#!/usr/bin/env python3
"""JSONL worker for Marlin-2B caption/find inference.

The worker intentionally supports a deterministic --mock mode so the Node
connector, schema, and pipeline contracts can be tested without installing
PyTorch or downloading the model. Real model loading is lazy and happens only
when --mock is not set.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any

# Caption generation is never unbounded: when neither the request nor the
# worker configuration provides a limit, this hard default applies. It also
# accepts the provisional VOS_MARLIN_CAPTION_MAX_NEW_TOKENS environment
# override as a backward-compatible fallback (invalid / zero / negative
# values fall back to the safe default).
DEFAULT_CAPTION_MAX_NEW_TOKENS = 2048


@dataclass
class WorkerConfig:
    model: str
    device: str
    mock: bool
    caption_max_new_tokens: int | None = None
    caption_max_new_tokens_ceiling: int | None = None


def parse_positive_int_or_none(value: Any) -> int | None:
    """Return value as a positive int, or None when invalid/absent."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def resolve_auto_device(platform_name: str, mps_available: bool) -> str | None:
    """Pure device choice for device='auto'.

    Accelerate's 'auto' discovery can stall during initialization on Apple
    platforms; prefer an explicit MPS mapping when MPS is available. Every
    other platform keeps 'auto' so CUDA/CPU placement is unchanged.
    """
    if platform_name == "darwin" and mps_available:
        return "mps"
    return None


def probe_mps_available(torch_module: Any) -> bool:
    try:
        mps = getattr(getattr(torch_module, "backends", None), "mps", None)
        return bool(mps is not None and mps.is_available())
    except Exception:  # pragma: no cover - defensive fail-open probe
        return False


class MockMarlinModel:
    def caption(self, video_path: str, max_new_tokens: int | None = None) -> dict[str, Any]:
        _ = max_new_tokens
        basename = os.path.basename(video_path) or "source video"
        return {
            "scene": f"Mock Marlin scene for {basename}.",
            "caption": f"{basename} contains a visible action moment suitable for temporal analysis.",
            "events": [
                {
                    "start": 1.0,
                    "end": 3.5,
                    "description": f"{basename} establishes the main subject.",
                    "confidence": 0.72,
                },
                {
                    "start": 4.0,
                    "end": 6.25,
                    "description": f"{basename} reaches the strongest visible action.",
                    "confidence": 0.84,
                },
            ],
        }

    def find(self, video_path: str, event: str) -> dict[str, Any]:
        _ = video_path
        query = event.strip() or "strongest action moment"
        return {
            "query": query,
            "span": [4.0, 6.25],
            "format_ok": True,
            "confidence": 0.8,
        }


class RealMarlinModel:
    def __init__(self, config: WorkerConfig):
        try:
            import torch
            from transformers import AutoModelForCausalLM
        except Exception as exc:  # pragma: no cover - exercised only with optional deps
            raise RuntimeError(
                "Marlin dependencies are missing. Install python/requirements-marlin.txt "
                "or run the worker with --mock."
            ) from exc

        dtype = getattr(torch, "bfloat16", None)
        device_map: Any
        if config.device == "auto":
            resolved = resolve_auto_device(sys.platform, probe_mps_available(torch))
            device_map = {"": resolved} if resolved else "auto"
        else:
            device_map = {"": config.device}

        self._model = AutoModelForCausalLM.from_pretrained(
            config.model,
            trust_remote_code=True,
            dtype=dtype,
            device_map=device_map,
        )

    def caption(self, video_path: str, max_new_tokens: int | None = None) -> dict[str, Any]:  # pragma: no cover
        kwargs: dict[str, Any] = {"video_path": video_path}
        if max_new_tokens is not None:
            kwargs["max_new_tokens"] = max_new_tokens
        # A TypeError here (e.g. a model without a generation-limit kwarg)
        # surfaces as a request error and flows into the caller's existing
        # optional/degraded path; it must never retry unbounded.
        result = self._model.caption(**kwargs)
        return result if isinstance(result, dict) else {"caption": str(result), "events": []}

    def find(self, video_path: str, event: str) -> dict[str, Any]:  # pragma: no cover
        result = self._model.find(video_path, event=event)
        if isinstance(result, dict):
            return {"query": event, **result}
        return {"query": event, "span": result, "format_ok": True}


def build_model(config: WorkerConfig):
    if config.mock:
        return MockMarlinModel()
    return RealMarlinModel(config)


def write_response(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def effective_caption_max_new_tokens(
    requested: Any,
    config_value: int | None,
    ceiling: int | None = None,
) -> int:
    """Request override → worker config → hard default, always clamped.

    A missing or invalid policy ceiling falls back to the hard default as
    the ceiling, so a direct worker launch without --caption-max-new-tokens-max
    can never pass an unbounded request/config value through to the model.
    """
    resolved = (
        parse_positive_int_or_none(requested)
        or (config_value if config_value is not None else None)
        or DEFAULT_CAPTION_MAX_NEW_TOKENS
    )
    limit = parse_positive_int_or_none(ceiling) or DEFAULT_CAPTION_MAX_NEW_TOKENS
    return min(resolved, limit)


def handle_request(model: Any, request: dict[str, Any], config: WorkerConfig) -> dict[str, Any]:
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}

    if method == "caption":
        result = model.caption(
            str(params.get("video_path", "")),
            max_new_tokens=effective_caption_max_new_tokens(
                params.get("max_new_tokens"),
                config.caption_max_new_tokens,
                config.caption_max_new_tokens_ceiling,
            ),
        )
        return {"id": request_id, "ok": True, "result": result}

    if method == "find":
        result = model.find(str(params.get("video_path", "")), str(params.get("event", "")))
        return {"id": request_id, "ok": True, "result": result}

    if method == "shutdown":
        return {"id": request_id, "ok": True, "result": {"shutdown": True}}

    return {"id": request_id, "ok": False, "error": f"unknown method: {method}"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Marlin-2B JSONL worker")
    parser.add_argument("--model", default=os.environ.get("VOS_MARLIN_MODEL", "NemoStation/Marlin-2B"))
    parser.add_argument("--device", default=os.environ.get("VOS_MARLIN_DEVICE", "auto"))
    parser.add_argument(
        "--caption-max-new-tokens",
        default=os.environ.get("VOS_MARLIN_CAPTION_MAX_NEW_TOKENS"),
        help="Hard cap on generated caption tokens; falls back to the safe default when invalid.",
    )
    parser.add_argument(
        "--caption-max-new-tokens-max",
        help="Policy ceiling clamping every caption token bound (request, default, or hard default).",
    )
    parser.add_argument("--mock", action="store_true", default=os.environ.get("VOS_MARLIN_MOCK") == "1")
    args = parser.parse_args()

    config = WorkerConfig(
        model=args.model,
        device=args.device,
        mock=args.mock,
        caption_max_new_tokens=parse_positive_int_or_none(args.caption_max_new_tokens),
        caption_max_new_tokens_ceiling=parse_positive_int_or_none(args.caption_max_new_tokens_max),
    )
    model = build_model(config)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request: Any = None
        try:
            request = json.loads(line)
            response = handle_request(model, request, config)
            write_response(response)
            if request.get("method") == "shutdown":
                return 0
        except Exception as exc:
            request_id = request.get("id") if isinstance(request, dict) else None
            write_response({"id": request_id, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
