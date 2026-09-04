import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { stringify as stringifyYaml } from "yaml";
import { runReview, type ReviewAgent, type ReviewReport } from "../runtime/commands/review.js";
import { writeProjectState } from "../runtime/state/reconcile.js";
import {
  type WholeCutAxisOutcome,
  type WholeCutSemanticProvider,
  type WholeCutSemanticProviderObservation,
} from "../runtime/review/whole-cut-semantic.js";
import type { CreativeBrief } from "../runtime/artifacts/types.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";

type FixtureStyle = "action_sequence" | "talking_head" | "day_log";
type FixtureCase =
  | "clean"
  | "vo_image_mismatch"
  | "false_chronology"
  | "dense_without_progression"
  | "unidentifiable_protagonist"
  | "incoherent_emotion_story"
  | "intentional_contrast"
  | "intentional_non_linear";

interface SceneEvidence {
  scene_id: string;
  start_sec: number;
  end_sec: number;
  visual_subject_ids: string[];
  action: string;
  phase: "setup" | "development" | "resolution";
  emotional_state: string;
  semantic_topic: string;
  sequence_role: "origin" | "transition" | "outcome";
}

interface TranscriptEvidence {
  start_sec: number;
  end_sec: number;
  text: string;
  semantic_topic: string;
}

interface EditorialEvidence {
  scenes: SceneEvidence[];
  transcript: TranscriptEvidence[];
  declared_relation?: "contrast";
  declared_order?: "non_linear";
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureBrief(projectId: string, style: FixtureStyle): CreativeBrief {
  return {
    version: "1",
    project_id: projectId,
    project: {
      id: projectId,
      title: "Generic editorial regression fixture",
      strategy: `${style} with a clear change and retained message`,
      runtime_target_sec: 30,
    },
    message: { primary: "A clear change is understandable when the sequence preserves cause and result." },
    audience: { primary: "viewers evaluating a coherent short sequence" },
    emotion_curve: ["uncertainty", "understanding", "release"],
    must_have: ["an identifiable narrative anchor", "a visible cause and result"],
    must_avoid: ["unexplained chronology", "emotion without situation"],
    autonomy: { mode: "full", may_decide: ["pacing"], must_ask: ["ambiguous interpretation"] },
    resolved_assumptions: ["The whole rendered cut is the semantic review authority."],
  };
}

function baseScenes(style: FixtureStyle): SceneEvidence[] {
  const scripts: Record<FixtureStyle, Array<Pick<SceneEvidence, "action" | "phase" | "emotional_state" | "sequence_role">>> = {
    action_sequence: [
      { action: "starts a controlled movement", phase: "setup", emotional_state: "uncertainty", sequence_role: "origin" },
      { action: "changes the visible state through a clear response", phase: "development", emotional_state: "understanding", sequence_role: "transition" },
      { action: "settles on the resulting state", phase: "resolution", emotional_state: "release", sequence_role: "outcome" },
    ],
    talking_head: [
      { action: "states the starting condition", phase: "setup", emotional_state: "uncertainty", sequence_role: "origin" },
      { action: "explains the response and demonstrates the change", phase: "development", emotional_state: "understanding", sequence_role: "transition" },
      { action: "summarizes the resulting state", phase: "resolution", emotional_state: "release", sequence_role: "outcome" },
    ],
    day_log: [
      { action: "opens on the initial routine", phase: "setup", emotional_state: "uncertainty", sequence_role: "origin" },
      { action: "records a practical adjustment", phase: "development", emotional_state: "understanding", sequence_role: "transition" },
      { action: "closes on the changed routine", phase: "resolution", emotional_state: "release", sequence_role: "outcome" },
    ],
  };
  return scripts[style].map((script, index) => ({
    scene_id: `scene_${index}`,
    start_sec: index * 10,
    end_sec: (index + 1) * 10,
    visual_subject_ids: ["anchor_subject"],
    semantic_topic: "change",
    ...script,
  }));
}

function reindexScenes(scenes: SceneEvidence[]): SceneEvidence[] {
  return scenes.map((scene, index) => ({
    ...scene,
    scene_id: `scene_${index}`,
    start_sec: index * 10,
    end_sec: (index + 1) * 10,
  }));
}

function makeEditorialEvidence(style: FixtureStyle, fixtureCase: FixtureCase): EditorialEvidence {
  let scenes = baseScenes(style);
  let declaredRelation: EditorialEvidence["declared_relation"];
  let declaredOrder: EditorialEvidence["declared_order"];

  if (fixtureCase === "dense_without_progression") {
    scenes = scenes.map((scene) => ({
      ...scene,
      action: "holds the same visible state",
      phase: "development",
      emotional_state: "understanding",
      sequence_role: "transition",
    }));
  }
  if (fixtureCase === "vo_image_mismatch") {
    scenes = scenes.map((scene) => ({ ...scene, semantic_topic: "visible_change" }));
  }
  if (fixtureCase === "false_chronology" || fixtureCase === "intentional_non_linear") {
    scenes = reindexScenes([scenes[2], scenes[0], scenes[1]]);
  }
  if (fixtureCase === "intentional_non_linear") {
    scenes = scenes.map((scene, index) => ({
      ...scene,
      emotional_state: ["uncertainty", "understanding", "release"][index]!,
    }));
  }
  if (fixtureCase === "unidentifiable_protagonist") {
    scenes = scenes.map((scene, index) => ({
      ...scene,
      visual_subject_ids: [`candidate_subject_${index}`],
    }));
  }
  if (fixtureCase === "incoherent_emotion_story") {
    scenes = scenes.map((scene, index) => ({
      ...scene,
      emotional_state: ["release", "uncertainty", "release"][index]!,
    }));
  }
  if (fixtureCase === "intentional_contrast") {
    scenes = scenes.map((scene) => ({ ...scene, semantic_topic: "visual_change" }));
    declaredRelation = "contrast";
  }
  if (fixtureCase === "intentional_non_linear") declaredOrder = "non_linear";

  const transcriptTopic = fixtureCase === "vo_image_mismatch" || fixtureCase === "intentional_contrast"
    ? "spoken_context"
    : "change";
  const transcript = scenes.map((scene, index) => ({
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    text: `${style} evidence explains the ${index === 0 ? "starting condition" : index === 1 ? "response" : "resulting state"}.`,
    semantic_topic: transcriptTopic,
  }));
  if (fixtureCase === "dense_without_progression") {
    for (const item of transcript) item.text = "The same state is repeated without a new situation.";
  }

  return {
    scenes,
    transcript,
    ...(declaredRelation ? { declared_relation: declaredRelation } : {}),
    ...(declaredOrder ? { declared_order: declaredOrder } : {}),
  };
}

function createRegressionProject(style: FixtureStyle, fixtureCase: FixtureCase): string {
  const projectId = `issue31-${style}-${fixtureCase}`;
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue31-editorial-"));
  tempDirs.push(projectDir);
  for (const relative of ["01_intent", "02_media", "03_analysis", "04_plan", "05_timeline"]) {
    fs.mkdirSync(path.join(projectDir, relative), { recursive: true });
  }

  const brief = fixtureBrief(projectId, style);
  fs.writeFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), stringifyYaml(brief));
  fs.writeFileSync(path.join(projectDir, "01_intent/unresolved_blockers.yaml"), stringifyYaml({
    version: "1",
    project_id: projectId,
    blockers: [],
  }));
  fs.writeFileSync(
    path.join(projectDir, "03_analysis/editorial-evidence.json"),
    JSON.stringify(makeEditorialEvidence(style, fixtureCase), null, 2),
  );

  const assetIds = fixtureCase === "dense_without_progression"
    ? Array.from({ length: 6 }, (_, index) => `asset_${String(index).padStart(2, "0")}`)
    : ["asset_alpha", "asset_beta", "asset_gamma"];
  const sourceItems = assetIds.map((assetId) => {
    const sourcePath = path.join(projectDir, "02_media", `${assetId}.mp4`);
    fs.writeFileSync(sourcePath, `source-${assetId}`);
    return {
      asset_id: assetId,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: `02_media/${assetId}.mp4`,
      media_kind: "video",
    };
  });
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1",
    project_id: projectId,
    media_dir: "02_media",
    generated_at: "2026-09-01T00:00:00.000Z",
    items: sourceItems,
  }, null, 2));

  const clipCount = fixtureCase === "dense_without_progression" ? 30 : 3;
  const clips = Array.from({ length: clipCount }, (_, index) => {
    const assetId = assetIds[index % assetIds.length];
    return {
      clip_id: `clip_${String(index).padStart(2, "0")}`,
      segment_id: `segment_${String(index).padStart(2, "0")}`,
      asset_id: assetId,
      src_in_us: 0,
      src_out_us: 1_000_000,
      timeline_in_frame: fixtureCase === "dense_without_progression" ? index : index * 10,
      timeline_duration_frames: fixtureCase === "dense_without_progression" ? 1 : 10,
      role: "hero",
      motivation: "generic fixture coverage",
      beat_id: index < clipCount / 3 ? "beat_open" : index < clipCount * 2 / 3 ? "beat_middle" : "beat_close",
      fallback_segment_ids: [],
      confidence: 0.85,
      quality_flags: [],
    };
  });
  const timeline = {
    version: "timeline-issue31-regression",
    project_id: projectId,
    created_at: "2026-09-01T00:00:00.000Z",
    sequence: {
      name: "Generic regression sequence",
      fps_num: 1,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      output_aspect_ratio: "16:9",
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "issue31-fixture",
    },
  };
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify(timeline, null, 2));

  fs.writeFileSync(path.join(projectDir, "04_plan/selects_candidates.yaml"), stringifyYaml({
    version: "1",
    project_id: projectId,
    candidates: [{
      segment_id: "segment_00",
      asset_id: assetIds[0],
      src_in_us: 0,
      src_out_us: 1_000_000,
      role: "hero",
      why_it_matches: "generic narrative anchor",
      risks: [],
      confidence: 0.85,
      evidence: ["message.primary"],
    }],
  }));
  fs.writeFileSync(path.join(projectDir, "04_plan/edit_blueprint.yaml"), stringifyYaml({
    version: "1",
    project_id: projectId,
    sequence_goals: ["make cause and result legible"],
    beats: [
      { id: "beat_open", label: "opening", purpose: "establish the narrative anchor", target_duration_frames: 10, required_roles: ["hero"] },
      { id: "beat_middle", label: "middle", purpose: "show the change", target_duration_frames: 10, required_roles: ["hero"] },
      { id: "beat_close", label: "close", purpose: "retain the message", target_duration_frames: 10, required_roles: ["hero"] },
    ],
    pacing: { opening_cadence: "steady", middle_cadence: "steady", ending_cadence: "breath" },
    music_policy: { start_sparse: true, allow_release_late: true, entry_beat: "beat_middle" },
    dialogue_policy: { preserve_natural_breath: true, avoid_wall_to_wall_voiceover: true },
    transition_policy: { prefer_match_texture_over_flashy_fx: true },
    ending_policy: { should_feel: "clear" },
    rejection_rules: ["do not lose the central message"],
  }));
  fs.writeFileSync(path.join(projectDir, "04_plan/uncertainty_register.yaml"), stringifyYaml({
    version: "1",
    project_id: projectId,
    uncertainties: [],
  }));
  writeProjectState(projectDir, {
    version: 1,
    project_id: projectId,
    current_state: "blueprint_ready",
    history: [],
  });
  return projectDir;
}

function readEditorialEvidence(projectDir: string): EditorialEvidence {
  return JSON.parse(fs.readFileSync(path.join(projectDir, "03_analysis/editorial-evidence.json"), "utf8")) as EditorialEvidence;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function evidenceDrivenProvider(): WholeCutSemanticProvider {
  return {
    id: "issue31-structured-evidence-adapter",
    capability: "available",
    async observeWindow(input) {
      const evidence = readEditorialEvidence(input.project_dir);
      const timeline = JSON.parse(fs.readFileSync(path.join(input.project_dir, input.timeline_path), "utf8")) as {
        tracks?: { video?: Array<{ clips?: Array<{ clip_id?: string }> }> };
      };
      const clipCount = (timeline.tracks?.video ?? []).reduce(
        (sum, track) => sum + (track.clips?.length ?? 0),
        0,
      );
      const visualTopic = mostCommon(evidence.scenes.map((scene) => scene.semantic_topic));
      const transcriptTopic = mostCommon(evidence.transcript.map((item) => item.semantic_topic));
      const orderRank: Record<SceneEvidence["sequence_role"], number> = {
        origin: 0,
        transition: 1,
        outcome: 2,
      };
      const falseChronology = evidence.declared_order !== "non_linear" && evidence.scenes.some((scene, index) =>
        index > 0 && orderRank[scene.sequence_role] < orderRank[evidence.scenes[index - 1]!.sequence_role],
      );
      const subjectCounts = new Map<string, number>();
      for (const scene of evidence.scenes) {
        for (const subjectId of scene.visual_subject_ids) {
          subjectCounts.set(subjectId, (subjectCounts.get(subjectId) ?? 0) + 1);
        }
      }
      const stableSubject = [...subjectCounts.values()].some((count) => count >= Math.ceil(evidence.scenes.length / 2));
      const curvePositions = new Map(input.brief.emotion_curve.map((emotion, index) => [emotion.toLowerCase(), index]));
      const emotionPositions = evidence.scenes
        .map((scene) => curvePositions.get(scene.emotional_state.toLowerCase()))
        .filter((position): position is number => position !== undefined);
      const incoherentEmotionStory = emotionPositions.some((position, index) =>
        index > 0 && position < emotionPositions[index - 1]!,
      );
      const stateSignatures = new Set(evidence.scenes.map((scene) => [
        scene.action,
        scene.phase,
        scene.emotional_state,
        scene.semantic_topic,
      ].join("|")));
      const denseWithoutProgression = clipCount / Math.max(input.duration_sec, 1) * 10 >= 3 && stateSignatures.size < 2;
      const issueAxes = new Set<string>();
      const issueReasons = new Map<string, string>();
      if (visualTopic !== undefined && transcriptTopic !== undefined && visualTopic !== transcriptTopic && evidence.declared_relation !== "contrast") {
        issueAxes.add("semantic_agreement_or_intended_contrast");
        issueReasons.set("semantic_agreement_or_intended_contrast", "Scene topics and transcript topics disagree without declared contrast intent.");
      }
      if (falseChronology) {
        issueAxes.add("role_time_context");
        issueReasons.set("role_time_context", "The structured causal roles are presented in an order that reverses their stated context.");
      }
      if (!stableSubject) {
        issueAxes.add("protagonist_story_identity");
        issueReasons.set("protagonist_story_identity", "No stable visual subject identity persists across the whole-cut scenes.");
      }
      if (incoherentEmotionStory) {
        issueAxes.add("information_emotion_situation_progression");
        issueReasons.set("information_emotion_situation_progression", "The emotional sequence reverses against the brief's situation progression.");
      }

      const observationId = `observation-${input.start_sec}`;
      const observation: WholeCutSemanticProviderObservation = {
        observation_id: observationId,
        start_sec: input.start_sec,
        end_sec: input.end_sec,
        observation: `Structured scene and transcript evidence covers ${evidence.scenes.length} scene intervals and ${evidence.transcript.length} transcript intervals.`,
        inference: issueAxes.size > 0
          ? [...issueAxes].map((axis) => issueReasons.get(axis)).filter(Boolean).join(" ")
          : "The evidence preserves an identifiable anchor, causal order, and the brief's progression.",
        confidence: 0.84,
        confidence_basis: "measured",
        evidence: {
          render: {
            path: input.render_path,
            start_sec: input.start_sec,
            end_sec: input.end_sec,
            sha256: input.render_sha256,
          },
          source_clip_ids: input.active_clip_ids,
        },
        axis_results: input.axes.map((axis) => {
          const intentionalOutcome: WholeCutAxisOutcome | undefined = axis.axis_id === "semantic_agreement_or_intended_contrast" && evidence.declared_relation === "contrast"
            ? "intentional_contrast"
            : axis.axis_id === "intentional_ambiguity_vs_missing_explanation" && evidence.declared_order === "non_linear"
              ? "intentional_non_linear"
              : undefined;
          const outcome = intentionalOutcome ?? (issueAxes.has(axis.axis_id) ? "problem" : "pass");
          return {
            axis_id: axis.axis_id,
            outcome,
            confidence: 0.84,
            confidence_basis: "measured" as const,
            brief_refs: axis.brief_refs,
            rationale: intentionalOutcome
              ? "The structured evidence declares and supports this expressive relationship."
              : issueReasons.get(axis.axis_id) ?? "The structured evidence supports this axis across the observed interval.",
          };
        }),
        story_progression: {
          score: denseWithoutProgression ? 0.2 : 0.84,
          confidence: 0.84,
          confidence_basis: "measured",
        },
      };
      const problemRanges = [...issueAxes].map((axisId) => ({
        problem_id: `problem-${axisId}-${input.start_sec}`,
        axis_id: axisId,
        start_sec: input.start_sec,
        end_sec: input.end_sec,
        observation_ids: [observationId],
        summary: issueReasons.get(axisId) ?? "The structured evidence exposes a brief-relevant semantic problem.",
        evidence: observation.evidence,
        brief_refs: input.axes.find((axis) => axis.axis_id === axisId)!.brief_refs,
        brief_mismatch: "The evidence does not support the brief-bound reading for this axis.",
        recommended_correction: "Review the affected whole-cut range and compare an evidence-bound alternative.",
      }));
      return { observations: [observation], problem_ranges: problemRanges };
    },
  };
}

function regressionReviewAgent(): ReviewAgent {
  return {
    async run(ctx) {
      const report: ReviewReport = {
        version: "2",
        project_id: ctx.projectId,
        timeline_version: ctx.timelineVersion,
        summary_judgment: {
          status: "approved",
          rationale: "The fixture agent supplied a baseline report.",
          confidence: 0.82,
          confidence_basis: "measured",
        },
        strengths: [],
        weaknesses: [],
        fatal_issues: [],
        warnings: [],
        mismatches_to_brief: [],
        mismatches_to_blueprint: [],
        recommended_next_pass: { goal: "preserve a coherent whole cut", actions: ["review semantic result"] },
        editorial_judgments: [{
          observation: "The fixture window contains visible sequence material.",
          inference: "The material may support the stated message.",
          editorial_intent: "Keep the message legible while revising unsupported readings.",
          evidence: [{ kind: "artifact_ref", ref: "01_intent/creative_brief.yaml" }],
          confidence: 0.8,
          confidence_basis: "measured",
        }],
      };
      return {
        report,
        patch: { timeline_version: ctx.timelineVersion, operations: [] },
      };
    },
  };
}

function reviewOptions(projectDir: string) {
  const renderImpl = async ({ outputPath, projectDir: renderProjectDir }: { outputPath?: string; projectDir: string }) => {
    const resolved = outputPath ?? path.join(renderProjectDir, "09_output/rough-cut.mp4");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=16x16:r=1:d=30",
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y", resolved,
    ]);
    return {
      outputPath: resolved,
      workingDir: path.join(renderProjectDir, ".tmp"),
      timelineDurationFrames: 30,
      videoSegmentCount: 1,
      audioClipCount: 0,
    };
  };
  const qaReport = (videoPath: string): MarlinQAReport => {
    const evidence = readEditorialEvidence(projectDir);
    return {
      version: "1",
      project_id: path.basename(projectDir),
      video_path: videoPath,
      video_duration_sec: 30,
      overall_assessment: "fixture visual QA derived from structured scene evidence",
      scene_descriptions: evidence.scenes.map((scene) => ({
        start_sec: scene.start_sec,
        end_sec: scene.end_sec,
        description: `${scene.action}; subject ids ${scene.visual_subject_ids.join(", ")}`,
      })),
      issues: [],
      pacing_assessment: { too_fast: false, too_slow: false, notes: "fixture" },
      emotion_arc_assessment: { follows_brief: true, notes: "fixture" },
      score: 95,
      visual_qa: "verified",
    };
  };
  return {
    render: true,
    requireCompiledTimeline: true,
    skipPreview: true,
    wholeCutSemantic: {
      provider: evidenceDrivenProvider(),
      assembleTimelineToMp4Impl: renderImpl,
    },
    visualQA: {
      assembleTimelineToMp4Impl: renderImpl,
      runDeterministicOutputQAImpl: async () => ({
        status: "verified" as const,
        duration_sec: 30,
        width: 1920,
        height: 1080,
        issues: [],
      }),
      runMarlinQAImpl: async (_dir: string, videoPath: string) => qaReport(videoPath),
    },
    operatorAccept: async () => ({ accepted: true, approvedBy: "fixture-operator" }),
  };
}

describe("Issue #31 editorial intelligence regression fixture", () => {
  it("uses the same evidence-only adapter across meaningfully distinct action, talking-head, and day-log fixtures", async () => {
    for (const style of ["action_sequence", "talking_head", "day_log"] as const) {
      const projectDir = createRegressionProject(style, "clean");
      const result = await runReview(projectDir, regressionReviewAgent(), reviewOptions(projectDir));

      expect(result.success, style).toBe(true);
      expect(result.newState, style).toBe("approved");
      expect(result.report?.whole_cut_semantic?.coverage.status, style).toBe("complete");
      expect(result.report?.whole_cut_semantic?.semantic_outcome.status, style).toBe("pass");
    }
  }, 180_000);

  it.each([
    ["vo_image_mismatch", "semantic_agreement_or_intended_contrast"],
    ["false_chronology", "role_time_context"],
    ["unidentifiable_protagonist", "protagonist_story_identity"],
    ["incoherent_emotion_story", "information_emotion_situation_progression"],
  ] as const)("derives %s from scene/transcript/timeline evidence", async (fixtureCase, axisId) => {
    const projectDir = createRegressionProject("talking_head", fixtureCase);
    const result = await runReview(projectDir, regressionReviewAgent(), reviewOptions(projectDir));

    expect(result.success).toBe(true);
    expect(result.newState).toBe("critique_ready");
    expect(result.report?.summary_judgment.status).not.toBe("approved");
    const semantic = result.report?.whole_cut_semantic;
    expect(semantic?.problem_ranges.some((problem) => problem.axis_id === axisId)).toBe(true);
    expect(semantic?.problem_ranges.every((problem) => problem.render_evidence.sha256.length === 64)).toBe(true);
    expect(semantic?.problem_ranges.every((problem) => problem.source_evidence.length > 0)).toBe(true);
  }, 180_000);

  it("separates dense micro-cut tempo from story progression", async () => {
    const projectDir = createRegressionProject("action_sequence", "dense_without_progression");
    const result = await runReview(projectDir, regressionReviewAgent(), reviewOptions(projectDir));
    const semantic = result.report?.whole_cut_semantic;

    expect(result.success).toBe(true);
    expect(result.newState).toBe("critique_ready");
    expect(semantic?.cut_density.cut_count).toBeGreaterThan(10);
    expect(semantic?.story_progression.relationship).toBe("dense_without_progression");
    expect(semantic?.semantic_outcome.status).toBe("needs_revision");
  }, 180_000);

  it("does not fail intentional contrast or non-linear expression solely for mismatch or chronology", async () => {
    for (const fixtureCase of ["intentional_contrast", "intentional_non_linear"] as const) {
      const projectDir = createRegressionProject("day_log", fixtureCase);
      const result = await runReview(projectDir, regressionReviewAgent(), reviewOptions(projectDir));

      expect(result.success, fixtureCase).toBe(true);
      expect(result.newState, fixtureCase).toBe("approved");
      expect(result.report?.whole_cut_semantic?.problem_ranges, fixtureCase).toHaveLength(0);
      expect(result.report?.whole_cut_semantic?.semantic_outcome.status, fixtureCase).toBe("pass");
    }
  }, 180_000);
});
