import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TimelineIR } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import {
  createPremiereRoundtripReceipt,
  derivePremiereRoundtripId,
  parsePremiereRoundtripReceipt,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const tempDirs: string[] = [];

function sha256(raw: string | Buffer): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function timeline(projectId = "roundtrip-base-conflict"): TimelineIR {
  return {
    version: "1",
    project_id: projectId,
    created_at: "2026-08-15T00:00:00Z",
    sequence: {
      name: "Premiere Roundtrip Base Conflict",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{
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
            motivation: "first fixture clip",
            beat_id: "beat-1",
            fallback_segment_ids: [],
            confidence: 1,
            quality_flags: [],
          },
          {
            clip_id: "CLP_0002",
            segment_id: "SEG_0002",
            asset_id: "AST_0002",
            src_in_us: 0,
            src_out_us: 1_000_000,
            timeline_in_frame: 24,
            timeline_duration_frames: 24,
            role: "primary",
            motivation: "second fixture clip",
            beat_id: "beat-2",
            fallback_segment_ids: [],
            confidence: 1,
            quality_flags: [],
          },
        ],
      }],
      audio: [],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

interface Fixture {
  projectDir: string;
  timelinePath: string;
  xmlPath: string;
  receiptPath: string;
  originalTimeline: string;
}

function runScript(script: "export" | "import", args: string[]) {
  const result = spawnSync(
    tsxPath,
    [path.join(repoRoot, "scripts", `${script}-premiere-xml.ts`), ...args],
    { cwd: repoRoot, encoding: "utf-8", env: { ...process.env, FORCE_COLOR: "0" } },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function createFixture(): Fixture {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-roundtrip-base-"));
  tempDirs.push(projectDir);
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const outputDir = path.join(projectDir, "09_output");
  const sourceMapPath = path.join(projectDir, "source-map.json");
  const value = timeline();
  const originalTimeline = JSON.stringify(value, null, 2);
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.writeFileSync(timelinePath, originalTimeline);
  fs.writeFileSync(sourceMapPath, JSON.stringify({ AST_0001: "/media/a.mov", AST_0002: "/media/b.mov" }));
  const exported = runScript("export", [projectDir, "--source-map", sourceMapPath]);
  expect(exported.status, exported.stderr).toBe(0);
  return {
    projectDir,
    timelinePath,
    xmlPath: path.join(outputDir, `${value.project_id}_premiere.xml`),
    receiptPath: path.join(outputDir, `${value.project_id}_premiere.roundtrip.json`),
    originalTimeline,
  };
}

function trimFirstClip(xml: string): string {
  const changed = xml.replace(
    /(<clipitem id="cv-CLP_0001">[\s\S]*?<out>)24(<\/out>)/,
    "$120$2",
  );
  if (changed === xml) throw new Error("fixture did not trim first clip");
  return changed;
}

function expectNoMutation(fixture: Fixture): void {
  expect(fs.readFileSync(fixture.timelinePath, "utf-8")).toBe(fixture.originalTimeline);
  expect(fs.existsSync(`${fixture.timelinePath}.bak`)).toBe(false);
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Premiere roundtrip receipt export", () => {
  it("writes a closed v1 receipt and embeds one deterministic roundtrip id", () => {
    const fixture = createFixture();
    const rawTimeline = fs.readFileSync(fixture.timelinePath);
    const rawXml = fs.readFileSync(fixture.xmlPath);
    const receipt = parsePremiereRoundtripReceipt(fs.readFileSync(fixture.receiptPath, "utf-8"));
    expect(Object.keys(receipt).sort()).toEqual([
      "base_timeline_sha256",
      "exported_xml_filename",
      "exported_xml_sha256",
      "project_id",
      "roundtrip_id",
      "version",
    ]);
    expect(receipt.version).toBe("premiere-roundtrip-receipt/v1");
    expect(receipt.base_timeline_sha256).toBe(sha256(rawTimeline));
    expect(receipt.exported_xml_filename).toBe(path.basename(fixture.xmlPath));
    expect(receipt.exported_xml_sha256).toBe(sha256(rawXml));
    expect(receipt.roundtrip_id).toBe(
      derivePremiereRoundtripId(receipt.project_id, receipt.base_timeline_sha256),
    );
    const ids = [...fs.readFileSync(fixture.xmlPath, "utf-8").matchAll(/&quot;roundtrip_id&quot;:&quot;(sha256:[0-9a-f]{64})&quot;/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([receipt.roundtrip_id]));
  });

  it("derives the same id for the same project and raw base hash", () => {
    const base = sha256("same raw timeline bytes");
    expect(derivePremiereRoundtripId("project-a", base)).toBe(
      derivePremiereRoundtripId("project-a", base),
    );
    expect(createPremiereRoundtripReceipt("project-a", Buffer.from("same raw timeline bytes"), "a.xml", Buffer.from("xml")).roundtrip_id)
      .toBe(derivePremiereRoundtripId("project-a", base));
  });

  it("rejects project ids that could escape or form dot segments before output", () => {
    for (const projectId of ["../escaped", "..", ".", "nested/project", "nested\\project"]) {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-output-path-"));
      tempDirs.push(projectDir);
      const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
      const sourceMapPath = path.join(projectDir, "source-map.json");
      fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
      fs.writeFileSync(timelinePath, JSON.stringify(timeline(projectId), null, 2));
      fs.writeFileSync(sourceMapPath, JSON.stringify({ AST_0001: "/media/a.mov", AST_0002: "/media/b.mov" }));

      const result = runScript("export", [projectDir, "--source-map", sourceMapPath]);
      expect(result.status, projectId).toBe(1);
      expect(result.stderr, projectId).toContain("unsafe project_id");
      expect(fs.existsSync(path.join(projectDir, "09_output")), projectId).toBe(false);
      expect(fs.existsSync(path.join(projectDir, "escaped_premiere.xml")), projectId).toBe(false);
    }
  });
});

describe("Premiere roundtrip apply gate", () => {
  it("keeps receipt-less legacy XML preview-compatible", () => {
    const fixture = createFixture();
    const legacyXml = fs.readFileSync(fixture.xmlPath, "utf-8").replace(
      /,&quot;roundtrip_id&quot;:&quot;sha256:[0-9a-f]{64}&quot;/g,
      "",
    );
    fs.writeFileSync(fixture.xmlPath, trimFirstClip(legacyXml));
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "preview", applied: false, total_diffs: 1 });
    expectNoMutation(fixture);
  });

  it("rejects apply without a receipt before backup or write", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.xmlPath, trimFirstClip(fs.readFileSync(fixture.xmlPath, "utf-8")));
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--receipt is required with --apply");
    expectNoMutation(fixture);
  });

  it("applies a mapped edit with a matching session and base", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.xmlPath, trimFirstClip(fs.readFileSync(fixture.xmlPath, "utf-8")));
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Applied 1 change(s).");
    expect(fs.existsSync(`${fixture.timelinePath}.bak`)).toBe(true);
  });

  it("rejects a stale raw timeline base before backup or write", () => {
    const fixture = createFixture();
    fs.appendFileSync(fixture.timelinePath, "\n");
    const staleRaw = fs.readFileSync(fixture.timelinePath, "utf-8");
    fs.writeFileSync(fixture.xmlPath, trimFirstClip(fs.readFileSync(fixture.xmlPath, "utf-8")));
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("base timeline hash mismatch");
    expect(fs.readFileSync(fixture.timelinePath, "utf-8")).toBe(staleRaw);
    expect(fs.existsSync(`${fixture.timelinePath}.bak`)).toBe(false);
  });

  it("rejects a wrong project receipt", () => {
    const fixture = createFixture();
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf-8"));
    receipt.project_id = "other-project";
    receipt.roundtrip_id = derivePremiereRoundtripId(receipt.project_id, receipt.base_timeline_sha256);
    fs.writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("project_id mismatch");
    expectNoMutation(fixture);
  });

  it("rejects missing, malformed, mixed, and mismatched marker sessions", () => {
    const transforms: Array<[string, (xml: string) => string]> = [
      ["missing", (xml) => xml.replace(/,&quot;roundtrip_id&quot;:&quot;sha256:[0-9a-f]{64}&quot;/, "")],
      ["malformed", (xml) => xml.replace(/sha256:[0-9a-f]{64}/, "sha256:not-a-hash")],
      ["mixed", (xml) => xml.replace(/sha256:[0-9a-f]{64}/, `sha256:${"1".repeat(64)}`)],
      ["mismatch", (xml) => xml.replaceAll(/sha256:[0-9a-f]{64}/g, `sha256:${"2".repeat(64)}`)],
    ];
    for (const [label, transform] of transforms) {
      const fixture = createFixture();
      fs.writeFileSync(fixture.xmlPath, transform(fs.readFileSync(fixture.xmlPath, "utf-8")));
      const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply"]);
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toContain("roundtrip_id");
      expectNoMutation(fixture);
    }
  });

  it("rejects a base clip whose complete video_os marker block is missing", () => {
    const fixture = createFixture();
    const xml = fs.readFileSync(fixture.xmlPath, "utf-8");
    const withoutFirstMarker = xml.replace(
      /\n\s*<marker>\n\s*<name>primary<\/name>\n\s*<comment>video_os:[\s\S]*?<\/marker>/,
      "",
    );
    expect(withoutFirstMarker).not.toBe(xml);
    expect(withoutFirstMarker).toContain('clipitem id="cv-CLP_0001"');
    fs.writeFileSync(fixture.xmlPath, withoutFirstMarker);

    const result = runScript("import", [
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      "--receipt",
      fixture.receiptPath,
      "--apply",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "base FCP7 clip cv-CLP_0001 is missing its video_os marker block",
    );
    expectNoMutation(fixture);
  });

  it("rejects non-closed receipts", () => {
    const fixture = createFixture();
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf-8"));
    receipt.exported_at = "2026-08-15T00:00:00Z";
    fs.writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected receipt field");
    expectNoMutation(fixture);
  });

  it("validates before returning non-applied for no diffs", () => {
    const fixture = createFixture();
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--receipt is required with --apply");
    expectNoMutation(fixture);
  });

  it("validates then leaves only-unmapped diffs non-applied", () => {
    const fixture = createFixture();
    const added = [
      '        <clipitem id="premiere-added-1">',
      "          <name>Premiere added clip</name>",
      "          <start>48</start><end>60</end><in>0</in><out>12</out>",
      "        </clipitem>",
    ].join("\n");
    const xml = fs.readFileSync(fixture.xmlPath, "utf-8").replace(/(\s*<\/track>)/, `\n${added}$1`);
    fs.writeFileSync(fixture.xmlPath, xml);
    const result = runScript("import", [fixture.projectDir, "--xml", fixture.xmlPath, "--receipt", fixture.receiptPath, "--apply", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "apply", applied: false, by_kind: { added_unmapped: 1 } });
    expectNoMutation(fixture);
  });
});
