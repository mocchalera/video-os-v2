/**
 * FCP7 XML roundtrip tests
 *
 * Tests:
 * 1. XML parser basics
 * 2. Marker comment parsing
 * 3. Export → Import roundtrip (same timeline restored)
 * 4. Diff detection: trim change, reorder, delete, unmapped add
 * 5. Diff application (patch)
 * 6. Japanese path roundtrip
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type {
  TimelineIR,
  ClipOutput,
  TimelineTransitionOutput,
} from "../runtime/compiler/types.js";
import { timelineToFcp7Xml } from "../runtime/handoff/fcp7-xml-export.js";
import {
  parseFcp7Xml,
  parseVideoOsMarker,
  parseFcp7Sequence,
  parsedSequenceToTimelineIR,
  detectDiffs,
  applyDiffs,
  type ClipDiff,
} from "../runtime/handoff/fcp7-xml-import.js";
import {
  createPremiereRoundtripReceipt,
  derivePremiereExportGenerationId,
  derivePremiereRoundtripIdV2,
  parsePremiereRoundtripReceipt,
  validatePremiereRoundtripApply,
  type PremiereBakedClipMap,
} from "../runtime/handoff/premiere-roundtrip-receipt.js";

// ── Test helpers ─────────────────────────────────────────────────────

function makeClip(overrides: Partial<ClipOutput> = {}): ClipOutput {
  return {
    clip_id: "clip-1",
    segment_id: "seg-1",
    asset_id: "AST_001",
    src_in_us: 0,
    src_out_us: 3_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 72,
    role: "hero",
    motivation: "Test clip",
    beat_id: "beat-1",
    fallback_segment_ids: [],
    confidence: 0.9,
    quality_flags: [],
    ...overrides,
  };
}

function makeTimeline(
  videoClips: ClipOutput[][],
  audioClips: ClipOutput[][] = [],
  transitions?: TimelineTransitionOutput[],
): TimelineIR {
  return {
    version: "1.0.0",
    project_id: "TEST_001",
    created_at: "2024-01-01T00:00:00Z",
    sequence: {
      name: "Test Sequence",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      timecode_format: "NDF",
    },
    tracks: {
      video: videoClips.map((clips, i) => ({
        track_id: `V${i + 1}`,
        kind: "video" as const,
        clips,
      })),
      audio: audioClips.map((clips, i) => ({
        track_id: `A${i + 1}`,
        kind: "audio" as const,
        clips,
      })),
    },
    markers: [],
    ...(transitions ? { transitions } : {}),
    provenance: {
      brief_path: "test/brief.yaml",
      blueprint_path: "test/blueprint.yaml",
      selects_path: "test/selects.yaml",
      compiler_version: "test-1.0.0",
    },
  };
}

function makeKnownSourceAdditionFixture(): {
  timeline: TimelineIR;
  baseXml: string;
  candidateBlock: string;
  candidateXmlId: string;
  fileId: string;
  fullFileBlock: string;
} {
  const anchorA = makeClip({
    clip_id: "anchor-a",
    segment_id: "seg-anchor-a",
    asset_id: "AST_ANCHOR_A",
    src_out_us: 1_001_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 30,
  });
  const anchorC = makeClip({
    clip_id: "anchor-c",
    segment_id: "seg-anchor-c",
    asset_id: "AST_ANCHOR_C",
    src_out_us: 1_001_000,
    timeline_in_frame: 60,
    timeline_duration_frames: 30,
  });
  const knownTemplate = makeClip({
    clip_id: "known-template",
    segment_id: "seg-known",
    asset_id: "AST_KNOWN",
    src_in_us: 0,
    src_out_us: 3_003_000,
    timeline_in_frame: 180,
    timeline_duration_frames: 90,
    role: "support",
    motivation: "Known source template",
    beat_id: "beat-known",
    fallback_segment_ids: ["seg-known-fallback"],
    confidence: 0.77,
    quality_flags: ["known-source"],
  });
  const timeline = makeTimeline([[anchorA, anchorC, knownTemplate]]);
  timeline.sequence.fps_num = 30_000;
  timeline.sequence.fps_den = 1_001;
  const sourceMap = new Map([
    ["AST_ANCHOR_A", "/media/anchor-a.mov"],
    ["AST_ANCHOR_C", "/media/anchor-c.mov"],
    ["AST_KNOWN", "/media/known source.mov"],
  ]);
  const baseXml = timelineToFcp7Xml(timeline, { sourceMap });
  const templateBlock = baseXml.match(
    /<clipitem id="cv-known-template">[\s\S]*?<\/clipitem>/,
  )![0];
  const fullFileMatch = templateBlock.match(
    /<file id="([^"]+)">[\s\S]*?<\/file>/,
  )!;
  const fileId = fullFileMatch[1];
  const candidateXmlId = "premiere-known-add-1";
  const candidateBlock = templateBlock
    .replace('id="cv-known-template"', `id="${candidateXmlId}"`)
    .replace(/<start>180<\/start>/, "<start>30</start>")
    .replace(/<end>270<\/end>/, "<end>60</end>")
    .replace(/<in>0<\/in>/, "<in>60</in>")
    .replace(fullFileMatch[0], `<file id="${fileId}"/>`)
    .replace(/\s*<marker>[\s\S]*?<\/marker>/g, "");
  return {
    timeline,
    baseXml,
    candidateBlock,
    candidateXmlId,
    fileId,
    fullFileBlock: fullFileMatch[0],
  };
}

function insertAfterAnchorA(xml: string, block: string): string {
  return xml.replace(
    /(<clipitem id="cv-anchor-a">[\s\S]*?<\/clipitem>)/,
    `$1\n${block}`,
  );
}

function makeTrackMoveFixture(options: {
  movedStart?: number;
  movedDuration?: number;
  targetTransition?: boolean;
  targetMiddle?: boolean;
  independentFileAuthority?: boolean;
  sourcePeer?: boolean;
} = {}): {
  timeline: TimelineIR;
  exported: string;
  returned: string;
  movedBlock: string;
  beforeBlock: string;
  afterBlock: string;
  middleBlock?: string;
  sourcePeerBlock?: string;
} {
  const movedStart = options.movedStart ?? 30;
  const movedDuration = options.movedDuration ?? 30;
  const moved = makeClip({
    clip_id: "move-candidate",
    segment_id: "seg-move-candidate",
    asset_id: "AST_MOVE",
    src_out_us: 1_250_000,
    timeline_in_frame: movedStart,
    timeline_duration_frames: movedDuration,
  });
  const authority = makeClip({
    clip_id: "move-authority",
    segment_id: "seg-move-candidate",
    asset_id: "AST_MOVE",
    src_out_us: 1_250_000,
    timeline_in_frame: 120,
    timeline_duration_frames: 30,
  });
  const before = makeClip({
    clip_id: "move-before",
    segment_id: "seg-move-candidate",
    asset_id: "AST_MOVE",
    src_out_us: 1_250_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 30,
  });
  const after = makeClip({
    clip_id: "move-after",
    segment_id: "seg-move-after",
    asset_id: "AST_AFTER",
    src_out_us: 1_250_000,
    timeline_in_frame: 60,
    timeline_duration_frames: 30,
  });
  const middle = makeClip({
    clip_id: "move-middle",
    segment_id: "seg-move-middle",
    asset_id: "AST_MIDDLE",
    src_out_us: 1_250_000,
    timeline_in_frame: 30,
    timeline_duration_frames: 30,
  });
  const sourcePeer = makeClip({
    clip_id: "move-source-peer",
    segment_id: "seg-move-source-peer",
    asset_id: "AST_SOURCE_PEER",
    src_out_us: 1_250_000,
    timeline_in_frame: 180,
    timeline_duration_frames: 30,
  });
  const transitions = options.targetTransition ? [{
    transition_id: "target-gap-transition",
    from_clip_id: "move-before",
    to_clip_id: "move-after",
    track_id: "V2",
    transition_type: "crossfade",
    applied_skill_id: "crossfade",
    transition_frames: 12,
  }] : undefined;
  const independentFileAuthority = options.independentFileAuthority !== false;
  const timeline = makeTimeline(
    independentFileAuthority
      ? [
          [authority],
          options.sourcePeer ? [moved, sourcePeer] : [moved],
          options.targetMiddle ? [before, middle, after] : [before, after],
        ]
      : [
          options.sourcePeer ? [moved, sourcePeer] : [moved],
          options.targetMiddle ? [before, middle, after] : [before, after],
        ],
    [],
    undefined,
  );
  if (independentFileAuthority) {
    timeline.tracks.video[0].track_id = "V0";
    timeline.tracks.video[1].track_id = "V1";
    timeline.tracks.video[2].track_id = "V2";
  }
  const exported = timelineToFcp7Xml(timeline, {
    sourceMap: new Map([
      ["AST_MOVE", "/media/move.mov"],
      ["AST_AFTER", "/media/after.mov"],
      ["AST_MIDDLE", "/media/middle.mov"],
      ["AST_SOURCE_PEER", "/media/source-peer.mov"],
    ]),
  });
  if (transitions) timeline.transitions = transitions;
  const movedBlock = exported.match(
    /<clipitem id="cv-move-candidate">[\s\S]*?<\/clipitem>/,
  )![0];
  const beforeBlock = exported.match(
    /<clipitem id="cv-move-before">[\s\S]*?<\/clipitem>/,
  )![0];
  const afterBlock = exported.match(
    /<clipitem id="cv-move-after">[\s\S]*?<\/clipitem>/,
  )![0];
  const middleBlock = options.targetMiddle
    ? exported.match(/<clipitem id="cv-move-middle">[\s\S]*?<\/clipitem>/)![0]
    : undefined;
  const sourcePeerBlock = options.sourcePeer
    ? exported.match(/<clipitem id="cv-move-source-peer">[\s\S]*?<\/clipitem>/)![0]
    : undefined;
  const returned = exported
    .replace(movedBlock, "")
    .replace(afterBlock, `${movedBlock}\n${afterBlock}`);
  return {
    timeline,
    exported,
    returned,
    movedBlock,
    beforeBlock,
    afterBlock,
    ...(middleBlock ? { middleBlock } : {}),
    ...(sourcePeerBlock ? { sourcePeerBlock } : {}),
  };
}

// ── 1. XML Parser ────────────────────────────────────────────────────

describe("parseFcp7Xml", () => {
  it("parses a simple element with text", () => {
    const node = parseFcp7Xml("<name>Hello World</name>");
    expect(node.tag).toBe("name");
    expect(node.text).toBe("Hello World");
  });

  it("parses attributes", () => {
    const node = parseFcp7Xml('<file id="file-1"/>');
    expect(node.tag).toBe("file");
    expect(node.attrs.id).toBe("file-1");
    expect(node.children).toHaveLength(0);
  });

  it("parses nested elements", () => {
    const xml = `<root><child1>A</child1><child2>B</child2></root>`;
    const node = parseFcp7Xml(xml);
    expect(node.tag).toBe("root");
    expect(node.children).toHaveLength(2);
    expect(node.children[0].tag).toBe("child1");
    expect(node.children[0].text).toBe("A");
    expect(node.children[1].tag).toBe("child2");
    expect(node.children[1].text).toBe("B");
  });

  it("handles XML entity unescaping", () => {
    const node = parseFcp7Xml("<text>A &amp; B &lt; C</text>");
    expect(node.text).toBe("A & B < C");
  });

  it("handles self-closing tags with attributes", () => {
    const xml = `<root><file id="f1"/><file id="f2"/></root>`;
    const node = parseFcp7Xml(xml);
    expect(node.children).toHaveLength(2);
    expect(node.children[0].attrs.id).toBe("f1");
    expect(node.children[1].attrs.id).toBe("f2");
  });
});

describe("Premiere receipt v2 rational residual contract", () => {
  const sha = (ch: string) => `sha256:${ch.repeat(64)}`;
  function receiptFor(fpsNum: number, fpsDen: number, sourceOutUs: number, residual: number) {
    const map: PremiereBakedClipMap = {
      clip_id: "C1", xml_clipitem_id: "cv-C1", timeline_track_id: "V1", canonical_asset_id: "AST_1",
      derived_asset_id: "AST_BAKE_AAAAAAAAAAAAAAAAAAAAAAAA", bake_request_id: sha("a"),
      manifest_path: "09_output/premiere-bakes/requests/a/generations/b/manifest.json", manifest_sha256: sha("b"),
      media_path: "09_output/premiere-bakes/requests/a/generations/b/clip.mp4", media_sha256: sha("c"),
      media_video_stream_sha256: sha("d"), timeline_duration_frames: 3, xml_in_frame: 0, xml_out_frame: 3,
      fps_num: fpsNum, fps_den: fpsDen, source_in_us: 0, source_out_us: sourceOutUs,
      source_time_den: fpsNum, source_out_residual_num: residual,
    };
    const base = sha("e"), index = sha("f"), xml = sha("1");
    const roundtrip = derivePremiereRoundtripIdV2("p", base, index, [map]);
    return { version: "premiere-roundtrip-receipt/v2", project_id: "p", roundtrip_id: roundtrip,
      export_generation_id: derivePremiereExportGenerationId("p", base, roundtrip, xml, index), base_timeline_sha256: base,
      exported_xml: { path: "09_output/premiere-exports/generations/g/p_premiere.xml", sha256: xml },
      bake_index: { path: "09_output/premiere-exports/generations/g/bake-index.json", sha256: index }, baked_clip_maps: [map] };
  }

  it.each([[30, 1, 100000, 0], [30, 1, 100001, 30], [30, 1, 99999, -30]])("GREEN_RESIDUAL_RECONSTRUCTION_30_1_ZERO_POSITIVE_NEGATIVE %#", (num, den, out, residual) => {
    expect(parsePremiereRoundtripReceipt(JSON.stringify(receiptFor(num, den, out, residual))).version).toBe("premiere-roundtrip-receipt/v2");
  });

  it.each([[30000, 1001, 100100, 0], [30000, 1001, 100101, 30000], [30000, 1001, 100099, -30000]])("GREEN_RESIDUAL_RECONSTRUCTION_30000_1001_ZERO_POSITIVE_NEGATIVE %#", (num, den, out, residual) => {
    expect(parsePremiereRoundtripReceipt(JSON.stringify(receiptFor(num, den, out, residual))).version).toBe("premiere-roundtrip-receipt/v2");
  });

  it("GREEN_RECEIPT_V2_EXAMPLE_RESIDUAL_10000", () => {
    const receipt = receiptFor(30000, 1001, 3_336_667, 10_000);
    receipt.baked_clip_maps[0].timeline_duration_frames = 100;
    receipt.baked_clip_maps[0].xml_out_frame = 100;
    receipt.roundtrip_id = derivePremiereRoundtripIdV2("p", receipt.base_timeline_sha256, receipt.bake_index.sha256, receipt.baked_clip_maps);
    receipt.export_generation_id = derivePremiereExportGenerationId("p", receipt.base_timeline_sha256, receipt.roundtrip_id, receipt.exported_xml.sha256, receipt.bake_index.sha256);
    expect(parsePremiereRoundtripReceipt(JSON.stringify(receipt)).version).toBe("premiere-roundtrip-receipt/v2");
  });

  it("rejects a mismatched signed residual before import diff", () => {
    expect(() => parsePremiereRoundtripReceipt(JSON.stringify(receiptFor(30, 1, 100001, 0)))).toThrow(/residual.*mismatch/);
  });
});

// ── 2. Marker Comment Parsing ────────────────────────────────────────

describe("parseVideoOsMarker", () => {
  it("parses JSON format marker comment", () => {
    const meta = parseVideoOsMarker(
      'video_os:{"exchange_clip_id":"clip-1","clip_id":"clip-1","asset_id":"AST_001","beat_id":"beat-1","motivation":"Hero shot"}',
    );
    expect(meta).toEqual({
      clip_id: "clip-1",
      asset_id: "AST_001",
      beat_id: "beat-1",
      motivation: "Hero shot",
    });
  });

  it("parses legacy pipe-delimited format", () => {
    const meta = parseVideoOsMarker(
      "video_os:clip_id=clip-1|asset_id=AST_001|beat_id=beat-1|motivation=Hero shot",
    );
    expect(meta).toEqual({
      clip_id: "clip-1",
      asset_id: "AST_001",
      beat_id: "beat-1",
      motivation: "Hero shot",
    });
  });

  it("returns null for non-video_os comments", () => {
    expect(parseVideoOsMarker("Just a comment")).toBeNull();
    expect(parseVideoOsMarker("")).toBeNull();
  });

  it("handles empty motivation in JSON format", () => {
    const meta = parseVideoOsMarker(
      'video_os:{"clip_id":"c1","asset_id":"a1","beat_id":"b1","motivation":""}',
    );
    expect(meta).not.toBeNull();
    expect(meta!.motivation).toBe("");
  });

  it("handles empty motivation in pipe format", () => {
    const meta = parseVideoOsMarker(
      "video_os:clip_id=c1|asset_id=a1|beat_id=b1|motivation=",
    );
    expect(meta).not.toBeNull();
    expect(meta!.motivation).toBe("");
  });

  it("returns null when required fields are missing", () => {
    expect(parseVideoOsMarker('video_os:{"clip_id":"c1"}')).toBeNull();
    expect(
      parseVideoOsMarker('video_os:{"clip_id":"c1","asset_id":"a1"}'),
    ).toBeNull();
  });
});

// ── 3. Export → Import Roundtrip ─────────────────────────────────────

describe("roundtrip: export then import", () => {
  it("preserves clip identity through export/import cycle", () => {
    const clip1 = makeClip({
      clip_id: "clip-alpha",
      asset_id: "AST_A",
      src_in_us: 1_000_000,
      src_out_us: 4_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
      beat_id: "beat-intro",
      motivation: "Opening shot",
    });
    const clip2 = makeClip({
      clip_id: "clip-beta",
      asset_id: "AST_B",
      src_in_us: 500_000,
      src_out_us: 2_500_000,
      timeline_in_frame: 72,
      timeline_duration_frames: 48,
      beat_id: "beat-main",
      motivation: "Main content",
    });

    const timeline = makeTimeline([[clip1, clip2]]);

    const sourceMap = new Map<string, string>([
      ["AST_A", "/media/footage/clip_a.mov"],
      ["AST_B", "/media/footage/clip_b.mov"],
    ]);

    // Export to XML
    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    expect(xml).toContain("xmeml");
    // Marker comments use JSON format with XML-escaped quotes
    expect(xml).toContain("clip-alpha");
    expect(xml).toContain("clip-beta");

    // Parse back
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.name).toBe("Test Sequence");
    expect(parsed.timebase).toBe(24);
    expect(parsed.videoTracks).toHaveLength(1);
    expect(parsed.videoTracks[0]).toHaveLength(2);

    // Verify clip identity via markers
    const parsedClip1 = parsed.videoTracks[0][0];
    expect(parsedClip1.videoOsMeta).not.toBeNull();
    expect(parsedClip1.videoOsMeta!.clip_id).toBe("clip-alpha");
    expect(parsedClip1.videoOsMeta!.asset_id).toBe("AST_A");

    const parsedClip2 = parsed.videoTracks[0][1];
    expect(parsedClip2.videoOsMeta).not.toBeNull();
    expect(parsedClip2.videoOsMeta!.clip_id).toBe("clip-beta");

    // Convert back to TimelineIR
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    expect(imported.tracks.video).toHaveLength(1);
    expect(imported.tracks.video[0].clips).toHaveLength(2);

    const importedClip1 = imported.tracks.video[0].clips[0];
    expect(importedClip1.clip_id).toBe("clip-alpha");
    expect(importedClip1.asset_id).toBe("AST_A");
    expect(importedClip1.beat_id).toBe("beat-intro");
    expect(importedClip1.timeline_in_frame).toBe(0);
    expect(importedClip1.timeline_duration_frames).toBe(72);
  });

  it("detects no diffs when timeline is unchanged", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.diffs).toHaveLength(0);
    expect(report.mappedClips).toBe(1);
    expect(report.unmappedClips).toBe(0);
  });

  it("restores visible editorial marker values on import", () => {
    const clip = makeClip({
      clip_id: "clip-marker",
      beat_id: "beat-a",
      motivation: "Original motivation",
      role: "support",
      confidence: 0.81,
      timeline_in_frame: 48,
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });
    xml = xml.replace(
      "<name>beat-a: Original motivation</name>",
      "<name>beat-b: Updated motivation from marker</name>",
    );
    xml = xml.replace(
      "<comment>support | confidence: 0.81</comment>",
      "<comment>hero | confidence: 0.42</comment>",
    );

    const parsed = parseFcp7Sequence(xml);
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    const importedClip = imported.tracks.video[0].clips[0];

    expect(importedClip.beat_id).toBe("beat-b");
    expect(importedClip.motivation).toBe("Updated motivation from marker");
    expect(importedClip.role).toBe("support");
    expect(importedClip.confidence).toBe(0.81);
  });

  it("roundtrips transitionitem back into timeline transitions", () => {
    const clip1 = makeClip({
      clip_id: "clip-alpha",
      asset_id: "AST_A",
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
    const clip2 = makeClip({
      clip_id: "clip-beta",
      asset_id: "AST_B",
      timeline_in_frame: 72,
      timeline_duration_frames: 60,
    });
    const timeline = makeTimeline(
      [[clip1, clip2]],
      [],
      [
        {
          transition_id: "tr-1",
          from_clip_id: "clip-alpha",
          to_clip_id: "clip-beta",
          track_id: "V1",
          transition_type: "match_cut",
          applied_skill_id: "match_cut_bridge",
          transition_frames: 12,
          transition_params: {
            cut_frame_after_snap: 72,
            snap_delta_frames: 0,
          },
        },
      ],
    );
    const sourceMap = new Map<string, string>([
      ["AST_A", "/media/a.mov"],
      ["AST_B", "/media/b.mov"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    expect(xml).toContain("<transitionitem>");

    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTransitions[0]).toHaveLength(1);
    expect(parsed.videoTransitions[0][0].effectName).toBe("Dip to Color");

    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    expect(imported.transitions).toHaveLength(1);
    expect(imported.transitions![0]).toMatchObject({
      transition_id: "tr-1",
      from_clip_id: "clip-alpha",
      to_clip_id: "clip-beta",
      track_id: "V1",
      transition_type: "match_cut",
      applied_skill_id: "match_cut_bridge",
      transition_frames: 12,
    });
  });
});

// ── 4. Diff Detection ────────────────────────────────────────────────

describe("diff detection", () => {
  it("roundtrips one marker-backed video clip moved between existing anchored tracks", () => {
    const moved = makeClip({
      clip_id: "moved",
      segment_id: "seg-moved",
      asset_id: "AST_MOVED",
      src_out_us: 1_250_000,
      timeline_in_frame: 30,
      timeline_duration_frames: 30,
      motivation: "Preserve every moved field",
      fallback_segment_ids: ["seg-moved-fallback"],
      confidence: 0.73,
      quality_flags: ["roundtrip"],
      metadata: { exact: "preserve", nested: { value: 7 } },
    });
    const fileAuthority = makeClip({
      clip_id: "moved-file-authority",
      segment_id: "seg-moved",
      asset_id: "AST_MOVED",
      src_out_us: 1_250_000,
      timeline_in_frame: 210,
      timeline_duration_frames: 30,
      motivation: "Preserve every moved field",
      fallback_segment_ids: ["seg-moved-fallback"],
      confidence: 0.73,
      quality_flags: ["roundtrip"],
    });
    const targetBefore = makeClip({
      clip_id: "target-before",
      segment_id: "seg-moved",
      asset_id: "AST_MOVED",
      src_out_us: 1_250_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      motivation: "Preserve every moved field",
      fallback_segment_ids: ["seg-moved-fallback"],
      confidence: 0.73,
      quality_flags: ["roundtrip"],
    });
    const targetAfter = makeClip({
      clip_id: "target-after",
      segment_id: "seg-target-after",
      asset_id: "AST_TARGET_AFTER",
      src_out_us: 1_250_000,
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
    });
    const unrelatedBefore = makeClip({
      clip_id: "unrelated-before",
      segment_id: "seg-unrelated-before",
      asset_id: "AST_UNRELATED_BEFORE",
      src_out_us: 1_250_000,
      timeline_in_frame: 120,
      timeline_duration_frames: 30,
    });
    const unrelatedAfter = makeClip({
      clip_id: "unrelated-after",
      segment_id: "seg-unrelated-after",
      asset_id: "AST_UNRELATED_AFTER",
      src_out_us: 1_250_000,
      timeline_in_frame: 150,
      timeline_duration_frames: 30,
    });
    const audio = makeClip({
      clip_id: "audio-unrelated",
      segment_id: "seg-audio-unrelated",
      asset_id: "AST_AUDIO",
      src_out_us: 7_500_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 180,
      role: "music",
      audio_policy: { gain_unit: "db", bgm_gain: -8 },
    });
    const transition: TimelineTransitionOutput = {
      transition_id: "transition-unrelated",
      from_clip_id: "unrelated-before",
      to_clip_id: "unrelated-after",
      track_id: "V3",
      transition_type: "crossfade",
      applied_skill_id: "crossfade",
      transition_frames: 12,
    };
    const timeline = makeTimeline(
      [
        [fileAuthority],
        [moved],
        [targetBefore, targetAfter],
        [unrelatedBefore, unrelatedAfter],
      ],
      [[audio]],
      [transition],
    );
    timeline.tracks.video[0].track_id = "V0";
    timeline.tracks.video[1].track_id = "V1";
    timeline.tracks.video[2].track_id = "V2";
    timeline.tracks.video[3].track_id = "V3";
    timeline.markers = [{
      frame: 111,
      label: "untouched",
      kind: "note",
    }];
    const original = structuredClone(timeline);
    const sourceMap = new Map([
      ["AST_MOVED", "/media/moved.mov"],
      ["AST_TARGET_AFTER", "/media/target-after.mov"],
      ["AST_UNRELATED_BEFORE", "/media/unrelated-before.mov"],
      ["AST_UNRELATED_AFTER", "/media/unrelated-after.mov"],
      ["AST_AUDIO", "/media/audio.wav"],
    ]);

    const exported = timelineToFcp7Xml(timeline, { sourceMap });
    const movedBlock = exported.match(
      /<clipitem id="cv-moved">[\s\S]*?<\/clipitem>/,
    )![0];
    const returned = exported
      .replace(movedBlock, "")
      .replace(
        /(<clipitem id="cv-target-after">[\s\S]*?<\/clipitem>)/,
        `${movedBlock}\n$1`,
      );

    const parsed = parseFcp7Sequence(returned);
    expect(parsed.videoTracks[1]).toEqual([]);
    expect(parsed.videoTracks[2].map((clip) => clip.videoOsMeta?.clip_id)).toEqual([
      "target-before",
      "moved",
      "target-after",
    ]);

    const report = detectDiffs(parsed, timeline);
    const trackMoved = report.diffs.filter(
      (diff) => (diff as { kind: string }).kind === "track_moved",
    );
    expect(trackMoved).toEqual([expect.objectContaining({
      clip_id: "moved",
      source_track_id: "V1",
      target_track_id: "V2",
      after_clip_id: "target-before",
      before_clip_id: "target-after",
    })]);
    expect(report.diffs).toHaveLength(1);
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "deleted" }));
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "reordered" }));
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "trim_changed" }));
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "added_mapped" }));
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "added_unmapped" }));
    expect(report.unsupportedEdits).toEqual([]);

    const patched = applyDiffs(timeline, report.diffs);
    expect(patched.tracks.video[0]).toEqual(timeline.tracks.video[0]);
    expect(patched.tracks.video[1].clips).toEqual([]);
    expect(patched.tracks.video[2].clips.map((clip) => clip.clip_id)).toEqual([
      "target-before",
      "moved",
      "target-after",
    ]);
    expect(patched.tracks.video[2].clips[1]).toEqual(moved);
    expect(patched.tracks.video[3]).toEqual(timeline.tracks.video[3]);
    expect(patched.tracks.audio).toEqual(timeline.tracks.audio);
    expect(patched.transitions).toEqual(timeline.transitions);
    expect(patched.markers).toEqual(timeline.markers);
    expect(patched.provenance).toEqual(timeline.provenance);
    expect(timeline).toEqual(original);
  });

  it.each([
    ["changed start", (block: string) => block.replace("<start>30</start>", "<start>31</start>"), "unsafe_video_track_move"],
    ["changed end", (block: string) => block.replace("<end>60</end>", "<end>61</end>"), "unsafe_video_track_move"],
    ["changed in", (block: string) => block.replace("<in>0</in>", "<in>1</in>"), "unsafe_video_track_move"],
    ["changed out", (block: string) => block.replace("<out>30</out>", "<out>29</out>"), "unsafe_video_track_move"],
    ["changed duration", (block: string) => block.replace("<duration>30</duration>", "<duration>29</duration>"), "unsafe_video_track_move"],
    ["changed file", (block: string) => block.replace(/<file id="file-1"/, '<file id="unknown-file"'), "unsafe_video_track_move"],
    ["changed marker asset", (block: string) => block.replace("AST_MOVE", "AST_OTHER"), "unsafe_video_track_move"],
    ["duplicate marker identity", (block: string) => {
      const marker = block.match(/<marker>[\s\S]*?<\/marker>/)![0];
      return block.replace("</clipitem>", `${marker}</clipitem>`);
    }, "duplicate_mapped_identity"],
    ["duplicate direct field", (block: string) => block.replace("</clipitem>", "<start>30</start></clipitem>"), "unsafe_video_track_move"],
    ["unknown direct field", (block: string) => block.replace("</clipitem>", "<generator/></clipitem>"), "unsafe_video_track_move"],
    ["nested sequence", (block: string) => block.replace("</clipitem>", "<sequence/></clipitem>"), "unsafe_video_track_move"],
    ["direct link", (block: string) => block.replace("</clipitem>", "<link/></clipitem>"), "unsafe_video_track_move"],
    ["direct sourcetrack", (block: string) => block.replace("</clipitem>", "<sourcetrack/></clipitem>"), "unsafe_video_track_move"],
    ["direct media", (block: string) => block.replace("</clipitem>", "<media/></clipitem>"), "unsafe_video_track_move"],
    ["direct effect", (block: string) => block.replace("</clipitem>", "<effect/></clipitem>"), "unsafe_video_track_move"],
    ["direct speed", (block: string) => block.replace("</clipitem>", "<speed/></clipitem>"), "direct_speed_element_present"],
    ["direct filter", (block: string) => block.replace("</clipitem>", "<filter/></clipitem>"), "clip_filter_missing_effect"],
    ["rate mismatch", (block: string) => block.replace("<timebase>24</timebase>", "<timebase>25</timebase>"), "clip_rate_mismatch"],
  ] as Array<[string, (block: string) => string, string]>)(
    "blocks an observable moved clip with %s",
    (_name, mutate, reason) => {
    const fixture = makeTrackMoveFixture();
    const timelineBefore = structuredClone(fixture.timeline);
    const xml = fixture.returned.replace(fixture.movedBlock, mutate(fixture.movedBlock));
    const report = detectDiffs(parseFcp7Sequence(xml), fixture.timeline);
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(report.unsupportedEdits).toContainEqual(expect.objectContaining({
      clip_id: "move-candidate",
      reason,
    }));
    expect(fixture.timeline).toEqual(timelineBefore);
    },
  );

  it("blocks the accepted unsafe video track-move matrix", () => {
    const cases: Array<{
      name: string;
      build: () => { timeline: TimelineIR; xml: string };
      reason?: string;
    }> = [
      {
        name: "one target anchor",
        build: () => {
          const fixture = makeTrackMoveFixture();
          return { timeline: fixture.timeline, xml: fixture.returned.replace(fixture.afterBlock, "") };
        },
      },
      {
        name: "reversed target anchors",
        build: () => {
          const fixture = makeTrackMoveFixture();
          const xml = fixture.returned
            .replace(fixture.beforeBlock, "__MOVE_BEFORE__")
            .replace(fixture.afterBlock, fixture.beforeBlock)
            .replace("__MOVE_BEFORE__", fixture.afterBlock);
          return { timeline: fixture.timeline, xml };
        },
      },
      {
        name: "nonconsecutive canonical target anchors",
        build: () => {
          const fixture = makeTrackMoveFixture({ targetMiddle: true });
          return {
            timeline: fixture.timeline,
            xml: fixture.returned.replace(fixture.middleBlock!, ""),
          };
        },
      },
      {
        name: "target overlap",
        build: () => {
          const fixture = makeTrackMoveFixture({ movedStart: 20 });
          return { timeline: fixture.timeline, xml: fixture.returned };
        },
      },
      {
        name: "target anchor transition",
        build: () => {
          const fixture = makeTrackMoveFixture({ targetTransition: true });
          return { timeline: fixture.timeline, xml: fixture.returned };
        },
      },
      {
        name: "participating target reorder",
        build: () => {
          const fixture = makeTrackMoveFixture();
          const changedBefore = fixture.beforeBlock
            .replace("<start>0</start>", "<start>1</start>")
            .replace("<end>30</end>", "<end>31</end>");
          return {
            timeline: fixture.timeline,
            xml: fixture.returned.replace(fixture.beforeBlock, changedBefore),
          };
        },
      },
      {
        name: "duplicate XML ID",
        reason: "duplicate_mapped_identity",
        build: () => {
          const fixture = makeTrackMoveFixture();
          return {
            timeline: fixture.timeline,
            xml: fixture.returned.replace('id="cv-move-before"', 'id="cv-move-candidate"'),
          };
        },
      },
      {
        name: "markerless VIDEO anywhere",
        build: () => {
          const fixture = makeTrackMoveFixture();
          const markerless = fixture.afterBlock
            .replace('id="cv-move-after"', 'id="premiere-markerless"')
            .replace(/\s*<marker>[\s\S]*?<\/marker>/g, "");
          return {
            timeline: fixture.timeline,
            xml: fixture.returned.replace(
              /(<track>\s*<enabled>TRUE<\/enabled>\s*<locked>FALSE<\/locked>)(\s*<\/track>)/,
              `$1\n${markerless}$2`,
            ),
          };
        },
      },
    ];

    for (const testCase of cases) {
      const { timeline, xml } = testCase.build();
      const before = structuredClone(timeline);
      const report = detectDiffs(parseFcp7Sequence(xml), timeline);
      expect(report.diffs, testCase.name).not.toContainEqual(
        expect.objectContaining({ kind: "track_moved" }),
      );
      expect(report.unsupportedEdits, testCase.name).toContainEqual(
        expect.objectContaining({
          reason: testCase.reason ?? "unsafe_video_track_move",
        }),
      );
      expect(timeline, testCase.name).toEqual(before);
    }
  });

  it("keeps markerless move boundaries fail-closed without identity inference", () => {
    const fixture = makeTrackMoveFixture();
    const rawTimeline = Buffer.from(JSON.stringify(fixture.timeline));
    const receipt = createPremiereRoundtripReceipt(
      fixture.timeline.project_id,
      rawTimeline,
      "roundtrip.xml",
      Buffer.from(fixture.exported),
    );
    const retainedId = fixture.movedBlock.replace(
      /\s*<marker>[\s\S]*?<\/marker>/g,
      "",
    );
    const retainedXml = fixture.returned.replace(fixture.movedBlock, retainedId);
    expect(() => validatePremiereRoundtripApply(
      receipt,
      fixture.timeline.project_id,
      rawTimeline,
      parseFcp7Sequence(retainedXml),
      fixture.timeline,
    )).toThrow(/missing its video_os marker block/);

    const renamed = retainedId.replace(
      'id="cv-move-candidate"',
      'id="premiere-renamed-markerless"',
    );
    const renamedReport = detectDiffs(
      parseFcp7Sequence(fixture.returned.replace(fixture.movedBlock, renamed)),
      fixture.timeline,
    );
    expect(renamedReport.diffs).toContainEqual(expect.objectContaining({
      kind: "deleted",
      clip_id: "move-candidate",
    }));
    expect(renamedReport.diffs).toContainEqual(expect.objectContaining({
      kind: "added_unmapped",
      clip_id: "premiere-renamed-markerless",
    }));
    expect(renamedReport.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
  });

  it("blocks marker-backed audio and multiple video track moves", () => {
    const audioMoved = makeClip({
      clip_id: "audio-moved",
      asset_id: "AST_AUDIO_MOVE",
      timeline_in_frame: 30,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
      role: "music",
    });
    const audioBefore = makeClip({
      clip_id: "audio-before",
      asset_id: "AST_AUDIO_MOVE",
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
      role: "music",
    });
    const audioAfter = makeClip({
      clip_id: "audio-after",
      asset_id: "AST_AUDIO_AFTER",
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
      role: "music",
    });
    const audioTimeline = makeTimeline([], [[audioMoved], [audioBefore, audioAfter]]);
    const audioExported = timelineToFcp7Xml(audioTimeline, {
      sourceMap: new Map([
        ["AST_AUDIO_MOVE", "/media/audio-move.wav"],
        ["AST_AUDIO_AFTER", "/media/audio-after.wav"],
      ]),
    });
    const audioBlock = audioExported.match(
      /<clipitem id="ca-audio-moved">[\s\S]*?<\/clipitem>/,
    )![0];
    const audioAfterBlock = audioExported.match(
      /<clipitem id="ca-audio-after">[\s\S]*?<\/clipitem>/,
    )![0];
    const audioReturned = audioExported
      .replace(audioBlock, "")
      .replace(audioAfterBlock, `${audioBlock}\n${audioAfterBlock}`);
    const audioReport = detectDiffs(parseFcp7Sequence(audioReturned), audioTimeline);
    expect(audioReport.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(audioReport.unsupportedEdits).toContainEqual(expect.objectContaining({
      clip_id: "audio-moved",
      reason: "audio_track_move_not_supported",
    }));

    const moveOne = makeClip({
      clip_id: "multi-move-1",
      asset_id: "AST_MULTI_1",
      timeline_in_frame: 30,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const authorityOne = makeClip({
      clip_id: "multi-authority-1",
      asset_id: "AST_MULTI_1",
      timeline_in_frame: 120,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const anchorOneA = makeClip({
      clip_id: "multi-anchor-1a",
      asset_id: "AST_MULTI_1",
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const anchorOneB = makeClip({
      clip_id: "multi-anchor-1b",
      asset_id: "AST_MULTI_1B",
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const moveTwo = makeClip({
      clip_id: "multi-move-2",
      asset_id: "AST_MULTI_2",
      timeline_in_frame: 30,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const authorityTwo = makeClip({
      clip_id: "multi-authority-2",
      asset_id: "AST_MULTI_2",
      timeline_in_frame: 120,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const anchorTwoA = makeClip({
      clip_id: "multi-anchor-2a",
      asset_id: "AST_MULTI_2",
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const anchorTwoB = makeClip({
      clip_id: "multi-anchor-2b",
      asset_id: "AST_MULTI_2B",
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
    });
    const multipleTimeline = makeTimeline([
      [authorityOne],
      [authorityTwo],
      [moveOne],
      [anchorOneA, anchorOneB],
      [moveTwo],
      [anchorTwoA, anchorTwoB],
    ]);
    const multipleExported = timelineToFcp7Xml(multipleTimeline, {
      sourceMap: new Map([
        ["AST_MULTI_1", "/media/multi-1.mov"],
        ["AST_MULTI_1B", "/media/multi-1b.mov"],
        ["AST_MULTI_2", "/media/multi-2.mov"],
        ["AST_MULTI_2B", "/media/multi-2b.mov"],
      ]),
    });
    const moveOneBlock = multipleExported.match(
      /<clipitem id="cv-multi-move-1">[\s\S]*?<\/clipitem>/,
    )![0];
    const moveTwoBlock = multipleExported.match(
      /<clipitem id="cv-multi-move-2">[\s\S]*?<\/clipitem>/,
    )![0];
    const anchorOneBBlock = multipleExported.match(
      /<clipitem id="cv-multi-anchor-1b">[\s\S]*?<\/clipitem>/,
    )![0];
    const anchorTwoBBlock = multipleExported.match(
      /<clipitem id="cv-multi-anchor-2b">[\s\S]*?<\/clipitem>/,
    )![0];
    const multipleReturned = multipleExported
      .replace(moveOneBlock, "")
      .replace(moveTwoBlock, "")
      .replace(anchorOneBBlock, `${moveOneBlock}\n${anchorOneBBlock}`)
      .replace(anchorTwoBBlock, `${moveTwoBlock}\n${anchorTwoBBlock}`);
    const multipleReport = detectDiffs(
      parseFcp7Sequence(multipleReturned),
      multipleTimeline,
    );
    expect(multipleReport.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(multipleReport.unsupportedEdits.filter(
      (entry) => entry.reason === "multiple_track_moves_not_supported",
    )).toHaveLength(2);
  });

  it("prevalidates forged track moves before cloning or removal", () => {
    const fixture = makeTrackMoveFixture();
    const valid = {
      kind: "track_moved",
      clip_id: "move-candidate",
      source_track_id: "V1",
      target_track_id: "V2",
      after_clip_id: "move-before",
      before_clip_id: "move-after",
      detail: "test",
    } as ClipDiff;
    const invalids = [
      { ...valid, source_track_id: "missing" },
      { ...valid, target_track_id: "V1" },
      { ...valid, after_clip_id: "missing" },
      { ...valid, before_clip_id: "move-before" },
      [valid, valid],
    ];
    for (const invalid of invalids) {
      const before = structuredClone(fixture.timeline);
      expect(() => applyDiffs(
        fixture.timeline,
        (Array.isArray(invalid) ? invalid : [invalid]) as ClipDiff[],
      )).toThrow();
      expect(fixture.timeline).toEqual(before);
    }
  });

  it("review-fix M1 blocks a moved clip whose inline path self-authorizes", () => {
    const fixture = makeTrackMoveFixture({ independentFileAuthority: false });
    const changedBlock = fixture.movedBlock.replace(
      /<pathurl>[^<]+<\/pathurl>/,
      "<pathurl>file://localhost/media/changed-move.mov</pathurl>",
    );
    expect(changedBlock).not.toBe(fixture.movedBlock);
    const report = detectDiffs(
      parseFcp7Sequence(fixture.returned.replace(fixture.movedBlock, changedBlock)),
      fixture.timeline,
    );
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(report.unsupportedEdits).toContainEqual(expect.objectContaining({
      clip_id: "move-candidate",
      reason: "unsafe_video_track_move",
    }));
  });

  it("review-fix M2 blocks a parsed VIDEO track mixing three canonical tracks", () => {
    const clips = ["ambiguous-a", "ambiguous-b", "ambiguous-c"].map(
      (clip_id, index) => makeClip({
        clip_id,
        segment_id: `seg-${clip_id}`,
        asset_id: `AST_AMBIGUOUS_${index}`,
        timeline_in_frame: index * 30,
        timeline_duration_frames: 30,
        src_out_us: 1_250_000,
      }),
    );
    const timeline = makeTimeline(clips.map((clip) => [clip]));
    const exported = timelineToFcp7Xml(timeline, {
      sourceMap: new Map(clips.map((clip, index) => [
        clip.asset_id,
        `/media/ambiguous-${index}.mov`,
      ])),
    });
    const blocks = clips.map((clip) => exported.match(
      new RegExp(`<clipitem id="cv-${clip.clip_id}">[\\s\\S]*?<\\/clipitem>`),
    )![0]);
    const returned = exported
      .replace(blocks[1], "")
      .replace(blocks[2], "")
      .replace(blocks[0], `${blocks[0]}\n${blocks[1]}\n${blocks[2]}`);
    const report = detectDiffs(parseFcp7Sequence(returned), timeline);
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(report.unsupportedEdits).toContainEqual(expect.objectContaining({
      reason: "unsafe_video_track_move",
    }));
  });

  it("review-fix grouped two-canonical-track ambiguity blocks", () => {
    const clips = ["grouped-a1", "grouped-a2", "grouped-b1", "grouped-b2"].map(
      (clip_id, index) => makeClip({
        clip_id,
        segment_id: `seg-${clip_id}`,
        asset_id: `AST_GROUPED_${index}`,
        timeline_in_frame: index * 30,
        timeline_duration_frames: 30,
        src_out_us: 1_250_000,
      }),
    );
    const timeline = makeTimeline([clips.slice(0, 2), clips.slice(2)]);
    const exported = timelineToFcp7Xml(timeline, {
      sourceMap: new Map(clips.map((clip, index) => [
        clip.asset_id,
        `/media/grouped-${index}.mov`,
      ])),
    });
    const blocks = clips.map((clip) => exported.match(
      new RegExp(`<clipitem id="cv-${clip.clip_id}">[\\s\\S]*?<\\/clipitem>`),
    )![0]);
    const returned = exported
      .replace(blocks[2], "")
      .replace(blocks[3], "")
      .replace(blocks[1], `${blocks[1]}\n${blocks[2]}\n${blocks[3]}`);
    const parsed = parseFcp7Sequence(returned);
    expect(parsed.videoTracks[0].map((clip) => clip.videoOsMeta?.clip_id)).toEqual([
      "grouped-a1",
      "grouped-a2",
      "grouped-b1",
      "grouped-b2",
    ]);

    const report = detectDiffs(parsed, timeline);
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(report.unsupportedEdits).toContainEqual(expect.objectContaining({
      reason: "unsafe_video_track_move",
    }));
  });

  it("review-fix M2 blocks one canonical AUDIO track split across parsed tracks", () => {
    const audioA = makeClip({
      clip_id: "split-audio-a",
      asset_id: "AST_SPLIT_AUDIO_A",
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
      role: "music",
    });
    const audioB = makeClip({
      clip_id: "split-audio-b",
      asset_id: "AST_SPLIT_AUDIO_B",
      timeline_in_frame: 30,
      timeline_duration_frames: 30,
      src_out_us: 1_250_000,
      role: "music",
    });
    const timeline = makeTimeline([], [[audioA, audioB]]);
    const exported = timelineToFcp7Xml(timeline, {
      sourceMap: new Map([
        ["AST_SPLIT_AUDIO_A", "/media/split-a.wav"],
        ["AST_SPLIT_AUDIO_B", "/media/split-b.wav"],
      ]),
    });
    const audioBBlock = exported.match(
      /<clipitem id="ca-split-audio-b">[\s\S]*?<\/clipitem>/,
    )![0];
    const audioTrackBlock = exported.match(
      /<track>\s*<enabled>TRUE<\/enabled>\s*<locked>FALSE<\/locked>[\s\S]*?ca-split-audio-a[\s\S]*?ca-split-audio-b[\s\S]*?<\/track>/,
    )![0];
    const splitTrack = `<track>\n<enabled>TRUE</enabled>\n<locked>FALSE</locked>\n${audioBBlock}\n</track>`;
    const returned = exported.replace(
      audioTrackBlock,
      `${audioTrackBlock.replace(audioBBlock, "")}\n${splitTrack}`,
    );
    const report = detectDiffs(parseFcp7Sequence(returned), timeline);
    expect(report.diffs).not.toContainEqual(expect.objectContaining({ kind: "track_moved" }));
    expect(report.unsupportedEdits).toContainEqual(expect.objectContaining({
      clip_id: "split-audio-b",
      reason: "audio_track_move_not_supported",
    }));
  });

  it("review-fix M3 restores detection and forged-apply safety coverage", () => {
    const emptyTarget = makeTrackMoveFixture();
    const targetTrackBlock = emptyTarget.returned.match(
      /<track>(?:(?!<\/track>)[\s\S])*cv-move-before(?:(?!<\/track>)[\s\S])*cv-move-after(?:(?!<\/track>)[\s\S])*<\/track>/,
    )![0];
    const newEmptyTarget = [
      "<track>",
      "<enabled>TRUE</enabled>",
      "<locked>FALSE</locked>",
      emptyTarget.movedBlock,
      "</track>",
    ].join("\n");
    const emptyTargetXml = emptyTarget.returned.replace(
      targetTrackBlock,
      `${targetTrackBlock.replace(emptyTarget.movedBlock, "")}\n${newEmptyTarget}`,
    );
    const emptyTargetReport = detectDiffs(
      parseFcp7Sequence(emptyTargetXml),
      emptyTarget.timeline,
    );
    expect(emptyTargetReport.diffs).not.toContainEqual(
      expect.objectContaining({ kind: "track_moved" }),
    );

    const nonbracket = makeTrackMoveFixture({ movedStart: 100 });
    const nonbracketReport = detectDiffs(
      parseFcp7Sequence(nonbracket.returned),
      nonbracket.timeline,
    );
    expect(nonbracketReport.diffs).not.toContainEqual(
      expect.objectContaining({ kind: "track_moved" }),
    );
    expect(nonbracketReport.unsupportedEdits).toContainEqual(
      expect.objectContaining({ reason: "unsafe_video_track_move" }),
    );

    const transitioned = makeTrackMoveFixture();
    const transitionItem = [
      "<transitionitem>",
      "<start>54</start>",
      "<end>66</end>",
      "<alignment>center</alignment>",
      "<effect><name>Cross Dissolve</name><effectid>CrossDissolve</effectid><mediatype>video</mediatype></effect>",
      "</transitionitem>",
    ].join("");
    const transitionedXml = transitioned.returned.replace(
      transitioned.movedBlock,
      `${transitioned.movedBlock}\n${transitionItem}`,
    );
    const transitionedReport = detectDiffs(
      parseFcp7Sequence(transitionedXml),
      transitioned.timeline,
    );
    expect(transitionedReport.diffs).not.toContainEqual(
      expect.objectContaining({ kind: "track_moved" }),
    );
    expect(transitionedReport.unsupportedEdits).toContainEqual(
      expect.objectContaining({ reason: "unsafe_video_track_move" }),
    );

    const baseTransition = makeTrackMoveFixture();
    baseTransition.timeline.transitions = [{
      transition_id: "review-fix-moved-base-transition",
      from_clip_id: "move-candidate",
      to_clip_id: "move-after",
      track_id: "V1",
      transition_type: "crossfade",
    }];
    const baseTransitionReport = detectDiffs(
      parseFcp7Sequence(baseTransition.returned),
      baseTransition.timeline,
    );
    expect(baseTransitionReport.diffs).not.toContainEqual(
      expect.objectContaining({ kind: "track_moved" }),
    );
    expect(baseTransitionReport.unsupportedEdits).toContainEqual(
      expect.objectContaining({ reason: "unsafe_video_track_move" }),
    );

    const sourceConflict = makeTrackMoveFixture({ sourcePeer: true });
    const sourceConflictReport = detectDiffs(
      parseFcp7Sequence(
        sourceConflict.returned.replace(sourceConflict.sourcePeerBlock!, ""),
      ),
      sourceConflict.timeline,
    );
    expect(sourceConflictReport.diffs).not.toContainEqual(
      expect.objectContaining({ kind: "track_moved" }),
    );
    expect(sourceConflictReport.unsupportedEdits).toContainEqual(
      expect.objectContaining({ reason: "unsafe_video_track_move" }),
    );

    const fixture = makeTrackMoveFixture();
    const valid = {
      kind: "track_moved",
      clip_id: "move-candidate",
      source_track_id: "V1",
      target_track_id: "V2",
      after_clip_id: "move-before",
      before_clip_id: "move-after",
      detail: "review-fix",
    } as ClipDiff;
    const forged: TimelineIR[] = [];
    const duplicateTrack = structuredClone(fixture.timeline);
    duplicateTrack.tracks.video.push({
      ...structuredClone(duplicateTrack.tracks.video[1]),
      clips: [],
    });
    forged.push(duplicateTrack);
    const duplicateClip = structuredClone(fixture.timeline);
    duplicateClip.tracks.video[1].clips.push(structuredClone(duplicateClip.tracks.video[1].clips[0]));
    forged.push(duplicateClip);
    const overlap = structuredClone(fixture.timeline);
    overlap.tracks.video[1].clips[0].timeline_in_frame = 20;
    forged.push(overlap);
    const transitionConflict = structuredClone(fixture.timeline);
    transitionConflict.transitions = [{
      transition_id: "review-fix-conflict",
      from_clip_id: "move-candidate",
      to_clip_id: "move-after",
      track_id: "V1",
      transition_type: "crossfade",
    }];
    forged.push(transitionConflict);
    for (const timeline of forged) {
      const before = structuredClone(timeline);
      expect(() => applyDiffs(timeline, [valid])).toThrow();
      expect(timeline).toEqual(before);
    }
    const conflicting = {
      kind: "reordered",
      clip_id: "move-before",
      detail: "review-fix conflict",
      original: {
        src_in_us: 0,
        src_out_us: 1_250_000,
        timeline_in_frame: 0,
        timeline_duration_frames: 30,
      },
      updated: {
        src_in_us: 0,
        src_out_us: 1_250_000,
        timeline_in_frame: 1,
        timeline_duration_frames: 30,
      },
    } as ClipDiff;
    const before = structuredClone(fixture.timeline);
    expect(() => applyDiffs(fixture.timeline, [valid, conflicting])).toThrow();
    expect(fixture.timeline).toEqual(before);
  });

  it("imports one contained markerless known-source NTSC video clip", () => {
    const anchorA = makeClip({
      clip_id: "anchor-a",
      segment_id: "seg-anchor-a",
      asset_id: "AST_ANCHOR_A",
      src_out_us: 1_001_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 30,
    });
    const anchorC = makeClip({
      clip_id: "anchor-c",
      segment_id: "seg-anchor-c",
      asset_id: "AST_ANCHOR_C",
      src_out_us: 1_001_000,
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
    });
    const knownTemplate = makeClip({
      clip_id: "known-template",
      segment_id: "seg-known",
      asset_id: "AST_KNOWN",
      src_in_us: 0,
      src_out_us: 3_003_000,
      timeline_in_frame: 180,
      timeline_duration_frames: 90,
      role: "support",
      motivation: "Known source template",
      beat_id: "beat-known",
      fallback_segment_ids: ["seg-known-fallback"],
      confidence: 0.77,
      quality_flags: ["known-source"],
    });
    const timeline = makeTimeline([[anchorA, anchorC, knownTemplate]]);
    timeline.sequence.fps_num = 30_000;
    timeline.sequence.fps_den = 1_001;
    const originalTimeline = structuredClone(timeline);
    const sourceMap = new Map([
      ["AST_ANCHOR_A", "/media/anchor-a.mov"],
      ["AST_ANCHOR_C", "/media/anchor-c.mov"],
      ["AST_KNOWN", "/media/known source.mov"],
    ]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });
    const templateMatch = xml.match(
      /<clipitem id="cv-known-template">[\s\S]*?<\/clipitem>/,
    );
    expect(templateMatch).not.toBeNull();
    const templateBlock = templateMatch![0];
    const fileMatch = templateBlock.match(
      /<file id="([^"]+)">[\s\S]*?<\/file>/,
    );
    expect(fileMatch).not.toBeNull();
    const fileId = fileMatch![1];
    const pathMatch = fileMatch![0].match(/<pathurl>([^<]+)<\/pathurl>/);
    expect(pathMatch).not.toBeNull();
    const encodedPathurl = pathMatch![1];

    const candidateXmlId = "premiere-known-add-1";
    const candidateBlock = templateBlock
      .replace('id="cv-known-template"', `id="${candidateXmlId}"`)
      .replace(/<start>180<\/start>/, "<start>30</start>")
      .replace(/<end>270<\/end>/, "<end>60</end>")
      .replace(/<in>0<\/in>/, "<in>60</in>")
      .replace(fileMatch![0], `<file id="${fileId}"/>`)
      .replace(/\s*<marker>[\s\S]*?<\/marker>/g, "");

    expect(candidateBlock).toContain("<duration>90</duration>");
    expect(candidateBlock).toContain("<out>90</out>");
    expect(candidateBlock).toContain("<timebase>30</timebase>");
    expect(candidateBlock).toContain("<ntsc>TRUE</ntsc>");
    expect(candidateBlock).toContain(`<file id="${fileId}"/>`);
    expect(candidateBlock).not.toContain("video_os:");
    expect(candidateBlock.match(/<file\b/g)).toHaveLength(1);

    xml = xml.replace(
      /(<clipitem id="cv-anchor-a">[\s\S]*?<\/clipitem>)/,
      `$1\n${candidateBlock}`,
    );
    expect(xml.match(new RegExp(`<clipitem id="${candidateXmlId}">`, "g"))).toHaveLength(1);

    const parsed = parseFcp7Sequence(xml);
    const parsedCandidate = parsed.videoTracks[0].find(
      (clip) => clip.xmlClipId === candidateXmlId,
    );
    expect(parsedCandidate).toMatchObject({
      fileId,
      pathurl: encodedPathurl,
      timelineInFrame: 30,
      timelineEndFrame: 60,
      srcInFrame: 60,
      srcOutFrame: 90,
      videoOsMeta: null,
    });

    const report = detectDiffs(parsed, timeline);
    const mappedDiff = report.diffs.find(
      (diff) => (diff as { kind: string }).kind === "added_mapped",
    ) as
      | (typeof report.diffs[number] & {
          kind: "added_mapped";
          target_track_id: string;
          after_clip_id: string;
          before_clip_id: string;
          source_identity: { file_id: string; decoded_pathurl: string };
          added_clip: ClipOutput;
        })
      | undefined;
    expect(mappedDiff).toBeDefined();

    const decodedPathurl = decodeURIComponent(encodedPathurl);
    const expectedClipId = `premiere_add_${createHash("sha256")
      .update(JSON.stringify([
        "premiere-known-source-add/v1",
        timeline.project_id,
        "V1",
        "anchor-a",
        "anchor-c",
        candidateXmlId,
        fileId,
        decodedPathurl,
        30_000,
        1_001,
        30,
        60,
        60,
        90,
      ]))
      .digest("hex")}`;
    expect(mappedDiff).toMatchObject({
      clip_id: expectedClipId,
      target_track_id: "V1",
      after_clip_id: "anchor-a",
      before_clip_id: "anchor-c",
      source_identity: {
        file_id: fileId,
        decoded_pathurl: decodedPathurl,
      },
      added_clip: {
        clip_id: expectedClipId,
        segment_id: "seg-known",
        asset_id: "AST_KNOWN",
        src_in_us: 2_002_000,
        src_out_us: 3_003_000,
        timeline_in_frame: 30,
        timeline_duration_frames: 30,
        role: "support",
        motivation: "Known source template",
        beat_id: "beat-known",
        fallback_segment_ids: ["seg-known-fallback"],
        confidence: 0.77,
        quality_flags: ["known-source"],
      },
    });
    expect(report.diffs).not.toContainEqual(
      expect.objectContaining({
        kind: "added_unmapped",
        clip_id: candidateXmlId,
      }),
    );
    expect(Math.round((30 * 1_000_000 * 1_001) / 30_000)).toBe(1_001_000);

    const patched = applyDiffs(timeline, report.diffs);
    expect(patched.tracks.video[0].clips.map((clip) => clip.clip_id)).toEqual([
      "anchor-a",
      expectedClipId,
      "anchor-c",
      "known-template",
    ]);
    expect(patched.tracks.video[0].clips[0]).toEqual(anchorA);
    expect(patched.tracks.video[0].clips[2]).toEqual(anchorC);
    expect(patched.tracks.video[0].clips[3]).toEqual(knownTemplate);
    expect(patched.transitions).toEqual(timeline.transitions);
    expect(timeline).toEqual(originalTimeline);
  });

  it("keeps unsafe markerless additions unmapped across the bounded rejection matrix", () => {
    type RejectedFixture = ReturnType<typeof makeKnownSourceAdditionFixture> & {
      xml: string;
      expectedXmlId?: string;
    };
    const build = (
      mutate?: (fixture: ReturnType<typeof makeKnownSourceAdditionFixture>) => {
        xml?: string;
        expectedXmlId?: string;
      } | void,
    ): RejectedFixture => {
      const fixture = makeKnownSourceAdditionFixture();
      const changed: { xml?: string; expectedXmlId?: string } =
        mutate?.(fixture) ?? {};
      return {
        ...fixture,
        xml: changed.xml ?? insertAfterAnchorA(fixture.baseXml, fixture.candidateBlock),
        expectedXmlId: changed.expectedXmlId ?? fixture.candidateXmlId,
      };
    };
    const transitionItem = `
      <transitionitem>
        <start>30</start><end>31</end><alignment>center</alignment>
        <effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><mediatype>video</mediatype></effect>
      </transitionitem>`;
    const cases: Array<[string, () => RejectedFixture]> = [
      ["unknown file ID", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace(
            `<file id="${fixture.fileId}"/>`,
            '<file id="file-unknown"/>',
          ),
        ),
      }))],
      ["malformed percent-encoded path", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml.replace("known%20source.mov", "known%ZZsource.mov"),
          fixture.candidateBlock,
        ),
      }))],
      ["empty path definition", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml.replace(
            /<pathurl>file:\/\/localhost\/media\/known%20source\.mov<\/pathurl>/,
            "<pathurl></pathurl>",
          ),
          fixture.candidateBlock,
        ),
      }))],
      ["conflicting path definitions", () => build((fixture) => {
        const anchorBlock = fixture.baseXml.match(
          /<clipitem id="cv-anchor-a">[\s\S]*?<\/clipitem>/,
        )![0];
        const conflictingAnchor = anchorBlock.replace(
          /<file id="[^"]+">[\s\S]*?<\/file>/,
          (file) => file.replace(/id="[^"]+"/, `id="${fixture.fileId}"`),
        );
        return {
          xml: insertAfterAnchorA(
            fixture.baseXml.replace(anchorBlock, conflictingAnchor),
            fixture.candidateBlock,
          ),
        };
      })],
      ["conflicting asset authority", () => build((fixture) => {
        const anchorBlock = fixture.baseXml.match(
          /<clipitem id="cv-anchor-a">[\s\S]*?<\/clipitem>/,
        )![0];
        const conflictingAnchor = anchorBlock.replace(
          /<file id="[^"]+">[\s\S]*?<\/file>/,
          `<file id="${fixture.fileId}"/>`,
        );
        return {
          xml: insertAfterAnchorA(
            fixture.baseXml.replace(anchorBlock, conflictingAnchor),
            fixture.candidateBlock,
          ),
        };
      })],
      ["conflicting template authority", () => build((fixture) => {
        const originalTemplate = fixture.baseXml.match(
          /<clipitem id="cv-known-template">[\s\S]*?<\/clipitem>/,
        )![0];
        const secondTemplate = originalTemplate.replaceAll(
          "known-template",
          "known-template-2",
        );
        fixture.timeline.tracks.video[0].clips.push(makeClip({
          ...fixture.timeline.tracks.video[0].clips[2],
          clip_id: "known-template-2",
          motivation: "Conflicting known source semantics",
        }));
        const withSecondTemplate = fixture.baseXml.replace(
          originalTemplate,
          `${originalTemplate}\n${secondTemplate}`,
        );
        return { xml: insertAfterAnchorA(withSecondTemplate, fixture.candidateBlock) };
      })],
      ["missing predecessor anchor", () => build((fixture) => {
        const withoutAnchorMarker = fixture.baseXml.replace(
          /(<clipitem id="cv-anchor-a">[\s\S]*?)\s*<marker>[\s\S]*?<\/marker>/,
          "$1",
        );
        return { xml: insertAfterAnchorA(withoutAnchorMarker, fixture.candidateBlock) };
      })],
      ["cross-track anchors", () => build((fixture) => {
        const [anchorC] = fixture.timeline.tracks.video[0].clips.splice(1, 1);
        fixture.timeline.tracks.video.push({
          track_id: "V2",
          kind: "video",
          clips: [anchorC],
        });
      })],
      ["reversed reference anchors", () => build((fixture) => {
        const [anchorA, anchorC, template] = fixture.timeline.tracks.video[0].clips;
        fixture.timeline.tracks.video[0].clips = [anchorC, anchorA, template];
      })],
      ["nonconsecutive reference anchors", () => build((fixture) => {
        fixture.timeline.tracks.video[0].clips.splice(1, 0, makeClip({
          clip_id: "unreturned-between-anchors",
          asset_id: "AST_UNRETURNED",
          timeline_in_frame: 40,
          timeline_duration_frames: 10,
        }));
      })],
      ["concurrent anchor trim", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml.replace(
            /(<clipitem id="cv-anchor-a">[\s\S]*?)<out>30<\/out>/,
            "$1<out>29</out>",
          ),
          fixture.candidateBlock,
        ),
      }))],
      ["concurrent anchor reorder", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml.replace(
            /(<clipitem id="cv-anchor-a">[\s\S]*?)<start>0<\/start>([\s\S]*?)<end>30<\/end>/,
            "$1<start>1</start>$2<end>31</end>",
          ),
          fixture.candidateBlock,
        ),
      }))],
      ["concurrent target deletion", () => build((fixture) => {
        fixture.timeline.tracks.video[0].clips.push(makeClip({
          clip_id: "unreturned-target-clip",
          asset_id: "AST_UNRETURNED",
          timeline_in_frame: 300,
          timeline_duration_frames: 30,
        }));
      })],
      ["existing overlap", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock
            .replace("<start>30</start>", "<start>20</start>")
            .replace("<end>60</end>", "<end>50</end>"),
        ),
      }))],
      ["markerless audio", () => build((fixture) => ({
        xml: fixture.baseXml.replace(
          /\s*<\/media>\s*<\/sequence>/,
          `<audio><track>${fixture.candidateBlock}</track></audio></media></sequence>`,
        ),
      }))],
      ["shared anchor gap", () => build((fixture) => {
        const second = fixture.candidateBlock.replace(
          fixture.candidateXmlId,
          "premiere-known-add-2",
        );
        return {
          xml: insertAfterAnchorA(
            fixture.baseXml,
            `${fixture.candidateBlock}\n${second}`,
          ),
        };
      })],
      ["candidate transition endpoint", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          `${fixture.candidateBlock}\n${transitionItem}`,
        ),
      }))],
      ["base transition across anchors", () => build((fixture) => {
        fixture.timeline.transitions = [{
          transition_id: "tr-anchor-gap",
          from_clip_id: "anchor-a",
          to_clip_id: "anchor-c",
          track_id: "V1",
          transition_type: "dissolve",
        }];
      })],
      ["inline candidate file body", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace(
            `<file id="${fixture.fileId}"/>`,
            fixture.fullFileBlock,
          ),
        ),
      }))],
      ["direct filter effect", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace(
            "</clipitem>",
            "<filter><effect><effectid>blur</effectid></effect></filter></clipitem>",
          ),
        ),
      }))],
      ["direct speed", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("</clipitem>", "<speed>200</speed></clipitem>"),
        ),
      }))],
      ["unknown direct child", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("</clipitem>", "<mystery>1</mystery></clipitem>"),
        ),
      }))],
      ["extra clipitem attribute", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace(
            `<clipitem id="${fixture.candidateXmlId}">`,
            `<clipitem id="${fixture.candidateXmlId}" enabled="TRUE">`,
          ),
        ),
      }))],
      ["duplicate clipitem ID attribute", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace(
            `<clipitem id="${fixture.candidateXmlId}">`,
            `<clipitem id="${fixture.candidateXmlId}" id="duplicate">`,
          ),
        ),
        expectedXmlId: "duplicate",
      }))],
      ["duplicate structural child", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<start>30</start>", "<start>30</start><start>30</start>"),
        ),
      }))],
      ["nested compound content", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("</clipitem>", "<sequence><media/></sequence></clipitem>"),
        ),
      }))],
      ["missing rate", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace(/\s*<rate>[\s\S]*?<\/rate>/, ""),
        ),
      }))],
      ["malformed NTSC rate", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<timebase>30</timebase>", "<timebase>030</timebase>"),
        ),
      }))],
      ["malformed NTSC literal", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<ntsc>TRUE</ntsc>", "<ntsc>true</ntsc>"),
        ),
      }))],
      ["mismatched rate", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock
            .replace("<timebase>30</timebase>", "<timebase>24</timebase>")
            .replace("<ntsc>TRUE</ntsc>", "<ntsc>FALSE</ntsc>"),
        ),
      }))],
      ["implicit retime", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<end>60</end>", "<end>61</end>"),
        ),
      }))],
      ["template range overflow", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock
            .replace("<duration>90</duration>", "<duration>120</duration>")
            .replace("<in>60</in>", "<in>90</in>")
            .replace("<out>90</out>", "<out>120</out>"),
        ),
      }))],
      ["negative numeric field", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<start>30</start>", "<start>-1</start>"),
        ),
      }))],
      ["unsafe numeric field", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock
            .replace("<duration>90</duration>", "<duration>9007199254740992</duration>")
            .replace("<out>90</out>", "<out>9007199254740992</out>"),
        ),
      }))],
      ["unsafe conversion product", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock
            .replace("<duration>90</duration>", "<duration>9007199254</duration>")
            .replace("<end>60</end>", "<end>9007199224</end>")
            .replace("<out>90</out>", "<out>9007199254</out>"),
        ),
      }))],
      ["noncanonical numeric text", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<start>30</start>", "<start>030</start>"),
        ),
      }))],
      ["duration mismatch", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          fixture.candidateBlock.replace("<duration>90</duration>", "<duration>89</duration>"),
        ),
      }))],
      ["duplicate XML ID", () => build((fixture) => ({
        xml: insertAfterAnchorA(
          fixture.baseXml,
          `${fixture.candidateBlock}\n${fixture.candidateBlock}`,
        ),
      }))],
      ["base-impersonating XML ID", () => build((fixture) => {
        fixture.timeline.tracks.audio.push({
          track_id: "A1",
          kind: "audio",
          clips: [makeClip({ clip_id: "base-audio", asset_id: "AST_AUDIO" })],
        });
        const xmlId = "ca-base-audio";
        return {
          expectedXmlId: xmlId,
          xml: insertAfterAnchorA(
            fixture.baseXml,
            fixture.candidateBlock.replace(fixture.candidateXmlId, xmlId),
          ),
        };
      })],
      ["derived clip ID collision", () => build((fixture) => {
        const encodedPathurl = fixture.fullFileBlock.match(
          /<pathurl>([^<]+)<\/pathurl>/,
        )![1];
        const collisionId = `premiere_add_${createHash("sha256")
          .update(JSON.stringify([
            "premiere-known-source-add/v1",
            fixture.timeline.project_id,
            "V1",
            "anchor-a",
            "anchor-c",
            fixture.candidateXmlId,
            fixture.fileId,
            decodeURIComponent(encodedPathurl),
            30_000,
            1_001,
            30,
            60,
            60,
            90,
          ]))
          .digest("hex")}`;
        fixture.timeline.tracks.audio.push({
          track_id: "A1",
          kind: "audio",
          clips: [makeClip({ clip_id: collisionId, asset_id: "AST_COLLISION" })],
        });
      })],
    ];

    for (const [name, makeRejectedFixture] of cases) {
      const fixture = makeRejectedFixture();
      const report = detectDiffs(parseFcp7Sequence(fixture.xml), fixture.timeline);
      expect(
        report.diffs.some((diff) => diff.kind === "added_mapped"),
        name,
      ).toBe(false);
      expect(
        report.diffs.some(
          (diff) =>
            diff.kind === "added_unmapped" &&
            diff.clip_id === fixture.expectedXmlId,
        ),
        name,
      ).toBe(true);
      const patched = applyDiffs(fixture.timeline, report.diffs);
      expect(
        patched.tracks.video.flatMap((track) => track.clips).some(
          (clip) => clip.clip_id.startsWith("premiere_add_"),
        ),
        name,
      ).toBe(false);
    }
  });

  it("revalidates mapped additions before any anchored splice", () => {
    const fixture = makeKnownSourceAdditionFixture();
    const xml = insertAfterAnchorA(fixture.baseXml, fixture.candidateBlock);
    const report = detectDiffs(parseFcp7Sequence(xml), fixture.timeline);
    const mapped = report.diffs.find((diff) => diff.kind === "added_mapped");
    expect(mapped).toBeDefined();
    if (!mapped || mapped.kind !== "added_mapped") return;

    const invalidDiffs: ClipDiff[] = [
      { ...structuredClone(mapped), target_track_id: "V-missing" },
      { ...structuredClone(mapped), before_clip_id: "known-template" },
      {
        ...structuredClone(mapped),
        clip_id: "anchor-a",
        added_clip: { ...mapped.added_clip, clip_id: "anchor-a" },
      },
      {
        ...structuredClone(mapped),
        added_clip: { ...mapped.added_clip, timeline_in_frame: -1 },
      },
      {
        ...structuredClone(mapped),
        added_clip: {
          ...mapped.added_clip,
          timeline_in_frame: 0,
          timeline_duration_frames: 30,
        },
      },
    ];
    for (const invalid of invalidDiffs) {
      const original = structuredClone(fixture.timeline);
      expect(() => applyDiffs(fixture.timeline, [invalid])).toThrow();
      expect(fixture.timeline).toEqual(original);
    }
  });

  it("detects in/out trim changes", () => {
    const clip = makeClip({
      clip_id: "clip-1",
      src_in_us: 0,
      src_out_us: 3_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    // Export, then modify the XML to change in/out
    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Simulate Premiere changing in from 0 to 12 and out from 72 to 60
    xml = xml.replace(/<in>0<\/in>/, "<in>12</in>");
    xml = xml.replace(/<out>72<\/out>/, "<out>60</out>");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.diffs.length).toBeGreaterThan(0);
    const trimDiff = report.diffs.find((d) => d.kind === "trim_changed");
    expect(trimDiff).toBeDefined();
    expect(trimDiff!.clip_id).toBe("clip-1");
  });

  it("detects clip reorder", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      asset_id: "AST_001",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      asset_id: "AST_002",
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
    });
    const timeline = makeTimeline([[clip1, clip2]]);
    const sourceMap = new Map([
      ["AST_001", "/media/a.mov"],
      ["AST_002", "/media/b.mov"],
    ]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Move clip-1 from frame 0→48 by targeting its specific clipitem
    // Replace within the first clipitem block (clip-1)
    xml = xml.replace(
      /(<clipitem id="cv-clip-1">[\s\S]*?)<start>0<\/start>([\s\S]*?)<end>48<\/end>/,
      "$1<start>48</start>$2<end>96</end>",
    );
    // Replace within the second clipitem block (clip-2)
    xml = xml.replace(
      /(<clipitem id="cv-clip-2">[\s\S]*?)<start>48<\/start>([\s\S]*?)<end>96<\/end>/,
      "$1<start>0</start>$2<end>48</end>",
    );

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    const reorderDiffs = report.diffs.filter((d) => d.kind === "reordered");
    expect(reorderDiffs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects clip deletion", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      asset_id: "AST_001",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      asset_id: "AST_002",
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
    });
    const timeline = makeTimeline([[clip1, clip2]]);
    const sourceMap = new Map([
      ["AST_001", "/media/a.mov"],
      ["AST_002", "/media/b.mov"],
    ]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Remove the second clipitem entirely
    const clipitemRegex =
      /<clipitem id="cv-clip-2">[\s\S]*?<\/clipitem>/;
    xml = xml.replace(clipitemRegex, "");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    const deleteDiffs = report.diffs.filter((d) => d.kind === "deleted");
    expect(deleteDiffs).toHaveLength(1);
    expect(deleteDiffs[0].clip_id).toBe("clip-2");
  });

  it("detects unmapped new clips", () => {
    const clip = makeClip();
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Add a new clipitem without video_os marker
    const newClip = `
        <clipitem id="new-premiere-clip">
          <name>New clip from Premiere</name>
          <duration>48</duration>
          <rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
          <start>72</start>
          <end>120</end>
          <in>0</in>
          <out>48</out>
          <file id="file-1"/>
        </clipitem>`;
    xml = xml.replace("</track>", newClip + "\n        </track>");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.unmappedClips).toBe(1);
    const addDiffs = report.diffs.filter((d) => d.kind === "added_unmapped");
    expect(addDiffs).toHaveLength(1);
  });
});

// ── 5. Diff Application ─────────────────────────────────────────────

describe("applyDiffs", () => {
  it("applies trim changes to timeline", () => {
    const clip = makeClip({
      clip_id: "clip-1",
      src_in_us: 0,
      src_out_us: 3_000_000,
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
    const timeline = makeTimeline([[clip]]);

    const patched = applyDiffs(timeline, [
      {
        kind: "trim_changed",
        clip_id: "clip-1",
        detail: "Trim changed",
        original: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 72,
        },
        updated: {
          src_in_us: 500_000,
          src_out_us: 2_500_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 48,
        },
      },
    ]);

    const patchedClip = patched.tracks.video[0].clips[0];
    expect(patchedClip.src_in_us).toBe(500_000);
    expect(patchedClip.src_out_us).toBe(2_500_000);
    expect(patchedClip.timeline_duration_frames).toBe(48);
  });

  it("removes deleted clips", () => {
    const clip1 = makeClip({ clip_id: "clip-1" });
    const clip2 = makeClip({
      clip_id: "clip-2",
      timeline_in_frame: 72,
    });
    const timeline = makeTimeline([[clip1, clip2]]);

    const patched = applyDiffs(timeline, [
      {
        kind: "deleted",
        clip_id: "clip-2",
        detail: "Clip deleted",
      },
    ]);

    expect(patched.tracks.video[0].clips).toHaveLength(1);
    expect(patched.tracks.video[0].clips[0].clip_id).toBe("clip-1");
  });

  it("roundtrips mapped video and audio deletion with dependent transition reconciliation", () => {
    const videoLate = makeClip({
      clip_id: "video-late",
      asset_id: "AST_LATE",
      timeline_in_frame: 96,
      timeline_duration_frames: 24,
    });
    const videoDelete1 = makeClip({
      clip_id: "video-delete-1",
      asset_id: "AST_DELETE_1",
      timeline_in_frame: 0,
      timeline_duration_frames: 24,
    });
    const videoEarly = makeClip({
      clip_id: "video-early",
      asset_id: "AST_EARLY",
      timeline_in_frame: 24,
      timeline_duration_frames: 24,
    });
    const videoDelete2 = makeClip({
      clip_id: "video-delete-2",
      asset_id: "AST_DELETE_2",
      timeline_in_frame: 48,
      timeline_duration_frames: 24,
    });
    const linkedAudioSurvivor = makeClip({
      clip_id: "audio-linked-survivor",
      asset_id: "AST_DELETE_1",
      timeline_in_frame: 72,
      timeline_duration_frames: 24,
      role: "nat_sound",
    });
    const audioDelete = makeClip({
      clip_id: "audio-delete",
      asset_id: "AST_AUDIO_DELETE",
      timeline_in_frame: 0,
      timeline_duration_frames: 24,
      role: "music",
    });
    const retainedTransitions: TimelineTransitionOutput[] = [
      {
        transition_id: "tr-retained-deep",
        from_clip_id: "video-late",
        to_clip_id: "video-early",
        track_id: "V1",
        transition_type: "custom",
        transition_frames: 7,
        transition_params: {
          nested: { layers: ["foreground", { curve: [0, 0.5, 1] }] },
        },
        applied_skill_id: "deep-structure",
        confidence: 0.73,
      },
      {
        transition_id: "tr-unrelated-dangling",
        from_clip_id: "unrelated-missing-clip",
        to_clip_id: "video-early",
        track_id: "V1",
        transition_type: "manual",
        transition_params: { preserve: true },
      },
      {
        transition_id: "tr-retained-tail",
        from_clip_id: "video-early",
        to_clip_id: "video-late",
        track_id: "V1",
        transition_type: "cut",
      },
    ];
    const timeline = makeTimeline(
      [[videoLate, videoDelete1, videoEarly, videoDelete2]],
      [[linkedAudioSurvivor, audioDelete]],
      [
        retainedTransitions[0],
        {
          transition_id: "tr-delete-video-from",
          from_clip_id: "video-delete-1",
          to_clip_id: "video-early",
          track_id: "V1",
          transition_type: "dissolve",
        },
        retainedTransitions[1],
        {
          transition_id: "tr-delete-audio-to",
          from_clip_id: "audio-linked-survivor",
          to_clip_id: "audio-delete",
          track_id: "A1",
          transition_type: "audio_crossfade",
        },
        {
          transition_id: "tr-delete-video-to",
          from_clip_id: "video-early",
          to_clip_id: "video-delete-2",
          track_id: "V1",
          transition_type: "wipe",
        },
        retainedTransitions[2],
      ],
    );
    const sourceMap = new Map([
      ["AST_LATE", "/media/late.mov"],
      ["AST_DELETE_1", "/media/delete-1.mov"],
      ["AST_EARLY", "/media/early.mov"],
      ["AST_DELETE_2", "/media/delete-2.mov"],
      ["AST_AUDIO_DELETE", "/media/delete.wav"],
    ]);

    const exportTimeline = structuredClone(timeline);
    delete exportTimeline.transitions;
    let xml = timelineToFcp7Xml(exportTimeline, { sourceMap });
    for (const xmlClipId of [
      "cv-video-delete-1",
      "cv-video-delete-2",
      "ca-audio-delete",
    ]) {
      xml = xml.replace(
        new RegExp(`<clipitem id="${xmlClipId}">[\\s\\S]*?</clipitem>`),
        "",
      );
    }

    const diffs = detectDiffs(parseFcp7Sequence(xml), timeline).diffs;
    expect(
      diffs.filter((diff) => diff.kind === "deleted").map((diff) => diff.clip_id),
    ).toEqual(["video-delete-1", "video-delete-2", "audio-delete"]);

    const patched = applyDiffs(timeline, diffs);
    expect(patched.tracks.video[0].clips.map((clip) => clip.clip_id)).toEqual([
      "video-late",
      "video-early",
    ]);
    expect(patched.tracks.audio[0].clips.map((clip) => clip.clip_id)).toEqual([
      "audio-linked-survivor",
    ]);
    expect(patched.tracks.video[0].clips).toEqual([videoLate, videoEarly]);
    expect(patched.tracks.audio[0].clips).toEqual([linkedAudioSurvivor]);
    expect(patched.transitions).toEqual(retainedTransitions);

    const withoutTransitions = makeTimeline([[videoDelete1]]);
    expect(applyDiffs(withoutTransitions, diffs)).not.toHaveProperty("transitions");
    const withEmptyTransitions = makeTimeline([[videoDelete1]], [], []);
    expect(applyDiffs(withEmptyTransitions, diffs).transitions).toEqual([]);
  });

  it("applies reorder and sorts by timeline position", () => {
    const clip1 = makeClip({
      clip_id: "clip-1",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "clip-2",
      timeline_in_frame: 48,
      timeline_duration_frames: 48,
    });
    const timeline = makeTimeline([[clip1, clip2]]);

    const patched = applyDiffs(timeline, [
      {
        kind: "reordered",
        clip_id: "clip-1",
        detail: "Moved",
        original: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 48,
        },
        updated: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 48,
          timeline_duration_frames: 48,
        },
      },
      {
        kind: "reordered",
        clip_id: "clip-2",
        detail: "Moved",
        original: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 48,
          timeline_duration_frames: 48,
        },
        updated: {
          src_in_us: 0,
          src_out_us: 3_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 48,
        },
      },
    ]);

    // After sort, clip-2 should be first (frame 0), clip-1 second (frame 48)
    expect(patched.tracks.video[0].clips[0].clip_id).toBe("clip-2");
    expect(patched.tracks.video[0].clips[1].clip_id).toBe("clip-1");
  });

  it("does not mutate the original timeline", () => {
    const clip = makeClip({ clip_id: "clip-1" });
    const timeline = makeTimeline([[clip]]);
    const originalJson = JSON.stringify(timeline);

    applyDiffs(timeline, [
      {
        kind: "deleted",
        clip_id: "clip-1",
        detail: "Deleted",
      },
    ]);

    expect(JSON.stringify(timeline)).toBe(originalJson);
  });
});

// ── 6. Japanese Path Roundtrip ───────────────────────────────────────

describe("Japanese path roundtrip", () => {
  it("handles Japanese characters in file paths", () => {
    const clip = makeClip({
      clip_id: "clip-jp",
      asset_id: "AST_JP",
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([
      ["AST_JP", "/メディア/素材/インタビュー.mov"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Verify pathurl is percent-encoded
    expect(xml).toContain("file://localhost/");
    // The pathurl should be percent-encoded, but <name> retains original filename
    expect(xml).toContain("pathurl");

    // Parse back
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTracks[0][0].videoOsMeta).not.toBeNull();
    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("clip-jp");

    // File reference should be present (encoded URL)
    expect(parsed.videoTracks[0][0].pathurl).toBeTruthy();
  });

  it("handles Japanese characters in clip motivation", () => {
    const clip = makeClip({
      clip_id: "clip-jp2",
      motivation: "オープニングショット",
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    // Marker comment contains clip_id in JSON format
    expect(xml).toContain("clip-jp2");

    const parsed = parseFcp7Sequence(xml);
    const meta = parsed.videoTracks[0][0].videoOsMeta;
    expect(meta).not.toBeNull();
    expect(meta!.motivation).toBe("オープニングショット");
  });
});

// ── 7. Audio track roundtrip ─────────────────────────────────────────

describe("audio track roundtrip", () => {
  it("preserves audio clips with duck level (via linear gain conversion)", () => {
    const audioClip = makeClip({
      clip_id: "audio-1",
      asset_id: "AST_MUSIC",
      role: "music",
      motivation: "BGM",
      beat_id: "beat-bgm",
      audio_policy: { duck_music_db: -12 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_MUSIC", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    expect(xml).toContain("audiolevels");
    expect(xml).toContain("<valuemin>0</valuemin>");
    expect(xml).toContain("<valuemax>4</valuemax>");

    const parsed = parseFcp7Sequence(xml);
    expect(parsed.audioTracks).toHaveLength(1);
    expect(parsed.audioTracks[0]).toHaveLength(1);
    // New format: linear gain is parsed
    expect(parsed.audioTracks[0][0].audioGainLinear).toBeCloseTo(0.251189, 3);
    expect(parsed.audioTracks[0][0].videoOsMeta!.clip_id).toBe("audio-1");

    // Full roundtrip to TimelineIR: duck_music_db becomes bgm_gain
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    const importedClip = imported.tracks.audio[0].clips[0];
    expect(importedClip.audio_policy?.bgm_gain).toBeCloseTo(-12, 1);
    expect(importedClip.audio_policy?.gain_unit).toBe("db");
  });

  it("preserves audio clips with bgm_gain", () => {
    const audioClip = makeClip({
      clip_id: "audio-bgm",
      asset_id: "AST_MUSIC",
      role: "music",
      motivation: "BGM",
      beat_id: "beat-bgm",
      audio_policy: { bgm_gain: -6 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_MUSIC", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    const parsed = parseFcp7Sequence(xml);
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    const importedClip = imported.tracks.audio[0].clips[0];
    expect(importedClip.audio_policy?.bgm_gain).toBeCloseTo(-6, 1);
    expect(importedClip.audio_policy?.gain_unit).toBe("db");
  });

  it("preserves nat_sound_gain through roundtrip", () => {
    const audioClip = makeClip({
      clip_id: "audio-nat",
      asset_id: "AST_NAT",
      role: "nat_sound",
      motivation: "Natural sound",
      beat_id: "beat-nat",
      audio_policy: { nat_sound_gain: -9 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_NAT", "/media/nat.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    const parsed = parseFcp7Sequence(xml);
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    const importedClip = imported.tracks.audio[0].clips[0];
    expect(importedClip.audio_policy?.nat_sound_gain).toBeCloseTo(-9, 1);
    expect(importedClip.audio_policy?.gain_unit).toBe("db");
  });

  it("preserves fade keyframes through roundtrip", () => {
    const audioClip = makeClip({
      clip_id: "audio-fade",
      asset_id: "AST_BGM",
      role: "music",
      motivation: "BGM with fades",
      beat_id: "beat-bgm",
      timeline_duration_frames: 240,
      audio_policy: {
        bgm_gain: -6,
        bgm_fade_in_frames: 24,
        bgm_fade_out_frames: 48,
      },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([["AST_BGM", "/media/bgm.wav"]]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    const parsed = parseFcp7Sequence(xml);

    // Check parsed fade values
    expect(parsed.audioTracks[0][0].fadeInFrames).toBe(24);
    expect(parsed.audioTracks[0][0].fadeOutFrames).toBe(48);
    expect(parsed.audioTracks[0][0].audioGainLinear).toBeCloseTo(0.501187, 3);

    // Full roundtrip
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    const importedClip = imported.tracks.audio[0].clips[0];
    expect(importedClip.audio_policy?.bgm_gain).toBeCloseTo(-6, 1);
    expect(importedClip.audio_policy?.bgm_fade_in_frames).toBe(24);
    expect(importedClip.audio_policy?.bgm_fade_out_frames).toBe(48);
  });
});

// ── 8. Comment/PI resilience (self-roundtrip smoke test) ─────────────

describe("XML comment and PI resilience", () => {
  it("parses XML with metadata comment before xmeml (exporter output)", () => {
    const clip = makeClip({ clip_id: "comment-test" });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    const xml = timelineToFcp7Xml(timeline, {
      sourceMap,
      projectId: "PROJ_COMMENT",
      timelineVersion: "v1",
    });

    // Verify the metadata comment is present
    expect(xml).toContain("<!-- Video OS v2");

    // Parse should succeed despite the comment
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.name).toBe("Test Sequence");
    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("comment-test");
  });

  it("parses XML with extra comments injected inside elements", () => {
    const clip = makeClip({ clip_id: "inner-comment" });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Inject comments inside the sequence element (simulating Premiere additions)
    xml = xml.replace(
      "<media>",
      "<!-- Premiere Pro internal comment -->\n    <media>",
    );
    xml = xml.replace(
      "</track>",
      "<!-- track end marker -->\n        </track>",
    );

    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTracks[0]).toHaveLength(1);
    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("inner-comment");
  });

  it("handles processing instructions before the root element", () => {
    const clip = makeClip({ clip_id: "pi-test" });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([["AST_001", "/media/test.mov"]]);

    let xml = timelineToFcp7Xml(timeline, { sourceMap });

    // Add a processing instruction after DOCTYPE
    xml = xml.replace(
      "<!DOCTYPE xmeml>",
      '<!DOCTYPE xmeml>\n<?premiere version="24.0"?>',
    );

    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("pi-test");
  });

  it("self-roundtrip: export→import produces no diffs", () => {
    const clip1 = makeClip({
      clip_id: "rt-1",
      asset_id: "AST_RT1",
      timeline_in_frame: 0,
      timeline_duration_frames: 48,
    });
    const clip2 = makeClip({
      clip_id: "rt-2",
      asset_id: "AST_RT2",
      timeline_in_frame: 48,
      timeline_duration_frames: 72,
    });
    const audioClip = makeClip({
      clip_id: "rt-bgm",
      asset_id: "AST_BGM",
      role: "music",
      beat_id: "beat-bgm",
      audio_policy: { bgm_gain: -6 },
    });
    const timeline = makeTimeline([[clip1, clip2]], [[audioClip]]);
    const sourceMap = new Map([
      ["AST_RT1", "/media/a.mov"],
      ["AST_RT2", "/media/b.mov"],
      ["AST_BGM", "/media/bgm.wav"],
    ]);

    const xml = timelineToFcp7Xml(timeline, {
      sourceMap,
      projectId: "SMOKE_TEST",
      timelineVersion: "v2",
    });

    // The XML contains the metadata comment
    expect(xml).toContain("<!-- Video OS v2");

    const parsed = parseFcp7Sequence(xml);
    const report = detectDiffs(parsed, timeline);

    expect(report.diffs).toHaveLength(0);
    expect(report.mappedClips).toBe(3);
    expect(report.unmappedClips).toBe(0);
  });
});

// ── 9. Non-ASCII path + audio metadata fixture ──────────────────────

describe("non-ASCII path and audio metadata fixtures", () => {
  it("roundtrips CJK file paths with audio gain levels", () => {
    const videoClip = makeClip({
      clip_id: "cjk-video",
      asset_id: "AST_CJK_VID",
      motivation: "日本語テスト映像",
      timeline_in_frame: 0,
      timeline_duration_frames: 120,
    });
    const audioClip = makeClip({
      clip_id: "cjk-audio",
      asset_id: "AST_CJK_AUD",
      role: "music",
      motivation: "背景音楽",
      beat_id: "beat-bgm",
      audio_policy: { bgm_gain: -9 },
    });
    const timeline = makeTimeline([[videoClip]], [[audioClip]]);

    const sourceMap = new Map([
      ["AST_CJK_VID", "/プロジェクト/素材/インタビュー_2024年.mov"],
      ["AST_CJK_AUD", "/プロジェクト/音楽/ピアノ曲.wav"],
    ]);

    const xml = timelineToFcp7Xml(timeline, {
      sourceMap,
      sampleRate: 44100,
      audioBitDepth: 24,
    });

    // Pathurl should be percent-encoded
    expect(xml).not.toContain("/プロジェクト/");
    expect(xml).toContain("file://localhost/");

    // Audio metadata present
    expect(xml).toContain("<samplerate>44100</samplerate>");
    expect(xml).toContain("<depth>24</depth>");
    expect(xml).toContain("<effectid>audiolevels</effectid>");

    // Parse back
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("cjk-video");
    expect(parsed.videoTracks[0][0].videoOsMeta!.motivation).toBe(
      "日本語テスト映像",
    );

    expect(parsed.audioTracks[0][0].videoOsMeta!.clip_id).toBe("cjk-audio");
    expect(parsed.audioTracks[0][0].audioGainLinear).toBeCloseTo(0.354813, 3);

    // Full roundtrip to TimelineIR
    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    const importedVideo = imported.tracks.video[0].clips[0];
    expect(importedVideo.clip_id).toBe("cjk-video");
    expect(importedVideo.motivation).toBe("日本語テスト映像");

    const importedAudio = imported.tracks.audio[0].clips[0];
    expect(importedAudio.clip_id).toBe("cjk-audio");
    expect(importedAudio.audio_policy?.bgm_gain).toBeCloseTo(-9, 1);

    // No diffs
    const report = detectDiffs(parsed, timeline);
    expect(report.diffs).toHaveLength(0);
  });

  it("handles Korean and emoji in paths", () => {
    const clip = makeClip({
      clip_id: "emoji-path",
      asset_id: "AST_EMOJI",
    });
    const timeline = makeTimeline([[clip]]);
    const sourceMap = new Map([
      ["AST_EMOJI", "/미디어/촬영_🎬/clip.mov"],
    ]);

    const xml = timelineToFcp7Xml(timeline, { sourceMap });
    const parsed = parseFcp7Sequence(xml);

    expect(parsed.videoTracks[0][0].videoOsMeta!.clip_id).toBe("emoji-path");
    expect(parsed.videoTracks[0][0].pathurl).toBeTruthy();
  });

  it("preserves audio sample rate and bit depth in file definition", () => {
    const audioClip = makeClip({
      clip_id: "audio-hd",
      asset_id: "AST_AUDIO_HD",
      role: "music",
      beat_id: "beat-hd",
      audio_policy: { bgm_gain: -3 },
    });
    const timeline = makeTimeline([], [[audioClip]]);
    const sourceMap = new Map([
      ["AST_AUDIO_HD", "/media/studio_recording.wav"],
    ]);

    const xml = timelineToFcp7Xml(timeline, {
      sourceMap,
      sampleRate: 96000,
      audioBitDepth: 32,
    });

    expect(xml).toContain("<samplerate>96000</samplerate>");
    expect(xml).toContain("<depth>32</depth>");

    // Parse and roundtrip
    const parsed = parseFcp7Sequence(xml);
    expect(parsed.audioTracks[0][0].audioGainLinear).toBeCloseTo(0.70795, 3);

    const imported = parsedSequenceToTimelineIR(parsed, timeline);
    expect(imported.tracks.audio[0].clips[0].audio_policy?.bgm_gain).toBeCloseTo(
      -3,
      1,
    );
  });
});
