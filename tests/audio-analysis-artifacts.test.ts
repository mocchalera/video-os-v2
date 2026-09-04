import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssetItem } from "../runtime/connectors/ffprobe.js";
import type { AssetSttResult } from "../runtime/connectors/openai-stt.js";
import type { AssetsJson } from "../runtime/pipeline/pipeline-types.js";
import { sha256FileHex } from "../runtime/source-content-identity.js";
import {
  assertAudioStoryGraphResult,
  predictAudioStoryGraphStatus,
  resolveExplicitBgmSources,
  type AudioStoryStatusAnalysis,
} from "../runtime/pipeline/audio-analysis-artifacts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vos-audio-artifacts-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function audioAsset(assetId = "AST_AUDIO"): AssetItem {
  return {
    asset_id: assetId,
    filename: "voice.wav",
    media_kind: "audio",
    duration_us: 1_000_000,
    has_transcript: false,
    transcript_ref: null,
    segments: 1,
    segment_ids: [`SEG_${assetId}_0001`],
    quality_flags: [],
    tags: [],
    source_fingerprint: "fp-audio",
    frame_rate_mode: "audio_only",
    audio_stream: { sample_rate: 16_000, channels: 1, codec: "pcm_s16le" },
    contact_sheet_ids: [],
    analysis_status: "ready",
  };
}

function baseAnalysis(asset = audioAsset()): AudioStoryStatusAnalysis {
  return {
    assets: [asset],
    sttAttempted: true,
    audioEvents: { failures: new Map(), itemCount: 0 },
    bgm: {
      requestedAssetIds: [],
      readyAssetIds: [],
      failedAssetIds: [],
      unmatchedRequestedCount: 0,
    },
  };
}

describe("audio analysis artifact contracts", () => {
  it("predicts skipped, partial, and neutral-ready graph states", () => {
    const projectDir = tempDir("status-table");
    const noNodes = baseAnalysis();
    expect(predictAudioStoryGraphStatus(noNodes, projectDir)).toBe("skipped");

    const pendingStt = baseAnalysis();
    pendingStt.audioEvents.itemCount = 1;
    expect(predictAudioStoryGraphStatus(pendingStt, projectDir)).toBe("partial");

    const neutralStt = baseAnalysis();
    neutralStt.audioEvents.itemCount = 1;
    neutralStt.sttSkippedAssetIds = new Set(["AST_AUDIO"]);
    expect(predictAudioStoryGraphStatus(neutralStt, projectDir)).toBe("ready");

    const notAttempted = baseAnalysis();
    notAttempted.audioEvents.itemCount = 1;
    notAttempted.sttAttempted = false;
    expect(predictAudioStoryGraphStatus(notAttempted, projectDir)).toBe("ready");
  });

  it("uses only current non-empty transcript documents as ready graph evidence", () => {
    const projectDir = tempDir("transcripts");
    const transcriptDir = path.join(projectDir, "03_analysis", "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, "empty.json"), JSON.stringify({ asset_id: "AST_AUDIO", items: [] }));
    fs.writeFileSync(path.join(transcriptDir, "stale.json"), JSON.stringify({ asset_id: "AST_STALE", items: [{}] }));
    const analysis = baseAnalysis();
    expect(predictAudioStoryGraphStatus(analysis, projectDir)).toBe("skipped");

    fs.writeFileSync(path.join(transcriptDir, "current.json"), JSON.stringify({ asset_id: "AST_AUDIO", items: [{ text: "now" }] }));
    expect(predictAudioStoryGraphStatus(analysis, projectDir)).toBe("ready");
  });

  it("fails loudly on corrupt canonical transcript JSON", () => {
    const projectDir = tempDir("corrupt-transcript");
    const transcriptDir = path.join(projectDir, "03_analysis", "transcripts");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, "corrupt.json"), "{not-json");

    expect(() => predictAudioStoryGraphStatus(baseAnalysis(), projectDir)).toThrow(SyntaxError);
  });

  it("treats STT, audio-event, and BGM failures as partial", () => {
    const projectDir = tempDir("failure-table");
    const sttFailure = baseAnalysis();
    sttFailure.sttResults = new Map([[
      "AST_AUDIO",
      { success: false } as AssetSttResult,
    ]]);
    expect(predictAudioStoryGraphStatus(sttFailure, projectDir)).toBe("partial");

    const eventFailure = baseAnalysis();
    eventFailure.audioEvents.failures.set("AST_AUDIO", "silencedetect_failed");
    expect(predictAudioStoryGraphStatus(eventFailure, projectDir)).toBe("partial");

    const bgmFailure = baseAnalysis();
    bgmFailure.bgm.unmatchedRequestedCount = 1;
    expect(predictAudioStoryGraphStatus(bgmFailure, projectDir)).toBe("partial");
  });

  it("deduplicates canonical BGM aliases and reports unmatched requests", () => {
    const projectDir = tempDir("bgm-identity");
    const sourceFile = path.join(projectDir, "music.wav");
    const aliasFile = path.join(projectDir, "music-alias.wav");
    const missingFile = path.join(projectDir, "missing.wav");
    fs.writeFileSync(sourceFile, "audio");
    fs.symlinkSync(sourceFile, aliasFile);
    const asset = audioAsset("AST_BGM");
    asset.source_content_sha256 = sha256FileHex(sourceFile);
    const assetsJson: AssetsJson = {
      project_id: "audio-project",
      artifact_version: "2.0.0",
      items: [asset],
    };

    const matched = resolveExplicitBgmSources(
      [sourceFile, aliasFile],
      assetsJson,
      new Map([[asset.asset_id, sourceFile]]),
    );
    expect(matched).toEqual({
      sources: [{ sourceFile, assetId: "AST_BGM" }],
      requestedCount: 1,
      unmatchedCount: 0,
    });

    const unmatched = resolveExplicitBgmSources(
      [aliasFile, missingFile],
      assetsJson,
      new Map([[asset.asset_id, sourceFile]]),
    );
    expect(unmatched.requestedCount).toBe(2);
    expect(unmatched.unmatchedCount).toBe(1);
  });

  it("keeps missing graph and predicted/builder mismatch failures explicit", () => {
    expect(() => assertAudioStoryGraphResult("ready", "ready", false))
      .toThrow("canonical_artifact_missing:03_analysis/audio_story_graph.json");
    expect(() => assertAudioStoryGraphResult("ready", "partial", true))
      .toThrow("audio_story_graph_coverage_prediction_mismatch:ready:partial");
    expect(() => assertAudioStoryGraphResult("ready", "ready", true)).not.toThrow();
  });
});
