import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { parse as parseYaml } from "yaml";
import { confirmBriefDefaults } from "../runtime/brief-confirmation.js";

describe("brief confirmation prompt", () => {
  it("skips completely when skip_confirmations is true", async () => {
    const projectDir = makeConfirmationProject({ skipConfirmations: true });
    try {
      const before = fs.readFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), "utf-8");
      const result = await confirmBriefDefaults(projectDir, { force: true });
      const after = fs.readFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), "utf-8");

      expect(result).toEqual({ skipped: true, wrote: false });
      expect(after).toBe(before);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("writes interactive confirmation answers back to creative_brief.yaml", async () => {
    const projectDir = makeConfirmationProject();
    const outputChunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        outputChunks.push(String(chunk));
        callback();
      },
    });

    try {
      const result = await confirmBriefDefaults(projectDir, {
        force: true,
        input: Readable.from(["manual\nno\n"]),
        output,
        now: "2026-04-28T00:00:00.000Z",
      });
      const brief = parseYaml(
        fs.readFileSync(path.join(projectDir, "01_intent/creative_brief.yaml"), "utf-8"),
      ) as {
        caption_policy?: string;
        audio_policy?: string;
        confirmation_provenance?: { source?: string; confirmed_at?: string };
      };

      expect(result.wrote).toBe(true);
      expect(result.captionPolicy).toBe("manual");
      expect(result.audioPolicy).toBe("bgm_only");
      expect(brief.caption_policy).toBe("manual");
      expect(brief.audio_policy).toBe("bgm_only");
      expect(brief.confirmation_provenance).toMatchObject({
        source: "interactive_prompt",
        confirmed_at: "2026-04-28T00:00:00.000Z",
      });
      expect(outputChunks.join("")).toContain("テロップを付けますか?");
      expect(outputChunks.join("")).toContain("原音を活用しますか?");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

function makeConfirmationProject(opts?: { skipConfirmations?: boolean }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-brief-confirm-"));
  fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "04_plan"), { recursive: true });

  fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), [
    'version: "1"',
    "project_id: confirmation-fixture",
    "project:",
    "  id: confirmation-fixture",
    "  title: Confirmation Fixture",
    "  strategy: family-growth-recap",
    "message:",
    "  primary: growth",
    "audience:",
    "  primary: family",
    "emotion_curve: [start, peak, end]",
    "must_have: [milestone]",
    "must_avoid: [mute]",
    "autonomy:",
    "  mode: full",
    "  may_decide: []",
    "  must_ask: []",
    ...(opts?.skipConfirmations ? ["  skip_confirmations: true"] : []),
    "resolved_assumptions: [defaults]",
    "editorial:",
    "  profile_hint: family-growth-recap",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "04_plan/edit_blueprint.yaml"), [
    'version: "1"',
    "project_id: confirmation-fixture",
    "sequence_goals: [test]",
    "beats: []",
    "pacing:",
    "  opening_cadence: gentle",
    "  middle_cadence: gentle",
    "  ending_cadence: gentle",
    "music_policy:",
    "  start_sparse: true",
    "  allow_release_late: true",
    "  entry_beat: b01",
    "dialogue_policy:",
    "  preserve_natural_breath: true",
    "  avoid_wall_to_wall_voiceover: true",
    "resolved_profile:",
    "  id: family-growth-recap",
    "",
  ].join("\n"));

  return dir;
}
