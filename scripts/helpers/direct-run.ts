import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (entrypoint === undefined) return false;
  try {
    return fs.realpathSync(entrypoint) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
