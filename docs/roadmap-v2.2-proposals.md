# Video OS v2.2 Proposal Backlog

> Reviewed: 2026-03-24
> Scope: current checkout of `video-os-v2-spec`
> Method: architecture/docs read-through, code scan across `runtime/`, `scripts/`, `tests/`, `docs/`, plus local `build` / `test` execution

## Snapshot

- `npm run build` passes on the current checkout.
- `npm test -- --reporter=dot` currently reports `53` test files / `1593` tests, with `9` failures concentrated in FCP7 roundtrip.
- A local import-graph scan across `runtime/` + `scripts/` (`99` files) found no module cycles, so v2.2 should focus more on boundary clarity and reliability than on cycle removal.

## Proposed Roadmap

| ID | Priority | Theme | Size | Depends on |
|---|---|---|---|---|
| V22-01 | P0 | FCP7 self-roundtrip regression repair | 小 | なし |
| V22-02 | P0 | Real QA measurement for `/package` | 中 | なし |
| V22-03 | P1 | Canonical artifact typing and parser hardening | 中 | なし |
| V22-04 | P1 | Module decomposition and layer cleanup | 大 | V22-03 推奨 |
| V22-05 | P1 | `project_state.yaml` atomic write + concurrency guard | 中 | なし |
| V22-06 | P1 | `/review` に実プレビューを統合 | 中 | なし |
| V22-07 | P1 | BGM artifact/source-map alignment | 小 | V22-03 推奨 |
| V22-08 | P1 | Onboarding/public CLI cleanup | 中 | なし |
| V22-09 | P2 | Public CLI / orphan module test coverage | 中 | V22-01, V22-02, V22-08 後 |

## Detailed Proposals

### V22-01. FCP7 self-roundtrip regression repair

- Priority: `P0`
- Size: `小`
- Depends on: `なし`
- Why:
  - Exporter now emits an XML metadata comment before the root `xmeml`: [runtime/handoff/fcp7-xml-export.ts:136](../runtime/handoff/fcp7-xml-export.ts#L136), [runtime/handoff/fcp7-xml-export.ts:140](../runtime/handoff/fcp7-xml-export.ts#L140)
  - Importer expects the parsed root itself, or its direct child, to be `sequence`; if not, it throws immediately: [runtime/handoff/fcp7-xml-import.ts:305](../runtime/handoff/fcp7-xml-import.ts#L305), [runtime/handoff/fcp7-xml-import.ts:312](../runtime/handoff/fcp7-xml-import.ts#L312)
  - Current regression is visible in the roundtrip suite that parses exporter output directly: [tests/fcp7-roundtrip.test.ts:215](../tests/fcp7-roundtrip.test.ts#L215), [tests/fcp7-roundtrip.test.ts:222](../tests/fcp7-roundtrip.test.ts#L222)
  - Local test run on 2026-03-24 failed `9` tests, all in `tests/fcp7-roundtrip.test.ts`.
- Proposal:
  - Make the importer skip XML comments / processing nodes and navigate from `xmeml` to `sequence` robustly.
  - Add a tiny exporter→importer smoke test that runs before the larger diff cases.
  - Keep one fixture with non-ASCII paths and audio metadata so the parser contract does not regress again.

### V22-02. Real QA measurement for `/package`

- Priority: `P0`
- Size: `中`
- Depends on: `なし`
- Why:
  - Engine-render packaging falls back to placeholder values when no metrics are supplied: video/audio duration default to `10000ms`, loudness defaults to `-16.0` / `-1.8`: [runtime/commands/package.ts:223](../runtime/commands/package.ts#L223), [runtime/commands/package.ts:231](../runtime/commands/package.ts#L231)
  - The same pattern exists on the `nle_finishing` path: [runtime/commands/package.ts:355](../runtime/commands/package.ts#L355), [runtime/commands/package.ts:366](../runtime/commands/package.ts#L366)
  - `timeline_schema_valid` is currently treated as “parsed successfully”, not an actual measured output gate: [runtime/commands/package.ts:176](../runtime/commands/package.ts#L176)
  - This means a real package can pass QA without probing the generated media at all.
- Proposal:
  - Add real media measurement helpers for duration drift, loudness, true peak, and dialogue occupancy from emitted artifacts.
  - Persist raw measurements as a canonical artifact such as `07_package/qa-measurements.json`.
  - Make `packageCommand()` consume measured values by default; keep `precomputedMetrics` as test-only injection, not production fallback.

### V22-03. Canonical artifact typing and parser hardening

- Priority: `P1`
- Size: `中`
- Depends on: `なし`
- Why:
  - `/blueprint` redefines artifact interfaces that already exist in compiler types, creating drift risk: [runtime/commands/blueprint.ts:52](../runtime/commands/blueprint.ts#L52), [runtime/commands/blueprint.ts:62](../runtime/commands/blueprint.ts#L62), [runtime/compiler/types.ts:48](../runtime/compiler/types.ts#L48), [runtime/compiler/types.ts:104](../runtime/compiler/types.ts#L104)
  - The same file relies on a stub blueprint plus repeated `as any` casts in the narrative loop: [runtime/commands/blueprint.ts:837](../runtime/commands/blueprint.ts#L837), [runtime/commands/blueprint.ts:894](../runtime/commands/blueprint.ts#L894), [runtime/commands/blueprint.ts:960](../runtime/commands/blueprint.ts#L960), [runtime/commands/blueprint.ts:998](../runtime/commands/blueprint.ts#L998)
  - Additional runtime casts leak into scoring/evaluation helpers: [runtime/script/read.ts:68](../runtime/script/read.ts#L68), [runtime/script/evaluate.ts:100](../runtime/script/evaluate.ts#L100)
  - Render/caption surfaces still carry `any`: [runtime/render/composition.ts:13](../runtime/render/composition.ts#L13), [runtime/render/composition.ts:35](../runtime/render/composition.ts#L35), [runtime/commands/caption.ts:166](../runtime/commands/caption.ts#L166)
- Proposal:
  - Introduce one canonical artifact type module plus typed parse/validate loaders for `creative_brief`, `selects`, `blueprint`, `timeline`, `caption`, and `project_state`.
  - Replace ad-hoc `JSON.parse(...)`/`parseYaml(...) as unknown` with schema-backed loader functions.
  - Remove duplicated interfaces from command modules and make command orchestration depend on canonical artifact types only.

### V22-04. Module decomposition and layer cleanup

- Priority: `P1`
- Size: `大`
- Depends on: `V22-03` 推奨
- Why:
  - Several files have become large orchestration hubs:
    - [runtime/pipeline/ingest.ts](../runtime/pipeline/ingest.ts) (`1508` lines)
    - [runtime/handoff/import.ts](../runtime/handoff/import.ts) (`1403` lines)
    - [runtime/commands/blueprint.ts](../runtime/commands/blueprint.ts) (`1108` lines)
    - [runtime/commands/review.ts](../runtime/commands/review.ts) (`983` lines)
    - [scripts/validate-schemas.ts](../scripts/validate-schemas.ts) (`920` lines)
    - [runtime/state/reconcile.ts](../runtime/state/reconcile.ts) (`761` lines)
  - Runtime layers are already crossing into script-only entrypoints:
    - `reconcile` imports `validateProject` from `scripts/`: [runtime/state/reconcile.ts:13](../runtime/state/reconcile.ts#L13)
    - `runAnalyze` imports `runPreflight` from `scripts/`: [runtime/commands/analyze.ts:18](../runtime/commands/analyze.ts#L18)
  - `initCommand()` calls `reconcile()` on every command start, so the state layer currently owns validation, gate computation, hashing, and self-heal in one place: [runtime/commands/shared.ts:91](../runtime/commands/shared.ts#L91), [runtime/state/reconcile.ts:486](../runtime/state/reconcile.ts#L486), [runtime/state/reconcile.ts:609](../runtime/state/reconcile.ts#L609)
- Proposal:
  - Split `ingest.ts` into stage modules (`ingest`, `segment`, `derivatives`, `stt`, `vlm`, `peak`, `cache`, `gap-report`).
  - Split `handoff/import.ts` into parser, mapping, one-to-many normalization, loss classification, and report builder.
  - Move validation/preflight helpers into `runtime/validation/*` and `runtime/preflight/*` so `runtime/commands/*` stop importing from `scripts/*`.
  - Keep `scripts/*` as thin CLI adapters only.

### V22-05. `project_state.yaml` atomic write + concurrency guard

- Priority: `P1`
- Size: `中`
- Depends on: `なし`
- Why:
  - `project_state.yaml` is written with direct `fs.writeFileSync`, not temp+rename: [runtime/state/reconcile.ts:478](../runtime/state/reconcile.ts#L478), [runtime/state/reconcile.ts:481](../runtime/state/reconcile.ts#L481)
  - Every command startup self-heals and rewrites state immediately: [runtime/commands/shared.ts:98](../runtime/commands/shared.ts#L98), [runtime/commands/shared.ts:102](../runtime/commands/shared.ts#L102)
  - Transition writes happen again later with no revision guard: [runtime/commands/shared.ts:286](../runtime/commands/shared.ts#L286), [runtime/commands/shared.ts:307](../runtime/commands/shared.ts#L307)
  - This is weaker than artifact promotion, which already has hash guards and rollback: [runtime/commands/shared.ts:177](../runtime/commands/shared.ts#L177), [runtime/commands/shared.ts:218](../runtime/commands/shared.ts#L218), [runtime/commands/shared.ts:239](../runtime/commands/shared.ts#L239)
- Proposal:
  - Make `writeProjectState()` atomic via temp file + rename.
  - Add optional state revision / hash guard so concurrent sessions do not silently overwrite each other.
  - Add multi-session tests around `initCommand()` + `transitionState()` on the same project directory.

### V22-06. `/review` に実プレビューを統合

- Priority: `P1`
- Size: `中`
- Depends on: `なし`
- Why:
  - `/review` still writes a JSON placeholder into `05_timeline/review.mp4` and marks preview as skipped: [runtime/commands/review.ts:509](../runtime/commands/review.ts#L509), [runtime/commands/review.ts:816](../runtime/commands/review.ts#L816), [runtime/commands/review.ts:823](../runtime/commands/review.ts#L823), [runtime/commands/review.ts:831](../runtime/commands/review.ts#L831)
  - A real preview CLI already exists and calls the preview renderer: [scripts/preview-segment.ts:7](../scripts/preview-segment.ts#L7), [scripts/preview-segment.ts:95](../scripts/preview-segment.ts#L95)
  - `compile-timeline` already generates a timeline overview image during normal CLI use: [scripts/compile-timeline.ts:116](../scripts/compile-timeline.ts#L116), [scripts/compile-timeline.ts:123](../scripts/compile-timeline.ts#L123)
- Proposal:
  - Replace the placeholder `review.mp4` path with a real low-res preview render in `/review`.
  - Emit a canonical preview manifest plus overview image so roughcut critique can reference actual media, not just schema-valid JSON.
  - Keep a fast-path fallback, but surface it as degraded review evidence rather than a fake `.mp4`.

### V22-07. BGM artifact/source-map alignment

- Priority: `P1`
- Size: `小`
- Depends on: `V22-03` 推奨
- Why:
  - `/analyze` writes BGM analysis after `runPipeline()` completes: [runtime/commands/analyze.ts:157](../runtime/commands/analyze.ts#L157), [runtime/commands/analyze.ts:174](../runtime/commands/analyze.ts#L174), [runtime/commands/analyze.ts:186](../runtime/commands/analyze.ts#L186)
  - The BGM artifact is written to `03_analysis/bgm_analysis.json`: [runtime/media/bgm-analyzer.ts:752](../runtime/media/bgm-analyzer.ts#L752), [runtime/media/bgm-analyzer.ts:763](../runtime/media/bgm-analyzer.ts#L763)
  - `createMediaLinks()` runs inside `runPipeline()` before that post-step: [runtime/pipeline/ingest.ts:1477](../runtime/pipeline/ingest.ts#L1477)
  - `source-map` discovery still probes the legacy `07_package/audio/bgm-analysis.json` location: [runtime/media/source-map.ts:328](../runtime/media/source-map.ts#L328), [runtime/media/source-map.ts:330](../runtime/media/source-map.ts#L330), [runtime/media/source-map.ts:344](../runtime/media/source-map.ts#L344)
- Proposal:
  - Move BGM analysis into the main analysis pipeline before media-link generation, or teach media-link discovery to read `03_analysis/bgm_analysis.json`.
  - Standardize one canonical BGM analysis path and make compiler/render/source-map all consume the same source.

### V22-08. Onboarding/public CLI cleanup

- Priority: `P1`
- Size: `中`
- Depends on: `なし`
- Why:
  - README quickstart shows source-file based analyze usage: [README.md:89](../README.md#L89), [README.md:95](../README.md#L95)
  - Operator checklist still documents `scripts/analyze.ts projects/<project-id>` even though the CLI requires source files plus `--project`: [scripts/operator-checklist.md:20](../scripts/operator-checklist.md#L20), [scripts/operator-checklist.md:28](../scripts/operator-checklist.md#L28), [scripts/analyze.ts:5](../scripts/analyze.ts#L5), [scripts/analyze.ts:117](../scripts/analyze.ts#L117)
  - Project bootstrap is still manual copy/edit of templates with empty `project_id`: [scripts/operator-checklist.md:38](../scripts/operator-checklist.md#L38), [projects/_template/project_state.yaml:2](../projects/_template/project_state.yaml#L2), [projects/_template/06_review/human_notes.yaml:2](../projects/_template/06_review/human_notes.yaml#L2)
  - README’s test count is stale relative to the current repo and the license section is still unresolved: [README.md:195](../README.md#L195), [README.md:201](../README.md#L201), [README.md:221](../README.md#L221), [README.md:223](../README.md#L223)
- Proposal:
  - Ship a supported `init-project` CLI that scaffolds `projects/<id>/` from `_template` and fills required IDs.
  - Add `.env.example` and a single “supported entrypoints” section (`analyze`, `status`, `compile`, `preview`, `export-premiere`, `import-premiere`).
  - Add a docs smoke check so README examples and test counts cannot silently drift.

### V22-09. Public CLI / orphan module test coverage

- Priority: `P2`
- Size: `中`
- Depends on: `V22-01`, `V22-02`, `V22-08` 後
- Why:
  - The current suite is strong on core runtime flows, but several public-facing or potentially dead surfaces have no direct test references in the current tree:
    - [scripts/check-progress.ts](../scripts/check-progress.ts)
    - [scripts/demo.ts](../scripts/demo.ts)
    - [scripts/preview-segment.ts](../scripts/preview-segment.ts)
    - [scripts/export-premiere-xml.ts](../scripts/export-premiere-xml.ts)
    - [scripts/import-premiere-xml.ts](../scripts/import-premiere-xml.ts)
    - [runtime/render/composition.ts](../runtime/render/composition.ts)
  - `runtime/render/composition.ts` is also still a pure stub with `any`-typed props and a hard throw: [runtime/render/composition.ts:13](../runtime/render/composition.ts#L13), [runtime/render/composition.ts:35](../runtime/render/composition.ts#L35), [runtime/render/composition.ts:73](../runtime/render/composition.ts#L73)
- Proposal:
  - Add smoke tests for supported CLIs and remove or quarantine dead stubs that are not part of the supported surface.
  - Prefer contract tests around file outputs / exit codes for CLI wrappers, and fixture tests for preview/render orchestration.

## Suggested Execution Order

1. `V22-01` FCP7 self-roundtrip regression repair
2. `V22-02` Real QA measurement for `/package`
3. `V22-03` Canonical artifact typing and parser hardening
4. `V22-05` `project_state.yaml` atomic write + concurrency guard
5. `V22-07` BGM artifact/source-map alignment
6. `V22-06` `/review` 実プレビュー統合
7. `V22-08` Onboarding/public CLI cleanup
8. `V22-04` Module decomposition and layer cleanup
9. `V22-09` Public CLI / orphan module test coverage

## Notes

- No module cycle remediation item is proposed because no cycles were found in the current runtime/script import graph.
- The most urgent reliability signal is not type-related but behavior-related: the FCP7 exporter/importer pair no longer roundtrips cleanly in the current checkout.
- The most important product-quality gap is packaging QA: today it can report green without measuring the produced media.
