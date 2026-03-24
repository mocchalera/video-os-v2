import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: CheckResult[];
}

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

export function parsePreflightArgs(argv: string[]): {
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
      throw new Error("help");
    } else if (!arg.startsWith("-")) {
      sourceFolder = arg;
    }
  }

  if (!sourceFolder) {
    throw new Error("Error: source folder path is required");
  }

  return { sourceFolder, projectId };
}

export function getPreflightUsage(): string {
  return `Usage: npx tsx scripts/preflight.ts <素材フォルダパス> [--project <プロジェクトID>]

Options:
  --project, -p   Project identifier (optional, logged in output)
  --help, -h      Show this help
`;
}

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
    const dfOut = execSync(`df -k "${sourceFolderPath}"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const lines = dfOut.trim().split("\n");
    const dataLine = lines[lines.length - 1];
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
    }

    return {
      name: "disk_space",
      status: "fail",
      detail: `only ${availMB} MB available, need ${requiredMB} MB (2× source ${folderMB} MB)`,
    };
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

  try {
    const result = execSync('zsh -c "setopt" 2>/dev/null', {
      encoding: "utf-8",
      timeout: 5000,
    });
    const hasNullGlob = result.split("\n").some((line) => line.trim() === "nullglob");
    if (hasNullGlob) {
      return {
        name: "shell_compat",
        status: "pass",
        detail: "zsh with null_glob enabled — glob patterns will not error on no match",
      };
    }

    return {
      name: "shell_compat",
      status: "warn",
      detail:
        "zsh without null_glob — glob patterns like *.mp4 will fail if no match. " +
        "Run `setopt null_glob` or add to ~/.zshrc. " +
        "Pipeline uses Node.js glob internally, but CLI invocations may be affected.",
    };
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

  if (!fs.existsSync(resolved)) {
    return {
      name: "source_folder",
      status: "fail",
      detail: `folder not found: ${resolved}`,
    };
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return {
      name: "source_folder",
      status: "fail",
      detail: `not a directory: ${resolved}`,
    };
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    return {
      name: "source_folder",
      status: "fail",
      detail: `no read permission: ${resolved}`,
    };
  }

  const entries = fs.readdirSync(resolved);
  const videoFiles = entries.filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry).toLowerCase()));

  if (videoFiles.length === 0) {
    return {
      name: "source_folder",
      status: "fail",
      detail: `no video files found in ${resolved} (${entries.length} total files)`,
    };
  }

  const totalSize = videoFiles.reduce((sum, file) => {
    try {
      return sum + fs.statSync(path.join(resolved, file)).size;
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

export function runPreflight(sourceFolder: string): PreflightResult {
  const checks: CheckResult[] = [];
  checks.push(...checkApiKeys());
  checks.push(checkBinary("ffmpeg"));
  checks.push(checkBinary("ffprobe"));
  checks.push(checkSourceFolder(sourceFolder));

  const folderCheck = checks.find((check) => check.name === "source_folder");
  if (folderCheck?.status !== "fail") {
    checks.push(checkDiskSpace(path.resolve(sourceFolder)));
  }

  checks.push(checkShellCompat());

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function runPreflightCli(argv: string[] = process.argv): void {
  let parsed: ReturnType<typeof parsePreflightArgs>;
  try {
    parsed = parsePreflightArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "help") {
      console.log(getPreflightUsage());
      process.exit(0);
    }
    console.error(message);
    process.exit(1);
  }

  if (parsed.projectId) {
    console.error(`[preflight] project: ${parsed.projectId}`);
  }
  console.error(`[preflight] source: ${path.resolve(parsed.sourceFolder)}`);

  const result = runPreflight(parsed.sourceFolder);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}
