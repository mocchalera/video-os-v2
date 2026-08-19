import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PremiereFinishReviewError,
  projectPremiereFinishReview,
  type PremierePreflightChildResult,
  type PremierePreflightInvocation,
} from "../runtime/handoff/premiere-finish-review.js";
import type { TimelineIR } from "../runtime/compiler/types.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const richFixture = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "tests/fixtures/premiere/finish-surfaces-rich-v1.json"),
  "utf8",
)) as { fixture_kind: string; timeline: TimelineIR };
const temporaryRoots: string[] = [];
const requestSha = `sha256:${"a".repeat(64)}`;

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("fixture is not JSON");
  return encoded;
}

function invocationReceipt(
  variant: "source_ffprobe" | "ffmpeg_version",
  trackId: string,
  clipId: string,
  evaluationOrdinal: number,
  evaluationSha: string,
): Record<string, unknown> {
  const operationOrdinal = variant === "source_ffprobe" ? 0 : 1;
  const binding = {
    preflight_run_id: "run-fixture", wrapper2_pid: 4242, evaluation_ordinal: evaluationOrdinal,
    track_id: trackId, clip_id: clipId, evaluation_sha256: evaluationSha, request_sha256: null,
    ready_cache_generation_id: null, operation_ordinal: operationOrdinal,
  };
  const body = {
    variant, binding, executable_realpath: variant === "source_ffprobe" ? "/opt/homebrew/bin/ffprobe" : "/opt/homebrew/bin/ffmpeg",
    argv: variant === "source_ffprobe" ? ["-v", "error", "-show_format", "-show_streams", "-of", "json", "file:/dev/fd/3"] : ["-version"],
    child_pid: 5000 + evaluationOrdinal * 10 + operationOrdinal, parent_pid: 4242, exit_code: 0, signal: null,
    stdout_sha256: hash(`${variant}-stdout`), stderr_sha256: hash(""),
  };
  return { ...body, receipt_sha256: hash(canonical(body)) };
}

function evaluationAssociation(clip: Record<string, unknown>, evaluationOrdinal: number): Record<string, unknown> {
  const trackId = String(clip.track_id), clipId = String(clip.clip_id), request = String(clip.request_sha256);
  const evaluationSha = hash(`evaluation:${evaluationOrdinal}:${trackId}:${clipId}`);
  const sourceReceipt = invocationReceipt("source_ffprobe", trackId, clipId, evaluationOrdinal, evaluationSha);
  const versionReceipt = invocationReceipt("ffmpeg_version", trackId, clipId, evaluationOrdinal, evaluationSha);
  return {
    version: "premiere-effect-bake-evaluation-association/v1", preflight_run_id: "run-fixture", evaluation_ordinal: evaluationOrdinal,
    track_id: trackId, clip_id: clipId, discovery_sha256: hash("discovery"),
    ffmpeg_discovery_receipt_sha256: hash("ffmpeg-discovery"), ffprobe_discovery_receipt_sha256: hash("ffprobe-discovery"),
    evaluation_sha256: evaluationSha,
    source_probe_invocation_receipt: sourceReceipt,
    source_probe_broker_invocation_receipt_sha256: sourceReceipt.receipt_sha256,
    ffmpeg_version_invocation_receipt: versionReceipt,
    broker_invocation_receipt_sha256: versionReceipt.receipt_sha256,
    ffmpeg_version_sha256: hash("ffmpeg version fixture\n"), request_sha256: request,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function cloneTimeline(source: TimelineIR = richFixture.timeline): TimelineIR {
  return JSON.parse(JSON.stringify(source)) as TimelineIR;
}

function minimalTimeline(treated = false): TimelineIR {
  const timeline = cloneTimeline();
  timeline.project_id = treated ? "finish-treated" : "finish-native";
  timeline.tracks.video = [{
    ...timeline.tracks.video[0],
    clips: [{
      ...timeline.tracks.video[0].clips[0],
      ...(treated ? { metadata: { zoom: 1.25 } } : {}),
    }],
  }];
  timeline.tracks.audio = [];
  timeline.tracks.overlay = [];
  timeline.tracks.caption = [];
  timeline.transitions = [];
  return timeline;
}

function makeProject(timeline: TimelineIR): { root: string; timelinePath: string } {
  const tempBase = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, "s4br-finish-review-"));
  temporaryRoots.push(root);
  const timelineDir = path.join(root, "05_timeline");
  fs.mkdirSync(timelineDir);
  const timelinePath = path.join(timelineDir, "timeline.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
  return { root, timelinePath };
}

function result(
  projectId: string,
  clips: Array<Record<string, unknown>>,
  status: number,
  overrides: Partial<PremierePreflightChildResult> = {},
): PremierePreflightChildResult {
  return {
    status,
    signal: null,
    stdout: JSON.stringify({ mode: "preflight", project_id: projectId, hardware_verified: false, clips }),
    stderr: "",
    ...overrides,
  };
}

function timelineRevision(timelinePath: string): { sha: string; identity: Record<string, string | number>; encodedIdentity: string } {
  const stat = fs.statSync(timelinePath, { bigint: true });
  const identity = {
    dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode), nlink: Number(stat.nlink),
    size: Number(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs),
  };
  return {
    sha: `sha256:${createHash("sha256").update(fs.readFileSync(timelinePath)).digest("hex")}`,
    identity,
    encodedIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
  };
}

function revisionBoundResult(
  projectId: string,
  clips: Array<Record<string, unknown>>,
  status: number,
  revision: ReturnType<typeof timelineRevision>,
  overrides: Record<string, unknown> = {},
): PremierePreflightChildResult {
  return {
    status,
    signal: null,
    stdout: JSON.stringify({
      mode: "preflight", project_id: projectId, hardware_verified: false, clips,
      child_used_timeline_sha256: revision.sha,
      child_used_timeline_identity: revision.identity,
      ...overrides,
    }),
    stderr: "",
  };
}

function nativeClips(timeline: TimelineIR): Array<Record<string, unknown>> {
  return timeline.tracks.video.flatMap((track) => track.clips.map((clip) => ({
    clip_id: clip.clip_id,
    track_id: track.track_id,
    status: "native",
  })));
}

function runner(child: PremierePreflightChildResult, inspect?: (invocation: PremierePreflightInvocation) => void, attachAssociations = true) {
  return (invocation: PremierePreflightInvocation): PremierePreflightChildResult => {
    inspect?.(invocation);
    try {
      const parsed = JSON.parse(child.stdout) as Record<string, unknown>;
      if (attachAssociations && Array.isArray(parsed.clips)) {
        parsed.clips = parsed.clips.map((value, index) => {
          const clip = value as Record<string, unknown>;
          return clip.request_sha256 !== undefined && clip.evaluation_association === undefined
            ? { ...clip, evaluation_association: evaluationAssociation(clip, index + 1) }
            : clip;
        });
      }
      if (parsed.mode === "preflight"
        && !Object.hasOwn(parsed, "child_used_timeline_sha256")
        && !Object.hasOwn(parsed, "child_used_timeline_identity")) {
        return {
          ...child,
          stdout: JSON.stringify({
            ...parsed,
            child_used_timeline_sha256: invocation.args[5],
            child_used_timeline_identity: JSON.parse(Buffer.from(invocation.args[7], "base64url").toString("utf8")),
          }),
        };
      }
    } catch {
      // Preserve malformed fixtures byte-for-byte for strict decoder tests.
    }
    return child;
  };
}

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error("expected PremiereFinishReviewError");
  } catch (error) {
    expect(error).toBeInstanceOf(PremiereFinishReviewError);
    expect((error as PremiereFinishReviewError).code).toBe(code);
  }
}

function projectSnapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`d:${relative}:${stat.mode}:${stat.nlink}`);
        walk(absolute);
      } else {
        entries.push(`f:${relative}:${stat.mode}:${stat.nlink}:${fs.readFileSync(absolute).toString("base64")}`);
      }
    }
  };
  walk(root);
  return entries;
}

describe("Premiere finish review projection", () => {
  it("rejects omitted, tampered, relabeled, or reused evaluation associations", () => {
    const timeline = minimalTimeline(true), project = makeProject(timeline);
    const clip = { clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha };
    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot, preflightRunner: runner(result(timeline.project_id, [clip], 2), undefined, false),
    }), "preflight_contract_error");

    const tampered = evaluationAssociation(clip, 1);
    (tampered.ffmpeg_version_invocation_receipt as Record<string, unknown>).receipt_sha256 = hash("tampered");
    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot, preflightRunner: runner(result(timeline.project_id, [{ ...clip, evaluation_association: tampered }], 2)),
    }), "preflight_contract_error");

    const relabeled = evaluationAssociation(clip, 1), version = relabeled.ffmpeg_version_invocation_receipt as Record<string, unknown>;
    version.binding = { ...(version.binding as Record<string, unknown>), clip_id: "other" };
    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot, preflightRunner: runner(result(timeline.project_id, [{ ...clip, evaluation_association: relabeled }], 2)),
    }), "preflight_contract_error");

    const reusedTimeline = minimalTimeline(true);
    reusedTimeline.project_id = "finish-reused-association";
    reusedTimeline.tracks.video[0].clips.push({ ...reusedTimeline.tracks.video[0].clips[0], clip_id: "video-b", segment_id: "segment-b" });
    const reusedProject = makeProject(reusedTimeline), second = { ...clip, clip_id: "video-b", request_sha256: `sha256:${"b".repeat(64)}` };
    const reused = evaluationAssociation(clip, 1);
    expectCode(() => projectPremiereFinishReview(reusedProject.root, {
      repoRoot, preflightRunner: runner(result(reusedTimeline.project_id, [
        { ...clip, evaluation_association: reused }, { ...second, evaluation_association: reused },
      ], 2)),
    }), "preflight_contract_error");
  });

  it("revision-bound preflight child binds argv and rejects missing, wrong, or swap-and-restore child-used revisions", () => {
    const timeline = minimalTimeline();
    const project = makeProject(timeline);
    const revision = timelineRevision(project.timelinePath);
    let invocationSeen = false;
    const projection = projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: (invocation) => {
        invocationSeen = true;
        expect(invocation.args).toEqual([
          path.join(repoRoot, "scripts/export-premiere-xml.ts"), project.root, "--preflight", "--json",
          "--expected-timeline-sha256", revision.sha,
          "--expected-timeline-identity-json", revision.encodedIdentity,
        ]);
        return revisionBoundResult(timeline.project_id, nativeClips(timeline), 0, revision);
      },
    });
    expect(invocationSeen).toBe(true);
    expect(projection.base_timeline_sha256).toBe(revision.sha);

    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: () => result(timeline.project_id, nativeClips(timeline), 0),
    }), "preflight_contract_error");

    const replacement = { ...revision, sha: `sha256:${"1".repeat(64)}` };
    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: () => revisionBoundResult(timeline.project_id, nativeClips(timeline), 0, replacement),
    }), "timeline_revision_changed");

    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: () => revisionBoundResult(timeline.project_id, nativeClips(timeline), 0, revision, { extra: true }),
    }), "preflight_contract_error");
  });

  it("projects the closed rich S1-S4 surface contract in canonical order without writes", () => {
    const timeline = cloneTimeline();
    const project = makeProject(timeline);
    const before = projectSnapshot(project.root);
    const projection = projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: runner(result(timeline.project_id, nativeClips(timeline), 0)),
    });

    expect(Object.keys(projection)).toEqual([
      "version", "project_id", "profile_id", "base_timeline_sha256", "hardware_verified", "surfaces",
    ]);
    expect(projection).toMatchObject({
      version: "premiere-finish-review/v2",
      project_id: timeline.project_id,
      profile_id: "adobe_premiere_fcp7xml_v1",
      hardware_verified: false,
    });
    expect(projection.base_timeline_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(projection.surfaces.map((item) => item.kind)).toEqual([
      "text", "text", "transition", "transition", "audio", "visual_effect", "visual_effect", "visual_effect",
    ]);

    const text = projection.surfaces.filter((item) => item.kind === "text");
    expect(text.map((item) => item.target.clip_id)).toEqual(["overlay-lower-third", "overlay-title"]);
    expect(Object.keys(text[0])).toEqual(["kind", "target", "source", "status", "raw_status", "reason_code", "action_code"]);
    expect(text[0]).toMatchObject({
      status: "blocked", raw_status: "report_only", reason_code: "profile_text_export_blocked",
      action_code: "review_text_then_wait_for_full_handoff",
    });

    const transitions = projection.surfaces.filter((item) => item.kind === "transition");
    expect(transitions.map((item) => item.target.transition_id)).toEqual(["transition-ab", "transition-bc"]);
    expect(transitions.every((item) => item.status === "unsupported" && item.raw_status === "type_not_allowed")).toBe(true);

    const audio = projection.surfaces.filter((item) => item.kind === "audio");
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({
      target: { track_id: "A1", clip_id: "audio-bgm", effect_id: "audiolevels" },
      status: "provisional_roundtrip",
      raw_status: "provisional_roundtrip",
      reason_code: "profile_audiolevels_provisional",
      action_code: "review_audio_levels_then_wait_for_full_handoff",
    });
    expect(Object.keys(audio[0].source.audio_policy)).toEqual([
      "mode", "gain_unit", "duck_music_db", "nat_gain", "nat_sound_gain", "bgm_gain",
      "a1_loudnorm", "preserve_nat_sound", "fade_in_frames", "fade_out_frames",
      "nat_sound_fade_in_frames", "nat_sound_fade_out_frames", "bgm_fade_in_frames", "bgm_fade_out_frames",
    ]);
    expect(audio[0].source.audio_policy).toMatchObject({ mode: null, gain_unit: "db", bgm_gain: -6 });

    const visual = projection.surfaces.filter((item) => item.kind === "visual_effect");
    expect(visual.map((item) => item.target.clip_id)).toEqual(["video-a", "video-b", "video-c"]);
    expect(visual.every((item) => item.status === "native" && item.raw_status === "native" && item.request_sha256 === null)).toBe(true);
    expect(projectSnapshot(project.root)).toEqual(before);
  });

  it("Audio Levels emission decision matches clip policy, timeline mix, precedence and no-op exclusion", () => {
    const mixTimeline = minimalTimeline();
    mixTimeline.tracks.video = [];
    mixTimeline.tracks.audio = [{
      track_id: "A1", kind: "audio",
      clips: [{ ...richFixture.timeline.tracks.audio[0].clips[0], clip_id: "mix-only", audio_policy: undefined }],
    }];
    mixTimeline.audio_mix = { gain_unit: "db", bgm_gain: -9 };
    const mixProject = makeProject(mixTimeline);
    const mixProjection = projectPremiereFinishReview(mixProject.root, {
      repoRoot, preflightRunner: runner(result(mixTimeline.project_id, [], 0)),
    });
    expect(mixProjection.surfaces.filter((item) => item.kind === "audio")).toHaveLength(1);
    expect(mixProjection.surfaces.find((item) => item.kind === "audio")?.source.audio_policy.bgm_gain).toBeNull();

    const noOpTimeline = cloneTimeline(mixTimeline);
    noOpTimeline.project_id = "finish-audio-no-op";
    noOpTimeline.audio_mix = {};
    noOpTimeline.tracks.audio[0].clips[0].audio_policy = { bgm_fade_in_frames: 0, bgm_fade_out_frames: 0 };
    const noOpProject = makeProject(noOpTimeline);
    const noOpProjection = projectPremiereFinishReview(noOpProject.root, {
      repoRoot, preflightRunner: runner(result(noOpTimeline.project_id, [], 0)),
    });
    expect(noOpProjection.surfaces.filter((item) => item.kind === "audio")).toHaveLength(0);

    const precedenceTimeline = cloneTimeline(mixTimeline);
    precedenceTimeline.project_id = "finish-audio-precedence";
    precedenceTimeline.tracks.audio[0].clips[0].audio_policy = { gain_unit: "db", bgm_gain: -3 };
    precedenceTimeline.audio_mix = { gain_unit: "db", bgm_gain: -12 };
    const precedenceProject = makeProject(precedenceTimeline);
    const precedenceProjection = projectPremiereFinishReview(precedenceProject.root, {
      repoRoot, preflightRunner: runner(result(precedenceTimeline.project_id, [], 0)),
    });
    expect(precedenceProjection.surfaces.filter((item) => item.kind === "audio")).toHaveLength(1);
  });

  it("maps visual transform and effect IDs only from the pinned classifier in fixed order", () => {
    const timeline = minimalTimeline(true);
    timeline.tracks.video[0].clips[0].metadata = {
      zoom: 1.25,
      crop: { x: 0, y: 0, width: 1280, height: 720 },
      position: { x: 10, y: -5 },
      render: { effects: [
        { type: "eq", params: { contrast: 1.1 } },
        { type: "saturation", params: { value: 1.2 } },
      ] },
    };
    const project = makeProject(timeline);
    const projection = projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: runner(result(timeline.project_id, [{
        clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha,
      }], 2)),
    });
    const visual = projection.surfaces.find((item) => item.kind === "visual_effect");
    expect(visual).toMatchObject({
      target: { effect_ids: ["transform.zoom", "transform.crop", "transform.position", "effect.eq", "effect.saturation"] },
      status: "bake_required", raw_status: "bake_required",
      action_code: "consent_required_but_execution_blocked", request_sha256: requestSha,
    });
  });

  it("rejects request_sha aliases, unknown or extra values, duplicate targets and invalid nullability", () => {
    const timeline = minimalTimeline(true);
    const project = makeProject(timeline);
    const invalidChildren = [
      result(timeline.project_id, [{ clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha: requestSha }], 2),
      result(timeline.project_id, [{ clip_id: "video-a", track_id: "V1", status: "ready" }], 0),
      result(timeline.project_id, [{ clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha, extra: true }], 2),
      result(timeline.project_id, [
        { clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha },
        { clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha },
      ], 2),
      result(timeline.project_id, [{ clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: null }], 2),
      result(timeline.project_id, [{ clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha, reason: null }], 2),
    ];
    for (const child of invalidChildren) {
      expectCode(() => projectPremiereFinishReview(project.root, { repoRoot, preflightRunner: runner(child) }),
        child === invalidChildren[3] ? "duplicate_target" : "preflight_contract_error");
    }

    const invalidText = minimalTimeline();
    invalidText.tracks.video = [];
    invalidText.tracks.overlay = cloneTimeline().tracks.overlay;
    ((invalidText.tracks.overlay?.[0].clips[0].metadata?.overlay) as Record<string, unknown>).writing_mode = 7;
    const invalidTextProject = makeProject(invalidText);
    expectCode(() => projectPremiereFinishReview(invalidTextProject.root, {
      repoRoot, preflightRunner: runner(result(invalidText.project_id, [], 0)),
    }), "invalid_projection");
  });

  it("discards the child result when the timeline identity or SHA changes", () => {
    const timeline = minimalTimeline();
    const project = makeProject(timeline);
    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: runner(result(timeline.project_id, nativeClips(timeline), 0), () => {
        const changed = cloneTimeline(timeline);
        changed.sequence.name = "mutated only by controlled fixture";
        fs.writeFileSync(project.timelinePath, `${JSON.stringify(changed, null, 2)}\n`);
      }),
    }), "timeline_revision_changed");
  });

  it("preflight exit and read-only process closure", () => {
    const scenarios: Array<{ raw: string; exit: number }> = [
      { raw: "native", exit: 0 }, { raw: "reusable", exit: 0 },
      { raw: "bake_required", exit: 2 }, { raw: "stale", exit: 2 },
      { raw: "busy", exit: 1 }, { raw: "conflict", exit: 1 }, { raw: "unsupported", exit: 1 },
      { raw: "source_unverified", exit: 1 }, { raw: "rights_privacy_blocked", exit: 1 },
    ];
    for (const scenario of scenarios) {
      const treated = scenario.raw !== "native";
      const timeline = minimalTimeline(treated);
      const project = makeProject(timeline);
      const clip: Record<string, unknown> = { clip_id: "video-a", track_id: "V1", status: scenario.raw };
      if (treated) clip.request_sha256 = requestSha;
      const projection = projectPremiereFinishReview(project.root, {
        repoRoot, preflightRunner: runner(result(timeline.project_id, [clip], scenario.exit)),
      });
      expect(projection.surfaces.filter((item) => item.kind === "visual_effect")).toHaveLength(1);
    }

    const mixedTimeline = minimalTimeline(true);
    mixedTimeline.project_id = "finish-mixed-precedence";
    mixedTimeline.tracks.video[0].clips.push({
      ...mixedTimeline.tracks.video[0].clips[0], clip_id: "video-b", segment_id: "segment-b",
    });
    const mixedProject = makeProject(mixedTimeline);
    const mixedProjection = projectPremiereFinishReview(mixedProject.root, {
      repoRoot,
      preflightRunner: runner(result(mixedTimeline.project_id, [
        { clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha },
        { clip_id: "video-b", track_id: "V1", status: "busy", request_sha256: `sha256:${"b".repeat(64)}` },
      ], 1)),
    });
    expect(mixedProjection.surfaces.filter((item) => item.kind === "visual_effect").map((item) => item.raw_status)).toEqual(["bake_required", "busy"]);

    const timeline = minimalTimeline(true);
    const project = makeProject(timeline);
    const validClip = { clip_id: "video-a", track_id: "V1", status: "bake_required", request_sha256: requestSha };
    const invalidResults: PremierePreflightChildResult[] = [
      { status: 2, signal: null, stdout: "", stderr: "" },
      { status: 2, signal: null, stdout: "{}", stderr: "" },
      { status: 2, signal: null, stdout: "{}\n{}", stderr: "" },
      result("wrong-project", [validClip], 2),
      result(timeline.project_id, [validClip], 0),
      result(timeline.project_id, [validClip], 3),
      result(timeline.project_id, [validClip], 2, { status: null, signal: "SIGTERM" }),
    ];
    for (const child of invalidResults) {
      expectCode(() => projectPremiereFinishReview(project.root, { repoRoot, preflightRunner: runner(child) }), "preflight_contract_error");
    }
  });

  it("wrapper and S4A child process closure", () => {
    const timeline = minimalTimeline();
    const project = makeProject(timeline);
    let invocations = 0;
    projectPremiereFinishReview(project.root, {
      repoRoot,
      preflightRunner: runner(result(timeline.project_id, nativeClips(timeline), 0), (invocation) => {
        invocations += 1;
        expect(invocation.executable).toBe(fs.realpathSync(path.join(repoRoot, "node_modules/.bin/tsx")));
        expect(invocation.args).toEqual([
          path.join(repoRoot, "scripts/export-premiere-xml.ts"), project.root, "--preflight", "--json",
          "--expected-timeline-sha256", timelineRevision(project.timelinePath).sha,
          "--expected-timeline-identity-json", timelineRevision(project.timelinePath).encodedIdentity,
        ]);
        expect(invocation.cwd).toBe(repoRoot);
        expect(invocation.args.join(" ")).not.toMatch(/--bake-visual-effects|--source-map|09_output|https?:|npx/);
      }),
    });
    expect(invocations).toBe(1);

    const before = projectSnapshot(project.root);
    const cli = spawnSync(
      fs.realpathSync(path.join(repoRoot, "node_modules/.bin/tsx")),
      [path.join(repoRoot, "scripts/premiere-finish-review.ts"), project.root, "--json"],
      { cwd: repoRoot, encoding: "utf8", env: process.env },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ version: "premiere-finish-review/v2", project_id: timeline.project_id });
    expect(projectSnapshot(project.root)).toEqual(before);

    const s4aSource = fs.readFileSync(path.join(repoRoot, "runtime/handoff/premiere-effect-bake.ts"), "utf8");
    expect(s4aSource).toContain('execFileSync("which", [name]');
    expect(s4aSource).toContain('["-v", "error", "-show_format", "-show_streams", "-of", "json", "file:/dev/fd/<SOURCE_FD>"]');
    expect(s4aSource).toContain('execFileSync(ffmpeg, ["-version"]');
    const exportSource = fs.readFileSync(path.join(repoRoot, "scripts/export-premiere-xml.ts"), "utf8");
    const preflightBranch = exportSource.slice(exportSource.indexOf("if (preflight)"), exportSource.indexOf("const blocked =", exportSource.indexOf("if (preflight)")));
    expect(preflightBranch).toContain("preflightPremiereEffectBakes");
    expect(preflightBranch).not.toMatch(/preparePremiereEffectBakes|timelineToFcp7Xml|publishExportGeneration|renderAndPublishBake/);
  });

  it("returns tool_unavailable before spawning when repository-local tsx is absent", () => {
    const timeline = minimalTimeline();
    const project = makeProject(timeline);
    const fakeRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s4br-fake-repo-"));
    temporaryRoots.push(fakeRepo);
    fs.mkdirSync(path.join(fakeRepo, "schemas"));
    fs.mkdirSync(path.join(fakeRepo, "runtime/nle-profiles"), { recursive: true });
    fs.mkdirSync(path.join(fakeRepo, "scripts"));
    fs.copyFileSync(path.join(repoRoot, "schemas/timeline-ir.schema.json"), path.join(fakeRepo, "schemas/timeline-ir.schema.json"));
    fs.copyFileSync(path.join(repoRoot, "schemas/nle-capability-profile.schema.json"), path.join(fakeRepo, "schemas/nle-capability-profile.schema.json"));
    fs.copyFileSync(path.join(repoRoot, "runtime/nle-profiles/premiere-v1.yaml"), path.join(fakeRepo, "runtime/nle-profiles/premiere-v1.yaml"));
    fs.writeFileSync(path.join(fakeRepo, "package.json"), "{}\n");
    fs.writeFileSync(path.join(fakeRepo, "scripts/export-premiere-xml.ts"), "// fixture only\n");
    let childCount = 0;
    expectCode(() => projectPremiereFinishReview(project.root, {
      repoRoot: fakeRepo,
      preflightRunner: () => {
        childCount += 1;
        return result(timeline.project_id, nativeClips(timeline), 0);
      },
    }), "tool_unavailable");
    expect(childCount).toBe(0);
  });
});
