import Foundation

public struct ProjectStudioGoalRequirement: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let statusLabel: String
    public let detail: String
    public let nextAction: String
    public let nextCommand: String?
    public let isSatisfied: Bool

    public init(
        id: String,
        title: String,
        statusLabel: String,
        detail: String,
        nextAction: String,
        nextCommand: String?,
        isSatisfied: Bool
    ) {
        self.id = id
        self.title = title
        self.statusLabel = statusLabel
        self.detail = detail
        self.nextAction = nextAction
        self.nextCommand = nextCommand
        self.isSatisfied = isSatisfied
    }
}

public struct ProjectStudioGoalStatus: Equatable, Sendable {
    public let projectURL: URL
    public let requirements: [ProjectStudioGoalRequirement]

    public var satisfiedRequirementCount: Int {
        requirements.filter(\.isSatisfied).count
    }

    public var totalRequirementCount: Int {
        requirements.count
    }

    public var scoreLabel: String {
        "\(satisfiedRequirementCount)/\(totalRequirementCount)"
    }

    public var readinessLabel: String {
        guard totalRequirementCount > 0 else { return "not assessed" }
        if satisfiedRequirementCount == totalRequirementCount {
            return "objective verified"
        }
        if satisfiedRequirementCount >= max(1, totalRequirementCount - 2) {
            return "near studio target"
        }
        if satisfiedRequirementCount >= max(1, totalRequirementCount / 2) {
            return "studio loop partially operational"
        }
        return "foundation in progress"
    }

    public var nextRequirement: ProjectStudioGoalRequirement? {
        requirements.first { !$0.isSatisfied }
    }

    public var nextAction: String {
        nextRequirement?.nextAction ?? "Run full acceptance and visual QA before marking the studio objective complete."
    }

    public var nextCommand: String? {
        nextRequirement?.nextCommand
    }
}

public enum ProjectStudioGoalStatusReader {
    public static func status(
        repositoryRoot: URL,
        projectURL: URL,
        marlinModelAccessStatus: ProjectMarlinModelAccessStatus? = nil,
        preflightStatus: ProjectPackagePreflightStatus = ProjectPackagePreflightRunner.pending(),
        packageVerificationStatus: ProjectPackageVerificationStatus = ProjectPackageVerificationRunner.pending()
    ) -> ProjectStudioGoalStatus {
        let fileManager = FileManager.default
        let projectID = projectURL.lastPathComponent
        let packageSwiftExists = fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("Package.swift").path)
        let guiTargetExists = fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudio/ContentView.swift").path)
        let cliTargetExists = fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudioCLI/main.swift").path)
        let runScriptExists = fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("script/build_and_run.sh").path)
        let packageJSONExists = fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("package.json").path)

        let library = ProjectLibraryReadinessStatusReader.status(projectURL: projectURL)
        let planning = ProjectPlanningStatusReader.status(projectURL: projectURL)
        let pipeline = ProjectPipelineGateStatusReader.status(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            preflightStatus: preflightStatus
        )
        let marlin = ProjectMarlinEvaluationStatusReader.status(projectURL: projectURL, repositoryRoot: repositoryRoot)
        let marlinDefault = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: repositoryRoot)
        let marlinModelAccess = marlinModelAccessStatus ?? ProjectMarlinModelAccessStatusReader.status(repositoryRoot: repositoryRoot)
        let representativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: repositoryRoot)
        let evidence = ProjectEvidenceStore.load(projectURL: projectURL)
        let handoff = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: evidence.assets)
        let renderPackage = ProjectRenderPackageStatusReader.status(
            projectURL: projectURL,
            verificationStatus: packageVerificationStatus
        )
        let renderPlan = ProjectRenderRunPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            preflightStatus: preflightStatus
        )
        let nativeEditorVisualQA = ProjectNativeEditorVisualQAStatusReader.status(repositoryRoot: repositoryRoot)

        let nativeSurfacesReady = packageSwiftExists && guiTargetExists && cliTargetExists && runScriptExists
        let codexRuntimeReady = packageJSONExists && fileManager.fileExists(atPath: repositoryRoot.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudioCore/CodexAppServerProtocol.swift").path)
        let materialRAGReady = library.analysisReady && library.mediaReady && library.ragReady
        let marlinReady = marlinModelAccess.isReadyForLiveMarlin && marlinDefault.canPreferMarlinAsDefault
        let audioReady = library.audioReady
        let roughCutReady = planning.readinessLabel == "planning ready" && pipeline.hasTimeline
        let nativeEditorReady = library.timelineExists && library.mediaReady && handoff.canExportPacket
        let nativeEditorPolished = nativeEditorReady && nativeEditorVisualQA.isPassed
        let renderReady = renderPackage.readinessLabel == "render packaged"
        let representativeCoverageReady = representativePlan.candidateCoveredBucketCount == representativePlan.targetBucketCount

        let requirements = [
            ProjectStudioGoalRequirement(
                id: "native-gui-cli",
                title: "ネイティブGUIとCLI",
                statusLabel: nativeSurfacesReady ? "available" : "missing surface",
                detail: "Package.swift=\(packageSwiftExists) / GUI=\(guiTargetExists) / CLI=\(cliTargetExists) / run script=\(runScriptExists)",
                nextAction: "Keep the SwiftPM GUI, CLI, and build script runnable as the studio shell.",
                nextCommand: nativeSurfacesReady ? "./script/build_and_run.sh --verify" : "swift build",
                isSatisfied: nativeSurfacesReady
            ),
            ProjectStudioGoalRequirement(
                id: "codex-app-server",
                title: "Codex App Serverランタイム",
                statusLabel: codexRuntimeReady ? "configured" : "not configured",
                detail: CodexAppServerLaunchPlan(workspace: repositoryRoot).environmentDescription,
                nextAction: "Verify the Codex App Server handshake and thread loop before treating Codex as the main agent runtime.",
                nextCommand: swiftCommand("app-server-smoke"),
                isSatisfied: codexRuntimeReady
            ),
            ProjectStudioGoalRequirement(
                id: "material-db-rag",
                title: "素材DBとRAG",
                statusLabel: materialRAGReady ? "ready" : library.readinessLabel,
                detail: library.evidenceSummary + " / RAG " + library.ragCoverageLabel,
                nextAction: library.recommendation,
                nextCommand: materialCommand(projectID: projectID, projectURL: projectURL, library: library),
                isSatisfied: materialRAGReady
            ),
            ProjectStudioGoalRequirement(
                id: "marlin-preferred-vlm",
                title: "Marlin-2B優先VLMゲート",
                statusLabel: marlinReady ? "ready for preference" : marlinDefault.decisionLabel,
                detail: "\(marlin.readinessLabel) / model access=\(marlinModelAccess.readinessLabel) / \(marlinDefault.candidateProjectCount)/\(marlinDefault.evaluatedProjectCount) candidate projects / \(marlinDefault.representativeCandidateBucketCount)/\(marlinDefault.representativeTargetBucketCount) representative buckets",
                nextAction: marlinReady
                    ? "Apply Marlin-first temporal semantics with operator confirmation."
                    : (marlinModelAccess.isReadyForLiveMarlin ? marlinDefault.recommendation : marlinModelAccess.recommendation),
                nextCommand: marlinReady
                    ? swiftCommand("marlin-preference-apply", "--confirm")
                    : (marlinModelAccess.isReadyForLiveMarlin ? marlinDefaultCommand(repositoryRoot: repositoryRoot) : swiftCommand("marlin-model-access-status")),
                isSatisfied: marlinReady
            ),
            ProjectStudioGoalRequirement(
                id: "audio-intelligence",
                title: "音声優先の編集根拠",
                statusLabel: audioReady ? "ready" : "audio evidence missing",
                detail: "\(library.audioEventCount) events / \(library.audioStoryNodeCount) story nodes / \(library.bgmBeatCount) BGM beats",
                nextAction: "Build audio story evidence so dialogue, speakers, sound events, and BGM timing can guide cuts.",
                nextCommand: audioReady ? swiftCommand("audio-map", projectID) : swiftCommand("audio-story-run", projectID),
                isSatisfied: audioReady
            ),
            ProjectStudioGoalRequirement(
                id: "intent-to-roughcut",
                title: "編集意図から粗編集まで",
                statusLabel: roughCutReady ? "rough cut available" : planning.readinessLabel,
                detail: "timeline=\(pipeline.hasTimeline) / review=\(pipeline.hasReview) / planning=\(planning.readinessLabel)",
                nextAction: planning.recommendation,
                nextCommand: planningCommand(projectID: projectID, planning: planning),
                isSatisfied: roughCutReady
            ),
            ProjectStudioGoalRequirement(
                id: "native-editor-ui",
                title: "ネイティブNLE風エディタUX",
                statusLabel: nativeEditorPolished ? "visual QA passed" : (nativeEditorReady ? nativeEditorVisualQA.readinessLabel : "not yet operational"),
                detail: "timeline=\(library.timelineExists) / media=\(library.mediaReady) / handoff packet=\(handoff.canExportPacket) / \(nativeEditorVisualQA.detail)",
                nextAction: nativeEditorPolished
                    ? nativeEditorVisualQA.recommendation
                    : (nativeEditorReady
                        ? nativeEditorVisualQA.recommendation
                        : "Create a previewable timeline and media mapping so the native NLE surface can be inspected."
                    ),
                nextCommand: nativeEditorReady ? "./script/build_and_run.sh --verify" : swiftCommand("media-status", projectID),
                isSatisfied: nativeEditorPolished
            ),
            ProjectStudioGoalRequirement(
                id: "editor-handoff",
                title: "編集者ハンドオフ",
                statusLabel: handoff.canExportPacket ? handoff.readinessLabel : "handoff incomplete",
                detail: "packet media=\(handoff.mediaIncludedCount) / annotations=\(handoff.annotationIncluded) / review=\(handoff.reviewReportIncluded)",
                nextAction: "Export and verify an editor packet with media, notes, review context, and Premiere XML.",
                nextCommand: handoff.canExportPacket ? swiftCommand("handoff-export-packet", projectID) : swiftCommand("handoff-packet-status", projectID),
                isSatisfied: handoff.canExportPacket
            ),
            ProjectStudioGoalRequirement(
                id: "final-render",
                title: "最終書き出し/パッケージ",
                statusLabel: renderPackage.readinessLabel,
                detail: "package=\(renderPackage.readinessLabel) / run=\(renderPlan.readinessLabel)",
                nextAction: "Run render/package validation once the reviewed rough cut is approved.",
                nextCommand: renderReady ? swiftCommand("render-status", projectID) : (renderPlan.canRun ? swiftCommand("render-run", projectID) : swiftCommand("render-status", projectID)),
                isSatisfied: renderReady
            ),
            ProjectStudioGoalRequirement(
                id: "interview-to-mv-coverage",
                title: "インタビューからMVまでの代表カバレッジ",
                statusLabel: representativeCoverageReady ? "covered" : representativePlan.readinessLabel,
                detail: "\(representativePlan.candidateCoveredBucketCount)/\(representativePlan.targetBucketCount) representative buckets have Marlin candidate evidence / model access=\(marlinModelAccess.readinessLabel)",
                nextAction: representativeCoverageReady
                    ? representativePlan.nextAction
                    : (marlinModelAccess.isReadyForLiveMarlin ? representativePlan.nextAction : marlinModelAccess.recommendation),
                nextCommand: representativeCoverageReady
                    ? swiftCommand("marlin-preference-status")
                    : (marlinModelAccess.isReadyForLiveMarlin ? marlinEvaluationNextCommand() : swiftCommand("marlin-model-access-status")),
                isSatisfied: representativeCoverageReady
            )
        ]

        return ProjectStudioGoalStatus(projectURL: projectURL, requirements: requirements)
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

    private static func marlinDefaultCommand(repositoryRoot: URL) -> String {
        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: repositoryRoot)
        if queue.items.contains(where: { $0.canRunDefaultEvaluation && !$0.canPreferMarlin }) {
            return marlinEvaluationNextCommand()
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

    private static func swiftCommand(_ parts: String...) -> String {
        (["swift", "run", "videoos-studio-cli"] + parts).joined(separator: " ")
    }

    private static func marlinEvaluationNextCommand() -> String {
        (
            ["swift", "run", "videoos-studio-cli", "marlin-eval-next", "--execute"]
                + ProjectMarlinEvaluationCommandDefaults.boundedSkipExistingArgs
        ).joined(separator: " ")
    }
}
