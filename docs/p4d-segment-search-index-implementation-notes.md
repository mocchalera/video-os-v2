# P4d Segment Search Index Implementation Notes

## 1. Baseline Snapshot

- Start git status: existing dirty worktree was broad, including `.github/`, `editor/`, package files, render/package changes, `schemas/timeline-ir.schema.json`, and deleted `tmp/rokutaro-*` assets. P4d work stayed inside the requested allowlist.
- Demo timeline canonical hash before implementation: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`.
- Baseline tests before implementation: `npx vitest run` passed `70` files with `1861` tests passed and `12` skipped.
- Baseline typecheck: `npm run build` passed.

## 2. Allowlist Compliance

Created:

- `schemas/segment-search-index-manifest.schema.json`
- `schemas/segment-text-index.schema.json`
- `scripts/rebuild-segment-search-index.ts`
- `runtime/artifacts/p4d-segment-search-index.ts`
- `tests/segment-search-index.test.ts`
- `tests/fixtures/segment_search_index/*`
- `tests/fixtures/segment_text_index/*`
- `docs/p4d-segment-search-index-implementation-notes.md`

Changed existing allowlisted files only:

- `runtime/validation/schema-validator.ts`
- `schemas/selects-candidates.schema.json`
- `runtime/commands/triage.ts`
- `runtime/commands/status.ts`
- `runtime/artifacts/p4a-release-safety.ts`
- `tests/release-safety-report.test.ts`

No compiler output logic, existing P1-P4c artifact schemas, existing fixtures, package files, or editor files were changed by P4d.

## 3. Manifest Schema Final Shape

`segment-search-index-manifest.schema.json` defines a canonical root object with `version`, `project_id`, `artifact_version: search-index-v1`, `created_at`, `index_id: SIDX_*`, input hash snapshot, indexed field structure, text index ref, provider-dependent vector shard refs, and artifact provenance.

Vector shards are references only. The schema accepts `hash: null` for absent derived shards and does not define a shard payload schema.

## 4. Text Index Schema Final Shape

`segment-text-index.schema.json` defines `artifact_version: text-index-v1`, matching `index_id`, and per-segment normalized text entries. Each entry carries `SEG_*` segment id, `AST_*` asset id, token refs, and a source artifact ref typed as `transcript`, `audio_story_node`, or `continuity_entity`.

Normalization implemented by the rebuild CLI is UTF-8 NFC plus whitespace collapse to single spaces.

## 5. Selects Candidates Extension

`schemas/selects-candidates.schema.json` now allows optional root `provenance.search_index_manifest_hash`.

The field is optional and additive. Existing fixtures without `provenance` or without the search hash remain valid.

## 6. Loader Hash Stale Check

`runtime/artifacts/p4d-segment-search-index.ts` provides:

- Feature flag: `ENABLE_P4D_SEARCH_INDEX`
- Autonomy mode: `SEARCH_INDEX_AUTONOMY`, default `interactive`
- Manifest/text loaders gated off when the feature flag is disabled
- Canonical hash helpers using `normalized-json-v1` with `created_at` excluded
- Current input hash snapshot for source manifest, assets, segments, transcripts, audio story graph, continuity graph, preference memory, and coverage report
- Stale reason generation and release check generation
- Selects materialization helper for `provenance.search_index_manifest_hash`

## 7. Rebuild CLI

Command:

```bash
ENABLE_P4D_SEARCH_INDEX=true npx tsx scripts/rebuild-segment-search-index.ts --project <project> --output-dir <project>/03_analysis/search --tokenizer japanese_morpheme
```

The CLI refuses to run when `ENABLE_P4D_SEARCH_INDEX` is off. It writes:

- `segment_text_index.json`
- `segment_search_index_manifest.json`

Vector shards are skipped in P4d; `vector_shards` is an empty array.

## 8. P4a Integration

`runtime/artifacts/p4a-release-safety.ts` appends search freshness checks inside the existing `source_manifest` category. Existing source manifest freshness logic is unchanged.

When P4d is disabled, no search manifest is loaded and no search check is added.

## 9. Triage Integration

`runtime/commands/triage.ts` follows the beta first-class materialization pattern. With P4d enabled, if candidates carry search evidence, the loaded manifest canonical hash is written to `selects_candidates.provenance.search_index_manifest_hash`.

With P4d disabled, triage output remains unchanged and the search hash is not written.

## 10. Tests Red To Green

Red confirmation:

- Focused tests failed before implementation because `runtime/artifacts/p4d-segment-search-index.ts` was missing and P4a did not emit the new search stale check.

Green confirmation:

- `npx vitest run tests/segment-search-index.test.ts tests/release-safety-report.test.ts`: `44` tests passed.
- `npx vitest run`: `71` files passed, `1` skipped; `1882` tests passed, `12` skipped.
- `npm run build`: passed.

## 11. Feature Flags

- `ENABLE_P4D_SEARCH_INDEX`: default false.
- `SEARCH_INDEX_AUTONOMY=interactive`: default, stale search index is a warning.
- `SEARCH_INDEX_AUTONOMY=full`: stale search index is a blocker.

OFF mode behavior:

- Search manifest loader returns `null`.
- Triage does not materialize `search_index_manifest_hash`.
- P4a search stale detection is a no-op.

## 12. Open Question Q6

Decision: stale search index is not a universal compile/render blocker.

- `SEARCH_INDEX_AUTONOMY=full`: stale search index is a `blocker`.
- `SEARCH_INDEX_AUTONOMY=interactive`: stale search index is a `warning`.

Rationale: search index absence or staleness must not block final render. It only blocks or warns for search-dependent automation, matching the production-readiness policy that full-autonomy triage may block while interactive triage can warn and continue.

Q9 JSONL compaction and Q11 artifact_version per entry remain out of scope.

## 13. Canonical Hash Verification

- Demo timeline canonical hash after implementation: `68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100`.
- Search manifest and text index hash tests verify `created_at` exclusion and stable `sha256:*` output.

## 14. Existing Fixture Compatibility

Existing fixtures were not edited. Full test pass confirms current planning, release safety, delivery profile, confidence calibration, and compiler tests remain compatible.

## 15. P4 Phase Completion Summary

- P4a: release safety dry-run report remains additive.
- P4b: delivery profile checks remain independent.
- P4c: confidence calibration checks remain gated by their own flag.
- P4d: search index manifest, lexical index, rebuild CLI, triage materialization, status visibility, and P4a stale detection are now integrated behind a default-off flag.

## 16. Ending Git Status P4d Subset

```text
 M runtime/artifacts/p4a-release-safety.ts
 M runtime/commands/status.ts
 M runtime/commands/triage.ts
 M runtime/validation/schema-validator.ts
 M schemas/selects-candidates.schema.json
 M tests/release-safety-report.test.ts
?? docs/p4d-segment-search-index-implementation-notes.md
?? runtime/artifacts/p4d-segment-search-index.ts
?? schemas/segment-search-index-manifest.schema.json
?? schemas/segment-text-index.schema.json
?? scripts/rebuild-segment-search-index.ts
?? tests/fixtures/segment_search_index/
?? tests/fixtures/segment_text_index/
?? tests/segment-search-index.test.ts
```

## 17. Acceptance Checklist

- [x] allowlist 外変更ゼロ for P4d work
- [x] manifest schema valid 3 / invalid 2 / edge 1
- [x] text_index schema valid 2 / invalid 1
- [x] flag OFF demo canonical hash baseline一致
- [x] flag OFF full regression pass
- [x] flag ON + AUTONOMY=full stale -> blocker
- [x] flag ON + AUTONOMY=interactive stale -> warning
- [x] hash recipe deterministic
- [x] `search_index_manifest_hash` remains optional
- [x] rebuild CLI does not affect runtime output unless explicitly run
- [x] baseline and final git status recorded
