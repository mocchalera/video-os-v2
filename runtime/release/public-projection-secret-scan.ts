import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PublicProjectionError,
  canonicalJsonBytes,
  sha256Hex,
  type ApprovedAttestationVerifier,
  type ProjectionGenerationSnapshot,
  type PublicProjectionPolicy,
  type PublicProjectionScanAttestation,
} from "./public-projection.js";

export const REPOSITORY_SECRET_SCAN_PRODUCER_ID =
  "video-os-repository-secret-scan-wrapper";
export const REPOSITORY_SECRET_SCAN_WRAPPER_VERSION = "1.0.0";
export const REPOSITORY_SECRET_SCAN_KEY_ID = "repository-owned-rerun-v1";
export const REPOSITORY_SECRET_SCAN_VERIFIER_ID =
  "video-os-repository-secret-scan-rerun-verifier/v1";

export interface RepositorySecretScanFinding {
  line: number;
  match_sha256: string;
  offset: number;
  path_b64: string;
  rule_id: string;
}

export interface RepositorySecretScanResult {
  version: "public-projection-secret-scan-result/v1";
  scanner: {
    name: string;
    version: string;
    binary_sha256: string;
    rules_sha256: string;
  };
  target_payload_sha256: string;
  findings: RepositorySecretScanFinding[];
  result: PublicProjectionScanAttestation["result"];
}

export interface RepositorySecretScanExecutionReceipt {
  version: "approved-wrapper-execution-receipt/v1";
  producer: PublicProjectionScanAttestation["producer"];
  attestation_sha256: string;
  scan_result: RepositorySecretScanResult;
}

export interface RepositorySecretScanPaths {
  scannerPath: string;
  rulesPath: string;
  wrapperPath: string;
  verifierPath: string;
}

export function repositorySecretScanPaths(): RepositorySecretScanPaths {
  return {
    scannerPath: fileURLToPath(new URL("../../scripts/public-projection-secret-scanner.mjs", import.meta.url)),
    rulesPath: fileURLToPath(new URL("./public-projection-secret-rules.json", import.meta.url)),
    wrapperPath: fileURLToPath(new URL("../../scripts/run-public-projection-secret-scan.ts", import.meta.url)),
    verifierPath: fileURLToPath(import.meta.url),
  };
}

function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicProjectionError(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new PublicProjectionError(`${label} has unexpected or missing keys`);
  }
}

function parseCanonical<T>(bytes: Buffer, label: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new PublicProjectionError(`${label} is not valid JSON`);
  }
  if (!bytes.equals(canonicalJsonBytes(parsed))) {
    throw new PublicProjectionError(`${label} is not canonical JSON`);
  }
  return parsed;
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PublicProjectionError(`${label} must be a lowercase SHA-256`);
  }
}

function assertScanResult(value: RepositorySecretScanResult): void {
  exactKeys(value, ["version", "scanner", "target_payload_sha256", "findings", "result"], "scan result");
  exactKeys(value.scanner, ["name", "version", "binary_sha256", "rules_sha256"], "scan result scanner");
  exactKeys(value.result, ["status", "exit_code", "finding_count"], "scan result status");
  if (value.version !== "public-projection-secret-scan-result/v1") {
    throw new PublicProjectionError("unsupported repository secret scan result");
  }
  assertSha(value.target_payload_sha256, "scan target payload digest");
  assertSha(value.scanner.binary_sha256, "scanner binary digest");
  assertSha(value.scanner.rules_sha256, "scanner rules digest");
  if (!Array.isArray(value.findings)) throw new PublicProjectionError("scan findings must be an array");
  for (const finding of value.findings) {
    exactKeys(finding, ["line", "match_sha256", "offset", "path_b64", "rule_id"], "scan finding");
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) throw new PublicProjectionError("scan finding line is invalid");
    if (!Number.isSafeInteger(finding.offset) || finding.offset < 0) throw new PublicProjectionError("scan finding offset is invalid");
    assertSha(finding.match_sha256, "scan finding digest");
    if (typeof finding.path_b64 !== "string" || Buffer.from(finding.path_b64, "base64").toString("base64") !== finding.path_b64) {
      throw new PublicProjectionError("scan finding path is not canonical base64");
    }
    if (typeof finding.rule_id !== "string" || !/^[a-z0-9-]+$/.test(finding.rule_id)) {
      throw new PublicProjectionError("scan finding rule ID is invalid");
    }
  }
  if (value.result.finding_count !== value.findings.length) {
    throw new PublicProjectionError("scan finding count does not match findings ledger");
  }
  const expected = value.findings.length === 0
    ? { status: "clean", exit_code: 0 }
    : { status: "findings", exit_code: 2 };
  if (value.result.status !== expected.status || value.result.exit_code !== expected.exit_code) {
    throw new PublicProjectionError("scan exit/result does not match findings ledger");
  }
}

export function runRepositorySecretScanner(options: {
  stagingRoot: string;
  targetPayloadSha256: string;
  paths?: RepositorySecretScanPaths;
}): { bytes: Buffer; result: RepositorySecretScanResult } {
  assertSha(options.targetPayloadSha256, "scan target payload digest");
  const paths = options.paths ?? repositorySecretScanPaths();
  const execution = spawnSync(process.execPath, [
    fs.realpathSync(paths.scannerPath),
    "--staging",
    fs.realpathSync(options.stagingRoot),
    "--rules",
    fs.realpathSync(paths.rulesPath),
    "--target-payload-sha256",
    options.targetPayloadSha256,
  ], {
    cwd: path.dirname(fs.realpathSync(paths.scannerPath)),
    encoding: "buffer",
    env: { LANG: "C", LC_ALL: "C" },
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (execution.error) throw new PublicProjectionError(`secret scanner failed to execute: ${execution.error.message}`);
  if (execution.status !== 0 && execution.status !== 2) {
    const stderr = execution.stderr.toString("utf8").trim();
    throw new PublicProjectionError(`secret scanner error${stderr ? `: ${stderr}` : ""}`);
  }
  const bytes = execution.stdout;
  const result = parseCanonical<RepositorySecretScanResult>(bytes, "secret scanner output");
  assertScanResult(result);
  if (result.result.exit_code !== execution.status) {
    throw new PublicProjectionError("secret scanner process exit does not match its result");
  }
  const scannerDigest = sha256Hex(fs.readFileSync(paths.scannerPath));
  const rulesDigest = sha256Hex(fs.readFileSync(paths.rulesPath));
  if (result.scanner.name !== "video-os-repository-secret-scanner"
    || result.scanner.version !== "video-os-public-secret-scanner/v1"
    || result.scanner.binary_sha256 !== scannerDigest
    || result.scanner.rules_sha256 !== rulesDigest) {
    throw new PublicProjectionError("secret scanner identity does not match repository-owned code and rules");
  }
  if (result.target_payload_sha256 !== options.targetPayloadSha256) {
    throw new PublicProjectionError("secret scanner target digest mismatch");
  }
  return { bytes, result };
}

export function repositorySecretScanProducer(
  paths = repositorySecretScanPaths(),
): PublicProjectionScanAttestation["producer"] {
  return {
    producer_id: REPOSITORY_SECRET_SCAN_PRODUCER_ID,
    wrapper_version: REPOSITORY_SECRET_SCAN_WRAPPER_VERSION,
    wrapper_sha256: sha256Hex(fs.readFileSync(paths.wrapperPath)),
    verifier_sha256: sha256Hex(fs.readFileSync(paths.verifierPath)),
    key_id: REPOSITORY_SECRET_SCAN_KEY_ID,
  };
}

export function createRepositorySecretScanArtifacts(options: {
  stagingRoot: string;
  generationSnapshot: ProjectionGenerationSnapshot;
  paths?: RepositorySecretScanPaths;
}): {
  attestation: PublicProjectionScanAttestation;
  attestationBytes: Buffer;
  executionReceipt: RepositorySecretScanExecutionReceipt;
  executionReceiptBytes: Buffer;
} {
  const paths = options.paths ?? repositorySecretScanPaths();
  const scanned = runRepositorySecretScanner({
    stagingRoot: options.stagingRoot,
    targetPayloadSha256: options.generationSnapshot.public_payload_sha256,
    paths,
  });
  const producer = repositorySecretScanProducer(paths);
  const attestation: PublicProjectionScanAttestation = {
    version: "public-projection-scan-attestation/v1",
    producer,
    scanner: scanned.result.scanner,
    target_payload_sha256: scanned.result.target_payload_sha256,
    result: scanned.result.result,
  };
  const attestationBytes = canonicalJsonBytes(attestation);
  const executionReceipt: RepositorySecretScanExecutionReceipt = {
    version: "approved-wrapper-execution-receipt/v1",
    producer,
    attestation_sha256: sha256Hex(attestationBytes),
    scan_result: scanned.result,
  };
  return {
    attestation,
    attestationBytes,
    executionReceipt,
    executionReceiptBytes: canonicalJsonBytes(executionReceipt),
  };
}

export function createBoundRepositorySecretScanVerifier(options: {
  stagingRoot: string;
  paths?: RepositorySecretScanPaths;
}): ApprovedAttestationVerifier {
  const paths = options.paths ?? repositorySecretScanPaths();
  return {
    verify(input) {
      if (input.verificationEvidence.mechanism !== "approved-wrapper-execution-receipt") {
        throw new PublicProjectionError("repository secret scan verifier accepts only its execution receipt");
      }
      const receipt = parseCanonical<RepositorySecretScanExecutionReceipt>(
        input.verificationEvidence.bytes,
        "approved wrapper execution receipt",
      );
      exactKeys(receipt, ["version", "producer", "attestation_sha256", "scan_result"], "approved wrapper execution receipt");
      if (receipt.version !== "approved-wrapper-execution-receipt/v1") {
        throw new PublicProjectionError("unsupported approved wrapper execution receipt");
      }
      const producer = repositorySecretScanProducer(paths);
      if (!canonicalJsonBytes(receipt.producer).equals(canonicalJsonBytes(producer))
        || !canonicalJsonBytes(input.approvedProducer).equals(canonicalJsonBytes(producer))
        || !canonicalJsonBytes(input.attestation.producer).equals(canonicalJsonBytes(producer))) {
        throw new PublicProjectionError("secret scan wrapper/verifier trust root mismatch");
      }
      if (receipt.attestation_sha256 !== sha256Hex(input.attestationBytes)) {
        throw new PublicProjectionError("execution receipt does not bind the exact scan attestation");
      }
      assertScanResult(receipt.scan_result);
      if (!canonicalJsonBytes(receipt.scan_result.scanner).equals(canonicalJsonBytes(input.attestation.scanner))
        || !canonicalJsonBytes(receipt.scan_result.result).equals(canonicalJsonBytes(input.attestation.result))
        || receipt.scan_result.target_payload_sha256 !== input.attestation.target_payload_sha256) {
        throw new PublicProjectionError("execution receipt does not bind the exact scan result");
      }
      const rerun = runRepositorySecretScanner({
        stagingRoot: options.stagingRoot,
        targetPayloadSha256: input.attestation.target_payload_sha256,
        paths,
      });
      if (!rerun.bytes.equals(canonicalJsonBytes(receipt.scan_result))) {
        throw new PublicProjectionError("secret scan execution receipt does not match a trusted rerun");
      }
      if (rerun.result.result.status !== "clean") {
        throw new PublicProjectionError("secret scan rerun reported findings");
      }
      return {
        mechanism: "approved-wrapper-execution-receipt",
        verifier_id: REPOSITORY_SECRET_SCAN_VERIFIER_ID,
        producer_id: producer.producer_id,
        key_id: producer.key_id,
      };
    },
  };
}

export function assertPolicyApprovesRepositorySecretScan(
  policy: PublicProjectionPolicy,
  paths = repositorySecretScanPaths(),
): void {
  const producer = repositorySecretScanProducer(paths);
  const scanner = {
    name: "video-os-repository-secret-scanner",
    version: "video-os-public-secret-scanner/v1",
    binary_sha256: sha256Hex(fs.readFileSync(paths.scannerPath)),
    rules_sha256: sha256Hex(fs.readFileSync(paths.rulesPath)),
  };
  if (!policy.secret_scan.approved_producers.some((candidate) =>
    canonicalJsonBytes(candidate).equals(canonicalJsonBytes(producer)))) {
    throw new PublicProjectionError("policy does not approve the exact repository secret scan producer");
  }
  if (!policy.secret_scan.approved_scanners.some((candidate) =>
    canonicalJsonBytes(candidate).equals(canonicalJsonBytes(scanner)))) {
    throw new PublicProjectionError("policy does not approve the exact repository secret scanner and rules");
  }
}
