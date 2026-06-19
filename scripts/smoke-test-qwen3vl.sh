#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$REPO_ROOT/python/.venv-qwen3vl"
REQUIREMENTS="$REPO_ROOT/python/requirements-qwen3vl.txt"
WORKER="$REPO_ROOT/python/qwen3vl_embedding_worker.py"
CACHE_DIR="${VOS_QWEN3VL_CACHE_DIR:-$HOME/.cache/video-os-v2/qwen3vl}"
MODEL="${VOS_QWEN3VL_MODEL:-Qwen/Qwen3-VL-Embedding-2B}"
DEVICE="${VOS_QWEN3VL_DEVICE:-auto}"

echo "[qwen3vl-smoke] repo: $REPO_ROOT"
echo "[qwen3vl-smoke] venv: $VENV_DIR"
echo "[qwen3vl-smoke] model: $MODEL"
echo "[qwen3vl-smoke] device: $DEVICE"
echo "[qwen3vl-smoke] cache: $CACHE_DIR"

if [[ ! -x "$VENV_DIR/bin/python3" ]]; then
  python3 -m venv "$VENV_DIR"
fi

# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r "$REQUIREMENTS"

export QWEN3VL_WORKER="$WORKER"
export QWEN3VL_MODEL="$MODEL"
export QWEN3VL_DEVICE="$DEVICE"
export QWEN3VL_CACHE_DIR="$CACHE_DIR"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

python - <<'PY'
from __future__ import annotations

import base64
import json
import math
import os
import selectors
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image, ImageDraw


WORKER = os.environ["QWEN3VL_WORKER"]
MODEL = os.environ["QWEN3VL_MODEL"]
DEVICE = os.environ["QWEN3VL_DEVICE"]
CACHE_DIR = os.path.expanduser(os.environ["QWEN3VL_CACHE_DIR"])
DIMENSION = 2048


def make_fixture() -> str:
    fixture_dir = Path(tempfile.mkdtemp(prefix="qwen3vl-smoke-"))
    image_path = fixture_dir / "warm-light-fixture.png"
    image = Image.new("RGB", (96, 64), (225, 171, 101))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 36, 96, 64), fill=(88, 70, 54))
    draw.ellipse((56, 8, 88, 40), fill=(255, 231, 158))
    draw.rectangle((14, 18, 42, 52), fill=(142, 97, 57))
    image.save(image_path)
    return str(image_path)


def drain_stderr(proc: subprocess.Popen[str], lines: list[str]) -> None:
    assert proc.stderr is not None
    for line in proc.stderr:
        lines.append(line.rstrip())


def read_response(proc: subprocess.Popen[str], selector: selectors.BaseSelector, timeout: float) -> dict:
    events = selector.select(timeout)
    if not events:
        raise RuntimeError(f"worker response timed out after {timeout:.0f}s")
    assert proc.stdout is not None
    line = proc.stdout.readline()
    if not line:
        code = proc.poll()
        raise RuntimeError(f"worker exited before response, code={code}")
    return json.loads(line)


def send(proc: subprocess.Popen[str], selector: selectors.BaseSelector, request: dict, timeout: float) -> dict:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
    proc.stdin.flush()
    return read_response(proc, selector, timeout)


def decode_vector(encoded: str, dimension: int) -> list[float]:
    payload = base64.b64decode(encoded)
    expected_bytes = dimension * 4
    if len(payload) != expected_bytes:
        raise AssertionError(f"vector bytes mismatch: got {len(payload)}, expected {expected_bytes}")
    return list(struct.unpack("<" + "f" * dimension, payload))


def validate_embedding_response(name: str, response: dict) -> dict:
    if not response.get("ok"):
        error = response.get("error") or {}
        code = error.get("code", "unknown")
        message = error.get("message", response)
        raise RuntimeError(f"{name} failed: {code}: {message}")

    result = response.get("result") or {}
    vectors = result.get("vectors") or []
    if len(vectors) != 1:
        raise AssertionError(f"{name} expected one vector, got {len(vectors)}")

    vector_meta = vectors[0]
    if vector_meta.get("dimension") != DIMENSION:
        raise AssertionError(f"{name} dimension mismatch: {vector_meta.get('dimension')}")
    if vector_meta.get("vector_encoding") != "float32-le-base64":
        raise AssertionError(f"{name} vector_encoding mismatch: {vector_meta.get('vector_encoding')}")

    vector = decode_vector(vector_meta["vector"], DIMENSION)
    if not all(math.isfinite(value) for value in vector):
        raise AssertionError(f"{name} returned non-finite values")
    norm = math.sqrt(sum(value * value for value in vector))
    if abs(norm - 1.0) > 0.001:
        raise AssertionError(f"{name} vector norm {norm:.6f} is outside tolerance")
    if not vector_meta.get("normalized"):
        raise AssertionError(f"{name} did not mark vector as normalized")

    model = result.get("model") or {}
    for field in ["name", "model_revision", "output_dimension", "precision", "device"]:
        if field not in model:
            raise AssertionError(f"{name} missing model.{field}")
    if model["output_dimension"] != DIMENSION:
        raise AssertionError(f"{name} model output dimension mismatch: {model['output_dimension']}")

    return {
        "name": name,
        "elapsed_ms": result.get("elapsed_ms"),
        "device": model.get("device"),
        "peak_rss_mb": (result.get("metrics") or {}).get("peak_rss_mb"),
        "norm": norm,
    }


def main() -> int:
    image_path = make_fixture()
    proc = subprocess.Popen(
        [
            sys.executable,
            WORKER,
            "--model",
            MODEL,
            "--device",
            DEVICE,
            "--cache-dir",
            CACHE_DIR,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stderr_lines: list[str] = []
    thread = threading.Thread(target=drain_stderr, args=(proc, stderr_lines), daemon=True)
    thread.start()

    selector = selectors.DefaultSelector()
    assert proc.stdout is not None
    selector.register(proc.stdout, selectors.EVENT_READ)
    request_id = 1
    summaries: list[dict] = []

    try:
        tests = [
            (
                "embed_text",
                {
                    "texts": ["温かみのある光のシーン"],
                    "instruction": "Retrieve relevant video footage.",
                    "output_dimension": DIMENSION,
                    "normalize": True,
                },
                600.0,
            ),
            (
                "embed_image",
                {
                    "image_paths": [image_path],
                    "instruction": "Retrieve visually similar video footage.",
                    "output_dimension": DIMENSION,
                    "normalize": True,
                    "preprocess_version": "qwen3vl-frame-v1",
                },
                300.0,
            ),
            (
                "embed_mixed",
                {
                    "items": [{"text": "warm morning light on wood", "image_path": image_path}],
                    "instruction": "Retrieve matching video clips using text and image.",
                    "output_dimension": DIMENSION,
                    "normalize": True,
                    "preprocess_version": "qwen3vl-mixed-v1",
                },
                300.0,
            ),
        ]

        for method, params, timeout in tests:
            started = time.perf_counter()
            response = send(proc, selector, {"id": request_id, "method": method, "params": params}, timeout)
            elapsed = int((time.perf_counter() - started) * 1000)
            summary = validate_embedding_response(method, response)
            summary["roundtrip_ms"] = elapsed
            summaries.append(summary)
            request_id += 1

        try:
            send(proc, selector, {"id": request_id, "method": "shutdown", "params": {}}, 15.0)
        finally:
            proc.wait(timeout=15)

        device = summaries[-1]["device"]
        peak_rss_values = [item["peak_rss_mb"] for item in summaries if item.get("peak_rss_mb") is not None]
        peak_rss = max(peak_rss_values) if peak_rss_values else None

        print("\nPASS qwen3vl local smoke")
        print(f"device={device}")
        if peak_rss is not None:
            print(f"peak_rss_mb={peak_rss}")
        for item in summaries:
            print(
                f"{item['name']}: elapsed_ms={item['elapsed_ms']} "
                f"roundtrip_ms={item['roundtrip_ms']} norm={item['norm']:.6f}"
            )
        return 0
    except Exception as exc:
        print("\nFAIL qwen3vl local smoke", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        if stderr_lines:
            print("\nworker stderr:", file=sys.stderr)
            for line in stderr_lines[-20:]:
                print(line, file=sys.stderr)
        return 1
    finally:
        if proc.poll() is None:
            try:
                assert proc.stdin is not None
                proc.stdin.write(json.dumps({"id": request_id + 1, "method": "shutdown", "params": {}}) + "\n")
                proc.stdin.flush()
            except Exception:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        selector.close()


raise SystemExit(main())
PY
