import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildImageQcPrompt,
  buildRepairConstraints,
  computeImageQcVerdict,
  DEFAULT_IMAGE_QC_POLICY,
  normalizeImageQcResult,
  type ImageQcDefect,
  type ImageQcInspection,
} from "../runtime/connectors/image-qc-vlm.js";
import {
  assertImageQcGateOpen,
  imageQcCompileGateReason,
  runImageQcGate,
  validateImageQcReportIntegrity,
  type ImageQcReport,
} from "../runtime/artifacts/image-qc-report.js";
import { runAnalyzeImageQcGate } from "../runtime/commands/analyze.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { compile } from "../runtime/compiler/index.js";
import {
  classifyOptionalVlmResult,
  shouldRetryOptionalVlm,
} from "../runtime/review/optional-vlm-policy.js";

const roots: string[] = [];
const originalGeminiKey = process.env.GEMINI_API_KEY;

afterAll(() => {
  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
});

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeProject(name: string): { root: string; framePath: string; frameSha: string } {
  const root = fs.mkdtempSync(path.join(process.cwd(), `test-issue37-${name}-`));
  roots.push(root);
  const analysis = path.join(root, "03_analysis");
  const framePath = path.join(analysis, "normalized", "AST_STILL.png");
  fs.mkdirSync(path.dirname(framePath), { recursive: true });
  fs.mkdirSync(path.join(root, "01_intent"), { recursive: true });
  const bytes = Buffer.from(`fixture:${name}`);
  fs.writeFileSync(framePath, bytes);
  const frameSha = sha(bytes);
  fs.writeFileSync(path.join(root, "01_intent", "creative_brief.yaml"), [
    "version: '1'",
    "project_id: issue37-fixture",
    "project:",
    "  title: Still image QC fixture",
    "  runtime_target_sec: 3",
    "editorial:",
    "  profile_hint: generic-editorial",
  ].join("\n"));
  fs.writeFileSync(path.join(analysis, "assets.json"), JSON.stringify({
    project_id: "issue37-fixture",
    items: [{
      asset_id: "AST_STILL",
      media_kind: "image",
      still_image: {
        normalized_frame_path: "normalized/AST_STILL.png",
        normalized_frame_content_sha256: frameSha,
      },
    }],
  }, null, 2));
  fs.writeFileSync(path.join(analysis, "segments.json"), JSON.stringify({
    project_id: "issue37-fixture",
    items: [{
      segment_id: "SEG_STILL",
      asset_id: "AST_STILL",
      provenance: { tags: { frame_content_sha256: [frameSha] } },
    }],
  }, null, 2));
  return { root, framePath, frameSha };
}

function addStillAsset(root: string, assetId: string, bytes = `fixture:${assetId}`): void {
  const analysis = path.join(root, "03_analysis");
  const framePath = path.join(analysis, "normalized", `${assetId}.png`);
  fs.writeFileSync(framePath, Buffer.from(bytes));
  const frameSha = sha(Buffer.from(bytes));
  const assetsPath = path.join(analysis, "assets.json");
  const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as {
    items: Array<{ asset_id: string; media_kind: string; still_image: Record<string, unknown> }>;
  };
  assets.items.push({
    asset_id: assetId,
    media_kind: "image",
    still_image: {
      normalized_frame_path: `normalized/${assetId}.png`,
      normalized_frame_content_sha256: frameSha,
    },
  });
  fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2));

  const segmentsPath = path.join(analysis, "segments.json");
  const segments = JSON.parse(fs.readFileSync(segmentsPath, "utf8")) as {
    items: Array<{ segment_id: string; asset_id: string; provenance: { tags: { frame_content_sha256: string[] } } }>;
  };
  segments.items.push({
    segment_id: `SEG_${assetId}`,
    asset_id: assetId,
    provenance: { tags: { frame_content_sha256: [frameSha] } },
  });
  fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2));
}

function defect(code: ImageQcDefect["code"], description = `${code} defect`, severity: ImageQcDefect["severity"] = "major"): ImageQcDefect {
  return { code, description, severity, location: "center" };
}

function inspection(options: {
  handScore?: number;
  compositionScore?: number;
  briefScore?: number;
  handDefects?: ImageQcDefect[];
  compositionDefects?: ImageQcDefect[];
  briefDefects?: ImageQcDefect[];
  peopleDetected?: boolean;
  peopleCount?: number | null;
  handsDetected?: number | null;
  fingersDetectedMax?: number | null;
} = {}): ImageQcInspection {
  const handScore = options.handScore ?? 0.95;
  const compositionScore = options.compositionScore ?? 0.95;
  const briefScore = options.briefScore ?? 0.95;
  return {
    people_detected: options.peopleDetected ?? true,
    people_count: options.peopleCount ?? 1,
    hand_finger_count_check: {
      evaluable: true,
      score: handScore,
      defects: options.handDefects ?? [],
      hands_detected: options.handsDetected ?? 2,
      expected_hands_max: 2,
      fingers_detected_max: options.fingersDetectedMax ?? 5,
      expected_fingers: 5,
    },
    composition_artifact_check: {
      evaluable: true,
      score: compositionScore,
      defects: options.compositionDefects ?? [],
      hands_detected: null,
      expected_hands_max: null,
      fingers_detected_max: null,
      expected_fingers: null,
    },
    brief_semantic_consistency: {
      evaluable: true,
      score: briefScore,
      defects: options.briefDefects ?? [],
      hands_detected: null,
      expected_hands_max: null,
      fingers_detected_max: null,
      expected_fingers: null,
    },
    notes: [],
  };
}

function inspectionFn(sequence: ImageQcInspection[], calls: { count: number } = { count: 0 }) {
  return async () => {
    calls.count += 1;
    return {
      inspection: sequence[Math.min(calls.count - 1, sequence.length - 1)] ?? inspection(),
      provider: "fixture-vlm",
      model: "fixture-model",
      prompt_sha256: "ignored-by-gate",
    };
  };
}

function regenerationFn(frameBytes: string[] = []) {
  let calls = 0;
  return {
    get count() { return calls; },
    fn: async (request: { frame_path: string; attempt: number }) => {
      calls += 1;
      fs.writeFileSync(request.frame_path, Buffer.from(frameBytes[calls - 1] ?? `repaired-${request.attempt}`));
      return { provider: "fixture-generator", model: "fixture-image-model" };
    },
  };
}

function readReport(root: string): ImageQcReport {
  return JSON.parse(fs.readFileSync(path.join(root, "03_analysis/image_qc_report.json"), "utf8")) as ImageQcReport;
}

describe("Issue 37 connector contract", () => {
  it("builds a prompt for anatomy, composition/text, and brief semantics", () => {
    const prompt = buildImageQcPrompt("navy hoodie, red mug, quiet kitchen");
    expect(prompt).toContain("hand_finger_count_check");
    expect(prompt).toContain("garbled or warped text");
    expect(prompt).toContain("brief context");
  });

  it("normalizes hostile values and preserves the three required checks", () => {
    const result = normalizeImageQcResult({
      people_detected: true,
      people_count: 1,
      hand_finger_count_check: { evaluable: true, score: 2, defects: [{ code: "unknown", description: "token=secret", severity: "bad" }] },
      composition_artifact_check: { evaluable: true, score: 1, defects: [] },
      brief_semantic_consistency: { evaluable: true, score: 1, defects: [] },
    });
    expect(result.hand_finger_count_check.score).toBe(1);
    expect(result.hand_finger_count_check.defects[0]?.code).toBe("other");
    expect(result.hand_finger_count_check.defects[0]?.description).not.toContain("secret");
  });

  it("rejects anatomy count contradictions even when the score is perfect", () => {
    const result = computeImageQcVerdict(
      inspection({ handsDetected: 3, handScore: 1, compositionScore: 1, briefScore: 1 }),
      DEFAULT_IMAGE_QC_POLICY,
    );
    expect(result.verdict).toBe("rejected");
    expect(result.rejection_reasons.some((reason) => reason.startsWith("critical_defect:extra_hands:"))).toBe(true);
    expect(buildRepairConstraints([
      defect("extra_hands", "third hand on the left", "critical"),
    ]).positive).toContain("render exactly two hands per person with natural poses");
  });
});

describe("Issue 37 public analysis gate", () => {
  it.each([
    ["anatomy", inspection({ handScore: 0.2, handDefects: [defect("extra_hands", "third hand", "critical")] })],
    ["composition", inspection({ compositionScore: 0.2, compositionDefects: [defect("garbled_text", "warped title")] })],
    ["semantic", inspection({ briefScore: 0.2, briefDefects: [defect("wardrobe_mismatch", "wrong jacket")] })],
  ])("blocks a %s defect and writes a qa_failed report", async (_label, rejectedInspection) => {
    const { root } = makeProject(`reject-${_label}`);
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([rejectedInspection]),
    });
    expect(result.report?.summary.status).toBe("blocked");
    expect(result.report?.outcome.classification).toBe("qa_failed");
    expect(result.report?.assets[0]?.status).toBe("rejected");
    expect(() => assertImageQcGateOpen(root)).toThrow(/image_qc_gate_blocked/);
  });

  it("approves a clean image and validates the sanitized report schema", async () => {
    const { root } = makeProject("pass");
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([inspection()]),
      now: () => "2026-09-01T00:00:00.000Z",
    });
    expect(result.report?.summary.status).toBe("ready");
    expect(result.report?.outcome.classification).toBe("available");
    expect(validateImageQcReportIntegrity(result.report, { projectDir: root }).violations).toEqual([]);
    expect(() => validateArtifact(result.report, "image-qc-report.schema.json")).not.toThrow();
  });

  it("bounds repair to two retries and keeps concrete constraints per retry", async () => {
    const { root } = makeProject("max-retries");
    const calls = { count: 0 };
    const generator = regenerationFn();
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([
        inspection({ handScore: 0.2, handDefects: [defect("extra_hands", "third hand", "critical")] }),
        inspection({ handScore: 0.2, handDefects: [defect("extra_hands", "third hand", "critical")] }),
        inspection({ handScore: 0.2, handDefects: [defect("extra_hands", "third hand", "critical")] }),
      ], calls),
      regenerationFn: generator.fn,
    });
    const asset = result.report!.assets[0]!;
    expect(calls.count).toBe(3);
    expect(generator.count).toBe(2);
    expect(asset.regeneration_attempts).toBe(2);
    expect(asset.attempts).toHaveLength(3);
    expect(asset.attempts[1]?.repair_constraints?.negative.join(" ")).toContain("extra hands");
    expect(result.report?.summary.status).toBe("blocked");
  });

  it("binds a successful repaired replacement to its actual output hash", async () => {
    const { root, framePath } = makeProject("repair-pass");
    const generator = regenerationFn(["replacement-image-bytes"]);
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([
        inspection({ compositionScore: 0.2, compositionDefects: [defect("garbled_text", "bad title")] }),
        inspection(),
      ]),
      regenerationFn: generator.fn,
    });
    const outputHash = sha(fs.readFileSync(framePath));
    const asset = result.report!.assets[0]!;
    expect(result.report?.summary.status).toBe("ready");
    expect(asset.attempts[1]?.frame_content_sha256).toBe(`sha256:${outputHash}`);
    expect(asset.frame_content_sha256).toBe(`sha256:${outputHash}`);
    const assets = JSON.parse(fs.readFileSync(path.join(root, "03_analysis/assets.json"), "utf8")) as { items: Array<{ still_image: { normalized_frame_content_sha256: string } }> };
    expect(assets.items[0]!.still_image.normalized_frame_content_sha256).toBe(outputHash);
  });

  it("never waives unresolved qa_failed at the compile gate", async () => {
    const { root } = makeProject("qa-failed-compile");
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([inspection({ briefScore: 0.1, briefDefects: [defect("setting_mismatch", "wrong setting")] })]),
    });
    expect(imageQcCompileGateReason(result.report!)).toMatch(/rejected assets|qa_failed/);
    expect(() => assertImageQcGateOpen(root)).toThrow(/image_qc_gate_blocked/);
  });

  it("does not replace a current qa_failed report with optional unavailability", async () => {
    const { root } = makeProject("qa-failed-preserved");
    await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([inspection({ compositionScore: 0.1, compositionDefects: [defect("garbled_text", "bad title", "critical")] })]),
    });
    const rerun = await runImageQcGate({ projectDir: root });
    expect(rerun.report?.outcome.classification).toBe("qa_failed");
    expect(() => assertImageQcGateOpen(root)).toThrow(/qa_failed cannot be waived|rejected assets/);
    expect(() => compile({ projectPath: root, createdAt: "2026-09-01T00:00:00.000Z", validateSourceArtifacts: false }))
      .toThrow(/qa_failed cannot be waived|rejected assets/);
  });

  it("keeps an earlier qa_failed above a later 401 and forbids Issue 44 handoff", async () => {
    const { root } = makeProject("qa-failed-precedence");
    addStillAsset(root, "AST_STILL_2");
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: async ({ asset_id }) => {
        if (asset_id === "AST_STILL") {
          return {
            inspection: inspection({ compositionScore: 0.1, compositionDefects: [defect("garbled_text", "bad title", "critical")] }),
            provider: "fixture-vlm",
            model: "fixture-model",
            prompt_sha256: "ignored-by-gate",
          };
        }
        throw Object.assign(new Error("Gemini API error 401"), { status: 401 });
      },
    });
    expect(result.report?.outcome.classification).toBe("qa_failed");
    expect(result.report?.provenance.issue44_handoff).toBeNull();
    expect(result.report?.summary.status).toBe("blocked");
    expect(validateImageQcReportIntegrity(result.report).violations).toEqual([]);
    expect(() => assertImageQcGateOpen(root)).toThrow(/qa_failed cannot be waived|rejected assets/);
  });

  it("hands optional unavailability to Issue 44 and does not repeat it", async () => {
    const { root } = makeProject("optional-unavailable");
    const first = await runImageQcGate({ projectDir: root });
    const second = await runImageQcGate({ projectDir: root });
    expect(first.report?.outcome.classification).toBe("unavailable_optional");
    expect(first.report?.provenance.issue44_handoff).toBe("optional_vlm_policy");
    expect(imageQcCompileGateReason(first.report!)).toBeNull();
    expect(second.report?.created_at).toBe(first.report?.created_at);
    expect(shouldRetryOptionalVlm(first.report?.outcome, second.report?.outcome)).toBe(false);
    expect(classifyOptionalVlmResult(first.report?.outcome).classification).toBe("unavailable_optional");
  });

  it("keeps the retry bound per asset while allowing an aggregate of two retries each", async () => {
    const { root } = makeProject("two-asset-retries");
    addStillAsset(root, "AST_STILL_2");
    const generator = regenerationFn();
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([inspection({ compositionScore: 0.1, compositionDefects: [defect("garbled_text", "bad title", "critical")] })]),
      regenerationFn: generator.fn,
    });
    expect(result.report?.assets.map((asset) => asset.regeneration_attempts)).toEqual([2, 2]);
    expect(result.report?.summary.regeneration_attempts).toBe(4);
    expect(() => validateArtifact(result.report, "image-qc-report.schema.json")).not.toThrow();
  });

  it("classifies a configured-provider 401 as optional unavailable without persisting the error", async () => {
    const { root } = makeProject("provider-401");
    let calls = 0;
    const inspection = async () => {
      calls += 1;
      throw Object.assign(new Error("Gemini API error 401: token=do-not-persist https://provider.invalid/x?request_id=private"), { status: 401 });
    };
    const first = await runImageQcGate({ projectDir: root, inspectionFn: inspection });
    const second = await runImageQcGate({ projectDir: root, inspectionFn: inspection });
    expect(first.report?.outcome).toMatchObject({ classification: "unavailable_optional", error_code: "HTTP_401" });
    expect(first.report?.assets[0]?.unavailable_reason).toBe("image_qc_inspection_unavailable");
    expect(imageQcCompileGateReason(first.report!)).toBeNull();
    expect(validateImageQcReportIntegrity(first.report, { projectDir: root }).violations).toEqual([]);
    expect(second.report?.created_at).toBe(first.report?.created_at);
    expect(calls).toBe(1);
    const serialized = JSON.stringify(first.report);
    expect(serialized).not.toContain("do-not-persist");
    expect(serialized).not.toContain("request_id=private");
  });

  it("blocks an unavailable required capability", async () => {
    const { root } = makeProject("required-unavailable");
    const result = await runImageQcGate({
      projectDir: root,
      capabilityProfile: {
        profile_id: "required-fixture",
        capability: { id: "visual_model", requirement: "required", provider: "fixture", model: "required-model" },
      },
    });
    expect(result.report?.summary.status).toBe("blocked");
    expect(imageQcCompileGateReason(result.report!)).toBe("required visual_model capability is unavailable");
  });

  it("sanitizes model defect text and never persists provider error details or image bytes", async () => {
    const { root } = makeProject("sanitized");
    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([inspection({
        compositionScore: 0.2,
        compositionDefects: [defect("garbled_text", "token=super-secret https://provider.invalid/check?request_id=abc request_id=abc", "major")],
      })]),
    });
    const raw = JSON.stringify(result.report);
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("request_id=abc");
    expect(raw).not.toContain("https://provider.invalid/check?");
    expect(raw).not.toContain("sanitized"); // source image bytes are not persisted
    expect(validateImageQcReportIntegrity(result.report, { projectDir: root }).violations).toEqual([]);
  });

  it("fails closed when the canonical source frame hash is missing", async () => {
    const { root } = makeProject("missing-frame-hash");
    const assetsPath = path.join(root, "03_analysis/assets.json");
    const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as { items: Array<{ still_image: Record<string, unknown> }> };
    delete assets.items[0]!.still_image.normalized_frame_content_sha256;
    fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2));

    const result = await runImageQcGate({
      projectDir: root,
      inspectionFn: inspectionFn([inspection()]),
    });
    expect(result.report?.summary.status).toBe("blocked");
    expect(result.report?.outcome.classification).toBe("invalid_result");
    expect(result.report?.summary.status).not.toBe("ready");
    expect(imageQcCompileGateReason(result.report!)).toMatch(/invalid_result|image QC input/);
    expect(validateImageQcReportIntegrity(result.report, { projectDir: root }).violations)
      .toContain("AST_STILL:binding_declared_frame_hash_missing");
    expect(() => assertImageQcGateOpen(root)).toThrow(/binding_declared_frame_hash_missing|invalid_result/);
  });

  it("is connected to the public analyze route", async () => {
    const { root } = makeProject("public-cli");
    const result = await runAnalyzeImageQcGate({ projectDir: root });
    expect(result.applicable).toBe(true);
    expect(fs.existsSync(path.join(root, "03_analysis/image_qc_report.json"))).toBe(true);
    expect(result.report?.provenance.producer).toBe("analysis-pipeline");
  });
});
