import { describe, expect, it } from "vitest";
import {
  assertSafeAudioDelayFilterOrder,
  findDestructivePostDelayTrims,
} from "../runtime/render/audio-filter-safety.js";

describe("audio delay filter safety", () => {
  it("rejects the adelay then atrim(start=0) pattern that erases a J-cut lead-in", () => {
    const graph = "[1:a]adelay=3330|3330,atrim=start=0:end=34[a0]";

    expect(findDestructivePostDelayTrims(graph)).toEqual([graph]);
    expect(() => assertSafeAudioDelayFilterOrder(graph)).toThrow(
      /removes the inserted lead-in/,
    );
  });

  it("allows source trim before delay and duration trim after the mixed output", () => {
    const graph = [
      "[1:a]atrim=start=664.695:duration=30,asetpts=PTS-STARTPTS,adelay=3330|3330[a0]",
      "[silent][a0]amix=inputs=2:duration=longest,atrim=start=0:duration=34[aout]",
    ].join(";");

    expect(findDestructivePostDelayTrims(graph)).toEqual([]);
    expect(() => assertSafeAudioDelayFilterOrder(graph)).not.toThrow();
  });
});
