import Foundation

public struct ProjectStudioReadinessCapability: Equatable, Sendable {
    public let id: String
    public let title: String
    public let readinessLabel: String
    public let detail: String
    public let nextAction: String
    public let nextCommand: String?
    public let isReady: Bool

    public init(
        id: String,
        title: String,
        readinessLabel: String,
        detail: String,
        nextAction: String,
        nextCommand: String? = nil,
        isReady: Bool
    ) {
        self.id = id
        self.title = title
        self.readinessLabel = readinessLabel
        self.detail = detail
        self.nextAction = nextAction
        self.nextCommand = nextCommand
        self.isReady = isReady
    }
}

public struct ProjectStudioReadinessAction: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let action: String
    public let command: String?
    public let isBlocking: Bool
}

public struct ProjectStudioReadinessStatus: Equatable, Sendable {
    public let projectURL: URL
    public let capabilities: [ProjectStudioReadinessCapability]
    public let pipelineLabel: String
    public let libraryLabel: String
    public let marlinLabel: String
    public let marlinDefaultLabel: String
    public let marlinDefaultDetail: String
    public let marlinDefaultNextAction: String
    public let marlinDefaultNextCommand: String
    public let handoffLabel: String
    public let renderLabel: String

    public var readyCapabilityCount: Int {
        capabilities.filter(\.isReady).count
    }

    public var totalCapabilityCount: Int {
        capabilities.count
    }

    public var scoreLabel: String {
        "\(readyCapabilityCount)/\(totalCapabilityCount)"
    }

    public var readinessLabel: String {
        if totalCapabilityCount > 0, readyCapabilityCount == totalCapabilityCount {
            return "studio ready"
        }
        if renderLabel == "render packaged" {
            return "packaged"
        }
        if pipelineLabel == "ready to render" {
            return "ready for finishing"
        }
        if pipelineLabel == "needs revision pass" || pipelineLabel == "review blocked" {
            return pipelineLabel
        }
        if capabilities.first(where: { $0.id == "rough-cut-review" })?.isReady == true {
            return "review loop active"
        }
        if capabilities.first(where: { $0.id == "planning" })?.isReady == true {
            return "ready to compile"
        }
        if capabilities.first(where: { $0.id == "material-rag" })?.isReady == true {
            return "ready for planning"
        }
        return "needs ingest"
    }

    public var nextAction: String {
        if pipelineLabel == "needs revision pass" || pipelineLabel == "review blocked" {
            return capabilities.first(where: { $0.id == "rough-cut-review" })?.nextAction
                ?? "Resolve the current review gate before continuing."
        }
        if let next = capabilities.first(where: { !$0.isReady }) {
            return next.nextAction
        }
        return "Render the final package or export the editor handoff packet."
    }

    public var nextCommand: String? {
        if pipelineLabel == "needs revision pass" || pipelineLabel == "review blocked" {
            return capabilities.first(where: { $0.id == "rough-cut-review" })?.nextCommand
        }
        return capabilities.first(where: { !$0.isReady })?.nextCommand
    }

    public var actionQueue: [ProjectStudioReadinessAction] {
        var actions: [ProjectStudioReadinessAction] = []
        var seen: Set<String> = []

        func append(_ capability: ProjectStudioReadinessCapability) {
            guard !capability.isReady, !seen.contains(capability.id) else { return }
            seen.insert(capability.id)
            actions.append(ProjectStudioReadinessAction(
                id: capability.id,
                title: capability.title,
                action: capability.nextAction,
                command: capability.nextCommand,
                isBlocking: true
            ))
        }

        if pipelineLabel == "needs revision pass" || pipelineLabel == "review blocked",
           let review = capabilities.first(where: { $0.id == "rough-cut-review" }) {
            append(review)
        }

        for capability in capabilities {
            append(capability)
        }

        actions.append(ProjectStudioReadinessAction(
            id: "marlin-default",
            title: "Marlin既定設定ゲート",
            action: marlinDefaultLabel == "ready for Marlin-first temporal VLM"
                ? "Apply Marlin-first temporal semantics to the analysis defaults after operator confirmation."
                : marlinDefaultNextAction,
            command: marlinDefaultLabel == "ready for Marlin-first temporal VLM"
                ? "swift run videoos-studio-cli marlin-preference-apply --confirm"
                : marlinDefaultNextCommand,
            isBlocking: false
        ))

        return actions
    }

    public var primaryAction: ProjectStudioReadinessAction? {
        actionQueue.first(where: \.isBlocking) ?? actionQueue.first
    }
}

public enum ProjectStudioReadinessStatusReader {
    public static func status(repositoryRoot: URL, projectURL: URL) -> ProjectStudioReadinessStatus {
        let fileManager = FileManager.default
        let evidence = ProjectEvidenceStore.load(projectURL: projectURL)
        let intent = ProjectIntentSummaryReader.summary(projectURL: projectURL)
        let library = ProjectLibraryReadinessStatusReader.status(projectURL: projectURL)
        let planning = ProjectPlanningStatusReader.status(projectURL: projectURL)
        let pipeline = ProjectPipelineGateStatusReader.status(repositoryRoot: repositoryRoot, projectURL: projectURL)
        let marlin = ProjectMarlinEvaluationStatusReader.status(projectURL: projectURL, repositoryRoot: repositoryRoot)
        let marlinDefault = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: repositoryRoot)
        let marlinQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: repositoryRoot)
        let handoff = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: evidence.assets)
        let renderPackage = ProjectRenderPackageStatusReader.status(projectURL: projectURL)
        let renderPlan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: projectURL)
        let packageJSONExists = fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("package.json").path)
        let projectID = projectURL.lastPathComponent

        let capabilities = [
            ProjectStudioReadinessCapability(
                id: "codex-runtime",
                title: "Codexランタイム",
                readinessLabel: packageJSONExists ? "configured" : "repo runtime missing",
                detail: CodexAppServerLaunchPlan(workspace: repositoryRoot).environmentDescription,
                nextAction: "Run app-server-smoke after the repository runtime is available.",
                nextCommand: swiftCommand("app-server-smoke"),
                isReady: packageJSONExists
            ),
            ProjectStudioReadinessCapability(
                id: "material-rag",
                title: "素材ライブラリ / RAG",
                readinessLabel: library.readinessLabel,
                detail: "\(library.evidenceSummary) / RAG \(library.ragCoverageLabel)",
                nextAction: library.recommendation,
                nextCommand: materialCommand(projectID: projectID, projectURL: projectURL, library: library),
                isReady: library.analysisReady && library.mediaReady && library.ragReady
            ),
            ProjectStudioReadinessCapability(
                id: "intent",
                title: "編集意図",
                readinessLabel: intent.readinessLabel,
                detail: "must-have=\(intent.mustHave.count) / must-avoid=\(intent.mustAvoid.count) / blockers=\(intent.blockerCount)",
                nextAction: intent.recommendation,
                nextCommand: intent.briefExists ? nil : swiftCommand("agent-prompt", projectID, "intent"),
                isReady: intent.briefExists && intent.blockersExists && intent.blockerCount == 0
            ),
            ProjectStudioReadinessCapability(
                id: "planning",
                title: planningCapabilityTitle(planning),
                readinessLabel: planning.readinessLabel,
                detail: "\(planning.assetCount) assets / \(planning.segmentCount) segments / selects=\(planning.hasSelects) / blueprint=\(planning.hasBlueprint)",
                nextAction: planning.recommendation,
                nextCommand: planningCommand(projectID: projectID, planning: planning),
                isReady: planning.readinessLabel == "planning ready"
            ),
            ProjectStudioReadinessCapability(
                id: "marlin-temporal-vlm",
                title: "Marlin時間理解VLM",
                readinessLabel: marlin.readinessLabel,
                detail: "\(marlin.eventCount + marlin.findResultCount) signals / \(String(format: "%.0f", marlin.coverageRatio * 100))% segment coverage / \(marlin.modelLabel)",
                nextAction: marlin.recommendation,
                nextCommand: marlin.canPreferMarlin ? nil : marlinCommand(projectID: projectID, repositoryRoot: repositoryRoot, projectURL: projectURL, assets: evidence.assets, marlin: marlin),
                isReady: marlin.canPreferMarlin
            ),
            ProjectStudioReadinessCapability(
                id: "audio-story",
                title: "音声ストーリー根拠",
                readinessLabel: library.audioReady ? "audio ready" : "audio evidence missing",
                detail: "\(library.audioEventCount) events / \(library.audioStoryNodeCount) story nodes / \(library.bgmBeatCount) beats",
                nextAction: "Run audio, diarization, transcript, and BGM analysis so cuts can follow sound as well as picture.",
                nextCommand: library.audioReady ? nil : swiftCommand("audio-story-run", projectID),
                isReady: library.audioReady
            ),
            ProjectStudioReadinessCapability(
                id: "rough-cut-review",
                title: "粗編集 / レビュー",
                readinessLabel: pipeline.readinessLabel,
                detail: "timeline=\(pipeline.hasTimeline) / review=\(pipeline.hasReview) / reviewStatus=\(pipeline.reviewStatus ?? "-")",
                nextAction: pipeline.nextAction,
                nextCommand: pipelineCommand(projectID: projectID, pipeline: pipeline),
                isReady: pipeline.hasTimeline && pipeline.hasReview && pipeline.reviewStatus == "approved"
            ),
            ProjectStudioReadinessCapability(
                id: "editor-handoff",
                title: "編集者ハンドオフ",
                readinessLabel: handoff.readinessLabel,
                detail: "packet media=\(handoff.mediaIncludedCount) / annotations=\(handoff.annotationIncluded) / review=\(handoff.reviewReportIncluded)",
                nextAction: "Relink source media or export the editor packet once timeline and source mapping are ready.",
                nextCommand: handoff.canExportPacket ? swiftCommand("handoff-export-packet", projectID) : swiftCommand("handoff-packet-status", projectID),
                isReady: handoff.canExportPacket
            ),
            ProjectStudioReadinessCapability(
                id: "final-render",
                title: "最終書き出し",
                readinessLabel: renderPackage.readinessLabel == "render packaged" ? renderPackage.readinessLabel : renderPlan.readinessLabel,
                detail: "package=\(renderPackage.readinessLabel) / run=\(renderPlan.readinessLabel)",
                nextAction: "Approve the reviewed rough cut, then run render/package validation.",
                nextCommand: renderPlan.canRun ? swiftCommand("render-run", projectID) : swiftCommand("render-status", projectID),
                isReady: renderPackage.readinessLabel == "render packaged" || renderPlan.canRun
            )
        ]

        return ProjectStudioReadinessStatus(
            projectURL: projectURL,
            capabilities: capabilities,
            pipelineLabel: pipeline.readinessLabel,
            libraryLabel: library.readinessLabel,
            marlinLabel: marlin.readinessLabel,
            marlinDefaultLabel: marlinDefault.decisionLabel,
            marlinDefaultDetail: "\(marlinDefault.candidateProjectCount)/\(marlinDefault.evaluatedProjectCount) candidate projects / \(marlinDefault.representativeCandidateBucketCount)/\(marlinDefault.representativeTargetBucketCount) representative buckets",
            marlinDefaultNextAction: marlinDefault.recommendation,
            marlinDefaultNextCommand: marlinDefault.canPreferMarlinAsDefault
                ? swiftCommand("marlin-preference-apply", "--confirm")
                : marlinDefaultCommand(queue: marlinQueue),
            handoffLabel: handoff.readinessLabel,
            renderLabel: renderPackage.readinessLabel
        )
    }

    private static func materialCommand(projectID: String, projectURL: URL, library: ProjectLibraryReadinessStatus) -> String {
        if library.assetCount == 0 || library.segmentCount == 0 {
            return swiftCommand("analysis-run", projectID)
        }
        if library.mediaMissingCount > 0 {
            let sourceMap = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL)
            if sourceMap.exists, !ProjectMediaRelinker.suggestedSearchRoots(projectURL: projectURL).isEmpty {
                return swiftCommand("media-relink-plan", projectID, "--from-source-map")
            }
            return swiftCommand("media-relink-plan", projectID, "<search-root>")
        }
        if library.mediaProxyNeededCount > 0 {
            return swiftCommand("media-proxy-build", projectID)
        }
        if !library.ragReady {
            return swiftCommand("index-rebuild", projectID)
        }
        return swiftCommand("library-status", projectID)
    }

    private static func planningCommand(projectID: String, planning: ProjectPlanningStatus) -> String? {
        if !planning.analysisReady {
            return swiftCommand("analysis-run", projectID)
        }
        if planning.dialogueEvidenceRequired && !planning.dialogueEvidenceReady {
            return swiftCommand("audio-story-run", projectID)
        }
        if let job = planning.nextAgentJob {
            switch job {
            case .triage:
                return swiftCommand("agent-prompt", projectID, "triage")
            case .blueprint:
                return swiftCommand("agent-prompt", projectID, "blueprint")
            case .compile:
                return swiftCommand("compile-run", projectID)
            default:
                return swiftCommand("agent-prompt", projectID, job.rawValue)
            }
        }
        return nil
    }

    private static func planningCapabilityTitle(_ planning: ProjectPlanningStatus) -> String {
        if planning.dialogueEvidenceRequired && !planning.dialogueEvidenceReady {
            return "音声根拠"
        }
        if !planning.hasSelects {
            return "候補抽出"
        }
        if !planning.hasBlueprint || !planning.isBlueprintFresh {
            return "構成案"
        }
        return "計画"
    }

    private static func marlinCommand(
        projectID: String,
        repositoryRoot: URL,
        projectURL: URL,
        assets: AnalysisAssetDocument?,
        marlin: ProjectMarlinEvaluationStatus
    ) -> String {
        if marlin.readinessLabel == "needs segment materialization" {
            return swiftCommand("marlin-materialize", projectID)
        }
        let plan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: assets)
        if plan.canRun {
            return swiftCommand("marlin-eval-run", projectID)
        }
        return swiftCommand("marlin-representative-plan")
    }

    private static func marlinDefaultCommand(queue: ProjectMarlinEvaluationQueue) -> String {
        if let materialize = queue.items.first(where: \.needsSegmentMaterialization) {
            return swiftCommand("marlin-materialize", materialize.id)
        }
        if queue.items.contains(where: { $0.canRunDefaultEvaluation && !$0.canPreferMarlin && !$0.needsSegmentMaterialization }) {
            return swiftCommand(
                "marlin-eval-next",
                ["--execute"] + ProjectMarlinEvaluationCommandDefaults.boundedSkipExistingArgs
            )
        }
        if let relink = queue.items.first(where: { $0.hasNoUnevaluatedReadySources && $0.mediaMissingCount > 0 })
            ?? queue.items.first(where: { !$0.canPreferMarlin && $0.mediaMissingCount > 0 }) {
            return marlinRelinkCommand(for: relink)
        }
        return swiftCommand("marlin-representative-plan")
    }

    private static func marlinRelinkCommand(for item: ProjectMarlinEvaluationQueueItem) -> String {
        let sourceMap = ProjectMediaSourceMapStatusReader.status(projectURL: item.projectURL)
        if sourceMap.exists, !ProjectMediaRelinker.suggestedSearchRoots(projectURL: item.projectURL).isEmpty {
            return swiftCommand("media-relink-plan", item.id, "--from-source-map")
        }
        return swiftCommand("media-relink-plan", item.id, "<search-root>")
    }

    private static func pipelineCommand(projectID: String, pipeline: ProjectPipelineGateStatus) -> String? {
        if !pipeline.hasTimeline {
            return swiftCommand("compile-run", projectID)
        }
        if !pipeline.hasReview {
            return swiftCommand("agent-prompt", projectID, "review")
        }
        if pipeline.reviewStatus == "needs_revision", pipeline.reviewPatchOperationCount > 0 {
            return swiftCommand("compile-run", projectID, "--review-patch")
        }
        if pipeline.reviewStatus == "needs_revision" {
            return swiftCommand("agent-prompt", projectID, "review")
        }
        if pipeline.renderCanRun {
            return swiftCommand("render-run", projectID)
        }
        return swiftCommand("gate-status", projectID)
    }

    private static func swiftCommand(_ parts: String...) -> String {
        (["swift", "run", "videoos-studio-cli"] + parts).joined(separator: " ")
    }

    private static func swiftCommand(_ command: String, _ args: [String]) -> String {
        (["swift", "run", "videoos-studio-cli", command] + args).joined(separator: " ")
    }
}
