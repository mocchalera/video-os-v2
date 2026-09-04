import * as fs from "node:fs";
import * as path from "node:path";
import type { CaptionApproval } from "./approval.js";
import type { CaptionVisualTreatmentInput } from "./visual-treatment.js";
import {
  buildAssDocument,
  resolveCaptionStylePreset,
} from "../../editor/shared/caption-style-tokens.js";
import { rationalFrameRate } from "../../editor/shared/rational-timebase.js";
import {
  buildApprovedCaptionAssCues,
  generateSrt,
  generateVtt,
} from "../render/pipeline.js";

export interface CaptionDeliveryArtifacts {
  assPath: string;
  srtPath: string;
  vttPath: string;
}

export function writeApprovedCaptionDeliveryArtifacts(
  approval: CaptionApproval,
  timeline: {
    sequence?: {
      width?: number;
      height?: number;
      fps_num?: number;
      fps_den?: number;
    };
  },
  outputDir: string,
  visualTreatmentInput?: CaptionVisualTreatmentInput,
): CaptionDeliveryArtifacts {
  const width = timeline.sequence?.width;
  const height = timeline.sequence?.height;
  const fpsNum = timeline.sequence?.fps_num;
  const fpsDen = timeline.sequence?.fps_den;
  if (!width || !height || !fpsNum || !fpsDen) {
    throw new Error("timeline sequence width, height, fps_num, and fps_den are required");
  }

  const frameRate = rationalFrameRate(fpsNum, fpsDen);
  const captionsDir = path.join(outputDir, "captions");
  fs.mkdirSync(captionsDir, { recursive: true });
  const srtPath = path.join(captionsDir, "speech.approved.srt");
  const vttPath = path.join(captionsDir, "speech.vtt");
  const assPath = path.join(captionsDir, "speech.ass");
  const srt = generateSrt(approval.speech_captions, frameRate);
  const vtt = generateVtt(approval.speech_captions, frameRate);
  const ass = buildAssDocument(
    buildApprovedCaptionAssCues(approval.speech_captions, frameRate, visualTreatmentInput),
    resolveCaptionStylePreset(approval.caption_policy.styling_class),
    { width, height, fps: fpsNum / fpsDen },
  );
  fs.writeFileSync(srtPath, srt, "utf8");
  fs.writeFileSync(vttPath, vtt, "utf8");
  fs.writeFileSync(assPath, ass, "utf8");
  return { assPath, srtPath, vttPath };
}
