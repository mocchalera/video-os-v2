# P1 Manifest + Coverage Implementation Notes

## 1. Baseline snapshot

Date: 2026-04-26

### Starting `git status --short`

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
?? docs/p0-schema-proposals.md
?? docs/production-readiness-canonical-artifacts-review.md
?? docs/production-readiness-canonical-artifacts.md
?? editor/server/services/preview-job-service.ts
?? editor/shared/caption-style-tokens.ts
?? editor/shared/filtergraph.ts
?? editor/shared/render-spec.ts
?? editor/tests/
?? scripts/render-ax1-promo.ts
```

### Starting demo timeline hash

```text
011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7  projects/demo/05_timeline/timeline.json
```

### Starting test command

```text
npm test -- --runInBand
```

Result: failed before running tests. Vitest rejected `--runInBand` with `CACError: Unknown option --runInBand`.

## 2. Allowlist compliance

P1-authored files are within the P1 allowlist from `docs/p0-schema-proposals.md` lines 72-86.

Created:

- `schemas/source-media-manifest.schema.json` - allowed exact path.
- `schemas/analysis-coverage-report.schema.json` - allowed exact path.
- `runtime/artifacts/p1-manifest-coverage.ts` - allowed by `runtime/artifacts/`.
- `tests/fixtures/source_media_manifest/valid_minimal.json` - allowed by fixture prefix.
- `tests/fixtures/source_media_manifest/valid_mixed_media.json` - allowed by fixture prefix.
- `tests/fixtures/source_media_manifest/valid_inferred_timecode.json` - allowed by fixture prefix.
- `tests/fixtures/source_media_manifest/invalid_missing_fingerprint.json` - allowed by fixture prefix.
- `tests/fixtures/source_media_manifest/invalid_bad_asset_prefix.json` - allowed by fixture prefix.
- `tests/fixtures/source_media_manifest/edge_missing_source.json` - allowed by fixture prefix.
- `tests/fixtures/source_media_manifest/edge_stale_source.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/valid_ready_all_lanes.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/valid_partial_override_stt.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/valid_music_only_skipped_dialogue.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/invalid_missing_source_manifest_hash.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/invalid_ready_with_failed_required_lane.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/edge_stale_manifest_blocks.json` - allowed by fixture prefix.
- `tests/fixtures/analysis_coverage_report/edge_optional_embeddings_skipped.json` - allowed by fixture prefix.
- `tests/source-media-manifest.test.ts` - allowed by `tests/`.
- `tests/analysis-coverage-report.test.ts` - allowed by `tests/`.
- `docs/p1-manifest-coverage-implementation-notes.md` - allowed exact path.

Changed:

- `runtime/validation/schema-validator.ts` - allowed by `runtime/validation/`.
- `runtime/commands/analyze.ts` - allowed exact path.
- `runtime/commands/status.ts` - allowed exact path.
- `runtime/state/reconcile.ts` - allowed by `runtime/state/`.
- `scripts/init-project.ts` - allowed exact path.

Temporary/generated non-allowlist outputs from verification:

- `projects/demo/05_timeline/timeline.json` and `projects/demo/05_timeline/preview-manifest.json` were modified by `npm run demo`; both were restored to the baseline checkout state.
- `projects/demo/project_state.yaml` was created by status/reconcile verification and removed.

## 3. Schema implementation notes

Both schemas follow the P0 Section 3.1 and 3.2 sketches with closed root objects, kebab-case schema filenames, and `$id` values under `https://example.com/schemas/...`.

Intentional runner-level checks:

- Q12 is implemented outside JSON Schema: each source item must have at least one usable `content_hash` or `fingerprint`.
- Coverage semantic validation rejects `summary.status: ready` when the `source_manifest` lane is not ready or when a required lane is pending, partial, skipped, or failed.
- Coverage `partial_override` requires at least one active override ref in the report.

No changes were made to `schemas/project-state.schema.json` because that path is outside the P1 allowlist.

## 4. Test history

Red run:

```text
npx vitest run tests/source-media-manifest.test.ts tests/analysis-coverage-report.test.ts
Result: failed, 2 failed suites, helper module missing: runtime/artifacts/p1-manifest-coverage.js
```

Green focused run:

```text
npx vitest run tests/source-media-manifest.test.ts tests/analysis-coverage-report.test.ts
Result: 2 passed files, 27 passed tests
```

Full run:

```text
npx tsc --noEmit
Result: pass

npm test
Result: 62 passed files, 1 skipped file; 1754 passed tests, 19 skipped tests
```

Fixture validation coverage:

- Source manifest fixtures: 5 schema/runner-valid fixtures pass, 2 invalid fixtures reject.
- Coverage report fixtures: 5 schema/runner-valid fixtures pass, 2 invalid fixtures reject.
- Total fixture files covered: 14.

## 5. Feature flag design

Primary environment variable:

```text
ENABLE_P1_MANIFEST_COVERAGE=1
```

Default: OFF. Accepted truthy values: `1`, `true`, `yes`, `on`.

Compatibility alias:

```text
ENABLE_P1_MANIFEST=1
```

Integration points:

- `scripts/init-project.ts`: writes `02_media/source_media_manifest.json` only when a source dir is provided and the flag is ON.
- `runtime/commands/analyze.ts`: writes/updates manifest and coverage report only when the flag is ON.
- `runtime/commands/status.ts`: exposes coverage summary only when the flag is ON.
- `runtime/state/reconcile.ts`: reads coverage only when the flag is ON; blocked coverage remains report-only and does not newly block existing transitions.

## 6. Open Questions Q10/Q11/Q12

Q10: choose additive migration. The current checked schema already has `analysis_gate: ready | partial_override | blocked`; `planning_gate` remains `open | blocked`. P1 does not change `schemas/project-state.schema.json`. P2 should add any remaining additive gate enum or artifact hash fields under the project-state schema allowlist.

Q11: not applicable in P1 because manifest and coverage are JSON artifacts, not JSONL. Re-evaluate in P3 when JSONL artifacts are implemented.

Q12: keep P0's nullable `content_hash` and `fingerprint` fields, and enforce "at least one non-null" at runner level. Implemented in `validateSourceMediaManifest`.

## 7. Byte-stable verification

Baseline hash:

```text
011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7  projects/demo/05_timeline/timeline.json
```

Flag-OFF smoke inside the P1 test suite:

```text
runStatus(projects/demo) with ENABLE_P1_MANIFEST_COVERAGE unset
Result: timeline hash remained 011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7
```

Required command verification:

```text
npm run demo && shasum -a 256 projects/demo/05_timeline/timeline.json
Result hash: 565723e23c61929a5ed5e77e730113c6a8a0768bb7ddc4777b242c338d90a81a
```

Result: hash did not match the baseline. The command also changed `projects/demo/05_timeline/preview-manifest.json`. These generated changes were restored after measurement. This appears independent of P1 feature-flag code because the compiler/demo path is outside the P1 implementation and the feature flag was OFF, but the acceptance item is marked partial until the pre-existing demo regeneration delta is resolved.

## 8. P2 handoff

- Add any remaining project-state additive enum/hash fields under a P2 allowlist. In particular, decide whether `artifact_hashes` should include `source_media_manifest_hash` and `analysis_coverage_report_hash`.
- Decide whether coverage report status should be persisted into project state as report-only diagnostics, or only exposed through `/status`.
- Add enforcement mode only after report-only behavior has real project evidence.
- Add richer manifest refresh behavior for missing/stale source detection against existing manifest entries.
- Decide how empty source directories should be represented; current schema requires at least one item.

## 9. Ending `git status --short`

P1-derived status:

```text
 M runtime/commands/analyze.ts
 M runtime/commands/status.ts
 M runtime/state/reconcile.ts
 M runtime/validation/schema-validator.ts
MM scripts/init-project.ts
?? docs/p1-manifest-coverage-implementation-notes.md
?? runtime/artifacts/p1-manifest-coverage.ts
?? schemas/analysis-coverage-report.schema.json
?? schemas/source-media-manifest.schema.json
?? tests/analysis-coverage-report.test.ts
?? tests/fixtures/analysis_coverage_report/
?? tests/fixtures/source_media_manifest/
?? tests/source-media-manifest.test.ts
```

Note: `scripts/init-project.ts` was already dirty before P1 and is now `MM`; P1 changes were additive and kept inside the allowlist.

## 10. Acceptance checklist

- [x] Allowlist outside file changes by P1: pass. Demo-generated non-allowlist files were restored and generated project state was removed.
- [x] Fixtures validate/reject as intended: pass for 14 fixture files, with 10 valid/edge pass and 4 invalid reject.
- [ ] Feature-flag OFF with `npm run demo` keeps demo timeline byte-stable: partial/fail. Baseline `011db...` changed to `5657...` under the existing demo command. Generated changes were restored.
- [x] Feature-flag OFF existing tests pass: pass, `npm test` reported 1754 passed / 19 skipped.
- [x] Hash recipe deterministic: pass.
- [x] Notes include baseline and final git status: pass.

