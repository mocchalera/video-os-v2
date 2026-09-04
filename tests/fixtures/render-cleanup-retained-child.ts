/**
 * Registry retained-entry signal fixture (Issue 33 follow-up): keep one
 * registered task-owned directory deliberately non-removable so the signal
 * handler must report the failure once, remove its own listener, and preserve
 * native signal termination without recursively handling the same signal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerRenderCleanupPath } from "../../runtime/render/render-cleanup-registry.js";

const retainedDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-still-base-retained-child-"));
fs.writeFileSync(path.join(retainedDir, "occupied.bin"), "retained");
fs.chmodSync(retainedDir, 0o500);
registerRenderCleanupPath(retainedDir, "dir");
console.log(`DIR:${retainedDir}`);

setInterval(() => {}, 1_000);
