import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { runPipeline, SourceReadinessError } from "../runtime/pipeline/ingest.js";
import { buildFootageDb } from "../runtime/artifacts/footage-db-builder.js";
import { runAnalyze } from "../runtime/commands/analyze.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import { sha256FileHex, SourceContentIdentityCache } from "../runtime/source-content-identity.js";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3") as new (filePath: string) => {
  prepare(sql: string): { pluck(): { all(): string[] } };
  close(): void;
};
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;
const tempDirs: string[] = [];
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-ledger-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function createRealMediaFixtures(dir: string): { video: string; corrupt: string; wav: string; png: string; unknown: string; alias: string } {
  const video = path.join(dir, "short.mp4");
  const wav = path.join(dir, "tone.wav");
  const png = path.join(dir, "still.png");
  const corrupt = path.join(dir, "corrupt.mp4");
  const unknown = path.join(dir, "notes.bin");
  const alias = path.join(dir, "short-alias.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", wav]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", png]);
  fs.writeFileSync(corrupt, "not a video");
  fs.writeFileSync(unknown, "unknown");
  fs.symlinkSync(video, alias);
  return { video, corrupt, wav, png, unknown, alias };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function validateSchema(schemaName: string, value: unknown): { valid: boolean; errors?: unknown[] | null } {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = readJson<object>(path.join(REPO_ROOT, "schemas", schemaName));
  const validate = ajv.compile(schema);
  return { valid: validate(value), errors: validate.errors };
}

describe("pipeline canonical source ledger", () => {
  it("probes a canonical alias once and preserves mixed ready, unsupported, and corrupt dispositions with one identity", async () => {
    const sourceDir = tempDir("mixed-source");
    const projectDir = tempDir("mixed-project");
    const media = createRealMediaFixtures(sourceDir);
    let hashCalls = 0;
    const hashHex = (filePath: string): string => {
      hashCalls += 1;
      return sha256FileHex(filePath);
    };
    const requested = [media.video, media.alias, media.corrupt, media.wav, media.png, media.unknown];
    const sourceDiscovery = discoverRequestedSources(requested, {
      hashFile: (filePath) => `sha256:${hashHex(filePath)}`,
    });
    const result = await runPipeline({
      sourceFiles: requested,
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
      sourceDiscovery,
      sourceIdentityCache: new SourceContentIdentityCache(hashHex),
    });

    expect(hashCalls).toBe(5);
    expect(result.assetsJson.items).toHaveLength(3);
    expect(result.sourceLedger?.summary).toEqual({ requested: 6, ready: 4, unsupported: 1, failed: 1 });
    const readyLedger = result.sourceLedger!.items.filter((item) => item.status === "ready");
    expect(new Set(readyLedger.map((item) => item.canonical_asset_id)).size).toBe(3);
    expect(new Set(readyLedger.map((item) => item.fingerprint)).size).toBe(3);
    const videoAsset = result.assetsJson.items.find((item) => item.media_kind === "video")!;
    const audioAsset = result.assetsJson.items.find((item) => item.media_kind === "audio")!;
    const imageAsset = result.assetsJson.items.find((item) => item.media_kind === "image")!;
    expect(result.sourceMediaManifest?.items).toHaveLength(6);
    const readyManifest = result.sourceMediaManifest!.items.filter((item) => item.ingest_status === "ready");
    expect(readyManifest).toHaveLength(4);
    for (const item of readyManifest) {
      const asset = result.assetsJson.items.find((candidate) => candidate.asset_id === item.asset_id)!;
      expect(item.fingerprint).toBe(asset.source_fingerprint);
      expect(item.duration_us).toBe(asset.duration_us);
      expect(item.sample_rate).toBe(asset.audio_stream?.sample_rate ?? null);
      expect(item.frame_rate_mode).toBe(asset.frame_rate_mode);
      expect(item.rotation).toBe(asset.rotation);
    }
    for (const item of result.sourceMediaManifest!.items.filter((entry) => entry.ingest_status !== "ready")) {
      expect(item.asset_id).toBeNull();
      expect(item.sample_rate).toBeNull();
      expect(item.duration_us).toBeNull();
      expect(item.rotation).toBeNull();
      expect(item.frame_rate_mode).toBe("unknown");
    }
    const sourceMap = readJson<{ items: Array<{ asset_id: string }> }>(path.join(projectDir, "02_media/source_map.json"));
    expect(new Set(sourceMap.items.map((item) => item.asset_id))).toEqual(new Set([videoAsset.asset_id, audioAsset.asset_id, imageAsset.asset_id]));
    expect(result.gapReport.entries.filter((entry) => entry.source_id)).toHaveLength(2);
    expect(result.analysisCoverageReport?.summary.source_counts).toEqual(result.sourceLedger?.summary);
    expect(validateSchema("source-ledger.schema.json", result.sourceLedger).valid).toBe(true);
    expect(validateSchema("source-media-manifest.schema.json", result.sourceMediaManifest).valid).toBe(true);
    expect(validateSchema("analysis-coverage-report.schema.json", result.analysisCoverageReport).valid).toBe(true);
    const persistedSourceArtifacts = [
      fs.readFileSync(path.join(projectDir, "03_analysis/source_ledger.json"), "utf-8"),
      fs.readFileSync(path.join(projectDir, "02_media/source_media_manifest.json"), "utf-8"),
    ].join("\n");
    expect(persistedSourceArtifacts).not.toContain(sourceDir);
    expect(persistedSourceArtifacts).not.toContain(projectDir);

    const dbResult = await buildFootageDb({ projectDir, embeddingPolicy: "skip", qwen3vlEnabled: false, clapAudioEnabled: false });
    const db = new Database(dbResult.db_path);
    try {
      expect(db.prepare("SELECT asset_id FROM assets ORDER BY asset_id").pluck().all()).toEqual(
        [audioAsset.asset_id, imageAsset.asset_id, videoAsset.asset_id].sort(),
      );
    } finally {
      db.close();
    }
  }, 120_000);

  it("keeps valid audio analysis-ready while accounting for a missing audio request as failed", async () => {
    const sourceDir = tempDir("blocked-source");
    const projectDir = tempDir("blocked-project");
    const wav = path.join(sourceDir, "audio.wav");
    const missing = path.join(sourceDir, "missing.mp3");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", wav]);
    const result = await runPipeline({
      sourceFiles: [wav, missing],
      projectDir,
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipAppraiser: true,
    });
    const ledger = readJson<{ summary: { requested: number; ready: number; unsupported: number; failed: number } }>(path.join(projectDir, "03_analysis/source_ledger.json"));
    expect(ledger.summary).toEqual({ requested: 2, ready: 1, unsupported: 0, failed: 1 });
    expect(result.assetsJson.items).toHaveLength(1);
    expect(result.segmentsJson.items.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/analysis_coverage_report.json"))).toBe(true);
    const manifest = readJson<{ items: Array<{ source_locator: string; size_bytes: number | null; mtime: string | null }> }>(path.join(projectDir, "02_media/source_media_manifest.json"));
    expect(manifest.items.find((item) => item.source_locator.endsWith("missing.mp3"))).toMatchObject({
      size_bytes: null,
      mtime: null,
    });
    const gaps = parseYaml(fs.readFileSync(path.join(projectDir, "03_analysis/gap_report.yaml"), "utf-8")) as { entries: Array<{ blocking: boolean }> };
    expect(gaps.entries).toHaveLength(1);
    expect(gaps.entries.every((entry) => entry.blocking)).toBe(true);
  }, 30_000);

  it("accounts corrupt audio as failed at ingest, continues with ready audio, and hard-gates corrupt-only requests", async () => {
    const sourceDir = tempDir("corrupt-audio-source");
    const mixedProject = tempDir("corrupt-audio-mixed-project");
    const blockedProject = tempDir("corrupt-audio-blocked-project");
    const ready = path.join(sourceDir, "ready.wav");
    const corrupt = path.join(sourceDir, "corrupt.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", ready]);
    fs.writeFileSync(corrupt, "not an audio stream");
    const options = {
      repoRoot: REPO_ROOT,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipBgmAnalysis: true,
    };

    const mixed = await runPipeline({ ...options, sourceFiles: [ready, corrupt], projectDir: mixedProject });
    expect(mixed.sourceLedger?.summary).toEqual({ requested: 2, ready: 1, unsupported: 0, failed: 1 });
    expect(mixed.sourceLedger?.items.find((item) => item.status === "failed")).toMatchObject({ media_kind: "audio", stage: "ingest" });
    expect(mixed.gapReport.entries.find((entry) => entry.source_id)).toMatchObject({ blocking: true, severity: "error" });

    await expect(runPipeline({ ...options, sourceFiles: [corrupt], projectDir: blockedProject }))
      .rejects.toBeInstanceOf(SourceReadinessError);
    const blockedLedger = readJson<{ summary: unknown; items: Array<{ media_kind: string; status: string; stage: string }> }>(path.join(blockedProject, "03_analysis/source_ledger.json"));
    expect(blockedLedger.summary).toEqual({ requested: 1, ready: 0, unsupported: 0, failed: 1 });
    expect(blockedLedger.items[0]).toMatchObject({ media_kind: "audio", status: "failed", stage: "ingest" });
    const blockedGaps = parseYaml(fs.readFileSync(path.join(blockedProject, "03_analysis/gap_report.yaml"), "utf-8")) as { entries: Array<{ blocking: boolean }> };
    expect(blockedGaps.entries).toHaveLength(1);
    expect(blockedGaps.entries[0].blocking).toBe(true);
  }, 30_000);

  it("returns the current-run source artifacts on a second cached runAnalyze with a non-directory project id", async () => {
    const sourceDir = tempDir("cached-command-source");
    const projectDir = fs.mkdtempSync(path.join(REPO_ROOT, "test-fixtures-ledger-cache-"));
    tempDirs.push(projectDir);
    const media = createRealMediaFixtures(sourceDir);
    fs.writeFileSync(
      path.join(projectDir, "project_state.yaml"),
      "version: 1\nproject_id: canonical-project-id\ncurrent_state: initialized\nhistory: []\n",
    );
    const options = {
      sourceFiles: [media.video],
      skipPreflight: true,
      skipStt: true,
      skipVlm: true,
      skipPeak: true,
      skipMarlin: true,
      skipAppraiser: true,
      skipMediaLink: true,
      skipBgmAnalysis: true,
    };

    const first = await runAnalyze(projectDir, options);
    expect(first.success, JSON.stringify(first.error)).toBe(true);
    const firstLedger = readJson<{ project_id: string; items: Array<{ source_id: string; canonical_asset_id: string }> }>(path.join(projectDir, "03_analysis/source_ledger.json"));
    const firstManifest = readJson<{ project_id: string; items: Array<{ source_id: string; asset_id: string }> }>(path.join(projectDir, "02_media/source_media_manifest.json"));
    const firstCoverage = readJson<{ project_id: string; summary: { source_counts: unknown } }>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const second = await runAnalyze(projectDir, options);
      expect(second.success).toBe(true);
      expect(log.mock.calls.some(([message]) => String(message).includes("[cache hit]"))).toBe(true);
    } finally {
      log.mockRestore();
    }

    const secondLedger = readJson<typeof firstLedger>(path.join(projectDir, "03_analysis/source_ledger.json"));
    const secondManifest = readJson<typeof firstManifest>(path.join(projectDir, "02_media/source_media_manifest.json"));
    const secondCoverage = readJson<typeof firstCoverage>(path.join(projectDir, "03_analysis/analysis_coverage_report.json"));
    expect(secondLedger.project_id).toBe("canonical-project-id");
    expect(secondManifest.project_id).toBe("canonical-project-id");
    expect(secondCoverage.project_id).toBe("canonical-project-id");
    expect(secondLedger.items.map((item) => [item.source_id, item.canonical_asset_id]))
      .toEqual(firstLedger.items.map((item) => [item.source_id, item.canonical_asset_id]));
    expect(secondManifest.items.map((item) => [item.source_id, item.asset_id]))
      .toEqual(firstManifest.items.map((item) => [item.source_id, item.asset_id]));
    expect(secondCoverage.summary.source_counts).toEqual(firstCoverage.summary.source_counts);
  }, 120_000);

  it("returns the same structured source-readiness gate with and without preflight", async () => {
    const sourceDir = tempDir("readiness-command-source");
    const audio = path.join(sourceDir, "voice.wav");
    const missing = path.join(sourceDir, "missing.mp4");
    fs.writeFileSync(audio, "unsupported audio");
    const summaries: unknown[] = [];

    for (const skipPreflight of [false, true]) {
      const projectDir = fs.mkdtempSync(path.join(REPO_ROOT, `test-fixtures-readiness-${skipPreflight}-`));
      tempDirs.push(projectDir);
      fs.writeFileSync(
        path.join(projectDir, "project_state.yaml"),
        `version: 1\nproject_id: readiness-${skipPreflight}\ncurrent_state: initialized\nhistory: []\n`,
      );
      const result = await runAnalyze(projectDir, {
        sourceFiles: [audio, missing],
        skipPreflight,
        skipStt: true,
        skipVlm: true,
        skipPeak: true,
        skipMarlin: true,
        skipAppraiser: true,
        skipMediaLink: true,
        skipBgmAnalysis: true,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("GATE_CHECK_FAILED");
      const details = result.error?.details as { source_readiness: { summary: unknown; items: Array<{ status: string }> } };
      expect(details.source_readiness.items.map((item) => item.status).sort()).toEqual(["failed", "failed"]);
      summaries.push(details.source_readiness.summary);
    }

    expect(summaries).toEqual([
      { requested: 2, ready: 0, unsupported: 0, failed: 2 },
      { requested: 2, ready: 0, unsupported: 0, failed: 2 },
    ]);
  }, 30_000);

  it("persists empty canonical artifacts before returning the explicit empty-input gate failure", async () => {
    const projectDir = tempDir("empty-command");
    fs.mkdirSync(path.join(projectDir, "00_project"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "00_project/project_state.yaml"), "version: 1\nproject_id: empty-command\ncurrent_state: initialized\nhistory: []\n");
    const result = await runAnalyze(projectDir, { sourceFiles: [], skipPreflight: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("GATE_CHECK_FAILED");
    expect(readJson<{ summary: { requested: number } }>(path.join(projectDir, "03_analysis/source_ledger.json")).summary.requested).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "02_media/source_media_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "03_analysis/gap_report.yaml"))).toBe(true);
  });
});
