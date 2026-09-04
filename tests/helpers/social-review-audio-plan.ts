import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  hashAudioRenderPlan,
  type AudioRenderPlan,
} from "../../runtime/audio/render-plan.js";
import type { MasteringDefaults } from "../../runtime/audio/mastering.js";

function fileHash(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

export function writeCanonicalSocialReviewAudioPlan(input: {
  projectDir: string;
  projectId: string;
  timelinePath: string;
  policy: MasteringDefaults;
}): { filePath: string; hash: string; plan: AudioRenderPlan } {
  const plan: AudioRenderPlan = {
    version: "audio-render-plan/v1",
    project_id: input.projectId,
    strategy: "dialogue_only",
    timeline: {
      path: path.relative(input.projectDir, input.timelinePath).split(path.sep).join("/"),
      version: "test",
      content_hash: fileHash(input.timelinePath),
      duration_frames: 300,
      fps: { num: 30, den: 1 },
    },
    inputs: {},
    dialogue: { source_track_id: "A1", clips: [], finish_scope: "none" },
    music: { enabled: false, source_track_id: "A2", cues: [] },
    final_mastering: {
      ...input.policy,
      count: 1,
      stage: "after_mix",
      owner: "shared_audio_render_plan",
    },
    expected_artifacts: {
      dialogue_stem: "raw_dialogue.wav",
      final_mix: "final_mix.wav",
      report: "audio-mix-report.json",
    },
    warnings: [],
  };
  const filePath = path.join(input.projectDir, "07_package", "audio-render-plan.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`);
  return { filePath, hash: hashAudioRenderPlan(plan), plan };
}
