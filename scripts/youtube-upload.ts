import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runPublicationPreflight } from "../runtime/packaging/publication-preflight.js";
import {
  uploadYoutubeVideo,
  youtubeUploadMetadataSha256,
  type YoutubePublicationApproval,
  type YoutubePrivacyStatus,
  type YoutubeUploadMetadata,
} from "../runtime/packaging/youtube-resumable-upload.js";

interface YoutubeUploadCliArgs {
  projectDir: string;
  metadataPath: string;
  privacyStatus: YoutubePrivacyStatus;
  accessTokenEnv: string;
  expectedChannelId?: string;
  receiptDir?: string;
  sessionDir?: string;
  chunkSizeBytes?: number;
  processingTimeoutMs?: number;
}

export interface ResolveYoutubePublicationRequestInput {
  projectDir: string;
  metadataPath: string;
  privacyStatus: YoutubePrivacyStatus;
  expectedChannelId?: string;
}

export interface ResolvedYoutubePublicationRequest {
  videoPath: string;
  videoSha256: string;
  metadata: YoutubeUploadMetadata;
  metadataSha256: string;
  expectedChannelId: string;
  destinationAccount?: string;
  publicationApproval: YoutubePublicationApproval;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "Usage: npm run youtube-upload -- <project-dir> --metadata <metadata.json> " +
    "[--privacy private|unlisted|public] [--expected-channel <channel-id>] " +
    "[--access-token-env YOUTUBE_ACCESS_TOKEN] [--chunk-size-mib 8] " +
    "[--processing-timeout-ms 1800000] [--receipt-dir <dir>] [--session-dir <dir>]",
  );
  process.exit(2);
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) usage(`Missing value for ${flag}`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) usage(`${flag} must be a positive integer`);
  return parsed;
}

export function parseYoutubeUploadArgs(argv: string[]): YoutubeUploadCliArgs {
  const projectDir = argv[0];
  if (!projectDir || projectDir.startsWith("--")) usage();
  let metadataPath: string | undefined;
  let privacyStatus: YoutubePrivacyStatus = "unlisted";
  let accessTokenEnv = "YOUTUBE_ACCESS_TOKEN";
  let expectedChannelId: string | undefined;
  let receiptDir: string | undefined;
  let sessionDir: string | undefined;
  let chunkSizeBytes: number | undefined;
  let processingTimeoutMs: number | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = requiredValue(argv, index, flag);
    if (flag === "--metadata") metadataPath = value;
    else if (flag === "--privacy") {
      if (value !== "private" && value !== "unlisted" && value !== "public") usage("Invalid --privacy value");
      privacyStatus = value;
    } else if (flag === "--access-token-env") accessTokenEnv = value;
    else if (flag === "--expected-channel") expectedChannelId = value;
    else if (flag === "--receipt-dir") receiptDir = value;
    else if (flag === "--session-dir") sessionDir = value;
    else if (flag === "--chunk-size-mib") chunkSizeBytes = parsePositiveInteger(value, flag) * 1024 * 1024;
    else if (flag === "--processing-timeout-ms") processingTimeoutMs = parsePositiveInteger(value, flag);
    else usage(`Unknown option: ${flag}`);
    index += 1;
  }
  if (!metadataPath) usage("--metadata is required");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(accessTokenEnv)) usage("--access-token-env must be an environment variable name");
  return {
    projectDir,
    metadataPath,
    privacyStatus,
    accessTokenEnv,
    ...(expectedChannelId ? { expectedChannelId } : {}),
    ...(receiptDir ? { receiptDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(chunkSizeBytes ? { chunkSizeBytes } : {}),
    ...(processingTimeoutMs ? { processingTimeoutMs } : {}),
  };
}

function readMetadata(metadataPath: string): YoutubeUploadMetadata {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error("youtube_metadata_json_invalid");
  }
  return value as YoutubeUploadMetadata;
}

export function resolveYoutubePublicationRequest(
  input: ResolveYoutubePublicationRequestInput,
): ResolvedYoutubePublicationRequest {
  const projectDir = path.resolve(input.projectDir);
  const metadata = readMetadata(path.resolve(input.metadataPath));
  const metadataSha256 = youtubeUploadMetadataSha256(metadata);
  const preflight = runPublicationPreflight(projectDir, {
    platform: "youtube",
    visibility: input.privacyStatus,
  });
  if (
    !preflight.ready ||
    !preflight.canonical_video ||
    !preflight.approval
  ) {
    const failedChecks = preflight.checks
      .filter((check) => !check.passed)
      .map((check) => check.name);
    throw new Error(
      `youtube_publication_preflight_failed:${failedChecks.join(",")}`,
    );
  }
  if (preflight.approval.version !== "publication-approval/v2") {
    throw new Error("youtube_publication_approval_v2_required");
  }
  const destination = preflight.destinations?.find((candidate) =>
    candidate.platform === "youtube" &&
    candidate.visibility === input.privacyStatus
  );
  if (!destination) throw new Error("youtube_approved_destination_missing");
  if (!destination.channel_id) {
    throw new Error("youtube_approved_channel_id_missing");
  }
  if (destination.metadata_sha256 !== metadataSha256) {
    throw new Error("youtube_approved_metadata_hash_mismatch");
  }
  if (
    input.expectedChannelId &&
    input.expectedChannelId !== destination.channel_id
  ) {
    throw new Error("youtube_expected_channel_conflicts_with_approval");
  }

  return {
    videoPath: preflight.canonical_video.path,
    videoSha256: preflight.canonical_video.sha256,
    metadata,
    metadataSha256,
    expectedChannelId: destination.channel_id,
    ...(destination.account
      ? { destinationAccount: destination.account }
      : {}),
    publicationApproval: {
      version: "publication-approval/v2",
      approvalSha256: preflight.approval.sha256,
      artifactSha256: preflight.canonical_video.sha256,
      privacyStatus: input.privacyStatus,
      channelId: destination.channel_id,
      metadataSha256,
    },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseYoutubeUploadArgs(argv);
  const projectDir = path.resolve(args.projectDir);
  const request = resolveYoutubePublicationRequest({
    projectDir,
    metadataPath: args.metadataPath,
    privacyStatus: args.privacyStatus,
    ...(args.expectedChannelId
      ? { expectedChannelId: args.expectedChannelId }
      : {}),
  });
  const accessToken = process.env[args.accessTokenEnv];
  if (!accessToken) throw new Error(`youtube_access_token_env_missing:${args.accessTokenEnv}`);
  const packageDir = path.join(projectDir, "07_package");
  const receipt = await uploadYoutubeVideo({
    videoPath: request.videoPath,
    metadata: request.metadata,
    accessToken,
    privacyStatus: args.privacyStatus,
    expectedArtifactSha256: request.videoSha256,
    expectedChannelId: request.expectedChannelId,
    ...(request.destinationAccount
      ? { destinationAccount: request.destinationAccount }
      : {}),
    publicationApproval: request.publicationApproval,
    receiptDir: path.resolve(args.receiptDir ?? path.join(packageDir, "publication-receipts")),
    sessionDir: path.resolve(args.sessionDir ?? path.join(packageDir, ".youtube-upload-sessions")),
    ...(args.chunkSizeBytes ? { chunkSizeBytes: args.chunkSizeBytes } : {}),
    ...(args.processingTimeoutMs ? { processingTimeoutMs: args.processingTimeoutMs } : {}),
    logger: (event) => console.error(`[youtube-upload] ${JSON.stringify(event)}`),
  });
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.outcome !== "succeeded") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "youtube_upload_failed");
    process.exitCode = 1;
  });
}
