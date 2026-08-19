import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { parseFcp7Sequence } from "../runtime/handoff/fcp7-xml-import.js";
import {
  preflightPremiereEffectBakes,
  preparePremiereEffectBakes,
  validatePremiereBakeArtifactGraph,
  type PremiereBakedRepresentation,
} from "../runtime/handoff/premiere-effect-bake.js";

const tempDirs: string[] = [];
const sha = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const repoRoot = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");

afterAll(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

interface FixtureSourceEvidence {
  contentHash: string;
  fingerprint: string;
  sizeBytes: number;
  mtimeMs: number;
  mtime: string;
}

function fixtureSourceEvidence(sourcePath: string): FixtureSourceEvidence {
  const before = fs.lstatSync(sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("fixture source must be regular nlink=1");
  const fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    const sameIdentity = before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size && before.mode === stat.mode &&
      before.mtimeMs === stat.mtimeMs && before.ctimeMs === stat.ctimeMs && stat.nlink === 1;
    if (!stat.isFile() || !sameIdentity) throw new Error("fixture source identity changed while opening");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const contentHash = `sha256:${hash.digest("hex")}`;
    return { contentHash, fingerprint: contentHash, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, mtime: new Date(stat.mtimeMs).toISOString() };
  } finally { fs.closeSync(fd); }
}

function treatedTimeline(): TimelineIR {
  return {
    version: "1", project_id: "s4a-xml", created_at: "2026-08-16T00:00:00Z",
    sequence: { name: "S4A", fps_num: 30, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: { video: [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_1", segment_id: "SEG_1", asset_id: "AST_1", src_in_us: 1_000_000,
      src_out_us: 2_000_000, timeline_in_frame: 0, timeline_duration_frames: 30,
      role: "primary", motivation: "treated", beat_id: "b1", fallback_segment_ids: [],
      confidence: 1, quality_flags: [], metadata: { zoom: 1.2 },
    }] }], audio: [] }, markers: [],
    provenance: { brief_path: "brief", blueprint_path: "blueprint", selects_path: "selects", compiler_version: "test" },
  };
}

describe("S4A FCP7 representation gate", () => {
  it("never silently exports a treated clip against untreated original media", () => {
    expect(() => timelineToFcp7Xml(treatedTimeline(), {
      sourceMap: new Map([["AST_1", "/original/untreated.mov"]]),
      projectId: "s4a-xml",
    })).toThrow(/visual_bake_representation_required/);
  });

  it("emits a visibly non-editable video-only derived representation", () => {
    const base = treatedTimeline();
    base.tracks.audio = [{ track_id: "A1", kind: "audio", clips: [{ ...base.tracks.video[0].clips[0], clip_id: "AUD_1", metadata: undefined }] }];
    const hash = `sha256:${"a".repeat(64)}`;
    const baked: PremiereBakedRepresentation = {
      representation: "baked_visual", clip_id: "CLP_1", canonical_asset_id: "AST_1",
      derived_asset_id: "AST_BAKE_AAAAAAAAAAAAAAAAAAAAAAAA", bake_request_id: hash,
      manifest_path: "09_output/premiere-bakes/requests/a/generations/b/manifest.json", manifest_sha256: hash,
      media_path: "09_output/premiere-bakes/requests/a/generations/b/clip.mp4", media_sha256: hash,
      media_video_stream_sha256: hash, absolute_media_path: "/derived/clip.mp4", timeline_track_id: "V1",
      source_in_us: 1_000_000, source_out_us: 2_000_000, timeline_duration_frames: 30,
      fps_num: 30, fps_den: 1, effect_editable: false,
    };
    const xml = timelineToFcp7Xml(base, {
      sourceMap: new Map([["AST_1", "/original/source.mov"]]), projectId: base.project_id,
      roundtripId: `sha256:${"b".repeat(64)}`, videoRepresentations: new Map([["CLP_1", baked]]),
    });
    expect(xml).toContain("[BAKED] treated");
    expect(xml).toContain("file://localhost/derived/clip.mp4");
    expect(xml).toContain("file://localhost/original/source.mov");
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTracks[0][0]).toMatchObject({ srcInFrame: 0, srcOutFrame: 30, videoOsMeta: { representation: "baked_visual", effect_editable: false, derived_asset_id: baked.derived_asset_id } });
    const bakedFile = xml.match(/<file id="file-1">([\s\S]*?)<\/file>/)?.[1] ?? "";
    expect(bakedFile).toContain("<video>");
    expect(bakedFile).not.toContain("<audio>");
  });
});

function provenanceFixture(): { projectPath: string; timeline: TimelineIR; rawTimeline: Buffer; sourcePath: string } {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "s4a-provenance-")); tempDirs.push(projectPath);
  const sourceDir = path.join(projectPath, "01_input"), sourcePath = path.join(sourceDir, "source.mp4"); fs.mkdirSync(sourceDir, { recursive: true });
  const render = spawnSync("ffmpeg", ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=1", "-an", "-vf", "format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off", "-color_range", "tv", "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709", sourcePath], { encoding: "utf8" });
  if (render.status !== 0) throw new Error(render.stderr);
  const evidence = fixtureSourceEvidence(sourcePath), sourceId = `SRC_${evidence.contentHash.slice(7, 23).toUpperCase()}`, sourceOrigin = "original_source" as const;
  const timeline = treatedTimeline(); timeline.project_id = "s4a-provenance"; timeline.sequence = { ...timeline.sequence, width: 320, height: 240 }; timeline.tracks.video[0].clips[0] = { ...timeline.tracks.video[0].clips[0], src_in_us: 0, src_out_us: 1_000_000, timeline_duration_frames: 30, metadata: { render: { effects: [{ type: "contrast", params: { value: 1.2 } }] } } };
  const rawTimeline = Buffer.from(JSON.stringify(timeline, null, 2));
  fs.mkdirSync(path.join(projectPath, "02_media"), { recursive: true }); fs.mkdirSync(path.join(projectPath, "03_analysis"), { recursive: true }); fs.mkdirSync(path.join(projectPath, "05_timeline"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "05_timeline", "timeline.json"), rawTimeline);
  fs.writeFileSync(path.join(projectPath, "02_media", "source_map.json"), JSON.stringify({ version: "1", project_id: timeline.project_id, media_dir: "02_media", generated_at: "2026-08-16T00:00:00Z", items: [{ asset_id: "AST_1", source_locator: sourcePath, local_source_path: sourcePath, link_path: sourcePath, link_type: "direct", media_kind: "video", source_content_sha256: evidence.contentHash.slice(7), source_fingerprint: evidence.fingerprint, source_size_bytes: evidence.sizeBytes, source_mtime_ms: evidence.mtimeMs, source_origin: sourceOrigin }] }, null, 2));
  fs.writeFileSync(path.join(projectPath, "03_analysis", "source_ledger.json"), JSON.stringify({ version: "1.0.0", artifact_version: "source-ledger-v1", project_id: timeline.project_id, created_at: "2026-08-16T00:00:00Z", hidden_sidecar_policy: "exclude", summary: { requested: 1, ready: 1, unsupported: 0, failed: 0 }, items: [{ source_id: sourceId, requested_locator: sourcePath, canonical_locator: sourcePath, media_kind: "video", status: "ready", stage: "probe", reason: null, consumer_impact: "none", content_hash: evidence.contentHash, fingerprint: evidence.fingerprint, canonical_asset_id: "AST_1", size_bytes: evidence.sizeBytes, mtime: evidence.mtime, canonical_request_source_id: sourceId }] }, null, 2));
  fs.writeFileSync(path.join(projectPath, "02_media", "source_media_manifest.json"), JSON.stringify({ version: "1.0.0", project_id: timeline.project_id, artifact_version: "manifest-v1", created_at: "2026-08-16T00:00:00Z", source_root: { locator: sourceDir, locator_kind: "local_path" }, items: [{ asset_id: "AST_1", source_id: sourceId, source_locator: sourcePath, filename: "source.mp4", content_hash: evidence.contentHash, fingerprint: evidence.fingerprint, size_bytes: evidence.sizeBytes, mtime: evidence.mtime, media_kind: "video", ingest_status: "ready", reason: null, consumer_impact: "none", rights_status: "licensed", privacy_status: "operator_declared_ok", analysis_policy_ref: "APOL_default", capture_started_at: null, capture_timezone: null, timecode_start: null, timecode_format: "none", sample_rate: null, duration_us: 1_000_000, frame_rate_mode: "cfr", rotation: 0, audio_video_offset_ms: null, clock_source: "file_metadata" }], provenance: { producer: "analysis-ingest", inputs: [], hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: [] } } }, null, 2));
  return { projectPath, timeline, rawTimeline, sourcePath };
}

function runPublicExport(projectPath: string) {
  const result = spawnSync(tsx, [path.join(repoRoot, "scripts/export-premiere-xml.ts"), projectPath, "--bake-visual-effects", "--json"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPublicImport(projectPath: string, xmlPath: string, receiptPath: string, apply = false) {
  const result = spawnSync(tsx, [path.join(repoRoot, "scripts/import-premiere-xml.ts"), projectPath, "--xml", xmlPath, "--receipt", receiptPath, ...(apply ? ["--apply"] : []), "--json"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPublicExportAsync(projectPath: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(tsx, [path.join(repoRoot, "scripts/export-premiere-xml.ts"), projectPath, "--bake-visual-effects", "--json"], { cwd: repoRoot, env: { ...process.env, FORCE_COLOR: "0" } });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function fixtureCommandOutput(command: string, args: string[], label: string): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!output) throw new Error(`fixture cannot establish ${label}`);
  return output;
}

function fixtureBootIdentity(): string {
  const procBootId = "/proc/sys/kernel/random/boot_id";
  if (fs.existsSync(procBootId)) {
    const value = fs.readFileSync(procBootId, "utf8").trim();
    if (!value) throw new Error("fixture cannot establish Linux boot identity");
    return value;
  }
  if (process.platform === "darwin") return fixtureCommandOutput("/usr/sbin/sysctl", ["-n", "kern.boottime"], "macOS boot identity");
  throw new Error(`fixture cannot establish boot identity on ${process.platform}`);
}
function fixtureHostId(): string { return sha(`${os.hostname()}\0${fixtureBootIdentity()}`); }
function fixtureProcessStartId(pid: number): string { return sha(`${fixtureHostId()}\0${pid}\0${fixtureCommandOutput("ps", ["-o", "lstart=", "-p", String(pid)], "process start identity")}`); }

function writeExportClaim(projectPath: string, pid: number, processStartId: string): string {
  const root = path.join(projectPath, "09_output", "premiere-exports"); fs.mkdirSync(root, { recursive: true });
  const id = sha(`claim-${pid}-${processStartId}`);
  fs.writeFileSync(path.join(root, "CLAIM.json"), `${JSON.stringify({ version: "premiere-export-claim/v1", claim_id: id, project_id: "s4a-provenance", base_timeline_sha256: sha(fs.readFileSync(path.join(projectPath, "05_timeline/timeline.json"))), invocation_id: `fixture-${pid}`, host_id: fixtureHostId(), pid, process_start_id: processStartId, created_at: "2026-08-16T00:00:00.000Z" })}\n`, { mode: 0o600 });
  return id;
}

function writeBakeClaim(projectPath: string, requestSha256: string, pid: number, processStartId: string): string {
  const requestDir = path.join(projectPath, "09_output/premiere-bakes/requests", requestSha256.slice(7));
  const claimId = sha(`bake-claim-${pid}-${processStartId}`);
  fs.writeFileSync(path.join(requestDir, "CLAIM.json"), `${JSON.stringify({ version: "premiere-bake-claim/v1", claim_id: claimId, request_sha256: requestSha256, invocation_id: `fixture-${pid}`, host_id: fixtureHostId(), pid, process_start_id: processStartId, created_at: "2026-08-16T00:00:00.000Z" })}\n`, { mode: 0o600 });
  return requestDir;
}

describe("S4A provenance-bound render/cache graph", () => {
  it("renders once, reuses only a fully validated fixed-root graph, and rejects substituted media", () => {
    const fixture = provenanceFixture(), options = { projectPath: fixture.projectPath, timeline: fixture.timeline, rawTimeline: fixture.rawTimeline };
    expect(preflightPremiereEffectBakes(options)).toMatchObject([{ status: "bake_required" }]);
    const first = preparePremiereEffectBakes(options), entry = first.index.entries[0];
    expect(first.cache_results).toMatchObject([{ status: "rendered" }]);
    expect(preflightPremiereEffectBakes(options)).toMatchObject([{ status: "reusable" }]);
    expect(preparePremiereEffectBakes(options).cache_results).toMatchObject([{ status: "reused" }]);
    expect(validatePremiereBakeArtifactGraph(fixture.projectPath, entry)).toMatchObject({ effect_editable: false, media_sha256: entry.media_sha256 });
    fs.appendFileSync(path.resolve(fixture.projectPath, entry.media_path), "substitution");
    expect(preflightPremiereEffectBakes(options)).toMatchObject([{ status: "conflict" }]);
  });

  it("reports rights/privacy denial before rendering or cache publication", () => {
    const fixture = provenanceFixture(), manifestPath = path.join(fixture.projectPath, "02_media/source_media_manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); manifest.items[0].rights_status = "unknown"; fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    expect(preflightPremiereEffectBakes({ projectPath: fixture.projectPath, timeline: fixture.timeline, rawTimeline: fixture.rawTimeline })).toMatchObject([{ status: "rights_privacy_blocked" }]);
    expect(fs.existsSync(path.join(fixture.projectPath, "09_output", "premiere-bakes"))).toBe(false);
  });

  it("rejects a live source change against the manifest request graph", () => {
    const fixture = provenanceFixture(), options = { projectPath: fixture.projectPath, timeline: fixture.timeline, rawTimeline: fixture.rawTimeline };
    const prepared = preparePremiereEffectBakes(options), entry = prepared.index.entries[0];
    fs.appendFileSync(fixture.sourcePath, "changed source");
    expect(preflightPremiereEffectBakes(options)).toMatchObject([{ status: "source_unverified" }]);
    expect(() => validatePremiereBakeArtifactGraph(fixture.projectPath, entry)).toThrow(/visual_bake_source_unverified/);
  });

  it("publishes repeated identical exports without leaving request or export claims", () => {
    const fixture = provenanceFixture(), first = runPublicExport(fixture.projectPath), second = runPublicExport(fixture.projectPath);
    expect(first.status, first.stderr).toBe(0); expect(second.status, second.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout), secondResult = JSON.parse(second.stdout);
    expect(secondResult.export_generation_id).toBe(firstResult.export_generation_id);
    expect(fs.existsSync(path.join(fixture.projectPath, "09_output/premiere-exports/CLAIM.json"))).toBe(false);
    const requestRoot = path.join(fixture.projectPath, "09_output/premiere-bakes/requests");
    for (const request of fs.readdirSync(requestRoot)) expect(fs.existsSync(path.join(requestRoot, request, "CLAIM.json"))).toBe(false);
  });

  it("rejects a pre-existing symlink-backed deterministic export generation without changing published compatibility artifacts", () => {
    const fixture = provenanceFixture(), first = runPublicExport(fixture.projectPath);
    expect(first.status, first.stderr).toBe(0);
    const result = JSON.parse(first.stdout), output = path.join(fixture.projectPath, "09_output");
    const generationPath = result.generation.generation_dir as string, backingPath = path.join(output, "symlink-generation-backing");
    const currentPath = path.join(output, "premiere-exports/CURRENT.json"), xmlPath = path.join(output, "s4a-provenance_premiere.xml"), receiptPath = path.join(output, "s4a-provenance_premiere.roundtrip.json");
    const before = { current: fs.readFileSync(currentPath), xml: fs.readFileSync(xmlPath), receipt: fs.readFileSync(receiptPath) };
    fs.renameSync(generationPath, backingPath);
    fs.symlinkSync(backingPath, generationPath, "dir");

    const blocked = runPublicExport(fixture.projectPath);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("premiere_export_conflict");
    expect(fs.readFileSync(currentPath)).toEqual(before.current);
    expect(fs.readFileSync(xmlPath)).toEqual(before.xml);
    expect(fs.readFileSync(receiptPath)).toEqual(before.receipt);
  });

  it("validates the selected CURRENT/READY/receipt/index/manifest/media chain before import diff", () => {
    const fixture = provenanceFixture(), exported = runPublicExport(fixture.projectPath);
    expect(exported.status, exported.stderr).toBe(0);
    const result = JSON.parse(exported.stdout), unchanged = runPublicImport(fixture.projectPath, result.generation.xml_path, result.generation.receipt_path);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ receipt_validation: { provided: true, valid: true }, total_diffs: 0 });
    const currentPath = path.join(fixture.projectPath, "09_output/premiere-exports/CURRENT.json"), current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    current.unexpected = true; fs.writeFileSync(currentPath, JSON.stringify(current));
    const blocked = runPublicImport(fixture.projectPath, result.generation.xml_path, result.generation.receipt_path, true);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ applied: false, apply_blocked: true, total_diffs: 0, receipt_validation: { provided: true, valid: false } });
    expect(fs.existsSync(path.join(fixture.projectPath, "05_timeline/timeline.json.bak"))).toBe(false);
  });

  it("reports and recovers abandoned request claims but blocks active request claims", () => {
    const fixture = provenanceFixture(), options = { projectPath: fixture.projectPath, timeline: fixture.timeline, rawTimeline: fixture.rawTimeline };
    const prepared = preparePremiereEffectBakes(options), requestSha = prepared.index.entries[0].bake_request_id;
    const requestDir = writeBakeClaim(fixture.projectPath, requestSha, 999999, sha("dead-process"));
    expect(preflightPremiereEffectBakes(options)).toMatchObject([{ status: "stale", request_sha256: requestSha }]);
    expect(preparePremiereEffectBakes(options).cache_results).toMatchObject([{ status: "reused" }]);
    expect(fs.existsSync(path.join(requestDir, "CLAIM.json"))).toBe(false);
    writeBakeClaim(fixture.projectPath, requestSha, process.pid, fixtureProcessStartId(process.pid));
    expect(preflightPremiereEffectBakes(options)).toMatchObject([{ status: "busy", request_sha256: requestSha }]);
    expect(() => preparePremiereEffectBakes(options)).toThrow(/visual_bake_busy/);
  });

  it("recovers a deterministic orphan generation and an exact completed request release", () => {
    const fixture = provenanceFixture(), options = { projectPath: fixture.projectPath, timeline: fixture.timeline, rawTimeline: fixture.rawTimeline };
    const first = preparePremiereEffectBakes(options), entry = first.index.entries[0], requestDir = path.join(fixture.projectPath, "09_output/premiere-bakes/requests", entry.bake_request_id.slice(7));
    fs.unlinkSync(path.join(requestDir, "READY.json"));
    fs.unlinkSync(path.join(requestDir, "generations", entry.media_sha256.slice(7), "READY.json"));
    expect(preparePremiereEffectBakes(options).cache_results).toMatchObject([{ status: "rendered", request_sha256: entry.bake_request_id }]);
    const claimId = sha("completed-bake-release"), claimPath = path.join(requestDir, "CLAIM.json"), processStartId = sha("dead-process");
    fs.writeFileSync(claimPath, `${JSON.stringify({ version: "premiere-bake-claim/v1", claim_id: claimId, request_sha256: entry.bake_request_id, invocation_id: "completed-fixture", host_id: fixtureHostId(), pid: 999999, process_start_id: processStartId, created_at: "2026-08-16T00:00:00.000Z" })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(requestDir, "claims/releases", `${claimId.slice(7)}.json`), `${JSON.stringify({ version: "premiere-bake-claim-release/v1", claim_id: claimId, request_sha256: entry.bake_request_id, request_ready_sha256: sha(fs.readFileSync(path.join(requestDir, "READY.json"))), released_at: "2026-08-16T00:00:01.000Z" })}\n`, { mode: 0o600 });
    expect(preparePremiereEffectBakes(options).cache_results).toMatchObject([{ status: "reused" }]);
    expect(fs.existsSync(claimPath)).toBe(false);
  });

  it("releases an export claim after a post-claim failure", () => {
    const fixture = provenanceFixture(), missingTitles = path.join(fixture.projectPath, "missing-titles.json");
    const failed = spawnSync(tsx, [path.join(repoRoot, "scripts/export-premiere-xml.ts"), fixture.projectPath, "--bake-visual-effects", "--titles", missingTitles, "--json"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
    expect(failed.status).toBe(1);
    expect(fs.existsSync(path.join(fixture.projectPath, "09_output/premiere-exports/CLAIM.json"))).toBe(false);
  });

  it("admits one concurrent exporter and leaves no wedged claim", async () => {
    const fixture = provenanceFixture();
    const [left, right] = await Promise.all([runPublicExportAsync(fixture.projectPath), runPublicExportAsync(fixture.projectPath)]);
    expect([left.status, right.status]).toContain(0);
    const loser = left.status === 0 ? right : left;
    if (loser.status !== 0) expect(loser.stderr).toContain("premiere_export_busy");
    expect(fs.existsSync(path.join(fixture.projectPath, "09_output/premiere-exports/CLAIM.json"))).toBe(false);
  });

  it("recovers an abandoned export claim and rejects an active same-host claim", () => {
    const stale = provenanceFixture(); writeExportClaim(stale.projectPath, 999999, sha("dead-process"));
    const recovered = runPublicExport(stale.projectPath); expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.readdirSync(path.join(stale.projectPath, "09_output/premiere-exports/claims/abandoned")).length).toBe(1);

    const active = provenanceFixture();
    writeExportClaim(active.projectPath, process.pid, fixtureProcessStartId(process.pid));
    const blocked = runPublicExport(active.projectPath); expect(blocked.status).toBe(1); expect(blocked.stderr).toContain("premiere_export_busy");
  });

  it("recovers partial export readiness and an exact completed export release", () => {
    const fixture = provenanceFixture(), first = runPublicExport(fixture.projectPath); expect(first.status, first.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout), root = path.join(fixture.projectPath, "09_output/premiere-exports"), output = path.join(fixture.projectPath, "09_output");
    fs.unlinkSync(firstResult.generation.ready_path); fs.unlinkSync(path.join(root, "CURRENT.json"));
    const recoveredGeneration = runPublicExport(fixture.projectPath); expect(recoveredGeneration.status, recoveredGeneration.stderr).toBe(0);
    const claimId = writeExportClaim(fixture.projectPath, 999999, sha("dead-completed-export"));
    fs.mkdirSync(path.join(root, "claims/releases"), { recursive: true });
    fs.writeFileSync(path.join(root, "claims/releases", `${claimId.slice(7)}.json`), `${JSON.stringify({ version: "premiere-export-claim-release/v1", claim_id: claimId, current_sha256: sha(fs.readFileSync(path.join(root, "CURRENT.json"))), compatibility_xml_sha256: sha(fs.readFileSync(path.join(output, "s4a-provenance_premiere.xml"))), compatibility_receipt_sha256: sha(fs.readFileSync(path.join(output, "s4a-provenance_premiere.roundtrip.json"))), released_at: "2026-08-16T00:00:01.000Z" })}\n`, { mode: 0o600 });
    const recoveredRelease = runPublicExport(fixture.projectPath); expect(recoveredRelease.status, recoveredRelease.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "CLAIM.json"))).toBe(false);
  });
});
