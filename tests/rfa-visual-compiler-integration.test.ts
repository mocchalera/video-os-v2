import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { extractClipTransform } from "../runtime/render/assembler.js";
import { loadFramingPolicy } from "../runtime/visual/framing-policy.js";
import { resolveVisionAssistedReframe } from "../runtime/visual/reframe.js";

const SAMPLE_PROJECT = path.resolve("projects/sample");
const POLICY_FIXTURE = path.resolve("tests/fixtures/rfa-visual/framing_policy.json");
const HASH_A = `sha256:${"a".repeat(64)}`;
const CREATED_AT = "2026-08-21T00:00:00Z";
const temporaryProjects: string[] = [];

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else fs.copyFileSync(sourcePath, destinationPath);
  }
}

function createProject(): string {
  const project = path.resolve("tests", `tmp_rfa_visual_${Date.now()}`);
  copyDirectory(SAMPLE_PROJECT, project);
  temporaryProjects.push(project);
  return project;
}

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
});

describe("RFA-008/009/010 compiler projection", () => {
  it("loads the project framing policy and projects the registered intent into canonical timeline provenance", () => {
    const project = createProject();
    const sourceMapDir = path.join(project, "02_media");
    fs.mkdirSync(sourceMapDir, { recursive: true });
    fs.writeFileSync(path.join(sourceMapDir, "source_map.json"), JSON.stringify({
      version: "1",
      project_id: "sample-mountain-reset",
      media_dir: "02_media",
      generated_at: CREATED_AT,
      items: [{
        asset_id: "AST_005",
        source_locator: "anonymous-source.mov",
        source_content_sha256: HASH_A,
      }],
    }, null, 2));
    fs.copyFileSync(POLICY_FIXTURE, path.join(project, "04_plan/framing_policy.json"));
    fs.writeFileSync(path.join(project, "03_analysis/assets.json"), JSON.stringify({ items: [{ asset_id: "AST_005", video_stream: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 }, audio_stream: { sample_rate: 48000, channels: 2 } }] }, null, 2));
    fs.copyFileSync(path.resolve("tests/fixtures/rfa-vertical/vertical-composition-policy.json"), path.join(project, "04_plan/vertical-composition-policy.json"));

    const first = compile({ projectPath: project, createdAt: CREATED_AT });
    const target = first.timeline.tracks.video[0].clips[0];
    const blueprintPath = path.join(project, "04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(blueprintPath, stringifyYaml({
      ...blueprint,
      policy_refs: {
        composition_policy_ref: {
          ref: "04_plan/framing_policy.json",
          version: "framing-policy/v1",
        },
        vertical_composition_policy_ref: {
          ref: "04_plan/vertical-composition-policy.json",
          version: "vertical-composition-policy/v1",
        },
      },
      visual_intents: [{
        intent_id: "VIS_COMPILE_001",
        policy: "registered-visual-intent/v1",
        mode: "continuous_transform",
        framing_mode: "punch",
        reason: "anonymous compiler integration framing intent",
        target: { clip_id: target.clip_id },
        transform: { zoom: 1.2, position: { x: -10, y: 6 } },
        framing_input: {
          observations: [{
            time_us: 1_000_000,
            person: { x: 0.35, y: 0.2, width: 0.3, height: 0.3, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            head: { x: 0.35, y: 0.2, width: 0.3, height: 0.3, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            hands: [],
          }, {
            time_us: 2_000_000,
            person: { x: 0.35, y: 0.2, width: 0.3, height: 0.3, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            head: { x: 0.35, y: 0.2, width: 0.3, height: 0.3, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            hands: [],
          }, {
            time_us: 3_000_000,
            person: { x: 0.02, y: 0.2, width: 0.9, height: 0.9, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            head: { x: 0.02, y: 0.2, width: 0.9, height: 0.9, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            hands: [],
          }],
          output: { width: 1920, height: 1080 },
        },
        source_evidence: [{
          asset_id: target.asset_id,
          segment_id: target.segment_id,
          source_content_hash: HASH_A,
          source_range: { src_in_us: target.src_in_us, src_out_us: target.src_out_us },
        }],
        confidence: 0.87,
      }],
    }));
    fs.rmSync(path.join(project, "05_timeline/timeline.json"));

    const result = compile({ projectPath: project, createdAt: CREATED_AT });
    expect(extractClipTransform(result.timeline.tracks.video[0].clips[0])).toMatchObject({
      zoom: 1.2,
      position: { x: -10, y: 6 },
    });
    expect(result.timeline.provenance.visual_framing).toMatchObject({
      policy: "registered-visual-intents/v1",
      framing_policy_ref: "04_plan/framing_policy.json",
      framing_policy_id: "anonymous-framing-policy-v1",
      source_av_preserved: true,
    });
    expect(result.timeline.provenance.visual_framing?.applied_intents[0]).toMatchObject({
      intent_id: "VIS_COMPILE_001",
      mode: "continuous_transform",
    });
    expect(result.timeline.provenance.vertical_composition?.results[0]).toMatchObject({ status: "degraded", reason: expect.stringContaining("occupancy=0.8100") });
    expect(() => validateArtifact(result.timeline, "timeline-ir.schema.json")).not.toThrow();
  });

  it("fails clearly when a registered visual intent has no policy artifact", () => {
    const project = createProject();
    const blueprintPath = path.join(project, "04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(blueprintPath, stringifyYaml({
      ...blueprint,
      visual_intents: [{
        intent_id: "VIS_MISSING_POLICY",
        policy: "registered-visual-intent/v1",
        mode: "continuous_transform",
        reason: "must not silently use hidden defaults",
        target: { clip_id: "CLP_0001" },
        transform: { zoom: 1.1 },
        framing_input: {
          observations: [{
            person: { x: 0.38, y: 0.2, width: 0.24, height: 0.28, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            head: { x: 0.38, y: 0.2, width: 0.24, height: 0.28, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            hands: [],
          }],
          output: { width: 1920, height: 1080 },
        },
        source_evidence: [{
          asset_id: "AST_005",
          segment_id: "SEG_0025",
          source_content_hash: HASH_A,
          source_range: { src_in_us: 1_400_000, src_out_us: 6_000_000 },
        }],
      }],
    }));
    expect(() => compile({ projectPath: project, createdAt: CREATED_AT })).toThrow(/composition_policy_ref/);
  });

  it("routes a policy-violating Blueprint transform through safe-degrade before canonical export", () => {
    const project = createProject();
    const sourceMapDir = path.join(project, "02_media");
    fs.mkdirSync(sourceMapDir, { recursive: true });
    fs.writeFileSync(path.join(sourceMapDir, "source_map.json"), JSON.stringify({
      version: "1",
      project_id: "sample-mountain-reset",
      media_dir: "02_media",
      generated_at: CREATED_AT,
      items: [{ asset_id: "AST_005", source_locator: "anonymous-source.mov", source_content_sha256: HASH_A }],
    }, null, 2));
    const policyPath = path.join(project, "04_plan/framing_policy.json");
    const restrictivePolicy = JSON.parse(fs.readFileSync(POLICY_FIXTURE, "utf8")) as Record<string, any>;
    restrictivePolicy.modes.punch.max_zoom = 1.01;
    fs.writeFileSync(policyPath, JSON.stringify(restrictivePolicy, null, 2));
    const first = compile({ projectPath: project, createdAt: CREATED_AT });
    const target = first.timeline.tracks.video[0].clips[0];
    const blueprintPath = path.join(project, "04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(blueprintPath, stringifyYaml({
      ...blueprint,
      policy_refs: { composition_policy_ref: { ref: "04_plan/framing_policy.json", version: "framing-policy/v1" } },
      visual_intents: [{
        intent_id: "VIS_COMPILE_POLICY_GUARD",
        policy: "registered-visual-intent/v1",
        mode: "continuous_transform",
        framing_mode: "punch",
        reason: "compiler must resolve a policy-bound punch before export",
        target: { clip_id: target.clip_id },
        transform: { zoom: 8 },
        framing_input: {
          observations: [{
            person: { x: 0.38, y: 0.2, width: 0.24, height: 0.28, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            head: { x: 0.38, y: 0.2, width: 0.24, height: 0.28, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
            hands: [],
          }],
          output: { width: 1920, height: 1080 },
        },
        source_evidence: [{
          asset_id: target.asset_id,
          segment_id: target.segment_id,
          source_content_hash: HASH_A,
          source_range: { src_in_us: target.src_in_us, src_out_us: target.src_out_us },
        }],
      }],
    }));
    fs.rmSync(path.join(project, "05_timeline/timeline.json"));

    const result = compile({ projectPath: project, createdAt: CREATED_AT });
    const clip = result.timeline.tracks.video[0].clips[0];
    expect(clip.metadata?.zoom).toBeLessThanOrEqual(1.01);
    expect(clip.metadata?.visual_framing).toMatchObject({
      framing_result: { status: "degraded", requested_mode: "punch" },
    });
  });

  it("adopts a verified vision candidate only when the Blueprint pins its ref and hash", async () => {
    const project = createProject();
    const sourceMapDir = path.join(project, "02_media");
    fs.mkdirSync(sourceMapDir, { recursive: true });
    fs.writeFileSync(path.join(sourceMapDir, "source_map.json"), JSON.stringify({
      version: "1",
      project_id: "sample-mountain-reset",
      media_dir: "02_media",
      generated_at: CREATED_AT,
      items: [{ asset_id: "AST_005", source_locator: "anonymous-source.mov", source_content_sha256: HASH_A }],
    }, null, 2));
    fs.copyFileSync(POLICY_FIXTURE, path.join(project, "04_plan/framing_policy.json"));
    const first = compile({ projectPath: project, createdAt: CREATED_AT });
    const target = first.timeline.tracks.video[0].clips[0];
    const framingPolicy = loadFramingPolicy(path.join(project, "04_plan/framing_policy.json"));
    const candidate = await resolveVisionAssistedReframe({
      source: {
        asset_id: target.asset_id,
        segment_id: target.segment_id,
        source_content_hash: HASH_A,
        source_range: { src_in_us: target.src_in_us, src_out_us: target.src_out_us },
      },
      output: { width: first.timeline.sequence.width, height: first.timeline.sequence.height },
      mode: "punch",
      policy: framingPolicy,
    }, {
      adapter_id: "anonymous-local-vision",
      adapter_version: "1.0.0",
      provider: { id: "anonymous-provider", version: "1.0.0" },
      model: { id: "anonymous-detector", version: `weights-sha256:${"d".repeat(64)}` },
      analyze: async () => ({
        status: "ready" as const,
        observations: [{
          time_us: 1_000_000,
          person: { x: 0.38, y: 0.2, width: 0.24, height: 0.28, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
          head: { x: 0.38, y: 0.2, width: 0.24, height: 0.28, eye_x: 0.5, eye_y: 0.45, yaw_radians: 0, confidence: 0.96 },
          hands: [],
        }],
        model: { id: "anonymous-detector", version: `weights-sha256:${"d".repeat(64)}` },
        cache: { status: "hit" as const, key: "candidate-cache-001" },
      }),
    });
    const candidateRef = "04_plan/reframe_candidates/vision-001.json";
    fs.mkdirSync(path.dirname(path.join(project, candidateRef)), { recursive: true });
    fs.writeFileSync(path.join(project, candidateRef), JSON.stringify(candidate, null, 2));
    const blueprintPath = path.join(project, "04_plan/edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(blueprintPath, stringifyYaml({
      ...blueprint,
      policy_refs: { composition_policy_ref: { ref: "04_plan/framing_policy.json", version: "framing-policy/v1" } },
      visual_intents: [{
        intent_id: "VIS_CANDIDATE_001",
        policy: "registered-visual-intent/v1",
        mode: "continuous_transform",
        framing_mode: "punch",
        reason: "verified local candidate is the registered framing evidence",
        target: { clip_id: target.clip_id },
        reframe_candidate_ref: candidateRef,
        reframe_candidate_hash: candidate.candidate_hash,
        source_evidence: [{
          asset_id: target.asset_id,
          segment_id: target.segment_id,
          source_content_hash: HASH_A,
          source_range: { src_in_us: target.src_in_us, src_out_us: target.src_out_us },
        }],
        confidence: 0.92,
      }],
    }));
    fs.rmSync(path.join(project, "05_timeline/timeline.json"));

    const result = compile({ projectPath: project, createdAt: CREATED_AT });
    const applied = result.timeline.provenance.visual_framing?.applied_intents[0];
    expect(applied).toMatchObject({
      intent_id: "VIS_CANDIDATE_001",
      reframe_candidate_ref: candidateRef,
      reframe_candidate_hash: candidate.candidate_hash,
    });
    expect(applied?.framing_result).toEqual(candidate.result);
    expect(() => validateArtifact(result.timeline, "timeline-ir.schema.json")).not.toThrow();

    const currentPolicy = JSON.parse(fs.readFileSync(path.join(project, "04_plan/framing_policy.json"), "utf8")) as {
      policy_id: string;
      version: string;
      modes: Record<string, { max_zoom: number }>;
    };
    expect(currentPolicy.policy_id).toBe(candidate.framing_policy.id);
    expect(currentPolicy.version).toBe(candidate.framing_policy.version);
    currentPolicy.modes.punch.max_zoom = 1.01;
    fs.writeFileSync(path.join(project, "04_plan/framing_policy.json"), JSON.stringify(currentPolicy, null, 2));
    fs.rmSync(path.join(project, "05_timeline/timeline.json"));
    expect(() => compile({ projectPath: project, createdAt: CREATED_AT })).toThrow(/framing policy content hash.*loaded framing_policy\.json/);
  });
});
