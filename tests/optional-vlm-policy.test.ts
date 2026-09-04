import { describe, expect, it } from "vitest";
import {
  classifyOptionalVlmResult,
  deriveOptionalVlmDeterministicQA,
  evaluateOptionalVlmPolicy,
  inspectOptionalVlmPolicy,
  optionalVlmPolicyGateReason,
  resolveOptionalVlmCapability,
  sameOptionalUnavailableResult,
  shouldRetryOptionalVlm,
  writeOptionalVlmPolicy,
  type OptionalVlmPolicyArtifact,
} from "../runtime/review/optional-vlm-policy.js";
import { checkGate10 } from "../runtime/packaging/gate10.js";
import { hasReviewVisualQAWaiver, reviewVisualQAGateReason } from "../runtime/review/visual-qa.js";
import { validateArtifact } from "../runtime/artifacts/loaders.js";
import { createReviewRoundProject, runReviewRound } from "./helpers/review-round-project.js";
import { runOptionalVlmPolicyCli } from "../scripts/optional-vlm-policy.js";
import { buildPackagePreflight } from "../scripts/package.js";
import { stringify as stringifyYaml } from "yaml";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const generation = {
  generation_id: hash("a"),
  video_sha256: hash("b"),
  timeline_sha256: hash("c"),
};
const deterministicPass = {
  full_decode: "pass",
  black: "pass",
  freeze: "pass",
  inset: "pass",
  layout: "pass",
  caption: "pass",
};
const optionalProfile = {
  id: "interview-highlight",
  capabilities: { visual_model: { requirement: "optional" as const } },
};
const requiredProfile = {
  id: "strict-visual-profile",
  capabilities: { visual_model: { requirement: "required" as const } },
};

function policy(overrides: Partial<Parameters<typeof evaluateOptionalVlmPolicy>[0]> = {}): OptionalVlmPolicyArtifact {
  return evaluateOptionalVlmPolicy({
    project_id: "issue-44-test",
    profile: optionalProfile,
    generation,
    result: { status: "available", provider: "fixture", model: "fixture-v1" },
    deterministic_qa: deterministicPass,
    ...overrides,
  });
}

function schemaReviewReport(visual: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1",
    project_id: "issue-44-schema-test",
    timeline_version: "1",
    summary_judgment: { status: "needs_revision", rationale: "fixture" },
    strengths: [],
    weaknesses: [],
    fatal_issues: [],
    warnings: [],
    mismatches_to_brief: [],
    mismatches_to_blueprint: [],
    recommended_next_pass: { goal: "fixture", actions: ["fixture"] },
    visual_qa: {
      status: "blocked",
      reason: "fixture",
      min_score: 70,
      issues: { total: 0, critical: 0, warning: 0, info: 0 },
      issue_summaries: [],
      ...visual,
    },
  };
}

describe("Issue #44 optional VLM policy", () => {
  it.each([
    [{ http_status: 401, error: "gated repo token=SECRET request_id=req-secret" }, "unavailable_optional", "HTTP_401"],
    [{ http_status: 403, error: "access denied for gated repository" }, "unavailable_optional", "HTTP_403"],
    [{ error: "model cache missing at /private/model" }, "unavailable_optional", "MODEL_CACHE_MISSING"],
    [{ error: "optional dependency module not found" }, "unavailable_optional", "OPTIONAL_DEPENDENCY_MISSING"],
    [{ error_code: "GATED_REPOSITORY" }, "unavailable_optional", "GATED_REPOSITORY"],
    [{ error_code: "OPTIONAL_UNAVAILABLE" }, "unavailable_optional", "OPTIONAL_UNAVAILABLE"],
    [{ error: { code: "ERR_MODULE_NOT_FOUND", message: "cannot find package" } }, "unavailable_optional", "OPTIONAL_DEPENDENCY_MISSING"],
    [{ response: { error_code: "GATED_REPOSITORY" } }, "unavailable_optional", "GATED_REPOSITORY"],
    [{ status: 401 }, "unavailable_optional", "HTTP_401"],
    [{ error: "worker timed out after 30s" }, "execution_failed", "EXECUTION_TIMEOUT"],
    [{ status: "timeout" }, "execution_failed", "EXECUTION_TIMEOUT"],
    [{ crashed: true, error: "worker exited with SIGKILL" }, "execution_failed", "EXECUTION_CRASH"],
    [{ status: "crashed" }, "execution_failed", "EXECUTION_CRASH"],
    [{ status: 500 }, "execution_failed", "EXECUTION_ERROR"],
    [{ status: "ok", response: "not-json" }, "invalid_result", "MALFORMED_RESPONSE"],
    [{ error_code: "MALFORMED_RESPONSE" }, "invalid_result", "MALFORMED_RESPONSE"],
    [{ status: "qa_failed", issues: [{ description: "black frame detected" }] }, "qa_failed", "MODEL_DETECTED_DEFECT"],
    [{ error_code: "MODEL_DETECTED_DEFECT" }, "qa_failed", "MODEL_DETECTED_DEFECT"],
  ] as const)("classifies %s without persisting external text", (input, classification, errorCode) => {
    const result = classifyOptionalVlmResult({
      ...input,
      provider: "https://provider.example/v1?token=SECRET",
      model: "org/model?request_id=req-secret",
    });
    expect(result).toMatchObject({ classification, error_code: errorCode, provider: "https://provider.example/v1", model: "org/model" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("request_id");
    expect(JSON.stringify(result)).not.toContain("gated repo token");
  });

  it("keeps a successful model result as available", () => {
    expect(classifyOptionalVlmResult({ status: "verified", provider: "fixture", model: "fixture-v1" })).toMatchObject({
      classification: "available",
      error_code: null,
    });
  });

  it("derives full-decode, black, freeze, inset, layout, and caption from current receipt shapes", () => {
    expect(deriveOptionalVlmDeterministicQA({
      generation_receipt: {
        qa: {
          output: { status: "verified", scans: {
            decode: { status: "complete" },
            black: { status: "complete", detections: [] },
            freeze: { status: "complete", detections: [] },
            layout_inset: { status: "complete", detections: [] },
          } },
          layout: { status: "verified", issues: [] },
        },
      },
      review_receipt: {
        gaps: {
          primary_video: { status: "pass", count: 0 },
          black: { status: "pass", count: 0 },
          freeze: { status: "pass", count: 0 },
        },
        captions: { collision_status: "pass" },
      },
    })).toEqual({ status: "passed", ...deterministicPass });
  });

  it("exposes optional-unavailable, deterministic-pending, human-pending, and skipped states", () => {
    const unavailable = { http_status: 401, error: "gated repository" };
    expect(policy({ result: unavailable, deterministic_qa: undefined })).toMatchObject({
      outcome: { classification: "unavailable_optional", error_code: "HTTP_401" },
      status: "optional_unavailable",
      deterministic_qa: { status: "pending" },
    });
    expect(policy({ result: unavailable, deterministic_qa: {} })).toMatchObject({ status: "deterministic_qa_pending" });
    expect(policy({ result: unavailable })).toMatchObject({ status: "human_approval_pending" });
    expect(policy({
      result: unavailable,
      human_approval: {
        status: "approved",
        generation_id: generation.generation_id,
        video_sha256: generation.video_sha256,
        timeline_sha256: generation.timeline_sha256,
        approved_by: "reviewer",
      },
    })).toMatchObject({ status: "skipped_unavailable_optional", human_approval: { status: "approved", actor: "reviewer" } });
  });

  it("fails closed for identity mismatch, required capability, and qa_failed", () => {
    const mismatched = policy({
      result: { http_status: 401 },
      human_approval: {
        status: "approved",
        generation_id: hash("d"),
        video_sha256: generation.video_sha256,
        timeline_sha256: generation.timeline_sha256,
      },
    });
    expect(mismatched).toMatchObject({ status: "blocked", human_approval: { status: "identity_mismatch" } });
    expect(optionalVlmPolicyGateReason(mismatched, generation)).toContain("blocked");

    const required = policy({ profile: requiredProfile, result: { http_status: 401 } });
    expect(required.status).toBe("blocked");
    expect(optionalVlmPolicyGateReason(required, generation)).toContain("required visual_model capability");

    const qaFailed = policy({
      result: { status: "qa_failed", issues: [{ description: "defect" }] },
      human_approval: {
        status: "approved",
        generation_id: generation.generation_id,
        video_sha256: generation.video_sha256,
        timeline_sha256: generation.timeline_sha256,
      },
    });
    expect(qaFailed.status).toBe("qa_failed");
    expect(optionalVlmPolicyGateReason(qaFailed, generation)).toContain("cannot use an unavailable waiver");
  });

  it("does not retry the same sanitized unavailable result", () => {
    const first = policy({ result: { http_status: 401, error: "secret one" }, deterministic_qa: undefined });
    const second = policy({ result: { http_status: 401, error: "secret two" }, deterministic_qa: undefined, previous: first });
    expect(sameOptionalUnavailableResult(first, second)).toBe(true);
    expect(shouldRetryOptionalVlm(first, second)).toBe(false);
    expect(second.retry).toEqual({ same_unavailable_result: true, action: "not_retried" });
    const changed = policy({ result: { http_status: 403 }, deterministic_qa: undefined, previous: first });
    expect(shouldRetryOptionalVlm(first, changed)).toBe(true);
  });

  it("declares capability by profile and validates a persisted artifact through the public status CLI", () => {
    expect(resolveOptionalVlmCapability(requiredProfile).capability.requirement).toBe("required");
    expect(resolveOptionalVlmCapability(optionalProfile).capability.requirement).toBe("optional");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-44-policy-"));
    try {
      const artifact = policy();
      writeOptionalVlmPolicy(projectDir, artifact);
      expect(runOptionalVlmPolicyCli(["status", "--project", projectDir])).toMatchObject({
        exists: true,
        status: "blocked",
        valid: false,
        identity_status: "missing",
      });
      expect(inspectOptionalVlmPolicy(projectDir).closeable).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("evaluates through the public CLI from the current review-ready receipt and response", async () => {
    const project = createReviewRoundProject({ projectId: "issue-44-public-route" });
    try {
      const round = await runReviewRound(project, { decision: "approve" });
      const evaluated = runOptionalVlmPolicyCli(
        ["evaluate", "--project", project.root, "--result-stdin"],
        {
          resultStdin: JSON.stringify({
            status: 401,
            provider: "https://provider.example/v1?token=SECRET",
            model: "org/model?request_id=req-secret",
            error: "gated repository token=SECRET",
          }),
        },
      ) as { artifact: OptionalVlmPolicyArtifact; path: string };
      expect(evaluated.artifact).toMatchObject({
        status: "skipped_unavailable_optional",
        outcome: { classification: "unavailable_optional", error_code: "HTTP_401" },
        generation: { generation_id: round.generationId, video_sha256: round.outputSha256 },
      });
      expect(evaluated.artifact.generation.timeline_sha256).toBe(round.timelineSha256);
      expect(fs.readFileSync(evaluated.path, "utf8")).not.toMatch(/SECRET|request_id|gated repository/);
      expect(runOptionalVlmPolicyCli(["status", "--project", project.root])).toMatchObject({
        status: "skipped_unavailable_optional",
        valid: true,
        identity_status: "current",
        current_generation_id: round.generationId,
        current_video_sha256: round.outputSha256,
        current_timeline_sha256: round.timelineSha256,
        closeable: true,
      });

      const stale = {
        ...evaluated.artifact,
        generation: { ...evaluated.artifact.generation, generation_id: hash("d") },
      } satisfies OptionalVlmPolicyArtifact;
      writeOptionalVlmPolicy(project.root, stale);
      expect(runOptionalVlmPolicyCli(["status", "--project", project.root])).toMatchObject({
        status: "blocked",
        valid: false,
        identity_status: "mismatch",
        error: "optional_vlm_policy_identity_mismatch",
      });
      writeOptionalVlmPolicy(project.root, evaluated.artifact);

      fs.mkdirSync(path.join(project.root, "01_intent"), { recursive: true });
      fs.mkdirSync(path.join(project.root, "04_plan"), { recursive: true });
      fs.writeFileSync(path.join(project.root, "01_intent/creative_brief.yaml"), stringifyYaml({
        version: "1",
        project_id: project.projectId,
        project: { id: project.projectId, title: "Issue 44 fixture", runtime_target_sec: 54 },
        autonomy: { mode: "full", may_decide: ["render"], must_ask: [] },
      }));
      fs.writeFileSync(path.join(project.root, "04_plan/edit_blueprint.yaml"), stringifyYaml({
        version: "1",
        project_id: project.projectId,
        caption_policy: { source: "none" },
      }));
      fs.writeFileSync(path.join(project.root, "project_state.yaml"), stringifyYaml({
        version: 1,
        project_id: project.projectId,
        current_state: "approved",
        gates: { review_gate: "open" },
        approval_record: { status: "clean" },
        handoff_resolution: {
          handoff_id: "HND_ISSUE_44",
          status: "decided",
          source_of_truth_decision: "engine_render",
        },
      }));
      fs.writeFileSync(path.join(project.root, "06_review/review_report.yaml"), stringifyYaml({
        version: "1",
        project_id: project.projectId,
        timeline_version: round.timelineVersion,
        summary_judgment: { status: "approved", rationale: "fixture" },
        strengths: [],
        weaknesses: [],
        fatal_issues: [],
        warnings: [],
        mismatches_to_brief: [],
        mismatches_to_blueprint: [],
        recommended_next_pass: { goal: "fixture", actions: ["fixture"] },
        visual_qa: {
          status: "blocked",
          reason: "marlin_qa_unavailable_optional",
          min_score: 70,
          issues: { total: 0, critical: 0, warning: 0, info: 0 },
          issue_summaries: [],
          video_hash: round.outputSha256,
          timeline_hash: round.timelineSha256,
          optional_vlm_classification: "unavailable_optional",
          optional_vlm_error_code: "HTTP_401",
        },
      }));
      const preflight = buildPackagePreflight(project.root);
      expect(preflight.sourceOfTruth).toBe("engine_render");
      expect(preflight.visualQaSummary).toContain("status=blocked");
      expect(preflight.issues).not.toContain('review_report.visual_qa.status must be "verified", got "blocked"');
      expect(preflight.issues).not.toContain("optional_vlm_policy review_report identity is missing or stale");
      expect(preflight.issues).not.toContain("optional_vlm_policy is human_approval_pending");
    } finally {
      fs.rmSync(project.root, { recursive: true, force: true });
    }
  });

  it("is the Gate 10 close-readiness input and rejects a qa_failed waiver", () => {
    const baseState = {
      current_state: "approved",
      approval_record: { status: "clean" },
      handoff_resolution: { handoff_id: "HND_TEST", status: "decided", source_of_truth_decision: "engine_render" },
      gates: { review_gate: "open" },
    };
    const reviewReport = {
      fatal_issues: [],
      visual_qa: {
        status: "blocked" as const,
        reason: "marlin_qa_unavailable_optional",
        min_score: 70,
        issues: { total: 0, critical: 0, warning: 0, info: 0 },
        issue_summaries: [],
        deterministic_scan: { status: "verified" as const, issues: [] },
        video_hash: generation.video_sha256,
        timeline_hash: generation.timeline_sha256,
        optional_vlm_classification: "unavailable_optional" as const,
        optional_vlm_error_code: "HTTP_401" as const,
      },
    };
    const closeable = policy({ result: { http_status: 401 }, human_approval: {
      status: "approved",
      generation_id: generation.generation_id,
      video_sha256: generation.video_sha256,
      timeline_sha256: generation.timeline_sha256,
    } });
    expect(checkGate10(baseState, {
      reviewReport,
      optionalVlmPolicy: closeable,
      optionalVlmContext: generation,
    }).passed).toBe(true);
    const availablePolicy = policy();
    const availableSubstitution = checkGate10(baseState, {
      reviewReport,
      optionalVlmPolicy: availablePolicy,
      optionalVlmContext: generation,
    });
    expect(availableSubstitution.passed).toBe(false);
    expect(availableSubstitution.errors).toContain('review_report.visual_qa.status must be "verified", got "blocked"');
    const failed = policy({ result: { status: "qa_failed", issues: [{ description: "defect" }] } });
    const result = checkGate10(baseState, {
      reviewReport,
      optionalVlmPolicy: failed,
      optionalVlmContext: generation,
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toContain("optional_vlm_policy qa_failed cannot use an unavailable waiver");
    expect(checkGate10(baseState, {
      reviewReport,
      optionalVlmPolicy: closeable,
      optionalVlmContext: { ...generation, video_sha256: hash("d") },
    }).passed).toBe(false);
    const { video_hash: _videoHash, timeline_hash: _timelineHash, ...identityLessVisual } = reviewReport.visual_qa;
    const identityLessReport = { ...reviewReport, visual_qa: identityLessVisual };
    const identityLess = checkGate10(baseState, {
      reviewReport: identityLessReport,
      optionalVlmPolicy: closeable,
      optionalVlmContext: generation,
    });
    expect(identityLess.passed).toBe(false);
    expect(identityLess.errors).toContain("optional_vlm_policy review_report identity is missing or stale");
    const requiredWithoutArtifact = checkGate10(baseState, {
      reviewReport,
      optionalVlmCapability: { requirement: "required" },
    });
    expect(requiredWithoutArtifact.passed).toBe(false);
    expect(requiredWithoutArtifact.errors).toContain("required visual_model capability policy is missing");
    const requiredPolicy = policy({
      profile: requiredProfile,
      result: { http_status: 401 },
      human_approval: {
        status: "approved",
        generation_id: generation.generation_id,
        video_sha256: generation.video_sha256,
        timeline_sha256: generation.timeline_sha256,
      },
    });
    const requiredGate = checkGate10(baseState, {
      reviewReport,
      optionalVlmCapability: { requirement: "required" },
      optionalVlmPolicy: requiredPolicy,
      optionalVlmContext: generation,
    });
    expect(requiredGate.passed).toBe(false);
    expect(requiredGate.errors).toContain("required visual_model capability is unavailable");
  });

  it("does not let the legacy visual QA waiver bypass an Issue 44 failure classification", () => {
    const report = {
      visual_qa: {
        status: "blocked" as const,
        reason: "marlin_qa_qa_failed",
        min_score: 70,
        issues: { total: 0, critical: 0, warning: 0, info: 0 },
        issue_summaries: [],
        deterministic_scan: { status: "verified" as const, issues: [] },
        optional_vlm_classification: "qa_failed" as const,
        optional_vlm_error_code: "MODEL_DETECTED_DEFECT" as const,
      },
      visual_qa_waiver: true,
      visual_qa_waiver_reason: "operator reviewed the export",
    };
    expect(hasReviewVisualQAWaiver(report)).toBe(false);
    expect(reviewVisualQAGateReason(report)).toContain("visual_qa.status");
  });

  it.each([
    ["unavailable_optional", undefined],
    ["execution_failed", undefined],
    ["invalid_result", undefined],
    ["qa_failed", undefined],
    ["unavailable_optional", "HTTP_401"],
    ["execution_failed", "EXECUTION_TIMEOUT"],
    ["invalid_result", "MALFORMED_RESPONSE"],
    ["qa_failed", "MODEL_DETECTED_DEFECT"],
  ] as const)("rejects legacy waiver for %s regardless of error code", (classification, errorCode) => {
    const report = {
      visual_qa: {
        status: "blocked" as const,
        reason: `marlin_qa_${classification}`,
        min_score: 70,
        issues: { total: 0, critical: 0, warning: 0, info: 0 },
        issue_summaries: [],
        deterministic_scan: { status: "verified" as const, issues: [] },
        optional_vlm_classification: classification,
        ...(errorCode ? { optional_vlm_error_code: errorCode } : {}),
      },
      visual_qa_waiver: true,
      visual_qa_waiver_reason: "operator reviewed the export",
    };
    expect(hasReviewVisualQAWaiver(report)).toBe(false);
  });

  it("fails closed when review-report classification and error code disagree", () => {
    const validPairs = [
      ["available", undefined],
      ["unavailable_optional", "HTTP_401"],
      ["execution_failed", "EXECUTION_TIMEOUT"],
      ["invalid_result", "MALFORMED_RESPONSE"],
      ["qa_failed", "MODEL_DETECTED_DEFECT"],
    ] as const;
    for (const [classification, errorCode] of validPairs) {
      expect(() => validateArtifact(
        schemaReviewReport({
          optional_vlm_classification: classification,
          ...(errorCode ? { optional_vlm_error_code: errorCode } : {}),
        }),
        "review-report.schema.json",
      )).not.toThrow();
    }

    const invalidPairs = [
      ["unavailable_optional", undefined],
      ["unavailable_optional", "EXECUTION_TIMEOUT"],
      ["execution_failed", "MALFORMED_RESPONSE"],
      ["invalid_result", "MODEL_DETECTED_DEFECT"],
      ["qa_failed", "EXECUTION_ERROR"],
      ["available", "HTTP_401"],
      [undefined, "HTTP_401"],
    ] as const;
    for (const [classification, errorCode] of invalidPairs) {
      expect(() => validateArtifact(
        schemaReviewReport({
          ...(classification ? { optional_vlm_classification: classification } : {}),
          ...(errorCode ? { optional_vlm_error_code: errorCode } : {}),
        }),
        "review-report.schema.json",
      )).toThrow();
    }
  });
});
