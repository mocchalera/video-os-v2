import Foundation

public struct VideoOSAgentWriteContract: Equatable, Sendable {
    public let modeLabel: String
    public let commandContract: String?
    public let entrypoint: String
    public let allowedArtifactRoots: [String]
    public let expectedArtifacts: [String]
    public let forbiddenWrites: [String]

    public var readOnly: Bool {
        allowedArtifactRoots.isEmpty && expectedArtifacts.isEmpty
    }

    public var requiresOperatorApproval: Bool {
        !readOnly
    }

    public func violations(for diffs: [ProjectArtifactDiff]) -> [VideoOSAgentWriteViolation] {
        diffs.compactMap { diff in
            if readOnly {
                return VideoOSAgentWriteViolation(
                    relativePath: diff.relativePath,
                    kind: diff.kind,
                    reason: "read-only job changed a canonical artifact"
                )
            }
            if allowedArtifactRoots.contains(where: { Self.scope($0, allows: diff.relativePath) }) {
                return nil
            }
            return VideoOSAgentWriteViolation(
                relativePath: diff.relativePath,
                kind: diff.kind,
                reason: "outside allowed write contract"
            )
        }
    }

    private static func scope(_ scope: String, allows relativePath: String) -> Bool {
        let normalized = normalize(scope)
        if normalized.hasSuffix("/") {
            return relativePath.hasPrefix(normalized)
        }
        return relativePath == normalized
    }

    private static func normalize(_ scope: String) -> String {
        let parts = scope.split(separator: "/").map(String.init)
        if parts.count >= 3, parts[0] == "projects" {
            let normalized = parts.dropFirst(2).joined(separator: "/")
            return scope.hasSuffix("/") ? "\(normalized)/" : normalized
        }
        return scope
    }
}

public struct VideoOSAgentWriteViolation: Identifiable, Equatable, Sendable {
    public var id: String { "\(kind.rawValue):\(relativePath)" }
    public let relativePath: String
    public let kind: ProjectArtifactDiff.Kind
    public let reason: String
}

public enum VideoOSAgentJob: String, CaseIterable, Identifiable, Sendable {
    case status
    case validate
    case clipAnnotation = "clip-annotation"
    case triage
    case blueprint
    case compile
    case review
    case render

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .status:
            return "Status"
        case .validate:
            return "Validate"
        case .clipAnnotation:
            return "Clip Note"
        case .triage:
            return "Triage"
        case .blueprint:
            return "Blueprint"
        case .compile:
            return "Compile"
        case .review:
            return "Review"
        case .render:
            return "Render"
        }
    }

    public var systemImage: String {
        switch self {
        case .status:
            return "list.bullet.rectangle"
        case .validate:
            return "checkmark.shield"
        case .clipAnnotation:
            return "text.bubble"
        case .triage:
            return "rectangle.stack.badge.person.crop"
        case .blueprint:
            return "rectangle.connected.to.line.below"
        case .compile:
            return "timeline.selection"
        case .review:
            return "text.badge.checkmark"
        case .render:
            return "film.stack"
        }
    }

    public var readOnly: Bool {
        writeContract(projectID: "<id>").readOnly
    }

    public var requiresOperatorApproval: Bool {
        writeContract(projectID: "<id>").requiresOperatorApproval
    }

    public var sandboxLabel: String {
        readOnly ? "read-only / network off" : "workspace-write / user reviewed"
    }

    public var approvalSummary: String {
        switch self {
        case .status:
            return "Read current project gate state and report the next safe action."
        case .validate:
            return "Run schema validation and report violations without changing artifacts."
        case .clipAnnotation:
            return "Draft a selected-clip editor note from timeline, transcript, Marlin, and audio evidence without writing files."
        case .triage:
            return "Select candidate segments from analyzed material and write selects only."
        case .blueprint:
            return "Design the rough-cut structure from selected candidates and write blueprint artifacts only."
        case .compile:
            return "Run the deterministic compiler after Codex confirms gates and planned writes."
        case .review:
            return "Run review against an existing compiled timeline and emit review artifacts only."
        case .render:
            return "Run final render/package after approval and emit package/output artifacts only."
        }
    }

    public var plannedWriteScopes: [String] {
        writeContract(projectID: "<id>").allowedArtifactRoots
    }

    public var requiresSelectedTimelineClip: Bool {
        self == .clipAnnotation
    }

    public func writeContract(projectID: String) -> VideoOSAgentWriteContract {
        let project = "projects/\(projectID)"
        switch self {
        case .status:
            return VideoOSAgentWriteContract(
                modeLabel: "read-only status",
                commandContract: nil,
                entrypoint: "npx tsx scripts/status.ts \(project)",
                allowedArtifactRoots: [],
                expectedArtifacts: [],
                forbiddenWrites: [
                    "any repository file mutation",
                    "timeline, review, media proxy, or search-index writes"
                ]
            )
        case .validate:
            return VideoOSAgentWriteContract(
                modeLabel: "read-only validation",
                commandContract: nil,
                entrypoint: "npx tsx scripts/validate-schemas.ts \(project)",
                allowedArtifactRoots: [],
                expectedArtifacts: [],
                forbiddenWrites: [
                    "any repository file mutation",
                    "schema repair or artifact generation"
                ]
            )
        case .clipAnnotation:
            return VideoOSAgentWriteContract(
                modeLabel: "read-only selected-clip annotation proposal",
                commandContract: nil,
                entrypoint: "Codex read-only turn using selected timeline clip evidence",
                allowedArtifactRoots: [],
                expectedArtifacts: [],
                forbiddenWrites: [
                    "any repository file mutation",
                    "saving or clearing \(project)/07_handoff/editor_annotations.json",
                    "timeline, review, media proxy, or search-index writes"
                ]
            )
        case .triage:
            return VideoOSAgentWriteContract(
                modeLabel: "workspace-write triage contract",
                commandContract: ".codex/commands/triage.md",
                entrypoint: "runtime/commands/triage.ts via .codex/commands/triage.md",
                allowedArtifactRoots: [
                    "\(project)/04_plan/selects_candidates.yaml",
                    "\(project)/project_state.yaml",
                    "\(project)/progress.json"
                ],
                expectedArtifacts: [
                    "\(project)/04_plan/selects_candidates.yaml"
                ],
                forbiddenWrites: [
                    "direct edits to analysis artifacts under \(project)/03_analysis/",
                    "blueprint artifacts under \(project)/04_plan/edit_blueprint.yaml",
                    "timeline writes under \(project)/05_timeline/",
                    "review, render, media proxy, or search-index writes"
                ]
            )
        case .blueprint:
            return VideoOSAgentWriteContract(
                modeLabel: "workspace-write blueprint contract",
                commandContract: ".codex/commands/blueprint.md",
                entrypoint: "runtime/commands/blueprint.ts via .codex/commands/blueprint.md",
                allowedArtifactRoots: [
                    "\(project)/04_plan/edit_blueprint.yaml",
                    "\(project)/04_plan/uncertainty_register.yaml",
                    "\(project)/04_plan/script_evaluation.yaml",
                    "\(project)/project_state.yaml",
                    "\(project)/progress.json"
                ],
                expectedArtifacts: [
                    "\(project)/04_plan/edit_blueprint.yaml",
                    "\(project)/04_plan/uncertainty_register.yaml"
                ],
                forbiddenWrites: [
                    "direct edits to selects under \(project)/04_plan/selects_candidates.yaml",
                    "analysis artifacts under \(project)/03_analysis/",
                    "timeline writes under \(project)/05_timeline/",
                    "review, render, media proxy, or search-index writes"
                ]
            )
        case .compile:
            return VideoOSAgentWriteContract(
                modeLabel: "workspace-write compiler contract",
                commandContract: ".codex/commands/compile.md",
                entrypoint: "npx tsx scripts/compile-timeline.ts \(project)",
                allowedArtifactRoots: [
                    "\(project)/05_timeline/",
                    "\(project)/project_state.yaml",
                    "\(project)/progress.json"
                ],
                expectedArtifacts: [
                    "\(project)/05_timeline/timeline.json",
                    "\(project)/05_timeline/timeline.otio",
                    "\(project)/05_timeline/preview-manifest.json"
                ],
                forbiddenWrites: [
                    "direct edits to planning artifacts outside compiler inputs",
                    "manual timeline writes outside scripts/compile-timeline.ts",
                    "review artifacts under \(project)/06_review/"
                ]
            )
        case .review:
            return VideoOSAgentWriteContract(
                modeLabel: "workspace-write review contract",
                commandContract: ".codex/commands/review.md",
                entrypoint: "runtime/commands/review.ts via .codex/commands/review.md",
                allowedArtifactRoots: [
                    "\(project)/06_review/review_report.yaml",
                    "\(project)/06_review/review_patch.json",
                    "\(project)/project_state.yaml",
                    "\(project)/progress.json"
                ],
                expectedArtifacts: [
                    "\(project)/06_review/review_report.yaml",
                    "\(project)/06_review/review_patch.json"
                ],
                forbiddenWrites: [
                    "auto-compiling or modifying \(project)/05_timeline/timeline.json",
                    "direct edits to analysis, triage, or blueprint artifacts",
                    "media, proxy, or search-index writes"
                ]
            )
        case .render:
            return VideoOSAgentWriteContract(
                modeLabel: "workspace-write render contract",
                commandContract: ".codex/commands/render.md",
                entrypoint: "runtime/commands/render.ts via .codex/commands/render.md",
                allowedArtifactRoots: [
                    "\(project)/07_package/",
                    "\(project)/09_output/final.mp4",
                    "\(project)/project_state.yaml",
                    "\(project)/progress.json"
                ],
                expectedArtifacts: [
                    "\(project)/07_package/qa-report.json",
                    "\(project)/07_package/package_manifest.json",
                    "\(project)/09_output/final.mp4"
                ],
                forbiddenWrites: [
                    "auto-compiling or modifying \(project)/05_timeline/timeline.json",
                    "direct edits to analysis, triage, blueprint, or review artifacts",
                    "media source, proxy, or search-index writes outside render/package outputs"
                ]
            )
        }
    }

    public func prompt(project: ProjectSummary, repositoryRoot: URL) -> String {
        prompt(project: project, repositoryRoot: repositoryRoot, ragContext: nil)
    }

    public func prompt(project: ProjectSummary, repositoryRoot: URL, ragContext: ProjectRAGContextPack?) -> String {
        let projectPath = project.path.path
        let relativeProject = "projects/\(project.id)"
        let contract = writeContract(projectID: project.id)
        let contractText = promptContractText(contract)
        let ragContextText = promptRAGContextText(ragContext)

        switch self {
        case .status:
            return """
            Run a read-only Video OS status check for project `\(relativeProject)`.

            Use the existing repository entrypoint:
            `npx tsx scripts/status.ts \(relativeProject)`

            Do not modify files. Summarize the current gate state, missing prerequisites, and the next safest action for the editor.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .validate:
            return """
            Run a read-only schema validation check for project `\(relativeProject)`.

            Use the existing repository entrypoint:
            `npx tsx scripts/validate-schemas.ts \(relativeProject)`

            Do not modify files. Report whether validation passed, the artifact count, and any violations exactly enough for the GUI operator to act.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .clipAnnotation:
            return """
            Prepare a read-only selected-clip editor annotation proposal for project `\(relativeProject)`.

            This job requires a selected timeline clip in the native editor. Do not modify files. Use the selected clip, transcript, Marlin, and audio evidence supplied by the GUI, then return exactly one JSON object with `clip_id`, `note`, and `handoff_instruction`.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .triage:
            return """
            Prepare and, if approvals allow it, run the Video OS triage phase for project `\(relativeProject)`.

            Use the existing command contract in `.codex/commands/triage.md`. The triage job must consume analyzed assets and segments, select candidate footage, and emit only `04_plan/selects_candidates.yaml` plus state/progress updates.

            Before any file mutation, confirm analysis evidence exists and explain the planned writes. Do not write blueprint, timeline, review, render, media proxy, or search-index artifacts. Stop and report blockers if prerequisites are missing or approval is required.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .blueprint:
            return """
            Prepare and, if approvals allow it, run the Video OS blueprint phase for project `\(relativeProject)`.

            Use the existing command contract in `.codex/commands/blueprint.md`. The blueprint job must consume `04_plan/selects_candidates.yaml`, the creative brief, blockers, and optional style context, then emit only blueprint artifacts.

            Before any file mutation, confirm selects and intent artifacts exist and explain the planned writes. Do not write timeline, review, render, media proxy, or search-index artifacts. Stop and report blockers if prerequisites are missing or approval is required.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .compile:
            return """
            Prepare and, if approvals allow it, run the Video OS compile phase for project `\(relativeProject)`.

            Use the existing command contract in `.codex/commands/compile.md` and the supported entrypoint:
            `npx tsx scripts/compile-timeline.ts \(relativeProject)`

            Before any file mutation, confirm gates and explain the planned writes. Preserve canonical artifact rules: only the compiler may write `05_timeline/timeline.json`. Stop and report blockers if prerequisites are missing or approval is required.
            End with exactly one JSON object and no markdown after it:
            `{"engine_action":"run_compile","reason":"..."}`
            Use `run_compile` only if compile and planning gates are open and the deterministic compiler may run now. Use `block` if any prerequisite, gate, or approval is missing; include the blocker in `reason`. The native app may execute the deterministic compiler after this approved Codex turn only when you return `run_compile`.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .review:
            return """
            Prepare and, if approvals allow it, run the Video OS review phase for project `\(relativeProject)`.

            Use the existing command contract in `.codex/commands/review.md`. The review must inspect an already compiled timeline and emit only review artifacts.

            Before any file mutation, confirm gates and explain the planned writes. Do not auto-compile in phase-split mode. Stop and report blockers if prerequisites are missing or approval is required.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        case .render:
            return """
            Prepare and, if approvals allow it, run the Video OS render/package phase for project `\(relativeProject)`.

            Use the existing command contract in `.codex/commands/render.md`. The render must start only from an approved or rerunnable packaged project, run packaging/render checks, and emit only package/output artifacts.

            Before any file mutation, confirm gates and explain the planned writes. Do not auto-compile or modify `05_timeline/timeline.json`. Stop and report blockers if prerequisites are missing or approval is required.
            \(contractText)
            \(ragContextText)
            Repository root: `\(repositoryRoot.path)`
            Project path: `\(projectPath)`
            """
        }
    }

    public func prompt(
        project: ProjectSummary,
        repositoryRoot: URL,
        selection: TimelineClipSelection,
        timeline: TimelineDocument,
        evidence: ClipEvidence?,
        existingNote: ProjectEditorClipNote?
    ) -> String {
        guard self == .clipAnnotation else {
            return prompt(project: project, repositoryRoot: repositoryRoot)
        }

        let contractText = promptContractText(writeContract(projectID: project.id))
        let proposalPrompt = ProjectEditorAnnotationProposalPrompt.make(
            project: project,
            selection: selection,
            timeline: timeline,
            evidence: evidence,
            existingNote: existingNote
        )
        return """
        Run the selected-clip annotation proposal job for project `projects/\(project.id)`.

        \(proposalPrompt)

        \(contractText)
        Repository root: `\(repositoryRoot.path)`
        Project path: `\(project.path.path)`
        """
    }

    private func promptContractText(_ contract: VideoOSAgentWriteContract) -> String {
        var lines = [
            "Write contract:",
            "- Mode: \(contract.modeLabel)",
            "- Entrypoint: `\(contract.entrypoint)`"
        ]
        if let commandContract = contract.commandContract {
            lines.append("- Command contract: `\(commandContract)`")
        }
        if contract.allowedArtifactRoots.isEmpty {
            lines.append("- Allowed writes: none")
        } else {
            lines.append("- Allowed writes:")
            lines.append(contentsOf: contract.allowedArtifactRoots.map { "  - `\($0)`" })
        }
        if !contract.expectedArtifacts.isEmpty {
            lines.append("- Expected artifacts:")
            lines.append(contentsOf: contract.expectedArtifacts.map { "  - `\($0)`" })
        }
        if !contract.forbiddenWrites.isEmpty {
            lines.append("- Forbidden writes:")
            lines.append(contentsOf: contract.forbiddenWrites.map { "  - \($0)" })
        }
        return lines.joined(separator: "\n")
    }

    private func promptRAGContextText(_ ragContext: ProjectRAGContextPack?) -> String {
        guard let ragContext, !ragContext.isEmpty else { return "" }
        return ragContext.promptText
    }
}
