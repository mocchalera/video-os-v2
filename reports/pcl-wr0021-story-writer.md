# Timeline AI consultation evidence story drafted

## Findings

- The story should focus on a professional editor asking AI about a selected clip, transition, or short range while staying inside the manual timeline loop.
- Expected behavior should make the prompt more useful by surfacing evidence that is already loaded locally: segment interest/peak cues, Marlin search hits, audio story nodes, BGM section energy, transcript, QA issues, and existing notes.
- The story must preserve the current safety contract: prompt preparation and direct Agent consultation remain read-only unless the human explicitly applies a supported review patch later.

## Evidence

- `docs/project-memory/PLANS.md` M7 keeps the AI-assisted edit bench active and calls for richer evidence context in prompts.
- `TimelineAgentConsultationPrompt.swift` already states "Do not modify files or write artifacts" and marks timeline-changing suggestions as `PREVIEW, not applied`.
- `StudioViewModel.prepareTimelineSelectionAgentPrompt()` prepares prompts from selected timeline clips/transitions and passes evidence, QA issues, and notes without mutating timeline state.
- `ProjectEvidenceStore.evidence(for:)` already provides the local evidence fields needed for the story without adding dependencies or external model requirements.

## Recommended pcl Commands

- `pcl story draft --feature F-0020 --actor "macOS Studio editor" --goal "ask AI for timeline advice with richer local evidence already attached" --benefit "so trim, replacement, explanation, and shorter-beat recommendations cite the selected clip's visual, transcript, audio, QA, and music context before any preview patch is considered" --expected-behavior "Preparing or running a timeline-scoped AI consultation includes selected clip IDs, timeline range, existing notes, QA issues, transcript excerpt, segment summary, segment interest/peak cues, Marlin temporal and find-result cues, audio event and audio-story cues, and BGM section context when available. The prompt stays read-only/PREVIEW, does not mutate timeline artifacts, and keeps review_patch output optional and schema-compatible."`
