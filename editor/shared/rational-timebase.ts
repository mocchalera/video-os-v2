/** Canonical frame-rate identity carried by timeline.sequence. */
export interface RationalFrameRate {
  fpsNum: number;
  fpsDen: number;
}

export type FrameRateInput = RationalFrameRate | number;

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function rationalFrameRate(
  fpsNum: number,
  fpsDen: number,
): RationalFrameRate {
  if (!Number.isSafeInteger(fpsNum) || fpsNum <= 0) {
    throw new Error(`Invalid fps numerator: ${fpsNum}`);
  }
  if (!Number.isSafeInteger(fpsDen) || fpsDen <= 0) {
    throw new Error(`Invalid fps denominator: ${fpsDen}`);
  }
  return { fpsNum, fpsDen };
}

export function frameRateValue(rate: FrameRateInput): number {
  if (typeof rate === "number") {
    assertPositiveFinite(rate, "fps");
    return rate;
  }
  const validated = rationalFrameRate(rate.fpsNum, rate.fpsDen);
  return validated.fpsNum / validated.fpsDen;
}

/** Preserve the declared numerator/denominator for FFmpeg and probe receipts. */
export function frameRateRatio(rate: RationalFrameRate): string {
  const validated = rationalFrameRate(rate.fpsNum, rate.fpsDen);
  return `${validated.fpsNum}/${validated.fpsDen}`;
}

export function framesToSeconds(frames: number, rate: FrameRateInput): number {
  if (typeof rate === "number") return frames / frameRateValue(rate);
  const validated = rationalFrameRate(rate.fpsNum, rate.fpsDen);
  return frames * validated.fpsDen / validated.fpsNum;
}

export function framesToMilliseconds(frames: number, rate: FrameRateInput): number {
  return Math.round(framesToSeconds(frames, rate) * 1_000);
}

export function framesToMicroseconds(frames: number, rate: FrameRateInput): number {
  return Math.round(framesToSeconds(frames, rate) * 1_000_000);
}

export function secondsToFrames(seconds: number, rate: FrameRateInput): number {
  if (!Number.isFinite(seconds)) throw new Error(`Invalid seconds: ${seconds}`);
  if (typeof rate === "number") return Math.round(seconds * frameRateValue(rate));
  const validated = rationalFrameRate(rate.fpsNum, rate.fpsDen);
  return Math.round(seconds * validated.fpsNum / validated.fpsDen);
}

export function microsecondsToFrames(
  microseconds: number,
  rate: FrameRateInput,
): number {
  if (!Number.isFinite(microseconds)) {
    throw new Error(`Invalid microseconds: ${microseconds}`);
  }
  if (typeof rate === "number") {
    return Math.round((microseconds / 1_000_000) * frameRateValue(rate));
  }
  const validated = rationalFrameRate(rate.fpsNum, rate.fpsDen);
  return Math.round(
    microseconds * validated.fpsNum / (1_000_000 * validated.fpsDen),
  );
}

export function equivalentFrameRates(
  left: RationalFrameRate,
  right: RationalFrameRate,
): boolean {
  const a = rationalFrameRate(left.fpsNum, left.fpsDen);
  const b = rationalFrameRate(right.fpsNum, right.fpsDen);
  return BigInt(a.fpsNum) * BigInt(b.fpsDen) ===
    BigInt(b.fpsNum) * BigInt(a.fpsDen);
}

export function boundaryErrorFrames(
  actualSeconds: number,
  expectedFrame: number,
  rate: RationalFrameRate,
): number {
  if (!Number.isFinite(actualSeconds)) return Number.POSITIVE_INFINITY;
  return Math.abs(actualSeconds - framesToSeconds(expectedFrame, rate)) *
    frameRateValue(rate);
}
