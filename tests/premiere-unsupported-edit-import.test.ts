import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClipOutput, TimelineIR } from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import {
  detectDiffs,
  parseFcp7Sequence,
} from "../runtime/handoff/fcp7-xml-import.js";
import {
  createPremiereRoundtripReceipt,
  derivePremiereRoundtripId,
  sha256Prefixed,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const tempDirs: string[] = [];

function makeClip(
  clipId: string,
  assetId: string,
  role: string,
  timelineInFrame: number,
): ClipOutput {
  return {
    clip_id: clipId,
    segment_id: `segment-${clipId}`,
    asset_id: assetId,
    src_in_us: 0,
    src_out_us: 2_000_000,
    timeline_in_frame: timelineInFrame,
    timeline_duration_frames: 48,
    role,
    motivation: `${clipId} fixture`,
    beat_id: `beat-${clipId}`,
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
  };
}

function makeTimeline(): TimelineIR {
  const video1 = makeClip("video-1", "asset-video-1", "primary", 0);
  const video2 = makeClip("video-2", "asset-video-2", "primary", 48);
  const audio = makeClip("audio-1", "asset-audio-1", "music", 0);
  audio.audio_policy = {
    gain_unit: "db",
    bgm_gain: -6,
    bgm_fade_in_frames: 6,
    bgm_fade_out_frames: 6,
  };
  return {
    version: "1",
    project_id: "premiere-unsupported-edit",
    created_at: "2026-08-15T00:00:00Z",
    sequence: {
      name: "Premiere unsupported edit",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      timecode_format: "NDF",
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: [video1, video2] }],
      audio: [{ track_id: "A1", kind: "audio", clips: [audio] }],
    },
    transitions: [
      {
        transition_id: "transition-1",
        from_clip_id: "video-1",
        to_clip_id: "video-2",
        track_id: "V1",
        transition_type: "crossfade",
        transition_frames: 12,
      },
    ],
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function exportXml(timeline: TimelineIR, roundtripId?: string): string {
  return timelineToFcp7Xml(timeline, {
    sourceMap: new Map([
      ["asset-video-1", "/fixtures/video-1.mp4"],
      ["asset-video-2", "/fixtures/video-2.mp4"],
      ["asset-audio-1", "/fixtures/audio-1.wav"],
    ]),
    projectId: timeline.project_id,
    roundtripId,
    textOverlays: [
      { startFrame: 0, durationFrames: 24, text: "Title generator" },
    ],
  });
}

function transformClip(
  xml: string,
  xmlClipId: string,
  transform: (body: string) => string,
): string {
  const pattern = new RegExp(
    `(<clipitem id="${xmlClipId}">)([\\s\\S]*?)(</clipitem>)`,
  );
  const match = xml.match(pattern);
  if (!match) throw new Error(`missing fixture clip ${xmlClipId}`);
  const changedBody = transform(match[2]);
  if (changedBody === match[2]) {
    throw new Error(`fixture did not alter ${xmlClipId}`);
  }
  return xml.replace(pattern, `$1${changedBody}$3`);
}

function appendToClip(xml: string, xmlClipId: string, fragment: string): string {
  return transformClip(xml, xmlClipId, (body) => `${body}\n${fragment}\n      `);
}

function detect(xml: string, timeline = makeTimeline()) {
  return detectDiffs(parseFcp7Sequence(xml), timeline);
}

interface CliFixture {
  projectDir: string;
  timelinePath: string;
  xmlPath: string;
  receiptPath: string;
  originalTimeline: string;
  originalXml: string;
}

function createCliFixture(transform: (xml: string) => string): CliFixture {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "premiere-unsupported-edit-"),
  );
  tempDirs.push(projectDir);
  const timeline = makeTimeline();
  const originalTimeline = JSON.stringify(timeline, null, 2);
  const rawTimeline = Buffer.from(originalTimeline, "utf-8");
  const roundtripId = derivePremiereRoundtripId(
    timeline.project_id,
    sha256Prefixed(rawTimeline),
  );
  const originalXml = exportXml(timeline, roundtripId);
  const receipt = createPremiereRoundtripReceipt(
    timeline.project_id,
    rawTimeline,
    `${timeline.project_id}_premiere.xml`,
    Buffer.from(originalXml, "utf-8"),
  );
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  const xmlPath = path.join(projectDir, "edited.xml");
  const receiptPath = path.join(projectDir, "premiere.roundtrip.json");
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.writeFileSync(timelinePath, originalTimeline);
  fs.writeFileSync(xmlPath, transform(originalXml));
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  return {
    projectDir,
    timelinePath,
    xmlPath,
    receiptPath,
    originalTimeline,
    originalXml,
  };
}

function runImport(fixture: CliFixture, args: string[]) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  const result = spawnSync(
    tsxPath,
    [
      path.join(repoRoot, "scripts/import-premiere-xml.ts"),
      fixture.projectDir,
      "--xml",
      fixture.xmlPath,
      ...args,
    ],
    { cwd: repoRoot, encoding: "utf-8", env },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function expectNoMutation(fixture: CliFixture): void {
  expect(fs.readFileSync(fixture.timelinePath, "utf-8")).toBe(
    fixture.originalTimeline,
  );
  expect(fs.existsSync(`${fixture.timelinePath}.bak`)).toBe(false);
}

const speedElement = "        <speed><reverse>FALSE</reverse></speed>";
const timeremapFilter = [
  "        <filter>",
  "          <effect>",
  "            <name>Time Remap</name>",
  "            <effectid>timeremap</effectid>",
  "          </effect>",
  "        </filter>",
].join("\n");

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Premiere unsupported edit detection", () => {
  it("keeps unchanged exporter audiolevels, transitions, and generators clean", () => {
    const report = detect(exportXml(makeTimeline()));
    expect(report.unsupportedEdits).toEqual([]);
    expect(report.diffs).toEqual([]);
  });

  it("reports a direct speed element with closed mapped evidence", () => {
    const xml = appendToClip(exportXml(makeTimeline()), "cv-video-1", speedElement);
    expect(detect(xml).unsupportedEdits).toEqual([
      {
        kind: "unsupported_edit",
        clip_id: "video-1",
        surface: "speed_time_remap",
        reason: "direct_speed_element_present",
        disposition: "non_applicable",
        detail: expect.stringContaining("speed"),
        evidence_location: {
          element: "clipitem/speed",
          track_kind: "video",
          track_index: 0,
          clip_index: 0,
          xml_clip_id: "cv-video-1",
          speed_index: 0,
        },
      },
    ]);
  });

  it("reports changed and incomplete present direct clip rates", () => {
    const baseline = exportXml(makeTimeline());
    expect(detect(baseline).unsupportedEdits).toEqual([]);

    const cases = [
      ["timebase", (body: string) => body.replace("<timebase>24</timebase>", "<timebase>25</timebase>"), "25", "FALSE"],
      ["ntsc", (body: string) => body.replace("<ntsc>FALSE</ntsc>", "<ntsc>TRUE</ntsc>"), "24", "TRUE"],
      ["incomplete", (body: string) => body.replace(/\s*<ntsc>FALSE<\/ntsc>/, ""), "24", ""],
    ] as const;

    for (const [label, change, observedTimebase, observedNtsc] of cases) {
      const xml = transformClip(baseline, "cv-video-1", change);
      expect(detect(xml).unsupportedEdits, label).toEqual([
        expect.objectContaining({
          kind: "unsupported_edit",
          clip_id: "video-1",
          surface: "speed_time_remap",
          reason: "clip_rate_mismatch",
          disposition: "non_applicable",
          evidence_location: {
            element: "clipitem/rate",
            track_kind: "video",
            track_index: 0,
            clip_index: 0,
            xml_clip_id: "cv-video-1",
            rate_index: 0,
            expected_timebase: "24",
            expected_ntsc: "FALSE",
            observed_timebase: observedTimebase,
            observed_ntsc: observedNtsc,
          },
        }),
      ]);
    }
  });

  it("reports timeremap only as a generic unsupported clip effect", () => {
    const xml = appendToClip(exportXml(makeTimeline()), "cv-video-1", timeremapFilter);
    expect(detect(xml).unsupportedEdits).toEqual([
      expect.objectContaining({
        surface: "non_audio_level_clip_filter_effect",
        reason: "clip_effect_not_supported_audiolevels",
        evidence_location: expect.objectContaining({
          element: "clipitem/filter/effect",
          effect_id: "timeremap",
          effect_name: "Time Remap",
        }),
      }),
    ]);
  });

  it("exempts only raw exact audio-track audiolevels", () => {
    const baseline = exportXml(makeTimeline());
    expect(detect(baseline).unsupportedEdits).toEqual([]);

    const genericFilter = (effectId: string) => [
      "        <filter><effect>",
      "          <name>Audio Levels</name>",
      `          <effectid>${effectId}</effectid>`,
      "        </effect></filter>",
    ].join("\n");
    const cases: Array<[string, boolean]> = [
      [appendToClip(baseline, "cv-video-1", genericFilter("audiolevels")), false],
      [transformClip(baseline, "ca-audio-1", (body) =>
        body.replace("<effectid>audiolevels</effectid>", "<effectid>AudioLevels</effectid>")), true],
      [transformClip(baseline, "ca-audio-1", (body) =>
        body.replace("<effectid>audiolevels</effectid>", "<effectid> audiolevels </effectid>")), true],
    ];

    for (const [xml, missingRequiredFilter] of cases) {
      const unsupported = detect(xml).unsupportedEdits;
      expect(unsupported).toEqual(expect.arrayContaining([
        expect.objectContaining({
          surface: "non_audio_level_clip_filter_effect",
          reason: "clip_effect_not_supported_audiolevels",
        }),
      ]));
      expect(unsupported.some(
        (entry) => entry.reason === "audiolevels_filter_missing",
      )).toBe(missingRequiredFilter);
    }
  });

  it("reports a required Audio Levels filter that disappeared", () => {
    const xml = transformClip(exportXml(makeTimeline()), "ca-audio-1", (body) =>
      body.replace(/\s*<filter>[\s\S]*?<effectid>audiolevels<\/effectid>[\s\S]*?<\/filter>/, ""));
    expect(detect(xml).unsupportedEdits).toEqual([
      expect.objectContaining({
        clip_id: "audio-1",
        surface: "audio_levels",
        reason: "audiolevels_filter_missing",
        evidence_location: expect.objectContaining({
          element: "clipitem",
          expected: "filter/effect[effectid=audiolevels]",
        }),
      }),
    ]);
  });

  it.each([
    ["duplicate effect", (body: string) => {
      const filter = body.match(/<filter>[\s\S]*?<effectid>audiolevels<\/effectid>[\s\S]*?<\/filter>/)?.[0];
      if (!filter) throw new Error("missing audiolevels fixture");
      return `${body}\n${filter}`;
    }, "audiolevels_duplicate_effect"],
    ["duplicate parameter", (body: string) => body.replace(
      /(<parameter authoringApp="FinalCutPro">[\s\S]*?<\/parameter>)/,
      "$1$1",
    ), "audiolevels_duplicate_parameter"],
    ["extra parameter", (body: string) => body.replace(
      "          </effect>",
      "            <parameter><parameterid>pan</parameterid><value>0</value></parameter>\n          </effect>",
    ), "audiolevels_extra_parameter"],
    ["non-finite value", (body: string) => body.replace("<value>0</value>", "<value>NaN</value>"), "audiolevels_value_non_finite"],
    ["out-of-range value", (body: string) => body.replace("<value>0</value>", "<value>5</value>"), "audiolevels_value_out_of_range"],
    ["duplicate keyframe time", (body: string) => body.replace("<when>6</when>", "<when>0</when>"), "audiolevels_keyframe_time_invalid"],
    ["ambiguous keyframe shape", (body: string) => body.replace(
      /(<when>48<\/when>\s*)<value>0<\/value>/,
      "$1<value>0.25</value>",
    ), "audiolevels_keyframe_shape_unsupported"],
  ])("blocks malformed Audio Levels: %s", (_label, mutate, reason) => {
    const xml = transformClip(exportXml(makeTimeline()), "ca-audio-1", mutate);
    expect(detect(xml).unsupportedEdits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clip_id: "audio-1",
          surface: "audio_levels",
          reason,
          disposition: "non_applicable",
        }),
      ]),
    );
  });

  it.each([
    ["wrapper attribute", (body: string) => body.replace(
      "<filter>",
      '<filter enabled="FALSE">',
    )],
    ["disabled control", (body: string) => body.replace(
      "<filter>",
      "<filter><enabled>FALSE</enabled>",
    )],
    ["range control", (body: string) => body.replace(
      "<filter>",
      "<filter><start>0</start><end>48</end>",
    )],
  ])("blocks unsupported Audio Levels outer filter shape: %s", (_label, mutate) => {
    const xml = transformClip(exportXml(makeTimeline()), "ca-audio-1", mutate);
    expect(detect(xml).unsupportedEdits).toEqual([
      expect.objectContaining({
        clip_id: "audio-1",
        surface: "audio_levels",
        reason: "audiolevels_filter_shape_unsupported",
        disposition: "non_applicable",
        evidence_location: expect.objectContaining({
          element: "clipitem/filter/effect",
          filter_index: 0,
          effect_index: 0,
        }),
      }),
    ]);
  });

  it("distinguishes a filter missing effect from actual effect evidence", () => {
    let xml = appendToClip(
      exportXml(makeTimeline()),
      "cv-video-1",
      "        <filter><name>Missing effect wrapper</name></filter>",
    );
    xml = appendToClip(
      xml,
      "cv-video-1",
      "        <filter><effect><name>Crop</name><effectid>crop</effectid></effect></filter>",
    );
    expect(detect(xml).unsupportedEdits).toEqual([
      expect.objectContaining({
        reason: "clip_filter_missing_effect",
        evidence_location: expect.objectContaining({
          element: "clipitem/filter",
          filter_index: 0,
        }),
      }),
      expect.objectContaining({
        reason: "clip_effect_not_supported_audiolevels",
        evidence_location: expect.objectContaining({
          element: "clipitem/filter/effect",
          filter_index: 1,
          effect_index: 0,
          effect_id: "crop",
          effect_name: "Crop",
        }),
      }),
    ]);
  });

  it("does not attach unsupported entries to unmapped clips", () => {
    const unmapped = [
      '        <clipitem id="premiere-added">',
      "          <name>Unmapped speed clip</name>",
      "          <start>96</start><end>120</end><in>0</in><out>24</out>",
      "          <speed/>",
      "        </clipitem>",
    ].join("\n");
    const xml = exportXml(makeTimeline()).replace(/(\s*<\/track>)/, `\n${unmapped}$1`);
    const report = detect(xml);
    expect(report.unsupportedEdits).toEqual([]);
    expect(report.diffs).toContainEqual(expect.objectContaining({ kind: "added_unmapped" }));
  });
});

describe("Premiere unsupported edit CLI gate", () => {
  it("reports human and JSON previews without blocking or mutation", () => {
    for (const json of [false, true]) {
      const fixture = createCliFixture((xml) =>
        appendToClip(xml, "cv-video-1", speedElement));
      const result = runImport(fixture, json ? ["--json"] : []);
      expect(result.status, result.stderr).toBe(0);
      if (json) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          mode: "preview",
          applied: false,
          unsupported_edit_count: 1,
          apply_blocked: false,
          unsupported_edits: [
            { kind: "unsupported_edit", reason: "direct_speed_element_present" },
          ],
        });
        expect(JSON.parse(result.stdout)).not.toHaveProperty("block_reason");
      } else {
        expect(result.stdout).toContain("UNSUPPORTED_EDIT");
        expect(result.stdout).toContain("direct_speed_element_present");
        expect(result.stdout).toContain("[PREVIEW] No changes applied.");
      }
      expectNoMutation(fixture);
    }
  });

  it("blocks human apply before backup or write", () => {
    const fixture = createCliFixture((xml) =>
      appendToClip(xml, "cv-video-1", speedElement));
    const result = runImport(fixture, [
      "--receipt",
      fixture.receiptPath,
      "--apply",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("UNSUPPORTED_EDIT");
    expect(result.stdout).toContain("Apply blocked");
    expectNoMutation(fixture);
  });

  it("blocks missing and malformed Audio Levels before backup or write", () => {
    const cases = [
      (xml: string) => transformClip(xml, "ca-audio-1", (body) =>
        body.replace(/\s*<filter>[\s\S]*?<effectid>audiolevels<\/effectid>[\s\S]*?<\/filter>/, "")),
      (xml: string) => transformClip(xml, "ca-audio-1", (body) =>
        body.replace("<when>6</when>", "<when>0</when>")),
      (xml: string) => transformClip(xml, "ca-audio-1", (body) =>
        body.replace("<filter>", "<filter><enabled>FALSE</enabled>")),
    ];
    for (const mutate of cases) {
      const fixture = createCliFixture(mutate);
      const result = runImport(fixture, [
        "--receipt",
        fixture.receiptPath,
        "--apply",
        "--json",
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        applied: false,
        apply_blocked: true,
        block_reason: "unsupported_edit",
      });
      expectNoMutation(fixture);
    }
  });

  it("emits one blocked JSON document for mixed supported and unsupported edits", () => {
    const fixture = createCliFixture((xml) => {
      let changed = appendToClip(xml, "cv-video-1", timeremapFilter);
      changed = transformClip(changed, "cv-video-1", (body) =>
        body.replace("<out>48</out>", "<out>40</out>"));
      changed = transformClip(changed, "ca-audio-1", (body) =>
        body.replaceAll(
          /<value>0\.501187[^<]*<\/value>/g,
          "<value>0.25</value>",
        ));
      return changed;
    });
    const result = runImport(fixture, [
      "--receipt",
      fixture.receiptPath,
      "--apply",
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      mode: "apply",
      applied: false,
      apply_blocked: true,
      block_reason: "unsupported_edit",
      unsupported_edit_count: 1,
      by_kind: { trim_changed: 1, audio_policy_changed: 1 },
    });
    expect(result.stdout.trimEnd().endsWith("}")).toBe(true);
    expectNoMutation(fixture);
  });

  it("keeps receipt, base, and marker gates ahead of unsupported blocking", () => {
    const cases: Array<[
      string,
      (fixture: CliFixture) => void,
      string,
    ]> = [
      [
        "stale base",
        (fixture) => fs.appendFileSync(fixture.timelinePath, "\n"),
        "base timeline hash mismatch",
      ],
      [
        "wrong session",
        (fixture) => fs.writeFileSync(
          fixture.xmlPath,
          fs.readFileSync(fixture.xmlPath, "utf-8").replaceAll(
            /sha256:[0-9a-f]{64}/g,
            `sha256:${"2".repeat(64)}`,
          ),
        ),
        "roundtrip_id does not match receipt",
      ],
      [
        "malformed marker",
        (fixture) => fs.writeFileSync(
          fixture.xmlPath,
          fs.readFileSync(fixture.xmlPath, "utf-8").replace(
            /sha256:[0-9a-f]{64}/,
            "sha256:not-a-hash",
          ),
        ),
        "malformed video_os roundtrip_id",
      ],
    ];

    for (const [label, invalidate, expectedError] of cases) {
      const fixture = createCliFixture((xml) =>
        appendToClip(xml, "cv-video-1", speedElement));
      invalidate(fixture);
      const expectedTimeline = fs.readFileSync(fixture.timelinePath, "utf-8");
      const result = runImport(fixture, [
        "--receipt",
        fixture.receiptPath,
        "--apply",
      ]);
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toContain(expectedError);
      expect(result.stdout, label).not.toContain("Apply blocked");
      expect(fs.readFileSync(fixture.timelinePath, "utf-8"), label).toBe(expectedTimeline);
      expect(fs.existsSync(`${fixture.timelinePath}.bak`), label).toBe(false);
    }
  });

  it("returns a receipt failure before unsupported edit detection", () => {
    const fixture = createCliFixture((xml) => appendToClip(xml, "cv-video-1", speedElement));
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf8"));
    receipt.extra = "closed-union violation";
    fs.writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
    const result = runImport(fixture, ["--receipt", fixture.receiptPath, "--apply", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: false, apply_blocked: true, total_diffs: 0, unsupported_edit_count: 0 });
    expectNoMutation(fixture);
  });
});
