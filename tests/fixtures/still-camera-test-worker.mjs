#!/usr/bin/env node

// Dependency-free CI fixture for the still-camera worker protocol. It keeps
// the production Node bridge, capability gate, raw-frame handoff, ffmpeg
// assembly, and render receipts live while replacing only the optional local
// Python/NumPy executable. The fixture performs the same Float64 Lanczos
// coordinate operation in JavaScript after ffmpeg decodes the source image.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const POLICY = "still-camera-motion/v1";
const INTERPOLATION = "lanczos4";
const PRECISION = "float64";
const LANCZOS_A = 4;
const LANCZOS_TAPS = 8;

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(error) {
  emit({ ok: false, error });
  process.exit(1);
}

function finite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`still_camera_test_worker_non_finite_${name}:${String(value)}`);
  }
  return value;
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    fail(`still_camera_test_worker_${name}_invalid:${String(value)}`);
  }
  return value;
}

function backgroundRgb(value) {
  if (value === "black" || value === "transparent") return [0, 0, 0];
  if (value === "white") return [255, 255, 255];
  if (typeof value === "string" && (value.length === 7 || value.length === 9) && value[0] === "#") {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
    if (channels.every(Number.isFinite)) return channels;
  }
  fail(`still_camera_test_worker_background_invalid:${String(value)}`);
}

function validateRequest(request) {
  if (request.policy !== POLICY) fail(`still_camera_test_worker_policy_mismatch:${String(request.policy)}`);
  const window = request.window ?? {};
  const width = positiveInteger("window_width", window.width);
  const height = positiveInteger("window_height", window.height);
  const frameCount = positiveInteger("frame_count", request.frame_count);
  const fps = request.fps ?? {};
  const fpsNum = positiveInteger("fps_num", fps.num);
  const fpsDen = positiveInteger("fps_den", fps.den);
  if (!["contain", "cover", "full_bleed"].includes(request.fit_mode)) {
    fail(`still_camera_test_worker_fit_mode_invalid:${String(request.fit_mode)}`);
  }
  if (!Array.isArray(request.trajectory) || request.trajectory.length !== frameCount) {
    fail(`still_camera_test_worker_trajectory_length_mismatch:${String(request.trajectory?.length)}!=${frameCount}`);
  }
  for (const [index, state] of request.trajectory.entries()) {
    if (!state || typeof state !== "object") fail(`still_camera_test_worker_trajectory_state_invalid:${index}`);
    const zoom = finite(`zoom_${index}`, state.zoom);
    const centerX = finite(`center_x_${index}`, state.centerX);
    const centerY = finite(`center_y_${index}`, state.centerY);
    if (zoom < 1) fail(`still_camera_test_worker_zoom_below_identity:${zoom}`);
    const half = 1 / (2 * zoom);
    if (centerX < half - 1e-9 || centerX > 1 - half + 1e-9) {
      fail(`still_camera_test_worker_center_x_out_of_range:${centerX}`);
    }
    if (centerY < half - 1e-9 || centerY > 1 - half + 1e-9) {
      fail(`still_camera_test_worker_center_y_out_of_range:${centerY}`);
    }
  }
  return { width, height, frameCount, fps: { num: fpsNum, den: fpsDen } };
}

function fitGeometry(sourceWidth, sourceHeight, width, height, fitMode) {
  const scale = fitMode === "contain"
    ? Math.min(width / sourceWidth, height / sourceHeight)
    : Math.max(width / sourceWidth, height / sourceHeight);
  return {
    scale,
    offsetX: (width - sourceWidth * scale) / 2,
    offsetY: (height - sourceHeight * scale) / 2,
  };
}

function sinc(value) {
  if (value === 0) return 1;
  const piValue = Math.PI * value;
  return Math.sin(piValue) / piValue;
}

function lanczos(value) {
  const absolute = Math.abs(value);
  return absolute < LANCZOS_A ? sinc(value) * sinc(value / LANCZOS_A) : 0;
}

function tapsAndWeights(coordinate, size) {
  const base = Math.floor(coordinate) - (LANCZOS_TAPS / 2 - 1);
  const indices = new Array(LANCZOS_TAPS);
  const weights = new Array(LANCZOS_TAPS);
  let sum = 0;
  for (let tap = 0; tap < LANCZOS_TAPS; tap += 1) {
    indices[tap] = Math.min(size - 1, Math.max(0, base + tap));
    weights[tap] = lanczos(coordinate - (base + tap));
    sum += weights[tap];
  }
  if (sum === 0 || !Number.isFinite(sum)) fail("still_camera_test_worker_lanczos_weights_invalid");
  for (let tap = 0; tap < LANCZOS_TAPS; tap += 1) weights[tap] /= sum;
  return { indices, weights };
}

function renderFrame(image, sourceWidth, sourceHeight, state, width, height, fitMode, background) {
  const { scale, offsetX, offsetY } = fitGeometry(sourceWidth, sourceHeight, width, height, fitMode);
  const xMaps = [];
  const yMaps = [];
  const zoom = state.zoom;
  const centerX = state.centerX;
  const centerY = state.centerY;
  for (let x = 0; x < width; x += 1) {
    const baseX = (x + 0.5 - width / 2) / zoom + centerX * width - 0.5;
    const baseXCenter = baseX + 0.5;
    xMaps.push({
      valid: baseXCenter >= offsetX - 1e-9 && baseXCenter <= offsetX + sourceWidth * scale + 1e-9,
      taps: tapsAndWeights((baseXCenter - offsetX) / scale - 0.5, sourceWidth),
    });
  }
  for (let y = 0; y < height; y += 1) {
    const baseY = (y + 0.5 - height / 2) / zoom + centerY * height - 0.5;
    const baseYCenter = baseY + 0.5;
    yMaps.push({
      valid: baseYCenter >= offsetY - 1e-9 && baseYCenter <= offsetY + sourceHeight * scale + 1e-9,
      taps: tapsAndWeights((baseYCenter - offsetY) / scale - 0.5, sourceHeight),
    });
  }

  const horizontal = new Float64Array(sourceHeight * width * 3);
  for (let sourceY = 0; sourceY < sourceHeight; sourceY += 1) {
    for (let x = 0; x < width; x += 1) {
      const map = xMaps[x].taps;
      const outOffset = (sourceY * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        let value = 0;
        for (let tap = 0; tap < LANCZOS_TAPS; tap += 1) {
          value += map.weights[tap] * image[(sourceY * sourceWidth + map.indices[tap]) * 3 + channel];
        }
        horizontal[outOffset + channel] = value;
      }
    }
  }

  const output = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const outputOffset = (y * width + x) * 3;
      if (fitMode === "contain" && (!xMaps[x].valid || !yMaps[y].valid)) {
        output[outputOffset] = background[0];
        output[outputOffset + 1] = background[1];
        output[outputOffset + 2] = background[2];
        continue;
      }
      const map = yMaps[y].taps;
      for (let channel = 0; channel < 3; channel += 1) {
        let value = 0;
        for (let tap = 0; tap < LANCZOS_TAPS; tap += 1) {
          value += map.weights[tap] * horizontal[(map.indices[tap] * width + x) * 3 + channel];
        }
        output[outputOffset + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return output;
}

function decodeSource(input) {
  const dimensions = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", input,
  ], { encoding: "utf8" }).trim().split("x").map(Number);
  const [sourceWidth, sourceHeight] = dimensions;
  if (!Number.isInteger(sourceWidth) || sourceWidth < 1 || !Number.isInteger(sourceHeight) || sourceHeight < 1) {
    fail(`still_camera_test_worker_source_dimensions_invalid:${dimensions.join("x")}`);
  }
  const image = execFileSync("ffmpeg", [
    "-v", "error", "-i", input, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: sourceWidth * sourceHeight * 3 + 1024 });
  const expectedBytes = sourceWidth * sourceHeight * 3;
  if (image.length !== expectedBytes) {
    fail(`still_camera_test_worker_source_bytes_mismatch:${image.length}!=${expectedBytes}`);
  }
  return { image, sourceWidth, sourceHeight };
}

function uniformRgb(image) {
  if (image.length < 3) return undefined;
  const rgb = [image[0], image[1], image[2]];
  for (let offset = 3; offset < image.length; offset += 3) {
    if (image[offset] !== rgb[0] || image[offset + 1] !== rgb[1] || image[offset + 2] !== rgb[2]) {
      return undefined;
    }
  }
  return rgb;
}

function repeatUniformFrame(rgb, width, height, frameCount) {
  // A cover-fitted uniform image is invariant under every camera trajectory;
  // repeating its exact rendered RGB frame is therefore an equivalent fast
  // path, not a static fallback. The request and trajectory were validated
  // above, and contain is excluded because its animated border can change.
  const frame = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < frame.length; offset += 3) {
    frame[offset] = rgb[0];
    frame[offset + 1] = rgb[1];
    frame[offset + 2] = rgb[2];
  }
  const output = Buffer.alloc(frame.length * frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    frame.copy(output, index * frame.length);
  }
  return output;
}

function warp(requestPath, outputPath) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const { width, height, frameCount } = validateRequest(request);
  const { image, sourceWidth, sourceHeight } = decodeSource(request.input);
  const background = backgroundRgb(request.background ?? "black");
  const uniform = request.fit_mode === "contain" ? undefined : uniformRgb(image);
  const output = uniform
    ? repeatUniformFrame(uniform, width, height, frameCount)
    : Buffer.concat(
        request.trajectory.map((state) => renderFrame(
          image, sourceWidth, sourceHeight, state, width, height, request.fit_mode, background,
        )),
        width * height * 3 * frameCount,
      );
  writeFileSync(outputPath, output);
  emit({
    ok: true,
    frames: frameCount,
    width,
    height,
    source_width: sourceWidth,
    source_height: sourceHeight,
    fps: request.fps,
    cv2_version: "ffmpeg-test-fixture",
    numpy_version: "node-float64-test-fixture",
    policy: POLICY,
    interpolation: INTERPOLATION,
    precision: PRECISION,
  });
}

const args = process.argv.slice(2);
if (args[0] === "probe" && args.length === 1) {
  emit({
    ok: true,
    cv2_version: "ffmpeg-test-fixture",
    numpy_version: "node-float64-test-fixture",
    policy: POLICY,
    interpolation: INTERPOLATION,
    precision: PRECISION,
  });
} else if (args[0] === "warp" && args[1] === "--request" && args[3] === "--output" && args.length === 5) {
  try {
    warp(args[2], args[4]);
  } catch (error) {
    fail(`still_camera_test_worker_failed:${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  fail("still_camera_test_worker_arguments_invalid");
}
