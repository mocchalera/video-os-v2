import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";

const SAMPLE_PROJECT = path.resolve("projects/sample");
const FIXED_CREATED_AT = "2026-08-21T00:00:00Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const tempProjects: string[] = [];

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(source, target);
    else fs.copyFileSync(source, target);
  }
}

function createAnonymousProject(): string {
  const project = path.resolve("tests", `tmp_rfa_003_004_${Date.now()}`);
  copyDirSync(SAMPLE_PROJECT, project);
  tempProjects.push(project);
  return project;
}

afterEach(() => {
  while (tempProjects.length > 0) {
    const project = tempProjects.pop()!;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

describe("RFA-003/004 compiler integration", () => {
  it("resolves anchors into canonical provenance and keeps Hook fingerprint stable for Body-only recompile", () => {
    const project = createAnonymousProject();
    const existing = JSON.parse(fs.readFileSync(path.join(project, "05_timeline/timeline.json"), "utf8")) as {
      tracks: {
        video: Array<{ clips: Array<{ clip_id: string; segment_id: string; asset_id: string; src_in_us: number; src_out_us: number; beat_id: string }> }>;
        audio: Array<{ track_id: string; clips: Array<{ clip_id: string; asset_id: string; src_in_us: number; src_out_us: number; timeline_in_frame: number; timeline_duration_frames: number }> }>;
      };
    };
    const hookClip = existing.tracks.video[0].clips[0];
    fs.rmSync(path.join(project, "05_timeline/timeline.json"));

    fs.mkdirSync(path.join(project, "02_media"), { recursive: true });
    fs.writeFileSync(path.join(project, "02_media/source_map.json"), JSON.stringify({
      version: "1",
      project_id: "sample-mountain-reset",
      media_dir: "02_media",
      generated_at: FIXED_CREATED_AT,
      items: [{
        asset_id: hookClip.asset_id,
        source_locator: "fixture-source.mp4",
        source_content_sha256: HASH_A,
        source_fingerprint: "fixture-fingerprint-a",
      }],
    }, null, 2));

    const baseBlueprint = parseYaml(fs.readFileSync(path.join(project, "04_plan/edit_blueprint.yaml"), "utf8")) as Record<string, unknown>;
    const hookSequence = {
      sequence_id: "hook-anonymous-fixture",
      locked: true,
      lock_revision: 1,
      shots: [{
        shot_id: "shot-hook-1",
        beat_id: hookClip.beat_id,
        scene_type: "source-grounded-fixture",
        shot_anchor: {
          anchor_id: "anchor-hook-1",
          asset_id: hookClip.asset_id,
          source_content_hash: HASH_A,
          segment_id: hookClip.segment_id,
          src_in_us: hookClip.src_in_us,
          src_out_us: hookClip.src_out_us,
        },
      }],
    };
    const bodySequence = {
      sequence_id: "body-anonymous-fixture",
      shots: [{ shot_id: "shot-body-1", candidate_ref: "fixture-body-ref" }],
    };
    const writeBlueprint = (hash: string, bodyCandidateRef = "fixture-body-ref", bodyShotId = "shot-body-1"): void => {
      fs.writeFileSync(path.join(project, "04_plan/edit_blueprint.yaml"), stringifyYaml({
        ...baseBlueprint,
        version: "2",
        hook_sequence: {
          ...hookSequence,
          shots: [{
            ...hookSequence.shots[0],
            shot_anchor: { ...hookSequence.shots[0].shot_anchor, source_content_hash: hash },
          }],
        },
        body_sequence: {
          ...bodySequence,
          shots: [{ shot_id: bodyShotId, candidate_ref: bodyCandidateRef }],
        },
      }));
    };

    writeBlueprint(HASH_A);
    const first = compile({ projectPath: project, createdAt: FIXED_CREATED_AT });
    expect(first.timeline.provenance.shot_anchor_resolution).toMatchObject({
      policy: "shot-anchor-resolution/v1",
      anchors: [{ anchor_id: "anchor-hook-1", asset_id: hookClip.asset_id, segment_id: hookClip.segment_id }],
    });
    const firstA1Companion = first.timeline.tracks.audio
      .flatMap((track) => track.clips)
      .find((clip) => clip.asset_id === hookClip.asset_id
        && clip.src_in_us === hookClip.src_in_us
        && clip.src_out_us === hookClip.src_out_us
        && clip.timeline_in_frame === 0
        && clip.timeline_duration_frames === 96);
    expect(firstA1Companion).toBeDefined();
    expect(first.timeline.provenance.hook_lock).toMatchObject({
      policy: "hook-lock/v1",
      locked: true,
      protected_clip_ids: [firstA1Companion!.clip_id, hookClip.clip_id].sort(),
    });
    const fingerprint = first.timeline.provenance.hook_lock!.fingerprint;
    expect(first.timeline.metadata?.shot_anchor).toMatchObject({ binding_count: 1, clip_ids: [hookClip.clip_id] });

    // Change only the Body intent (candidate and shot). The canonical Hook lock/fingerprint must survive.
    writeBlueprint(HASH_A, "fixture-body-ref-2", "shot-body-2");
    const second = compile({ projectPath: project, createdAt: FIXED_CREATED_AT });
    expect(second.timeline.provenance.hook_lock?.fingerprint).toBe(fingerprint);
    expect(second.timeline.provenance.hook_lock?.reason).toBe("preserved_existing_lock");

    // A source identity change is a Hook mutation and fails before timeline write.
    writeBlueprint(HASH_B);
    fs.writeFileSync(path.join(project, "02_media/source_map.json"), JSON.stringify({
      version: "1",
      project_id: "sample-mountain-reset",
      media_dir: "02_media",
      generated_at: FIXED_CREATED_AT,
      items: [{ asset_id: hookClip.asset_id, source_locator: "fixture-source.mp4", source_content_sha256: HASH_B }],
    }, null, 2));
    expect(() => compile({ projectPath: project, createdAt: FIXED_CREATED_AT })).toThrow(/Hook is locked|fingerprint mismatch/);
    expect(JSON.parse(fs.readFileSync(path.join(project, "05_timeline/timeline.json"), "utf8")).provenance.hook_lock.fingerprint).toBe(fingerprint);
  });
});
