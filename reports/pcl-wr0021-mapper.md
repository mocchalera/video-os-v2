# Timeline AI consultation evidence surface mapped

## Findings

- Existing feature coverage already includes Source Bin collection ordering as `F-0019`, with unit coverage passing and integration/manual checks still planned.
- The next small user-visible macOS Studio improvement should come from the M7 AI-assisted edit bench rather than another broad Source Bin folder/reorder workflow. `docs/project-memory/PLANS.md` still had an unchecked requirement to feed clip evidence, QA issues, transcript, Marlin, audio signals, and current timeline context into timeline-scoped AI prompts.
- `TimelineAgentConsultationPrompt.make(...)` already receives `ClipEvidence`, QA issues, selected clips, selected transition, and existing notes. It emitted asset, segment summary, transcript, Marlin temporal events, audio events, and QA issues, but did not expose several already-loaded evidence fields: segment interest points, peak analysis, Marlin find/search hits, audio story nodes, and BGM sections.
- A focused feature can expand the read-only AI consultation prompt evidence packet without changing Agent execution, review-patch schema, timeline artifacts, compiler contracts, source media, rendered outputs, or project-loop storage.

## Evidence

- `docs/project-memory/PLANS.md` M7 lists prompt evidence as part of the AI-assisted edit bench.
- `apps/macos-studio/Sources/VideoOSStudioCore/TimelineAgentConsultationPrompt.swift` builds the prompt and appends selected clip evidence.
- `apps/macos-studio/Sources/VideoOSStudio/StudioViewModel.swift` passes `evidenceStore?.evidence(for:)`, `qaDashboard?.latestIssuesByClipID`, and existing clip notes into `TimelineAgentConsultationPrompt.make(...)`.
- `apps/macos-studio/Sources/VideoOSStudioCore/ProjectEvidenceStore.swift` already loads segment interest points, peak analysis, Marlin find results, audio story nodes, and BGM sections into `ClipEvidence`.
- `apps/macos-studio/Tests/VideoOSStudioCoreTests/TimelineAgentConsultationPromptTests.swift` covers the read-only prompt contract, QA issues, all consultation intents, and is the natural test home for richer evidence text.

## Recommended pcl Commands

- `pcl feature add --name "Timeline AI consultation rich evidence context" --surface "apps/macos-studio" --description "Expand timeline-scoped AI consultation prompts with already-loaded segment interest points, peak analysis, Marlin find hits, audio story nodes, and BGM section cues while keeping Agent output read-only/PREVIEW and leaving timeline artifacts, review patch schema, compiler contracts, source media, and rendered outputs unchanged." --evidence "reports/pcl-wr0021-mapper.md; docs/project-memory/PLANS.md M7 AI-Assisted Edit Bench; TimelineAgentConsultationPrompt.swift; ProjectEvidenceStore.swift; TimelineAgentConsultationPromptTests.swift"`
