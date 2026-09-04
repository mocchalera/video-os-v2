/**
 * Coexistence fixture (Issue 33 audit): registers a task-owned temp dir and
 * installs an UNRELATED SIGINT listener, then waits. When the parent sends a
 * real SIGINT, the registry must clean up its registered path, uninstall
 * ONLY its own listeners, and let the unrelated listener own termination —
 * the child must stay alive, and the unrelated listener must run exactly
 * once (no double delivery from a re-raise).
 *
 * stdout protocol: "DIR:<path>", then "UNRELATED" per listener invocation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  registerRenderCleanupPath,
  registeredRenderCleanupCount,
} from "../../runtime/render/render-cleanup-registry.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-base-"));
registerRenderCleanupPath(dir, "dir");
if (registeredRenderCleanupCount() !== 1) {
  console.error("CHILD_REGISTER_FAILED");
  process.exit(45);
}
console.log(`DIR:${dir}`);

// Hostile mode: refuse SIGTERM so the owning test's terminate() must
// escalate to SIGKILL for the exact process group.
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {
    console.log("TERM_IGNORED");
  });
}

// Hostile mode: spawn a task-owned DESCENDANT inside this child's process
// group that IGNORES SIGTERM. The owning test's terminate() must sweep the
// exact group (negative PGID) to kill both — leader exit alone is not
// group cleanup.
if (process.argv.includes("--spawn-descendant")) {
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    `vos-still-descendant-token-${process.pid}`,
  ], { stdio: "ignore" });
  console.log(`DESCENDANT:${descendant.pid}`);
  descendant.on("error", (error) => console.error(`DESCENDANT_SPAWN_ERROR:${String(error)}`));
}

// Hostile mode: a descendant that IGNORES SIGTERM and self-exits after ~3s —
// used to document the natural macOS post-leader-reap group-signal EPERM
// without leaving any orphan behind.
if (process.argv.includes("--spawn-descendant-self-exit")) {
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
      + " setTimeout(() => process.exit(0), 3000);",
    `vos-still-descendant-token-${process.pid}`,
  ], { stdio: "ignore" });
  console.log(`DESCENDANT:${descendant.pid}`);
  descendant.on("error", (error) => console.error(`DESCENDANT_SPAWN_ERROR:${String(error)}`));
}

let unrelatedCalls = 0;
process.on("SIGINT", () => {
  unrelatedCalls += 1;
  console.log("UNRELATED");
  if (unrelatedCalls > 1) {
    // A re-raise would double-deliver to this listener — a contract break.
    console.log("DOUBLE_DELIVERED");
    process.exit(47);
  }
});

setInterval(() => {}, 1_000);
