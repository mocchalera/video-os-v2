#!/usr/bin/env tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../runtime/eval/editorial-eye-suite.js";

export type GeneratedMediaKind = "video" | "audio" | "image" | "sequence" | "mixed";

export interface GeneratedMediaSpec {
  artifact_version: "editorial-eye-generated-media-spec/v1";
  generator_id: "editorial-eye-lavfi-fixtures";
  generator_version: "1.0.0";
  deterministic_inputs: true;
  fixtures: Array<{
    fixture_id: string;
    media_kind: GeneratedMediaKind;
    output: string;
    ffmpeg_args: string[];
  }>;
}

export interface GeneratedFixtureResult {
  artifact_version: "editorial-eye-generated-media-manifest/v1";
  status: "generated" | "degraded";
  degraded_reason?: string;
  spec_sha256: string;
  fixtures: Array<{
    fixture_id: string;
    media_kind: GeneratedMediaKind;
    outputs: string[];
    generated_bytes_sha256: string;
    decoded_frame_sha256?: string;
    stream_topology: string;
    duration_ms: number;
    audio_rms_db?: number;
  }>;
}

export function buildGeneratedMediaSpec(): GeneratedMediaSpec {
  return {
    artifact_version: "editorial-eye-generated-media-spec/v1",
    generator_id: "editorial-eye-lavfi-fixtures",
    generator_version: "1.0.0",
    deterministic_inputs: true,
    fixtures: [
      { fixture_id: "generated-video", media_kind: "video", output: "video.mp4", ffmpeg_args: ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=1", "-an", "-c:v", "mpeg4", "-q:v", "3", "-metadata", "creation_time=1970-01-01T00:00:00Z", "{output}"] },
      { fixture_id: "generated-audio", media_kind: "audio", output: "audio.wav", ffmpeg_args: ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-vn", "-c:a", "pcm_s16le", "{output}"] },
      { fixture_id: "generated-image", media_kind: "image", output: "still.png", ffmpeg_args: ["-f", "lavfi", "-i", "color=c=0x336699:s=96x64:d=1", "-frames:v", "1", "-threads", "1", "{output}"] },
      { fixture_id: "generated-sequence", media_kind: "sequence", output: "sequence/frame-%03d.png", ffmpeg_args: ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=3:duration=1", "-frames:v", "3", "-threads", "1", "{output}"] },
      { fixture_id: "generated-mixed", media_kind: "mixed", output: "mixed.mp4", ffmpeg_args: ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=1", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", "-shortest", "-metadata", "creation_time=1970-01-01T00:00:00Z", "{output}"] }
    ]
  };
}

function sha256(buffers: Buffer[]): string {
  const hash = crypto.createHash("sha256");
  for (const buffer of buffers) hash.update(buffer);
  return hash.digest("hex");
}

function executableAvailable(binary: string): boolean {
  const result = spawnSync(binary, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

function fixtureOutputs(outputRoot: string, outputPattern: string): string[] {
  if (!outputPattern.includes("%03d")) return [path.join(outputRoot, outputPattern)];
  const directory = path.join(outputRoot, path.dirname(outputPattern));
  return fs.readdirSync(directory).filter((name) => /^frame-\d{3}\.png$/.test(name)).sort().map((name) => path.join(directory, name));
}

function probeFixture(ffmpeg: string, ffprobe: string, outputs: string[], mediaKind: GeneratedMediaKind): Omit<GeneratedFixtureResult["fixtures"][number], "fixture_id" | "media_kind" | "outputs"> {
  const target = outputs[0];
  const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-show_entries", "format=duration", "-of", "json", target], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr.trim()}`);
  const parsed = JSON.parse(probe.stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string }>; format?: { duration?: string } };
  const topology = (parsed.streams ?? []).map((stream) => `${stream.codec_type ?? "unknown"}:${stream.codec_name ?? "unknown"}`).sort().join("+") || "unknown";
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  const buffers = outputs.map((file) => fs.readFileSync(file));
  const result: Omit<GeneratedFixtureResult["fixtures"][number], "fixture_id" | "media_kind" | "outputs"> = {
    generated_bytes_sha256: sha256(buffers), stream_topology: topology, duration_ms: Number.isFinite(durationMs) ? durationMs : 0,
  };
  if (mediaKind !== "audio") {
    const decoded = spawnSync(ffmpeg, ["-v", "error", "-i", target, "-map", "0:v:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: null, maxBuffer: 10 * 1024 * 1024 });
    if (decoded.status !== 0) throw new Error(`decoded frame probe failed: ${decoded.stderr.toString().trim()}`);
    result.decoded_frame_sha256 = sha256([decoded.stdout]);
  }
  if (mediaKind === "audio" || mediaKind === "mixed") {
    const rms = spawnSync(ffmpeg, ["-hide_banner", "-i", target, "-af", "astats=metadata=1:reset=0", "-f", "null", "-"], { encoding: "utf8" });
    const matches = [...rms.stderr.matchAll(/RMS level dB:\s*(-?(?:\d+(?:\.\d+)?|inf))/g)];
    const value = matches.at(-1)?.[1];
    if (value && value !== "-inf") result.audio_rms_db = Number(value);
  }
  return result;
}

export function generateEditorialEyeFixtures(options: { outputRoot: string; ffmpeg?: string; ffprobe?: string; write?: boolean }): GeneratedFixtureResult | { status: "spec_only"; spec: GeneratedMediaSpec; spec_sha256: string } {
  const spec = buildGeneratedMediaSpec();
  const specSha = sha256([Buffer.from(canonicalJson(spec))]);
  if (options.write === false) return { status: "spec_only", spec, spec_sha256: specSha };
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  if (!executableAvailable(ffmpeg) || !executableAvailable(ffprobe)) {
    return { artifact_version: "editorial-eye-generated-media-manifest/v1", status: "degraded", degraded_reason: "ffmpeg_or_ffprobe_unavailable", spec_sha256: specSha, fixtures: [] };
  }
  fs.mkdirSync(options.outputRoot, { recursive: true });
  const generated: GeneratedFixtureResult["fixtures"] = [];
  for (const fixture of spec.fixtures) {
    const output = path.join(options.outputRoot, fixture.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const args = ["-hide_banner", "-loglevel", "error", "-y", ...fixture.ffmpeg_args.map((arg) => arg === "{output}" ? output : arg)];
    const run = spawnSync(ffmpeg, args, { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`${fixture.fixture_id} generation failed: ${run.stderr.trim()}`);
    const outputs = fixtureOutputs(options.outputRoot, fixture.output);
    generated.push({ fixture_id: fixture.fixture_id, media_kind: fixture.media_kind, outputs: outputs.map((file) => path.relative(options.outputRoot, file)), ...probeFixture(ffmpeg, ffprobe, outputs, fixture.media_kind) });
  }
  const manifest: GeneratedFixtureResult = { artifact_version: "editorial-eye-generated-media-manifest/v1", status: "generated", spec_sha256: specSha, fixtures: generated };
  fs.writeFileSync(path.join(options.outputRoot, "generated-media-manifest.json"), `${canonicalJson(manifest)}\n`);
  return manifest;
}

export function main(argv: string[] = process.argv): number {
  let outputRoot = path.resolve("tmp/editorial-eye-generated-media");
  let write = true;
  let ffmpeg = "ffmpeg";
  let ffprobe = "ffprobe";
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--output-root") outputRoot = path.resolve(next());
    else if (arg === "--ffmpeg") ffmpeg = next();
    else if (arg === "--ffprobe") ffprobe = next();
    else if (arg === "--no-write") write = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const result = generateEditorialEyeFixtures({ outputRoot, ffmpeg, ffprobe, write });
  console.log(canonicalJson(result));
  return "status" in result && result.status === "degraded" ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`generate-editorial-eye-fixtures failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
