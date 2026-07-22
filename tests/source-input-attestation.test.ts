import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFreshAssembly } from "../scripts/package.js";
import { renderRoughCut } from "../scripts/render-rough-cut.js";
import {
  evaluateReviewVisualQA,
} from "../runtime/review/visual-qa.js";
import {
  MAX_PERSISTED_SOURCE_INPUTS,
  MAX_SOURCE_INPUT_WARNINGS,
  SOURCE_INPUT_ATTESTATION_VERSION,
  assessRenderArtifactFreshness,
  createSourceInputAttestation,
  writeRenderFreshnessMetadata,
} from "../runtime/render/source-input-attestation.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";
import type { MarlinQAReport } from "../runtime/eval/marlin-qa-types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface AssetFixture {
  id: string;
  bytes: string;
  mediaKind?: "video" | "audio" | "image" | "sequence" | "unknown";
  declared?: boolean | string | null;
}

function makeProject(assets: AssetFixture[], timeline?: Record<string, unknown>): {
  projectDir: string;
  paths: Map<string, string>;
  timelinePath: string;
} {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-attestation-"));
  tempDirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "02_media"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
  const paths = new Map<string, string>();
  const analysisItems: Record<string, unknown>[] = [];
  const items = assets.map((asset) => {
    const sourcePath = path.join(projectDir, "02_media", `${asset.id}.bin`);
    fs.writeFileSync(sourcePath, asset.bytes);
    paths.set(asset.id, sourcePath);
    const declaredValue = asset.declared === true
      ? sha256FileHex(sourcePath)
      : typeof asset.declared === "string" || asset.declared === null
        ? asset.declared
        : undefined;
    if (asset.mediaKind === "image") {
      const relative = `still_frames/${asset.id}/frame_0.png`;
      const normalized = path.join(projectDir, "03_analysis", relative);
      fs.mkdirSync(path.dirname(normalized), { recursive: true });
      fs.writeFileSync(normalized, `normalized:${asset.bytes}`);
      analysisItems.push({
        asset_id: asset.id,
        filename: `${asset.id}.bin`,
        media_kind: "image",
        source_content_sha256: sha256FileHex(sourcePath),
        still_image: {
          normalization_producer: "ffmpeg-still-normalizer",
          normalization_producer_version: "1",
          normalized_frame_path: relative,
          normalized_frame_content_sha256: sha256FileHex(normalized),
        },
      });
    }
    return {
      asset_id: asset.id,
      source_locator: sourcePath,
      local_source_path: sourcePath,
      link_path: `02_media/${asset.id}.bin`,
      ...(asset.mediaKind ? { media_kind: asset.mediaKind } : {}),
      ...(asset.declared !== undefined ? { source_content_sha256: declaredValue } : {}),
    };
  });
  fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({ items: analysisItems }));
  fs.writeFileSync(path.join(projectDir, "02_media/source_map.json"), JSON.stringify({
    version: "1",
    project_id: "source-attestation",
    media_dir: "02_media",
    generated_at: "2026-07-20T00:00:00.000Z",
    items,
  }));
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  fs.writeFileSync(timelinePath, JSON.stringify(timeline ?? timelineWith({ video: ["A"] })));
  return { projectDir, paths, timelinePath };
}

function timelineWith(options: {
  video?: string[];
  audio?: string[];
  image?: string[];
  bgm?: string;
}): Record<string, unknown> {
  const video = [...(options.video ?? []), ...(options.image ?? [])].map((assetId, index) => ({
    clip_id: `V_${index}`,
    asset_id: assetId,
    ...(options.image?.includes(assetId) ? { media_kind: "image" } : {}),
  }));
  const audio = (options.audio ?? []).map((assetId, index) => ({
    clip_id: `A_${index}`,
    asset_id: assetId,
  }));
  return {
    version: "1",
    sequence: { fps_num: 30, fps_den: 1 },
    tracks: {
      video: [{ track_id: "V1", clips: video }],
      audio: [{ track_id: "A1", clips: audio }],
    },
    ...(options.bgm ? { audio_mix: { bgm_asset_id: options.bgm } } : {}),
  };
}

function writeArtifact(projectDir: string, relative = "05_timeline/assembly.mp4", bytes = "assembly"): string {
  const artifactPath = path.join(projectDir, relative);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, bytes);
  return artifactPath;
}

function replaceSameSizeAndMtime(filePath: string, bytes: string): void {
  const stat = fs.statSync(filePath);
  fs.writeFileSync(filePath, bytes);
  fs.utimesSync(filePath, stat.atime, stat.mtime);
}

function writeLegacyRenderReport(projectDir: string, artifactPath: string): void {
  const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
  fs.writeFileSync(path.join(path.dirname(artifactPath), "render-report.json"), JSON.stringify({
    timeline_hash: computeFileHash(timelinePath),
    video_hash: computeFileHash(artifactPath),
  }));
}

describe("canonical source-input attestation", () => {
  it("records marker-stripped derived stills with authoritative image kind", () => {
    const fixture = makeProject([{ id: "STILL", bytes: "still", mediaKind: "image", declared: true }], timelineWith({ video: ["STILL"] }));
    const sourceMapPath = path.join(fixture.projectDir, "02_media/source_map.json");
    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
    delete sourceMap.items[0].media_kind;
    fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap));
    const attestation = createSourceInputAttestation(fixture.projectDir);
    expect(attestation.source_inputs[0]).toMatchObject({
      media_kind: "image",
      identity_status: "verified",
      render_input_identity: { relationship: "normalized_still_frame" },
    });
  });

  it("fails closed for forged normalized identity and rejects every normalized-path symlink component", () => {
    const mutate = (change: (fixture: ReturnType<typeof makeProject>, asset: any) => void, reason: string) => {
      const fixture = makeProject([{ id: "STILL", bytes: "still", mediaKind: "image", declared: true }], timelineWith({ video: ["STILL"] }));
      const assetsPath = path.join(fixture.projectDir, "03_analysis/assets.json");
      const doc = JSON.parse(fs.readFileSync(assetsPath, "utf8"));
      change(fixture, doc.items[0]);
      fs.writeFileSync(assetsPath, JSON.stringify(doc));
      expect(() => createSourceInputAttestation(fixture.projectDir)).toThrow(reason);
    };
    mutate((_fixture, asset) => { asset.still_image.normalized_frame_path = "../escape.png"; }, "still_image_normalized_path_escape");
    mutate((_fixture, asset) => { asset.still_image.normalized_frame_content_sha256 = "0".repeat(64); }, "still_image_normalized_hash_mismatch");
    mutate((_fixture, asset) => { asset.still_image.normalization_producer_version = "forged"; }, "still_image_normalization_producer_mismatch");
    mutate((fixture, asset) => {
      fs.rmSync(path.join(fixture.projectDir, "03_analysis", asset.still_image.normalized_frame_path));
    }, "still_image_normalized_frame_missing");
    mutate((fixture, asset) => {
      const frame = path.join(fixture.projectDir, "03_analysis", asset.still_image.normalized_frame_path);
      fs.writeFileSync(frame, "");
    }, "still_image_normalized_frame_empty");

    const symlink = makeProject([{ id: "STILL", bytes: "still", mediaKind: "image", declared: true }], timelineWith({ video: ["STILL"] }));
    const stillDir = path.join(symlink.projectDir, "03_analysis/still_frames");
    const realDir = path.join(symlink.projectDir, "03_analysis/real_frames");
    fs.renameSync(stillDir, realDir);
    fs.symlinkSync(realDir, stillDir);
    expect(() => createSourceInputAttestation(symlink.projectDir)).toThrow("still_image_normalized_path_escape");

    const rootSymlink = makeProject([{ id: "STILL", bytes: "still", mediaKind: "image", declared: true }], timelineWith({ video: ["STILL"] }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-analysis-"));
    tempDirs.push(outside);
    fs.renameSync(path.join(rootSymlink.projectDir, "03_analysis"), path.join(outside, "analysis"));
    fs.symlinkSync(path.join(outside, "analysis"), path.join(rootSymlink.projectDir, "03_analysis"));
    expect(() => createSourceInputAttestation(rootSymlink.projectDir)).toThrow("still_image_normalized_path_escape");
  });

  it("ignores image caller overrides as render inputs while checking the original source", () => {
    const fixture = makeProject([{ id: "STILL", bytes: "still", mediaKind: "image", declared: true }], timelineWith({ video: ["STILL"] }));
    const override = path.join(fixture.projectDir, "forged.png");
    fs.writeFileSync(override, "caller-forgery");
    const attestation = createSourceInputAttestation(fixture.projectDir, { sourceOverrides: { STILL: override } });
    expect(attestation.source_inputs[0].render_input_identity).toMatchObject({ relationship: "normalized_still_frame" });
    fs.writeFileSync(fixture.paths.get("STILL")!, "changed-original");
    expect(() => createSourceInputAttestation(fixture.projectDir, { sourceOverrides: { STILL: override } }))
      .toThrow("still_image_original_hash_mismatch");
  });

  it("keeps a truthful legacy v1 video-only freshness receipt additive-compatible", () => {
    const fixture = makeProject([{ id: "VIDEO", bytes: "video", declared: true }], timelineWith({ video: ["VIDEO"] }));
    const artifact = writeArtifact(fixture.projectDir);
    writeRenderFreshnessMetadata(fixture.projectDir, artifact);
    const reportPath = path.join(path.dirname(artifact), "render-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    report.source_inputs_attestation.version = "source-input-attestation/v1";
    report.source_inputs_attestation.identity_model = "original_source_equals_render_input_v1";
    report.source_inputs_hash = createHash("sha256").update(JSON.stringify({
      version: "source-input-attestation/v1",
      usage_policy: report.source_inputs_attestation.usage_policy,
      source_inputs: report.source_inputs,
    })).digest("hex");
    fs.writeFileSync(reportPath, JSON.stringify(report));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact).status).toBe("fresh");
    report.source_inputs_hash = createSourceInputAttestation(fixture.projectDir).source_inputs_hash;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_attestation_invalid",
    });
  });

  it("is sorted, duplicate/order independent, covers video/audio/BGM/image/mixed, and persists no paths", () => {
    const fixture = makeProject([
      { id: "VIDEO", bytes: "video", declared: true },
      { id: "AUDIO", bytes: "audio", mediaKind: "audio", declared: true },
      { id: "BGM", bytes: "bgm", mediaKind: "audio" },
      { id: "STILL", bytes: "still", mediaKind: "image", declared: true },
      { id: "MIXED", bytes: "mixed", declared: true },
    ], timelineWith({
      video: ["MIXED", "VIDEO", "VIDEO"],
      audio: ["AUDIO", "MIXED"],
      image: ["STILL"],
      bgm: "BGM",
    }));
    const first = createSourceInputAttestation(fixture.projectDir);
    fs.writeFileSync(fixture.timelinePath, JSON.stringify(timelineWith({
      video: ["VIDEO", "MIXED"],
      audio: ["MIXED", "AUDIO", "AUDIO"],
      image: ["STILL"],
      bgm: "BGM",
    })));
    const second = createSourceInputAttestation(fixture.projectDir);

    expect(second.source_inputs_hash).toBe(first.source_inputs_hash);
    expect(second.source_inputs.map((entry) => entry.asset_id)).toEqual(["AUDIO", "BGM", "MIXED", "STILL", "VIDEO"]);
    expect(second.source_inputs.find((entry) => entry.asset_id === "MIXED")?.media_kind).toBe("mixed");
    expect(second.source_inputs.find((entry) => entry.asset_id === "STILL")?.media_kind).toBe("image");
    expect(second.status).toBe("live_only");
    expect(JSON.stringify(second)).not.toContain(fixture.projectDir);
  });

  it("fails before render for mismatched or invalid declared C1 identity, but permits absent legacy identity as live_only", () => {
    const mismatch = makeProject([{ id: "A", bytes: "old!", declared: true }]);
    fs.writeFileSync(mismatch.paths.get("A")!, "new!");
    expect(() => createSourceInputAttestation(mismatch.projectDir)).toThrow(/source_analysis_identity_mismatch/);

    const invalid = makeProject([{ id: "A", bytes: "data", declared: "not-a-sha" }]);
    expect(() => createSourceInputAttestation(invalid.projectDir)).toThrow(/source_analysis_identity_invalid/);

    const invalidNonString = makeProject([{ id: "A", bytes: "data", declared: null }]);
    expect(() => createSourceInputAttestation(invalidNonString.projectDir)).toThrow(/source_analysis_identity_invalid/);

    const legacy = makeProject([{ id: "A", bytes: "data" }]);
    expect(createSourceInputAttestation(legacy.projectDir)).toMatchObject({
      status: "live_only",
      warnings: ["ingest_identity_unproven:A"],
    });
  });

  it("fails closed for a missing map entry, missing source, or unreadable non-file source", () => {
    const missingMap = makeProject([], timelineWith({ video: ["A"] }));
    expect(() => createSourceInputAttestation(missingMap.projectDir)).toThrow(/source_map_entry_missing/);

    const missingSource = makeProject([{ id: "A", bytes: "data" }]);
    fs.unlinkSync(missingSource.paths.get("A")!);
    expect(() => createSourceInputAttestation(missingSource.projectDir)).toThrow(/source_missing/);

    const unreadable = makeProject([{ id: "A", bytes: "data" }]);
    fs.rmSync(unreadable.paths.get("A")!);
    fs.mkdirSync(unreadable.paths.get("A")!);
    expect(() => createSourceInputAttestation(unreadable.projectDir)).toThrow(/source_unreadable/);
  });

  it("marks same-path same-size same-mtime replacement stale, ignores unused assets, and becomes fresh after auto rerender", async () => {
    const fixture = makeProject([
      { id: "USED", bytes: "aaaa" },
      { id: "UNUSED", bytes: "1111" },
    ], timelineWith({ video: ["USED"] }));
    const artifact = writeArtifact(fixture.projectDir);
    const snapshot = createSourceInputAttestation(fixture.projectDir);
    writeRenderFreshnessMetadata(fixture.projectDir, artifact, { sourceInputsBefore: snapshot });

    replaceSameSizeAndMtime(fixture.paths.get("UNUSED")!, "2222");
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact).status).toBe("fresh");

    replaceSameSizeAndMtime(fixture.paths.get("USED")!, "bbbb");
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_hash_mismatch",
    });

    const result = await ensureFreshAssembly(fixture.projectDir, {
      assembleTimelineToMp4Impl: async ({ outputPath }) => {
        const resolvedOutput = outputPath!;
        fs.writeFileSync(resolvedOutput, "rerendered");
        return {
          outputPath: resolvedOutput,
          workingDir: path.join(fixture.projectDir, ".tmp"),
          timelineDurationFrames: 30,
          videoSegmentCount: 1,
          audioClipCount: 0,
        };
      },
    });
    expect(result.action).toBe("generated");
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact).status).toBe("fresh");
  });

  it("blocks stale visual QA and auto-renders before measuring", async () => {
    const fixture = makeProject([{ id: "A", bytes: "aaaa" }]);
    fs.mkdirSync(path.join(fixture.projectDir, "01_intent"), { recursive: true });
    fs.writeFileSync(path.join(fixture.projectDir, "01_intent/creative_brief.yaml"), "project_id: source-attestation\n");
    const video = writeArtifact(fixture.projectDir, "09_output/rough-cut.mp4");
    writeRenderFreshnessMetadata(fixture.projectDir, video, {
      sourceInputsBefore: createSourceInputAttestation(fixture.projectDir),
    });
    replaceSameSizeAndMtime(fixture.paths.get("A")!, "bbbb");
    await expect(evaluateReviewVisualQA(fixture.projectDir)).resolves.toMatchObject({
      status: "stale",
      reason: "source_inputs_hash_mismatch",
    });

    let rendered = 0;
    const report: MarlinQAReport = {
      version: "1",
      project_id: "source-attestation",
      video_path: video,
      video_duration_sec: 1,
      overall_assessment: "verified",
      scene_descriptions: [],
      issues: [],
      pacing_assessment: { too_fast: false, too_slow: false, notes: "ok" },
      emotion_arc_assessment: { follows_brief: true, notes: "ok" },
      score: 90,
      visual_qa: "verified",
    };
    const refreshed = await evaluateReviewVisualQA(fixture.projectDir, {
      render: true,
      assembleTimelineToMp4Impl: async ({ outputPath }) => {
        rendered += 1;
        const resolvedOutput = outputPath!;
        fs.writeFileSync(resolvedOutput, "rerendered");
        return {
          outputPath: resolvedOutput,
          workingDir: path.join(fixture.projectDir, ".tmp"),
          timelineDurationFrames: 30,
          videoSegmentCount: 1,
          audioClipCount: 0,
        };
      },
      runMarlinQAImpl: async () => report,
    });
    expect(rendered).toBe(1);
    expect(refreshed.status).toBe("verified");
    expect(refreshed.source_inputs_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects source replacement during render and does not write fresh metadata", () => {
    const fixture = makeProject([{ id: "A", bytes: "aaaa" }]);
    const before = createSourceInputAttestation(fixture.projectDir);
    const artifact = writeArtifact(fixture.projectDir);
    replaceSameSizeAndMtime(fixture.paths.get("A")!, "bbbb");
    expect(() => writeRenderFreshnessMetadata(fixture.projectDir, artifact, {
      sourceInputsBefore: before,
    })).toThrow(/source_changed_during_render/);
    expect(fs.existsSync(path.join(fixture.projectDir, "05_timeline/render-report.json"))).toBe(false);
  });

  it("detects timeline replacement during render before stamping metadata", () => {
    const fixture = makeProject([{ id: "A", bytes: "aaaa" }]);
    const before = createSourceInputAttestation(fixture.projectDir);
    const artifact = writeArtifact(fixture.projectDir);
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf-8"));
    timeline.metadata = { changed_during_render: true };
    fs.writeFileSync(fixture.timelinePath, JSON.stringify(timeline));

    expect(() => writeRenderFreshnessMetadata(fixture.projectDir, artifact, {
      sourceInputsBefore: before,
    })).toThrow(/timeline_changed_during_render/);
    expect(fs.existsSync(path.join(fixture.projectDir, "05_timeline/render-report.json"))).toBe(false);
  });

  it("treats legacy render metadata as unverifiable for source timelines, while source-zero is N/A", () => {
    const fixture = makeProject([{ id: "A", bytes: "data" }]);
    const artifact = writeArtifact(fixture.projectDir);
    writeLegacyRenderReport(fixture.projectDir, artifact);
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_unverifiable",
    });

    fs.writeFileSync(fixture.timelinePath, JSON.stringify(timelineWith({})));
    writeLegacyRenderReport(fixture.projectDir, artifact);
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "fresh",
      sourceInputsStatus: "not_applicable",
    });
  });

  it("validates v1 metadata structure, entries, and bounded warnings as truthful evidence", () => {
    const fixture = makeProject([{ id: "A", bytes: "data" }]);
    const artifact = writeArtifact(fixture.projectDir);
    writeRenderFreshnessMetadata(fixture.projectDir, artifact, {
      sourceInputsBefore: createSourceInputAttestation(fixture.projectDir),
    });
    const reportPath = path.join(fixture.projectDir, "05_timeline/render-report.json");
    const original = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as Record<string, any>;
    const mutations: Array<[string, (value: Record<string, any>) => void, string]> = [
      ["missing contract", (value) => delete value.source_inputs_attestation, "source_inputs_attestation_invalid"],
      ["unknown version", (value) => { value.source_inputs_attestation.version = "source-input-attestation/v999"; }, "source_inputs_attestation_unsupported"],
      ["wrong status", (value) => { value.source_inputs_attestation.status = "verified"; }, "source_inputs_attestation_invalid"],
      ["wrong count", (value) => { value.source_inputs_attestation.source_input_count = 2; }, "source_inputs_attestation_invalid"],
      ["tampered entry", (value) => { value.source_inputs[0].content_sha256 = "0".repeat(64); }, "source_inputs_attestation_invalid"],
      ["tampered warning", (value) => { value.source_inputs_attestation.warnings = []; }, "source_inputs_attestation_invalid"],
    ];
    for (const [, mutate, reason] of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      fs.writeFileSync(reportPath, JSON.stringify(changed));
      expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({ status: "stale", reason });
    }

    const missingPolicy = structuredClone(original);
    delete missingPolicy.source_inputs_attestation.usage_policy;
    fs.writeFileSync(reportPath, JSON.stringify(missingPolicy));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_attestation_invalid",
    });

    const unknownPolicy = structuredClone(original);
    unknownPolicy.source_inputs_attestation.usage_policy = { include_video: true, include_audio: "sometimes" };
    fs.writeFileSync(reportPath, JSON.stringify(unknownPolicy));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_attestation_invalid",
    });

    const mismatchedPolicy = structuredClone(original);
    mismatchedPolicy.source_inputs_attestation.usage_policy = { include_video: false, include_audio: true };
    fs.writeFileSync(reportPath, JSON.stringify(mismatchedPolicy));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_attestation_invalid",
    });
  });

  it("bounds live_only warnings and validates a truncated canonical prefix", () => {
    const assets = Array.from({ length: MAX_PERSISTED_SOURCE_INPUTS + 1 }, (_, index) => ({
      id: `A_${String(index).padStart(3, "0")}`,
      bytes: String(index),
    }));
    const fixture = makeProject(assets, timelineWith({ video: assets.map((asset) => asset.id).reverse() }));
    const attestation = createSourceInputAttestation(fixture.projectDir);
    expect(attestation.source_inputs).toHaveLength(MAX_PERSISTED_SOURCE_INPUTS);
    expect(attestation.warnings).toHaveLength(MAX_SOURCE_INPUT_WARNINGS);
    expect(attestation.warning_count).toBe(assets.length);
    expect(attestation.warnings_suppressed).toBe(assets.length - MAX_SOURCE_INPUT_WARNINGS);
    expect(attestation.source_inputs[0].asset_id).toBe("A_000");

    const artifact = writeArtifact(fixture.projectDir);
    writeRenderFreshnessMetadata(fixture.projectDir, artifact, { sourceInputsBefore: attestation });
    const reportPath = path.join(fixture.projectDir, "05_timeline/render-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    report.source_inputs[MAX_PERSISTED_SOURCE_INPUTS - 1].asset_id = "tampered-prefix";
    fs.writeFileSync(reportPath, JSON.stringify(report));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact)).toMatchObject({
      status: "stale",
      reason: "source_inputs_attestation_invalid",
    });
  });

  it("uses an explicit persisted no-audio policy so unused audio/BGM replacements do not stale the output", () => {
    const fixture = makeProject([
      { id: "VIDEO", bytes: "video" },
      { id: "AUDIO", bytes: "audio" },
      { id: "BGM", bytes: "bgm!!" },
    ], timelineWith({ video: ["VIDEO"], audio: ["AUDIO"], bgm: "BGM" }));
    const artifact = writeArtifact(fixture.projectDir);
    const before = createSourceInputAttestation(fixture.projectDir, { includeAudio: false });
    writeRenderFreshnessMetadata(fixture.projectDir, artifact, { sourceInputsBefore: before });
    replaceSameSizeAndMtime(fixture.paths.get("AUDIO")!, "other");
    replaceSameSizeAndMtime(fixture.paths.get("BGM")!, "music!");
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact).status).toBe("fresh");

    const report = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, "05_timeline/render-report.json"), "utf-8"));
    expect(report.source_inputs_attestation.usage_policy).toEqual({ include_video: true, include_audio: false });
    expect(report.source_inputs_hash).toBe(before.source_inputs_hash);
    delete report.source_inputs_attestation.usage_policy;
    fs.writeFileSync(path.join(fixture.projectDir, "05_timeline/render-report.json"), JSON.stringify(report));
    expect(assessRenderArtifactFreshness(fixture.projectDir, artifact).status).toBe("stale");
  });

  it("allows byte-identical/symlink renderer overrides but rejects derived bytes even on legacy maps", () => {
    const fixture = makeProject([{ id: "A", bytes: "data" }]);
    const symlink = path.join(fixture.projectDir, "02_media/A-link.bin");
    fs.symlinkSync(fixture.paths.get("A")!, symlink);
    expect(createSourceInputAttestation(fixture.projectDir, {
      sourceOverrides: { A: symlink },
    }).source_inputs[0].render_input_identity).toMatchObject({ relationship: "same_as_original" });

    const derived = path.join(fixture.projectDir, "02_media/A-derived.bin");
    fs.writeFileSync(derived, "DATA");
    expect(() => createSourceInputAttestation(fixture.projectDir, {
      sourceOverrides: { A: derived },
    })).toThrow(/render_input_identity_mismatch/);
  });

  it("does not turn absolute or traversal asset filenames into legacy 00_sources attestations", () => {
    for (const variant of ["traversal", "absolute"] as const) {
      const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), "vos-legacy-source-escape-"));
      tempDirs.push(wrapper);
      const projectDir = path.join(wrapper, "project");
      const outside = variant === "traversal"
        ? path.join(projectDir, "outside.mov")
        : path.join(wrapper, "outside.mov");
      const filename = variant === "traversal" ? "../outside.mov" : outside;
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, "external-video");
      fs.mkdirSync(path.join(projectDir, "03_analysis"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "03_analysis/assets.json"), JSON.stringify({
        items: [{ asset_id: "A", filename, media_kind: "video" }],
      }));
      fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify(
        timelineWith({ video: ["A"] }),
      ));
      expect(() => createSourceInputAttestation(projectDir)).toThrow(/source_map_entry_missing/);
    }
  });

  it("rejects --reuse-video without canonical freshness metadata before invoking ffmpeg", async () => {
    const fixture = makeProject([{ id: "A", bytes: "data" }], {
      ...timelineWith({ video: ["A"] }),
      tracks: {
        video: [{ track_id: "V1", clips: [{
          clip_id: "V1",
          asset_id: "A",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 30,
        }] }],
        audio: [],
      },
    });
    const reusePath = writeArtifact(fixture.projectDir, "05_timeline/reuse.mp4", "unverified");
    await expect(renderRoughCut({
      projectPath: fixture.projectDir,
      reuseVideoPath: reusePath,
      noAudio: true,
    })).rejects.toThrow(/lacks fresh canonical source identity metadata/);
  });
});
