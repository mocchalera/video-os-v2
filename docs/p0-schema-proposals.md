# P0 Schema Proposals For Production Readiness Canonical Artifacts

- Status: P0 proposal
- Scope: docs-only
- Source design: `docs/production-readiness-canonical-artifacts.md` Draft v2
- Created: 2026-04-26

## 1. Scope And Non-Goals

This document proposes schema, fixture, file ownership, gate wiring, versioning, and hash conventions for the six MVP production-readiness artifacts defined in Draft v2:

1. `source_media_manifest.json`
2. `analysis_coverage_report.json`
3. `audio_story_graph.json`
4. `continuity_graph.json`
5. `editorial_preference_memory.jsonl`
6. `release_safety_report.yaml`

This P0 does propose:

- final proposed schema paths under `schemas/`;
- final proposed runtime artifact paths under `projects/<id>/`;
- strict JSON Schema-style sketches with required fields, type, enum, format, pattern, and `additionalProperties: false`;
- fixture catalog names for P1+ implementation;
- producer and consumer ownership;
- state and gate wiring;
- versioning, provenance, and hash behavior;
- phase-owned file allowlists for P1 through P4.

This P0 does not propose or perform:

- implementation changes;
- actual `schemas/*.schema.json` creation;
- actual fixture creation;
- validator code changes;
- runtime command changes;
- package or dependency changes;
- edits to existing docs;
- enforcement of new gates in the current dirty worktree.

The only file owned by this P0 task is this document:

- `docs/p0-schema-proposals.md`

All existing dirty worktree files are baseline context and are outside the P0 allowlist.

## 2. Phase-Owned File Allowlist

### P0 Allowlist

P0 may create only:

- `docs/p0-schema-proposals.md`

P0 must not touch:

- `schemas/`
- `runtime/`
- `scripts/`
- `tests/`
- `package.json`
- `package-lock.json`
- `README.md`
- `ARCHITECTURE.md`
- existing `docs/*.md`
- existing dirty or untracked files

### P1 Allowlist: Manifest + Coverage Foundation

P1 is not allowed to touch files outside this list unless the P1 review explicitly expands the allowlist.

Path prefix allowlist:

- `schemas/source-media-manifest.schema.json`
- `schemas/analysis-coverage-report.schema.json`
- `tests/fixtures/source_media_manifest/`
- `tests/fixtures/analysis_coverage_report/`
- `runtime/artifacts/`
- `runtime/validation/`
- `runtime/pipeline/`
- `runtime/commands/analyze.ts`
- `runtime/commands/status.ts`
- `runtime/state/`
- `scripts/init-project.ts`
- `tests/`
- `docs/p1-manifest-coverage-implementation-notes.md`

Expected P1 generated project artifact paths:

- `projects/<id>/02_media/source_media_manifest.json`
- `projects/<id>/03_analysis/analysis_coverage_report.json`

P1 may update `project_state.yaml` handling only for feature-flagged, dry-run/report-only `analysis_gate` reflection. P1 must keep existing demo timeline compilation byte-stable when new gates are disabled.

### P2 Allowlist: Audio Story Graph

Path prefix allowlist:

- `schemas/audio-story-graph.schema.json`
- `tests/fixtures/audio_story_graph/`
- `runtime/media/`
- `runtime/pipeline/`
- `runtime/commands/triage.ts`
- `runtime/commands/blueprint.ts`
- `runtime/commands/review.ts`
- `runtime/caption/`
- `runtime/artifacts/`
- `runtime/validation/`
- `tests/`
- `docs/p2-audio-story-graph-implementation-notes.md`

Expected P2 generated project artifact path:

- `projects/<id>/03_analysis/audio_story_graph.json`

P2 must materialize graph-derived refs into `selects_candidates.yaml` and `edit_blueprint.yaml`. The compiler must not read `audio_story_graph.json` directly.

### P3 Allowlist: Continuity Graph + Preference Memory

Path prefix allowlist:

- `schemas/continuity-graph.schema.json`
- `schemas/editorial-preference-memory-entry.schema.json`
- `tests/fixtures/continuity_graph/`
- `tests/fixtures/editorial_preference_memory/`
- `runtime/media/`
- `runtime/commands/intent.ts`
- `runtime/commands/triage.ts`
- `runtime/commands/blueprint.ts`
- `runtime/commands/review.ts`
- `runtime/handoff/`
- `runtime/artifacts/`
- `runtime/validation/`
- `runtime/state/`
- `tests/`
- `docs/p3-continuity-preference-implementation-notes.md`

Expected P3 generated project artifact paths:

- `projects/<id>/03_analysis/continuity_graph.json`
- `projects/<id>/00_project/editorial_preference_memory.jsonl`

P3 must keep JSONL preference writes append-only and must return precise malformed-line diagnostics without silently dropping consumed entries.

### P4 Allowlist: Release Safety Enforcement Migration

Path prefix allowlist:

- `schemas/release-safety-report.schema.json`
- `schemas/delivery-profile.schema.json`
- `tests/fixtures/release_safety_report/`
- `tests/fixtures/delivery_profiles/`
- `runtime/commands/package.ts`
- `runtime/commands/render.ts`
- `runtime/commands/status.ts`
- `runtime/packaging/`
- `runtime/render/`
- `runtime/validation/`
- `runtime/state/`
- `tests/`
- `docs/p4-release-safety-migration-notes.md`

Expected P4 generated project artifact paths:

- `projects/<id>/07_package/release_safety_report.yaml`
- `projects/<id>/07_package/delivery_profiles/<profile>.yaml`

P4 must migrate through `dry_run` then `report_only` before `enforce`. Enforcement must stay feature-flagged off until existing package/demo fixtures pass or have explicit scoped waivers.

### Existing Dirty Worktree Outside P0

Every dirty worktree path shown in Section 10 is outside the P0 allowlist except `docs/p0-schema-proposals.md`, which this task adds. The existing dirty files are treated as baseline context and must not be staged, reverted, reformatted, or migrated by this P0.

## 3. Schema Proposals

### 3.1 `source_media_manifest.json`

**Proposed schema path**: `schemas/source-media-manifest.schema.json`

**Proposed artifact path**: `projects/<id>/02_media/source_media_manifest.json`

**Schema sketch**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/source-media-manifest.schema.json",
  "title": "Video OS Source Media Manifest",
  "type": "object",
  "required": ["version", "project_id", "artifact_version", "created_at", "source_root", "items", "provenance"],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "project_id": { "type": "string", "minLength": 1 },
    "artifact_version": { "type": "string", "pattern": "^(analysis|manifest)-v\\d+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "source_root": {
      "type": "object",
      "required": ["locator", "locator_kind"],
      "additionalProperties": false,
      "properties": {
        "locator": { "type": "string", "minLength": 1 },
        "locator_kind": { "type": "string", "enum": ["local_path", "symlink", "external_drive", "cloud_uri", "mixed"] }
      }
    },
    "items": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/source-item" }
    },
    "provenance": { "$ref": "#/$defs/artifact-provenance" }
  },
  "$defs": {
    "source-item": {
      "type": "object",
      "required": [
        "asset_id", "source_locator", "filename", "content_hash", "fingerprint", "size_bytes", "mtime",
        "media_kind", "ingest_status", "rights_status", "privacy_status", "analysis_policy_ref",
        "capture_started_at", "capture_timezone", "timecode_start", "timecode_format", "sample_rate",
        "duration_us", "frame_rate_mode", "rotation", "audio_video_offset_ms", "clock_source"
      ],
      "additionalProperties": false,
      "properties": {
        "asset_id": { "type": "string", "pattern": "^AST_[A-Za-z0-9_-]+$" },
        "source_locator": { "type": "string", "minLength": 1 },
        "filename": { "type": "string", "minLength": 1 },
        "content_hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" },
        "fingerprint": { "type": ["string", "null"], "minLength": 1 },
        "size_bytes": { "type": "integer", "minimum": 0 },
        "mtime": { "type": "string", "format": "date-time" },
        "media_kind": { "type": "string", "enum": ["video", "audio", "image", "sequence", "unknown"] },
        "ingest_status": { "type": "string", "enum": ["ready", "missing", "stale", "unsupported", "excluded"] },
        "rights_status": { "type": "string", "enum": ["unknown", "operator_declared_ok", "licensed", "restricted", "blocked"] },
        "privacy_status": { "type": "string", "enum": ["unknown", "operator_declared_ok", "contains_people", "sensitive", "blocked"] },
        "analysis_policy_ref": { "type": "string", "pattern": "^APOL_[A-Za-z0-9_-]+$" },
        "capture_started_at": { "type": ["string", "null"], "format": "date-time" },
        "capture_timezone": { "type": ["string", "null"], "minLength": 1 },
        "timecode_start": { "type": ["string", "null"], "pattern": "^(\\d{2}:\\d{2}:\\d{2}[:;]\\d{2})$" },
        "timecode_format": { "type": "string", "enum": ["none", "non_drop", "drop_frame", "inferred", "unknown"] },
        "sample_rate": { "type": ["integer", "null"], "minimum": 1 },
        "duration_us": { "type": ["integer", "null"], "minimum": 0 },
        "frame_rate_mode": { "type": "string", "enum": ["cfr", "vfr", "audio_only", "unknown"] },
        "rotation": { "type": ["integer", "null"], "enum": [0, 90, 180, 270, null] },
        "audio_video_offset_ms": { "type": ["number", "null"] },
        "clock_source": { "type": "string", "enum": ["file_metadata", "timecode_track", "operator_declared", "inferred", "unknown"] }
      }
    },
    "artifact-provenance": {
      "type": "object",
      "required": ["producer", "inputs", "hash_policy"],
      "additionalProperties": false,
      "properties": {
        "producer": { "type": "string", "enum": ["init-project", "analysis-ingest", "ingest-command"] },
        "inputs": { "type": "array", "items": { "$ref": "#/$defs/input-ref" } },
        "hash_policy": { "$ref": "#/$defs/hash-policy" }
      }
    },
    "input-ref": {
      "type": "object",
      "required": ["path", "hash"],
      "additionalProperties": false,
      "properties": {
        "path": { "type": "string", "minLength": 1 },
        "hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" }
      }
    },
    "hash-policy": {
      "type": "object",
      "required": ["algorithm", "canonicalization", "excluded_fields"],
      "additionalProperties": false,
      "properties": {
        "algorithm": { "type": "string", "enum": ["sha256"] },
        "canonicalization": { "type": "string", "enum": ["normalized-json-v1"] },
        "excluded_fields": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

ID prefix rules:

- `asset_id`: `AST_`
- `analysis_policy_ref`: `APOL_`

**Fixture catalog**:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/source_media_manifest/valid_minimal.json` | one ready video asset with content hash and required sync fields |
| `tests/fixtures/source_media_manifest/valid_mixed_media.json` | video, audio, image, and excluded unsupported file |
| `tests/fixtures/source_media_manifest/valid_inferred_timecode.json` | ambiguous timezone/timecode with `clock_source: inferred` |
| `tests/fixtures/source_media_manifest/invalid_missing_fingerprint.json` | item has neither usable hash nor fingerprint |
| `tests/fixtures/source_media_manifest/invalid_bad_asset_prefix.json` | rejects non-`AST_` IDs |
| `tests/fixtures/source_media_manifest/edge_missing_source.json` | `ingest_status: missing`, used by coverage blocked fixture |
| `tests/fixtures/source_media_manifest/edge_stale_source.json` | hash mismatch stale-source behavior |

**Producer / Consumer matrix**:

| Producer | Writes | Notes |
| --- | --- | --- |
| `init-project` | yes | creates initial manifest when `--source-dir` or explicit media inputs exist |
| analysis ingest | yes | refreshes fingerprints before `assets.json` and analysis lanes |
| downstream graph builders | no | may only read and validate refs |

| Consumer | Reads | Gate effect |
| --- | --- | --- |
| `analysis_coverage_report.json` | source lane and per-asset freshness | required for `summary.status: ready` |
| `audio_story_graph.json` | every utterance/audio/music source ref | invalid refs fail graph validation |
| `continuity_graph.json` | entity/segment source refs and capture basis | low source confidence bounds continuity certainty |
| `release_safety_report.yaml` | rights/privacy/freshness/used-source completeness | report-only until P4 enforce |
| `package_manifest.json` | package provenance | cites hash, does not copy manifest |
| `sync_quality_report.json` | future input | uses timecode and A/V sync fields |

**State / Gate mapping**:

- Required before `media_analyzed`.
- Controls `analysis_gate` through lane `source_manifest`.
- Referenced by `planning_gate` for both graphs.
- Stale/missing sources used by current `timeline.json` block `packaging_gate` only after P4 enforce.

**Versioning fields**:

```json
{
  "version": "1.0.0",
  "artifact_version": "manifest-v1",
  "created_at": "2026-04-26T00:00:00Z",
  "provenance": {
    "producer": "analysis-ingest",
    "inputs": [{ "path": "projects/demo/02_media/source", "hash": "sha256:..." }],
    "hash_policy": {
      "algorithm": "sha256",
      "canonicalization": "normalized-json-v1",
      "excluded_fields": ["created_at"]
    }
  }
}
```

**Hash recipe**:

Normalize the full JSON object with deterministic key ordering, UTF-8 NFC normalization, and no insignificant whitespace. Exclude `created_at` only if declared in `provenance.hash_policy.excluded_fields`. Hash raw source media by content SHA-256 when practical; otherwise store a documented fingerprint and hash the fingerprint record.

**Failure modes**:

| Mode | Behavior |
| --- | --- |
| missing | item remains in manifest with `ingest_status: missing`; coverage blocks required analysis lanes |
| partial | allowed only as `ingest_status: unsupported` or `excluded` with consumer impact recorded in coverage |
| corrupt | invalid JSON or schema failure blocks `analysis_gate` |
| stale | downstream artifacts citing old manifest hash are stale; P4 packaging blocks if stale used source remains |

### 3.2 `analysis_coverage_report.json`

**Proposed schema path**: `schemas/analysis-coverage-report.schema.json`

**Proposed artifact path**: `projects/<id>/03_analysis/analysis_coverage_report.json`

**Schema sketch**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/analysis-coverage-report.schema.json",
  "title": "Video OS Analysis Coverage Report",
  "type": "object",
  "required": [
    "version", "project_id", "artifact_version", "created_at", "source_media_manifest_hash",
    "summary", "lanes", "assets", "blockers", "overrides", "provenance"
  ],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "project_id": { "type": "string", "minLength": 1 },
    "artifact_version": { "type": "string", "pattern": "^analysis-v\\d+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "source_media_manifest_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "summary": {
      "type": "object",
      "required": ["status", "required_lane_count", "ready_lane_count", "blocked_lane_count", "partial_lane_count"],
      "additionalProperties": false,
      "properties": {
        "status": { "type": "string", "enum": ["ready", "partial_override", "blocked"] },
        "required_lane_count": { "type": "integer", "minimum": 0 },
        "ready_lane_count": { "type": "integer", "minimum": 0 },
        "blocked_lane_count": { "type": "integer", "minimum": 0 },
        "partial_lane_count": { "type": "integer", "minimum": 0 }
      }
    },
    "lanes": {
      "type": "array",
      "items": { "$ref": "#/$defs/lane-status" }
    },
    "assets": {
      "type": "array",
      "items": { "$ref": "#/$defs/asset-coverage" }
    },
    "blockers": {
      "type": "array",
      "items": { "$ref": "#/$defs/coverage-blocker" }
    },
    "overrides": {
      "type": "array",
      "items": { "$ref": "#/$defs/override-ref" }
    },
    "provenance": { "$ref": "#/$defs/artifact-provenance" }
  },
  "$defs": {
    "lane-status": {
      "type": "object",
      "required": ["lane_id", "status", "required", "consumer_impact", "asset_ids"],
      "additionalProperties": false,
      "properties": {
        "lane_id": {
          "type": "string",
          "enum": [
            "source_manifest", "ffprobe", "segments", "contact_sheets", "filmstrips", "stt",
            "diarization", "vlm_tags", "vlm_peaks", "audio_events", "bgm_analysis",
            "audio_story_graph", "continuity_graph", "embeddings", "sync_quality"
          ]
        },
        "status": { "type": "string", "enum": ["pending", "ready", "partial", "skipped", "failed", "waived"] },
        "required": { "type": "boolean" },
        "reason": { "type": ["string", "null"] },
        "consumer_impact": { "type": "string", "enum": ["none", "status_only", "triage_warn", "planning_warn", "planning_block", "compile_block", "package_block"] },
        "asset_ids": { "type": "array", "items": { "type": "string", "pattern": "^AST_[A-Za-z0-9_-]+$" } },
        "artifact_hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" }
      }
    },
    "asset-coverage": {
      "type": "object",
      "required": ["asset_id", "status", "lanes"],
      "additionalProperties": false,
      "properties": {
        "asset_id": { "type": "string", "pattern": "^AST_[A-Za-z0-9_-]+$" },
        "status": { "type": "string", "enum": ["ready", "partial", "blocked", "excluded"] },
        "lanes": { "type": "array", "items": { "$ref": "#/$defs/lane-status" } }
      }
    },
    "coverage-blocker": {
      "type": "object",
      "required": ["blocker_id", "severity", "lane_id", "asset_ids", "message"],
      "additionalProperties": false,
      "properties": {
        "blocker_id": { "type": "string", "pattern": "^COVBLK_[A-Za-z0-9_-]+$" },
        "severity": { "type": "string", "enum": ["warning", "blocker"] },
        "lane_id": { "type": "string" },
        "asset_ids": { "type": "array", "items": { "type": "string", "pattern": "^AST_[A-Za-z0-9_-]+$" } },
        "message": { "type": "string", "minLength": 1 }
      }
    },
    "override-ref": {
      "type": "object",
      "required": ["override_id", "status", "scope", "approved_by", "approved_at"],
      "additionalProperties": false,
      "properties": {
        "override_id": { "type": "string", "pattern": "^OVR_[A-Za-z0-9_-]+$" },
        "status": { "type": "string", "enum": ["active", "stale", "expired"] },
        "scope": { "type": "string", "minLength": 1 },
        "approved_by": { "type": "string", "minLength": 1 },
        "approved_at": { "type": "string", "format": "date-time" },
        "expires_at": { "type": ["string", "null"], "format": "date-time" },
        "applies_to_artifact_hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" }
      }
    },
    "artifact-provenance": {
      "type": "object",
      "required": ["producer", "inputs", "hash_policy"],
      "additionalProperties": false,
      "properties": {
        "producer": { "type": "string", "enum": ["scripts/analyze.ts", "analysis-pipeline"] },
        "inputs": { "type": "array", "items": { "type": "object" } },
        "hash_policy": { "type": "object" }
      }
    }
  }
}
```

ID prefix rules:

- `asset_id`: `AST_`
- `blocker_id`: `COVBLK_`
- `override_id`: `OVR_`

**Fixture catalog**:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/analysis_coverage_report/valid_ready_all_lanes.json` | all required raw lanes ready |
| `tests/fixtures/analysis_coverage_report/valid_partial_override_stt.json` | STT missing with explicit active override |
| `tests/fixtures/analysis_coverage_report/valid_music_only_skipped_dialogue.json` | dialogue lane skipped with consumer impact |
| `tests/fixtures/analysis_coverage_report/invalid_missing_source_manifest_hash.json` | rejects absent source hash |
| `tests/fixtures/analysis_coverage_report/invalid_ready_with_failed_required_lane.json` | summary ready cannot coexist with required failed lane |
| `tests/fixtures/analysis_coverage_report/edge_stale_manifest_blocks.json` | stale source manifest lane blocks readiness |
| `tests/fixtures/analysis_coverage_report/edge_optional_embeddings_skipped.json` | optional search lane skipped without compile block |

**Producer / Consumer matrix**:

| Producer | Writes | Notes |
| --- | --- | --- |
| `scripts/analyze.ts` | yes | updates after each analysis stage |
| analysis pipeline stages | yes | stage-local updates must preserve closed schema |
| human override command | no direct silent write | records explicit override through project state and report refs |

| Consumer | Reads | Gate effect |
| --- | --- | --- |
| `status` | yes | explains missing analysis and next actions |
| `/triage` | yes | refuses missing required lanes unless override covers consumer |
| `/blueprint` | yes | blocks or warns for incomplete story/continuity evidence |
| `project_state.yaml` | yes | reflects report hash and gate status |
| `/package` | yes after P4 | checks evidence freshness in release report |

**State / Gate mapping**:

- Created during `intent_locked -> media_analyzed`.
- Required before `media_analyzed`.
- Owns `analysis_gate`.
- Informs `planning_gate` through graph lane readiness.

**Versioning fields**:

```json
{
  "version": "1.0.0",
  "artifact_version": "analysis-v3",
  "created_at": "2026-04-26T00:00:00Z",
  "provenance": {
    "producer": "scripts/analyze.ts",
    "inputs": [
      { "path": "projects/demo/02_media/source_media_manifest.json", "hash": "sha256:..." }
    ],
    "hash_policy": {
      "algorithm": "sha256",
      "canonicalization": "normalized-json-v1",
      "excluded_fields": ["created_at"]
    }
  }
}
```

**Hash recipe**:

Normalize the complete coverage object as deterministic JSON. Include lane statuses, blocker IDs, override refs, and source manifest hash. Exclude only declared volatile fields such as `created_at`. Never hash human-readable status summaries instead of the closed object.

**Failure modes**:

| Mode | Behavior |
| --- | --- |
| missing | `analysis_gate` blocked; `media_analyzed` cannot be reached |
| partial | allowed only with `summary.status: partial_override` and active matching override |
| corrupt | validator reports schema error; gate blocked |
| stale | if `source_media_manifest_hash` differs from current manifest hash, coverage becomes blocked |

### 3.3 `audio_story_graph.json`

**Proposed schema path**: `schemas/audio-story-graph.schema.json`

**Proposed artifact path**: `projects/<id>/03_analysis/audio_story_graph.json`

**Schema sketch**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/audio-story-graph.schema.json",
  "title": "Video OS Audio Story Graph",
  "type": "object",
  "required": [
    "version", "project_id", "artifact_version", "created_at", "source_media_manifest_hash",
    "inputs", "nodes", "edges", "coverage", "provenance"
  ],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "project_id": { "type": "string", "minLength": 1 },
    "artifact_version": { "type": "string", "pattern": "^(analysis|projection)-v\\d+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "source_media_manifest_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "inputs": {
      "type": "object",
      "required": ["transcript_hashes", "audio_events_hash", "bgm_analysis_hash", "coverage_report_hash"],
      "additionalProperties": false,
      "properties": {
        "transcript_hashes": { "type": "array", "items": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" } },
        "audio_events_hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" },
        "bgm_analysis_hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" },
        "coverage_report_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" }
      }
    },
    "nodes": { "type": "array", "items": { "$ref": "#/$defs/audio-node" } },
    "edges": { "type": "array", "items": { "$ref": "#/$defs/audio-edge" } },
    "coverage": {
      "type": "object",
      "required": ["status", "dialogue_lane", "audio_event_lane", "music_lane", "missing_inputs"],
      "additionalProperties": false,
      "properties": {
        "status": { "type": "string", "enum": ["ready", "partial", "skipped", "failed"] },
        "dialogue_lane": { "type": "string", "enum": ["ready", "partial", "skipped", "failed"] },
        "audio_event_lane": { "type": "string", "enum": ["ready", "partial", "skipped", "failed"] },
        "music_lane": { "type": "string", "enum": ["ready", "partial", "skipped", "failed"] },
        "missing_inputs": { "type": "array", "items": { "type": "string" } }
      }
    },
    "provenance": { "$ref": "#/$defs/artifact-provenance" }
  },
  "$defs": {
    "audio-node": {
      "type": "object",
      "required": ["node_id", "node_type", "asset_id", "start_us", "end_us", "refs", "confidence"],
      "additionalProperties": false,
      "properties": {
        "node_id": { "type": "string", "pattern": "^(ASG|UTTREF|SPKREF|AEREF|BGMREF)_[A-Za-z0-9_-]+$" },
        "node_type": { "type": "string", "enum": ["utterance", "speaker_turn", "silence", "laughter", "applause", "music_section", "impact", "ambient_shift", "emotion_lift", "emotion_drop"] },
        "asset_id": { "type": "string", "pattern": "^AST_[A-Za-z0-9_-]+$" },
        "start_us": { "type": "integer", "minimum": 0 },
        "end_us": { "type": "integer", "minimum": 0 },
        "text": { "type": ["string", "null"] },
        "story_role": { "type": ["string", "null"], "enum": ["hook", "setup", "experience", "payoff", "reaction", "closing", null] },
        "refs": {
          "type": "object",
          "required": ["transcript_ref", "speaker_ref", "audio_event_ref", "bgm_ref"],
          "additionalProperties": false,
          "properties": {
            "transcript_ref": { "type": ["string", "null"], "pattern": "^(TR|UTT)_[A-Za-z0-9_-]+$" },
            "speaker_ref": { "type": ["string", "null"], "pattern": "^SPK_[A-Za-z0-9_-]+$" },
            "audio_event_ref": { "type": ["string", "null"], "pattern": "^AE_[A-Za-z0-9_-]+$" },
            "bgm_ref": { "type": ["string", "null"], "pattern": "^BGM_[A-Za-z0-9_-]+$" }
          }
        },
        "confidence": { "$ref": "https://example.com/schemas/analysis-common.schema.json#/$defs/confidence-record" }
      }
    },
    "audio-edge": {
      "type": "object",
      "required": ["edge_id", "from_node_id", "to_node_id", "type"],
      "additionalProperties": false,
      "properties": {
        "edge_id": { "type": "string", "pattern": "^ASGEDGE_[A-Za-z0-9_-]+$" },
        "from_node_id": { "type": "string", "pattern": "^(ASG|UTTREF|SPKREF|AEREF|BGMREF)_[A-Za-z0-9_-]+$" },
        "to_node_id": { "type": "string", "pattern": "^(ASG|UTTREF|SPKREF|AEREF|BGMREF)_[A-Za-z0-9_-]+$" },
        "type": { "type": "string", "enum": ["precedes", "responds_to", "overlaps", "supports_beat", "contrasts_with", "music_under", "silence_after", "payoff_for"] }
      }
    },
    "artifact-provenance": {
      "type": "object",
      "required": ["producer", "inputs", "hash_policy"],
      "additionalProperties": false,
      "properties": {
        "producer": { "type": "string", "enum": ["analysis-pipeline", "blueprint-projection"] },
        "inputs": { "type": "array", "items": { "type": "object" } },
        "hash_policy": { "type": "object" }
      }
    }
  }
}
```

ID prefix rules:

- graph-owned nodes: `ASG_`
- transcript refs inside graph: `UTTREF_`
- speaker refs inside graph: `SPKREF_`
- audio event refs inside graph: `AEREF_`
- music section refs inside graph: `BGMREF_`
- edges: `ASGEDGE_`
- external source refs remain `AST_`, `TR_`, `UTT_`, `SPK_`, `AE_`, `BGM_`

**Fixture catalog**:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/audio_story_graph/valid_dialogue_heavy.json` | utterance, speaker, silence, and payoff edges |
| `tests/fixtures/audio_story_graph/valid_music_only_skipped_dialogue.json` | no dialogue nodes, music/ambient nodes only |
| `tests/fixtures/audio_story_graph/valid_audio_events_failed_partial.json` | STT ready but audio events failed |
| `tests/fixtures/audio_story_graph/invalid_node_missing_manifest_asset.json` | node references absent `AST_` asset |
| `tests/fixtures/audio_story_graph/invalid_edge_unknown_node.json` | edge points to missing node |
| `tests/fixtures/audio_story_graph/edge_failed_stt_no_dialogue_nodes.json` | partial graph without invented dialogue |

**Producer / Consumer matrix**:

| Producer | Writes | Notes |
| --- | --- | --- |
| analysis pipeline | yes | builds raw graph after STT, diarization, audio events, BGM analysis |
| `/blueprint` projection | no mutation of raw facts | may materialize story roles into planning artifacts |
| compiler | no | must not read graph directly |

| Consumer | Reads | Gate effect |
| --- | --- | --- |
| `/triage` | yes | scores candidate windows by audio salience |
| `/blueprint` | yes | maps node refs to beat roles and audio policy |
| compiler | no direct read | consumes only materialized refs in planning artifacts |
| `/review` | yes | detects dropped setup/payoff and awkward audio transitions |
| `/caption` | yes | future caption source refs |
| `/package` | yes after P4 | checks caption/music consistency through refs |

**State / Gate mapping**:

- Not required for entering `media_analyzed`.
- Required by `planning_gate` for dialogue/music-driven projects unless scoped override exists.
- Readiness reflected as the `audio_story_graph` lane in `analysis_coverage_report.json`.

**Versioning fields**:

```json
{
  "version": "1.0.0",
  "artifact_version": "analysis-v3",
  "created_at": "2026-04-26T00:00:00Z",
  "provenance": {
    "producer": "analysis-pipeline",
    "inputs": [
      { "path": "projects/demo/03_analysis/transcript.json", "hash": "sha256:..." },
      { "path": "projects/demo/03_analysis/audio_events.json", "hash": "sha256:..." }
    ],
    "hash_policy": {
      "algorithm": "sha256",
      "canonicalization": "normalized-json-v1",
      "excluded_fields": ["created_at"]
    }
  }
}
```

**Hash recipe**:

Normalize all nodes and edges in array order as written by the graph builder. The builder must use deterministic ordering: asset order, then `start_us`, then `node_id`; edges sorted by `from_node_id`, `to_node_id`, `type`, `edge_id`. Include input hashes and coverage status. Exclude only declared volatile fields.

**Failure modes**:

| Mode | Behavior |
| --- | --- |
| missing | planning gate blocks dialogue/music-driven projects unless override scopes missing audio graph |
| partial | valid graph with `coverage.status: partial`; no invented dialogue nodes |
| corrupt | graph validation fails; planning gate blocked for graph-dependent workflow |
| stale | if any input hash changes, graph is stale and must be regenerated or overridden |

### 3.4 `continuity_graph.json`

**Proposed schema path**: `schemas/continuity-graph.schema.json`

**Proposed artifact path**: `projects/<id>/03_analysis/continuity_graph.json`

**Schema sketch**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/continuity-graph.schema.json",
  "title": "Video OS Continuity Graph",
  "type": "object",
  "required": [
    "version", "project_id", "artifact_version", "created_at", "source_media_manifest_hash",
    "entities", "segments", "edges", "risks", "provenance"
  ],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "project_id": { "type": "string", "minLength": 1 },
    "artifact_version": { "type": "string", "pattern": "^(analysis|projection)-v\\d+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "source_media_manifest_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "entities": { "type": "array", "items": { "$ref": "#/$defs/entity" } },
    "segments": { "type": "array", "items": { "$ref": "#/$defs/segment-ref" } },
    "edges": { "type": "array", "items": { "$ref": "#/$defs/continuity-edge" } },
    "risks": { "type": "array", "items": { "$ref": "#/$defs/continuity-risk" } },
    "provenance": { "$ref": "#/$defs/artifact-provenance" }
  },
  "$defs": {
    "entity": {
      "type": "object",
      "required": ["entity_id", "entity_type", "status", "evidence_segment_ids", "confidence"],
      "additionalProperties": false,
      "properties": {
        "entity_id": { "type": "string", "pattern": "^ENT_(SUBJECT|LOCATION|PROP|MOTIF|ACTION)_[A-Za-z0-9_-]+$" },
        "entity_type": { "type": "string", "enum": ["subject_cluster", "location", "prop", "motif", "action"] },
        "status": { "type": "string", "enum": ["hypothesis", "confirmed_editing_continuity", "human_confirmed", "redacted"] },
        "label": { "type": ["string", "null"] },
        "evidence_segment_ids": { "type": "array", "items": { "type": "string", "pattern": "^SEG_[A-Za-z0-9_-]+$" } },
        "confidence": { "$ref": "https://example.com/schemas/analysis-common.schema.json#/$defs/confidence-record" }
      }
    },
    "segment-ref": {
      "type": "object",
      "required": ["segment_id", "asset_id", "src_in_us", "src_out_us", "entity_ids"],
      "additionalProperties": false,
      "properties": {
        "segment_id": { "type": "string", "pattern": "^SEG_[A-Za-z0-9_-]+$" },
        "asset_id": { "type": "string", "pattern": "^AST_[A-Za-z0-9_-]+$" },
        "src_in_us": { "type": "integer", "minimum": 0 },
        "src_out_us": { "type": "integer", "minimum": 0 },
        "capture_basis": { "type": "string", "enum": ["manifest_timecode", "file_metadata", "inferred", "unknown"] },
        "entity_ids": { "type": "array", "items": { "type": "string", "pattern": "^ENT_(SUBJECT|LOCATION|PROP|MOTIF|ACTION)_[A-Za-z0-9_-]+$" } }
      }
    },
    "continuity-edge": {
      "type": "object",
      "required": ["edge_id", "from_ref", "to_ref", "type", "confidence"],
      "additionalProperties": false,
      "properties": {
        "edge_id": { "type": "string", "pattern": "^CONEDGE_[A-Za-z0-9_-]+$" },
        "from_ref": { "type": "string", "pattern": "^(SEG|ENT_[A-Z]+)_[A-Za-z0-9_-]+$" },
        "to_ref": { "type": "string", "pattern": "^(SEG|ENT_[A-Z]+)_[A-Za-z0-9_-]+$" },
        "type": {
          "type": "string",
          "enum": [
            "same_subject", "same_location", "chronologically_before", "action_continues",
            "screen_direction_consistent", "screen_direction_break", "visual_match",
            "visual_contrast", "duplicate_semantic_content"
          ]
        },
        "confidence": { "$ref": "https://example.com/schemas/analysis-common.schema.json#/$defs/confidence-record" }
      }
    },
    "continuity-risk": {
      "type": "object",
      "required": ["risk_id", "severity", "type", "refs", "message"],
      "additionalProperties": false,
      "properties": {
        "risk_id": { "type": "string", "pattern": "^CONRISK_[A-Za-z0-9_-]+$" },
        "severity": { "type": "string", "enum": ["info", "warning", "blocker"] },
        "type": { "type": "string", "enum": ["identity_uncertain", "chronology_uncertain", "axis_break", "duplicate_content", "privacy_sensitive", "missing_evidence"] },
        "refs": { "type": "array", "items": { "type": "string" } },
        "message": { "type": "string", "minLength": 1 }
      }
    },
    "artifact-provenance": {
      "type": "object",
      "required": ["producer", "inputs", "hash_policy"],
      "additionalProperties": false,
      "properties": {
        "producer": { "type": "string", "enum": ["analysis-pipeline", "triage-projection"] },
        "inputs": { "type": "array", "items": { "type": "object" } },
        "hash_policy": { "type": "object" }
      }
    }
  }
}
```

ID prefix rules:

- subject clusters: `ENT_SUBJECT_`
- locations: `ENT_LOCATION_`
- props: `ENT_PROP_`
- motifs: `ENT_MOTIF_`
- actions: `ENT_ACTION_`
- segment refs: `SEG_`
- edges: `CONEDGE_`
- risks: `CONRISK_`

**Fixture catalog**:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/continuity_graph/valid_multi_asset_chronological.json` | chronology and same-subject constraints |
| `tests/fixtures/continuity_graph/valid_editorial_reorder.json` | deliberate non-chronological structure |
| `tests/fixtures/continuity_graph/valid_anonymous_subject_clusters.json` | privacy-safe editing clusters |
| `tests/fixtures/continuity_graph/invalid_confirmed_identity_without_human_status.json` | prevents accidental release identity confirmation |
| `tests/fixtures/continuity_graph/invalid_missing_manifest_asset.json` | segment points to missing `AST_` |
| `tests/fixtures/continuity_graph/edge_screen_direction_break.json` | risk record for axis break |
| `tests/fixtures/continuity_graph/edge_duplicate_semantic_content.json` | duplicate candidate warning |

**Producer / Consumer matrix**:

| Producer | Writes | Notes |
| --- | --- | --- |
| analysis pipeline | yes | after source manifest, assets, segments, contact sheets, filmstrips, VLM tags |
| `/triage` projection | no raw mutation | may materialize candidate continuity risk labels |
| human correction workflow | later patch artifact | should not ad hoc edit graph in P3 |

| Consumer | Reads | Gate effect |
| --- | --- | --- |
| `/triage` | yes | avoids redundancy and unintended breaks |
| `/blueprint` | yes | chooses chronological/editorial order and deliberate discontinuities |
| compiler | no direct read | consumes projected planning fields only |
| `/review` | yes | flags unintended continuity break |
| Premiere round-trip diff | yes | explains human reorders |
| `/package` | later refs only | privacy/identity release risk belongs to future privacy report |

**State / Gate mapping**:

- Not required for entering `media_analyzed`.
- Required by `planning_gate` for multi-asset projects or `timeline_order: chronological` unless override is active.
- Stale graph invalidates downstream `selects_candidates.yaml`, `edit_blueprint.yaml`, and `timeline.json`.

**Versioning fields**:

```json
{
  "version": "1.0.0",
  "artifact_version": "analysis-v3",
  "created_at": "2026-04-26T00:00:00Z",
  "provenance": {
    "producer": "analysis-pipeline",
    "inputs": [
      { "path": "projects/demo/03_analysis/segments.json", "hash": "sha256:..." },
      { "path": "projects/demo/03_analysis/assets.json", "hash": "sha256:..." }
    ],
    "hash_policy": {
      "algorithm": "sha256",
      "canonicalization": "normalized-json-v1",
      "excluded_fields": ["created_at"]
    }
  }
}
```

**Hash recipe**:

Normalize deterministic JSON. Sort entities by `entity_id`, segments by `asset_id`, `src_in_us`, `segment_id`, edges by `type`, `from_ref`, `to_ref`, and risks by `risk_id`. Include all input hashes and confidence records.

**Failure modes**:

| Mode | Behavior |
| --- | --- |
| missing | blocks automatic chronological compile for multi-asset projects unless override exists |
| partial | valid with low-confidence `hypothesis` entities and bounded risks |
| corrupt | planning gate blocked for continuity-dependent workflows |
| stale | selected candidates and blueprints that consumed old graph hash become stale |

### 3.5 `editorial_preference_memory.jsonl`

**Proposed schema path**: `schemas/editorial-preference-memory-entry.schema.json`

**Proposed artifact path**: `projects/<id>/00_project/editorial_preference_memory.jsonl`

**Schema sketch**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/editorial-preference-memory-entry.schema.json",
  "title": "Video OS Editorial Preference Memory Entry",
  "type": "object",
  "required": [
    "version", "project_id", "entry_id", "created_at", "actor", "source_event",
    "preference_type", "value", "scope", "confidence", "status", "provenance"
  ],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "project_id": { "type": "string", "minLength": 1 },
    "entry_id": { "type": "string", "pattern": "^EPM_[A-Za-z0-9_-]+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "actor": {
      "type": "object",
      "required": ["type", "id"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["human", "runtime_command", "import_premiere", "package_preflight"] },
        "id": { "type": "string", "minLength": 1 }
      }
    },
    "source_event": {
      "type": "object",
      "required": ["event_type", "event_ref"],
      "additionalProperties": false,
      "properties": {
        "event_type": { "type": "string", "enum": ["operator_command", "blueprint_acceptance", "review_patch_acceptance", "review_patch_rejection", "premiere_import", "package_approval", "redaction"] },
        "event_ref": { "type": "string", "minLength": 1 }
      }
    },
    "preference_type": {
      "type": "string",
      "enum": ["pacing", "chronology", "transition_style", "repetition_tolerance", "bgm_loudness", "caption_density", "override_rationale", "delivery_preference", "redaction"]
    },
    "value": {
      "type": "object",
      "required": ["kind", "data"],
      "additionalProperties": false,
      "properties": {
        "kind": { "type": "string", "enum": ["string", "number", "boolean", "enum", "json"] },
        "data": {}
      }
    },
    "scope": { "type": "string", "enum": ["project", "series", "profile", "delivery", "temporary"] },
    "confidence": { "$ref": "https://example.com/schemas/analysis-common.schema.json#/$defs/confidence-record" },
    "status": { "type": "string", "enum": ["active", "superseded", "rejected", "expired", "redacted"] },
    "supersedes_entry_id": { "type": ["string", "null"], "pattern": "^EPM_[A-Za-z0-9_-]+$" },
    "expires_at": { "type": ["string", "null"], "format": "date-time" },
    "provenance": {
      "type": "object",
      "required": ["producer", "inputs", "hash_policy"],
      "additionalProperties": false,
      "properties": {
        "producer": { "type": "string", "enum": ["operator-command", "blueprint", "review", "import-premiere", "package"] },
        "inputs": { "type": "array", "items": { "type": "object" } },
        "hash_policy": { "type": "object" }
      }
    }
  }
}
```

JSONL file-level rules:

- one strict JSON object per line;
- no array wrapper;
- no trailing comma;
- each line validates against `editorial-preference-memory-entry.schema.json`;
- append-only except future compaction/migration command;
- loader returns `line_number`, `byte_offset`, and last-known-good offset on malformed lines.

ID prefix rules:

- preference entries: `EPM_`

**Fixture catalog**:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/editorial_preference_memory/valid_active_pacing.jsonl` | one active project pacing preference |
| `tests/fixtures/editorial_preference_memory/valid_superseded_transition_style.jsonl` | supersession by later entry |
| `tests/fixtures/editorial_preference_memory/valid_redaction_entry.jsonl` | privacy redaction represented as append entry |
| `tests/fixtures/editorial_preference_memory/invalid_malformed_line.jsonl` | loader reports line and byte offset |
| `tests/fixtures/editorial_preference_memory/invalid_missing_status.jsonl` | required field failure |
| `tests/fixtures/editorial_preference_memory/edge_conflicting_active_preferences.jsonl` | produces unresolved blocker unless priority is explicit |
| `tests/fixtures/editorial_preference_memory/edge_consumed_range_malformed.jsonl` | caller fails when malformed line is inside consumed range |

**Producer / Consumer matrix**:

| Producer | Writes | Notes |
| --- | --- | --- |
| operator preference command | yes | primary writer |
| `/blueprint` | append only after explicit human accept/reject | no silent background write |
| `/review` | append only after explicit human accept/reject | captures accepted house style |
| `/import-premiere` | append only after human confirms import lesson | records learned edit decisions |
| `/package` | append only for explicit delivery preference | must not override delivery profile |

| Consumer | Reads | Gate effect |
| --- | --- | --- |
| `/intent` | yes | preloads known project preferences |
| `/blueprint` | yes | resolves pacing/profile/policy choices |
| `/review` | yes | distinguishes issue from accepted style |
| `/package` | yes | applies delivery preferences only if profile-compatible |

**State / Gate mapping**:

- Exists from project initialization onward.
- Append-only across all states.
- Downstream artifacts store consumed log hash and byte offset.
- Malformed consumed entries block only callers that depend on affected range.

**Versioning fields**:

```json
{
  "version": "1.0.0",
  "entry_id": "EPM_20260426_001",
  "created_at": "2026-04-26T00:00:00Z",
  "provenance": {
    "producer": "operator-command",
    "inputs": [],
    "hash_policy": {
      "algorithm": "sha256",
      "canonicalization": "jsonl-records-v1",
      "excluded_fields": []
    }
  }
}
```

`artifact_version` is not a per-entry required field because the JSONL artifact is an append log. The file-level consumer record should store:

```json
{
  "artifact_version": "preference-log-v1",
  "consumed_offset": 1234,
  "consumed_hash": "sha256:..."
}
```

**Hash recipe**:

Validate each line independently. Normalize each JSON object with deterministic key ordering and UTF-8 NFC. Join normalized records in original line order with `\n`, preserving a terminal newline policy declared by the loader. Hash the ordered normalized record stream. A compacted file must produce an `artifact_migration_log.jsonl` entry once that later-tier artifact exists.

**Failure modes**:

| Mode | Behavior |
| --- | --- |
| missing | allowed; consumers treat as empty log with hash of empty stream |
| partial | malformed line beyond caller consumed offset returns warning and last-known-good offset |
| corrupt | malformed line within consumed range blocks dependent consumer |
| stale | if preference hash changes after blueprint generation, blueprint is stale unless declared unaffected |

### 3.6 `release_safety_report.yaml`

**Proposed schema path**: `schemas/release-safety-report.schema.json`

**Proposed artifact path**: `projects/<id>/07_package/release_safety_report.yaml`

**Schema sketch**:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/release-safety-report.schema.json",
  "title": "Video OS Release Safety Report",
  "type": "object",
  "required": [
    "version", "project_id", "artifact_version", "created_at", "base_timeline_version",
    "source_of_truth", "mode", "summary", "checks", "waivers", "provenance"
  ],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "project_id": { "type": "string", "minLength": 1 },
    "artifact_version": { "type": "string", "pattern": "^(release-safety|package)-v\\d+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "base_timeline_version": { "type": "string", "minLength": 1 },
    "source_of_truth": { "type": "string", "enum": ["engine_render", "nle_finishing"] },
    "mode": { "type": "string", "enum": ["dry_run", "report_only", "enforce"] },
    "summary": {
      "type": "object",
      "required": ["status", "fatal_count", "blocker_count", "warning_count", "waived_count"],
      "additionalProperties": false,
      "properties": {
        "status": { "type": "string", "enum": ["pass", "blocked", "pass_with_waiver", "not_evaluated"] },
        "fatal_count": { "type": "integer", "minimum": 0 },
        "blocker_count": { "type": "integer", "minimum": 0 },
        "warning_count": { "type": "integer", "minimum": 0 },
        "waived_count": { "type": "integer", "minimum": 0 }
      }
    },
    "checks": { "type": "array", "items": { "$ref": "#/$defs/release-check" } },
    "waivers": { "type": "array", "items": { "$ref": "#/$defs/release-waiver" } },
    "provenance": { "$ref": "#/$defs/release-provenance" }
  },
  "$defs": {
    "release-check": {
      "type": "object",
      "required": ["check_id", "category", "severity", "status", "message", "artifact_refs"],
      "additionalProperties": false,
      "properties": {
        "check_id": { "type": "string", "pattern": "^RSCHK_[A-Za-z0-9_-]+$" },
        "category": {
          "type": "string",
          "enum": [
            "editorial_review", "schema_validation", "technical_qa", "delivery_profile", "rights",
            "privacy", "source_of_truth", "caption_audio", "music_audio", "package_completeness",
            "source_manifest"
          ]
        },
        "severity": { "type": "string", "enum": ["info", "warning", "blocker", "fatal"] },
        "status": { "type": "string", "enum": ["pass", "fail", "not_evaluated", "waived"] },
        "message": { "type": "string", "minLength": 1 },
        "artifact_refs": { "type": "array", "items": { "$ref": "#/$defs/artifact-ref" } }
      }
    },
    "release-waiver": {
      "type": "object",
      "required": ["waiver_id", "approved_by", "approved_at", "scope", "reason"],
      "additionalProperties": false,
      "properties": {
        "waiver_id": { "type": "string", "pattern": "^RSWVR_[A-Za-z0-9_-]+$" },
        "approved_by": { "type": "string", "minLength": 1 },
        "approved_at": { "type": "string", "format": "date-time" },
        "scope": { "type": "string", "minLength": 1 },
        "reason": { "type": "string", "minLength": 1 },
        "expires_at": { "type": ["string", "null"], "format": "date-time" },
        "applies_to_artifact_hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" }
      }
    },
    "artifact-ref": {
      "type": "object",
      "required": ["path", "hash"],
      "additionalProperties": false,
      "properties": {
        "path": { "type": "string", "minLength": 1 },
        "hash": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" },
        "required": { "type": "boolean" }
      }
    },
    "release-provenance": {
      "type": "object",
      "required": ["producer", "inputs", "hash_policy"],
      "additionalProperties": false,
      "properties": {
        "producer": { "type": "string", "enum": ["/package", "/render"] },
        "inputs": { "type": "array", "items": { "$ref": "#/$defs/artifact-ref" } },
        "hash_policy": { "type": "object" }
      }
    }
  }
}
```

YAML-specific rule:

- Runtime representation is YAML, but validation and hash calculation use deterministic normalized JSON converted from parsed YAML.
- YAML anchors and aliases are disallowed in canonical files to keep normalization explicit.

ID prefix rules:

- checks: `RSCHK_`
- waivers: `RSWVR_`

**Fixture catalog**:

| Fixture | Purpose |
| --- | --- |
| `tests/fixtures/release_safety_report/valid_dry_run_missing_inputs.yaml` | missing inputs are not blocking |
| `tests/fixtures/release_safety_report/valid_report_only_blocker.yaml` | blocker visible but not enforced |
| `tests/fixtures/release_safety_report/valid_enforce_pass_with_waiver.yaml` | scoped waiver permits pass |
| `tests/fixtures/release_safety_report/invalid_enforce_blocked_summary_pass.yaml` | fatal check cannot coexist with `summary.status: pass` |
| `tests/fixtures/release_safety_report/invalid_missing_base_timeline_version.yaml` | timeline-bound artifact requires base version |
| `tests/fixtures/release_safety_report/edge_public_unknown_rights_fatal.yaml` | external/public profile escalates unknown rights |
| `tests/fixtures/release_safety_report/edge_fatal_review_creative_override.yaml` | fatal review only waived by matching creative override |

**Producer / Consumer matrix**:

| Producer | Writes | Notes |
| --- | --- | --- |
| `/package` | yes | package preflight and report generation |
| `/render` | yes | pre-render release safety preflight |
| existing M4 artifact producers | no | their artifacts remain source of truth |

| Consumer | Reads | Gate effect |
| --- | --- | --- |
| `/render` | yes | report-only before P4, blocks in enforce mode |
| `/package` | yes | refuses finalization only after P4 enforce migration |
| `status` | yes | displays release blockers with artifact refs |
| human operator | yes | approves scoped waivers |

**State / Gate mapping**:

- First useful after `critique_ready`.
- Absent-ok during P1-P3.
- Required for `approved -> packaged` only after P4 enforcement migration.
- `packaging_gate` is `report_only` before enforce and `blocked` only under enforce rules.

**Versioning fields**:

```yaml
version: "1.0.0"
artifact_version: "release-safety-v1"
created_at: "2026-04-26T00:00:00Z"
base_timeline_version: "tl_..."
provenance:
  producer: "/package"
  inputs:
    - path: "projects/demo/05_timeline/timeline.json"
      hash: "sha256:..."
      required: true
  hash_policy:
    algorithm: "sha256"
    canonicalization: "yaml-to-normalized-json-v1"
    excluded_fields:
      - created_at
```

**Hash recipe**:

Parse YAML with a safe parser, reject anchors/aliases, convert to a plain JSON value, sort object keys deterministically, normalize UTF-8 text, omit declared volatile fields, then SHA-256 the normalized JSON bytes.

**Failure modes**:

| Mode | Behavior |
| --- | --- |
| missing | absent-ok in P1-P3; in P4 enforce, packaging gate blocks only for workflows migrated to enforcement |
| partial | `dry_run`/`report_only` may emit `not_evaluated` checks |
| corrupt | status reports validation failure; enforce mode blocks packaging |
| stale | if timeline/review/package/source input hash changes, report is stale and must be regenerated |

## 4. Cross-Artifact Reference Conventions

### ID Prefix Registry

| Prefix | Owner | Meaning |
| --- | --- | --- |
| `AST_` | `source_media_manifest.json` / existing assets | source asset |
| `SEG_` | `segments.json` / continuity graph refs | source segment |
| `TR_` | transcript artifact | transcript document or asset transcript |
| `UTT_` | transcript artifact | utterance |
| `SPK_` | transcript/diarization artifact | speaker label |
| `AE_` | `audio_events.json` | audio event |
| `BGM_` | `bgm-analysis.json` / `music_cues.json` context | BGM section or music cue source |
| `APOL_` | analysis policy | analysis policy ref |
| `ASG_` | audio story graph | graph-owned audio/story node |
| `UTTREF_` | audio story graph | graph-local utterance ref wrapper |
| `SPKREF_` | audio story graph | graph-local speaker ref wrapper |
| `AEREF_` | audio story graph | graph-local audio event ref wrapper |
| `BGMREF_` | audio story graph | graph-local music section ref wrapper |
| `ASGEDGE_` | audio story graph | audio/story edge |
| `ENT_SUBJECT_` | continuity graph | anonymous or confirmed editing-continuity subject cluster |
| `ENT_LOCATION_` | continuity graph | location entity |
| `ENT_PROP_` | continuity graph | prop entity |
| `ENT_MOTIF_` | continuity graph | motif entity |
| `ENT_ACTION_` | continuity graph | action entity |
| `CONEDGE_` | continuity graph | continuity edge |
| `CONRISK_` | continuity graph | continuity risk |
| `EPM_` | editorial preference memory | preference entry |
| `OVR_` | project state / coverage | analysis override |
| `COVBLK_` | coverage report | coverage blocker |
| `RSCHK_` | release safety report | release safety check |
| `RSWVR_` | release safety report | release waiver |

### Foreign Reference Integrity Policy

P1+ validators should enforce three levels:

1. Schema-level format: prefix and type are valid.
2. Artifact-level existence: referenced ID exists in its owner artifact.
3. Hash-level freshness: consumer artifact cites the owner artifact hash that contained the referenced ID.

Foreign references must fail closed for required lanes. Optional references may be `null` only when the field type explicitly permits `null` and the producer records consumer impact.

### Materialize Rule

The compiler must remain provider-free and graph-free. It must not read:

- `audio_story_graph.json`
- `continuity_graph.json`
- embeddings or search shards
- STT/VLM outputs directly

When graph signals affect compile, `/triage` and `/blueprint` must materialize stable refs and derived decisions into:

- `selects_candidates.yaml`
- `edit_blueprint.yaml`
- existing deterministic policy/registry files

Planning artifacts must include the graph hash they consumed, for example:

```yaml
provenance:
  graph_inputs:
    audio_story_graph_hash: "sha256:..."
    continuity_graph_hash: "sha256:..."
    materialized_at: "2026-04-26T00:00:00Z"
  materialized_refs:
    - candidate_ref: "CAND_001"
      audio_story_node_refs: ["ASG_hook_001"]
      continuity_entity_refs: ["ENT_SUBJECT_child_001"]
```

## 5. Versioning And Hash Policy

### Semver Rules

For new MVP artifacts:

- `version` is the schema contract version.
- `artifact_version` is the generated corpus/projection generation identifier.
- `base_timeline_version` is required only for timeline-bound artifacts, currently `release_safety_report.yaml`.
- `created_at` records file creation or regeneration time and may be excluded from content hash only when declared.

Increment rules:

| Change | Version impact |
| --- | --- |
| additive optional field with default-compatible behavior | minor |
| new enum value consumed only by tolerant readers | minor |
| required field added | major |
| enum value removed or renamed | major |
| field type narrowed | major |
| description/comment only | patch |
| fixture-only addition | patch |

Existing M4 artifacts may keep their current field sets. P0 does not require retroactive `artifact_version` insertion into `caption_approval.json`, `music_cues.json`, `package-qa-report.json`, or `package_manifest.json`.

### Normalized JSON Procedure

For JSON:

1. Parse as JSON.
2. Validate against schema.
3. Remove fields listed in `provenance.hash_policy.excluded_fields`.
4. Sort object keys lexicographically at every level.
5. Preserve array order unless the schema declares deterministic producer sorting.
6. Normalize strings to UTF-8 NFC.
7. Serialize with no insignificant whitespace.
8. Hash bytes with SHA-256 and store as `sha256:<hex>`.

For YAML:

1. Parse with a safe YAML parser.
2. Reject anchors, aliases, custom tags, and executable tags.
3. Convert to plain JSON-compatible values.
4. Apply the JSON normalization procedure.

For JSONL:

1. Split by `\n`.
2. Validate one JSON object per non-empty line.
3. Track `line_number` and byte offset.
4. Normalize each record independently.
5. Join normalized records in original order using `\n`.
6. Hash the ordered normalized record stream.

### `base_timeline_version` Update Triggers

`base_timeline_version` must change when the approved `timeline.json.version` changes. Release safety becomes stale when any of these change:

- `timeline.json.version`
- editorial timeline hash
- packaging projection hash
- `review_report.yaml`
- `caption_approval.json`
- `music_cues.json`
- `package-qa-report.json`
- `package_manifest.json`
- `source_media_manifest.json`
- delivery profile selected for release
- handoff source-of-truth decision

### Retrospective Application To Existing Canonical Artifacts

P0 does not require migration of existing canonical artifacts. P1-P4 should apply the new policy only to new MVP artifacts and cite existing M4 artifact hashes as inputs.

Recommended compatibility policy:

- existing artifacts remain valid under their current schemas;
- new artifacts may cite existing artifact hashes;
- package-plane aggregate reports must not copy source-of-truth fields from M4 artifacts;
- future migrations should write `artifact_migration_log.jsonl` after that later-tier artifact is implemented.

## 6. State Machine Wiring

Draft v2 keeps the existing top-level state names. New readiness is represented through gates, not new states.

### Gate Status Proposal

Use these implementation enums:

```yaml
gates:
  analysis_gate:
    status: ready # ready | partial | failed | overridden
    canonical_projection: ready # ready | partial_override | blocked
  planning_gate:
    status: ready # ready | partial | failed | overridden
    canonical_projection: open # open | blocked
  packaging_gate:
    status: report_only # open | blocked | report_only
```

`analysis_gate.status` enum for implementation diagnostics:

- `ready`
- `partial`
- `failed`
- `overridden`

Projection to existing Draft v2 vocabulary:

| Implementation status | `project_state.gates.analysis_gate` |
| --- | --- |
| `ready` | `ready` |
| `partial` | `blocked` |
| `failed` | `blocked` |
| `overridden` | `partial_override` |

### `analysis_gate` Transitions

Ready when:

- `source_media_manifest.json` exists and validates;
- `analysis_coverage_report.json` exists and validates;
- coverage `summary.status == ready`;
- required lanes are `ready`;
- source manifest hash matches current manifest.

Partial when:

- at least one required lane is `partial`, `skipped`, or `failed`;
- no active valid override exists.

Failed when:

- required artifact missing, corrupt, or stale;
- required lane is `failed`;
- `source_manifest` lane is not `ready`.

Overridden when:

- coverage `summary.status == partial_override`;
- `project_state.analysis_override.status == active`;
- override scope names missing lanes, asset IDs, consumers, approver, reason, and expiry or artifact hash.

### `planning_gate` Transitions

Ready when:

- selected workflow's required planning evidence exists;
- audio/story graph is ready for dialogue/music-driven workflows or scoped override exists;
- continuity graph is ready for multi-asset chronological workflows or scoped override exists;
- consumed preference memory range validates;
- materialized graph refs in planning artifacts point to fresh graph hashes.

Partial/overridden when:

- missing graph lanes are bounded to the selected workflow;
- a no-dialogue montage skips diarization with declared impact;
- human override names allowed consumers.

Failed when:

- workflow needs graph evidence and graph is missing/stale/corrupt;
- active preference conflicts create unresolved blockers;
- planning artifacts consume stale graph or preference hashes.

### `packaging_gate` Transitions

P1-P3:

- `release_safety_report.yaml` is absent-ok or report-only.
- Existing final render blockers remain unchanged.
- Status can show release blockers but must not block existing demo/package flows.

P4 enforce:

- `release_safety_report.yaml.mode == enforce`;
- `summary.status == blocked` blocks;
- unwaived fatal checks block;
- missing required delivery profile for public/external output blocks;
- stale/missing/unlicensed used sources block;
- package QA failure blocks;
- fatal review issue blocks unless tied to creative override.

### Override Issuance And Provenance

Overrides may be issued only by explicit human/operator command. They cannot be inferred from missing artifacts.

Required override record:

```yaml
analysis_override:
  status: active
  override_id: OVR_20260426_001
  approved_by: "operator-id"
  approved_at: "2026-04-26T00:00:00Z"
  reason: "No dialogue in music-only montage; STT lane skipped."
  scope:
    lanes: ["stt", "diarization"]
    asset_ids: ["AST_001"]
    allowed_consumers: ["/triage", "/blueprint"]
  expires_at: "2026-05-03T00:00:00Z"
  applies_to_artifact_hash: "sha256:..."
```

Clear or renew override when:

- source manifest hash changes;
- missing lane becomes ready;
- selected candidates, blueprint, or timeline consumes the overridden lane outside scope;
- expiry is reached.

### Artifact-To-Gate Matrix

Implementation proposal:

```yaml
artifact_gate_rules:
  source_media_manifest:
    path: "02_media/source_media_manifest.json"
    gates:
      media_analyzed: required
      analysis_gate: required_ready
      planning_gate: referenced
      packaging_gate: enforce_after_p4
  analysis_coverage_report:
    path: "03_analysis/analysis_coverage_report.json"
    gates:
      media_analyzed: required
      analysis_gate: controller
      planning_gate: graph_lane_input
      packaging_gate: evidence_freshness_after_p4
  audio_story_graph:
    path: "03_analysis/audio_story_graph.json"
    gates:
      media_analyzed: not_required
      planning_gate: required_for_dialogue_or_music
      compile_gate: projected_refs_only
  continuity_graph:
    path: "03_analysis/continuity_graph.json"
    gates:
      media_analyzed: not_required
      planning_gate: required_for_multi_asset_chronological
      compile_gate: projected_refs_only
  editorial_preference_memory:
    path: "00_project/editorial_preference_memory.jsonl"
    gates:
      intent: optional
      planning_gate: consumed_range_must_validate
      review_gate: advisory
  release_safety_report:
    path: "07_package/release_safety_report.yaml"
    gates:
      packaging_gate: absent_ok_until_p4_then_enforce_by_mode
```

## 7. P1 Implementation Allowlist And Plan

### P1 File List

Create:

- `schemas/source-media-manifest.schema.json`
- `schemas/analysis-coverage-report.schema.json`
- `tests/fixtures/source_media_manifest/valid_minimal.json`
- `tests/fixtures/source_media_manifest/valid_mixed_media.json`
- `tests/fixtures/source_media_manifest/valid_inferred_timecode.json`
- `tests/fixtures/source_media_manifest/invalid_missing_fingerprint.json`
- `tests/fixtures/source_media_manifest/invalid_bad_asset_prefix.json`
- `tests/fixtures/source_media_manifest/edge_missing_source.json`
- `tests/fixtures/source_media_manifest/edge_stale_source.json`
- `tests/fixtures/analysis_coverage_report/valid_ready_all_lanes.json`
- `tests/fixtures/analysis_coverage_report/valid_partial_override_stt.json`
- `tests/fixtures/analysis_coverage_report/valid_music_only_skipped_dialogue.json`
- `tests/fixtures/analysis_coverage_report/invalid_missing_source_manifest_hash.json`
- `tests/fixtures/analysis_coverage_report/invalid_ready_with_failed_required_lane.json`
- `tests/fixtures/analysis_coverage_report/edge_stale_manifest_blocks.json`
- `tests/fixtures/analysis_coverage_report/edge_optional_embeddings_skipped.json`

Likely minimal existing-file changes:

- `runtime/validation/schema-validator.ts`: register new schema files.
- `scripts/init-project.ts`: optionally create initial manifest when `--source-dir` is present.
- `runtime/commands/analyze.ts`: write/update manifest and coverage report.
- `runtime/commands/status.ts`: display coverage and gate status.
- `runtime/state/reconcile.ts`: feature-flagged reflection into project state.
- focused tests under `tests/`.

Do not change compiler output behavior in P1 except through disabled/report-only gates.

### Byte-Stable Compatibility Procedure

Run before and after P1 with new gates disabled:

```bash
npm run demo
shasum -a 256 projects/demo/05_timeline/timeline.json
npm test -- --runInBand
```

Expected P1 compatibility:

- existing demo `timeline.json` remains byte-stable when new gates are disabled;
- existing compile path does not require release safety;
- `analysis_coverage_report.summary.status == ready` requires `source_manifest` lane ready only when P1 gate is enabled;
- status may show report-only diagnostics without failing compile.

## 8. Acceptance Checklist For P0 Sign-off

Answer each item Yes/No:

- Does P0 create only `docs/p0-schema-proposals.md`?
- Are all six MVP artifacts covered?
- Does every artifact have a proposed schema path?
- Does every artifact have a proposed runtime artifact path?
- Does every artifact have a schema sketch with `required` fields?
- Does every artifact schema sketch declare `type`?
- Does every artifact schema sketch declare relevant `enum` values?
- Does every artifact schema sketch declare relevant `pattern` values?
- Does every timestamp field use `format: date-time`?
- Does every schema sketch use `additionalProperties: false`?
- Does every artifact have at least one valid fixture proposal?
- Does every artifact have at least one invalid fixture proposal?
- Does every artifact include edge-case fixture proposals?
- Is each artifact producer named?
- Is each artifact consumer named?
- Is each artifact's gate behavior named?
- Are versioning fields specified for each artifact?
- Is a hash recipe specified for each artifact?
- Are missing, partial, corrupt, and stale failure modes specified for each artifact?
- Is the compiler graph-read prohibition explicit?
- Is materialization into planning artifacts explicit?
- Is release safety report-only/absent-ok through P1-P3 explicit?
- Is P4 enforcement migration explicit?
- Is dirty worktree baseline captured?
- Is P1 allowed file scope narrow enough to review?
- Are open questions carried forward instead of silently decided?

Self-evaluation: pass.

## 9. Open Questions Carried To P1

1. STT and diarization provider matrix: schema remains provider-agnostic, but P1/P2 still need an acceptance matrix for OpenAI audio, Groq fallback, and pyannote diarization.
2. Minimum diarization confidence: P2 must decide when speaker-linked story nodes are `ready`, `partial`, or `hypothesis`.
3. Face/privacy boundary: continuity graph should store anonymous editing clusters, but P3/P4 still need the exact handoff to `privacy_face_review_report.yaml`.
4. Rights declaration authority: release safety should check missing/stale/incompatible declarations, but P4 must decide who may approve waivers.
5. Human approval UI: CLI-only first is recommended, but editor UI integration remains unresolved.
6. Search index blocking policy: full-autonomy triage may need stale-search blocking when search influenced candidates; interactive mode may warn.
7. Graph mutation workflow: P2/P3 should decide whether `*_graph_patch.jsonl` is introduced immediately or deferred.
8. Confidence calibration: remains advisory until a delivery profile opts into calibrated confidence.
9. JSONL compaction and redaction: before `artifact_migration_log.jsonl` exists, append redaction entries; later migration policy still needs implementation detail.
10. Existing `project-state.schema.json` gate enum alignment: current schema has `planning_gate: open | blocked`, while Draft v2 discusses `partial_override`; P1 must choose additive migration or diagnostic projection.
11. Whether `artifact_version` belongs inside JSONL entries: this P0 proposes file-level consumed metadata, but P1/P3 may choose per-entry if validators need it.
12. Whether source manifest requires both `content_hash` and `fingerprint`: this P0 makes both required but nullable to express "one must be usable"; runner-level validation must enforce at least one non-null.

## 10. Baseline Snapshot

Start-of-task `git status --short`:

```text
A  .github/ISSUE_TEMPLATE/bug_report.md
A  .github/ISSUE_TEMPLATE/feature_request.md
A  .github/pull_request_template.md
A  .github/workflows/ci.yml
M  .gitignore
A  CODE_OF_CONDUCT.md
A  CONTRIBUTING.md
A  LICENSE
M  README.md
A  SECURITY.md
A  docs/oss-readiness.md
M  editor/client/package-lock.json
M  editor/client/package.json
 M editor/client/src/App.tsx
 M editor/client/src/components/AppShell.tsx
 M editor/client/src/components/ClipBlock.tsx
 M editor/client/src/components/ClipLayer.tsx
 M editor/client/src/components/DiffPanel.tsx
 M editor/client/src/components/EditorLayout.tsx
 M editor/client/src/components/PreviewPlayer.tsx
 M editor/client/src/components/ProgramMonitor.tsx
 M editor/client/src/components/PropertyPanel.tsx
 M editor/client/src/components/Timeline.tsx
 M editor/client/src/components/TrackHeader.tsx
 M editor/client/src/components/TrackLane.tsx
 M editor/client/src/components/TransportBar.tsx
 M editor/client/src/hooks/useDiff.ts
 M editor/client/src/hooks/useEditorKeyboard.ts
 M editor/client/src/hooks/usePlayback.ts
 M editor/client/src/hooks/useProjectSync.ts
 M editor/client/src/hooks/useSourcePlayback.ts
 M editor/client/src/hooks/useTimeline.ts
 M editor/client/src/types.ts
 M editor/client/src/utils/draw.ts
 M editor/client/src/utils/editor-helpers.ts
M  editor/package-lock.json
M  editor/package.json
 M editor/server/index.ts
 M editor/server/routes/media.ts
 M editor/server/routes/preview.ts
 M editor/server/services/watch-hub.ts
 M editor/shared/timeline-validation.ts
M  package-lock.json
M  package.json
M  runtime/commands/package.ts
M  runtime/commands/render.ts
 M runtime/connectors/gemini-vlm.ts
 M runtime/connectors/vlm-peak-detector.ts
A  runtime/packaging/deliverable.ts
M  runtime/packaging/manifest.ts
 M runtime/render/assembler.ts
 M runtime/render/pipeline.ts
M  schemas/timeline-ir.schema.json
M  scripts/init-project.ts
 M scripts/regen-ax1-captions.ts
M  tests/e2e-m4.test.ts
M  tests/package-assembler.test.ts
M  tests/public-cli.test.ts
 M tests/render-pipeline.test.ts
D  tmp/rokutaro-posters-all.jpg
D  tmp/rokutaro-thumbs/39B2F532-BEAD-45B3-B316-531EED5BB9A0.MP4.jpg
D  tmp/rokutaro-thumbs/IMG_0117.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0359.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0543.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0601.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0805.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0944.mov.jpg
D  tmp/rokutaro-thumbs/IMG_0953.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0997.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_1004.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_1163.mov.jpg
D  tmp/rokutaro-thumbs/IMG_1199.mov.jpg
D  tmp/rokutaro-thumbs/IMG_1311.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_1470.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_2481.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_2733.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_3941.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_4149.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_4178.mov.jpg
D  tmp/rokutaro-thumbs/IMG_4342.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_4719.mov.jpg
D  tmp/rokutaro-thumbs/IMG_4742.mov.jpg
D  tmp/rokutaro-thumbs/IMG_6015.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_6482.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_6570.mov.jpg
D  tmp/rokutaro-thumbs/IMG_6645.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_7014.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_7040.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_7167.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_8681.mov.jpg
D  tmp/rokutaro-thumbs/VID_20201024_082154.mov.jpg
D  tmp/rokutaro-thumbs/contact-sheet-labeled.jpg
D  tmp/rokutaro-thumbs/contact-sheet.jpg
D  tmp/rokutaro-thumbs/final-mid.jpg
 M tsconfig.json
?? docs/editor-preview-render-parity-design.md
?? docs/production-readiness-canonical-artifacts-review.md
?? docs/production-readiness-canonical-artifacts.md
?? editor/server/services/preview-job-service.ts
?? editor/shared/caption-style-tokens.ts
?? editor/shared/filtergraph.ts
?? editor/shared/render-spec.ts
?? editor/tests/
?? scripts/render-ax1-promo.ts
```

This P0 adds:

```text
?? docs/p0-schema-proposals.md
```
