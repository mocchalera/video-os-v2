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
import {
  parsePlanSoundDesignArgs,
  runPlanSoundDesign,
} from "../scripts/plan-sound-design.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function hash(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sound-design-cli-"));
  roots.push(root);
  const timeline: TimelineIR = {
    version: "7",
    project_id: "sound-design-cli-test",
    created_at: "2026-07-28T00:00:00Z",
    sequence: {
      name: "sound-design-cli",
      fps_num: 24,
      fps_den: 1,
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
          src_out_us: 25_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 600,
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
  const timelinePath = path.join(root, "05_timeline", "timeline.json");
  writeJson(timelinePath, timeline);

  const audioBytes = Buffer.from("formal-sfx-fixture");
  const audioPath = path.join(root, "sfx-library", "audio", "impact.wav");
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, audioBytes);
  const manifest = {
    version: "sfx-library/v1",
    library_id: "video-os-test-sfx",
    library_version: "1.0.0",
    scope: "project_local",
    review_status: "approved",
    assets: [{
      asset_id: "sfx-soft-impact-01",
      semantic_roles: ["hook_impact"],
      path: "audio/impact.wav",
      content_hash: hash(audioBytes),
      size_bytes: audioBytes.length,
      duration_us: 500_000,
      rights: {
        status: "confirmed",
        basis: "deterministic_synthesis",
        usage_scope: "project_render",
        evidence_ref: "rights:test-synthesis",
        verified_at: "2026-08-21T00:00:00Z",
        permitted_derivatives: ["project_render"],
      },
      provenance: {
        origin: "deterministic_synthesis",
        source_ref: "provenance:test-synthesis",
        generated_at: "2026-07-28T00:00:00Z",
        status: "verified",
        evidence_ref: "evidence:test-synthesis-provenance",
      },
      review_status: "approved",
    }],
  };
  const manifestPath = path.join(root, "sfx-library", "sfx-library.json");
  writeJson(manifestPath, manifest);
  const manifestHash = hash(fs.readFileSync(manifestPath));
  const request = {
    version: "sound-design-request/v1",
    project_id: timeline.project_id,
    base_timeline_version: timeline.version,
    timeline_fps: { num: 24, den: 1 },
    timeline_duration_frames: 600,
    timeline_ref: {
      path: timelinePath,
      content_hash: hash(fs.readFileSync(timelinePath)),
    },
    library: {
      manifest_path: manifestPath,
      library_id: manifest.library_id,
      library_version: manifest.library_version,
      manifest_hash: manifestHash,
      scope: "project_local",
    },
    candidates: [{
      candidate_id: "fracture-hook",
      semantic_role: "hook_impact",
      semantic_purpose: "Support the visible fracture hook.",
      evidence_refs: ["timeline:frame:0"],
      semantic_strength: 0.9,
      semantic_anchor: {
        label: "fracture hook",
        frame: 0,
        window: { earliest_frame: 0, latest_frame: 3 },
      },
      asset_id: manifest.assets[0].asset_id,
      asset_pin: {
        library_id: manifest.library_id,
        library_version: manifest.library_version,
        library_manifest_hash: manifestHash,
        asset_content_hash: manifest.assets[0].content_hash,
        asset_size_bytes: manifest.assets[0].size_bytes,
        rights_evidence_ref: manifest.assets[0].rights.evidence_ref,
        provenance_ref: manifest.assets[0].provenance.source_ref,
      },
      audio: {
        duration_frames: 10,
        source_range: { in_us: 0, out_us: 400_000 },
        gain_db: -18,
        fade_in_ms: 8,
        fade_out_ms: 120,
        tail: { max_frames: 2, policy: "trim_or_pad_to_limit" },
        duck_group: "dialogue",
        ducking: {
          duck_gain_db: -24,
          attack_ms: 10,
          release_ms: 180,
        },
      },
    }],
    dialogue_windows: [],
    congestion_events: [],
    beat_evidence: {
      status: "degraded",
      analysis_status: "degraded",
      analysis_path: null,
      content_hash: null,
      bpm: 71.8,
      confidence: 0.3,
      beat_frames: [],
      downbeat_frames: [],
    },
    policy: {
      minimum_spacing_frames: 24,
      max_cues_per_30_seconds: 2,
      absolute_max_cues: 2,
      semantic_accept_threshold: 4,
      congestion_reject_threshold: 4,
      minimum_beat_confidence: 0.7,
      max_snap_frames: 3,
      congestion_weights: {
        dialogue: 2,
        music_entry: 3,
        lower_third: 1.5,
        section_label: 1.5,
        caption: 1,
        picture_edit: 2,
        overlay: 1,
      },
    },
  };
  const requestPath = path.join(root, "04_plan", "sound-design-request.json");
  writeJson(requestPath, request);
  return {
    root,
    timeline,
    timelinePath,
    requestPath,
    decisionPath: path.join(root, "07_package", "sound-design-decision.json"),
    cuesPath: path.join(root, "07_package", "sfx_cues-phase5.json"),
  };
}

describe("sound-design planner CLI and decision pin", () => {
  it("keeps dry-run write-free and emits deterministic formal cues", () => {
    const input = fixture();
    const args = {
      projectDir: input.root,
      timelinePath: input.timelinePath,
      requestPath: input.requestPath,
      decisionOutputPath: input.decisionPath,
      cuesOutputPath: input.cuesPath,
      dryRun: true,
    };
    const first = runPlanSoundDesign(args);
    const second = runPlanSoundDesign(args);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      dry_run: true,
      wrote_files: false,
      adopted: [{
        candidate_id: "fracture-hook",
        resolved_frame: 0,
        snap: { applied: false },
      }],
      cue_ids: ["SFX_FRACTURE_HOOK_000000"],
    });
    expect(fs.existsSync(input.decisionPath)).toBe(false);
    expect(fs.existsSync(input.cuesPath)).toBe(false);
  });

  it("writes new decision/cues and validates the pin through A3 projection", () => {
    const input = fixture();
    runPlanSoundDesign({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      requestPath: input.requestPath,
      decisionOutputPath: input.decisionPath,
      cuesOutputPath: input.cuesPath,
      dryRun: false,
    });
    const plan = resolveSfxCuePlan({
      projectDir: input.root,
      timeline: input.timeline,
      cuesPath: input.cuesPath,
    });
    const projected = projectSfxToTimeline(input.timeline, plan);
    expect(plan.decision_ref).toMatchObject({
      resolved_path: fs.realpathSync(input.decisionPath),
    });
    expect(plan.cues[0].decision_pin).toMatchObject({
      candidate_id: "fracture-hook",
      resolved_frame: 0,
    });
    expect(projected.tracks.audio[0].clips[0].metadata?.sfx_cue)
      .toMatchObject({
        decision_pin: {
          candidate_id: "fracture-hook",
          resolved_frame: 0,
        },
      });
  });

  it("fails closed for decision pin drift", () => {
    const input = fixture();
    runPlanSoundDesign({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      requestPath: input.requestPath,
      decisionOutputPath: input.decisionPath,
      cuesOutputPath: input.cuesPath,
      dryRun: false,
    });
    const cues = JSON.parse(fs.readFileSync(input.cuesPath, "utf8"));
    cues.cues[0].decision_pin.resolved_frame = 1;
    writeJson(input.cuesPath, cues);
    expect(() => resolveSfxCuePlan({
      projectDir: input.root,
      timeline: input.timeline,
      cuesPath: input.cuesPath,
    })).toThrow(/SFX_DECISION_DRIFT|resolved_frame/);
  });

  it("rejects unsafe and existing output paths without overwriting", () => {
    const input = fixture();
    const outside = path.join(path.dirname(input.root), "outside-decision.json");
    expect(() => runPlanSoundDesign({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      requestPath: input.requestPath,
      decisionOutputPath: outside,
      cuesOutputPath: input.cuesPath,
      dryRun: true,
    })).toThrow(/contained/);

    fs.mkdirSync(path.dirname(input.decisionPath), { recursive: true });
    fs.writeFileSync(input.decisionPath, "owned");
    expect(() => runPlanSoundDesign({
      projectDir: input.root,
      timelinePath: input.timelinePath,
      requestPath: input.requestPath,
      decisionOutputPath: input.decisionPath,
      cuesOutputPath: input.cuesPath,
      dryRun: false,
    })).toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(input.decisionPath, "utf8")).toBe("owned");
  });

  it("exposes all CLI flags in help and requires explicit outputs", () => {
    let help = "";
    try {
      parsePlanSoundDesignArgs(["node", "script", "--help"]);
    } catch (error) {
      help = error instanceof Error ? error.message : String(error);
    }
    for (const flag of [
      "--project",
      "--timeline",
      "--request",
      "--decision-output",
      "--cues-output",
      "--dry-run",
    ]) {
      expect(help).toContain(flag);
    }
  });
});
