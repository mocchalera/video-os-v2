import { describe, it, expect } from "vitest";
import { classifyTranscriptQuality } from "../runtime/analysis/transcript-quality.js";

/**
 * Calibrated against real fumoto-growth b-roll transcripts. The creative
 * regeneration eval traced two missed hero moments to the triager trusting the
 * "ご視聴ありがとうございました" Whisper hallucination as if it were content; this
 * classifier must mark such noise unreliable while preserving genuine speech.
 */
describe("classifyTranscriptQuality", () => {
  it("marks the Whisper boilerplate hallucination as unusable", () => {
    const r = classifyTranscriptQuality("ご視聴ありがとうございました");
    expect(r.quality).toBe("empty");
    expect(r.usableText).toBe("");
  });

  it("marks repeated boilerplate + filler as unusable", () => {
    const r = classifyTranscriptQuality("ご視聴ありがとうございました ご視聴ありがとうございました ん ん ん ん ん ん");
    expect(r.quality).not.toBe("ok");
    expect(r.usableText).toBe("");
  });

  it("flags mojibake (replacement char / exotic scripts) as low quality", () => {
    expect(classifyTranscriptQuality("悲しめ��影 ありがとう").quality).toBe("low");
    expect(classifyTranscriptQuality("ろくže 2 ウースト 反省の隔を追是数 וו精神").quality).toBe("low");
    expect(classifyTranscriptQuality("ỗ兩木omp 海人もたぶん 海人もたぶん").quality).toBe("low");
  });

  it("flags single-token babble as low quality", () => {
    expect(classifyTranscriptQuality("ん ん ん ん ん ん ん").quality).toBe("low");
    expect(
      classifyTranscriptQuality("ディアン ディアン ディアン ディアン ディアン ザンバレ ディアン").quality,
    ).toBe("low");
  });

  it("keeps genuine speech as ok", () => {
    expect(classifyTranscriptQuality("坂本六太郎 0歳 0日 寝てるのかな").quality).toBe("ok");
    expect(classifyTranscriptQuality("スタートしてる いいよ おー いけたね イエーイ できたー").quality).toBe("ok");
    expect(
      classifyTranscriptQuality("やったね! 一周してこれたね すごいね、ロクちゃん もうマスターだ").quality,
    ).toBe("ok");
  });

  it("treats blank as empty", () => {
    expect(classifyTranscriptQuality("").quality).toBe("empty");
    expect(classifyTranscriptQuality("   ").quality).toBe("empty");
  });
});
