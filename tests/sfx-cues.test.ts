import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  projectSfxToTimeline,
  resolveSfxCuePlan,
} from "../runtime/audio/sfx-cues.js";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { runProjectSfxCues } from "../scripts/project-sfx-cues.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function hashBytes(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-cues-"));
  roots.push(root);
  const libraryRoot = path.join(root, "library");
  const audioDir = path.join(libraryRoot, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const sourcePath = path.join(audioDir, "soft-impact.wav");
  const sourceBytes = Buffer.from("deterministic-sfx-fixture");
  fs.writeFileSync(sourcePath, sourceBytes);

  const manifestPath = path.join(libraryRoot, "sfx-library.json");
  const manifest = {
    version: "sfx-library/v1",
    library_id: "video-os-test-sfx",
    library_version: "1.0.0",
    assets: [{
      asset_id: "sfx-soft-impact-01",
      semantic_roles: ["hook_impact", "simple_sound"],
      path: "audio/soft-impact.wav",
      content_hash: hashBytes(sourceBytes),
      size_bytes: sourceBytes.length,
      duration_us: 600_000,
      rights: {
        status: "confirmed",
        basis: "deterministic_synthesis",
        usage_scope: "internal_audition",
        evidence_ref: "evidence:fixture-synthesis-rights",
      },
      provenance: {
        origin: "deterministic_synthesis",
        source_ref: "provenance:fixture-soft-impact-v1",
        generated_at: "2026-07-28T00:00:00Z",
      },
    }],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHash = hashBytes(fs.readFileSync(manifestPath));

  const timeline: TimelineIR = {
    version: "7",
    project_id: "sfx-phase4-test",
    created_at: "2026-07-28T00:00:00Z",
    sequence: {
      name: "phase4",
      fps_num: 30_000,
      fps_den: 1_001,
      width: 1080,
      height: 1920,
      start_frame: 0,
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "V1_MAIN",
          segment_id: "SEG_MAIN",
          asset_id: "AST_MAIN",
          src_in_us: 0,
          src_out_us: 10_010_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 300,
          role: "hero",
          motivation: "fixture",
          beat_id: "",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
      audio_policy: { mode: "ducking", source: "explicit_brief" },
    },
  };
  const timelinePath = path.join(root, "timeline.json");
  fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);

  const cuesPath = path.join(root, "sfx_cues.json");
  const cues = {
    version: "sfx-cues/v1",
    project_id: timeline.project_id,
    base_timeline_version: timeline.version,
    timeline_fps: { num: 30_000, den: 1_001 },
    required: true,
    library: {
      manifest_path: manifestPath,
      library_id: manifest.library_id,
      library_version: manifest.library_version,
      manifest_hash: manifestHash,
    },
    cues: [{
      cue_id: "SFX_HOOK_000030",
      semantic_role: "hook_impact",
      asset_id: "sfx-soft-impact-01",
      trigger_frame: 30,
      duration_frames: 15,
      source_range: { in_us: 0, out_us: 600_000 },
      gain_db: -18,
      fade_in_ms: 8,
      fade_out_ms: 120,
      tail: { max_frames: 5, policy: "trim_or_pad_to_limit" },
      duck_group: "dialogue",
      ducking: {
        duck_gain_db: -24,
        attack_ms: 10,
        release_ms: 180,
      },
      asset_pin: {
        library_id: manifest.library_id,
        library_version: manifest.library_version,
        library_manifest_hash: manifestHash,
        asset_content_hash: manifest.assets[0].content_hash,
        asset_size_bytes: manifest.assets[0].size_bytes,
        rights_evidence_ref: manifest.assets[0].rights.evidence_ref,
        provenance_ref: manifest.assets[0].provenance.source_ref,
      },
      intent: "subtle technical hook accent",
    }],
  };
  fs.writeFileSync(cuesPath, `${JSON.stringify(cues, null, 2)}\n`);

  return {
    root,
    libraryRoot,
    manifestPath,
    manifest,
    timeline,
    timelinePath,
    cuesPath,
    cues,
  };
}

describe("formal SFX library and cue contract", () => {
  it("resolves verified pins, rational timing, tail policy, and projects idempotently to A3", () => {
    const input = fixture();
    const plan = resolveSfxCuePlan({
      projectDir: input.root,
      timeline: input.timeline,
      cuesPath: input.cuesPath,
    });
    expect(plan).not.toHaveProperty("decision_ref");
    expect(plan.cues[0]).not.toHaveProperty("decision_pin");

    expect(plan).toMatchObject({
      version: "resolved-sfx-cues/v1",
      project_id: "sfx-phase4-test",
      required: true,
      library: {
        library_id: "video-os-test-sfx",
        library_version: "1.0.0",
      },
      cues: [{
        cue_id: "SFX_HOOK_000030",
        source_path: fs.realpathSync(
          path.join(input.libraryRoot, "audio", "soft-impact.wav"),
        ),
        timeline_range: { in_frame: 30, out_frame: 50 },
        tail_processing: {
          requested_tail_frames: 5,
          applied_tail_frames: 5,
          timeline_action: "kept",
          source_action: "padded",
        },
      }],
    });

    const projected = projectSfxToTimeline(input.timeline, plan);
    const projectedAgain = projectSfxToTimeline(projected, plan);
    const a3 = projected.tracks.audio.find((track) => track.track_id === "A3");
    expect(a3).toMatchObject({
      role: "sfx",
      clips: [{
        clip_id: "A3_SFX_HOOK_000030",
        role: "sfx",
        timeline_in_frame: 30,
        timeline_duration_frames: 20,
        metadata: {
          sfx_cue: {
            cue_id: "SFX_HOOK_000030",
            dialogue_finish_applied: false,
          },
          sfx_asset: {
            library_id: "video-os-test-sfx",
            asset_content_hash: input.manifest.assets[0].content_hash,
          },
        },
      }],
    });
    expect(a3?.clips[0].metadata?.sfx_cue).not.toHaveProperty("decision_pin");
    expect(projectedAgain).toEqual(projected);
  });

  it("trims only the permitted tail at the timeline boundary using rational frames", () => {
    const input = fixture();
    input.cues.cues[0].trigger_frame = 286;
    input.cues.cues[0].duration_frames = 10;
    input.cues.cues[0].tail.max_frames = 10;
    fs.writeFileSync(input.cuesPath, `${JSON.stringify(input.cues, null, 2)}\n`);

    const plan = resolveSfxCuePlan({
      projectDir: input.root,
      timeline: input.timeline,
      cuesPath: input.cuesPath,
    });
    expect(plan.cues[0]).toMatchObject({
      timeline_range: { in_frame: 286, out_frame: 300 },
      tail_processing: {
        requested_tail_frames: 10,
        applied_tail_frames: 4,
        timeline_action: "trimmed_to_timeline",
      },
    });
  });

  it.each([
    ["unknown asset", (input: ReturnType<typeof fixture>) => {
      input.cues.cues[0].asset_id = "missing";
    }, /unknown SFX asset/],
    ["hash mismatch", (input: ReturnType<typeof fixture>) => {
      input.cues.cues[0].asset_pin.asset_content_hash = `sha256:${"f".repeat(64)}`;
    }, /asset_content_hash/],
    ["unsafe path", (input: ReturnType<typeof fixture>) => {
      input.manifest.assets[0].path = "../outside.wav";
      fs.writeFileSync(input.manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`);
      input.cues.library.manifest_hash = hashBytes(fs.readFileSync(input.manifestPath));
      input.cues.cues[0].asset_pin.library_manifest_hash =
        input.cues.library.manifest_hash;
    }, /path|outside the SFX library root/],
  ])("fails closed for %s", (_label, mutate, expected) => {
    const input = fixture();
    mutate(input);
    fs.writeFileSync(input.cuesPath, `${JSON.stringify(input.cues, null, 2)}\n`);
    expect(() => resolveSfxCuePlan({
      projectDir: input.root,
      timeline: input.timeline,
      cuesPath: input.cuesPath,
    })).toThrow(expected);
  });

  it("keeps dry-run write-free and refuses an existing explicit output", () => {
    const input = fixture();
    const dryRun = runProjectSfxCues({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      cuesPath: input.cuesPath,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      dry_run: true,
      wrote_files: false,
      a3_clip_count: 1,
    });
    const outputPath = path.join(input.root, "projected.json");
    fs.writeFileSync(outputPath, "owned");
    expect(() => runProjectSfxCues({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      cuesPath: input.cuesPath,
      outputPath,
      dryRun: false,
    })).toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("owned");
    expect(() => runProjectSfxCues({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      cuesPath: input.cuesPath,
      outputPath: input.root,
      dryRun: false,
    })).toThrow(/unsafe output path/);
  });
});
