# Timeline AI consultation evidence tests designed

## Findings

- The feature needs focused Swift unit coverage in `TimelineAgentConsultationPromptTests` because the behavior is deterministic prompt text generation.
- The happy path should verify that rich evidence fields appear in the prompt when present.
- The regression path should verify the read-only/PREVIEW contract still appears and that richer evidence does not require review-patch JSON for explanation or source-search-only advice.
- A build/typecheck/app launch check remains useful because the prompt is wired through `StudioViewModel` and visible Agent panel/command palette actions.

## Evidence

- `TimelineAgentConsultationPromptTests` already decodes a fixture timeline and asserts the prompt's read-only/PREVIEW contract, selected clip ordering, transition context, QA issue formatting, and intent-specific text.
- `ProjectEvidenceStore.swift` defines `ClipEvidence` fields for Marlin find results, audio story nodes, BGM sections, segment interest points, and peak analysis.
- `StudioViewModel.prepareTimelineSelectionAgentPrompt()` is the integration point that passes local evidence into the prompt.

## Recommended pcl Commands

- `pcl test plan --feature F-0020 --story US-0004 --type unit --scenario "Build a timeline AI consultation prompt for a selected clip with segment interest points, peak analysis, Marlin find results, audio story nodes, BGM section cues, transcript, QA issue, and existing note evidence." --expected "The prompt includes the richer local evidence under the selected clip while preserving the read-only/PREVIEW response contract and exact timeline_version guidance."`
- `pcl test plan --feature F-0020 --story US-0004 --type integration --scenario "Prepare a timeline-scoped AI consultation from StudioViewModel with selected clip evidence, QA dashboard issues, and existing annotation notes loaded." --expected "The generated agent prompt contains selected timeline context and local evidence without changing timeline state, review patch drafts, source monitor state, project artifacts, or compiler inputs."`
- `pcl test plan --feature F-0020 --story US-0004 --type manual --scenario "In the running macOS app, select a timeline clip and use Agent panel or Command Palette AI consultation actions after QA/evidence artifacts are loaded." --expected "The previewed prompt includes richer evidence cues, remains readable in the Agent panel, and running the consultation stays read-only unless the editor explicitly applies a supported review patch."`
