/**
 * Public /render signal fixture (Issue 33 follow-up): run the real public
 * command entry, wait until its assembler and still-camera worker roots are live,
 * then let the parent deliver SIGTERM to this exact child PID only.
 * The public command creates ProgressTracker before package/render setup, so
 * this proves that its signal path also drains the shared render registry.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRender } from "../../runtime/commands/render.js";

const [projectDir] = process.argv.slice(2);
if (!projectDir) {
  console.error("CHILD_ARGS_INVALID");
  process.exit(44);
}

const tempRoot = path.resolve(os.tmpdir());
const renderPromise = runRender(projectDir).then(
  (result) => {
    console.log(`RENDER_RESULT:${String(result.success)}`);
    process.exit(result.success ? 42 : 46);
  },
  (error: unknown) => {
    console.error(`RENDER_ERROR:${String(error)}`);
    process.exit(46);
  },
);

async function waitUntilRenderIsActive(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const names = fs.readdirSync(tempRoot);
    const assemblerReady = names.some((name) => name.startsWith("vos-assembler-"));
    const stillReady = names.some((name) => name.startsWith("vos-still-warp-"));
    if (assemblerReady && stillReady) {
      console.log("READY");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  console.log("TIMEOUT");
  process.exit(43);
}

// Keep the leader alive until the parent sends the scenario signal. The
// render promise remains in flight and owns the exact child/scratch group.
void waitUntilRenderIsActive().catch((error: unknown) => {
  console.error(`READY_ERROR:${String(error)}`);
  process.exit(43);
});
setInterval(() => {}, 1_000);
