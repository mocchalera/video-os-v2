import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  CAPTION_FINALIZE_CONTRACT_VERSION,
  computeGenerationKey,
  runCaptionFinalize,
  resolveStagedFontManifestPaths,
  type CaptionFinalizeStageContext,
} from "../runtime/caption/caption-finalize.js";
import { writeApprovedCaptionDeliveryArtifacts } from "../runtime/caption/delivery-artifacts.js";
import {
  InvalidActiveDeliveryPointerError,
  resolveDeliveryArtifactPaths,
  type ActiveDelivery,
} from "../runtime/packaging/active-delivery.js";
import { buildQaReport } from "../runtime/packaging/qa.js";
import { buildNleFinishingManifest } from "../runtime/packaging/manifest.js";
import { computeFileHash } from "../runtime/state/reconcile.js";
import {
  buildDirectRenderRepairPlan,
  stageDirectRenderOutput,
} from "../runtime/render/direct-render-staging.js";
import { packageCommand } from "../runtime/commands/package.js";
import { validateAgainstSchema } from "../runtime/commands/shared.js";
import { verifyExistingPackage } from "../runtime/packaging/package-verification.js";
import { runPublicationPreflight } from "../runtime/packaging/publication-preflight.js";
import { buildPackagePreflight } from "../scripts/package.js";
import { parseCaptionFinalizeArgs, runCaptionFinalizeCli } from "../scripts/caption-finalize.js";
import { approveFinalRenderChecklist } from "../runtime/packaging/final-render-approval.js";
import { writeValidFinalRenderReviewPack } from "./helpers/final-render-review.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("caption-finalize transaction", () => {
  it("keeps legacy v1 receipts schema-valid without v2 font fields", () => {
    const hash = `sha256:${"0".repeat(64)}`;
    const artifact = { path: "07_package/legacy.bin", sha256: hash };
    const receipt = {
      version: "caption-finalize-receipt/v1",
      project_id: "legacy",
      generation_id: "111111111111111111111111",
      generation_key: hash,
      approval_sha256: hash,
      timeline_sha256: hash,
      created_at: "2026-07-23T00:00:00Z",
      artifacts: {
        approval_intent: artifact,
        caption_ass: artifact,
        caption_srt: artifact,
        final_video: { ...artifact, size_bytes: 1, mtime_ms: 1 },
        qa_report: artifact,
        package_manifest: artifact,
        preview: { ...artifact, size_bytes: 1, mtime_ms: 1 },
        preview_receipt: artifact,
      },
      verification: {
        qa_passed: true,
        package_ready: true,
        package_preflight_version: "package-preflight/v2",
        package_preflight_decision: "ready_to_run",
      },
    };
    expect(validateAgainstSchema(receipt, "caption-finalize-receipt.schema.json").valid).toBe(true);
  });

  it("binds v2 and the selected font identity into the generation key", () => {
    const projectDir = createProject();
    const hash = `sha256:${"a".repeat(64)}`;
    const base = {
      approvalSha256: hash,
      timelineSha256: hash,
      finalRenderApprovalSha256: `sha256:${"e".repeat(64)}`,
      fontPrimarySha256: `sha256:${"b".repeat(64)}`,
      fontAssBoldSha256: `sha256:${"d".repeat(64)}`,
      fontAssHeavySha256: `sha256:${"c".repeat(64)}`,
      fontSelectedFamily: "VideoOS Noto Sans JP Black",
      fontSelectedRole: "ass_heavy" as const,
      fontSelectedSha256: `sha256:${"c".repeat(64)}`,
    };
    expect(CAPTION_FINALIZE_CONTRACT_VERSION).toBe("v4");
    expect(computeGenerationKey(projectDir, base)).not.toBe(computeGenerationKey(projectDir, {
      ...base,
      fontSelectedFamily: "Noto Sans JP",
      fontSelectedRole: "primary",
      fontSelectedSha256: `sha256:${"b".repeat(64)}`,
    }));
  });

  it("keeps a legacy v1 generation while explicit finalize creates a font-bound v2 generation", async () => {
    const projectDir = createProject();
    const legacyID = "111111111111111111111111";
    const legacyDir = path.join(projectDir, "07_package/caption-finalize/generations", legacyID);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "caption-finalize-receipt.json"), JSON.stringify({
      version: "caption-finalize-receipt/v1",
      generation_id: legacyID,
    }));

    const result = await runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() });
    expect(result.generationId).not.toBe(legacyID);
    expect(result.receipt.version).toBe("caption-finalize-receipt/v4");
    expect(result.receipt.final_render_approval_sha256).toMatch(/^sha256:/);
    expect(result.receipt.generation_key).toMatch(/^sha256:/);
    expect(result.receipt.font_contract).toMatchObject({
      status: "ready",
      fallback_used: false,
      family: "VideoOS Noto Sans JP Black",
      selected_family: "VideoOS Noto Sans JP Black",
      selected_asset: {
        role: "ass_heavy",
        family: "VideoOS Noto Sans JP Black",
        weight: 900,
      },
    });
    expect(result.receipt.font_contract?.selected_asset?.sha256)
      .toBe(result.receipt.font_contract?.ass_heavy?.sha256);
    const stagedManifest = JSON.parse(fs.readFileSync(
      path.join(result.generationDir, "font-manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(stagedManifest).toMatchObject({
      version: "font-staging-manifest/v3",
      family: "Noto Sans JP",
      selected_family: "VideoOS Noto Sans JP Black",
      selected_asset: { role: "ass_heavy", weight: 900 },
    });
    expect(fs.readFileSync(path.join(result.generationDir, "captions/speech.ass"), "utf8"))
      .toMatch(/Style: Default,VideoOS Noto Sans JP Black,[^\n]*,0,0,0,0,100,100/);
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it("resolves staged font assets from the manifest instead of fixed filenames", () => {
    const generationDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-finalize-font-paths-"));
    tempDirs.push(generationDir);
    fs.mkdirSync(path.join(generationDir, "fonts"), { recursive: true });
    fs.writeFileSync(path.join(generationDir, "fonts/future-primary.otf"), "primary");
    fs.writeFileSync(path.join(generationDir, "fonts/future-bold.otf"), "bold");
    fs.writeFileSync(path.join(generationDir, "fonts/future-heavy.otf"), "heavy");
    fs.writeFileSync(path.join(generationDir, "font-manifest.json"), JSON.stringify({
      assets: [
        { role: "primary", path: "fonts/future-primary.otf" },
        { role: "ass_bold", path: "fonts/future-bold.otf" },
        { role: "ass_heavy", path: "fonts/future-heavy.otf" },
      ],
    }));

    expect(resolveStagedFontManifestPaths(generationDir)).toEqual({
      manifest: path.join(generationDir, "font-manifest.json"),
      primary: path.join(generationDir, "fonts/future-primary.otf"),
      assBold: path.join(generationDir, "fonts/future-bold.otf"),
      assHeavy: path.join(generationDir, "fonts/future-heavy.otf"),
    });
    fs.writeFileSync(path.join(generationDir, "font-manifest.json"), JSON.stringify({
      assets: [
        { role: "primary", path: "../escaped.ttf" },
        { role: "ass_bold", path: "fonts/future-bold.otf" },
        { role: "ass_heavy", path: "fonts/future-heavy.otf" },
      ],
    }));
    expect(() => resolveStagedFontManifestPaths(generationDir)).toThrow(/escaped generation/);
  });

  it("blocks before the stage runner when final render approval is missing", async () => {
    const projectDir = createProject();
    fs.rmSync(path.join(projectDir, "06_review", "final-render-approval.json"));
    const stageRunner = vi.fn(fixtureStageRunner());

    await expect(runCaptionFinalize(projectDir, {}, { stageRunner }))
      .rejects.toThrow("final render approval is missing");
    expect(stageRunner).not.toHaveBeenCalled();
  });

  it("atomically advances every caption-bound hash and retains the previous generation", async () => {
    const projectDir = createProject();
    const first = await runCaptionFinalize(projectDir, { createdAt: "2026-07-23T00:00:00Z" }, {
      stageRunner: fixtureStageRunner(),
    });
    const firstHashes = activeHashes(first.activeDelivery);
    const firstIntent = first.activeDelivery.approval_intent.path;

    updateCaption(projectDir, "一文字だけ変更A");
    const second = await runCaptionFinalize(projectDir, { createdAt: "2026-07-23T00:01:00Z" }, {
      stageRunner: fixtureStageRunner(),
    });

    expect(second.generationId).not.toBe(first.generationId);
    expect(second.activeDelivery.approval_intent.path).not.toBe(firstIntent);
    expect(fs.existsSync(first.generationDir)).toBe(true);
    expect(fs.readFileSync(path.join(first.generationDir, "video/final.mp4"), "utf8"))
      .toContain("最初の字幕");
    for (const [name, hash] of Object.entries(firstHashes)) {
      expect(activeHashes(second.activeDelivery)[name], `${name} should refresh`).not.toBe(hash);
    }
    expect(fs.statSync(path.resolve(projectDir, firstIntent)).mode & 0o222).toBe(0);
    expect(resolveDeliveryArtifactPaths(projectDir, { verifyHashes: true }).finalVideoPath)
      .toBe(path.join(second.generationDir, "video", "final.mp4"));
    expect(validateAgainstSchema(second.activeDelivery, "active-delivery.schema.json").valid).toBe(true);
    expect(validateAgainstSchema(second.receipt, "caption-finalize-receipt.schema.json").valid).toBe(true);
  });

  it("preserves the active generation after stage, preflight, and activation write failures", async () => {
    const projectDir = createProject();
    const first = await runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() });
    const pointerBefore = fs.readFileSync(first.activeDeliveryPath);

    updateCaption(projectDir, "stage failure");
    await expect(runCaptionFinalize(projectDir, {}, {
      stageRunner: async () => { throw new Error("fixture stage failed"); },
    })).rejects.toThrow("fixture stage failed");
    expect(fs.readFileSync(first.activeDeliveryPath)).toEqual(pointerBefore);

    updateCaption(projectDir, "preflight failure");
    await expect(runCaptionFinalize(projectDir, {}, {
      stageRunner: fixtureStageRunner(),
      packagePreflight: () => ({
        version: "package-preflight/v2",
        decision: "blocked",
        issues: ["fixture blocked"],
      }),
    })).rejects.toThrow("package-preflight/v2 failed");
    expect(fs.readFileSync(first.activeDeliveryPath)).toEqual(pointerBefore);

    updateCaption(projectDir, "disk failure");
    await expect(runCaptionFinalize(projectDir, {}, {
      stageRunner: fixtureStageRunner(),
      activate: () => { throw new Error("ENOSPC fixture"); },
    })).rejects.toThrow("ENOSPC fixture");
    expect(fs.readFileSync(first.activeDeliveryPath)).toEqual(pointerBefore);
    expect(resolveDeliveryArtifactPaths(projectDir).activeDelivery?.generation_id).toBe(first.generationId);
    const recovered = await runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() });
    expect(recovered.reused).toBe(true);
    expect(recovered.generationId).not.toBe(first.generationId);
    expect(fs.existsSync(first.generationDir)).toBe(true);
  });

  it("retries a failed generation and idempotently reuses the completed approval/hash", async () => {
    const projectDir = createProject();
    const stage = vi.fn(fixtureStageRunner());
    let attempts = 0;
    await expect(runCaptionFinalize(projectDir, {}, {
      stageRunner: stage,
      packagePreflight: () => ({
        version: "package-preflight/v2",
        decision: attempts++ === 0 ? "blocked" : "ready_to_run",
        issues: attempts === 1 ? ["retry"] : [],
      }),
    })).rejects.toThrow("package-preflight/v2 failed");

    const completed = await runCaptionFinalize(projectDir, {}, { stageRunner: stage });
    const activeBeforeBlockedRetry = fs.readFileSync(completed.activeDeliveryPath);
    await expect(runCaptionFinalize(projectDir, {}, {
      stageRunner: stage,
      packagePreflight: () => ({
        version: "package-preflight/v2",
        decision: "blocked",
        issues: ["transient policy block"],
      }),
    })).rejects.toThrow("refuses to replace generation referenced by the active pointer");
    expect(fs.readFileSync(completed.activeDeliveryPath)).toEqual(activeBeforeBlockedRetry);
    expect(fs.existsSync(completed.generationDir)).toBe(true);
    const reused = await runCaptionFinalize(projectDir, {}, { stageRunner: stage });
    expect(completed.reused).toBe(false);
    expect(reused.reused).toBe(true);
    expect(reused.generationId).toBe(completed.generationId);
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a completed generation after receipt downgrade", async () => {
    const projectDir = createProject();
    const stage = vi.fn(fixtureStageRunner());
    const completed = await runCaptionFinalize(projectDir, {}, { stageRunner: stage });
    fs.rmSync(completed.activeDeliveryPath);
    const receiptPath = path.join(completed.generationDir, "caption-finalize-receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.version = "caption-finalize-receipt/v1";
    delete receipt.final_render_approval_sha256;
    delete receipt.font_contract;
    writeJson(receiptPath, receipt);

    const rebuilt = await runCaptionFinalize(projectDir, {}, { stageRunner: stage });

    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.generationId).toBe(completed.generationId);
    expect(rebuilt.receipt.version).toBe("caption-finalize-receipt/v4");
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a generation whose staged font identity was rewritten", async () => {
    const projectDir = createProject();
    const stage = vi.fn(fixtureStageRunner());
    const completed = await runCaptionFinalize(projectDir, {}, { stageRunner: stage });
    fs.rmSync(completed.activeDeliveryPath);
    const manifestPath = path.join(completed.generationDir, "font-manifest.json");
    const receiptPath = path.join(completed.generationDir, "caption-finalize-receipt.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.selected_family = "Noto Sans JP";
    manifest.selected_asset.family = "Noto Sans JP";
    writeJson(manifestPath, manifest);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.font_contract.family = "Noto Sans JP";
    receipt.font_contract.selected_family = "Noto Sans JP";
    receipt.font_contract.selected_asset.family = "Noto Sans JP";
    receipt.artifacts.font_manifest.sha256 = computeFileHash(manifestPath);
    writeJson(receiptPath, receipt);

    const rebuilt = await runCaptionFinalize(projectDir, {}, { stageRunner: stage });

    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.receipt.font_contract?.selected_family)
      .toBe("VideoOS Noto Sans JP Black");
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it("uses legacy paths only when the pointer is absent and fails closed when it is invalid", () => {
    const projectDir = createProject();
    const legacyFinal = path.join(projectDir, "09_output", "final.mp4");
    writeFile(legacyFinal, "legacy-final");
    expect(resolveDeliveryArtifactPaths(projectDir).source).toBe("legacy");
    writeJson(path.join(projectDir, "07_package", "active_delivery.json"), {
      version: "active-delivery/v1",
      generation_id: "broken",
    });
    expect(() => resolveDeliveryArtifactPaths(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
    expect(fs.readFileSync(legacyFinal, "utf8")).toBe("legacy-final");
  });

  it("requires explicit human approval identity before persisting an intent", async () => {
    const projectDir = createProject();
    const approvalPath = path.join(projectDir, "07_package", "caption_approval.json");
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
    delete approval.approval.approved_by;
    writeJson(approvalPath, approval);

    await expect(runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() }))
      .rejects.toThrow("human approved_by");
    expect(fs.existsSync(path.join(projectDir, "07_package", "caption-finalize", "intents"))).toBe(false);
  });

  it("blocks explicit finalize when a review-bound approval is stale or invalid", async () => {
    const projectDir = createProject();
    const approvalPath = path.join(projectDir, "07_package", "caption_approval.json");
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
    approval.approval.base_caption_draft_hash = `sha256:${"1".repeat(64)}`;
    approval.approval.caption_review_patch_hash = `sha256:${"2".repeat(64)}`;
    approval.approval.validation_hash = `sha256:${"3".repeat(64)}`;
    writeJson(approvalPath, approval);

    await expect(runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() }))
      .rejects.toThrow(/caption approval is stale or invalid/);
    expect(fs.existsSync(path.join(projectDir, "07_package", "caption-finalize", "intents"))).toBe(false);
  });

  it("plans direct-render repair without touching the canonical final", () => {
    const projectDir = createProject();
    const legacyFinal = path.join(projectDir, "09_output", "final.mp4");
    writeFile(legacyFinal, "legacy-direct-render");
    const before = fs.readFileSync(legacyFinal);
    const plan = buildDirectRenderRepairPlan(projectDir);
    expect(plan).toMatchObject({
      dry_run: true,
      source_exists: true,
      canonical_overwrite_allowed: false,
    });
    expect(fs.existsSync(path.dirname(plan.would_stage_path))).toBe(false);
    expect(fs.readFileSync(legacyFinal)).toEqual(before);
  });

  it("stages direct-render output with a receipt before finalization", () => {
    const projectDir = createProject();
    const canonical = path.join(projectDir, "09_output", "final.mp4");
    const generationDir = path.join(projectDir, "07_package", "caption-finalize", "generations", "direct-stage");
    writeFile(canonical, "direct-source-before-finalize");
    const canonicalBefore = fs.readFileSync(canonical);

    const staged = stageDirectRenderOutput(canonical, generationDir, "2026-07-23T00:00:00Z");

    expect(staged.receipt).toMatchObject({
      version: "direct-render-staging-receipt/v1",
      source_sha256: staged.receipt.staged_sha256,
    });
    expect(fs.readFileSync(staged.stagedPath)).toEqual(canonicalBefore);
    expect(fs.existsSync(staged.receiptPath)).toBe(true);
    expect(fs.readFileSync(canonical)).toEqual(canonicalBefore);
  });

  it("connects the receipt-staged direct source to the real package path without a real render", async () => {
    const projectDir = createProject();
    const base = await runCaptionFinalize(projectDir, {}, {
      stageRunner: fixtureStageRunner(),
    });
    const legacyReceiptPath = path.join(projectDir, "legacy-v3-caption-receipt.json");
    const legacyReceipt = JSON.parse(fs.readFileSync(
      path.join(base.generationDir, "caption-finalize-receipt.json"),
      "utf8",
    ));
    legacyReceipt.version = "caption-finalize-receipt/v3";
    delete legacyReceipt.final_render_approval_sha256;
    writeJson(legacyReceiptPath, legacyReceipt);
    const supplied = path.join(projectDir, "nle-export.mp4");
    writeFile(supplied, "fixture-nle-export");

    const result = await runCaptionFinalize(projectDir, {
      suppliedFinalPath: supplied,
      suppliedFinalReceiptPath: legacyReceiptPath,
      packageOptions: { skipRender: true, precomputedMetrics: fixtureMetrics() },
    }, {
      videoStreamHasher: () => `sha256:${"7".repeat(64)}`,
    });

    expect(result.reused).toBe(false);
    expect(fs.existsSync(path.join(result.generationDir, "staging", "direct-render-receipt.json"))).toBe(true);
    expect(fs.existsSync(
      path.join(result.generationDir, "staging", "supplied-final-provenance.json"),
    )).toBe(true);
    expect(result.receipt.artifacts.supplied_final_provenance?.sha256)
      .toMatch(/^sha256:/);
    expect(fs.readFileSync(path.join(result.generationDir, "video", "final.mp4"), "utf8"))
      .toBe("fixture-nle-export");
    expect(resolveDeliveryArtifactPaths(projectDir, { verifyHashes: true }).finalVideoPath)
      .toBe(path.join(result.generationDir, "video", "final.mp4"));
  });

  it("rejects a supplied final without caption and font provenance", async () => {
    const projectDir = createProject();
    const supplied = path.join(projectDir, "nle-export.mp4");
    writeFile(supplied, "fixture-nle-export");
    const stageRunner = vi.fn(fixtureStageRunner());

    await expect(runCaptionFinalize(projectDir, {
      suppliedFinalPath: supplied,
      packageOptions: { skipRender: true, precomputedMetrics: fixtureMetrics() },
    }, { stageRunner })).rejects.toThrow(
      "--supplied-final and --supplied-final-receipt must be provided together",
    );
    expect(stageRunner).not.toHaveBeenCalled();
  });

  it("rejects a remux whose video stream differs from its proven caption generation", async () => {
    const projectDir = createProject();
    const base = await runCaptionFinalize(projectDir, {}, {
      stageRunner: fixtureStageRunner(),
    });
    const supplied = path.join(projectDir, "nle-export.mp4");
    writeFile(supplied, "fixture-nle-export");

    await expect(runCaptionFinalize(projectDir, {
      suppliedFinalPath: supplied,
      suppliedFinalReceiptPath: path.join(
        base.generationDir,
        "caption-finalize-receipt.json",
      ),
      packageOptions: { skipRender: true, precomputedMetrics: fixtureMetrics() },
    }, {
      videoStreamHasher: (filePath) => filePath === supplied
        ? `sha256:${"8".repeat(64)}`
        : `sha256:${"7".repeat(64)}`,
    })).rejects.toThrow(
      "supplied final video stream differs from its caption/font provenance generation",
    );
    expect(fs.existsSync(base.activeDeliveryPath)).toBe(true);
  });

  it("rejects a tampered active artifact at every deliberate Node gate", async () => {
    const projectDir = createProject();
    const finalized = await runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() });
    fs.appendFileSync(path.resolve(projectDir, finalized.activeDelivery.artifacts.caption_ass.path), "X");

    expect(() => resolveDeliveryArtifactPaths(projectDir, { verifyHashes: true }))
      .toThrow(InvalidActiveDeliveryPointerError);
    expect(verifyExistingPackage(projectDir).ready).toBe(false);
    expect(() => buildPackagePreflight(projectDir)).toThrow(InvalidActiveDeliveryPointerError);
    const publication = runPublicationPreflight(projectDir);
    expect(publication.ready).toBe(false);
    expect(publication.checks[0]).toMatchObject({ name: "active_delivery_pointer_valid", passed: false });
    const stateBeforePackageGate = fs.readFileSync(path.join(projectDir, "project_state.yaml"), "utf8");
    expect(stateBeforePackageGate).toContain("current_state: approved");
    await expect(packageCommand(projectDir, {
      skipRender: true,
      deferActivation: true,
      deliveryOutputDir: path.join(projectDir, "07_package", "caption-finalize", "tamper-gate"),
    }))
      .rejects.toThrow(InvalidActiveDeliveryPointerError);
    expect(fs.readFileSync(path.join(projectDir, "project_state.yaml"), "utf8"))
      .toBe(stateBeforePackageGate);
  });

  it("publishes preflight decisions against the active generation instead of legacy canonical files", async () => {
    const projectDir = createProject();
    const finalized = await runCaptionFinalize(projectDir, {}, { stageRunner: fixtureStageRunner() });
    const finalHash = finalized.activeDelivery.artifacts.final_video.sha256;
    const approvalEntry = {
      status: "approved",
      approved_by: "operator",
      approved_at: "2026-07-23T00:00:00Z",
      scope: "active generation fixture",
      artifact_sha256: finalHash,
    };
    writeYaml(path.join(projectDir, "07_package", "publication_approval.yaml"), {
      version: "publication-approval/v1",
      project_id: "caption-finalize-test",
      created_at: "2026-07-23T00:00:00Z",
      canonical_video: { path: "09_output/final.mp4", sha256: finalHash },
      approvals: { creative: approvalEntry, rights: approvalEntry, privacy: approvalEntry },
      destinations: [{ platform: "internal", visibility: "workspace_only" }],
    });
    writeFile(path.join(projectDir, "09_output", "final.mp4"), "stale-legacy-final");

    const publication = runPublicationPreflight(projectDir, {
      platform: "internal",
      visibility: "workspace_only",
    });

    expect(publication.ready).toBe(true);
    expect(publication.canonical_video?.path)
      .toBe(path.resolve(projectDir, finalized.activeDelivery.artifacts.final_video.path));
    expect(publication.canonical_video?.sha256).toBe(finalHash);
  });

  it("keeps legacy input sidecars separate from the generation output root", async () => {
    const projectDir = createProject();
    const generationDir = path.join(projectDir, "07_package", "caption-finalize", "input-root-fixture");
    writeJson(path.join(projectDir, "07_package", "music_cues.json"), {
      version: "1", project_id: "caption-finalize-test", base_timeline_version: "1",
    });
    writeJson(path.join(generationDir, "music_cues.json"), {
      version: "1", project_id: "caption-finalize-test", base_timeline_version: "stale-generation-copy",
      music_asset: { path: "07_package/audio/generation-only.wav" },
    });
    writeFile(path.join(projectDir, "07_package", "audio", "generation-only.wav"), "fixture-audio");
    writeJson(path.join(projectDir, "07_package", "audio", "generation-only.provenance.json"), {
      origin: "procedurally_generated_from_repository_script",
      usage_class: "music_bed",
    });
    const approval = JSON.parse(fs.readFileSync(
      path.join(projectDir, "07_package", "caption_approval.json"),
      "utf8",
    ));
    const timeline = JSON.parse(fs.readFileSync(
      path.join(projectDir, "05_timeline", "timeline.json"),
      "utf8",
    ));
    writeApprovedCaptionDeliveryArtifacts(approval, timeline, generationDir);
    writeFile(path.join(generationDir, "captions", "speech.vtt"), "WEBVTT\n");
    const suppliedFinal = path.join(projectDir, "direct-source.mp4");
    writeFile(suppliedFinal, "fixture-direct-source");

    const result = await packageCommand(projectDir, {
      suppliedFinalPath: suppliedFinal,
      deliveryOutputDir: generationDir,
      captionApprovalPath: path.join(projectDir, "07_package", "caption_approval.json"),
      deferActivation: true,
      skipRender: true,
      precomputedMetrics: fixtureMetrics(),
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(fs.existsSync(path.join(generationDir, "package_manifest.json"))).toBe(true);
    expect(fs.readFileSync(path.join(generationDir, "music_cues.json"), "utf8"))
      .toContain("stale-generation-copy");
  });
});

describe("caption-finalize CLI", () => {
  it("documents run, supplied-final, and repair dry-run options", () => {
    const parsed = parseCaptionFinalizeArgs([
      "node", "caption-finalize", "run", "--project", ".",
      "--supplied-final", "./final.mp4",
      "--supplied-final-receipt", "./receipt.json",
      "--json",
    ]);
    expect(parsed.command).toBe("run");
    expect(parsed.suppliedFinalPath).toBe(path.resolve("./final.mp4"));
    expect(parsed.suppliedFinalReceiptPath).toBe(path.resolve("./receipt.json"));
    expect(parsed.json).toBe(true);
    expect(() => parseCaptionFinalizeArgs(["node", "caption-finalize", "--help"]))
      .toThrow(/repair-direct-render[\s\S]*--dry-run/);
  });

  it("prints help successfully without running a job", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runCaptionFinalizeCli(["node", "caption-finalize", "--help"])).resolves.toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("caption-finalize.ts run"));
    output.mockRestore();
  });
});

function fixtureStageRunner(): (context: CaptionFinalizeStageContext) => Promise<void> {
  return async (context) => {
    writeApprovedCaptionDeliveryArtifacts(
      context.approval,
      context.timeline as Parameters<typeof writeApprovedCaptionDeliveryArtifacts>[1],
      context.generationDir,
    );
    const text = context.approval.speech_captions.map((caption) => caption.text).join("|");
    const finalPath = path.join(context.generationDir, "video", "final.mp4");
    writeFile(finalPath, `fixture-final:${text}`);
    const approvalHash = computeFileHash(context.approvalIntentPath);
    const qaPath = path.join(context.generationDir, "qa-report.json");
    const qa = buildQaReport(
      context.approval.project_id,
      "nle_finishing",
      [{ name: "caption_fixture_valid", passed: true, details: `approval=${approvalHash}` }],
      {},
      { final_video: projectRelative(context.projectDir, finalPath) },
    );
    writeJson(qaPath, qa);
    const manifest = buildNleFinishingManifest({
      projectId: context.approval.project_id,
      baseTimelineVersion: context.approval.base_timeline_version,
      editorialTimelineHash: computeFileHash(path.join(context.projectDir, "05_timeline", "timeline.json")),
      outputDir: context.generationDir,
      handoffId: "HND_CAPTION_FINALIZE",
      captionApprovalHash: approvalHash,
      captionPolicy: context.approval.caption_policy,
      finalVideoPath: finalPath,
      qaReportPath: qaPath,
      sidecarPaths: [path.join(context.generationDir, "captions", "speech.approved.srt")],
      createdAt: context.createdAt,
    });
    writeJson(path.join(context.generationDir, "package_manifest.json"), manifest);
  };
}

function fixtureMetrics() {
  return {
    integratedLufs: -16,
    truePeakDbtp: -1.8,
    videoDurationMs: 2_002,
    audioDurationMs: 2_002,
    videoFrame: {
      width: 1920,
      height: 1080,
      sar: "1:1",
      dar: "16:9",
      fps_num: 30_000,
      fps_den: 1_001,
      fps: 30_000 / 1_001,
    },
  };
}

function createProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-finalize-"));
  tempDirs.push(projectDir);
  const timelinePath = path.join(projectDir, "05_timeline", "timeline.json");
  writeJson(timelinePath, {
    version: "1",
    project_id: "caption-finalize-test",
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
    project_id: "caption-finalize-test",
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
    project_id: "caption-finalize-test",
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
  writeApproval(projectDir, "最初の字幕");
  return projectDir;
}

function updateCaption(projectDir: string, text: string): void {
  writeApproval(projectDir, text);
}

function writeApproval(projectDir: string, text: string): void {
  writeJson(path.join(projectDir, "07_package", "caption_approval.json"), {
    version: "1",
    project_id: "caption-finalize-test",
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
      text,
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
}

function activeHashes(active: ActiveDelivery): Record<string, string> {
  return Object.fromEntries(Object.entries(active.artifacts).map(([name, value]) => [name, value.sha256]));
}

function writeJson(filePath: string, value: unknown): void {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeYaml(filePath: string, value: unknown): void {
  writeFile(filePath, stringifyYaml(value));
}

function writeFile(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function projectRelative(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}
