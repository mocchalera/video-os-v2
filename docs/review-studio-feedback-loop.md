# Review: Studio Feedback Loop Design

Date: 2026-06-22
Target: `docs/design-studio-feedback-loop.md`
Scope: Architecture review only. No runtime or Swift changes.

## Verdict

The direction is sound: Studio should express human review as an auditable patch, and the deterministic compiler should remain the authority for `timeline.json`. However, the current design cannot be implemented as written because its Section 2.1 patch schema is incompatible with the existing compiler patch contract and with the Studio "Apply Review Patch" path. The design also needs a clearer split between preview patches and durable planning/artifact commits, otherwise human decisions can disappear on the next full compile.

Recommended decision: keep "Review Patch" as the feedback contract, but align Phase 1 with the existing `timeline_version` + `replace_segment`/`trim_segment`/`move_segment`/`insert_segment`/`remove_segment` contract first. Add Studio-only metadata and approval/rejection UI state around that contract, not inside it, unless the schema and compiler are extended together.

## Priority Findings

### P0. Section 2.1 `ReviewPatch` is not compatible with the current compiler

The design proposes top-level fields `version`, `project_id`, `created_at`, `source`, and `base_timeline_hash`, plus operations such as `swap_clip`, `reject_clip`, `approve_clip`, `reorder_beat`, `adjust_trim`, `insert_clip`, and `set_transition` (`docs/design-studio-feedback-loop.md:37-60`). The current schema requires only `timeline_version` and `operations`, disallows additional top-level properties, and only allows `replace_segment`, `trim_segment`, `move_segment`, `insert_segment`, `remove_segment`, `change_audio_policy`, `add_marker`, and `add_note` (`schemas/review-patch.schema.json:6-34`, `:101`). The runtime applicator has the same operation set (`runtime/compiler/patch.ts:22-30`, `:193-211`).

The existing Studio "Apply Review Patch" path does not translate Studio-style operations. `compileSelectedProjectWithReviewPatch()` simply passes `06_review/review_patch.json` to `ProjectRoughCutCompileRunner`, and the runner invokes `npx tsx scripts/compile-timeline.ts <project> --patch <patch>` (`apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:1530-1543`, `apps/macos-studio/Sources/VideoOSStudioCore/ProjectRoughCutCompileRunner.swift:66-83`, `scripts/compile-timeline.ts:263-269`). Therefore the proposed Section 2.1 JSON would not be accepted by the existing feature.

Recommended mapping for Phase 1:

| UI gesture | Current compiler op | Notes |
|---|---|---|
| Swap clip | `replace_segment` | Use `target_clip_id` + `with_segment_id`, not `replacement_segment_id`. |
| Adjust trim | `trim_segment` | Must include `reason`; validate `new_src_in_us < new_src_out_us` in Swift before writing. |
| Remove clip | `remove_segment` | Equivalent to destructive removal from preview timeline. |
| Insert clip | `insert_segment` | Builder must compute `new_timeline_in_frame` and `new_duration_frames`; current runtime defaults are unsafe for UI use. |
| Reorder beat | multiple `move_segment` ops | Existing patch layer has no beat-order primitive. |
| Approve clip | not a compiler mutation | Store as Studio feedback/annotation, or compile to `add_note` only if a timeline marker is desired. |
| Reject clip | UI state or `remove_segment` | If rejection must survive future compiles, it must mutate/promote into selects or preference memory, not only patched timeline. |
| Set transition | unsupported | Needs a separate compiler extension before UI exposure. |

Also note that the schema already has `with_candidate_ref`, but `applyPatch()` builds its replacement lookup by `segment_id` only (`runtime/compiler/patch.ts:155-159`, `:235-238`). Candidate Browser should not promise candidate-ref-precise swaps until the patch runtime supports that lookup.

### P0. `base_timeline_hash` is useful but not sufficient as currently framed

The design correctly wants a base hash, but current patch application checks only `patch.timeline_version !== timeline.version` (`runtime/compiler/patch.ts:124-150`). `base_timeline_hash` exists today in the preview playback contract, not in review patch application: the compiler stamps a 16-hex SHA-256 prefix into `preview-manifest.json`, and Swift re-computes the same hash to detect stale playback (`runtime/compiler/export.ts:180-193`, `apps/macos-studio/Sources/VideoOSStudioCore/ProjectPlaybackContractStatus.swift:57-103`).

If the design adds `base_timeline_hash`, it must specify where it is checked. The check should happen before invoking or inside `scripts/compile-timeline.ts --patch`, not only in Swift UI state. For non-adversarial stale detection, a raw-file hash is enough; for a durable patch contract, use both:

- `timeline_version` for compatibility with current compiler behavior.
- Full `sha256:<64 hex>` `base_timeline_hash` for exact stale detection, or explicitly document if the project continues using 16 hex for artifact-status parity.
- Per-op preconditions such as target clip `segment_id`, `candidate_ref`, `src_in_us`, `src_out_us`, and `timeline_in_frame`, so conflicts can be reported at clip granularity instead of rejecting the entire patch with a generic stale-file message.

### P0. Preview patch and durable commit are conflated

The design says the UI never mutates `timeline.json` directly and the compiler is the source of truth (`docs/design-studio-feedback-loop.md:21-35`). The current patch path does write the patched `05_timeline/timeline.json` directly, then regenerates `preview-manifest.json` (`scripts/compile-timeline.ts:223-237`). It does not mutate `selects_candidates.yaml` or `edit_blueprint.yaml`. A later normal compile can therefore discard Studio swaps/rejections unless the patch is re-applied or promoted.

This needs an explicit mode split:

- Preview mode: write a Studio-generated patch file, apply it to `timeline.json`, reload the viewer, and archive the patch with base/result hashes.
- Commit/promote mode: either update planning artifacts through a controlled path, or record the accepted patch in a durable patch chain that every future compile applies.

Without that split, "Zero data loss" is not guaranteed (`docs/design-studio-feedback-loop.md:380`).

### P1. `StudioViewModel` should not own patch construction

`StudioViewModel` is already 2,231 lines and coordinates project scanning, playback, analysis, compile, render, media relink/proxies, Marlin, audio story graph, editor annotations, readiness actions, RAG, and Codex sessions (`apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift:15-120`). Adding `pendingPatch`, validation, conflicts, diff state, history, undo, and Candidate Browser selection directly to it will make the main model harder to reason about.

Use a separate `ReviewPatchBuilder` or `StudioFeedbackSession` `ObservableObject` that owns:

- pending operations and UI-only approval/rejection marks,
- conflict detection and op coalescing,
- base timeline version/hash capture,
- Codable serialization to the current compiler patch schema,
- undo of pending operations,
- applied patch history metadata.

`StudioViewModel` should orchestrate project selection and call the existing compile runner. This also keeps `TimelineViews.swift` as a selection/editing surface instead of making it aware of compiler details; today it only selects clips and scrubs the playhead (`apps/macos-studio/Sources/VideoOSStudio/TimelineViews.swift:216-233`).

### P1. Candidate Browser data needs a dedicated data source, not just `ProjectEvidenceStore`

`ProjectEvidenceStore` currently loads analysis artifacts under `03_analysis` plus transcripts; it does not load `04_plan/selects_candidates.yaml` or `04_plan/edit_blueprint.yaml` (`apps/macos-studio/Sources/VideoOSStudioCore/ProjectEvidenceStore.swift:3-29`). Adding candidate browsing is conceptually valid, but `selects_candidates.yaml` is planning data, not evidence. A dedicated `CandidateBrowserDataSource` should compose:

- `selects_candidates.yaml` candidates,
- `edit_blueprint.yaml` beat plans and fallback refs,
- existing `ProjectEvidenceStore` analysis evidence,
- media/thumbnail resolution.

Swift currently has no YAML package dependency (`Package.swift:1-31`). Existing YAML reads are lightweight text scans, not structured decoders (`ProjectIntentSummary.swift:91-138`). The design should choose one of two paths: add a real Swift YAML parser, or expose a small Node/TS JSON reader for candidate browser data and let Swift decode JSON.

Also, the design's fallback lookup must handle both `segment_id` and first-class `candidate_ref`/`candidate_id`, because the compiler now emits `candidate_ref` and `fallback_candidate_refs` on timeline clips (`runtime/compiler/assemble.ts:1314-1330`).

### P1. Search CLI wrapper is the right shape, but short-lived subprocesses hurt interactive search

`runtime/tools/footage-search.ts` is already a library with a clean response shape: `FootageSearchResponse` includes `query`, `db_status`, `mode_used`, `results`, and `warnings`; each result has `segment_id`, source range, `score`, `scores`, optional `key_frame_path`, tags, flags, metadata, and evidence refs (`runtime/tools/footage-search.ts:94-227`). Swift can decode this directly if it ignores unknown fields and models dynamic score maps carefully.

A thin CLI wrapper is preferable to making `footage-search.ts` directly executable, because the module is imported by QA and agent code (`runtime/eval/qa-fix-proposer.ts:1-7`). Existing project CLIs are generally thin scripts that parse args and call library functions (`scripts/build-footage-db.ts:22-94`).

The lifecycle issue is important: Qwen and CLAP clients are cached only in the Node process (`runtime/tools/footage-search.ts:459`, `:1768-1794`) and can be explicitly disposed (`runtime/tools/footage-search.ts:612-620`). If Studio starts `npx tsx runtime/tools/footage-search-cli.ts` for every query, every search pays process startup and possibly model/client startup. That may be acceptable for Phase 3 MVP, but not for "instant" browsing. The design should call this out and leave a path to a persistent JSONL/HTTP search worker per project/session, shutting it down via `disposeFootageSearch()`.

Security correction: current visual/audio query paths must be absolute and must resolve under approved roots (`runtime/tools/footage-search.ts:660-696`, `:726-763`). The design's relative `--image-query-path 03_analysis/posters/...` example should either be changed to an absolute path or the CLI wrapper should resolve project-relative paths and then reuse the same realpath checks.

### P1. QA Dashboard cannot list all issues from current reports

The design says the dashboard should show issues across iterations from `qa-improvement-report-iter*.json` (`docs/design-studio-feedback-loop.md:265-273`). Current `QAImprovementReport` stores counts and `fixes`, but it does not store the full issue list (`runtime/eval/qa-improvement-report.ts:8-17`). Each fix nests its issue, so fixed/proposed issues are visible, but open/unfixed issues are lost except as counts.

To support the proposed Issue List, add one of:

- `issues: QAIssue[]` to `QAImprovementReport`, preserving all detected issues.
- A parallel `06_review/qa-issues-iterN.json`.
- A `qa-dashboard.json` aggregate written by the QA loop.

The glob itself matches the current writer, which emits `06_review/qa-improvement-report-iter${iteration}.json` (`runtime/eval/qa-loop.ts:294-311`). It is still fragile without a `run_id`, base timeline hash, or manifest, because old iteration files can remain after a rerun. A `06_review/qa-improvement-index.json` with ordered report paths, run metadata, base/result timeline hashes, and convergence reason would make the Swift loader deterministic.

The radar chart should show selects and blueprint as two separate stage overlays, not one merged score. The evaluator computes the same six axis names separately for selects and blueprint (`runtime/eval/brief-alignment.ts:259-324`), and the report flattens both `selects.*` and `blueprint.*` keys while also adding unqualified aliases for the first stage (`runtime/eval/qa-improvement-report.ts:52-65`). The UI should avoid treating the unqualified aliases as a third canonical series.

### P2. "Compiling... (~2s)" is optimistic for Apply & Preview

The UI flow is feasible, but the latency budget should include more than compiler time:

- `scripts/compile-timeline.ts --patch` reads the existing timeline, patch, selects, and blueprint, applies the patch, writes `timeline.json`, regenerates `preview-manifest.json`, and validates the post-patch timeline (`scripts/compile-timeline.ts:180-258`).
- `ProjectRoughCutCompileRunner.run()` rebuilds the SQLite index after success by default (`apps/macos-studio/Sources/VideoOSStudioCore/ProjectRoughCutCompileRunner.swift:173-185`).
- `StudioViewModel` then calls `refresh()` and re-selects the project, which reloads project status, evidence, timeline, editor annotations, and async audio waveforms (`StudioViewModel.swift:1565-1583`, `:541-617`, `:629-643`).

For small projects, the target may still land under 10 seconds. The design should not promise "~2s" unless index rebuild is deferred. Since the runner already accepts `rebuildIndex: false`, Apply & Preview should consider skipping the index rebuild and refreshing the RAG/search index asynchronously after the viewer updates.

### P2. Proxy fallback should mirror current media resolver behavior

Current media resolution already prefers direct playable source media, then an existing proxy, then an existing but unsupported source or a missing path (`ProjectMediaResolver.swift:123-150`, `:162-198`). Proxy generation is a separate operation through `ProjectMediaProxyPlanner` and creates low-res playable media for assets that need it (`ProjectMediaProxyPlanner.swift:72-113`).

The design should specify:

- If direct playable source exists, preview from source.
- If proxy exists, preview from proxy.
- If media exists but needs proxy, show a degraded/unsupported preview state and a "Build Preview Proxies" action.
- If media is missing, show a relink-required state.

Do not treat missing proxies as a hard Apply & Preview error.

### P2. Thumbnail resolution is not covered by `ProjectMediaProxyPlanner`

The design says thumbnail extraction is handled by `ProjectMediaProxyPlanner` + `SubprocessRunner` (`docs/design-studio-feedback-loop.md:137-143`). That is not accurate. `ProjectMediaProxyPlanner` plans full preview proxy videos and uses ffmpeg args for transcoding, not still thumbnail extraction (`ProjectMediaProxyPlanner.swift:95-113`, `:161-170`).

Candidate thumbnails should first reuse existing artifacts already produced by the analysis/search stack, such as `key_frame_path` in search results (`runtime/tools/footage-search.ts:161-172`) or representative frames under `03_analysis/frames/.../representative.jpg`. Only then add a dedicated `ProjectThumbnailCache` for on-demand still extraction.

## Security, History, and Annotation Boundaries

Review patches should remain ID-based. Current patch operations reference clip IDs, segment IDs, frames, audio policy, beat IDs, role, labels, and text evidence; they do not need arbitrary external paths (`runtime/compiler/patch.ts:32-47`). Keep it that way. Search query paths can exist in the search CLI, but they must be resolved and validated before use and should not be copied into `review_patch.json` as executable/file inputs.

Do not overwrite an agent-generated `06_review/review_patch.json` casually. Studio-generated pending patches should be written as a temporary or timestamped file, passed explicitly to the runner, then archived after success. If the canonical `review_patch.json` is updated, preserve the previous file in patch history.

The undo design needs retention. `timeline-backup-{timestamp}.json` will accumulate indefinitely unless the design defines a directory and policy. Prefer:

- `06_review/patch_history/index.json`
- one record per applied patch with patch path, base timeline hash, result timeline hash, created_at, source, and changed clip IDs,
- bounded retention such as latest 20 timeline backups or latest 1 GB,
- atomic restore and playback-contract refresh after undo.

`editor_annotations.json` is not a duplicate of review patch. It stores clip-anchored notes and human handoff instructions under `07_handoff/editor_annotations.json` (`ProjectEditorAnnotations.swift:3-64`, `:100-197`). Keep the boundary clear:

- `editor_annotations.json`: explanatory notes for humans and editor handoff.
- `review_patch.json`: deterministic compiler mutations.
- Studio feedback state: approvals/rejections that may not mutate the timeline.

## Recommended Design Edits Before Implementation

1. Replace Section 2.1 with the current schema, plus an explicit future extension block for `project_id`, `source`, and `base_timeline_hash`.
2. Add a `ReviewPatchBuilder`/`StudioFeedbackSession` object instead of adding raw `pendingPatch` arrays to `StudioViewModel`.
3. Define a translation table from UI gestures to current compiler ops and mark unsupported gestures as non-Phase-1.
4. Add a preview-vs-promote section so accepted Studio changes survive future compiles intentionally.
5. Change Search CLI examples to use absolute or project-resolved paths and document the MVP short-lived subprocess versus future persistent worker tradeoff.
6. Add `issues` or an issue manifest to the QA report model before building the Issue List UI.
7. Replace unbounded `timeline-backup-{timestamp}.json` with a patch history manifest and retention policy.
