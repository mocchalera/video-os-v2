import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildBgmCatalog } from "../runtime/music/catalog.js";
import {
  BgmPackPromotionError,
  buildBgmPromotionPlan,
  materializeBgmCandidatePack,
} from "../runtime/music/pack-promotion.js";
import { verifyPack } from "../runtime/music/pack-registry.js";
import { selectBgmForProject } from "../runtime/music/selection-service.js";
import {
  PROMOTE_BGM_PACK_CLI_EXIT,
  runPromoteBgmPackCli,
  type PromoteBgmPackCliIo,
} from "../scripts/promote-bgm-pack.js";

const tempDirectories: string[] = [];
const CATALOG_PATH = path.resolve("docs/bgm-pack/core-v1/track-catalog.yaml");
const FIXED_TIME = "2026-07-27T12:00:00.000Z";

interface CatalogTrackFixture {
  id: string;
  bpm: number;
  meter: string;
  working_title: string;
  structure_90_150s: { target_duration_seconds: number };
}

interface CandidateFixture {
  analysisPath: string;
  audioPath: string;
  stableId: string;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-bgm-promotion-"));
  tempDirectories.push(root);
  return root;
}

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalogTracks(): CatalogTrackFixture[] {
  const document = parseYaml(fs.readFileSync(CATALOG_PATH, "utf8")) as { tracks: CatalogTrackFixture[] };
  return document.tracks;
}

function writeCandidate(
  sourceRoot: string,
  track: CatalogTrackFixture,
  ordinal: number,
  globalOrdinal: number,
): CandidateFixture {
  const batchNumber = (globalOrdinal - 1) % 3 + 1;
  const batchRoot = path.join(sourceRoot, `batch-${batchNumber}`);
  const inputRoot = path.join(batchRoot, "input");
  const analysisRoot = path.join(batchRoot, "analysis");
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.mkdirSync(analysisRoot, { recursive: true });

  const stableOrdinal = String(ordinal).padStart(2, "0");
  const stableId = `${track.id}-batch${batchNumber}-candidate-${stableOrdinal}`;
  const filename = `${track.id}-${stableOrdinal}.m4a`;
  const audioBytes = Buffer.from(`fixture-audio:${track.id}:${batchNumber}:${stableOrdinal}`);
  const audioPath = path.join(inputRoot, filename);
  fs.writeFileSync(audioPath, audioBytes);

  const tiedBest = track.id === "trust-clarity-low-01" && ordinal <= 2;
  const duration = tiedBest
    ? track.structure_90_150s.target_duration_seconds
    : track.structure_90_150s.target_duration_seconds + Math.max(0, ordinal - 1) * 4;
  const bpm = tiedBest ? track.bpm : track.bpm + Math.max(0, ordinal - 1) * 2;
  const generationId = `00000000-0000-4000-8000-${String(globalOrdinal).padStart(12, "0")}`;
  const analysis = {
    filename,
    title: track.working_title,
    track_id: track.id,
    candidate_number: ordinal,
    sha256: hash(audioBytes),
    duplicate_of: null,
    codec: "opus",
    sample_rate_hz: 48_000,
    channels: 2,
    bit_rate: 128_000,
    duration_sec: duration,
    bpm,
    meter: track.meter,
    detector: "fixture",
    status: "ready",
    beat_count: 8,
    section_count: 2,
    suno_comment: `made with suno; created=2026-07-16T12:00:00Z; id=${generationId}`,
    analysis: {
      version: "1",
      project_id: "fixture-bgm-candidates",
      analysis_status: "ready",
      music_asset: {
        asset_id: stableId,
        path: audioPath,
        source_hash: hash(audioBytes).slice(0, 16),
      },
      bpm,
      meter: track.meter,
      duration_sec: duration,
      beats_sec: [0, 1, 2, 3, 4, 5, 6, 7],
      downbeats_sec: [0, 4],
      sections: [
        { id: "S1", label: "intro", start_sec: 0, end_sec: duration / 2, energy: 0.3 },
        { id: "S2", label: "outro", start_sec: duration / 2, end_sec: duration, energy: 0.5 },
      ],
      beats: [0, 1, 2, 3, 4, 5, 6, 7].map((time) => ({ time_sec: time, strength: 0.75 })),
      provenance: { detector: "fixture", sample_rate_hz: 48_000 },
    },
  };
  const analysisPath = path.join(analysisRoot, `${stableId}.json`);
  fs.writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
  return { analysisPath, audioPath, stableId };
}

function writeCandidateSet(root: string): { sourceRoot: string; candidates: CandidateFixture[] } {
  const sourceRoot = path.join(root, "source");
  const candidates: CandidateFixture[] = [];
  let globalOrdinal = 1;
  catalogTracks().forEach((track, trackIndex) => {
    const count = trackIndex < 9 ? 7 : 6;
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      candidates.push(writeCandidate(sourceRoot, track, ordinal, globalOrdinal));
      globalOrdinal += 1;
    }
  });
  expect(candidates).toHaveLength(105);
  return { sourceRoot, candidates };
}

function writeBatchSummaries(sourceRoot: string): void {
  for (const batch of fs.readdirSync(sourceRoot).sort()) {
    const analysisRoot = path.join(sourceRoot, batch, "analysis");
    const summary = fs.readdirSync(analysisRoot)
      .filter((filename) => filename.endsWith(".json"))
      .sort()
      .map((filename) => {
        const document = JSON.parse(fs.readFileSync(path.join(analysisRoot, filename), "utf8")) as Record<string, unknown>;
        const { analysis: _analysis, ...facts } = document;
        return facts;
      });
    fs.writeFileSync(path.join(analysisRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

function fakePreviewRenderer(sourcePath: string, outputPath: string): void {
  fs.writeFileSync(outputPath, Buffer.concat([Buffer.from("fixture-preview:"), fs.readFileSync(sourcePath)]));
}

function outputPath(root: string): string {
  return path.join(root, "packs", "video-os-core-bgm-v1-candidate", "1.0.0-candidate.1");
}

function writeProject(root: string): string {
  const projectDir = path.join(root, "narunarugram-fixture");
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "01_intent", "creative_brief.yaml"), stringifyYaml({
    version: "1",
    project_id: "narunarugram-fixture",
    project: {
      title: "AX-1 なるなるgram 経営者インタビュー",
      strategy: "経営者本人の実践と信頼をdialogue-firstで伝える",
      runtime_target_sec: 60,
    },
    message: { primary: "AI活用の具体性と経営者本人の前進" },
    audience: { primary: "経営者" },
    emotion_curve: ["recognition", "credibility", "forward momentum"],
    must_have: ["インタビュー", "信頼", "実践"],
    must_avoid: ["lead vocal"],
    audio_policy: "ducking",
  }));
  fs.writeFileSync(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), stringifyYaml({
    version: "1",
    project_id: "narunarugram-fixture",
    beats: [
      { id: "b01", label: "recognition", purpose: "課題", target_duration_frames: 600, required_roles: ["dialogue"] },
      { id: "b02", label: "forward momentum", purpose: "成果", target_duration_frames: 1_200, required_roles: ["dialogue"] },
    ],
    music_policy: { start_sparse: true, allow_release_late: true, permitted_energy_curve: "restrained_to_warm" },
    ending_policy: { should_feel: "resolved with余韻" },
  }));
  fs.writeFileSync(path.join(projectDir, "05_timeline", "timeline.json"), `${JSON.stringify({
    version: "2",
    project_id: "narunarugram-fixture",
    sequence: { fps_num: 30, fps_den: 1 },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [
        { timeline_in_frame: 0, timeline_duration_frames: 900 },
        { timeline_in_frame: 900, timeline_duration_frames: 900 },
      ] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [
        { timeline_in_frame: 0, timeline_duration_frames: 1_650, role: "dialogue" },
      ] }],
    },
  }, null, 2)}\n`);
  return projectDir;
}

function captureIo(): { io: PromoteBgmPackCliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } },
      stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
    },
  };
}

describe("BGM candidate Pack promotion", () => {
  it("selects one candidate for every family deterministically from all 105 inputs", () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    const first = buildBgmPromotionPlan({
      sourceRoot,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
    });
    const second = buildBgmPromotionPlan({
      sourceRoot,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
    });

    expect(first).toEqual(second);
    expect(first.candidate_count).toBe(105);
    expect(first.family_count).toBe(16);
    expect(first.selections).toHaveLength(16);
    expect(new Set(first.selections.map((selection) => selection.track_id)).size).toBe(16);
    expect(first.selection_method.tie_break).toContain("stable_id");
    expect(first.human_gates).toContain("musical_audition");
    expect(first.selections.find((selection) => selection.track_id === "trust-clarity-low-01")?.stable_id)
      .toBe("trust-clarity-low-01-batch1-candidate-01");
  });

  it("uses existing batch-summary analysis deterministically when individual evidence is offline", () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    writeBatchSummaries(sourceRoot);
    const plan = buildBgmPromotionPlan({
      sourceRoot,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
    });

    expect(plan.candidate_count).toBe(105);
    expect(plan.selections).toHaveLength(16);
    expect(plan.selections.every((selection) => selection.analysis_evidence_type === "batch_summary")).toBe(true);
    expect(plan.selections.find((selection) => selection.track_id === "trust-clarity-low-01")?.stable_id)
      .toBe("trust-clarity-low-01-batch1-candidate-01");
  });

  it("rejects a changed source hash before creating a plan", () => {
    const root = tempRoot();
    const { sourceRoot, candidates } = writeCandidateSet(root);
    fs.appendFileSync(candidates[0].audioPath, "changed");
    expect(() => buildBgmPromotionPlan({
      sourceRoot,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
    })).toThrowError(expect.objectContaining({ code: "BGM_TRACK_HASH_MISMATCH" }));
  });

  it("rejects an unsafe source reference that escapes its batch input directory", () => {
    const root = tempRoot();
    const { sourceRoot, candidates } = writeCandidateSet(root);
    const document = JSON.parse(fs.readFileSync(candidates[0].analysisPath, "utf8")) as {
      filename: string;
      analysis: { music_asset: { path: string } };
    };
    document.filename = "../outside.m4a";
    document.analysis.music_asset.path = path.join(root, "outside.m4a");
    fs.writeFileSync(path.join(root, "outside.m4a"), "outside");
    fs.writeFileSync(candidates[0].analysisPath, `${JSON.stringify(document, null, 2)}\n`);

    expect(() => buildBgmPromotionPlan({
      sourceRoot,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
    })).toThrowError(expect.objectContaining({ code: "BGM_PACK_ARCHIVE_UNSAFE" }));
  });

  it("refuses an existing output without overwriting it", () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    const destination = outputPath(root);
    fs.mkdirSync(destination, { recursive: true });
    const marker = path.join(destination, "keep.txt");
    fs.writeFileSync(marker, "preserve");

    expect(() => materializeBgmCandidatePack({
      sourceRoot,
      outputPath: destination,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
      previewRenderer: fakePreviewRenderer,
    })).toThrowError(expect.objectContaining({ code: "BGM_PACK_BUSY" }));
    expect(fs.readFileSync(marker, "utf8")).toBe("preserve");
  });

  it("materializes and discovers 16 fully verified tracks with pinned provenance", () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    const destination = outputPath(root);
    const result = materializeBgmCandidatePack({
      sourceRoot,
      outputPath: destination,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
      previewRenderer: fakePreviewRenderer,
    });

    const verification = verifyPack(destination);
    const catalog = buildBgmCatalog({
      searchRoots: [{ source: "environment", priority: 1, path: path.join(root, "packs") }],
    });
    expect(result.verification.ok).toBe(true);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification.files_checked).toBe(66);
    expect(verification.verified_provenance_paths).toHaveLength(1);
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.tracks).toHaveLength(16);
  });

  it("fails registry verification when a promoted preview is missing", () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    const destination = outputPath(root);
    const result = materializeBgmCandidatePack({
      sourceRoot,
      outputPath: destination,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
      previewRenderer: fakePreviewRenderer,
    });
    fs.rmSync(path.join(destination, result.manifest.tracks[0].preview.path));

    const verification = verifyPack(destination);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_TRACK_MISSING",
      affected_ref: result.manifest.tracks[0].track_id,
    }));
  });

  it("returns three dialogue-first audition candidates through select-bgm dry-run", async () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    const destination = outputPath(root);
    materializeBgmCandidatePack({
      sourceRoot,
      outputPath: destination,
      catalogPath: CATALOG_PATH,
      createdAt: FIXED_TIME,
      expectedCandidateCount: 105,
      previewRenderer: fakePreviewRenderer,
    });
    const projectDir = writeProject(root);
    const result = await selectBgmForProject({
      projectPath: projectDir,
      requestedMode: "suggest",
      outputScope: "preview_internal",
      packRoot: path.join(root, "packs"),
      writeArtifact: false,
      createdAt: FIXED_TIME,
    });
    const topThree = result.artifact.candidates
      .filter((candidate) => candidate.status === "ranked")
      .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 3);

    expect(result.ok).toBe(true);
    expect(result.wrote_artifact).toBe(false);
    expect(topThree).toHaveLength(3);
    expect(topThree.every((candidate) => candidate.rejection_reasons.length === 0)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "04_plan", "bgm_selection.json"))).toBe(false);
  });

  it("supports a non-mutating CLI dry-run and help contract", async () => {
    const root = tempRoot();
    const { sourceRoot } = writeCandidateSet(root);
    const destination = outputPath(root);
    const dryRunCapture = captureIo();
    const dryRunExit = await runPromoteBgmPackCli([
      "node",
      "promote-bgm-pack",
      "--source-root",
      sourceRoot,
      "--output",
      destination,
      "--dry-run",
      "--json",
    ], dryRunCapture.io, {
      now: () => new Date(FIXED_TIME),
      materialize: materializeBgmCandidatePack,
      plan: buildBgmPromotionPlan,
    });
    const dryRun = JSON.parse(dryRunCapture.stdout.join("")) as { ok: boolean; candidate_count: number; selections: unknown[] };
    expect(dryRunExit).toBe(PROMOTE_BGM_PACK_CLI_EXIT.ok);
    expect(dryRun).toMatchObject({ ok: true, candidate_count: 105 });
    expect(dryRun.selections).toHaveLength(16);
    expect(fs.existsSync(destination)).toBe(false);

    const helpCapture = captureIo();
    const helpExit = await runPromoteBgmPackCli(
      ["node", "promote-bgm-pack", "--help"],
      helpCapture.io,
    );
    expect(helpExit).toBe(PROMOTE_BGM_PACK_CLI_EXIT.ok);
    expect(helpCapture.stdout.join("")).toContain("--source-root");
    expect(helpCapture.stdout.join("")).toContain("--dry-run");
  });

  it("surfaces promotion failures as stable CLI errors", async () => {
    const root = tempRoot();
    const { sourceRoot, candidates } = writeCandidateSet(root);
    fs.appendFileSync(candidates[0].audioPath, "changed");
    const capture = captureIo();
    const exit = await runPromoteBgmPackCli([
      "node",
      "promote-bgm-pack",
      "--source-root",
      sourceRoot,
      "--output",
      outputPath(root),
      "--dry-run",
      "--json",
    ], capture.io);
    const payload = JSON.parse(capture.stdout.join("")) as { ok: boolean; issues: Array<{ code: string }> };
    expect(exit).toBe(PROMOTE_BGM_PACK_CLI_EXIT.integrity);
    expect(payload.ok).toBe(false);
    expect(payload.issues).toContainEqual(expect.objectContaining({ code: "BGM_TRACK_HASH_MISMATCH" }));
  });

  it("uses the typed promotion error for fail-closed conditions", () => {
    const error = new BgmPackPromotionError(
      "BGM_PACK_INCOMPATIBLE",
      "fixture",
      "fixture-ref",
    );
    expect(error).toMatchObject({
      name: "BgmPackPromotionError",
      code: "BGM_PACK_INCOMPATIBLE",
      affected_ref: "fixture-ref",
    });
  });
});
