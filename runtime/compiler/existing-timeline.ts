import * as fs from "node:fs";
import * as path from "node:path";

export interface ExistingTimelineRate {
  fpsNum: number;
  fpsDen: number;
}

/** Preserve the exact rational sequence rate during a recompile. */
export function inferExistingTimelineRate(projectDir: string): ExistingTimelineRate | undefined {
  const timelinePath = path.join(path.resolve(projectDir), "05_timeline/timeline.json");
  if (!fs.existsSync(timelinePath)) return undefined;
  try {
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as {
      sequence?: { fps_num?: unknown; fps_den?: unknown };
    };
    const fpsNum = Number(timeline.sequence?.fps_num);
    const fpsDen = Number(timeline.sequence?.fps_den);
    if (!Number.isInteger(fpsNum) || fpsNum <= 0 || !Number.isInteger(fpsDen) || fpsDen <= 0) {
      return undefined;
    }
    return { fpsNum, fpsDen };
  } catch {
    return undefined;
  }
}

/** Preserve an existing sequence rate during a recompile unless explicitly overridden. */
export function inferExistingTimelineFps(projectDir: string): number | undefined {
  const rate = inferExistingTimelineRate(projectDir);
  return rate ? rate.fpsNum / rate.fpsDen : undefined;
}
