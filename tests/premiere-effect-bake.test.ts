import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TimelineIR, ClipOutput } from "../runtime/compiler/types.js";
import {
  bindPremiereEffectBakeRequestSha,
  buildPremiereBakeFfmpegArgv,
  buildPremiereBakeFiltergraph,
  canonicalJson,
  classifyPremiereVideoTreatments,
  normalizePremiereVisualTreatment,
  sha256Prefixed,
} from "../runtime/handoff/premiere-effect-bake.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const dirs: string[] = [];

function projectWithTreatment(effects: unknown[]) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s4a-red-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(dir, "02_media"), { recursive: true });
  const source = path.join(dir, "source.mp4");
  fs.writeFileSync(source, "fixture");
  fs.writeFileSync(path.join(dir, "05_timeline", "timeline.json"), JSON.stringify({
    version: "1", project_id: "s4a-red", created_at: "2026-08-16T00:00:00Z",
    sequence: { name: "S4A RED", fps_num: 30, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
    tracks: { video: [{ track_id: "V1", kind: "video", clips: [{
      clip_id: "CLP_1", segment_id: "SEG_1", asset_id: "AST_1", src_in_us: 0,
      src_out_us: 1_000_000, timeline_in_frame: 0, timeline_duration_frames: 30,
      role: "hero", motivation: "treated", beat_id: "b1", fallback_segment_ids: [],
      confidence: 1, quality_flags: [], metadata: { render: { effects } },
    }] }], audio: [] }, markers: [],
    provenance: { brief_path: "brief", blueprint_path: "blueprint", selects_path: "selects", compiler_version: "test" },
  }));
  const map = path.join(dir, "map.json");
  fs.writeFileSync(map, JSON.stringify({ AST_1: source }));
  return { dir, source, map };
}

function runExport(args: string[]) {
  const result = spawnSync(tsx, [path.join(repoRoot, "scripts/export-premiere-xml.ts"), ...args], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function timelineRevisionArgs(timelinePath: string): string[] {
  const stat = fs.statSync(timelinePath, { bigint: true });
  const identity = {
    dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode), nlink: Number(stat.nlink),
    size: Number(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs),
  };
  const sha = `sha256:${createHash("sha256").update(fs.readFileSync(timelinePath)).digest("hex")}`;
  return ["--expected-timeline-sha256", sha, "--expected-timeline-identity-json", Buffer.from(JSON.stringify(identity)).toString("base64url")];
}

afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe("S4A public export fail-first contract", () => {
  it("revision-bound preflight child requires expected revision flags and emits the exact used revision", () => {
    const fixture = projectWithTreatment([{ type: "contrast", params: { value: 1.2 } }]);
    const timelinePath = path.join(fixture.dir, "05_timeline", "timeline.json");
    const revisionArgs = timelineRevisionArgs(timelinePath);

    const missing = runExport([fixture.dir, "--source-map", fixture.map, "--preflight", "--json"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("invalid_preflight_contract");

    const stable = runExport([fixture.dir, "--source-map", fixture.map, "--preflight", "--json", ...revisionArgs]);
    expect(stable.status).toBe(1);
    const stableJson = JSON.parse(stable.stdout) as Record<string, unknown>;
    expect(stableJson.child_used_timeline_sha256).toBe(revisionArgs[1]);
    expect(stableJson.child_used_timeline_identity).toEqual(JSON.parse(Buffer.from(revisionArgs[3], "base64url").toString("utf8")));

    const wrongSha = runExport([
      fixture.dir, "--source-map", fixture.map, "--preflight", "--json",
      "--expected-timeline-sha256", `sha256:${"0".repeat(64)}`,
      "--expected-timeline-identity-json", revisionArgs[3],
    ]);
    expect(wrongSha.status).toBe(1);
    expect(JSON.parse(wrongSha.stdout)).toEqual({
      version: "premiere-preflight-revision/v1",
      project_id: "s4a-red",
      status: "timeline_revision_mismatch",
      expected_timeline_sha256: `sha256:${"0".repeat(64)}`,
      observed_timeline_sha256: revisionArgs[1],
      expected_timeline_identity: JSON.parse(Buffer.from(revisionArgs[3], "base64url").toString("utf8")),
      observed_timeline_identity: JSON.parse(Buffer.from(revisionArgs[3], "base64url").toString("utf8")),
      hardware_verified: false,
      items: [],
    });
  });

  it("RED_PUBLIC_EXPORT_REPEATED_BRIGHTNESS_NOT_BLOCKED", () => {
    const fixture = projectWithTreatment([
      { type: "brightness", params: { value: 0.1 } },
      { type: "brightness", params: { value: 0.2 } },
    ]);
    const result = runExport([fixture.dir, "--source-map", fixture.map]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("visual_bake_repeated_effect_type");
  });

  it("RED_PUBLIC_EXPORT_EQ_STANDALONE_OVERLAP_NOT_BLOCKED", () => {
    const fixture = projectWithTreatment([
      { type: "eq", params: { brightness: 0.1 } },
      { type: "brightness", params: { value: 0.2 } },
    ]);
    const result = runExport([fixture.dir, "--source-map", fixture.map]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("visual_bake_effect_component_overlap");
  });

  it("requires explicit bake consent instead of exporting untreated source", () => {
    const fixture = projectWithTreatment([{ type: "contrast", params: { value: 1.2 } }]);
    const result = runExport([fixture.dir, "--source-map", fixture.map, "--json"]);
    expect(result.status).toBe(2);
    expect(fs.existsSync(path.join(fixture.dir, "09_output", "s4a-red_premiere.xml"))).toBe(false);
  });

  it("reports source_unverified without creating output when preflight authority is incomplete", () => {
    const fixture = projectWithTreatment([{ type: "contrast", params: { value: 1.2 } }]);
    const result = runExport([
      fixture.dir, "--source-map", fixture.map, "--preflight", "--json",
      ...timelineRevisionArgs(path.join(fixture.dir, "05_timeline", "timeline.json")),
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ clips: [{ clip_id: "CLP_1", status: "source_unverified" }] });
    expect(fs.existsSync(path.join(fixture.dir, "09_output"))).toBe(false);
  });
});

function clip(metadata: Record<string, unknown>): ClipOutput {
  return { clip_id: "C", segment_id: "S", asset_id: "AST", src_in_us: 0, src_out_us: 100_000, timeline_in_frame: 0, timeline_duration_frames: 3, role: "primary", motivation: "test", beat_id: "b", fallback_segment_ids: [], confidence: 1, quality_flags: [], metadata };
}

function timeline(value: ClipOutput, fpsNum = 30, fpsDen = 1): TimelineIR {
  return { version: "1", project_id: "p", created_at: "2026-08-16T00:00:00Z", sequence: { name: "p", fps_num: fpsNum, fps_den: fpsDen, width: 1920, height: 1080, start_frame: 0 }, tracks: { video: [{ track_id: "V1", kind: "video", clips: [value] }], audio: [] }, markers: [], provenance: { brief_path: "b", blueprint_path: "p", selects_path: "s", compiler_version: "test" } };
}

describe("closed premiere visual treatment", () => {
  it("keeps producer request/cache identity stable across distinct preflight runs", () => {
    const request = { version: "premiere-effect-bake-request/v1", clip_id: "C", effect: "brightness" };
    const producerRequestSha = sha256Prefixed(`premiere-effect-bake-request/v1\0${canonicalJson(request)}`);
    const runOne = bindPremiereEffectBakeRequestSha(producerRequestSha, `sha256:${"1".repeat(64)}`);
    const runTwo = bindPremiereEffectBakeRequestSha(producerRequestSha, `sha256:${"2".repeat(64)}`);
    expect(runOne).toBe(producerRequestSha);
    expect(runTwo).toBe(producerRequestSha);
    expect(runOne).toBe(runTwo);
  });

  it("evaluation to final request association preserves distinct immutable hash domains", () => {
    const source = fs.readFileSync(path.join(repoRoot, "runtime/handoff/premiere-effect-bake.ts"), "utf8");
    expect(source).toContain("premiere-effect-bake-evaluation/v2");
    expect(source).toContain("premiere-effect-bake-evaluation-association/v1");
    expect(source).toContain("ffmpeg_discovery_receipt_sha256");
    expect(source).toContain("broker_invocation_receipt_sha256");
    expect(source).toContain("evaluation_sha256");
    expect(source).toContain("association.ffmpeg_version_invocation_receipt.receipt_sha256");
    expect(source).toContain("association.request_sha256 !== context.requestSha");
    expect(source).toContain("bindPremiereEffectBakeRequestSha(base.requestSha, evaluationSha)");
    expect(source).not.toContain("sha256Prefixed(canonicalJson(requestEnvelope))");
  });

  it("runtime preflight process broker is selected only by the JSON preflight branch", () => {
    const exporter = fs.readFileSync(path.join(repoRoot, "scripts/export-premiere-xml.ts"), "utf8");
    const preflightBranch = exporter.slice(exporter.indexOf("if (preflight)"), exporter.indexOf("const blocked =", exporter.indexOf("if (preflight)")));
    expect(preflightBranch).toContain("preflightPremiereEffectBakesBrokered");
    expect(preflightBranch).toContain("jsonOutput");
    expect(preflightBranch).toContain("new PremierePreflightProcessBroker");
    expect(preflightBranch).not.toMatch(/preparePremiereEffectBakes|timelineToFcp7Xml|publishExportGeneration|renderAndPublishBake/);

    const broker = fs.readFileSync(path.join(repoRoot, "runtime/handoff/premiere-preflight-process-broker.ts"), "utf8");
    expect(broker).toContain('import { spawn } from "node:child_process"');
    expect(broker).toContain("forbidden_process");
    expect(broker).toContain("network or response-file argv rejected");
    expect(broker).not.toMatch(/kind:\s*["'](?:render|bake|transcode|write|output)["']/);
  });

  it.each(["eq", "brightness", "contrast", "saturation"])("GREEN_REJECTS_REPEATED_EFFECT_TYPE %s", (type) => {
    const params = type === "eq" ? { brightness: 0.1 } : { value: type === "brightness" ? 0.1 : 1.1 };
    expect(() => normalizePremiereVisualTreatment(clip({ render: { effects: [{ type, params }, { type, params }] } }), 1920, 1080)).toThrow(/visual_bake_repeated_effect_type/);
  });

  it.each(["brightness", "contrast", "saturation"])("GREEN_REJECTS_EQ_%s_STANDALONE_OVERLAP", (type) => {
    const value = type === "brightness" ? 0.1 : 1.1;
    expect(() => normalizePremiereVisualTreatment(clip({ render: { effects: [{ type: "eq", params: { [type]: value } }, { type, params: { value } }] } }), 1920, 1080)).toThrow(/visual_bake_effect_component_overlap/);
  });

  it("GREEN_REJECTS_EQ_GAMMA_STANDALONE_OVERLAP_BEFORE_TYPE_CHECK", () => {
    expect(() => normalizePremiereVisualTreatment(clip({ render: { effects: [{ type: "eq", params: { gamma: 1.1 } }, { type: "gamma", params: { value: 1.1 } }] } }), 1920, 1080)).toThrow(/visual_bake_effect_component_overlap/);
  });

  it("normalizes aliases, negative zero, literal pixels, and preserves effect order", () => {
    const normalized = normalizePremiereVisualTreatment(clip({ zoom: 1.25, crop: { x: 0, y: 0, width: 1280, height: 720 }, position: { x: -0, y: 4 }, render: { effects: [{ type: "contrast", params: { value: 1.2 } }, { type: "brightness", params: { brightness: 0.1 } }] } }), 1920, 1080);
    expect(normalized.transform.position).toEqual({ x: 0, y: 4 });
    expect(normalized.effects).toEqual([{ type: "contrast", params: { contrast: 1.2 } }, { type: "brightness", params: { brightness: 0.1 } }]);
  });

  it.each([
    [{ zoom: 1 }], [{ position: { x: 0, y: 0 } }], [{ render: { effects: [] } }],
    [{ render: { effects: [{ type: "brightness", params: { value: 0 } }] } }],
  ])("rejects declared no-op %#", (metadata) => {
    expect(() => normalizePremiereVisualTreatment(clip(metadata as Record<string, unknown>), 1920, 1080)).toThrow(/visual_bake_declared_noop/);
  });

  it.each([
    ["brightness", 0.0000001],
    ["brightness", -0.0000001],
    ["contrast", 1.0000001],
    ["contrast", 0.9999999],
    ["saturation", 1.0000001],
    ["saturation", 0.9999999],
  ])("rejects %s values that six-decimal rendering turns into identity", (type, value) => {
    expect(() => normalizePremiereVisualTreatment(clip({ render: { effects: [{ type, params: { value } }] } }), 1920, 1080)).toThrow(/visual_bake_declared_noop/);
  });

  it("rejects an identity-rendered eq component even when another component remains effective", () => {
    expect(() => normalizePremiereVisualTreatment(clip({ render: { effects: [{ type: "eq", params: { brightness: 0.0000001, contrast: 1.2 } }] } }), 1920, 1080)).toThrow(/visual_bake_declared_noop/);
  });

  it("freezes shared order, BT.709 limited tail, and single-thread bframes=0 argv", () => {
    const value = clip({ zoom: 1.5, position: { x: 10, y: -5 }, render: { effects: [{ type: "contrast", params: { value: 1.2 } }] } });
    const t = timeline(value, 30000, 1001);
    const normalized = normalizePremiereVisualTreatment(value, 1920, 1080);
    const graph = buildPremiereBakeFiltergraph(normalized, t, value, "pc");
    expect(graph).toContain("scale=2880:1620:force_original_aspect_ratio=increase,crop=1920:1080");
    expect(graph).toContain("eq=contrast=1.2,format=yuv420p,setsar=1,colorspace=");
    expect(graph).toContain("irange=pc:space=bt709:trc=bt709:primaries=bt709:range=tv:format=yuv420p:fast=0,setsar=1");
    const argv = buildPremiereBakeFfmpegArgv(value, t, graph);
    expect(argv).toContain("threads=1:lookahead_threads=1:sliced_threads=0:sync-lookahead=0:bframes=0");
    expect(argv).toContain("30000/1001");
    expect(argv).toContain("-an");
  });

  it("classifies every video clip exactly once", () => {
    expect(classifyPremiereVideoTreatments(timeline(clip({ zoom: 1.1 })))).toMatchObject([{ status: "bake_required", clip_id: "C", track_id: "V1" }]);
  });

  it("closes the persisted request, probe, and packet evidence schemas", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas/premiere-effect-bake-manifest.schema.json"), "utf8"));
    expect(schema.$defs.request.additionalProperties).toBe(false);
    expect(schema.$defs.probe.additionalProperties).toBe(false);
    expect(schema.$defs.probe.properties.format.additionalProperties).toBe(false);
    expect(schema.$defs.probe.properties.video.additionalProperties).toBe(false);
    expect(schema.$defs.packetEvidence.additionalProperties).toBe(false);
  });
});
