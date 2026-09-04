import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  launchEditorServer,
  stopAllEditorServers,
} from "./helpers/editor-server-test-rig.js";

const tempDirs: string[] = [];

function timelineRevision(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

afterEach(async () => {
  await stopAllEditorServers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function jsonRequest(body: unknown, revision: string): RequestInit {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": `"${revision}"` },
    body: JSON.stringify(body),
  };
}

describe("Studio Hook lock API boundary", () => {
  it("shows locked status, rejects Hook PUT/patch mutations with reasons, and permits a Body save", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "editor-hook-lock-"));
    tempDirs.push(fixtureRoot);
    const projectsDir = path.join(fixtureRoot, "projects");
    const projectDir = path.join(projectsDir, "hook-lock-project");
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "06_review"), { recursive: true });

    const timeline = JSON.parse(fs.readFileSync("projects/sample/05_timeline/timeline.json", "utf8")) as {
      version: string;
      tracks: {
        video: Array<{ clips: Array<Record<string, unknown>> }>;
        audio: Array<{ clips: Array<Record<string, unknown>>; [key: string]: unknown }>;
      };
      markers: Array<Record<string, unknown>>;
      provenance: Record<string, unknown>;
    };
    const hookClip = timeline.tracks.video[0].clips[0];
    const bodyClip = timeline.tracks.video[0].clips[1];
    const a1Companion = {
      ...hookClip,
      clip_id: "A1_HOOK_COMPANION",
      role: "nat_sound",
    };
    timeline.tracks.video = [{
      ...timeline.tracks.video[0],
      clips: timeline.tracks.video[0].clips.slice(0, 2),
    }];
    bodyClip.timeline_in_frame = 120;
    timeline.tracks.audio = [{
      track_id: "A1",
      kind: "audio",
      role: "dialogue",
      clips: [a1Companion],
    }];
    timeline.markers = [];
    delete (timeline as Record<string, unknown>).transitions;
    timeline.provenance.hook_lock = {
      policy: "hook-lock/v1",
      locked: true,
      sequence_id: "hook-studio-fixture",
      lock_revision: 1,
      fingerprint: `sha256:${"a".repeat(64)}`,
      anchor_ids: ["anchor-studio-fixture"],
      protected_clip_ids: [String(a1Companion.clip_id), String(hookClip.clip_id)].sort(),
      protected_beat_ids: [String(hookClip.beat_id)],
      reason: "explicit_blueprint_lock",
    };
    fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);

    const server = await launchEditorServer({ projectsDir });
    const retryStatuses = [500, 502];

    const lockResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline/hook-lock",
      { retryStatuses },
    );
    expect(lockResponse.status).toBe(200);
    expect(await lockResponse.json()).toMatchObject({
      locked: true,
      reason: "Hook is explicitly locked by the Blueprint; only non-Hook edits are allowed.",
      protected_clip_ids: [a1Companion.clip_id, hookClip.clip_id].sort(),
    });

    const timelineResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { retryStatuses },
    );
    const revision = (timelineResponse.headers.get("etag") ?? "").replace(/^"|"$/g, "");
    expect(revision).toMatch(/^sha256:/);
    const protectedPut = structuredClone(timeline);
    (protectedPut.tracks.video[0].clips[0] as Record<string, unknown>).metadata = { attempted: "protected-change" };
    const protectedPutResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { init: jsonRequest(protectedPut, revision), retryStatuses },
    );
    expect(protectedPutResponse.status).toBe(423);
    expect(await protectedPutResponse.json()).toMatchObject({ error: "Hook is locked", code: "HOOK_LOCKED" });

    const a1TrimPut = structuredClone(timeline);
    (a1TrimPut.tracks.audio[0].clips[0] as Record<string, unknown>).src_out_us = Number(hookClip.src_out_us) - 100_000;
    const a1TrimResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { init: jsonRequest(a1TrimPut, revision), retryStatuses },
    );
    expect(a1TrimResponse.status).toBe(423);

    const a1RemovePut = structuredClone(timeline);
    a1RemovePut.tracks.audio[0].clips = [];
    const a1RemoveResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { init: jsonRequest(a1RemovePut, revision), retryStatuses },
    );
    expect(a1RemoveResponse.status).toBe(423);

    const lockProjectionPut = structuredClone(timeline);
    (lockProjectionPut.provenance.hook_lock as Record<string, unknown>).protected_clip_ids = [String(hookClip.clip_id)];
    const lockProjectionResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { init: jsonRequest(lockProjectionPut, revision), retryStatuses },
    );
    expect(lockProjectionResponse.status).toBe(423);

    const bodyPut = structuredClone(timeline);
    bodyPut.markers.push({ frame: 96, kind: "review", label: "body edit remains allowed" });
    const bodyPutResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { init: jsonRequest(bodyPut, revision), retryStatuses },
    );
    expect(bodyPutResponse.status).toBe(200);

    const afterBody = await server.waitForResponse(
      "/api/projects/hook-lock-project/timeline",
      { retryStatuses },
    );
    const bodyRevision = (afterBody.headers.get("etag") ?? "").replace(/^"|"$/g, "");
    const patchPath = path.join(projectDir, "06_review/review_patch.json");
    fs.writeFileSync(patchPath, JSON.stringify({
      timeline_version: timeline.version,
      operations: [{
        op: "trim_segment",
        target_clip_id: hookClip.clip_id,
        new_src_in_us: Number(hookClip.src_in_us) + 100_000,
        new_src_out_us: hookClip.src_out_us,
        reason: "protected patch attempt",
      }],
    }));
    const protectedPatchResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/ai/patches/apply",
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_timeline_revision: bodyRevision, operation_indexes: [0] }),
        },
        retryStatuses,
      },
    );
    expect(protectedPatchResponse.status).toBe(423);
    expect(await protectedPatchResponse.json()).toMatchObject({ error: "Hook is locked", code: "HOOK_LOCKED" });

    fs.writeFileSync(patchPath, JSON.stringify({
      timeline_version: timeline.version,
      operations: [{
        op: "trim_segment",
        target_clip_id: bodyClip.clip_id,
        new_src_in_us: bodyClip.src_in_us,
        new_src_out_us: Number(bodyClip.src_out_us) - 100_000,
        reason: "body patch remains allowed",
      }],
    }));
    const bodyPatchResponse = await server.waitForResponse(
      "/api/projects/hook-lock-project/ai/patches/apply",
      {
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_timeline_revision: bodyRevision, operation_indexes: [0] }),
        },
        retryStatuses,
      },
    );
    expect(bodyPatchResponse.status).toBe(200);
    expect((await bodyPatchResponse.json()).applied_operation_indexes).toEqual([0]);

    // The rejected Hook patch must not have changed the canonical bytes.
    const persisted = fs.readFileSync(path.join(projectDir, "05_timeline/timeline.json"), "utf8");
    expect(timelineRevision(persisted)).not.toBe(revision);
    expect(JSON.parse(persisted).provenance.hook_lock.fingerprint).toBe(`sha256:${"a".repeat(64)}`);
  });
});
