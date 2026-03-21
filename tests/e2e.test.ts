import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compile } from "../runtime/compiler/index.js";
import { applyPatch } from "../runtime/compiler/patch.js";
import type { ReviewPatch } from "../runtime/compiler/patch.js";
import type { Candidate, TimelineIR } from "../runtime/compiler/types.js";
import { validateProject } from "../scripts/validate-schemas.js";

// ── Helpers ─────────────────────────────────────────────────────────

const SAMPLE_PROJECT = path.resolve("projects/sample");
const FIXED_CREATED_AT = "2026-03-21T00:00:00Z";
const GOLDEN_PATH = path.resolve("tests/golden/sample-timeline.json");

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createTempProject(): string {
  const tmpDir = path.join("tests", `tmp_e2e_${Date.now()}`);
  copyDirSync(SAMPLE_PROJECT, tmpDir);
  // Remove existing output so tests start clean
  const timelinePath = path.join(tmpDir, "05_timeline/timeline.json");
  if (fs.existsSync(timelinePath)) fs.unlinkSync(timelinePath);
  const manifestPath = path.join(tmpDir, "05_timeline/preview-manifest.json");
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  return tmpDir;
}

function readCandidates(projectPath: string): Candidate[] {
  const selectsPath = path.join(projectPath, "04_plan/selects_candidates.yaml");
  const raw = fs.readFileSync(selectsPath, "utf-8");
  const data = parseYaml(raw) as { candidates: Candidate[] };
  return data.candidates;
}

// ── E2E: Full Editorial Loop ────────────────────────────────────────

describe("E2E: Editorial Loop", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempProject();
  });

  afterAll(() => {
    removeDirSync(tmpDir);
  });

  it("full loop: compile → validate → patch → validate v2", () => {
    // 1. Compile
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(result.timeline.version).toBe("1");
    expect(fs.existsSync(result.outputPath)).toBe(true);

    // 2. Schema validate → pass
    const validation1 = validateProject(tmpDir);
    expect(validation1.gate2_timeline_valid).toBe(true);

    // 3. Load fixture review patch
    const patchPath = path.resolve("projects/sample/06_review/review_patch.json");
    const patch: ReviewPatch = JSON.parse(fs.readFileSync(patchPath, "utf-8"));
    const candidates = readCandidates(tmpDir);

    // 4. Apply patch
    const patchResult = applyPatch(result.timeline, patch, candidates);
    expect(patchResult.errors).toEqual([]);
    expect(patchResult.appliedOps).toBe(3);
    expect(patchResult.timeline.version).toBe("2");

    // 5. Write patched timeline
    const patchedPath = path.join(tmpDir, "05_timeline/timeline.json");
    fs.writeFileSync(patchedPath, JSON.stringify(patchResult.timeline, null, 2), "utf-8");

    // 6. Validate v2 → pass
    const validation2 = validateProject(tmpDir);
    expect(validation2.gate2_timeline_valid).toBe(true);

    // 7. Verify specific patches were applied
    const v2 = patchResult.timeline;

    // trim_segment on CLP_0001: src_in_us should be 2000000
    const clp0001 = v2.tracks.video
      .flatMap((t) => t.clips)
      .find((c) => c.clip_id === "CLP_0001");
    expect(clp0001).toBeDefined();
    expect(clp0001!.src_in_us).toBe(2000000);
    expect(clp0001!.src_out_us).toBe(5500000);

    // replace_segment on CLP_0003: should now reference SEG_0014
    const clp0003 = v2.tracks.video
      .flatMap((t) => t.clips)
      .find((c) => c.clip_id === "CLP_0003");
    expect(clp0003).toBeDefined();
    expect(clp0003!.segment_id).toBe("SEG_0014");
    expect(clp0003!.asset_id).toBe("AST_003");

    // add_marker: should have a review marker at frame 312
    const reviewMarkers = v2.markers.filter((m) => m.kind === "review");
    expect(reviewMarkers.length).toBe(1);
    expect(reviewMarkers[0].frame).toBe(312);
  });

  it("determinism: same input produces identical output", () => {
    const result1 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    const result2 = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });
    expect(JSON.stringify(result1.timeline)).toBe(JSON.stringify(result2.timeline));
  });
});

// ── Gate Tests ──────────────────────────────────────────────────────

describe("E2E: Gate Tests", () => {
  it("compile gate blocks when unresolved_blockers has blocker status", () => {
    const tmpDir = path.join("tests", `tmp_gate1_${Date.now()}`);
    copyDirSync(SAMPLE_PROJECT, tmpDir);
    try {
      const blockersPath = path.join(tmpDir, "01_intent/unresolved_blockers.yaml");
      const blockers = parseYaml(fs.readFileSync(blockersPath, "utf-8")) as Record<string, unknown>;
      blockers.blockers = [
        {
          id: "BLK_TEST",
          summary: "Test blocker for gate check",
          status: "blocker",
          raised_at: "2026-03-21T00:00:00Z",
        },
      ];
      fs.writeFileSync(blockersPath, stringifyYaml(blockers), "utf-8");

      const validation = validateProject(tmpDir);
      expect(validation.compile_gate).toBe("blocked");
    } finally {
      removeDirSync(tmpDir);
    }
  });

  it("review gate blocked when fatal_issues present", () => {
    const tmpDir = path.join("tests", `tmp_gate3_${Date.now()}`);
    copyDirSync(SAMPLE_PROJECT, tmpDir);
    try {
      // Create review_report with fatal_issues
      const reviewDir = path.join(tmpDir, "06_review");
      fs.mkdirSync(reviewDir, { recursive: true });

      const fatalReport = {
        version: "1",
        project_id: "sample-mountain-reset",
        timeline_version: "1",
        summary_judgment: {
          status: "blocked",
          rationale: "Fatal issue found in timeline",
          confidence: 0.95,
        },
        strengths: [],
        weaknesses: [],
        fatal_issues: [
          {
            summary: "Missing required hero shot in b02",
            severity: "fatal",
            affected_beat_ids: ["b02"],
          },
        ],
        warnings: [],
        mismatches_to_brief: [],
        mismatches_to_blueprint: [],
        recommended_next_pass: {
          goal: "Fix fatal issues before proceeding",
          actions: ["Add hero shot to b02"],
        },
      };

      fs.writeFileSync(
        path.join(reviewDir, "review_report.yaml"),
        stringifyYaml(fatalReport),
        "utf-8",
      );

      const validation = validateProject(tmpDir);
      expect(validation.gate3_no_fatal_reviews).toBe(false);
    } finally {
      removeDirSync(tmpDir);
    }
  });
});

// ── Golden Test ─────────────────────────────────────────────────────

describe("E2E: Golden Snapshot", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempProject();
  });

  afterAll(() => {
    removeDirSync(tmpDir);
  });

  it("compile output matches golden snapshot", () => {
    const result = compile({ projectPath: tmpDir, createdAt: FIXED_CREATED_AT });

    if (!fs.existsSync(GOLDEN_PATH)) {
      // Auto-generate golden on first run
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(
        GOLDEN_PATH,
        JSON.stringify(result.timeline, null, 2) + "\n",
        "utf-8",
      );
      // Pass on first run — re-run will verify
      return;
    }

    const golden: TimelineIR = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf-8"));
    expect(result.timeline).toEqual(golden);
  });
});

// ── Patch Unit Tests ────────────────────────────────────────────────

describe("Patch Applicator", () => {
  function makeMinimalTimeline(clips: { trackId: string; clip: Partial<import("../runtime/compiler/types.js").ClipOutput> }[] = []): TimelineIR {
    const videoTracks: import("../runtime/compiler/types.js").TrackOutput[] = [
      { track_id: "V1", kind: "video", clips: [] },
      { track_id: "V2", kind: "video", clips: [] },
    ];
    const audioTracks: import("../runtime/compiler/types.js").TrackOutput[] = [
      { track_id: "A1", kind: "audio", clips: [] },
    ];

    for (const { trackId, clip } of clips) {
      const fullClip: import("../runtime/compiler/types.js").ClipOutput = {
        clip_id: clip.clip_id ?? "CLP_0001",
        segment_id: clip.segment_id ?? "SEG_001",
        asset_id: clip.asset_id ?? "AST_001",
        src_in_us: clip.src_in_us ?? 0,
        src_out_us: clip.src_out_us ?? 1000000,
        timeline_in_frame: clip.timeline_in_frame ?? 0,
        timeline_duration_frames: clip.timeline_duration_frames ?? 24,
        role: clip.role ?? "hero",
        motivation: clip.motivation ?? "test",
        beat_id: clip.beat_id ?? "b01",
        fallback_segment_ids: clip.fallback_segment_ids ?? [],
        confidence: clip.confidence ?? 0.9,
        quality_flags: clip.quality_flags ?? [],
      };

      const target = [...videoTracks, ...audioTracks].find((t) => t.track_id === trackId);
      if (target) target.clips.push(fullClip);
    }

    return {
      version: "1",
      project_id: "test",
      created_at: "2026-01-01T00:00:00Z",
      sequence: { name: "test", fps_num: 24, fps_den: 1, width: 1920, height: 1080, start_frame: 0 },
      tracks: { video: videoTracks, audio: audioTracks },
      markers: [],
      provenance: { brief_path: "", blueprint_path: "", selects_path: "", compiler_version: "1.0.0" },
    };
  }

  it("rejects patch with mismatched timeline_version", () => {
    const timeline = makeMinimalTimeline();
    const patch: ReviewPatch = {
      timeline_version: "99",
      operations: [],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].op).toBe("version_check");
    expect(result.appliedOps).toBe(0);
    // Version should NOT be incremented on rejection
    expect(result.timeline.version).toBe("1");
  });

  it("errors on nonexistent target_clip_id", () => {
    const timeline = makeMinimalTimeline();
    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "trim_segment", target_clip_id: "NONEXISTENT", reason: "test", new_src_in_us: 0, new_src_out_us: 100 },
      ],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("NONEXISTENT");
    // Version still increments (partial application allowed)
    expect(result.timeline.version).toBe("2");
  });

  it("remove_segment removes the clip", () => {
    const timeline = makeMinimalTimeline([
      { trackId: "V1", clip: { clip_id: "CLP_0001", segment_id: "SEG_001" } },
    ]);

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "remove_segment", target_clip_id: "CLP_0001", reason: "removing test clip" },
      ],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors).toEqual([]);
    expect(result.appliedOps).toBe(1);
    expect(result.timeline.tracks.video[0].clips.length).toBe(0);
    expect(result.timeline.version).toBe("2");
  });

  it("trim_segment updates source range", () => {
    const timeline = makeMinimalTimeline([
      { trackId: "V1", clip: { clip_id: "CLP_0001", src_in_us: 1000, src_out_us: 5000 } },
    ]);

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "trim_segment", target_clip_id: "CLP_0001", new_src_in_us: 2000, new_src_out_us: 4000, reason: "tighter trim" },
      ],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors).toEqual([]);
    const clip = result.timeline.tracks.video[0].clips[0];
    expect(clip.src_in_us).toBe(2000);
    expect(clip.src_out_us).toBe(4000);
    expect(clip.motivation).toContain("[patch:trim]");
  });

  it("move_segment updates timeline position", () => {
    const timeline = makeMinimalTimeline([
      { trackId: "V1", clip: { clip_id: "CLP_0001", timeline_in_frame: 0, timeline_duration_frames: 24 } },
    ]);

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "move_segment", target_clip_id: "CLP_0001", new_timeline_in_frame: 48, new_duration_frames: 36, reason: "move later" },
      ],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors).toEqual([]);
    const clip = result.timeline.tracks.video[0].clips[0];
    expect(clip.timeline_in_frame).toBe(48);
    expect(clip.timeline_duration_frames).toBe(36);
  });

  it("replace_segment swaps clip data from candidate", () => {
    const timeline = makeMinimalTimeline([
      { trackId: "V1", clip: { clip_id: "CLP_0001", segment_id: "SEG_OLD" } },
    ]);

    const candidates: Candidate[] = [
      {
        segment_id: "SEG_NEW",
        asset_id: "AST_099",
        src_in_us: 7000,
        src_out_us: 8000,
        role: "support",
        why_it_matches: "replacement",
        risks: [],
        confidence: 0.85,
        quality_flags: ["checked"],
      },
    ];

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "replace_segment", target_clip_id: "CLP_0001", with_segment_id: "SEG_NEW", reason: "better candidate" },
      ],
    };

    const result = applyPatch(timeline, patch, candidates);
    expect(result.errors).toEqual([]);
    const clip = result.timeline.tracks.video[0].clips[0];
    expect(clip.segment_id).toBe("SEG_NEW");
    expect(clip.asset_id).toBe("AST_099");
    expect(clip.src_in_us).toBe(7000);
    expect(clip.src_out_us).toBe(8000);
    expect(clip.confidence).toBe(0.85);
    expect(clip.role).toBe("support");
  });

  it("insert_segment adds a new clip to the correct track", () => {
    const timeline = makeMinimalTimeline();

    const candidates: Candidate[] = [
      {
        segment_id: "SEG_INSERT",
        asset_id: "AST_050",
        src_in_us: 1000,
        src_out_us: 5000,
        role: "dialogue",
        why_it_matches: "new line",
        risks: [],
        confidence: 0.88,
      },
    ];

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        {
          op: "insert_segment",
          with_segment_id: "SEG_INSERT",
          new_timeline_in_frame: 96,
          new_duration_frames: 48,
          beat_id: "b02",
          reason: "add dialogue line",
        },
      ],
    };

    const result = applyPatch(timeline, patch, candidates);
    expect(result.errors).toEqual([]);
    expect(result.appliedOps).toBe(1);
    // Dialogue should go to A1
    const a1 = result.timeline.tracks.audio.find((t) => t.track_id === "A1");
    expect(a1!.clips.length).toBe(1);
    expect(a1!.clips[0].segment_id).toBe("SEG_INSERT");
    expect(a1!.clips[0].timeline_in_frame).toBe(96);
    expect(a1!.clips[0].beat_id).toBe("b02");
  });

  it("add_marker and add_note insert markers", () => {
    const timeline = makeMinimalTimeline();

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "add_marker", new_timeline_in_frame: 100, reason: "review this section", label: "Review: audio QA" },
        { op: "add_note", new_timeline_in_frame: 200, reason: "Director note: extend pause" },
      ],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors).toEqual([]);
    expect(result.appliedOps).toBe(2);
    expect(result.timeline.markers.length).toBe(2);

    const reviewMarker = result.timeline.markers.find((m) => m.kind === "review");
    expect(reviewMarker!.frame).toBe(100);
    expect(reviewMarker!.label).toBe("Review: audio QA");

    const noteMarker = result.timeline.markers.find((m) => m.kind === "note");
    expect(noteMarker!.frame).toBe(200);
    expect(noteMarker!.label).toBe("Director note: extend pause");
  });

  it("change_audio_policy sets audio policy on clip", () => {
    const timeline = makeMinimalTimeline([
      { trackId: "A1", clip: { clip_id: "CLP_0001", role: "dialogue" } },
    ]);

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        {
          op: "change_audio_policy",
          target_clip_id: "CLP_0001",
          reason: "duck music under dialogue",
          audio_policy: { duck_music_db: -12, preserve_nat_sound: true },
        },
      ],
    };

    const result = applyPatch(timeline, patch, []);
    expect(result.errors).toEqual([]);
    const clip = result.timeline.tracks.audio[0].clips[0];
    expect(clip.audio_policy).toEqual({ duck_music_db: -12, preserve_nat_sound: true });
  });

  it("patch is deterministic: same inputs produce same output", () => {
    const timeline = makeMinimalTimeline([
      { trackId: "V1", clip: { clip_id: "CLP_0001", segment_id: "SEG_001" } },
      { trackId: "V2", clip: { clip_id: "CLP_0002", segment_id: "SEG_002" } },
    ]);

    const patch: ReviewPatch = {
      timeline_version: "1",
      operations: [
        { op: "trim_segment", target_clip_id: "CLP_0001", new_src_in_us: 500, new_src_out_us: 999000, reason: "trim" },
        { op: "add_marker", new_timeline_in_frame: 50, reason: "mark" },
      ],
    };

    const result1 = applyPatch(timeline, patch, []);
    // Re-create fresh timeline for second run (applyPatch clones internally)
    const result2 = applyPatch(timeline, patch, []);
    expect(JSON.stringify(result1.timeline)).toBe(JSON.stringify(result2.timeline));
  });
});
