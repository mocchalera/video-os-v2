// Phase 3: Assembly
// Build track layout (V1, V2, A1, A2, A3) by assigning best-scoring
// candidates per beat. Sets fallback_segment_ids.
//
// v5 fixes:
// - Guide mode: place ALL support/texture per beat (not just best)
// - Multi-track guide mode: place ALL dialogue per beat on A1
// - Guide mode: frame advancement floor = beat.target_duration_frames
// - Guide mode: global fill pass for remaining unused candidates
// - Chronological ordering support for keepsake/event-recap profiles

import type {
  AssembledTimeline,
  BriefAudioPolicy,
  Candidate,
  ContinuityReorderEvent,
  ContinuityRepeatPolicy,
  CraftDirective,
  CraftRhythm,
  DurationPolicy,
  Marker,
  NormalizedData,
  RankedCandidateTable,
  ScoredCandidate,
  ScoringParams,
  TimelineClip,
  StillDurationPolicy,
  Track,
  TrackLayout,
} from "./types.js";
import { resolveStillImageHold } from "../artifacts/still-image-policy.js";
import { isStillImageClip, setStillImageHoldFrames } from "./still-image.js";
import { getCandidateRef } from "./candidate-ref.js";
import {
  candidateSupportsVisual,
  inferAudioRole,
  isAudioOnlyCandidate,
} from "../artifacts/source-media-capabilities.js";

export const MIN_RHYTHM_CLIP_DURATION_SEC = 0.5;

export interface AssembleOptions {
  timelineOrder?: "chronological" | "editorial";
  beatOrder?: string[];
  trackLayout?: TrackLayout;
  audioPolicy?: BriefAudioPolicy;
  a1Loudnorm?: boolean;
  clusterContinuity?: boolean;
  bgmAssetId?: string;
  bgmSegmentId?: string;
  bgmDurationSec?: number;
  maxDurationFrames?: number;
  sameAssetRepeatPolicy?: ContinuityRepeatPolicy;
  continuityReorders?: ContinuityReorderEvent[];
  /** Treat each beat's candidate_plan as an exact authored sequence contract. */
  exactCandidatePlanOrder?: boolean;
  log?: (message: string) => void;
  stillDurationPolicy?: StillDurationPolicy;
}

export function assemble(
  normalized: NormalizedData,
  rankedTable: RankedCandidateTable,
  params: ScoringParams,
  fpsNum: number = 24,
  fpsDen: number = 1,
  durationPolicy?: DurationPolicy,
  options?: AssembleOptions,
): AssembledTimeline {
  const isGuide = durationPolicy?.mode === "guide";
  const layout = options?.trackLayout ?? "single";
  const usPerFrame = (1_000_000 * fpsDen) / fpsNum;
  const hasImageCandidate = [...rankedTable.values()].some((ranked) =>
    ranked.some((entry) => entry.candidate.media_kind === "image"));
  if (hasImageCandidate && !options?.stillDurationPolicy) {
    throw new Error("still_image_duration_policy_missing");
  }
  const v1Clips: TimelineClip[] = []; // primary narrative (hero)
  const v2Clips: TimelineClip[] = []; // support / inserts
  const a1Clips: TimelineClip[] = []; // dialogue / nat sound
  const a2Clips: TimelineClip[] = []; // music (M1: empty allowed)
  const a3Clips: TimelineClip[] = []; // texture / room tone (M1: empty allowed)
  const markers: Marker[] = [];
  const clusterByClipId = new Map<string, string>();
  const exactCandidatePlanOrder = options?.exactCandidatePlanOrder ?? false;
  const clusterContinuity = exactCandidatePlanOrder
    ? false
    : options?.clusterContinuity ?? true;
  const maxDurationFrames =
    typeof options?.maxDurationFrames === "number" && options.maxDurationFrames > 0
      ? Math.floor(options.maxDurationFrames)
      : undefined;
  const beatBudgetFrames = buildBeatBudgetFrames(normalized.beats, maxDurationFrames);
  const reservedCandidateOwner = shouldReserveBeatCandidates(normalized.beats, maxDurationFrames)
    ? buildBeatCandidateReservations(
        normalized.beats,
        rankedTable,
        layout,
        maxDurationFrames,
      )
    : new Map<string, string>();
  let durationCapDroppedClips = 0;

  // Track used segments to apply adjacency penalty and prevent overuse
  const usedClips = new Set<string>();
  let clipCounter = 0;
  let currentFrame = 0;

  // Track previous asset per track for adjacency penalty
  let prevV1Asset: string | null = null;
  let prevV2Asset: string | null = null;

  beatLoop:
  for (const beat of normalized.beats) {
    if (maxDurationFrames != null && currentFrame >= maxDurationFrames) {
      break;
    }

    const beatBudget = beatBudgetFrames.get(beat.beat_id) ?? beat.target_duration_frames;
    const mappedBeatCandidates = (rankedTable.get(beat.beat_id) ?? []).map((scored) => {
      const plan = beat.candidate_plan;
      const candidateRef = getCandidateRef(scored.candidate);
      if (scored.candidate.media_kind !== "image" || !plan?.still_image ||
        (plan.primary_candidate_ref !== candidateRef && plan.primary_candidate_ref !== scored.candidate.segment_id)) {
        return scored;
      }
      return {
        ...scored,
        candidate: {
          ...scored.candidate,
          still_image: { ...scored.candidate.still_image, ...plan.still_image },
        },
      };
    });
    const beatCandidates = mappedBeatCandidates.filter((scored) => {
      if (scored.candidate.media_kind !== "image") return true;
      const minimum = resolveStillImageHold(
        scored.candidate,
        options!.stillDurationPolicy!,
        options!.stillDurationPolicy!.max_hold_frames,
      ).min_hold_frames;
      return beatBudget >= minimum;
    });
    const hadUnplaceableStill = mappedBeatCandidates.some((candidate) =>
      candidate.candidate.media_kind === "image" && !beatCandidates.includes(candidate)
    );
    if (hadUnplaceableStill && !beatCandidates.some((candidate) => candidateSupportsVisual(candidate.candidate))) {
      const minimum = Math.min(...mappedBeatCandidates
        .filter((candidate) => candidate.candidate.media_kind === "image")
        .map((candidate) => resolveStillImageHold(
          candidate.candidate,
          options!.stillDurationPolicy!,
          options!.stillDurationPolicy!.max_hold_frames,
        ).min_hold_frames));
      throw new Error(`still_image_hold_cannot_fit_beat: beat_id=${beat.beat_id} available_frames=${beatBudget} min_hold_frames=${minimum}`);
    }

    // Add beat boundary marker
    markers.push({
      frame: currentFrame,
      kind: "beat",
      label: `${beat.beat_id}: ${beat.viewer_label ?? beat.label}`,
    });

    if (beatBudget <= 0) {
      continue;
    }

    // Collect candidates by role for this beat, applying adjacency penalty
    const byRole = groupByRole(beatCandidates.filter((item) => candidateSupportsVisual(item.candidate)));
    const audioOnlyCandidates = exactCandidatePlanOrder
      ? orderCandidatesByCandidatePlan(
          beatCandidates.filter((item) => isAudioOnlyCandidate(item.candidate)),
          beat.candidate_plan,
        )
      : candidatesForCurrentBeat(
          beatCandidates.filter((item) => isAudioOnlyCandidate(item.candidate)),
          beat.beat_id,
          reservedCandidateOwner,
        );
    const routedAudioCandidates = exactCandidatePlanOrder || isGuide
      ? pickAvailable(audioOnlyCandidates, usedClips, null, 0, clusterContinuity)
      : (() => {
          const best = pickBest(audioOnlyCandidates, usedClips, null, 0);
          return best ? [best] : [];
        })();
    let audioFrame = currentFrame;
    const audioBeatEndFrame = currentFrame + beatBudget;
    for (const scored of routedAudioCandidates) {
      if (audioFrame >= audioBeatEndFrame) break;
      const clip = makeClip(
        scored,
        beat.beat_id,
        audioFrame,
        audioBeatEndFrame - audioFrame,
        ++clipCounter,
        { segment_ids: [], candidate_refs: [] },
       usPerFrame,
        options?.stillDurationPolicy,
     );
      clip.audio_role = scored.candidate.audio_role ?? inferAudioRole(scored.candidate);
      const target = clip.audio_role === "dialogue"
        ? a1Clips
        : clip.audio_role === "music"
          ? a2Clips
          : a3Clips;
      if (placeClipWithinCap(target, clip, maxDurationFrames)) {
        usedClips.add(clipUsageKey(scored.candidate));
        audioFrame += clip.timeline_duration_frames;
      } else {
        durationCapDroppedClips += 1;
      }
    }

    if (layout === "single") {
      const visualCandidates = exactCandidatePlanOrder
        ? orderCandidatesByCandidatePlan(getV1FirstCandidates(byRole), beat.candidate_plan)
        : candidatesForCurrentBeat(
            getV1FirstCandidates(byRole),
            beat.beat_id,
            reservedCandidateOwner,
          );
      const beatEndFrame = currentFrame + beatBudget;
      let v1Frame = currentFrame;
      let exactPlanIndex = 0;

      while (v1Frame < beatEndFrame) {
        const visualClip: ScoredCandidate | undefined = exactCandidatePlanOrder
          ? visualCandidates[exactPlanIndex++]
          : pickAvailableV1First(
              visualCandidates,
              usedClips,
              prevV1Asset,
              params.adjacency_penalty,
              clusterContinuity,
            )[0];
        if (!visualClip) break;

        const clip = makeClip(
          visualClip,
          beat.beat_id,
          v1Frame,
          beatEndFrame - v1Frame,
          ++clipCounter,
          { segment_ids: [], candidate_refs: [] },
         usPerFrame,
          options?.stillDurationPolicy,
       );
        const placed = placeClipWithinCap(v1Clips, clip, maxDurationFrames);
        usedClips.add(clipUsageKey(visualClip.candidate));
        if (!placed) {
          durationCapDroppedClips += 1;
          if (maxDurationFrames != null && v1Frame >= maxDurationFrames) break;
          continue;
        }
        registerClipCluster(clusterByClipId, clip, visualClip);
        prevV1Asset = visualClip.candidate.asset_id;
        v1Frame += clip.timeline_duration_frames;
      }

      const v1HasDialogueForBeat = v1Clips.some((clip) =>
        clip.beat_id === beat.beat_id && clip.role === "dialogue"
      );
      if (!exactCandidatePlanOrder && !v1HasDialogueForBeat) {
        const dialogueCandidates = candidatesForCurrentBeat(
          (byRole.get("dialogue") ?? []).filter((candidate) =>
            candidateSupportsAuthoredDialogueAudio(candidate.candidate)
          ),
          beat.beat_id,
          reservedCandidateOwner,
        );
        const authoredDialogue = isGuide
          ? pickAvailable(
              dialogueCandidates,
              usedClips,
              null,
              0,
              clusterContinuity,
            )
          : (() => {
              const clip = pickBest(
                dialogueCandidates,
                usedClips,
                null,
                0,
              );
              return clip ? [clip] : [];
            })();
        for (const sc of authoredDialogue) {
          const clip = makeClip(
            sc,
            beat.beat_id,
            currentFrame,
            beatBudget,
            ++clipCounter,
            { segment_ids: [], candidate_refs: [] },
           usPerFrame,
            options?.stillDurationPolicy,
         );
          if (placeClipWithinCap(a1Clips, clip, maxDurationFrames)) {
            registerClipCluster(clusterByClipId, clip, sc);
            usedClips.add(clipUsageKey(sc.candidate));
          } else {
            durationCapDroppedClips += 1;
            if (isGuide) usedClips.add(clipUsageKey(sc.candidate));
          }
        }
      }
    } else {
      const visualDialogueCandidates = candidatesForCurrentBeat(
        (byRole.get("dialogue") ?? []).filter((candidate) =>
          !candidateSupportsAuthoredDialogueAudio(candidate.candidate)
        ),
        beat.beat_id,
        reservedCandidateOwner,
      );
      // V1: hero clips (always pick best 1)
      const heroCandidates = candidatesForCurrentBeat(
        byRole.get("hero") ?? [],
        beat.beat_id,
        reservedCandidateOwner,
      );
      const heroClip = pickBest(
        heroCandidates,
        usedClips,
        prevV1Asset,
        params.adjacency_penalty,
      );
      if (heroClip) {
        const clip = makeClip(
          heroClip,
          beat.beat_id,
          currentFrame,
          beatBudget,
          ++clipCounter,
          getRunnersUp(heroCandidates, heroClip, usedClips),
         usPerFrame,
          options?.stillDurationPolicy,
       );
        if (placeClipWithinCap(v1Clips, clip, maxDurationFrames)) {
          registerClipCluster(clusterByClipId, clip, heroClip);
          usedClips.add(clipUsageKey(heroClip.candidate));
          prevV1Asset = heroClip.candidate.asset_id;
        } else {
          durationCapDroppedClips += 1;
        }
      } else {
        // A visual-only dialogue candidate (notably a still image) cannot be
        // authored onto A1. Preserve it as the primary visual when no hero is
        // available instead of fabricating an audio clip.
        const visualDialogue = pickBest(
          visualDialogueCandidates,
          usedClips,
          prevV1Asset,
          params.adjacency_penalty,
        );
        if (visualDialogue) {
          const clip = makeClip(
            visualDialogue,
            beat.beat_id,
            currentFrame,
            beatBudget,
            ++clipCounter,
            getRunnersUp(visualDialogueCandidates, visualDialogue, usedClips),
            usPerFrame,
            options?.stillDurationPolicy,
          );
          if (placeClipWithinCap(v1Clips, clip, maxDurationFrames)) {
            registerClipCluster(clusterByClipId, clip, visualDialogue);
            usedClips.add(clipUsageKey(visualDialogue.candidate));
            prevV1Asset = visualDialogue.candidate.asset_id;
          } else {
            durationCapDroppedClips += 1;
          }
        }
      }

      // V2: support + texture clips
      const supportCandidates = [
        ...(byRole.get("support") ?? []),
        ...(byRole.get("texture") ?? []),
        ...visualDialogueCandidates,
      ];
      // Re-sort after merging (stable sort)
      supportCandidates.sort((a, b) => {
        const diff = b.score - a.score;
        if (diff !== 0) return diff;
        return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
      });
      const availableSupportCandidates = candidatesForCurrentBeat(
        supportCandidates,
        beat.beat_id,
        reservedCandidateOwner,
      );

      if (isGuide) {
        // Guide mode: place available support/texture clips as V2 inserts,
        // SEQUENCED within the beat window. Previously every insert was
        // placed at `currentFrame`, so a beat with N support/texture
        // candidates stacked N clips at the identical start time — e.g.
        // five clips all at 170.0s — which is not a playable overlay, just
        // an overflow dump. Each insert now starts where the previous one
        // ended and the run is capped at the beat boundary; surplus
        // candidates are left unused (and stay available to later beats).
        const allSupport = pickAvailable(
          availableSupportCandidates,
          usedClips,
          prevV2Asset,
          params.adjacency_penalty,
          clusterContinuity,
        );
        const beatEndFrame = currentFrame + beatBudget;
        let v2Frame = currentFrame;
        for (const sc of allSupport) {
          if (v2Frame >= beatEndFrame) break; // keep V2 inserts inside the beat
          const clip = makeClip(
            sc,
            beat.beat_id,
            v2Frame,
            beatEndFrame - v2Frame,
            ++clipCounter,
            { segment_ids: [], candidate_refs: [] },
           usPerFrame,
            options?.stillDurationPolicy,
         );
          if (placeClipWithinCap(v2Clips, clip, maxDurationFrames)) {
            registerClipCluster(clusterByClipId, clip, sc);
            usedClips.add(clipUsageKey(sc.candidate));
            prevV2Asset = sc.candidate.asset_id;
            v2Frame += clip.timeline_duration_frames; // sequence, do not stack
          } else {
            durationCapDroppedClips += 1;
            usedClips.add(clipUsageKey(sc.candidate));
          }
        }
      } else {
        // Strict mode: pick best 1
        const supportClip = pickBest(
          availableSupportCandidates,
          usedClips,
          prevV2Asset,
          params.adjacency_penalty,
        );
        if (supportClip) {
          const clip = makeClip(
            supportClip,
            beat.beat_id,
            currentFrame,
            beatBudget,
            ++clipCounter,
            getRunnersUp(availableSupportCandidates, supportClip, usedClips),
           usPerFrame,
            options?.stillDurationPolicy,
         );
          if (placeClipWithinCap(v2Clips, clip, maxDurationFrames)) {
            registerClipCluster(clusterByClipId, clip, supportClip);
            usedClips.add(clipUsageKey(supportClip.candidate));
            prevV2Asset = supportClip.candidate.asset_id;
          } else {
            durationCapDroppedClips += 1;
          }
        }
      }
    }

    if (layout === "multi") {
      // A1: authored dialogue clips. Single-track layouts use V1 as program
      // picture and add exact source-audio mirrors after video placement.
      if (isGuide) {
        // Guide mode: place ALL available dialogue clips
        const dialogueCandidates = candidatesForCurrentBeat(
          (byRole.get("dialogue") ?? []).filter((candidate) =>
            candidateSupportsAuthoredDialogueAudio(candidate.candidate)
          ),
          beat.beat_id,
          reservedCandidateOwner,
        );
        const allDialogue = pickAvailable(
          dialogueCandidates,
          usedClips,
          null,
          0,
          clusterContinuity,
        );
        for (const sc of allDialogue) {
          const clip = makeClip(
            sc,
            beat.beat_id,
            currentFrame,
            beatBudget,
            ++clipCounter,
            { segment_ids: [], candidate_refs: [] },
           usPerFrame,
            options?.stillDurationPolicy,
         );
          if (placeClipWithinCap(a1Clips, clip, maxDurationFrames)) {
            registerClipCluster(clusterByClipId, clip, sc);
            usedClips.add(clipUsageKey(sc.candidate));
          } else {
            durationCapDroppedClips += 1;
            usedClips.add(clipUsageKey(sc.candidate));
          }
        }
      } else {
        const dialogueCandidates = candidatesForCurrentBeat(
          (byRole.get("dialogue") ?? []).filter((candidate) =>
            candidateSupportsAuthoredDialogueAudio(candidate.candidate)
          ),
          beat.beat_id,
          reservedCandidateOwner,
        );
        const dialogueClip = pickBest(
          dialogueCandidates,
          usedClips,
          null,
          0,
        );
        if (dialogueClip) {
          const clip = makeClip(
            dialogueClip,
            beat.beat_id,
            currentFrame,
            beatBudget,
            ++clipCounter,
            getRunnersUp(dialogueCandidates, dialogueClip, usedClips),
           usPerFrame,
            options?.stillDurationPolicy,
         );
          if (placeClipWithinCap(a1Clips, clip, maxDurationFrames)) {
            registerClipCluster(clusterByClipId, clip, dialogueClip);
            usedClips.add(clipUsageKey(dialogueClip.candidate));
          } else {
            durationCapDroppedClips += 1;
          }
        }
      }
    }

    if (layout === "multi") {
      // Transition clips go to V2 as well
      const transitionCandidates = candidatesForCurrentBeat(
        byRole.get("transition") ?? [],
        beat.beat_id,
        reservedCandidateOwner,
      );
      const transitionClip = pickBest(
        transitionCandidates,
        usedClips,
        prevV2Asset,
        params.adjacency_penalty,
      );
      if (transitionClip) {
        const clip = makeClip(
          transitionClip,
          beat.beat_id,
          currentFrame,
          beatBudget,
          ++clipCounter,
          getRunnersUp(transitionCandidates, transitionClip, usedClips),
         usPerFrame,
          options?.stillDurationPolicy,
       );
        if (placeClipWithinCap(v2Clips, clip, maxDurationFrames)) {
          registerClipCluster(clusterByClipId, clip, transitionClip);
          usedClips.add(clipUsageKey(transitionClip.candidate));
          prevV2Asset = transitionClip.candidate.asset_id;
        } else {
          durationCapDroppedClips += 1;
        }
      }
    }

    const craftMaxEndFrame = maxDurationFrames != null
      ? Math.min(currentFrame + beatBudget, maxDurationFrames)
      : undefined;
    applyBeatCraftTiming(v1Clips, beat.craft, beat.beat_id, fpsNum / fpsDen, craftMaxEndFrame);
    applyBeatCraftTiming(v2Clips, beat.craft, beat.beat_id, fpsNum / fpsDen, craftMaxEndFrame);
    applyBeatCraftTiming(a1Clips, beat.craft, beat.beat_id, fpsNum / fpsDen, craftMaxEndFrame);
    applyBeatCraftTiming(a2Clips, beat.craft, beat.beat_id, fpsNum / fpsDen, craftMaxEndFrame);
    applyBeatCraftTiming(a3Clips, beat.craft, beat.beat_id, fpsNum / fpsDen, craftMaxEndFrame);

    // Frame advancement
    if (isGuide) {
      // Guide mode: use at least beat.target_duration_frames as floor.
      // target_duration is "at least this much", not an upper cap.
      const beatClips = [
        ...v1Clips.filter((c) => c.beat_id === beat.beat_id),
        ...v2Clips.filter((c) => c.beat_id === beat.beat_id),
      ];
      const maxClipDuration = beatClips.reduce(
        (max, c) => Math.max(max, c.timeline_duration_frames),
        0,
      );
      currentFrame += Math.max(maxClipDuration, beatBudget);
    } else {
      currentFrame += beatBudget;
    }
    if (maxDurationFrames != null && currentFrame >= maxDurationFrames) {
      currentFrame = maxDurationFrames;
      break beatLoop;
    }
  }

  // ── Guide mode: global fill pass ────────────────────────────────────
  // Place any remaining unused candidates that appear in the ranked table.
  // This ensures material coverage (important for keepsake profiles).
  if (isGuide && layout === "single" && !exactCandidatePlanOrder) {
    const fillResult = fillSingleLayoutGuideBeats(
      v1Clips,
      normalized.beats,
      markers,
      rankedTable,
      beatBudgetFrames,
      usedClips,
      clusterByClipId,
      clipCounter + 1,
      usPerFrame,
      maxDurationFrames,
      options?.stillDurationPolicy,
    );
    durationCapDroppedClips += fillResult.droppedClips;
    clipCounter = fillResult.clipCounter;
  } else if (isGuide && layout === "multi") {
    const unusedMap = new Map<string, ScoredCandidate>();
    for (const [, scored] of rankedTable) {
      for (const sc of scored) {
        const key = clipUsageKey(sc.candidate);
        if (!usedClips.has(key) && !unusedMap.has(key)) {
          unusedMap.set(key, sc);
        }
      }
    }

    const unused = [...unusedMap.values()].sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
    });

    const lastBeatId = normalized.beats[normalized.beats.length - 1]?.beat_id ?? "fill";

    for (const sc of unused) {
      if (maxDurationFrames != null && currentFrame >= maxDurationFrames) break;
      const availableFrames = maxDurationFrames == null
        ? Number.MAX_SAFE_INTEGER
        : maxDurationFrames - currentFrame;
      const clip = makeClip(
        sc,
        lastBeatId,
        currentFrame,
        availableFrames,
        ++clipCounter,
        { segment_ids: [], candidate_refs: [] },
        usPerFrame,
        options?.stillDurationPolicy,
      );

      usedClips.add(clipUsageKey(sc.candidate));
      const audioRole = sc.candidate.audio_role ?? inferAudioRole(sc.candidate);
      const targetTrack = isAudioOnlyCandidate(sc.candidate)
        ? audioRole === "dialogue" ? a1Clips : audioRole === "music" ? a2Clips : a3Clips
        : sc.candidate.role === "dialogue" && candidateSupportsAuthoredDialogueAudio(sc.candidate)
          ? a1Clips
          : v2Clips;
      if (placeClipWithinCap(targetTrack, clip, maxDurationFrames)) {
        registerClipCluster(clusterByClipId, clip, sc);
        currentFrame += clip.timeline_duration_frames;
      } else {
        durationCapDroppedClips += 1;
      }
    }
  }

  if (clusterContinuity) {
    reorderClusterContinuity(v1Clips, clusterByClipId, options?.beatOrder, {
      trackId: "V1",
      sameAssetRepeatPolicy: options?.sameAssetRepeatPolicy,
      reorders: options?.continuityReorders,
    });
    reorderClusterContinuity(v2Clips, clusterByClipId, options?.beatOrder, {
      trackId: "V2",
      sameAssetRepeatPolicy: options?.sameAssetRepeatPolicy,
      reorders: options?.continuityReorders,
    });
  }

  // ── Chronological reorder ───────────────────────────────────────────
  // For keepsake / event-recap profiles, reorder clips by source timestamp
  // (asset_id + src_in_us) instead of editorial score order.
  if (options?.timelineOrder === "chronological") {
    reorderChronological(v1Clips, v2Clips, a1Clips, a2Clips, a3Clips, markers, options.beatOrder);
  }

  if (maxDurationFrames != null) {
    durationCapDroppedClips += dropClipsBeyondCap(v1Clips, maxDurationFrames);
    durationCapDroppedClips += dropClipsBeyondCap(v2Clips, maxDurationFrames);
    durationCapDroppedClips += dropClipsBeyondCap(a1Clips, maxDurationFrames);
    durationCapDroppedClips += dropClipsBeyondCap(a2Clips, maxDurationFrames);
    durationCapDroppedClips += dropClipsBeyondCap(a3Clips, maxDurationFrames);
  }

  if (options?.audioPolicy !== "bgm_only") {
    addOriginalAudioForVideoClips(
      [...v1Clips, ...v2Clips],
      a1Clips,
      options?.audioPolicy ?? "ducking",
      clipCounter,
      options?.a1Loudnorm ?? true,
    );
  }

  if (options?.bgmAssetId && options.audioPolicy !== "original_only") {
    const totalProgramFrames = Math.max(
      0,
      ...(
        v1Clips.length + v2Clips.length > 0
          ? [...v1Clips, ...v2Clips]
          : [...a1Clips, ...a2Clips, ...a3Clips]
      ).map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames),
    );
    a2Clips.push({
      clip_id: "ACL_BGM_0001",
      segment_id: options.bgmSegmentId ?? `${normalized.project_id}:bgm`,
      asset_id: options.bgmAssetId,
      src_in_us: 0,
      src_out_us: Math.round((options.bgmDurationSec ?? totalProgramFrames / (fpsNum / fpsDen)) * 1_000_000),
      timeline_in_frame: 0,
      timeline_duration_frames: totalProgramFrames,
      role: "bgm",
      motivation: "background music bed",
      beat_id: "music01",
      fallback_segment_ids: [],
      confidence: 1,
      quality_flags: [],
      audio_policy: {
        mode: options.audioPolicy ?? "ducking",
        gain_unit: "linear",
        duck_music_db: -18,
        bgm_gain: 0.25,
        a1_loudnorm: options.a1Loudnorm ?? true,
      },
    });
  }

  if (maxDurationFrames != null && durationCapDroppedClips > 0) {
    const log = options?.log ?? console.warn;
    log(`Duration cap dropped ${durationCapDroppedClips} clip(s) beyond ${maxDurationFrames} frames`);
  }

  const video: Track[] = [
    { track_id: "V1", kind: "video", clips: v1Clips },
    { track_id: "V2", kind: "video", clips: v2Clips },
  ];

  const audio: Track[] = [
    { track_id: "A1", kind: "audio", clips: a1Clips },
    { track_id: "A2", kind: "audio", clips: a2Clips },
    { track_id: "A3", kind: "audio", clips: a3Clips },
  ];

  return { tracks: { video, audio }, markers };
}

function fillSingleLayoutGuideBeats(
  v1Clips: TimelineClip[],
  beats: NormalizedData["beats"],
  markers: Marker[],
  rankedTable: RankedCandidateTable,
  beatBudgetFrames: Map<string, number>,
  usedClips: Set<string>,
  clusterByClipId: Map<string, string>,
  startClipCounter: number,
  usPerFrame: number,
  maxDurationFrames?: number,
  stillDurationPolicy?: StillDurationPolicy,
): { droppedClips: number; clipCounter: number } {
  const unused = buildUnusedCandidatePool(rankedTable, usedClips);
  if (unused.length === 0) return { droppedClips: 0, clipCounter: startClipCounter - 1 };

  const beatStarts = buildBeatStartFrameMap(beats, markers);
  let clipCounter = startClipCounter - 1;
  let droppedClips = 0;

  for (const beat of beats) {
    const beatBudget = beatBudgetFrames.get(beat.beat_id) ?? beat.target_duration_frames;
    if (beatBudget <= 0) continue;

    const beatStart = beatStarts.get(beat.beat_id) ?? 0;
    const beatEnd = beatStart + beatBudget;
    let cursor = beatStart;
    for (const clip of orderedTimelineClips(v1Clips.filter((item) => item.beat_id === beat.beat_id))) {
      cursor = Math.max(cursor, clip.timeline_in_frame + clip.timeline_duration_frames);
    }

    while (cursor < beatEnd && unused.length > 0) {
      const nextIndex = findBestFillCandidateIndex(unused, beat.beat_id);
      const [sc] = unused.splice(nextIndex, 1);
      const availableFrames = beatEnd - cursor;
      const clip = makeClip(
        sc,
        beat.beat_id,
        cursor,
        availableFrames,
        ++clipCounter,
        { segment_ids: [], candidate_refs: [] },
        usPerFrame,
        stillDurationPolicy,
      );
      usedClips.add(clipUsageKey(sc.candidate));
      if (placeClipWithinCap(v1Clips, clip, maxDurationFrames)) {
        registerClipCluster(clusterByClipId, clip, sc);
        cursor += clip.timeline_duration_frames;
      } else {
        droppedClips += 1;
      }
    }
  }

  return { droppedClips, clipCounter };
}

function buildUnusedCandidatePool(
  rankedTable: RankedCandidateTable,
  usedClips: Set<string>,
): ScoredCandidate[] {
  const unusedByKey = new Map<string, ScoredCandidate>();
  for (const [, scored] of rankedTable) {
    for (const sc of scored) {
      const key = clipUsageKey(sc.candidate);
      if (!V1_FIRST_ROLE_PRIORITY.has(sc.candidate.role) || !candidateSupportsVisual(sc.candidate)) continue;
      if (usedClips.has(key)) continue;
      const current = unusedByKey.get(key);
      if (
        !current ||
        sc.score > current.score ||
        (sc.score === current.score && sc.candidate.segment_id.localeCompare(current.candidate.segment_id) < 0)
      ) {
        unusedByKey.set(key, sc);
      }
    }
  }

  return [...unusedByKey.values()].sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
  });
}

function findBestFillCandidateIndex(unused: ScoredCandidate[], beatId: string): number {
  const beatLocalIndex = unused.findIndex((sc) => sc.beat_id === beatId);
  return beatLocalIndex >= 0 ? beatLocalIndex : 0;
}

function buildBeatStartFrameMap(beats: NormalizedData["beats"], markers: Marker[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const marker of markers) {
    if (marker.kind !== "beat") continue;
    const beatId = marker.label.split(":")[0]?.trim();
    if (beatId) starts.set(beatId, marker.frame);
  }

  let cursor = 0;
  for (const beat of beats) {
    if (!starts.has(beat.beat_id)) starts.set(beat.beat_id, cursor);
    cursor += Math.max(0, beat.target_duration_frames);
  }
  return starts;
}

function applyBeatCraftTiming(
  trackClips: TimelineClip[],
  craft: CraftDirective | undefined,
  beatId: string,
  fps: number,
  maxEndFrame?: number,
): void {
  if (!craft) return;
  const beatClips = orderedTimelineClips(trackClips.filter((clip) => clip.beat_id === beatId));
  if (beatClips.length === 0) return;

  const holdBias = typeof craft.hold_duration_bias === "number" &&
    Number.isFinite(craft.hold_duration_bias) &&
    craft.hold_duration_bias > 0
    ? craft.hold_duration_bias
    : undefined;

  if (holdBias !== undefined && holdBias !== 1) {
    applyDurationMultipliers(
      beatClips,
      beatClips.map(() => holdBias),
    );
  }

  if (craft.rhythm) {
    applyRhythmPattern(beatClips, craft.rhythm, fps);
  }

  capBeatClipsToMaxEnd(beatClips, maxEndFrame);
}

export function applyRhythmPattern(
  clips: TimelineClip[],
  rhythm: CraftRhythm | string,
  fps: number,
): void {
  const ordered = orderedTimelineClips(clips);
  if (ordered.length === 0 || rhythm === "steady") return;

  const minRhythmFrames = Math.max(1, Math.round(fps * MIN_RHYTHM_CLIP_DURATION_SEC));

  if (rhythm === "accelerando") {
    applyDurationMultipliers(ordered, interpolatedMultipliers(ordered.length, 1.5, 0.5), minRhythmFrames);
  } else if (rhythm === "ritardando") {
    applyDurationMultipliers(ordered, interpolatedMultipliers(ordered.length, 0.5, 1.5), minRhythmFrames);
  } else if (rhythm === "syncopated") {
    applyDurationMultipliers(
      ordered,
      ordered.map((_, index) => (index % 2 === 0 ? 1.3 : 0.7)),
      minRhythmFrames,
    );
  } else if (rhythm === "breath") {
    applyBreathRhythm(ordered, fps);
  }
}

function orderedTimelineClips(clips: TimelineClip[]): TimelineClip[] {
  return [...clips].sort((a, b) =>
    a.timeline_in_frame - b.timeline_in_frame || a.clip_id.localeCompare(b.clip_id)
  );
}

function interpolatedMultipliers(count: number, first: number, last: number): number[] {
  if (count <= 1) return [1];
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    return first + (last - first) * t;
  });
}

function applyDurationMultipliers(
  clips: TimelineClip[],
  multipliers: number[],
  minDurationFrames = 1,
): void {
  if (clips.length === 0) return;
  const targetDurations = clips.map((clip, index) => {
    if (isStillImageClip(clip)) return clip.timeline_duration_frames;
    const multiplier = multipliers[index] ?? 1;
    return Math.max(1, Math.round(clip.timeline_duration_frames * multiplier));
  });
  const targetTotal = targetDurations.reduce((sum, duration) => sum + duration, 0);
  const durations = targetDurations.map((duration, index) =>
    isStillImageClip(clips[index]) ? duration : Math.max(minDurationFrames, duration)
  );
  let extraFrames = durations.reduce((sum, duration) => sum + duration, 0) - targetTotal;

  if (extraFrames > 0) {
    const reducible = durations
      .map((duration, index) => ({ index, slack: duration - minDurationFrames }))
      .filter((item) => item.slack > 0)
      .sort((a, b) => b.slack - a.slack || a.index - b.index);

    for (const item of reducible) {
      if (extraFrames <= 0) break;
      const reduction = Math.min(item.slack, extraFrames);
      durations[item.index] -= reduction;
      extraFrames -= reduction;
    }
  }

  let frame = clips[0].timeline_in_frame;
  for (let i = 0; i < clips.length; i += 1) {
    clips[i].timeline_in_frame = frame;
    setStillImageHoldFrames(clips[i], durations[i], isStillImageClip(clips[i]) ? "beat_budget" : "none");
    frame += durations[i];
  }
}

function applyBreathRhythm(clips: TimelineClip[], fps: number): void {
  if (clips.length === 0) return;
  const breathFrames = Math.max(1, Math.round(fps));
  let frame = clips[0].timeline_in_frame;

  for (let i = 0; i < clips.length; i += 1) {
    const shouldHoldLast = clips.length <= 3 && i === clips.length - 1;
    const duration = clips[i].timeline_duration_frames + (shouldHoldLast && !isStillImageClip(clips[i]) ? breathFrames : 0);
    clips[i].timeline_in_frame = frame;
    setStillImageHoldFrames(clips[i], Math.max(1, duration), isStillImageClip(clips[i]) ? clips[i].still_image!.policy_clamp : "none");
    frame += clips[i].timeline_duration_frames;
    if (clips.length > 3 && (i + 1) % 4 === 0 && i < clips.length - 1) {
      frame += breathFrames;
    }
  }
}

function capBeatClipsToMaxEnd(clips: TimelineClip[], maxEndFrame: number | undefined): void {
  if (maxEndFrame == null || clips.length === 0) return;
  const ordered = orderedTimelineClips(clips);
  const firstFrame = ordered[0].timeline_in_frame;
  const availableFrames = maxEndFrame - firstFrame;
  if (availableFrames < ordered.length) return;

  const currentEndFrame = Math.max(
    ...ordered.map((clip) => clip.timeline_in_frame + clip.timeline_duration_frames),
  );
  if (currentEndFrame <= maxEndFrame) return;

  const durations = ordered.map((clip) => Math.max(1, clip.timeline_duration_frames));
  let overflow = durations.reduce((sum, duration) => sum + duration, 0) - availableFrames;
  if (overflow > 0) {
    for (let index = durations.length - 1; index >= 0 && overflow > 0; index -= 1) {
      const floor = isStillImageClip(ordered[index])
        ? ordered[index].still_image!.min_hold_frames
        : 1;
      const reducible = durations[index] - floor;
      const reduction = Math.min(reducible, overflow);
      durations[index] -= reduction;
      overflow -= reduction;
    }
  }

  if (overflow > 0) {
    throw new Error(`still_image_hold_cannot_fit_cap:remaining_overflow_frames=${overflow}`);
  }

  let frame = firstFrame;
  for (let index = 0; index < ordered.length; index += 1) {
    ordered[index].timeline_in_frame = frame;
    const clip = ordered[index];
    const next = isStillImageClip(clip)
      ? Math.max(clip.still_image!.min_hold_frames, Math.min(durations[index], clip.still_image!.max_hold_frames))
      : durations[index];
    setStillImageHoldFrames(clip, next, isStillImageClip(clip) && next !== clip.still_image!.hold_frames ? "duration_cap" : "none");
    frame += clip.timeline_duration_frames;
  }
}

function placeClipWithinCap(
  clips: TimelineClip[],
  clip: TimelineClip,
  maxDurationFrames?: number,
): boolean {
  if (
    maxDurationFrames != null &&
    clip.timeline_in_frame + clip.timeline_duration_frames > maxDurationFrames
  ) {
    return false;
  }
  clips.push(clip);
  return true;
}

function dropClipsBeyondCap(clips: TimelineClip[], maxDurationFrames: number): number {
  const keep = clips.filter(
    (clip) => clip.timeline_in_frame + clip.timeline_duration_frames <= maxDurationFrames,
  );
  const dropped = clips.length - keep.length;
  if (dropped > 0) {
    clips.splice(0, clips.length, ...keep);
  }
  return dropped;
}

function buildBeatBudgetFrames(
  beats: NormalizedData["beats"],
  maxDurationFrames: number | undefined,
): Map<string, number> {
  const budgets = new Map<string, number>();
  const totalBeatFrames = beats.reduce(
    (sum, beat) => sum + Math.max(0, beat.target_duration_frames),
    0,
  );

  if (maxDurationFrames == null || totalBeatFrames <= maxDurationFrames || totalBeatFrames <= 0) {
    for (const beat of beats) {
      budgets.set(beat.beat_id, beat.target_duration_frames);
    }
    return budgets;
  }

  const scale = maxDurationFrames / totalBeatFrames;
  const positiveBeatCount = beats.filter((beat) => beat.target_duration_frames > 0).length;
  const canGiveEveryPositiveBeat = maxDurationFrames >= positiveBeatCount;
  const scaled = beats.map((beat, index) => {
    const raw = Math.max(0, beat.target_duration_frames) * scale;
    let frames = Math.floor(raw);
    if (canGiveEveryPositiveBeat && beat.target_duration_frames > 0 && frames === 0) {
      frames = 1;
    }
    return {
      beat,
      index,
      frames,
      remainder: raw - Math.floor(raw),
    };
  });

  let allocated = scaled.reduce((sum, item) => sum + item.frames, 0);
  if (allocated > maxDurationFrames) {
    const reducible = [...scaled].sort((a, b) =>
      b.frames - a.frames || a.remainder - b.remainder || a.index - b.index
    );
    for (const item of reducible) {
      const floor = canGiveEveryPositiveBeat && item.beat.target_duration_frames > 0 ? 1 : 0;
      while (allocated > maxDurationFrames && item.frames > floor) {
        item.frames -= 1;
        allocated -= 1;
      }
      if (allocated <= maxDurationFrames) break;
    }
  }

  let remaining = maxDurationFrames - allocated;
  if (remaining > 0) {
    const byRemainder = [...scaled].sort((a, b) =>
      b.remainder - a.remainder || a.index - b.index
    );
    let cursor = 0;
    while (remaining > 0 && byRemainder.length > 0) {
      byRemainder[cursor % byRemainder.length].frames += 1;
      remaining -= 1;
      cursor += 1;
    }
  }

  for (const item of scaled) {
    budgets.set(item.beat.beat_id, item.frames);
  }
  return budgets;
}

function shouldReserveBeatCandidates(
  beats: NormalizedData["beats"],
  maxDurationFrames: number | undefined,
): boolean {
  if (maxDurationFrames == null) return false;
  const totalBeatFrames = beats.reduce(
    (sum, beat) => sum + Math.max(0, beat.target_duration_frames),
    0,
  );
  return maxDurationFrames < totalBeatFrames;
}

function buildBeatCandidateReservations(
  beats: NormalizedData["beats"],
  rankedTable: RankedCandidateTable,
  layout: TrackLayout,
  maxDurationFrames: number | undefined,
): Map<string, string> {
  const reservedOwner = new Map<string, string>();
  if (maxDurationFrames == null) return reservedOwner;

  for (const beat of [...beats].reverse()) {
    const scored = rankedTable.get(beat.beat_id) ?? [];
    const candidates = layout === "single"
      ? getV1FirstCandidates(groupByRole(scored))
      : scored;
    const reserved = candidates.find((candidate) =>
      !reservedOwner.has(clipUsageKey(candidate.candidate))
    );
    if (reserved) {
      reservedOwner.set(clipUsageKey(reserved.candidate), beat.beat_id);
    }
  }

  return reservedOwner;
}

function candidatesForCurrentBeat(
  candidates: ScoredCandidate[],
  beatId: string,
  reservedOwner: Map<string, string>,
): ScoredCandidate[] {
  if (reservedOwner.size === 0) return candidates;
  return candidates
    .filter((candidate) => {
      const owner = reservedOwner.get(clipUsageKey(candidate.candidate));
      return owner == null || owner === beatId;
    })
    .sort((a, b) => {
      const aReserved = reservedOwner.get(clipUsageKey(a.candidate)) === beatId;
      const bReserved = reservedOwner.get(clipUsageKey(b.candidate)) === beatId;
      if (aReserved !== bReserved) return aReserved ? -1 : 1;
      return 0;
    });
}

// ── Cluster continuity reorder ───────────────────────────────────────

function registerClipCluster(
  clusterByClipId: Map<string, string>,
  clip: TimelineClip,
  scored: ScoredCandidate,
): void {
  const cluster = getCandidateSemanticCluster(scored.candidate);
  if (cluster) {
    clusterByClipId.set(clip.clip_id, cluster);
  }
}

function reorderClusterContinuity(
  clips: TimelineClip[],
  clusterByClipId: Map<string, string>,
  beatOrder: string[] = [],
  options: {
    trackId: string;
    sameAssetRepeatPolicy?: ContinuityRepeatPolicy;
    reorders?: ContinuityReorderEvent[];
  },
): void {
  if (clips.length <= 1) return;

  const beatIndex = new Map(beatOrder.map((beatId, index) => [beatId, index]));
  const groups = new Map<string, TimelineClip[]>();
  for (const clip of clips) {
    const beatClips = groups.get(clip.beat_id) ?? [];
    beatClips.push(clip);
    groups.set(clip.beat_id, beatClips);
  }

  const orderedBeats = [...groups.keys()].sort((a, b) => {
    const indexA = beatIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
    const indexB = beatIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (indexA !== indexB) return indexA - indexB;
    const firstA = groups.get(a)?.[0]?.timeline_in_frame ?? 0;
    const firstB = groups.get(b)?.[0]?.timeline_in_frame ?? 0;
    return firstA - firstB;
  });

  const orderedByBeat = new Map<string, TimelineClip[]>();
  for (const beatId of orderedBeats) {
    const beatClips = groups.get(beatId) ?? [];
    const semanticallyOrdered = orderBeatClipsBySemanticCluster(beatClips, clusterByClipId);
    recordBeatReorder(
      options.reorders,
      "beat_semantic_cluster_order",
      options.trackId,
      beatId,
      beatClips,
      semanticallyOrdered,
      "grouped by semantic_cluster_id, clusters sorted by earliest source time, clips sorted by src_in_us",
    );
    orderedByBeat.set(beatId, semanticallyOrdered);
  }

  moveMatchingBoundaryClusters(orderedByBeat, orderedBeats, clusterByClipId, options);

  for (const beatId of orderedBeats) {
    const semanticallyOrdered = orderedByBeat.get(beatId) ?? [];
    const assetOrdered = options.sameAssetRepeatPolicy === "reorder_or_fail"
      ? coalesceSameAssetRunsWithinBeat(semanticallyOrdered)
      : semanticallyOrdered;
    recordBeatReorder(
      options.reorders,
      "beat_same_asset_coalesce",
      options.trackId,
      beatId,
      semanticallyOrdered,
      assetOrdered,
      "coalesced repeated source assets within the beat before global continuity validation",
    );
    orderedByBeat.set(beatId, assetOrdered);
  }

  const nextClips: TimelineClip[] = [];
  for (const beatId of orderedBeats) {
    const beatClips = orderedByBeat.get(beatId) ?? [];
    retimeBeatClips(beatClips);
    nextClips.push(...beatClips);
  }

  clips.splice(0, clips.length, ...nextClips);
}

function moveMatchingBoundaryClusters(
  orderedByBeat: Map<string, TimelineClip[]>,
  orderedBeats: string[],
  clusterByClipId: Map<string, string>,
  options: {
    trackId: string;
    reorders?: ContinuityReorderEvent[];
  },
): void {
  for (let i = 0; i < orderedBeats.length - 1; i += 1) {
    const current = orderedByBeat.get(orderedBeats[i]) ?? [];
    const next = orderedByBeat.get(orderedBeats[i + 1]) ?? [];
    if (current.length < 2 || next.length === 0) continue;

    const currentStartCluster = clusterByClipId.get(current[0].clip_id);
    const currentEndCluster = clusterByClipId.get(current[current.length - 1].clip_id);
    const nextStartCluster = clusterByClipId.get(next[0].clip_id);
    if (!currentStartCluster || !currentEndCluster) continue;
    if (currentEndCluster === nextStartCluster || currentStartCluster !== currentEndCluster) continue;

    const nextMatchingIndex = next.findIndex((clip) =>
      clusterByClipId.get(clip.clip_id) === currentEndCluster
    );
    if (nextMatchingIndex <= 0) continue;

    const before = [...next];
    const [matching] = next.splice(nextMatchingIndex, 1);
    next.unshift(matching);
    recordBeatReorder(
      options.reorders,
      "beat_semantic_cluster_order",
      options.trackId,
      orderedBeats[i + 1],
      before,
      next,
      "moved matching semantic_cluster_id to the next beat boundary for scene continuity",
    );
  }
}

function orderBeatClipsBySemanticCluster(
  items: TimelineClip[],
  clusterByClipId: Map<string, string>,
): TimelineClip[] {
  if (items.length <= 1) return [...items];

  const groups = new Map<string, {
    key: string;
    firstIndex: number;
    earliestSrcInUs: number;
    items: TimelineClip[];
  }>();
  let clusteredCount = 0;

  items.forEach((item, index) => {
    const cluster = clusterByClipId.get(item.clip_id);
    if (cluster) clusteredCount += 1;
    const key = cluster ? `cluster:${cluster}` : `clip:${item.clip_id}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.earliestSrcInUs = Math.min(group.earliestSrcInUs, item.src_in_us);
    } else {
      groups.set(key, {
        key,
        firstIndex: index,
        earliestSrcInUs: item.src_in_us,
        items: [item],
      });
    }
  });

  if (clusteredCount === 0) {
    return [...items];
  }

  return [...groups.values()]
    .sort((a, b) =>
      a.earliestSrcInUs - b.earliestSrcInUs ||
      a.firstIndex - b.firstIndex ||
      a.key.localeCompare(b.key)
    )
    .flatMap((group) => [...group.items].sort(compareClipsBySourceTime));
}

function coalesceSameAssetRunsWithinBeat(items: TimelineClip[]): TimelineClip[] {
  if (items.length <= 2) return [...items];
  const groups = new Map<string, { firstIndex: number; items: TimelineClip[] }>();
  items.forEach((item, index) => {
    const group = groups.get(item.asset_id);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(item.asset_id, { firstIndex: index, items: [item] });
    }
  });
  if ([...groups.values()].every((group) => group.items.length <= 1)) return [...items];
  return [...groups.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .flatMap((group) => group.items);
}

function recordBeatReorder(
  reorders: ContinuityReorderEvent[] | undefined,
  code: ContinuityReorderEvent["code"],
  trackId: string,
  beatId: string,
  before: TimelineClip[],
  after: TimelineClip[],
  reason: string,
): void {
  if (!reorders || sameClipOrder(before, after)) return;
  reorders.push({
    code,
    track_id: trackId,
    beat_id: beatId,
    before_clip_ids: before.map((clip) => clip.clip_id),
    after_clip_ids: after.map((clip) => clip.clip_id),
    reason,
  });
}

function sameClipOrder(left: TimelineClip[], right: TimelineClip[]): boolean {
  return left.length === right.length &&
    left.every((clip, index) => clip.clip_id === right[index]?.clip_id);
}

function compareClipsBySourceTime(a: TimelineClip, b: TimelineClip): number {
  return a.src_in_us - b.src_in_us ||
    a.asset_id.localeCompare(b.asset_id) ||
    a.segment_id.localeCompare(b.segment_id) ||
    a.clip_id.localeCompare(b.clip_id);
}

function orderClusterBlocks<T>(items: T[], clusterFor: (item: T) => string): T[] {
  if (items.length <= 1) return [...items];

  const groups = new Map<string, { cluster: string; firstIndex: number; items: T[] }>();
  items.forEach((item, index) => {
    const cluster = clusterFor(item);
    const group = groups.get(cluster);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(cluster, { cluster, firstIndex: index, items: [item] });
    }
  });

  return [...groups.values()]
    .sort((a, b) => {
      const sizeDiff = b.items.length - a.items.length;
      if (sizeDiff !== 0) return sizeDiff;
      return a.firstIndex - b.firstIndex;
    })
    .flatMap((group) => group.items);
}

function retimeBeatClips(clips: TimelineClip[]): void {
  if (clips.length <= 1) return;
  let frame = Math.min(...clips.map((clip) => clip.timeline_in_frame));
  for (const clip of clips) {
    clip.timeline_in_frame = frame;
    frame += clip.timeline_duration_frames;
  }
}

// ── Chronological reorder ─────────────────────────────────────────────

function reorderChronological(
  v1Clips: TimelineClip[],
  v2Clips: TimelineClip[],
  a1Clips: TimelineClip[],
  a2Clips: TimelineClip[],
  a3Clips: TimelineClip[],
  markers: Marker[],
  beatOrder: string[] = [],
): void {
  const allVideoClips = [...v1Clips, ...v2Clips];
  const beatIndex = new Map(beatOrder.map((beatId, index) => [beatId, index]));

  if (allVideoClips.length === 0) {
    const programAudio = [...a1Clips, ...a2Clips, ...a3Clips];
    programAudio.sort((a, b) => {
      const beatCmp = (beatIndex.get(a.beat_id) ?? Number.MAX_SAFE_INTEGER) -
        (beatIndex.get(b.beat_id) ?? Number.MAX_SAFE_INTEGER);
      if (beatCmp !== 0) return beatCmp;
      return a.asset_id.localeCompare(b.asset_id) || a.src_in_us - b.src_in_us || a.clip_id.localeCompare(b.clip_id);
    });
    let frame = 0;
    const beatPositionMap = new Map<string, number>();
    for (const clip of programAudio) {
      clip.timeline_in_frame = frame;
      if (!beatPositionMap.has(clip.beat_id)) beatPositionMap.set(clip.beat_id, frame);
      frame += clip.timeline_duration_frames;
    }
    for (const clips of [a1Clips, a2Clips, a3Clips]) clips.sort((left, right) =>
      left.timeline_in_frame - right.timeline_in_frame || left.clip_id.localeCompare(right.clip_id)
    );
    for (const marker of markers) {
      if (marker.kind !== "beat") continue;
      const beatId = marker.label.split(":")[0].trim();
      const newFrame = beatPositionMap.get(beatId);
      if (newFrame != null) marker.frame = newFrame;
    }
    markers.sort((a, b) => a.frame - b.frame);
    return;
  }

  if (allVideoClips.length <= 1) return;

  // Sort final visual clips by resolved beat chronology first. Source timestamp
  // remains the fallback for generic chronological projects without beat order.
  allVideoClips.sort((a, b) => {
    const beatCmp = (beatIndex.get(a.beat_id) ?? Number.MAX_SAFE_INTEGER) -
      (beatIndex.get(b.beat_id) ?? Number.MAX_SAFE_INTEGER);
    if (beatCmp !== 0) return beatCmp;
    const assetCmp = a.asset_id.localeCompare(b.asset_id);
    if (assetCmp !== 0) return assetCmp;
    return a.src_in_us - b.src_in_us;
  });

  v1Clips.splice(0, v1Clips.length, ...allVideoClips);
  v2Clips.splice(0, v2Clips.length);

  // Reassign V1 timeline positions sequentially so the final render cannot
  // expose V1 gaps or hidden V2 overlaps after peak-based selection.
  let frame = 0;
  for (const clip of v1Clips) {
    clip.timeline_in_frame = frame;
    frame += clip.timeline_duration_frames;
  }

  // Build beat → new frame position mapping from V1
  const beatPositionMap = new Map<string, number>();
  for (const clip of v1Clips) {
    if (!beatPositionMap.has(clip.beat_id)) {
      beatPositionMap.set(clip.beat_id, clip.timeline_in_frame);
    }
  }

  // Reorder A1 clips to follow the new beat positions when audio was authored
  // before this pass. Generated nat sound is added after chronological reorder.
  for (const clips of [a1Clips, a2Clips, a3Clips]) {
    clips.sort((a, b) => {
      const posA = beatPositionMap.get(a.beat_id) ?? 0;
      const posB = beatPositionMap.get(b.beat_id) ?? 0;
      if (posA !== posB) return posA - posB;
      return a.src_in_us - b.src_in_us;
    });

    // Update timeline_in_frame to match new beat positions
    for (const clip of clips) {
      const newFrame = beatPositionMap.get(clip.beat_id);
      if (newFrame != null) {
        clip.timeline_in_frame = newFrame;
      }
    }
  }

  // Update beat markers to match new positions and re-sort
  for (const marker of markers) {
    if (marker.kind === "beat") {
      const beatId = marker.label.split(":")[0].trim();
      const newFrame = beatPositionMap.get(beatId);
      if (newFrame != null) {
        marker.frame = newFrame;
      }
    }
  }
  markers.sort((a, b) => a.frame - b.frame);
}

// ── Helpers ───────────────────────────────────────────────────────────

function groupByRole(
  candidates: ScoredCandidate[],
): Map<string, ScoredCandidate[]> {
  const groups = new Map<string, ScoredCandidate[]>();
  for (const c of candidates) {
    const role = c.candidate.role;
    const list = groups.get(role) ?? [];
    list.push(c);
    groups.set(role, list);
  }
  return groups;
}

function candidateSupportsAuthoredDialogueAudio(candidate: Candidate): boolean {
  if (candidate.media_kind === "image") return false;
  if (candidate.source_capabilities) return candidate.source_capabilities.has_audio === true;
  // Legacy candidates predate source capability materialization. Preserve the
  // historical A1 route only for an explicitly authored dialogue role.
  return candidate.role === "dialogue";
}

const V1_FIRST_ROLE_PRIORITY = new Map([
  ["hero", 0],
  ["dialogue", 1],
  ["support", 2],
  ["texture", 3],
]);

function getV1FirstCandidates(
  byRole: Map<string, ScoredCandidate[]>,
): ScoredCandidate[] {
  return [
    ...(byRole.get("hero") ?? []),
    ...(byRole.get("dialogue") ?? []),
    ...(byRole.get("support") ?? []),
    ...(byRole.get("texture") ?? []),
  ].filter((candidate) => candidateSupportsVisual(candidate.candidate)).sort(compareV1FirstCandidates);
}

function orderCandidatesByCandidatePlan(
  candidates: ScoredCandidate[],
  plan: NormalizedData["beats"][number]["candidate_plan"],
): ScoredCandidate[] {
  const refs = [
    plan?.primary_candidate_ref,
    ...(plan?.fallback_candidate_refs ?? []),
  ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  if (refs.length === 0) return [];

  const byRef = new Map<string, ScoredCandidate>();
  for (const candidate of candidates) {
    byRef.set(getCandidateRef(candidate.candidate), candidate);
    if (!byRef.has(candidate.candidate.segment_id)) {
      byRef.set(candidate.candidate.segment_id, candidate);
    }
  }
  return refs
    .map((ref) => byRef.get(ref))
    .filter((candidate): candidate is ScoredCandidate => candidate !== undefined);
}

function compareV1FirstCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  const roleDiff = (V1_FIRST_ROLE_PRIORITY.get(a.candidate.role) ?? Number.MAX_SAFE_INTEGER) -
    (V1_FIRST_ROLE_PRIORITY.get(b.candidate.role) ?? Number.MAX_SAFE_INTEGER);
  if (roleDiff !== 0) return roleDiff;
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) return scoreDiff;
  return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
}

/**
 * Unique key for a candidate's source range.
 * Uses segment_id + src_in_us + src_out_us so that different sub-ranges
 * of the same segment (e.g. multiple interview excerpts from one long take)
 * are treated as distinct clips rather than duplicates.
 */
function clipUsageKey(c: { segment_id: string; src_in_us: number; src_out_us: number }): string {
  return `${c.segment_id}:${c.src_in_us}:${c.src_out_us}`;
}

function clipPlacementUsageKey(
  c: Pick<TimelineClip, "segment_id" | "src_in_us" | "src_out_us" | "timeline_in_frame" | "timeline_duration_frames">,
): string {
  return `${clipUsageKey(c)}:${c.timeline_in_frame}:${c.timeline_duration_frames}`;
}

function getCandidateClusterKey(candidate: ScoredCandidate["candidate"]): string {
  const cluster = getCandidateSemanticCluster(candidate);
  if (cluster) return `cluster:${cluster}`;
  return getAssetPrefixCluster(candidate.asset_id);
}

function getCandidateSemanticCluster(candidate: ScoredCandidate["candidate"]): string | undefined {
  const cluster = candidate.editorial_signals?.semantic_cluster_id?.trim();
  return cluster || undefined;
}

function getAssetPrefixCluster(assetId: string): string {
  const prefix = assetId.split(/[_:-]/)[0] || assetId;
  return `asset:${prefix}`;
}

function pickBest(
  candidates: ScoredCandidate[],
  usedClips: Set<string>,
  prevAsset: string | null,
  adjacencyPenalty: number,
): ScoredCandidate | null {
  // Apply adjacency penalty and filter used source ranges, then pick best
  const available = candidates
    .filter((c) => !usedClips.has(clipUsageKey(c.candidate)))
    .map((c) => {
      let adjustedScore = c.score;
      if (prevAsset !== null && c.candidate.asset_id === prevAsset) {
        adjustedScore -= adjacencyPenalty;
      }
      return { ...c, score: adjustedScore };
    });

  // Stable sort again after adjustment
  available.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
  });

  return available[0] ?? null;
}

/**
 * Return ALL available candidates (guide mode fill).
 * Same logic as pickBest but returns the full sorted list.
 */
function pickAvailable(
  candidates: ScoredCandidate[],
  usedClips: Set<string>,
  prevAsset: string | null,
  adjacencyPenalty: number,
  clusterContinuity: boolean,
): ScoredCandidate[] {
  const available = candidates
    .filter((c) => !usedClips.has(clipUsageKey(c.candidate)))
    .map((c) => {
      let adjustedScore = c.score;
      if (prevAsset !== null && c.candidate.asset_id === prevAsset) {
        adjustedScore -= adjacencyPenalty;
      }
      return { ...c, score: adjustedScore };
    });

  available.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.candidate.segment_id.localeCompare(b.candidate.segment_id);
  });

  return clusterContinuity
    ? orderClusterBlocks(available, (sc) => getCandidateClusterKey(sc.candidate))
    : available;
}

function pickAvailableV1First(
  candidates: ScoredCandidate[],
  usedClips: Set<string>,
  prevAsset: string | null,
  adjacencyPenalty: number,
  clusterContinuity: boolean,
): ScoredCandidate[] {
  const available = candidates
    .filter((c) => !usedClips.has(clipUsageKey(c.candidate)))
    .map((c) => {
      let adjustedScore = c.score;
      if (prevAsset !== null && c.candidate.asset_id === prevAsset) {
        adjustedScore -= adjacencyPenalty;
      }
      return { ...c, score: adjustedScore };
    });

  available.sort(compareV1FirstCandidates);

  const ordered = clusterContinuity
    ? orderClusterBlocks(available, (sc) => getCandidateClusterKey(sc.candidate))
    : available;
  return preferVisualBridgeCandidate(ordered, prevAsset);
}

function preferVisualBridgeCandidate(
  candidates: ScoredCandidate[],
  prevAsset: string | null,
): ScoredCandidate[] {
  if (!prevAsset || candidates.length < 2) return candidates;

  const first = candidates[0];
  if (first.candidate.asset_id !== prevAsset || first.candidate.role !== "dialogue") {
    return candidates;
  }

  const bridgeIndex = candidates.findIndex((candidate, index) =>
    index > 0 &&
    candidate.candidate.asset_id !== prevAsset &&
    candidate.candidate.role !== "dialogue" &&
    isIntentionalVisualBridge(candidate.candidate) &&
    candidate.score >= first.score
  );
  if (bridgeIndex < 0) return candidates;

  const bridge = candidates[bridgeIndex];
  return [
    bridge,
    ...candidates.slice(0, bridgeIndex),
    ...candidates.slice(bridgeIndex + 1),
  ];
}

function isIntentionalVisualBridge(candidate: ScoredCandidate["candidate"]): boolean {
  return candidate.evidence?.includes("visual_variety") === true ||
    candidate.trim_hint?.peak_type === "visual_peak" ||
    candidate.editorial_signals?.peak_type === "visual_peak";
}

function getRunnersUp(
  candidates: ScoredCandidate[],
  chosen: ScoredCandidate,
  usedClips: Set<string>,
): { segment_ids: string[]; candidate_refs: string[] } {
  const runners = candidates
    .filter(
      (c) =>
        clipUsageKey(c.candidate) !== clipUsageKey(chosen.candidate) &&
        !usedClips.has(clipUsageKey(c.candidate)),
    )
    .slice(0, 2);
  return {
    segment_ids: runners.map((c) => c.candidate.segment_id),
    candidate_refs: runners.map((c) => getCandidateRef(c.candidate)),
  };
}

function makeClip(
  scored: ScoredCandidate,
  beatId: string,
  timelineInFrame: number,
  beatDurationFrames: number,
  clipNum: number,
  fallbacks: { segment_ids: string[]; candidate_refs: string[] },
  usPerFrame: number,
  stillDurationPolicy?: StillDurationPolicy,
): TimelineClip {
  const c = scored.candidate;
  if (c.media_kind === "image") {
    if (!stillDurationPolicy) throw new Error("still_image_duration_policy_missing");
    const stillImage = resolveStillImageHold(c, stillDurationPolicy, beatDurationFrames);
    return {
      clip_id: `CLP_${String(clipNum).padStart(4, "0")}`,
      segment_id: c.segment_id,
      asset_id: c.asset_id,
      src_in_us: c.src_in_us,
      src_out_us: c.src_out_us,
      timeline_in_frame: timelineInFrame,
      timeline_duration_frames: stillImage.hold_frames,
      role: c.role as TimelineClip["role"],
      motivation: c.why_it_matches,
      beat_id: beatId,
      fallback_segment_ids: fallbacks.segment_ids,
      confidence: c.confidence,
      quality_flags: c.quality_flags ?? [],
      media_kind: "image",
      source_capabilities: c.source_capabilities ? { ...c.source_capabilities } : { has_video: true, has_audio: false },
      still_image: stillImage,
      candidate_ref: getCandidateRef(c),
      fallback_candidate_refs: fallbacks.candidate_refs,
    };
  }
  const sourceDurationUs = c.src_out_us - c.src_in_us;
  const sourceDurationFrames = Math.ceil(sourceDurationUs / usPerFrame);
  const trimPreferredFrames = c.trim_hint?.preferred_duration_us
    ? Math.ceil(c.trim_hint.preferred_duration_us / usPerFrame)
    : undefined;
  const clampedDurationFrames = Math.min(
    beatDurationFrames,
    trimPreferredFrames ?? sourceDurationFrames,
    sourceDurationFrames,
  );

  return {
    clip_id: `CLP_${String(clipNum).padStart(4, "0")}`,
    segment_id: c.segment_id,
    asset_id: c.asset_id,
    src_in_us: c.src_in_us,
    src_out_us: c.src_out_us,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: clampedDurationFrames,
    role: c.role as TimelineClip["role"],
    motivation: c.why_it_matches,
    beat_id: beatId,
    fallback_segment_ids: fallbacks.segment_ids,
    confidence: c.confidence,
    quality_flags: c.quality_flags ?? [],
    ...(c.media_kind ? { media_kind: c.media_kind } : {}),
    ...(c.source_capabilities ? { source_capabilities: { ...c.source_capabilities } } : {}),
    ...(c.audio_role ? { audio_role: c.audio_role } : {}),
    candidate_ref: getCandidateRef(c),
    fallback_candidate_refs: fallbacks.candidate_refs,
  };
}

function addOriginalAudioForVideoClips(
  videoClips: TimelineClip[],
  a1Clips: TimelineClip[],
  audioPolicy: BriefAudioPolicy,
  startClipCounter: number,
  a1Loudnorm: boolean,
): void {
  const existing = new Set(a1Clips.map((clip) => clipPlacementUsageKey(clip)));
  let clipCounter = startClipCounter;

  for (const videoClip of videoClips) {
    if (videoClip.media_kind === "image") continue;
    if (videoClip.source_capabilities?.has_audio === false) continue;
    const key = clipPlacementUsageKey(videoClip);
    if (existing.has(key)) continue;
    if (hasPrimaryAudioOverlap(videoClip, a1Clips)) continue;

    a1Clips.push({
      ...videoClip,
      clip_id: `ACL_${String(++clipCounter).padStart(4, "0")}`,
      role: "nat_sound",
      motivation: "original clip audio",
      confidence: Math.max(videoClip.confidence, 0.9),
      audio_policy: {
        mode: audioPolicy,
        gain_unit: "linear",
        preserve_nat_sound: true,
        nat_gain: audioPolicy === "original_only" ? 1 : 1.8,
        a1_loudnorm: a1Loudnorm,
      },
    });
    existing.add(key);
  }
}

function hasPrimaryAudioOverlap(videoClip: TimelineClip, a1Clips: TimelineClip[]): boolean {
  return a1Clips.some((clip) => {
    if (clip.motivation === "original clip audio" || clip.role === "nat_sound") return false;
    return rangesOverlap(
      videoClip.timeline_in_frame,
      videoClip.timeline_in_frame + videoClip.timeline_duration_frames,
      clip.timeline_in_frame,
      clip.timeline_in_frame + clip.timeline_duration_frames,
    );
  });
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}
