import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalVerificationMechanism,
  buildPromotionEnvelope,
  canonicalJsonBytes,
  sha256Hex,
  type PromotionApprovalReceiptV1,
} from "../runtime/release/public-projection.js";
import {
  createApprovalReceiptSignatureVerifier,
  createCockpitApprovalEventVerifier,
  createExternalSignedPromotionApproval,
  parseExternalSignedPromotionApproval,
  unconfiguredApprovalSignatureHandoff,
  type PromotionApprovalRequest,
} from "../runtime/release/public-promotion-adapters.js";
import {
  prepareSignedPublicPromotionApproval,
} from "../scripts/prepare-signed-public-promotion-approval.js";
import {
  recordSignedPublicPromotionApproval,
} from "../scripts/record-signed-public-promotion-approval.js";
import {
  exactCanonicalEvidenceVerifier,
  promotionOptions,
  schemaValidator,
  stageBFixture,
  tempRoot,
} from "./helpers/public-projection-fixtures.js";

function signedRequest(stageAReceiptSha256: string): PromotionApprovalRequest {
  return {
    version: "public-promotion-approval-request/v1",
    stage_a_receipt_sha256: stageAReceiptSha256,
    destination: {
      provider: "github",
      repository_id: "1188541623",
      repository_full_name: "mocchalera/video-os-v2",
      branch: "main",
    },
    operation_scope: {
      operation: "push-exact-projection",
      event: "push",
      workflow_path: ".github/workflows/ci.yml",
    },
  };
}

describe("external signed promotion approval", () => {
  it("prepares deterministic canonical approval bytes and fail-closes record without a configured key", () => {
    const root = fs.realpathSync(tempRoot("signed-approval-prepare"));
    const protectedRoot = path.join(root, "public-repository");
    const outDir = path.join(root, "evidence");
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(outDir, { mode: 0o700 });
    const request = signedRequest("d".repeat(64));
    const requestPath = path.join(outDir, "request.json");
    const firstOut = path.join(outDir, "approval.json");
    fs.writeFileSync(requestPath, canonicalJsonBytes(request));
    const first = createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-public-1",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
    });
    const second = createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-public-1",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
    });
    expect(canonicalJsonBytes(first).equals(canonicalJsonBytes(second))).toBe(true);
    const prepared = prepareSignedPublicPromotionApproval({
      requestPath,
      approvalId: "approval-public-1",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
      output: firstOut,
      protectedRoot,
    });
    expect(prepared).toEqual(first);
    expect(fs.readFileSync(firstOut).equals(canonicalJsonBytes(first))).toBe(true);
    expect(() => prepareSignedPublicPromotionApproval({
      requestPath,
      approvalId: "approval-public-1",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
      output: firstOut,
      protectedRoot,
    })).toThrow(/already exists/i);

    const recordedOut = path.join(outDir, "recorded.json");
    try {
      recordSignedPublicPromotionApproval({
        requestPath,
        approvalPath: firstOut,
        signaturePath: path.join(root, "missing.sig"),
        output: recordedOut,
        protectedRoot,
      });
      throw new Error("expected unconfigured approval handoff");
    } catch (error) {
      expect((error as { handoff?: { version?: string } }).handoff).toMatchObject({
        version: "approval-signature-handoff/v1",
        configured: false,
      });
    }
    expect(fs.existsSync(recordedOut)).toBe(false);
    expect(unconfiguredApprovalSignatureHandoff().required_from_external_custodian).toEqual(expect.arrayContaining([
      "public key PEM",
      "public key SHA-256",
      "key_id",
    ]));
  });

  it("rejects unknown keys, invalid time, request mismatch, non-canonical JSON, and Cockpit spoofs", () => {
    const request = signedRequest("a".repeat(64));
    const approval = createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-public-2",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
    });
    expect(parseExternalSignedPromotionApproval(canonicalJsonBytes(approval), request)).toEqual(approval);

    const extra = { ...approval, extra: true };
    expect(() => parseExternalSignedPromotionApproval(canonicalJsonBytes(extra), request))
      .toThrow(/unexpected or missing keys/i);

    expect(() => createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-public-2",
      approverIdentity: "human:operator",
      approvedAt: "2026-02-30T00:00:00Z",
    })).toThrow(/supported RFC 3339 subset/i);

    const mismatched = signedRequest("b".repeat(64));
    expect(() => parseExternalSignedPromotionApproval(canonicalJsonBytes(approval), mismatched))
      .toThrow(/exact promotion request/i);

    const pretty = Buffer.from(`${JSON.stringify(approval, null, 2)}\n`);
    expect(() => parseExternalSignedPromotionApproval(pretty, request)).toThrow(/canonical JSON/i);

    expect(() => createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-public-2",
      approverIdentity: "cockpit:user",
      approvedAt: "2026-08-19T12:00:00.000Z",
    })).toThrow(/Cockpit identity/i);

    const cockpit: PromotionApprovalReceiptV1 = {
      version: "promotion-approval-receipt/v1",
      approval_id: "ask_spoof",
      approver: { identity: "cockpit:user" },
      approved_at: "2026-08-19T12:00:00.000Z",
      stage_a_receipt_sha256: request.stage_a_receipt_sha256,
      destination: request.destination,
      operation_scope: request.operation_scope,
      cockpit_source: { task_id: "task_spoof", event_id: "ask_spoof" },
    };
    expect(() => parseExternalSignedPromotionApproval(canonicalJsonBytes(cockpit), request))
      .toThrow(/unexpected or missing keys|not an external signed/i);
    expect(() => createCockpitApprovalEventVerifier({
      reader: () => ({ id: "task_spoof", conversation: [] }),
    }).verify(canonicalJsonBytes(approval))).toThrow(/external signed approval/i);

    const handwritten = {
      event: "cockpit.ask.resolved",
      version: 2,
      ask_id: "ask_spoof",
      outcome: "answered",
      answered_by: "user",
      resolved_at: "2026-08-19T12:00:00.000Z",
      answers: [{ type: "choice", value: "approve-public-promotion:deadbeef" }],
    };
    expect(() => parseExternalSignedPromotionApproval(canonicalJsonBytes(handwritten), request))
      .toThrow(/unexpected or missing keys|not an external signed/i);
  });

  it("rejects extra or missing nested request keys before writing output", () => {
    const root = fs.realpathSync(tempRoot("signed-approval-nested-keys"));
    const protectedRoot = path.join(root, "public-repository");
    const outDir = path.join(root, "evidence");
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(outDir, { mode: 0o700 });
    const request = signedRequest("e".repeat(64));
    const approval = createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-nested",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
    });

    const extraDestination = {
      ...request,
      destination: { ...request.destination, extra: true },
    };
    const missingDestinationBranch = {
      ...request,
      destination: {
        provider: request.destination.provider,
        repository_id: request.destination.repository_id,
        repository_full_name: request.destination.repository_full_name,
      },
    };
    const extraScope = {
      ...request,
      operation_scope: { ...request.operation_scope, extra: true },
    };
    const missingScopeEvent = {
      ...request,
      operation_scope: {
        operation: request.operation_scope.operation,
        workflow_path: request.operation_scope.workflow_path,
      },
    };

    for (const [label, malformed] of [
      ["destination extra", extraDestination],
      ["destination missing branch", missingDestinationBranch],
      ["scope extra", extraScope],
      ["scope missing event", missingScopeEvent],
    ] as const) {
      expect(
        () => createExternalSignedPromotionApproval({
          request: malformed as PromotionApprovalRequest,
          approvalId: "approval-nested",
          approverIdentity: "human:operator",
          approvedAt: "2026-08-19T12:00:00.000Z",
        }),
        label,
      ).toThrow(/unexpected or missing keys/i);
      expect(
        () => parseExternalSignedPromotionApproval(
          canonicalJsonBytes(approval),
          malformed as PromotionApprovalRequest,
        ),
        `parse ${label}`,
      ).toThrow(/unexpected or missing keys/i);

      const requestPath = path.join(outDir, `${label.replaceAll(" ", "-")}.json`);
      const output = path.join(outDir, `${label.replaceAll(" ", "-")}-approval.json`);
      fs.writeFileSync(requestPath, canonicalJsonBytes(malformed));
      expect(() => prepareSignedPublicPromotionApproval({
        requestPath,
        approvalId: "approval-nested",
        approverIdentity: "human:operator",
        approvedAt: "2026-08-19T12:00:00.000Z",
        output,
        protectedRoot,
      }), `prepare ${label}`).toThrow(/unexpected or missing keys/i);
      expect(fs.existsSync(output), `prepare output ${label}`).toBe(false);
    }
  });

  it("accepts a Stage B envelope when the injected approval verifier uses detached-signature", () => {
    const fixture = stageBFixture();
    const request = signedRequest(sha256Hex(fixture.receiptBytes));
    request.destination = structuredClone(fixture.destination);
    request.operation_scope.workflow_path = fixture.workflowPath;
    const approval = {
      version: "external-signed-promotion-approval/v1" as const,
      approval_id: "approval-stage-b",
      approver: { identity: "human:operator" },
      approved_at: "2026-08-19T12:00:00.000Z",
      stage_a_receipt_sha256: request.stage_a_receipt_sha256,
      destination: structuredClone(fixture.destination),
      operation_scope: {
        operation: "push-exact-projection" as const,
        event: "push",
        workflow_path: fixture.workflowPath,
      },
    };
    const approvalBytes = canonicalJsonBytes(approval);
    expect(approvalVerificationMechanism(approval)).toBe("detached-signature");
    const envelope = buildPromotionEnvelope({
      ...promotionOptions(fixture),
      approvalReceiptBytes: approvalBytes,
      approvalReceiptVerifier: exactCanonicalEvidenceVerifier(approvalBytes, "test-only-approval-signer"),
    });
    expect(envelope.approval.version).toBe("external-signed-promotion-approval/v1");
    expect(envelope.approval.verification.mechanism).toBe("detached-signature");
    expect("cockpit_source" in envelope.approval).toBe(false);
    const validate = schemaValidator("promotion-envelope.schema.json");
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);

    const cockpitSpoof = structuredClone(envelope);
    (cockpitSpoof.approval as { cockpit_source?: { task_id: string; event_id: string } }).cockpit_source = {
      task_id: "task_spoof",
      event_id: "ask_spoof",
    };
    expect(validate(cockpitSpoof), JSON.stringify(validate.errors)).toBe(false);
  });

  it("fail-closes the openssl approval verifier on empty or dummy signatures without generating keys", () => {
    const root = fs.realpathSync(tempRoot("signed-approval-openssl"));
    const request = signedRequest("c".repeat(64));
    const approval = createExternalSignedPromotionApproval({
      request,
      approvalId: "approval-openssl",
      approverIdentity: "human:operator",
      approvedAt: "2026-08-19T12:00:00.000Z",
    });
    const dummyPem = path.join(root, "not-a-key.pem");
    const emptySig = path.join(root, "empty.sig");
    const junkSig = path.join(root, "junk.sig");
    fs.writeFileSync(dummyPem, "not-a-real-public-key\n");
    fs.writeFileSync(emptySig, "");
    fs.writeFileSync(junkSig, "junk-signature");
    const digest = sha256Hex(fs.readFileSync(dummyPem));
    const trustRoot = {
      keyId: "test-approval",
      publicKeyPath: dummyPem,
      publicKeySha256: digest,
    };
    expect(() => createApprovalReceiptSignatureVerifier(trustRoot, emptySig, request)
      .verify(canonicalJsonBytes(approval))).toThrow(/detached signature is empty/i);
    expect(() => createApprovalReceiptSignatureVerifier(trustRoot, junkSig, request)
      .verify(canonicalJsonBytes(approval))).toThrow(/detached signature verification failed/i);
    expect(() => createApprovalReceiptSignatureVerifier({
      ...trustRoot,
      publicKeySha256: "0".repeat(64),
    }, junkSig, request).verify(canonicalJsonBytes(approval))).toThrow(/digest|trust root changed/i);
  });
});
