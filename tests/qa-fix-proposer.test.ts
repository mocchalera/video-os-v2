import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SelectsCandidates, TimelineIR } from "../runtime/artifacts/types.js";
import type {
  FootageSearchResponse,
  FootageSearchResult,
  SearchFootageInput,
} from "../runtime/tools/footage-search.js";
import {
  proposeFixes,
  type QAFixSearchFn,
} from "../runtime/eval/qa-fix-proposer.js";
import type { QAIssue } from "../runtime/eval/qa-issue-detector.js";
import { QA_FIX_SNAPSHOT_LIMITS } from "../runtime/eval/qa-source-discovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function canonicalProject(): { projectDir: string; sourcePath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-proposer-canonical-"));
  tempDirs.push(projectDir);
  const sourcePath = path.join(projectDir, "source.mov");
  fs.writeFileSync(sourcePath, "media");
  writeJson(path.join(projectDir, "03_analysis", "segments.json"), {
    project_id: "qa-fixture",
    artifact_version: "1",
    items: [canonicalSegment("SEG_EXT")],
  });
  writeJson(path.join(projectDir, "03_analysis", "assets.json"), {
    project_id: "qa-fixture",
    artifact_version: "1",
    items: [{ asset_id: "AST_SEG_EXT", source_locator: "source.mov" }],
  });
  return { projectDir, sourcePath };
}

function canonicalSegment(segmentId: string) {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 1_000_000,
    src_out_us: 7_000_000,
    summary: "canonical summary",
    transcript_excerpt: "canonical transcript",
    quality_flags: ["clean"],
    tags: ["bridge", "exterior"],
    visual_quality: { scores: { composition_score: 0.8, motion_quality: 0.9 } },
    editorial_observation: {
      evidence: [{ evidence_ref: "OBS_EXT", artifact_ref: "03_analysis/frames/SEG_EXT.jpg" }],
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

function isAbsoluteLike(value: string): boolean {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^file:\/\//iu.test(value)
    || /(?:^|\s)\/(?:[^\s]+)/u.test(value)
    || /(?:^|\s)[A-Za-z]:\\(?:[^\s]+)/u.test(value)
    || /(?:^|\s)\\\\(?:[^\s]+)/u.test(value);
}

function timeline(
  clips: Array<{
    clip_id: string;
    segment_id: string;
    start: number;
    duration?: number;
    beat_id?: string;
    role?: string;
  }>,
): TimelineIR {
  return {
    version: "1",
    project_id: "qa-fixture",
    created_at: "2026-06-20T00:00:00.000Z",
    sequence: {
      name: "qa-fixture",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [
        {
          track_id: "V1",
          kind: "video",
          clips: clips.map((clip) => ({
            clip_id: clip.clip_id,
            segment_id: clip.segment_id,
            asset_id: `AST_${clip.segment_id}`,
            src_in_us: 0,
            src_out_us: 5_000_000,
            timeline_in_frame: clip.start,
            timeline_duration_frames: clip.duration ?? 96,
            role: clip.role ?? "support",
            motivation: `motivation ${clip.segment_id}`,
            beat_id: clip.beat_id ?? "b1",
            fallback_segment_ids: [],
            confidence: 0.7,
            quality_flags: [],
          })),
        },
      ],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "",
      blueprint_path: "",
      selects_path: "",
      compiler_version: "test",
    },
  };
}

function selects(extraSegments: string[] = ["SEG_R"]): SelectsCandidates {
  return {
    version: "1",
    project_id: "qa-fixture",
    candidates: [
      candidate("SEG_A", 0.6),
      candidate("SEG_B", 0.6),
      candidate("SEG_C", 0.6),
      ...extraSegments.map((segmentId, index) => candidate(segmentId, 0.9 - index * 0.02)),
    ],
  };
}

function candidate(segmentId: string, confidence: number): SelectsCandidates["candidates"][number] {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 6_000_000,
    role: "support",
    why_it_matches: `candidate ${segmentId}`,
    risks: [],
    confidence,
    eligible_beats: ["b1"],
    evidence: [segmentId],
  };
}

function issue(overrides: Partial<QAIssue> = {}): QAIssue {
  return {
    issue_id: overrides.issue_id ?? "QAISSUE_1",
    type: overrides.type ?? "quality",
    severity: overrides.severity ?? 0.8,
    timestamp_sec: overrides.timestamp_sec ?? 0,
    clip_id: overrides.clip_id ?? "CLP_A",
    beat_id: overrides.beat_id ?? "b1",
    description: overrides.description ?? "fixture issue",
    fixable: overrides.fixable ?? true,
    suggested_fix_type: overrides.suggested_fix_type ?? "swap",
    ...overrides,
  };
}

function result(segmentId: string, score = 0.9): FootageSearchResult {
  return {
    segment_id: segmentId,
    asset_id: `AST_${segmentId}`,
    src_in_us: 0,
    src_out_us: 6_000_000,
    duration_us: 6_000_000,
    score,
    scores: {
      final: score,
      qwen_visual: score,
      quality: 0.85,
    },
    match_reason: `matched ${segmentId}`,
    summary: `summary ${segmentId}`,
    key_frame_path: `03_analysis/frames/${segmentId}.jpg`,
    tags: [],
    quality_flags: [],
    quality: {
      composition_score: 0.85,
      subject_prominence: 0.85,
    },
    evidence_refs: [],
  };
}

function response(input: SearchFootageInput, results: FootageSearchResult[]): FootageSearchResponse {
  return {
    query: input,
    db_status: "ready",
    mode_used: input.mode ?? "hybrid",
    results,
    warnings: [],
  };
}

function searchReturning(results: FootageSearchResult[]): { search: QAFixSearchFn; calls: SearchFootageInput[] } {
  const calls: SearchFootageInput[] = [];
  const search = vi.fn(async (_projectDir: string, input: SearchFootageInput) => {
    calls.push(input);
    return response(input, results);
  });
  return { search, calls };
}

describe("proposeFixes", () => {
  it("deterministically proposes an external canonical segment with a bounded auditable snapshot", async () => {
    const { projectDir } = canonicalProject();
    const externalResult = {
      ...result("SEG_EXT"),
      asset_id: "AST_SEG_EXT",
      src_in_us: 1_000_000,
      src_out_us: 7_000_000,
      match_reason: "r".repeat(QA_FIX_SNAPSHOT_LIMITS.reason_chars + 20),
      evidence_refs: [
        { field: "summary" as const, value: "/tmp/private/frame.jpg", source_refs: ["/tmp/private/source.mov", "03_analysis/search.json"] },
        { field: "tag" as const, value: "C:\\private\\frame.jpg", source_refs: ["file:///private/source.mov", "\\\\server\\share\\source.mov"] },
      ],
    };
    const { search } = searchReturning([externalResult]);
    const issues = [issue()];
    const currentTimeline = timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]);
    const currentSelects = selects([]);
    const first = await proposeFixes(issues, currentTimeline, currentSelects, projectDir, { search });
    const second = await proposeFixes(issues, currentTimeline, currentSelects, projectDir, { search });

    expect(first).toEqual(second);
    expect(first[0].replacement?.snapshot).toMatchObject({
      project_id: "qa-fixture",
      segment: { segment_id: "SEG_EXT", asset_id: "AST_SEG_EXT", src_in_us: 1_000_000, src_out_us: 7_000_000 },
      target: { clip_id: "CLP_A", beat_id: "b1" },
      quality: {
        score: 0.85,
        fields: ["composition_score", "motion_quality"],
        scores: { composition_score: 0.8, motion_quality: 0.9 },
        source: "segments.visual_quality.scores",
      },
      canonical_source_ref: "03_analysis/segments.json#SEG_EXT",
      asset_source_ref: "03_analysis/assets.json#AST_SEG_EXT",
    });
    expect(first[0].replacement?.snapshot?.search.reason).toHaveLength(QA_FIX_SNAPSHOT_LIMITS.reason_chars);
    expect(first[0].replacement?.snapshot?.canonical_evidence_refs).toContain("OBS_EXT");
    expect(JSON.stringify(first[0].replacement?.snapshot)).not.toContain("/tmp/private");
    const snapshotStrings = collectStrings(first[0].replacement?.snapshot);
    expect(snapshotStrings.some(isAbsoluteLike)).toBe(false);
    expect(() => JSON.stringify(first[0])).not.toThrow();
  });

  it("rejects every unsafe external discovery gate without proposing", async () => {
    const cases: Array<{ name: string; mutate: (ctx: { projectDir: string; sourcePath: string; tl: TimelineIR; s: SelectsCandidates; iss: QAIssue; discovery: { projectId: string; minQualityScore: number; iterationExcludedSegmentIds?: string[] } }) => void }> = [
      { name: "missing segment", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "segments.json"), { project_id: "qa-fixture", artifact_version: "1", items: [] }) },
      { name: "project mismatch", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "segments.json"), { project_id: "other", artifact_version: "1", items: [canonicalSegment("SEG_EXT")] }) },
      { name: "assets project mismatch", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "assets.json"), { project_id: "other", artifact_version: "1", items: [{ asset_id: "AST_SEG_EXT", source_locator: "source.mov" }] }) },
      { name: "invalid range", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "segments.json"), { project_id: "qa-fixture", artifact_version: "1", items: [{ ...canonicalSegment("SEG_EXT"), src_out_us: 1_000_000 }] }) },
      { name: "no quality", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "segments.json"), { project_id: "qa-fixture", artifact_version: "1", items: [{ ...canonicalSegment("SEG_EXT"), visual_quality: undefined }] }) },
      { name: "invalid quality", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "segments.json"), { project_id: "qa-fixture", artifact_version: "1", items: [{ ...canonicalSegment("SEG_EXT"), visual_quality: { scores: { composition_score: 100 } } }] }) },
      { name: "subthreshold", mutate: ({ projectDir }) => writeJson(path.join(projectDir, "03_analysis", "segments.json"), { project_id: "qa-fixture", artifact_version: "1", items: [{ ...canonicalSegment("SEG_EXT"), visual_quality: { scores: { composition_score: 0.49 } } }] }) },
      { name: "missing source", mutate: ({ sourcePath }) => fs.unlinkSync(sourcePath) },
      { name: "source is directory", mutate: ({ sourcePath }) => { fs.unlinkSync(sourcePath); fs.mkdirSync(sourcePath); } },
      { name: "beat mismatch", mutate: ({ iss }) => { iss.beat_id = "b2"; } },
      { name: "used", mutate: ({ tl }) => { tl.tracks.video[0].clips.push({ ...tl.tracks.video[0].clips[0], clip_id: "CLP_EXT", segment_id: "SEG_EXT", asset_id: "AST_SEG_EXT", timeline_in_frame: 96 }); } },
      { name: "reject", mutate: ({ s }) => { s.candidates.push({ ...candidate("SEG_EXT", 0.9), role: "reject" }); } },
      { name: "iteration duplicate", mutate: ({ discovery }) => { discovery.iterationExcludedSegmentIds = ["SEG_EXT"]; } },
    ];

    for (const testCase of cases) {
      const { projectDir, sourcePath } = canonicalProject();
      const tl = timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]);
      const s = selects([]);
      const iss = issue();
      const discovery = { projectId: "qa-fixture", minQualityScore: 0.5 };
      testCase.mutate({ projectDir, sourcePath, tl, s, iss, discovery });
      const externalResult = { ...result("SEG_EXT"), asset_id: "AST_SEG_EXT", src_in_us: 1_000_000, src_out_us: 7_000_000 };
      const { search } = searchReturning([externalResult]);
      expect(await proposeFixes([iss], tl, s, projectDir, { search, discovery }), testCase.name).toEqual([]);
    }
  });

  it("rejects malformed or cross-project source maps without assets fallback", async () => {
    for (const sourceMap of ["{", JSON.stringify({ version: "1", project_id: "other", media_dir: "02_media", generated_at: new Date(0).toISOString(), items: [] })]) {
      const { projectDir } = canonicalProject();
      const sourceMapPath = path.join(projectDir, "02_media", "source_map.json");
      fs.mkdirSync(path.dirname(sourceMapPath), { recursive: true });
      fs.writeFileSync(sourceMapPath, sourceMap);
      const externalResult = { ...result("SEG_EXT"), asset_id: "AST_SEG_EXT", src_in_us: 1_000_000, src_out_us: 7_000_000 };
      const { search } = searchReturning([externalResult]);
      expect(await proposeFixes([issue()], timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]), selects([]), projectDir, { search })).toEqual([]);
    }
  });

  it("keeps legacy candidates without eligible_beats compatible but rejects artifact project mismatch", async () => {
    const s = selects(["SEG_R"]);
    delete s.candidates.find((item) => item.segment_id === "SEG_R")?.eligible_beats;
    const { search } = searchReturning([result("SEG_R")]);
    expect(await proposeFixes([issue()], timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]), s, "/tmp/project", { search })).toHaveLength(1);
    const mismatched = timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]);
    mismatched.project_id = "other";
    expect(await proposeFixes([issue()], mismatched, s, "/tmp/project", { search })).toEqual([]);
  });

  it("rejects external results whose asset or source range differs from canonical", async () => {
    for (const mismatch of [
      { asset_id: "AST_WRONG" },
      { src_in_us: 2_000_000 },
      { src_out_us: 8_000_000 },
    ]) {
      const { projectDir } = canonicalProject();
      const externalResult = { ...result("SEG_EXT"), asset_id: "AST_SEG_EXT", src_in_us: 1_000_000, src_out_us: 7_000_000, ...mismatch };
      const { search } = searchReturning([externalResult]);
      expect(await proposeFixes([issue()], timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]), selects([]), projectDir, { search })).toEqual([]);
    }
  });

  it("rejects an existing candidate explicitly ineligible for the target beat", async () => {
    const s = selects(["SEG_R"]);
    s.candidates.find((item) => item.segment_id === "SEG_R")!.eligible_beats = ["b2"];
    const { search } = searchReturning([result("SEG_R")]);
    expect(await proposeFixes(
      [issue()],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      s,
      "/tmp/project",
      { search },
    )).toEqual([]);
  });

  it("proposes a swap by searching with the visual anchor of the target clip", async () => {
    const { search, calls } = searchReturning([result("SEG_R")]);

    const fixes = await proposeFixes(
      [issue()],
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96 },
      ]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      mode: "visual",
      visual_anchor: { segment_id: "SEG_A" },
      filters: { exclude_segment_ids: ["SEG_A", "SEG_B"] },
    });
    expect(fixes[0]).toMatchObject({
      fix_type: "swap",
      target_clip_id: "CLP_A",
      replacement: { segment_id: "SEG_R", search_mode: "visual" },
    });
  });

  it("proposes a continuity bridge by searching with both adjacent visual anchors", async () => {
    const { search, calls } = searchReturning([result("SEG_R")]);

    const fixes = await proposeFixes(
      [
        issue({
          type: "continuity",
          suggested_fix_type: "insert",
          adjacent_clip_ids: { before: "CLP_A", after: "CLP_B" },
        }),
      ],
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96 },
      ]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.visual_anchor?.segment_id)).toEqual(["SEG_A", "SEG_B"]);
    expect(fixes[0]).toMatchObject({
      fix_type: "insert",
      target_clip_id: "CLP_A",
      replacement: { segment_id: "SEG_R", search_mode: "visual" },
    });
  });

  it("proposes must_have fixes by searching with the issue text", async () => {
    const { search, calls } = searchReturning([result("SEG_R")]);

    await proposeFixes(
      [
        issue({
          type: "must_have",
          search_query: "closing smile",
          suggested_fix_type: "swap",
        }),
      ],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(calls[0]).toMatchObject({
      mode: "hybrid",
      query: "closing smile",
      semantic: "closing smile",
    });
  });

  it("excludes replacements that are already in the timeline", async () => {
    const { search } = searchReturning([result("SEG_A", 0.99), result("SEG_R", 0.8)]);

    const fixes = await proposeFixes(
      [issue()],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(fixes[0].replacement?.segment_id).toBe("SEG_R");
  });

  it("respects the max fixes limit", async () => {
    const replacements = new Map([
      ["SEG_A", "SEG_R1"],
      ["SEG_B", "SEG_R2"],
      ["SEG_C", "SEG_R3"],
    ]);
    const search = vi.fn(async (_projectDir: string, input: SearchFootageInput) => {
      const anchor = input.visual_anchor?.segment_id ?? "";
      const segmentId = replacements.get(anchor) ?? "SEG_R1";
      return response(input, [result(segmentId, 0.9)]);
    });

    const fixes = await proposeFixes(
      [
        issue({ issue_id: "QAISSUE_A", clip_id: "CLP_A" }),
        issue({ issue_id: "QAISSUE_B", clip_id: "CLP_B" }),
        issue({ issue_id: "QAISSUE_C", clip_id: "CLP_C" }),
      ],
      timeline([
        { clip_id: "CLP_A", segment_id: "SEG_A", start: 0 },
        { clip_id: "CLP_B", segment_id: "SEG_B", start: 96 },
        { clip_id: "CLP_C", segment_id: "SEG_C", start: 192 },
      ]),
      selects(["SEG_R1", "SEG_R2", "SEG_R3"]),
      "/tmp/project",
      { search, maxFixes: 2 },
    );

    expect(fixes).toHaveLength(2);
  });

  it("filters fixes below the minimum expected improvement", async () => {
    const { search } = searchReturning([result("SEG_R", 0.05)]);

    const fixes = await proposeFixes(
      [issue({ severity: 0.1 })],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search, minImprovement: 0.2, minQualityScore: 0 },
    );

    expect(fixes).toEqual([]);
  });

  it("skips gracefully when no replacement is found", async () => {
    const { search } = searchReturning([]);

    const fixes = await proposeFixes(
      [issue()],
      timeline([{ clip_id: "CLP_A", segment_id: "SEG_A", start: 0 }]),
      selects(),
      "/tmp/project",
      { search },
    );

    expect(fixes).toEqual([]);
  });
});
