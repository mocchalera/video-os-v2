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
  stageAFixture,
} from "./helpers/public-projection-fixtures.js";

describe("IMP-04a Stage A integrity rejection", () => {
  it("rejects dirty source and committed allowlist-unknown paths", () => {
    const fixture = stageAFixture();
    makeWritable(fixture.source);
    fs.writeFileSync(path.join(fixture.source, "dirty.txt"), "dirty\n");
    expect(() => generatePublicProjection({
      sourceRoot: fixture.source,
      outputRoot: path.join(fixture.root, "dirty-output"),
      policyPath: fixture.policyPath,
    })).toThrow(/dirty/i);

    fs.rmSync(path.join(fixture.source, "dirty.txt"));
    fs.writeFileSync(path.join(fixture.source, "unknown.txt"), "unknown\n");
    commitAll(fixture.source, "unknown path");
    expect(() => generatePublicProjection({
      sourceRoot: fixture.source,
      outputRoot: path.join(fixture.root, "unknown-output"),
      policyPath: fixture.policyPath,
    })).toThrow(/not covered by projection policy/i);
  });

  it("rejects absolute and escaping symlinks", () => {
    const fixture = stageAFixture();
    makeWritable(fixture.source);
    fs.unlinkSync(path.join(fixture.source, "docs-link"));
    fs.symlinkSync("../outside", path.join(fixture.source, "docs-link"));
    commitAll(fixture.source, "escaping symlink");
    expect(() => generatePublicProjection({
      sourceRoot: fixture.source,
      outputRoot: path.join(fixture.root, "symlink-output"),
      policyPath: fixture.policyPath,
    })).toThrow(/symlink target/i);
  });

  it("rejects unsigned, wrong-producer, target mismatch, findings, and non-zero scans", () => {
    const fixture = stageAFixture();
    const build = (
      patch: (attestation: PublicProjectionScanAttestation) => void,
      signatureBytes = fixture.signatureBytes,
    ) => {
      const attestation = structuredClone(fixture.attestation);
      patch(attestation);
      return () => buildPublicProjectionReceipt({
        sourceRoot: fixture.source,
        stagingRoot: fixture.staging,
        policyPath: fixture.policyPath,
        generationSnapshot: fixture.snapshot,
        attestationBytes: canonicalJsonBytes(attestation),
        signatureBytes,
        attestationVerifier: fixture.verifier,
      });
    };

    expect(build(() => undefined, Buffer.alloc(0))).toThrow(/signature/i);
    expect(build((value) => { value.producer.producer_id = "unknown"; })).toThrow(/producer/i);
    expect(build((value) => { value.target_payload_sha256 = SHA_A; })).toThrow(/target payload/i);
    expect(build((value) => { value.result.finding_count = 1; value.result.status = "findings"; }))
      .toThrow(/finding/i);
    expect(build((value) => { value.result.exit_code = 2; value.result.status = "error"; }))
      .toThrow(/exit code/i);
  });

  it("rejects source tampering after generation", () => {
    const fixture = stageAFixture();
    makeWritable(fixture.source);
    fs.writeFileSync(path.join(fixture.source, "private", "local.txt"), "changed excluded input\n");
    commitAll(fixture.source, "source moved after generation");
    expect(() => buildPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      generationSnapshot: fixture.snapshot,
      attestationBytes: fixture.attestationBytes,
      signatureBytes: fixture.signatureBytes,
      attestationVerifier: fixture.verifier,
    })).toThrow(/source .* changed/i);
  });

  it("rejects policy tampering after generation", () => {
    const fixture = stageAFixture();
    fs.appendFileSync(fixture.policyPath, "\n# changed after generation\n");
    expect(() => buildPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      generationSnapshot: fixture.snapshot,
      attestationBytes: fixture.attestationBytes,
      signatureBytes: fixture.signatureBytes,
      attestationVerifier: fixture.verifier,
    })).toThrow(/policy changed/i);
  });

  it("rejects staging tampering after generation", () => {
    const fixture = stageAFixture();
    makeWritable(fixture.staging);
    fs.writeFileSync(path.join(fixture.staging, "README.md"), "tampered\n");
    expect(() => buildPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      generationSnapshot: fixture.snapshot,
      attestationBytes: fixture.attestationBytes,
      signatureBytes: fixture.signatureBytes,
      attestationVerifier: fixture.verifier,
    })).toThrow(/staging .* changed/i);
  });

  it("rejects receipt ledger tampering", () => {
    const fixture = stageAFixture();
    const tamperedReceipt = structuredClone(fixture.receipt);
    tamperedReceipt.public_path_ledger[0].sha256 = SHA_A;
    expect(() => verifyPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      receiptBytes: canonicalJsonBytes(tamperedReceipt),
      attestationVerifier: fixture.verifier,
    })).toThrow(/receipt|ledger|mismatch/i);
  });

  it("rejects scan-to-finalize staging races", () => {
    const fixture = stageAFixture();
    const raceVerifier: ApprovedAttestationVerifier = {
      verify(input) {
        const result = fixture.verifier.verify(input);
        makeWritable(fixture.staging);
        fs.writeFileSync(path.join(fixture.staging, "README.md"), "changed during verification\n");
        return result;
      },
    };
    expect(() => buildPublicProjectionReceipt({
      sourceRoot: fixture.source,
      stagingRoot: fixture.staging,
      policyPath: fixture.policyPath,
      generationSnapshot: fixture.snapshot,
      attestationBytes: fixture.attestationBytes,
      signatureBytes: fixture.signatureBytes,
      attestationVerifier: raceVerifier,
    })).toThrow(/staging .* changed/i);
  });
});
