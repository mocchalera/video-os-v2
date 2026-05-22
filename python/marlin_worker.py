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


@dataclass
class WorkerConfig:
    model: str
    device: str
    mock: bool


class MockMarlinModel:
    def caption(self, video_path: str) -> dict[str, Any]:
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
            device_map = "auto"
        else:
            device_map = {"": config.device}

        self._model = AutoModelForCausalLM.from_pretrained(
            config.model,
            trust_remote_code=True,
            dtype=dtype,
            device_map=device_map,
        )

    def caption(self, video_path: str) -> dict[str, Any]:  # pragma: no cover
        result = self._model.caption(video_path)
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


def handle_request(model: Any, request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}

    if method == "caption":
        result = model.caption(str(params.get("video_path", "")))
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
    parser.add_argument("--mock", action="store_true", default=os.environ.get("VOS_MARLIN_MOCK") == "1")
    args = parser.parse_args()

    config = WorkerConfig(model=args.model, device=args.device, mock=args.mock)
    model = build_model(config)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(model, request)
            write_response(response)
            if request.get("method") == "shutdown":
                return 0
        except Exception as exc:
            write_response({"id": None, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
