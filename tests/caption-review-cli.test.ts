import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import {
  appendCaptionVisualTreatmentOperations,
  applyCaptionReview,
  approveCaptionReview,
  captionReviewUndoDepth,
  editCaptionReview,
  initializeCaptionReviewPatch,
  initializeCaptionVisualTreatmentPatch,
  inspectCaptionReviewOperationalState,
  inspectCaptionVisualTreatment,
  mergeCaptionReview,
  proposeCaptionGlossaryTerm,
  queueCaptionReview,
  prepareCaptionReviewDraft,
  previewCaptionVisualTreatment,
  splitCaptionReview,
  undoCaptionReview,
  validateCaptionReview,
  verifySafeCaptionReview,
} from "../runtime/caption/review-service.js";
import {
  computeCaptionDraftHash,
  computeCaptionTextHash,
} from "../runtime/caption/review-core.js";
import { captionApprovalBindingHash } from "../runtime/caption/visual-treatment.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import {
  parseCaptionReviewArgs,
  runCaptionReviewCli,
} from "../scripts/caption-review.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("caption review CLI workflow", () => {
  it("documents recovery, safe bulk, reviewer readiness, and approval commands", () => {
    const output: string[] = [];
    expect(runCaptionReviewCli(["node", "caption-review.ts", "--help"], (line) => output.push(line))).toBe(0);
    expect(output.join("\n")).toContain("queue --project <dir> [--reviewer <name>]");
    expect(output.join("\n")).toContain("prepare --project <dir>");
    expect(output.join("\n")).toContain("verify-safe --project <dir>");
    expect(output.join("\n")).toContain("retime --project <dir> --reviewer <name>");
    expect(output.join("\n")).toContain("approve --project <dir>");
    expect(output.join("\n")).toContain("visual-init --project <dir>");
    expect(output.join("\n")).toContain("visual-status --project <dir>");
    expect(output.join("\n")).toContain("visual-approve --project <dir>");
  });

  it("runs visual init/status/apply/undo/approve through the existing human CLI", () => {
    const projectDir = createProject(["visual CLI の字幕"]);
    const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.copyFileSync(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"), policyPath);
    initializeCaptionReviewPatch(projectDir, "human-editor");
    const item = queueCaptionReview(projectDir)[0];
    editCaptionReview(projectDir, { captionID: item.caption_id, state: "verified", expectedTextHash: item.text_hash });
    approveCaptionReview(projectDir, "human-editor");

    const run = (command: string, ...args: string[]) => {
      const output: string[] = [];
      expect(runCaptionReviewCli(["node", "caption-review.ts", command, "--project", projectDir, ...args], (message) => output.push(message))).toBe(0);
      return JSON.parse(output.join("\n")) as Record<string, unknown>;
    };
    expect(run("visual-init", "--reviewer", "human-editor", "--typography-policy", policyPath)).toMatchObject({ command: "visual-init", operation_count: 0 });
    expect(run("visual-status", "--typography-policy", policyPath)).toMatchObject({ command: "visual-status", status: "ready" });
    expect(run("visual-apply", "--reviewer", "human-editor", "--typography-policy", policyPath)).toMatchObject({ command: "visual-apply", status: "ready" });
    appendCaptionVisualTreatmentOperations(projectDir, "human-editor", [{
      caption_id: "SC_001", stable_root_id: "SC_001", anchor: "center", style_ref: "sns-vertical-outline", hierarchy_role: "keyword", emphasis_ref: "emphasis-word", fallback: "registered_fallback",
    }], { typographyPolicyPath: policyPath });
    expect(run("visual-undo", "--reviewer", "human-editor", "--typography-policy", policyPath)).toMatchObject({ command: "visual-undo", removed_operation_count: 1 });
    const current = run("visual-status", "--typography-policy", policyPath);
    const currentPatchHash = String(current.patch_hash);
    const candidate = run("visual-preview", "--reviewer", "human-editor", "--typography-policy", policyPath, "--expected-patch-hash", currentPatchHash);
    expect(candidate).toMatchObject({ command: "visual-preview", status: "ready", expected_patch_hash: currentPatchHash });
    expect(run("visual-approve", "--reviewer", "human-editor", "--typography-policy", policyPath, "--expected-patch-hash", currentPatchHash, "--preapproval-receipt", String(candidate.receipt_path))).toMatchObject({ command: "visual-approve", status: "ready" });
    expect(JSON.parse(fs.readFileSync(path.join(projectDir, "07_package/caption_approval.json"), "utf8")).approval.visual_treatment_context.accessibility).toEqual({ reduced_motion: false, high_contrast: false, audio_off: false, small_screen: false });
  });

  it("authors and renders a canonical visual-only preview without changing approval or text/timing", async () => {
    const projectDir = createProject(["承認済みの字幕"], true);
    const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.copyFileSync(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"), policyPath);
    initializeCaptionReviewPatch(projectDir, "human-editor");
    const item = queueCaptionReview(projectDir)[0];
    editCaptionReview(projectDir, { captionID: item.caption_id, state: "verified", expectedTextHash: item.text_hash });
    approveCaptionReview(projectDir, "human-editor");
    const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
    const approvalBefore = fs.readFileSync(approvalPath, "utf8");
    const approvalHash = captionApprovalBindingHash(JSON.parse(approvalBefore));
    const operation = {
      caption_id: "SC_001",
      stable_root_id: "SC_001",
      anchor: "bottom_center",
      rect: { x: 0.1, y: 0.72, width: 0.8, height: 0.16 },
      style_ref: "sns-vertical-outline",
      reference_scale: 1.1,
      hierarchy_role: "speech",
      fallback: "registered_fallback",
    };
    const output: string[] = [];
    expect(await runCaptionReviewCli([
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", "absent",
      "--expected-approval-hash", approvalHash,
    ], (message) => output.push(message))).toBe(0);
    const result = JSON.parse(output.join("\n")) as Record<string, unknown>;
    expect(result).toMatchObject({
      command: "visual-author-preview",
      production_approval_unchanged: true,
      approval_hash_before: approvalHash,
      approval_hash_after: approvalHash,
    });
    expect(result.text_timing_hash_before).toBe(result.text_timing_hash_after);
    expect(result.preview_output_path).not.toBe(result.input_path);
    expect(result.preview_output_hash).not.toBe(result.input_hash);
    expect(result.preview_output_content_type).toBe("video/mp4");
    expect(result.preview_output_hash).toBe(computeSha256(String(result.preview_output_path)));
    expect(fs.statSync(String(result.preview_output_path)).size).toBeGreaterThan(0);
    expect(fs.readFileSync(approvalPath, "utf8")).toBe(approvalBefore);

    const secondOutput: string[] = [];
    expect(await runCaptionReviewCli([
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify({ ...operation, reference_scale: 1.2 }),
      "--expected-patch-hash", String(result.patch_hash),
      "--expected-approval-hash", approvalHash,
    ], (message) => secondOutput.push(message))).toBe(0);
    const second = JSON.parse(secondOutput.join("\n")) as Record<string, unknown>;
    expect(second.text_timing_hash_before).toBe(result.text_timing_hash_before);
    expect(second.text_timing_hash_after).toBe(result.text_timing_hash_after);
    expect(second.approval_hash_before).toBe(approvalHash);
    expect(second.approval_hash_after).toBe(approvalHash);
    expect(fs.readFileSync(approvalPath, "utf8")).toBe(approvalBefore);
    await expect(runCaptionReviewCli([
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--patch", path.join(projectDir, "../escaped-patch.json"),
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", String(second.patch_hash),
      "--expected-approval-hash", approvalHash,
    ])).rejects.toThrow(/project-contained/);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-review-symlink-"));
    temporaryDirectories.push(outsideDir);
    const symlinkPatch = path.join(projectDir, "07_package/symlink-patch.json");
    fs.symlinkSync(path.join(outsideDir, "patch.json"), symlinkPatch);
    await expect(runCaptionReviewCli([
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--patch", symlinkPatch,
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", String(second.patch_hash),
      "--expected-approval-hash", approvalHash,
    ])).rejects.toThrow(/symlink/i);
    await expect(runCaptionReviewCli([
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify({ ...operation, unknown_field: true }),
      "--expected-patch-hash", String(second.patch_hash),
      "--expected-approval-hash", approvalHash,
    ])).rejects.toThrow(/additional properties|validation failed/i);

    await expect(runCaptionReviewCli([
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", String(result.patch_hash),
      "--expected-approval-hash", approvalHash,
    ])).rejects.toThrow(/patch changed|expected=absent/i);

    const preapprovalInputPath = String(second.input_path);
    const preapprovalReceiptPath = String(second.receipt_path);
    const previewOutputPath = String(second.preview_output_path);
    const inputBytes = fs.readFileSync(preapprovalInputPath);
    const receiptBytes = fs.readFileSync(preapprovalReceiptPath);
    const previewBytes = fs.readFileSync(previewOutputPath);
    const patchPath = String(second.patch_path);
    const patchBytes = fs.readFileSync(patchPath);
    const thirdArgs = [
      "node", "caption-review.ts", "visual-author-preview",
      "--project", projectDir,
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify({ ...operation, reference_scale: 1.3 }),
      "--expected-patch-hash", String(second.patch_hash),
      "--expected-approval-hash", approvalHash,
    ];
    const staleApprovalArgs = [...thirdArgs];
    staleApprovalArgs[staleApprovalArgs.indexOf("--expected-approval-hash") + 1] = `sha256:${"0".repeat(64)}`;
    await expect(runCaptionReviewCli(staleApprovalArgs)).rejects.toThrow(/caption approval changed/i);
    expect(fs.readFileSync(patchPath)).toEqual(patchBytes);
    fs.writeFileSync(preapprovalInputPath, JSON.stringify({ stale: true }));
    await expect(runCaptionReviewCli(thirdArgs)).rejects.toThrow(/input.*stale|schema/i);
    expect(fs.readFileSync(patchPath)).toEqual(patchBytes);
    fs.writeFileSync(preapprovalInputPath, inputBytes);
    fs.writeFileSync(preapprovalReceiptPath, JSON.stringify({ forged: true }));
    await expect(runCaptionReviewCli(thirdArgs)).rejects.toThrow(/receipt.*schema|validation/i);
    expect(fs.readFileSync(patchPath)).toEqual(patchBytes);
    fs.writeFileSync(preapprovalReceiptPath, receiptBytes);
    fs.writeFileSync(previewOutputPath, "forged-preview");
    await expect(runCaptionReviewCli(thirdArgs)).rejects.toThrow(/preview bytes.*stale|forged/i);
    expect(fs.readFileSync(patchPath)).toEqual(patchBytes);
    fs.writeFileSync(previewOutputPath, previewBytes);
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    timeline.sequence.name = "stale live timeline";
    fs.writeFileSync(timelinePath, JSON.stringify(timeline));
    await expect(runCaptionReviewCli(thirdArgs)).rejects.toThrow(/base_timeline_hash is stale/i);
    expect(fs.readFileSync(patchPath)).toEqual(patchBytes);
    expect(fs.readFileSync(approvalPath, "utf8")).toBe(approvalBefore);
  }, 120_000);

  it("accepts a stable visual operation and rejects an old Studio patch hash", () => {
    const projectDir = createProject(["visual stale guard の字幕"]);
    const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.copyFileSync(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"), policyPath);
    initializeCaptionReviewPatch(projectDir, "human-editor");
    const item = queueCaptionReview(projectDir)[0];
    editCaptionReview(projectDir, { captionID: item.caption_id, state: "verified", expectedTextHash: item.text_hash });
    approveCaptionReview(projectDir, "human-editor");

    const run = (command: string, ...args: string[]) => {
      const output: string[] = [];
      expect(runCaptionReviewCli(["node", "caption-review.ts", command, "--project", projectDir, ...args], (message) => output.push(message))).toBe(0);
      return JSON.parse(output.join("\n")) as Record<string, any>;
    };
    run("visual-init", "--reviewer", "human-editor", "--typography-policy", policyPath);
    const initial = run("visual-status", "--typography-policy", policyPath);
    const operation = {
      caption_id: "SC_001",
      stable_root_id: "SC_001",
      anchor: "bottom_center",
      rect: { x: 0.1, y: 0.76, width: 0.8, height: 0.12 },
      style_ref: "sns-vertical-outline",
      reference_scale: 1.1,
      hierarchy_role: "speech",
      fallback: "registered_fallback",
    } as const;
    const applied = run(
      "visual-apply",
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", initial.patch_hash,
    );
    expect(applied.input.caption_identity[0].requested_treatment).toMatchObject(operation);

    const current = inspectCaptionVisualTreatment(projectDir, { typographyPolicyPath: policyPath });
    appendCaptionVisualTreatmentOperations(projectDir, "human-editor", [{
      ...operation,
      anchor: "center",
    }], { typographyPolicyPath: policyPath, expectedPatchHash: current.patchHash });
    expect(() => runCaptionReviewCli([
      "node", "caption-review.ts", "visual-apply", "--project", projectDir,
      "--reviewer", "human-editor", "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", applied.patch_hash,
    ])).toThrow(/changed since it was loaded/);
  });

  it("rejects concurrent visual approval without writing the approval artifact", () => {
    const projectDir = createProject(["visual approval stale guard"]);
    const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.copyFileSync(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"), policyPath);
    initializeCaptionReviewPatch(projectDir, "human-editor");
    const item = queueCaptionReview(projectDir)[0];
    editCaptionReview(projectDir, { captionID: item.caption_id, state: "verified", expectedTextHash: item.text_hash });
    approveCaptionReview(projectDir, "human-editor");

    const run = (command: string, ...args: string[]) => {
      const output: string[] = [];
      expect(runCaptionReviewCli(["node", "caption-review.ts", command, "--project", projectDir, ...args], (message) => output.push(message))).toBe(0);
      return JSON.parse(output.join("\n")) as Record<string, any>;
    };
    run("visual-init", "--reviewer", "human-editor", "--typography-policy", policyPath);
    const initial = run("visual-status", "--typography-policy", policyPath);
    const operation = {
      caption_id: "SC_001",
      stable_root_id: "SC_001",
      anchor: "bottom_center",
      rect: { x: 0.1, y: 0.76, width: 0.8, height: 0.12 },
      style_ref: "sns-vertical-outline",
      hierarchy_role: "speech",
      fallback: "registered_fallback",
    } as const;
    const applied = run(
      "visual-apply",
      "--reviewer", "human-editor",
      "--typography-policy", policyPath,
      "--visual-operation-json", JSON.stringify(operation),
      "--expected-patch-hash", initial.patch_hash,
    );
    const candidate = run("visual-preview", "--reviewer", "human-editor", "--typography-policy", policyPath, "--expected-patch-hash", String(applied.patch_hash));
    const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
    const approvalBefore = fs.readFileSync(approvalPath, "utf8");
    const current = inspectCaptionVisualTreatment(projectDir, { typographyPolicyPath: policyPath });
    appendCaptionVisualTreatmentOperations(projectDir, "human-editor", [{
      ...operation,
      anchor: "center",
    }], { typographyPolicyPath: policyPath, expectedPatchHash: current.patchHash });

    expect(() => runCaptionReviewCli([
      "node", "caption-review.ts", "visual-approve", "--project", projectDir,
      "--reviewer", "human-editor", "--typography-policy", policyPath,
      "--expected-patch-hash", String(candidate.patch_hash),
      "--preapproval-receipt", String(candidate.receipt_path),
    ])).toThrow(/changed since it was loaded/);
    expect(fs.readFileSync(approvalPath, "utf8")).toBe(approvalBefore);
  });

  it("requires expected hash and exact preapproval receipt at the CLI approval boundary", () => {
    const prepare = () => {
      const projectDir = createProject(["visual approval evidence required"]);
      const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.copyFileSync(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"), policyPath);
      initializeCaptionReviewPatch(projectDir, "human-editor");
      const item = queueCaptionReview(projectDir)[0];
      editCaptionReview(projectDir, { captionID: item.caption_id, state: "verified", expectedTextHash: item.text_hash });
      approveCaptionReview(projectDir, "human-editor");
      const run = (command: string, ...args: string[]) => {
        const output: string[] = [];
        expect(runCaptionReviewCli(["node", "caption-review.ts", command, "--project", projectDir, ...args], (message) => output.push(message))).toBe(0);
        return JSON.parse(output.join("\n")) as Record<string, any>;
      };
      run("visual-init", "--reviewer", "human-editor", "--typography-policy", policyPath);
      const current = run("visual-status", "--typography-policy", policyPath);
      const candidate = run("visual-preview", "--reviewer", "human-editor", "--typography-policy", policyPath, "--expected-patch-hash", current.patch_hash);
      return { projectDir, policyPath, current, candidate, run, approvalPath: path.join(projectDir, "07_package/caption_approval.json") };
    };
    const rejectWithoutWrite = (fixture: ReturnType<typeof prepare>, args: string[], message: RegExp) => {
      const before = fs.readFileSync(fixture.approvalPath, "utf8");
      expect(() => runCaptionReviewCli(["node", "caption-review.ts", "visual-approve", "--project", fixture.projectDir, "--reviewer", "human-editor", "--typography-policy", fixture.policyPath, ...args])).toThrow(message);
      expect(fs.readFileSync(fixture.approvalPath, "utf8")).toBe(before);
    };

    const missingExpected = prepare();
    rejectWithoutWrite(missingExpected, ["--preapproval-receipt", String(missingExpected.candidate.receipt_path)], /expected-patch-hash/);

    const missingReceipt = prepare();
    rejectWithoutWrite(missingReceipt, ["--expected-patch-hash", String(missingReceipt.current.patch_hash)], /preapproval-receipt/);

    const staleHash = prepare();
    const staleCurrent = inspectCaptionVisualTreatment(staleHash.projectDir, { typographyPolicyPath: staleHash.policyPath });
    appendCaptionVisualTreatmentOperations(staleHash.projectDir, "human-editor", [{
      caption_id: "SC_001", stable_root_id: "SC_001", anchor: "center", style_ref: "sns-vertical-outline", fallback: "registered_fallback",
    }], { typographyPolicyPath: staleHash.policyPath, expectedPatchHash: staleCurrent.patchHash });
    rejectWithoutWrite(staleHash, ["--expected-patch-hash", String(staleHash.candidate.patch_hash), "--preapproval-receipt", String(staleHash.candidate.receipt_path)], /changed since it was loaded/);

    const mismatchedReceipt = prepare();
    const receipt = JSON.parse(fs.readFileSync(String(mismatchedReceipt.candidate.receipt_path), "utf8")) as Record<string, unknown>;
    receipt.input_hash = `sha256:${"0".repeat(64)}`;
    fs.writeFileSync(String(mismatchedReceipt.candidate.receipt_path), `${JSON.stringify(receipt, null, 2)}\n`);
    rejectWithoutWrite(mismatchedReceipt, ["--expected-patch-hash", String(mismatchedReceipt.current.patch_hash), "--preapproval-receipt", String(mismatchedReceipt.candidate.receipt_path)], /receipt/);

    const valid = prepare();
    const beforeValid = fs.readFileSync(valid.approvalPath, "utf8");
    expect(valid.run("visual-approve", "--reviewer", "human-editor", "--typography-policy", valid.policyPath, "--expected-patch-hash", String(valid.current.patch_hash), "--preapproval-receipt", String(valid.candidate.receipt_path))).toMatchObject({ command: "visual-approve", status: "ready" });
    expect(fs.readFileSync(valid.approvalPath, "utf8")).not.toBe(beforeValid);
  });

  it("validates integrated visual approval before approveCaptionReview writes its approval", () => {
    const prepare = () => {
      const projectDir = createProject(["integrated visual approval"]);
      const policyPath = path.join(projectDir, "04_plan/typography_policy.json");
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.copyFileSync(path.resolve("tests/fixtures/rfa-caption/typography-policy.json"), policyPath);
      initializeCaptionReviewPatch(projectDir, "human-editor");
      const item = queueCaptionReview(projectDir)[0];
      editCaptionReview(projectDir, { captionID: item.caption_id, state: "verified", expectedTextHash: item.text_hash });
      const approvedAt = "2026-08-21T01:00:00.000Z";
      approveCaptionReview(projectDir, "human-editor", { approvedAt });
      initializeCaptionVisualTreatmentPatch(projectDir, "human-editor", { typographyPolicyPath: policyPath });
      appendCaptionVisualTreatmentOperations(projectDir, "human-editor", [{
        caption_id: "SC_001", stable_root_id: "SC_001", anchor: "center", style_ref: "sns-vertical-outline", fallback: "registered_fallback",
      }], { typographyPolicyPath: policyPath });
      const current = inspectCaptionVisualTreatment(projectDir, { typographyPolicyPath: policyPath });
      const candidate = previewCaptionVisualTreatment(projectDir, "human-editor", { typographyPolicyPath: policyPath, expectedPatchHash: current.patchHash });
      return { projectDir, policyPath, approvedAt, current, candidate, approvalPath: path.join(projectDir, "07_package/caption_approval.json") };
    };
    const unchanged = (fixture: ReturnType<typeof prepare>, options: Parameters<typeof approveCaptionReview>[2], message: RegExp) => {
      const before = fs.readFileSync(fixture.approvalPath, "utf8");
      expect(() => approveCaptionReview(fixture.projectDir, "human-editor", options)).toThrow(message);
      expect(fs.readFileSync(fixture.approvalPath, "utf8")).toBe(before);
    };

    const missingReceipt = prepare();
    unchanged(missingReceipt, {
      approvedAt: missingReceipt.approvedAt,
      visualTreatment: { typographyPolicyPath: missingReceipt.policyPath, expectedPatchHash: missingReceipt.current.patchHash } as never,
    }, /preapprovalReceiptPath/);

    const staleHash = prepare();
    unchanged(staleHash, {
      approvedAt: staleHash.approvedAt,
      visualTreatment: {
        typographyPolicyPath: staleHash.policyPath,
        expectedPatchHash: `sha256:${"0".repeat(64)}`,
        preapprovalReceiptPath: staleHash.candidate.receiptPath,
      },
    }, /changed since it was loaded/);

    const mismatchedReceipt = prepare();
    const receipt = JSON.parse(fs.readFileSync(mismatchedReceipt.candidate.receiptPath, "utf8")) as Record<string, unknown>;
    receipt.input_hash = `sha256:${"0".repeat(64)}`;
    fs.writeFileSync(mismatchedReceipt.candidate.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    unchanged(mismatchedReceipt, {
      approvedAt: mismatchedReceipt.approvedAt,
      visualTreatment: {
        typographyPolicyPath: mismatchedReceipt.policyPath,
        expectedPatchHash: mismatchedReceipt.current.patchHash,
        preapprovalReceiptPath: mismatchedReceipt.candidate.receiptPath,
      },
    }, /receipt/);

    const valid = prepare();
    const beforeValid = fs.readFileSync(valid.approvalPath, "utf8");
    const approved = approveCaptionReview(valid.projectDir, "human-editor", {
      approvedAt: valid.approvedAt,
      visualTreatment: {
        typographyPolicyPath: valid.policyPath,
        expectedPatchHash: valid.current.patchHash,
        preapprovalReceiptPath: valid.candidate.receiptPath,
      },
    });
    expect(approved.visualTreatment).toBeDefined();
    expect(fs.readFileSync(valid.approvalPath, "utf8")).not.toBe(beforeValid);
  });

  it("initializes a hash-bound patch without overwriting human work", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    const result = initializeCaptionReviewPatch(projectDir, "editor", {
      now: "2026-07-14T10:00:00.000Z",
    });

    expect(result.patch.base_caption_draft_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.patch.base_timeline_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.patch.session.reviewer).toBe("editor");
    expect(() => initializeCaptionReviewPatch(projectDir, "other-editor")).toThrow(
      /already exists/,
    );
  });

  it("exports the Japanese phrase-break error in the risk queue", () => {
    const projectDir = createProject(["まだまだ聞きた\nいことがあります"]);
    const queue = queueCaptionReview(projectDir);

    expect(queue).toHaveLength(1);
    expect(queue[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unnatural_line_break", severity: "block" }),
    ]));

    const output: string[] = [];
    const exitCode = runCaptionReviewCli([
      "node",
      "caption-review.ts",
      "queue",
      "--project",
      projectDir,
      "--format",
      "csv",
      "--severity",
      "block",
    ], (message) => output.push(message));
    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("unnatural_line_break");
    expect(output.join("\n")).toContain("まだまだ聞きた");
  });

  it("applies corrections, validates every caption, and records approval provenance", () => {
    const projectDir = createProject([
      "まだまだ聞きた\nいことがあります",
      "今日はよろしくお願いします",
    ]);
    const { patch, patchPath } = initializeCaptionReviewPatch(projectDir, "editor", {
      now: "2026-07-14T10:00:00.000Z",
    });
    patch.operations = [
      {
        op: "set_line_break",
        caption_id: "SC_001",
        base_text_hash: computeCaptionTextHash("まだまだ聞きた\nいことがあります"),
        lines: ["まだまだ聞きたいことが", "あります"],
      },
      { op: "set_review_state", caption_id: "SC_001", state: "verified" },
      { op: "set_review_state", caption_id: "SC_002", state: "verified" },
    ];
    patch.session.updated_at = "2026-07-14T10:05:00.000Z";
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));

    const applied = applyCaptionReview(projectDir);
    expect(applied.preview.validation).toMatchObject({
      valid: true,
      blocking_issue_count: 0,
      unreviewed_count: 0,
      verified_count: 2,
    });
    expect(fs.existsSync(applied.previewPath)).toBe(true);
    expect(validateCaptionReview(projectDir).valid).toBe(true);

    const approved = approveCaptionReview(projectDir, "human-editor", {
      approvedAt: "2026-07-14T10:06:00.000Z",
    });
    expect(approved.approval.approval).toMatchObject({
      status: "approved",
      approved_by: "human-editor",
      base_caption_draft_hash: patch.base_caption_draft_hash,
      caption_review_patch_hash: approved.patchHash,
      validation_hash: approved.validationHash,
    });
    expect(approved.approval.speech_captions[0].text).toBe("まだまだ聞きたいことが\nあります");
    expect(approved.approval.speech_captions[0]).not.toHaveProperty("review");
    expect(fs.existsSync(approved.approvalPath)).toBe(true);
  });

  it("refuses approval while captions are unreviewed", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "editor");

    expect(() => approveCaptionReview(projectDir, "human-editor")).toThrow(
      /unreviewed_captions/,
    );
    expect(fs.existsSync(path.join(projectDir, "07_package/caption_approval.json"))).toBe(false);
  });

  it("returns recovery metadata and restores a missing draft without touching existing review artifacts", () => {
    const projectDir = createProject(["保全される字幕です"]);
    const draftPath = path.join(projectDir, "07_package/caption_draft.json");
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    fs.writeFileSync(path.join(projectDir, "STYLE.md"), "# Preserved caption style\n");
    initializeCaptionReviewPatch(projectDir, "editor");
    const patchPath = path.join(projectDir, "07_package/caption_review_patch.json");
    const patchBefore = fs.readFileSync(patchPath, "utf8");
    fs.rmSync(draftPath);

    const state = inspectCaptionReviewOperationalState(projectDir, "editor");
    expect(state).toMatchObject({
      status: "needs_recovery",
      recoveryAction: { code: "prepare_caption_draft", safe_to_run: true },
    });
    const recovered = prepareCaptionReviewDraft(projectDir, (stagingDir) => {
      expect(fs.existsSync(path.join(path.dirname(stagingDir), "schemas"))).toBe(true);
      expect(fs.readFileSync(path.join(stagingDir, "STYLE.md"), "utf8")).toBe(
        "# Preserved caption style\n",
      );
      fs.writeFileSync(
        path.join(stagingDir, "07_package/caption_draft.json"),
        JSON.stringify(draft, null, 2),
      );
      return { success: true, captionDraft: draft };
    });
    expect(recovered.draftHash).toBe(computeCaptionDraftHash(draft));
    expect(fs.readFileSync(patchPath, "utf8")).toBe(patchBefore);
  });

  it("refuses recovery hash drift atomically while preserving protected review artifacts", () => {
    const projectDir = createProject(["元の字幕です"]);
    const draftPath = path.join(projectDir, "07_package/caption_draft.json");
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    initializeCaptionReviewPatch(projectDir, "editor");
    const patchPath = path.join(projectDir, "07_package/caption_review_patch.json");
    const patchBefore = fs.readFileSync(patchPath, "utf8");
    fs.rmSync(draftPath);
    const changed = structuredClone(draft);
    changed.speech_captions[0].text = "一致しない字幕です";

    expect(() => prepareCaptionReviewDraft(projectDir, (stagingDir) => {
      fs.writeFileSync(path.join(stagingDir, "07_package/caption_draft.json"), JSON.stringify(changed));
      return { success: true, captionDraft: changed };
    })).toThrow(/hash mismatch/);
    expect(fs.existsSync(draftPath)).toBe(false);
    expect(fs.readFileSync(patchPath, "utf8")).toBe(patchBefore);
  });

  it("bulk verifies safe and layout-warning captions as one undoable atomic action", () => {
    const projectDir = createProject([
      "安全な字幕です",
      "これは一行二十文字を超えても一括確認できる字幕テキストです",
      "Tomyは42回参加しないと言いました",
    ]);
    initializeCaptionReviewPatch(projectDir, "editor");
    const state = inspectCaptionReviewOperationalState(projectDir, "editor");
    const hashes = Object.fromEntries(state.items.map((item) => [item.caption_id, item.text_hash]));
    const result = verifySafeCaptionReview(projectDir, {
      reviewer: "editor",
      baseCaptionDraftHash: state.baseCaptionDraftHash!,
      captionTextHashes: hashes,
    });
    expect(result.assessment.eligible_caption_ids).toEqual(["SC_001", "SC_002"]);
    expect(result.preview.speech_captions.filter((entry) => entry.review.state === "verified")).toHaveLength(2);
    expect(captionReviewUndoDepth(projectDir)).toBe(1);
    expect(undoCaptionReview(projectDir).preview.validation.verified_count).toBe(0);

    const patchPath = path.join(projectDir, "07_package/caption_review_patch.json");
    const before = fs.readFileSync(patchPath, "utf8");
    expect(() => verifySafeCaptionReview(projectDir, {
      reviewer: "editor",
      baseCaptionDraftHash: state.baseCaptionDraftHash!,
      captionTextHashes: { ...hashes, SC_001: `sha256:${"0".repeat(64)}` },
    })).toThrow(/stale/);
    expect(fs.readFileSync(patchPath, "utf8")).toBe(before);
  });

  it("allows approval when a verified caption only exceeds the line-length guide", () => {
    const projectDir = createProject([
      "これは一行二十文字を超えても人が承認できる字幕テキストです",
    ]);
    initializeCaptionReviewPatch(projectDir, "editor");
    const caption = queueCaptionReview(projectDir)[0];
    const edited = editCaptionReview(projectDir, {
      captionID: caption.caption_id,
      state: "verified",
      expectedTextHash: caption.text_hash,
    });

    expect(edited.preview.speech_captions[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "line_too_long", severity: "warn" }),
    ]));
    expect(edited.preview.validation).toMatchObject({
      valid: true,
      blocking_issue_count: 0,
      unreviewed_count: 0,
    });
    fs.writeFileSync(path.join(projectDir, "07_package/caption_review_preview.json"), JSON.stringify({
      ...edited.preview,
      speech_captions: edited.preview.speech_captions.map((entry) => ({
        ...entry,
        issues: entry.issues.map((issue) => issue.code === "line_too_long" ? { ...issue, severity: "block" } : issue),
      })),
    }));
    expect(() => approveCaptionReview(projectDir, "human-editor")).not.toThrow();
    const restored = inspectCaptionReviewOperationalState(projectDir, "human-editor");
    expect(restored.currentApproval).toMatchObject({ status: "approved" });
    expect(restored.approvalReadiness.can_approve).toBe(true);

    const approvalPath = path.join(projectDir, "07_package/caption_approval.json");
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
    approval.approval.validation_hash = `sha256:${"0".repeat(64)}`;
    fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
    const stale = inspectCaptionReviewOperationalState(projectDir, "human-editor");
    expect(stale.currentApproval).toBeUndefined();
    expect(stale.approvalWarning).toMatchObject({ code: "stale_approval" });
    expect(stale.approvalReadiness.can_approve).toBe(true);
    const reapproved = approveCaptionReview(projectDir, "human-editor-2");
    expect(reapproved.approvalHash).not.toBe(restored.currentApproval?.hash);
    expect(inspectCaptionReviewOperationalState(projectDir, "human-editor-2").currentApproval)
      .toMatchObject({ status: "approved", hash: reapproved.approvalHash });
  });

  it("edits through the shared adapter and returns the patched queue state", () => {
    const projectDir = createProject(["聞きた\nいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");

    const result = editCaptionReview(projectDir, {
      captionID: "SC_001",
      text: "聞きたいことが\nあります",
      state: "verified",
      category: "stt",
      updatedAt: "2026-07-14T11:00:00.000Z",
    });
    expect(result.preview.speech_captions[0]).toMatchObject({
      text: "聞きたいことが\nあります",
      review: { state: "verified", edited: true },
    });
    expect(result.preview.speech_captions[0].text_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const queue = queueCaptionReview(projectDir);
    expect(queue[0]).toMatchObject({
      caption_id: "SC_001",
      text: "聞きたいことが\nあります",
      source_text: "聞きたいことがあります",
      review_state: "verified",
    });
    expect(queue[0].issues.map((issue) => issue.code)).not.toContain("unnatural_line_break");
  });

  it("adjusts timing with stale-edit protection and multi-level action undo", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");
    const initial = queueCaptionReview(projectDir)[0];

    const edited = editCaptionReview(projectDir, {
      captionID: initial.caption_id,
      text: "まだ聞きたいことがあります",
      state: "unreviewed",
      startFrame: 6,
      endFrame: 78,
      expectedTextHash: initial.text_hash,
      updatedAt: "2026-07-14T11:10:00.000Z",
    });
    expect(edited.patch.session.last_action_operation_count).toBe(3);
    expect(edited.patch.session.action_operation_counts).toEqual([3]);
    expect(edited.preview.speech_captions[0]).toMatchObject({
      timeline_in_frame: 6,
      timeline_duration_frames: 72,
      text: "まだ聞きたいことがあります",
    });
    expect(() => editCaptionReview(projectDir, {
      captionID: initial.caption_id,
      text: "古い画面から上書き",
      expectedTextHash: initial.text_hash,
    })).toThrow(/changed since it was loaded/);

    const current = edited.preview.speech_captions[0];
    editCaptionReview(projectDir, {
      captionID: current.caption_id,
      text: "さらに聞きたいことがあります",
      expectedTextHash: current.text_hash,
      updatedAt: "2026-07-14T11:10:30.000Z",
    });
    expect(captionReviewUndoDepth(projectDir)).toBe(2);

    const firstUndo = undoCaptionReview(projectDir, "2026-07-14T11:11:00.000Z");
    expect(firstUndo.preview.speech_captions[0]).toMatchObject({
      timeline_in_frame: 6,
      timeline_duration_frames: 72,
      text: "まだ聞きたいことがあります",
    });
    expect(firstUndo.patch.session.action_operation_counts).toEqual([3]);
    expect(captionReviewUndoDepth(projectDir)).toBe(1);

    const secondUndo = undoCaptionReview(projectDir, "2026-07-14T11:12:00.000Z");
    expect(secondUndo.preview.speech_captions[0]).toMatchObject({
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
      text: "聞きたいことがあります",
    });
    expect(secondUndo.patch.session.action_operation_counts).toEqual([]);
    expect(secondUndo.patch.session.last_action_operation_count).toBe(0);
    expect(captionReviewUndoDepth(projectDir)).toBe(0);
  });

  it("promotes a human correction to a reversible glossary proposal", () => {
    const projectDir = createProject(["富井のイベントです"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");

    const proposed = proposeCaptionGlossaryTerm(projectDir, {
      canonical: "Tomy",
      variants: ["富井", " 富井 "],
      sourceCaptionIDs: ["SC_001"],
      updatedAt: "2026-07-14T11:20:00.000Z",
    });
    expect(proposed.preview.glossary_proposals).toEqual([{
      canonical: "Tomy",
      variants: ["富井"],
      source_caption_ids: ["SC_001"],
    }]);
    expect(captionReviewUndoDepth(projectDir)).toBe(1);

    const output: string[] = [];
    expect(runCaptionReviewCli([
      "node", "caption-review.ts", "queue",
      "--project", projectDir,
      "--format", "json",
      "--severity", "all",
    ], (message) => output.push(message))).toBe(0);
    const queueDocument = JSON.parse(output.join("\n"));
    expect(validateAgainstSchema(queueDocument, "caption-review-queue.schema.json")).toEqual({ valid: true, errors: [] });
    expect(queueDocument).toMatchObject({
      undo_depth: 1,
      glossary_proposals: [{ canonical: "Tomy", variants: ["富井"] }],
      caption_style: {
        preset_id: "longform-event",
        font_id: "noto-sans-jp",
        font_family: "VideoOS Noto Sans JP Bold",
        font_size_px_1080: 56,
        line_height_px_1080: 70,
        outline_px_1080: 4,
        margin_v_1080: 48,
        max_width_ratio: 0.9,
        alignment: "bottom_center",
      },
    });

    const undone = undoCaptionReview(projectDir);
    expect(undone.preview.glossary_proposals).toEqual([]);
  });

  it("splits and merges adjacent captions through canonical operations", () => {
    const projectDir = createProject(["前半です。後半です", "次の字幕です"]);
    initializeCaptionReviewPatch(projectDir, "Studio editor");
    const initial = queueCaptionReview(projectDir);

    const split = splitCaptionReview(projectDir, {
      captionID: "SC_001",
      splitFrame: 36,
      expectedTextHash: initial[0].text_hash,
    });
    expect(split.preview.speech_captions.slice(0, 2)).toMatchObject([
      { caption_id: "SC_001_A", text: "前半です。", timeline_in_frame: 0, timeline_duration_frames: 36 },
      { caption_id: "SC_001_B", text: "後半です", timeline_in_frame: 36, timeline_duration_frames: 36 },
    ]);

    const splitQueue = queueCaptionReview(projectDir)
      .sort((a, b) => a.timeline_in_frame - b.timeline_in_frame);
    const merged = mergeCaptionReview(projectDir, {
      firstCaptionID: "SC_001_A",
      secondCaptionID: "SC_001_B",
      expectedFirstTextHash: splitQueue[0].text_hash,
      expectedSecondTextHash: splitQueue[1].text_hash,
    });
    expect(merged.preview.speech_captions[0]).toMatchObject({
      caption_id: "SC_001_A",
      text: "前半です。後半です",
      timeline_in_frame: 0,
      timeline_duration_frames: 72,
    });
  });

  it("retimes a verified review to speech onset and keeps silence on the prior caption", () => {
    const projectDir = createProject(["前の発言", "どう思いますか？"]);
    const draftPath = path.join(projectDir, "07_package/caption_draft.json");
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    draft.caption_policy.semantic_timing = {
      mode: "speech_sync",
      ordinary_lead_frames: 2,
      question_audio_first_frames: 0,
      gap_ownership: "previous",
    };
    draft.speech_captions[0].timeline_in_frame = 0;
    draft.speech_captions[0].timeline_duration_frames = 24;
    draft.speech_captions[1].timeline_in_frame = 34;
    draft.speech_captions[1].timeline_duration_frames = 38;
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));
    fs.mkdirSync(path.join(projectDir, "03_analysis/transcripts"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "03_analysis/transcripts/TR_001.json"), JSON.stringify({
      version: "2.0.0",
      asset_id: "AST_001",
      language: "ja",
      word_timing_mode: "word",
      items: [
        {
          item_id: "TI_1",
          start_us: 0,
          end_us: 1_000_000,
          text: "前の発言",
          words: [{ word: "前の発言", start_us: 0, end_us: 1_000_000 }],
        },
        {
          item_id: "TI_2",
          start_us: 1_500_000,
          end_us: 2_500_000,
          text: "どう思いますか？",
          words: [
            { word: "どう", start_us: 1_500_000, end_us: 1_700_000 },
            { word: "思います", start_us: 1_700_000, end_us: 2_300_000 },
            { word: "か", start_us: 2_300_000, end_us: 2_500_000 },
          ],
        },
      ],
    }, null, 2));
    const { patchPath, patch } = initializeCaptionReviewPatch(projectDir, "editor");
    patch.operations.push(
      { op: "set_review_state", caption_id: "SC_001", state: "verified" },
      { op: "set_review_state", caption_id: "SC_002", state: "verified" },
    );
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));

    const output: string[] = [];
    expect(runCaptionReviewCli([
      "node", "caption-review.ts", "retime",
      "--project", projectDir,
      "--reviewer", "editor",
    ], (message) => output.push(message))).toBe(0);
    const result = JSON.parse(output.join("\n"));
    expect(result).toMatchObject({
      command: "retime",
      adjusted_caption_count: 2,
      timing_report: {
        question_caption_count: 1,
        question_adjusted_count: 0,
        gap_tail_hold_count: 1,
        unresolved_count: 0,
      },
      validation: { valid: true, verified_count: 2 },
    });
    const preview = JSON.parse(fs.readFileSync(result.preview_path, "utf8"));
    expect(preview.speech_captions).toMatchObject([
      { caption_id: "SC_001", timeline_in_frame: 0, timeline_duration_frames: 35 },
      { caption_id: "SC_002", timeline_in_frame: 36, timeline_duration_frames: 24 },
    ]);
  });

  it("rejects a stale patch after the timeline changes", () => {
    const projectDir = createProject(["聞きたいことがあります"]);
    initializeCaptionReviewPatch(projectDir, "editor");
    const timelinePath = path.join(projectDir, "05_timeline/timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    timeline.sequence.name = "changed after review started";
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

    const result = validateCaptionReview(projectDir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/base_timeline_hash/);
  });

  it("parses the explicit headless commands", () => {
    const args = parseCaptionReviewArgs([
      "node",
      "caption-review.ts",
      "approve",
      "--project",
      "/tmp/project",
      "--reviewer",
      "Sakamoto",
    ]);
    expect(args.command).toBe("approve");
    expect(args.reviewer).toBe("Sakamoto");
    expect(() => parseCaptionReviewArgs([
      "node",
      "caption-review.ts",
      "approve",
      "--project",
      "/tmp/project",
    ])).toThrow(/--reviewer is required/);

    const edit = parseCaptionReviewArgs([
      "node",
      "caption-review.ts",
      "edit",
      "--project",
      "/tmp/project",
      "--caption-id",
      "SC_001",
      "--text",
      "修正文",
      "--state",
      "verified",
    ]);
    expect(edit).toMatchObject({
      command: "edit",
      captionID: "SC_001",
      text: "修正文",
      state: "verified",
    });

    const glossary = parseCaptionReviewArgs([
      "node", "caption-review.ts", "glossary-propose",
      "--project", "/tmp/project",
      "--caption-id", "SC_001",
      "--canonical", "Tomy",
      "--variant", "富井",
    ]);
    expect(glossary).toMatchObject({
      command: "glossary-propose",
      captionID: "SC_001",
      canonical: "Tomy",
      variants: ["富井"],
    });
  });
});

function createProject(texts: string[], renderable = false): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-review-cli-"));
  temporaryDirectories.push(projectDir);
  fs.mkdirSync(path.join(projectDir, "05_timeline"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "07_package"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "05_timeline/timeline.json"), JSON.stringify({
    version: "1",
    project_id: "caption-review-test",
    sequence: {
      name: "Caption review test",
      fps_num: 24,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
      output_aspect_ratio: "16:9",
    },
    tracks: {
      video: renderable ? [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "VCL_001",
          asset_id: "AST_001",
          segment_id: "SEG_001",
          role: "hero",
          src_in_us: 0,
          src_out_us: 4_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: 96,
          beat_id: "b01",
          motivation: "synthetic canonical preview fixture",
          fallback_segment_ids: [],
          confidence: 1,
          quality_flags: [],
        }],
      }] : [],
      audio: [{
        track_id: "A1",
        kind: "audio",
        role: "dialogue",
        clips: [{
          clip_id: "ACL_001",
          asset_id: "AST_001",
          segment_id: "SEG_001",
          role: "dialogue",
          src_in_us: 0,
          src_out_us: renderable ? 4_000_000 : 10_000_000,
          timeline_in_frame: 0,
          timeline_duration_frames: renderable ? 96 : 240,
          motivation: "synthetic canonical preview fixture",
        }],
      }],
    },
    provenance: {
      brief_path: "04_plan/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "issue16-test",
    },
  }, null, 2));
  if (renderable) {
    const mediaDir = path.join(projectDir, "02_media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const sourcePath = path.join(mediaDir, "caption-preview-fixture.mp4");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
    ], { stdio: "ignore" });
    fs.writeFileSync(path.join(mediaDir, "source_map.json"), JSON.stringify({
      version: "1",
      project_id: "caption-review-test",
      media_dir: "02_media",
      generated_at: "2026-08-24T00:00:00.000Z",
      items: [{
        asset_id: "AST_001",
        source_locator: sourcePath,
        local_source_path: sourcePath,
        link_path: "02_media/caption-preview-fixture.mp4",
        source_content_sha256: computeSha256(sourcePath).slice("sha256:".length),
      }],
    }));
  }
  fs.writeFileSync(path.join(projectDir, "07_package/caption_draft.json"), JSON.stringify({
    version: "1.0",
    project_id: "caption-review-test",
    base_timeline_version: "1",
    caption_policy: {
      language: "ja",
      delivery_mode: "both",
      source: "transcript",
      styling_class: "longform-event",
    },
    speech_captions: texts.map((text, index) => ({
      caption_id: `SC_${String(index + 1).padStart(3, "0")}`,
      asset_id: "AST_001",
      segment_id: `SEG_${String(index + 1).padStart(3, "0")}`,
      timeline_in_frame: index * 72,
      timeline_duration_frames: 72,
      text,
      transcript_ref: "TR_001",
      transcript_item_ids: [`TI_${index + 1}`],
      source: "transcript",
      styling_class: "longform-event",
      metrics: { cps: 4, dwell_ms: 3000 },
      editorial: {
        sourceText: text.replace(/\n/g, ""),
        operations: [],
        glossaryHits: [],
        confidence: 1,
        status: "clean",
      },
      timing: {
        source: "clip_item_remap",
        confidence: 1,
        triggeredFallback: false,
        timelineInFrame: index * 72,
        timelineDurationFrames: 72,
      },
    })),
    text_overlays: [],
    draft_status: "ready_for_human_approval",
    degraded_count: 0,
  }, null, 2));
  return projectDir;
}
