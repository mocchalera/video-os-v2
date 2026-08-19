import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeNormalizedJsonHash } from "../runtime/artifacts/p1-manifest-coverage.js";
import { selectBgmForProject } from "../runtime/music/selection-service.js";
import { summarizeTimelineForBgm } from "../runtime/music/selection-project-input.js";
import type { BgmPackManifest, BgmPackTrack } from "../runtime/music/pack-types.js";
import {
  parseSelectBgmArgs,
  runSelectBgmCli,
  SELECT_BGM_CLI_EXIT,
  type SelectBgmCliIo,
} from "../scripts/select-bgm.js";

const tempDirectories: string[] = [];

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-bgm-selection-"));
  tempDirectories.push(root);
  return root;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function axes(): BgmPackTrack["axes"] {
  const values: Record<string, number> = {
    energy: 0.42,
    valence: 0.62,
    tension: 0.12,
    warmth: 0.7,
    modernity: 0.55,
    playfulness: 0.1,
    sophistication: 0.72,
    organic_electronic: 0.45,
    density: 0.18,
    speech_friendliness: 0.95,
    beat_prominence: 0.62,
    build_strength: 0.45,
    ending_resolution: 0.94,
  };
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, source: "authored" }])) as BgmPackTrack["axes"];
}

function writeVerifiedPack(root: string): void {
  const packDir = path.join(root, "core-interview-1.0.0");
  fs.mkdirSync(path.join(packDir, "audio"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "rights"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "analysis"), { recursive: true });

  const fullMix = Buffer.from("RIFF-selection-full-mix");
  const preview = Buffer.from("RIFF-selection-preview");
  const fullMixHash = sha256(fullMix);
  fs.writeFileSync(path.join(packDir, "audio", "interview-bed.wav"), fullMix);
  fs.writeFileSync(path.join(packDir, "audio", "interview-bed-preview.wav"), preview);

  const rights = parseYaml(fs.readFileSync(path.resolve("tests/fixtures/bgm_contracts/valid_rights_register.yaml"), "utf8")) as Record<string, unknown>;
  const rightsItem = (rights.items as Array<Record<string, unknown>>)[0];
  rights.project_id = "selection-integration";
  rights.items = [rightsItem];
  rightsItem.asset_id = "interview-bed";
  rightsItem.content_hash = fullMixHash;
  (rightsItem.integrity as Record<string, unknown>).verified_hash = fullMixHash;
  const rightsBytes = Buffer.from(`${JSON.stringify(rights, null, 2)}\n`);
  fs.writeFileSync(path.join(packDir, "rights", "interview-bed.json"), rightsBytes);

  const analysis = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/bgm_contracts/valid_track_analysis.json"), "utf8")) as Record<string, unknown>;
  analysis.track_id = "interview-bed";
  analysis.input_content_hash = fullMixHash;
  analysis.analysis_hash = computeNormalizedJsonHash(analysis, ["analysis_hash", "created_at"]);
  const analysisBytes = Buffer.from(`${JSON.stringify(analysis, null, 2)}\n`);
  fs.writeFileSync(path.join(packDir, "analysis", "interview-bed.json"), analysisBytes);

  const track: BgmPackTrack = {
    track_id: "interview-bed",
    title: "Interview Bed",
    contributor_id: "fixture-contributor",
    duration_us: 90_000_000,
    format: "wav",
    full_mix: { path: "audio/interview-bed.wav", content_hash: fullMixHash, size_bytes: fullMix.byteLength, format: "wav" },
    preview: { path: "audio/interview-bed-preview.wav", content_hash: sha256(preview), size_bytes: preview.byteLength, format: "wav" },
    rights_ref: { path: "rights/interview-bed.json", content_hash: sha256(rightsBytes), size_bytes: rightsBytes.byteLength, format: "json" },
    analysis_ref: { path: "analysis/interview-bed.json", content_hash: sha256(analysisBytes), size_bytes: analysisBytes.byteLength, format: "json" },
    family: "trust_clarity",
    intensity: "low",
    use_cases: ["interview", "case_study"],
    exclusions: ["lead_vocal"],
    instruments: ["piano", "soft_synth"],
    edit_points_us: [0, 30_000_000, 60_000_000, 90_000_000],
    loop_windows: [{ in_us: 15_000_000, out_us: 45_000_000, max_repetitions: 2 }],
    axes: axes(),
    vocal_presence: "none",
  };
  const manifest: BgmPackManifest = {
    version: "1.0.0",
    pack_id: "core-interview",
    pack_version: "1.0.0",
    title: "Selection Integration Pack",
    created_at: "2026-07-16T00:00:00.000Z",
    catalog_license: "fixture-only",
    default_content_license: "CC0-1.0",
    compatible_video_os: { contract_min: "0.1.0", contract_max: "0.1.0" },
    tracks: [track],
    provenance: { producer: "Video OS tests", source_type: "bundled_pack", evidence_refs: [] },
    hash_policy: { algorithm: "sha256", canonicalization: "normalized-json-v1", excluded_fields: [] },
  };
  fs.writeFileSync(path.join(packDir, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function rewriteRightsStatus(packRoot: string, status: "licensed" | "operator_declared_ok"): void {
  const packDir = path.join(packRoot, "core-interview-1.0.0");
  const manifestPath = path.join(packDir, "pack-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BgmPackManifest;
  const rightsPath = path.join(packDir, manifest.tracks[0].rights_ref.path);
  const rights = JSON.parse(fs.readFileSync(rightsPath, "utf8")) as Record<string, unknown>;
  ((rights.items as Array<Record<string, unknown>>)[0]).rights_status = status;
  const bytes = Buffer.from(`${JSON.stringify(rights, null, 2)}\n`);
  fs.writeFileSync(rightsPath, bytes);
  manifest.tracks[0].rights_ref.content_hash = sha256(bytes);
  manifest.tracks[0].rights_ref.size_bytes = bytes.byteLength;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeProject(root: string): string {
  const projectDir = path.join(root, "selection-project");
  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "04_plan"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "01_intent", "creative_brief.yaml"), stringifyYaml({
    version: "1",
    project_id: "selection-integration",
    project: { title: "AX-1事例インタビュー", strategy: "経営者の実践と会社の変化", runtime_target_sec: 60 },
    message: { primary: "経営者本人がAIを使うことの価値" },
    audience: { primary: "経営者" },
    emotion_curve: ["before", "実践", "成果"],
    must_have: ["インタビュー"],
    must_avoid: ["lead vocal"],
    audio_policy: "ducking",
  }));
  fs.writeFileSync(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), stringifyYaml({
    version: "1",
    project_id: "selection-integration",
    beats: [
      { id: "b01", label: "before", purpose: "参加前", target_duration_frames: 450, required_roles: ["dialogue"] },
      { id: "b02", label: "after", purpose: "会社の変化", target_duration_frames: 1350, required_roles: ["dialogue"] },
    ],
    music_policy: { start_sparse: true, allow_release_late: true, permitted_energy_curve: "restrained_to_warm" },
    ending_policy: { should_feel: "resolved with余韻" },
  }));
  fs.writeFileSync(path.join(projectDir, "05_timeline", "timeline.json"), `${JSON.stringify({
    version: "2",
    project_id: "selection-integration",
    sequence: { fps_num: 30, fps_den: 1 },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [
        { timeline_in_frame: 0, timeline_duration_frames: 900 },
        { timeline_in_frame: 900, timeline_duration_frames: 900 },
      ] }],
      audio: [
        { track_id: "A1", kind: "audio", clips: [{ timeline_in_frame: 0, timeline_duration_frames: 1500, role: "dialogue" }] },
        { track_id: "A2", kind: "audio", clips: [{ timeline_in_frame: 0, timeline_duration_frames: 1800, role: "bgm" }] },
      ],
    },
  }, null, 2)}\n`);
  return projectDir;
}

function captureIo(): { io: SelectBgmCliIo; stdout: string[]; stderr: string[] } {
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

describe("BGM project selection service", () => {
  it("summarizes dialogue timing without counting A2 music as speech", () => {
    const summary = summarizeTimelineForBgm({
      sequence: { fps_num: 30, fps_den: 1 },
      tracks: { audio: [
        { track_id: "A1", kind: "audio", clips: [
          { timeline_in_frame: 0, timeline_duration_frames: 60, role: "dialogue" },
          { timeline_in_frame: 30, timeline_duration_frames: 60, role: "dialogue" },
        ] },
        { track_id: "A2", kind: "audio", clips: [{ timeline_in_frame: 0, timeline_duration_frames: 120, role: "bgm" }] },
      ] },
    });
    expect(summary.duration_us).toBe(4_000_000);
    expect(summary.speech_duration_us).toBe(3_000_000);
    expect(summary.speech_ratio).toBe(0.75);
  });

  it("writes a schema-valid, byte-stable suggestion trace from a verified pack", async () => {
    const root = tempRoot();
    const packRoot = path.join(root, "packs");
    fs.mkdirSync(packRoot);
    writeVerifiedPack(packRoot);
    const projectDir = writeProject(root);
    const options = {
      projectPath: projectDir,
      requestedMode: "suggest" as const,
      outputScope: "external" as const,
      packRoot,
      writeArtifact: true,
      createdAt: "2026-07-16T12:00:00.000Z",
    };

    const first = await selectBgmForProject(options);
    const outputPath = path.join(projectDir, "04_plan", "bgm_selection.json");
    const firstBytes = fs.readFileSync(outputPath, "utf8");
    const second = await selectBgmForProject(options);
    const secondBytes = fs.readFileSync(outputPath, "utf8");

    expect(first.ok).toBe(true);
    expect(first.wrote_artifact).toBe(true);
    expect(first.artifact.mode).toBe("suggest");
    expect(first.artifact.selected).toBeNull();
    expect(first.artifact.candidates).toContainEqual(expect.objectContaining({ track_id: "interview-bed", rank: 1, status: "ranked" }));
    expect(first.artifact.redistribution_trace.applied).toBe(true);
    expect(second.artifact).toEqual(first.artifact);
    expect(secondBytes).toBe(firstBytes);
  });

  it("keeps dry-run selection non-mutating through the CLI", async () => {
    const root = tempRoot();
    const packRoot = path.join(root, "packs");
    fs.mkdirSync(packRoot);
    writeVerifiedPack(packRoot);
    const projectDir = writeProject(root);
    const capture = captureIo();
    const exit = await runSelectBgmCli([
      "node", "select-bgm", "--project", projectDir, "--pack-root", packRoot, "--mode", "suggest", "--dry-run", "--json",
    ], capture.io, { select: selectBgmForProject, now: () => new Date("2026-07-16T12:00:00.000Z") });

    expect(exit).toBe(SELECT_BGM_CLI_EXIT.ok);
    expect(fs.existsSync(path.join(projectDir, "04_plan", "bgm_selection.json"))).toBe(false);
    const payload = JSON.parse(capture.stdout.join("")) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, requested_mode: "suggest", effective_mode: "suggest", wrote_artifact: false });
    expect(payload.top_candidates).toEqual([
      expect.objectContaining({ track_id: "interview-bed", rank: 1 }),
    ]);
    expect(JSON.stringify(payload)).not.toContain(projectDir);
  });

  it("hard-rejects operator-declared rights for external output", async () => {
    const root = tempRoot();
    const packRoot = path.join(root, "packs");
    fs.mkdirSync(packRoot);
    writeVerifiedPack(packRoot);
    rewriteRightsStatus(packRoot, "operator_declared_ok");
    const projectDir = writeProject(root);
    const result = await selectBgmForProject({
      projectPath: projectDir,
      requestedMode: "suggest",
      outputScope: "external",
      packRoot,
      writeArtifact: false,
      createdAt: "2026-07-16T12:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.artifact.candidates).toContainEqual(expect.objectContaining({
      track_id: "interview-bed",
      status: "rejected",
      rejection_reasons: expect.arrayContaining([
        expect.stringContaining("licensed rights evidence is required"),
      ]),
    }));
  });

  it("does not write a selection artifact when the brief disables BGM", async () => {
    const root = tempRoot();
    const packRoot = path.join(root, "packs");
    fs.mkdirSync(packRoot);
    writeVerifiedPack(packRoot);
    const projectDir = writeProject(root);
    const briefPath = path.join(projectDir, "01_intent", "creative_brief.yaml");
    const brief = parseYaml(fs.readFileSync(briefPath, "utf8")) as Record<string, unknown>;
    brief.audio_policy = "original_only";
    fs.writeFileSync(briefPath, stringifyYaml(brief));

    const result = await selectBgmForProject({
      projectPath: projectDir,
      requestedMode: "suggest",
      outputScope: "preview_internal",
      packRoot,
      writeArtifact: true,
      createdAt: "2026-07-16T12:00:00.000Z",
    });

    expect(result.wrote_artifact).toBe(false);
    expect(result.output_ref).toBeNull();
    expect(fs.existsSync(path.join(projectDir, "04_plan", "bgm_selection.json"))).toBe(false);
  });

  it("rejects invalid CLI scopes as usage errors", async () => {
    expect(() => parseSelectBgmArgs(["node", "select-bgm", "--project", "demo", "--scope", "internet"])).toThrow();
    const capture = captureIo();
    const exit = await runSelectBgmCli(["node", "select-bgm", "--project", "demo", "--scope", "internet", "--json"], capture.io);
    expect(exit).toBe(SELECT_BGM_CLI_EXIT.usage);
    expect(capture.stderr).toEqual([]);
  });
});
