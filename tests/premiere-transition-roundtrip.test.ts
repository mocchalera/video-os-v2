import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import type { TimelineIR } from "../runtime/compiler/types.js";
import {
  SimpleTransitionExportError,
  timelineToFcp7Xml,
} from "../runtime/handoff/fcp7-xml-export.js";
import {
  detectDiffs,
  parseFcp7Sequence,
  parsedSequenceToTimelineIR,
} from "../runtime/handoff/fcp7-xml-import.js";
import {
  createPremiereRoundtripReceipt,
  derivePremiereRoundtripId,
  sha256Prefixed,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (opts: Record<string, unknown>) => {
  compile(schema: object): (data: unknown) => boolean;
};
const fixturePath = path.join(repoRoot, "tests/fixtures/premiere/finish-surfaces-rich-v1.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  fixture_kind: string;
  timeline: TimelineIR;
};
const tempDirs: string[] = [];

function transitionTimeline(): TimelineIR {
  const timeline = structuredClone(fixture.timeline);
  delete timeline.tracks.overlay;
  return timeline;
}

function sourceMap(): Map<string, string> {
  return new Map([
    ["asset-a", "/synthetic/a.mov"],
    ["asset-b", "/synthetic/b.mov"],
    ["asset-c", "/synthetic/c.mov"],
    ["asset-audio", "/synthetic/music.wav"],
  ]);
}

function exportXml(timeline = transitionTimeline(), roundtripId?: string): string {
  return timelineToFcp7Xml(timeline, {
    sourceMap: sourceMap(),
    projectId: timeline.project_id,
    roundtripId,
  });
}

function transitionBlocks(xml: string): string[] {
  return xml.match(/\s*<transitionitem>[\s\S]*?<\/transitionitem>/g) ?? [];
}

function reportFor(transform: (xml: string) => string) {
  const timeline = transitionTimeline();
  const xml = exportXml(timeline);
  const changed = transform(xml);
  if (changed === xml) throw new Error("test transform did not change XML");
  return detectDiffs(parseFcp7Sequence(changed), timeline);
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("synthetic rich transition fixture", () => {
  it("is explicitly synthetic and contains the bounded finish surfaces", () => {
    expect(fixture.fixture_kind).toBe("synthetic_not_premiere_hardware_proof");
    expect(fixture.timeline.tracks.video[0].clips).toHaveLength(3);
    expect(fixture.timeline.transitions?.map((item) => item.transition_frames)).toEqual([12, 8]);
    expect(fixture.timeline.tracks.overlay?.[0].clips).toHaveLength(2);
    expect(fixture.timeline.tracks.audio[0].clips[0].audio_policy).toMatchObject({
      bgm_gain: -6,
      bgm_fade_in_frames: 12,
      bgm_fade_out_frames: 18,
    });
    expect(fixture.timeline.tracks.caption?.[0].clips).toHaveLength(1);
  });

  it("emits exact marked effects/audio levels and never turns caption data into a generator", () => {
    const xml = exportXml();
    expect(xml).toContain("<effectid>CrossDissolve</effectid>");
    expect(xml).toContain("<effectid>DipToColor</effectid>");
    expect(xml).toContain("video_os_transition:");
    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).not.toContain("Caption must not become a generator");
    expect(xml).not.toContain("<generatoritem");
  });

  it("has a zero-transition-diff self roundtrip and preserves exact transition identity", () => {
    const timeline = transitionTimeline();
    const parsed = parseFcp7Sequence(exportXml(timeline));
    const report = detectDiffs(parsed, timeline);
    expect(report.transitionEdits).toEqual([]);
    expect(report.transitionSourceHandleAuthority).toBe("missing");
    expect(parsedSequenceToTimelineIR(parsed, timeline).transitions).toEqual(timeline.transitions);
  });
});

describe("simple transition report-only classification", () => {
  it.each([
    ["deleted", (xml: string) => xml.replace(transitionBlocks(xml)[0], ""), "deleted"],
    ["effect", (xml: string) => xml.replace("Cross Dissolve", "Dip to Color").replace("CrossDissolve", "DipToColor"), "effect_changed"],
    ["duration", (xml: string) => xml.replace("<start>42</start>", "<start>41</start>"), "duration_changed"],
    ["window", (xml: string) => xml.replace("<start>42</start>", "<start>43</start>").replace("<end>54</end>", "<end>55</end>"), "window_changed"],
    ["alignment", (xml: string) => xml.replace("<alignment>center</alignment>", "<alignment>start</alignment>"), "alignment_changed"],
    ["identity", (xml: string) => xml.replace("transition-ab", "transition-renamed"), "identity_changed"],
    ["unknown", (xml: string) => xml.replace("Cross Dissolve", "Page Peel").replace("CrossDissolve", "PagePeel"), "unknown_effect"],
    ["added", (xml: string) => xml.replace("&quot;track_id&quot;:&quot;V1&quot;", "&quot;track_id&quot;:&quot;V9&quot;"), "added"],
    ["orphan", (xml: string) => xml.replace(/\s*<clipitem id="cv-video-b">[\s\S]*?<\/clipitem>/, ""), "orphan_endpoint"],
    ["duplicate", (xml: string) => xml.replace(transitionBlocks(xml)[0], `${transitionBlocks(xml)[0]}${transitionBlocks(xml)[0]}`), "duplicate_edge"],
  ])("classifies %s without making it applicable", (_label, transform, kind) => {
    const report = reportFor(transform);
    expect(report.transitionEdits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind,
        surface: "simple_transition",
        disposition: "report_only",
        source_handle_authority: "missing",
      }),
    ]));
  });

  it("does not default an unknown effect to crossfade", () => {
    const timeline = transitionTimeline();
    const xml = exportXml(timeline)
      .replace("Cross Dissolve", "Mystery")
      .replace("CrossDissolve", "MysteryEffect");
    const imported = parsedSequenceToTimelineIR(parseFcp7Sequence(xml), timeline);
    expect(imported.transitions?.some((item) => item.transition_id === "transition-ab")).toBe(false);
  });

  it("does not reconstruct markerless Cross Dissolve as canonical crossfade", () => {
    const timeline = transitionTimeline();
    const xml = exportXml(timeline).replace(
      /\s*<comment>video_os_transition:[\s\S]*?<\/comment>/,
      "",
    );
    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    expect(report.transitionEdits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "identity_changed" }),
    ]));
    expect(imported.transitions?.some((item) => item.transition_id === "transition-ab")).toBe(false);
  });

  it("does not reconstruct Cross Dissolve with an unknown effect ID", () => {
    const timeline = transitionTimeline();
    const xml = exportXml(timeline).replace(
      "<effectid>CrossDissolve</effectid>",
      "<effectid>UnknownDissolve</effectid>",
    );
    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    expect(report.transitionEdits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "unknown_effect" }),
    ]));
    expect(imported.transitions?.some((item) => item.transition_id === "transition-ab")).toBe(false);
  });

  it("blocks a mixed supported trim plus transition change before backup or write", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-transition-gate-"));
    tempDirs.push(projectDir);
    const timeline = transitionTimeline();
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const xmlPath = path.join(projectDir, "returned.xml");
    const receiptPath = path.join(projectDir, "receipt.json");
    const original = JSON.stringify(timeline, null, 2);
    const raw = Buffer.from(original);
    const roundtripId = derivePremiereRoundtripId(timeline.project_id, sha256Prefixed(raw));
    const baseXml = exportXml(timeline, roundtripId);
    const changedXml = baseXml
      .replace(
        /(<clipitem id="cv-video-a">[\s\S]*?<out>)120(<\/out>)/,
        (_match, prefix: string, suffix: string) => `${prefix}117${suffix}`,
      )
      .replace("<start>42</start>", "<start>43</start>")
      .replace("<end>54</end>", "<end>55</end>");
    const receipt = createPremiereRoundtripReceipt(
      timeline.project_id,
      raw,
      "export.xml",
      Buffer.from(baseXml),
    );
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, original);
    fs.writeFileSync(xmlPath, changedXml);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const preview = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules/.bin/tsx"),
      path.join(repoRoot, "scripts/import-premiere-xml.ts"),
      projectDir,
      "--xml", xmlPath,
      "--json",
    ], { cwd: repoRoot, encoding: "utf8" });
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      mode: "preview",
      applied: false,
      apply_blocked: false,
      simple_transition_edit_count: 1,
      transition_edits: [expect.objectContaining({ kind: "window_changed" })],
    });
    expect(fs.readFileSync(timelinePath, "utf8")).toBe(original);
    expect(fs.existsSync(`${timelinePath}.bak`)).toBe(false);

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules/.bin/tsx"),
      path.join(repoRoot, "scripts/import-premiere-xml.ts"),
      projectDir,
      "--xml", xmlPath,
      "--receipt", receiptPath,
      "--apply",
      "--json",
    ], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      applied: false,
      apply_blocked: true,
      block_reason: "simple_transition_edit",
      total_diffs: 1,
      simple_transition_edit_count: 1,
      transition_source_handle_authority: "missing",
      transition_edits: [expect.objectContaining({ kind: "window_changed" })],
    });
    expect(fs.readFileSync(timelinePath, "utf8")).toBe(original);
    expect(fs.existsSync(`${timelinePath}.bak`)).toBe(false);
  });
});

describe("strict simple transition export geometry", () => {
  it("never maps fade_to_black to Cross Dissolve", () => {
    const timeline = transitionTimeline();
    timeline.transitions![0].transition_type = "fade_to_black";
    timeline.transitions![0].applied_skill_id = "crossfade_bridge";
    expect(() => exportXml(timeline)).toThrow(SimpleTransitionExportError);
  });

  it.each([
    ["duplicate id", (timeline: TimelineIR) => { timeline.transitions![1].transition_id = timeline.transitions![0].transition_id; }],
    ["duplicate edge", (timeline: TimelineIR) => { timeline.transitions![1].from_clip_id = "video-a"; timeline.transitions![1].to_clip_id = "video-b"; }],
    ["non-adjacent", (timeline: TimelineIR) => { timeline.transitions![0].to_clip_id = "video-c"; }],
    ["missing endpoint", (timeline: TimelineIR) => { timeline.transitions![0].from_clip_id = "missing"; }],
    ["fractional duration", (timeline: TimelineIR) => { timeline.transitions![0].transition_frames = 1.5; }],
    ["non-positive duration", (timeline: TimelineIR) => { timeline.transitions![0].transition_frames = 0; }],
    ["non-meeting intervals", (timeline: TimelineIR) => { timeline.tracks.video[0].clips[1].timeline_in_frame = 50; }],
    ["window outside neighbor", (timeline: TimelineIR) => { timeline.transitions![0].transition_frames = 120; }],
  ])("rejects %s", (_label, mutate) => {
    const timeline = transitionTimeline();
    mutate(timeline);
    expect(() => exportXml(timeline)).toThrow(SimpleTransitionExportError);
  });
});

describe("Premiere profile simple transition contract", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas/nle-capability-profile.schema.json"), "utf8"));
  const profile = parseYaml(fs.readFileSync(path.join(repoRoot, "runtime/nle-profiles/premiere-v1.yaml"), "utf8")) as Record<string, any>;
  const validate = new Ajv2020({ strict: false }).compile(schema);

  it("is report_only with exactly dissolve and dip_to_color and validates", () => {
    expect(profile.surfaces.simple_transition).toEqual({
      mode: "report_only",
      allowed_types: ["dissolve", "dip_to_color"],
    });
    expect(validate(profile)).toBe(true);
  });

  it.each([
    ["missing", ["dissolve"], "report_only"],
    ["extra", ["dissolve", "dip_to_color", "wipe"], "report_only"],
    ["duplicate", ["dissolve", "dissolve"], "report_only"],
    ["wipe", ["dissolve", "wipe"], "report_only"],
    ["stronger provisional", ["dissolve", "dip_to_color"], "provisional_roundtrip"],
    ["stronger verified", ["dissolve", "dip_to_color"], "verified_roundtrip"],
  ])("schema rejects %s content", (_label, allowedTypes, mode) => {
    const changed = structuredClone(profile);
    changed.surfaces.simple_transition = { mode, allowed_types: allowedTypes };
    expect(validate(changed)).toBe(false);
  });
});
