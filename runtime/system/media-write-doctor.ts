import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface MediaWriteReservation {
  label: string;
  path: string;
  requiredBytes: number;
}

export interface MediaWriteDoctorInput {
  reservations: MediaWriteReservation[];
  requireFfmpeg?: boolean;
  requireFfprobe?: boolean;
  requireCaptionFilters?: boolean;
  requiredNodeMajor?: number;
}

export interface MediaWriteDoctorCheck {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface MediaWriteDoctorResult {
  ok: boolean;
  checks: MediaWriteDoctorCheck[];
}

export interface MediaWriteDoctorDependencies {
  nodeVersion?: string;
  runCommand?: (
    command: string,
    args: string[],
  ) => { stdout: string; stderr?: string };
  findExistingParent?: (targetPath: string) => string;
  deviceId?: (existingPath: string) => string;
  availableBytes?: (existingPath: string) => number;
}

export class MediaWriteReadinessError extends Error {
  readonly result: MediaWriteDoctorResult;

  constructor(result: MediaWriteDoctorResult) {
    const failures = result.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
    super(`Media write readiness failed: ${failures}`);
    this.name = "MediaWriteReadinessError";
    this.result = result;
  }
}

const defaultRunCommand: NonNullable<MediaWriteDoctorDependencies["runCommand"]> =
  (command, args) => ({
    stdout: execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  });

export function checkCapacityReservations(
  reservations: MediaWriteReservation[],
  dependencies: MediaWriteDoctorDependencies = {},
): MediaWriteDoctorCheck[] {
  const findParent = dependencies.findExistingParent ?? nearestExistingParent;
  const getDeviceId = dependencies.deviceId ??
    ((existingPath) => fs.statSync(existingPath, { bigint: true }).dev.toString());
  const getAvailable = dependencies.availableBytes ??
    ((existingPath) => {
      const stat = fs.statfsSync(existingPath, { bigint: true });
      return Number(stat.bavail * stat.bsize);
    });
  const devices = new Map<string, {
    existingPath: string;
    requiredBytes: number;
    labels: string[];
  }>();

  for (const reservation of reservations) {
    if (
      !Number.isFinite(reservation.requiredBytes) ||
      reservation.requiredBytes < 0
    ) {
      return [{
        name: "media_write_capacity",
        status: "fail",
        detail: `${reservation.label} has invalid requiredBytes=${reservation.requiredBytes}`,
      }];
    }
    const existingPath = findParent(path.resolve(reservation.path));
    const device = getDeviceId(existingPath);
    const current = devices.get(device) ?? {
      existingPath,
      requiredBytes: 0,
      labels: [],
    };
    current.requiredBytes += Math.ceil(reservation.requiredBytes);
    current.labels.push(reservation.label);
    devices.set(device, current);
  }

  return [...devices.entries()].map(([device, reservation]) => {
    const available = getAvailable(reservation.existingPath);
    const passed = Number.isFinite(available) &&
      available >= reservation.requiredBytes;
    return {
      name: `media_write_capacity:${device}`,
      status: passed ? "pass" : "fail",
      detail:
        `${formatMiB(available)} MiB available; ` +
        `${formatMiB(reservation.requiredBytes)} MiB reserved for ` +
        reservation.labels.join(", "),
    };
  });
}

export function inspectMediaWriteReadiness(
  input: MediaWriteDoctorInput,
  dependencies: MediaWriteDoctorDependencies = {},
): MediaWriteDoctorResult {
  const checks: MediaWriteDoctorCheck[] = [];
  const requiredNodeMajor = input.requiredNodeMajor ?? 22;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  checks.push({
    name: "node_runtime",
    status: nodeMajor === requiredNodeMajor ? "pass" : "fail",
    detail: nodeMajor === requiredNodeMajor
      ? `Node.js ${nodeVersion} matches required ${requiredNodeMajor}.x`
      : `Node.js ${nodeVersion || "unknown"} is unsupported; required ${requiredNodeMajor}.x`,
  });

  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  if (input.requireFfmpeg !== false) {
    checks.push(checkExecutable("ffmpeg", runCommand));
  }
  if (input.requireFfprobe !== false) {
    checks.push(checkExecutable("ffprobe", runCommand));
  }
  if (input.requireCaptionFilters) {
    checks.push(checkCaptionFilters(runCommand));
  }
  checks.push(...checkCapacityReservations(input.reservations, dependencies));
  return {
    ok: checks.every((check) => check.status === "pass"),
    checks,
  };
}

export function assertMediaWriteReady(
  input: MediaWriteDoctorInput,
  dependencies: MediaWriteDoctorDependencies = {},
): MediaWriteDoctorResult {
  const result = inspectMediaWriteReadiness(input, dependencies);
  if (!result.ok) throw new MediaWriteReadinessError(result);
  return result;
}

function checkExecutable(
  command: "ffmpeg" | "ffprobe",
  runCommand: NonNullable<MediaWriteDoctorDependencies["runCommand"]>,
): MediaWriteDoctorCheck {
  try {
    const result = runCommand(command, ["-version"]);
    const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return {
      name: command,
      status: "pass",
      detail: firstLine || `${command} started successfully`,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
    };
    const stderr = typeof err.stderr === "string"
      ? err.stderr
      : err.stderr?.toString("utf-8");
    return {
      name: command,
      status: "fail",
      detail: err.code === "ENOENT"
        ? "not found in PATH"
        : `found but failed to start: ${(stderr || err.message).trim()}`,
    };
  }
}

function checkCaptionFilters(
  runCommand: NonNullable<MediaWriteDoctorDependencies["runCommand"]>,
): MediaWriteDoctorCheck {
  try {
    const result = runCommand("ffmpeg", ["-hide_banner", "-filters"]);
    const output = `${result.stdout}\n${result.stderr ?? ""}`;
    const hasSubtitles =
      /^[ \t]*[.A-Z| ]{3}[ \t]+subtitles[ \t]+/m.test(output);
    const hasAss = /^[ \t]*[.A-Z| ]{3}[ \t]+ass[ \t]+/m.test(output);
    const missing = [
      ...(hasSubtitles ? [] : ["subtitles"]),
      ...(hasAss ? [] : ["ass"]),
    ];
    return {
      name: "ffmpeg_caption_filters",
      status: missing.length === 0 ? "pass" : "fail",
      detail: missing.length === 0
        ? "ffmpeg subtitles and ass filters are available"
        : `missing required filter(s): ${missing.join(", ")}`,
    };
  } catch (error) {
    return {
      name: "ffmpeg_caption_filters",
      status: "fail",
      detail: `could not inspect filters: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function nearestExistingParent(targetPath: string): string {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent found for ${targetPath}`);
    }
    current = parent;
  }
  return current;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
