import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inferExistingTimelineFps, inferExistingTimelineRate } from "../runtime/compiler/existing-timeline.js";

describe("existing timeline FPS preservation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves a 30 fps canonical sequence during recompile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fps-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "05_timeline"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "05_timeline/timeline.json"),
      JSON.stringify({ sequence: { fps_num: 30, fps_den: 1 } }),
    );
    expect(inferExistingTimelineFps(dir)).toBe(30);
    expect(inferExistingTimelineRate(dir)).toEqual({ fpsNum: 30, fpsDen: 1 });
  });

  it("preserves a 30000/1001 rational rate without decimalizing its numerator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fps-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "05_timeline"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "05_timeline/timeline.json"),
      JSON.stringify({ sequence: { fps_num: 30000, fps_den: 1001 } }),
    );
    expect(inferExistingTimelineRate(dir)).toEqual({ fpsNum: 30000, fpsDen: 1001 });
    expect(inferExistingTimelineFps(dir)).toBeCloseTo(29.97002997);
  });

  it("leaves new or malformed projects on compiler defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fps-"));
    dirs.push(dir);
    expect(inferExistingTimelineFps(dir)).toBeUndefined();
  });
});
