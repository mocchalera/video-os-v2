# Studio First-Run UX Issues - 2026-07-08

## Context

This note records issues observed while starting a real macOS Studio project from
an arbitrary source folder and trying to continue from source analysis to rough
cut generation.

Observed project: `AX10604`

Source workflow:

1. Create a project from a source-material folder.
2. Press source analysis in the macOS app.
3. Restart the app after analysis completes.
4. Try to continue through candidate selection, blueprint, and rough cut.

The operator repeatedly needed CLI-level explanation to understand the next
step. This is a product UX issue, not just missing documentation.

## Evidence Snapshot

After source analysis recovery, CLI status showed:

- `media-source-map-status AX10604`: `source map ready`, coverage `5 / 5`.
- `library-status AX10604`: `ready for compile`, `assets: 5`, `segments: 5`,
  `transcriptDocuments: 0`, `transcriptItems: 0`, `audioReady: false`.
- `studio-status AX10604` before candidate selection: planning not ready,
  `selects=false`, `blueprint=true`, next command `agent-prompt AX10604 triage`.
- After candidate selection completed, `selects_candidates.yaml` was updated at
  `2026-07-08 15:17`, while `edit_blueprint.yaml` still had the earlier
  `2026-07-08 14:33` timestamp.
- `planning-status AX10604` still reported `planning ready` because both
  selects and blueprint existed, even though the blueprint was likely stale or
  template-derived.

Screens observed during the user run:

- Project panel showed an action queue with `候補抽出 / 構成案`, Marlin, and audio
  story rows, but no visible primary run button in the narrow panel state.
- Agent panel correctly showed the `候補抽出` job, but also showed generic
  controls such as `書き込み契約`, `相談内容`, and `対象`, which made the user ask
  whether empty fields were acceptable.

## Extracted Issues

### UX-1: First-run path has no single obvious next action

Expected:

- After source analysis completes, the app should present one clear primary
  next action based on the project and content type.
- The user should not need to know that `候補抽出` maps to
  `agent-prompt <project> triage`.

Actual:

- The operator had to ask where the `候補抽出 / 構成案` button was.
- The readiness panel exposed CLI command text before exposing a reliable,
  visible primary action.
- The action label combined candidate extraction and blueprint, even though
  they are separate jobs with separate write contracts.

### UX-2: Action queue run controls disappear or are not discoverable

Expected:

- Every actionable queue row should show a stable visible `実行` / `開始して実行`
  control, even in a narrow inspector.
- If the row cannot run, the disabled reason should appear in the same row.

Actual:

- The screenshot showed action rows and command text, but no visible button.
- The user reasonably concluded there was no button.

Likely fix direction:

- Make action rows use a compact leading icon button or persistent trailing
  button that cannot be clipped by command text.
- Consider moving the primary action above the capability list as a large
  top-level CTA.

### UX-3: Agent panel exposes irrelevant fields for write jobs

Expected:

- For `候補抽出` / `構成設計`, the Agent panel should show only:
  job, readiness, write contract summary, primary run/approval button, and
  progress/result.
- Timeline consultation fields should be hidden unless the selected job is a
  timeline consultation job.

Actual:

- The Agent panel showed `相談内容` and `対象` during candidate extraction.
- The user asked whether those empty-looking fields were safe to ignore.

Likely fix direction:

- Split Agent panel into job-specific forms.
- Hide or collapse consultation-only controls when selected job is
  `triage`, `blueprint`, `review`, or other write-contract jobs.

### UX-4: Analysis profile is not content-aware

Expected:

- When creating a project from source, the app should ask for or infer an
  analysis profile:
  - fast visual rough cut
  - interview/dialogue
  - music/performance
  - full local analysis
- For interview/dialogue, STT and audio evidence should be first-class and the
  app should warn before generating candidates without transcripts.

Actual:

- The Studio source-analysis default skipped STT and diarization.
- Candidate extraction could be run with `transcriptDocuments: 0` and
  `transcriptItems: 0`.
- Only after the user mentioned that the material was a seminar interview did
  the correct route become clear: rerun STT/audio, then rerun candidates.

Likely fix direction:

- Add a project-intent or import-time profile selector.
- If the brief or filenames suggest interview/testimonial/seminar, default to
  STT/audio-required analysis.
- Make `audioReady=false` a blocking planning issue for dialogue-heavy
  projects, not a generic advisory.

### UX-5: Stale blueprint/templates make planning look ready too early

Expected:

- `planning-status` and Studio readiness should account for freshness and
  provenance, not just file existence.
- If `edit_blueprint.yaml` predates `selects_candidates.yaml`, the app should
  prompt to rerun blueprint before compile.

Actual:

- `planning-status AX10604` reported `planning ready` because
  `selects_candidates.yaml` and `edit_blueprint.yaml` both existed.
- The blueprint timestamp was older than the newly generated selects file and
  appeared likely to be template-derived.

Likely fix direction:

- Add artifact freshness checks:
  - blueprint must be newer than selects and brief, or explicitly accepted.
  - timeline must be newer than blueprint/selects.
  - candidates should be marked stale after transcript/audio analysis changes.
- Surface stale artifact status in the Project panel and command availability.

### UX-6: Audio workflow is present but not connected to the first-run route

Expected:

- If audio is important, the app should guide the user through:
  STT analysis -> audio story graph -> candidate regeneration -> blueprint.
- The user should not need a CLI-only STT rerun command.

Actual:

- `audio-story-run` was available, but there were no transcript inputs, so the
  meaningful missing step was STT-enabled analysis.
- The GUI did not expose a clear "rerun analysis with transcription" action.

Likely fix direction:

- Add an "Add transcripts/audio evidence" action when transcripts are missing.
- Add an analysis profile menu to the source-analysis panel:
  `Fast`, `Dialogue`, `Full`, `Custom`.
- In `Dialogue`, do not pass `--skip-stt`; optionally keep VLM/Marlin skipped.

## Recommended Priority

1. Add first-run workflow CTA that shows exactly one primary next action.
2. Add analysis profiles, with `Dialogue/interview` enabling STT.
3. Hide irrelevant Agent-panel controls per selected job.
4. Add artifact freshness/provenance gates for selects, blueprint, and timeline.
5. Make action queue buttons visible in narrow inspector widths.

## Acceptance Direction

A non-technical operator should be able to:

1. Create a project from a folder.
2. Choose `Interview/dialogue` at import or analysis time.
3. Run analysis and see that transcripts/audio evidence were created.
4. See `候補抽出` as the only next primary action.
5. Run candidate extraction and then see `構成設計` as the only next primary
   action.
6. Avoid compiling with stale template blueprints.
