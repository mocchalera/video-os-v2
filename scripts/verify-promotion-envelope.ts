import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import {
  buildPromotionEnvelope,
  canonicalJsonBytes,
  inspectSafeOutputPath,
  verifyPromotionEnvelope,
  writeExclusiveOutputFile,
  type PromotionApprovalReceipt,
  type PromotionCiEvidence,
  type PromotionDestination,
  type PromotionEnvelope,
  type PublicProjectionReceipt,
  type TrustedEvidenceVerifier,
} from "../runtime/release/public-projection.js";
import {
  configuredApprovalTrustRoot,
  configuredStageATrustRoot,
  createApprovalReceiptSignatureVerifier,
  createGitHubProviderEvidenceVerifier,
  createStageAReceiptSignatureVerifier,
  fixedPublicPromotionDestination,
  readPublicPromotionTrustConfig,
  unconfiguredApprovalSignatureHandoff,
  unconfiguredStageASignatureHandoff,
} from "../runtime/release/public-promotion-adapters.js";

export interface VerifyPromotionEnvelopeCliArgs {
  stageA: string;
  publicRepository: string;
  publicCommit: string;
  destinationProvider: "github";
  destinationRepositoryId: string;
  destinationRepositoryFullName: string;
  destinationBranch: string;
  workflowPath: string;
  workflowBlobSha: string;
  ciEvidence: string;
  approvalReceipt: string;
  envelopeOut: string;
}

export interface VerifyPromotionEnvelopeProductionCliArgs {
  stageA: string;
  stageASignature: string;
  publicRepository: string;
  publicCommit: string;
  ciEvidence: string;
  approvalReceipt: string;
  approvalSignature: string;
  envelopeOut: string;
}

export function parseVerifyPromotionEnvelopeArgs(argv: string[]): VerifyPromotionEnvelopeProductionCliArgs {
  const allowed = [
    "--stage-a",
    "--stage-a-signature",
    "--public-repository",
    "--public-commit",
    "--ci-evidence",
    "--approval-receipt",
    "--approval-signature",
    "--envelope-out",
  ];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, value);
  }
  for (const required of allowed) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    stageA: values.get("--stage-a")!,
    stageASignature: values.get("--stage-a-signature")!,
    publicRepository: values.get("--public-repository")!,
    publicCommit: values.get("--public-commit")!,
    ciEvidence: values.get("--ci-evidence")!,
    approvalReceipt: values.get("--approval-receipt")!,
    approvalSignature: values.get("--approval-signature")!,
    envelopeOut: values.get("--envelope-out")!,
  };
}

function exactWorkflowBlob(publicRepository: string, commit: string, workflowPath: string): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  const result = execFileSync("git", [
    "--no-replace-objects", "rev-parse", "--verify", `${commit}:${workflowPath}`,
  ], {
    cwd: publicRepository,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) {
    throw new Error("Exact public workflow blob did not resolve to a full Git object ID");
  }
  return result;
}

export function verifyPromotionEnvelopeWithTrustedVerifiers(
  args: VerifyPromotionEnvelopeCliArgs,
  verifiers: {
    stageA: TrustedEvidenceVerifier<PublicProjectionReceipt>;
    ci: TrustedEvidenceVerifier<PromotionCiEvidence>;
    approval: TrustedEvidenceVerifier<PromotionApprovalReceipt>;
  },
): PromotionEnvelope {
  const publicRepository = path.resolve(args.publicRepository);
  const outputInspection = inspectSafeOutputPath({
    outputPath: args.envelopeOut,
    protectedRoot: publicRepository,
    label: "Stage B promotion envelope output",
  });
  const output = outputInspection.resolvedPath;
  if (outputInspection.exists && !outputInspection.stat?.isFile()) {
    throw new Error("Stage B promotion envelope output must be a regular file");
  }
  const destination: PromotionDestination = {
    provider: args.destinationProvider,
    repository_id: args.destinationRepositoryId,
    repository_full_name: args.destinationRepositoryFullName,
    branch: args.destinationBranch,
  };
  const options = {
    stageAReceiptBytes: fs.readFileSync(args.stageA),
    stageAReceiptVerifier: verifiers.stageA,
    publicRepository: args.publicRepository,
    exactPublicCommit: args.publicCommit,
    destination,
    workflowPath: args.workflowPath,
    workflowBlobSha: args.workflowBlobSha,
    ciEvidenceBytes: fs.readFileSync(args.ciEvidence),
    approvalReceiptBytes: fs.readFileSync(args.approvalReceipt),
    ciEvidenceVerifier: verifiers.ci,
    approvalReceiptVerifier: verifiers.approval,
  };
  if (outputInspection.exists) {
    return verifyPromotionEnvelope({
      ...options,
      envelopeBytes: fs.readFileSync(output),
    });
  }
  const envelope = buildPromotionEnvelope(options);
  writeExclusiveOutputFile({
    outputPath: output,
    protectedRoot: publicRepository,
    label: "Stage B promotion envelope output",
    bytes: canonicalJsonBytes(envelope),
    mode: 0o400,
  });
  return envelope;
}

function main(): void {
  try {
    const args = parseVerifyPromotionEnvelopeArgs(process.argv.slice(2));
    const config = readPublicPromotionTrustConfig();
    const destination = fixedPublicPromotionDestination();
    if (!config.stage_a_authentication.configured) {
      process.stderr.write(canonicalJsonBytes(unconfiguredStageASignatureHandoff()).toString("utf8"));
      process.exitCode = 1;
      return;
    }
    if (!config.approval_authentication.configured) {
      process.stderr.write(canonicalJsonBytes(unconfiguredApprovalSignatureHandoff()).toString("utf8"));
      process.exitCode = 1;
      return;
    }
    const trustRoot = configuredStageATrustRoot();
    const approvalTrustRoot = configuredApprovalTrustRoot();
    const envelope = verifyPromotionEnvelopeWithTrustedVerifiers({
      stageA: args.stageA,
      publicRepository: args.publicRepository,
      publicCommit: args.publicCommit,
      destinationProvider: destination.provider,
      destinationRepositoryId: destination.repository_id,
      destinationRepositoryFullName: destination.repository_full_name,
      destinationBranch: destination.branch,
      workflowPath: config.workflow.path,
      workflowBlobSha: exactWorkflowBlob(
        args.publicRepository,
        args.publicCommit,
        config.workflow.path,
      ),
      ciEvidence: args.ciEvidence,
      approvalReceipt: args.approvalReceipt,
      envelopeOut: args.envelopeOut,
    }, {
      stageA: createStageAReceiptSignatureVerifier(trustRoot, args.stageASignature),
      ci: createGitHubProviderEvidenceVerifier(),
      approval: createApprovalReceiptSignatureVerifier(
        approvalTrustRoot,
        args.approvalSignature,
      ),
    });
    process.stdout.write(`${envelope.public_commit_sha}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
