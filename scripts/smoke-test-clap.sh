#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/python/.venv-clap"
REQUIREMENTS="$REPO_ROOT/python/requirements-clap.txt"
PYTHON="$VENV_DIR/bin/python3"

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

"$PYTHON" -m pip install --upgrade pip
"$PYTHON" -m pip install -r "$REQUIREMENTS"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TONE_WAV="$TMP_DIR/clap-tone.wav"
SILENCE_WAV="$TMP_DIR/clap-silence.wav"

"$PYTHON" - "$TONE_WAV" "$SILENCE_WAV" <<'PY'
import math
import struct
import sys
import wave

tone_path, silence_path = sys.argv[1], sys.argv[2]
sample_rate = 48000
duration_seconds = 1.0
frame_count = int(sample_rate * duration_seconds)

def write_wav(path, samples):
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        payload = b"".join(struct.pack("<h", max(-32768, min(32767, int(sample * 32767)))) for sample in samples)
        handle.writeframes(payload)

tone = [0.25 * math.sin(2.0 * math.pi * 440.0 * index / sample_rate) for index in range(frame_count)]
silence = [0.0 for _ in range(frame_count)]
write_wav(tone_path, tone)
write_wav(silence_path, silence)
PY

export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export TRANSFORMERS_OFFLINE="${TRANSFORMERS_OFFLINE:-1}"
export VOS_CLAP_CACHE_DIR="${VOS_CLAP_CACHE_DIR:-$HOME/.cache/video-os-v2/clap}"

"$PYTHON" - "$REPO_ROOT" "$TONE_WAV" "$SILENCE_WAV" <<'PY'
import base64
import json
import math
import os
import struct
import subprocess
import sys

repo_root, tone_wav, silence_wav = sys.argv[1], sys.argv[2], sys.argv[3]
worker = os.path.join(repo_root, "python", "clap_audio_worker.py")
device = os.environ.get("VOS_CLAP_DEVICE", "auto")
cache_dir = os.path.expanduser(os.environ.get("VOS_CLAP_CACHE_DIR", "~/.cache/video-os-v2/clap"))
timeout_seconds = int(os.environ.get("VOS_CLAP_SMOKE_TIMEOUT_SECONDS", "900"))
mock = os.environ.get("VOS_CLAP_MOCK") == "1"

args = [sys.executable, worker, "--device", device, "--cache-dir", cache_dir]
if os.environ.get("VOS_CLAP_MODEL"):
    args.extend(["--model", os.environ["VOS_CLAP_MODEL"]])
if mock:
    args.append("--mock")

requests = [
    {
        "id": 1,
        "name": "text",
        "method": "embed_text",
        "params": {"texts": ["quiet ambient sound"], "output_dimension": 512, "normalize": True},
        "expected_count": 1,
    },
    {
        "id": 2,
        "name": "audio",
        "method": "embed_audio",
        "params": {"audio_paths": [tone_wav], "output_dimension": 512, "normalize": True},
        "expected_count": 1,
    },
    {
        "id": 3,
        "name": "batch_1",
        "method": "embed_batch",
        "params": {
            "items": [{"ref": "tone-0", "kind": "audio", "audio_path": tone_wav}],
            "output_dimension": 512,
            "normalize": True,
        },
        "expected_count": 1,
    },
    {
        "id": 4,
        "name": "batch_4",
        "method": "embed_batch",
        "params": {
            "items": [{"ref": f"tone-{index}", "kind": "audio", "audio_path": tone_wav} for index in range(4)],
            "output_dimension": 512,
            "normalize": True,
        },
        "expected_count": 4,
    },
    {
        "id": 5,
        "name": "batch_16",
        "method": "embed_batch",
        "params": {
            "items": [{"ref": f"tone-{index}", "kind": "audio", "audio_path": tone_wav} for index in range(16)],
            "output_dimension": 512,
            "normalize": True,
        },
        "expected_count": 16,
    },
]

if not mock:
    requests.append(
        {
            "id": 6,
            "name": "silent_window",
            "method": "embed_audio",
            "params": {"audio_paths": [silence_wav], "output_dimension": 512, "normalize": True},
            "expected_error": "silent_window",
        }
    )

requests.append({"id": 99, "name": "shutdown", "method": "shutdown", "params": {}})

input_payload = "".join(
    json.dumps({"id": item["id"], "method": item["method"], "params": item.get("params", {})}) + "\n"
    for item in requests
)

proc = subprocess.Popen(
    args,
    cwd=repo_root,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    env=os.environ.copy(),
)

try:
    stdout, stderr = proc.communicate(input_payload, timeout=timeout_seconds)
except subprocess.TimeoutExpired:
    proc.kill()
    stdout, stderr = proc.communicate()
    raise SystemExit(f"CLAP worker smoke timed out after {timeout_seconds}s\nSTDERR:\n{stderr}\nSTDOUT:\n{stdout}")

if proc.returncode != 0:
    raise SystemExit(f"CLAP worker exited with {proc.returncode}\nSTDERR:\n{stderr}\nSTDOUT:\n{stdout}")

responses = {}
for line in stdout.splitlines():
    if not line.strip():
        continue
    response = json.loads(line)
    responses[response["id"]] = response

def decode_vector(vector_payload):
    if vector_payload["vector_encoding"] != "float32-le-base64":
        raise AssertionError(f"unexpected vector encoding: {vector_payload['vector_encoding']}")
    raw = base64.b64decode(vector_payload["vector"])
    expected_bytes = vector_payload["dimension"] * 4
    if len(raw) != expected_bytes:
        raise AssertionError(f"vector byte length mismatch: got {len(raw)}, expected {expected_bytes}")
    values = struct.unpack("<" + "f" * vector_payload["dimension"], raw)
    if not all(math.isfinite(value) for value in values):
        raise AssertionError("vector contains non-finite values")
    norm = math.sqrt(sum(value * value for value in values))
    if abs(norm - 1.0) > 0.001:
        raise AssertionError(f"vector is not normalized: norm={norm}")
    return norm

def require_ok(item):
    response = responses.get(item["id"])
    if response is None:
        raise AssertionError(f"missing response for {item['name']}")
    if not response.get("ok"):
        raise AssertionError(f"{item['name']} failed: {response.get('error')}")
    result = response["result"]
    vectors = result.get("vectors", [])
    if len(vectors) != item["expected_count"]:
        raise AssertionError(f"{item['name']} returned {len(vectors)} vectors, expected {item['expected_count']}")
    model = result.get("model") or {}
    if model.get("name") is None or model.get("output_dimension") != 512:
        raise AssertionError(f"{item['name']} missing model info: {model}")
    for vector in vectors:
        if vector.get("dimension") != 512:
            raise AssertionError(f"{item['name']} vector dimension mismatch: {vector.get('dimension')}")
        decode_vector(vector)
    metrics = result.get("metrics") or {}
    elapsed_ms = result.get("elapsed_ms")
    print(
        f"{item['name']}: device={model.get('device')} elapsed_ms={elapsed_ms} "
        f"peak_rss_mb={metrics.get('peak_rss_mb')} first_embed_peak_rss_mb={metrics.get('first_embed_peak_rss_mb')}"
    )

for item in requests:
    if item["name"] == "shutdown":
        shutdown = responses.get(item["id"])
        if shutdown is None or not shutdown.get("ok"):
            raise AssertionError(f"shutdown failed: {shutdown}")
        continue
    if "expected_error" in item:
        response = responses.get(item["id"])
        if response is None:
            raise AssertionError(f"missing response for {item['name']}")
        error = response.get("error") or {}
        if response.get("ok") or error.get("code") != item["expected_error"]:
            raise AssertionError(f"{item['name']} expected {item['expected_error']}, got {response}")
        print(f"{item['name']}: error={error.get('code')} elapsed_ms={response.get('elapsed_ms')}")
        continue
    require_ok(item)

print("CLAP smoke passed")
PY
