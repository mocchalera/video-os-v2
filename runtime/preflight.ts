import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import {
  discoverRequestedSources,
  type DiscoverySummary,
  type SourceDiscoveryResult,
} from "./media/source-discovery.js";

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: CheckResult[];
  discovery: SourceDiscoveryResult;
}

export interface PreflightCommandOptions {
  encoding: "utf-8";
  timeout: number;
}

export type PreflightCommandRunner = (
  command: string,
  args: string[],
  options: PreflightCommandOptions,
) => string;

export interface DiskSpaceCheckOptions {
  sourceBytes?: number;
  availableBytes?: number;
  peakMultiplier?: number;
  reserveBytes?: number;
  execFileSyncImpl?: PreflightCommandRunner;
}

const DEFAULT_PEAK_DISK_MULTIPLIER = 3;
const DEFAULT_DISK_RESERVE_BYTES = 512 * 1024 * 1024;

const defaultCommandRunner: PreflightCommandRunner = (command, args, options) =>
  execFileSync(command, args, options);

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

export function checkNodeRuntime(
  version = process.versions.node,
  requiredMajor = 22,
): CheckResult {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major === requiredMajor) {
    return {
      name: "node_runtime",
      status: "pass",
      detail: `Node.js ${version} matches required ${requiredMajor}.x`,
    };
  }
  return {
    name: "node_runtime",
    status: "fail",
    detail: `Node.js ${version || "unknown"} is unsupported; required ${requiredMajor}.x`,
  };
}

export function checkBinary(
  name: string,
  execFileSyncImpl: PreflightCommandRunner = defaultCommandRunner,
): CheckResult {
  try {
    const raw = execFileSyncImpl(name, ["-version"], {
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
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
    };
    if (error.code === "ENOENT") {
      return {
        name,
        status: "fail",
        detail: `not found in PATH — install ${name} (https://ffmpeg.org)`,
      };
    }
    const stderr = typeof error.stderr === "string"
      ? error.stderr
      : error.stderr?.toString("utf-8");
    const detail = (stderr || error.message || "unknown startup error")
      .trim()
      .split("\n")
      .slice(0, 3)
      .join(" ");
    return {
      name,
      status: "fail",
      detail: `found but failed to start — ${detail}`,
    };
  }
}

export function checkFfmpegCaptionFilters(
  execFileSyncImpl: PreflightCommandRunner = defaultCommandRunner,
): CheckResult {
  try {
    const raw = execFileSyncImpl("ffmpeg", ["-hide_banner", "-filters"], {
      timeout: 5000,
      encoding: "utf-8",
    });
    const hasSubtitles =
      /^[ \t]*[.A-Z| ]{3}[ \t]+subtitles[ \t]+/m.test(raw);
    const hasAss = /^[ \t]*[.A-Z| ]{3}[ \t]+ass[ \t]+/m.test(raw);
    if (hasSubtitles && hasAss) {
      return {
        name: "ffmpeg_caption_filters",
        status: "pass",
        detail: "ffmpeg subtitles and ass filters are available",
      };
    }
    const missing = [
      ...(hasSubtitles ? [] : ["subtitles"]),
      ...(hasAss ? [] : ["ass"]),
    ];
    return {
      name: "ffmpeg_caption_filters",
      status: "fail",
      detail: `ffmpeg is missing required caption filter(s): ${missing.join(", ")}`,
    };
  } catch (err) {
    const error = err as Error & { stderr?: string | Buffer };
    const stderr = typeof error.stderr === "string"
      ? error.stderr
      : error.stderr?.toString("utf-8");
    return {
      name: "ffmpeg_caption_filters",
      status: "fail",
      detail: `could not inspect ffmpeg caption filters — ${(stderr || error.message).trim()}`,
    };
  }
}

export function checkDiskSpace(
  sourceFolderPath: string,
  options: DiskSpaceCheckOptions = {},
): CheckResult {
  try {
    const folderSize = options.sourceBytes ?? getDirSize(sourceFolderPath);
    const multiplier = options.peakMultiplier ?? DEFAULT_PEAK_DISK_MULTIPLIER;
    const reserveBytes = options.reserveBytes ?? DEFAULT_DISK_RESERVE_BYTES;
    const requiredBytes = Math.ceil(folderSize * multiplier + reserveBytes);
    let availBytes = options.availableBytes;
    if (availBytes === undefined) {
      const runner = options.execFileSyncImpl ?? defaultCommandRunner;
      const dfOut = runner("df", ["-k", sourceFolderPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const lines = dfOut.trim().split("\n");
      const dataLine = lines[lines.length - 1];
      const cols = dataLine?.split(/\s+/) ?? [];
      const availKb = parseInt(cols[3] ?? "0", 10);
      availBytes = availKb * 1024;
    }

    const folderMB = (folderSize / (1024 * 1024)).toFixed(1);
    const requiredMB = (requiredBytes / (1024 * 1024)).toFixed(1);
    const availMB = (availBytes / (1024 * 1024)).toFixed(1);

    if (availBytes >= requiredBytes) {
      return {
        name: "disk_space",
        status: "pass",
        detail: `${availMB} MB available (need ${requiredMB} MB = ${multiplier}× source ${folderMB} MB + ${(reserveBytes / (1024 * 1024)).toFixed(0)} MB reserve)`,
      };
    }

    return {
      name: "disk_space",
      status: "fail",
      detail: `only ${availMB} MB available, need ${requiredMB} MB (${multiplier}× source ${folderMB} MB + ${(reserveBytes / (1024 * 1024)).toFixed(0)} MB reserve)`,
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

  return checkSourceDiscovery(discoverRequestedSources([resolved]), "source_folder");
}

export function checkSourceInputs(
  locators: string[],
  checkName = "source_inputs",
  precomputedDiscovery?: SourceDiscoveryResult,
): { check: CheckResult; discovery: SourceDiscoveryResult } {
  const discovery = precomputedDiscovery ?? discoverRequestedSources(locators);
  return { check: checkSourceDiscovery(discovery, checkName), discovery };
}

function checkSourceDiscovery(discovery: SourceDiscoveryResult, name: string): CheckResult {
  const eligible = discovery.requests.filter((request) => request.disposition === "candidate");
  const totalSize = eligible.reduce((sum, request) => sum + (request.size_bytes ?? 0), 0);
  const counts = formatDiscoveryCounts(discovery.summary);
  if (eligible.length === 0) {
    return {
      name,
      status: "fail",
      detail: `no media files are ingest-eligible; ${counts}`,
    };
  }
  return {
    name,
    status: "pass",
    detail: `${eligible.length} media file(s) ingest-eligible, ${(totalSize / (1024 * 1024)).toFixed(1)} MB; ${counts}`,
  };
}

function formatDiscoveryCounts(summary: DiscoverySummary): string {
  const kinds = Object.entries(summary.by_media_kind).map(([kind, count]) => `${kind}=${count}`).join(", ");
  return `requested=${summary.requested}, candidate=${summary.candidate}, unsupported=${summary.unsupported}, failed=${summary.failed}; ${kinds}`;
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

export function runPreflight(
  sourceInput: string | string[],
  precomputedDiscovery?: SourceDiscoveryResult,
): PreflightResult {
  const checks: CheckResult[] = [];
  checks.push(...checkApiKeys());
  checks.push(checkNodeRuntime());
  const ffmpegCheck = checkBinary("ffmpeg");
  checks.push(ffmpegCheck);
  checks.push(checkBinary("ffprobe"));
  if (ffmpegCheck.status === "pass") {
    checks.push(checkFfmpegCaptionFilters());
  } else {
    checks.push({
      name: "ffmpeg_caption_filters",
      status: "fail",
      detail: "not checked because ffmpeg is unavailable",
    });
  }
  const sourceLocators = Array.isArray(sourceInput) ? sourceInput : [sourceInput];
  const sourceResult = checkSourceInputs(
    sourceLocators,
    Array.isArray(sourceInput) ? "source_inputs" : "source_folder",
    precomputedDiscovery,
  );
  checks.push(sourceResult.check);

  const folderCheck = sourceResult.check;
  if (folderCheck?.status !== "fail") {
    const diskTarget = resolveDiskTarget(sourceLocators);
    if (diskTarget) {
      const sourceBytes = sourceResult.discovery.requests
        .filter((request) => request.disposition === "candidate")
        .reduce((sum, request) => sum + (request.size_bytes ?? 0), 0);
      checks.push(checkDiskSpace(diskTarget, { sourceBytes }));
    }
  }

  checks.push(checkShellCompat());

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    discovery: sourceResult.discovery,
  };
}

function resolveDiskTarget(locators: string[]): string | undefined {
  for (const locator of locators) {
    const resolved = path.resolve(locator);
    if (!fs.existsSync(resolved)) continue;
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  }
  return undefined;
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
