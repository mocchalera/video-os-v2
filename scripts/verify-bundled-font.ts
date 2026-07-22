import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_VIDEO_FONT } from "../editor/shared/font-contract.js";
import {
  buildAssDocument,
  resolveCaptionStylePreset,
} from "../editor/shared/caption-style-tokens.js";
import { verifyBundledFont } from "../runtime/fonts/bundled-font.js";

function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stderr}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

const keep = process.env.KEEP_FONT_VERIFY === "1";
const workDir = mkdtempSync(path.join(tmpdir(), "video-os-font-verify-"));

try {
  const bundled = verifyBundledFont();
  const scan = run("fc-scan", [
    "--format",
    "%{family}|%{style}|%{postscriptname}\\n",
    bundled.fontPath,
  ]);
  if (!scan.stdout.includes(DEFAULT_VIDEO_FONT.family)) {
    throw new Error(`fc-scan did not expose ${DEFAULT_VIDEO_FONT.family}`);
  }

  const assPath = path.join(workDir, "captions.ass");
  const outputPath = path.join(workDir, "caption-sample.png");
  writeFileSync(assPath, buildAssDocument(
    [{ startSec: 0, endSec: 1, text: "経営者本人がAIを使う意味" }],
    resolveCaptionStylePreset("clean-lower-third"),
    { width: 1280, height: 720, fps: 30 },
  ), "utf8");

  const ffmpeg = run("ffmpeg", [
    "-hide_banner",
    "-loglevel", "verbose",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x24405f:s=1280x720:r=30:d=1",
    "-vf",
    `subtitles=filename='${escapeFilterValue(assPath)}':fontsdir='${escapeFilterValue(bundled.fontsDir)}'`,
    "-frames:v", "1",
    outputPath,
  ]);
  const fontSelected = ffmpeg.stderr.includes("NotoSansJP") || ffmpeg.stderr.includes("Noto Sans JP");
  if (!fontSelected || !existsSync(outputPath)) {
    throw new Error("FFmpeg/libass did not select the bundled Noto Sans JP font");
  }

  const outputHash = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
  process.stdout.write(`${JSON.stringify({
    version: "bundled-font-verification/v1",
    font_id: DEFAULT_VIDEO_FONT.id,
    family: DEFAULT_VIDEO_FONT.family,
    font_sha256: DEFAULT_VIDEO_FONT.sha256,
    license: path.basename(bundled.licensePath),
    fc_scan_match: true,
    ffmpeg_libass_match: true,
    sample_sha256: outputHash,
    sample: outputPath,
    kept: keep,
  }, null, 2)}\n`);
} finally {
  if (!keep) rmSync(workDir, { recursive: true, force: true });
}
