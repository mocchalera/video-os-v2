#!/usr/bin/env python3
"""JSONL worker for local Qwen3-VL embedding inference.

The worker intentionally loads the model lazily and with local-files-only
settings. A missing cache or optional dependency is reported as a structured
JSONL error so the TypeScript side can fail open or surface setup instructions.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import inspect
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "Qwen/Qwen3-VL-Embedding-2B"
DEFAULT_CACHE_DIR = "~/.cache/video-os-v2/qwen3vl"
DEFAULT_INSTRUCTION = "Retrieve relevant video footage for editing."
RUNNER_NAME = "python-qwen3vl-worker"
RUNNER_VERSION = "qwen3vl-worker-v1"
VECTOR_ENCODING = "float32-le-base64"
MAX_OUTPUT_DIMENSION = 2048
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


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
    payload: Any


class MockQwen3VlEmbedder:
    def __init__(self, model_name: str, device: str):
        self.model_name = model_name
        self.device = device

    def encode(
        self,
        inputs: list[Any],
        *,
        output_dimension: int,
        normalize: bool,
    ) -> list[list[float]]:
        vectors: list[list[float]] = []
        for item in inputs:
            vectors.append(mock_vector(item, output_dimension, normalize))
        return vectors


class Qwen3VlEmbeddingWorker:
    def __init__(self, config: WorkerConfig):
        self.config = config
        self.model: Any | None = MockQwen3VlEmbedder(config.model, "mock") if config.mock else None
        self.resolved_device = "mock" if config.mock else ""
        self.precision = "mock" if config.mock else ""
        self.model_revision = "mock" if config.mock else "unknown"
        self.peak_rss_mb: float | None = current_rss_mb()
        self.first_embed_peak_reported = False
        self.warned_cpu_fallback = False

    def embed_text(self, params: dict[str, Any]) -> dict[str, Any]:
        texts = expect_string_list(params.get("texts"), "texts")
        records = [EmbedRecord(str(index), text) for index, text in enumerate(texts)]
        return self.embed_records(records, params)

    def embed_image(self, params: dict[str, Any]) -> dict[str, Any]:
        image_paths = expect_string_list(params.get("image_paths"), "image_paths")
        records = [
            EmbedRecord(str(index), {"image": validate_image_path(path)})
            for index, path in enumerate(image_paths)
        ]
        return self.embed_records(records, params)

    def embed_mixed(self, params: dict[str, Any]) -> dict[str, Any]:
        items = expect_items(params.get("items"))
        records: list[EmbedRecord] = []
        for index, item in enumerate(items):
            text = expect_non_empty_string(item.get("text"), f"items[{index}].text")
            image_path = validate_image_path(item.get("image_path"))
            ref = str(item.get("ref") or index)
            records.append(EmbedRecord(ref, {"text": text, "image": image_path}))
        return self.embed_records(records, params)

    def embed_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        items = expect_items(params.get("items"))
        records: list[EmbedRecord] = []
        for index, item in enumerate(items):
            kind = expect_non_empty_string(item.get("kind"), f"items[{index}].kind")
            ref = str(item.get("ref") or index)
            if kind == "text":
                text = expect_non_empty_string(item.get("text"), f"items[{index}].text")
                records.append(EmbedRecord(ref, text))
            elif kind == "image":
                image_path = validate_image_path(item.get("image_path"))
                records.append(EmbedRecord(ref, {"image": image_path}))
            elif kind == "mixed":
                text = expect_non_empty_string(item.get("text"), f"items[{index}].text")
                image_path = validate_image_path(item.get("image_path"))
                records.append(EmbedRecord(ref, {"text": text, "image": image_path}))
            else:
                raise WorkerError("invalid_input", f"unsupported embed_batch item kind: {kind}")
        return self.embed_records(records, params)

    def embed_records(self, records: list[EmbedRecord], params: dict[str, Any]) -> dict[str, Any]:
        if not records:
            raise WorkerError("invalid_input", "embedding request must include at least one item")

        instruction = str(params.get("instruction") or DEFAULT_INSTRUCTION)
        output_dimension = parse_output_dimension(params.get("output_dimension", MAX_OUTPUT_DIMENSION))
        normalize = bool(params.get("normalize", True))
        preprocess_version = str(params.get("preprocess_version") or "")

        self.ensure_model()
        self.record_rss()

        assert self.model is not None
        payloads = [record.payload for record in records]
        if isinstance(self.model, MockQwen3VlEmbedder):
            embeddings = self.model.encode(payloads, output_dimension=output_dimension, normalize=normalize)
        else:
            embeddings = self.encode_real(payloads, instruction, output_dimension, normalize)

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
            "model": self.model_info(output_dimension, instruction, preprocess_version),
            "metrics": metrics,
        }

    def ensure_model(self) -> None:
        if self.model is not None:
            return

        try:
            import torch
            import psutil  # noqa: F401
            from sentence_transformers import SentenceTransformer
        except Exception as exc:
            raise WorkerError(
                "dependency_missing",
                "Qwen3-VL dependencies are missing. Run: python3 -m pip install -r python/requirements-qwen3vl.txt",
                retryable=False,
            ) from exc

        self.resolved_device = self.resolve_device(torch)
        self.precision = "fp16" if self.resolved_device == "mps" else "fp32"

        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        cache_dir = os.path.expanduser(self.config.cache_dir)
        Path(cache_dir).mkdir(parents=True, exist_ok=True)

        try:
            kwargs = build_sentence_transformer_kwargs(SentenceTransformer, cache_dir, self.resolved_device, torch)
            self.model = SentenceTransformer(self.config.model, **kwargs)
            self.model_revision = detect_model_revision(self.model)
        except WorkerError:
            raise
        except Exception as exc:
            raise map_model_load_error(exc, self.config.model, cache_dir) from exc

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
            print("[qwen3vl] warning: MPS unavailable; falling back to CPU", file=sys.stderr, flush=True)
            self.warned_cpu_fallback = True
        return "cpu"

    def encode_real(
        self,
        payloads: list[Any],
        instruction: str,
        output_dimension: int,
        normalize: bool,
    ) -> list[Any]:
        assert self.model is not None
        try:
            encode_signature = inspect.signature(self.model.encode)
            encode_kwargs: dict[str, Any] = {
                "convert_to_numpy": True,
                "show_progress_bar": False,
                # Normalize in prepare_vector using Python floats; MPS fp16 model-side
                # normalization can produce NaNs for longer text payloads.
                "normalize_embeddings": False,
            }
            if "prompt" in encode_signature.parameters:
                encode_kwargs["prompt"] = instruction
            if "truncate_dim" in encode_signature.parameters:
                encode_kwargs["truncate_dim"] = output_dimension
            if "batch_size" in encode_signature.parameters:
                encode_kwargs["batch_size"] = 1
            result = self.model.encode(payloads, **encode_kwargs)
            return result.tolist() if hasattr(result, "tolist") else list(result)
        except Exception as exc:
            raise map_inference_error(exc) from exc

    def record_rss(self) -> None:
        rss = current_rss_mb()
        if rss is not None:
            self.peak_rss_mb = max(self.peak_rss_mb or 0.0, rss)

    def model_info(self, output_dimension: int, instruction: str, preprocess_version: str) -> dict[str, Any]:
        return {
            "name": self.config.model,
            "model_revision": self.model_revision,
            "output_dimension": output_dimension,
            "instruction": instruction,
            "preprocess_version": preprocess_version,
            "runner_name": RUNNER_NAME,
            "runner_version": RUNNER_VERSION,
            "precision": self.precision or "unknown",
            "device": self.resolved_device or self.config.device,
            "distance_metric": "cosine",
        }


def build_sentence_transformer_kwargs(
    sentence_transformer_cls: Any,
    cache_dir: str,
    device: str,
    torch: Any,
) -> dict[str, Any]:
    params = inspect.signature(sentence_transformer_cls).parameters
    kwargs: dict[str, Any] = {}
    if "cache_folder" in params:
        kwargs["cache_folder"] = cache_dir
    if "device" in params:
        kwargs["device"] = device
    if "trust_remote_code" in params:
        kwargs["trust_remote_code"] = True
    if "local_files_only" in params:
        kwargs["local_files_only"] = True
    if "model_kwargs" in params:
        model_kwargs: dict[str, Any] = {"local_files_only": True}
        if device == "mps":
            model_kwargs["torch_dtype"] = torch.float16
        kwargs["model_kwargs"] = model_kwargs
    return kwargs


def map_model_load_error(exc: Exception, model_name: str, cache_dir: str) -> WorkerError:
    message = str(exc)
    lowered = message.lower()
    if is_oom_message(lowered):
        return WorkerError("oom", f"Qwen3-VL model load ran out of memory: {message}", retryable=True)
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
            "Qwen3-VL model weights are not available locally. "
            f"The worker will not download weights. Warm the cache explicitly, for example: "
            f"HF_HOME={cache_dir!r} huggingface-cli download {model_name!r}; "
            f"or pass --model /absolute/path/to/Qwen3-VL-Embedding-2B.",
            retryable=False,
        )
    return WorkerError("model_not_found", f"failed to load Qwen3-VL model from local cache: {message}")


def map_inference_error(exc: Exception) -> WorkerError:
    message = str(exc)
    lowered = message.lower()
    if is_oom_message(lowered):
        return WorkerError("oom", f"Qwen3-VL inference ran out of memory: {message}", retryable=True)
    return WorkerError("invalid_input", f"Qwen3-VL inference failed: {message}")


def is_oom_message(message: str) -> bool:
    return "out of memory" in message or "mps backend out of memory" in message or "allocate memory" in message


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


def validate_image_path(value: Any) -> str:
    image_path = expect_non_empty_string(value, "image_path")
    path = Path(image_path)
    if not path.is_absolute():
        raise WorkerError("invalid_input", f"image_path must be absolute: {image_path}")
    if path.suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
        raise WorkerError("invalid_input", f"image_path must have one of these extensions: .jpg, .jpeg, .png, .webp")
    if not path.is_file():
        raise WorkerError("invalid_input", f"image_path does not exist or is not a file: {image_path}")
    try:
        from PIL import Image

        with Image.open(path) as image:
            image.verify()
    except ImportError as exc:
        raise WorkerError(
            "dependency_missing",
            "Pillow is missing. Run: python3 -m pip install -r python/requirements-qwen3vl.txt",
        ) from exc
    except Exception as exc:
        raise WorkerError("invalid_input", f"image_path is not a readable image: {image_path}") from exc
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
    for module in getattr(model, "_modules", {}).values():
        auto_model = getattr(module, "auto_model", None)
        config = getattr(auto_model, "config", None)
        commit_hash = getattr(config, "_commit_hash", None)
        if commit_hash:
            return str(commit_hash)
    for attr in ("model_card_data",):
        value = getattr(model, attr, None)
        revision = getattr(value, "model_revision", None)
        if revision:
            return str(revision)
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


def handle_request(worker: Qwen3VlEmbeddingWorker, request: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    try:
        if method == "embed_text":
            result = worker.embed_text(params)
        elif method == "embed_image":
            result = worker.embed_image(params)
        elif method == "embed_mixed":
            result = worker.embed_mixed(params)
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
    parser = argparse.ArgumentParser(description="Qwen3-VL embedding JSONL worker")
    parser.add_argument("--model", default=os.environ.get("VOS_QWEN3VL_MODEL", DEFAULT_MODEL))
    parser.add_argument("--device", default=os.environ.get("VOS_QWEN3VL_DEVICE", "auto"))
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("VOS_QWEN3VL_CACHE_DIR", DEFAULT_CACHE_DIR),
    )
    parser.add_argument("--mock", action="store_true", default=os.environ.get("VOS_QWEN3VL_MOCK") == "1")
    args = parser.parse_args()

    config = WorkerConfig(
        model=args.model,
        device=args.device,
        cache_dir=os.path.expanduser(args.cache_dir),
        mock=args.mock,
    )
    worker = Qwen3VlEmbeddingWorker(config)

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
