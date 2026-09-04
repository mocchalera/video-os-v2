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

export interface AlphaOverlayArtifactRef {
  path: string;
  sha256: string;
}

export type AlphaOverlayReceiptStatus =
  | "canonical"
  | "supplied_external"
  | "metadata_only"
  | "not_applicable";

export type AlphaOverlayReceiptOwnership = "canonical" | "supplied" | "external";

export interface AlphaOverlayExportReceipt {
  version: "alpha-overlay-export-receipt/v1";
  status: AlphaOverlayReceiptStatus;
  ownership: AlphaOverlayReceiptOwnership;
  canonical_claim: boolean;
  geometry: { width: number; height: number };
  fps: { num: number; den: number };
  codec: {
    name: string;
    pixel_format: string;
    alpha_mode: string | null;
  };
  source: AlphaOverlayArtifactRef;
  output: AlphaOverlayArtifactRef | null;
  visual_treatment: {
    input_hash: string | null;
    profile_hash: string | null;
    capability_hash: string | null;
  };
  human_approval: {
    status: "not_requested" | "pending" | "approved" | "rejected";
    owner: string | null;
    receipt: AlphaOverlayArtifactRef | null;
  };
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

export function reduceAlphaOverlayFps(num: number, den: number): [number, number] {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new Error("alpha_overlay_receipt_invalid:fps");
  }
  return reduceRational(`${num}/${den}`);
}

export function createAlphaOverlayExportReceipt(input: {
  status: AlphaOverlayReceiptStatus;
  ownership: AlphaOverlayReceiptOwnership;
  geometry: { width: number; height: number };
  fpsNum: number;
  fpsDen: number;
  codec: { name: string; pixel_format: string; alpha_mode: string | null };
  source: AlphaOverlayArtifactRef;
  output?: AlphaOverlayArtifactRef | null;
  visualTreatment?: {
    inputHash?: string | null;
    profileHash?: string | null;
    capabilityHash?: string | null;
  };
  humanApproval?: AlphaOverlayExportReceipt["human_approval"];
}): AlphaOverlayExportReceipt {
  const [num, den] = reduceAlphaOverlayFps(input.fpsNum, input.fpsDen);
  const receipt: AlphaOverlayExportReceipt = {
    version: "alpha-overlay-export-receipt/v1",
    status: input.status,
    ownership: input.ownership,
    canonical_claim: input.status === "canonical",
    geometry: input.geometry,
    fps: { num, den },
    codec: input.codec,
    source: input.source,
    output: input.output ?? null,
    visual_treatment: {
      input_hash: input.visualTreatment?.inputHash ?? null,
      profile_hash: input.visualTreatment?.profileHash ?? null,
      capability_hash: input.visualTreatment?.capabilityHash ?? null,
    },
    human_approval: input.humanApproval ?? {
      status: "not_requested",
      owner: null,
      receipt: null,
    },
  };
  const validation = validateAlphaOverlayExportReceipt(receipt);
  if (!validation.valid) {
    throw new Error(`alpha_overlay_receipt_invalid:${validation.errors.join(",")}`);
  }
  return receipt;
}

/** Compatibility name for the canonical alpha-layer receipt contract. */
export const createAlphaLayerReceipt = createAlphaOverlayExportReceipt;
export type AlphaLayerReceipt = AlphaOverlayExportReceipt;

const ALPHA_CODEC_PIXEL_FORMATS: Record<string, Set<string>> = {
  vp9: new Set(["yuva420p"]),
  prores: new Set(["yuva444p10le", "yuva444p12le", "yuva422p10le"]),
  prores_ks: new Set(["yuva444p10le", "yuva444p12le", "yuva422p10le"]),
  qtrle: new Set(["argb", "rgba"]),
  png: new Set(["argb", "rgba"]),
  ffv1: new Set(["yuva420p", "yuva444p10le"]),
  hap_alpha: new Set(["rgba"]),
};

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function hasAlphaCodec(codec: AlphaOverlayExportReceipt["codec"]): boolean {
  if (!codec || typeof codec.name !== "string" || typeof codec.pixel_format !== "string") return false;
  const formats = ALPHA_CODEC_PIXEL_FORMATS[codec.name.toLowerCase()];
  return Boolean(
    formats?.has(codec.pixel_format.toLowerCase())
      && typeof codec.alpha_mode === "string"
      && ["1", "straight", "premultiplied"].includes(codec.alpha_mode),
  );
}

export function validateAlphaOverlayExportReceipt(
  value: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["receipt must be an object"] };
  }
  const receipt = value as Partial<AlphaOverlayExportReceipt>;
  if (receipt.version !== "alpha-overlay-export-receipt/v1") errors.push("version");
  const statuses = ["canonical", "supplied_external", "metadata_only", "not_applicable"];
  const ownerships = ["canonical", "supplied", "external"];
  if (!statuses.includes(receipt.status as string)) errors.push("status");
  if (!ownerships.includes(receipt.ownership as string)) errors.push("ownership");
  if (receipt.canonical_claim !== (receipt.status === "canonical")) errors.push("canonical_claim");
  if (receipt.status !== "canonical" && receipt.ownership === "canonical") errors.push("noncanonical ownership");
  const geometry = receipt.geometry;
  if (!geometry || !Number.isSafeInteger(geometry.width) || geometry.width <= 0 || !Number.isSafeInteger(geometry.height) || geometry.height <= 0) errors.push("geometry");
  const fps = receipt.fps;
  if (!fps || !Number.isSafeInteger(fps.num) || !Number.isSafeInteger(fps.den) || fps.num <= 0 || fps.den <= 0) errors.push("fps");
  else {
    const [num, den] = reduceAlphaOverlayFps(fps.num, fps.den);
    if (num !== fps.num || den !== fps.den) errors.push("fps must be reduced");
  }
  if (!receipt.codec || typeof receipt.codec.name !== "string" || typeof receipt.codec.pixel_format !== "string" || (receipt.codec.alpha_mode !== null && typeof receipt.codec.alpha_mode !== "string")) errors.push("codec");
  if (receipt.status === "not_applicable") {
    if (receipt.codec?.name !== "none" || receipt.codec?.pixel_format !== "none" || receipt.codec?.alpha_mode !== null) errors.push("not_applicable codec");
  } else if (!receipt.codec || !hasAlphaCodec(receipt.codec)) {
    errors.push("codec must be alpha-capable");
  }
  if (!receipt.source || typeof receipt.source.path !== "string" || receipt.source.path.length === 0 || !isSha256(receipt.source.sha256)) errors.push("source");
  if (receipt.output !== null && receipt.output !== undefined && (typeof receipt.output.path !== "string" || receipt.output.path.length === 0 || !isSha256(receipt.output.sha256))) errors.push("output");
  if (receipt.status === "canonical" && (receipt.ownership !== "canonical" || !receipt.output)) errors.push("canonical output ownership");
  if (receipt.status === "supplied_external" && (receipt.canonical_claim || (receipt.ownership !== "supplied" && receipt.ownership !== "external") || !receipt.output)) errors.push("supplied external output ownership");
  if (receipt.status === "metadata_only" && (receipt.canonical_claim || (receipt.ownership !== "supplied" && receipt.ownership !== "external") || receipt.output !== null)) errors.push("metadata-only output ownership");
  if (receipt.status === "not_applicable" && (receipt.output !== null || receipt.canonical_claim || receipt.ownership === "canonical")) errors.push("not-applicable output ownership");
  const treatment = receipt.visual_treatment;
  if (!treatment || ![treatment.input_hash, treatment.profile_hash, treatment.capability_hash].every((hash) => hash === null || isSha256(hash))) errors.push("visual_treatment");
  if (receipt.status !== "not_applicable") {
    if (!treatment || !isSha256(treatment.capability_hash)) errors.push("visual_treatment capability_hash");
    if (!treatment || (treatment.input_hash === null) !== (treatment.profile_hash === null)) errors.push("visual_treatment treatment identity pair");
  } else if (treatment && (treatment.input_hash !== null || treatment.profile_hash !== null || treatment.capability_hash !== null)) {
    errors.push("not-applicable visual_treatment");
  }
  const approval = receipt.human_approval;
  const approvalOwner = typeof approval?.owner === "string" && approval.owner.trim().length > 0;
  const approvalReceipt = approval?.receipt;
  const approvalReceiptValid = approvalReceipt === null
    || (Boolean(approvalReceipt) && typeof approvalReceipt?.path === "string" && approvalReceipt.path.length > 0 && isSha256(approvalReceipt.sha256));
  if (!approval || !["not_requested", "pending", "approved", "rejected"].includes(approval.status) || (approval.owner !== null && !approvalOwner) || !approvalReceiptValid) errors.push("human_approval");
  if (approval) {
    if (approval.status === "not_requested" && (approval.owner !== null || approval.receipt !== null)) errors.push("approval not_requested consistency");
    if ((approval.status === "pending" || approval.status === "rejected") && (!approvalOwner || approval.receipt !== null)) errors.push("approval pending/rejected consistency");
    if (approval.status === "approved" && (!approvalOwner || !approvalReceipt)) errors.push("approval approved owner/receipt consistency");
    if (approval.receipt !== null && approval.status !== "approved") errors.push("approval receipt requires approved status");
  }
  return { valid: errors.length === 0, errors };
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
