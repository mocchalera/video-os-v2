# Footage DB Implementation Review

## Summary

The SQLite schema in `runtime/artifacts/footage-db-builder.ts` matches the unified design DDL: required tables, indexes, FTS5 table, embedding tables, metadata, warnings, and source tracking are present. The builder also enables foreign keys, writes a temp DB, runs `PRAGMA integrity_check`, writes the build report, and keeps structured/FTS search usable when embeddings are skipped or unavailable.

The main implementation risks are not in the base DDL. They are in behavior around defaults and fallback: the builder/CLI default to skipping embeddings even though the unified design resolved the default as `auto`, and JSON fallback ignores several filter types while silently returning results. FTS query construction is parameterized and generally escaped, but boolean mode is inferred from any uppercase `AND`/`OR`/`NOT`, which lets normal prompt text change query semantics.

Verification run:

- `npx vitest run tests/footage-db.test.ts` passed: 6 tests.
- `npx tsc --noEmit` passed.

## Issues Found

### High - JSON fallback ignores important filters

`runtime/tools/footage-search.ts:815` enters direct JSON fallback when the DB is missing or malformed, but `fallbackFilter(...)` only enforces asset, segment type, duration, exclusion, dialogue/text, and quality filters at `runtime/tools/footage-search.ts:866`. It does not enforce `shooting_date`, `shooting_time_start`, `shooting_time_end`, `camera_type`, `place_hint_name`, or `place_hint_category`, even though those filters are part of `FootageSearchFilters` and are implemented for SQLite at `runtime/tools/footage-search.ts:469`.

This means a missing or malformed DB can return clips that violate requested filters without any warning. That weakens the design requirement for direct JSON fallback and is especially risky for the agent because fallback results have the same response shape and can look authoritative.

Related fallback correctness problems:

- `has_text` fallback uses `fallbackText(...)` at `runtime/tools/footage-search.ts:928`, which includes summary and tags. The design defines `has_text` as OCR or transcript text, not generic metadata.
- `has_dialogue` fallback at `runtime/tools/footage-search.ts:874` does not honor `segment_type = "dialogue"` unless transcript text is also present.
- `fallbackRow(...)` leaves place fields null at `runtime/tools/footage-search.ts:915`, so place filters cannot work in fallback even when `segments.json` contains `visual_appraisal.place_hint`.

### Medium - Embedding default is `skip`, not design-default `auto`

The unified design resolves `embeddingPolicy` default to `auto`, so cached `Xenova/multilingual-e5-small:q8` embeddings are built when available and missing models degrade to FTS/structured search. The implementation defaults to `skip` in both the builder and CLI:

- `runtime/artifacts/footage-db-builder.ts:340`
- `scripts/build-footage-db.ts:53`

With the current default path, semantic rows are never attempted unless callers explicitly pass `embeddingPolicy: "auto"` or `--embedding-policy auto`. This makes semantic/hybrid search appear implemented but unavailable for default builds, including likely agent or CLI usage.

### Medium - FTS boolean mode is inferred too eagerly

`searchFootageWithDb(...)` enables explicit boolean syntax whenever the text contains uppercase `AND`, `OR`, or `NOT` at `runtime/tools/footage-search.ts:390`. The builder then preserves those tokens in `booleanFtsExpression(...)` at `runtime/tools/footage-search.ts:990`.

SQL injection is mitigated because the `MATCH` value is bound as `@fts_match` and non-operator tokens are quoted. The issue is query correctness and prompt safety: ordinary prompt text such as `this is NOT that` becomes `"this" "is" NOT "that"` and can return no rows because `NOT` is treated as an FTS operator. The design says boolean syntax should be preserved only when `explicitBoolean` is true, but the public `SearchFootageInput` has no explicit flag, so callers cannot intentionally distinguish Boolean syntax from natural language.

There is also an operator-precedence risk for CJK boolean queries because expanded CJK alternatives are joined with `OR` without grouping. A query shaped like `<CJK term> AND <term>` can become `<full CJK phrase> OR <char> OR <bigram> AND <term>`, which does not preserve the intended Boolean grouping.

### Low - Marlin event lookup is N+1

`marlinEventLookup(...)` prepares one statement but executes it once per result row at `runtime/tools/footage-search.ts:628`. For the design target of fewer than 1,000 segments this is unlikely to be a blocker, but it is an obvious avoidable N+1 query in broad structured/hybrid searches. A single `asset_id IN (...)` query followed by TypeScript overlap filtering would keep behavior deterministic and reduce SQLite round trips.

### Low - `--rebuild-mode incremental` is accepted but ignored

The CLI accepts `--rebuild-mode full|incremental` at `scripts/build-footage-db.ts:32`, and `BuildFootageDbOptions` exposes `rebuildMode` at `runtime/artifacts/footage-db-builder.ts:19`, but `buildFootageDb(...)` never reads it. If incremental is intentionally future-only, the CLI should reject or warn rather than silently doing a full rebuild.

## Test Gaps

- No fallback tests for `shooting_date`, `shooting_time_*`, `camera_type`, `place_hint_*`, `has_text`, or `has_dialogue` when the DB is missing or malformed.
- No corrupt/malformed DB test proving `readFootageDbStatus(...)` and `searchFootage(...)` fall back cleanly.
- No tests for missing required source files, skipped optional sources, malformed transcript JSON, or empty `segments.json`.
- No tests for default `embeddingPolicy` behavior. Current tests always pass `skip` or `require`, so the `auto` vs `skip` mismatch is invisible.
- No FTS tests for embedded quotes, natural-language uppercase `NOT`, unsupported syntax, or CJK expansion combined with Boolean operators.
- No runtime validation tests for filter JSON coming from a future `filters_json` adapter, including unknown quality fields and out-of-range numeric values.
- No integration test for `createEditorialToolkit(...)` exposing and executing `search_footage`.

## Recommendations

1. Make fallback filtering semantically match SQLite filtering, or return warnings for filters that fallback cannot honor. Prioritize date/time/camera/place filters and the correct `has_text`/`has_dialogue` definitions.
2. Change the builder and CLI default embedding policy to `auto`, or update the unified design if the intended rollout default is now `skip`.
3. Add an explicit boolean-query option to `SearchFootageInput` or stop auto-enabling Boolean syntax from natural-language query text. Group CJK expansion alternatives before combining them with Boolean operators.
4. Add the missing fallback, malformed DB, FTS escaping, and default-policy tests before wiring this into agent behavior.
5. Keep `search_footage` integration simple: `editorial-tools.ts` can wrap `searchFootage(...)` with flat `query`, `mode`, `filters_json`, and `limit` parameters as designed, but it needs a strict `filters_json` parser before exposing agent input.
6. Batch Marlin event lookup once the functional issues are fixed.
