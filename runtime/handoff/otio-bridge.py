#!/usr/bin/env python3
"""
Video OS — OTIO Bridge Script (M3.5 Phase 2)

Communicates with the TypeScript orchestrator via stdin/stdout JSON protocol.
Handles:
  - export_otio:    timeline bridge input JSON → .otio file
  - import_otio:    .otio file → normalized JSON (Phase 3)
  - normalize_otio: .otio file → normalized JSON with extracted metadata

Dependencies:
  - opentimelineio (pip install opentimelineio==0.17.0)
"""

import sys
import json
import hashlib
import platform
from pathlib import Path

BRIDGE_VERSION = "1.0.0"


def get_script_hash() -> str:
    """SHA-256 hash of this bridge script file."""
    content = Path(__file__).read_bytes()
    return "sha256:" + hashlib.sha256(content).hexdigest()


def get_fingerprint(loaded_adapters: list[str] | None = None) -> dict:
    """Build bridge fingerprint for response."""
    import opentimelineio as otio

    return {
        "bridge_version": BRIDGE_VERSION,
        "python_version": platform.python_version(),
        "opentimelineio_version": otio.__version__,
        "bridge_script_hash": get_script_hash(),
        "loaded_adapter_modules": loaded_adapters or [],
    }


def make_response(
    request_id: str,
    ok: bool,
    fingerprint: dict,
    payload_path: str | None = None,
    warnings: list[str] | None = None,
    error: dict | None = None,
) -> dict:
    response = {
        "request_id": request_id,
        "ok": ok,
        "bridge": fingerprint,
        "payload_path": payload_path,
        "warnings": warnings or [],
    }
    if error is not None:
        response["error"] = error
    return response


def make_error_response(request_id: str, message: str, request: dict | None = None) -> dict:
    """Error response without fingerprint (OTIO may not be importable)."""
    error = {"message": message}
    if isinstance(request, dict):
        error["request_context"] = {
            "command": request.get("command", ""),
            "input_path": request.get("input_path"),
            "output_path": request.get("output_path"),
        }

    return {
        "request_id": request_id,
        "ok": False,
        "bridge": {
            "bridge_version": BRIDGE_VERSION,
            "python_version": platform.python_version(),
            "opentimelineio_version": "unknown",
            "bridge_script_hash": get_script_hash(),
            "loaded_adapter_modules": [],
        },
        "payload_path": None,
        "warnings": [message],
        "error": error,
    }


# ── Export: timeline bridge input → .otio ───────────────────────────


def us_to_rational_time(us: int, fps_num: int = 24, fps_den: int = 1) -> "otio.opentime.RationalTime":
    """Convert microseconds to OTIO RationalTime at the given frame rate."""
    import opentimelineio as otio

    fps = fps_num / fps_den
    seconds = us / 1_000_000.0
    frames = seconds * fps
    return otio.opentime.RationalTime(value=frames, rate=fps)


def build_clip(
    clip_data: dict, fps_num: int, fps_den: int
) -> "otio.schema.Clip":
    """Build an OTIO Clip from bridge clip input data."""
    import opentimelineio as otio

    fps = fps_num / fps_den
    src_in_us = clip_data["src_in_us"]
    src_out_us = clip_data["src_out_us"]
    duration_us = src_out_us - src_in_us

    start_time = us_to_rational_time(src_in_us, fps_num, fps_den)
    duration = us_to_rational_time(duration_us, fps_num, fps_den)

    source_range = otio.opentime.TimeRange(
        start_time=start_time,
        duration=duration,
    )

    # Build media reference
    source_locator = clip_data.get("source_locator", "")
    if source_locator:
        media_ref = otio.schema.ExternalReference(
            target_url=source_locator,
        )
    else:
        media_ref = otio.schema.MissingReference()

    # Clip name: human-readable fallback
    clip_name = f"{clip_data['clip_id']} {clip_data.get('segment_id', '')}"

    clip = otio.schema.Clip(
        name=clip_name.strip(),
        media_reference=media_ref,
        source_range=source_range,
    )

    # video_os metadata namespace
    clip.metadata["video_os"] = {
        "exchange_clip_id": clip_data["exchange_clip_id"],
        "clip_id": clip_data["clip_id"],
        "track_id": clip_data.get("track_id", ""),
        "asset_id": clip_data["asset_id"],
        "segment_id": clip_data["segment_id"],
        "beat_id": clip_data.get("beat_id", ""),
        "role": clip_data.get("role", ""),
        "src_in_us": src_in_us,
        "src_out_us": src_out_us,
        "timeline_in_frame": clip_data.get("timeline_in_frame", 0),
        "timeline_duration_frames": clip_data.get("timeline_duration_frames", 0),
        "capability_profile_id": clip_data.get("capability_profile_id", ""),
    }

    return clip


def build_track(
    track_data: dict, fps_num: int, fps_den: int
) -> "otio.schema.Track":
    """Build an OTIO Track from bridge track input data."""
    import opentimelineio as otio

    kind_map = {
        "video": otio.schema.TrackKind.Video,
        "audio": otio.schema.TrackKind.Audio,
    }
    kind = track_data.get("kind", "video")
    otio_kind = kind_map.get(kind, otio.schema.TrackKind.Video)

    track = otio.schema.Track(
        name=track_data["track_id"],
        kind=otio_kind,
    )

    # video_os metadata
    track.metadata["video_os"] = {
        "exchange_track_id": track_data["exchange_track_id"],
        "track_id": track_data["track_id"],
        "kind": kind,
    }

    # Add clips
    for clip_data in track_data.get("clips", []):
        clip = build_clip(clip_data, fps_num, fps_den)
        track.append(clip)

    return track


def handle_export(request: dict) -> dict:
    """Export timeline bridge input to .otio file."""
    import opentimelineio as otio

    request_id = request["request_id"]
    input_path = request["input_path"]
    output_path = request["output_path"]
    options = request.get("options", {})

    # Read bridge input
    with open(input_path, "r") as f:
        bridge_input = json.load(f)

    fps_num = bridge_input["sequence"].get("fps_num", 24)
    fps_den = bridge_input["sequence"].get("fps_den", 1)

    # Build OTIO Timeline
    timeline = otio.schema.Timeline(
        name=bridge_input["sequence"].get("name", bridge_input["project_id"]),
    )

    # Root-level video_os metadata
    timeline.metadata["video_os"] = {
        "schema_version": "1",
        "project_id": bridge_input["project_id"],
        "handoff_id": bridge_input["handoff_id"],
        "timeline_version": bridge_input["timeline_version"],
        "capability_profile_id": bridge_input["capability_profile_id"],
        "approval_status": bridge_input.get("approval_status", "clean"),
    }

    # Build stack with tracks
    stack = timeline.tracks

    # Video tracks
    for track_data in bridge_input["tracks"].get("video", []):
        track = build_track(track_data, fps_num, fps_den)
        stack.append(track)

    # Audio tracks
    for track_data in bridge_input["tracks"].get("audio", []):
        track = build_track(track_data, fps_num, fps_den)
        stack.append(track)

    # Write .otio file
    otio.adapters.write_to_file(timeline, output_path)

    # Write normalized JSON if requested
    normalized_path = options.get("normalized_output_path")
    if normalized_path:
        normalized = extract_normalized(timeline)
        Path(normalized_path).parent.mkdir(parents=True, exist_ok=True)
        with open(normalized_path, "w") as f:
            json.dump(normalized, f, indent=2)

    fingerprint = get_fingerprint()
    return make_response(
        request_id=request_id,
        ok=True,
        fingerprint=fingerprint,
        payload_path=output_path,
    )


# ── Normalize: .otio → JSON with extracted metadata ────────────────


def metadata_keys_without_video_os(metadata: dict | None) -> list[str]:
    if not isinstance(metadata, dict):
        return []
    return [str(key) for key in metadata.keys() if key != "video_os"]


def normalize_track_kind(track) -> str:
    kind = str(getattr(track, "kind", "video")).lower()
    if "audio" in kind:
        return "audio"
    return "video"


def effect_names_for_item(item) -> list[str]:
    names: list[str] = []
    for effect in getattr(item, "effects", None) or []:
        effect_name = getattr(effect, "effect_name", None) or getattr(effect, "name", None)
        if not effect_name:
            effect_name = effect.__class__.__name__
        names.append(str(effect_name))
    return names


def rational_time_to_us(rational_time) -> int:
    if rational_time is None:
        return 0
    rate = getattr(rational_time, "rate", 0) or 0
    if rate == 0:
        return 0
    value = getattr(rational_time, "value", 0) or 0
    return int(round((value / rate) * 1_000_000))


def duration_to_frames(rational_time) -> int:
    if rational_time is None:
        return 0
    value = getattr(rational_time, "value", 0) or 0
    return int(round(value))


def derive_name_tokens(name: str | None) -> tuple[str, str]:
    if not name:
        return ("", "")
    parts = str(name).strip().split()
    clip_id = parts[0] if len(parts) > 0 else ""
    segment_id = parts[1] if len(parts) > 1 else ""
    return (clip_id, segment_id)


def extract_normalized(timeline) -> dict:
    """Extract normalized JSON from an OTIO timeline, including exchange_clip_ids."""
    exchange_clip_ids = []
    exchange_track_ids = []
    clips_data = []
    tracks_data = []

    for track in timeline.tracks:
        track_meta = track.metadata.get("video_os", {})
        exchange_track_id = track_meta.get("exchange_track_id", "")
        track_id = track_meta.get("track_id", "") or getattr(track, "name", "")
        track_kind = track_meta.get("kind", "") or normalize_track_kind(track)
        track_vendor_metadata_keys = metadata_keys_without_video_os(getattr(track, "metadata", {}))

        if exchange_track_id:
            exchange_track_ids.append(exchange_track_id)

        tracks_data.append({
            "exchange_track_id": exchange_track_id,
            "track_id": track_id,
            "kind": track_kind,
            "vendor_metadata_keys": track_vendor_metadata_keys,
            "unknown_property_keys": [],
        })

        timeline_cursor_frames = 0

        for item in track:
            if hasattr(item, "metadata"):
                clip_meta = item.metadata.get("video_os", {})
                exchange_clip_id = clip_meta.get("exchange_clip_id", "")
                if exchange_clip_id:
                    exchange_clip_ids.append(exchange_clip_id)

                item_name = getattr(item, "name", "") or ""
                fallback_clip_id, fallback_segment_id = derive_name_tokens(item_name)
                source_range = getattr(item, "source_range", None)
                start_time = getattr(source_range, "start_time", None)
                duration = getattr(source_range, "duration", None)
                src_in_us = clip_meta.get("src_in_us", rational_time_to_us(start_time))
                duration_us = rational_time_to_us(duration)
                clips_data.append({
                    "exchange_clip_id": exchange_clip_id,
                    "clip_id": clip_meta.get("clip_id", "") or fallback_clip_id,
                    "track_id": clip_meta.get("track_id", "") or track_id,
                    "asset_id": clip_meta.get("asset_id", ""),
                    "segment_id": clip_meta.get("segment_id", "") or fallback_segment_id,
                    "src_in_us": src_in_us,
                    "src_out_us": clip_meta.get("src_out_us", src_in_us + duration_us),
                    "timeline_in_frame": clip_meta.get("timeline_in_frame", timeline_cursor_frames),
                    "timeline_duration_frames": clip_meta.get("timeline_duration_frames", duration_to_frames(duration)),
                    "name": item_name,
                    "enabled": bool(getattr(item, "enabled", True)),
                    "metadata_lost": not bool(exchange_clip_id),
                    "track_kind": track_kind,
                    "vendor_metadata_keys": metadata_keys_without_video_os(getattr(item, "metadata", {})),
                    "track_vendor_metadata_keys": track_vendor_metadata_keys,
                    "unknown_property_keys": [],
                    "track_unknown_property_keys": [],
                    "effect_names": effect_names_for_item(item),
                })

                timeline_cursor_frames += duration_to_frames(duration)
            else:
                source_range = getattr(item, "source_range", None)
                duration = getattr(source_range, "duration", None)
                timeline_cursor_frames += duration_to_frames(duration)

    root_meta = timeline.metadata.get("video_os", {})

    return {
        "project_id": root_meta.get("project_id", ""),
        "handoff_id": root_meta.get("handoff_id", ""),
        "timeline_version": root_meta.get("timeline_version", ""),
        "exchange_clip_ids": exchange_clip_ids,
        "exchange_track_ids": exchange_track_ids,
        "tracks": tracks_data,
        "clips": clips_data,
        "track_count": len(tracks_data),
        "clip_count": len(clips_data),
    }


def handle_normalize(request: dict) -> dict:
    """Normalize an .otio file to JSON with extracted metadata."""
    import opentimelineio as otio

    request_id = request["request_id"]
    input_path = request["input_path"]
    options = request.get("options", {})

    timeline = otio.adapters.read_from_file(input_path)
    normalized = extract_normalized(timeline)

    # Write to output path or a temp file
    output_path = request.get("output_path")
    if not output_path:
        output_path = str(Path(input_path).with_suffix(".normalized.json"))

    with open(output_path, "w") as f:
        json.dump(normalized, f, indent=2)

    fingerprint = get_fingerprint()
    return make_response(
        request_id=request_id,
        ok=True,
        fingerprint=fingerprint,
        payload_path=output_path,
    )


# ── Import: .otio → normalized JSON with split/dup hints ────────────


def detect_split_duplicate_hints(clips_data: list[dict]) -> dict:
    """Detect potential split/duplicate hints from imported clips.

    Groups clips by exchange_clip_id and flags groups with >1 member.
    Returns hint data for the TS orchestrator.
    """
    groups: dict[str, list[dict]] = {}
    for clip in clips_data:
        eid = clip.get("exchange_clip_id", "")
        if not eid:
            continue
        if eid not in groups:
            groups[eid] = []
        groups[eid].append(clip)

    hints = {
        "one_to_many_candidates": [],
        "total_one_to_many_clips": 0,
    }

    for eid, members in groups.items():
        if len(members) > 1:
            # Sort by src_in_us for stable ordering
            members.sort(key=lambda c: (c.get("src_in_us", 0), c.get("timeline_in_frame", 0)))

            # Check overlap: if any pair overlaps, it's likely duplicate
            has_overlap = False
            for i in range(len(members) - 1):
                a_out = members[i].get("src_out_us", 0)
                b_in = members[i + 1].get("src_in_us", 0)
                if a_out > b_in:
                    has_overlap = True
                    break

            hints["one_to_many_candidates"].append({
                "exchange_clip_id": eid,
                "count": len(members),
                "likely_type": "duplicate" if has_overlap else "split",
            })
            hints["total_one_to_many_clips"] += len(members)

    return hints


def handle_import(request: dict) -> dict:
    """Import an edited .otio file and normalize it with split/duplicate hints."""
    import opentimelineio as otio

    request_id = request["request_id"]
    input_path = request["input_path"]
    options = request.get("options", {})

    timeline = otio.adapters.read_from_file(input_path)
    normalized = extract_normalized(timeline)

    # Add split/duplicate detection hints
    hints = detect_split_duplicate_hints(normalized.get("clips", []))
    normalized["split_duplicate_hints"] = hints

    # Write to output path
    output_path = request.get("output_path")
    if not output_path:
        output_path = str(Path(input_path).with_suffix(".imported.json"))

    with open(output_path, "w") as f:
        json.dump(normalized, f, indent=2)

    fingerprint = get_fingerprint()
    return make_response(
        request_id=request_id,
        ok=True,
        fingerprint=fingerprint,
        payload_path=output_path,
    )


# ── Main ────────────────────────────────────────────────────────────


def main():
    try:
        raw_input = sys.stdin.read()
        request = json.loads(raw_input)
    except json.JSONDecodeError as e:
        resp = make_error_response("unknown", f"Invalid JSON input: {e}")
        print(json.dumps(resp))
        sys.exit(1)

    request_id = request.get("request_id", "unknown")
    command = request.get("command", "")

    # Version check
    expected_version = request.get("expected_bridge_version", "")
    if expected_version and expected_version != BRIDGE_VERSION:
        resp = make_error_response(
            request_id,
            f"Bridge version mismatch: expected={expected_version}, actual={BRIDGE_VERSION}",
            request,
        )
        print(json.dumps(resp))
        sys.exit(1)

    # Check OTIO availability
    try:
        import opentimelineio  # noqa: F401
    except ImportError as e:
        resp = make_error_response(
            request_id,
            f"opentimelineio not installed: {e}. Install with: pip install opentimelineio==0.17.0",
            request,
        )
        print(json.dumps(resp))
        sys.exit(1)

    # Dispatch command
    handlers = {
        "export_otio": handle_export,
        "import_otio": handle_import,
        "normalize_otio": handle_normalize,
    }

    handler = handlers.get(command)
    if not handler:
        resp = make_error_response(request_id, f"Unknown command: {command}", request)
        print(json.dumps(resp))
        sys.exit(1)

    try:
        response = handler(request)
        print(json.dumps(response))
    except Exception as e:
        resp = make_error_response(request_id, f"Command failed: {e}", request)
        print(json.dumps(resp))
        sys.exit(1)


if __name__ == "__main__":
    main()
