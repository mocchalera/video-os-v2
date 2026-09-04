import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import type {
  VlmCallOptions,
  VlmFn,
  VlmResponseDiagnostic,
} from "../runtime/connectors/gemini-vlm.js";
import { discoverRequestedSources } from "../runtime/media/source-discovery.js";
import { runTriage, type TriageAgent } from "../runtime/commands/triage.js";
import { runStatus } from "../runtime/commands/status.js";
import { runPipeline } from "../runtime/pipeline/ingest.js";
import { readProjectState, writeProjectState as persistProjectState } from "../runtime/state/reconcile.js";
import { readValidatedStillImageFrames } from "../runtime/artifacts/still-image-grounding.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROJECT_ID = "issue-40-close-readiness";
const NESTED_CONFIDENCE_PATHS = [
  "editorial_observation.confidence.tags",
  "editorial_observation.confidence.motion",
  "editorial_observation.confidence.framing",
  "editorial_observation.confidence.direction",
  "editorial_observation.confidence.appearance",
  "editorial_observation.confidence.text",
];
const tempDirs: string[] = [];

interface ProviderCall {
  framePaths: string[];
  prompt: string;
  maxOutputTokens: number;
  responseSchema: string;
}

interface Issue40Fixture {
  projectDir: string;
  sourceDir: string;
  sourceFiles: string[];
}

type FixtureResponseMode = "truncate_then_repair" | "invalid_after_repair";

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-issue40-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

function createFixture(label: string): Issue40Fixture {
  const sourceDir = tempDir(`${label}-sources`);
  const projectDir = tempDir(`${label}-project`);
  const colors = ["red", "green", "blue", "yellow", "magenta", "cyan"];
  const sourceFiles = colors.map((color, index) => {
    const source = path.join(
      sourceDir,
      `still-${String(index + 1).padStart(2, "0")}-${color}.png`,
    );
    ffmpeg([
      "-f", "lavfi",
      "-i", `testsrc2=s=160x90, hue=h=${index * 45}`,
      "-frames:v", "1",
      source,
    ]);
    // Keep the input set visibly six-still and content-distinct in logs and
    // source identity, while the image itself remains a deterministic fixture.
    return source;
  });

  fs.mkdirSync(path.join(projectDir, "01_intent"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "01_intent/creative_brief.yaml"),
    stringifyYaml({
      version: "1",
      project_id: PROJECT_ID,
      created_at: "2026-08-31T00:00:00Z",
      project: {
        id: PROJECT_ID,
        title: "Issue 40 close-readiness fixture",
        strategy: "deterministic grounded stills",
        runtime_target_sec: 6,
      },
      message: { primary: "A grounded still remains attributable through triage." },
      audience: { primary: "Fixture verifier" },
      emotion_curve: ["observe", "repair", "ready"],
      must_have: ["issue 40 still"],
      must_avoid: ["ungrounded claim"],
      autonomy: { mode: "full", may_decide: ["candidate order"], must_ask: [] },
      resolved_assumptions: ["All six inputs are deterministic still images."],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(projectDir, "01_intent/unresolved_blockers.yaml"),
    stringifyYaml({ version: "1", project_id: PROJECT_ID, blockers: [] }),
    "utf8",
  );
  persistProjectState(projectDir, {
    version: 1,
    project_id: PROJECT_ID,
    current_state: "intent_locked",
    history: [],
  });

  return { projectDir, sourceDir, sourceFiles };
}

function canonicalResponse(missingNestedConfidence = false): Record<string, unknown> {
  const response: Record<string, unknown> = {
    summary: "Issue 40 still fixture with a deterministic visible composition.",
    tags: ["issue_40_still", "deterministic_fixture"],
    interest_points: [{ frame_us: 0, label: "fixture frame", confidence: 0.9 }],
    quality_flags: [],
    confidence: { summary: 0.9, tags: 0.9, quality_flags: 0.9 },
    editorial_observation: {
      visual_tags: ["issue_40_still"],
      motion_type: "static",
      camera_motion_direction: "not_applicable",
      subject_motion_direction: "not_applicable",
      shot_scale: "wide",
      composition_anchor: "center",
      screen_side: "center",
      gaze_direction: "not_applicable",
      camera_axis: "not_applicable",
      dominant_subject_type: "object",
      dominant_colors: ["blue"],
      text_presence: "absent",
      confidence: {
        tags: 0.9,
        motion: 0.9,
        framing: 0.9,
        direction: 0.9,
        appearance: 0.9,
        text: 0.9,
      },
    },
  };
  if (missingNestedConfidence) {
    delete (response.editorial_observation as Record<string, unknown>).confidence;
  }
  return response;
}

function responseDiagnostic(
  finishReason: "MAX_TOKENS" | "STOP",
  outputTokenCap: number,
): VlmResponseDiagnostic {
  return {
    candidate_count: 1,
    finish_reason: finishReason,
    block_reason: null,
    blocked: false,
    candidates_token_count: null,
    thoughts_token_count: null,
    output_token_cap: outputTokenCap,
    text_bytes: null,
    text_sha256_16: "0".repeat(16),
    part_count: 1,
    text_part_count: 1,
    first_part_kind: "text",
    has_open_brace: true,
    ends_with_close_brace: finishReason === "STOP",
    truncation_reason: finishReason === "MAX_TOKENS" ? "max_tokens" : null,
  };
}

function makeFixtureVlm(mode: FixtureResponseMode, calls: ProviderCall[]): VlmFn {
  const attemptsByFrame = new Map<string, number>();
  return async (framePaths: string[], prompt: string, options: VlmCallOptions) => {
    const frameKey = framePaths.join("\n");
    const attempt = attemptsByFrame.get(frameKey) ?? 0;
    attemptsByFrame.set(frameKey, attempt + 1);
    calls.push({
      framePaths: [...framePaths],
      prompt,
      maxOutputTokens: options.maxOutputTokens,
      responseSchema: JSON.stringify(options.responseSchema ?? null),
    });

    if (mode === "truncate_then_repair" && attempt === 0) {
      return {
        rawJson: '{"summary":"provider output cut at the token boundary"',
        response_diagnostic: responseDiagnostic("MAX_TOKENS", options.maxOutputTokens),
      };
    }

    return {
      rawJson: JSON.stringify(canonicalResponse(mode === "invalid_after_repair")),
      response_diagnostic: responseDiagnostic("STOP", options.maxOutputTokens),
    };
  };
}

async function runFixtureAnalysis(
  fixture: Issue40Fixture,
  mode: FixtureResponseMode,
): Promise<{ result: Awaited<ReturnType<typeof runPipeline>>; calls: ProviderCall[] }> {
  const calls: ProviderCall[] = [];
  const result = await runPipeline({
    sourceFiles: fixture.sourceFiles,
    sourceDiscovery: discoverRequestedSources(fixture.sourceFiles),
    projectDir: fixture.projectDir,
    projectId: PROJECT_ID,
    repoRoot: REPO_ROOT,
    vlmFn: makeFixtureVlm(mode, calls),
    // These optional lanes are outside Issue #40. The VLM path still uses the
    // repository's default policy and its real still normalization/grounding.
    skipStt: true,
    skipMarlin: true,
    skipAppraiser: true,
    skipPeak: true,
    skipBgmAnalysis: true,
  });
  return { result, calls };
}

function makeTriageAgent(projectDir: string, observed: { runs: number; gate?: string }): TriageAgent {
  return {
    async run(ctx) {
      observed.runs += 1;
      observed.gate = ctx.analysisGate;
      const segments = JSON.parse(
        fs.readFileSync(path.join(projectDir, "03_analysis/segments.json"), "utf8"),
      ) as { items: Array<{ segment_id: string; asset_id: string; src_in_us: number; src_out_us: number }> };
      return {
        confirmed: true,
        selects: {
          version: "1",
          project_id: ctx.projectId,
          candidates: segments.items.map((segment, index) => ({
            candidate_id: `C_ISSUE40_${index + 1}`,
            segment_id: segment.segment_id,
            asset_id: segment.asset_id,
            src_in_us: segment.src_in_us,
            src_out_us: segment.src_out_us,
            role: index === 0 ? "hero" : "support",
            why_it_matches: "issue 40 still fixture is grounded and attributable",
            risks: [],
            confidence: 0.9,
            media_kind: "image",
            source_capabilities: { has_video: true, has_audio: false },
            still_image: { hold_duration_sec: 1 },
            evidence: ["issue 40 still"],
          })),
        },
      };
    },
  };
}

function readSegments(projectDir: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(projectDir, "03_analysis/segments.json"), "utf8"),
  ) as { items?: unknown[] };
  return (parsed.items ?? []).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function readAssets(projectDir: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(projectDir, "03_analysis/assets.json"), "utf8"),
  ) as { items?: unknown[] };
  return (parsed.items ?? []).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function readProvenance(segment: Record<string, unknown>): Record<string, unknown> {
  return ((segment.provenance as Record<string, unknown> | undefined)?.tags ?? {}) as Record<string, unknown>;
}

describe("Issue #40 close-readiness milestone", () => {
  it("routes the same six stills through default grounding, bounded repair, and Gate 4", async () => {
    const fixture = createFixture("happy");
    const { result, calls } = await runFixtureAnalysis(fixture, "truncate_then_repair");
    const assets = readAssets(fixture.projectDir);
    const segments = readSegments(fixture.projectDir);

    expect(fixture.sourceFiles).toHaveLength(6);
    expect(assets).toHaveLength(6);
    expect(segments).toHaveLength(6);
    expect(result.sourceLedger?.summary).toEqual({ requested: 6, ready: 6, unsupported: 0, failed: 0 });
    expect(result.analysisCoverageReport?.summary.status).toBe("ready");
    expect(result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "vlm_tags"))
      .toMatchObject({ status: "ready", asset_ids: expect.arrayContaining(assets.map((asset) => asset.asset_id)) });

    const frameMap = readValidatedStillImageFrames(fixture.projectDir);
    expect(frameMap.size).toBe(6);
    expect(calls).toHaveLength(12);
    expect(new Set(calls.map((call) => call.maxOutputTokens))).toHaveLength(1);
    expect(calls[0].maxOutputTokens).toBeGreaterThan(256);
    expect(new Set(calls.map((call) => call.responseSchema))).toHaveLength(1);

    const callsByFrame = new Map<string, ProviderCall[]>();
    for (const call of calls) {
      const key = call.framePaths.join("\n");
      const existing = callsByFrame.get(key) ?? [];
      existing.push(call);
      callsByFrame.set(key, existing);
    }
    expect(callsByFrame).toHaveLength(6);
    for (const frameCalls of callsByFrame.values()) {
      expect(frameCalls).toHaveLength(2);
      expect(frameCalls[0].framePaths).toEqual(frameCalls[1].framePaths);
      expect(frameCalls[1].prompt).toContain("Return ONLY a JSON object satisfying the canonical response contract");
      for (const requiredPath of NESTED_CONFIDENCE_PATHS) {
        expect(frameCalls[1].prompt).toContain(requiredPath);
      }
      expect(frameCalls[1].prompt).not.toContain("provider output cut");
    }

    for (const asset of assets) {
      const still = asset.still_image as Record<string, unknown>;
      const segment = segments.find((item) => item.asset_id === asset.asset_id)!;
      const observation = segment.editorial_observation as Record<string, unknown>;
      const provenance = readProvenance(segment);
      expect(observation.status).toBe("ready");
      expect(provenance).toMatchObject({
        stage: "vlm",
        requested_output_tokens: calls[0].maxOutputTokens,
        finish_reason: "STOP",
        attempt_count: 2,
        retry_reason: "truncated_json",
        frame_count: 1,
        source_content_sha256: asset.source_content_sha256,
        frame_content_sha256: [still.normalized_frame_content_sha256],
      });
      expect(sha256FileHex(path.join(fixture.projectDir, "03_analysis", String(still.normalized_frame_path))))
        .toBe(still.normalized_frame_content_sha256);
    }

    const status = runStatus(fixture.projectDir);
    expect(status.gates?.analysis_gate).toBe("ready");
    const observed = { runs: 0, gate: undefined as string | undefined };
    const triage = await runTriage(fixture.projectDir, makeTriageAgent(fixture.projectDir, observed));
    expect(triage.success, JSON.stringify(triage, null, 2)).toBe(true);
    expect(triage.newState).toBe("selects_ready");
    expect(observed).toEqual({ runs: 1, gate: "ready" });
    expect(readProjectState(fixture.projectDir)?.current_state).toBe("selects_ready");

    const selects = parseYaml(
      fs.readFileSync(path.join(fixture.projectDir, "04_plan/selects_candidates.yaml"), "utf8"),
    ) as { candidates: unknown[]; coverage?: { status?: string } };
    expect(selects.candidates).toHaveLength(6);
    expect(selects.coverage?.status).toBe("met");
  }, 120_000);

  it("keeps unrepaired nested schema output partial and out of triage", async () => {
    const fixture = createFixture("schema-invalid");
    const { result, calls } = await runFixtureAnalysis(fixture, "invalid_after_repair");
    const segments = readSegments(fixture.projectDir);
    const vlmLane = result.analysisCoverageReport?.lanes.find((lane) => lane.lane_id === "vlm_tags");

    expect(calls).toHaveLength(12);
    expect(vlmLane).toMatchObject({ status: "failed", consumer_impact: "triage_warn" });
    expect(segments).toHaveLength(6);
    expect(segments.every((segment) => {
      const observation = segment.editorial_observation as Record<string, unknown> | undefined;
      const warnings = Array.isArray(observation?.warnings) ? observation.warnings : [];
      const snapshots = observation?.producer_snapshots as Record<string, unknown> | undefined;
      const grounded = snapshots?.grounded_vlm as Record<string, unknown> | undefined;
      return observation?.status === "partial" && grounded?.status === "skipped" &&
        warnings.some((warning) => String(warning).includes("vlm_schema_validation_failed"));
    }), JSON.stringify(segments, null, 2)).toBe(true);
    expect(fs.existsSync(path.join(fixture.projectDir, "04_plan/selects_candidates.yaml"))).toBe(false);
    const observed = { runs: 0, gate: undefined as string | undefined };
    await expect(runTriage(fixture.projectDir, makeTriageAgent(fixture.projectDir, observed)))
      .rejects.toThrow(/still_image_grounding_invalid/);
    expect(observed.runs).toBe(0);
    expect(fs.existsSync(path.join(fixture.projectDir, "04_plan/selects_candidates.yaml"))).toBe(false);
  }, 120_000);

  it("keeps a changed source identity as a zero-call grounding HOLD", async () => {
    const fixture = createFixture("identity-mismatch");
    await runFixtureAnalysis(fixture, "truncate_then_repair");
    const original = fixture.sourceFiles[0];
    const originalAsset = readAssets(fixture.projectDir).find((asset) =>
      asset.filename === path.basename(original),
    )!;
    const validAssetFrameAllowlist = new Set(
      readAssets(fixture.projectDir)
        .filter((asset) => asset.asset_id !== originalAsset.asset_id)
        .map((asset) => path.resolve(
          fixture.projectDir,
          "03_analysis",
          String((asset.still_image as Record<string, unknown>).normalized_frame_path),
        )),
    );
    expect(validAssetFrameAllowlist).toHaveLength(5);
    const originalFrame = path.resolve(
      fixture.projectDir,
      "03_analysis",
      String((originalAsset.still_image as Record<string, unknown>).normalized_frame_path),
    );
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90, hue=h=271", "-frames:v", "1", original]);
    const calls: ProviderCall[] = [];
    const rerun = await runPipeline({
      sourceFiles: fixture.sourceFiles,
      projectDir: fixture.projectDir,
      projectId: PROJECT_ID,
      repoRoot: REPO_ROOT,
      vlmFn: makeFixtureVlm("truncate_then_repair", calls),
      vlmOnly: true,
      skipAppraiser: true,
      skipPeak: true,
      skipBgmAnalysis: true,
    });
    const changedAsset = readAssets(fixture.projectDir).find((asset) =>
      asset.filename === path.basename(original),
    )!;
    const changedSegment = readSegments(fixture.projectDir).find((segment) =>
      segment.asset_id === changedAsset.asset_id,
    )!;
    const grounding = changedSegment.editorial_observation as Record<string, unknown>;
    const warnings = Array.isArray(grounding.warnings) ? grounding.warnings.map(String) : [];
    const snapshots = grounding.producer_snapshots as Record<string, unknown>;
    const groundedSnapshot = snapshots.grounded_vlm as Record<string, unknown>;
    const observedFramePaths = new Set(calls.flatMap((call) => call.framePaths));

    expect(calls).toHaveLength(10);
    expect(observedFramePaths).toEqual(validAssetFrameAllowlist);
    expect([...observedFramePaths].some((framePath) => fixture.sourceFiles.includes(framePath))).toBe(false);
    expect(calls.filter((call) => call.framePaths.includes(originalFrame))).toHaveLength(0);
    expect(rerun.segmentsJson.items.find((segment) => segment.asset_id === changedAsset.asset_id)
      ?.editorial_observation?.status).toBe("partial");
    expect(warnings.join(" ")).toContain("still_image_source_identity_mismatch");
    expect(grounding.status).toBe("partial");
    expect(groundedSnapshot.status).toBe("skipped");
    const observed = { runs: 0, gate: undefined as string | undefined };
    await expect(runTriage(fixture.projectDir, makeTriageAgent(fixture.projectDir, observed)))
      .rejects.toThrow(/still_image_grounding_invalid/);
    expect(observed.runs).toBe(0);
    expect(fs.existsSync(path.join(fixture.projectDir, "04_plan/selects_candidates.yaml"))).toBe(false);
  }, 120_000);
});
