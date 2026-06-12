# Video OS Studio macOS Architecture

> Date: 2026-05-22
> Status: Initial product architecture and scaffold contract
> Scope: Native macOS GUI + CLI that hosts the existing RoughCut Agent system and uses Codex App Server as the main agent runtime.

## 1. Product Decision

Video OS Studio is not a separate editor engine. It is the native operator surface for the existing artifact-driven system:

```text
macOS GUI / CLI
  -> Codex App Server as main reasoning runtime
  -> existing role commands and agents
  -> media analysis, DB/RAG, VLM/STT/audio connectors
  -> deterministic compiler / render / handoff engines
  -> timeline.json / FCP7 XML / final media
```

The existing repository rule still stands: agents propose, engines write deterministic artifacts, and canonical project files remain the source of truth.

## 2. Codex App Server Boundary

Codex App Server is the app integration boundary, not a direct OpenAI API chat replacement. The native app should start or connect to Codex App Server and use it for:

- ChatGPT/Codex account-backed agent execution.
- Thread lifecycle, turn lifecycle, streaming events, and conversation history.
- Human approval gates for risky operations.
- Project-scoped reasoning over the repository and canonical artifacts.

Initial transport:

```text
cd <repo>
codex app-server --listen stdio://
```

The workspace is passed in `thread/start.cwd` and later turn requests. Packaged app transport can move to authenticated WebSocket (`--listen ws://127.0.0.1:<port>` plus capability-token auth when needed) or Unix socket (`--listen unix://...`) once the launch, auth, and lifecycle behavior are proven.

The first Swift scaffold exposes this contract through:

- `VideoOSStudio` GUI target.
- `videoos-studio-cli` CLI target.
- `VideoOSStudioCore.CodexAppServerLaunchPlan`.
- `VideoOSStudioCore.CodexAppServerRequestFactory`.

The first supported app-server loop is:

```text
initialize
initialized
thread/start
turn/start
thread/read includeTurns=true
```

Default thread policy:

```text
approvalPolicy: on-request
approvalsReviewer: user
sandbox: workspace-write
threadSource: user
personality: pragmatic
```

## 3. Native App Shape

The macOS app should follow a professional NLE layout instead of a chat-first app:

```text
Sidebar: projects / libraries / bins
Viewer: source and program monitor
Inspector: AI context, selected clip, review findings, media metadata
Timeline: multi-track edit surface with V/A tracks, markers, overlays
Command surfaces: toolbar, menus, shortcuts, command palette
Agent panel: Codex turns, approvals, artifact diffs, job progress
```

SwiftUI is the default for windows, split views, settings, menus, and high-level composition. Use AppKit only where the editor requires lower-level responder-chain, media, panel, or timeline interaction.

## 4. Existing Web Editor Migration

`editor/` remains useful as the proven local editor/server surface. The native app should not immediately rewrite all timeline behavior. The staged path is:

1. Wrap project selection, artifact state, and job launch in native UI.
2. Keep source-of-truth artifacts and the current editor server APIs.
3. Rebuild the core timeline surface natively only after sync, playback, and save contracts are stable.
4. Preserve FCP7 XML / NLE handoff rather than forcing all finishing into the native editor.

## 5. Marlin-2B Role

The Marlin plan is adopted as a priority VLM direction with one constraint: Marlin-2B should be a temporal semantics layer, not a blind replacement for the existing VLM connector.

Use Marlin for:

- video-level scene understanding,
- timestamped semantic events,
- brief-aware moment search,
- peak-centered trim hints,
- selects candidate evidence.

Keep existing VLM paths for:

- contact sheets,
- still image reasoning,
- arbitrary JSON prompt extraction,
- quality flags,
- visual fallback when local Marlin is unavailable.

The app settings should expose this as a policy:

```text
VLM mode: existing | marlin | hybrid
Default: hybrid
Preferred temporal model: NemoStation/Marlin-2B
Fallback: existing Gemini/contact-sheet VLM path
```

The current native Settings window reads the canonical `runtime/analysis-defaults.yaml` policy and exposes the active VLM default, Marlin mode, model alias, connector, worker path, output artifact, and the rule for when Marlin can become preferred. The Media panel and CLI can apply the Marlin-first temporal policy only after the repository-level representative evidence gate passes.

## 6. Audio Is First-Class

Video OS Studio must treat audio as an editing surface, not as metadata:

- STT and speaker diarization feed story structure.
- Dialogue/nat-sound/BGM stems remain visible in the timeline.
- BGM analysis, beat grids, downbeats, intensity, and phrase boundaries guide cuts.
- Review must evaluate audio continuity, loudness, dialogue intelligibility, music edit points, and silence usage.

The timeline UI should reserve explicit lanes for dialogue, nat sound, BGM, captions, and markers from the beginning.

The current implementation adds a canonical audio story graph build path: `scripts/build-audio-story-graph.ts` reads transcripts, optional `audio_events.json`, and optional `bgm_analysis.json` into `03_analysis/audio_story_graph.json`. The native CLI exposes `audio-story-plan` / `audio-story-run`, and the Media panel plus Studio menu can run the same build and immediately refresh the SQLite RAG index so dialogue turns, speaker cues, music sections, and BGM timing become searchable editing evidence.

## 7. Data And RAG

The native app should add a local project library layer around canonical artifacts:

```text
Project database
  assets
  segments
  transcripts
  speakers
  marlin_events
  audio_events
  music_cues
  edit decisions
  user preference memory
```

The database is an index/cache, not canonical truth. Canonical JSON/YAML artifacts remain portable and validate against schemas. RAG queries should cite artifact IDs, segment IDs, transcript spans, and media time ranges so every agent decision can be inspected.

The first native implementation writes a rebuildable SQLite cache at:

```text
projects/<id>/03_analysis/search/project_index.sqlite
```

It indexes assets, segments, transcript items, Marlin events, Marlin find results, audio events, audio story nodes, BGM sections, BGM beats, and a unified `search_documents` table for CLI/GUI search. This remains derived state and can be rebuilt from canonical artifacts at any time.

## 8. First Implementation Slices

P0 has now started with a native scaffold:

- Add SwiftPM package and two products: `VideoOSStudio`, `videoos-studio-cli`.
- Load projects from `projects/`.
- Display artifact state and initial NLE-style panes.
- Model the Codex App Server launch plan and stdio JSON-RPC request factory.
- Verify real `codex app-server --listen stdio://` initialize handshake from the CLI.
- Verify thread and turn lifecycle from the CLI and expose GUI job turns for selected projects.
- Add the initial Marlin events artifact schema, normalization contract, JSONL worker, and TypeScript local connector.
- Wire `marlin-local-v1` into `/analyze` behind `VOS_MARLIN_ENABLED`, producing `03_analysis/marlin_events.json` from caption and find passes.
- Map Marlin events into `segments.json.peak_analysis` and materialize those segment peaks into candidate `trim_hint` / `editorial_signals` for `/triage` and the compiler.
- Add a native Marlin evaluation status surface. The CLI exposes `marlin-status`, and the Media tab reports artifact readability, policy mode, model identity, event/find counts, segment peak coverage, and whether the current project is only evaluated or is a candidate for Marlin-first temporal VLM priority.
- Add a live Marlin runtime preflight and mock-evidence guard. The CLI exposes `marlin-runtime-status`, Settings shows the same Python dependency and accelerator readiness, and generated `marlin_events.json` records `model.inference_mode` so deterministic `--mock` runs can exercise workflow QA without being counted as live Marlin preference evidence.
- Gate live Marlin evaluation on that runtime preflight. Native Marlin run buttons and `marlin-eval-run` / `marlin-eval-next --execute` refuse live execution until required Python packages and a usable accelerator/device are available; `--mock` remains an explicit workflow QA path.
- Add a repository-level Marlin preference decision gate. The CLI exposes `marlin-preference-status`, `marlin-representative-plan`, and `marlin-eval-queue`, and the Media tab shows whether enough representative evaluated projects have Marlin-derived segment peak coverage to justify promoting Marlin-2B from opt-in temporal semantics to Marlin-first VLM priority while keeping the existing VLM fallback. Promotion now requires candidate evidence across interview/dialogue, music/beat-sync, and documentary/growth buckets, so Marlin evaluation can move from policy text to evidence across the studio's intended range instead of passing on project count alone.
- Add a next-evaluation runner for the Marlin queue. `marlin-eval-next` selects the first runnable non-candidate project from the representative queue, prints the exact `marlin-evaluate.ts` command by default, and runs it with `--execute`; Studio Readiness routes the Marlin default gate to this command whenever more evidence can be collected immediately.
- Add a gated Marlin preference apply path. `marlin-preference-apply` prints the current/target policy and requires `--confirm` before writing `runtime/analysis-defaults.yaml`; the write is refused unless the preference decision gate is ready. The Media panel mirrors this as an `Apply Marlin Preference` button that is disabled until Marlin evidence covers the representative categories and segment peak materialization requirements.
- Surface that Marlin preference gate inside Studio Readiness without inflating the per-project readiness score. The CLI `studio-status` now reports `marlinDefaultGate`, `marlinDefaultEvidence`, and `marlinDefaultNextAction`, and the Overview panel mirrors those values so operators can see when a project is otherwise packaged but the repository still lacks representative Marlin evidence.
- Make Studio Readiness actionable. `studio-status` now prints `nextCommand`, and each capability can include a concrete CLI command such as `index-rebuild`, `analysis-run`, `marlin-eval-run`, `compile-run --review-patch`, `render-run`, or handoff/export status commands. The Overview panel mirrors these commands in monospace so the GUI explains the next operational step instead of only showing prose.
- Add an ordered Studio action queue. `studio-status` now emits `action.<id>` rows that separate blocking project work from advisory repository-level gates such as Marlin default promotion, and the Overview panel shows the same queue below the readiness score. Review failures are deliberately first when present, followed by material/RAG, planning, Marlin evaluation, handoff, and render actions.
- Wire the Overview action queue into the native app. Each action row now has a small Run/Open control plus a Copy command control: deterministic actions call the existing native runners (`analysis-run`, `index-rebuild`, `audio-story-run`, `marlin-eval-run`, compile, packet export, render), while Codex-owned jobs route through the existing App Server session and operator approval gate.
- Reduce Codex startup friction inside Studio Readiness. If a Codex-owned action such as review, triage, or blueprint is clicked before an App Server thread is active, the Overview button starts the Codex session first and then continues into the same job approval flow. The GUI therefore treats Codex App Server as the default agent runtime instead of requiring a separate manual setup step before every project action.
- Mirror the action queue in CLI execution. `studio-action <project>` selects the first queued action, prints its execution mode, and can run native deterministic actions with `--execute`. Codex-owned actions stay approval-oriented: `--execute` prints the exact job prompt, sandbox, and write scopes rather than silently running a workspace-write App Server turn.
- Add an explicit CLI Codex turn path. `studio-action <project> <action-id> --execute --run-codex` starts Codex App Server, opens a thread, and runs the selected Codex job; workspace-write jobs still require `--approve-codex-write` after reviewing the prompt and allowed write scopes. This keeps CLI automation Codex-native without removing the operator gate.
- Feed material RAG into CLI Studio actions. `studio-action` accepts `--context-query=<query>` and `--context-limit=<n>` for Codex-owned actions, builds the same prompt-ready SQLite evidence pack used by `agent-prompt`, prints the included context count during approval review, and sends that pack into the App Server turn when execution is approved.
- Surface material RAG in GUI Codex approvals. The Agent panel and Studio Readiness action queue now show the active cited context pack, and pending workspace-write approval cards include the RAG query/count so operators can confirm whether a review, compile, triage, or blueprint turn is grounded in selected material evidence before approving it.
- Audit CLI Codex writes after execution. Approved `studio-action --run-codex` turns now snapshot canonical project artifacts before and after the App Server turn, print changed artifacts, and fail if any diff falls outside the selected job's write contract. Read-only Codex jobs use the same diff check, so unexpected artifact writes are visible in CLI automation too.
- Add a Marlin-only evaluation run path for already analyzed projects. `scripts/marlin-evaluate.ts` runs the Marlin temporal pass without rerunning the full ingest pipeline; the native CLI exposes `marlin-eval-plan` / `marlin-eval-run`, and the Media tab shows the runnable source count, command, and a Run button. Successful Marlin runs immediately rebuild the derived SQLite index so `marlin_events` and `marlin_find_results` become available to material search/RAG without a separate manual refresh.
- Parse `05_timeline/timeline.json` in the native core and render a read-only NLE-style timeline from real tracks and clips instead of placeholder bars.
- Add timeline clip selection, Clip inspector details, and artifact evidence lookup from assets, segments, transcripts, and optional Marlin events.
- Add a rebuildable SQLite project index and expose it in both the CLI and native Media inspector as the first material-management/RAG lookup layer. The index now includes assets, segments, transcripts, Marlin events/finds, audio evidence, BGM beats/sections, continuity entities/segment refs, and editorial preference memory entries.
- Add a prompt-ready RAG context pack on top of the SQLite index. The CLI exposes `index-context`, `agent-prompt --context-query=<query>`, and the native Media search surface can append cited material context directly into Codex Agent prompts with document IDs, asset IDs, segment IDs, and source time ranges.
- Add a combined material-library readiness surface for GUI and CLI. `library-status` reports canonical analysis counts, media relink/proxy readiness, SQLite/RAG coverage, Marlin/audio evidence, timeline availability, and handoff annotation presence without mutating project artifacts.
- Extend that index and the clip inspector with first-class audio evidence from `audio_events.json`, `audio_story_graph.json`, and `bgm_analysis.json`.
- Add a native audio story graph build path. The CLI exposes `audio-story-plan` / `audio-story-run`, and the Media panel plus Studio menu build `03_analysis/audio_story_graph.json` from transcripts, BGM analysis, and audio events, then rebuild the SQLite index so Codex can cite sound-driven story evidence.
- Add a native operator approval gate for workspace-write Codex turns. Read-only jobs run directly; compile/review show sandbox and planned-write scope before the operator can approve execution.
- Add explicit agent write contracts for each native Codex job. The GUI and CLI now show the mode, entrypoint, command contract, allowed output artifacts, expected artifacts, and forbidden direct writes so workspace-write turns stay fenced to compiler/review contracts.
- Capture Codex turn results as structured native history: assistant text, status, sandbox, approval state, duration, event methods, and an event timeline are visible in the Agent panel.
- Snapshot canonical project artifacts around approved workspace-write turns and show an artifact diff preview in the Agent history. Derived SQLite search indexes are excluded from this preview, and JSON/YAML changes show a short first-hunk detail preview.
- Promote selected-clip annotation proposal into the Agent panel job picker. The `Clip Note` job is read-only, requires a selected timeline clip, carries an explicit no-write contract, and reuses timeline, transcript, Marlin, and audio evidence to draft JSON note/handoff instructions without mutating `07_handoff/editor_annotations.json`.
- Add `Render` as an explicit Codex Agent job with operator approval. The job follows `.codex/commands/render.md`, starts only from an approved or rerunnable packaged project, and fences writes to `07_package/`, `09_output/final.mp4`, `project_state.yaml`, and `progress.json` so final output generation is part of the same native agent workflow as compile/review.
- Add a native render/package status surface. The CLI exposes `render-status`; the Media tab reports QA status, source-of-truth, package manifest readiness, `09_output/final.mp4`, `07_package/video/final.mp4`, and `07_package/audio/final_mix.wav` so render completion is visible outside Agent turn history.
- Add a native render/package run path. The CLI exposes `render-plan` / `render-run`, and the Media tab plus Studio menu can run the existing `/render` worker against approved or already packaged projects while keeping Gate 10 and packaging validation inside the runtime command.
- Compare approved Codex artifact diffs against the selected job write contract and surface contract warnings when changes land outside allowed outputs.
- Resolve selected timeline clips to source media through `02_media/source_map.json` with filename fallbacks and connect the Viewer to AVKit playback when the source file exists. Missing demo media is surfaced explicitly instead of showing a silent placeholder.
- Add a real timeline playhead, scrubber, playhead line, active-clip highlighting, and program monitor resolution. The Viewer now follows the clip under the playhead and seeks into the matching source time.
- Add transport playback controls for the program monitor. Play/pause advances the native playhead at sequence FPS, step buttons move by one second, and the Viewer follows clip boundaries as the playhead changes. During continuous playback, AVPlayer now seeks only on explicit scrub/step or program-clip boundary changes instead of seeking on every frame tick, and the Viewer keeps the next playable program clip as a preloaded AV asset.
- Add a dedicated marker lane above the native timeline tracks. Beat/note/warning/chapter markers are normalized from `timeline.json`, rendered with NLE-style chips and timecode help, and exposed in the CLI with `timeline-markers`.
- Split program monitor selection into visual and audio lanes. The Viewer still uses visual-first program selection for picture, while the transport now resolves and displays the active audio clip independently so sync work can use a real audio target instead of fallback-only audio selection.
- Add monitor audio controls and a separate hidden AVPlayer for the active audio lane. When an audio lane is present, the picture player is muted and the audio player follows its own sync generation, mute state, and monitor volume.
- Add a timeline-positioned audio map for audio events, audio story nodes, BGM sections, beats, and downbeats. The native timeline overlays those cues on audio tracks, and the CLI exposes the same frame/timecode mapping with `audio-map`.
- Add waveform extraction for readable audio files on timeline audio lanes. The app extracts normalized peak envelopes in the background and renders them inside audio clips; the CLI exposes the same extraction with `audio-waveform`.
- Add a CLI monitor snapshot command so visual/audio/program/next clip resolution can be inspected at an exact timeline frame, including source/proxy path, existence, and video/audio playback readiness. Playback readiness is only marked ready when the resolved file or proxy exists.
- Add source preview readiness inspection in both CLI and the native Media tab. Each analyzed asset is classified as direct video, direct audio, proxy-needed, or missing using `source_map.json` plus filename fallbacks.
- Add durable source-map diagnostics. The CLI exposes `media-source-map-status`, and the Media tab reports source-map coverage, broken mapped paths, ready mapped assets, relinked symlink count, and generation time separately from preview fallback readiness.
- Add a native relink workflow for missing source media. The CLI exposes `media-relink-plan` / `media-relink-apply`, and the Media tab can choose one or more folders/files, match missing analyzed assets by filename, write `02_media/source_map.json`, and create safe project-local symlinks under `02_media/relinked/` without mutating analysis artifacts. For broken existing source maps, `media-source-map-status` now prints suggested search roots recovered from absolute paths in `source_map.json`, and `media-relink-plan|apply --from-source-map` can reuse those roots when the source volume is available.
- Add a synthetic demo-media builder for QA and demos without real source footage. The CLI exposes `media-synthetic-plan` / `media-synthetic-build`, and the Media tab can generate short AVKit-playable source videos under `02_media/synthetic/` and write a durable `source_map.json` so preview, handoff, and packet flows can be verified end-to-end without committing binary fixtures.
- Add a synthetic handoff smoke path for release/debug confidence. The CLI exposes `handoff-synthetic-smoke`, which creates a temporary two-asset project, generates playable source media, verifies durable source-map coverage, exports Premiere XML, packages the editor handoff packet, and removes the temporary project unless `--keep` is passed.
- Add a full synthetic studio smoke path for final-output confidence without real footage. The CLI exposes `studio-synthetic-smoke`, and the native Media panel plus Studio menu can run the same temporary project verification: generate playable synthetic source media, run render/package against a supplied final, verify `09_output/final.mp4`, and export an editor packet containing media so the final render/handoff loop is testable outside demo fixtures.
- Add a studio acceptance smoke path that joins the Codex App Server runtime boundary to the full synthetic studio loop. The CLI exposes `studio-acceptance-smoke`, and the native Media panel plus Studio menu can run one gate that initializes Codex App Server, generates a temporary project, verifies source-map/render/package/final media/final audio, exports and verifies an editor packet, and rebuilds the derived SQLite material/RAG index without touching the selected project.
- Add a native preview-proxy path for unsupported source media. The app and CLI now surface deterministic ffmpeg commands that transcode `needs-proxy` assets into `02_media/proxy/<asset_id>.mp4`, the CLI can execute those transcodes explicitly, the Media tab can trigger the same build path, and the Viewer prefers an existing proxy when the original source is not AVKit-playable. Proxy transcodes are capped at 1280px wide without upscaling smaller sources.
- Add a native editor handoff surface. The CLI exposes `handoff-status` and `handoff-export-premiere`, while the Media tab shows Premiere XML readiness, relink count, output path, and an export button. The exporter wraps the existing FCP7 XML script, writes only `09_output/<project_id>_premiere.xml`, and can generate a temporary source map from analyzed assets when `02_media/source_map.json` has not been created yet.
- Thread durable source-map diagnostics into editor handoff. `handoff-status`, the Media handoff panel, editor notes, and editor packet manifest now distinguish a real ready `02_media/source_map.json` from a temporary export source map, and report source-map coverage, missing entries, and broken mapped paths.
- Add a canonical editor annotation artifact at `07_handoff/editor_annotations.json`, with JSON Schema validation. The CLI exposes `annotations-status`, `clip-note-add`, `clip-note-clear`, and `clip-note-prompt`; the native Clip inspector can save a selected clip note without mutating `timeline.json`, and the Media handoff panel reports the annotation count.
- Add a read-only Codex annotation proposal path for selected clips. The native Clip inspector can ask Codex for a strict JSON note/handoff proposal using timeline, transcript, Marlin, and audio evidence; the proposal is applied to draft fields only, and the operator must explicitly save before `07_handoff/editor_annotations.json` changes.
- Add an editor packet export above Premiere XML. The CLI exposes `handoff-packet-status`, `handoff-packet-verify`, and `handoff-export-packet`; the native Media handoff panel can export and reveal `09_output/editor_packet/` containing the Premiere XML, human-readable `editor_notes.md`, optional `editor_annotations.json`, optional review report/patch artifacts, optional preview/final media under `media/`, and a manifest for the human editor. Packet verification reads the exported manifest and checks that listed files, final media, and final audio are actually present before handoff.
- Add native macOS command menus and a command palette for daily editor operations. The Studio menu now exposes refresh, search-index rebuild, Marlin evaluation, preview-proxy build, Premiere XML export, editor-packet export, and packet reveal actions, while a Transport menu exposes play/pause and single-step controls with keyboard access. The app menu and toolbar also expose a Cmd+K command palette so operators can search and run project, Codex, analysis, compile, Marlin, audio, media, handoff, render, smoke, and transport commands without hunting through inspector panes.
- Add native Agent menu commands for Codex App Server lifecycle and job execution. Operators can check the App Server, start/stop an agent session, run the selected job, run the read-only prompt, and approve/cancel pending write jobs without hunting through the inspector pane.
- Add a Codex-to-engine handoff for approved Compile jobs. Codex must return a strict `engine_action` decision after gate review; only `run_compile` lets the native app run the deterministic compiler, and the resulting engine status plus artifact diff remains visible in Agent history.
- Add native planning readiness for the analysis-to-rough-cut gap. The CLI exposes `planning-status`, the Project panel shows intent/analysis/selects/blueprint readiness, and the Agent job picker now includes approval-gated `Triage` and `Blueprint` jobs with write contracts fenced to planning artifacts.
- Add a native intent brief summary so the app does not treat user intent as a hidden YAML flag. The CLI exposes `intent-status`, and the Project panel now shows primary message, audience, autonomy, must-have, must-avoid, and unresolved blocker counts from `01_intent/creative_brief.yaml` and `01_intent/unresolved_blockers.yaml`.
- Add a native intent-alignment scan for rough cuts. The CLI exposes `intent-alignment`, and the Project panel compares the current brief's must-have / must-avoid cues against planning, timeline, and review artifacts while surfacing `mismatches_to_brief` and review status.
- Add a native review artifact surface. The CLI exposes `review-status`, the Project panel shows `review_report.yaml` judgment, issue/mismatch counts, and `review_patch.json` operation summaries, and the same panel/menu can route operators into the approval-gated Codex Review job instead of hiding review behind the Agent pane.
- Add a native review-patch compile path. `compile-run --review-patch` applies `06_review/review_patch.json` through the deterministic compiler, while the Project panel and Studio menu expose the same action as `Apply Review Patch` and refresh timeline/RAG state after success.
- Add a native pipeline gate status surface across the review-to-render boundary. The CLI exposes `gate-status`, and the Project panel shows `project_state.yaml` gate summary, current state, review status, render readiness, and the next operator action so approval, patch, and packaging gates are not hidden in separate tabs.
- Add a cross-pipeline Studio Readiness surface. The CLI exposes `studio-status`, and the Project panel now scores Codex runtime configuration, material/RAG, editing intent, selects/blueprint, Marlin temporal VLM, audio story evidence, rough-cut review, editor handoff, and final render readiness from derived status readers so operators can see the whole studio loop without opening every tab.
- Add objective-level Studio Goal coverage. The CLI exposes `studio-goal-status`, and the Project panel mirrors the same native GUI/CLI, Codex App Server, material DB/RAG, Marlin default gate, audio intelligence, rough-cut, native editor UX, handoff, render, and representative-coverage requirements. This keeps the original studio objective visible as a requirement audit instead of letting local green tests imply the product is complete.
- Add a native project initialization/import entrypoint. The CLI exposes `project-init <project-id> --source-dir=<folder>`, and the Studio menu/sidebar can create a new project from `projects/_template` while linking the chosen source-media folder into `02_media/source` for the first analysis pass.
- Add a native source-analysis run path for linked projects. The CLI exposes `analysis-plan` / `analysis-run`, and the Project panel plus Studio menu can run `scripts/analyze.ts` over `02_media/source`, then rebuild the SQLite material/RAG index when analysis succeeds.
- Add a native rough-cut compile run path. The CLI exposes `compile-plan` / `compile-run`, and the Project panel plus Studio menu can run `scripts/compile-timeline.ts` from the canonical planning artifacts, refresh `timeline.json`, and rebuild the SQLite material/RAG index so the native NLE surface and RAG context move forward together.
- Add a native Settings policy surface plus CLI `policy-status` so VLM and Marlin defaults are visible outside the architecture document. The policy surface reads `runtime/analysis-defaults.yaml` and does not mutate the canonical defaults.

Current smoke commands:

```bash
swift run videoos-studio-cli doctor
swift run videoos-studio-cli policy-status
swift run videoos-studio-cli project-init new-cut --source-dir=/path/to/footage
swift run videoos-studio-cli intent-status demo
swift run videoos-studio-cli intent-alignment demo
swift run videoos-studio-cli review-status demo
swift run videoos-studio-cli gate-status demo
swift run videoos-studio-cli studio-status demo
swift run videoos-studio-cli analysis-plan new-cut
swift run videoos-studio-cli analysis-run new-cut
swift run videoos-studio-cli planning-status new-cut
swift run videoos-studio-cli compile-plan demo
swift run videoos-studio-cli compile-run demo --skip-preview
swift run videoos-studio-cli compile-run demo --review-patch --skip-preview
swift run videoos-studio-cli agent-jobs demo
swift run videoos-studio-cli agent-prompt demo triage --context-query=quiet --context-limit=4
swift run videoos-studio-cli annotations-status demo
swift run videoos-studio-cli clip-note-prompt demo <clip-id>
swift run videoos-studio-cli library-status demo
swift run videoos-studio-cli index-rebuild demo
swift run videoos-studio-cli index-status demo
swift run videoos-studio-cli index-search demo quiet
swift run videoos-studio-cli index-context demo quiet --limit=6
swift run videoos-studio-cli media-status demo
swift run videoos-studio-cli media-source-map-status demo
swift run videoos-studio-cli media-relink-plan demo /path/to/media
swift run videoos-studio-cli media-relink-apply demo /path/to/media
swift run videoos-studio-cli media-synthetic-plan demo
swift run videoos-studio-cli media-synthetic-build demo --duration=5
swift run videoos-studio-cli media-proxy-plan demo
swift run videoos-studio-cli media-proxy-build demo
swift run videoos-studio-cli monitor-status demo 45
swift run videoos-studio-cli timeline-markers demo
swift run videoos-studio-cli audio-map demo
swift run videoos-studio-cli audio-waveform demo
swift run videoos-studio-cli marlin-status demo
swift run videoos-studio-cli marlin-runtime-status
swift run videoos-studio-cli marlin-preference-status
swift run videoos-studio-cli marlin-representative-plan
swift run videoos-studio-cli marlin-eval-queue
swift run videoos-studio-cli marlin-eval-plan demo
swift run videoos-studio-cli render-status demo
swift run videoos-studio-cli render-plan demo
swift run videoos-studio-cli render-run demo
swift run videoos-studio-cli handoff-status demo
swift run videoos-studio-cli handoff-export-premiere demo
swift run videoos-studio-cli handoff-packet-status demo
swift run videoos-studio-cli handoff-packet-verify demo
swift run videoos-studio-cli handoff-export-packet demo
swift run videoos-studio-cli handoff-synthetic-smoke --duration=1
swift run videoos-studio-cli studio-synthetic-smoke --duration=1
swift run videoos-studio-cli studio-acceptance-smoke --duration=1
swift run videoos-studio-cli app-server-smoke
swift run videoos-studio-cli thread-smoke
swift run videoos-studio-cli turn-smoke
npm test -- tests/marlin-worker.test.ts tests/marlin-normalize.test.ts --reporter=dot
npm test -- tests/marlin-worker.test.ts tests/marlin-normalize.test.ts tests/marlin-analysis-stage.test.ts --reporter=dot
npm test -- tests/marlin-normalize.test.ts --reporter=dot
npm run build
npm run validate
swift test
./script/build_and_run.sh --verify
```

Next slices:

1. ~~Run a real render and verify preview/final media appears in `09_output/editor_packet/media/` from the GUI flow.~~ Done (2026-06-12): `studio-acceptance-smoke` passes end-to-end, and a real-project re-render through the same `ProjectRenderRunner` path works after aligning Gate 10 with this doc (runtime/packaging/gate10.ts now accepts `packaged` for re-renders, matching the Swift planner).
2. Run a real local Marlin-2B evaluation on representative interview and music-video footage, then use `marlin-status` coverage and segment-peak evidence before flipping it from opt-in to preferred default.
3. ~~Split the growing native `ContentView.swift` into focused Agent, Editor, Media, and Inspector view files once the current workflow surfaces stabilize.~~ Done (2026-06-12): split into StudioViewModel / ViewerViews / AgentInspectorViews / ProjectInspectorViews / ClipInspectorViews / MediaPanelViews / TimelineViews / SettingsView; ContentView.swift now holds only the root layout, shelf, top bar, command palette, and workspace.
4. Stabilize the playback contract: make `preview-manifest.json` the explicit playback source of truth for GUI review so what the operator approves matches what the engine renders (see editor-v3-design.md / editor-preview-render-parity-design.md).
   - Increment 1 done (2026-06-12): the compiler stamps `base_timeline_hash` into preview-manifest.json; `runtime/preview/playback-contract.ts` and `ProjectPlaybackContractStatusReader` (same sha256-16 definition, cross-verified) classify exact / stale / legacy_manifest / missing; the viewer shows an Exact/Stale preview badge and the CLI exposes `playback-contract-status`. Existing manifests report `legacy_manifest` until their next compile.
   - Increment 2 done (2026-06-12): true cross-path parity. The ffmpeg assembly engine is wired into produceAssembly (sourceOverrides honored), intermediates on both paths use the shared near-lossless profile (editor/shared/encode-profiles.ts), the assembler concat stream-copies instead of re-encoding, pipeline's fit step skips when dimensions already match, AAC priming no longer shifts preview video PTS (PCM intermediates), and finals without BGM are loudnorm-mastered like previews. editor/tests/parity/final-parity.test.ts renders the SAME timeline through PreviewJobService and runRenderPipeline and asserts SSIM ≥ 0.999 / duration ≤ 1 frame / LUFS diff ≤ 0.1 — all passing.
   - Increment 3 done (2026-06-12): caption-burn and crossfade scenarios added to final-parity.test.ts and passing. Fixes: render-spec now reads the canonical caption_approval.json `speech_captions` shape (it previously only understood a legacy `cues` field, so exact previews silently dropped approved captions); the final burn uses the shared caption style preset + intermediate profile; and transitioned timelines render through a new single-generation `buildTransitionChainArgs` on BOTH paths. That work also exposed and fixed a latent preview bug: the transition graph's [vN]/[aN] labels were never bound to input streams, so every transitioned preview replayed clip A instead of cutting to clip B.
   - Remaining: j_cut/l_cut audio parity on the final path, gap-containing transition timelines (currently fall back to windowed xfade), and the staleness badge in the web editor ProgramMonitor.

## 9. Verification Gates

The product is not done on a green build alone. Each milestone needs at least:

- Swift build for GUI and CLI.
- Node `npm run build`.
- Schema validation for demo artifacts.
- Runtime launch check for the app bundle.
- A local project loaded in the GUI.
- A Codex App Server turn started from the app.
- One rough cut produced from source media and handed off to Premiere or final render.

## References

- OpenAI Codex App Server documentation: https://developers.openai.com/codex/app-server
- Marlin-2B integration plan: `docs/marlin-2B統合プラン.md`
- Editor v3 design: `docs/editor-v3-design.md`
- Core architecture: `ARCHITECTURE.md`
