/**
 * Shared utilities for pipeline stages — atomic writes and JSON helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";

/**
 * Write JSON to a file atomically via temp file + rename.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Write YAML to a file atomically via temp file + rename.
 */
export function atomicWriteYaml(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, stringifyYaml(data));
  fs.renameSync(tmp, filePath);
}

export function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}
