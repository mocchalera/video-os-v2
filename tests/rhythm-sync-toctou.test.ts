import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as fsSync from "node:fs";
import * as path from "node:path";

// ── TOCTOU hostile harness ──────────────────────────────────────────
// Virtual filesystem where a path's content can be REPLACED right after the
// first read. If any consumer re-opened the artifact (for provenance hashing
// or a second consumption pass), it would see the mutated bytes and the
// binding could end up bound to different bytes than were parsed. The tests
// prove the loaders consume + hash ONE snapshot, or fail closed.

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  const readLog: string[] = [];
  /** Queued replacements: each read of the path pops the next content into the store. */
  const mutateAfterRead = new Map<string, string[]>();
  return { files, readLog, mutateAfterRead };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      h.files.has(String(p)) || actual.existsSync(p),
    readFileSync: (p: Parameters<typeof actual.readFileSync>[0], opts?: Parameters<typeof actual.readFileSync>[1]) => {
      const key = String(p);
      h.readLog.push(key);
      if (!h.files.has(key)) return actual.readFileSync(p, opts);
      const content = h.files.get(key)!;
      const queue = h.mutateAfterRead.get(key);
      if (queue && queue.length > 0) {
        // Simulate the adversary winning the race: every WOULD-BE next read
        // now sees the queued (different) bytes.
        h.files.set(key, queue.shift()!);
      }
      return content;
    },
  };
});

const { loadRhythmEventGrid } = await import("../runtime/compiler/rhythm-sync.js");
const { compile } = await import("../runtime/compiler/index.js");

const PROJECT_ID = "toctou-project";
const MEDIA_CONTENT = "fake-pcm-bytes-v1";
const MEDIA_HASH = createHash("sha256").update(MEDIA_CONTENT).digest("hex").slice(0, 16);

function bgmArtifact(detector: string, sourceHash: string, bpm = 120): string {
  return JSON.stringify({
    version: "1",
    project_id: PROJECT_ID,
    analysis_status: "ready",
    music_asset: { asset_id: "AST_MUSIC", path: "02_media/bgm.wav", source_hash: sourceHash },
    bpm,
    meter: "4/4",
    duration_sec: 30,
    beats_sec: [2, 4, 6],
    downbeats_sec: [4],
    sections: [
      { id: "S1", label: "verse", start_sec: 0, end_sec: 10 },
      { id: "S2", label: "chorus", start_sec: 10, end_sec: 20 },
    ],
    provenance: { detector, sample_rate_hz: 44100 },
  }, null, 2);
}

function transcriptArtifact(projectId: string, assetId: string, word: string): string {
  return JSON.stringify({
    project_id: projectId,
    artifact_version: "analysis-v1",
    transcript_ref: `TR_${assetId}`,
    asset_id: assetId,
    word_timing_mode: "word",
    items: [{ speaker: "V", start_us: 10_000_000, end_us: 11_000_000, text: word, words: [{ word, start_us: 10_000_000, end_us: 10_500_000 }] }],
  }, null, 2);
}

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const readsOf = (p: string) => h.readLog.filter((entry) => entry === p).length;

describe("rhythm sync: single-snapshot evidence consumption (TOCTOU hostile)", () => {
  // Repo-local: the canonical transcript schema authority resolves upward.
  let dir: string;

  beforeAll(async () => {
    dir = path.resolve(path.join("tests", "tmp_rhythm_toctou_unit"));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(path.join(dir, "02_media"), { recursive: true });
    // Media is REAL: the source-hash tamper check reads it exactly once and
    // nothing else consumes its bytes.
    await fsp.writeFile(path.join(dir, "02_media/bgm.wav"), MEDIA_CONTENT);
  });

  afterAll(async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    await fsp.rm(dir, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(dir)).toBe(false);
  });

  it("consumes and hashes the BGM artifact from ONE snapshot even when the file is replaced between would-be reads", async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    const bgmPath = path.join(dir, "03_analysis/bgm_analysis.json");
    const bytes1 = bgmArtifact("detector-v1", MEDIA_HASH);
    const bytes2 = bgmArtifact("detector-v2-replacement", "deadbeefdeadbeef", 99);
    h.files.set(bgmPath, bytes1);
    // Arm the adversary: any second read sees tampered bytes.
    h.mutateAfterRead.set(bgmPath, [bytes2]);

    const grid = loadRhythmEventGrid(dir, 30, 1, { projectId: PROJECT_ID });

    // Exactly one read happened: the snapshot.
    expect(readsOf(bgmPath)).toBe(1);
    // The adversary's replacement WAS armed in the store...
    expect(h.files.get(bgmPath)).toBe(bytes2);
    // ...but the binding is bound to the FIRST bytes: digest and parsed
    // provenance both come from bytes1, never from bytes2.
    expect(grid.evidence.bgm_artifact_sha256).toBe(sha256(bytes1));
    expect(grid.evidence.bgm_artifact_sha256).not.toBe(sha256(bytes2));
    expect(grid.evidence.bgm_detector).toBe("detector-v1");
    expect(grid.evidence.bgm_artifact_origin).toBe("primary");
    // The evidence adopted is bytes1's: 3 beats, 1 downbeat, valid hash.
    expect(grid.evidence.binding).toBe("bound");
    expect(grid.evidence.binding_failures).toEqual([]);
    expect(grid.sources.bgm_analysis).toBe(true);
    expect(grid.sources.beat_count).toBeGreaterThan(0);
    // No tampered-hash rejection: the tampered bytes were never validated.
    expect(grid.degraded_reasons).not.toContain("bgm_music_source_hash_mismatch");
  });

  it("consumes and hashes the transcript from ONE snapshot; replaced bytes are never adopted", async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    const bgmPath = path.join(dir, "03_analysis/bgm_analysis.json");
    const transcriptPath = path.join(dir, "03_analysis/transcripts/TR_AST_MUSIC.json");
    h.files.set(bgmPath, bgmArtifact("detector-v1", MEDIA_HASH));
    const transcript1 = transcriptArtifact(PROJECT_ID, "AST_MUSIC", "snapshot-word");
    const transcript2 = transcriptArtifact("another-project", "AST_MUSIC", "replaced-word");
    // REAL file on disk + virtual mirror: the transcripts-directory snapshot
    // (readdir + read) must see it, and every read must be counted.
    await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fsp.writeFile(transcriptPath, transcript1);
    h.files.set(transcriptPath, transcript1);
    h.mutateAfterRead.set(transcriptPath, [transcript2]);

    const grid = loadRhythmEventGrid(dir, 30, 1, { projectId: PROJECT_ID });

    expect(readsOf(transcriptPath)).toBe(1);
    expect(h.files.get(transcriptPath)).toBe(transcript2);
    // Digest describes the snapshot bytes; words were parsed from the same.
    expect(grid.evidence.transcript_artifact_sha256).toBe(sha256(transcript1));
    expect(grid.evidence.transcript_artifact_sha256).not.toBe(sha256(transcript2));
    expect(grid.sources.word_count).toBe(1);
    expect(grid.events.find((event) => event.kind === "word_start")?.word).toBe("snapshot-word");
    // The replaced (foreign-project) transcript was never validated/adopted.
    expect(grid.degraded_reasons).not.toContain("transcript_project_id_mismatch");
    expect(grid.evidence.binding).toBe("bound");
    expect(grid.evidence.binding_failures).toEqual([]);
  });

  it("never binds mixed bytes: tampered replacement is neither parsed nor hashed (fails closed, stays bound to the snapshot)", () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    const bgmPath = path.join(dir, "03_analysis/bgm_analysis.json");
    const valid = bgmArtifact("detector-v1", MEDIA_HASH);
    // Replacement carries a FOREIGN project id + tampered hash: had the
    // loader re-opened the path for identity checks, binding would flip to
    // degraded on different bytes than the digest describes.
    const tampered = bgmArtifact("detector-v1", MEDIA_HASH).replace(`"project_id": "${PROJECT_ID}"`, `"project_id": "other-project"`);
    h.files.set(bgmPath, valid);
    h.mutateAfterRead.set(bgmPath, [tampered]);

    const grid = loadRhythmEventGrid(dir, 30, 1, { projectId: PROJECT_ID });

    expect(readsOf(bgmPath)).toBe(1);
    expect(grid.evidence.binding).toBe("bound");
    expect(grid.evidence.binding_failures).toEqual([]);
    expect(grid.evidence.bgm_artifact_sha256).toBe(sha256(valid));
    expect(grid.degraded_reasons).not.toContain("bgm_analysis_project_id_mismatch");
    // The stamped digest never matches the tampered bytes.
    expect(grid.evidence.bgm_artifact_sha256).not.toBe(sha256(tampered));
  });
});

// ── Full-compile hostile: A→B→A and missing-ID across ALL phases ────

describe("rhythm sync: full-compile single-snapshot evidence (A→B→A hostile)", () => {
  const SAMPLE = path.resolve("projects/sample");
  const CREATED_AT = "2026-08-29T00:00:00Z";
  // Repo-local root so compile's findRepoRoot (schemas/) can walk up.
  const root = path.join("tests", "tmp_rhythm_toctou_full");

  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
  const readsOf = (p: string) => h.readLog.filter((entry) => entry === p).length;

  const MEDIA = "fixture-bgm-media-bytes-v1";
  const MEDIA_HASH = createHash("sha256").update(MEDIA).digest("hex").slice(0, 16);

  function bgmBytes(options: {
    detector: string;
    beatStepSec: number;
    projectId?: string;
    sourceHash?: string;
  }): string {
    const beats: number[] = [];
    for (let t = 0; t < 30; t += options.beatStepSec) beats.push(t);
    return JSON.stringify({
      version: "1",
      ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
      analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSICTEST", path: "02_media/bgm-test.wav", source_hash: options.sourceHash ?? MEDIA_HASH },
      bpm: options.beatStepSec === 2 ? 120 : 80,
      meter: "4/4",
      duration_sec: 30,
      beats_sec: beats,
      downbeats_sec: beats,
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 4.6, energy: 0.3 },
        { id: "S2", label: "chorus", start_sec: 4.6, end_sec: 20, energy: 0.9 },
        { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
      ],
      provenance: { detector: options.detector, sample_rate_hz: 44100 },
    }, null, 2);
  }

  const transcriptBytes = (projectId: string, assetId: string) => JSON.stringify({
    project_id: projectId,
    artifact_version: "analysis-v1",
    transcript_ref: `TR_${assetId}`,
    asset_id: assetId,
    word_timing_mode: "word",
    items: [{ speaker: "V", start_us: 4_600_000, end_us: 5_600_000, text: "orbit", words: [{ word: "orbit", start_us: 4_600_000, end_us: 5_100_000 }] }],
  }, null, 2);

  async function setupProject(name: string, files: Record<string, string>): Promise<string> {
    // Absolute: compile() resolves the project path before any read.
    const dir = path.resolve(path.join(root, name));
    await fsp.cp(SAMPLE, dir, { recursive: true });
    await fsp.rm(path.join(dir, "05_timeline/timeline.json"), { force: true });
    await fsp.mkdir(path.join(dir, "02_media"), { recursive: true });
    await fsp.writeFile(path.join(dir, "02_media/bgm-test.wav"), MEDIA);
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    for (const [relative, content] of Object.entries(files)) {
      // REAL file on disk (so directory-scanning consumers see it) mirrored
      // into the virtual store (so every read is counted and mutable).
      const absolute = path.join(dir, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, content);
      h.files.set(absolute, content);
    }
    return dir;
  }

  function geometrySignature(timeline: any): string {
    return JSON.stringify(timeline.tracks.video.flatMap((track: any) =>
      track.clips.map((clip: any) => [clip.clip_id, clip.timeline_in_frame, clip.timeline_duration_frames, clip.src_in_us, clip.src_out_us]),
    ));
  }

  function rhythmSignature(timeline: any): string {
    const rhythm = timeline.metadata?.rhythm_sync as Record<string, any> | undefined;
    return JSON.stringify(rhythm ? {
      status: rhythm.status,
      degraded_reasons: rhythm.degraded_reasons,
      counts: rhythm.counts,
      snaps: rhythm.snaps,
      parity: rhythm.parity,
      beat_sync: undefined,
    } : null);
  }

  afterAll(async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    await fsp.rm(root, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(root)).toBe(false);
  });

  it("A→B→A: the whole compile consumes ONE snapshot — geometry and provenance match the pure-A control", async () => {
    const bytesA = bgmBytes({ detector: "detector-A", beatStepSec: 2, projectId: "sample-mountain-reset" });
    const bytesB = bgmBytes({ detector: "detector-B", beatStepSec: 3, projectId: "sample-mountain-reset" });
    // A again, but with a distinguishable detector: a third read would be
    // detectable through the stamped detector/digest.
    const bytesA2 = bgmBytes({ detector: "detector-A2", beatStepSec: 2, projectId: "sample-mountain-reset" });
    const t1 = transcriptBytes("sample-mountain-reset", "AST_MUSICTEST");
    const t2 = transcriptBytes("another-project", "AST_MUSICTEST");

    // Control: pure A forever.
    const controlDir = await setupProject("control", {
      "03_analysis/bgm_analysis.json": bytesA,
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": t1,
    });
    const control = compile({ projectPath: controlDir, createdAt: CREATED_AT });
    const bgmPath = path.join(controlDir, "03_analysis/bgm_analysis.json");
    const transcriptPath = path.join(controlDir, "03_analysis/transcripts/TR_AST_MUSICTEST.json");

    // Armed: A consumed once, then B (valid identity, different beats!), then A2.
    const armedDir = await setupProject("armed", {
      "03_analysis/bgm_analysis.json": bytesA,
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": t1,
    });
    const armedBgmPath = path.join(armedDir, "03_analysis/bgm_analysis.json");
    const armedTranscriptPath = path.join(armedDir, "03_analysis/transcripts/TR_AST_MUSICTEST.json");
    h.mutateAfterRead.set(armedBgmPath, [bytesB, bytesA2]);
    h.mutateAfterRead.set(armedTranscriptPath, [t2]);

    const armed = compile({ projectPath: armedDir, createdAt: CREATED_AT });

    // Each artifact was read EXACTLY ONCE across the entire compile:
    // scoring, adjacency, beat-sync and rhythm-sync all shared the snapshot.
    expect(readsOf(armedBgmPath)).toBe(1);
    expect(readsOf(armedTranscriptPath)).toBe(1);
    // The adversary's queue advanced by exactly ONE (the first would-be second
    // read) and never further: B replaced A in the store, A2 still queued.
    expect(h.files.get(armedBgmPath)).toBe(bytesB);
    expect(h.files.get(armedTranscriptPath)).toBe(t2);

    // Provenance binds the FIRST snapshot (A): digest, detector, origin.
    const armedRhythm = (armed.timeline.metadata as Record<string, any>).rhythm_sync;
    const evidence = armedRhythm.evidence_provenance;
    expect(evidence.bgm_artifact_sha256).toBe(sha256(bytesA));
    expect(evidence.bgm_artifact_sha256).not.toBe(sha256(bytesB));
    expect(evidence.bgm_artifact_sha256).not.toBe(sha256(bytesA2));
    expect(evidence.bgm_detector).toBe("detector-A");
    expect(evidence.bgm_artifact_origin).toBe("primary");
    expect(evidence.transcript_artifact_sha256).toBe(sha256(t1));
    expect(evidence.transcript_artifact_sha256).not.toBe(sha256(t2));
    expect(evidence.binding).toBe("bound");

    // Geometry, rhythm contract and beat-sync are byte-stable vs pure A:
    // B's different beat grid (3s spacing) never touched V1.
    expect(geometrySignature(armed.timeline)).toBe(geometrySignature(control.timeline));
    expect(rhythmSignature(armed.timeline)).toBe(rhythmSignature(control.timeline));
    expect(JSON.stringify((armed as unknown as Record<string, unknown>).beat_sync))
      .toBe(JSON.stringify((control as unknown as Record<string, unknown>).beat_sync));
  });

  it("missing project id: rejected at the entry snapshot — unbound evidence never alters V1", async () => {
    const bytesNoId = bgmBytes({ detector: "detector-A", beatStepSec: 2, projectId: undefined });
    const t1 = transcriptBytes("sample-mountain-reset", "AST_MUSICTEST");

    // Control: no BGM evidence at all.
    const controlDir = await setupProject("no-bgm", {});
    const control = compile({ projectPath: controlDir, createdAt: CREATED_AT });
    const controlBgmPath = path.join(controlDir, "03_analysis/bgm_analysis.json");

    // Armed: BGM artifact present but with a MISSING project id.
    const armedDir = await setupProject("missing-id", {
      "03_analysis/bgm_analysis.json": bytesNoId,
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": t1,
    });
    const armedBgmPath = path.join(armedDir, "03_analysis/bgm_analysis.json");
    const armedTranscriptPath = path.join(armedDir, "03_analysis/transcripts/TR_AST_MUSICTEST.json");

    const armed = compile({ projectPath: armedDir, createdAt: CREATED_AT });

    // Each artifact is read exactly once at the entry snapshot: the BGM
    // artifact for binding, the transcript once for the utterance projection
    // (the music words are NOT derived because the BGM evidence is unbound).
    expect(readsOf(armedBgmPath)).toBe(1);
    expect(readsOf(armedTranscriptPath)).toBe(1);

    const armedRhythm = (armed.timeline.metadata as Record<string, any>).rhythm_sync;
    expect(armedRhythm.enabled).toBe(false);
    expect(armedRhythm.degraded_reasons).toContain("bgm_project_id_missing");
    expect(armedRhythm.evidence_provenance).toMatchObject({ binding: "degraded" });

    // Unbound evidence cannot alter V1: geometry identical to the no-BGM control.
    expect(geometrySignature(armed.timeline)).toBe(geometrySignature(control.timeline));
    expect(JSON.stringify((armed as unknown as Record<string, unknown>).beat_sync))
      .toBe(JSON.stringify((control as unknown as Record<string, unknown>).beat_sync));
  });
});

// ── General-transcript project binding (full compile, real FS) ───────

describe("rhythm sync: general transcript project binding (full compile)", () => {
  const SAMPLE = path.resolve("projects/sample");
  const CREATED_AT = "2026-08-29T00:00:00Z";
  const root = path.join("tests", "tmp_rhythm_binding_full");
  const MEDIA2 = "fixture-bgm-media-bytes-v1";
  const MEDIA2_HASH = createHash("sha256").update(MEDIA2).digest("hex").slice(0, 16);
  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
  const readsOf = (p: string) => h.readLog.filter((entry) => entry === p).length;

  const PROJECT = "sample-mountain-reset";

  function bgmBytes(projectId: string | undefined): string {
    const beats: number[] = [];
    for (let t = 0; t < 30; t += 2) beats.push(t);
    return JSON.stringify({
      version: "1",
      ...(projectId === undefined ? {} : { project_id: projectId }),
      analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSICTEST", path: "02_media/bgm-test.wav", source_hash: MEDIA2_HASH },
      bpm: 120,
      meter: "4/4",
      duration_sec: 30,
      beats_sec: beats,
      downbeats_sec: beats,
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 4.6, energy: 0.3 },
        { id: "S2", label: "chorus", start_sec: 4.6, end_sec: 20, energy: 0.9 },
        { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
      ],
      provenance: { detector: "detector-A", sample_rate_hz: 44100 },
    }, null, 2);
  }

  function transcriptBytes(options: {
    projectId?: string;
    assetId?: string;
    word?: string;
    artifactVersion?: unknown;
    transcriptRef?: unknown;
    items?: unknown;
  }): string {
    return JSON.stringify({
      ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
      // Schema-hostile overrides: wrong version/ref shapes fail the canonical
      // transcript.schema.json authority.
      // null = omit the field entirely (schema "missing required field" case).
      ...(options.artifactVersion === undefined
        ? { artifact_version: "analysis-v1" }
        : options.artifactVersion === null
          ? {}
          : { artifact_version: options.artifactVersion }),
      ...(options.transcriptRef === undefined
        ? { transcript_ref: `TR_${options.assetId ?? "AST_MUSICTEST"}` }
        : options.transcriptRef === null
          ? {}
          : { transcript_ref: options.transcriptRef }),
      asset_id: options.assetId ?? "AST_MUSICTEST",
      word_timing_mode: "word",
      items: options.items === undefined
        ? [{ speaker: "V", start_us: 4_600_000, end_us: 5_600_000, text: options.word ?? "orbit", words: [{ word: options.word ?? "orbit", start_us: 4_600_000, end_us: 5_100_000 }] }]
        : options.items,
    }, null, 2);
  }

  const GATE_OFF = {
    defaultsOverride: { rhythm_sync: { mode: "auto" as const, search_window_sec: 1.5, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" as const } },
  };

  async function setup(name: string, files: Record<string, string>): Promise<string> {
    const dir = path.resolve(path.join(root, name));
    await fsp.cp(SAMPLE, dir, { recursive: true });
    await fsp.rm(path.join(dir, "05_timeline/timeline.json"), { force: true });
    await fsp.mkdir(path.join(dir, "02_media"), { recursive: true });
    await fsp.writeFile(path.join(dir, "02_media/bgm-test.wav"), MEDIA2);
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(dir, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, content);
      h.files.set(absolute, content);
    }
    return dir;
  }

  function signature(timeline: any): string {
    return JSON.stringify({
      geometry: timeline.tracks.video.flatMap((track: any) =>
        track.clips.map((clip: any) => [clip.clip_id, clip.timeline_in_frame, clip.timeline_duration_frames, clip.src_in_us, clip.src_out_us])),
      beat_sync: (timeline.metadata as Record<string, any>).beat_sync,
    });
  }

  beforeAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    await fsp.rm(root, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(root)).toBe(false);
  });

  it("valid bound transcript: provenance bound, geometry uses the word head", async () => {
    const t1 = transcriptBytes({ projectId: PROJECT });
    const dir = await setup("bound", {
      "03_analysis/bgm_analysis.json": bgmBytes(PROJECT),
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": t1,
    });

    const result = compile({ projectPath: dir, createdAt: CREATED_AT, ...GATE_OFF });
    const rhythm = (result.timeline.metadata as Record<string, any>).rhythm_sync;

    expect(rhythm.evidence_provenance.binding).toBe("bound");
    // Sample ships additional asset transcripts — assert the music record per path.
    const musicRecord = rhythm.evidence_provenance.transcripts.find(
      (record: any) => record.path === "03_analysis/transcripts/TR_AST_MUSICTEST.json",
    );
    expect(musicRecord).toEqual({
      path: "03_analysis/transcripts/TR_AST_MUSICTEST.json",
      sha256: sha256(t1),
      binding: "bound",
      failures: [],
    });
    // The bound word evidence affects geometry: chorus cut snaps to 110f.
    expect(result.timeline.tracks.video[0].clips.some((clip: any) => clip.timeline_in_frame === 110)).toBe(true);
    expect(readsOf(path.join(dir, "03_analysis/bgm_analysis.json"))).toBe(1);
    expect(readsOf(path.join(dir, "03_analysis/transcripts/TR_AST_MUSICTEST.json"))).toBe(1);
  });

  it.each([
    ["missing project_id", { assetId: "AST_MUSICTEST", word: "orbit" }, "transcript_schema_invalid:", true],
    ["foreign project_id", { projectId: "another-project", assetId: "AST_MUSICTEST", word: "orbit" }, "transcript_project_id_mismatch", false],
  ])("%s transcript is degraded provenance with no-transcript-equivalent geometry", async (_name, transcriptOptions, expectedFailure, schemaFailure) => {
    const bytes = transcriptBytes(transcriptOptions);
    // Control: NO transcript at all.
    const controlDir = await setup(`ctrl-${expectedFailure}`, {
      "03_analysis/bgm_analysis.json": bgmBytes(PROJECT),
    });
    const control = compile({ projectPath: controlDir, createdAt: CREATED_AT, ...GATE_OFF });

    // Armed: transcript present but project-unbound.
    const armedDir = await setup(`armed-${expectedFailure}`, {
      "03_analysis/bgm_analysis.json": bgmBytes(PROJECT),
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": bytes,
    });

    const armed = compile({ projectPath: armedDir, createdAt: CREATED_AT, ...GATE_OFF });

    // Single read per artifact; no reopen.
    expect(readsOf(path.join(armedDir, "03_analysis/bgm_analysis.json"))).toBe(1);
    expect(readsOf(path.join(armedDir, "03_analysis/transcripts/TR_AST_MUSICTEST.json"))).toBe(1);

    const armedRhythm = (armed.timeline.metadata as Record<string, any>).rhythm_sync;
    const musicRecord = armedRhythm.evidence_provenance.transcripts.find(
      (record: any) => record.path === "03_analysis/transcripts/TR_AST_MUSICTEST.json",
    );
    expect(musicRecord).toMatchObject({
      path: "03_analysis/transcripts/TR_AST_MUSICTEST.json",
      sha256: sha256(bytes),
      binding: "degraded",
    });
    if (schemaFailure) {
      // Missing required fields surface as canonical transcript.schema.json
      // failures with deterministic details.
      expect(musicRecord.failures.length).toBeGreaterThan(0);
      for (const failure of musicRecord.failures) {
        expect(failure.startsWith(expectedFailure)).toBe(true);
      }
      expect(musicRecord.failures.some((failure: string) => failure.includes("project_id"))).toBe(true);
    } else {
      // Project mismatch carries the deterministic detail after the rule.
      expect(musicRecord.failures.length).toBe(1);
      expect(musicRecord.failures[0].startsWith(expectedFailure)).toBe(true);
    }
    // Every OTHER sample transcript is bound (its own project id matches):
    // none may be degraded, and the unbound music words were not consumed.
    for (const record of armedRhythm.evidence_provenance.transcripts) {
      if (record.path !== "03_analysis/transcripts/TR_AST_MUSICTEST.json") {
        expect(record.binding).toBe("bound");
      }
    }
    // Unbound words are never consumed: no word-driven snap, so V1 geometry
    // and beat_sync are EXACTLY the no-transcript control.
    expect(signature(armed.timeline)).toBe(signature(control.timeline));
  });

  it("mixed transcripts: the bound file may affect geometry, the foreign one is degraded provenance only", async () => {
    const valid = transcriptBytes({ projectId: PROJECT });
    const foreign = transcriptBytes({ projectId: "another-project", assetId: "AST_OTHER", word: "intruder" });
    const dir = await setup("mixed", {
      "03_analysis/bgm_analysis.json": bgmBytes(PROJECT),
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": valid,
      "03_analysis/transcripts/TR_AST_OTHER.json": foreign,
    });

    const result = compile({ projectPath: dir, createdAt: CREATED_AT, ...GATE_OFF });
    const rhythm = (result.timeline.metadata as Record<string, any>).rhythm_sync;

    // Deterministic per-file provenance: both fixture files recorded with path/hash.
    const recordOf = (p: string) =>
      rhythm.evidence_provenance.transcripts.find((record: any) => record.path === p);
    expect(recordOf("03_analysis/transcripts/TR_AST_MUSICTEST.json")).toEqual({
      path: "03_analysis/transcripts/TR_AST_MUSICTEST.json", sha256: sha256(valid), binding: "bound", failures: [],
    });
    expect(recordOf("03_analysis/transcripts/TR_AST_OTHER.json")).toMatchObject({
      path: "03_analysis/transcripts/TR_AST_OTHER.json", sha256: sha256(foreign), binding: "degraded",
    });
    expect(recordOf("03_analysis/transcripts/TR_AST_OTHER.json").failures[0].startsWith("transcript_project_id_mismatch:")).toBe(true);
    // The bound file's word head still drives the chorus snap.
    expect(result.timeline.tracks.video[0].clips.some((clip: any) => clip.timeline_in_frame === 110)).toBe(true);
    // One read per transcript path; the foreign "intruder" word never appears.
    expect(readsOf(path.join(dir, "03_analysis/transcripts/TR_AST_MUSICTEST.json"))).toBe(1);
    expect(readsOf(path.join(dir, "03_analysis/transcripts/TR_AST_OTHER.json"))).toBe(1);
    expect(JSON.stringify(rhythm.snaps)).not.toContain("intruder");
  });
});

// ── Canonical transcript.schema.json authority (full compile) ────────

describe("rhythm sync: canonical transcript schema authority (full compile)", () => {
  const SAMPLE = path.resolve("projects/sample");
  const CREATED_AT = "2026-08-29T00:00:00Z";
  const root = path.join("tests", "tmp_rhythm_schema_full");
  const MEDIA3 = "fixture-bgm-media-bytes-v1";
  const MEDIA3_HASH = createHash("sha256").update(MEDIA3).digest("hex").slice(0, 16);
  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
  const readsOf = (p: string) => h.readLog.filter((entry) => entry === p).length;
  const PROJECT = "sample-mountain-reset";

  const bgmBytes = () => {
    const beats: number[] = [];
    for (let t = 0; t < 30; t += 2) beats.push(t);
    return JSON.stringify({
      version: "1",
      project_id: PROJECT,
      analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSICTEST", path: "02_media/bgm-test.wav", source_hash: MEDIA3_HASH },
      bpm: 120, meter: "4/4", duration_sec: 30,
      beats_sec: beats, downbeats_sec: beats,
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 4.6, energy: 0.3 },
        { id: "S2", label: "chorus", start_sec: 4.6, end_sec: 20, energy: 0.9 },
        { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
      ],
      provenance: { detector: "detector-A", sample_rate_hz: 44100 },
    }, null, 2);
  };

  function transcriptBytes(options: {
    projectId?: string;
    artifactVersion?: unknown;
    transcriptRef?: unknown;
    items?: unknown;
  }): string {
    return JSON.stringify({
      ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
      ...(options.artifactVersion === undefined
        ? { artifact_version: "analysis-v1" }
        : { artifact_version: options.artifactVersion }),
      ...(options.transcriptRef === undefined
        ? { transcript_ref: "TR_AST_MUSICTEST" }
        : { transcript_ref: options.transcriptRef }),
      asset_id: "AST_MUSICTEST",
      word_timing_mode: "word",
      items: options.items === undefined
        ? [{ speaker: "V", start_us: 4_600_000, end_us: 5_600_000, text: "orbit", words: [{ word: "orbit", start_us: 4_600_000, end_us: 5_100_000 }] }]
        : options.items,
    }, null, 2);
  }

  const GATE_OFF = {
    defaultsOverride: { rhythm_sync: { mode: "auto" as const, search_window_sec: 1.5, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" as const } },
  };

  function signature(timeline: any): string {
    return JSON.stringify({
      geometry: timeline.tracks.video.flatMap((track: any) =>
        track.clips.map((clip: any) => [clip.clip_id, clip.timeline_in_frame, clip.timeline_duration_frames, clip.src_in_us, clip.src_out_us])),
      beat_sync: (timeline.metadata as Record<string, any>).beat_sync,
    });
  }

  async function setup(name: string, files: Record<string, string>): Promise<string> {
    const dir = path.resolve(path.join(root, name));
    await fsp.cp(SAMPLE, dir, { recursive: true });
    await fsp.rm(path.join(dir, "05_timeline/timeline.json"), { force: true });
    await fsp.mkdir(path.join(dir, "02_media"), { recursive: true });
    await fsp.writeFile(path.join(dir, "02_media/bgm-test.wav"), MEDIA3);
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(dir, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, content);
      h.files.set(absolute, content);
    }
    return dir;
  }

  beforeAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    await fsp.rm(root, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(root)).toBe(false);
  });

  it.each([
    ["missing artifact_version", { artifactVersion: null }],
    ["wrong artifact_version type", { artifactVersion: 1 }],
    ["empty transcript_ref", { transcriptRef: "" }],
    ["malformed item structure (missing text)", { items: [{ speaker: "V", start_us: 4_600_000, end_us: 5_600_000 }] }],
  ])("%s: schema-invalid music transcript is degraded with schema details and never reaches geometry", async (_name, overrides) => {
    const bytes = transcriptBytes({ projectId: PROJECT, ...overrides } as Parameters<typeof transcriptBytes>[0]);
    const controlDir = await setup(`ctrl-${sha256(bytes).slice(0, 8)}`, {
      "03_analysis/bgm_analysis.json": bgmBytes(),
    });
    const control = compile({ projectPath: controlDir, createdAt: CREATED_AT, ...GATE_OFF });

    const dir = await setup(`invalid-${sha256(bytes).slice(0, 8)}`, {
      "03_analysis/bgm_analysis.json": bgmBytes(),
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": bytes,
    });
    const result = compile({ projectPath: dir, createdAt: CREATED_AT, ...GATE_OFF });

    const transcriptPath = path.join(dir, "03_analysis/transcripts/TR_AST_MUSICTEST.json");
    // One read; no fallback reopen.
    expect(readsOf(transcriptPath)).toBe(1);
    expect(readsOf(path.join(dir, "03_analysis/bgm_analysis.json"))).toBe(1);

    const rhythm = (result.timeline.metadata as Record<string, any>).rhythm_sync;
    const record = rhythm.evidence_provenance.transcripts.find(
      (entry: any) => entry.path === "03_analysis/transcripts/TR_AST_MUSICTEST.json",
    );
    expect(record).toMatchObject({ path: "03_analysis/transcripts/TR_AST_MUSICTEST.json", sha256: sha256(bytes), binding: "degraded" });
    expect(record.failures.length).toBeGreaterThan(0);
    for (const failure of record.failures) {
      expect(failure.startsWith("transcript_schema_invalid:")).toBe(true);
    }
    // Schema-invalid evidence is NEVER projected: geometry and beat_sync are
    // exactly the no-transcript control.
    expect(signature(result.timeline)).toBe(signature(control.timeline));
  });

  it("mixed valid + schema-invalid transcripts: bound file drives geometry, invalid one is degraded-only", async () => {
    const valid = transcriptBytes({ projectId: PROJECT });
    const invalid = transcriptBytes({ projectId: "AST_OTHER", artifactVersion: 1, items: "not-an-array" })
      .replace('"asset_id": "AST_MUSICTEST"', '"asset_id": "AST_OTHER"');
    const dir = await setup("mixed-schema", {
      "03_analysis/bgm_analysis.json": bgmBytes(),
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": valid,
      "03_analysis/transcripts/TR_AST_OTHER.json": invalid,
    });

    const result = compile({ projectPath: dir, createdAt: CREATED_AT, ...GATE_OFF });
    const rhythm = (result.timeline.metadata as Record<string, any>).rhythm_sync;

    const recordOf = (p: string) =>
      rhythm.evidence_provenance.transcripts.find((entry: any) => entry.path === p);
    expect(recordOf("03_analysis/transcripts/TR_AST_MUSICTEST.json")).toMatchObject({ binding: "bound", failures: [] });
    expect(recordOf("03_analysis/transcripts/TR_AST_OTHER.json")).toMatchObject({
      binding: "degraded",
      sha256: sha256(invalid),
    });
    expect(recordOf("03_analysis/transcripts/TR_AST_OTHER.json").failures.length).toBeGreaterThan(0);
    // The bound file's word head still drives the chorus snap; the invalid
    // file contributed nothing.
    expect(result.timeline.tracks.video[0].clips.some((clip: any) => clip.timeline_in_frame === 110)).toBe(true);
    expect(readsOf(path.join(dir, "03_analysis/transcripts/TR_AST_OTHER.json"))).toBe(1);
  });
});

// ── Semantic/path invariants + authority-unavailable boundary ────────

describe("rhythm sync: semantic invariants and authority-unavailable boundary (full compile)", () => {
  const SAMPLE = path.resolve("projects/sample");
  const CREATED_AT = "2026-08-29T00:00:00Z";
  const root = path.join("tests", "tmp_rhythm_invariants_full");
  const MEDIA4 = "fixture-bgm-media-bytes-v1";
  const MEDIA4_HASH = createHash("sha256").update(MEDIA4).digest("hex").slice(0, 16);
  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
  const readsOf = (p: string) => h.readLog.filter((entry) => entry === p).length;
  const PROJECT = "sample-mountain-reset";

  const bgmBytes = () => {
    const beats: number[] = [];
    for (let t = 0; t < 30; t += 2) beats.push(t);
    return JSON.stringify({
      version: "1",
      project_id: PROJECT,
      analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSICTEST", path: "02_media/bgm-test.wav", source_hash: MEDIA4_HASH },
      bpm: 120, meter: "4/4", duration_sec: 30,
      beats_sec: beats, downbeats_sec: beats,
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 4.6, energy: 0.3 },
        { id: "S2", label: "chorus", start_sec: 4.6, end_sec: 20, energy: 0.9 },
        { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
      ],
      provenance: { detector: "detector-A", sample_rate_hz: 44100 },
    }, null, 2);
  };

  function transcriptBytes(options: {
    projectId?: string;
    artifactVersion?: unknown;
    transcriptRef?: unknown;
    assetId?: string;
  }): string {
    return JSON.stringify({
      ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
      ...(options.artifactVersion === undefined
        ? { artifact_version: "analysis-v1" }
        : { artifact_version: options.artifactVersion }),
      ...(options.transcriptRef === undefined
        ? { transcript_ref: "TR_AST_MUSICTEST" }
        : { transcript_ref: options.transcriptRef }),
      asset_id: options.assetId ?? "AST_MUSICTEST",
      word_timing_mode: "word",
      items: [{ speaker: "V", start_us: 4_600_000, end_us: 5_600_000, text: "orbit", words: [{ word: "orbit", start_us: 4_600_000, end_us: 5_100_000 }] }],
    }, null, 2);
  }

  const GATE_OFF = {
    defaultsOverride: { rhythm_sync: { mode: "auto" as const, search_window_sec: 1.5, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" as const } },
  };

  function signature(timeline: any): string {
    return JSON.stringify({
      geometry: timeline.tracks.video.flatMap((track: any) =>
        track.clips.map((clip: any) => [clip.clip_id, clip.timeline_in_frame, clip.timeline_duration_frames, clip.src_in_us, clip.src_out_us])),
      beat_sync: (timeline.metadata as Record<string, any>).beat_sync,
    });
  }

  async function setup(name: string, files: Record<string, string>): Promise<string> {
    const dir = path.resolve(path.join(root, name));
    await fsp.cp(SAMPLE, dir, { recursive: true });
    await fsp.rm(path.join(dir, "05_timeline/timeline.json"), { force: true });
    await fsp.mkdir(path.join(dir, "02_media"), { recursive: true });
    await fsp.writeFile(path.join(dir, "02_media/bgm-test.wav"), MEDIA4);
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(dir, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, content);
      h.files.set(absolute, content);
    }
    return dir;
  }

  beforeAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    await fsp.rm(root, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(root)).toBe(false);
  });

  it.each([
    ["unsupported artifact version v999", { artifactVersion: "v999" }, "transcript_artifact_version_unsupported:v999"],
    ["mismatched non-empty transcript_ref", { transcriptRef: "TR_WRONG" }, "transcript_ref_matches_filename:"],
    ["filename/asset mismatch", { assetId: "AST_OTHER" }, "asset_id_matches_filename:"],
  ])("%s is degraded with the central invariant detail and never reaches geometry", async (_name, overrides, expectedFailure) => {
    const bytes = transcriptBytes({ projectId: PROJECT, ...overrides });
    const controlDir = await setup(`ctrl-${sha256(bytes).slice(0, 8)}`, {
      "03_analysis/bgm_analysis.json": bgmBytes(),
    });
    const control = compile({ projectPath: controlDir, createdAt: CREATED_AT, ...GATE_OFF });

    const dir = await setup(`inv-${sha256(bytes).slice(0, 8)}`, {
      "03_analysis/bgm_analysis.json": bgmBytes(),
      "03_analysis/transcripts/TR_AST_MUSICTEST.json": bytes,
    });
    const result = compile({ projectPath: dir, createdAt: CREATED_AT, ...GATE_OFF });

    const transcriptPath = path.join(dir, "03_analysis/transcripts/TR_AST_MUSICTEST.json");
    expect(readsOf(transcriptPath)).toBe(1);
    expect(readsOf(path.join(dir, "03_analysis/bgm_analysis.json"))).toBe(1);

    const rhythm = (result.timeline.metadata as Record<string, any>).rhythm_sync;
    const record = rhythm.evidence_provenance.transcripts.find(
      (entry: any) => entry.path === "03_analysis/transcripts/TR_AST_MUSICTEST.json",
    );
    expect(record).toMatchObject({
      path: "03_analysis/transcripts/TR_AST_MUSICTEST.json",
      sha256: sha256(bytes),
      binding: "degraded",
    });
    // Failure strings are "<rule>:<message>" — assert by deterministic prefix.
    expect(record.failures.some((failure: string) => failure.startsWith(expectedFailure))).toBe(true);
    // Zero transcript evidence: V1 geometry and beat_sync are exactly the
    // no-transcript control.
    expect(signature(result.timeline)).toBe(signature(control.timeline));
  });
});

// ── Authority-unavailable: fail-open compile, fail-closed evidence ───

describe("rhythm sync: transcript schema authority boundary (unit, real FS)", () => {
  const TMP_ROOT = path.join("tests", "tmp_rhythm_authority_unit");

  afterAll(() => {
    fsSync.rmSync(TMP_ROOT, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(TMP_ROOT)).toBe(false);
  });

  function writeProject(name: string, options: { schemas?: Record<string, string> } = {}): string {
    const projectDir = path.join(TMP_ROOT, name);
    fsSync.rmSync(projectDir, { recursive: true, force: true });
    fsSync.mkdirSync(path.join(projectDir, "03_analysis/transcripts"), { recursive: true });
    fsSync.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
    fsSync.writeFileSync(path.join(projectDir, "02_media/bgm.wav"), "fake-pcm-bytes-v1");
    const hash = createHash("sha256").update("fake-pcm-bytes-v1").digest("hex").slice(0, 16);
    fsSync.writeFileSync(path.join(projectDir, "03_analysis/bgm_analysis.json"), JSON.stringify({
      version: "1", project_id: "rhythm-test", analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSIC", path: "02_media/bgm.wav", source_hash: hash },
      beats_sec: [2], downbeats_sec: [4], sections: [],
    }));
    fsSync.writeFileSync(path.join(projectDir, "03_analysis/transcripts/TR_AST_MUSIC.json"), JSON.stringify({
      project_id: "rhythm-test",
      artifact_version: "analysis-v1",
      transcript_ref: "TR_AST_MUSIC",
      asset_id: "AST_MUSIC",
      word_timing_mode: "word",
      items: [{ speaker: "V", start_us: 10_000_000, end_us: 11_000_000, text: "orbit", words: [{ word: "orbit", start_us: 10_000_000, end_us: 10_500_000 }] }],
    }));
    for (const [schemaName, content] of Object.entries(options.schemas ?? {})) {
      fsSync.mkdirSync(path.join(projectDir, "schemas"), { recursive: true });
      fsSync.writeFileSync(path.join(projectDir, "schemas", schemaName), content);
    }
    return projectDir;
  }

  it("missing schemas directory: authority unavailable is degraded provenance, not a crash", () => {
    const project = writeProject("missing-schemas", {}); // no schemas/ dir at all
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test", repoRoot: path.join(project, "nowhere") });
    expect(grid.status).toBe("partial"); // bgm beats stay bound
    expect(grid.evidence.binding).toBe("degraded");
    const record = grid.evidence.transcripts?.find((entry) => entry.path === "03_analysis/transcripts/TR_AST_MUSIC.json");
    expect(record?.binding).toBe("degraded");
    expect(record?.failures.length).toBeGreaterThan(0);
    for (const failure of record?.failures ?? []) {
      expect(failure.startsWith("transcript_schema_authority_unavailable:")).toBe(true);
    }
    expect(grid.sources.word_timestamps).toBe(false);
  });

  it("malformed transcript schema file: authority unavailable, compile-capable degrade, no crash", () => {
    const project = writeProject("malformed-schema", {
      schemas: { "transcript.schema.json": "{ not valid json" },
    });
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test", repoRoot: project });
    const record = grid.evidence.transcripts?.find((entry) => entry.path === "03_analysis/transcripts/TR_AST_MUSIC.json");
    expect(record?.binding).toBe("degraded");
    expect(record?.failures[0]?.startsWith("transcript_schema_authority_unavailable:")).toBe(true);
    expect(grid.sources.word_timestamps).toBe(false);
    // Failure constructions are never cached as successes: a retry with a
    // GOOD root must bind (cache is per repo root).
  });

  it("authority cache is per repo root: a distinct root never inherits another root's verdict", () => {
    // Same project bytes, two roots: one broken, one good.
    const broken = writeProject("cache-broken", {
      schemas: { "transcript.schema.json": "{ not valid json" },
    });
    const brokenGrid = loadRhythmEventGrid(broken, 30, 1, { projectId: "rhythm-test", repoRoot: broken });
    expect(brokenGrid.evidence.binding).toBe("degraded");

    const good = writeProject("cache-good", {
      schemas: {
        "transcript.schema.json": fsSync.readFileSync(path.resolve("schemas/transcript.schema.json"), "utf-8"),
        "analysis-common.schema.json": fsSync.readFileSync(path.resolve("schemas/analysis-common.schema.json"), "utf-8"),
      },
    });
    const goodGrid = loadRhythmEventGrid(good, 30, 1, { projectId: "rhythm-test", repoRoot: good });
    expect(goodGrid.evidence.binding).toBe("bound");
    expect(goodGrid.sources.word_timestamps).toBe(true);
    // The broken root stays degraded (no cross-root reuse).
    const brokenAgain = loadRhythmEventGrid(broken, 30, 1, { projectId: "rhythm-test", repoRoot: broken });
    expect(brokenAgain.evidence.transcripts?.[0]?.failures[0]?.startsWith("transcript_schema_authority_unavailable:")).toBe(true);
  });
});

// ── High 1/3: validateProject ⇔ admission parity + canonical filenames ──

describe("rhythm sync: one central transcript authority (validateProject ⇔ admission)", () => {
  const TMP = path.join("tests", "tmp_rhythm_parity_unit");

  afterAll(() => {
    fsSync.rmSync(TMP, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(TMP)).toBe(false);
  });

  function writeParityProject(): string {
    fsSync.rmSync(TMP, { recursive: true, force: true });
    fsSync.mkdirSync(path.join(TMP, "01_intent"), { recursive: true });
    fsSync.mkdirSync(path.join(TMP, "03_analysis/transcripts"), { recursive: true });
    fsSync.writeFileSync(path.join(TMP, "01_intent/creative_brief.yaml"), "version: \"1\"\nproject_id: \"parity-project\"\n");
    const transcript = (assetId: string, projectId: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
      project_id: projectId,
      artifact_version: "analysis-v1",
      transcript_ref: `TR_${assetId}`,
      asset_id: assetId,
      word_timing_mode: "word",
      items: [{ speaker: "V", start_us: 1_000_000, end_us: 2_000_000, text: "x", words: [{ word: "x", start_us: 1_000_000, end_us: 1_500_000 }] }],
      ...overrides,
    }, null, 2);
    // v999 version, foreign project, ref mismatch, canonical control, non-canonical filename.
    fsSync.writeFileSync(path.join(TMP, "03_analysis/transcripts/TR_AST_V999.json"), transcript("AST_V999", "parity-project", { artifact_version: "v999" }));
    fsSync.writeFileSync(path.join(TMP, "03_analysis/transcripts/TR_AST_FOREIGN.json"), transcript("AST_FOREIGN", "another-project"));
    fsSync.writeFileSync(path.join(TMP, "03_analysis/transcripts/TR_AST_REFBAD.json"), transcript("AST_REFBAD", "parity-project", { transcript_ref: "TR_WRONG" }));
    fsSync.writeFileSync(path.join(TMP, "03_analysis/transcripts/TR_AST_OK.json"), transcript("AST_OK", "parity-project"));
    fsSync.writeFileSync(path.join(TMP, "03_analysis/transcripts/not-canonical.json"), transcript("AST_OK", "parity-project"));
    return TMP;
  }

  it("validateProject and admission agree per file (same central authority)", async () => {
    const { validateProject } = await import("../runtime/validation/schema-validator.js");
    const { loadRhythmEventGrid } = await import("../runtime/compiler/rhythm-sync.js");
    const project = writeParityProject();

    const validation = validateProject(project, { repoRoot: path.resolve(".") });
    const violationsByRule = new Map<string, number>();
    for (const violation of validation.violations) {
      if (violation.artifact.startsWith("03_analysis/transcripts/")) {
        violationsByRule.set(violation.rule, (violationsByRule.get(violation.rule) ?? 0) + 1);
      }
    }

    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "parity-project", repoRoot: path.resolve(".") });
    const records = grid.evidence.transcripts ?? [];
    const recordOf = (p: string) => records.find((entry) => entry.path === p);

    // v999: both reject with the same central rule.
    expect(recordOf("03_analysis/transcripts/TR_AST_V999.json")?.binding).toBe("degraded");
    expect(recordOf("03_analysis/transcripts/TR_AST_V999.json")?.failures.some((f: string) => f.startsWith("transcript_artifact_version_unsupported:v999"))).toBe(true);
    expect(violationsByRule.get("transcript_artifact_version_unsupported")).toBeGreaterThan(0);

    // Foreign consuming project: both reject.
    expect(recordOf("03_analysis/transcripts/TR_AST_FOREIGN.json")?.failures.some((f: string) => f.startsWith("transcript_project_id_mismatch:"))).toBe(true);
    expect(violationsByRule.get("transcript_project_id_mismatch")).toBeGreaterThan(0);

    // Ref mismatch: both reject.
    expect(recordOf("03_analysis/transcripts/TR_AST_REFBAD.json")?.failures.some((f: string) => f.startsWith("transcript_ref_matches_filename:"))).toBe(true);
    expect(violationsByRule.get("transcript_ref_matches_filename")).toBeGreaterThan(0);

    // Non-canonical filename: reported by BOTH, never silently skipped.
    expect(recordOf("03_analysis/transcripts/not-canonical.json")?.failures.some((f: string) => f.startsWith("transcript_filename_canonical:"))).toBe(true);
    expect(violationsByRule.get("transcript_filename_canonical")).toBeGreaterThan(0);

    // The canonical bound control passes BOTH paths.
    expect(recordOf("03_analysis/transcripts/TR_AST_OK.json")?.binding).toBe("bound");
    expect(violationsByRule.get("transcript_schema_invalid")).toBeUndefined();
    // General utterances: only the canonical bound file projects (3 files
    // are degraded; not-canonical contributes zero utterances).
    const degradedPaths = records.filter((entry) => entry.binding !== "bound").length;
    expect(degradedPaths).toBe(4);
  });

  it("exports no path-reopening word helper and no weaker handwritten subset", async () => {
    const rhythmModule = await import("../runtime/compiler/rhythm-sync.js");
    // The path-reopening API is gone.
    expect((rhythmModule as Record<string, unknown>).loadMusicAssetWordsSnapshot).toBeUndefined();
    // The only public word helper takes the immutable snapshot.
    expect(typeof rhythmModule.loadMusicAssetWords).toBe("function");
    expect(rhythmModule.loadMusicAssetWords.length).toBeGreaterThan(0);
    const first = String(rhythmModule.loadMusicAssetWords).slice(0, 400);
    expect(first).not.toContain("readFileSync");
    expect(first).not.toContain("existsSync");
    // The central authority is exported from the validation layer.
    const validationModule = await import("../runtime/validation/schema-validator.js");
    expect(typeof validationModule.validateTranscriptDoc).toBe("function");
    expect(Array.isArray(validationModule.SUPPORTED_TRANSCRIPT_ARTIFACT_VERSIONS)).toBe(true);
  });

  it("authority-unavailable details are deterministic and machine-path-free", async () => {
    const { loadRhythmEventGrid } = await import("../runtime/compiler/rhythm-sync.js");
    const project = path.join(TMP, "authority-detail");
    fsSync.rmSync(project, { recursive: true, force: true });
    fsSync.mkdirSync(path.join(project, "03_analysis/transcripts"), { recursive: true });
    fsSync.writeFileSync(path.join(project, "03_analysis/transcripts/TR_AST_MUSIC.json"), JSON.stringify({
      project_id: "p", artifact_version: "analysis-v1", transcript_ref: "TR_AST_MUSIC", asset_id: "AST_MUSIC",
      items: [],
    }));
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "p", repoRoot: path.join(project, "no-such-root") });
    const record = grid.evidence.transcripts?.[0];
    expect(record?.binding).toBe("degraded");
    expect(record?.failures[0]?.startsWith("transcript_schema_authority_unavailable:")).toBe(true);
    // Normalized: no absolute machine-specific paths or stacks.
    for (const failure of record?.failures ?? []) {
      expect(failure.includes(os.tmpdir())).toBe(false);
      expect(failure.includes(process.cwd())).toBe(false);
      expect(failure).not.toMatch(/at \w+ \(/); // no stack frames
    }
    // Deterministic across repeated calls.
    const grid2 = loadRhythmEventGrid(project, 30, 1, { projectId: "p", repoRoot: path.join(project, "no-such-root") });
    expect(grid2.evidence.transcripts?.[0]?.failures).toEqual(record?.failures);
  });
});

// ── High 3: non-canonical transcript filename (full compile, real FS) ──

describe("rhythm sync: non-canonical transcript filename (full compile)", () => {
  const SAMPLE = path.resolve("projects/sample");
  const CREATED_AT = "2026-08-29T00:00:00Z";
  const root = path.join("tests", "tmp_rhythm_noncanonical_full");
  const MEDIA5 = "fixture-bgm-media-bytes-v1";
  const MEDIA5_HASH = createHash("sha256").update(MEDIA5).digest("hex").slice(0, 16);
  const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
  const readsOf = (p: string) => h.readLog.filter((entry) => entry === p).length;
  const PROJECT = "sample-mountain-reset";

  const bgmBytes = () => {
    const beats: number[] = [];
    for (let t = 0; t < 30; t += 2) beats.push(t);
    return JSON.stringify({
      version: "1", project_id: PROJECT, analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSICTEST", path: "02_media/bgm-test.wav", source_hash: MEDIA5_HASH },
      bpm: 120, meter: "4/4", duration_sec: 30,
      beats_sec: beats, downbeats_sec: beats,
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: 4.6, energy: 0.3 },
        { id: "S2", label: "chorus", start_sec: 4.6, end_sec: 20, energy: 0.9 },
        { id: "S3", label: "outro", start_sec: 20, end_sec: 30, energy: 0.4 },
      ],
      provenance: { detector: "detector-A", sample_rate_hz: 44100 },
    }, null, 2);
  };

  const validTranscriptBytes = () => JSON.stringify({
    project_id: PROJECT,
    artifact_version: "analysis-v1",
    transcript_ref: "TR_AST_MUSICTEST",
    asset_id: "AST_MUSICTEST",
    word_timing_mode: "word",
    items: [{ speaker: "V", start_us: 4_600_000, end_us: 5_600_000, text: "orbit", words: [{ word: "orbit", start_us: 4_600_000, end_us: 5_100_000 }] }],
  }, null, 2);

  const GATE_OFF = {
    defaultsOverride: { rhythm_sync: { mode: "auto" as const, search_window_sec: 1.5, max_shift_frames: 12, parity_max_offset_frames: 2, parity_gate: "off" as const } },
  };

  function signature(timeline: any): string {
    return JSON.stringify({
      geometry: timeline.tracks.video.flatMap((track: any) =>
        track.clips.map((clip: any) => [clip.clip_id, clip.timeline_in_frame, clip.timeline_duration_frames, clip.src_in_us, clip.src_out_us])),
      beat_sync: (timeline.metadata as Record<string, any>).beat_sync,
    });
  }

  async function setup(name: string, files: Record<string, string>): Promise<string> {
    const dir = path.resolve(path.join(root, name));
    await fsp.cp(SAMPLE, dir, { recursive: true });
    await fsp.rm(path.join(dir, "05_timeline/timeline.json"), { force: true });
    await fsp.mkdir(path.join(dir, "02_media"), { recursive: true });
    await fsp.writeFile(path.join(dir, "02_media/bgm-test.wav"), MEDIA5);
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(dir, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, content);
      h.files.set(absolute, content);
    }
    return dir;
  }

  beforeAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    h.files.clear();
    h.readLog.length = 0;
    h.mutateAfterRead.clear();
    await fsp.rm(root, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(root)).toBe(false);
  });

  it("valid content under a non-canonical filename is degraded provenance with no-transcript-equivalent geometry", async () => {
    const bytes = validTranscriptBytes();
    const controlDir = await setup("ctrl", {
      "03_analysis/bgm_analysis.json": bgmBytes(),
    });
    const control = compile({ projectPath: controlDir, createdAt: CREATED_AT, ...GATE_OFF });

    // Same valid bytes, but the FILENAME is not the canonical TR_<asset>.json:
    // music words AND general utterances must be excluded.
    const armedDir = await setup("noncanonical", {
      "03_analysis/bgm_analysis.json": bgmBytes(),
      "03_analysis/transcripts/not-canonical.json": bytes,
    });
    const result = compile({ projectPath: armedDir, createdAt: CREATED_AT, ...GATE_OFF });

    const transcriptPath = path.join(armedDir, "03_analysis/transcripts/not-canonical.json");
    expect(readsOf(transcriptPath)).toBe(1);
    expect(readsOf(path.join(armedDir, "03_analysis/bgm_analysis.json"))).toBe(1);

    const rhythm = (result.timeline.metadata as Record<string, any>).rhythm_sync;
    const record = rhythm.evidence_provenance.transcripts.find(
      (entry: any) => entry.path === "03_analysis/transcripts/not-canonical.json",
    );
    expect(record).toMatchObject({
      path: "03_analysis/transcripts/not-canonical.json",
      sha256: sha256(bytes),
      binding: "degraded",
    });
    expect(record.failures.some((failure: string) => failure.startsWith("transcript_filename_canonical:"))).toBe(true);
    // No TR_AST_MUSICTEST.json exists → no music word lookup at all.
    // Zero music words and zero general utterances: geometry and beat_sync
    // are EXACTLY the no-transcript control (music + talking-head routes).
    expect(rhythm.sources.word_timestamps ?? rhythm.sources?.word_timestamps).toBeFalsy();
    expect(rhythm.counts?.snapped ?? 0).toBe((control.timeline.metadata as Record<string, any>).rhythm_sync.counts?.snapped ?? 0);
    expect(signature(result.timeline)).toBe(signature(control.timeline));
  });
});

// ── High: exact supported-version matrix (admission) ─────────────────

describe("rhythm sync: canonical transcript artifact version matrix", () => {
  const TMP = path.join("tests", "tmp_rhythm_version_matrix");

  afterAll(() => {
    fsSync.rmSync(TMP, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(TMP)).toBe(false);
  });

  function writeVersionProject(version: unknown): string {
    fsSync.rmSync(TMP, { recursive: true, force: true });
    fsSync.mkdirSync(path.join(TMP, "03_analysis/transcripts"), { recursive: true });
    fsSync.mkdirSync(path.join(TMP, "02_media"), { recursive: true });
    fsSync.writeFileSync(path.join(TMP, "02_media/bgm.wav"), "fake-pcm-bytes-v1");
    const hash = createHash("sha256").update("fake-pcm-bytes-v1").digest("hex").slice(0, 16);
    fsSync.writeFileSync(path.join(TMP, "03_analysis/bgm_analysis.json"), JSON.stringify({
      version: "1", project_id: "rhythm-test", analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSIC", path: "02_media/bgm.wav", source_hash: hash },
      beats_sec: [2], downbeats_sec: [4], sections: [],
    }));
    const versionField = version === null ? {} : { artifact_version: version };
    fsSync.writeFileSync(path.join(TMP, "03_analysis/transcripts/TR_AST_MUSIC.json"), JSON.stringify({
      project_id: "rhythm-test",
      ...versionField,
      transcript_ref: "TR_AST_MUSIC",
      asset_id: "AST_MUSIC",
      word_timing_mode: "word",
      items: [{ speaker: "V", start_us: 10_000_000, end_us: 11_000_000, text: "orbit", words: [{ word: "orbit", start_us: 10_000_000, end_us: 10_500_000 }] }],
    }));
    return TMP;
  }

  it.each([
    ["2.0.0"],
    ["analysis-v1"],
    ["analysis-v2"],
  ])("admits the exact supported canonical version %s", (version) => {
    const project = writeVersionProject(version);
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test", repoRoot: path.resolve(".") });
    const record = grid.evidence.transcripts?.find((entry) => entry.path === "03_analysis/transcripts/TR_AST_MUSIC.json");
    expect(record?.binding).toBe("bound");
    expect(record?.failures).toEqual([]);
    expect(grid.sources.word_timestamps).toBe(true);
    expect(grid.sources.word_count).toBe(1);
    expect(grid.status).toBe("ready");
  });

  it.each([
    ["analysis-v3"],
    ["2.0.1"],
    ["v999"],
  ])("degrades the arbitrary unsupported variant %s with the central rule", (version) => {
    const project = writeVersionProject(version);
    const grid = loadRhythmEventGrid(project, 30, 1, { projectId: "rhythm-test", repoRoot: path.resolve(".") });
    const record = grid.evidence.transcripts?.find((entry) => entry.path === "03_analysis/transcripts/TR_AST_MUSIC.json");
    expect(record?.binding).toBe("degraded");
    expect(record?.failures).toEqual([`transcript_artifact_version_unsupported:${version}`]);
    expect(grid.sources.word_timestamps).toBe(false);
    expect(grid.sources.word_count).toBe(0);
  });
});

// ── Medium: repo-root auto-discovery failure (normalized, no escape) ──

describe("rhythm sync: repo-root discovery failure (hostile, real FS)", () => {
  const OUTSIDE = path.join(os.tmpdir(), "rhythm-discovery-failure-fixture");

  afterAll(() => {
    fsSync.rmSync(OUTSIDE, { recursive: true, force: true });
    // Task-owned files must be absent after the tests (tracked and ignored).
    expect(fsSync.existsSync(OUTSIDE)).toBe(false);
  });

  function writeOutsideProject(withTranscript: boolean): string {
    fsSync.rmSync(OUTSIDE, { recursive: true, force: true });
    fsSync.mkdirSync(path.join(OUTSIDE, "03_analysis/transcripts"), { recursive: true });
    fsSync.mkdirSync(path.join(OUTSIDE, "02_media"), { recursive: true });
    fsSync.writeFileSync(path.join(OUTSIDE, "02_media/bgm.wav"), "fake-pcm-bytes-v1");
    const hash = createHash("sha256").update("fake-pcm-bytes-v1").digest("hex").slice(0, 16);
    fsSync.writeFileSync(path.join(OUTSIDE, "03_analysis/bgm_analysis.json"), JSON.stringify({
      version: "1", project_id: "outside-project", analysis_status: "ready",
      music_asset: { asset_id: "AST_MUSIC", path: "02_media/bgm.wav", source_hash: hash },
      beats_sec: [2], downbeats_sec: [4], sections: [],
    }));
    if (withTranscript) {
      fsSync.writeFileSync(path.join(OUTSIDE, "03_analysis/transcripts/TR_AST_MUSIC.json"), JSON.stringify({
        project_id: "outside-project",
        artifact_version: "analysis-v1",
        transcript_ref: "TR_AST_MUSIC",
        asset_id: "AST_MUSIC",
        word_timing_mode: "word",
        items: [{ speaker: "V", start_us: 10_000_000, end_us: 11_000_000, text: "orbit", words: [{ word: "orbit", start_us: 10_000_000, end_us: 10_500_000 }] }],
      }));
    }
    return OUTSIDE;
  }

  it("auto-discovery failure yields stable normalized detail, zero words, and no exception escape", () => {
    const project = writeOutsideProject(true);
    // os.tmpdir() is outside any repository: findRepoRoot cannot discover a
    // schemas/ directory, and no repoRoot option is passed.
    expect(path.resolve(project).startsWith(path.resolve("."))).toBe(false);

    const grid1 = loadRhythmEventGrid(project, 30, 1, { projectId: "outside-project" });
    const grid2 = loadRhythmEventGrid(project, 30, 1, { projectId: "outside-project" });

    const record1 = grid1.evidence.transcripts?.find((entry) => entry.path === "03_analysis/transcripts/TR_AST_MUSIC.json");
    expect(record1?.binding).toBe("degraded");
    expect(record1?.failures.length).toBe(1);
    const detail = record1?.failures[0] ?? "";
    expect(detail.startsWith("transcript_schema_authority_unavailable:")).toBe(true);
    expect(detail).toContain("Could not find repo root");
    // Deterministic across calls; no absolute machine paths, no stacks.
    expect(grid2.evidence.transcripts?.[0]?.failures).toEqual(record1?.failures);
    expect(detail.includes(os.tmpdir())).toBe(false);
    expect(detail.includes(process.cwd())).toBe(false);
    expect(detail).not.toMatch(/at \w+ \(/);
    // Zero words adopted; the pass degrades honestly instead of crashing.
    expect(grid1.sources.word_timestamps).toBe(false);
    expect(grid1.sources.word_count).toBe(0);
    expect(grid1.evidence.binding).toBe("degraded");
  });

  it("discovery-failure evidence shape is identical to the no-transcript shape (zero admission)", () => {
    const withTranscript = writeOutsideProject(true);
    const gridTranscript = loadRhythmEventGrid(withTranscript, 30, 1, { projectId: "outside-project" });

    const withoutTranscript = writeOutsideProject(false);
    const gridNoTranscript = loadRhythmEventGrid(withoutTranscript, 30, 1, { projectId: "outside-project" });

    // Same admission shape as no-transcript: no words, no word events, same
    // partial status (bgm beats stay bound; the authority is unavailable
    // only for transcript projection).
    expect(gridTranscript.sources.word_timestamps).toBe(false);
    expect(gridTranscript.sources.word_count).toBe(0);
    expect(gridTranscript.status).toBe(gridNoTranscript.status);
    expect(gridTranscript.events.filter((event) => event.kind === "word_start")).toEqual([]);
    expect(gridNoTranscript.events.filter((event) => event.kind === "word_start")).toEqual([]);
  });
});
