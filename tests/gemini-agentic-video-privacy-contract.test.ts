import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiAgenticVideoConnector } from
  "../runtime/connectors/gemini-agentic-video.js";
import type { VideoReasoningRequest } from
  "../runtime/connectors/video-reasoning-types.js";
import { main } from "../scripts/agentic-video-probe.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeVideo(bytes = "privacy-contract-video"): { path: string; sha256: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-video-privacy-"));
  tempDirs.push(dir);
  const videoPath = path.join(dir, "proxy.mp4");
  fs.writeFileSync(videoPath, bytes);
  return {
    path: videoPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("Gemini Agentic Video bounded-derivative privacy contract", () => {
  it("rejects original bytes presented as a bounded derivative before provider access", async () => {
    let transportCalls = 0;
    const connector = createGeminiAgenticVideoConnector({
      apiKey: "test-only-key",
      transport: async () => {
        transportCalls += 1;
        return { status: 200, body: "{}" };
      },
    });
    const sameHash = "a".repeat(64);
    const request: VideoReasoningRequest = {
      task: "needle_search",
      model: "gemini-3.7-flash",
      prompt: "Find the strongest reveal.",
      source: {
        assetId: "AST_PRIVACY",
        sourceContentSha256: sameHash,
        submittedMediaContentSha256: sameHash,
        sourceDurationUs: 10_000_000,
      },
      input: {
        kind: "provider_uri",
        uri: "gs://registered-bucket/bounded-proxy.mp4",
        mimeType: "video/mp4",
      },
      privacy: "bounded_derivative",
      consent: {
        approved: true,
        scope: "bounded_derivative",
      },
      budget: {
        maxRequests: 1,
      },
    };

    const result = await connector(request);

    expect(result.outcome).toBe("rejected");
    expect(result.diagnostic.errorCode).toBe("invalid_request");
    expect(result.diagnostic.submitted).toBe(false);
    expect(transportCalls).toBe(0);
  });

  it("refuses an ambiguous bounded-derivative CLI request before fetch", async () => {
    const media = makeVideo();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await main([
      "node",
      "script",
      "--video",
      media.path,
      "--asset-id",
      "AST_PRIVACY",
      "--duration-us",
      "10000000",
      "--source-sha256",
      media.sha256,
      "--prompt",
      "Find the strongest reveal.",
      "--privacy",
      "bounded_derivative",
      "--consent-cloud-upload",
    ]);

    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[agentic-video:probe] bounded_derivative requires original and submitted media to have distinct SHA-256 identities",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(media.path);
  });

  it("does not expose a missing local path from the probe CLI", async () => {
    const secretPath = "/tmp/private-project-name/missing-video.mp4";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await main([
      "node",
      "script",
      "--video",
      secretPath,
      "--asset-id",
      "AST_PRIVACY",
      "--duration-us",
      "10000000",
      "--prompt",
      "Find the strongest reveal.",
      "--privacy",
      "source_allowed",
      "--consent-cloud-upload",
    ]);

    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[agentic-video:probe] input validation failed");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secretPath);
  });
});
