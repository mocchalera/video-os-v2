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
  installExclusiveOutputAbaAttack,
  makeWritable,
  policy,
  promotionOptions,
  resignCi,
  schemaValidator,
  signedEvidence,
  stageAFixture,
  stageBFixture,
  tempRoot,
  wrapperStageAReceipt,
  type StageAFixture,
  type StageBFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04b Stage B promotion envelope contracts", () => {
  it("binds canonical Stage A, exact public commit ledger, destination, workflow, CI, and approval", () => {
    const fixture = stageBFixture();
    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    const envelopeBytes = canonicalJsonBytes(envelope);
    const validate = schemaValidator("promotion-envelope.schema.json");

    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
    expect(envelope).toMatchObject({
      version: "promotion-envelope/v1",
      stage_a_receipt_sha256: sha256Hex(fixture.receiptBytes),
      stage_a_public_path_ledger_sha256: fixture.receipt.public_path_ledger_sha256,
      stage_a_verification: {
        mechanism: "detached-signature",
        verifier_id: "test-only-stage-a-finalizer",
        evidence_sha256: sha256Hex(fixture.receiptBytes),
      },
      public_commit_sha: fixture.publicCommit,
      public_tree_sha: fixture.publicTree,
      destination: fixture.destination,
    });
    expect(envelope.public_path_count).toBe(fixture.receipt.public_path_ledger.length);
    expect(verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes,
    })).toEqual(envelope);
  });

  it("rejects arbitrary unsigned CI and approval JSON", () => {
    const fixture = stageBFixture();
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      ciEvidenceBytes: canonicalJsonBytes(fixture.ciEvidence),
    })).toThrow(/untrusted|evidence/i);
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      approvalReceiptBytes: canonicalJsonBytes(fixture.approval),
    })).toThrow(/untrusted|evidence/i);
  });

  it("requires an independent trusted Stage A receipt verifier", () => {
    const fixture = stageBFixture();
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptVerifier: undefined as never,
    })).toThrow(/Stage A .*trusted verifier/i);

    const tampered = structuredClone(fixture.receipt);
    tampered.secret_scan.verification.verifier_id = "self-asserted-verifier";
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptBytes: canonicalJsonBytes(tampered),
    })).toThrow(/untrusted .*stage-a-finalizer/i);

    const mismatchedVerifier: TrustedEvidenceVerifier<PublicProjectionReceipt> = {
      verify(bytes) {
        const verified = fixture.stageAVerifier.verify(bytes);
        return {
          ...verified,
          evidence: {
            ...verified.evidence,
            public_payload_sha256: SHA_A,
          },
        };
      },
    };
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptVerifier: mismatchedVerifier,
    })).toThrow(/Trusted Stage A receipt mismatch/i);

    const wrongDigestVerifier: TrustedEvidenceVerifier<PublicProjectionReceipt> = {
      verify(bytes) {
        const verified = fixture.stageAVerifier.verify(bytes);
        return {
          ...verified,
          verification: {
            ...verified.verification,
            evidence_sha256: SHA_A,
          },
        };
      },
    };
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptVerifier: wrongDigestVerifier,
    })).toThrow(/Stage A receipt evidence verification digest mismatch/i);

    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    const tamperedEnvelope = structuredClone(envelope);
    tamperedEnvelope.stage_a_verification.verifier_id = "self-asserted-verifier";
    expect(() => verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(tamperedEnvelope),
    })).toThrow(/Promotion envelope does not match trusted exact-commit inputs/i);
  });

  it("rejects schema-invalid verification shapes during build and verify", () => {
    const fixture = stageBFixture();
    const ciVerifierWithExtraKey: TrustedEvidenceVerifier<PromotionCiEvidence> = {
      verify(bytes) {
        const verified = fixture.ciVerifier.verify(bytes);
        return {
          ...verified,
          verification: {
            ...verified.verification,
            unexpected: true,
          },
        };
      },
    };
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      ciEvidenceVerifier: ciVerifierWithExtraKey,
    })).toThrow(/verification .*unexpected keys|exact keys/i);

    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    const malformed = structuredClone(envelope);
    const verification = malformed.ci.verification as typeof malformed.ci.verification & {
      unexpected?: boolean;
    };
    verification.unexpected = true;
    expect(() => verifyPromotionEnvelope({
      ...promotionOptions(fixture),
      envelopeBytes: canonicalJsonBytes(malformed),
    })).toThrow(/verification .*unexpected keys|exact keys/i);
  });

  it("binds each trusted verification mechanism to its evidence lane", () => {
    const fixture = stageBFixture();
    const wrongStageAVerifier: TrustedEvidenceVerifier<PublicProjectionReceipt> = {
      verify(bytes) {
        const verified = fixture.stageAVerifier.verify(bytes);
        return {
          ...verified,
          verification: {
            ...verified.verification,
            mechanism: "provider-api-execution-receipt",
          },
        };
      },
    };
    const wrongCiVerifier: TrustedEvidenceVerifier<PromotionCiEvidence> = {
      verify(bytes) {
        const verified = fixture.ciVerifier.verify(bytes);
        return {
          ...verified,
          verification: {
            ...verified.verification,
            mechanism: "cockpit-approval-event",
          },
        };
      },
    };
    const wrongApprovalVerifier: TrustedEvidenceVerifier<PromotionApprovalReceipt> = {
      verify(bytes) {
        const verified = fixture.approvalVerifier.verify(bytes);
        return {
          ...verified,
          verification: {
            ...verified.verification,
            mechanism: "provider-api-execution-receipt",
          },
        };
      },
    };

    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      stageAReceiptVerifier: wrongStageAVerifier,
    })).toThrow(/Stage A.*mechanism must be detached-signature/i);
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      ciEvidenceVerifier: wrongCiVerifier,
    })).toThrow(/CI.*mechanism must be provider-api-execution-receipt/i);
    expect(() => buildPromotionEnvelope({
      ...promotionOptions(fixture),
      approvalReceiptVerifier: wrongApprovalVerifier,
    })).toThrow(/Approval.*mechanism must be cockpit-approval-event/i);

    const validate = schemaValidator("promotion-envelope.schema.json");
    const envelope = buildPromotionEnvelope(promotionOptions(fixture));
    const wrongStageA = structuredClone(envelope);
    wrongStageA.stage_a_verification.mechanism = "cockpit-approval-event";
    const wrongCi = structuredClone(envelope);
    wrongCi.ci.verification.mechanism = "detached-signature";
    const wrongApproval = structuredClone(envelope);
    wrongApproval.approval.verification.mechanism = "detached-signature";
    for (const tampered of [wrongStageA, wrongCi, wrongApproval]) {
      expect(validate(tampered), JSON.stringify(validate.errors)).toBe(false);
    }
  });

  it.each(["root", "parent", "dangling"] as const)(
    "rejects Stage B envelope output %s symlinks",
    (variant) => {
      const fixture = stageBFixture();
      const evidenceRoot = path.join(fixture.root, "stage-b-evidence");
      fs.mkdirSync(evidenceRoot);
      const stageA = path.join(evidenceRoot, "stage-a.json");
      const ciEvidence = path.join(evidenceRoot, "ci.json");
      const approvalReceipt = path.join(evidenceRoot, "approval.json");
      fs.writeFileSync(stageA, fixture.receiptBytes);
      fs.writeFileSync(ciEvidence, fixture.ciBytes);
      fs.writeFileSync(approvalReceipt, fixture.approvalBytes);
      const envelopeOut = createOutputSymlinkAttack(
        fixture.root,
        fixture.publicRepo,
        variant,
      );

      expect(() => verifyPromotionEnvelopeWithTrustedVerifiers({
        stageA,
        publicRepository: fixture.publicRepo,
        publicCommit: fixture.publicCommit,
        destinationProvider: "github",
        destinationRepositoryId: fixture.destination.repository_id,
        destinationRepositoryFullName: fixture.destination.repository_full_name,
        destinationBranch: fixture.destination.branch,
        workflowPath: fixture.workflowPath,
        workflowBlobSha: fixture.workflowBlobSha,
        ciEvidence,
        approvalReceipt,
        envelopeOut,
      }, {
        stageA: fixture.stageAVerifier,
        ci: fixture.ciVerifier,
        approval: fixture.approvalVerifier,
      })).toThrow(/symbolic link|symlink/i);
    },
  );

  it("rejects Stage B envelope parent ABA without writing public or nominal bytes", () => {
    const fixture = stageBFixture();
    const evidenceRoot = path.join(fixture.root, "stage-b-aba-evidence");
    const outputParent = path.join(fixture.root, "stage-b-aba-output");
    const movedParent = path.join(fixture.root, "stage-b-aba-output-moved");
    fs.mkdirSync(evidenceRoot);
    fs.mkdirSync(outputParent);
    const stageA = path.join(evidenceRoot, "stage-a.json");
    const ciEvidence = path.join(evidenceRoot, "ci.json");
    const approvalReceipt = path.join(evidenceRoot, "approval.json");
    const envelopeOut = path.join(outputParent, "stage-b.json");
    fs.writeFileSync(stageA, fixture.receiptBytes);
    fs.writeFileSync(ciEvidence, fixture.ciBytes);
    fs.writeFileSync(approvalReceipt, fixture.approvalBytes);
    const attack = installExclusiveOutputAbaAttack({
      nominalParent: outputParent,
      movedParent,
      protectedRoot: fixture.publicRepo,
    });
    try {
      expect(() => verifyPromotionEnvelopeWithTrustedVerifiers({
        stageA,
        publicRepository: fixture.publicRepo,
        publicCommit: fixture.publicCommit,
        destinationProvider: "github",
        destinationRepositoryId: fixture.destination.repository_id,
        destinationRepositoryFullName: fixture.destination.repository_full_name,
        destinationBranch: fixture.destination.branch,
        workflowPath: fixture.workflowPath,
        workflowBlobSha: fixture.workflowBlobSha,
        ciEvidence,
        approvalReceipt,
        envelopeOut,
      }, {
        stageA: fixture.stageAVerifier,
        ci: fixture.ciVerifier,
        approval: fixture.approvalVerifier,
      })).toThrow(/parent changed|anchored output/i);
      expect(attack.wasTriggered()).toBe(true);
      expect(fs.existsSync(path.join(fixture.publicRepo, "stage-b.json"))).toBe(false);
      expect(fs.existsSync(envelopeOut)).toBe(false);
      expect(fs.readdirSync(outputParent)).toEqual([]);
    } finally {
      attack.restore();
    }
  });

});
