import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  compile,
  isEditorialEyeRelationV1Enabled,
} from "../runtime/compiler/index.js";

const SAMPLE_PROJECT = path.resolve("projects/sample");
const REPO_ROOT = path.resolve(".");
const CREATED_AT = "2026-03-21T00:00:00Z";
const tempDirs: string[] = [];
let originalFlag: string | undefined;

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(source, target);
    else fs.copyFileSync(source, target);
  }
}

function makeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-editorial-eye-"));
  tempDirs.push(projectDir);
  copyDirSync(SAMPLE_PROJECT, projectDir);
  fs.rmSync(path.join(projectDir, "05_timeline"), { recursive: true, force: true });
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  return projectDir;
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

beforeEach(() => {
  originalFlag = process.env.ENABLE_EDITORIAL_EYE_RELATION_V1;
  delete process.env.ENABLE_EDITORIAL_EYE_RELATION_V1;
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_EDITORIAL_EYE_RELATION_V1;
  else process.env.ENABLE_EDITORIAL_EYE_RELATION_V1 = originalFlag;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ENABLE_EDITORIAL_EYE_RELATION_V1", () => {
  it.each(["true", "TRUE", "1", "yes", "Yes", "on", " ON "])("accepts %s", (value) => {
    expect(isEditorialEyeRelationV1Enabled({ ENABLE_EDITORIAL_EYE_RELATION_V1: value })).toBe(true);
  });

  it.each([undefined, "", "false", "0", "off", "enabled"])("rejects %s", (value) => {
    expect(isEditorialEyeRelationV1Enabled({ ENABLE_EDITORIAL_EYE_RELATION_V1: value })).toBe(false);
  });

  it("keeps flag-off output byte-stable for old and observation-bearing segments", () => {
    const projectDir = makeProject();
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const analysisPath = path.join(projectDir, "05_timeline", "adjacency_analysis.json");

    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    const oldTimeline = fs.readFileSync(timelinePath);
    const oldAnalysis = fs.readFileSync(analysisPath);

    const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
    const segments = readJson(segmentsPath);
    segments.items[0].editorial_observation = {
      visual_tags: ["flag_off_must_ignore"],
      motion_type: "rapid",
      camera_axis: "axis_right",
    };
    writeJson(segmentsPath, segments);

    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    expect(fs.readFileSync(timelinePath).equals(oldTimeline)).toBe(true);
    expect(fs.readFileSync(analysisPath).equals(oldAnalysis)).toBe(true);

    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    expect(fs.readFileSync(timelinePath).equals(oldTimeline)).toBe(true);
    expect(fs.readFileSync(analysisPath).equals(oldAnalysis)).toBe(true);
  });

  it("materializes observation evidence through normal compile without embeddings", () => {
    const projectDir = makeProject();
    const blueprintPath = path.join(projectDir, "04_plan", "edit_blueprint.yaml");
    const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8"));
    delete blueprint.transition_policy;
    delete blueprint.active_editing_skills;
    fs.writeFileSync(blueprintPath, stringifyYaml(blueprint), "utf-8");

    const preliminary = compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    const clips = preliminary.timeline.tracks.video[0].clips;
    expect(clips.length).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(projectDir, "05_timeline", "adjacency_analysis.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "03_analysis", "visual-cache.json"))).toBe(false);

    const segmentsPath = path.join(projectDir, "03_analysis", "segments.json");
    const segments = readJson(segmentsPath);
    const byId = new Map(segments.items.map((item: any) => [item.segment_id, item]));
    const left: any = byId.get(clips[0].segment_id);
    const right: any = byId.get(clips[1].segment_id);
    left.editorial_observation = {
      visual_tags: ["shared_subject"],
      motion_type: "continuous",
      camera_motion_direction: "right",
      subject_motion_direction: "right",
      shot_scale: "medium",
      composition_anchor: "left",
      screen_side: "left",
      gaze_direction: "screen_right",
      camera_axis: "axis_left",
      dominant_subject_type: "person",
      avg_luma: 0.45,
      dominant_colors: ["blue", "white"],
      text_presence: "absent",
      confidence: {
        tags: { score: 0.9, evidence_refs: ["fixture:tags"] },
        motion: { score: 0.9, evidence_refs: ["fixture:motion"] },
        framing: { score: 0.9, evidence_refs: ["fixture:framing"] },
        direction: { score: 0.9, evidence_refs: ["fixture:direction"] },
        appearance: { score: 0.9, evidence_refs: ["fixture:appearance"] },
        text: { score: 0.9, evidence_refs: ["fixture:text"] },
      },
    };
    right.editorial_observation = { ...left.editorial_observation };
    writeJson(segmentsPath, segments);

    process.env.ENABLE_EDITORIAL_EYE_RELATION_V1 = "on";
    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    const analysisPath = path.join(projectDir, "05_timeline", "adjacency_analysis.json");
    const matchingBytes = fs.readFileSync(analysisPath);
    const matching = JSON.parse(matchingBytes.toString("utf-8"));
    expect(matching.version).toBe("2");
    expect(matching.pairs[0].evidence).toMatchObject({
      visual_tag_overlap_score: 1,
      motion_continuity_score: 0.9,
      evidence_coverage: {
        visual_tags: { left: "known", right: "known", pair: "known" },
        visual_tag_overlap_score: {
          left: "known",
          right: "known",
          pair: "known",
          source: { left: "canonical_metadata", right: "canonical_metadata" },
        },
        camera_axis: { left: "known", right: "known", pair: "known" },
        camera_motion_direction: { left: "known", right: "known", pair: "known" },
        subject_motion_direction: { left: "known", right: "known", pair: "known" },
        dominant_subject_type: { left: "known", right: "known", pair: "known" },
        avg_luma: { left: "known", right: "known", pair: "known" },
        dominant_colors: { left: "known", right: "known", pair: "known" },
        text_presence: { left: "known", right: "known", pair: "known" },
      },
    });
    expect(matching.pairs[0].selection_rationale).toMatchObject({
      outcome: "no_eligible",
      reason_codes: ["no_eligible_card"],
      active_cards: [],
      applied_skill_id: null,
    });
    expect(matching.pairs[0].evidence.visual_coherence_score).toBeUndefined();
    expect(matching.pairs[0].cut_relation).toMatchObject({
      relationship: "continuous",
      explicit_intent_evidence: [],
      signals: {
        luma: { coverage: "known", evaluation: "match" },
        dominant_color: { coverage: "known", evaluation: "match" },
        text_presence: { coverage: "known", evaluation: "match" },
        gaze_axis: {
          confidence: { left: 0.9, right: 0.9 },
          source_refs: {
            left: expect.arrayContaining(["fixture:direction"]),
            right: expect.arrayContaining(["fixture:direction"]),
          },
        },
      },
    });

    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    expect(fs.readFileSync(analysisPath).equals(matchingBytes)).toBe(true);

    right.editorial_observation = {
      ...right.editorial_observation,
      visual_tags: ["different_subject"],
      motion_type: "rapid",
      camera_motion_direction: "left",
      subject_motion_direction: "left",
      shot_scale: "wide",
      composition_anchor: "right",
      screen_side: "right",
      gaze_direction: "screen_left",
      camera_axis: "axis_right",
      dominant_subject_type: "landscape",
      avg_luma: 0.95,
      dominant_colors: ["orange", "black"],
      text_presence: "present",
    };
    writeJson(segmentsPath, segments);
    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    const contrasting = readJson(analysisPath);

    expect(contrasting.pairs[0].evidence.visual_tag_overlap_score).toBe(0);
    expect(contrasting.pairs[0].evidence.motion_continuity_score).toBe(0.3);
    expect(contrasting.pairs[0].evidence).not.toEqual(matching.pairs[0].evidence);
    expect(contrasting.pairs[0].cut_relation.relationship).toBe("risky_jump");
  });

  it("fails open through normal compile when segments.json is absent", () => {
    const projectDir = makeProject();
    fs.rmSync(path.join(projectDir, "03_analysis", "segments.json"));
    const messages: string[] = [];
    process.env.ENABLE_EDITORIAL_EYE_RELATION_V1 = "yes";

    expect(() => compile({
      projectPath: projectDir,
      repoRoot: REPO_ROOT,
      createdAt: CREATED_AT,
      log: (message) => messages.push(message),
    })).not.toThrow();

    expect(messages.join("\n")).toContain("continuing without segment evidence");
    const analysis = readJson(path.join(projectDir, "05_timeline", "adjacency_analysis.json"));
    expect(analysis.pairs[0].evidence.evidence_coverage.motion_type).toEqual({
      left: "missing", right: "missing", pair: "missing",
    });
    expect(analysis.pairs[0].evidence.evidence_coverage.visual_tag_overlap_score.pair).toBe("missing");
    expect(analysis.pairs[0].evidence.evidence_coverage.semantic_cluster_change.pair).toBe("missing");
    expect(analysis.pairs[0].evidence.evidence_coverage.energy_delta_score.pair).toBe("missing");
  });

  it("keeps normal compile metadata-only when footage.db has no embeddings", () => {
    const projectDir = makeProject();
    process.env.ENABLE_EDITORIAL_EYE_RELATION_V1 = "on";
    const preliminary = compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    const clips = preliminary.timeline.tracks.video[0].clips;
    expect(clips.length).toBeGreaterThan(1);

    const searchDir = path.join(projectDir, "03_analysis", "search");
    fs.mkdirSync(searchDir, { recursive: true });
    const db = new Database(path.join(searchDir, "footage.db"));
    try {
      db.exec(`
        CREATE TABLE segments (
          segment_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          src_in_us INTEGER NOT NULL
        );
        CREATE TABLE assets (
          asset_id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          shooting_date TEXT,
          shooting_time TEXT,
          camera_type TEXT
        );
      `);
      const insertAsset = db.prepare("INSERT OR IGNORE INTO assets VALUES (?, ?, ?, ?, ?)");
      const insertSegment = db.prepare("INSERT OR IGNORE INTO segments VALUES (?, ?, ?)");
      for (const clip of clips) {
        insertAsset.run(clip.asset_id, `${clip.asset_id}.mov`, null, null, "metadata-camera");
        insertSegment.run(clip.segment_id, clip.asset_id, clip.src_in_us);
      }
    } finally {
      db.close();
    }

    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    const analysisPath = path.join(projectDir, "05_timeline", "adjacency_analysis.json");
    const firstBytes = fs.readFileSync(analysisPath);
    const analysis = JSON.parse(firstBytes.toString("utf-8"));
    for (const pair of analysis.pairs) {
      expect(pair.evidence.visual_coherence_score).toBeUndefined();
      expect(pair.evidence.visual_transition_hint).toBeUndefined();
      expect(pair.evidence.evidence_coverage).toBeDefined();
      expect(pair.selection_rationale).toBeDefined();
    }

    compile({ projectPath: projectDir, repoRoot: REPO_ROOT, createdAt: CREATED_AT });
    expect(fs.readFileSync(analysisPath).equals(firstBytes)).toBe(true);
  });
});
