# P3 Continuity Graph + Editorial Preference Memory Implementation Notes

## 1. Baseline Snapshot

Started: 2026-04-27 Asia/Tokyo.

Initial `git status --short`:

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
M  editor/shared/timeline-validation.ts
M  package-lock.json
M  package.json
 M runtime/commands/analyze.ts
 M runtime/commands/blueprint.ts
M  runtime/commands/package.ts
M  runtime/commands/render.ts
 M runtime/commands/review.ts
 M runtime/commands/status.ts
 M runtime/commands/triage.ts
 M runtime/connectors/gemini-vlm.ts
 M runtime/connectors/vlm-peak-detector.ts
A  runtime/packaging/deliverable.ts
M  runtime/packaging/manifest.ts
 M runtime/render/assembler.ts
 M runtime/render/pipeline.ts
 M runtime/state/reconcile.ts
 M runtime/validation/schema-validator.ts
M  schemas/timeline-ir.schema.json
MM scripts/init-project.ts
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
?? docs/p0-schema-proposals.md
?? docs/p1-bytestable-investigation-report.md
?? docs/p1-manifest-coverage-implementation-notes.md
?? docs/p2-audio-story-graph-implementation-notes.md
?? docs/production-readiness-canonical-artifacts-review.md
?? docs/production-readiness-canonical-artifacts.md
?? editor/server/services/preview-job-service.ts
?? editor/shared/caption-style-tokens.ts
?? editor/shared/filtergraph.ts
?? editor/shared/render-spec.ts
?? editor/tests/
?? projects/demo/project_state.yaml
?? runtime/artifacts/p1-manifest-coverage.ts
?? runtime/artifacts/p2-audio-story-graph.ts
?? schemas/analysis-coverage-report.schema.json
?? schemas/audio-story-graph.schema.json
?? schemas/source-media-manifest.schema.json
?? scripts/render-ax1-promo.ts
?? tests/analysis-coverage-report.test.ts
?? tests/audio-story-graph.test.ts
?? tests/fixtures/analysis_coverage_report/
?? tests/fixtures/audio_story_graph/
?? tests/fixtures/source_media_manifest/
?? tests/source-media-manifest.test.ts
```

Baseline commands:

```text
npx tsc --noEmit
Result: pass

npx vitest run tests/source-media-manifest.test.ts tests/analysis-coverage-report.test.ts tests/audio-story-graph.test.ts
Result: pass, 3 files, 38 tests

node --input-type=module -e "import fs from 'node:fs'; import crypto from 'node:crypto'; const p='projects/demo/05_timeline/timeline.json'; const data=JSON.parse(fs.readFileSync(p,'utf8')); delete data.created_at; const h=crypto.createHash('sha256').update(JSON.stringify(data),'utf8').digest('hex'); console.log('sha256:'+h);"
Result: sha256:68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100
```

## 2. Allowlist Compliance

P3 touched only paths allowed by docs/p0-schema-proposals.md Section 2 P3 Allowlist:

- `schemas/continuity-graph.schema.json`
- `schemas/editorial-preference-memory-entry.schema.json`
- `tests/fixtures/continuity_graph/`
- `tests/fixtures/editorial_preference_memory/`
- `tests/continuity-graph.test.ts`
- `tests/editorial-preference-memory.test.ts`
- `runtime/artifacts/p3-continuity-graph.ts`
- `runtime/artifacts/p3-preference-memory.ts`
- `runtime/validation/schema-validator.ts`
- `runtime/commands/intent.ts`
- `runtime/commands/triage.ts`
- `runtime/commands/blueprint.ts`
- `runtime/commands/review.ts`
- `runtime/handoff/import/index.ts`
- `docs/p3-continuity-preference-implementation-notes.md`

No `editor/`, compiler output logic, `schemas/project-state.schema.json`, P1/P2 schemas, package files, or existing fixture files were modified by P3.

## 3. Schema Implementation Notes

`schemas/continuity-graph.schema.json` follows P0 Section 3.4:

- required top-level fields: `version`, `project_id`, `artifact_version`, `created_at`, `source_media_manifest_hash`, `entities`, `segments`, `edges`, `risks`, `provenance`;
- ID prefixes: `ENT_SUBJECT_`, `ENT_LOCATION_`, `ENT_PROP_`, `ENT_MOTIF_`, `ENT_ACTION_`, `SEG_`, `CONEDGE_`, `CONRISK_`;
- `confidence` references `analysis-common.schema.json#/$defs/confidence-record`;
- provenance declares `normalized-json-v1` and excludes `created_at`.

`schemas/editorial-preference-memory-entry.schema.json` follows P0 Section 3.5:

- one entry schema only; JSONL file wrapper is intentionally not a schema array;
- `entry_id` uses `EPM_`;
- `status` supports `active`, `superseded`, `rejected`, `expired`, `redacted`;
- no per-entry `artifact_version`, matching P0 file-level metadata decision.

`runtime/validation/schema-validator.ts` now registers `03_analysis/continuity_graph.json` and uses runner-level continuity integrity checks. JSONL preference memory is intentionally handled by the dedicated loader, not by project artifact registry parsing, because it is line-oriented.

## 4. Continuity Builder Notes

Implemented in `runtime/artifacts/p3-continuity-graph.ts`.

- Feature flag: `ENABLE_P3_CONTINUITY_PREFERENCE`; truthy values `1`, `true`, `yes`, `on`; default OFF.
- Builder inputs: manifest, coverage report, assets, segments, optional `createdAt`.
- Builder output: deterministic `continuity_graph.json` shape.
- Sorting: entities by `entity_id`, segments by `asset_id -> src_in_us -> segment_id`, edges by `type -> from_ref -> to_ref -> edge_id`, risks by `risk_id`.
- Hash: `computeContinuityGraphHash`, canonical normalized JSON, `created_at` excluded.
- Runner validation enforces graph-local refs, manifest asset refs, stale manifest hash, segment time order, duplicate IDs, and privacy identity rule.
- Privacy: subject clusters can be anonymous (`label: null`) as `hypothesis`; a subject identity label is only valid as release-safe when `status: human_confirmed`.

## 5. JSONL Loader / Writer / Resolver

Implemented in `runtime/artifacts/p3-preference-memory.ts`.

API:

- `readPreferenceEntries(path, { validateEntry })`
- `readPreferenceEntriesWithConsumedOffset(path, consumedOffset, { validateEntry })`
- `resolveActivePreference(entries, preferenceType)`
- `appendPreferenceEntry(path, entry, { validateEntry })`
- `computePreferenceMemoryHash(rawJsonl)`

Diagnostics:

- malformed JSON: line number, byte offset, raw line, parser error;
- schema invalid line: same diagnostic shape with `schema validation failed`;
- consumed offset: malformed line with `byteOffset < consumedOffset` is `errorsInConsumed`; otherwise `warningsAfterConsumed`;
- last-known-good offset is the byte offset immediately after the last successfully parsed and schema-valid line.

Writer:

- append-only;
- writes exactly one JSON object plus newline;
- never rewrites as an array wrapper;
- rejects schema-invalid entries when a validator is supplied;
- returns `consumedOffset` and `consumedHash`.

Resolver:

- returns one active terminal entry for a type;
- multiple active entries without priority return `active: null`, conflict entries, and an unresolved blocker error string;
- supersession cycles are reported as errors.

## 6. Red To Green

Red confirmation:

```text
npx vitest run tests/continuity-graph.test.ts tests/editorial-preference-memory.test.ts
Result: failed, missing runtime/artifacts/p3-continuity-graph.js and p3-preference-memory.js
```

Green commands:

```text
npx vitest run tests/continuity-graph.test.ts tests/editorial-preference-memory.test.ts
Result: 2 files passed, 24 tests passed

npx vitest run tests/continuity-graph.test.ts tests/editorial-preference-memory.test.ts tests/audio-story-graph.test.ts tests/commands.test.ts
Result: 4 files passed, 137 tests passed

npx tsc --noEmit
Result: pass

npm test
Result: 65 files passed, 1 skipped; 1789 tests passed, 19 skipped
```

## 7. Feature Flag Design

`ENABLE_P3_CONTINUITY_PREFERENCE` is OFF by default. OFF behavior:

- `/intent` does not preload preference memory;
- `/triage` does not materialize continuity refs;
- `/blueprint` does not read continuity graph or preference memory;
- `/review` does not append continuity graph warnings;
- handoff import does not append preference memory;
- compiler continues to read only materialized planning artifacts.

ON behavior:

- `/intent` adds active project-scoped preferences to the injected agent context;
- `/triage` materializes `continuity_graph_hash:*` and `continuity_risk_ref:*` into existing candidate `evidence` and `risks`;
- `/blueprint` materializes continuity/preference refs into existing beat `notes`;
- `/review` emits report-only continuity warnings from continuity risks;
- `runtime/handoff/import/index.ts` can append an import lesson only when the caller supplies both `confirmedPreferenceLesson` and `preferenceMemoryPath`.

## 8. Open Questions

Q3 face/privacy boundary:

- Decision: continuity_graph generates anonymous subject clusters by default: `label: null`, `status: hypothesis`.
- `human_confirmed` is required before a subject identity label is treated as release-safe.
- P4 release safety should block identity release when subject labels are not `human_confirmed`.
- P4 must define the `privacy_face_review_report.yaml` handoff contract.

Q5 human approval UI:

- Decision: P3 is CLI/runtime only.
- Existing `/blueprint accept|reject` and `/review accept|reject` command flow is the target integration point.
- Editor UI integration is P4+.

Q7 graph mutation workflow:

- Decision: no `*_graph_patch.jsonl` in P3.
- `continuity_graph` is fully regenerated.
- `editorial_preference_memory` is append-only; corrections are new entries, supersession, or redaction entries.

Q9 JSONL compaction and redaction:

- Decision: redaction is represented by append-only `status: redacted`.
- No file deletion or in-place edit.
- Compaction is deferred until a later `artifact_migration_log.jsonl`; current implementation assumes append growth.

Q11 artifact_version per-entry:

- Decision: no per-entry `artifact_version`.
- Consumers store file-level `artifact_version`, `consumed_offset`, and `consumed_hash`.

## 9. Canonical Hash Results

Continuity graph:

```text
npx tsx -e "import fs from 'node:fs'; import { computeContinuityGraphHash } from './runtime/artifacts/p3-continuity-graph.ts'; const p='tests/fixtures/continuity_graph/valid_multi_asset_chronological.json'; console.log(computeContinuityGraphHash(JSON.parse(fs.readFileSync(p,'utf8'))));"
Result: sha256:2882a4230b588b99fd8cafa88575df448a4ca4d18447095c196519de2e46d297
```

Demo timeline OFF regression:

```text
node --input-type=module -e "import fs from 'node:fs'; import crypto from 'node:crypto'; const p='projects/demo/05_timeline/timeline.json'; const data=JSON.parse(fs.readFileSync(p,'utf8')); delete data.created_at; const h=crypto.createHash('sha256').update(JSON.stringify(data),'utf8').digest('hex'); console.log('sha256:'+h);"
Result: sha256:68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100
Baseline match: yes
```

## 10. JSONL Hash Result

```text
npx tsx -e "import fs from 'node:fs'; import { computePreferenceMemoryHash } from './runtime/artifacts/p3-preference-memory.ts'; const p='tests/fixtures/editorial_preference_memory/valid_superseded_transition_style.jsonl'; console.log(computePreferenceMemoryHash(fs.readFileSync(p,'utf8')));"
Result: sha256:531c92e4ec0e5dc311da11bec83ad715da9de0444ad5020f89c9f7ba94849ed2
```

Recipe: parse each JSONL line independently, normalize object key order with `normalized-json-v1`, preserve line order, join with newline, keep terminal newline for non-empty logs, SHA-256.

## 11. Compiler Non-Reference Check

```text
rg -n "continuity_graph|continuity-graph|editorial_preference_memory|editorial-preference|p3-continuity|p3-preference|ENABLE_P3_CONTINUITY_PREFERENCE" runtime/compiler scripts/compile-timeline.ts schemas/timeline-ir.schema.json || true
Result: no matches
```

Compiler does not directly read graph/preference artifacts. P3 effects are projected before compile into existing planning artifact fields.

## 12. P4 Handoff

- Enforce `human_confirmed` identity safety in `release_safety_report`.
- Define privacy face review artifact and its handoff to continuity graph.
- Add first-class planning schema graph refs if wrapper strings become insufficient.
- Add preference compaction/migration artifact when JSONL size threshold policy is defined.
- Add UI flow for human approval, supersession, and redaction.
- Add delivery/profile compatibility checks for delivery preferences.

## 13. Ending P3 Status

P3-derived `git status --short` only:

```text
 M runtime/commands/blueprint.ts
 M runtime/commands/intent.ts
 M runtime/commands/review.ts
 M runtime/commands/triage.ts
 M runtime/handoff/import/index.ts
 M runtime/validation/schema-validator.ts
?? docs/p3-continuity-preference-implementation-notes.md
?? runtime/artifacts/p3-continuity-graph.ts
?? runtime/artifacts/p3-preference-memory.ts
?? schemas/continuity-graph.schema.json
?? schemas/editorial-preference-memory-entry.schema.json
?? tests/continuity-graph.test.ts
?? tests/editorial-preference-memory.test.ts
?? tests/fixtures/continuity_graph/
?? tests/fixtures/editorial_preference_memory/
```

## 14. Acceptance Checklist

- [x] allowlist 外のファイル変更ゼロ
- [x] continuity_graph: valid 3件 PASS、invalid 2件 FAIL、edge 2件 risks 期待通り
- [x] preference_memory: valid 3件 PASS、invalid 2件 FAIL、edge fixtures expected 挙動
- [x] foreign reference integrity (continuity_graph) 動作
- [x] supersession chain resolver 動作（循環検出含む）
- [x] JSONL malformed line diagnostics 動作
- [x] consumed_offset 境界判定動作（before=error / after=warning）
- [x] feature-flag OFF で demo timeline canonical hash baseline 一致
- [x] feature-flag OFF で既存テスト全 PASS（1789 pass）
- [x] hash recipe deterministic（continuity と preference 両方）
- [x] deterministic ordering 動作（continuity entities/segments/edges/risks）
- [x] compiler が graph/preference を直接読んでいない（grep 確認）
- [x] preference conflict が unresolved blocker を返す
- [x] redaction entry が削除ではなく append で実装

Self score: pass.
