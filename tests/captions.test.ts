import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compile } from "../runtime/compiler/index.js";
import { calculateAgeLabel, resolveCaptionPolicy } from "../runtime/captions/timeline-captions.js";
import { buildCaptionDrawtextFilter } from "../runtime/render/assembler.js";
import type { CreativeBrief, EditBlueprint } from "../runtime/compiler/types.js";

describe("auto milestone captions", () => {
  it("calculates Japanese age labels from subject.birth_date", () => {
    expect(calculateAgeLabel("2019-07-07", "2022-05-02")).toBe("2歳9ヶ月");
  });

  it("defaults family-growth-recap caption_policy to auto", () => {
    const brief = {
      version: "1",
      project_id: "p",
      project: { id: "p", title: "P", strategy: "family-growth-recap" },
      message: { primary: "growth" },
      emotion_curve: ["start", "middle", "end"],
      editorial: { profile_hint: "family-growth-recap" },
    } as CreativeBrief;
    const blueprint = { version: "1", project_id: "p", resolved_profile: { id: "family-growth-recap" } } as EditBlueprint;

    expect(resolveCaptionPolicy(brief, blueprint, path.resolve("."))).toEqual({
      mode: "auto",
      source: "profile_default",
    });
  });

  it("adds date, age, and milestone captions to compiled timeline clips", () => {
    const projectDir = makeCaptionProject();
    try {
      const result = compile({
        projectPath: projectDir,
        repoRoot: path.resolve("."),
        createdAt: "2026-04-28T00:00:00Z",
        fpsNum: 30,
      });

      const clip = result.timeline.tracks.video[0].clips.find((item) => item.segment_id === "seg_20220502_bicycle_start");
      expect(result.timeline.provenance.caption_policy).toEqual({
        mode: "auto",
        source: "explicit_brief",
      });
      expect(clip?.captions?.[0].text).toBe("2022/05  2歳9ヶ月  補助輪外した");
      expect(clip?.captions?.[0].style).toBe("gentle-lower-third");

      const filter = buildCaptionDrawtextFilter(clip!.captions!, 30, 1920, 1080);
      expect(filter).toContain("drawtext=");
      expect(filter).toContain("補助輪外した");
      expect(filter).toContain("between(t,");
      expect(filter).toContain(":fontfile='");
      expect(filter).toContain("NotoSansJP-Variable.ttf");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not add clip captions when caption_policy is off", () => {
    const projectDir = makeCaptionProject("off");
    try {
      const result = compile({
        projectPath: projectDir,
        repoRoot: path.resolve("."),
        createdAt: "2026-04-28T00:00:00Z",
        fpsNum: 30,
      });

      expect(result.timeline.provenance.caption_policy?.mode).toBe("off");
      expect(result.timeline.tracks.video[0].clips[0].captions).toBeUndefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

function makeCaptionProject(captionPolicy: "auto" | "off" = "auto"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-caption-policy-"));
  fs.mkdirSync(path.join(dir, "01_intent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "03_analysis"), { recursive: true });
  fs.mkdirSync(path.join(dir, "04_plan"), { recursive: true });

  fs.writeFileSync(path.join(dir, "01_intent/creative_brief.yaml"), [
    'version: "1"',
    "project_id: caption-fixture",
    "project:",
    "  id: caption-fixture",
    "  title: Caption Fixture",
    "  strategy: family-growth-recap",
    "  runtime_target_sec: 8",
    "subject:",
    "  birth_date: 2019-07-07",
    `caption_policy: ${captionPolicy}`,
    "message:",
    "  primary: growth",
    "audience:",
    "  primary: family",
    "emotion_curve: [start, peak, end]",
    "must_have: [milestone]",
    "must_avoid: [none]",
    "autonomy:",
    "  may_decide: []",
    "  must_ask: []",
    "resolved_assumptions: [captions]",
    "editorial:",
    "  profile_hint: family-growth-recap",
    "  allow_inference: true",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "04_plan/edit_blueprint.yaml"), [
    'version: "1"',
    "project_id: caption-fixture",
    "sequence_goals: [test]",
    "beats:",
    "  - id: bicycle_start",
    "    label: 2022-05-02 自転車",
    "    target_duration_frames: 120",
    "    required_roles: [hero]",
    "pacing:",
    "  opening_cadence: gentle",
    "  middle_cadence: gentle",
    "  ending_cadence: gentle",
    "music_policy:",
    "  start_sparse: true",
    "  allow_release_late: true",
    "  entry_beat: bicycle_start",
    "dialogue_policy:",
    "  preserve_natural_breath: true",
    "  avoid_wall_to_wall_voiceover: true",
    "resolved_profile:",
    "  id: family-growth-recap",
    "duration_policy:",
    "  mode: guide",
    "  source: explicit_brief",
    "  target_source: explicit_brief",
    "  target_duration_sec: 4",
    "  min_duration_sec: 1",
    "  max_duration_sec: 8",
    "  hard_gate: false",
    "  protect_vlm_peaks: true",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "04_plan/selects_candidates.yaml"), [
    'version: "1"',
    "project_id: caption-fixture",
    "candidates:",
    "  - candidate_id: cand_05",
    "    segment_id: seg_20220502_bicycle_start",
    "    asset_id: AST_VIDEO",
    "    src_in_us: 0",
    "    src_out_us: 4000000",
    "    role: hero",
    "    why_it_matches: 自転車への挑戦",
    "    risks: []",
    "    confidence: 0.9",
    "    semantic_rank: 1",
    "    eligible_beats: [bicycle_start]",
    "    trim_hint:",
    "      interest_point_label: 補助輪外した",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "03_analysis/assets.json"), JSON.stringify({ project_id: "caption-fixture", artifact_version: "1", items: [] }, null, 2));
  return dir;
}
