import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessMusicAssetEligibility } from "../runtime/music/asset-eligibility.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(origin: string, usageClass?: string) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-bgm-eligibility-"));
  roots.push(projectDir);
  const audioDir = path.join(projectDir, "07_package", "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(audioDir, "bed.wav"), "stub");
  fs.writeFileSync(path.join(audioDir, "bed.provenance.json"), JSON.stringify({
    origin,
    ...(usageClass ? { usage_class: usageClass } : {}),
  }));
  return { projectDir, musicCues: { music_asset: { path: "07_package/audio/bed.wav" } } };
}

describe("BGM asset eligibility", () => {
  it("blocks an ad-hoc procedural full music bed", () => {
    const input = fixture("procedurally_generated_from_repository_script");
    const result = assessMusicAssetEligibility(input.projectDir, input.musicCues);
    expect(result).toMatchObject({ eligible: false, status: "blocked_procedural_bgm" });
    expect(result.message).toContain("reviewed BGM-library track");
  });

  it("allows the explicit simple-sound exception", () => {
    const input = fixture("procedurally_generated", "simple_sound");
    expect(assessMusicAssetEligibility(input.projectDir, input.musicCues)).toMatchObject({
      eligible: true,
      status: "simple_sound_exception",
    });
  });

  it("keeps existing non-procedural assets backward compatible", () => {
    const input = fixture("verified_bgm_pack");
    expect(assessMusicAssetEligibility(input.projectDir, input.musicCues)).toMatchObject({
      eligible: true,
      status: "verified_or_legacy",
    });
  });
});
