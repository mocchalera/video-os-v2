import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runGeneratePublicProjection } from "../scripts/generate-public-projection.js";
import {
  finalizePublicProjectionReceiptWithApprovedVerifier,
} from "../scripts/finalize-public-projection-receipt.js";
import {
  canonicalJsonBytes,
  generatePublicProjection,
  sha256Hex,
} from "../runtime/release/public-projection.js";
import {
  createOutputSymlinkAttack,
  stageAFixture,
  wrapperStageAReceipt,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04a Stage A generation and finalization", () => {
  it("finalizes through the detached-signature Stage A evidence route", () => {
    const fixture = stageAFixture();
    const evidenceRoot = path.join(fixture.root, "detached-evidence");
    fs.mkdirSync(evidenceRoot);
    const generationSnapshot = path.join(evidenceRoot, "generation.json");
    const scanAttestation = path.join(evidenceRoot, "scan.json");
    const scanSignature = path.join(evidenceRoot, "scan.sig");
    fs.writeFileSync(generationSnapshot, canonicalJsonBytes(fixture.snapshot));
    fs.writeFileSync(scanAttestation, fixture.attestationBytes);
    fs.writeFileSync(scanSignature, fixture.signatureBytes);
    const receipt = finalizePublicProjectionReceiptWithApprovedVerifier({
      source: fixture.source,
      staging: fixture.staging,
      policy: fixture.policyPath,
      scanAttestation,
      scanSignature,
      receiptOut: path.join(evidenceRoot, "stage-a.json"),
      generationSnapshot,
    }, fixture.verifier);
    expect(receipt.secret_scan.verification.mechanism).toBe("detached-signature");
  });

  it("finalizes through the approved-wrapper-execution-receipt Stage A evidence route", () => {
    const fixture = stageAFixture();
    const wrapper = wrapperStageAReceipt(fixture);
    const wrapperEvidence = path.join(fixture.root, "wrapper-evidence");
    fs.mkdirSync(wrapperEvidence);
    const wrapperSnapshot = path.join(wrapperEvidence, "generation.json");
    const wrapperAttestation = path.join(wrapperEvidence, "scan.json");
    const wrapperReceiptPath = path.join(wrapperEvidence, "wrapper.receipt");
    fs.writeFileSync(wrapperSnapshot, canonicalJsonBytes(fixture.snapshot));
    fs.writeFileSync(wrapperAttestation, fixture.attestationBytes);
    fs.writeFileSync(
      wrapperReceiptPath,
      Buffer.from(`test-wrapper-execution:${sha256Hex(fixture.attestationBytes)}`, "utf8"),
    );
    const receipt = finalizePublicProjectionReceiptWithApprovedVerifier({
      source: fixture.source,
      staging: fixture.staging,
      policy: fixture.policyPath,
      scanAttestation: wrapperAttestation,
      wrapperExecutionReceipt: wrapperReceiptPath,
      receiptOut: path.join(wrapperEvidence, "stage-a.json"),
      generationSnapshot: wrapperSnapshot,
    }, wrapper.verifier);
    expect(receipt.secret_scan.verification.mechanism).toBe(
      "approved-wrapper-execution-receipt",
    );
  });

  it.each(["root", "parent", "dangling"] as const)(
    "rejects generator output %s symlinks before materialization",
    (variant) => {
      const fixture = stageAFixture();
      const output = createOutputSymlinkAttack(
        fixture.root,
        fixture.source,
        variant,
      );
      expect(() => runGeneratePublicProjection({
        source: fixture.source,
        output,
        policy: fixture.policyPath,
        noReceipt: true,
      })).toThrow(/symbolic link|symlink/i);
    },
  );

  it("sanitizes every caller-supplied GIT_* override without changing source or raw objects", () => {
    const fixture = stageAFixture();
    const shallowFile = path.join(fixture.root, "foreign-shallow");
    const graftFile = path.join(fixture.root, "foreign-grafts");
    fs.writeFileSync(shallowFile, `${fixture.snapshot.source.commit_sha}\n`);
    fs.writeFileSync(graftFile, `${fixture.snapshot.source.commit_sha}\n`);
    const overrides: Record<string, string> = {
      GIT_DIR: path.join(fixture.root, "not-the-source.git"),
      GIT_WORK_TREE: path.join(fixture.root, "not-the-source"),
      GIT_OBJECT_DIRECTORY: path.join(fixture.root, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(fixture.root, "alternate-objects"),
      GIT_INDEX_FILE: path.join(fixture.root, "foreign-index"),
      GIT_COMMON_DIR: path.join(fixture.root, "foreign-common"),
      GIT_CONFIG: path.join(fixture.root, "foreign-config"),
      GIT_CONFIG_GLOBAL: path.join(fixture.root, "foreign-global-config"),
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.repositoryformatversion",
      GIT_CONFIG_VALUE_0: "999",
      GIT_NO_REPLACE_OBJECTS: "0",
      GIT_SHALLOW_FILE: shallowFile,
      GIT_GRAFT_FILE: graftFile,
      GIT_NAMESPACE: "foreign-namespace",
    };
    const previous = new Map(
      Object.keys(overrides).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, overrides);
    try {
      const sanitized = generatePublicProjection({
        sourceRoot: fixture.source,
        outputRoot: path.join(fixture.root, "sanitized-env-output"),
        policyPath: fixture.policyPath,
      });
      expect(sanitized.source).toEqual(fixture.snapshot.source);
      expect(sanitized.public_path_ledger).toEqual(fixture.snapshot.public_path_ledger);
      expect(sanitized.public_payload_sha256).toBe(fixture.snapshot.public_payload_sha256);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
