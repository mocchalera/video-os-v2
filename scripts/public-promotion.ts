import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { devNull } from "node:os";
import * as path from "node:path";
import { isDirectRun } from "./helpers/direct-run.js";
import {
  PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL,
  PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME,
  PUBLIC_PROJECTION_COMMIT_TIMESTAMP,
  buildPublicProjectionReceipt,
  canonicalJsonBytes,
  canonicalPublicProjectionCandidateBranch,
  canonicalPublicProjectionCommitMessage,
  generatePublicProjection,
  sha256Hex,
  verifyCanonicalPublicProjectionCommit,
  writeExclusiveOutputFile,
  type PublicPathLedgerEntry,
  type PublicProjectionReceipt,
} from "../runtime/release/public-projection.js";
import {
  createBoundRepositorySecretScanVerifier,
  createRepositorySecretScanArtifacts,
} from "../runtime/release/public-projection-secret-scan.js";

export interface PreparePublicPromotionArgs {
  command: "prepare";
  source: string;
  sourceCommit: string;
  staging: string;
  evidenceDirectory: string;
  publicRepository: string;
}

function parsePairs(argv: string[], allowed: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${String(key)}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(`Missing required argument: ${key}`);
  return values;
}

export function parsePublicPromotionArgs(argv: string[]): PreparePublicPromotionArgs {
  const [command, ...rest] = argv;
  if (command !== "prepare") {
    throw new Error("Only the dry local 'prepare' command is supported; this tool never pushes");
  }
  const values = parsePairs(rest, [
    "--source",
    "--source-commit",
    "--staging",
    "--evidence-directory",
    "--public-repository",
  ]);
  const sourceCommit = values.get("--source-commit")!;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    throw new Error("--source-commit must be a full Git object ID");
  }
  return {
    command,
    source: values.get("--source")!,
    sourceCommit,
    staging: values.get("--staging")!,
    evidenceDirectory: values.get("--evidence-directory")!,
    publicRepository: values.get("--public-repository")!,
  };
}

function prospectiveRealPath(input: string): string {
  let existing = path.resolve(input);
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve output root: ${path.resolve(input)}`);
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  const inside = (value: string) => value === ""
    || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
  return inside(relative) || inside(reverse);
}

function assertSeparatedRoots(args: PreparePublicPromotionArgs, source: string): void {
  const outputs = [args.staging, args.evidenceDirectory, args.publicRepository];
  for (const output of outputs) {
    if (fs.existsSync(output)) throw new Error(`Output root already exists: ${path.resolve(output)}`);
  }
  const roots = [source, ...outputs.map(prospectiveRealPath)];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left], roots[right])) {
        throw new Error("Source, staging, evidence, and public repository roots must be disjoint");
      }
    }
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = devNull;
  return env;
}

function git(cwd: string, argv: string[], input?: Buffer): string {
  return execFileSync("git", ["--no-replace-objects", ...argv], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function gitFromFileDescriptor(cwd: string, argv: string[], inputFd: number): string {
  return execFileSync("git", ["--no-replace-objects", ...argv], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 256 * 1024 * 1024,
    stdio: [inputFd, "pipe", "pipe"],
  }).trim();
}

function stagingPath(root: string, pathBytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(root), Buffer.from(path.sep), pathBytes]);
}

function ledgerEntryBytes(staging: string, entry: PublicPathLedgerEntry): Buffer {
  const pathBytes = Buffer.from(entry.path_b64, "base64");
  if (pathBytes.toString("base64") !== entry.path_b64) {
    throw new Error(`Stage A ledger path is not canonical base64: ${entry.path}`);
  }
  const absolute = stagingPath(staging, pathBytes);
  const stat = fs.lstatSync(absolute);
  let bytes: Buffer;
  if (entry.type === "symlink") {
    if (!stat.isSymbolicLink() || entry.mode !== "120000") {
      throw new Error(`Stage A ledger type/mode mismatch at ${entry.path}`);
    }
    bytes = fs.readlinkSync(absolute, { encoding: "buffer" });
    if (bytes.toString("base64") !== entry.target_b64) {
      throw new Error(`Stage A ledger symlink target mismatch at ${entry.path}`);
    }
  } else {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Stage A ledger type mismatch at ${entry.path}`);
    }
    const executableMode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
    if (entry.mode !== executableMode) {
      throw new Error(`Stage A ledger executable mode mismatch at ${entry.path}`);
    }
    bytes = fs.readFileSync(absolute);
  }
  if (sha256Hex(bytes) !== entry.sha256) {
    throw new Error(`Stage A ledger content mismatch at ${entry.path}`);
  }
  return bytes;
}

function writeExactLedgerIndex(options: {
  staging: string;
  output: string;
  receipt: PublicProjectionReceipt;
}): void {
  const records: Buffer[] = [];
  const inputRoot = fs.mkdtempSync(
    path.join(options.output, ".git", "public-projection-blob-input-"),
  );
  const inputPath = path.join(inputRoot, "blob");
  try {
    for (const entry of options.receipt.public_path_ledger) {
      const pathBytes = Buffer.from(entry.path_b64, "base64");
      const bytes = ledgerEntryBytes(options.staging, entry);
      const writeFd = fs.openSync(
        inputPath,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW ?? 0),
        0o400,
      );
      try {
        fs.writeFileSync(writeFd, bytes);
        fs.fsyncSync(writeFd);
        const stat = fs.fstatSync(writeFd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length) {
          throw new Error(`Temporary Git blob input identity mismatch at ${entry.path}`);
        }
      } finally {
        fs.closeSync(writeFd);
      }
      const readFd = fs.openSync(
        inputPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      let objectId: string;
      try {
        objectId = gitFromFileDescriptor(options.output, ["hash-object", "-w", "--stdin"], readFd);
      } finally {
        fs.closeSync(readFd);
      }
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
        throw new Error(`Git did not return a full blob object ID for ${entry.path}`);
      }
      fs.unlinkSync(inputPath);
      records.push(
        Buffer.from(`${entry.mode} ${objectId}\t`, "ascii"),
        pathBytes,
        Buffer.from([0]),
      );
    }
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    fs.rmdirSync(inputRoot);
  }
  git(options.output, ["update-index", "-z", "--index-info"], Buffer.concat(records));
}

function createCanonicalPublicRepository(options: {
  staging: string;
  output: string;
  stageAReceipt: PublicProjectionReceipt;
  stageAReceiptBytes: Buffer;
}): { commit: string; branch: string } {
  fs.cpSync(options.staging, options.output, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
    verbatimSymlinks: true,
  });
  fs.chmodSync(options.output, 0o700);
  git(options.output, ["init", "--quiet"]);
  git(options.output, ["read-tree", "--empty"]);
  writeExactLedgerIndex({
    staging: options.staging,
    output: options.output,
    receipt: options.stageAReceipt,
  });
  const tree = git(options.output, ["write-tree"]);
  const stageAReceiptSha256 = sha256Hex(options.stageAReceiptBytes);
  const identityEnv = gitEnvironment();
  identityEnv.GIT_AUTHOR_NAME = PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME;
  identityEnv.GIT_AUTHOR_EMAIL = PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL;
  identityEnv.GIT_AUTHOR_DATE = `@${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`;
  identityEnv.GIT_COMMITTER_NAME = PUBLIC_PROJECTION_COMMIT_AUTHOR_NAME;
  identityEnv.GIT_COMMITTER_EMAIL = PUBLIC_PROJECTION_COMMIT_AUTHOR_EMAIL;
  identityEnv.GIT_COMMITTER_DATE = `@${PUBLIC_PROJECTION_COMMIT_TIMESTAMP}`;
  const commit = execFileSync("git", ["--no-replace-objects", "commit-tree", tree, "-F", "-"], {
    cwd: options.output,
    encoding: "utf8",
    env: identityEnv,
    input: canonicalPublicProjectionCommitMessage(stageAReceiptSha256),
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const branch = canonicalPublicProjectionCandidateBranch(commit);
  git(options.output, ["update-ref", `refs/heads/${branch}`, commit, ""]);
  git(options.output, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  verifyCanonicalPublicProjectionCommit({
    stageAReceiptBytes: options.stageAReceiptBytes,
    publicRepository: options.output,
    exactPublicCommit: commit,
  });
  return { commit, branch };
}

export function preparePublicPromotion(args: PreparePublicPromotionArgs): {
  version: "public-promotion-preparation/v1";
  source_commit: string;
  stage_a_receipt_sha256: string;
  public_commit_sha: string;
  candidate_branch: string;
  push_performed: false;
  stage_b_status: "blocked-pending-external-trust-and-evidence";
  main_update_status: "not-attempted";
} {
  const source = fs.realpathSync(args.source);
  assertSeparatedRoots(args, source);
  const actualSourceCommit = git(source, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (actualSourceCommit !== args.sourceCommit) {
    throw new Error(
      `Exact source commit mismatch: expected ${args.sourceCommit}, got ${actualSourceCommit}`,
    );
  }
  const policyPath = path.join(source, "runtime", "release", "public-projection-policy.yaml");
  const snapshot = generatePublicProjection({
    sourceRoot: source,
    outputRoot: args.staging,
    policyPath,
  });
  if (snapshot.source.commit_sha !== args.sourceCommit) throw new Error("Source commit changed during projection");
  fs.mkdirSync(args.evidenceDirectory, { recursive: false, mode: 0o700 });
  const generationPath = path.join(args.evidenceDirectory, "generation.json");
  const attestationPath = path.join(args.evidenceDirectory, "scan-attestation.json");
  const executionReceiptPath = path.join(args.evidenceDirectory, "scan-execution-receipt.json");
  const stageAPath = path.join(args.evidenceDirectory, "stage-a-receipt.json");
  writeExclusiveOutputFile({
    outputPath: generationPath,
    protectedRoot: args.staging,
    label: "Projection generation snapshot output",
    bytes: canonicalJsonBytes(snapshot),
    mode: 0o400,
  });
  const scan = createRepositorySecretScanArtifacts({
    stagingRoot: args.staging,
    generationSnapshot: snapshot,
  });
  if (scan.attestation.result.status !== "clean") {
    throw new Error(`Secret scan blocked publication with ${scan.attestation.result.finding_count} finding(s)`);
  }
  writeExclusiveOutputFile({
    outputPath: attestationPath,
    protectedRoot: args.staging,
    label: "Secret scan attestation output",
    bytes: scan.attestationBytes,
    mode: 0o400,
  });
  writeExclusiveOutputFile({
    outputPath: executionReceiptPath,
    protectedRoot: args.staging,
    label: "Secret scan execution receipt output",
    bytes: scan.executionReceiptBytes,
    mode: 0o400,
  });
  const stageA = buildPublicProjectionReceipt({
    sourceRoot: source,
    stagingRoot: args.staging,
    policyPath,
    generationSnapshot: snapshot,
    attestationBytes: scan.attestationBytes,
    verificationEvidence: {
      mechanism: "approved-wrapper-execution-receipt",
      bytes: scan.executionReceiptBytes,
    },
    attestationVerifier: createBoundRepositorySecretScanVerifier({ stagingRoot: args.staging }),
  });
  const stageABytes = canonicalJsonBytes(stageA);
  writeExclusiveOutputFile({
    outputPath: stageAPath,
    protectedRoot: args.staging,
    label: "Stage A receipt output",
    bytes: stageABytes,
    mode: 0o400,
  });
  const publicRepository = createCanonicalPublicRepository({
    staging: args.staging,
    output: args.publicRepository,
    stageAReceipt: stageA,
    stageAReceiptBytes: stageABytes,
  });
  return {
    version: "public-promotion-preparation/v1",
    source_commit: snapshot.source.commit_sha,
    stage_a_receipt_sha256: sha256Hex(stageABytes),
    public_commit_sha: publicRepository.commit,
    candidate_branch: publicRepository.branch,
    push_performed: false,
    stage_b_status: "blocked-pending-external-trust-and-evidence",
    main_update_status: "not-attempted",
  };
}

function main(): void {
  try {
    const result = preparePublicPromotion(parsePublicPromotionArgs(process.argv.slice(2)));
    process.stdout.write(canonicalJsonBytes(result));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) main();
