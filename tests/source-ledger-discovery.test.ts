import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  allRegisteredExtensions,
  classifyMediaKind,
  MEDIA_KIND_REGISTRY,
} from "../runtime/media/media-kind-registry.js";
import {
  DIRECTORY_SCAN_HIDDEN_POLICY,
  discoverRequestedSources,
} from "../runtime/media/source-discovery.js";
import {
  buildSourceLedger,
  validateSourceLedgerArtifact,
} from "../runtime/artifacts/source-ledger.js";
import {
  buildAnalysisCoverageReport,
  buildSourceMediaManifest,
  type SourceMediaManifest,
} from "../runtime/artifacts/p1-manifest-coverage.js";
import { sha256FileUri } from "../runtime/source-content-identity.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-${name}-`));
  tempDirs.push(dir);
  return dir;
}

describe("media-kind registry", () => {
  it("owns the legacy video union plus explicit audio and image classification exactly once", () => {
    const expectedVideo = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".mts", ".m2ts", ".ts", ".mxf", ".flv", ".wmv", ".mpg", ".mpeg", ".m4v", ".3gp"];
    expect(new Set(MEDIA_KIND_REGISTRY.video.extensions)).toEqual(new Set(expectedVideo));
    expect(classifyMediaKind("VOICE.WAV").kind).toBe("audio");
    expect(classifyMediaKind("voice.MP3").kind).toBe("audio");
    expect(classifyMediaKind("voice.m4A").kind).toBe("audio");
    expect(classifyMediaKind("voice.AAC").kind).toBe("audio");
    expect(classifyMediaKind("STILL.JPEG").kind).toBe("image");
    expect(classifyMediaKind("still.HeIc").kind).toBe("image");
    const extensions = allRegisteredExtensions();
    expect(new Set(extensions).size).toBe(extensions.length);
    expect(MEDIA_KIND_REGISTRY.sequence.capabilities).toEqual({
      discovery: true, ingest: true, segment: true, analyze: true,
      plan: true, compile: true, render: true,
    });
    expect(MEDIA_KIND_REGISTRY.sequence.consumerImpact).toBe("none");
    expect(MEDIA_KIND_REGISTRY.sequence.unsupportedReason).toBeNull();
    expect(MEDIA_KIND_REGISTRY.audio.capabilities).toMatchObject({
      ingest: true, segment: true, analyze: true, plan: true, compile: true, render: true,
    });
    expect(MEDIA_KIND_REGISTRY.audio.consumerImpact).toBe("none");
    expect(MEDIA_KIND_REGISTRY.audio.unsupportedReason).toBeNull();
  });

  it("keeps ready audio sources free of package-block coverage warnings", () => {
    const manifest: SourceMediaManifest = {
      version: "1.0.0",
      project_id: "audio-coverage",
      artifact_version: "manifest-v1",
      created_at: "2026-07-20T00:00:00.000Z",
      source_root: { locator: "00_sources", locator_kind: "local_path" },
      items: [{
        asset_id: "AST_AUDIO",
        source_id: "SRC_AUDIO",
        source_locator: "00_sources/voice.wav",
        filename: "voice.wav",
        content_hash: `sha256:${"1".repeat(64)}`,
        fingerprint: `sha256:${"2".repeat(64)}`,
        size_bytes: 1,
        mtime: "2026-07-20T00:00:00.000Z",
        media_kind: "audio",
        ingest_status: "ready",
        reason: null,
        consumer_impact: MEDIA_KIND_REGISTRY.audio.consumerImpact,
        rights_status: "unknown",
        privacy_status: "unknown",
        analysis_policy_ref: "APOL_default",
        capture_started_at: null,
        capture_timezone: null,
        timecode_start: null,
        timecode_format: "none",
        sample_rate: 48_000,
        duration_us: 2_000_000,
        frame_rate_mode: "audio_only",
        rotation: null,
        audio_video_offset_ms: null,
        clock_source: "file_metadata",
      }],
      provenance: {
        producer: "analysis-ingest",
        inputs: [{ path: "00_sources", hash: `sha256:${"3".repeat(64)}` }],
        hash_policy: {
          algorithm: "sha256",
          canonicalization: "normalized-json-v1",
          excluded_fields: ["created_at"],
        },
      },
    };
    const coverage = buildAnalysisCoverageReport({ projectId: "audio-coverage", manifest });
    expect(coverage.lanes.find((lane) => lane.lane_id === "source_manifest")).toMatchObject({
      status: "ready",
      consumer_impact: "none",
    });
    expect(coverage.blockers.some((blocker) => blocker.message.includes("package-blocked"))).toBe(false);
  });

  it("leaves executor, preflight, manifest, and ingest routing free of private extension owners", () => {
    const files = [
      "runtime/pipeline/executor.ts",
      "runtime/preflight.ts",
      "runtime/artifacts/p1-manifest-coverage.ts",
      "runtime/pipeline/stages/ingest-map.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(file), "utf-8");
      expect(source).not.toMatch(/VIDEO_EXTENSIONS|MEDIA_EXTENSIONS/);
      expect(source).not.toMatch(/\\\.\(mp4\|mov/);
    }
  });
});

describe("deterministic recursive source discovery", () => {
  it("preserves nested case-insensitive kinds, same basenames, unknown, missing, broken links, aliases, and scan escapes", () => {
    const base = tempDir("discovery");
    const root = path.join(base, "root");
    const outside = path.join(base, "outside.mp4");
    fs.mkdirSync(path.join(root, "nested", "a"), { recursive: true });
    fs.mkdirSync(path.join(root, "nested", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "nested", "a", "CLIP.MP4"), "video-a");
    fs.writeFileSync(path.join(root, "nested", "b", "CLIP.MP4"), "video-b");
    fs.writeFileSync(path.join(root, "notes.weird"), "unknown");
    fs.writeFileSync(path.join(root, ".hidden.mp4"), "sidecar");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(path.join("nested", "a", "CLIP.MP4"), path.join(root, "alias.mp4"));
    fs.symlinkSync(outside, path.join(root, "escape.mp4"));
    fs.symlinkSync(path.join(root, "missing-target.mp4"), path.join(root, "broken.mp4"));

    const missing = path.join(root, "explicit-missing.MOV");
    const one = discoverRequestedSources([root, missing]);
    const two = discoverRequestedSources([root, missing]);
    expect(one).toEqual(two);
    expect(one.hidden_policy).toBe(DIRECTORY_SCAN_HIDDEN_POLICY);
    expect(one.requests.some((request) => request.requested_locator.includes(".hidden.mp4"))).toBe(false);
    expect(one.requests.filter((request) => path.basename(request.lexical_path) === "CLIP.MP4")).toHaveLength(2);
    expect(one.requests.find((request) => request.lexical_path.endsWith("notes.weird"))?.media_kind).toBe("unknown");
    expect(one.requests.find((request) => request.lexical_path.endsWith("notes.weird"))?.disposition).toBe("unsupported");
    expect(one.requests.find((request) => request.lexical_path.endsWith("escape.mp4"))?.reason).toBe("source_path_escapes_requested_root");
    expect(one.requests.find((request) => request.lexical_path.endsWith("broken.mp4"))?.disposition).toBe("failed");
    expect(one.requests.find((request) => request.lexical_path === missing)?.disposition).toBe("failed");
    const alias = one.requests.find((request) => request.lexical_path.endsWith("alias.mp4"));
    const target = one.requests.find((request) => request.lexical_path.endsWith(path.join("nested", "a", "CLIP.MP4")));
    expect(alias?.canonical_path).toBe(target?.canonical_path);
    expect([alias?.canonical_request_source_id, target?.canonical_request_source_id].filter(Boolean)).toHaveLength(1);
  });

  it("allows an explicit file symlink only when its real target remains in the explicit parent", () => {
    const base = tempDir("explicit-symlink");
    const inside = path.join(base, "inside.mp4");
    const alias = path.join(base, "alias.mp4");
    const outsideDir = tempDir("explicit-outside");
    const outside = path.join(outsideDir, "outside.mp4");
    fs.writeFileSync(inside, "inside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(inside, alias);
    const safe = discoverRequestedSources([alias]);
    expect(safe.requests[0].disposition).toBe("candidate");
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    const escaped = discoverRequestedSources([alias]);
    expect(escaped.requests[0].reason).toBe("source_path_escapes_requested_root");
  });

  it("treats an explicitly requested directory symlink as the authorized scan root but still rejects nested escapes", () => {
    const base = tempDir("directory-symlink");
    const target = tempDir("directory-target");
    const unrelated = tempDir("directory-unrelated");
    fs.writeFileSync(path.join(target, "clip.mp4"), "video");
    fs.writeFileSync(path.join(unrelated, "escape.mp4"), "escape");
    fs.symlinkSync(path.join(unrelated, "escape.mp4"), path.join(target, "nested-escape.mp4"));
    const link = path.join(base, "source");
    fs.symlinkSync(target, link);

    const discovery = discoverRequestedSources([link]);
    expect(discovery.requests.find((request) => request.lexical_path.endsWith("clip.mp4"))?.disposition).toBe("candidate");
    expect(discovery.requests.find((request) => request.lexical_path.endsWith("nested-escape.mp4"))?.reason).toBe("source_path_escapes_requested_root");
  });

  it("uses the shared chunked hash primitive deterministically without whole-file reads", () => {
    const base = tempDir("hash");
    const file = path.join(base, "large.mp4");
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, Buffer.alloc(5 * 1024 * 1024, 7));
    fs.closeSync(fd);
    const discovery = discoverRequestedSources([file]);
    expect(discovery.requests[0].content_hash).toBe(sha256FileUri(file));
    const source = fs.readFileSync(path.resolve("runtime/media/source-discovery.ts"), "utf-8");
    expect(source).not.toContain("fs.readFileSync(filePath)");
  });

  it("records a hash read race as a discovery failure and continues other requested inputs", () => {
    const base = tempDir("hash-failure");
    const bad = path.join(base, "bad.mp4");
    const good = path.join(base, "good.mp4");
    fs.writeFileSync(bad, "bad");
    fs.writeFileSync(good, "good");

    const discovery = discoverRequestedSources([bad, good], {
      hashFile(filePath) {
        if (path.basename(filePath) === path.basename(bad)) throw new Error("simulated read race");
        return sha256FileUri(filePath);
      },
    });

    expect(discovery.requests.find((request) => request.lexical_path === bad)).toMatchObject({
      disposition: "failed",
      stage: "discovery",
      content_hash: null,
    });
    expect(discovery.requests.find((request) => request.lexical_path === bad)?.reason).toContain("content_hash_failed:");
    expect(discovery.requests.find((request) => request.lexical_path === good)?.disposition).toBe("candidate");
  });

  it("records an unreadable nested directory without aborting readable siblings", () => {
    const root = tempDir("directory-read-failure");
    const blocked = path.join(root, "blocked");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "hidden-by-error.mp4"), "video");
    fs.writeFileSync(path.join(root, "good.mp4"), "video");

    const discovery = discoverRequestedSources([root], {
      readDirectory(dirPath) {
        if (dirPath === blocked) throw new Error("simulated EACCES");
        return fs.readdirSync(dirPath, { withFileTypes: true });
      },
    });

    expect(discovery.requests.find((request) => request.lexical_path === blocked)).toMatchObject({
      disposition: "failed",
      stage: "discovery",
    });
    expect(discovery.requests.find((request) => request.lexical_path === blocked)?.reason).toContain("directory_read_failed:");
    expect(discovery.requests.find((request) => request.lexical_path.endsWith("good.mp4"))?.disposition).toBe("candidate");
  });

  it("retains an external locator verbatim instead of resolving it as a local path", () => {
    const discovery = discoverRequestedSources(["external://camera-roll/clip.mp4"]);
    expect(discovery.requests[0]).toMatchObject({
      requested_locator: "external://camera-roll/clip.mp4",
      lexical_path: "external://camera-roll/clip.mp4",
      canonical_path: null,
      disposition: "failed",
      reason: "external_locator_not_materialized",
    });
  });
});

describe("source ledger invariant and redaction", () => {
  it("redacts absolute and ../../ external requested locators from artifact fields", () => {
    const projectDir = tempDir("project");
    const outsideDir = tempDir("private-home-like");
    const outside = path.join(outsideDir, "private.mp4");
    fs.writeFileSync(outside, "video");
    const relativeEscape = path.relative(projectDir, outside);
    const discovery = discoverRequestedSources([path.resolve(projectDir, relativeEscape)]);
    const ledger = buildSourceLedger("redacted", discovery, new Map(), "2026-07-20T00:00:00.000Z", projectDir);
    const serialized = JSON.stringify(ledger);
    expect(ledger.items[0].requested_locator).toBe("external://private.mp4");
    expect(ledger.items[0].canonical_locator).toBe("external://private.mp4");
    expect(serialized).not.toContain(outsideDir);
    expect(serialized).not.toContain(projectDir);
    expect(serialized).not.toContain("../");
  });

  it("preserves external locators while materializing the source media manifest", () => {
    const projectDir = tempDir("external-manifest");
    const discovery = discoverRequestedSources([path.join(projectDir, "missing.mp4")]);
    const ledger = buildSourceLedger("external-manifest", discovery, new Map(), "2026-07-20T00:00:00.000Z", projectDir);
    ledger.items[0].requested_locator = "external://missing.mp4";
    ledger.items[0].canonical_locator = "external://missing.mp4";

    const manifest = buildSourceMediaManifest({
      projectDir,
      projectId: "external-manifest",
      ledger,
      createdAt: "2026-07-20T00:00:00.000Z",
    });

    expect(manifest.items[0].source_locator).toBe("external://missing.mp4");
    expect(manifest.items[0].filename).toBe("missing.mp4");
  });

  it("resolves project-relative canonical locators before computing an internal source root", () => {
    const projectDir = tempDir("relative-root");
    const discovery = discoverRequestedSources([]);
    const ledger = buildSourceLedger("relative-root", discovery, new Map(), "2026-07-20T00:00:00.000Z", projectDir);
    ledger.items = [{
      source_id: "SRC_0000000000000001",
      requested_locator: "02_media/source/nested/clip.mp4",
      canonical_locator: "02_media/source/nested/clip.mp4",
      media_kind: "video",
      status: "failed",
      stage: "discovery",
      reason: "content_hash_failed:simulated",
      consumer_impact: "planning_block",
      content_hash: null,
      fingerprint: null,
      canonical_asset_id: null,
      size_bytes: null,
      mtime: null,
      canonical_request_source_id: null,
    }];
    ledger.summary = { requested: 1, ready: 0, unsupported: 0, failed: 1 };

    const manifest = buildSourceMediaManifest({ projectDir, projectId: "relative-root", ledger });

    expect(manifest.source_root.locator).toBe("02_media/source/nested");
    expect(manifest.source_root.locator).not.toContain("..");
    expect(path.isAbsolute(manifest.source_root.locator)).toBe(false);
    expect(manifest.items[0]).toMatchObject({ size_bytes: null, mtime: null });
  });

  it("combines JSON Schema validation with the requested equation runtime invariant", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/source-ledger.schema.json"), "utf-8"));
    const validateSchema = ajv.compile(schema);
    const discovery = discoverRequestedSources([]);
    const ledger = buildSourceLedger("equation", discovery, new Map(), "2026-07-20T00:00:00.000Z");
    expect(validateSourceLedgerArtifact(ledger, validateSchema).valid).toBe(true);
    const invalid = structuredClone(ledger);
    invalid.summary.requested = 1;
    expect(validateSchema(invalid)).toBe(true);
    expect(validateSourceLedgerArtifact(invalid, validateSchema)).toMatchObject({ valid: false });
  });
});
