import * as fs from "node:fs";
import * as path from "node:path";

export interface MusicAssetEligibility {
  eligible: boolean;
  status: "verified_or_legacy" | "simple_sound_exception" | "blocked_procedural_bgm";
  provenancePath?: string;
  message?: string;
}

interface MusicCuesLike {
  music_asset?: { path?: unknown };
}

function readRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function provenanceCandidates(audioPath: string): string[] {
  const extension = path.extname(audioPath);
  const stem = extension ? audioPath.slice(0, -extension.length) : audioPath;
  return [...new Set([`${stem}.provenance.json`, `${audioPath}.provenance.json`])];
}

/**
 * Reject ad-hoc procedurally generated audio when it is used as a full BGM bed.
 * Existing licensed/recorded assets remain backward compatible. Procedural
 * audio is allowed only when its provenance explicitly marks a simple sound.
 */
export function assessMusicAssetEligibility(
  projectDir: string,
  musicCues: MusicCuesLike | null | undefined,
): MusicAssetEligibility {
  const assetRef = musicCues?.music_asset?.path;
  if (typeof assetRef !== "string" || assetRef.trim().length === 0) {
    return { eligible: true, status: "verified_or_legacy" };
  }

  const audioPath = path.isAbsolute(assetRef)
    ? assetRef
    : path.resolve(projectDir, assetRef);
  const provenancePath = provenanceCandidates(audioPath).find((candidate) => fs.existsSync(candidate));
  if (!provenancePath) return { eligible: true, status: "verified_or_legacy" };

  const provenance = readRecord(provenancePath);
  const origin = typeof provenance?.origin === "string" ? provenance.origin : "";
  const procedural = origin === "procedurally_generated_from_repository_script"
    || origin === "procedurally_generated"
    || origin === "synthetic_generator";
  if (!procedural) return { eligible: true, status: "verified_or_legacy", provenancePath };

  if (provenance?.usage_class === "simple_sound") {
    return { eligible: true, status: "simple_sound_exception", provenancePath };
  }

  return {
    eligible: false,
    status: "blocked_procedural_bgm",
    provenancePath,
    message:
      "Procedurally generated audio cannot be used as a full BGM bed. Select a reviewed BGM-library track, or remove music_cues for a no-BGM render. Only provenance usage_class=simple_sound may use the procedural exception.",
  };
}
