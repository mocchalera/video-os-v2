import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseYoutubeUploadArgs } from "../scripts/youtube-upload.js";
import { computeSha256 } from "../runtime/packaging/manifest.js";
import {
  uploadYoutubeVideo,
  youtubeUploadMetadataSha256,
  type YoutubePublicationApproval,
  type YoutubeUploadLogEvent,
  type YoutubeUploadMetadata,
  type YoutubeUploadOptions,
} from "../runtime/packaging/youtube-resumable-upload.js";

const CHUNK_SIZE = 256 * 1024;
const ACCESS_TOKEN = "test-oauth-token-must-not-leak";
const metadata: YoutubeUploadMetadata = {
  snippet: {
    title: "Resumable upload fixture",
    description: "local mock only",
    tags: ["fixture", "resumable"],
    categoryId: "22",
  },
};
const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  videoPath: string;
  receiptDir: string;
  sessionDir: string;
}

function createFixture(content: Buffer | string = "video-fixture"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-resumable-"));
  tempDirs.push(root);
  const videoPath = path.join(root, "final.mp4");
  fs.writeFileSync(videoPath, content);
  return {
    root,
    videoPath,
    receiptDir: path.join(root, "receipts"),
    sessionDir: path.join(root, "sessions"),
  };
}

async function startMockServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>,
): Promise<string> {
  const server = http.createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), ...headers });
  response.end(body);
}

function sendChannel(response: http.ServerResponse): void {
  sendJson(response, 200, { items: [{ id: "UC_LOCAL_TEST", snippet: { title: "Local Test Channel" } }] });
}

function sendProcessing(
  response: http.ServerResponse,
  processingStatus: "processing" | "succeeded" | "failed" = "succeeded",
): void {
  sendJson(response, 200, {
    items: [{
      id: "video-local-1",
      processingDetails: { processingStatus },
      status: { privacyStatus: "unlisted" },
      snippet: { channelId: "UC_LOCAL_TEST", channelTitle: "Local Test Channel" },
    }],
  });
}

function optionsFor(fixture: Fixture, baseUrl: string, overrides: Partial<YoutubeUploadOptions> = {}): YoutubeUploadOptions {
  return {
    videoPath: fixture.videoPath,
    metadata,
    accessToken: ACCESS_TOKEN,
    privacyStatus: "unlisted",
    expectedChannelId: "UC_LOCAL_TEST",
    destinationAccount: "approved-destination",
    receiptDir: fixture.receiptDir,
    sessionDir: fixture.sessionDir,
    chunkSizeBytes: CHUNK_SIZE,
    baseBackoffMs: 0,
    processingPollIntervalMs: 0,
    processingTimeoutMs: 1_000,
    apiBaseUrl: `${baseUrl}/youtube/v3/`,
    uploadBaseUrl: `${baseUrl}/upload/youtube/v3/`,
    dependencies: { sleep: async () => undefined, random: () => 0 },
    ...overrides,
  };
}

function publicationApprovalFor(
  fixture: Fixture,
  overrides: Partial<YoutubePublicationApproval> = {},
): YoutubePublicationApproval {
  return {
    version: "publication-approval/v2",
    approvalSha256: `sha256:${"a".repeat(64)}`,
    artifactSha256: computeSha256(fixture.videoPath),
    privacyStatus: "unlisted",
    channelId: "UC_LOCAL_TEST",
    metadataSha256: youtubeUploadMetadataSha256(metadata),
    ...overrides,
  };
}

describe("YouTube resumable upload worker", () => {
  it("streams chunks, follows 308 offsets, polls processing, and writes a redacted receipt", async () => {
    const fixture = createFixture(Buffer.alloc(600 * 1024, 7));
    const ranges: string[] = [];
    const uploadBodies: number[] = [];
    const initiationBodies: unknown[] = [];
    const initiationUrls: string[] = [];
    let processingPolls = 0;
    const logs: YoutubeUploadLogEvent[] = [];
    let baseUrl = "";
    baseUrl = await startMockServer(async (request, response) => {
      const requestUrl = request.url ?? "";
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/channels")) return sendChannel(response);
      if (request.method === "POST" && requestUrl.startsWith("/upload/youtube/v3/videos")) {
        initiationUrls.push(requestUrl);
        initiationBodies.push(JSON.parse((await readBody(request)).toString("utf8")));
        response.writeHead(200, { location: `${baseUrl}/session/secret-session-url` });
        response.end();
        return;
      }
      if (request.method === "PUT" && requestUrl === "/session/secret-session-url") {
        const range = String(request.headers["content-range"]);
        const body = await readBody(request);
        ranges.push(range);
        uploadBodies.push(body.length);
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
        if (!match) throw new Error("unexpected probe");
        const end = Number(match[2]);
        const total = Number(match[3]);
        if (end + 1 === total) return sendJson(response, 201, { id: "video-local-1" });
        response.writeHead(308, { range: `bytes=0-${end}` });
        response.end();
        return;
      }
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/videos")) {
        processingPolls += 1;
        return sendProcessing(response, processingPolls === 1 ? "processing" : "succeeded");
      }
      response.writeHead(404).end();
    });

    const approval = publicationApprovalFor(fixture);
    const receipt = await uploadYoutubeVideo(optionsFor(fixture, baseUrl, {
      logger: (event) => logs.push(event),
      publicationApproval: approval,
    }));

    expect(ranges).toEqual([
      "bytes 0-262143/614400",
      "bytes 262144-524287/614400",
      "bytes 524288-614399/614400",
    ]);
    expect(uploadBodies).toEqual([262144, 262144, 90112]);
    expect(initiationBodies).toEqual([expect.objectContaining({ status: { privacyStatus: "unlisted" }, snippet: metadata.snippet })]);
    expect(initiationUrls[0]).toContain("notifySubscribers=false");
    expect(processingPolls).toBe(2);
    expect(receipt).toMatchObject({
      version: "youtube-upload-receipt/v1",
      outcome: "succeeded",
      local: { size_bytes: 614400, sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      request: {
        metadata_sha256: youtubeUploadMetadataSha256(metadata),
        privacyStatus: "unlisted",
        publication_approval_sha256: approval.approvalSha256,
      },
      remote: {
        video_id: "video-local-1",
        privacyStatus: "unlisted",
        processingStatus: "succeeded",
        channel: { id: "UC_LOCAL_TEST", title: "Local Test Channel" },
        destination: {
          platform: "youtube",
          approval_account: "approved-destination",
          approval_channel_id: "UC_LOCAL_TEST",
        },
      },
      timestamps: { completed_at: expect.any(String) },
    });
    const receiptFiles = fs.readdirSync(fixture.receiptDir);
    expect(receiptFiles).toHaveLength(1);
    const receiptText = fs.readFileSync(path.join(fixture.receiptDir, receiptFiles[0]), "utf8");
    expect(receiptText).not.toContain(ACCESS_TOKEN);
    expect(receiptText).not.toContain("secret-session-url");
    expect(JSON.stringify(logs)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(logs)).not.toContain("secret-session-url");
    expect(fs.statSync(path.join(fixture.receiptDir, receiptFiles[0])).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(fixture.sessionDir)).toEqual([]);
  });

  it("probes the committed offset and applies exponential backoff after a 5xx chunk response", async () => {
    const fixture = createFixture("retry-video");
    let chunkAttempts = 0;
    let probeCount = 0;
    const delays: number[] = [];
    let baseUrl = "";
    baseUrl = await startMockServer(async (request, response) => {
      const requestUrl = request.url ?? "";
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/channels")) return sendChannel(response);
      if (request.method === "POST" && requestUrl.startsWith("/upload/youtube/v3/videos")) {
        await readBody(request);
        response.writeHead(200, { location: `${baseUrl}/session/retry` }).end();
        return;
      }
      if (request.method === "PUT" && requestUrl === "/session/retry") {
        const range = String(request.headers["content-range"]);
        await readBody(request);
        if (range.startsWith("bytes */")) {
          probeCount += 1;
          response.writeHead(308).end();
        } else {
          chunkAttempts += 1;
          if (chunkAttempts <= 2) response.writeHead(503).end();
          else sendJson(response, 200, { id: "video-local-1" });
        }
        return;
      }
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/videos")) return sendProcessing(response);
      response.writeHead(404).end();
    });

    const receipt = await uploadYoutubeVideo(optionsFor(fixture, baseUrl, {
      baseBackoffMs: 100,
      dependencies: { sleep: async (delay) => { delays.push(delay); }, random: () => 0 },
    }));

    expect(receipt.outcome).toBe("succeeded");
    expect(chunkAttempts).toBe(3);
    expect(probeCount).toBe(2);
    expect(delays).toEqual([75, 150]);
  });

  it("reinitializes an explicitly expired session without reusing its URL", async () => {
    const fixture = createFixture("expiry-video");
    let sessionsStarted = 0;
    const chunkSessionPaths: string[] = [];
    const logs: YoutubeUploadLogEvent[] = [];
    let baseUrl = "";
    baseUrl = await startMockServer(async (request, response) => {
      const requestUrl = request.url ?? "";
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/channels")) return sendChannel(response);
      if (request.method === "POST" && requestUrl.startsWith("/upload/youtube/v3/videos")) {
        await readBody(request);
        sessionsStarted += 1;
        response.writeHead(200, { location: `${baseUrl}/session/expiry-${sessionsStarted}` }).end();
        return;
      }
      if (request.method === "PUT" && requestUrl.startsWith("/session/expiry-")) {
        await readBody(request);
        chunkSessionPaths.push(requestUrl);
        if (requestUrl.endsWith("-1")) response.writeHead(404).end();
        else sendJson(response, 200, { id: "video-local-1" });
        return;
      }
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/videos")) return sendProcessing(response);
      response.writeHead(404).end();
    });

    const receipt = await uploadYoutubeVideo(optionsFor(fixture, baseUrl, { logger: (event) => logs.push(event) }));

    expect(receipt.outcome).toBe("succeeded");
    expect(sessionsStarted).toBe(2);
    expect(chunkSessionPaths).toEqual(["/session/expiry-1", "/session/expiry-2"]);
    expect(logs).toContainEqual({ event: "session_reinitialized" });
  });

  it("refuses to reinitialize an expired session after an ambiguous final-chunk attempt", async () => {
    const fixture = createFixture("ambiguous-final-video");
    let phase: "ambiguous" | "expired" = "ambiguous";
    let sessionsStarted = 0;
    let baseUrl = "";
    baseUrl = await startMockServer(async (request, response) => {
      const requestUrl = request.url ?? "";
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/channels")) return sendChannel(response);
      if (request.method === "POST" && requestUrl.startsWith("/upload/youtube/v3/videos")) {
        await readBody(request);
        sessionsStarted += 1;
        response.writeHead(200, { location: `${baseUrl}/session/ambiguous-final` }).end();
        return;
      }
      if (request.method === "PUT" && requestUrl === "/session/ambiguous-final") {
        const range = String(request.headers["content-range"]);
        await readBody(request);
        if (phase === "ambiguous" && !range.startsWith("bytes */")) response.writeHead(503).end();
        else if (phase === "ambiguous") response.writeHead(503).end();
        else response.writeHead(404).end();
        return;
      }
      response.writeHead(404).end();
    });
    const approval = publicationApprovalFor(fixture);
    const uploadOptions = optionsFor(fixture, baseUrl, {
      maxRetries: 0,
      publicationApproval: approval,
    });

    await expect(uploadYoutubeVideo(uploadOptions)).rejects.toThrow("youtube_upload_http_503");
    const stateName = fs.readdirSync(fixture.sessionDir).find((entry) => entry.endsWith(".youtube-upload-session.json"));
    expect(stateName).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, stateName!), "utf8"))).toMatchObject({
      final_attempt_pending: true,
      publication_approval_sha256: approval.approvalSha256,
    });
    phase = "expired";
    await expect(uploadYoutubeVideo(uploadOptions)).rejects.toThrow("youtube_final_chunk_completion_ambiguous");
    expect(sessionsStarted).toBe(1);
  });

  it("fails before any HTTP request when the approved local SHA-256 does not match", async () => {
    const fixture = createFixture("hash-mismatch");
    await expect(uploadYoutubeVideo(optionsFor(fixture, "http://127.0.0.1:1", {
      expectedArtifactSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }))).rejects.toThrow("youtube_artifact_hash_mismatch");
    expect(fs.existsSync(fixture.receiptDir)).toBe(false);
    expect(fs.existsSync(fixture.sessionDir)).toBe(false);
  });

  it("fails before any HTTP request when metadata differs from publication approval", async () => {
    const fixture = createFixture("metadata-mismatch");
    await expect(uploadYoutubeVideo(optionsFor(fixture, "http://127.0.0.1:1", {
      publicationApproval: publicationApprovalFor(fixture, {
        metadataSha256:
          `sha256:${"0".repeat(64)}`,
      }),
    }))).rejects.toThrow("youtube_publication_approval_metadata_mismatch");
    expect(fs.existsSync(fixture.receiptDir)).toBe(false);
    expect(fs.existsSync(fixture.sessionDir)).toBe(false);
  });

  it("returns the matching final receipt instead of uploading the same artifact twice", async () => {
    const fixture = createFixture("duplicate-video");
    let sessionStarts = 0;
    let channelLookups = 0;
    let baseUrl = "";
    baseUrl = await startMockServer(async (request, response) => {
      const requestUrl = request.url ?? "";
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/channels")) {
        channelLookups += 1;
        return sendChannel(response);
      }
      if (request.method === "POST" && requestUrl.startsWith("/upload/youtube/v3/videos")) {
        await readBody(request);
        sessionStarts += 1;
        response.writeHead(200, { location: `${baseUrl}/session/duplicate` }).end();
        return;
      }
      if (request.method === "PUT" && requestUrl === "/session/duplicate") {
        await readBody(request);
        return sendJson(response, 200, { id: "video-local-1" });
      }
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/videos")) return sendProcessing(response);
      response.writeHead(404).end();
    });

    const approval = publicationApprovalFor(fixture);
    const first = await uploadYoutubeVideo(optionsFor(fixture, baseUrl, {
      publicationApproval: approval,
    }));
    const second = await uploadYoutubeVideo(optionsFor(fixture, baseUrl, {
      publicationApproval: approval,
    }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.remote.video_id).toBe(second.remote.video_id);
    expect(sessionStarts).toBe(1);
    expect(channelLookups).toBe(2);

    await expect(uploadYoutubeVideo(optionsFor(fixture, baseUrl, {
      publicationApproval: publicationApprovalFor(fixture, {
        approvalSha256: `sha256:${"b".repeat(64)}`,
      }),
    }))).rejects.toThrow("youtube_duplicate_exists_for_different_approval");
    expect(sessionStarts).toBe(1);
    expect(channelLookups).toBe(3);
  });

  it("resumes a sparse 512 MiB-plus fixture at a large Content-Range without buffering the file", async () => {
    const fixture = createFixture();
    const sparseSize = 512 * 1024 * 1024 + 1;
    const descriptor = fs.openSync(fixture.videoPath, "w");
    fs.ftruncateSync(descriptor, sparseSize);
    fs.writeSync(descriptor, Buffer.from([9]), 0, 1, sparseSize - 1);
    fs.closeSync(descriptor);
    const fakeHash = `sha256:${"a".repeat(64)}`;
    let phase: "seed" | "resume" = "seed";
    const bodySizes: number[] = [];
    const contentRanges: string[] = [];
    let baseUrl = "";
    baseUrl = await startMockServer(async (request, response) => {
      const requestUrl = request.url ?? "";
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/channels")) return sendChannel(response);
      if (request.method === "POST" && requestUrl.startsWith("/upload/youtube/v3/videos")) {
        await readBody(request);
        response.writeHead(200, { location: `${baseUrl}/session/large-secret` }).end();
        return;
      }
      if (request.method === "PUT" && requestUrl === "/session/large-secret") {
        const range = String(request.headers["content-range"]);
        const body = await readBody(request);
        contentRanges.push(range);
        bodySizes.push(body.length);
        if (phase === "seed") {
          response.writeHead(308, { range: `bytes=0-${sparseSize - 2}` }).end();
        } else if (range.startsWith("bytes */")) {
          response.writeHead(308, { range: `bytes=0-${sparseSize - 2}` }).end();
        } else sendJson(response, 200, { id: "video-local-1" });
        return;
      }
      if (request.method === "GET" && requestUrl.startsWith("/youtube/v3/videos")) return sendProcessing(response);
      response.writeHead(404).end();
    });
    const largeOptions = optionsFor(fixture, baseUrl, {
      dependencies: {
        hashOpenFile: async () => fakeHash,
        sleep: async () => undefined,
        random: () => 0,
      },
    });

    await expect(uploadYoutubeVideo(largeOptions)).rejects.toThrow("youtube_upload_offset_exceeds_chunk");
    const sessionFile = path.join(fixture.sessionDir, fs.readdirSync(fixture.sessionDir).find((entry) => entry.endsWith(".youtube-upload-session.json"))!);
    expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(sessionFile, "utf8")).toContain("large-secret");
    phase = "resume";
    const receipt = await uploadYoutubeVideo(largeOptions);

    expect(receipt.outcome).toBe("succeeded");
    expect(receipt.local.size_bytes).toBe(sparseSize);
    expect(contentRanges).toContain(`bytes */${sparseSize}`);
    expect(contentRanges).toContain(`bytes ${sparseSize - 1}-${sparseSize - 1}/${sparseSize}`);
    expect(bodySizes.at(-1)).toBe(1);
    expect(fs.readdirSync(fixture.sessionDir)).toEqual([]);
  });

  it("rejects public visibility in the worker without a hash-bound public approval", async () => {
    const fixture = createFixture("public-video");
    await expect(uploadYoutubeVideo(optionsFor(fixture, "http://127.0.0.1:1", {
      privacyStatus: "public",
    }))).rejects.toThrow("youtube_publication_approval_required_for_public");
  });
});

describe("YouTube upload CLI arguments", () => {
  it("defaults to unlisted and never accepts an OAuth token value as an argument", () => {
    expect(parseYoutubeUploadArgs(["project", "--metadata", "metadata.json"])).toMatchObject({
      privacyStatus: "unlisted",
      accessTokenEnv: "YOUTUBE_ACCESS_TOKEN",
    });
    expect(() => parseYoutubeUploadArgs(["project", "--metadata", "metadata.json", "--access-token", ACCESS_TOKEN])).toThrow();
  });
});
