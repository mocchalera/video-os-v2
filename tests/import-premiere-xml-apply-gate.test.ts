import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import {
  createPremiereRoundtripReceipt,
  derivePremiereRoundtripId,
  sha256Prefixed,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const tempDirs: string[] = [];

interface Fixture {
  projectDir: string;
  timelinePath: string;
  xmlPath: string;
  receiptPath: string;
  originalTimeline: string;
}

function runImport(args: string[]) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;

  const result = spawnSync(
    tsxPath,
    [path.join(repoRoot, "scripts/import-premiere-xml.ts"), ...args],
    { cwd: repoRoot, encoding: "utf-8", env },
  );

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function createFixture(xmlTransform: (xml: string) => string, overlayOnly = false): Fixture {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "video-os-premiere-apply-gate-"),
  );
  tempDirs.push(projectDir);

  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const xmlPath = path.join(projectDir, "edited.xml");
  const receiptPath = path.join(projectDir, "premiere.roundtrip.json");
  const timeline: TimelineIR = {
    version: "1",
    project_id: "premiere-apply-gate",
    created_at: "2026-08-15T00:00:00Z",
    sequence: {
      name: "Premiere Apply Gate",
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
          clips: [
            {
              clip_id: "CLP_0001",
              segment_id: "SEG_0001",
              asset_id: "AST_0001",
              src_in_us: 0,
              src_out_us: 1_000_000,
              timeline_in_frame: 0,
              timeline_duration_frames: 24,
              role: "primary",
              motivation: "apply gate fixture",
              beat_id: "beat-1",
              fallback_segment_ids: [],
              confidence: 1,
              quality_flags: [],
            },
          ],
        },
      ],
      audio: [],
      overlay: [{
        track_id: "O1",
        kind: "overlay",
        clips: [{
          clip_id: "TITLE_1",
          segment_id: "TXT_OVL_1",
          asset_id: "__overlay__",
          src_in_us: 0,
          src_out_us: 1_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 24,
          role: "title",
          motivation: "overlay",
          beat_id: "beat-1",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
          metadata: { overlay: {
            overlay_id: "OVL_1",
            text: "Canonical title",
            styling_class: "vos:overlay.title-card",
            writing_mode: "horizontal_tb",
            anchor: "center",
            source: "authored",
          } },
        }],
      }],
      caption: [{ track_id: "C1", kind: "caption", clips: [] }],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
  if (overlayOnly) timeline.tracks.video = [];
  const originalTimeline = JSON.stringify(timeline, null, 2);
  const rawTimeline = Buffer.from(originalTimeline, "utf-8");
  const baseTimelineSha256 = sha256Prefixed(rawTimeline);
  const roundtripId = derivePremiereRoundtripId(
    timeline.project_id,
    baseTimelineSha256,
  );
  const exportBase = structuredClone(timeline);
  exportBase.tracks.overlay = [];
  exportBase.tracks.caption = [];
  const xml = timelineToFcp7Xml(exportBase, {
    sourceMap: new Map([["AST_0001", "/fixtures/clip.mp4"]]),
    projectId: timeline.project_id,
    roundtripId,
    textOverlays: [{
      startFrame: 0,
      durationFrames: 24,
      text: "Canonical title",
      fontSize: 48,
      color: [255, 255, 255],
      opacity: 100,
      position: "center",
    }],
  })
    .replace('generatoritem id="legacy-title-1"', 'generatoritem id="title-TITLE_1-OVL_1"')
    .replace("        <effect>", `        <marker>
          <name>video_os text overlay</name>
          <comment>video_os:{&quot;surface&quot;:&quot;text_overlay&quot;,&quot;overlay_id&quot;:&quot;OVL_1&quot;,&quot;clip_id&quot;:&quot;TITLE_1&quot;,&quot;roundtrip_id&quot;:&quot;${roundtripId}&quot;}</comment>
          <in>0</in>
          <out>-1</out>
        </marker>
        <effect>`);
  const receipt = createPremiereRoundtripReceipt(
    timeline.project_id,
    rawTimeline,
    `${timeline.project_id}_premiere.xml`,
    Buffer.from(xml, "utf-8"),
  );

  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.writeFileSync(timelinePath, originalTimeline, "utf-8");
  fs.writeFileSync(xmlPath, xmlTransform(xml), "utf-8");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), "utf-8");

  return { projectDir, timelinePath, xmlPath, receiptPath, originalTimeline };
}

function withMappedTrim(xml: string): string {
  const changed = xml.replace(
    /(<clipitem id="cv-CLP_0001">[\s\S]*?<out>)24(<\/out>)/,
    "$120$2",
  );
  if (changed === xml) throw new Error("fixture did not alter mapped clip");
  return changed;
}

function withUnmappedClip(xml: string): string {
  const clip = [
    '        <clipitem id="premiere-added-1">',
    "          <name>Premiere added clip</name>",
    "          <start>24</start>",
    "          <end>36</end>",
    "          <in>0</in>",
    "          <out>12</out>",
    "        </clipitem>",
  ].join("\n");
  return xml.replace(/(\s*<\/track>)/, `\n${clip}$1`);
}

function expectNoMutation(fixture: Fixture): void {
  expect(fs.readFileSync(fixture.timelinePath, "utf-8")).toBe(
    fixture.originalTimeline,
  );
  expect(fs.existsSync(`${fixture.timelinePath}.bak`)).toBe(false);
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("import-premiere-xml explicit apply gate", () => {
  it("previews by default without writing timeline or backup", () => {
    const fixture = createFixture(withMappedTrim);
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[PREVIEW] No changes applied.");
    expectNoMutation(fixture);
  });

  it("keeps --dry-run as a preview-only compatibility alias", () => {
    const fixture = createFixture(withMappedTrim);
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--dry-run",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[PREVIEW] No changes applied.");
    expectNoMutation(fixture);
  });

  it("mutates and backs up only with --apply", () => {
    const fixture = createFixture(withMappedTrim);
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--receipt",
      fixture.receiptPath,
      "--apply",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Applied 1 change(s).");
    expect(fs.readFileSync(`${fixture.timelinePath}.bak`, "utf-8")).toBe(
      fixture.originalTimeline,
    );
    expect(fs.readFileSync(fixture.timelinePath, "utf-8")).not.toBe(
      fixture.originalTimeline,
    );
    const patched = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf-8"));
    const original = JSON.parse(fixture.originalTimeline);
    expect(patched.tracks.overlay).toEqual(original.tracks.overlay);
    expect(patched.tracks.caption).toEqual(original.tracks.caption);
  });

  it("rejects --apply with --dry-run before reading project artifacts", () => {
    const result = runImport([
      path.join(os.tmpdir(), "missing-premiere-project"),
      "--xml",
      path.join(os.tmpdir(), "missing-premiere.xml"),
      "--apply",
      "--dry-run",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--apply and --dry-run cannot be used together");
    expect(result.stderr).not.toContain("timeline.json not found");
    expect(result.stderr).not.toContain("XML file not found");
  });

  it("emits one pure JSON document with preview mode and applied state", () => {
    const fixture = createFixture(withMappedTrim);
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--json",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      mode: string;
      applied: boolean;
      total_diffs: number;
    };
    expect(parsed.mode).toBe("preview");
    expect(parsed.applied).toBe(false);
    expect(parsed.total_diffs).toBe(1);
    expect(result.stdout.trimEnd().endsWith("}")).toBe(true);
    expectNoMutation(fixture);
  });

  it("never auto-applies added_unmapped clips even in apply mode", () => {
    const fixture = createFixture(withUnmappedClip);
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--receipt",
      fixture.receiptPath,
      "--apply",
      "--json",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      mode: string;
      applied: boolean;
      by_kind: Record<string, number>;
    };
    expect(parsed.mode).toBe("apply");
    expect(parsed.applied).toBe(false);
    expect(parsed.by_kind.added_unmapped).toBe(1);
    expectNoMutation(fixture);
  });

  it("blocks mixed clip-plus-title changes before backup or timeline write", () => {
    const fixture = createFixture((xml) => withMappedTrim(xml).replace(
      "<value>Canonical title</value>",
      "<value>Premiere changed title</value>",
    ));
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--receipt",
      fixture.receiptPath,
      "--apply",
      "--json",
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      applied: false,
      apply_blocked: true,
      block_reason: "text_overlay_edit",
      total_diffs: 1,
      text_overlay_edit_count: 1,
    });
    expectNoMutation(fixture);
  });

  it.each([
    ["deleted", (xml: string) => xml.replace(/\s*<generatoritem id="title-TITLE_1-OVL_1">[\s\S]*?<\/generatoritem>/, "")],
    ["malformed_marker", (xml: string) => xml.replace(
      `&quot;surface&quot;:&quot;text_overlay&quot;`,
      `&quot;surface&quot;:12`,
    )],
  ])("reports an overlay-only sole title as %s and blocks before write", (kind, mutate) => {
    const fixture = createFixture(mutate, true);
    const result = runImport([
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--receipt",
      fixture.receiptPath,
      "--apply",
      "--json",
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      applied: false,
      apply_blocked: true,
      block_reason: "text_overlay_edit",
      receipt_validation: { provided: true, valid: true },
      text_overlay_edits: expect.arrayContaining([
        expect.objectContaining({ kind, disposition: "report_only" }),
      ]),
    });
    expectNoMutation(fixture);
  });

  it("blocks a treated base without receipt before diff detection", () => {
    const fixture = createFixture((xml) => xml);
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    timeline.tracks.video[0].clips[0].metadata = { zoom: 1.1 };
    fs.writeFileSync(fixture.timelinePath, JSON.stringify(timeline, null, 2));
    const expected = fs.readFileSync(fixture.timelinePath, "utf8");
    const result = runImport([fixture.projectDir, "--xml", fixture.xmlPath, "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: false, apply_blocked: true, would_block_apply: true, block_reason: "baked_media_unverified: receipt v2 required for treated base or baked marker", total_diffs: 0 });
    expect(fs.readFileSync(fixture.timelinePath, "utf8")).toBe(expected);
    expect(fs.existsSync(`${fixture.timelinePath}.bak`)).toBe(false);
  });

  it("preserves closed receipt rejection wording and blocks before diff or backup", () => {
    const fixture = createFixture(withMappedTrim);
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf8"));
    receipt.unexpected = true;
    fs.writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
    const result = runImport([fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected receipt field");
    expect(result.stdout).not.toContain("Diffs detected");
    expectNoMutation(fixture);
  });
});
