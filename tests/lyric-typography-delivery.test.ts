import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  defaultCaptionFinalizeStageRunner,
  runCaptionFinalize,
  type CaptionFinalizeStageContext,
} from "../runtime/caption/caption-finalize.js";
import {
  loadLyricLineInputs,
  parseLrcTimestampSeconds,
  writeLyricTypographyDeliveryArtifacts,
} from "../runtime/caption/lyric-delivery.js";
import { buildQaReport } from "../runtime/packaging/qa.js";
import { buildNleFinishingManifest, computeSha256 } from "../runtime/packaging/manifest.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import { buildExternalRenderRouteReceipt } from "../runtime/render/route-resolver.js";
import { approveFinalRenderChecklist } from "../runtime/packaging/final-render-approval.js";
import { writeValidFinalRenderReviewPack } from "./helpers/final-render-review.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  InvalidActiveDeliveryPointerError,
  resolveDeliveryArtifactPathsStrict,
  resolveLyricsAssPathStrict,
} from "../runtime/packaging/active-delivery.js";
import { buildFinalVisualCompositorArgs } from "../runtime/render/final-visual-compositor.js";
import { packageCommand, type PackageCommandOptions } from "../runtime/commands/package.js";
import { parseCaptionFinalizeArgs } from "../scripts/caption-finalize.js";

/** Precomputed QA fixture: fake final.mp4 is not a real video. */
const FIXTURE_METRICS = {
  videoDurationMs: 2_002,
  audioDurationMs: 2_002,
  integratedLufs: -17,
  truePeakDbtp: -2,
  videoFrame: {
    width: 1920, height: 1080,
    sar: null, dar: null,
    fps_num: 30000, fps_den: 1001, fps: 29.97,
  },
} as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Unit: LRC lyric script loading ───────────────────────────────────────

describe("lyric delivery LRC loading", () => {
  it("parses contiguous timing from LRC line timestamps", () => {
    const lines = loadLyricLineInputs([
      "[00:01.00]夜が降る",
      "[00:05.50]光の中へ",
      "[00:09]終わり",
    ].join("\n"), { tailSec: 3 });
    expect(lines).toEqual([
      { text: "夜が降る", startSec: 1, endSec: 5.5 },
      { text: "光の中へ", startSec: 5.5, endSec: 9 },
      { text: "終わり", startSec: 9, endSec: 12 },
    ]);
  });

  it("extends the previous slot for untagged lines and honors repeated tags", () => {
    const lines = loadLyricLineInputs([
      "[00:01.00]夜が\n降る",
      "[00:02.00][Aメロ]",
      "[00:02.50]光の中へ",
    ].join("\n"));
    expect(lines[0].text).toBe("夜が\n降る");
    expect(lines[0].endSec).toBe(2);
    // section tag line keeps its own slot; the engine drops it from cues
    expect(lines[1].startSec).toBe(2);
    expect(lines[1].endSec).toBe(2.5);
  });

  it("throws instead of inventing timing", () => {
    expect(() => loadLyricLineInputs("untimed line\nanother")).toThrow(/refusing to invent timing/);
    expect(() => loadLyricLineInputs("")).toThrow(/no timed lines/);
  });

  it("skips credits, directives, comments, and separators entirely", () => {
    const lines = loadLyricLineInputs([
      "Title: 夜旋律",
      "作詞：誰か",
      "BGM: intro only",
      "# encode note",
      "―――――",
      "[00:01.00]夜が降る",
      "// mixer note",
      "[00:05.00]光の中へ",
    ].join("\n"));
    expect(lines).toHaveLength(2);
    // credits/directives/comments/separators never open a timing slot
    expect(lines[0].startSec).toBe(1);
    expect(lines[1].startSec).toBe(5);
    // an untagged `//` comment rides along in the slot and is stripped by
    // the engine sanitizer (metadata can never render)
    expect(lines[0].text).toBe("夜が降る\n// mixer note");
  });

  it("clamps cues to the video duration", () => {
    const lines = loadLyricLineInputs([
      "[00:01.00]夜が降る",
      "[00:05.00]光の中へ",
      "[00:09.00]終わり",
    ].join("\n"), { videoDurationSec: 10 });
    expect(lines).toHaveLength(3);
    expect(lines[1].endSec).toBe(9);
    // the last tail is clamped so nothing renders past the video end
    expect(lines[2].endSec).toBe(10);
  });

  it("drops cues at or after the video end", () => {
    const lines = loadLyricLineInputs([
      "[00:01.00]夜が降る",
      "[00:15.00]映像の外",
    ].join("\n"), { videoDurationSec: 10 });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("夜が降る");
  });

  it("parses centisecond and millisecond LRC variants", () => {
    expect(parseLrcTimestampSeconds("[01:05.20]")).toBeCloseTo(65.2, 5);
    expect(parseLrcTimestampSeconds("[01:05.200]")).toBeCloseTo(65.2, 5);
    expect(parseLrcTimestampSeconds("[1:05]")).toBe(65);
  });
});

// ── Unit: fail-closed delivery writer ────────────────────────────────────

describe("lyric delivery writer", () => {
  it("refuses delivery when the plan has violations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyric-delivery-"));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "lyrics.lrc");
    // 34 unbreakable chars -> safe_width violation even at minimum tier sizes
    fs.writeFileSync(scriptPath, "[00:01.00]とても長い歌詞の行は二段組みでも入りきらないので正直に違反を報告する", "utf8");
    expect(() => writeLyricTypographyDeliveryArtifacts({ lyricScriptPath: scriptPath, outputDir: dir }))
      .toThrow(/unresolved violations/);
    expect(fs.existsSync(path.join(dir, "captions", "lyrics.ass"))).toBe(false);
  });
});

describe("lyric delivery CLI surface", () => {
  it("parses --lyric-script and forwards it to caption finalize options", () => {
    const args = parseCaptionFinalizeArgs([
      "node", "caption-finalize.ts", "run", "--project", "/tmp/project",
      "--lyric-script", "/tmp/project/01_intent/lyrics.lrc",
    ]);
    expect(args.lyricScriptPath).toBe("/tmp/project/01_intent/lyrics.lrc");
  });

  it("forwards explicit lyric options without introducing a second lyric script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyric-cli-options-"));
    tempDirs.push(dir);
    const sectionsPath = path.join(dir, "sections.json");
    writeJson(sectionsPath, [{ role: "chorus", startSec: 0, endSec: 2 }]);
    const args = parseCaptionFinalizeArgs([
      "node", "caption-finalize.ts", "run", "--project", "/tmp/project",
      "--lyric-reduced-motion",
      "--lyric-tail-sec", "3",
      "--lyric-max-per-char-sec", "0.2",
      "--lyric-max-hold-sec", "0.7",
      "--lyric-sections", sectionsPath,
    ]);
    expect(args.lyricScriptPath).toBeUndefined();
    expect(args.lyricOptions).toEqual({
      reducedMotion: true,
      tailSec: 3,
      staccato: { maxPerCharSec: 0.2, maxHoldSec: 0.7 },
      sections: [{ role: "chorus", startSec: 0, endSec: 2 }],
    });
  });
});

// ── End-to-end: caption-finalize writes lyric telops via the real pipeline ──

function writeFile(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}
function writeJson(filePath: string, value: unknown): void {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function writeYaml(filePath: string, value: unknown): void {
  writeFile(filePath, stringifyYaml(value));
}
function projectRelative(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}

function createLyricProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyric-finalize-"));
  tempDirs.push(projectDir);
  writeJson(path.join(projectDir, "05_timeline", "timeline.json"), {
    version: "1",
    project_id: "lyric-finalize-test",
    sequence: {
      name: "main", fps_num: 30_000, fps_den: 1_001, width: 1920, height: 1080, start_frame: 0,
    },
    tracks: { video: [], audio: [] },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
    },
  });
  writeYaml(path.join(projectDir, "01_intent", "creative_brief.yaml"), {
    version: "1",
    project_id: "lyric-finalize-test",
    autonomy: { mode: "collaborative", must_ask: ["publish"] },
  });
  writeYaml(path.join(projectDir, "04_plan", "edit_blueprint.yaml"), {
    caption_policy: { language: "ja", delivery_mode: "both", source: "transcript", styling_class: "clean-lower-third" },
  });
  writeYaml(path.join(projectDir, "06_review", "review_report.yaml"), {
    fatal_issues: [],
    visual_qa: {
      status: "verified", score: 90, min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 }, issue_summaries: [],
      deterministic_scan: {
        status: "verified", duration_sec: 10, width: 1920, height: 1080, issues: [],
      },
    },
  });
  writeYaml(path.join(projectDir, "project_state.yaml"), {
    version: 1,
    project_id: "lyric-finalize-test",
    current_state: "approved",
    gates: { review_gate: "open" },
    approval_record: { status: "clean", approved_by: "operator", approved_at: "2026-07-23T00:00:00Z" },
    handoff_resolution: {
      handoff_id: "HND_CAPTION_FINALIZE",
      status: "decided",
      source_of_truth_decision: "nle_finishing",
      decided_by: "operator",
      decided_at: "2026-07-23T00:00:00Z",
    },
  });
  writeJson(path.join(projectDir, "07_package", "caption_approval.json"), {
    version: "1",
    project_id: "lyric-finalize-test",
    base_timeline_version: "1",
    caption_policy: {
      language: "ja", delivery_mode: "both", source: "transcript", styling_class: "clean-lower-third",
    },
    speech_captions: [{
      caption_id: "SC_001",
      asset_id: "AST_001",
      segment_id: "SEG_001",
      timeline_in_frame: 0,
      timeline_duration_frames: 60,
      text: "最初の字幕",
      source: "authored",
      styling_class: "clean-lower-third",
      metrics: { cps: 5, dwell_ms: 2_002 },
    }],
    text_overlays: [],
    approval: {
      status: "approved", approved_by: "operator", approved_at: "2026-07-23T00:00:00Z",
    },
  });
  approveFinalRenderChecklist(projectDir, {
    approvedBy: "operator",
    approvedAt: "2026-07-23T00:00:00Z",
    checklist: {
      captions: "approved",
      caption_typography: "approved",
      section_titles: "not_applicable",
      visual_preview: writeValidFinalRenderReviewPack(projectDir),
      audio: {
        decision: "preserve",
        preview_reviewed: false,
        bgm: "none",
      },
      output_spec: "approved",
    },
  });
  return projectDir;
}

const LYRIC_SCRIPT = [
  "[00:01.00]// mixer note: check vocal level",
  "[00:01.00][Aメロ]",
  "[00:01.00]夜の靄が静かに降りてくる",
  "[00:05.00]長い歌詞の行は画面からはみ出すので二段へ",
  "[00:09.00][Chorus glow=amber]",
  "[00:10.00]（BGM）",
  "[00:10.00]光の中へ 君と走る",
  // timestamped metadata: sanitized AFTER timestamp removal -> Dialogue zero
  "[00:11.00]BGM: guitar dist",
  "[00:12.00]作詞：誰かさん",
  "[00:13.00]Title: 夜旋律",
  "[00:14.00][Punk]",
  "[00:14.00]右左橋坂息",
].join("\n");

/** Visible text of a Dialogue line with override blocks and metadata columns removed. */
function visibleDialogueText(dialogueLine: string): string {
  return dialogueLine.split(",").slice(9).join(",")
    .replace(/\{[^}]*\}/g, "")
    .split("\\N").join("\n");
}

/**
 * Stage exactly what packageCommand needs (final video, external route
 * receipt, QA, manifest) and then delegate to the REAL default stage runner,
 * so the lyric branch under test is the production code path.
 */
function stagingPlusDefaultStageRunner(): (context: CaptionFinalizeStageContext) => Promise<void> {
  return async (context) => {
    const finalPath = path.join(context.generationDir, "video", "final.mp4");
    writeFile(finalPath, `fixture-final:${context.approval.project_id}`);
    const timelinePath = path.join(context.projectDir, "05_timeline", "timeline.json");
    const handoffArtifact = { path: "handoff/nle-notes.md", sha256: `sha256:${"a".repeat(64)}` };
    const routeReceiptPath = path.join(context.generationDir, "logs", "render-route.json");
    writeJson(routeReceiptPath, buildExternalRenderRouteReceipt({
      version: "external-route-metadata/v1",
      project_id: context.approval.project_id,
      route_kind: "external_manual_nle",
      source_identity: {
        timeline: { path: timelinePath, sha256: computeSha256(timelinePath) },
        source_inputs_hash: computeSha256(timelinePath),
        source_assets: [],
      },
      output: { path: finalPath, sha256: computeSha256(finalPath) },
      geometry: { width: 1920, height: 1080, fps_num: 30, fps_den: 1001 },
      caption: {
        approval: { path: context.approvalIntentPath, sha256: computeSha256(context.approvalIntentPath) },
        approval_status: "approved",
        text_timing_hash: computeSha256(context.approvalIntentPath),
        burn_render_owner: "none",
        requested_animations: [],
        unsupported_animations: [],
        capability_status: "not_applicable",
        decision: "not_applicable",
      },
      required_handoff_artifacts: [handoffArtifact],
      handoff: {
        status: "confirmed",
        human_owner: "operator",
        human_approval_status: "approved",
        artifacts: [handoffArtifact],
      },
      agent_qa: { status: "passed" },
      human_approval: { status: "approved", owner: "operator" },
    }));
    const approvalHash = computeFileHash(context.approvalIntentPath);
    const qaPath = path.join(context.generationDir, "qa-report.json");
    writeJson(qaPath, buildQaReport(
      context.approval.project_id,
      "nle_finishing",
      [{ name: "caption_fixture_valid", passed: true, details: `approval=${approvalHash}` }],
      {},
      { final_video: projectRelative(context.projectDir, finalPath) },
    ));
    const manifest = buildNleFinishingManifest({
      projectId: context.approval.project_id,
      baseTimelineVersion: context.approval.base_timeline_version,
      editorialTimelineHash: computeFileHash(timelinePath),
      outputDir: context.generationDir,
      handoffId: "HND_CAPTION_FINALIZE",
      captionApprovalHash: approvalHash,
      captionPolicy: context.approval.caption_policy,
      finalVideoPath: finalPath,
      qaReportPath: qaPath,
      routeReceiptPath,
      sidecarPaths: [],
      createdAt: context.createdAt,
    });
    writeJson(path.join(context.generationDir, "package_manifest.json"), manifest);
    await defaultCaptionFinalizeStageRunner(context);
  };
}

describe("caption-finalize lyric typography delivery (end-to-end)", () => {
  it("writes schema-valid lyrics.ass telops through the default stage runner", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);

    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      // fixture final.mp4 is not a real video; skipRender + precomputed
      // metrics skip the ffprobe measurement of the staged fixture video
      packageOptions: {
        skipRender: true,
        precomputedMetrics: {
          videoDurationMs: 2_002,
          audioDurationMs: 2_002,
          integratedLufs: -17,
          truePeakDbtp: -2,
          videoFrame: {
            width: 1920, height: 1080,
            sar: null, dar: null,
            fps_num: 30000, fps_den: 1001, fps: 29.97,
          },
        },
      },
    }, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });

    // speech captions are unaffected
    expect(fs.readFileSync(path.join(result.generationDir, "captions", "speech.ass"), "utf8"))
      .toContain("最初の字幕");

    const assPath = path.join(result.generationDir, "captions", "lyrics.ass");
    const planPath = path.join(result.generationDir, "captions", "lyric-typography-plan.json");
    expect(fs.existsSync(assPath)).toBe(true);
    expect(fs.existsSync(planPath)).toBe(true);

    const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
    const validation = validateAgainstSchema(plan, "lyric-typography-plan.schema.json");
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(plan.version).toBe("lyric-typography-plan/v1");
    expect(plan.violations).toEqual([]);

    const ass = fs.readFileSync(assPath, "utf8");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    for (const style of ["LyricVerse", "LyricChorus", "LyricPunk"]) {
      expect(ass).toContain(`Style: ${style},`);
    }
    // every section switch appears as its own Dialogue style in real events
    const dialogueStyles = ass.split("\n")
      .filter((line) => line.startsWith("Dialogue:"))
      .map((line) => line.split(",")[3]);
    expect(dialogueStyles).toContain("LyricVerse");
    expect(dialogueStyles).toContain("LyricChorus");
    expect(dialogueStyles).toContain("LyricPunk");
    // chorus glow + bounce tags reach the render output
    const chorusDialogue = ass.split("\n").find((line) => line.includes("LyricChorus") && line.startsWith("Dialogue:"));
    expect(chorusDialogue).toContain("\\3c&H00BFFF&");
    expect(chorusDialogue).toContain("\\blur5");
    expect(chorusDialogue).toContain("\\t(0,120,");
    // staccato: one character per Dialogue at screen center
    const punkDialogues = ass.split("\n").filter((line) => line.split(",")[3] === "LyricPunk");
    expect(punkDialogues.map((line) => line.replace(/\{[^}]*\}/g, "").split(",").slice(9).join(",").trim()))
      .toEqual(["右", "左", "橋", "坂", "息"]);
    // metadata never reaches any Dialogue *text* (style names excluded):
    // timestamped BGM:/credits/Title lines are zero-Dialogue after sanitize
    const dialogueText = ass.split("\n")
      .filter((line) => line.startsWith("Dialogue:"))
      .map((line) => visibleDialogueText(line))
      .join("\n");
    expect(dialogueText).not.toMatch(/mixer note|BGM|Aメロ|Chorus glow|Punk|作詞|Title|guitar dist/);
    expect(dialogueText).not.toContain(":");
    // removed metadata is auditable in the plan
    const removed = (plan.removed_metadata as Array<{ reason: string }>).map((entry) => entry.reason).join("\n");
    expect(removed).toContain("mixer note");
    expect(removed).toContain("（BGM）");
    // safe-zone fit is recorded per cue
    for (const cue of plan.cues as Array<{ position: { within_safe_zone: boolean } }>) {
      expect(cue.position.within_safe_zone).toBe(true);
    }

    // ── receipt: lyric contract + hashed artifacts ──
    const receipt = result.receipt;
    expect(receipt.version).toBe("caption-finalize-receipt/v5");
    const routePath = path.join(result.generationDir, "logs", "render-route.json");
    const route = JSON.parse(fs.readFileSync(routePath, "utf8")) as {
      route_evidence: unknown;
    };
    expect(receipt.route_evidence).toEqual({
      route_kind: "external_manual_nle",
      render_route_receipt_sha256: computeSha256(routePath),
    });
    expect((route.route_evidence as unknown)).toEqual(
      (JSON.parse(fs.readFileSync(path.join(result.generationDir, "package_manifest.json"), "utf8")) as {
        provenance: { route_evidence: unknown };
      }).provenance.route_evidence,
    );
    expect(resolveDeliveryArtifactPathsStrict(projectDir).activeDelivery?.generation_id)
      .toBe(result.generationId);
    expect(receipt.lyric_contract).toMatchObject({
      reduced_motion: false,
      tail_sec: 4,
      max_per_char_sec: 0.5,
      max_hold_sec: 0.5,
    });
    expect(receipt.lyric_contract!.script_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.lyric_contract!.options_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const key of ["lyrics_ass", "lyric_plan", "lyric_script"] as const) {
      const artifactRecord = receipt.artifacts[key]!;
      const artifactFile = path.resolve(projectDir, artifactRecord.path);
      expect(fs.existsSync(artifactFile)).toBe(true);
      // the receipt hash covers the exact burn-ready ASS bytes
      expect(computeSha256(artifactFile)).toBe(artifactRecord.sha256);
    }
    // the lyric script content is in the generation identity
    expect(receipt.lyric_contract!.script_sha256).toBe(computeSha256(lyricScriptPath));

    // ── fontsdir binding: exact bound faces staged for libass ──
    const fontsDir = path.join(result.generationDir, "fonts");
    for (const face of receipt.lyric_contract!.faces) {
      if (!face.font_path) continue;
      const copies = fs.readdirSync(fontsDir).filter((name) => name.startsWith(`lyrics-${face.role}.`));
      expect(copies).toHaveLength(1);
      // the staged copy libass loads is byte-identical to the bound binary
      expect(computeSha256(path.join(fontsDir, copies[0]))).toBe(face.font_sha256);
    }

    // ── active delivery pointer: lyric artifacts verified ──
    const active = result.activeDelivery;
    expect(active.artifacts.lyrics_ass).toBeTruthy();
    expect(active.artifacts.lyric_plan).toBeTruthy();
    expect(active.artifacts.lyric_script).toBeTruthy();
    // resolveDeliveryArtifactPaths exposes the lyric ASS for the burn chain
    const deliveryPaths = resolveDeliveryArtifactPathsStrict(projectDir);
    expect(deliveryPaths.lyricsAssPath).toBeTruthy();
    expect(fs.readFileSync(deliveryPaths.lyricsAssPath!, "utf8")).toContain("LyricChorus");

    // schema-level mutual requirement: lyric_contract <=> the 3 artifacts
    const strippedContract = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete strippedContract.lyric_contract;
    expect(validateAgainstSchema(strippedContract, "caption-finalize-receipt.schema.json").valid).toBe(false);
    const strippedArtifact = structuredClone(receipt);
    delete (strippedArtifact.artifacts as Record<string, unknown>).lyrics_ass;
    expect(validateAgainstSchema(strippedArtifact, "caption-finalize-receipt.schema.json").valid).toBe(false);
    const strippedPointer = structuredClone(active);
    delete (strippedPointer.artifacts as Record<string, unknown>).lyric_plan;
    expect(validateAgainstSchema(strippedPointer, "active-delivery.schema.json").valid).toBe(false);
  });

  it("blocks reuse when lyrics change: stale script content yields a new generation", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const finalizeInput = {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    };
    const first = await runCaptionFinalize(projectDir, finalizeInput, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });
    expect(first.reused).toBe(false);

    // identical input: reuse
    const second = await runCaptionFinalize(projectDir, finalizeInput, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });
    expect(second.reused).toBe(true);
    expect(second.generationId).toBe(first.generationId);

    // edited lyric content: the generation key changes -> no reuse, re-plan
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT.replace("夜の靄が静かに降りてくる", "夜の靄がひらひら降りてくる")}\n`);
    const third = await runCaptionFinalize(projectDir, finalizeInput, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });
    expect(third.reused).toBe(false);
    expect(third.generationId).not.toBe(first.generationId);
    const thirdAss = fs.readFileSync(path.join(third.generationDir, "captions", "lyrics.ass"), "utf8");
    expect(thirdAss).toContain("ひらひら");
    // the lyric contract hash covers the NEW script bytes
    expect(third.receipt.lyric_contract!.script_sha256).toBe(computeSha256(lyricScriptPath));

    // changed options (reduced motion) also change the identity
    const fourth = await runCaptionFinalize(projectDir, {
      ...finalizeInput,
      lyricOptions: { reducedMotion: true },
    }, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });
    expect(fourth.reused).toBe(false);
    expect(fourth.generationId).not.toBe(third.generationId);
    expect(fourth.receipt.lyric_contract).toMatchObject({ reduced_motion: true });
    // reduced motion collapses staccato to one static Dialogue
    const punkEvents = fs.readFileSync(path.join(fourth.generationDir, "captions", "lyrics.ass"), "utf8")
      .split("\n").filter((line) => line.split(",")[3] === "LyricPunk");
    expect(punkEvents).toHaveLength(1);
    expect(punkEvents[0]).not.toContain("\\t(");
  });

  it("does not reuse a generation whose staged lyric face copy changed", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const input = {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    };
    const first = await runCaptionFinalize(projectDir, input, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });
    fs.rmSync(path.join(projectDir, "07_package", "active_delivery.json"));
    const stagedFace = fs.readdirSync(path.join(first.generationDir, "fonts"))
      .find((name) => name.startsWith("lyrics-verse."));
    expect(stagedFace).toBeTruthy();
    fs.appendFileSync(path.join(first.generationDir, "fonts", stagedFace!), "tampered");

    const rebuilt = await runCaptionFinalize(projectDir, input, {
      stageRunner: stagingPlusDefaultStageRunner(),
    });
    expect(rebuilt.reused).toBe(false);
    expect(computeSha256(path.join(rebuilt.generationDir, "fonts", stagedFace!)))
      .toBe(rebuilt.receipt.lyric_contract!.faces.find((face) => face.role === "verse")!.font_sha256);
  });

  it("absent lyrics never reuse a lyric generation (and vice versa)", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const withLyrics = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    // a caller without a lyric script gets a DIFFERENT generation identity
    const withoutLyrics = await runCaptionFinalize(projectDir, {
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    expect(withoutLyrics.generationId).not.toBe(withLyrics.generationId);
    expect(withoutLyrics.receipt.lyric_contract).toBeUndefined();
    expect(withoutLyrics.activeDelivery.artifacts.lyrics_ass).toBeUndefined();
  });

  it("burns lyric ASS in the same encode as speech captions", async () => {
    // burn-chain counterexample: the compositor must chain BOTH subtitle
    // filters in one filter graph (one lossy encode), not a second pass.
    const args = buildFinalVisualCompositorArgs({
      baseVideoPath: "/tmp/base.mp4",
      layers: [],
      assPath: "/tmp/g/speech.ass",
      extraAssPath: "/tmp/g/lyrics.ass",
      fontsDir: "/tmp/fonts",
      outputPath: "/tmp/out.mp4",
      width: 1080,
      height: 1920,
      fpsNum: 30,
      fpsDen: 1,
    });
    const filterGraph = args[args.indexOf("-filter_complex") + 1];
    expect(filterGraph).toContain("subtitles=filename='/tmp/g/speech.ass'");
    expect(filterGraph).toContain("subtitles=filename='/tmp/g/lyrics.ass'");
    // chained: lyrics stage reads the captioned stream
    expect(filterGraph.indexOf("lyrics.ass")).toBeGreaterThan(filterGraph.indexOf("speech.ass"));
    expect(filterGraph).toContain("[captioned]subtitles=");
    expect(filterGraph).toMatch(/\[captioned\]subtitles=[^\[]*\[lyriced\]/);
    // exactly one output encode
    expect(filterGraph).toContain("[lyriced]format=yuv420p[v]");
  });

  it("aborts finalize when the lyric script cannot be planned", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    // untimed script -> loadLyricLineInputs throws -> finalize fails closed
    writeFile(lyricScriptPath, "タイムスタンプのない歌詞\n");

    await expect(runCaptionFinalize(projectDir, { lyricScriptPath }, {
      stageRunner: stagingPlusDefaultStageRunner(),
    })).rejects.toThrow(/refusing to invent timing/);
  });
});

describe("lyric delivery adversarial: tampered/missing artifacts and stale reuse", () => {
  it("FAILS CLOSED when the active generation's lyrics.ass is tampered", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    // flip one byte of the burned ASS behind the pointer's back
    const lyricsAss = path.join(result.generationDir, "captions", "lyrics.ass");
    fs.writeFileSync(lyricsAss, fs.readFileSync(lyricsAss, "utf8").replace("PlayResX", "PlayReSX"), "utf8");

    expect(() => resolveLyricsAssPathStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
    // and the burn chain refuses the poisoned path
    await expect(runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() })).rejects.toThrow(/refuses to replace generation/);
  });

  it("rejects a self-rehashed pointer carrying FORGED_UNAPPROVED_TEXT", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    const lyricsAssPath = path.join(result.generationDir, "captions", "lyrics.ass");
    expect(result.receipt.artifacts.lyrics_ass?.sha256).toBe(computeSha256(lyricsAssPath));
    fs.appendFileSync(lyricsAssPath, "FORGED_UNAPPROVED_TEXT\n", "utf8");
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as {
      artifacts: { lyrics_ass: { sha256: string } };
    };
    // The attacker updates only the mutable pointer-side ASS hash. The
    // caption-finalize receipt retains the canonical approved hash.
    pointer.artifacts.lyrics_ass.sha256 = computeSha256(lyricsAssPath);
    writeJson(pointerPath, pointer);

    expect(() => resolveLyricsAssPathStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("FAILS CLOSED when the active generation's lyric artifacts are deleted", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    fs.rmSync(path.join(result.generationDir, "captions", "lyrics.ass"));
    expect(() => resolveLyricsAssPathStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("rejects stale reuse: a tampered generation is never re-served", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const first = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    // tamper the shipped script copy: hash != receipt artifact -> the
    // completed generation is invalid and (being active) cannot be replaced
    const scriptCopy = path.join(first.generationDir, "captions", "lyrics.lrc");
    fs.writeFileSync(scriptCopy, `${LYRIC_SCRIPT}\n[00:59.00] tampered extra line\n`);

    await expect(runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() })).rejects.toThrow(/refuses to replace generation/);
  });

  it("FAILS CLOSED on a hash-self-consistent pointer bound to a stale timeline", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    // the timeline changes AFTER the generation completed
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    timeline.sequence.name = "retimed";
    writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);

    // even a fully self-consistent pointer (all internal hashes valid) must
    // be rejected against the CURRENT timeline
    expect(() => resolveLyricsAssPathStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("FAILS CLOSED on a foreign project_id binding", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");

    // foreign identity: rebrand the project and the derived binding rejects
    const statePath = path.join(projectDir, "project_state.yaml");
    writeFile(statePath, fs.readFileSync(statePath, "utf8").replace("lyric-finalize-test", "some-other-project"));
    expect(() => resolveLyricsAssPathStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("FAILS CLOSED when the referenced receipt is arbitrary text", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");

    // swap the receipt for arbitrary text; the pointer entry still hashes it
    const receiptPath = path.join(result.generationDir, "caption-finalize-receipt.json");
    writeFile(receiptPath, "totally not a receipt");
    const pointer = JSON.parse(fs.readFileSync(path.join(projectDir, "07_package", "active_delivery.json"), "utf8"));
    pointer.artifacts.receipt.sha256 = computeSha256(receiptPath); // self-rehashed
    writeFile(path.join(projectDir, "07_package", "active_delivery.json"), `${JSON.stringify(pointer, null, 2)}\n`);

    expect(() => resolveLyricsAssPathStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("strict authority: full-input mutation matrix rejects every tampered source", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const strict = (): unknown => resolveDeliveryArtifactPathsStrict(projectDir);

    // baseline: the untouched generation passes
    expect(strict()).toBeTruthy();

    // 1) lyric input bytes: mutate the shipped script copy
    const scriptCopy = path.join(result.generationDir, "captions", "lyrics.lrc");
    writeFile(scriptCopy, `${LYRIC_SCRIPT}\n[00:59.00] tampered\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
    writeFile(scriptCopy, `${LYRIC_SCRIPT}\n`);

    // 2) staged font binary: flip bytes of the staged bold face
    const fontsDir = path.join(result.generationDir, "fonts");
    const boldFace = fs.readdirSync(fontsDir).find((name) => name.startsWith("Noto") && name.includes("Bold"));
    if (boldFace) {
      const facePath = path.join(fontsDir, boldFace);
      const bytes = fs.readFileSync(facePath);
      bytes[bytes.length - 1] ^= 0xff;
      fs.writeFileSync(facePath, bytes);
      expect(strict).toThrow(/staged font bytes differ|does not match the current canonical state/);
      fs.copyFileSync(result.receipt.artifacts.font_ass_bold
        ? path.resolve(projectDir, result.receipt.artifacts.font_ass_bold.path)
        : facePath, facePath);
    }

    // 3) music cues: create the canonical file after finalize
    writeFile(path.join(projectDir, "07_package", "music_cues.json"), `${JSON.stringify({ cues: [] }, null, 2)}\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
    fs.rmSync(path.join(projectDir, "07_package", "music_cues.json"));

    // 4) final render approval: touch the canonical FR approval
    const frPath = path.join(projectDir, "06_review", "final-render-approval.json");
    const fr = JSON.parse(fs.readFileSync(frPath, "utf8"));
    fr.approved_at = "2031-01-01T00:00:00Z";
    writeFile(frPath, `${JSON.stringify(fr, null, 2)}\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("strict authority: a copied generation directory under a foreign id fails", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    // copy the generation to a sibling with a forged id and re-point the
    // pointer there with consistent hashes: the key-derived identifier
    // cannot match, so the copied directory is rejected
    const forgedId = "a".repeat(24);
    const copiedDir = path.join(path.dirname(result.generationDir), forgedId);
    fs.cpSync(result.generationDir, copiedDir, { recursive: true });
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    pointer.generation_id = forgedId;
    pointer.generation_path = `07_package/caption-finalize/generations/${forgedId}`;
    for (const [key, artifact] of Object.entries(pointer.artifacts as Record<string, { path: string; sha256: string }>)) {
      const originalPath = path.resolve(projectDir, artifact.path);
      const newPath = originalPath.replace(result.generationId, forgedId);
      artifact.path = path.relative(projectDir, newPath);
      artifact.sha256 = computeSha256(newPath);
      void key;
    }
    writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    expect(() => resolveDeliveryArtifactPathsStrict(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("deferActivation must not bypass lyric consumption rules", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    // a finalize-owned package run consuming a FOREIGN lyric ASS is rejected
    await expect(packageCommand(projectDir, {
      skipRender: true,
      precomputedMetrics: FIXTURE_METRICS,
      lyricsAssPath: "/tmp/evil-lyrics.ass",
    } as PackageCommandOptions)).rejects.toThrow(/not a public option/);
  });

  it("valid controls: present and absent deliveries both pass the strict authority", async () => {
    const presentProject = createLyricProject();
    const lyricScriptPath = path.join(presentProject, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(presentProject, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    expect(resolveDeliveryArtifactPathsStrict(presentProject).lyricsAssPath).toBeTruthy();

    const absentProject = createLyricProject();
    await runCaptionFinalize(absentProject, {
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const absent = resolveDeliveryArtifactPathsStrict(absentProject);
    expect(absent.lyricsAssPath).toBeUndefined();
    expect(absent.activeDelivery?.lyric_delivery).toBe("absent");
  });

  it("AJV + runtime matrix: valid present/absent and both inversions, both schemas", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const receipt = structuredClone(result.receipt) as unknown as Record<string, unknown>;
    const pointer = structuredClone(result.activeDelivery) as unknown as Record<string, unknown>;
    const receiptSchema = "caption-finalize-receipt.schema.json";
    const pointerSchema = "active-delivery.schema.json";

    // valid controls
    expect(validateAgainstSchema(receipt, receiptSchema).valid).toBe(true);
    expect(validateAgainstSchema(pointer, pointerSchema).valid).toBe(true);

    // inversion 1: absent mode carrying the contract / lyric artifacts
    const absentWithContract = structuredClone(receipt);
    absentWithContract.lyric_delivery = "absent";
    expect(validateAgainstSchema(absentWithContract, receiptSchema).valid, "receipt absent+contract").toBe(false);
    const absentWithArtifacts = structuredClone(pointer);
    absentWithArtifacts.lyric_delivery = "absent";
    expect(validateAgainstSchema(absentWithArtifacts, pointerSchema).valid, "pointer absent+artifacts").toBe(false);

    // inversion 2: present mode missing the contract or any artifact
    const presentNoContract = structuredClone(receipt);
    delete presentNoContract.lyric_contract;
    expect(validateAgainstSchema(presentNoContract, receiptSchema).valid, "receipt present-no-contract").toBe(false);
    const pointerPresentNoContract = structuredClone(pointer);
    delete pointerPresentNoContract.lyric_contract;
    expect(validateAgainstSchema(pointerPresentNoContract, pointerSchema).valid, "pointer present-no-contract").toBe(false);
    for (const artifactKey of ["lyrics_ass", "lyric_plan", "lyric_script"]) {
      const stripped = structuredClone(receipt);
      delete (stripped.artifacts as Record<string, unknown>)[artifactKey];
      expect(validateAgainstSchema(stripped, receiptSchema).valid, `receipt present-no-${artifactKey}`).toBe(false);
      const strippedPointer = structuredClone(pointer);
      delete (strippedPointer.artifacts as Record<string, unknown>)[artifactKey];
      expect(validateAgainstSchema(strippedPointer, pointerSchema).valid, `pointer present-no-${artifactKey}`).toBe(false);
    }
  });

  it("runtime pre-resolution: an inverted pointer fails with ZERO filesystem side effects", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });

    const snapshot = (): string[] => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(`${path.relative(projectDir, full)}:${computeSha256(full)}`);
        }
      };
      walk(projectDir);
      return files.sort();
    };
    // self-rehashed inverted pointer: hashes stay consistent, mode inverted
    // (this mutation is TEST SETUP, not an authority side effect)
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    pointer.lyric_delivery = "absent";
    delete pointer.lyric_contract;
    writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    const before = snapshot();

    expect(() => resolveDeliveryArtifactPathsStrict(projectDir))
      .toThrow(InvalidActiveDeliveryPointerError);
    // zero side effects: the tree is byte-identical after the rejection
    expect(snapshot()).toEqual(before);
  });

  it("full recomputation: missing key input, canonical lyric mutation, option forgery all fail", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    const receiptPath = path.resolve(projectDir, (result.activeDelivery.artifacts.receipt as { path: string }).path);
    const strict = (): unknown => resolveDeliveryArtifactPathsStrict(projectDir);

    // 1) missing key input: strip lyric_input from the persisted evidence
    const stripInput = (mutate: (receipt: Record<string, unknown>) => void): void => {
      const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      mutate(receipt);
      pointer.inputs.generation_key = receipt.generation_key;
      writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      (pointer.artifacts.receipt as { sha256: string }).sha256 = computeSha256(receiptPath);
      writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    };
    stripInput((receipt) => { delete (receipt.generation_key_inputs as Record<string, unknown>).lyric_input; });
    try {
      strict();
      throw new Error("expected strict to throw");
    } catch (error) {
      // surface the exact rejection reason in the assertion below
      expect((error as Error).message).toMatch(/mandatory field set/);
    }

    // 2) canonical lyric mutation: 01_intent/lyrics.lrc is the authority
    writeFile(path.join(projectDir, "01_intent", "lyrics.lrc"), `${LYRIC_SCRIPT}\n[00:59.00] mutated\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    fs.copyFileSync(lyricScriptPath, path.join(projectDir, "01_intent", "lyrics.lrc"));

    // 3) stale ASS/plan/script with a forged new-option key: the canonical
    // request file is the options authority, so the forgery cannot pass
    stripInput((receipt) => {
      const contract = receipt.lyric_contract as Record<string, unknown>;
      contract.options_digest = "sha256:" + "b".repeat(64);
      const inputs = receipt.generation_key_inputs as Record<string, unknown>;
      inputs.lyric_input = "sha256:" + "c".repeat(64);
      receipt.generation_key = "sha256:" + "d".repeat(64);
    });
    const pointer3 = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    pointer3.inputs.generation_key = "sha256:" + "d".repeat(64);
    writeFile(pointerPath, `${JSON.stringify(pointer3, null, 2)}\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("public surface contract: no internal-authority exports, fixed arities", async () => {
    const pkg = await import("../runtime/commands/package.js");
    // the internal-authority surface is gone entirely
    expect("createFreshGenerationCapability" in pkg).toBe(false);
    expect("FreshGenerationCapability" in pkg).toBe(false);
    expect(pkg.packageCommand).toBeTypeOf("function");
    expect(pkg.packageCommand.length).toBe(2);
    expect(pkg.packageCaptionFinalizeGeneration).toBeTypeOf("function");
    expect(pkg.packageCaptionFinalizeGeneration.length).toBe(2);
    // extra JS arguments cannot smuggle authority: the third argument is ignored
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const forgedCapability = { brand: Symbol("x"), projectDir: "/tmp", generationDir: "/tmp/g" };
    const forgedOptions = { lyricsAssPath: "/tmp/evil.ass", deferActivation: true, skipRender: true };
    await expect(
      (pkg.packageCommand as (a: string, b?: unknown, c?: unknown) => Promise<unknown>)(projectDir, forgedOptions, forgedCapability),
    ).rejects.toThrow(/not a public option/);
  });

  it("zero side effects: packageCommand with an inverted pointer leaves the tree byte-identical", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const snapshot = (): string[] => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(`${path.relative(projectDir, full)}:${computeSha256(full)}`);
        }
      };
      walk(projectDir);
      return files.sort();
    };
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    pointer.lyric_delivery = "absent";
    delete pointer.lyric_contract;
    writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    const before = snapshot();
    await expect(packageCommand(projectDir, {
      skipRender: true,
      precomputedMetrics: FIXTURE_METRICS,
    })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("downgrade prevention: a rehashed v4 receipt cannot open delivery", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const receiptPath = path.resolve(projectDir, (result.activeDelivery.artifacts.receipt as { path: string }).path);
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    // downgrade the receipt to v4 and rehash pointer + receipt entry
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.version = "caption-finalize-receipt/v4";
    writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    (pointer.artifacts.receipt as { sha256: string }).sha256 = computeSha256(receiptPath);
    writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    expect(() => resolveDeliveryArtifactPathsStrict(projectDir)).toThrow(/legacy receipt/);
  });

  it("lyric contract mirror: pointer/receipt divergence fails before path access", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const result = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const pointerPath = path.join(projectDir, "07_package", "active_delivery.json");
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    (pointer.lyric_contract as { tail_sec: number }).tail_sec = 9;
    writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    expect(() => resolveDeliveryArtifactPathsStrict(projectDir)).toThrow(/lyric contract mirror mismatch/);
  });

  it("canonical authority: policy, patch, and approval changes reject the pointer", async () => {
    const projectDir = createLyricProject();
    const lyricScriptPath = path.join(projectDir, "01_intent", "lyrics.lrc");
    writeFile(lyricScriptPath, `${LYRIC_SCRIPT}\n`);
    const finalizeResult = await runCaptionFinalize(projectDir, {
      lyricScriptPath,
      packageOptions: { skipRender: true, precomputedMetrics: FIXTURE_METRICS },
    }, { stageRunner: stagingPlusDefaultStageRunner() });
    const strict = (): unknown => resolveDeliveryArtifactPathsStrict(projectDir);
    expect(strict()).toBeTruthy();

    // typography policy appears after finalize -> key input changes
    writeFile(path.join(projectDir, "04_plan", "typography_policy.json"), `${JSON.stringify({ version: "1" }, null, 2)}\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
    fs.rmSync(path.join(projectDir, "04_plan", "typography_policy.json"));

    // visual-treatment patch appears after finalize -> key input changes
    writeFile(path.join(projectDir, "04_plan", "visual-treatment-patch.json"), `${JSON.stringify({ version: "1" }, null, 2)}\n`);
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
    fs.rmSync(path.join(projectDir, "04_plan", "visual-treatment-patch.json"));

    // mixed mode: route receipt claims supplied_final without supplied evidence
    const routePath = path.join(projectDir, "07_package", "caption-finalize", "generations", finalizeResult.generationId, "logs", "render-route.json");
    const route = JSON.parse(fs.readFileSync(routePath, "utf8"));
    route.route_evidence.route_kind = "supplied_final";
    writeFile(routePath, `${JSON.stringify(route, null, 2)}\n`);
    // supplied_final route claimed without staged supplied-final evidence
    expect(strict).toThrow(InvalidActiveDeliveryPointerError);
  });

  it("no pointer: the strict resolver is undefined, not an error", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lyric-no-pointer-"));
    tempDirs.push(empty);
    expect(resolveLyricsAssPathStrict(empty)).toBeUndefined();
    // a caller can no longer weaken the binding: no options exist
    expect(resolveLyricsAssPathStrict.length).toBe(1);
  });
});
