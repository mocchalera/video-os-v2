import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import type { Readable } from "node:stream";

export type YoutubePrivacyStatus = "private" | "unlisted" | "public";
export type YoutubeProcessingStatus = "processing" | "succeeded" | "failed" | "terminated" | "unknown";

export interface YoutubeUploadMetadata {
  snippet: {
    title: string;
    description?: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  recordingDetails?: Record<string, unknown>;
}

export interface YoutubePublicationApproval {
  version: "publication-approval/v2";
  approvalSha256: string;
  artifactSha256: string;
  privacyStatus: YoutubePrivacyStatus;
  channelId: string;
  metadataSha256: string;
}

export interface YoutubeUploadReceipt {
  version: "youtube-upload-receipt/v1";
  idempotency_key: string;
  outcome: "processing" | "succeeded" | "failed" | "terminated" | "timeout" | "privacy_mismatch" | "artifact_changed";
  local: {
    path: string;
    sha256: string;
    size_bytes: number;
  };
  request: {
    metadata_sha256: string;
    privacyStatus: YoutubePrivacyStatus;
    publication_approval_sha256?: string;
  };
  remote: {
    video_id: string;
    privacyStatus: YoutubePrivacyStatus;
    processingStatus: YoutubeProcessingStatus;
    channel: { id: string; title?: string };
    destination: {
      platform: "youtube";
      approval_account?: string;
      approval_channel_id?: string;
    };
  };
  timestamps: {
    upload_started_at: string;
    remote_created_at: string;
    processing_checked_at: string;
    completed_at?: string;
    updated_at: string;
  };
}

export interface YoutubeUploadLogEvent {
  event:
    | "duplicate_prevented"
    | "session_started"
    | "session_resumed"
    | "session_reinitialized"
    | "chunk_accepted"
    | "retry_scheduled"
    | "remote_created"
    | "processing_polled";
  attempt?: number;
  next_offset?: number;
  processing_status?: YoutubeProcessingStatus;
}

export interface YoutubeUploadOptions {
  videoPath: string;
  metadata: YoutubeUploadMetadata;
  accessToken: string;
  privacyStatus?: YoutubePrivacyStatus;
  mimeType?: string;
  expectedArtifactSha256?: string;
  expectedChannelId?: string;
  destinationAccount?: string;
  publicationApproval?: YoutubePublicationApproval;
  receiptDir: string;
  sessionDir: string;
  chunkSizeBytes?: number;
  maxRetries?: number;
  maxSessionRestarts?: number;
  baseBackoffMs?: number;
  processingPollIntervalMs?: number;
  processingTimeoutMs?: number;
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  logger?: (event: YoutubeUploadLogEvent) => void;
  dependencies?: Partial<YoutubeUploadDependencies>;
}

export interface YoutubeUploadDependencies {
  now: () => Date;
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
  hashOpenFile: (handle: FileHandle) => Promise<string>;
}

interface UploadSessionState {
  version: "youtube-upload-session/v1";
  idempotency_key: string;
  session_url: string;
  next_offset: number;
  artifact_sha256: string;
  size_bytes: number;
  metadata_sha256: string;
  privacyStatus: YoutubePrivacyStatus;
  mime_type: string;
  channel_id: string;
  destination_account?: string;
  publication_approval_sha256?: string;
  upload_started_at: string;
  final_attempt_pending?: boolean;
  created_at: string;
  updated_at: string;
}

interface ResolvedChannel {
  id: string;
  title?: string;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface RemoteVideo {
  id: string;
}

type SessionResult =
  | { kind: "progress"; nextOffset: number }
  | { kind: "complete"; video: RemoteVideo }
  | { kind: "expired" };

class HttpTransportError extends Error {
  constructor() {
    super("youtube_http_transport_failed");
  }
}

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_API_BASE = "https://www.googleapis.com/youtube/v3/";
const DEFAULT_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3/";
const RECEIPT_SUFFIX = ".youtube-upload-receipt.json";
const SESSION_SUFFIX = ".youtube-upload-session.json";
const LOCK_SUFFIX = ".youtube-upload.lock";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HTTP_REQUEST_TIMEOUT_MS = 120_000;

const defaultDependencies: YoutubeUploadDependencies = {
  now: () => new Date(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: Math.random,
  hashOpenFile: hashOpenFileSha256,
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function youtubeUploadIdempotencyKey(input: {
  artifactSha256: string;
  metadataSha256: string;
  privacyStatus: YoutubePrivacyStatus;
  channelId: string;
  destinationAccount?: string;
  publicationApprovalSha256?: string;
}): string {
  return crypto.createHash("sha256").update(stableJson(input)).digest("hex");
}

export function youtubeUploadMetadataSha256(
  metadata: YoutubeUploadMetadata,
): string {
  assertMetadata(metadata);
  return sha256Text(stableJson(metadata));
}

export async function hashOpenFileSha256(handle: FileHandle): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

function assertMetadata(metadata: YoutubeUploadMetadata): void {
  if (!metadata || typeof metadata !== "object" || !metadata.snippet || typeof metadata.snippet.title !== "string") {
    throw new Error("youtube_metadata_requires_snippet_title");
  }
  if (metadata.snippet.title.trim().length === 0) throw new Error("youtube_metadata_title_empty");
}

function assertChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("youtube_chunk_size_invalid");
  if (chunkSize % (256 * 1024) !== 0) throw new Error("youtube_chunk_size_must_be_256k_multiple");
}

function inferMimeType(videoPath: string): string {
  switch (path.extname(videoPath).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mpeg":
    case ".mpg":
      return "video/mpeg";
    default:
      return "application/octet-stream";
  }
}

function ensureDirectory(directory: string, mode: number): void {
  fs.mkdirSync(directory, { recursive: true, mode });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("youtube_state_directory_unsafe");
  fs.chmodSync(directory, mode);
}

function atomicWriteJson(filePath: string, value: unknown, mode: number): void {
  ensureDirectory(path.dirname(filePath), 0o700);
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error("youtube_state_file_unsafe");
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "wx", mode);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, mode);
}

function readJson(filePath: string): unknown {
  if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error("youtube_state_file_unsafe");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function joinApiUrl(baseUrl: string, resource: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(resource, normalized);
}

function assertSecureEndpoint(baseUrl: string): void {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("youtube_http_endpoint_insecure");
  }
}

function authorizationHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

async function requestHttp(input: {
  url: URL;
  method: string;
  headers?: Record<string, string>;
  body?: Buffer | Readable;
}): Promise<HttpResponse> {
  const transport = input.url.protocol === "https:" ? https : input.url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("youtube_http_protocol_invalid");

  return new Promise((resolve, reject) => {
    const request = transport.request(input.url, {
      method: input.method,
      headers: input.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error("youtube_http_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", () => reject(new HttpTransportError()));
    });
    request.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => request.destroy(new HttpTransportError()));
    request.on("error", () => reject(new HttpTransportError()));
    if (Buffer.isBuffer(input.body)) request.end(input.body);
    else if (input.body) {
      input.body.on("error", () => request.destroy(new HttpTransportError()));
      input.body.pipe(request);
    } else request.end();
  });
}

function parseJsonBody<T>(response: HttpResponse): T {
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw new Error("youtube_http_response_json_invalid");
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

async function backoff(
  attempt: number,
  baseMs: number,
  deps: YoutubeUploadDependencies,
  logger?: YoutubeUploadOptions["logger"],
): Promise<void> {
  const exponential = baseMs * (2 ** attempt);
  const delay = Math.round(exponential * (0.75 + deps.random() * 0.5));
  logger?.({ event: "retry_scheduled", attempt: attempt + 1 });
  await deps.sleep(delay);
}

async function requestRetrying5xx(
  makeRequest: () => Promise<HttpResponse>,
  maxRetries: number,
  baseBackoffMs: number,
  deps: YoutubeUploadDependencies,
  logger?: YoutubeUploadOptions["logger"],
): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await makeRequest();
    if (!isRetryableStatus(response.status) || attempt >= maxRetries) return response;
    await backoff(attempt, baseBackoffMs, deps, logger);
  }
}

async function resolveChannel(input: {
  apiBaseUrl: string;
  accessToken: string;
  maxRetries: number;
  baseBackoffMs: number;
  deps: YoutubeUploadDependencies;
  logger?: YoutubeUploadOptions["logger"];
}): Promise<ResolvedChannel> {
  const url = joinApiUrl(input.apiBaseUrl, "channels");
  url.searchParams.set("part", "id,snippet");
  url.searchParams.set("mine", "true");
  const response = await requestRetrying5xx(
    () => requestHttp({ url, method: "GET", headers: authorizationHeaders(input.accessToken) }),
    input.maxRetries,
    input.baseBackoffMs,
    input.deps,
    input.logger,
  );
  if (response.status !== 200) throw new Error(`youtube_channel_lookup_http_${response.status}`);
  const body = parseJsonBody<{ items?: Array<{ id?: string; snippet?: { title?: string } }> }>(response);
  const channel = body.items?.[0];
  if (!channel?.id) throw new Error("youtube_authenticated_channel_missing");
  return { id: channel.id, ...(channel.snippet?.title ? { title: channel.snippet.title } : {}) };
}

function validateSessionUrl(sessionUrl: string, allowedOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(sessionUrl);
  } catch {
    throw new Error("youtube_session_url_invalid");
  }
  if (url.origin !== allowedOrigin || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("youtube_session_origin_invalid");
  }
  return url;
}

function parseSessionResponse(response: HttpResponse, sizeBytes: number, maxAcknowledgedOffset?: number): SessionResult {
  if (response.status === 404 || response.status === 410) return { kind: "expired" };
  if (response.status === 200 || response.status === 201) {
    const body = parseJsonBody<{ id?: string }>(response);
    if (!body.id) throw new Error("youtube_upload_response_video_id_missing");
    return { kind: "complete", video: { id: body.id } };
  }
  if (response.status === 308) {
    const range = response.headers.range;
    let nextOffset = 0;
    if (typeof range === "string") {
      const match = /^bytes=0-(\d+)$/.exec(range);
      if (!match) throw new Error("youtube_upload_range_invalid");
      nextOffset = Number(match[1]) + 1;
    }
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > sizeBytes) {
      throw new Error("youtube_upload_offset_invalid");
    }
    if (maxAcknowledgedOffset !== undefined && nextOffset > maxAcknowledgedOffset) {
      throw new Error("youtube_upload_offset_exceeds_chunk");
    }
    if (nextOffset === sizeBytes) throw new Error("youtube_upload_completion_ambiguous");
    return { kind: "progress", nextOffset };
  }
  throw new Error(`youtube_upload_http_${response.status}`);
}

async function startSession(input: {
  uploadBaseUrl: string;
  accessToken: string;
  metadata: YoutubeUploadMetadata;
  privacyStatus: YoutubePrivacyStatus;
  sizeBytes: number;
  mimeType: string;
  maxRetries: number;
  baseBackoffMs: number;
  deps: YoutubeUploadDependencies;
  logger?: YoutubeUploadOptions["logger"];
}): Promise<string> {
  const url = joinApiUrl(input.uploadBaseUrl, "videos");
  url.searchParams.set("uploadType", "resumable");
  url.searchParams.set("part", "snippet,status,recordingDetails");
  url.searchParams.set("notifySubscribers", "false");
  const requestBody = Buffer.from(JSON.stringify({
    ...input.metadata,
    status: { privacyStatus: input.privacyStatus },
  }));
  const response = await requestRetrying5xx(
    () => requestHttp({
      url,
      method: "POST",
      headers: {
        ...authorizationHeaders(input.accessToken),
        "content-type": "application/json; charset=utf-8",
        "content-length": String(requestBody.length),
        "x-upload-content-length": String(input.sizeBytes),
        "x-upload-content-type": input.mimeType,
      },
      body: requestBody,
    }),
    input.maxRetries,
    input.baseBackoffMs,
    input.deps,
    input.logger,
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`youtube_session_init_http_${response.status}`);
  }
  const location = response.headers.location;
  if (typeof location !== "string") throw new Error("youtube_session_location_missing");
  return location;
}

async function probeSession(input: {
  sessionUrl: URL;
  accessToken: string;
  sizeBytes: number;
  maxRetries: number;
  baseBackoffMs: number;
  deps: YoutubeUploadDependencies;
  logger?: YoutubeUploadOptions["logger"];
}): Promise<SessionResult> {
  const response = await requestRetrying5xx(
    () => requestHttp({
      url: input.sessionUrl,
      method: "PUT",
      headers: {
        ...authorizationHeaders(input.accessToken),
        "content-length": "0",
        "content-range": `bytes */${input.sizeBytes}`,
      },
    }),
    input.maxRetries,
    input.baseBackoffMs,
    input.deps,
    input.logger,
  );
  return parseSessionResponse(response, input.sizeBytes);
}

async function sendChunk(input: {
  sessionUrl: URL;
  accessToken: string;
  sizeBytes: number;
  start: number;
  end: number;
  mimeType: string;
  createStream: () => Readable;
}): Promise<{ response?: SessionResult; transportFailed: boolean }> {
  try {
    const response = await requestHttp({
      url: input.sessionUrl,
      method: "PUT",
      headers: {
        ...authorizationHeaders(input.accessToken),
        "content-length": String(input.end - input.start + 1),
        "content-type": input.mimeType,
        "content-range": `bytes ${input.start}-${input.end}/${input.sizeBytes}`,
      },
      body: input.createStream(),
    });
    if (isRetryableStatus(response.status)) return { transportFailed: true };
    return {
      response: parseSessionResponse(response, input.sizeBytes, input.end + 1),
      transportFailed: false,
    };
  } catch (error) {
    if (error instanceof HttpTransportError) return { transportFailed: true };
    throw error;
  }
}

function isSessionState(value: unknown): value is UploadSessionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<UploadSessionState>;
  return state.version === "youtube-upload-session/v1" &&
    typeof state.idempotency_key === "string" &&
    typeof state.session_url === "string" &&
    Number.isSafeInteger(state.next_offset) &&
    typeof state.artifact_sha256 === "string" &&
    Number.isSafeInteger(state.size_bytes) &&
    typeof state.metadata_sha256 === "string" &&
    typeof state.mime_type === "string" &&
    typeof state.channel_id === "string" &&
    (
      state.publication_approval_sha256 === undefined ||
      /^sha256:[a-f0-9]{64}$/.test(state.publication_approval_sha256)
    ) &&
    typeof state.upload_started_at === "string" &&
    (state.final_attempt_pending === undefined || typeof state.final_attempt_pending === "boolean");
}

function isReceipt(value: unknown): value is YoutubeUploadReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<YoutubeUploadReceipt>;
  return receipt.version === "youtube-upload-receipt/v1" &&
    typeof receipt.idempotency_key === "string" &&
    typeof receipt.local?.sha256 === "string" &&
    typeof receipt.local?.size_bytes === "number" &&
    typeof receipt.request?.metadata_sha256 === "string" &&
    (
      receipt.request.publication_approval_sha256 === undefined ||
      /^sha256:[a-f0-9]{64}$/.test(
        receipt.request.publication_approval_sha256,
      )
    ) &&
    typeof receipt.remote?.video_id === "string" &&
    typeof receipt.remote?.channel?.id === "string" &&
    (
      receipt.remote.destination?.approval_channel_id === undefined ||
      typeof receipt.remote.destination.approval_channel_id === "string"
    );
}

function loadSession(sessionPath: string, expected: Omit<UploadSessionState, "version" | "session_url" | "next_offset" | "created_at" | "updated_at">): UploadSessionState | undefined {
  if (!fs.existsSync(sessionPath)) return undefined;
  if ((fs.statSync(sessionPath).mode & 0o077) !== 0) throw new Error("youtube_session_permissions_unsafe");
  const state = readJson(sessionPath);
  if (!isSessionState(state)) throw new Error("youtube_session_state_invalid");
  const matches = state.idempotency_key === expected.idempotency_key &&
    state.artifact_sha256 === expected.artifact_sha256 &&
    state.size_bytes === expected.size_bytes &&
    state.metadata_sha256 === expected.metadata_sha256 &&
    state.privacyStatus === expected.privacyStatus &&
    state.mime_type === expected.mime_type &&
    state.channel_id === expected.channel_id &&
    state.destination_account === expected.destination_account &&
    state.publication_approval_sha256 ===
      expected.publication_approval_sha256;
  if (!matches) throw new Error("youtube_session_state_identity_mismatch");
  return state;
}

function findDuplicateReceipt(input: {
  receiptDir: string;
  idempotencyKey: string;
  artifactSha256: string;
  sizeBytes: number;
  metadataSha256: string;
  privacyStatus: YoutubePrivacyStatus;
  channelId: string;
  destinationAccount?: string;
  publicationApprovalSha256?: string;
}): YoutubeUploadReceipt | undefined {
  if (!fs.existsSync(input.receiptDir)) return undefined;
  for (const entry of fs.readdirSync(input.receiptDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(RECEIPT_SUFFIX)) continue;
    const value = readJson(path.join(input.receiptDir, entry.name));
    if (!isReceipt(value)) continue;
    const sameBaseUploadIdentity = value.local.sha256 === input.artifactSha256 &&
      value.local.size_bytes === input.sizeBytes &&
      value.request.metadata_sha256 === input.metadataSha256 &&
      value.request.privacyStatus === input.privacyStatus;
    if (!sameBaseUploadIdentity) continue;
    if (
      value.request.publication_approval_sha256 !==
        input.publicationApprovalSha256
    ) {
      throw new Error("youtube_duplicate_exists_for_different_approval");
    }
    const sameDestination = value.remote.channel.id === input.channelId &&
      value.remote.destination.approval_account === input.destinationAccount &&
      value.remote.destination.approval_channel_id ===
        (input.publicationApprovalSha256 ? input.channelId : undefined);
    if (!sameDestination) throw new Error("youtube_duplicate_exists_for_different_destination");
    if (value.idempotency_key !== input.idempotencyKey) throw new Error("youtube_receipt_identity_inconsistent");
    return value;
  }
  return undefined;
}

function saveReceipt(receiptPath: string, receipt: YoutubeUploadReceipt): void {
  atomicWriteJson(receiptPath, receipt, 0o600);
}

function acquireUploadLock(lockPath: string): void {
  ensureDirectory(path.dirname(lockPath), 0o700);
  const create = (): void => {
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    create();
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  let ownerPid: number | undefined;
  try {
    const value = readJson(lockPath) as { pid?: unknown };
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) ownerPid = value.pid;
  } catch {
    throw new Error("youtube_upload_lock_invalid");
  }
  if (ownerPid !== undefined) {
    try {
      process.kill(ownerPid, 0);
      throw new Error("youtube_upload_already_in_progress");
    } catch (error) {
      if (error instanceof Error && error.message === "youtube_upload_already_in_progress") throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        throw new Error("youtube_upload_already_in_progress");
      }
    }
  }
  fs.unlinkSync(lockPath);
  try {
    create();
  } catch {
    throw new Error("youtube_upload_already_in_progress");
  }
}

function processingStatus(value: unknown): YoutubeProcessingStatus {
  return value === "processing" || value === "succeeded" || value === "failed" || value === "terminated"
    ? value
    : "unknown";
}

async function pollProcessing(input: {
  receipt: YoutubeUploadReceipt;
  receiptPath: string;
  apiBaseUrl: string;
  accessToken: string;
  expectedChannelId: string;
  expectedPrivacyStatus: YoutubePrivacyStatus;
  maxRetries: number;
  baseBackoffMs: number;
  intervalMs: number;
  timeoutMs: number;
  deps: YoutubeUploadDependencies;
  logger?: YoutubeUploadOptions["logger"];
}): Promise<YoutubeUploadReceipt> {
  const startedAt = input.deps.now().getTime();
  const maxPolls = Math.max(1, Math.ceil(input.timeoutMs / Math.max(1, input.intervalMs)) + 1);
  let receipt = input.receipt;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const url = joinApiUrl(input.apiBaseUrl, "videos");
    url.searchParams.set("part", "processingDetails,status,snippet");
    url.searchParams.set("id", receipt.remote.video_id);
    const response = await requestRetrying5xx(
      () => requestHttp({ url, method: "GET", headers: authorizationHeaders(input.accessToken) }),
      input.maxRetries,
      input.baseBackoffMs,
      input.deps,
      input.logger,
    );
    if (response.status !== 200) throw new Error(`youtube_processing_poll_http_${response.status}`);
    const body = parseJsonBody<{ items?: Array<{
      id?: string;
      processingDetails?: { processingStatus?: string };
      status?: { privacyStatus?: YoutubePrivacyStatus };
      snippet?: { channelId?: string; channelTitle?: string };
    }> }>(response);
    const remote = body.items?.find((item) => item.id === receipt.remote.video_id);
    if (!remote) throw new Error("youtube_remote_video_missing");
    const checkedAt = input.deps.now().toISOString();
    const status = processingStatus(remote.processingDetails?.processingStatus);
    const privacy = remote.status?.privacyStatus ?? receipt.remote.privacyStatus;
    const channelId = remote.snippet?.channelId ?? receipt.remote.channel.id;
    const terminal = status === "succeeded" || status === "failed" || status === "terminated";
    const privacyMismatch = privacy !== input.expectedPrivacyStatus;
    if (channelId !== input.expectedChannelId) throw new Error("youtube_remote_channel_mismatch");
    receipt = {
      ...receipt,
      outcome: privacyMismatch ? "privacy_mismatch" : terminal ? status : "processing",
      remote: {
        ...receipt.remote,
        privacyStatus: privacy,
        processingStatus: status,
        channel: {
          id: channelId,
          ...(remote.snippet?.channelTitle ? { title: remote.snippet.channelTitle } : receipt.remote.channel.title ? { title: receipt.remote.channel.title } : {}),
        },
      },
      timestamps: {
        ...receipt.timestamps,
        processing_checked_at: checkedAt,
        ...(terminal || privacyMismatch ? { completed_at: checkedAt } : {}),
        updated_at: checkedAt,
      },
    };
    saveReceipt(input.receiptPath, receipt);
    input.logger?.({ event: "processing_polled", processing_status: status });
    if (privacyMismatch || terminal) return receipt;
    if (input.deps.now().getTime() - startedAt >= input.timeoutMs || poll === maxPolls - 1) break;
    await input.deps.sleep(input.intervalMs);
  }

  const checkedAt = input.deps.now().toISOString();
  receipt = {
    ...receipt,
    outcome: "timeout",
    timestamps: { ...receipt.timestamps, processing_checked_at: checkedAt, updated_at: checkedAt },
  };
  saveReceipt(input.receiptPath, receipt);
  return receipt;
}

function sameFileStat(before: fs.Stats, current: fs.Stats): boolean {
  return before.dev === current.dev && before.ino === current.ino && before.size === current.size && before.mtimeMs === current.mtimeMs;
}

export async function uploadYoutubeVideo(options: YoutubeUploadOptions): Promise<YoutubeUploadReceipt> {
  assertMetadata(options.metadata);
  if (!options.accessToken) throw new Error("youtube_access_token_missing");
  const privacyStatus = options.privacyStatus ?? "unlisted";
  const chunkSize = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE;
  assertChunkSize(chunkSize);
  const maxRetries = options.maxRetries ?? 5;
  const maxSessionRestarts = options.maxSessionRestarts ?? 2;
  const baseBackoffMs = options.baseBackoffMs ?? 1_000;
  const pollIntervalMs = options.processingPollIntervalMs ?? 5_000;
  const pollTimeoutMs = options.processingTimeoutMs ?? 30 * 60_000;
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE;
  const uploadBaseUrl = options.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE;
  assertSecureEndpoint(apiBaseUrl);
  assertSecureEndpoint(uploadBaseUrl);
  const deps: YoutubeUploadDependencies = { ...defaultDependencies, ...options.dependencies };
  const videoPath = path.resolve(options.videoPath);
  const mimeType = options.mimeType ?? inferMimeType(videoPath);
  if (!/^(video\/[A-Za-z0-9.+-]+|application\/octet-stream)$/.test(mimeType)) {
    throw new Error("youtube_video_mime_type_invalid");
  }
  const handle = await fs.promises.open(videoPath, "r");
  let ownedLockPath: string | undefined;

  try {
    const initialStat = await handle.stat();
    if (!initialStat.isFile() || initialStat.size <= 0 || !Number.isSafeInteger(initialStat.size)) {
      throw new Error("youtube_video_file_invalid");
    }
    const artifactSha256 = await deps.hashOpenFile(handle);
    const afterHashStat = await handle.stat();
    if (!sameFileStat(initialStat, afterHashStat)) throw new Error("youtube_video_changed_while_hashing");
    if (options.expectedArtifactSha256 && artifactSha256 !== options.expectedArtifactSha256) {
      throw new Error("youtube_artifact_hash_mismatch");
    }
    const metadataSha256 = youtubeUploadMetadataSha256(options.metadata);
    const publicationApproval = options.publicationApproval;
    if (publicationApproval) {
      if (
        publicationApproval.version !== "publication-approval/v2" ||
        !/^sha256:[a-f0-9]{64}$/.test(publicationApproval.approvalSha256)
      ) {
        throw new Error("youtube_publication_approval_identity_invalid");
      }
      if (publicationApproval.artifactSha256 !== artifactSha256) {
        throw new Error("youtube_publication_approval_artifact_mismatch");
      }
      if (publicationApproval.privacyStatus !== privacyStatus) {
        throw new Error("youtube_publication_approval_privacy_mismatch");
      }
      if (publicationApproval.metadataSha256 !== metadataSha256) {
        throw new Error("youtube_publication_approval_metadata_mismatch");
      }
      if (
        options.expectedChannelId &&
        publicationApproval.channelId !== options.expectedChannelId
      ) {
        throw new Error("youtube_publication_approval_channel_mismatch");
      }
    }
    if (privacyStatus === "public") {
      if (!publicationApproval) {
        throw new Error("youtube_publication_approval_required_for_public");
      }
    }

    const channel = await resolveChannel({
      apiBaseUrl,
      accessToken: options.accessToken,
      maxRetries,
      baseBackoffMs,
      deps,
      logger: options.logger,
    });
    if (options.expectedChannelId && channel.id !== options.expectedChannelId) {
      throw new Error("youtube_authenticated_channel_mismatch");
    }
    if (
      publicationApproval &&
      channel.id !== publicationApproval.channelId
    ) {
      throw new Error("youtube_authenticated_channel_mismatch");
    }
    const idempotencyKey = youtubeUploadIdempotencyKey({
      artifactSha256,
      metadataSha256,
      privacyStatus,
      channelId: channel.id,
      ...(options.destinationAccount ? { destinationAccount: options.destinationAccount } : {}),
      ...(publicationApproval
        ? {
          publicationApprovalSha256:
            publicationApproval.approvalSha256,
        }
        : {}),
    });
    const receiptDir = path.resolve(options.receiptDir);
    const sessionDir = path.resolve(options.sessionDir);
    const receiptPath = path.join(receiptDir, `${idempotencyKey}${RECEIPT_SUFFIX}`);
    const sessionPath = path.join(sessionDir, `${idempotencyKey}${SESSION_SUFFIX}`);
    const lockPath = path.join(sessionDir, `${idempotencyKey}${LOCK_SUFFIX}`);
    const duplicate = findDuplicateReceipt({
      receiptDir,
      idempotencyKey,
      artifactSha256,
      sizeBytes: initialStat.size,
      metadataSha256,
      privacyStatus,
      channelId: channel.id,
      ...(options.destinationAccount ? { destinationAccount: options.destinationAccount } : {}),
      ...(publicationApproval
        ? {
          publicationApprovalSha256:
            publicationApproval.approvalSha256,
        }
        : {}),
    });
    if (duplicate) {
      options.logger?.({ event: "duplicate_prevented" });
      if (["succeeded", "failed", "terminated", "privacy_mismatch", "artifact_changed"].includes(duplicate.outcome)) return duplicate;
      return pollProcessing({
        receipt: duplicate,
        receiptPath,
        apiBaseUrl,
        accessToken: options.accessToken,
        expectedChannelId: channel.id,
        expectedPrivacyStatus: privacyStatus,
        maxRetries,
        baseBackoffMs,
        intervalMs: pollIntervalMs,
        timeoutMs: pollTimeoutMs,
        deps,
        logger: options.logger,
      });
    }

    acquireUploadLock(lockPath);
    ownedLockPath = lockPath;

    const uploadStartedAt = deps.now().toISOString();
    const expectedSessionIdentity = {
      idempotency_key: idempotencyKey,
      artifact_sha256: artifactSha256,
      size_bytes: initialStat.size,
      metadata_sha256: metadataSha256,
      privacyStatus,
      mime_type: mimeType,
      channel_id: channel.id,
      ...(options.destinationAccount ? { destination_account: options.destinationAccount } : {}),
      ...(publicationApproval
        ? {
          publication_approval_sha256:
            publicationApproval.approvalSha256,
        }
        : {}),
      upload_started_at: uploadStartedAt,
    };
    let session = loadSession(sessionPath, expectedSessionIdentity);
    let sessionRestarts = 0;
    let completedVideo: RemoteVideo | undefined;
    const allowedSessionOrigin = new URL(uploadBaseUrl).origin;

    const createAndSaveSession = async (reinitialized: boolean): Promise<UploadSessionState> => {
      const sessionUrl = await startSession({
        uploadBaseUrl,
        accessToken: options.accessToken,
        metadata: options.metadata,
        privacyStatus,
        sizeBytes: initialStat.size,
        mimeType,
        maxRetries,
        baseBackoffMs,
        deps,
        logger: options.logger,
      });
      validateSessionUrl(sessionUrl, allowedSessionOrigin);
      const now = deps.now().toISOString();
      const next: UploadSessionState = {
        version: "youtube-upload-session/v1",
        ...expectedSessionIdentity,
        upload_started_at: session?.upload_started_at ?? uploadStartedAt,
        session_url: sessionUrl,
        next_offset: 0,
        created_at: now,
        updated_at: now,
      };
      atomicWriteJson(sessionPath, next, 0o600);
      options.logger?.({ event: reinitialized ? "session_reinitialized" : "session_started" });
      return next;
    };

    let loadedSessionExpired = false;
    if (session) {
      const sessionUrl = validateSessionUrl(session.session_url, allowedSessionOrigin);
      const probed = await probeSession({
        sessionUrl,
        accessToken: options.accessToken,
        sizeBytes: initialStat.size,
        maxRetries,
        baseBackoffMs,
        deps,
        logger: options.logger,
      });
      if (probed.kind === "complete") completedVideo = probed.video;
      else if (probed.kind === "expired") {
        if (session.final_attempt_pending) throw new Error("youtube_final_chunk_completion_ambiguous");
        session = undefined;
        loadedSessionExpired = true;
      }
      else {
        session.next_offset = probed.nextOffset;
        session.final_attempt_pending = false;
        session.updated_at = deps.now().toISOString();
        atomicWriteJson(sessionPath, session, 0o600);
        options.logger?.({ event: "session_resumed", next_offset: probed.nextOffset });
      }
    }
    if (!session && !completedVideo) {
      if (loadedSessionExpired) {
        if (maxSessionRestarts === 0) throw new Error("youtube_session_restart_exhausted");
        sessionRestarts += 1;
      }
      session = await createAndSaveSession(loadedSessionExpired);
    }

    while (!completedVideo) {
      if (!session) throw new Error("youtube_session_state_missing");
      const currentStat = await handle.stat();
      if (!sameFileStat(initialStat, currentStat)) throw new Error("youtube_video_changed_during_upload");
      const start = session.next_offset;
      const end = Math.min(start + chunkSize, initialStat.size) - 1;
      if (start < 0 || end < start) throw new Error("youtube_upload_offset_invalid");
      const sessionUrl = validateSessionUrl(session.session_url, allowedSessionOrigin);
      let retryAttempt = 0;

      for (;;) {
        if (end === initialStat.size - 1 && !session.final_attempt_pending) {
          session.final_attempt_pending = true;
          session.updated_at = deps.now().toISOString();
          atomicWriteJson(sessionPath, session, 0o600);
        }
        const sent = await sendChunk({
          sessionUrl,
          accessToken: options.accessToken,
          sizeBytes: initialStat.size,
          start,
          end,
          mimeType,
          createStream: () => handle.createReadStream({ autoClose: false, start, end }),
        });
        let result = sent.response;
        if (sent.transportFailed) {
          const probed = await probeSession({
            sessionUrl,
            accessToken: options.accessToken,
            sizeBytes: initialStat.size,
            maxRetries,
            baseBackoffMs,
            deps,
            logger: options.logger,
          });
          if (probed.kind === "expired" && end === initialStat.size - 1) {
            throw new Error("youtube_final_chunk_completion_ambiguous");
          }
          result = probed;
          if (result.kind === "progress" && result.nextOffset <= start) {
            if (retryAttempt >= maxRetries) throw new Error("youtube_chunk_retry_exhausted");
            await backoff(retryAttempt++, baseBackoffMs, deps, options.logger);
            continue;
          }
        }
        if (!result) throw new Error("youtube_upload_response_missing");
        if (result.kind === "complete") {
          completedVideo = result.video;
          break;
        }
        if (result.kind === "expired") {
          if (sessionRestarts >= maxSessionRestarts) throw new Error("youtube_session_restart_exhausted");
          sessionRestarts += 1;
          session = await createAndSaveSession(true);
          break;
        }
        session.next_offset = result.nextOffset;
        session.final_attempt_pending = false;
        session.updated_at = deps.now().toISOString();
        atomicWriteJson(sessionPath, session, 0o600);
        options.logger?.({ event: "chunk_accepted", next_offset: result.nextOffset });
        break;
      }
    }

    const finalStat = await handle.stat();
    const artifactChanged = !sameFileStat(initialStat, finalStat);
    const remoteCreatedAt = deps.now().toISOString();
    const receipt: YoutubeUploadReceipt = {
      version: "youtube-upload-receipt/v1",
      idempotency_key: idempotencyKey,
      outcome: artifactChanged ? "artifact_changed" : "processing",
      local: { path: videoPath, sha256: artifactSha256, size_bytes: initialStat.size },
      request: {
        metadata_sha256: metadataSha256,
        privacyStatus,
        ...(publicationApproval
          ? {
            publication_approval_sha256:
              publicationApproval.approvalSha256,
          }
          : {}),
      },
      remote: {
        video_id: completedVideo.id,
        privacyStatus,
        processingStatus: artifactChanged ? "unknown" : "processing",
        channel,
        destination: {
          platform: "youtube",
          ...(options.destinationAccount ? { approval_account: options.destinationAccount } : {}),
          ...(publicationApproval
            ? { approval_channel_id: publicationApproval.channelId }
            : {}),
        },
      },
      timestamps: {
        upload_started_at: session?.upload_started_at ?? uploadStartedAt,
        remote_created_at: remoteCreatedAt,
        processing_checked_at: remoteCreatedAt,
        ...(artifactChanged ? { completed_at: remoteCreatedAt } : {}),
        updated_at: remoteCreatedAt,
      },
    };
    saveReceipt(receiptPath, receipt);
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    options.logger?.({ event: "remote_created" });
    if (artifactChanged) return receipt;
    return pollProcessing({
      receipt,
      receiptPath,
      apiBaseUrl,
      accessToken: options.accessToken,
      expectedChannelId: channel.id,
      expectedPrivacyStatus: privacyStatus,
      maxRetries,
      baseBackoffMs,
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
      deps,
      logger: options.logger,
    });
  } finally {
    if (ownedLockPath && fs.existsSync(ownedLockPath)) fs.unlinkSync(ownedLockPath);
    await handle.close();
  }
}
