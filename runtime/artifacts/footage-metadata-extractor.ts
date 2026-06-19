import { execFile } from "node:child_process";
import * as path from "node:path";

export interface CameraMotionExtraction {
  camera_motion: string;
  motion_direction: string | null;
  motion_speed: string | null;
  stability: string;
}

export interface SceneShotTakeExtraction {
  scene_number: number | null;
  shot_number: number | null;
  take_number: number | null;
}

export interface AudioLevelExtraction {
  peak_db: number | null;
  rms_db: number | null;
  loudness_lufs: number | null;
}

export function extractCameraMotion(description: string): CameraMotionExtraction {
  const text = normalized(description);
  const stability = extractStability(text);
  const motionSpeed = extractMotionSpeed(text);

  if (/\b(drone|aerial|overhead)\b/.test(text)) {
    return { camera_motion: "drone", motion_direction: null, motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(crane|jib)\b/.test(text)) {
    const direction = /\b(up|rises?|ascending|lifts?)\b/.test(text)
      ? "up"
      : /\b(down|descends?|descending|drops?)\b/.test(text)
        ? "down"
        : null;
    return { camera_motion: "crane", motion_direction: direction, motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(?:camera\s+)?pan(?:s|ning|ned)?(?:\s+\w+){0,4}\s+(?:to\s+the\s+)?right\b|\bright(?:ward)?\s+pan\b/.test(text)) {
    return { camera_motion: "pan_right", motion_direction: "right", motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(?:camera\s+)?pan(?:s|ning|ned)?(?:\s+\w+){0,4}\s+(?:to\s+the\s+)?left\b|\bleft(?:ward)?\s+pan\b/.test(text)) {
    return { camera_motion: "pan_left", motion_direction: "left", motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(?:camera\s+)?tilt(?:s|ing|ed)?(?:\s+\w+){0,4}\s+up\b|\btilt\s+up\b/.test(text)) {
    return { camera_motion: "tilt_up", motion_direction: "up", motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(?:camera\s+)?tilt(?:s|ing|ed)?(?:\s+\w+){0,4}\s+down\b|\btilt\s+down\b/.test(text)) {
    return { camera_motion: "tilt_down", motion_direction: "down", motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(dolly\s+in|push(?:es|ing)?\s+in|moves?\s+forward|camera\s+advances?|moves?\s+toward|tracks?\s+in)\b/.test(text)) {
    return { camera_motion: "dolly_in", motion_direction: "forward", motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(dolly\s+out|pull(?:s|ing)?\s+back|moves?\s+back(?:ward)?|moves?\s+away|tracks?\s+out)\b/.test(text)) {
    return { camera_motion: "dolly_out", motion_direction: "backward", motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(tracking\s+shot|camera\s+tracks?|follows?|following)\b/.test(text)) {
    return { camera_motion: "tracking", motion_direction: null, motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\bhandheld\b/.test(text)) {
    return { camera_motion: "handheld", motion_direction: null, motion_speed: motionSpeed ?? "medium", stability };
  }
  if (/\b(static\s+shot|stationary|remains?\s+stationary|fixed|locked\s*off|tripod)\b/.test(text)) {
    return { camera_motion: "static", motion_direction: null, motion_speed: null, stability };
  }

  return { camera_motion: "static", motion_direction: null, motion_speed: null, stability };
}

export function extractShotScale(description: string): string {
  const text = normalized(description);
  if (/\b(extreme\s+wide|very\s+wide)\b/.test(text)) return "extreme_wide";
  if (/\b(wide\s+shot|wide\s+angle|panoramic|establishing|long\s+shot)\b/.test(text)) return "wide";
  if (/\b(full\s+shot|head\s+to\s+toe|full\s+body)\b/.test(text)) return "full";
  if (/\b(medium\s+close(?:-|\s*)up|medium\s+close)\b/.test(text)) return "medium_closeup";
  if (/\b(extreme\s+close(?:-|\s*)up|very\s+close)\b/.test(text)) return "extreme_closeup";
  if (/\b(detail\s+of|detail\s+shot|macro|person'?s\s+hand|hands?\b|fingers?\b|object\s+detail)\b/.test(text)) return "detail";
  if (/\b(close(?:-|\s*)up|close\s+shot)\b/.test(text)) return "closeup";
  if (/\b(medium\s+shot|waist\s+up|waist-up)\b/.test(text)) return "medium";
  return "medium";
}

export function extractSceneShotTake(filename: string, shootingTimestamp?: string): SceneShotTakeExtraction {
  const stem = path.basename(filename, path.extname(filename));

  const explicitSst = stem.match(/(?:^|[_\-\s])S(?<scene>\d{1,4})(?:[_\-\s]+S(?<shot>\d{1,4}))?(?:[_\-\s]+T(?<take>\d{1,4}))?(?:$|[_\-\s])/i);
  if (explicitSst?.groups) {
    return {
      scene_number: parsePositiveInt(explicitSst.groups.scene),
      shot_number: parsePositiveInt(explicitSst.groups.shot),
      take_number: parsePositiveInt(explicitSst.groups.take),
    };
  }

  const explicitWords = stem.match(/scene[_\-\s]*(?<scene>\d{1,4}).*shot[_\-\s]*(?<shot>\d{1,4}).*take[_\-\s]*(?<take>\d{1,4})/i);
  if (explicitWords?.groups) {
    return {
      scene_number: parsePositiveInt(explicitWords.groups.scene),
      shot_number: parsePositiveInt(explicitWords.groups.shot),
      take_number: parsePositiveInt(explicitWords.groups.take),
    };
  }

  const takeNumber = parseBlackmagicTake(stem);
  const timestamp = parseTimestampParts(stem) ?? parseTimestampParts(shootingTimestamp ?? "");
  if (timestamp || takeNumber != null) {
    return {
      scene_number: timestamp ? parsePositiveInt(timestamp.date) : null,
      shot_number: timestamp ? parsePositiveInt(timestamp.time) : null,
      take_number: takeNumber,
    };
  }

  return { scene_number: null, shot_number: null, take_number: null };
}

export async function extractAudioLevels(sourcePath: string): Promise<AudioLevelExtraction | null> {
  try {
    const stderr = await runFfmpegVolumedetect(sourcePath);
    return {
      peak_db: parseDb(stderr, /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i),
      rms_db: parseDb(stderr, /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i),
      loudness_lufs: parseDb(stderr, /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i),
    };
  } catch {
    return null;
  }
}

function extractStability(text: string): string {
  if (/\b(shaky|unstable|unsteady|shake|shaking|jittery)\b/.test(text)) return "shaky";
  if (/\bhandheld|slight\s+movement|subtle\s+movement|gentle\s+movement|minor\s+movement\b/.test(text)) return "slight_movement";
  return "stable";
}

function extractMotionSpeed(text: string): string | null {
  if (/\b(whip|fast|quick|rapid|swift)\b/.test(text)) return "fast";
  if (/\b(slow|slowly|gentle|gradual|subtle)\b/.test(text)) return "slow";
  if (/\b(steady|smooth)\b/.test(text)) return "medium";
  return null;
}

function parseBlackmagicTake(stem: string): number | null {
  const match = stem.match(/(?:^|[_\-\s])C(?<take>\d{3,5})(?:$|[_\-\s])/i);
  return parsePositiveInt(match?.groups?.take);
}

function parseTimestampParts(value: string): { date: string; time: string } | null {
  const compact = value.match(/(?<date>20\d{6})[_\-\s]?(?<time>\d{6})/);
  if (compact?.groups) return { date: compact.groups.date, time: compact.groups.time };

  const iso = value.match(/(?<year>20\d{2})[-\/](?<month>\d{2})[-\/](?<day>\d{2})[T_\-\s](?<hour>\d{2}):?(?<minute>\d{2}):?(?<second>\d{2})/);
  if (!iso?.groups) return null;
  return {
    date: `${iso.groups.year}${iso.groups.month}${iso.groups.day}`,
    time: `${iso.groups.hour}${iso.groups.minute}${iso.groups.second}`,
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseDb(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function runFfmpegVolumedetect(sourcePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", sourcePath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
      { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) reject(error);
        else resolve(stderr);
      },
    );
  });
}
