import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PremierePreflightProcessBroker,
  type PremierePreflightDiscoveryBinding,
  type PremierePreflightEvaluationBinding,
  type PremierePreflightExecutableIdentity,
  type PremierePreflightSpawn,
  type PremierePreflightSpawnRequest,
} from "../runtime/handoff/premiere-preflight-process-broker.js";

const cwd = "/repo", runId = "run-1", wrapperPid = 4242;
const discoverySha = `sha256:${"d".repeat(64)}`, evaluationSha = `sha256:${"e".repeat(64)}`, requestSha = `sha256:${"f".repeat(64)}`;

function discovery(tool: "ffmpeg" | "ffprobe", ordinal: 0 | 1, overrides: Partial<PremierePreflightDiscoveryBinding> = {}): PremierePreflightDiscoveryBinding {
  return { preflight_run_id: runId, wrapper2_pid: wrapperPid, discovery_sha256: discoverySha, tool, discovery_ordinal: ordinal, ...overrides };
}

function evaluation(operationOrdinal: number, overrides: Partial<PremierePreflightEvaluationBinding> = {}): PremierePreflightEvaluationBinding {
  return { preflight_run_id: runId, wrapper2_pid: wrapperPid, evaluation_ordinal: 1, track_id: "V1", clip_id: "C1", evaluation_sha256: evaluationSha, request_sha256: null, ready_cache_generation_id: null, operation_ordinal: operationOrdinal, ...overrides };
}

function identity(realpath: string): PremierePreflightExecutableIdentity {
  return { realpath, dev: "1", ino: realpath.endsWith("ffmpeg") ? "2" : "3", mode: 0o100755, nlink: 1, size: 42, mtime_ns: "4", ctime_ns: "5" };
}

function recordingSpawn(requests: PremierePreflightSpawnRequest[]): PremierePreflightSpawn {
  return async (request) => {
    requests.push(request);
    return {
      exit_code: 0,
      signal: null,
      stdout: request.executable.endsWith("/which") || request.executable.endsWith("/which.debianutils")
        ? `/opt/homebrew/bin/${request.argv[0]}\n`
        : request.argv[0] === "-version" ? "ffmpeg version fixture\r\n" : "{}\n",
      stderr: "",
      executable_realpath: request.executable,
      argv: [...request.argv],
      child_pid: 5000 + requests.length,
      parent_pid: wrapperPid,
    };
  };
}

function fakeBroker(requests: PremierePreflightSpawnRequest[] = []): PremierePreflightProcessBroker {
  return new PremierePreflightProcessBroker({ cwd, preflight_run_id: runId, wrapper2_pid: wrapperPid, spawn: recordingSpawn(requests), realpath: (value) => value, executableIdentity: identity, sourceFile: () => true });
}

async function discoverBoth(broker: PremierePreflightProcessBroker): Promise<void> {
  await broker.run({ kind: "which_ffmpeg" }, discovery("ffmpeg", 0));
  await broker.run({ kind: "which_ffprobe" }, discovery("ffprobe", 1));
}

describe("runtime preflight process broker", () => {
  it("non-circular discovery evaluation stages issue immutable receipts and broker READY validators", async () => {
    const requests: PremierePreflightSpawnRequest[] = [], broker = fakeBroker(requests);
    const ffmpeg = await broker.run({ kind: "which_ffmpeg" }, discovery("ffmpeg", 0));
    const ffprobe = await broker.run({ kind: "which_ffprobe" }, discovery("ffprobe", 1));
    const source = await broker.run({ kind: "source_ffprobe", source_path: "/media/source.mov", source_fd: 19 }, evaluation(0));
    const version = await broker.run({ kind: "ffmpeg_version" }, evaluation(1));
    const generation = `sha256:${"a".repeat(64)}`;
    const ready = { request_sha256: requestSha, ready_cache_generation_id: generation };
    const metadata = await broker.run({ kind: "ready_cache_ffprobe", media_path: "/media/cache.mp4", media_fd: 20, probe_mode: "output_metadata" }, evaluation(2, ready));
    const packets = await broker.run({ kind: "ready_cache_ffprobe", media_path: "/media/cache.mp4", media_fd: 20, probe_mode: "packet_timing" }, evaluation(3, ready));
    const frames = await broker.run({ kind: "ready_cache_ffprobe", media_path: "/media/cache.mp4", media_fd: 20, probe_mode: "frame_timing" }, evaluation(4, ready));
    const stream = await broker.run({ kind: "ready_cache_stream_hash", media_path: "/media/cache.mp4", media_fd: 20 }, evaluation(5, ready));
    expect(ffmpeg.receipt.discovery_sha256).toBe(discoverySha);
    expect(ffprobe.receipt.discovery_sha256).toBe(discoverySha);
    expect(Object.isFrozen(ffmpeg.receipt)).toBe(true);
    expect([source, version, metadata, packets, frames, stream].map((entry) => entry.receipt.binding.evaluation_sha256)).toEqual(Array(6).fill(evaluationSha));
    expect(version.receipt.binding.request_sha256).toBeNull();
    expect([metadata, packets, frames, stream].map((entry) => entry.receipt.binding.request_sha256)).toEqual(Array(4).fill(requestSha));
    expect([metadata.receipt.variant, packets.receipt.variant, frames.receipt.variant, stream.receipt.variant]).toEqual(["ready_cache_ffprobe", "ready_cache_ffprobe", "ready_cache_ffprobe", "ready_cache_stream_hash"]);
    expect(new Set([ffmpeg.receipt.broker_invocation_receipt_sha256, ffprobe.receipt.broker_invocation_receipt_sha256, source.receipt.receipt_sha256, version.receipt.receipt_sha256, metadata.receipt.receipt_sha256, packets.receipt.receipt_sha256, frames.receipt.receipt_sha256, stream.receipt.receipt_sha256]).size).toBe(8);
    await expect(broker.run({ kind: "ready_cache_ffprobe", media_path: "/media/cache.mp4", media_fd: 20, probe_mode: "output_metadata" }, evaluation(8, ready))).rejects.toThrow(/process cardinality exceeded/);
    expect(requests.every((request) => request.shell === false && request.cwd === cwd && Object.keys(request.env).sort().join("|") === "LANG|LC_ALL|PATH")).toBe(true);
  });

  it("runs actual READY-cache validator descendants and records the wrapper process tree", async () => {
    const repoRoot = path.resolve(import.meta.dirname, ".."), broker = new PremierePreflightProcessBroker({ cwd: repoRoot, preflight_run_id: runId, wrapper2_pid: process.pid });
    await broker.run({ kind: "which_ffmpeg" }, discovery("ffmpeg", 0, { wrapper2_pid: process.pid }));
    await broker.run({ kind: "which_ffprobe" }, discovery("ffprobe", 1, { wrapper2_pid: process.pid }));
    const media = fs.realpathSync(path.join(repoRoot, "package.json")), fd = fs.openSync(media, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const ready = { wrapper2_pid: process.pid, request_sha256: requestSha, ready_cache_generation_id: `sha256:${"a".repeat(64)}` };
    try {
      const probe = await broker.run({ kind: "ready_cache_ffprobe", media_path: media, media_fd: fd, probe_mode: "output_metadata" }, evaluation(2, ready));
      const stream = await broker.run({ kind: "ready_cache_stream_hash", media_path: media, media_fd: fd }, evaluation(5, ready));
      for (const result of [probe, stream]) {
        expect(result.receipt.parent_pid).toBe(process.pid);
        expect(result.receipt.child_pid).toBeGreaterThan(0);
        expect(result.receipt.exit_code).not.toBe(0);
      }
    } finally { fs.closeSync(fd); }
  });

  it("constructs exact argv and refuses association/cardinality reuse", async () => {
    const requests: PremierePreflightSpawnRequest[] = [], broker = fakeBroker(requests);
    await discoverBoth(broker);
    const sourceBinding = evaluation(0);
    await broker.run({ kind: "source_ffprobe", source_path: "/media/source.mov", source_fd: 19 }, sourceBinding);
    await broker.run({ kind: "ffmpeg_version" }, evaluation(1));
    await expect(broker.run({ kind: "ffmpeg_version" }, evaluation(1))).rejects.toThrow(/forbidden_process/);
    await expect(broker.run({ kind: "source_ffprobe", source_path: "/media/source.mov", source_fd: 19 }, evaluation(7, { request_sha256: requestSha }))).rejects.toThrow(/forbidden_process/);
    expect(requests.map(({ executable, argv }) => ({ executable, argv }))).toEqual([
      { executable: "/usr/bin/which", argv: ["ffmpeg"] },
      { executable: "/usr/bin/which", argv: ["ffprobe"] },
      { executable: "/opt/homebrew/bin/ffprobe", argv: ["-v", "error", "-show_format", "-show_streams", "-of", "json", "file:/dev/fd/3"] },
      { executable: "/opt/homebrew/bin/ffmpeg", argv: ["-version"] },
    ]);
  });

  it("canonicalizes Linux symlinked fixed executables before identity checks and spawn", async () => {
    const requests: PremierePreflightSpawnRequest[] = [];
    const realpath = (value: string): string => value === "/usr/bin/which"
      ? "/usr/bin/which.debianutils"
      : value === "/usr/bin/ps" ? "/bin/ps" : value;
    const broker = new PremierePreflightProcessBroker({
      cwd,
      preflight_run_id: runId,
      wrapper2_pid: wrapperPid,
      platform: "linux",
      spawn: recordingSpawn(requests),
      realpath,
      executableIdentity: identity,
      sourceFile: () => true,
    });
    await discoverBoth(broker);
    const ps = await broker.run({ kind: "ps_exact_if_reachable", pid: 123 }, evaluation(9));

    expect(requests.map((request) => request.executable)).toEqual([
      "/usr/bin/which.debianutils",
      "/usr/bin/which.debianutils",
      "/bin/ps",
    ]);
    expect(ps.receipt.executable_realpath).toBe("/bin/ps");
  });

  it("still rejects a discovered executable path that stops being canonical", async () => {
    const requests: PremierePreflightSpawnRequest[] = [];
    let retargeted = false;
    const broker = new PremierePreflightProcessBroker({
      cwd,
      preflight_run_id: runId,
      wrapper2_pid: wrapperPid,
      spawn: recordingSpawn(requests),
      realpath: (value) => retargeted && value === "/opt/homebrew/bin/ffmpeg"
        ? "/tmp/retargeted-ffmpeg"
        : value,
      executableIdentity: identity,
      sourceFile: () => true,
    });
    await discoverBoth(broker);
    retargeted = true;

    await expect(broker.run({ kind: "ffmpeg_version" }, evaluation(10))).rejects.toThrow(
      /executable path is not canonical absolute/,
    );
    expect(requests).toHaveLength(2);
  });

  it("rejects bypass, shell-shaped, network, response-file, output, render, bake, transcode and write attempts", async () => {
    const broker = fakeBroker();
    await expect(broker.run({ kind: "raw", executable: "/bin/sh", argv: ["-c", "true"] } as never, evaluation(0))).rejects.toThrow(/forbidden_process/);
    await discoverBoth(broker);
    for (const source_path of ["https://example.test/a.mov", "tcp://127.0.0.1/a", "/media/@response", "/media/out.mov\n-y"]) {
      await expect(broker.run({ kind: "source_ffprobe", source_path, source_fd: 20 }, evaluation(10 + source_path.length))).rejects.toThrow(/forbidden_process/);
    }
  });
});
