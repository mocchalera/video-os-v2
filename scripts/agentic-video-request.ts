#!/usr/bin/env npx tsx
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local", quiet: true });
dotenvConfig({ quiet: true });

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  coordinateVideoReasoning,
  type VideoReasoningCoordinatorRequest,
} from "../runtime/connectors/video-reasoning-coordinator.js";
import {
  DEFAULT_MAX_INLINE_VIDEO_BYTES,
  GEMINI_AGENTIC_VIDEO_MODELS,
} from "../runtime/connectors/gemini-agentic-video.js";
import type {
  VideoReasoningPrivacy,
  VideoReasoningTask,
} from "../runtime/connectors/video-reasoning-types.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";

const TASKS = new Set<VideoReasoningTask>([
  "needle_search",
  "moment_refine",
  "trim_refine",
  "continuity_check",
  "roughcut_review",
  "anomaly_inspection",
]);
const PRIVACY_MODES = new Set<VideoReasoningPrivacy>([
  "local_only",
  "bounded_derivative",
  "source_allowed",
]);
const MODELS = new Set<string>(GEMINI_AGENTIC_VIDEO_MODELS);
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

const USAGE = `Usage:
  npm run agentic-video:request -- \\
    --video /path/to/proxy.mp4 \\
    --asset-id AST_001 --duration-us 120000000 \\
    --source-sha256 <original-source-sha256> \\
    --prompt "Find the strongest reveal." \\
    --privacy bounded_derivative --project-opt-in --consent-cloud-upload

Options:
  --video <path>            Submitted media file (inline video payload)
  --local-source <path>     Original source media file (for local timestamp verification)
  --registry-key <key>      Registry key for an unexpired registered cloud file
  --registered-file         Resolve provider URI from private Gemini file registry
  --project-opt-in          Explicit project-scoped policy opt-in gate
  --consent-cloud-upload    Operator manual action consent gate
  --privacy <mode>          Privacy mode: local_only (default) | bounded_derivative | source_allowed
  --local-verify            Run M3b local timestamp verification seam
  --help, -h                Show this help message

Models: ${GEMINI_AGENTIC_VIDEO_MODELS.join(" | ")}
Tasks: ${[...TASKS].join(" | ")}`;

export interface AgenticVideoRequestCliArgs {
  videoPath: string | null;
  localSourcePath: string | null;
  registryKey: string | null;
  useRegisteredFile: boolean;
  assetId: string;
  sourceDurationUs: number;
  sourceSha256: string | null;
  submittedSha256: string | null;
  rangeStartUs: number | null;
  rangeEndUs: number | null;
  prompt: string;
  model: string;
  task: VideoReasoningTask;
  mimeType: string;
  privacy: VideoReasoningPrivacy;
  projectOptIn: boolean;
  consentCloudUpload: boolean;
  projectDir: string;
  timeoutMs: number | null;
  maxInputBytes: number | null;
  localVerify: boolean;
  temporalReasoning: boolean;
  candidateConflict: boolean;
  unresolvedUncertainty: boolean;
  editorialImpact: "low" | "medium" | "high";
  semanticReviewRequested: boolean;
}

function integer(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} exceeds the safe integer range`);
  return value;
}

export function parseArgs(argv: string[] = process.argv): AgenticVideoRequestCliArgs {
  const values = argv.slice(2);
  const parsed: AgenticVideoRequestCliArgs = {
    videoPath: null,
    localSourcePath: null,
    registryKey: null,
    useRegisteredFile: false,
    assetId: "",
    sourceDurationUs: 0,
    sourceSha256: null,
    submittedSha256: null,
    rangeStartUs: null,
    rangeEndUs: null,
    prompt: "",
    model: "gemini-3.7-flash",
    task: "needle_search",
    mimeType: "video/mp4",
    privacy: "local_only",
    projectOptIn: false,
    consentCloudUpload: false,
    projectDir: ".",
    timeoutMs: null,
    maxInputBytes: null,
    localVerify: false,
    temporalReasoning: false,
    candidateConflict: false,
    unresolvedUncertainty: false,
    editorialImpact: "low",
    semanticReviewRequested: false,
  };

  for (let i = 0; i < values.length; i += 1) {
    const flag = values[i];
    if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    if (flag === "--uri") {
      throw new Error("Raw --uri is disallowed in M4a; provider URI must be resolved from private Gemini file registry via --registry-key or --registered-file");
    }
    if (flag === "--project-opt-in") {
      parsed.projectOptIn = true;
      continue;
    }
    if (flag === "--consent-cloud-upload") {
      parsed.consentCloudUpload = true;
      continue;
    }
    if (flag === "--registered-file") {
      parsed.useRegisteredFile = true;
      continue;
    }
    if (flag === "--local-verify") {
      parsed.localVerify = true;
      continue;
    }
    if (flag === "--temporal-reasoning") {
      parsed.temporalReasoning = true;
      continue;
    }
    if (flag === "--candidate-conflict") {
      parsed.candidateConflict = true;
      continue;
    }
    if (flag === "--unresolved-uncertainty") {
      parsed.unresolvedUncertainty = true;
      continue;
    }
    if (flag === "--semantic-review-requested") {
      parsed.semanticReviewRequested = true;
      continue;
    }

    const value = values[++i];
    switch (flag) {
      case "--video": parsed.videoPath = value ?? ""; break;
      case "--local-source": parsed.localSourcePath = value ?? ""; break;
      case "--registry-key": parsed.registryKey = value ?? ""; break;
      case "--asset-id": parsed.assetId = value ?? ""; break;
      case "--duration-us": parsed.sourceDurationUs = integer(flag, value); break;
      case "--source-sha256": parsed.sourceSha256 = value ?? ""; break;
      case "--submitted-sha256": parsed.submittedSha256 = value ?? ""; break;
      case "--range-start-us": parsed.rangeStartUs = integer(flag, value); break;
      case "--range-end-us": parsed.rangeEndUs = integer(flag, value); break;
      case "--prompt": parsed.prompt = value ?? ""; break;
      case "--mime-type": parsed.mimeType = value ?? ""; break;
      case "--project": parsed.projectDir = value ?? "."; break;
      case "--timeout-ms": parsed.timeoutMs = integer(flag, value); break;
      case "--max-input-bytes": parsed.maxInputBytes = integer(flag, value); break;
      case "--editorial-impact":
        if (value !== "low" && value !== "medium" && value !== "high") {
          throw new Error(`Unsupported --editorial-impact: ${value ?? ""}`);
        }
        parsed.editorialImpact = value;
        break;
      case "--model":
        if (!MODELS.has(value ?? "")) throw new Error(`Unsupported --model: ${value ?? ""}`);
        parsed.model = value ?? "";
        break;
      case "--task":
        if (!TASKS.has(value as VideoReasoningTask)) throw new Error(`Unsupported --task: ${value ?? ""}`);
        parsed.task = value as VideoReasoningTask;
        break;
      case "--privacy":
        if (!PRIVACY_MODES.has(value as VideoReasoningPrivacy)) throw new Error(`Unsupported --privacy: ${value ?? ""}`);
        parsed.privacy = value as VideoReasoningPrivacy;
        break;
      default: throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
    }
  }

  if (parsed.videoPath === null && parsed.registryKey === null && !parsed.useRegisteredFile) {
    throw new Error(`Pass either --video or a registry reference (--registry-key / --registered-file).\n${USAGE}`);
  }
  if (!parsed.assetId.trim() || !parsed.prompt.trim() || parsed.sourceDurationUs <= 0) {
    throw new Error(USAGE);
  }
  if ((parsed.rangeStartUs === null) !== (parsed.rangeEndUs === null)) {
    throw new Error("--range-start-us and --range-end-us must be supplied together");
  }
  if (parsed.sourceSha256 !== null && !SHA256_PATTERN.test(parsed.sourceSha256)) {
    throw new Error("--source-sha256 must be 64 hexadecimal characters");
  }
  if (parsed.submittedSha256 !== null && !SHA256_PATTERN.test(parsed.submittedSha256)) {
    throw new Error("--submitted-sha256 must be 64 hexadecimal characters");
  }

  return parsed;
}

function inlineIdentity(filePath: string, maxBytes: number): { path: string; sha256: string } {
  const absolutePath = path.resolve(filePath);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error("Inline input must be a non-empty regular file, not a symlink");
  }
  if (stat.size > maxBytes) throw new Error("Inline input exceeds the configured raw-byte limit");
  return { path: absolutePath, sha256: sha256FileHex(absolutePath) };
}

export function buildCoordinatorRequest(args: AgenticVideoRequestCliArgs): VideoReasoningCoordinatorRequest {
  const maxInputBytes = args.maxInputBytes ?? DEFAULT_MAX_INLINE_VIDEO_BYTES;
  const inline = args.videoPath === null ? null : inlineIdentity(args.videoPath, maxInputBytes);
  const sourceHash = (args.sourceSha256 ?? inline?.sha256 ?? "").toLowerCase();
  const submittedHash = (args.submittedSha256 ?? inline?.sha256 ?? sourceHash).toLowerCase();
  const rangeUs = args.rangeStartUs === null || args.rangeEndUs === null
    ? undefined
    : [args.rangeStartUs, args.rangeEndUs] as const;

  // Determine local source path: explicitly passed, or fallback to --video if identical to source SHA-256
  let resolvedLocalSourcePath: string | undefined;
  if (args.localSourcePath) {
    resolvedLocalSourcePath = path.resolve(args.localSourcePath);
  } else if (inline !== null && sourceHash === submittedHash) {
    resolvedLocalSourcePath = inline.path;
  }

  return {
    projectDir: args.projectDir,
    projectOptIn: args.projectOptIn,
    task: args.task,
    model: args.model,
    prompt: args.prompt,
    source: {
      assetId: args.assetId,
      sourceContentSha256: sourceHash,
      submittedMediaContentSha256: submittedHash,
      sourceDurationUs: args.sourceDurationUs,
      ...(rangeUs === undefined ? {} : { rangeUs }),
    },
    input: inline !== null
      ? { kind: "inline", path: inline.path, mimeType: args.mimeType }
      : { kind: "provider_uri", uri: "", mimeType: args.mimeType },
    ...(args.registryKey || args.useRegisteredFile ? {
      registryLookup: {
        ...(args.registryKey ? { registryKey: args.registryKey } : {}),
      },
    } : {}),
    privacy: args.privacy,
    consentCloudUpload: args.consentCloudUpload,
    budget: {
      maxRequests: 1,
      maxInputBytes,
      ...(args.timeoutMs === null ? {} : { timeoutMs: args.timeoutMs }),
    },
    temporalReasoningRequired: args.temporalReasoning,
    candidateConflict: args.candidateConflict,
    unresolvedUncertainty: args.unresolvedUncertainty,
    editorialImpact: args.editorialImpact,
    semanticReviewRequested: args.semanticReviewRequested,
    localVerification: args.localVerify ? {
      enabled: true,
      ...(resolvedLocalSourcePath ? { sourcePath: resolvedLocalSourcePath } : {}),
    } : undefined,
  };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: AgenticVideoRequestCliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === USAGE) {
      console.log(USAGE);
      return 0;
    }
    console.error("[agentic-video:request] invalid arguments; use --help for usage");
    return 1;
  }

  let request: VideoReasoningCoordinatorRequest;
  try {
    request = buildCoordinatorRequest(args);
  } catch {
    console.error("[agentic-video:request] input validation failed");
    return 1;
  }

  if (request.privacy === "bounded_derivative" &&
      request.source.sourceContentSha256 === request.source.submittedMediaContentSha256) {
    console.error("[agentic-video:request] bounded_derivative requires original and submitted media to have distinct SHA-256 identities");
    return 1;
  }

  const result = await coordinateVideoReasoning(request);
  console.log(JSON.stringify(result.summary, null, 2));

  if (result.outcome === "completed" || result.outcome === "routed_local" || result.outcome === "routed_static_vlm") {
    return 0;
  }
  return 2;
}

const direct = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("[agentic-video:request] unexpected failure");
    process.exitCode = 2;
  });
}
