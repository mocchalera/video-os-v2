import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseGeneratePublicProjectionArgs,
  runGeneratePublicProjection,
} from "../scripts/generate-public-projection.js";
import {
  finalizePublicProjectionReceiptWithApprovedVerifier,
  parseFinalizePublicProjectionArgs,
} from "../scripts/finalize-public-projection-receipt.js";
import {
  parseVerifyPublicProjectionArgs,
} from "../scripts/verify-public-projection.js";
import {
  parseVerifyPromotionEnvelopeArgs,
  verifyPromotionEnvelopeWithTrustedVerifiers,
} from "../scripts/verify-promotion-envelope.js";
import {
  REQUIRED_PUBLIC_BOUNDARY_JOBS,
  buildPromotionEnvelope,
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  generatePublicProjection,
  sha256Hex,
  verifyPromotionEnvelope,
  verifyPublicProjectionReceipt,
  writeExclusiveOutputFile,
  type ApprovedAttestationVerifier,
  type PromotionApprovalReceipt,
  type PromotionCiEvidence,
  type PromotionDestination,
  type PublicProjectionPolicy,
  type PublicProjectionReceipt,
  type PublicProjectionScanAttestation,
  type TrustedEvidenceVerifier,
} from "../runtime/release/public-projection.js";

const require_ = createRequire(import.meta.url);
const Ajv2020 = require_("ajv/dist/2020") as new (options: Record<string, unknown>) => {
  compile(schema: object): {
    (data: unknown): boolean;
    errors?: unknown[] | null;
  };
};
const addFormats = require_("ajv-formats") as (ajv: unknown) => void;

import {
  SHA_A,
  commitAll,
  createOutputSymlinkAttack,
  git,
  installExclusiveOutputAdditionalHardlink,
  installExclusiveOutputAbaAttack,
  installExclusiveOutputForcedTermination,
  installExclusiveOutputForeignTempReplacement,
  installExclusiveOutputPostPublishTermination,
  makeWritable,
  policy,
  promotionOptions,
  resignApproval,
  resignCi,
  schemaValidator,
  signedEvidence,
  stageAFixture,
  stageBFixture,
  tempRoot,
  wrapperStageAReceipt,
  type StageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04a Stage A public projection", () => {
  it("validates the production policy and a canonical receipt without self/public/CI identity", () => {
    const validatePolicy = schemaValidator("public-projection-policy.schema.json");
    const validateReceipt = schemaValidator("public-projection-receipt.schema.json");
    const productionPolicy = parseYaml(
      fs.readFileSync("runtime/release/public-projection-policy.yaml", "utf8"),
    ) as PublicProjectionPolicy;
    const fixture = stageAFixture();

    expect(validatePolicy(policy()), JSON.stringify(validatePolicy.errors)).toBe(true);
    expect(validatePolicy(productionPolicy), JSON.stringify(validatePolicy.errors)).toBe(true);
    expect(productionPolicy.secret_scan.approved_producers).toHaveLength(1);
    expect(productionPolicy.secret_scan.approved_scanners).toHaveLength(1);
    expect(validateReceipt(fixture.receipt), JSON.stringify(validateReceipt.errors)).toBe(true);
    expect(fixture.receiptBytes.at(-1)).toBe(0x0a);

    const serialized = fixture.receiptBytes.toString("utf8");
    expect(serialized).not.toContain("stage_a_receipt_sha256");
    expect(serialized).not.toContain("public_commit_sha");
    expect(serialized).not.toContain("ci_url");
  });

  it("keeps CLI phases explicit and rejects implicit receipt generation", () => {
    expect(() => parseGeneratePublicProjectionArgs([
      "--source", "/source",
      "--output", "/staging",
      "--policy", "/policy",
    ])).toThrow(/--no-receipt/);
    expect(parseGeneratePublicProjectionArgs([
      "--source", "/source",
      "--output", "/staging",
      "--policy", "/policy",
      "--no-receipt",
    ])).toMatchObject({ noReceipt: true });
    const signatureArgs = [
      "--source", "/source",
      "--staging", "/staging",
      "--policy", "/policy",
      "--scan-attestation", "/evidence/scan.json",
      "--scan-signature", "/evidence/scan.sig",
      "--receipt-out", "/evidence/stage-a.json",
    ];
    expect(parseFinalizePublicProjectionArgs(signatureArgs)).toMatchObject({
      scanSignature: "/evidence/scan.sig",
      generationSnapshot: "/staging.generation.json",
    });
    const wrapperArgs = signatureArgs.flatMap((value, index) => (
      index === signatureArgs.indexOf("--scan-signature")
        ? ["--wrapper-execution-receipt"]
        : index === signatureArgs.indexOf("--scan-signature") + 1
          ? ["/evidence/wrapper.json"]
          : [value]
    ));
    expect(parseFinalizePublicProjectionArgs(wrapperArgs)).toMatchObject({
      wrapperExecutionReceipt: "/evidence/wrapper.json",
    });
    expect(() => parseFinalizePublicProjectionArgs(
      signatureArgs.filter((value) => !["--scan-signature", "/evidence/scan.sig"].includes(value)),
    )).toThrow(/Exactly one/);
    expect(() => parseFinalizePublicProjectionArgs([
      ...signatureArgs,
      "--wrapper-execution-receipt", "/evidence/wrapper.json",
    ])).toThrow(/Exactly one/);
    expect(parseVerifyPublicProjectionArgs([
      "--source", "/source",
      "--public", "/staging",
      "--policy", "/policy",
      "--receipt", "/evidence/stage-a.json",
    ])).toMatchObject({ public: "/staging" });
    expect(parseVerifyPromotionEnvelopeArgs([
      "--stage-a", "/evidence/stage-a.json",
      "--stage-a-signature", "/evidence/stage-a.sig",
      "--public-repository", "/public-repo",
      "--public-commit", "a".repeat(40),
      "--ci-evidence", "/evidence/ci.json",
      "--approval-receipt", "/evidence/approval.json",
      "--envelope-out", "/evidence/stage-b.json",
    ])).toMatchObject({ stageASignature: "/evidence/stage-a.sig" });
  });

  it("rejects parent ABA before atomic publish and removes only the anchored task temp", () => {
    const root = tempRoot("output-parent-race");
    const protectedRoot = path.join(root, "protected");
    const trustedParent = path.join(root, "trusted-parent");
    const movedParent = path.join(root, "trusted-parent-moved");
    const outputPath = path.join(trustedParent, "receipt.json");
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(trustedParent);
    const attack = installExclusiveOutputAbaAttack({
      nominalParent: trustedParent,
      movedParent,
      protectedRoot,
    });
    try {
      expect(() => writeExclusiveOutputFile({
        outputPath,
        protectedRoot,
        label: "race-test output",
        bytes: Buffer.from("must-not-be-written"),
        mode: 0o444,
      })).toThrow(/parent changed|anchored output/i);
      expect(attack.wasTriggered()).toBe(true);
      expect(fs.existsSync(path.join(protectedRoot, "receipt.json"))).toBe(false);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(trustedParent)).toEqual([]);
    } finally {
      attack.restore();
    }
  });

  it("never publishes partial final bytes when the anchored worker is killed during temp write", () => {
    const root = tempRoot("output-worker-kill");
    const protectedRoot = path.join(root, "protected");
    const trustedParent = path.join(root, "trusted-parent");
    const outputPath = path.join(trustedParent, "receipt.json");
    const payload = Buffer.alloc(32 * 1024, 0x61);
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(trustedParent, { mode: 0o700 });
    const termination = installExclusiveOutputForcedTermination();
    try {
      expect(() => writeExclusiveOutputFile({
        outputPath,
        protectedRoot,
        label: "forced-termination output",
        bytes: payload,
        mode: 0o444,
      })).toThrow(/SIGKILL|anchored output/i);
      expect(termination.wasTriggered()).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(protectedRoot)).toEqual([]);
      const taskTemps = fs.readdirSync(trustedParent)
        .filter((name) => name.startsWith(".public-projection-"));
      expect(taskTemps).toHaveLength(1);
      const partialSize = fs.statSync(path.join(trustedParent, taskTemps[0])).size;
      expect(partialSize).toBeGreaterThan(0);
      expect(partialSize).toBeLessThan(payload.length);
    } finally {
      termination.restore();
    }
  });

  it("can expose only complete final bytes when the worker is killed after atomic publish", () => {
    const root = tempRoot("output-worker-post-publish-kill");
    const protectedRoot = path.join(root, "protected");
    const trustedParent = path.join(root, "trusted-parent");
    const outputPath = path.join(trustedParent, "receipt.json");
    const payload = Buffer.alloc(32 * 1024, 0x62);
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(trustedParent, { mode: 0o700 });
    const termination = installExclusiveOutputPostPublishTermination();
    try {
      expect(() => writeExclusiveOutputFile({
        outputPath,
        protectedRoot,
        label: "post-publish termination output",
        bytes: payload,
        mode: 0o444,
      })).toThrow(/SIGKILL|anchored output/i);
      expect(termination.wasTriggered()).toBe(true);
      expect(fs.readFileSync(outputPath)).toEqual(payload);
      const finalStat = fs.statSync(outputPath);
      expect(finalStat.mode & 0o777).toBe(0o444);
      expect(finalStat.size).toBe(payload.length);
      expect(finalStat.nlink).toBe(2);
      const taskTemps = fs.readdirSync(trustedParent)
        .filter((name) => name.startsWith(".public-projection-"));
      expect(taskTemps).toHaveLength(1);
      const recoveryPath = path.join(trustedParent, taskTemps[0]);
      const recoveryStat = fs.statSync(recoveryPath);
      expect(fs.readFileSync(recoveryPath)).toEqual(payload);
      expect(recoveryStat.mode & 0o777).toBe(0o444);
      expect(recoveryStat.size).toBe(payload.length);
      expect(recoveryStat.dev).toBe(finalStat.dev);
      expect(recoveryStat.ino).toBe(finalStat.ino);
      expect(recoveryStat.nlink).toBe(2);
      expect(fs.readdirSync(protectedRoot)).toEqual([]);
    } finally {
      termination.restore();
    }
  });

  it("rejects an additional hardlink to the task temp and removes only same-parent task aliases", () => {
    const root = tempRoot("output-worker-additional-link");
    const protectedRoot = path.join(root, "protected");
    const trustedParent = path.join(root, "trusted-parent");
    const outputPath = path.join(trustedParent, "receipt.json");
    const aliasLeaf = "task-temp-alias";
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(trustedParent, { mode: 0o700 });
    const attack = installExclusiveOutputAdditionalHardlink(aliasLeaf);
    try {
      expect(() => writeExclusiveOutputFile({
        outputPath,
        protectedRoot,
        label: "additional-hardlink output",
        bytes: Buffer.from("must-not-publish"),
        mode: 0o444,
      })).toThrow(/link-count|changed after creation|anchored output/i);
      expect(attack.wasTriggered()).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(trustedParent)).toEqual([]);
      expect(fs.readdirSync(protectedRoot)).toEqual([]);
    } finally {
      attack.restore();
    }
  });

  it("removes the actual foreign final entry when the temp name is replaced before publish", () => {
    const root = tempRoot("output-worker-foreign-temp");
    const protectedRoot = path.join(root, "protected");
    const trustedParent = path.join(root, "trusted-parent");
    const outputPath = path.join(trustedParent, "receipt.json");
    const foreignBytes = "foreign-replacement-bytes";
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(trustedParent, { mode: 0o700 });
    const attack = installExclusiveOutputForeignTempReplacement(foreignBytes);
    try {
      expect(() => writeExclusiveOutputFile({
        outputPath,
        protectedRoot,
        label: "foreign-temp output",
        bytes: Buffer.from("approved-payload"),
        mode: 0o444,
      })).toThrow(/inode|link-count|anchored output/i);
      expect(attack.wasTriggered()).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(protectedRoot)).toEqual([]);
      const remaining = fs.readdirSync(trustedParent);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatch(/^\.public-projection-/);
      expect(fs.readFileSync(path.join(trustedParent, remaining[0]), "utf8")).toBe(foreignBytes);
    } finally {
      attack.restore();
    }
  });

  it("runs the output worker without inherited NODE_OPTIONS or NODE_PATH preload hooks", () => {
    const root = tempRoot("output-worker-env");
    const protectedRoot = path.join(root, "protected");
    const trustedParent = path.join(root, "trusted-parent");
    const outputPath = path.join(trustedParent, "receipt.json");
    const protectedMarker = path.join(protectedRoot, "preload-marker.txt");
    const preloadPath = path.join(root, "worker-preload.cjs");
    const payload = Buffer.from("complete-safe-output");
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(trustedParent, { mode: 0o700 });
    fs.writeFileSync(
      preloadPath,
      `require("node:fs").writeFileSync(${JSON.stringify(protectedMarker)}, "injected");\n`,
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousNodePath = process.env.NODE_PATH;
    process.env.NODE_OPTIONS = `--require=${preloadPath}`;
    process.env.NODE_PATH = protectedRoot;
    try {
      expect(writeExclusiveOutputFile({
        outputPath,
        protectedRoot,
        label: "hermetic-worker output",
        bytes: payload,
        mode: 0o444,
      })).toBe(outputPath);
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = previousNodePath;
    }
    expect(fs.readFileSync(outputPath)).toEqual(payload);
    expect(fs.existsSync(protectedMarker)).toBe(false);
    expect(fs.readdirSync(trustedParent)).toEqual(["receipt.json"]);
  });

  it.each(["root", "parent", "dangling"] as const)(
    "rejects Stage A receipt output %s symlinks",
    (variant) => {
      const fixture = stageAFixture();
      const evidenceRoot = path.join(fixture.root, "stage-a-evidence");
      fs.mkdirSync(evidenceRoot);
      const generationSnapshot = path.join(evidenceRoot, "generation.json");
      const scanAttestation = path.join(evidenceRoot, "scan.json");
      const scanSignature = path.join(evidenceRoot, "scan.sig");
      fs.writeFileSync(generationSnapshot, canonicalJsonBytes(fixture.snapshot));
      fs.writeFileSync(scanAttestation, fixture.attestationBytes);
      fs.writeFileSync(scanSignature, fixture.signatureBytes);
      const receiptOut = createOutputSymlinkAttack(
        fixture.root,
        fixture.staging,
        variant,
      );

      expect(() => finalizePublicProjectionReceiptWithApprovedVerifier({
        source: fixture.source,
        staging: fixture.staging,
        policy: fixture.policyPath,
        scanAttestation,
        scanSignature,
        receiptOut,
        generationSnapshot,
      }, fixture.verifier)).toThrow(/symbolic link|symlink/i);
    },
  );

  it("rejects Stage A receipt parent ABA without writing staging or nominal bytes", () => {
    const fixture = stageAFixture();
    const evidenceRoot = path.join(fixture.root, "stage-a-aba-evidence");
    const outputParent = path.join(fixture.root, "stage-a-aba-output");
    const movedParent = path.join(fixture.root, "stage-a-aba-output-moved");
    fs.mkdirSync(evidenceRoot);
    fs.mkdirSync(outputParent);
    const generationSnapshot = path.join(evidenceRoot, "generation.json");
    const scanAttestation = path.join(evidenceRoot, "scan.json");
    const scanSignature = path.join(evidenceRoot, "scan.sig");
    const receiptOut = path.join(outputParent, "stage-a.json");
    fs.writeFileSync(generationSnapshot, canonicalJsonBytes(fixture.snapshot));
    fs.writeFileSync(scanAttestation, fixture.attestationBytes);
    fs.writeFileSync(scanSignature, fixture.signatureBytes);
    const attack = installExclusiveOutputAbaAttack({
      nominalParent: outputParent,
      movedParent,
      protectedRoot: fixture.staging,
    });
    try {
      expect(() => finalizePublicProjectionReceiptWithApprovedVerifier({
        source: fixture.source,
        staging: fixture.staging,
        policy: fixture.policyPath,
        scanAttestation,
        scanSignature,
        receiptOut,
        generationSnapshot,
      }, fixture.verifier)).toThrow(/parent changed|anchored output/i);
      expect(attack.wasTriggered()).toBe(true);
      expect(fs.existsSync(path.join(fixture.staging, "stage-a.json"))).toBe(false);
      expect(fs.existsSync(receiptOut)).toBe(false);
      expect(fs.readdirSync(outputParent)).toEqual([]);
    } finally {
      attack.restore();
    }
  });

});
