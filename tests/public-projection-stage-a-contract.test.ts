import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  generatePublicProjection,
  verifyPublicProjectionReceipt,
  type ApprovedAttestationVerifier,
  type PublicProjectionScanAttestation,
} from "../runtime/release/public-projection.js";
import {
  SHA_A,
  commitAll,
  makeWritable,
  schemaValidator,
  stageAFixture,
  wrapperStageAReceipt,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04a Stage A projection contract", () => {
  it("projects only declared paths and preserves Git type/mode/content identities", () => {
    const fixture = stageAFixture();
    const ledger = fixture.receipt.public_path_ledger;
    expect(ledger.map((entry) => entry.path)).toEqual([
      ".github/workflows/ci.yml",
      "README.md",
      "bin/run.sh",
      "docs-link",
    ]);
    expect(ledger.find((entry) => entry.path === "bin/run.sh")?.mode).toBe("100755");
    expect(ledger.find((entry) => entry.path === "docs-link")).toMatchObject({
      type: "symlink",
      mode: "120000",
      target_b64: Buffer.from("README.md").toString("base64"),
    });
    expect(fixture.receipt.policy_ledger.find((entry) => entry.path === "private/local.txt"))
      .toMatchObject({ decision: "exclude", reason: "private test material" });
  });

  it("makes every staging directory non-writable and rejects permission drift", () => {
    const fixture = stageAFixture();
    for (const relative of ["", ".github", ".github/workflows", "bin"]) {
      const directory = path.join(fixture.staging, relative);
      expect(fs.lstatSync(directory).mode & 0o222, relative || ".").toBe(0);
    }

    fs.chmodSync(path.join(fixture.staging, ".github"), 0o755);
    expect(() => verifyPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      receiptBytes: fixture.receiptBytes,
      attestationVerifier: fixture.verifier,
    })).toThrow(/staging .*directory .*writable/i);
  });

  it("verifies canonical Stage A bytes against source, policy, staging, and trusted scan", () => {
    const fixture = stageAFixture();
    expect(verifyPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      receiptBytes: fixture.receiptBytes,
      attestationVerifier: fixture.verifier,
    })).toEqual(fixture.receipt);
  });

  it("accepts mutually exclusive detached-signature and wrapper execution receipt routes", () => {
    const fixture = stageAFixture();
    const validate = schemaValidator("public-projection-receipt.schema.json");
    const wrapper = wrapperStageAReceipt(fixture);

    expect(validate(fixture.receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(fixture.receipt.secret_scan).toHaveProperty("detached_signature_b64");
    expect(fixture.receipt.secret_scan).not.toHaveProperty(
      "approved_wrapper_execution_receipt_b64",
    );
    expect(validate(wrapper.receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(wrapper.receipt.secret_scan).toHaveProperty(
      "approved_wrapper_execution_receipt_b64",
    );
    expect(wrapper.receipt.secret_scan).not.toHaveProperty("detached_signature_b64");
    expect(verifyPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      receiptBytes: wrapper.receiptBytes,
      attestationVerifier: wrapper.verifier,
    })).toEqual(wrapper.receipt);
  });

  it("rejects cross-mechanism Stage A evidence tampering", () => {
    const fixture = stageAFixture();
    const validate = schemaValidator("public-projection-receipt.schema.json");
    const detachedTamper = structuredClone(fixture.receipt);
    detachedTamper.secret_scan.verification.mechanism =
      "approved-wrapper-execution-receipt";
    expect(validate(detachedTamper)).toBe(false);
    expect(() => verifyPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      receiptBytes: canonicalJsonBytes(detachedTamper),
      attestationVerifier: fixture.verifier,
    })).toThrow(/mechanism|exclusive|exact keys/i);

    const wrapper = wrapperStageAReceipt(fixture);
    const wrapperTamper = structuredClone(wrapper.receipt);
    wrapperTamper.secret_scan.verification.mechanism = "detached-signature";
    expect(validate(wrapperTamper)).toBe(false);
    expect(() => verifyPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      receiptBytes: canonicalJsonBytes(wrapperTamper),
      attestationVerifier: wrapper.verifier,
    })).toThrow(/mechanism|exclusive|exact keys/i);
  });

});
