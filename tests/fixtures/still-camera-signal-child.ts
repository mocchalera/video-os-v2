/**
 * Hostile subprocess fixture (Issue 33 audit): starts a real still-camera
 * render, reports readiness once genuine task-owned temp AND a partial
 * output exist, then stays alive so the parent can send a real OS signal.
 *
 * Exit contract:
 * - killed by the parent's signal after cleanup  -> honest signal exit
 * - 42: render finished before the signal landed (test setup race)
 * - 43: readiness conditions never appeared
 * - 46: render failed outright
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { renderStillMotionSegment } from "../../runtime/render/still-motion-render.js";
import { resolveStillCameraMotion, resolveVerticalStillComposition } from "../../runtime/render/camera-motion.js";

const [inputPath, outputPath, framesArg] = process.argv.slice(2);
const frames = Number(framesArg);
if (!inputPath || !outputPath || !Number.isInteger(frames) || frames < 1) {
  console.error("CHILD_ARGS_INVALID");
  process.exit(44);
}

// The vertical blur-backdrop composite (auto-engaged for 9:16) keeps the
// ENCODE phase several seconds long even for a few hundred frames, so the
// parent's signal reliably lands mid-render with a partial MP4 on disk.
const motion = resolveStillCameraMotion({ preset: "push_in", easing: "smoothstep", intensity: 0.12 }, frames);
const composition = resolveVerticalStillComposition(1080, 1920);

// Attribution baseline MUST precede the render: anything vos-still-* that
// appears after this point and before READY was caused by this render.
const tempNames = (): string[] => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("vos-still-")).sort();
const beforeTemp = tempNames();

const renderPromise = renderStillMotionSegment({
  inputPath,
  outputPath,
  frameCount: frames,
  width: 1080,
  height: 1920,
  fpsRational: "30/1",
  motion,
  composition: composition ?? undefined,
  fitMode: "cover",
  background: "black",
}).then(
  () => "done" as const,
  (error: unknown) => {
    console.error(`RENDER_ERROR:${String(error)}`);
    process.exit(46);
  },
);

const deadline = Date.now() + 90_000;
let ready = false;
while (Date.now() < deadline) {
  const workerReady = fs.readdirSync(os.tmpdir()).some((name) => name.startsWith("vos-still-warp-"));
  const partialReady = fs.existsSync(outputPath);
  if (workerReady && partialReady) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!ready) {
  console.log("TIMEOUT");
  process.exit(43);
}
console.log("READY");
// Attribution evidence: the EXACT temp entries this render caused. The
// parent asserts these specific names vanish after the signal — a global
// tmpdir snapshot would be racy against concurrently running test workers.
for (const name of tempNames()) {
  if (!beforeTemp.includes(name)) console.log(`NEWTEMP:${name}`);
}

// The signal must land while the render is genuinely in flight; if the
// render wins the race the parent test setup is broken.
const winner = await Promise.race([
  renderPromise,
  new Promise((resolve) => setTimeout(() => resolve("pending" as const), 250)),
]);
if (winner === "done") {
  console.log("RENDER_FINISHED_EARLY");
  process.exit(42);
}

// Hold the process open for the parent's signal; the cleanup registry
// removes registered paths synchronously and re-raises.
setInterval(() => {}, 1_000);
