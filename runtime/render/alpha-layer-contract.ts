import { execFile, execFileSync } from "node:child_process";

export interface AlphaLayerMediaContract {
  version: "alpha-layer-media/v1";
  codec_name: string;
  pixel_format: string;
  alpha_mode: string | null;
  has_alpha: boolean;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  duration_frames: number;
  time_base: string;
  audio_stream_count: number;
}

export interface ExpectedAlphaLayerMedia {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  durationFrames: number;
}

export type ProbeAlphaLayerMedia = (
  filePath: string,
) => Promise<AlphaLayerMediaContract>;

function reduceRational(value: string): [number, number] {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error(`alpha_layer_media_contract_mismatch:fps value=${value}`);
  let numerator = Number(match[1]);
  let denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error(`alpha_layer_media_contract_mismatch:fps value=${value}`);
  }
  let left = numerator;
  let right = denominator;
  while (right !== 0) [left, right] = [right, left % right];
  numerator /= left;
  denominator /= left;
  return [numerator, denominator];
}

export function assertAlphaLayerMediaContract(
  media: AlphaLayerMediaContract,
  expected: ExpectedAlphaLayerMedia,
): void {
  const pixelFormatValid = media.pixel_format === "yuva420p"
    || (media.pixel_format === "yuv420p" && media.alpha_mode === "1");
  const mismatches: Array<[keyof AlphaLayerMediaContract, boolean]> = [
    ["version", media.version === "alpha-layer-media/v1"],
    ["codec_name", media.codec_name === "vp9"],
    ["pixel_format", pixelFormatValid],
    ["has_alpha", media.has_alpha === true],
    ["width", media.width === expected.width],
    ["height", media.height === expected.height],
    ["fps_num", media.fps_num === expected.fpsNum],
    ["fps_den", media.fps_den === expected.fpsDen],
    ["duration_frames", media.duration_frames === expected.durationFrames],
    ["time_base", media.time_base === "1/1000"],
    ["audio_stream_count", media.audio_stream_count === 0],
  ];
  const mismatch = mismatches.find(([, matches]) => !matches);
  if (mismatch) {
    throw new Error(
      `alpha_layer_media_contract_mismatch:${mismatch[0]} actual=${
        JSON.stringify(media[mismatch[0]])
      }`,
    );
  }
}

export async function probeAlphaLayerMedia(
  filePath: string,
): Promise<AlphaLayerMediaContract> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("ffprobe", [
      "-v", "error",
      "-count_packets",
      "-show_entries",
      "stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,time_base,nb_read_packets,nb_frames:stream_tags=alpha_mode",
      "-of", "json",
      filePath,
    ], { maxBuffer: 8 * 1024 * 1024 }, (error, out, stderr) => {
      if (error) {
        reject(new Error(`alpha_layer_probe_failed:${stderr || error.message}`));
        return;
      }
      resolve(out);
    });
  });
  return parseAlphaLayerProbe(stdout);
}

export function probeAlphaLayerMediaSync(
  filePath: string,
): AlphaLayerMediaContract {
  const stdout = execFileSync("ffprobe", [
    "-v", "error",
    "-count_packets",
    "-show_entries",
    "stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,time_base,nb_read_packets,nb_frames:stream_tags=alpha_mode",
    "-of", "json",
    filePath,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return parseAlphaLayerProbe(stdout);
}

export function parseAlphaLayerProbe(stdout: string): AlphaLayerMediaContract {
  const streams = (JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown> & { tags?: Record<string, unknown> }>;
  }).streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("alpha_layer_media_contract_mismatch:video_stream");
  const rate = String(video.avg_frame_rate ?? video.r_frame_rate ?? "");
  const [fpsNum, fpsDen] = reduceRational(rate === "0/0" ? String(video.r_frame_rate ?? "") : rate);
  const durationFrames = Number(video.nb_read_packets ?? video.nb_frames);
  const pixelFormat = typeof video.pix_fmt === "string" ? video.pix_fmt : "";
  const alphaModeEntry = Object.entries(video.tags ?? {}).find(
    ([key]) => key.toLowerCase() === "alpha_mode",
  );
  const alphaMode = alphaModeEntry == null ? null : String(alphaModeEntry[1]);
  const result: AlphaLayerMediaContract = {
    version: "alpha-layer-media/v1",
    codec_name: typeof video.codec_name === "string" ? video.codec_name : "",
    pixel_format: pixelFormat,
    alpha_mode: alphaMode,
    has_alpha: /a/i.test(pixelFormat) || alphaMode === "1",
    width: Number(video.width),
    height: Number(video.height),
    fps_num: fpsNum,
    fps_den: fpsDen,
    duration_frames: durationFrames,
    time_base: typeof video.time_base === "string" ? video.time_base : "",
    audio_stream_count: streams.filter((stream) => stream.codec_type === "audio").length,
  };
  return result;
}
