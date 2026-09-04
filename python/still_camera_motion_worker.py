#!/usr/bin/env python3
"""Still-image camera-motion warp worker (Issue 33 — still-camera-motion/v1).

Renders true subpixel camera motion for still images at Float64 coordinate
granularity: the per-frame affine map (zoom about the window center + pan) and
the source-to-output fit transform are composed and inverted in float64 from
the plan trajectory authored by the Node planner. Every output pixel is
resampled at an exact Float64 source coordinate with an 8-tap Lanczos kernel.
There is no integer-pixel or fixed-point quantization stage anywhere in this
path — sub-0.001px plan steps survive rendering.

Why a Float64 kernel evaluation instead of ``cv2.warpAffine``: OpenCV's
warpAffine/remap resamplers precompute sample coordinates in fixed point with
a 5-bit fraction (1/32 px = 0.03125 px quantization). That is far coarser than
the 0.001 px granularity Issue 33 demands, so this worker evaluates the same
Lanczos4 kernel directly in numpy float64. OpenCV is still used for image
decode/color conversion; numpy (OpenCV's own required dependency) provides the
deterministic float64 linear algebra.

Protocol (mirrors the repo's external-worker pattern, one-shot per segment):

  probe                    -> single JSON line on stdout:
                              {"ok": true, "cv2_version": ..., "numpy_version": ...,
                               "policy": "still-camera-motion/v1",
                               "interpolation": "lanczos4", "precision": "float64"}
  warp --request REQ.json --output OUT.raw
                           -> writes rawvideo rgb24 frames to OUT.raw, then a
                              single JSON line on stdout:
                               {"ok": true, "frames": N, "width": W, "height": H,
                               "source_width": SW, "source_height": SH,
                               "fps": {"num": ..., "den": ...},
                               "cv2_version": ..., "precision": "float64"}
                              On any validation/render failure it prints
                              {"ok": false, "error": "..."} and exits 1.

Fail-closed: malformed requests, out-of-range window states, or non-finite
trajectory values are rejected before any output byte is written. The worker
never falls back to integer-pixel rendering.
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np

POLICY = "still-camera-motion/v1"
INTERPOLATION = "lanczos4"
PRECISION = "float64"
FIT_MODES = ("contain", "cover", "full_bleed")
# Lanczos window parameter: 8 taps per axis (matches OpenCV INTER_LANCZOS4).
LANCZOS_A = 4
LANCZOS_TAPS = 8


def _cv2():
    try:
        import cv2  # noqa: PLC0415
        return cv2
    except Exception as exc:  # pragma: no cover - exercised via probe
        _emit({"ok": False, "error": f"cv2_import_failed:{exc}"})
        raise SystemExit(1)


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _fail(error: str) -> None:
    _emit({"ok": False, "error": error})
    raise SystemExit(1)


def _check_finite(name: str, value) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        _fail(f"still_camera_motion_worker_invalid_{name}:{value!r}")
    if not math.isfinite(v):
        _fail(f"still_camera_motion_worker_non_finite_{name}:{value!r}")
    return v


def _background_rgb(value) -> np.ndarray:
    """Resolve the existing still-image color tokens to float64 RGB."""
    if value == "black" or value == "transparent":
        return np.array([0.0, 0.0, 0.0], dtype=np.float64)
    if value == "white":
        return np.array([255.0, 255.0, 255.0], dtype=np.float64)
    if isinstance(value, str) and len(value) in (7, 9) and value[0] == "#":
        try:
            return np.array(
                [int(value[i:i + 2], 16) for i in (1, 3, 5)],
                dtype=np.float64,
            )
        except ValueError:
            pass
    _fail(f"still_camera_motion_worker_background_invalid:{value!r}")


def _fit_geometry(
    source_width: int,
    source_height: int,
    output_width: int,
    output_height: int,
    fit_mode: str,
) -> tuple[float, float, float]:
    """Return scale and centered output-space source placement.

    `full_bleed` is the named cover alias used by the artifact contract: it
    fills the canvas without changing the source aspect ratio.
    """
    if fit_mode not in FIT_MODES:
        _fail(f"still_camera_motion_worker_fit_mode_invalid:{fit_mode!r}")
    if fit_mode == "contain":
        scale = min(output_width / source_width, output_height / source_height)
    else:
        scale = max(output_width / source_width, output_height / source_height)
    scaled_width = float(source_width) * scale
    scaled_height = float(source_height) * scale
    offset_x = (float(output_width) - scaled_width) / 2.0
    offset_y = (float(output_height) - scaled_height) / 2.0
    return scale, offset_x, offset_y


def validate_trajectory(request: dict) -> list[tuple[float, float, float]]:
    """Validate the Node-planned trajectory and return float64 tuples."""
    if request.get("policy") != POLICY:
        _fail(f"still_camera_motion_worker_policy_mismatch:{request.get('policy')!r}")
    window = request.get("window") or {}
    width = window.get("width")
    height = window.get("height")
    if not isinstance(width, int) or width < 1 or not isinstance(height, int) or height < 1:
        _fail(f"still_camera_motion_worker_window_invalid:{width}x{height}")
    frame_count = request.get("frame_count")
    if not isinstance(frame_count, int) or frame_count < 1:
        _fail(f"still_camera_motion_worker_frame_count_invalid:{frame_count!r}")
    fps = request.get("fps") or {}
    fps_num = fps.get("num")
    fps_den = fps.get("den")
    if (
        not isinstance(fps_num, int) or fps_num < 1
        or not isinstance(fps_den, int) or fps_den < 1
    ):
        _fail(f"still_camera_motion_worker_fps_invalid:{fps_num}/{fps_den}")
    trajectory = request.get("trajectory")
    if not isinstance(trajectory, list) or len(trajectory) != frame_count:
        _fail(
            "still_camera_motion_worker_trajectory_length_mismatch:"
            f"{len(trajectory) if isinstance(trajectory, list) else 'missing'}!={frame_count}"
        )
    states: list[tuple[float, float, float]] = []
    for i, state in enumerate(trajectory):
        if not isinstance(state, dict):
            _fail(f"still_camera_motion_worker_trajectory_state_invalid:{i}")
        zoom = _check_finite(f"zoom_{i}", state.get("zoom"))
        cx = _check_finite(f"center_x_{i}", state.get("centerX"))
        cy = _check_finite(f"center_y_{i}", state.get("centerY"))
        if zoom < 1.0:
            _fail(f"still_camera_motion_worker_zoom_below_identity:{zoom}")
        # The window (1/z of the base view) must remain inside the base view.
        half = 1.0 / (2.0 * zoom)
        if cx < half - 1e-9 or cx > 1.0 - half + 1e-9:
            _fail(f"still_camera_motion_worker_center_x_out_of_range:{cx}")
        if cy < half - 1e-9 or cy > 1.0 - half + 1e-9:
            _fail(f"still_camera_motion_worker_center_y_out_of_range:{cy}")
        states.append((zoom, cx, cy))
    return states


def _lanczos(t_abs: np.ndarray) -> np.ndarray:
    """Lanczos kernel with window parameter LANCZOS_A, evaluated in float64."""
    t = np.asarray(t_abs, dtype=np.float64)
    out = np.zeros_like(t)
    inside = t < LANCZOS_A
    ti = t[inside]
    out[inside] = np.sinc(ti) * np.sinc(ti / LANCZOS_A)
    return out


def _taps_and_weights(
    coords: np.ndarray,
    size: int,
) -> tuple[np.ndarray, np.ndarray]:
    """8-tap integer indices and normalized Lanczos weights for source coords.

    `coords` are float64 pixel-index positions (pixel i is centered at i).
    Indices are clamped to the image (replicate border semantics).
    """
    base = np.floor(coords).astype(np.int64) - (LANCZOS_TAPS // 2 - 1)
    idx = base[:, None] + np.arange(LANCZOS_TAPS, dtype=np.int64)[None, :]
    t = coords[:, None] - idx.astype(np.float64)
    weights = _lanczos(np.abs(t))
    weights /= weights.sum(axis=1, keepdims=True)
    np.clip(idx, 0, size - 1, out=idx)
    return idx, weights


def _resample_axis(
    src: np.ndarray,
    coords: np.ndarray,
    axis: int,
) -> np.ndarray:
    """Separable Lanczos resample of `src` along one axis at float64 coords.

    src: (H, W, 3) float64. axis 0 resamples rows (coords length H_out),
    axis 1 resamples columns (coords length W_out). Deterministic tap-order
    accumulation keeps runs bit-reproducible.
    """
    size = src.shape[axis]
    idx, weights = _taps_and_weights(coords, size)
    if axis == 1:
        out = np.zeros(
            (src.shape[0], coords.shape[0], src.shape[2]), dtype=np.float64
        )
        for k in range(LANCZOS_TAPS):
            gathered = np.take(src, idx[:, k], axis=1)
            out += weights[:, k][None, :, None] * gathered
        return out
    out = np.zeros(
        (coords.shape[0], src.shape[1], src.shape[2]), dtype=np.float64
    )
    for k in range(LANCZOS_TAPS):
        gathered = np.take(src, idx[:, k], axis=0)
        out += weights[:, k][:, None, None] * gathered
    return out


def warp_frame(
    image: np.ndarray,
    state: tuple[float, float, float],
    width: int,
    height: int,
    fit_mode: str,
    background: np.ndarray,
) -> np.ndarray:
    """Render one camera window through one composed Float64 source transform.

    Forward map (matching the shared Node planner's screen-space contract):
    a base-view point at continuous coordinate x appears on screen at
    q = (x - c*S) * zoom + S/2 - 0.5 (continuous, pixel centers at i + 0.5).
    Inverse per output pixel center j:
        s = (j + 0.5 - S/2) / zoom + c*S - 0.5   (pixel-index coordinate)
    """
    zoom, cx, cy = state
    source_height, source_width = image.shape[:2]
    scale, offset_x, offset_y = _fit_geometry(
        source_width, source_height, width, height, fit_mode,
    )

    # First invert the camera window from output pixels to continuous base
    # canvas coordinates, then immediately apply the fit map to source pixels.
    # Keeping this as one coordinate calculation avoids the old integer
    # FFmpeg scale/crop intermediate and its crop-phase quantization.
    base_x = (np.arange(width, dtype=np.float64) + 0.5 - width / 2.0) / zoom \
        + cx * width - 0.5
    base_y = (np.arange(height, dtype=np.float64) + 0.5 - height / 2.0) / zoom \
        + cy * height - 0.5
    base_x_center = base_x + 0.5
    base_y_center = base_y + 0.5
    sx = (base_x_center - offset_x) / scale - 0.5
    sy = (base_y_center - offset_y) / scale - 0.5
    valid_x = (base_x_center >= offset_x - 1e-9) & (base_x_center <= offset_x + source_width * scale + 1e-9)
    valid_y = (base_y_center >= offset_y - 1e-9) & (base_y_center <= offset_y + source_height * scale + 1e-9)
    # Resample columns first (x), then rows (y): separable 8-tap Lanczos.
    stage = _resample_axis(image, sx, axis=1)
    warped = _resample_axis(stage, sy, axis=0)
    if fit_mode == "contain":
        invalid = (~valid_y)[:, None] | (~valid_x)[None, :]
        warped[invalid] = background
    return warped


def cmd_probe() -> None:
    cv2 = _cv2()
    _emit({
        "ok": True,
        "cv2_version": cv2.__version__,
        "numpy_version": np.__version__,
        "policy": POLICY,
        "interpolation": INTERPOLATION,
        "precision": PRECISION,
    })


def cmd_warp(request_path: str, output_path: str) -> None:
    cv2 = _cv2()
    with open(request_path, "r", encoding="utf-8") as fh:
        request = json.load(fh)
    states = validate_trajectory(request)

    frame_count = request["frame_count"]
    width = request["window"]["width"]
    height = request["window"]["height"]
    fit_mode = request.get("fit_mode")
    if fit_mode not in FIT_MODES:
        _fail(f"still_camera_motion_worker_fit_mode_invalid:{fit_mode!r}")
    background = _background_rgb(request.get("background", "black"))
    image = cv2.imread(request.get("input", ""), cv2.IMREAD_COLOR)
    if image is None:
        _fail(f"still_camera_motion_worker_input_unreadable:{request.get('input')!r}")
    ih, iw = image.shape[:2]
    source_width, source_height = iw, ih
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float64)

    with open(output_path, "wb") as out:
        for state in states:
            warped = warp_frame(image, state, width, height, fit_mode, background)
            # Round-half-away-from-zero to uint8, clamped to the 8-bit range.
            frame = np.clip(np.rint(warped), 0.0, 255.0).astype(np.uint8)
            out.write(frame.tobytes())
    _emit({
        "ok": True,
        "frames": frame_count,
        "width": width,
        "height": height,
        "source_width": source_width,
        "source_height": source_height,
        "fps": request["fps"],
        "cv2_version": cv2.__version__,
        "policy": POLICY,
        "interpolation": INTERPOLATION,
        "precision": PRECISION,
    })


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("probe")
    warp = sub.add_parser("warp")
    warp.add_argument("--request", required=True)
    warp.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "probe":
        cmd_probe()
    else:
        cmd_warp(args.request, args.output)


if __name__ == "__main__":
    main()
