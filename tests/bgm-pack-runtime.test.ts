import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildBgmCatalog, resolveTrack } from "../runtime/music/catalog.js";
import { inspectInstalledPacks, resolveInstalledPacks, verifyPack } from "../runtime/music/pack-registry.js";
import type { BgmPackManifest, BgmPackTrack } from "../runtime/music/pack-types.js";
import { BGM_PACK_CLI_EXIT, runBgmPackCli } from "../scripts/bgm-pack.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-bgm-pack-"));
  tempDirs.push(root);
  return root;
}

function axes(): BgmPackTrack["axes"] {
  return Object.fromEntries([
    "energy", "valence", "tension", "warmth", "modernity", "playfulness", "sophistication",
    "organic_electronic", "density", "speech_friendliness", "beat_prominence", "build_strength", "ending_resolution",
  ].map((name) => [name, { value: 0.5, source: "authored" }])) as BgmPackTrack["axes"];
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
}

function normalizedJson(value: unknown, excluded: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizedJson(item, excluded));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, normalizedJson(item, excluded)]));
}

function writePack(
  container: string,
  options: { packId?: string; packVersion?: string; corruptHash?: boolean } = {},
): { packDir: string; manifest: BgmPackManifest } {
  const packId = options.packId ?? "core-v1";
  const packDir = path.join(container, `${packId}-${options.packVersion ?? "1.0.0"}`);
  fs.mkdirSync(path.join(packDir, "audio"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "rights"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "analysis"), { recursive: true });
  const fullMix = Buffer.from("RIFF-synthetic-full-mix");
  const preview = Buffer.from("RIFF-synthetic-preview");
  const declaredFullMixHash = options.corruptHash ? `sha256:${"0".repeat(64)}` : sha256(fullMix);
  fs.writeFileSync(path.join(packDir, "audio", "track-a.wav"), fullMix);
  fs.writeFileSync(path.join(packDir, "audio", "track-a-preview.wav"), preview);

  const rights = parseYaml(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "bgm_contracts", "valid_rights_register.yaml"), "utf8")) as Record<string, unknown>;
  const rightsItems = rights.items as Array<Record<string, unknown>>;
  rights.items = [rightsItems[0]];
  rightsItems[0].asset_id = "track-a";
  rightsItems[0].content_hash = declaredFullMixHash;
  (rightsItems[0].integrity as Record<string, unknown>).verified_hash = declaredFullMixHash;
  const rightsBytes = Buffer.from(`${JSON.stringify(rights, null, 2)}\n`);
  fs.writeFileSync(path.join(packDir, "rights", "track-a.json"), rightsBytes);

  const analysis = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "bgm_contracts", "valid_track_analysis.json"), "utf8")) as Record<string, unknown>;
  analysis.track_id = "track-a";
  analysis.input_content_hash = declaredFullMixHash;
  analysis.analysis_hash = `sha256:${"0".repeat(64)}`;
  const excluded = ((analysis.hash_policy as Record<string, unknown>).excluded_fields as string[]);
  analysis.analysis_hash = `sha256:${createHash("sha256").update(JSON.stringify(normalizedJson(analysis, excluded))).digest("hex")}`;
  const analysisBytes = Buffer.from(`${JSON.stringify(analysis, null, 2)}\n`);
  fs.writeFileSync(path.join(packDir, "analysis", "track-a.json"), analysisBytes);
  const track: BgmPackTrack = {
    track_id: "track-a",
    title: "Synthetic Track A",
    contributor_id: "fixture-contributor",
    duration_us: 60_000_000,
    format: "wav",
    full_mix: {
      path: "audio/track-a.wav",
      content_hash: declaredFullMixHash,
      size_bytes: fullMix.byteLength,
      format: "wav",
    },
    preview: {
      path: "audio/track-a-preview.wav",
      content_hash: sha256(preview),
      size_bytes: preview.byteLength,
      format: "wav",
    },
    rights_ref: {
      path: "rights/track-a.json",
      content_hash: sha256(rightsBytes),
      size_bytes: rightsBytes.byteLength,
      format: "json",
    },
    analysis_ref: {
      path: "analysis/track-a.json",
      content_hash: sha256(analysisBytes),
      size_bytes: analysisBytes.byteLength,
      format: "json",
    },
    family: "trust_clarity",
    intensity: "low",
    use_cases: ["interview"],
    exclusions: ["lead_vocal"],
    instruments: ["piano"],
    edit_points_us: [0, 15_000_000, 30_000_000],
    loop_windows: [{ in_us: 15_000_000, out_us: 30_000_000, max_repetitions: 2 }],
    axes: axes(),
    vocal_presence: "none",
  };
  const manifest: BgmPackManifest = {
    version: "1.0.0",
    pack_id: packId,
    pack_version: options.packVersion ?? "1.0.0",
    title: "Synthetic Core Pack",
    created_at: "2026-07-16T00:00:00.000Z",
    catalog_license: "fixture-only",
    default_content_license: "fixture-only",
    compatible_video_os: { contract_min: "0.1.0", contract_max: "0.1.0" },
    tracks: [track],
    provenance: { producer: "Video OS tests", source_type: "bundled_pack", evidence_refs: [] },
    hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: [] },
  };
  fs.writeFileSync(path.join(packDir, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { packDir, manifest };
}

function readManifest(packDir: string): BgmPackManifest {
  return JSON.parse(fs.readFileSync(path.join(packDir, "pack-manifest.json"), "utf8")) as BgmPackManifest;
}

function writeManifest(packDir: string, manifest: BgmPackManifest): void {
  fs.writeFileSync(path.join(packDir, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("read-only BGM pack registry", () => {
  it("keeps a legacy manifest without pinned provenance assets compatible", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification.files_checked).toBe(5);
    expect(verification.verified_provenance_paths).toEqual([]);

    const resolved = resolveTrack("track-a", manifest.tracks[0].full_mix.content_hash, {
      searchRoots: [{ source: "environment", priority: 1, path: root }],
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.track?.track.title).toBe("Synthetic Track A");
  });

  it("rejects a track content hash mismatch", () => {
    const root = makeRoot();
    const { packDir } = writePack(root, { corruptHash: true });
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_TRACK_HASH_MISMATCH",
      affected_ref: "track-a",
    }));
  });

  it("treats a pinned rights data hash mismatch as a hard pack integrity error", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    manifest.tracks[0].rights_ref.content_hash = `sha256:${"9".repeat(64)}`;
    writeManifest(packDir, manifest);
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_PACK_HASH_MISMATCH",
      affected_ref: "track-a",
    }));
  });

  it("degrades malformed but integrity-pinned analysis without hiding the track", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    const bytes = Buffer.from("{}\n");
    fs.writeFileSync(path.join(packDir, manifest.tracks[0].analysis_ref.path), bytes);
    manifest.tracks[0].analysis_ref.content_hash = sha256(bytes);
    manifest.tracks[0].analysis_ref.size_bytes = bytes.byteLength;
    writeManifest(packDir, manifest);
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_ANALYSIS_UNAVAILABLE",
      severity: "warning",
    }));
  });

  it("degrades a schema-valid analysis whose identity does not match the track", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    const analysisPath = path.join(packDir, manifest.tracks[0].analysis_ref.path);
    const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8")) as Record<string, unknown>;
    analysis.track_id = "other-track";
    const excluded = ((analysis.hash_policy as Record<string, unknown>).excluded_fields as string[]);
    analysis.analysis_hash = `sha256:${createHash("sha256").update(JSON.stringify(normalizedJson(analysis, excluded))).digest("hex")}`;
    const bytes = Buffer.from(`${JSON.stringify(analysis, null, 2)}\n`);
    fs.writeFileSync(analysisPath, bytes);
    manifest.tracks[0].analysis_ref.content_hash = sha256(bytes);
    manifest.tracks[0].analysis_ref.size_bytes = bytes.byteLength;
    writeManifest(packDir, manifest);
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_ANALYSIS_UNAVAILABLE",
      severity: "warning",
    }));
  });

  it("blocks a rights register not bound to the track full-mix hash", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    const rightsPath = path.join(packDir, manifest.tracks[0].rights_ref.path);
    const rights = JSON.parse(fs.readFileSync(rightsPath, "utf8")) as Record<string, unknown>;
    const item = (rights.items as Array<Record<string, unknown>>)[0];
    item.content_hash = `sha256:${"8".repeat(64)}`;
    (item.integrity as Record<string, unknown>).verified_hash = item.content_hash;
    const bytes = Buffer.from(`${JSON.stringify(rights, null, 2)}\n`);
    fs.writeFileSync(rightsPath, bytes);
    manifest.tracks[0].rights_ref.content_hash = sha256(bytes);
    manifest.tracks[0].rights_ref.size_bytes = bytes.byteLength;
    writeManifest(packDir, manifest);
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(expect.objectContaining({ code: "BGM_RIGHTS_BLOCKED" }));
  });

  it("keeps the canonical manifest hash stable across whitespace and key order", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    const firstHash = verifyPack(packDir).manifest_hash;
    fs.writeFileSync(path.join(packDir, "pack-manifest.json"), JSON.stringify(reverseObjectKeys(manifest)));
    expect(verifyPack(packDir).manifest_hash).toBe(firstHash);
  });

  it("rejects duplicate stable track IDs", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    manifest.tracks.push(structuredClone(manifest.tracks[0]));
    fs.writeFileSync(path.join(packDir, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_PACK_INCOMPATIBLE",
      affected_ref: "track-a",
    }));
  });

  it("rejects an audio symlink that escapes the pack realpath", () => {
    const root = makeRoot();
    const outside = path.join(root, "outside.wav");
    const { packDir, manifest } = writePack(root);
    fs.writeFileSync(outside, "outside-audio");
    const assetPath = path.join(packDir, manifest.tracks[0].full_mix.path);
    fs.rmSync(assetPath);
    fs.symlinkSync(outside, assetPath);
    manifest.tracks[0].full_mix.content_hash = sha256(fs.readFileSync(outside));
    manifest.tracks[0].full_mix.size_bytes = fs.statSync(outside).size;
    fs.writeFileSync(path.join(packDir, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const verification = verifyPack(packDir);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(expect.objectContaining({
      code: "BGM_PACK_ARCHIVE_UNSAFE",
      affected_ref: "track-a",
    }));
  });

  it("uses root priority before a later pack version", () => {
    const projectRoot = makeRoot();
    const environmentRoot = makeRoot();
    writePack(projectRoot, { packVersion: "1.0.0" });
    writePack(environmentRoot, { packVersion: "9.0.0" });
    const packs = resolveInstalledPacks({
      searchRoots: [
        { source: "project_override", priority: 0, path: projectRoot },
        { source: "environment", priority: 1, path: environmentRoot },
      ],
    });
    expect(packs).toHaveLength(1);
    expect(packs[0].source).toBe("project_override");
    expect(packs[0].manifest.pack_version).toBe("1.0.0");
  });

  it("prefers an exact stable SemVer over its prerelease at the same priority", () => {
    const root = makeRoot();
    writePack(root, { packVersion: "2.0.0-rc.10" });
    writePack(root, { packVersion: "2.0.0" });
    const packs = resolveInstalledPacks({ searchRoots: [{ source: "environment", priority: 1, path: root }] });
    expect(packs).toHaveLength(1);
    expect(packs[0].manifest.pack_version).toBe("2.0.0");
  });

  it("does not fall back when a higher-priority manifest declares the same ID but is schema-invalid", () => {
    const projectRoot = makeRoot();
    const environmentRoot = makeRoot();
    const { packDir, manifest } = writePack(projectRoot);
    manifest.tracks = [];
    writeManifest(packDir, manifest);
    writePack(environmentRoot, { packVersion: "2.0.0" });
    const registry = inspectInstalledPacks({ searchRoots: [
      { source: "project_override", priority: 0, path: projectRoot },
      { source: "environment", priority: 1, path: environmentRoot },
    ] });
    expect(registry.packs).toEqual([]);
    expect(registry.blocked_pack_ids).toContain("core-v1");
    expect(registry.issues).toContainEqual(expect.objectContaining({ code: "BGM_PACK_INCOMPATIBLE" }));
  });

  it("blocks all lower global fallback after unreadable JSON in an explicit project override", () => {
    const projectRoot = makeRoot();
    const environmentRoot = makeRoot();
    const invalidDir = path.join(projectRoot, "broken-project-pack");
    fs.mkdirSync(invalidDir);
    fs.writeFileSync(path.join(invalidDir, "pack-manifest.json"), "{not-json");
    writePack(environmentRoot, { packId: "different-pack" });
    const registry = inspectInstalledPacks({ searchRoots: [
      { source: "project_override", priority: 0, path: projectRoot },
      { source: "environment", priority: 1, path: environmentRoot },
    ] });
    expect(registry.global_fallback_blocked).toBe(true);
    expect(registry.packs).toEqual([]);
    expect(registry.issues).toContainEqual(expect.objectContaining({ code: "BGM_PACK_INCOMPATIBLE" }));
  });

  it("uses verifier-realpathed audio assets in the catalog", () => {
    const root = makeRoot();
    const { packDir, manifest } = writePack(root);
    const declaredPath = path.join(packDir, manifest.tracks[0].full_mix.path);
    const actualPath = path.join(packDir, "audio", "track-a-actual.wav");
    fs.renameSync(declaredPath, actualPath);
    fs.symlinkSync(actualPath, declaredPath);
    const catalog = buildBgmCatalog({ searchRoots: [{ source: "environment", priority: 1, path: root }] });
    expect(catalog.tracks).toHaveLength(1);
    expect(catalog.tracks[0].full_mix_path).toBe(fs.realpathSync(actualPath));
    expect(catalog.tracks[0].full_mix_path).not.toBe(declaredPath);
  });

  it("rejects an ambiguous unpinned track ID across verified packs", () => {
    const root = makeRoot();
    writePack(root, { packId: "pack-one" });
    writePack(root, { packId: "pack-two" });
    const resolved = resolveTrack("track-a", undefined, {
      searchRoots: [{ source: "environment", priority: 1, path: root }],
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: "BGM_SELECTION_INCONCLUSIVE" }));
  });

  it("fails open with an empty catalog when no pack is installed", () => {
    const root = makeRoot();
    const catalog = buildBgmCatalog({
      searchRoots: [{ source: "environment", priority: 1, path: root }],
    });
    expect(catalog.packs).toEqual([]);
    expect(catalog.tracks).toEqual([]);
  });
});

describe("bgm-pack CLI", () => {
  it("lists verified packs as path-free JSON", async () => {
    const root = makeRoot();
    writePack(root);
    let stdout = "";
    let stderr = "";
    const exitCode = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "list", "--root", root, "--json"],
      {
        stdout: { write: (chunk) => { stdout += String(chunk); return true; } },
        stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
      },
    );
    const payload = JSON.parse(stdout) as { ok: boolean; packs: unknown[]; tracks: unknown[] };
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(payload.ok).toBe(true);
    expect(payload.packs).toHaveLength(1);
    expect(payload.tracks).toHaveLength(1);
    expect(stdout).not.toContain(root);
  });

  it("returns stable path-free verification issues as JSON", async () => {
    const root = makeRoot();
    writePack(root, { corruptHash: true });
    let stdout = "";
    const exitCode = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "verify", "--pack", "core-v1", "--root", root, "--json"],
      {
        stdout: { write: (chunk) => { stdout += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    const payload = JSON.parse(stdout) as { ok: boolean; issues: Array<{ code: string; affected_ref?: string }> };
    expect(exitCode).toBe(BGM_PACK_CLI_EXIT.verificationFailed);
    expect(payload.ok).toBe(false);
    expect(payload.issues).toContainEqual(expect.objectContaining({
      code: "BGM_TRACK_HASH_MISMATCH",
      affected_ref: "track-a",
    }));
    expect(stdout).not.toContain(root);
  });

  it("uses documented usage and not-found exit codes without echoing input paths", async () => {
    const root = makeRoot();
    let usageOut = "";
    const sensitive = path.join(root, "private-name");
    const usageExit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "bad-command", sensitive, "--json"],
      {
        stdout: { write: (chunk) => { usageOut += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    expect(usageExit).toBe(BGM_PACK_CLI_EXIT.usage);
    expect(usageOut).not.toContain(sensitive);

    let notFoundOut = "";
    const notFoundExit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "verify", "--pack", "missing-pack", "--root", root, "--json"],
      {
        stdout: { write: (chunk) => { notFoundOut += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    expect(notFoundExit).toBe(BGM_PACK_CLI_EXIT.notFound);
    expect(notFoundOut).not.toContain(root);
  });

  it("classifies schema/contract failures as exit 2 and integrity failures as exit 4", async () => {
    const schemaRoot = makeRoot();
    const { packDir, manifest } = writePack(schemaRoot);
    manifest.tracks = [];
    writeManifest(packDir, manifest);
    let schemaOut = "";
    const schemaExit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "list", "--root", schemaRoot, "--json"],
      {
        stdout: { write: (chunk) => { schemaOut += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    expect(schemaExit).toBe(BGM_PACK_CLI_EXIT.usage);
    expect((JSON.parse(schemaOut) as { ok: boolean }).ok).toBe(false);
    let verifySchemaOut = "";
    const verifySchemaExit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "verify", "--root", schemaRoot, "--json"],
      {
        stdout: { write: (chunk) => { verifySchemaOut += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    expect(verifySchemaExit).toBe(BGM_PACK_CLI_EXIT.usage);
    expect((JSON.parse(verifySchemaOut) as { ok: boolean }).ok).toBe(false);

    const integrityRoot = makeRoot();
    writePack(integrityRoot, { corruptHash: true });
    let integrityOut = "";
    const integrityExit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "list", "--root", integrityRoot, "--json"],
      {
        stdout: { write: (chunk) => { integrityOut += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    expect(integrityExit).toBe(BGM_PACK_CLI_EXIT.verificationFailed);
    expect((JSON.parse(integrityOut) as { ok: boolean }).ok).toBe(false);
  });

  it("redacts an invalid manifest directory name from CLI JSON", async () => {
    const root = makeRoot();
    const privateName = "Private Client 123";
    const packDir = path.join(root, privateName);
    fs.mkdirSync(packDir);
    fs.writeFileSync(path.join(packDir, "pack-manifest.json"), "{broken-json");
    let stdout = "";
    const exit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "verify", "--root", root, "--json"],
      {
        stdout: { write: (chunk) => { stdout += String(chunk); return true; } },
        stderr: { write: () => true },
      },
    );
    expect(exit).toBe(BGM_PACK_CLI_EXIT.usage);
    expect(stdout).not.toContain(privateName);
    expect(stdout).toContain("bgm-pack");
  });

  it("converts an unexpected command failure to redacted exit 5 JSON", async () => {
    const root = makeRoot();
    let writes = 0;
    let stdout = "";
    const exit = await runBgmPackCli(
      ["node", "scripts/bgm-pack.ts", "list", "--root", root, "--json"],
      {
        stdout: { write: (chunk) => {
          writes += 1;
          if (writes === 1) throw new Error(`private failure at ${root}`);
          stdout += String(chunk);
          return true;
        } },
        stderr: { write: () => true },
      },
    );
    expect(exit).toBe(BGM_PACK_CLI_EXIT.internal);
    expect(stdout).toContain("failed unexpectedly");
    expect(stdout).not.toContain(root);
  });
});
