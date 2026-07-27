import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClipOutput, TimelineIR } from "../runtime/compiler/types.js";
import {
  attachTranscriptAlignedCaptions,
  buildAssSubtitleFile,
  buildPromoFinalizeFfmpegArgs,
  extendFinalClipTail,
  splitCaptionText,
} from "../runtime/render/promo-finisher.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempProject(name: string): string {
  const tmpDir = path.resolve(`tests/tmp_promo_finisher_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  tempDirs.push(tmpDir);
  return tmpDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function makeTimeline(videoClips: ClipOutput[], audioClips: ClipOutput[] = []): TimelineIR {
  return {
    version: "1",
    project_id: "test-project",
    created_at: "2026-07-08T00:00:00.000Z",
    sequence: {
      name: "test",
      fps_num: 30,
      fps_den: 1,
      width: 1920,
      height: 1080,
      start_frame: 0,
    },
    tracks: {
      video: [{ track_id: "V1", kind: "video", clips: videoClips }],
      audio: [
        { track_id: "A1", kind: "audio", clips: audioClips },
        { track_id: "A2", kind: "audio", clips: audioClips.map((clip) => ({ ...clip, clip_id: `${clip.clip_id}_bgm`, role: "music" })) },
      ],
    },
    markers: [],
    provenance: {
      brief_path: "01_intent/creative_brief.yaml",
      blueprint_path: "04_plan/edit_blueprint.yaml",
      selects_path: "04_plan/selects_candidates.yaml",
      compiler_version: "test",
    },
  };
}

function makeClip(overrides: Partial<ClipOutput>): ClipOutput {
  return {
    clip_id: "clip-1",
    segment_id: "seg-1",
    asset_id: "AST_A",
    src_in_us: 0,
    src_out_us: 1_000_000,
    timeline_in_frame: 0,
    timeline_duration_frames: 30,
    role: "testimonial",
    motivation: "test",
    beat_id: "beat-1",
    fallback_segment_ids: [],
    confidence: 1,
    quality_flags: [],
    ...overrides,
  };
}

describe("promo finisher captions", () => {
  it("aligns subtitle timing to transcript item source ranges and clamps to the clip", () => {
    const projectDir = createTempProject("captions");
    writeJson(path.join(projectDir, "03_analysis/transcripts/TR_AST_A.json"), {
      asset_id: "AST_A",
      items: [
        {
          start_us: 1_000_000,
          end_us: 4_000_000,
          text: "前半はクリップ外から始まります。",
        },
        {
          start_us: 4_000_000,
          end_us: 7_000_000,
          text: "AI活用は業務効率化だけではなく経営判断を変えるものです。",
        },
      ],
    });
    const clip = makeClip({
      src_in_us: 2_000_000,
      src_out_us: 7_000_000,
      timeline_in_frame: 30,
      timeline_duration_frames: 150,
    });
    const timeline = makeTimeline([clip]);

    const summary = attachTranscriptAlignedCaptions(timeline, projectDir, {
      maxChars: 8,
      minCaptionFrames: 8,
    });

    expect(summary.clipsWithCaptions).toBe(1);
    expect(summary.captionCount).toBeGreaterThan(2);
    expect(clip.captions?.[0]?.in_frame).toBe(30);
    expect(clip.captions?.every((caption) => caption.in_frame >= 30 && caption.out_frame <= 180)).toBe(true);
    expect(clip.captions?.every((caption) => caption.out_frame > caption.in_frame)).toBe(true);
  });

  it("splits Japanese captions into readable chunks", () => {
    expect(splitCaptionText("AI活用は業務効率化だけではなく、経営判断を変えるものです。", 10)).toEqual([
      "AI活用は",
      "業務効率化だけではなく",
      "経営判断を",
      "変えるものです",
    ]);
  });

  it("avoids splitting Japanese captions at dependent suffixes and small kana", () => {
    expect(splitCaptionText("最初本当に作業を効率化するみたいなふうに思ってたんですけど", 26)).toEqual([
      "最初本当に作業を効率化するみたいな",
      "ふうに思ってたんですけど",
    ]);
    expect(splitCaptionText("これ本当にやりたいことをスピード感を持ってできるんじゃないかなと思っています", 26)).toEqual([
      "これ本当にやりたいことを",
      "スピード感を持ってできるんじゃないかなと思っています",
    ]);
    expect(splitCaptionText("スピード感を持ってできるんじゃないかなと思っています", 18)).toEqual([
      "スピード感を持って",
      "できるんじゃないかなと思っています",
    ]);
    for (const chunk of splitCaptionText("これ本当にやりたいことをスピード感を持ってできるんじゃないかなと思っています", 26)) {
      expect(chunk).not.toMatch(/^(たん|です|ます|けど|ので|から|んじゃ|ゃ|ゅ|ょ|っ|ー)/u);
      expect(chunk).not.toMatch(/[んじ]$/u);
    }
  });
});

describe("promo finisher ending tail", () => {
  it("extends the final V1 clip and matching speech audio, while leaving BGM untouched", () => {
    const projectDir = createTempProject("tail");
    writeJson(path.join(projectDir, "03_analysis/assets.json"), {
      project_id: "test-project",
      items: [{ asset_id: "AST_A", duration_us: 3_000_000 }],
    });
    const finalVideo = makeClip({
      clip_id: "v-final",
      src_in_us: 1_000_000,
      src_out_us: 2_000_000,
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
    });
    const speechAudio = makeClip({
      clip_id: "a-final",
      src_in_us: 1_000_000,
      src_out_us: 2_000_000,
      timeline_in_frame: 60,
      timeline_duration_frames: 30,
      role: "dialogue",
    });
    const timeline = makeTimeline([finalVideo], [speechAudio]);
    const bgmAudio = timeline.tracks.audio[1]?.clips[0];

    const summary = extendFinalClipTail(timeline, projectDir, { tailSec: 0.5 });

    expect(summary.extended).toBe(true);
    expect(summary.addedFrames).toBe(15);
    expect(finalVideo.src_out_us).toBe(2_500_000);
    expect(finalVideo.timeline_duration_frames).toBe(45);
    expect(speechAudio.src_out_us).toBe(2_500_000);
    expect(speechAudio.timeline_duration_frames).toBe(45);
    expect(bgmAudio?.src_out_us).toBe(2_000_000);
    expect(bgmAudio?.timeline_duration_frames).toBe(30);
  });

  it("does not add a second tail when transcript-aligned speech tail is already present", () => {
    const projectDir = createTempProject("tail_present");
    writeJson(path.join(projectDir, "03_analysis/assets.json"), {
      project_id: "test-project",
      items: [{ asset_id: "AST_A", duration_us: 5_000_000 }],
    });
    writeJson(path.join(projectDir, "03_analysis/transcripts/TR_AST_A.json"), {
      asset_id: "AST_A",
      items: [
        {
          start_us: 1_000_000,
          end_us: 2_000_000,
          text: "今日はありがとうございました。",
        },
      ],
    });
    const finalVideo = makeClip({
      clip_id: "v-final",
      src_in_us: 1_000_000,
      src_out_us: 2_500_000,
      timeline_in_frame: 60,
      timeline_duration_frames: 45,
    });
    const speechAudio = makeClip({
      clip_id: "a-final",
      src_in_us: 1_000_000,
      src_out_us: 2_500_000,
      timeline_in_frame: 60,
      timeline_duration_frames: 45,
      role: "dialogue",
    });
    const timeline = makeTimeline([finalVideo], [speechAudio]);

    const summary = extendFinalClipTail(timeline, projectDir, { tailSec: 0.5 });

    expect(summary.extended).toBe(false);
    expect(summary.reason).toBe("speech tail already present");
    expect(finalVideo.src_out_us).toBe(2_500_000);
    expect(speechAudio.src_out_us).toBe(2_500_000);
  });
});

describe("promo finisher ASS and ffmpeg args", () => {
  it("uses bold white outlined subtitles and applies video/audio fade-out", () => {
    const ass = buildAssSubtitleFile([
      { text: "今日は本当にありがとうございました", in_frame: 0, out_frame: 90, style: "simple-shadow" },
    ], 30);
    const args = buildPromoFinalizeFfmpegArgs({
      inputPath: "base.mp4",
      outputPath: "finished.mp4",
      assPath: "subtitles.ass",
      durationSec: 76,
      fadeSec: 0.8,
    });

    expect(ass).toContain("Style: Default,VideoOS Noto Sans JP Bold,66");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain(",1,6,0,2,90,90,72,1");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:03.00");
    expect(args.join(" ")).toContain("subtitles=filename='subtitles.ass'");
    expect(args.join(" ")).toContain(":fontsdir='");
    expect(args.join(" ")).toContain("Resources/Fonts");
    expect(args.join(" ")).toContain("fade=t=out:st=75.2:d=0.8");
    expect(args.join(" ")).toContain("afade=t=out:st=75.2:d=0.8");
  });

  it("supports a vertical translucent panel style for social captions", () => {
    const ass = buildAssSubtitleFile([
      { text: "AIには作れない\n人の挑戦の物語", in_frame: 0, out_frame: 48, style: "simple-shadow" },
    ], 24, {
      playResX: 1080,
      playResY: 1920,
      fontSize: 60,
      marginV: 300,
      borderStyle: 3,
      outline: 12,
      backColor: "&H500B2434",
    });

    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("&H500B2434");
    expect(ass).toContain(",3,12,0,2,90,90,300,1");
    expect(ass).toContain("AIには作れない\\N人の挑戦の物語");
  });
});
