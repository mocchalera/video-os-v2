#!/usr/bin/env python3
"""
Video OS — Pyannote Speaker Diarization Bridge

Communicates with the TypeScript orchestrator via stdin/stdout JSON protocol.
Same pattern as runtime/handoff/otio-bridge.py.

Handles:
  - diarize: audio file → speaker turns [{ speaker_id, start, end }]

Dependencies:
  - pyannote.audio (pip install pyannote.audio)
  - Hugging Face token with pyannote model access
"""

import sys
import os
import io
import json
import hashlib
import platform
from pathlib import Path

BRIDGE_VERSION = "1.0.0"


def get_script_hash() -> str:
    """SHA-256 hash of this bridge script file."""
    content = Path(__file__).read_bytes()
    return "sha256:" + hashlib.sha256(content).hexdigest()


def make_response(
    ok: bool,
    payload: dict | None = None,
    error: str | None = None,
    warnings: list[str] | None = None,
) -> dict:
    response: dict = {
        "ok": ok,
        "bridge_version": BRIDGE_VERSION,
        "python_version": platform.python_version(),
        "warnings": warnings or [],
    }
    if payload is not None:
        response["payload"] = payload
    if error is not None:
        response["error"] = error
    return response


def check_pyannote_available() -> tuple[bool, str | None]:
    """Check if pyannote.audio is importable."""
    try:
        import importlib.util
        if importlib.util.find_spec("pyannote.audio") is None:
            return False, "pyannote.audio not installed"
    except ModuleNotFoundError:
        return False, "pyannote.audio not installed"
    return True, None


def normalize_diarization_turns(diarization) -> list[dict]:
    """Extract speaker turns from pyannote diarization output.

    pyannote >=4.0 returns DiarizeOutput; extract the Annotation from it.
    """
    annotation = getattr(diarization, "speaker_diarization", diarization)
    turns: list[dict] = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        turns.append(
            {
                "speaker_id": str(speaker),
                "start": round(turn.start, 3),
                "end": round(turn.end, 3),
            }
        )
    return turns


def handle_diarize(request: dict) -> dict:
    """Run pyannote speaker diarization on an audio file."""
    audio_path = request.get("audio_path")
    if not audio_path:
        return make_response(False, error="audio_path is required")

    if not Path(audio_path).exists():
        return make_response(False, error=f"audio file not found: {audio_path}")

    # Optional HF token — from request or environment
    hf_token = request.get("hf_token")
    if not hf_token:
        hf_token = os.environ.get("HF_TOKEN")

    if not hf_token:
        return make_response(False, error="HF_TOKEN is required for pyannote model access")

    # Check pyannote availability
    available, reason = check_pyannote_available()
    if not available:
        return make_response(False, error=reason)

    # Redirect stdout to capture any pyannote/huggingface output that would
    # corrupt our JSON protocol. Restore stdout before writing response.
    captured_stdout = io.StringIO()
    original_stdout = sys.stdout
    sys.stdout = captured_stdout

    try:
        from pyannote.audio import Pipeline  # type: ignore[import-untyped]

        model = request.get("model", "pyannote/speaker-diarization-community-1")

        # pyannote >=3.1 uses `token=`, older versions use `use_auth_token=`
        try:
            pipeline = Pipeline.from_pretrained(model, token=hf_token)
        except TypeError:
            pipeline = Pipeline.from_pretrained(model, use_auth_token=hf_token)

        # Optional device selection
        device = request.get("device")
        if device and device != "auto":
            import torch
            pipeline.to(torch.device(device))

        # Build kwargs for optional speaker count hints
        kwargs: dict = {}
        min_speakers = request.get("min_speakers")
        max_speakers = request.get("max_speakers")
        if min_speakers is not None:
            kwargs["min_speakers"] = int(min_speakers)
        if max_speakers is not None:
            kwargs["max_speakers"] = int(max_speakers)

        diarization = pipeline(audio_path, **kwargs)
        turns = normalize_diarization_turns(diarization)

        # Restore stdout before building response
        sys.stdout = original_stdout

        captured = captured_stdout.getvalue().strip()
        warnings = [captured] if captured else []

        return make_response(True, payload={"turns": turns}, warnings=warnings)

    except Exception as exc:
        sys.stdout = original_stdout
        captured = captured_stdout.getvalue().strip()
        error_msg = f"diarization failed: {exc}"
        if captured:
            error_msg += f" | stdout: {captured[:200]}"
        return make_response(False, error=error_msg)


def main() -> None:
    """Read JSON request from stdin, process, write JSON response to stdout."""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            response = make_response(False, error="empty stdin")
            sys.stdout.write(json.dumps(response))
            sys.stdout.flush()
            return

        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        response = make_response(False, error=f"invalid JSON: {exc}")
        sys.stdout.write(json.dumps(response))
        sys.stdout.flush()
        return

    action = request.get("action", "")

    if action == "diarize":
        response = handle_diarize(request)
    elif action == "check":
        # Health check — just verify pyannote is importable
        available, reason = check_pyannote_available()
        response = make_response(available, error=reason)
    else:
        response = make_response(False, error=f"unknown action: {action}")

    sys.stdout.write(json.dumps(response))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
