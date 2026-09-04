#!/usr/bin/env npx tsx
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_MAX_INLINE_VIDEO_BYTES,
  GEMINI_AGENTIC_VIDEO_MODELS,
  createGeminiAgenticVideoConnector,
} from "../runtime/connectors/gemini-agentic-video.js";
import type {
  VideoReasoningPrivacy,
  VideoReasoningRequest,
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
const PRIVACY = new Set<VideoReasoningPrivacy>([
  "local_only",
  "bounded_derivative",
  "source_allowed",
]);
const MODELS = new Set<string>(GEMINI_AGENTIC_VIDEO_MODELS);
const SHA256 = /^[0-9a-f]{64}$/i;

const USAGE = `Usage:
  npm run agentic-video:probe -- \\
    --video /absolute/path/to/proxy.mp4 \\
    --asset-id AST_001 --duration-us 120000000 \\
    --source-sha256 <original-source-sha256> \\
    --prompt "Find the strongest reveal." \\
    --privacy bounded_derivative --consent-cloud-upload

Or pass an existing Gemini Files API / registered gs:// URI with --uri and
--source-sha256. This command never uploads through the Files API and never
writes canonical project artifacts.

Models: ${GEMINI_AGENTIC_VIDEO_MODELS.join(" | ")}
Tasks: ${[...TASKS].join(" | ")}`;

export interface AgenticVideoProbeCliArgs {
  videoPath: string | null;
  providerUri: string | null;
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
  consentCloudUpload: boolean;
  timeoutMs: number | null;
  maxInputBytes: number | null;
}

function integer(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} exceeds the safe integer range`);
  return value;
}

export function parseArgs(argv: string[] = process.argv): AgenticVideoProbeCliArgs {
  const values = argv.slice(2);
  const parsed: AgenticVideoProbeCliArgs = {
    videoPath: null,
    providerUri: null,
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
    consentCloudUpload: false,
    timeoutMs: null,
    maxInputBytes: null,
  };

  for (let i = 0; i < values.length; i += 1) {
    const flag = values[i];
    if (flag === "--help" || flag === "-h") throw new Error(USAGE);
    if (flag === "--consent-cloud-upload") {
      parsed.consentCloudUpload = true;
      continue;
    }
    const value = values[++i];
    switch (flag) {
      case "--video": parsed.videoPath = value ?? ""; break;
      case "--uri": parsed.providerUri = value ?? ""; break;
      case "--asset-id": parsed.assetId = value ?? ""; break;
      case "--duration-us": parsed.sourceDurationUs = integer(flag, value); break;
      case "--source-sha256": parsed.sourceSha256 = value ?? ""; break;
      case "--submitted-sha256": parsed.submittedSha256 = value ?? ""; break;
      case "--range-start-us": parsed.rangeStartUs = integer(flag, value); break;
      case "--range-end-us": parsed.rangeEndUs = integer(flag, value); break;
      case "--prompt": parsed.prompt = value ?? ""; break;
      case "--mime-type": parsed.mimeType = value ?? ""; break;
      case "--timeout-ms": parsed.timeoutMs = integer(flag, value); break;
      case "--max-input-bytes": parsed.maxInputBytes = integer(flag, value); break;
      case "--model":
        if (!MODELS.has(value ?? "")) throw new Error(`Unsupported --model: ${value ?? ""}`);
        parsed.model = value ?? "";
        break;
      case "--task":
        if (!TASKS.has(value as VideoReasoningTask)) throw new Error(`Unsupported --task: ${value ?? ""}`);
        parsed.task = value as VideoReasoningTask;
        break;
      case "--privacy":
        if (!PRIVACY.has(value as VideoReasoningPrivacy)) throw new Error(`Unsupported --privacy: ${value ?? ""}`);
        parsed.privacy = value as VideoReasoningPrivacy;
        break;
      default: throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
    }
  }

  if ((parsed.videoPath === null) === (parsed.providerUri === null)) {
    throw new Error(`Pass exactly one of --video or --uri.\n${USAGE}`);
  }
  if (!parsed.assetId.trim() || !parsed.prompt.trim() || parsed.sourceDurationUs <= 0) {
    throw new Error(USAGE);
  }
  if ((parsed.rangeStartUs === null) !== (parsed.rangeEndUs === null)) {
    throw new Error("--range-start-us and --range-end-us must be supplied together");
  }
  if (parsed.sourceSha256 !== null && !SHA256.test(parsed.sourceSha256)) {
    throw new Error("--source-sha256 must be 64 hexadecimal characters");
  }
  if (parsed.submittedSha256 !== null && !SHA256.test(parsed.submittedSha256)) {
    throw new Error("--submitted-sha256 must be 64 hexadecimal characters");
  }
  if (parsed.providerUri !== null && parsed.sourceSha256 === null) {
    throw new Error("--source-sha256 is required with --uri");
  }
  if (parsed.rangeStartUs !== null && parsed.sourceSha256 === null) {
    throw new Error("A non-full submitted range requires the original --source-sha256");
  }
  if (parsed.privacy === "local_only" || !parsed.consentCloudUpload) {
    throw new Error(
      "Live probe refused: choose --privacy bounded_derivative|source_allowed and pass --consent-cloud-upload explicitly.",
    );
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

export function buildProbeRequest(args: AgenticVideoProbeCliArgs): VideoReasoningRequest {
  if (args.privacy === "local_only") throw new Error("Cloud probe cannot use local_only privacy");
  const maxInputBytes = args.maxInputBytes ?? DEFAULT_MAX_INLINE_VIDEO_BYTES;
  const inline = args.videoPath === null ? null : inlineIdentity(args.videoPath, maxInputBytes);
  const sourceHash = (args.sourceSha256 ?? inline?.sha256 ?? "").toLowerCase();
  const submittedHash = (args.submittedSha256 ?? inline?.sha256 ?? sourceHash).toLowerCase();
  const rangeUs = args.rangeStartUs === null || args.rangeEndUs === null
    ? undefined
    : [args.rangeStartUs, args.rangeEndUs] as const;

  return {
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
    input: inline === null
      ? { kind: "provider_uri", uri: args.providerUri ?? "", mimeType: args.mimeType }
      : { kind: "inline", path: inline.path, mimeType: args.mimeType },
    privacy: args.privacy,
    consent: { approved: true, scope: args.privacy },
    budget: {
      maxRequests: 1,
      maxInputBytes,
      ...(args.timeoutMs === null ? {} : { timeoutMs: args.timeoutMs }),
    },
  };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: AgenticVideoProbeCliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(message === USAGE ? USAGE : "[agentic-video:probe] invalid arguments; use --help for usage");
    return 1;
  }

  let request: VideoReasoningRequest;
  try {
    request = buildProbeRequest(args);
  } catch {
    // Do not disclose filesystem paths or low-level stat/read errors.
    console.error("[agentic-video:probe] input validation failed");
    return 1;
  }

  if (request.privacy === "bounded_derivative" &&
      request.source.sourceContentSha256 === request.source.submittedMediaContentSha256) {
    console.error("[agentic-video:probe] bounded_derivative requires original and submitted media to have distinct SHA-256 identities");
    return 1;
  }

  const result = await createGeminiAgenticVideoConnector()(request);
  console.log(JSON.stringify(result, null, 2));
  return result.outcome === "completed" ? 0 : 2;
}

const direct = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("[agentic-video:probe] unexpected failure");
    process.exitCode = 2;
  });
}
