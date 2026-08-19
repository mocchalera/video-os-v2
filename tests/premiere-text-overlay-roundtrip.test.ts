import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import {
  detectDiffs,
  parseFcp7Sequence,
} from "../runtime/handoff/fcp7-xml-import.js";
import {
  createPremiereRoundtripReceipt,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";

const ROUNDTRIP_ID = `sha256:${"a".repeat(64)}`;
const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function canonicalOverlay(overrides: Record<string, unknown> = {}) {
  const metadata = {
    overlay: {
      overlay_id: "OVL_1",
      text: "First line\nSecond line",
      styling_class: "vos:overlay.title-card",
      writing_mode: "horizontal_tb",
      anchor: "center",
      source: "authored",
    },
  };
  return {
    clip_id: "TITLE_1",
    segment_id: "TXT_OVL_1",
    asset_id: "__overlay__",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 24,
    timeline_duration_frames: 48,
    role: "title",
    motivation: "overlay",
    beat_id: "B1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    metadata,
    ...overrides,
  };
}

function timeline(overlays: any[] = [canonicalOverlay()]): TimelineIR {
  return {
    version: "2",
    project_id: "premiere-title-test",
    created_at: "2026-08-16T00:00:00.000Z",
    sequence: {
      name: "Canonical title",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      letterbox_policy: "none",
    },
    tracks: {
      video: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "VIDEO_1",
          segment_id: "SEG_1",
          asset_id: "AST_1",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          role: "hero",
          motivation: "test",
          beat_id: "B1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }],
      audio: [],
      overlay: [{ track_id: "O1", kind: "overlay", clips: overlays }],
      caption: [{
        track_id: "C1",
        kind: "caption",
        clips: [{ ...canonicalOverlay(), clip_id: "CAPTION_1", role: "dialogue" }],
      }],
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

function exportXml(value = timeline()): string {
  return timelineToFcp7Xml(value, {
    sourceMap: new Map([["AST_1", "/tmp/source.mov"]]),
    projectId: value.project_id,
    roundtripId: ROUNDTRIP_ID,
  });
}

function historicalMarkedXml(value = timeline()): string {
  const exportBase = structuredClone(value);
  exportBase.tracks.overlay = [];
  exportBase.tracks.caption = [];
  const clip = value.tracks.overlay![0].clips[0];
  const overlay = clip.metadata!.overlay as Record<string, unknown>;
  const marker = `        <marker>
          <name>video_os text overlay</name>
          <comment>video_os:{&quot;surface&quot;:&quot;text_overlay&quot;,&quot;overlay_id&quot;:&quot;${overlay.overlay_id}&quot;,&quot;clip_id&quot;:&quot;${clip.clip_id}&quot;,&quot;roundtrip_id&quot;:&quot;${ROUNDTRIP_ID}&quot;}</comment>
          <in>0</in>
          <out>-1</out>
        </marker>`;
  return timelineToFcp7Xml(exportBase, {
    sourceMap: new Map([["AST_1", "/tmp/source.mov"]]),
    projectId: value.project_id,
    roundtripId: ROUNDTRIP_ID,
    textOverlays: [{
      startFrame: clip.timeline_in_frame,
      durationFrames: clip.timeline_duration_frames,
      text: overlay.text as string,
      fontSize: 48,
      color: [255, 255, 255],
      opacity: 100,
      position: "center",
    }],
  })
    .replace('generatoritem id="legacy-title-1"', `generatoritem id="title-${clip.clip_id}-${overlay.overlay_id}"`)
    .replace("        <effect>", `${marker}\n        <effect>`);
}

function detectHistorical(xml: string, value = timeline()) {
  const rawTimeline = Buffer.from(JSON.stringify(value));
  const originalXml = historicalMarkedXml(value);
  const receipt = createPremiereRoundtripReceipt(
    value.project_id,
    rawTimeline,
    "historical.xml",
    Buffer.from(originalXml),
  );
  return detectDiffs(parseFcp7Sequence(xml), value, receipt.text_overlay_manifest);
}

function issueFrom(value: TimelineIR): Record<string, unknown> {
  try {
    exportXml(value);
    throw new Error("expected export to fail");
  } catch (error) {
    const issues = (error as { issues?: Array<Record<string, unknown>> }).issues;
    expect(issues).toHaveLength(1);
    return issues![0];
  }
}

describe("canonical Premiere text-overlay export", () => {
  it.each([
    ["vos:overlay.title-card", "font_family"],
    ["vos:overlay.chapter-kicker", "font_family"],
    ["vos:overlay.hook-title", "text_stroke"],
    ["vos:overlay.cta-card", "background"],
  ])("rejects rich preset %s instead of silently downgrading it", (stylingClass, semantic) => {
    const issue = issueFrom(timeline([canonicalOverlay({
      metadata: { overlay: {
        ...(canonicalOverlay().metadata as any).overlay,
        text: "Single line",
        styling_class: stylingClass,
      } },
    })]));
    expect(issue).toMatchObject({
      field: "metadata.overlay.styling_class",
      disposition: "blocked",
    });
    expect(issue.reason).toContain(semantic);
  });

  it.each([
    ["non-title", canonicalOverlay({ role: "support" }), "role"],
    ["missing overlay metadata", canonicalOverlay({ metadata: {} }), "metadata.overlay"],
    ["empty text", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, text: "" } } }), "metadata.overlay.text"],
    ["non-authored source", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, source: "generated" } } }), "metadata.overlay.source"],
    ["vertical text", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, writing_mode: "vertical_rl" } } }), "metadata.overlay.writing_mode"],
    ["unknown style", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, styling_class: "unknown" } } }), "metadata.overlay.styling_class"],
    ["safe area", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, safe_area: { top: 1, right: 1, bottom: 1, left: 1 } } } }), "metadata.overlay.safe_area"],
    ["background", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, background: "black" } } }), "metadata.overlay.background"],
    ["outline", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, outline: 2 } } }), "metadata.overlay.outline"],
    ["animation", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, animation: "fade" } } }), "metadata.overlay.animation"],
    ["unknown style field", canonicalOverlay({ metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, shadow: true } } }), "metadata.overlay.shadow"],
    ["negative start", canonicalOverlay({ timeline_in_frame: -1 }), "timeline_in_frame"],
    ["zero duration", canonicalOverlay({ timeline_duration_frames: 0 }), "timeline_duration_frames"],
    ["overflow", canonicalOverlay({ timeline_in_frame: Number.MAX_SAFE_INTEGER, timeline_duration_frames: 2 }), "timeline_range"],
  ])("fails before XML for %s with a structured blocked issue", (_name, overlay, field) => {
    const issue = issueFrom(timeline([overlay]));
    expect(issue).toMatchObject({ track_id: "O1", clip_id: overlay.clip_id, field, disposition: "blocked" });
    expect(issue.reason).toEqual(expect.any(String));
  });

  it("still rejects duplicate canonical identities before style projection", () => {
    const duplicateClip = canonicalOverlay({
      metadata: { overlay: { ...(canonicalOverlay().metadata as any).overlay, overlay_id: "OVL_2" } },
    });
    expect(issueFrom(timeline([canonicalOverlay(), duplicateClip]))).toMatchObject({ field: "clip_id" });
    const duplicateOverlay = canonicalOverlay({ clip_id: "TITLE_2" });
    expect(issueFrom(timeline([canonicalOverlay(), duplicateOverlay]))).toMatchObject({
      field: "metadata.overlay.overlay_id",
    });
  });

  it("fails canonical-plus-legacy input before XML without downgrading the canonical preset", () => {
    expect(() => timelineToFcp7Xml(timeline(), {
      sourceMap: new Map([["AST_1", "/tmp/source.mov"]]),
      projectId: "premiere-title-test",
      roundtripId: ROUNDTRIP_ID,
      legacyTitlesRequested: true,
      textOverlays: [],
    })).toThrow(/requires unrepresentable semantics/);
  });

  it("keeps existing XML and receipt byte-identical when legacy flags conflict", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-title-export-block-"));
    tempDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "09_output"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "05_timeline", "timeline.json"), JSON.stringify(timeline()));
    const sourceMapPath = path.join(projectDir, "source-map.json");
    const titlesPath = path.join(projectDir, "titles.json");
    fs.writeFileSync(sourceMapPath, JSON.stringify({ AST_1: "/tmp/source.mov" }));
    fs.writeFileSync(titlesPath, "[]");
    const xmlPath = path.join(projectDir, "09_output", "premiere-title-test_premiere.xml");
    const receiptPath = path.join(projectDir, "09_output", "premiere-title-test_premiere.roundtrip.json");
    fs.writeFileSync(xmlPath, "existing XML");
    fs.writeFileSync(receiptPath, "existing receipt");

    const result = spawnSync(
      path.join(repoRoot, "node_modules", ".bin", "tsx"),
      [path.join(repoRoot, "scripts/export-premiere-xml.ts"), projectDir,
        "--source-map", sourceMapPath, "--titles", titlesPath],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires unrepresentable semantics");
    expect(fs.readFileSync(xmlPath, "utf-8")).toBe("existing XML");
    expect(fs.readFileSync(receiptPath, "utf-8")).toBe("existing receipt");
  });
});

describe("canonical Premiere text-overlay report-only import", () => {
  it("keeps a receipt-manifest-bound historical marked generator clean when unchanged", () => {
    const value = timeline();
    const xml = historicalMarkedXml(value);
    const rawTimeline = Buffer.from(JSON.stringify(value));
    const receipt = createPremiereRoundtripReceipt(
      value.project_id,
      rawTimeline,
      "historical.xml",
      Buffer.from(xml),
    );
    expect(receipt.text_overlay_manifest).toHaveLength(1);
    const report = detectDiffs(
      parseFcp7Sequence(xml),
      value,
      receipt.text_overlay_manifest,
    );
    expect(report.textOverlayEdits).toEqual([]);
  });

  it.each([
    ["text_changed", (xml: string) => xml.replace("First line\nSecond line", "Changed")],
    ["timing_changed", (xml: string) => xml
      .replace("<start>24</start>", "<start>23</start>")
      .replace("<end>72</end>", "<end>71</end>")],
    ["style_changed", (xml: string) => xml.replace("<value>48</value>", "<value>47</value>")],
    ["deleted", (xml: string) => xml.replace(/\s*<generatoritem id="title-TITLE_1-OVL_1">[\s\S]*?<\/generatoritem>/, "")],
    ["malformed_marker", (xml: string) => xml.replace(`&quot;surface&quot;:&quot;text_overlay&quot;`, `&quot;surface&quot;:12`)],
    ["duplicate", (xml: string) => xml.replace("</track>\n      </video>", `${xml.match(/<generatoritem id="title-TITLE_1-OVL_1">[\s\S]*?<\/generatoritem>/)?.[0]}\n        </track>\n      </video>`)],
    ["added_unmapped", (xml: string) => xml.replace(`&quot;overlay_id&quot;:&quot;OVL_1&quot;`, `&quot;overlay_id&quot;:&quot;OVL_NEW&quot;`)],
  ])("reports %s without producing an applicable clip diff", (kind, mutate) => {
    const value = timeline();
    const report = detectHistorical(mutate(historicalMarkedXml(value)), value);
    expect(report.textOverlayEdits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind, disposition: "report_only" }),
    ]));
    expect(report.diffs).toEqual([]);
  });

  it("rejects an invalid generator range instead of accepting a malformed title", () => {
    const value = timeline();
    const xml = historicalMarkedXml(value).replace("<end>72</end>", `<end>${Number.MAX_SAFE_INTEGER + 1}</end>`);
    const report = detectHistorical(xml, value);
    expect(report.textOverlayEdits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "malformed", disposition: "report_only" }),
    ]));
  });
});
