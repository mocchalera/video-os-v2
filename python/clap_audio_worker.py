#!/usr/bin/env python3
"""JSONL worker for local CLAP text/audio embedding inference.

The worker loads LAION CLAP lazily and uses local-files-only Hugging Face
settings. A missing cache or optional dependency is reported as a structured
JSONL error so the TypeScript connector can fail open or surface setup steps.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "laion/clap-htsat-fused"
DEFAULT_CACHE_DIR = "~/.cache/video-os-v2/clap"
RUNNER_NAME = "python-clap-audio-worker"
RUNNER_VERSION = "clap-audio-worker-v1"
VECTOR_ENCODING = "float32-le-base64"
DEFAULT_OUTPUT_DIMENSION = 512
MAX_OUTPUT_DIMENSION = 512
DEFAULT_PREPROCESS_VERSION = "clap-audio-window-v1"
ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac"}
SILENCE_RMS_THRESHOLD = 1e-5
SILENCE_PEAK_THRESHOLD = 1e-5


class WorkerError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    def to_payload(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


@dataclass
class WorkerConfig:
    model: str
    device: str
    cache_dir: str
    mock: bool


@dataclass
class EmbedRecord:
    ref: str
    kind: str
    payload: str


class MockClapEmbedder:
    def __init__(self, model_name: str, device: str):
        self.model_name = model_name
        self.device = device

    def encode(
        self,
        records: list[EmbedRecord],
        *,
        output_dimension: int,
        normalize: bool,
    ) -> list[list[float]]:
        return [mock_vector({"kind": record.kind, "payload": record.payload}, output_dimension, normalize) for record in records]


class ClapAudioWorker:
    def __init__(self, config: WorkerConfig):
        self.config = config
        self.model: Any | None = MockClapEmbedder(config.model, "mock") if config.mock else None
        self.processor: Any | None = None
        self.resolved_device = "mock" if config.mock else ""
        self.precision = "mock" if config.mock else ""
        self.model_revision = "mock" if config.mock else "unknown"
        self.peak_rss_mb: float | None = current_rss_mb()
        self.first_embed_peak_reported = False
        self.warned_cpu_fallback = False

    def embed_text(self, params: dict[str, Any]) -> dict[str, Any]:
        texts = expect_string_list(params.get("texts"), "texts")
        records = [EmbedRecord(str(index), "text", text) for index, text in enumerate(texts)]
        return self.embed_records(records, params)

    def embed_audio(self, params: dict[str, Any]) -> dict[str, Any]:
        audio_paths = expect_string_list(params.get("audio_paths"), "audio_paths")
        records = [
            EmbedRecord(str(index), "audio", validate_audio_path(path))
            for index, path in enumerate(audio_paths)
        ]
        return self.embed_records(records, params)

    def embed_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        items = expect_items(params.get("items"))
        records: list[EmbedRecord] = []
        for index, item in enumerate(items):
            kind = expect_non_empty_string(item.get("kind"), f"items[{index}].kind")
            ref = str(item.get("ref") or index)
            if kind == "text":
                text = expect_non_empty_string(item.get("text"), f"items[{index}].text")
                records.append(EmbedRecord(ref, "text", text))
            elif kind == "audio":
                audio_path = validate_audio_path(item.get("audio_path"))
                records.append(EmbedRecord(ref, "audio", audio_path))
            else:
                raise WorkerError("invalid_input", f"unsupported embed_batch item kind: {kind}")
        return self.embed_records(records, params)

    def embed_records(self, records: list[EmbedRecord], params: dict[str, Any]) -> dict[str, Any]:
        if not records:
            raise WorkerError("invalid_input", "embedding request must include at least one item")

        output_dimension = parse_output_dimension(params.get("output_dimension", DEFAULT_OUTPUT_DIMENSION))
        normalize = bool(params.get("normalize", True))
        preprocess_version = str(params.get("preprocess_version") or DEFAULT_PREPROCESS_VERSION)

        self.ensure_model()
        self.record_rss()

        assert self.model is not None
        if isinstance(self.model, MockClapEmbedder):
            embeddings = self.model.encode(records, output_dimension=output_dimension, normalize=normalize)
        else:
            embeddings = self.encode_real(records)

        encoded_vectors = []
        for record, embedding in zip(records, embeddings):
            vector = prepare_vector(embedding, output_dimension, normalize)
            encoded_vectors.append(
                {
                    "ref": record.ref,
                    "vector": encode_float32_le_base64(vector),
                    "vector_encoding": VECTOR_ENCODING,
                    "dimension": output_dimension,
                    "normalized": vector_is_normalized(vector) if normalize else False,
                }
            )

        self.record_rss()
        metrics: dict[str, float] = {}
        if self.peak_rss_mb is not None:
            metrics["peak_rss_mb"] = round(self.peak_rss_mb, 1)
            if not self.first_embed_peak_reported:
                metrics["first_embed_peak_rss_mb"] = round(self.peak_rss_mb, 1)
                self.first_embed_peak_reported = True
        current_rss = current_rss_mb()
        if current_rss is not None:
            metrics["rss_mb"] = round(current_rss, 1)

        return {
            "vectors": encoded_vectors,
            "model": self.model_info(output_dimension, preprocess_version),
            "metrics": metrics,
        }

    def ensure_model(self) -> None:
        if self.model is not None:
            return

        try:
            import librosa  # noqa: F401
            import psutil  # noqa: F401
            import soundfile  # noqa: F401
            import torch
            from transformers import ClapModel, ClapProcessor
        except Exception as exc:
            raise WorkerError(
                "dependency_missing",
                "CLAP dependencies are missing. Run: python3 -m pip install -r python/requirements-clap.txt",
                retryable=False,
            ) from exc

        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        cache_dir = os.path.expanduser(self.config.cache_dir)
        Path(cache_dir).mkdir(parents=True, exist_ok=True)

        requested = self.config.device
        self.resolved_device = self.resolve_device(torch)
        self.precision = "fp32"

        try:
            self.processor, self.model = self.load_real_model(ClapModel, ClapProcessor, cache_dir, self.resolved_device)
        except Exception as exc:
            if requested == "auto" and self.resolved_device == "mps" and is_mps_error(str(exc).lower()):
                print("[clap] warning: MPS model load failed; falling back to CPU", file=sys.stderr, flush=True)
                self.resolved_device = "cpu"
                try:
                    self.processor, self.model = self.load_real_model(ClapModel, ClapProcessor, cache_dir, self.resolved_device)
                except Exception as cpu_exc:
                    raise map_model_load_error(cpu_exc, self.config.model, cache_dir) from cpu_exc
            else:
                raise map_model_load_error(exc, self.config.model, cache_dir) from exc

        self.model_revision = detect_model_revision(self.model)

    def load_real_model(self, model_cls: Any, processor_cls: Any, cache_dir: str, device: str) -> tuple[Any, Any]:
        processor = processor_cls.from_pretrained(
            self.config.model,
            cache_dir=cache_dir,
            local_files_only=True,
        )
        model = model_cls.from_pretrained(
            self.config.model,
            cache_dir=cache_dir,
            local_files_only=True,
        )
        model.to(device)
        model.eval()
        return processor, model

    def resolve_device(self, torch: Any) -> str:
        requested = self.config.device
        if requested not in {"auto", "mps", "cpu"}:
            raise WorkerError("invalid_input", "--device must be one of: auto, mps, cpu")
        mps_available = bool(
            hasattr(torch, "backends")
            and hasattr(torch.backends, "mps")
            and torch.backends.mps.is_available()
        )
        if requested == "mps":
            if not mps_available:
                raise WorkerError(
                    "mps_unavailable",
                    "MPS device was requested but torch.backends.mps.is_available() is false",
                    retryable=True,
                )
            return "mps"
        if requested == "cpu":
            return "cpu"
        if mps_available:
            return "mps"
        if not self.warned_cpu_fallback:
            print("[clap] warning: MPS unavailable; falling back to CPU", file=sys.stderr, flush=True)
            self.warned_cpu_fallback = True
        return "cpu"

    def encode_real(self, records: list[EmbedRecord]) -> list[Any]:
        assert self.model is not None
        assert self.processor is not None

        try:
            embeddings: list[Any | None] = [None] * len(records)
            text_indices = [index for index, record in enumerate(records) if record.kind == "text"]
            audio_indices = [index for index, record in enumerate(records) if record.kind == "audio"]

            if text_indices:
                texts = [records[index].payload for index in text_indices]
                inputs = self.processor(text=texts, padding=True, return_tensors="pt")
                inputs = batch_to_device(inputs, self.resolved_device)
                with torch_no_grad():
                    features = self.model.get_text_features(**inputs)
                for index, vector in zip(text_indices, tensor_to_rows(features)):
                    embeddings[index] = vector

            if audio_indices:
                target_sample_rate = processor_sample_rate(self.processor)
                audios = [load_audio_file(records[index].payload, target_sample_rate) for index in audio_indices]
                inputs = self.processor(audio=audios, sampling_rate=target_sample_rate, return_tensors="pt", padding=True)
                inputs = batch_to_device(inputs, self.resolved_device)
                with torch_no_grad():
                    features = self.model.get_audio_features(**inputs)
                for index, vector in zip(audio_indices, tensor_to_rows(features)):
                    embeddings[index] = vector

            if any(embedding is None for embedding in embeddings):
                raise WorkerError("invalid_input", "failed to encode every requested item")
            return list(embeddings)
        except WorkerError:
            raise
        except Exception as exc:
            raise map_inference_error(exc) from exc

    def record_rss(self) -> None:
        rss = current_rss_mb()
        if rss is not None:
            self.peak_rss_mb = max(self.peak_rss_mb or 0.0, rss)

    def model_info(self, output_dimension: int, preprocess_version: str) -> dict[str, Any]:
        return {
            "name": self.config.model,
            "model_revision": self.model_revision,
            "output_dimension": output_dimension,
            "preprocess_version": preprocess_version,
            "runner_name": RUNNER_NAME,
            "runner_version": RUNNER_VERSION,
            "precision": self.precision or "unknown",
            "device": self.resolved_device or self.config.device,
            "distance_metric": "cosine",
        }


def torch_no_grad() -> Any:
    import torch

    return torch.no_grad()


def batch_to_device(batch: Any, device: str) -> Any:
    if hasattr(batch, "to"):
        return batch.to(device)
    return {key: value.to(device) if hasattr(value, "to") else value for key, value in batch.items()}


def processor_sample_rate(processor: Any) -> int:
    feature_extractor = getattr(processor, "feature_extractor", None)
    sample_rate = getattr(feature_extractor, "sampling_rate", None)
    try:
        parsed = int(sample_rate)
        return parsed if parsed > 0 else 48000
    except Exception:
        return 48000


def tensor_to_rows(value: Any) -> list[Any]:
    if hasattr(value, "pooler_output"):
        value = value.pooler_output
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "float"):
        value = value.float()
    if hasattr(value, "tolist"):
        rows = value.tolist()
    else:
        rows = list(value)
    if rows and not isinstance(rows[0], list):
        return [rows]
    return rows


def load_audio_file(audio_path: str, target_sample_rate: int) -> Any:
    try:
        import librosa
        import numpy as np
        import soundfile as sf
    except Exception as exc:
        raise WorkerError(
            "dependency_missing",
            "Audio decode dependencies are missing. Run: python3 -m pip install -r python/requirements-clap.txt",
        ) from exc

    try:
        try:
            data, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
        except Exception:
            data, sample_rate = librosa.load(audio_path, sr=None, mono=True)
        data = np.asarray(data, dtype=np.float32)
        if data.ndim == 2:
            data = data.mean(axis=1)
        if data.ndim != 1 or data.size == 0:
            raise WorkerError("audio_decode_failed", f"audio file contains no decodable mono samples: {audio_path}")
        if not np.all(np.isfinite(data)):
            raise WorkerError("audio_decode_failed", f"audio file contains non-finite samples: {audio_path}")

        peak = float(np.max(np.abs(data)))
        rms = float(np.sqrt(np.mean(np.square(data, dtype=np.float64))))
        if rms <= SILENCE_RMS_THRESHOLD or peak <= SILENCE_PEAK_THRESHOLD:
            raise WorkerError("silent_window", f"audio window is silent or near-silent: {audio_path}")

        sample_rate = int(sample_rate)
        if sample_rate != target_sample_rate:
            data = librosa.resample(data, orig_sr=sample_rate, target_sr=target_sample_rate)
            data = np.asarray(data, dtype=np.float32)
        return data
    except WorkerError:
        raise
    except Exception as exc:
        raise WorkerError("audio_decode_failed", f"failed to decode audio file: {audio_path}: {exc}") from exc


def map_model_load_error(exc: Exception, model_name: str, cache_dir: str) -> WorkerError:
    message = str(exc)
    lowered = message.lower()
    if is_oom_message(lowered):
        return WorkerError("oom", f"CLAP model load ran out of memory: {message}", retryable=True)
    if is_mps_error(lowered):
        return WorkerError("mps_unavailable", f"CLAP model load failed on MPS: {message}", retryable=True)
    if any(
        token in lowered
        for token in [
            "local_files_only",
            "cannot find",
            "couldn't find",
            "not found",
            "does not appear to have",
            "offline",
            "not a local folder",
            "no such file",
        ]
    ):
        return WorkerError(
            "model_not_found",
            "CLAP model weights are not available locally. "
            f"The worker will not download weights. Warm the cache explicitly, for example: "
            f"HF_HOME={cache_dir!r} huggingface-cli download {model_name!r}; "
            f"or pass --model /absolute/path/to/clap snapshot.",
            retryable=False,
        )
    return WorkerError("model_not_found", f"failed to load CLAP model from local cache: {message}")


def map_inference_error(exc: Exception) -> WorkerError:
    message = str(exc)
    lowered = message.lower()
    if is_oom_message(lowered):
        return WorkerError("oom", f"CLAP inference ran out of memory: {message}", retryable=True)
    if is_mps_error(lowered):
        return WorkerError("mps_unavailable", f"CLAP inference failed on MPS: {message}", retryable=True)
    return WorkerError("invalid_input", f"CLAP inference failed: {message}")


def is_oom_message(message: str) -> bool:
    return "out of memory" in message or "mps backend out of memory" in message or "allocate memory" in message


def is_mps_error(message: str) -> bool:
    return "mps" in message and (
        "not implemented" in message
        or "unsupported" in message
        or "unavailable" in message
        or "placeholder storage" in message
    )


def expect_string_list(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise WorkerError("invalid_input", f"{field_name} must be a non-empty array")
    result: list[str] = []
    for index, item in enumerate(value):
        result.append(expect_non_empty_string(item, f"{field_name}[{index}]"))
    return result


def expect_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise WorkerError("invalid_input", "items must be a non-empty array")
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise WorkerError("invalid_input", f"items[{index}] must be an object")
        result.append(item)
    return result


def expect_non_empty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkerError("invalid_input", f"{field_name} must be a non-empty string")
    return value


def validate_audio_path(value: Any) -> str:
    audio_path = expect_non_empty_string(value, "audio_path")
    path = Path(audio_path)
    if not path.is_absolute():
        raise WorkerError("invalid_input", f"audio_path must be absolute: {audio_path}")
    if path.suffix.lower() not in ALLOWED_AUDIO_EXTENSIONS:
        raise WorkerError("invalid_input", "audio_path must have one of these extensions: .wav, .mp3, .flac")
    if not path.is_file():
        raise WorkerError("source_audio_missing", f"audio_path does not exist or is not a file: {audio_path}")
    return str(path)


def parse_output_dimension(value: Any) -> int:
    try:
        dimension = int(value)
    except Exception as exc:
        raise WorkerError("invalid_input", "output_dimension must be an integer") from exc
    if dimension < 1 or dimension > MAX_OUTPUT_DIMENSION:
        raise WorkerError("invalid_input", f"output_dimension must be between 1 and {MAX_OUTPUT_DIMENSION}")
    return dimension


def prepare_vector(embedding: Any, output_dimension: int, normalize: bool) -> list[float]:
    values = [float(value) for value in embedding]
    if len(values) < output_dimension:
        raise WorkerError(
            "invalid_input",
            f"model returned {len(values)} dimensions, fewer than requested output_dimension={output_dimension}",
        )
    if len(values) > output_dimension:
        values = values[:output_dimension]
    if not all(math.isfinite(value) for value in values):
        raise WorkerError("invalid_input", "model returned non-finite vector values")
    if normalize:
        norm = math.sqrt(sum(value * value for value in values))
        if not math.isfinite(norm) or norm <= 0:
            raise WorkerError("invalid_input", "model returned a zero or non-finite vector")
        values = [value / norm for value in values]
        if not vector_is_normalized(values):
            raise WorkerError("invalid_input", "normalized vector failed L2 norm verification")
    return values


def vector_is_normalized(vector: list[float]) -> bool:
    norm = math.sqrt(sum(value * value for value in vector))
    return abs(norm - 1.0) <= 0.001


def encode_float32_le_base64(vector: list[float]) -> str:
    import struct

    payload = struct.pack("<" + "f" * len(vector), *vector)
    return base64.b64encode(payload).decode("ascii")


def current_rss_mb() -> float | None:
    try:
        import psutil

        return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
    except Exception:
        return None


def detect_model_revision(model: Any) -> str:
    config = getattr(model, "config", None)
    commit_hash = getattr(config, "_commit_hash", None)
    if commit_hash:
        return str(commit_hash)
    return "local-cache"


def mock_vector(seed_payload: Any, dimension: int, normalize: bool) -> list[float]:
    seed_json = json.dumps(seed_payload, ensure_ascii=False, sort_keys=True, default=str)
    state = int.from_bytes(hashlib.sha256(seed_json.encode("utf-8")).digest()[:8], "little") or 1
    values: list[float] = []
    for _ in range(dimension):
        state ^= (state << 13) & 0xFFFFFFFFFFFFFFFF
        state ^= state >> 7
        state ^= (state << 17) & 0xFFFFFFFFFFFFFFFF
        unit = (state & 0xFFFFFFFF) / 0xFFFFFFFF
        values.append(unit * 2.0 - 1.0)
    if normalize:
        norm = math.sqrt(sum(value * value for value in values))
        values = [value / norm for value in values]
    return values


def write_response(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def handle_request(worker: ClapAudioWorker, request: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    try:
        if method == "embed_text":
            result = worker.embed_text(params)
        elif method == "embed_audio":
            result = worker.embed_audio(params)
        elif method == "embed_batch":
            result = worker.embed_batch(params)
        elif method == "shutdown":
            result = {"shutdown": True}
        else:
            raise WorkerError("invalid_input", f"unknown method: {method}")
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        result["elapsed_ms"] = elapsed_ms
        return {"id": request_id, "ok": True, "result": result}
    except WorkerError as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {"id": request_id, "ok": False, "error": exc.to_payload(), "elapsed_ms": elapsed_ms}
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        error = WorkerError("invalid_input", str(exc))
        return {"id": request_id, "ok": False, "error": error.to_payload(), "elapsed_ms": elapsed_ms}


def main() -> int:
    parser = argparse.ArgumentParser(description="CLAP audio embedding JSONL worker")
    parser.add_argument("--model", default=os.environ.get("VOS_CLAP_MODEL", DEFAULT_MODEL))
    parser.add_argument("--device", default=os.environ.get("VOS_CLAP_DEVICE", "auto"))
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("VOS_CLAP_CACHE_DIR", DEFAULT_CACHE_DIR),
    )
    parser.add_argument("--mock", action="store_true", default=os.environ.get("VOS_CLAP_MOCK") == "1")
    args = parser.parse_args()

    config = WorkerConfig(
        model=args.model,
        device=args.device,
        cache_dir=os.path.expanduser(args.cache_dir),
        mock=args.mock,
    )
    worker = ClapAudioWorker(config)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise WorkerError("invalid_input", "request must be a JSON object")
            response = handle_request(worker, request)
            write_response(response)
            if request.get("method") == "shutdown":
                return 0
        except WorkerError as exc:
            write_response({"id": None, "ok": False, "error": exc.to_payload(), "elapsed_ms": 0})
        except Exception as exc:
            error = WorkerError("invalid_input", f"invalid JSONL request: {exc}")
            write_response({"id": None, "ok": False, "error": error.to_payload(), "elapsed_ms": 0})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
