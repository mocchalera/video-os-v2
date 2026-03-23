#!/usr/bin/env npx tsx
/**
 * Pre-flight check script for Video OS v2.
 *
 * Validates environment readiness before pipeline execution:
 * - API key presence (GEMINI_API_KEY, GROQ_API_KEY)
 * - ffmpeg / ffprobe availability and version
 * - Disk free space (>= 2x source folder size)
 * - Shell compatibility (zsh null_glob)
 * - Source folder readability and video file inventory
 *
 * Usage:
 *   npx tsx scripts/preflight.ts <素材フォルダパス> [--project <プロジェクトID>]
 *
 * Output: JSON to stdout
 *   {"ok": true/false, "checks": [{"name": "...", "status": "pass"|"warn"|"fail", "detail": "..."}]}
 *
 * Exit code 1 when ok=false.
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ── Types ─────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: CheckResult[];
}

// ── Video file extensions ─────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".mts",
  ".m2ts",
  ".ts",
  ".mxf",
  ".flv",
  ".wmv",
  ".mpg",
  ".mpeg",
  ".m4v",
  ".3gp",
]);

// ── Arg Parsing ───────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  sourceFolder: string;
  projectId: string | undefined;
} {
  const args = argv.slice(2);
  let sourceFolder = "";
  let projectId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") {
      projectId = args[++i] ?? undefined;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/preflight.ts <素材フォルダパス> [--project <プロジェクトID>]

Options:
  --project, -p   Project identifier (optional, logged in output)
  --help, -h      Show this help
`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      sourceFolder = arg;
    }
  }

  if (!sourceFolder) {
    console.error("Error: source folder path is required");
    process.exit(1);
  }

  return { sourceFolder, projectId };
}

// ── Individual checks ─────────────────────────────────────────────

export function checkApiKeys(): CheckResult[] {
  const results: CheckResult[] = [];

  const geminiKey = process.env.GEMINI_API_KEY;
  results.push({
    name: "GEMINI_API_KEY",
    status: geminiKey ? "pass" : "warn",
    detail: geminiKey
      ? "set"
      : "not set — VLM analysis will be skipped",
  });

  const groqKey = process.env.GROQ_API_KEY;
  results.push({
    name: "GROQ_API_KEY",
    status: groqKey ? "pass" : "warn",
    detail: groqKey
      ? "set"
      : "not set — Groq STT will be unavailable",
  });

  return results;
}

export function checkBinary(name: string): CheckResult {
  try {
    const raw = execSync(`${name} -version 2>&1`, {
      timeout: 5000,
      encoding: "utf-8",
    });
    const firstLine = raw.split("\n")[0] ?? "";
    const versionMatch = firstLine.match(/version\s+(\S+)/i);
    const version = versionMatch?.[1] ?? firstLine.trim().slice(0, 80);
    return {
      name,
      status: "pass",
      detail: `found — ${version}`,
    };
  } catch {
    return {
      name,
      status: "fail",
      detail: `not found in PATH — install ${name} (https://ffmpeg.org)`,
    };
  }
}

export function checkDiskSpace(sourceFolderPath: string): CheckResult {
  try {
    const folderSize = getDirSize(sourceFolderPath);
    const requiredBytes = folderSize * 2;

    // Use df to get available space on the volume containing the source folder
    const dfOut = execSync(`df -k "${sourceFolderPath}"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const lines = dfOut.trim().split("\n");
    const dataLine = lines[lines.length - 1];
    // df -k columns: Filesystem 1024-blocks Used Available Capacity ...
    const cols = dataLine?.split(/\s+/) ?? [];
    const availKb = parseInt(cols[3] ?? "0", 10);
    const availBytes = availKb * 1024;

    const folderMB = (folderSize / (1024 * 1024)).toFixed(1);
    const requiredMB = (requiredBytes / (1024 * 1024)).toFixed(1);
    const availMB = (availBytes / (1024 * 1024)).toFixed(1);

    if (availBytes >= requiredBytes) {
      return {
        name: "disk_space",
        status: "pass",
        detail: `${availMB} MB available (need ${requiredMB} MB = 2× source ${folderMB} MB)`,
      };
    } else {
      return {
        name: "disk_space",
        status: "fail",
        detail: `only ${availMB} MB available, need ${requiredMB} MB (2× source ${folderMB} MB)`,
      };
    }
  } catch (err) {
    return {
      name: "disk_space",
      status: "warn",
      detail: `could not determine disk space: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkShellCompat(): CheckResult {
  const shell = process.env.SHELL ?? "";
  if (!shell.includes("zsh")) {
    return {
      name: "shell_compat",
      status: "pass",
      detail: `shell is ${shell || "unknown"} (not zsh, no null_glob concern)`,
    };
  }

  // Check if null_glob is set in zsh
  try {
    const result = execSync('zsh -c "setopt" 2>/dev/null', {
      encoding: "utf-8",
      timeout: 5000,
    });
    const hasNullGlob = result.split("\n").some((l) => l.trim() === "nullglob");
    if (hasNullGlob) {
      return {
        name: "shell_compat",
        status: "pass",
        detail: "zsh with null_glob enabled — glob patterns will not error on no match",
      };
    } else {
      return {
        name: "shell_compat",
        status: "warn",
        detail:
          "zsh without null_glob — glob patterns like *.mp4 will fail if no match. " +
          'Run `setopt null_glob` or add to ~/.zshrc. ' +
          "Pipeline uses Node.js glob internally, but CLI invocations may be affected.",
      };
    }
  } catch {
    return {
      name: "shell_compat",
      status: "warn",
      detail: "could not detect zsh null_glob setting — ensure glob patterns are safe",
    };
  }
}

export function checkSourceFolder(folderPath: string): CheckResult {
  const resolved = path.resolve(folderPath);

  // Existence
  if (!fs.existsSync(resolved)) {
    return {
      name: "source_folder",
      status: "fail",
      detail: `folder not found: ${resolved}`,
    };
  }

  // Is directory
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return {
      name: "source_folder",
      status: "fail",
      detail: `not a directory: ${resolved}`,
    };
  }

  // Readability
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    return {
      name: "source_folder",
      status: "fail",
      detail: `no read permission: ${resolved}`,
    };
  }

  // Inventory
  const entries = fs.readdirSync(resolved);
  const videoFiles = entries.filter((e) => {
    const ext = path.extname(e).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });

  if (videoFiles.length === 0) {
    return {
      name: "source_folder",
      status: "fail",
      detail: `no video files found in ${resolved} (${entries.length} total files)`,
    };
  }

  const totalSize = videoFiles.reduce((sum, f) => {
    try {
      return sum + fs.statSync(path.join(resolved, f)).size;
    } catch {
      return sum;
    }
  }, 0);
  const totalMB = (totalSize / (1024 * 1024)).toFixed(1);

  return {
    name: "source_folder",
    status: "pass",
    detail: `${videoFiles.length} video file(s), ${totalMB} MB total in ${resolved}`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function getDirSize(dirPath: string): number {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    } else if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    }
  }
  return total;
}

// ── Run all checks ────────────────────────────────────────────────

export function runPreflight(sourceFolder: string): PreflightResult {
  const checks: CheckResult[] = [];

  // 1. API keys
  checks.push(...checkApiKeys());

  // 2. ffmpeg / ffprobe
  checks.push(checkBinary("ffmpeg"));
  checks.push(checkBinary("ffprobe"));

  // 3. Source folder
  checks.push(checkSourceFolder(sourceFolder));

  // 4. Disk space (only if source folder exists)
  const folderCheck = checks.find((c) => c.name === "source_folder");
  if (folderCheck?.status !== "fail") {
    checks.push(checkDiskSpace(path.resolve(sourceFolder)));
  }

  // 5. Shell compatibility
  checks.push(checkShellCompat());

  const ok = checks.every((c) => c.status !== "fail");
  return { ok, checks };
}

// ── CLI Main ──────────────────────────────────────────────────────

function main(): void {
  const { sourceFolder, projectId } = parseArgs(process.argv);

  if (projectId) {
    // Log to stderr so JSON output on stdout stays clean
    console.error(`[preflight] project: ${projectId}`);
  }
  console.error(`[preflight] source: ${path.resolve(sourceFolder)}`);

  const result = runPreflight(sourceFolder);

  // JSON output to stdout
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main();
}
