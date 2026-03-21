# DaVinci Resolve Smoke Test Checklist

Manual smoke test procedure for verifying M3.5 round-trip with DaVinci Resolve.

## Prerequisites

- DaVinci Resolve >= 19 installed
- Python 3.11+ with `opentimelineio==0.17.0` installed
- M3 approved project with `timeline.json`
- `runtime/nle-profiles/resolve-v1.yaml` capability profile

## Step 1: Export OTIO from Video OS

```bash
# From project directory (with approved timeline)
npx ts-node runtime/commands/handoff-export.ts \
  --project-path ./sample-project \
  --profile runtime/nle-profiles/resolve-v1.yaml
```

**Verify:**
- [ ] `handoff_manifest.yaml` created in `exports/handoffs/HND_*/`
- [ ] `handoff_timeline.otio` created alongside manifest
- [ ] Gate 8 passed (no stable ID errors in run log)
- [ ] Manifest contains `verified_roundtrip_surfaces: [trim, reorder, enable_disable]`
- [ ] Manifest contains `lossy_surfaces: [color_finish, fusion_effect, fairlight_advanced_audio]`
- [ ] `bridge_input.json` written with exchange_clip_id metadata per clip

## Step 2: Import OTIO into DaVinci Resolve

1. Open DaVinci Resolve
2. Create new project or open existing
3. File > Import > Timeline > select `handoff_timeline.otio`
4. Accept default import settings

**Verify:**
- [ ] Timeline imports without errors
- [ ] All clips visible on expected tracks
- [ ] Clip names contain or retain stable identifiers
- [ ] Media linked (or offline markers visible if source paths differ)

## Step 3: Perform Human Edits

### 3a. Trim Edit (Verified Surface)
- Select a clip on V1
- Trim the in-point by ~10 frames
- Trim the out-point by ~5 frames

### 3b. Reorder Edit (Verified Surface)
- On the same track (V1), drag a clip from position 1 to position 3
- Confirm the other clips shift (ripple edit)

### 3c. Disable Edit (Verified Surface)
- Right-click a clip > Clip Enable (toggle off)
- Confirm the clip appears dimmed/disabled in the timeline

### 3d. Optional: Provisional Edits
- Add a cross-dissolve transition between two clips (provisional surface)
- Add a timeline marker at any frame (provisional surface)

### 3e. Optional: Lossy Edits
- Apply a Fusion effect to a clip (lossy — will be reported but not auto-applied)
- Apply a color grade in the Color page (lossy)

## Step 4: Export OTIO from DaVinci Resolve

1. File > Export > Timeline > OpenTimelineIO (.otio)
2. Save as `edited_handoff.otio` in the handoff session directory

**Verify:**
- [ ] OTIO file exports successfully
- [ ] File size is reasonable (similar to or larger than original)

## Step 5: Import Back into Video OS

```bash
npx ts-node runtime/commands/handoff-import.ts \
  --manifest exports/handoffs/HND_*/handoff_manifest.yaml \
  --imported-otio exports/handoffs/HND_*/edited_handoff.otio \
  --profile runtime/nle-profiles/resolve-v1.yaml \
  --output-dir exports/handoffs/HND_*/import-results
```

**Verify:**
- [ ] `roundtrip_import_report.yaml` generated
- [ ] `human_revision_diff.yaml` generated
- [ ] Base timeline hash matches (no BASE_HASH_MISMATCH error)
- [ ] Bridge fingerprint comparison: same bridge_version, same OTIO version

## Step 6: Verify Edit Detection

### 6a. Trim Detection
- [ ] `human_revision_diff.yaml` contains `type: trim` operation
- [ ] `before` and `after` source range values reflect the trim
- [ ] `delta.in_us` and `delta.out_us` are non-zero
- [ ] `surface: verified_roundtrip`
- [ ] `confidence: exact` (metadata retained) or `confidence: fallback`

### 6b. Reorder Detection
- [ ] `type: reorder` operation present
- [ ] Before/after `timeline_in_frame` values differ
- [ ] Ripple normalization correctly distinguishes reorder from ripple shift
- [ ] `surface: verified_roundtrip`

### 6c. Disable Detection
- [ ] `type: enable_disable` operation present
- [ ] `enabled: false` in the operation
- [ ] `surface: verified_roundtrip`

### 6d. Provisional Edit Detection (if performed)
- [ ] `type: simple_transition` present with `surface: provisional_roundtrip`
- [ ] `type: timeline_marker_add` present with `surface: provisional_roundtrip`

### 6e. Lossy Edit Reporting (if performed)
- [ ] `unmapped_edits` contains `classification: color_finish` or `classification: plugin_effect`
- [ ] All lossy items have `review_required: true`
- [ ] Lossy edits do NOT appear as operations (they are report-only)

## Step 7: Verify One-to-Many (if applicable)

If a clip was split in Resolve (blade tool):
- [ ] `roundtrip_import_report.yaml` contains `split_entries`
- [ ] Child IDs follow `{parent}#S01`, `{parent}#S02` pattern
- [ ] `review_required: true`
- [ ] Source ranges of children don't overlap (split, not duplicate)

If a clip was duplicated (copy-paste):
- [ ] `duplicate_entries` present
- [ ] Copy IDs follow `{parent}#D01` pattern
- [ ] Overlapping source ranges detected

## Step 8: Verify Stable ID Retention

- [ ] `mapping_summary.exact_matches` accounts for most clips
- [ ] `exchange_clip_id` metadata survives the Resolve round-trip
- [ ] If metadata was stripped, fallback mapping (`clip_id_or_name_fallback`) succeeded
- [ ] If fallback also failed, `provisional` mappings logged with source signatures

## Step 9: Verify Gate 9 (Review Requirement)

- [ ] If unmapped edits exist: `status: review_required` in diff
- [ ] If only lossy edits: `status: lossy` or `status: review_required`
- [ ] If no edits: `status: clean` (or `review_required` from lossy surfaces)
- [ ] No auto-accept of unmapped edits without review

## Step 10: Verify Re-entry Evidence

```bash
# Check consumer classification
grep -A2 "consumer:" exports/handoffs/HND_*/import-results/*.yaml
```

- [ ] Trim/reorder ops classified as `roughcut_critic`
- [ ] Enable/disable/structural ops classified as `blueprint_planner`
- [ ] Split/duplicate unmapped edits classified as `blueprint_planner`
- [ ] Lossy/vendor items classified as `report_only`

## Result Summary

| Test | Status | Notes |
|------|--------|-------|
| OTIO Export | | |
| Resolve Import | | |
| Trim Detection | | |
| Reorder Detection | | |
| Disable Detection | | |
| Transition Detection | | |
| Marker Detection | | |
| Lossy Reporting | | |
| Split Classification | | |
| Duplicate Classification | | |
| Stable ID Retention | | |
| Gate 9 Enforcement | | |
| Re-entry Consumer Routing | | |
| Schema Validation | | |

**Tester:** _______________
**Date:** _______________
**Resolve Version:** _______________
**OTIO Version:** _______________
