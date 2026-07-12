# P2 Audio Story Graph Implementation Notes

## 1. Baseline Snapshot

### Initial `git status --short`

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
 M runtime/commands/analyze.ts
M  runtime/commands/package.ts
M  runtime/commands/render.ts
 M runtime/commands/status.ts
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
?? docs/production-readiness-canonical-artifacts-review.md
?? docs/production-readiness-canonical-artifacts.md
?? editor/server/services/preview-job-service.ts
?? editor/shared/caption-style-tokens.ts
?? editor/shared/filtergraph.ts
?? editor/shared/render-spec.ts
?? editor/tests/
?? runtime/artifacts/p1-manifest-coverage.ts
?? schemas/analysis-coverage-report.schema.json
?? schemas/source-media-manifest.schema.json
?? scripts/render-ax1-promo.ts
?? tests/analysis-coverage-report.test.ts
?? tests/fixtures/analysis_coverage_report/
?? tests/fixtures/source_media_manifest/
?? tests/source-media-manifest.test.ts
```

### P1 Completion Check

- `npx tsc --noEmit`: pass
- `npx vitest run tests/source-media-manifest.test.ts tests/analysis-coverage-report.test.ts`: pass, 27 tests
- Baseline raw demo timeline hash: `011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7  projects/demo/05_timeline/timeline.json`
- Canonical hash rule for this task: normalized JSON with `created_at` excluded.

## 2. Allowlist Compliance Check

Changed files are all covered by `docs/p0-schema-proposals.md` P2 allowlist lines 95-117.

Created:

- `schemas/audio-story-graph.schema.json` - allowed exact path.
- `tests/fixtures/audio_story_graph/valid_dialogue_heavy.json` - allowed fixture prefix.
- `tests/fixtures/audio_story_graph/valid_music_only_skipped_dialogue.json` - allowed fixture prefix.
- `tests/fixtures/audio_story_graph/valid_audio_events_failed_partial.json` - allowed fixture prefix.
- `tests/fixtures/audio_story_graph/invalid_node_missing_manifest_asset.json` - allowed fixture prefix.
- `tests/fixtures/audio_story_graph/invalid_edge_unknown_node.json` - allowed fixture prefix.
- `tests/fixtures/audio_story_graph/edge_failed_stt_no_dialogue_nodes.json` - allowed fixture prefix.
- `tests/audio-story-graph.test.ts` - allowed by `tests/`.
- `runtime/artifacts/p2-audio-story-graph.ts` - allowed by `runtime/artifacts/`.
- `docs/p2-audio-story-graph-implementation-notes.md` - allowed exact path.

Changed:

- `runtime/validation/schema-validator.ts` - allowed by `runtime/validation/`.
- `runtime/commands/triage.ts` - allowed exact path.
- `runtime/commands/blueprint.ts` - allowed exact path.
- `runtime/commands/review.ts` - allowed exact path.

No `editor/`, compiler output logic, package files, CI files, P0/P1/v2 docs, P1 schemas, or `schemas/project-state.schema.json` were changed for P2.

## 3. Schema Implementation Notes

`schemas/audio-story-graph.schema.json` follows the P0 Section 3.3 sketch:

- closed root object and closed node/edge/ref objects;
- `$id` under `https://example.com/schemas/...`;
- confidence uses `analysis-common.schema.json#/$defs/confidence-record`;
- required `source_media_manifest_hash` and input hashes;
- ID prefix patterns for `ASG_`, `UTTREF_`, `SPKREF_`, `AEREF_`, `BGMREF_`, `ASGEDGE_`, and external `AST_`, `TR_`, `UTT_`, `SPK_`, `AE_`, `BGM_`.

Intentional runner-level checks:

- edge `from_node_id` / `to_node_id` existence is enforced in `validateAudioStoryGraph`;
- node `asset_id` existence in `source_media_manifest` is enforced in `validateAudioStoryGraph`;
- stale `source_media_manifest_hash` is enforced in `validateAudioStoryGraph` when the caller supplies the current manifest hash.

## 4. Builder Implementation Notes

Implemented in `runtime/artifacts/p2-audio-story-graph.ts`.

- Feature flag: `ENABLE_P2_AUDIO_STORY_GRAPH`, truthy values `1`, `true`, `yes`, `on`; default OFF.
- Builder inputs: source manifest, coverage report, transcripts, audio events, BGM analysis.
- Builder does not mutate analysis facts; it emits a new graph object.
- Ordering: nodes sort by source manifest asset order, then `start_us`, then `node_id`; edges sort by `from_node_id`, `to_node_id`, `type`, `edge_id`.
- Hash: `computeAudioStoryGraphHash` uses normalized-json-v1 via the P1 helper and excludes `created_at` from `provenance.hash_policy.excluded_fields`.
- Failed STT: transcript nodes are not invented; graph can still contain audio event/music nodes and `coverage.status: partial`, `dialogue_lane: failed`.
- Coverage lane helper: `addAudioStoryGraphLaneToCoverage` adds a report-only `audio_story_graph` lane with `planning_warn` impact unless ready.
- Runtime projection is feature-flagged:
  - `/triage`: ON only, adds `audio_story_node_ref:*` and graph hash into candidate `evidence`, with small confidence contribution for salient roles.
  - `/blueprint`: ON only, entrypoint wrapper projects graph story roles into existing beat `story_role` and `notes`.
  - `/review`: ON only, entrypoint wrapper adds report-only warnings for setup-without-payoff and awkward audio transition edge types.
  - Compiler remains graph-free.

## 5. Test List And Red To Green

Red run:

```text
npx vitest run tests/audio-story-graph.test.ts
Result: failed, missing runtime/artifacts/p2-audio-story-graph.js
```

Focused Green runs:

```text
npx vitest run tests/audio-story-graph.test.ts
Result: 1 passed file, 11 passed tests

npx vitest run tests/source-media-manifest.test.ts tests/analysis-coverage-report.test.ts tests/audio-story-graph.test.ts
Result: 3 passed files, 38 passed tests
```

Full verification:

```text
npx tsc --noEmit
Result: pass

npm test
Result: 63 passed files, 1 skipped file; 1765 passed tests, 19 skipped tests

npx vitest run tests/audio-story-graph.test.ts tests/commands.test.ts
Result after entrypoint-wrapper allowlist adjustment: 2 passed files, 113 passed tests
```

Fixture coverage:

- valid fixtures accepted: 3.
- invalid fixtures rejected by runner-level integrity: 2.
- edge fixture accepted with `coverage.status: partial` and `dialogue_lane: failed`: 1.

## 6. Feature Flag Design

Environment variable:

```text
ENABLE_P2_AUDIO_STORY_GRAPH
```

Default: OFF. Accepted truthy values: `1`, `true`, `yes`, `on`.

OFF behavior:

- no graph projection in `/triage`, `/blueprint`, or `/review`;
- compiler does not read `audio_story_graph.json`;
- demo timeline canonical hash remains stable with `created_at` excluded.

ON behavior:

- graph may be read by `/triage`, `/blueprint`, and `/review` only;
- graph-derived refs are materialized into planning artifacts using existing schema-compatible fields;
- coverage helper can add an `audio_story_graph` lane as report-only/planning-warn;
- no enforcement mode is introduced.

## 7. Open Questions Q1/Q2/Q7

Q1 STT/diarization provider matrix:

- OpenAI audio is the default STT provider for ready dialogue lanes when network/API use is allowed and word/utterance timing quality is sufficient.
- Groq fallback is acceptable when OpenAI audio fails or latency/cost requires fallback, but output should be marked partial unless timing and language confidence are comparable.
- pyannote diarization is used only for speaker separation when multi-speaker structure matters; if pyannote is absent or confidence is weak, speaker-linked story nodes remain partial/hypothesis rather than blocking graph creation.

Q2 minimum diarization confidence:

- `>= 0.75`: speaker-linked story node can be `ready`.
- `0.55 <= score < 0.75`: node may be emitted as `partial` / hypothesis-quality confidence.
- `< 0.55`: do not create speaker-linked story node; keep utterance-only node if STT is usable.

Q7 graph mutation workflow:

- P2 does not introduce `*_graph_patch.jsonl`.
- Graph is fully regenerated from source facts; corrections happen by updating inputs and rebuilding.
- Patch/mutation workflow is deferred to P3.

## 8. Canonical Hash Verification

Raw baseline before implementation:

```text
011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7  projects/demo/05_timeline/timeline.json
```

Canonical demo verification command:

```bash
canon() {
  node -e 'const fs=require("fs"); const p=process.argv[1]; const d=JSON.parse(fs.readFileSync(p,"utf8")); delete d.created_at; process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(d)).digest("hex"));' "$1"
}
BEFORE=$(canon projects/demo/05_timeline/timeline.json)
unset ENABLE_P2_AUDIO_STORY_GRAPH
npm run demo
AFTER=$(canon projects/demo/05_timeline/timeline.json)
```

Result:

```text
before_canonical=68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100
after_canonical=68c8d701302aa5150f8afd183de1a52711349834f4c9e267cb3544e26e01b100
match=yes
```

`npm run demo` modified `created_at` during verification; `timeline.json` and `preview-manifest.json` were restored from a pre-run backup. Final scoped diff for those files is empty.

Compiler graph-read check:

```bash
rg -n "audio_story_graph|audio-story-graph" runtime/compiler scripts/compile-timeline.ts schemas/timeline-ir.schema.json || true
```

Result: no matches.

## 9. P3 Handoff

- P3 can add continuity graph and preference memory without changing compiler graph-free rules.
- If P3 needs graph mutation, introduce explicit `*_graph_patch.jsonl` with separate schema and freshness policy; do not mutate P2 raw graph in place.
- P3 should decide whether `schemas/project-state.schema.json` gets additive planning gate fields under its own allowlist.
- Consider dedicated tests for ON-mode triage/blueprint/review projection once planning schemas gain first-class graph ref fields.

## 10. Final `git status --short` P2 Delta

```text
 M runtime/commands/blueprint.ts
 M runtime/commands/review.ts
 M runtime/commands/triage.ts
 M runtime/validation/schema-validator.ts
?? docs/p2-audio-story-graph-implementation-notes.md
?? runtime/artifacts/p2-audio-story-graph.ts
?? schemas/audio-story-graph.schema.json
?? tests/audio-story-graph.test.ts
?? tests/fixtures/audio_story_graph/
```

Fixture files under `tests/fixtures/audio_story_graph/`:

```text
tests/fixtures/audio_story_graph/edge_failed_stt_no_dialogue_nodes.json
tests/fixtures/audio_story_graph/invalid_edge_unknown_node.json
tests/fixtures/audio_story_graph/invalid_node_missing_manifest_asset.json
tests/fixtures/audio_story_graph/valid_audio_events_failed_partial.json
tests/fixtures/audio_story_graph/valid_dialogue_heavy.json
tests/fixtures/audio_story_graph/valid_music_only_skipped_dialogue.json
```

## 11. Acceptance Checklist

- [x] allowlist 外のファイル変更ゼロ
- [x] 全 fixture が schema 通り（valid 3件 PASS、invalid 2件 FAIL）
- [x] edge fixture の `coverage.status: partial` が期待通り
- [x] feature-flag OFF で demo timeline canonical hash baseline と一致
- [x] feature-flag OFF で既存テスト全 PASS（回帰なし）
- [x] hash recipe deterministic（同一入力で同一 hash）
- [x] foreign reference integrity validation 動作
- [x] deterministic node/edge ordering 動作
- [x] compiler が `audio_story_graph` を直接読んでいない（grep 確認）
- [x] notes doc に baseline と final の git status を記録
