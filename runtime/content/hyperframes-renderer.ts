import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeHyperFramesProject } from "./hyperframes-project.js";
import { loadContentRenderPlan } from "./render-plan.js";

export interface HyperFramesRenderResult {
  compositePath: string;
  overlayPath: string;
  receiptPath: string;
  elementCount: number;
}

export interface HyperFramesRenderOptions {
  timelinePath: string;
  baseAssemblyPath: string;
  outputDir: string;
  executablePath?: string;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export async function renderHyperFramesContentOverlay(
  options: HyperFramesRenderOptions,
): Promise<HyperFramesRenderResult | null> {
  const plan = loadContentRenderPlan(options.timelinePath);
  if (plan.issues.length > 0) {
    throw new Error(`Content render plan is invalid: ${plan.issues.map((issue) => `${issue.clip_id}: ${issue.message}`).join("; ")}`);
  }
  if (plan.hyperframes_elements.length === 0) return null;

  const executablePath = options.executablePath
    ?? path.resolve("node_modules/.bin/hyperframes");
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Pinned HyperFrames CLI is not installed: ${executablePath}`);
  }

  const videoDir = path.join(options.outputDir, "video");
  const logsDir = path.join(options.outputDir, "logs");
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const overlayPath = path.join(videoDir, "hyperframes-overlay.webm");
  const compositePath = path.join(videoDir, "assembly.with-content.mp4");
  const receiptPath = path.join(logsDir, "hyperframes-render-receipt.json");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-os-hyperframes-"));

  try {
    const written = writeHyperFramesProject(projectDir, {
      composition_id: "vos_content_overlay",
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration_frames: plan.duration_frames,
      elements: plan.hyperframes_elements,
    });
    const hfEnv = { HYPERFRAMES_NO_TELEMETRY: "1" };
    const lint = await run(executablePath, ["lint", projectDir, "--json"], hfEnv);
    await run(executablePath, [
      "render", projectDir,
      "--format", "webm",
      "--output", overlayPath,
      "--fps", String(plan.fps),
      "--quality", "standard",
      "--workers", "1",
      "--strict",
      "--no-browser-gpu",
      "--quiet",
    ], hfEnv);
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", options.baseAssemblyPath,
      "-c:v", "libvpx-vp9", "-i", overlayPath,
      "-filter_complex",
      "[0:v]format=rgba[base];[1:v]format=rgba[overlay];[base][overlay]overlay=eof_action=pass:shortest=0:format=rgb,format=yuv420p[v]",
      "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "16",
      "-c:a", "copy", "-movflags", "+faststart",
      compositePath,
    ]);

    const receipt = {
      version: "hyperframes-render-receipt/v1",
      renderer: "hyperframes",
      timeline_path: path.resolve(options.timelinePath),
      base_assembly_path: path.resolve(options.baseAssemblyPath),
      overlay_path: overlayPath,
      composite_path: compositePath,
      element_ids: plan.hyperframes_elements.map((entry) => entry.element.element_id),
      template_refs: plan.hyperframes_elements.map((entry) => entry.element.template_ref),
      font: {
        family: written.font.family,
        mode: written.font.mode,
        sha256: sha256(written.font.fontPath),
      },
      lint: JSON.parse(lint.stdout),
      overlay_sha256: sha256(overlayPath),
      composite_sha256: sha256(compositePath),
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return {
      compositePath,
      overlayPath,
      receiptPath,
      elementCount: plan.hyperframes_elements.length,
    };
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
