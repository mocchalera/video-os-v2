import Foundation
import VideoOSStudioCore

@main
struct VideoOSStudioCLI {
    private static let defaultMarlinRequestTimeoutMs = 300_000

    static func main() async {
        let root = ProjectScanner.locateRepositoryRoot()
        let args = Array(CommandLine.arguments.dropFirst())
        let command = args.first ?? "doctor"

        switch command {
        case "doctor":
            runDoctor(root: root)
        case "projects", "list-projects":
            listProjects(root: root)
        case "project-init":
            initializeProject(root: root, args: Array(args.dropFirst()))
        case "codex-plan":
            printCodexPlan(root: root)
        case "policy-status":
            printPolicyStatus(root: root)
        case "library-status":
            printLibraryStatus(root: root, args: Array(args.dropFirst()))
        case "studio-goal-status":
            printStudioGoalStatus(root: root, args: Array(args.dropFirst()))
        case "native-editor-visual-qa-status":
            printNativeEditorVisualQAStatus(root: root)
        case "studio-status":
            printStudioStatus(root: root, args: Array(args.dropFirst()))
        case "studio-action", "studio-next-action":
            handleStudioAction(root: root, args: Array(args.dropFirst()))
        case "gate-status", "pipeline-status":
            printGateStatus(root: root, args: Array(args.dropFirst()))
        case "intent-status":
            printIntentStatus(root: root, args: Array(args.dropFirst()))
        case "intent-alignment":
            printIntentAlignment(root: root, args: Array(args.dropFirst()))
        case "review-status":
            printReviewStatus(root: root, args: Array(args.dropFirst()))
        case "planning-status":
            printPlanningStatus(root: root, args: Array(args.dropFirst()))
        case "analysis-plan":
            printAnalysisPlan(root: root, args: Array(args.dropFirst()))
        case "analysis-run":
            runAnalysis(root: root, args: Array(args.dropFirst()))
        case "compile-plan":
            printRoughCutCompilePlan(root: root, args: Array(args.dropFirst()))
        case "compile-run":
            runRoughCutCompile(root: root, args: Array(args.dropFirst()))
        case "request-sample":
            printRequestSample(root: root)
        case "agent-jobs", "write-contracts":
            printAgentJobs(root: root, args: Array(args.dropFirst()))
        case "agent-prompt":
            printAgentPrompt(root: root, args: Array(args.dropFirst()))
        case "annotations-status":
            printAnnotationsStatus(root: root, args: Array(args.dropFirst()))
        case "clip-note-add":
            addClipNote(root: root, args: Array(args.dropFirst()))
        case "clip-note-clear":
            clearClipNote(root: root, args: Array(args.dropFirst()))
        case "clip-note-prompt":
            printClipNotePrompt(root: root, args: Array(args.dropFirst()))
        case "index-rebuild":
            rebuildIndex(root: root, args: Array(args.dropFirst()))
        case "index-status":
            printIndexStatus(root: root, args: Array(args.dropFirst()))
        case "index-search":
            searchIndex(root: root, args: Array(args.dropFirst()))
        case "index-context":
            printIndexContext(root: root, args: Array(args.dropFirst()))
        case "media-status":
            printMediaStatus(root: root, args: Array(args.dropFirst()))
        case "media-source-map-status":
            printMediaSourceMapStatus(root: root, args: Array(args.dropFirst()))
        case "media-relink-plan":
            printMediaRelinkPlan(root: root, args: Array(args.dropFirst()))
        case "media-relink-apply":
            applyMediaRelink(root: root, args: Array(args.dropFirst()))
        case "media-synthetic-plan":
            printSyntheticMediaPlan(root: root, args: Array(args.dropFirst()))
        case "media-synthetic-build":
            buildSyntheticMedia(root: root, args: Array(args.dropFirst()))
        case "media-proxy-plan":
            printMediaProxyPlan(root: root, args: Array(args.dropFirst()))
        case "media-proxy-build":
            buildMediaProxies(root: root, args: Array(args.dropFirst()))
        case "monitor-status":
            printMonitorStatus(root: root, args: Array(args.dropFirst()))
        case "timeline-markers":
            printTimelineMarkers(root: root, args: Array(args.dropFirst()))
        case "audio-map":
            printAudioMap(root: root, args: Array(args.dropFirst()))
        case "audio-waveform":
            printAudioWaveform(root: root, args: Array(args.dropFirst()))
        case "interview-reframe":
            await analyzeInterviewReframe(root: root, args: Array(args.dropFirst()))
        case "audio-story-plan":
            printAudioStoryGraphPlan(root: root, args: Array(args.dropFirst()))
        case "audio-story-run":
            runAudioStoryGraph(root: root, args: Array(args.dropFirst()))
        case "marlin-status", "marlin-eval-status":
            printMarlinStatus(root: root, args: Array(args.dropFirst()))
        case "marlin-runtime-status":
            printMarlinRuntimeStatus(root: root)
        case "marlin-model-access-status":
            printMarlinModelAccessStatus(root: root)
        case "marlin-preference-status":
            printMarlinPreferenceStatus(root: root)
        case "marlin-preference-apply":
            applyMarlinPreference(root: root, args: Array(args.dropFirst()))
        case "marlin-representative-plan":
            printMarlinRepresentativePlan(root: root)
        case "marlin-eval-queue":
            printMarlinEvaluationQueue(root: root)
        case "marlin-eval-next":
            runNextMarlinEvaluation(root: root, args: Array(args.dropFirst()))
        case "marlin-eval-plan":
            printMarlinEvaluationPlan(root: root, args: Array(args.dropFirst()))
        case "marlin-materialize":
            materializeMarlinEvidence(root: root, args: Array(args.dropFirst()))
        case "marlin-eval-run":
            runMarlinEvaluation(root: root, args: Array(args.dropFirst()))
        case "playback-contract-status":
            printPlaybackContractStatus(root: root, args: Array(args.dropFirst()))
        case "render-status", "package-status":
            printRenderStatus(root: root, args: Array(args.dropFirst()))
        case "render-plan":
            printRenderPlan(root: root, args: Array(args.dropFirst()))
        case "render-run":
            runRender(root: root, args: Array(args.dropFirst()))
        case "handoff-status":
            printHandoffStatus(root: root, args: Array(args.dropFirst()))
        case "handoff-export-premiere":
            exportPremiereHandoff(root: root, args: Array(args.dropFirst()))
        case "handoff-packet-status":
            printHandoffPacketStatus(root: root, args: Array(args.dropFirst()))
        case "handoff-packet-verify":
            printHandoffPacketVerification(root: root, args: Array(args.dropFirst()))
        case "handoff-export-packet":
            exportHandoffPacket(root: root, args: Array(args.dropFirst()))
        case "handoff-synthetic-smoke":
            smokeSyntheticHandoff(root: root, args: Array(args.dropFirst()))
        case "studio-synthetic-smoke":
            smokeSyntheticStudio(root: root, args: Array(args.dropFirst()))
        case "studio-acceptance-smoke":
            smokeStudioAcceptance(root: root, args: Array(args.dropFirst()))
        case "app-server-smoke":
            smokeAppServer(root: root)
        case "thread-smoke":
            smokeThread(root: root)
        case "turn-smoke":
            smokeTurn(root: root)
        default:
            printUsage()
            Foundation.exit(2)
        }
    }

    private static func runDoctor(root: URL) {
        let projects = ProjectScanner.scanProjects(in: root)
        print("Video OS Studio")
        print("repo: \(root.path)")
        print("projects: \(projects.count)")
        print("codex app-server: \(CodexAppServerLaunchPlan(workspace: root).environmentDescription)")
    }

    private static func analyzeInterviewReframe(root: URL, args: [String]) async {
        do {
            guard let source = try valueOption(args, names: ["--source"], errorLabel: "--source") else {
                throw CLIError.message("usage: videoos-studio-cli interview-reframe --source=<video> [--in-us=<n>] [--out-us=<n>] [--width=1920] [--height=1080] [--samples=9]")
            }
            let sourceURL = resolvePathArgument(source, root: root)
            guard FileManager.default.fileExists(atPath: sourceURL.path) else {
                throw CLIError.message("source video not found: \(sourceURL.path)")
            }
            let proposal = try await InterviewAutoReframeAnalyzer.analyze(
                url: sourceURL,
                sourceInUS: intOption(args, name: "in-us"),
                sourceOutUS: intOption(args, name: "out-us"),
                outputWidth: intOption(args, name: "width") ?? 1_920,
                outputHeight: intOption(args, name: "height") ?? 1_080,
                sampleCount: intOption(args, name: "samples") ?? 9
            )
            let payload: [String: Any] = [
                "source": sourceURL.path,
                "zoom": proposal.zoom,
                "position": ["x": proposal.positionX, "y": proposal.positionY],
                "confidence": proposal.confidence,
                "analyzed_sample_count": proposal.analyzedSampleCount,
                "face_sample_count": proposal.faceSampleCount,
                "gesture_sample_count": proposal.gestureSampleCount,
                "reason": proposal.reason,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch {
            fputs("interview reframe failed: \(error.localizedDescription)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func listProjects(root: URL) {
        let projects = ProjectScanner.scanProjects(in: root)
        if projects.isEmpty {
            print("No projects found under \(root.appendingPathComponent("projects").path)")
            return
        }

        for project in projects {
            print("\(project.id)\tstate=\(project.stateLabel)\tmedia=\(project.mediaFileCount)\ttimeline=\(project.hasTimeline)")
        }
    }

    private static func initializeProject(root: URL, args: [String]) {
        guard let projectID = args.first, !projectID.hasPrefix("--") else {
            fputs("usage: videoos-studio-cli project-init <project-id> [--source-dir=<path>]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let sourceDirectory = sourceDirectoryArgument(args).map { resolvePathArgument($0, root: root) }
            let plan = try ProjectInitializer.plan(repositoryRoot: root, projectID: projectID, sourceDirectory: sourceDirectory)
            let result = try ProjectInitializer.run(plan: plan)
            print("ok: project initialized")
            print("project: \(result.projectURL.path)")
            print("sourceLink: \(result.sourceLinkURL?.path ?? "-")")
            print("nextStep: \(result.nextStepCommand ?? "-")")
            let trimmed = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                print(trimmed)
            }
        } catch {
            fputs("project init failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printCodexPlan(root: URL) {
        let plan = CodexAppServerLaunchPlan(workspace: root)
        print(([plan.executable] + plan.arguments).joined(separator: " "))
    }

    private static func printPolicyStatus(root: URL) {
        let status = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: root)
        print("repo: \(root.path)")
        print("status: \(status.readinessLabel)")
        print("policy: \(status.policyURL.path)")
        print("policyExists: \(status.policyExists)")
        print("policyReadable: \(status.policyReadable)")
        print("vlmModel: \(status.vlmModelAlias ?? "-")")
        print("vlmInputMode: \(status.vlmInputMode ?? "-")")
        print("vlmPromptTemplate: \(status.vlmPromptTemplateID ?? "-")")
        print("marlinEnabled: \(status.marlinEnabled.map(String.init) ?? "-")")
        print("marlinMode: \(status.marlinMode ?? "-")")
        print("marlinRole: \(status.marlinRole ?? "-")")
        print("marlinModel: \(status.marlinModelAlias ?? "-")")
        print("marlinConnector: \(status.marlinConnectorVersion ?? "-")")
        print("marlinWorker: \(status.marlinWorkerPath ?? "-")")
        print("marlinMock: \(status.marlinMock.map(String.init) ?? "-")")
        print("marlinOutput: \(status.marlinOutputArtifact ?? "-")")
        print("preferredVLMRule: \(status.preferredVLMRule)")
    }

    private static func printLibraryStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectLibraryReadinessStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("assets: \(status.assetCount)")
            print("segments: \(status.segmentCount)")
            print("transcriptDocuments: \(status.transcriptDocumentCount)")
            print("transcriptItems: \(status.transcriptItemCount)")
            print("mediaReady: \(status.mediaReady)")
            print("mediaReadyCount: \(status.mediaReadyCount)")
            print("mediaMissing: \(status.mediaMissingCount)")
            print("mediaProxyNeeded: \(status.mediaProxyNeededCount)")
            print("ragReady: \(status.ragReady)")
            print("index: \(status.indexURL.path)")
            print("indexExists: \(status.indexExists)")
            print("indexDocuments: \(status.indexDocumentCount)")
            print("indexUpdatedAt: \(status.indexUpdatedAt ?? "-")")
            print("marlinReady: \(status.marlinReady)")
            print("marlinEvents: \(status.marlinEventCount)")
            print("marlinFindResults: \(status.marlinFindResultCount)")
            print("audioReady: \(status.audioReady)")
            print("audioEvents: \(status.audioEventCount)")
            print("audioStoryNodes: \(status.audioStoryNodeCount)")
            print("bgmSections: \(status.bgmSectionCount)")
            print("bgmBeats: \(status.bgmBeatCount)")
            print("timeline: \(status.timelineExists)")
            print("handoffAnnotations: \(status.handoffAnnotationsExist)")
            print("recommendation: \(status.recommendation)")
        } catch {
            fputs("library status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printStudioStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("score: \(status.scoreLabel)")
            print("pipeline: \(status.pipelineLabel)")
            print("library: \(status.libraryLabel)")
            print("marlin: \(status.marlinLabel)")
            print("marlinDefaultGate: \(status.marlinDefaultLabel)")
            print("marlinDefaultEvidence: \(status.marlinDefaultDetail)")
            print("marlinDefaultNextAction: \(status.marlinDefaultNextAction)")
            print("handoff: \(status.handoffLabel)")
            print("render: \(status.renderLabel)")
            print("nextAction: \(status.nextAction)")
            print("nextCommand: \(status.nextCommand ?? "-")")
            for capability in status.capabilities {
                print("capability.\(capability.id): \(capability.isReady ? "ready" : "not-ready") | \(capability.readinessLabel) | \(capability.detail)")
                if let command = capability.nextCommand {
                    print("  command: \(command)")
                }
            }
            for action in status.actionQueue {
                print("action.\(action.id): \(action.isBlocking ? "blocking" : "advisory") | \(action.title) | \(action.action)")
                if let command = action.command {
                    print("  command: \(command)")
                }
            }
        } catch {
            fputs("studio status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printStudioGoalStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectStudioGoalStatusReader.status(repositoryRoot: root, projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("score: \(status.scoreLabel)")
            print("nextAction: \(status.nextAction)")
            print("nextCommand: \(status.nextCommand ?? "-")")
            for requirement in status.requirements {
                print("requirement.\(requirement.id): \(requirement.isSatisfied ? "satisfied" : "not-satisfied") | \(requirement.statusLabel) | \(requirement.title)")
                print("  detail: \(requirement.detail)")
                print("  nextAction: \(requirement.nextAction)")
                if let command = requirement.nextCommand {
                    print("  command: \(command)")
                }
            }
        } catch {
            fputs("studio goal status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printNativeEditorVisualQAStatus(root: URL) {
        let status = ProjectNativeEditorVisualQAStatusReader.status(repositoryRoot: root)
        print("status: \(status.readinessLabel)")
        print("passed: \(status.isPassed)")
        print("report: \(status.reportURL.path)")
        print("screenshot: \(status.screenshotPath ?? "-")")
        print("screenshotExists: \(status.screenshotExists)")
        print("project: \(status.projectID ?? "-")")
        print("capturedAt: \(status.capturedAt ?? "-")")
        print("passedSurfaces: \(status.passedSurfaceIDs.joined(separator: ","))")
        print("missingSurfaces: \(status.missingSurfaceIDs.joined(separator: ","))")
        print("failedSurfaces: \(status.failedSurfaceIDs.joined(separator: ","))")
        print("recommendation: \(status.recommendation)")
        if !status.isPassed {
            Foundation.exit(1)
        }
    }

    private static func handleStudioAction(root: URL, args: [String]) {
        let execute = args.contains("--execute")
        let runCodex = args.contains("--run-codex")
        let approveCodexWrite = args.contains("--approve-codex-write")
        let timeout = intOption(args, name: "timeout") ?? 300
        let contextQuery = stringOption("--context-query", args: args)
        let contextLimit = intOption(args, name: "context-limit") ?? 8
        let nonOptions = args.filter { !$0.hasPrefix("--") }
        guard let projectArgument = nonOptions.first else {
            fputs("usage: videoos-studio-cli studio-action <project-id-or-path> [action-id|--id=<id>] [--execute] [--run-codex] [--approve-codex-write] [--timeout=<sec>] [--context-query=<query>] [--context-limit=<n>]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [projectArgument])
            let requestedActionID = stringOption("--id", args: args) ?? nonOptions.dropFirst().first
            let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project.path)
            guard let action = selectStudioAction(status: status, requestedActionID: requestedActionID) else {
                if let requestedActionID {
                    throw CLIError.message("studio action not found: \(requestedActionID)")
                }
                throw CLIError.message("studio action queue is empty")
            }

            print("project: \(project.id)")
            print("action: \(action.id)")
            print("title: \(action.title)")
            print("kind: \(action.isBlocking ? "blocking" : "advisory")")
            print("execution: \(studioActionExecutionMode(action))")
            print("nextAction: \(action.action)")
            print("command: \(action.command ?? "-")")
            if action.command?.contains("agent-prompt") == true {
                print("codexRun: \(runCodex)")
                print("codexWriteApproved: \(approveCodexWrite)")
                print("contextQuery: \(contextQuery ?? "-")")
                print("contextLimit: \(contextLimit)")
            }

            guard execute else {
                print("execute: false")
                print("hint: add --execute to run native actions or print Codex approval prompts. Add --run-codex to execute Codex turns after review.")
                return
            }

            print("execute: true")
            try executeStudioAction(
                root: root,
                project: project,
                action: action,
                runCodex: runCodex,
                approveCodexWrite: approveCodexWrite,
                timeout: TimeInterval(timeout),
                contextQuery: contextQuery,
                contextLimit: contextLimit
            )
        } catch {
            fputs("studio action failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func selectStudioAction(
        status: ProjectStudioReadinessStatus,
        requestedActionID: String?
    ) -> ProjectStudioReadinessAction? {
        guard let requestedActionID, requestedActionID != "first" else {
            return status.actionQueue.first
        }
        return status.actionQueue.first { $0.id == requestedActionID }
    }

    private static func studioActionExecutionMode(_ action: ProjectStudioReadinessAction) -> String {
        guard let command = action.command else { return "manual-input" }
        if command.contains("agent-prompt") { return "codex-approval-required" }
        if command.contains("media-relink-plan") { return "needs-search-root" }
        if command.contains("status") || command.contains("marlin-representative-plan") { return "read-only-status" }
        return "native-runner"
    }

    private static func executeStudioAction(
        root: URL,
        project: ProjectSummary,
        action: ProjectStudioReadinessAction,
        runCodex: Bool = false,
        approveCodexWrite: Bool = false,
        timeout: TimeInterval = 300,
        contextQuery: String? = nil,
        contextLimit: Int = 8
    ) throws {
        guard let command = action.command else {
            throw CLIError.message("\(action.id) has no executable command")
        }

        if command.contains("app-server-smoke") {
            smokeAppServer(root: root)
        } else if command.contains("analysis-run") {
            runAnalysis(root: root, args: [project.id])
        } else if command.contains("index-rebuild") {
            rebuildIndex(root: root, args: [project.id])
        } else if command.contains("media-relink-plan") {
            throw CLIError.message("media relink requires one or more search roots. Run: videoos-studio-cli media-relink-plan \(project.id) <search-root>")
        } else if command.contains("media-proxy-build") {
            buildMediaProxies(root: root, args: [project.id])
        } else if command.contains("audio-story-run") {
            runAudioStoryGraph(root: root, args: [project.id])
        } else if command.contains("marlin-materialize") {
            materializeMarlinEvidence(root: root, args: [project.id])
        } else if command.contains("marlin-eval-run") {
            runMarlinEvaluation(root: root, args: [project.id])
        } else if command.contains("marlin-eval-next") {
            let args = command.contains("--mock") ? ["--execute", "--mock"] : ["--execute"]
            runNextMarlinEvaluation(root: root, args: args)
        } else if command.contains("marlin-representative-plan") {
            printMarlinRepresentativePlan(root: root)
        } else if command.contains("agent-prompt") {
            if runCodex {
                try runCodexStudioAction(
                    root: root,
                    project: project,
                    command: command,
                    approveCodexWrite: approveCodexWrite,
                    timeout: timeout,
                    contextQuery: contextQuery,
                    contextLimit: contextLimit
                )
            } else {
                try printCodexApprovalPrompt(
                    root: root,
                    project: project,
                    command: command,
                    contextQuery: contextQuery,
                    contextLimit: contextLimit
                )
            }
        } else if command.contains("compile-run") {
            runRoughCutCompile(root: root, args: command.contains("--review-patch") ? [project.id, "--review-patch"] : [project.id])
        } else if command.contains("handoff-export-packet") {
            exportHandoffPacket(root: root, args: [project.id])
        } else if command.contains("handoff-packet-status") {
            printHandoffPacketStatus(root: root, args: [project.id])
        } else if command.contains("render-run") {
            runRender(root: root, args: [project.id])
        } else if command.contains("render-status") {
            printRenderStatus(root: root, args: [project.id])
        } else if command.contains("gate-status") {
            printGateStatus(root: root, args: [project.id])
        } else if command.contains("library-status") {
            printLibraryStatus(root: root, args: [project.id])
        } else {
            throw CLIError.message("no CLI executor is wired for: \(command)")
        }
    }

    private static func printCodexApprovalPrompt(
        root: URL,
        project: ProjectSummary,
        command: String,
        contextQuery: String?,
        contextLimit: Int
    ) throws {
        guard let job = agentJob(fromReadinessCommand: command) else {
            print("approvalRequired: true")
            print("prompt: unavailable")
            print("reason: no agent job could be parsed from \(command)")
            return
        }
        let ragContext = try buildRAGContext(project: project, query: contextQuery, limit: contextLimit)
        print("approvalRequired: \(job.requiresOperatorApproval)")
        print("job: \(job.rawValue)")
        print("sandbox: \(job.sandboxLabel)")
        print("writeScopes: \(job.plannedWriteScopes.joined(separator: ", "))")
        printRAGContextSummary(ragContext)
        print("prompt:")
        print(job.prompt(project: project, repositoryRoot: root, ragContext: ragContext))
    }

    private static func runCodexStudioAction(
        root: URL,
        project: ProjectSummary,
        command: String,
        approveCodexWrite: Bool,
        timeout: TimeInterval,
        contextQuery: String?,
        contextLimit: Int
    ) throws {
        guard let job = agentJob(fromReadinessCommand: command) else {
            throw CLIError.message("no Codex job could be parsed from \(command)")
        }
        let ragContext = try buildRAGContext(project: project, query: contextQuery, limit: contextLimit)
        print("approvalRequired: \(job.requiresOperatorApproval)")
        print("job: \(job.rawValue)")
        print("sandbox: \(job.sandboxLabel)")
        print("writeScopes: \(job.plannedWriteScopes.joined(separator: ", "))")
        printRAGContextSummary(ragContext)
        guard !job.requiresOperatorApproval || approveCodexWrite else {
            print("prompt:")
            print(job.prompt(project: project, repositoryRoot: root, ragContext: ragContext))
            throw CLIError.message("Codex write job requires --approve-codex-write after reviewing the prompt and write scopes.")
        }

        let session = CodexAppServerSession(workspace: root)
        do {
            let beforeSnapshot = try ProjectArtifactSnapshot.capture(projectURL: project.path)
            try session.start()
            _ = try session.initialize(timeout: 15)
            let thread = try session.startThread(ephemeral: false, timeout: 20)
            print("threadId: \(thread.thread.id)")
            print("model: \(thread.model)")
            let summary = try session.runTurnAndWait(
                threadID: thread.thread.id,
                text: job.prompt(project: project, repositoryRoot: root, ragContext: ragContext),
                readOnly: job.readOnly,
                timeout: timeout
            )
            print("turnId: \(summary.turnId)")
            print("turnStatus: \(summary.status)")
            print("durationMs: \(summary.durationMs.map(String.init) ?? "-")")
            print("events: \(summary.eventMethods.joined(separator: ","))")
            print("assistant:")
            print(summary.assistantText.isEmpty ? "-" : summary.assistantText)
            let afterSnapshot = try ProjectArtifactSnapshot.capture(projectURL: project.path)
            let diffs = beforeSnapshot.diff(to: afterSnapshot)
            let violations = job.writeContract(projectID: project.id).violations(for: diffs)
            print("artifactDiffs: \(diffs.count)")
            for diff in diffs.prefix(12) {
                print("artifactDiff.\(diff.kind.rawValue): \(diff.relativePath) bytes=\(diff.byteDelta)")
            }
            if diffs.count > 12 {
                print("artifactDiff.more: \(diffs.count - 12)")
            }
            print("writeViolations: \(violations.count)")
            for violation in violations {
                print("writeViolation.\(violation.kind.rawValue): \(violation.relativePath) | \(violation.reason)")
            }
            session.stop()
            if summary.status != "completed" {
                Foundation.exit(1)
            }
            if !violations.isEmpty {
                Foundation.exit(1)
            }
        } catch {
            let diagnostics = session.process.recentDiagnostics()
            session.stop()
            if !diagnostics.isEmpty {
                fputs(diagnostics.joined(separator: "\n") + "\n", stderr)
            }
            throw error
        }
    }

    private static func buildRAGContext(
        project: ProjectSummary,
        query: String?,
        limit: Int
    ) throws -> ProjectRAGContextPack? {
        try query.map {
            try ProjectRAGContextPack.build(projectURL: project.path, query: $0, limit: limit)
        }
    }

    private static func printRAGContextSummary(_ ragContext: ProjectRAGContextPack?) {
        guard let ragContext else { return }
        print("contextQuery: \(ragContext.query)")
        print("contextItems: \(ragContext.items.count)")
    }

    private static func agentJob(fromReadinessCommand command: String) -> VideoOSAgentJob? {
        let parts = command.split(separator: " ").map(String.init)
        return VideoOSAgentJob.allCases.first { parts.contains($0.rawValue) }
    }

    private static func printGateStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectPipelineGateStatusReader.status(repositoryRoot: root, projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("stateFile: \(status.stateFileExists)")
            print("currentState: \(status.currentState ?? "-")")
            print("lastUpdated: \(status.lastUpdated ?? "-")")
            print("timeline: \(status.hasTimeline)")
            print("review: \(status.hasReview)")
            print("reviewStatus: \(status.reviewStatus ?? "-")")
            print("reviewPatchOperations: \(status.reviewPatchOperationCount)")
            print("renderCanRun: \(status.renderCanRun)")
            print("renderReadiness: \(status.renderReadinessLabel)")
            if !status.gateSummaryLabel.isEmpty {
                print("gates: \(status.gateSummaryLabel)")
            }
            print("nextAction: \(status.nextAction)")
        } catch {
            fputs("gate status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printIntentStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let summary = ProjectIntentSummaryReader.summary(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(summary.readinessLabel)")
            print("briefExists: \(summary.briefExists)")
            print("blockersExists: \(summary.blockersExists)")
            print("title: \(summary.displayTitle)")
            print("strategy: \(summary.strategy ?? "-")")
            print("format: \(summary.format ?? "-")")
            print("runtimeTargetSec: \(summary.runtimeTargetSeconds ?? "-")")
            print("primaryMessage: \(summary.primaryMessage ?? "-")")
            print("primaryAudience: \(summary.primaryAudience ?? "-")")
            print("emotionCurve: \(summary.emotionCurve.joined(separator: " > "))")
            print("mustHave: \(summary.mustHave.joined(separator: ", "))")
            print("mustAvoid: \(summary.mustAvoid.joined(separator: ", "))")
            print("autonomy: \(summary.autonomyLabel)")
            print("mayDecide: \(summary.mayDecideCount)")
            print("mustAsk: \(summary.mustAsk.joined(separator: ", "))")
            print("blockers: \(summary.blockerCount)")
            print("softBlockers: \(summary.softBlockerCount)")
            for question in summary.openBlockerQuestions {
                print("openBlocker: \(question)")
            }
            print("recommendation: \(summary.recommendation)")
        } catch {
            fputs("intent status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printIntentAlignment(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectIntentAlignmentStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("hasBrief: \(status.hasBrief)")
            print("hasTimeline: \(status.hasTimeline)")
            print("hasReview: \(status.hasReview)")
            print("reviewStatus: \(status.reviewStatus ?? "-")")
            print("coverage: \(status.coverageLabel)")
            print("briefMismatches: \(status.briefMismatchCount)")
            print("mustHaveCovered: \(status.mustHaveCovered.joined(separator: ", "))")
            print("mustHaveMissing: \(status.mustHaveMissing.joined(separator: ", "))")
            print("mustAvoidAcknowledged: \(status.mustAvoidAcknowledged.joined(separator: ", "))")
            print("recommendation: \(status.recommendation)")
        } catch {
            fputs("intent alignment failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printReviewStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectReviewArtifactStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("hasTimeline: \(status.hasTimeline)")
            print("reportExists: \(status.reportExists)")
            print("reportReadable: \(status.reportReadable)")
            print("patchExists: \(status.patchExists)")
            print("patchReadable: \(status.patchReadable)")
            print("judgment: \(status.judgmentStatus ?? "-")")
            print("confidence: \(status.confidence ?? "-")")
            print("issues: \(status.issueLabel)")
            print("mismatches: \(status.mismatchLabel)")
            print("patch: \(status.patchLabel)")
            print("recommendedGoal: \(status.recommendedGoal ?? "-")")
            if !status.recommendedActions.isEmpty {
                print("recommendedActions: \(status.recommendedActions.joined(separator: " | "))")
            }
            print("previewPath: \(status.previewPath ?? "-")")
            print("recommendation: \(status.recommendation)")
        } catch {
            fputs("review status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printPlanningStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectPlanningStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("creativeBrief: \(status.hasCreativeBrief)")
            print("unresolvedBlockers: \(status.hasUnresolvedBlockers)")
            print("analysisReady: \(status.analysisReady)")
            print("assets: \(status.assetCount)")
            print("segments: \(status.segmentCount)")
            print("dialogueEvidenceRequired: \(status.dialogueEvidenceRequired)")
            print("dialogueEvidence: \(status.dialogueEvidenceLabel)")
            print("transcriptDocuments: \(status.transcriptDocumentCount)")
            print("transcriptItems: \(status.transcriptItemCount)")
            print("audioEvidence: \(status.audioEvidenceCount)")
            print("selects: \(status.hasSelects)")
            print("blueprint: \(status.hasBlueprint)")
            print("blueprintFreshness: \(status.blueprintFreshnessLabel)")
            print("blueprintStaleReason: \(status.blueprintStaleReason ?? "-")")
            print("uncertaintyRegister: \(status.hasUncertaintyRegister)")
            print("nextAgentJob: \(status.nextAgentJob?.rawValue ?? "-")")
            print("recommendation: \(status.recommendation)")
        } catch {
            fputs("planning status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printAnalysisPlan(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: project.path, options: analysisOptions(args))
            print("project: \(project.id)")
            print("status: \(plan.readinessLabel)")
            print("canRun: \(plan.canRun)")
            print("sourceDirectory: \(plan.sourceDirectory.path)")
            print("sources: \(plan.sourceCount)")
            print("skipped: \(plan.skippedSourceCount)")
            print("script: \(plan.scriptURL.path)")
            print("command: \(plan.commandLine)")
            for url in plan.sourceURLs {
                print("source: \(url.path)")
            }
        } catch {
            fputs("analysis plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func runAnalysis(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let rebuildIndex = !args.contains("--no-index")
            let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: project.path, options: analysisOptions(args))
            let result = try ProjectAnalysisRunner.run(plan: plan, rebuildIndex: rebuildIndex)
            print("ok: analysis \(result.succeeded ? "completed" : "failed")")
            print("project: \(project.id)")
            print("sources: \(plan.sourceCount)")
            print("exitCode: \(result.exitCode)")
            print("indexRebuilt: \(result.indexSummary != nil)")
            if let indexSummary = result.indexSummary {
                print("indexDocuments: \(indexSummary.searchDocumentCount)")
                print("assets: \(indexSummary.assetCount)")
                print("segments: \(indexSummary.segmentCount)")
            }
            let trimmedStdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedStdout.isEmpty {
                print(trimmedStdout)
            }
            let trimmedStderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedStderr.isEmpty {
                fputs(trimmedStderr + "\n", stderr)
            }
            if !result.succeeded {
                Foundation.exit(Int32(result.exitCode))
            }
        } catch {
            fputs("analysis run failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printRoughCutCompilePlan(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: root, projectURL: project.path, options: roughCutCompileOptions(root: root, projectURL: project.path, args: args))
            print("project: \(project.id)")
            print("status: \(plan.readinessLabel)")
            print("canRun: \(plan.canRun)")
            print("creativeBrief: \(plan.hasCreativeBrief)")
            print("selects: \(plan.hasSelects)")
            print("blueprint: \(plan.hasBlueprint)")
            print("patch: \(plan.options.patchURL?.path ?? "-")")
            print("timeline: \(plan.timelineURL.path)")
            print("sourceMap: \(plan.resolvedSourceMapURL?.path ?? "-")")
            print("script: \(plan.scriptURL.path)")
            print("command: \(plan.commandLine)")
        } catch {
            fputs("compile plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func runRoughCutCompile(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let rebuildIndex = !args.contains("--no-index")
            let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: root, projectURL: project.path, options: roughCutCompileOptions(root: root, projectURL: project.path, args: args))
            let result = try ProjectRoughCutCompileRunner.run(plan: plan, rebuildIndex: rebuildIndex)
            print("ok: compile \(result.succeeded ? "completed" : "failed")")
            print("project: \(project.id)")
            print("exitCode: \(result.exitCode)")
            print("patchApplied: \(plan.options.patchURL?.path ?? "-")")
            print("timelineExists: \(result.timelineExists)")
            print("indexRebuilt: \(result.indexSummary != nil)")
            if let indexSummary = result.indexSummary {
                print("indexDocuments: \(indexSummary.searchDocumentCount)")
                print("assets: \(indexSummary.assetCount)")
                print("segments: \(indexSummary.segmentCount)")
            }
            let trimmedStdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedStdout.isEmpty {
                print(trimmedStdout)
            }
            let trimmedStderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedStderr.isEmpty {
                fputs(trimmedStderr + "\n", stderr)
            }
            if !result.succeeded {
                Foundation.exit(Int32(result.exitCode == 0 ? 1 : result.exitCode))
            }
        } catch {
            fputs("compile run failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printRequestSample(root: URL) {
        let factory = CodexAppServerRequestFactory(workspace: root)
        do {
            print(try CodexJSONEncoding.encodeLine(factory.initializeRequest()).trimmingCharacters(in: .newlines))
            print(try CodexJSONEncoding.encodeLine(factory.threadStartRequest(id: 2)).trimmingCharacters(in: .newlines))
            print(try CodexJSONEncoding.encodeLine(factory.turnStartRequest(id: 3, threadID: "THREAD_ID", text: "Run /status for the selected Video OS project.")).trimmingCharacters(in: .newlines))
            print(try CodexJSONEncoding.encodeLine(factory.threadReadRequest(id: 4, threadID: "THREAD_ID")).trimmingCharacters(in: .newlines))
        } catch {
            fputs("failed to encode request sample: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printAgentJobs(root: URL, args: [String]) {
        let resolvedProject: ProjectSummary?
        if let projectArg = args.first, projectArg != "<id>" {
            resolvedProject = try? resolveProject(root: root, args: [projectArg])
        } else {
            resolvedProject = nil
        }
        let planningStatus = resolvedProject.map { ProjectPlanningStatusReader.status(projectURL: $0.path) }
        let projectID = resolvedProject?.id ?? args.first ?? "<id>"
        print("project: \(projectID)")
        print("workspace: \(root.path)")
        for job in VideoOSAgentJob.allCases {
            let contract = job.writeContract(projectID: projectID)
            let readiness = resolvedProject.map {
                VideoOSAgentJobReadinessResolver.readiness(
                    for: job,
                    hasActiveThread: true,
                    project: $0,
                    planningStatus: planningStatus,
                    selectedTimelineClipAvailable: false
                )
            }
            print("")
            print("\(job.rawValue): \(job.title)")
            print("  mode: \(contract.modeLabel)")
            print("  sandbox: \(job.sandboxLabel)")
            print("  approvalRequired: \(contract.requiresOperatorApproval)")
            if let readiness {
                print("  readiness: \(readiness.canRun ? "ready" : "blocked")")
                print("  readinessLabel: \(readiness.label)")
            } else {
                print("  readiness: unknown")
                print("  readinessLabel: pass a project id or path to evaluate readiness")
            }
            print("  entrypoint: \(contract.entrypoint)")
            print("  commandContract: \(contract.commandContract ?? "-")")
            print("  allowedWrites:")
            if contract.allowedArtifactRoots.isEmpty {
                print("    - none")
            } else {
                for scope in contract.allowedArtifactRoots {
                    print("    - \(scope)")
                }
            }
            print("  expectedArtifacts:")
            if contract.expectedArtifacts.isEmpty {
                print("    - none")
            } else {
                for artifact in contract.expectedArtifacts {
                    print("    - \(artifact)")
                }
            }
            print("  forbiddenWrites:")
            for forbidden in contract.forbiddenWrites {
                print("    - \(forbidden)")
            }
        }
    }

    private static func printAgentPrompt(root: URL, args: [String]) {
        let nonOptions = args.filter { !$0.hasPrefix("--") }
        guard nonOptions.count >= 2 else {
            fputs("usage: videoos-studio-cli agent-prompt <project-id-or-path> <job> [--context-query=<query>] [--context-limit=<n>]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [nonOptions[0]])
            guard let job = VideoOSAgentJob(rawValue: nonOptions[1]) else {
                let jobs = VideoOSAgentJob.allCases.map(\.rawValue).joined(separator: ", ")
                throw CLIError.message("unknown agent job: \(nonOptions[1]). Expected one of: \(jobs)")
            }
            let contextQuery = stringOption("--context-query", args: args)
            let contextLimit = intOption(args, name: "context-limit") ?? 8
            let ragContext = try contextQuery.map {
                try ProjectRAGContextPack.build(projectURL: project.path, query: $0, limit: contextLimit)
            }
            print(job.prompt(project: project, repositoryRoot: root, ragContext: ragContext))
        } catch {
            fputs("agent prompt failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printAnnotationsStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let timeline = try? TimelineDocument.load(projectURL: project.path)
            let summary = ProjectEditorAnnotationStore.summary(projectURL: project.path, timeline: timeline)
            let document = ProjectEditorAnnotationStore.load(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(summary.statusLabel)")
            print("path: \(summary.url.path)")
            print("exists: \(summary.exists)")
            print("notes: \(summary.noteCount)")
            print("unresolved: \(summary.unresolvedClipIDs.count)")
            for note in document?.notes ?? [] {
                print("\(note.clipID)\t\(note.trackID)\t\(note.timecodeIn)-\(note.timecodeOut)\t\(note.handoffInstruction)")
            }
            for clipID in summary.unresolvedClipIDs {
                print("unresolved\t\(clipID)")
            }
        } catch {
            fputs("annotations status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func addClipNote(root: URL, args: [String]) {
        guard args.count >= 3 else {
            fputs("usage: videoos-studio-cli clip-note-add <project-id-or-path> <clip-id> <note>\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [args[0]])
            let clipID = args[1]
            let note = args.dropFirst(2).joined(separator: " ")
            let document = try ProjectEditorAnnotationStore.upsertNote(projectURL: project.path, clipID: clipID, note: note)
            let saved = document.note(for: clipID)
            print("ok: clip note saved")
            print("project: \(project.id)")
            print("clip: \(clipID)")
            print("path: \(ProjectEditorAnnotationStore.annotationsURL(for: project.path).path)")
            if let saved {
                print("timecode: \(saved.timecodeIn)-\(saved.timecodeOut)")
                print("handoff: \(saved.handoffInstruction)")
            }
        } catch {
            fputs("clip note add failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func clearClipNote(root: URL, args: [String]) {
        guard args.count >= 2 else {
            fputs("usage: videoos-studio-cli clip-note-clear <project-id-or-path> <clip-id>\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [args[0]])
            let clipID = args[1]
            let document = try ProjectEditorAnnotationStore.removeNote(projectURL: project.path, clipID: clipID)
            print("ok: clip note cleared")
            print("project: \(project.id)")
            print("clip: \(clipID)")
            print("notes: \(document.notes.count)")
            print("path: \(ProjectEditorAnnotationStore.annotationsURL(for: project.path).path)")
        } catch {
            fputs("clip note clear failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printClipNotePrompt(root: URL, args: [String]) {
        guard args.count >= 2 else {
            fputs("usage: videoos-studio-cli clip-note-prompt <project-id-or-path> <clip-id>\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [args[0]])
            let timeline = try TimelineDocument.load(projectURL: project.path)
            guard let selection = timeline.clipSelection(for: args[1]) else {
                throw ProjectEditorAnnotationError.clipNotFound(args[1])
            }
            let evidenceStore = ProjectEvidenceStore.load(projectURL: project.path)
            let prompt = ProjectEditorAnnotationProposalPrompt.make(
                project: project,
                selection: selection,
                timeline: timeline,
                evidence: evidenceStore.evidence(for: selection.clip),
                existingNote: ProjectEditorAnnotationStore.load(projectURL: project.path)?.note(for: selection.clip.id)
            )
            print(prompt)
        } catch {
            fputs("clip note prompt failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func rebuildIndex(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let summary = try ProjectSQLiteIndex.rebuild(projectURL: project.path)
            print("ok: index rebuilt")
            print("project: \(project.id)")
            print("index: \(summary.indexURL.path)")
            print("assets: \(summary.assetCount)")
            print("segments: \(summary.segmentCount)")
            print("transcriptItems: \(summary.transcriptItemCount)")
            print("marlinEvents: \(summary.marlinEventCount)")
            print("marlinFindResults: \(summary.marlinFindResultCount)")
            print("audioEvents: \(summary.audioEventCount)")
            print("audioStoryNodes: \(summary.audioStoryNodeCount)")
            print("bgmSections: \(summary.bgmSectionCount)")
            print("bgmBeats: \(summary.bgmBeatCount)")
            print("continuityEntities: \(summary.continuityEntityCount)")
            print("continuitySegmentRefs: \(summary.continuitySegmentRefCount)")
            print("editorialPreferences: \(summary.editorialPreferenceCount)")
            print("searchDocuments: \(summary.searchDocumentCount)")
        } catch {
            fputs("index rebuild failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printIndexStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectSQLiteIndex.status(projectURL: project.path)
            print("project: \(project.id)")
            print("index: \(status.indexURL.path)")
            print("exists: \(status.exists)")
            print("searchDocuments: \(status.documentCount)")
            print("updatedAt: \(status.updatedAt ?? "-")")
        } catch {
            fputs("index status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func searchIndex(root: URL, args: [String]) {
        guard args.count >= 2 else {
            fputs("usage: videoos-studio-cli index-search <project-id-or-path> <query>\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [args[0]])
            let query = args.dropFirst().joined(separator: " ")
            let results = try ProjectSQLiteIndex.search(projectURL: project.path, query: query)
            print("project: \(project.id)")
            print("query: \(query)")
            print("results: \(results.count)")
            for result in results {
                let ref = [result.assetID, result.segmentID].compactMap { $0 }.joined(separator: "/")
                print("\(result.kind)\t\(ref.isEmpty ? "-" : ref)\t\(result.title)")
            }
        } catch {
            fputs("index search failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printIndexContext(root: URL, args: [String]) {
        let nonOptions = args.filter { !$0.hasPrefix("--") }
        guard nonOptions.count >= 2 else {
            fputs("usage: videoos-studio-cli index-context <project-id-or-path> <query> [--limit=<n>]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [nonOptions[0]])
            let query = nonOptions.dropFirst().joined(separator: " ")
            let limit = intOption(args, name: "limit") ?? 8
            let pack = try ProjectRAGContextPack.build(projectURL: project.path, query: query, limit: limit)
            print("project: \(project.id)")
            print("query: \(pack.query)")
            print("items: \(pack.items.count)")
            print(pack.promptText)
        } catch {
            fputs("index context failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMediaStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let summary = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: nil)
            print("project: \(project.id)")
            print("assets: \(summary.items.count)")
            print("ready: \(summary.readyCount)")
            print("missing: \(summary.missingCount)")
            print("proxyNeeded: \(summary.proxyNeededCount)")
            for item in summary.items {
                print("\(item.assetID)\t\(item.playbackStatus.rawValue)\t\(item.resolvedFrom)\t\(item.filename)\t\(item.url?.path ?? "-")")
            }
        } catch {
            fputs("media status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMediaSourceMapStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectMediaSourceMapStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("sourceMap: \(status.sourceMapURL.path)")
            print("exists: \(status.exists)")
            print("generatedAt: \(status.generatedAt ?? "-")")
            print("assets: \(status.assetCount)")
            print("entries: \(status.entryCount)")
            print("coverage: \(status.coverageLabel)")
            print("readyAssets: \(status.readyAssetCount)")
            print("missingEntries: \(status.missingAssetIDs.count)")
            print("brokenEntries: \(status.brokenEntries.count)")
            print("relinkedSymlinks: \(status.relinkedSymlinkCount)")
            print("absoluteLocalPaths: \(status.absoluteLocalPathCount)")
            print("recommendation: \(status.recommendation)")
            let suggestedRoots = ProjectMediaRelinker.suggestedSearchRoots(projectURL: project.path)
            if !suggestedRoots.isEmpty {
                print("suggestedSearchRoots: \(suggestedRoots.count)")
                for root in suggestedRoots.prefix(8) {
                    print("searchRoot\t\(root.exists ? "exists" : "missing")\t\(root.referencedAssetCount)\t\(root.url.path)")
                }
            }
            for assetID in status.missingAssetIDs {
                print("missing\t\(assetID)")
            }
            for entry in status.brokenEntries {
                print("broken\t\(entry.assetID)\t\(entry.filename ?? "-")\t\(entry.checkedPaths.joined(separator: ","))")
            }
        } catch {
            fputs("media source map status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMediaRelinkPlan(root: URL, args: [String]) {
        guard let projectArg = args.first else {
            fputs("usage: videoos-studio-cli media-relink-plan <project-id-or-path> [<search-root> ...|--from-source-map] [--include-synthetic]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [projectArg])
            let searchRoots = mediaRelinkSearchRoots(root: root, projectURL: project.path, args: Array(args.dropFirst()))
            let includeSynthetic = args.contains("--include-synthetic")
            guard !searchRoots.isEmpty else {
                throw CLIError.message("media relink plan requires one or more search roots, or --from-source-map with absolute paths in source_map.json")
            }
            let plan = ProjectMediaRelinker.plan(
                projectURL: project.path,
                searchRoots: searchRoots,
                includeSynthetic: includeSynthetic
            )
            printMediaRelinkPlan(project: project, plan: plan)
        } catch {
            fputs("media relink plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func applyMediaRelink(root: URL, args: [String]) {
        guard let projectArg = args.first else {
            fputs("usage: videoos-studio-cli media-relink-apply <project-id-or-path> [<search-root> ...|--from-source-map] [--include-synthetic]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [projectArg])
            let searchRoots = mediaRelinkSearchRoots(root: root, projectURL: project.path, args: Array(args.dropFirst()))
            let includeSynthetic = args.contains("--include-synthetic")
            guard !searchRoots.isEmpty else {
                throw CLIError.message("media relink apply requires one or more search roots, or --from-source-map with absolute paths in source_map.json")
            }
            let plan = ProjectMediaRelinker.plan(
                projectURL: project.path,
                searchRoots: searchRoots,
                includeSynthetic: includeSynthetic
            )
            printMediaRelinkPlan(project: project, plan: plan)
            let result = try ProjectMediaRelinker.apply(plan: plan)
            let summary = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: nil)
            print("ok: media relinked")
            print("sourceMap: \(result.sourceMapURL.path)")
            print("linked: \(result.linkedCount)")
            print("skipped: \(result.skippedCount)")
            print("ready: \(summary.readyCount)")
            print("missing: \(summary.missingCount)")
            for url in result.symlinkURLs {
                print("symlink: \(url.path)")
            }
        } catch {
            fputs("media relink apply failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func mediaRelinkSearchRoots(root: URL, projectURL: URL, args: [String]) -> [URL] {
        let explicitRoots = args
            .filter { !$0.hasPrefix("--") }
            .map { resolvePathArgument($0, root: root) }
        guard args.contains("--from-source-map") else {
            return explicitRoots
        }
        let suggestedRoots = ProjectMediaRelinker
            .suggestedSearchRoots(projectURL: projectURL)
            .map(\.url)
        return uniqueURLs(explicitRoots + suggestedRoots)
    }

    private static func uniqueURLs(_ urls: [URL]) -> [URL] {
        var seen: Set<String> = []
        var result: [URL] = []
        for url in urls {
            let path = url.standardizedFileURL.path
            guard !seen.contains(path) else { continue }
            seen.insert(path)
            result.append(url)
        }
        return result
    }

    private static func printMediaRelinkPlan(project: ProjectSummary, plan: ProjectMediaRelinkPlan) {
        print("project: \(project.id)")
        print("status: \(plan.statusLabel)")
        print("sourceMap: \(plan.sourceMapURL.path)")
        print("missingAssets: \(plan.missingAssetCount)")
        print("syntheticAssets: \(plan.syntheticAssetCount)")
        print("matched: \(plan.matchedCount)")
        print("unmatched: \(plan.unmatchedCount)")
        for root in plan.searchRoots {
            print("searchRoot: \(root.path)")
        }
        for item in plan.items {
            print("\(item.assetID)\t\(item.reason.rawValue)\t\(item.candidateURL == nil ? "unmatched" : "matched")\t\(item.filename)\t\(item.candidateURL?.path ?? "-")")
        }
    }

    private static func printSyntheticMediaPlan(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args.filter { !$0.hasPrefix("--") })
            let duration = durationArgument(args) ?? 5
            let plan = ProjectSyntheticMediaPlanner.plan(projectURL: project.path, durationSeconds: duration)
            print("project: \(project.id)")
            print("status: \(plan.statusLabel)")
            print("outputDirectory: \(plan.outputDirectory.path)")
            print("durationSeconds: \(plan.durationSeconds)")
            print("total: \(plan.totalCount)")
            print("pending: \(plan.pendingCount)")
            for item in plan.items {
                print("\(item.assetID)\t\(item.outputExists ? "exists" : "pending")\t\(item.filename)\t\(item.outputURL.path)")
                print("  \(item.commandLine)")
            }
        } catch {
            fputs("media synthetic plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func buildSyntheticMedia(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args.filter { !$0.hasPrefix("--") })
            let duration = durationArgument(args) ?? 5
            let force = args.contains("--force")
            let result = ProjectSyntheticMediaBuilder.build(projectURL: project.path, durationSeconds: duration, force: force)
            let mediaSummary = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: nil)
            let sourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(result.failureCount == 0 ? "ok" : "failed")")
            print("outputDirectory: \(result.plan.outputDirectory.path)")
            print("built: \(result.builtCount)")
            print("skipped: \(result.skippedCount)")
            print("failed: \(result.failureCount)")
            print("mapped: \(result.mappedCount)")
            print("sourceMap: \(result.sourceMapURL?.path ?? "-")")
            print("mediaReady: \(mediaSummary.readyCount)")
            print("mediaMissing: \(mediaSummary.missingCount)")
            print("sourceMapStatus: \(sourceMapStatus.readinessLabel)")
            print("sourceMapCoverage: \(sourceMapStatus.coverageLabel)")
            for failure in result.failures {
                print("failed\t\(failure.item.assetID)\t\(failure.message)")
            }
            if result.failureCount > 0 {
                Foundation.exit(1)
            }
        } catch {
            fputs("media synthetic build failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMediaProxyPlan(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let plan = ProjectMediaProxyPlanner.plan(projectURL: project.path)
            print("project: \(project.id)")
            print("proxyPlans: \(plan.totalCount)")
            print("pending: \(plan.pendingCount)")
            for item in plan.items {
                print("\(item.assetID)\t\(item.outputExists ? "exists" : "pending")\t\(item.filename)\t\(item.outputPath)")
                print("  \(item.commandLine)")
            }
        } catch {
            fputs("media proxy plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func buildMediaProxies(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let result = ProjectMediaProxyBuilder.build(projectURL: project.path)
            print("project: \(project.id)")
            print("proxyPlans: \(result.plan.totalCount)")
            print("built: \(result.builtCount)")
            print("skipped: \(result.skippedCount)")
            print("failed: \(result.failureCount)")
            for item in result.builtItems {
                print("built\t\(item.assetID)\t\(item.outputPath)")
            }
            for item in result.skippedItems {
                print("skipped\t\(item.assetID)\t\(item.outputPath)")
            }
            for failure in result.failures {
                print("failed\t\(failure.item.assetID)\t\(failure.message)")
            }
            if !result.failures.isEmpty {
                Foundation.exit(1)
            }
        } catch {
            fputs("media proxy build failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMonitorStatus(root: URL, args: [String]) {
        guard let projectArg = args.first else {
            fputs("usage: videoos-studio-cli monitor-status <project-id-or-path> [frame]\n", stderr)
            Foundation.exit(2)
        }

        do {
            let project = try resolveProject(root: root, args: [projectArg])
            let frame = args.dropFirst().first.flatMap(Int.init) ?? 0
            let timeline = try TimelineDocument.load(projectURL: project.path)
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let snapshot = timeline.monitorSnapshot(atFrame: frame)
            print("project: \(project.id)")
            print("frame: \(snapshot.frame)")
            print("timecode: \(snapshot.timecode)")
            printMonitorClip("program", snapshot.program, projectURL: project.path, timeline: timeline, assets: assets)
            printMonitorClip("visual", snapshot.visual, projectURL: project.path, timeline: timeline, assets: assets)
            printMonitorClip("audio", snapshot.audio, projectURL: project.path, timeline: timeline, assets: assets)
            printMonitorClip("nextProgram", snapshot.nextProgram, projectURL: project.path, timeline: timeline, assets: assets)
        } catch {
            fputs("monitor status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMonitorClip(
        _ label: String,
        _ clip: TimelineMonitorClip?,
        projectURL: URL,
        timeline: TimelineDocument,
        assets: AnalysisAssetDocument?
    ) {
        guard let clip else {
            print("\(label): -")
            return
        }
        let source = clip.sourceTimeUS.map(String.init) ?? "-"
        let media = timeline.clipSelection(for: clip.clipID).flatMap { selection in
            ProjectMediaResolver.resolveSelectedClip(
                projectURL: projectURL,
                clip: selection.clip,
                assets: assets,
                previewTimeUS: clip.sourceTimeUS
            )
        }
        let mediaPath = media?.url?.path ?? "-"
        let status = media?.exists == true ? "exists" : "missing"
        let video = media?.isVideoPlaybackReady == true ? "video=ready" : "video=-"
        let audio = media?.isAudioPlaybackReady == true ? "audio=ready" : "audio=-"
        let resolvedFrom = media?.resolvedFrom ?? "unresolved"
        print("\(label): \(clip.trackKind.rawValue)\t\(clip.trackID)\t\(clip.clipID)\t\(clip.assetID)\tsource_us=\(source)\t\(status)\t\(video)\t\(audio)\t\(resolvedFrom)\t\(mediaPath)")
    }

    private static func printAudioMap(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let timeline = try TimelineDocument.load(projectURL: project.path)
            let evidence = ProjectEvidenceStore.load(projectURL: project.path)
            let map = ProjectAudioTimelineMap.build(timeline: timeline, evidence: evidence)
            print("project: \(project.id)")
            print("audioCues: \(map.cues.count)")
            for cue in map.cues {
                let timecode = timeline.sequence.framesToTimecode(cue.frame)
                let end = cue.endFrame.map { timeline.sequence.framesToTimecode($0) } ?? "-"
                print("\(cue.kind.rawValue)\t\(cue.trackID)\t\(cue.clipID)\t\(cue.assetID)\t\(timecode)\t\(end)\t\(cue.label)")
            }
        } catch {
            fputs("audio map failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printTimelineMarkers(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let timeline = try TimelineDocument.load(projectURL: project.path)
            let map = ProjectTimelineMarkerMap.build(timeline: timeline)
            print("project: \(project.id)")
            print("markers: \(map.markers.count)")
            for marker in map.markers {
                print("\(marker.kind.rawValue)\t\(marker.frame)\t\(marker.timecode)\t\(marker.label)")
            }
        } catch {
            fputs("timeline markers failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printAudioWaveform(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let timeline = try TimelineDocument.load(projectURL: project.path)
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let sampleCount = args.dropFirst().first.flatMap(Int.init) ?? 24
            let map = ProjectAudioWaveformMap.build(projectURL: project.path, timeline: timeline, assets: assets, sampleCount: sampleCount)
            print("project: \(project.id)")
            print("waveforms: \(map.waveforms.count)")
            for waveform in map.waveforms {
                let preview = waveform.peaks
                    .prefix(12)
                    .map { $0.formatted(.number.precision(.fractionLength(2))) }
                    .joined(separator: ",")
                print("\(waveform.trackID)\t\(waveform.clipID)\t\(waveform.assetID)\tpeaks=\(waveform.peaks.count)\t\(waveform.resolvedFrom)\t\(preview)")
            }
        } catch {
            fputs("audio waveform failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printAudioStoryGraphPlan(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let plan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: root, projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(plan.readinessLabel)")
            print("script: \(plan.scriptURL.path)")
            print("graph: \(project.path.appendingPathComponent("03_analysis/audio_story_graph.json").path)")
            print("command: \(plan.commandLine)")
        } catch {
            fputs("audio story plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func runAudioStoryGraph(root: URL, args: [String]) {
        do {
            let projectArgs = args.filter { $0 != "--no-index" }
            let project = try resolveProject(root: root, args: projectArgs)
            let rebuildIndex = !args.contains("--no-index")
            let plan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: root, projectURL: project.path)
            let result = try ProjectAudioStoryGraphRunner.run(plan: plan, rebuildIndex: rebuildIndex)
            print("project: \(project.id)")
            print("status: \(result.succeeded ? "succeeded" : "failed")")
            print("exitCode: \(result.exitCode)")
            print(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
            if !result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                print("stderr: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
            print("indexRebuilt: \(result.indexSummary != nil)")
            if let indexSummary = result.indexSummary {
                print("searchDocuments: \(indexSummary.searchDocumentCount)")
                print("audioStoryNodes: \(indexSummary.audioStoryNodeCount)")
            }
            if !result.succeeded {
                Foundation.exit(result.exitCode)
            }
        } catch {
            fputs("audio story run failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printHandoffStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let plan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: project.path, assets: assets)
            print("project: \(project.id)")
            print("status: \(plan.readinessLabel)")
            print("timeline: \(plan.timelineExists)")
            print("sourceMap: \(plan.sourceMapExists)")
            print("sourceMapEntries: \(plan.sourceMapEntryCount)")
            print("generatedSourceMapEntries: \(plan.generatedSourceMapEntryCount)")
            print("sourceMapStatus: \(plan.sourceMapReadinessLabel)")
            print("sourceMapCoverage: \(plan.sourceMapCoverageLabel)")
            print("sourceMapReadyAssets: \(plan.sourceMapReadyAssetCount)")
            print("sourceMapMissingEntries: \(plan.sourceMapMissingEntryCount)")
            print("sourceMapBrokenEntries: \(plan.sourceMapBrokenEntryCount)")
            print("usesTemporarySourceMap: \(plan.usesTemporarySourceMap)")
            print("mediaReady: \(plan.mediaReadyCount)")
            print("mediaMissing: \(plan.mediaMissingCount)")
            print("mediaProxyNeeded: \(plan.mediaProxyNeededCount)")
            print("editorAnnotations: \(plan.editorAnnotationExists)")
            print("editorAnnotationNotes: \(plan.editorAnnotationNoteCount)")
            print("output: \(plan.outputURL.path)")
            print("command: \(plan.commandLine)")
        } catch {
            fputs("handoff status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printRenderStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let verification = ProjectPackageVerificationRunner.status(
                repositoryRoot: root,
                projectURL: project.path
            )
            let status = ProjectRenderPackageStatusReader.status(
                projectURL: project.path,
                verificationStatus: verification
            )
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("qaReport: \(status.qaReportExists)")
            print("qaReportReadable: \(status.qaReportReadable)")
            print("qaPassed: \(status.qaPassed.map(String.init) ?? "-")")
            print("qaSourceOfTruth: \(status.qaSourceOfTruth ?? "-")")
            print("qaChecks: \(status.qaCheckCount)")
            print("qaFailedChecks: \(status.qaFailedCheckCount)")
            print("packageManifest: \(status.packageManifestExists)")
            print("packageManifestReadable: \(status.packageManifestReadable)")
            print("manifestSourceOfTruth: \(status.manifestSourceOfTruth ?? "-")")
            print("manifestCreatedAt: \(status.manifestCreatedAt ?? "-")")
            print("publishedFinalVideo: \(status.publishedFinalVideoExists)")
            print("packageFinalVideo: \(status.packageFinalVideoExists)")
            print("finalMix: \(status.finalMixExists)")
            print("packageVerificationAvailable: \(verification.available)")
            print("packageVerificationIssues: \(verification.issues.count)")
            print("qaReportPath: \(status.qaReportURL.path)")
            print("manifestPath: \(status.packageManifestURL.path)")
            print("publishedFinalVideoPath: \(status.publishedFinalVideoURL.path)")
            print("packageFinalVideoPath: \(status.packageFinalVideoURL.path)")
            print("finalMixPath: \(status.finalMixURL.path)")
            if !status.missingRequiredArtifacts.isEmpty {
                print("missingRequiredArtifacts: \(status.missingRequiredArtifacts.joined(separator: ","))")
            }
        } catch {
            fputs("render status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printPlaybackContractStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectPlaybackContractStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("state: \(status.state.rawValue)")
            print("approvalGrade: \(status.isApprovalGrade)")
            print("timelineHash: \(status.timelineHash ?? "-")")
            print("manifestBaseTimelineHash: \(status.manifestBaseTimelineHash ?? "-")")
            print("recommendation: \(status.recommendation)")
        } catch {
            fputs("playback contract status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printRenderPlan(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let preflight = ProjectPackagePreflightRunner.status(
                repositoryRoot: root,
                projectURL: project.path
            )
            let plan = ProjectRenderRunPlanner.plan(
                repositoryRoot: root,
                projectURL: project.path,
                options: renderRunOptions(root: root, args: args),
                preflightStatus: preflight
            )
            print("project: \(project.id)")
            print("status: \(plan.readinessLabel)")
            print("canRun: \(plan.canRun)")
            print("currentState: \(plan.currentState ?? "-")")
            print("timeline: \(plan.hasTimeline)")
            print("review: \(plan.hasReview)")
            print("skipRender: \(plan.options.skipRender)")
            print("assembly: \(plan.options.assemblyURL?.path ?? "-")")
            print("suppliedFinal: \(plan.options.suppliedFinalURL?.path ?? "-")")
            print("script: \(plan.scriptURL.path)")
            print("command: \(plan.commandLine)")
        } catch {
            fputs("render plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func runRender(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let preflight = ProjectPackagePreflightRunner.status(
                repositoryRoot: root,
                projectURL: project.path
            )
            let plan = ProjectRenderRunPlanner.plan(
                repositoryRoot: root,
                projectURL: project.path,
                options: renderRunOptions(root: root, args: args),
                preflightStatus: preflight
            )
            let result = try ProjectRenderRunner.run(plan: plan)
            print("ok: render \(result.succeeded ? "completed" : "failed")")
            print("project: \(project.id)")
            print("exitCode: \(result.exitCode)")
            print("readiness: \(result.status.readinessLabel)")
            print("qaPassed: \(result.status.qaPassed.map(String.init) ?? "-")")
            print("publishedFinalVideo: \(result.status.publishedFinalVideoExists)")
            print("packageManifest: \(result.status.packageManifestExists)")
            print("qaReport: \(result.status.qaReportExists)")
            let trimmedStdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedStdout.isEmpty {
                print(trimmedStdout)
            }
            let trimmedStderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedStderr.isEmpty {
                fputs(trimmedStderr + "\n", stderr)
            }
            if !result.succeeded {
                Foundation.exit(Int32(result.exitCode == 0 ? 1 : result.exitCode))
            }
        } catch {
            fputs("render run failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMarlinStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project.path, repositoryRoot: root)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("policyEnabled: \(status.policyEnabled.map(String.init) ?? "-")")
            print("policyMode: \(status.policyMode ?? "-")")
            print("policyMock: \(status.policyMock.map(String.init) ?? "-")")
            print("policyModel: \(status.policyModelAlias ?? "-")")
            print("artifactExists: \(status.artifactExists)")
            print("artifactReadable: \(status.artifactReadable)")
            print("artifactModel: \(status.artifactModelAlias ?? "-")")
            print("artifactSnapshot: \(status.artifactModelSnapshot ?? "-")")
            print("connectorVersion: \(status.artifactConnectorVersion ?? "-")")
            print("assets: \(status.assetCount)")
            print("events: \(status.eventCount)")
            print("findResults: \(status.findResultCount)")
            print("segments: \(status.segmentCount)")
            print("segmentsWithMarlinPeak: \(status.segmentsWithMarlinPeakCount)")
            print("marlinInterestPoints: \(status.marlinInterestPointCount)")
            print("coverage: \(String(format: "%.2f", status.coverageRatio))")
            print("canPreferMarlin: \(status.canPreferMarlin)")
            print("artifactPath: \(status.artifactURL.path)")
            print("segmentsPath: \(status.segmentsURL.path)")
            print("recommendation: \(status.recommendation)")
        } catch {
            fputs("marlin status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMarlinRuntimeStatus(root: URL) {
        let status = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: root)
        print("status: \(status.readinessLabel)")
        print("python: \(status.pythonBinary)")
        print("requestedDevice: \(status.requestedDevice)")
        print("resolvedDevice: \(status.resolvedDeviceLabel)")
        print("deviceStatus: \(status.deviceStatusLabel)")
        print("cudaAvailable: \(status.cudaAvailable)")
        print("mpsAvailable: \(status.mpsAvailable)")
        print("readyForLiveMarlin: \(status.isReadyForLiveMarlin)")
        print("missing: \(status.missingRequirements.map(\.id).joined(separator: ", "))")
        print("outdated: \(status.outdatedRequirements.map(\.id).joined(separator: ", "))")
        print("setupCommand: \(status.setupCommand)")
        print("recommendation: \(status.recommendation)")
        for requirement in status.requirements {
            print("module.\(requirement.id): \(requirement.statusLabel) | \(requirement.detail)")
        }
        let trimmedStderr = status.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedStderr.isEmpty {
            print("stderr: \(trimmedStderr)")
        }
    }

    private static func printMarlinModelAccessStatus(root: URL) {
        let status = ProjectMarlinModelAccessStatusReader.status(repositoryRoot: root)
        print("status: \(status.readinessLabel)")
        print("repo: \(status.repoID)")
        print("python: \(status.pythonBinary)")
        print("hasToken: \(status.hasToken)")
        print("checkedAccess: \(status.checkedAccess)")
        print("accessAllowed: \(status.accessAllowed)")
        print("readyForLiveMarlin: \(status.isReadyForLiveMarlin)")
        print("recommendation: \(status.recommendation)")
        if let error = status.error, !error.isEmpty {
            print("error: \(error)")
        }
        let trimmedStderr = status.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedStderr.isEmpty {
            print("stderr: \(trimmedStderr)")
        }
        if !status.isReadyForLiveMarlin {
            Foundation.exit(1)
        }
    }

    private static func printMarlinPreferenceStatus(root: URL) {
        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)
        print("status: \(decision.decisionLabel)")
        print("policy: \(decision.policyStatus.marlinPolicyLabel)")
        print("model: \(decision.policyStatus.marlinModelAlias ?? "NemoStation/Marlin-2B")")
        print("minimumCandidateProjects: \(decision.minimumCandidateProjectCount)")
        print("representativeCandidateBuckets: \(decision.representativeCandidateBucketCount) / \(decision.representativeTargetBucketCount)")
        print("representativePlan: \(decision.representativePlan.readinessLabel)")
        print("evaluatedProjects: \(decision.evaluatedProjectCount)")
        print("candidateProjects: \(decision.candidateProjectCount)")
        print("blockedEvaluatedProjects: \(decision.blockedEvaluatedProjectCount)")
        print("mediaBlockedEvaluatedProjects: \(decision.mediaBlockedEvaluatedProjectCount)")
        print("events: \(decision.totalEventCount)")
        print("findResults: \(decision.totalFindResultCount)")
        print("segments: \(decision.totalSegmentCount)")
        print("coveredSegments: \(decision.totalCoveredSegmentCount)")
        print("aggregateCoverage: \(String(format: "%.2f", decision.aggregateCoverageRatio))")
        print("canPreferMarlinAsDefault: \(decision.canPreferMarlinAsDefault)")
        print("recommendation: \(decision.recommendation)")
        for project in decision.projects {
            print("project.\(project.id): \(project.canPreferMarlin ? "candidate" : "not-ready") | \(project.readinessLabel) | \(project.coveredSegmentCount)/\(project.segmentCount) peak segments | \(project.eventCount) events / \(project.findResultCount) finds")
        }
    }

    private static func applyMarlinPreference(root: URL, args: [String]) {
        let confirm = args.contains("--confirm")
        let force = args.contains("--force")
        let plan = ProjectMarlinPreferenceApplier.plan(repositoryRoot: root)
        print("status: \(plan.readinessLabel)")
        print("policyPath: \(plan.policyURL.path)")
        print("currentPolicy: \(plan.currentPolicyLabel)")
        print("targetPolicy: \(plan.targetPolicyLabel)")
        print("canApply: \(plan.canApply)")
        print("needsChange: \(plan.needsChange)")
        print("confirm: \(confirm)")
        print("recommendation: \(plan.recommendation)")

        guard confirm else {
            print("wrotePolicy: false")
            print("hint: pass --confirm after reviewing marlin-preference-status to promote Marlin-first temporal semantics.")
            return
        }

        do {
            let result = try ProjectMarlinPreferenceApplier.apply(repositoryRoot: root, confirm: true, force: force)
            print("wrotePolicy: \(result.wrotePolicy)")
            print("previousPolicy: \(result.previousPolicyLabel)")
            print("nextPolicy: \(result.nextPolicyLabel)")
        } catch {
            fputs("marlin preference apply failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMarlinEvaluationQueue(root: URL) {
        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: root)
        print("status: \(queue.readinessLabel)")
        print("projects: \(queue.projectCount)")
        print("runnableProjects: \(queue.runnableProjectCount)")
        print("evaluatedProjects: \(queue.evaluatedProjectCount)")
        print("candidateProjects: \(queue.candidateProjectCount)")
        print("mediaBlockedProjects: \(queue.mediaBlockedProjectCount)")
        print("nextAction: \(queue.nextAction)")
        for item in queue.items {
            print("project.\(item.id): \(item.priorityLabel) | run=\(item.canRunEvaluation) defaultSelected=\(item.defaultSelectedSourceCount) | sources=\(item.sourceCount) skipped=\(item.skippedSourceCount) | mediaMissing=\(item.mediaMissingCount) proxyNeeded=\(item.proxyNeededCount) | marlin=\(item.evaluationReadinessLabel) | coverage=\(item.coveredSegmentCount)/\(item.segmentCount)")
            print("  sourceMap: \(item.sourceMapReadinessLabel)")
            print("  recommendation: \(item.recommendation)")
        }
    }

    private static func runNextMarlinEvaluation(root: URL, args: [String]) {
        let execute = args.contains("--execute")
        let mock = args.contains("--mock")
        let skipExisting = args.contains("--skip-existing")
        let captionOnly = args.contains("--caption-only")
        let requestTimeoutMs: Int?
        let maxSources: Int?
        let chunkSeconds: Int?
        let chunkOverlapSeconds: Int?
        let maxChunks: Int?
        do {
            requestTimeoutMs = try marlinRequestTimeoutMs(from: args)
            maxSources = try marlinMaxSources(from: args)
            chunkSeconds = try marlinChunkSeconds(from: args)
            chunkOverlapSeconds = try marlinChunkOverlapSeconds(from: args)
            maxChunks = try marlinMaxChunks(from: args)
        } catch {
            fputs("marlin eval next failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
        let next = ProjectMarlinEvaluationNextPlanner.plan(
            repositoryRoot: root,
            skipExisting: skipExisting,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds
        )
        print("queue: \(next.queue.readinessLabel)")
        print("execute: \(execute)")
        print("mock: \(mock)")
        print("requestTimeoutMs: \(requestTimeoutMs.map(String.init) ?? "\(defaultMarlinRequestTimeoutMs) (default)")")
        print("maxSources: \(maxSources.map(String.init) ?? "all")")
        print("skipExisting: \(skipExisting)")
        print("captionOnly: \(captionOnly)")
        print("chunkSeconds: \(chunkSeconds.map(String.init) ?? "-")")
        print("chunkOverlapSeconds: \(chunkOverlapSeconds.map(String.init) ?? "-")")
        print("maxChunks: \(maxChunks.map(String.init) ?? "all")")
        guard let item = next.item, let plan = next.runPlan else {
            print("status: \(next.readinessLabel)")
            print("nextProject: -")
            print("canRun: false")
            print("recommendation: \(next.recommendation)")
            return
        }
        let selectedSourceCount = plan.selectedSourceCount(
            skipExisting: skipExisting,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds
        )
        let canRunSelectedSources = plan.canRun && selectedSourceCount > 0
        let readinessLabel = canRunSelectedSources
            ? plan.readinessLabel
            : (plan.canRun ? "no unevaluated video sources" : plan.readinessLabel)
        print("status: \(readinessLabel)")
        print("nextProject: \(item.id)")
        print("canRun: \(canRunSelectedSources)")
        print("sourceCount: \(plan.sourceCount)")
        print("selectedSourceCount: \(selectedSourceCount)")
        print("skippedSourceCount: \(plan.skippedSourceCount)")
        if canRunSelectedSources {
            let commandLine = plan.commandLine(
                mock: mock,
                requestTimeoutMs: requestTimeoutMs,
                maxSources: maxSources,
                skipExisting: skipExisting,
                captionOnly: captionOnly,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds,
                maxChunks: maxChunks
            )
            print("command: \(commandLine)")
            print("recommendation: \(next.recommendation)")
        } else {
            print("command: -")
            print("recommendation: No unevaluated ready source files remain for \(item.id). Relink missing media or choose a different representative project.")
        }
        if !mock {
            let modelAccess = ProjectMarlinModelAccessStatusReader.status(repositoryRoot: root)
            print("modelAccess: \(modelAccess.readinessLabel)")
            if !modelAccess.isReadyForLiveMarlin {
                print("modelAccessRecommendation: \(modelAccess.recommendation)")
            }
        }

        guard execute else {
            print("hint: add --execute after marlin-model-access-status is ready. For slow MPS live runs, pass --request-timeout-ms=900000.")
            return
        }

        do {
            guard canRunSelectedSources else {
                throw CLIError.message("Marlin evaluation is not runnable: \(readinessLabel)")
            }
            let result = try ProjectMarlinEvaluationRunner.runAndRefreshIndex(
                plan: plan,
                mock: mock,
                requestTimeoutMs: requestTimeoutMs,
                maxSources: maxSources,
                skipExisting: skipExisting,
                captionOnly: captionOnly,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds,
                maxChunks: maxChunks
            )
            print(result.runResult.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines))
            if let indexSummary = result.indexSummary {
                print("indexRebuilt: true")
                print("index: \(indexSummary.indexURL.path)")
                print("searchDocuments: \(indexSummary.searchDocumentCount)")
                print("marlinEvents: \(indexSummary.marlinEventCount)")
                print("marlinFindResults: \(indexSummary.marlinFindResultCount)")
            }
            if !result.runResult.standardError.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                fputs(result.runResult.standardError + (result.runResult.standardError.hasSuffix("\n") ? "" : "\n"), stderr)
            }
            Foundation.exit(result.succeeded ? 0 : Int32(result.runResult.exitCode))
        } catch {
            fputs("marlin eval next failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printMarlinRepresentativePlan(root: URL) {
        let plan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: root)
        print("status: \(plan.readinessLabel)")
        print("coveredBuckets: \(plan.coveredBucketCount) / \(plan.targetBucketCount)")
        print("candidateBuckets: \(plan.candidateCoveredBucketCount) / \(plan.targetBucketCount)")
        print("nextAction: \(plan.nextAction)")
        for bucket in plan.buckets {
            print("bucket.\(bucket.id): \(bucket.readinessLabel) | projects=\(bucket.projectCount) runnable=\(bucket.runnableProjectCount) candidate=\(bucket.candidateProjectCount) blocked=\(bucket.blockedProjectCount)")
            print("  label: \(bucket.label)")
            print("  rationale: \(bucket.rationale)")
        }
        for project in plan.projects {
            print("project.\(project.id): \(project.readinessLabel) | tags=\(project.tagLabel) | sources=\(project.sourceCount) missing=\(project.mediaMissingCount)")
            print("  title: \(project.title)")
            print("  format: \(project.format)")
            print("  recommendation: \(project.recommendation)")
        }
    }

    private static func printMarlinEvaluationPlan(root: URL, args: [String]) {
        do {
            let requestTimeoutMs = try marlinRequestTimeoutMs(from: args)
            let maxSources = try marlinMaxSources(from: args)
            let skipExisting = args.contains("--skip-existing")
            let captionOnly = args.contains("--caption-only")
            let chunkSeconds = try marlinChunkSeconds(from: args)
            let chunkOverlapSeconds = try marlinChunkOverlapSeconds(from: args)
            let maxChunks = try marlinMaxChunks(from: args)
            let project = try resolveProject(root: root, args: marlinEvaluationProjectArgs(from: args))
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let plan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: root, projectURL: project.path, assets: assets)
            let selectedSourceCount = plan.selectedSourceCount(
                skipExisting: skipExisting,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds
            )
            let canRunSelectedSources = plan.canRun && selectedSourceCount > 0
            let readinessLabel = canRunSelectedSources
                ? plan.readinessLabel
                : (plan.canRun ? "no unevaluated video sources" : plan.readinessLabel)
            print("project: \(project.id)")
            print("status: \(readinessLabel)")
            print("canRun: \(canRunSelectedSources)")
            print("sourceCount: \(plan.sourceCount)")
            print("selectedSourceCount: \(selectedSourceCount)")
            print("skippedSourceCount: \(plan.skippedSourceCount)")
            print("requestTimeoutMs: \(requestTimeoutMs.map(String.init) ?? "\(defaultMarlinRequestTimeoutMs) (default)")")
            print("maxSources: \(maxSources.map(String.init) ?? "all")")
            print("skipExisting: \(skipExisting)")
            print("captionOnly: \(captionOnly)")
            print("chunkSeconds: \(chunkSeconds.map(String.init) ?? "-")")
            print("chunkOverlapSeconds: \(chunkOverlapSeconds.map(String.init) ?? "-")")
            print("maxChunks: \(maxChunks.map(String.init) ?? "all")")
            print("script: \(plan.scriptURL.path)")
            if canRunSelectedSources {
                let commandLine = plan.commandLine(
                    requestTimeoutMs: requestTimeoutMs,
                    maxSources: maxSources,
                    skipExisting: skipExisting,
                    captionOnly: captionOnly,
                    chunkSeconds: chunkSeconds,
                    chunkOverlapSeconds: chunkOverlapSeconds,
                    maxChunks: maxChunks
                )
                print("command: \(commandLine)")
            } else {
                print("command: -")
            }
            let selectedSourceURLs = plan.selectedSourceURLs(
                skipExisting: skipExisting,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds
            )
            if !selectedSourceURLs.isEmpty {
                print("sources:")
                for url in selectedSourceURLs {
                    print("- \(url.path)")
                }
            }
        } catch {
            fputs("marlin eval plan failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func materializeMarlinEvidence(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: root, projectURL: project.path)
            guard plan.canRun else {
                throw CLIError.message("Marlin materialization is not runnable: \(plan.readinessLabel)")
            }
            let result = try ProjectMarlinMaterializationRunner.runAndRefreshIndex(plan: plan)
            print(result.runResult.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines))
            if let indexSummary = result.indexSummary {
                print("indexRebuilt: true")
                print("index: \(indexSummary.indexURL.path)")
                print("searchDocuments: \(indexSummary.searchDocumentCount)")
                print("marlinEvents: \(indexSummary.marlinEventCount)")
                print("marlinFindResults: \(indexSummary.marlinFindResultCount)")
            }
            if !result.runResult.standardError.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                fputs(result.runResult.standardError + (result.runResult.standardError.hasSuffix("\n") ? "" : "\n"), stderr)
            }
            Foundation.exit(result.succeeded ? 0 : Int32(result.runResult.exitCode))
        } catch {
            fputs("marlin materialize failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func runMarlinEvaluation(root: URL, args: [String]) {
        do {
            let mock = args.contains("--mock")
            let skipExisting = args.contains("--skip-existing")
            let captionOnly = args.contains("--caption-only")
            let requestTimeoutMs = try marlinRequestTimeoutMs(from: args)
            let maxSources = try marlinMaxSources(from: args)
            let chunkSeconds = try marlinChunkSeconds(from: args)
            let chunkOverlapSeconds = try marlinChunkOverlapSeconds(from: args)
            let maxChunks = try marlinMaxChunks(from: args)
            let project = try resolveProject(root: root, args: marlinEvaluationProjectArgs(from: args))
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let plan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: root, projectURL: project.path, assets: assets)
            let selectedSourceCount = plan.selectedSourceCount(
                    skipExisting: skipExisting,
                    chunkSeconds: chunkSeconds,
                    chunkOverlapSeconds: chunkOverlapSeconds
            )
            guard plan.canRun, selectedSourceCount > 0
            else {
                let readinessLabel = plan.canRun ? "no unevaluated video sources" : plan.readinessLabel
                throw CLIError.message("Marlin evaluation is not runnable: \(readinessLabel)")
            }
            let result = try ProjectMarlinEvaluationRunner.runAndRefreshIndex(
                plan: plan,
                mock: mock,
                requestTimeoutMs: requestTimeoutMs,
                maxSources: maxSources,
                skipExisting: skipExisting,
                captionOnly: captionOnly,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds,
                maxChunks: maxChunks
            )
            print(result.runResult.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines))
            if let indexSummary = result.indexSummary {
                print("indexRebuilt: true")
                print("index: \(indexSummary.indexURL.path)")
                print("searchDocuments: \(indexSummary.searchDocumentCount)")
                print("marlinEvents: \(indexSummary.marlinEventCount)")
                print("marlinFindResults: \(indexSummary.marlinFindResultCount)")
            }
            if !result.runResult.standardError.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                fputs(result.runResult.standardError + (result.runResult.standardError.hasSuffix("\n") ? "" : "\n"), stderr)
            }
            Foundation.exit(result.succeeded ? 0 : Int32(result.runResult.exitCode))
        } catch {
            fputs("marlin eval run failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func exportPremiereHandoff(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let result = try ProjectHandoffExporter.exportPremiereXML(repositoryRoot: root, projectURL: project.path, assets: assets)
            print("ok: premiere xml exported")
            print("project: \(project.id)")
            print("output: \(result.outputURL.path)")
            let trimmed = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                print(trimmed)
            }
        } catch {
            fputs("handoff export failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printHandoffPacketStatus(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let plan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: project.path, assets: assets)
            print("project: \(project.id)")
            print("status: \(plan.readinessLabel)")
            print("canExportPacket: \(plan.canExportPacket)")
            print("packet: \(plan.packetURL.path)")
            print("manifest: \(plan.manifestURL.path)")
            print("premiereXML: \(plan.premiereXMLURL.path)")
            print("annotations: \(plan.annotationIncluded)")
            print("annotationNotes: \(plan.handoffPlan.editorAnnotationNoteCount)")
            print("reviewReport: \(plan.reviewReportIncluded)")
            print("reviewPatch: \(plan.reviewPatchIncluded)")
            print("mediaIncluded: \(plan.mediaIncludedCount)")
            for media in plan.mediaSources {
                print("media\t\(media.kind)\t\(media.packetRelativePath)\t\(media.sourceURL.path)")
            }
        } catch {
            fputs("handoff packet status failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func printHandoffPacketVerification(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let status = ProjectEditorPacketVerificationStatusReader.status(projectURL: project.path)
            print("project: \(project.id)")
            print("status: \(status.readinessLabel)")
            print("packet: \(status.packetURL.path)")
            print("packetExists: \(status.packetExists)")
            print("manifest: \(status.manifestURL.path)")
            print("manifestExists: \(status.manifestExists)")
            print("manifestReadable: \(status.manifestReadable)")
            print("manifestProject: \(status.manifestProjectID ?? "-")")
            print("manifestFiles: \(status.manifestFileCount)")
            print("existingFiles: \(status.existingFileCount)")
            print("missingFiles: \(status.missingFileCount)")
            print("mediaFiles: \(status.mediaFileCount)")
            print("previewMedia: \(status.previewMediaIncluded)")
            print("finalMedia: \(status.finalMediaIncluded)")
            print("finalAudio: \(status.finalAudioIncluded)")
            print("captionSidecar: \(status.captionSidecarIncluded)")
            print("captionApproval: \(status.captionApprovalIncluded)")
            print("recommendation: \(status.recommendation)")
            for file in status.missingFiles {
                print("missing\t\(file)")
            }
            if status.readinessLabel == "packet incomplete" || status.readinessLabel == "manifest unreadable" {
                Foundation.exit(1)
            }
        } catch {
            fputs("handoff packet verify failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func exportHandoffPacket(root: URL, args: [String]) {
        do {
            let project = try resolveProject(root: root, args: args)
            let assets = try? AnalysisAssetDocument.load(from: project.path.appendingPathComponent("03_analysis/assets.json"))
            let result = try ProjectEditorPacketExporter.export(repositoryRoot: root, projectURL: project.path, assets: assets)
            print("ok: editor packet exported")
            print("project: \(project.id)")
            print("packet: \(result.packetURL.path)")
            print("manifest: \(result.manifestURL.path)")
            print("files: \(result.files.count)")
            for file in result.files {
                print(file.path)
            }
        } catch {
            fputs("handoff packet export failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func smokeSyntheticHandoff(root: URL, args: [String]) {
        let duration = durationArgument(args) ?? 1
        let keepProject = args.contains("--keep")
        do {
            let result = try ProjectSyntheticHandoffSmoke.run(repositoryRoot: root, durationSeconds: duration)
            defer {
                if !keepProject {
                    ProjectSyntheticHandoffSmoke.removeProject(result)
                }
            }
            print("ok: synthetic handoff smoke \(result.succeeded ? "passed" : "failed")")
            print("project: \(result.projectURL.path)")
            print("kept: \(keepProject)")
            print("built: \(result.syntheticBuildResult.builtCount)")
            print("failed: \(result.syntheticBuildResult.failureCount)")
            print("mapped: \(result.syntheticBuildResult.mappedCount)")
            print("sourceMap: \(result.syntheticBuildResult.sourceMapURL?.path ?? "-")")
            print("sourceMapStatus: \(result.sourceMapStatus.readinessLabel)")
            print("sourceMapCoverage: \(result.sourceMapStatus.coverageLabel)")
            print("mediaReady: \(result.mediaPreviewSummary.readyCount)")
            print("mediaMissing: \(result.mediaPreviewSummary.missingCount)")
            print("handoffStatus: \(result.handoffPlan.readinessLabel)")
            print("usesTemporarySourceMap: \(result.handoffPlan.usesTemporarySourceMap)")
            print("premiereXML: \(result.premiereXMLURL.path)")
            print("editorPacket: \(result.editorPacketURL.path)")
            print("editorPacketManifest: \(result.editorPacketManifestURL.path)")
            print("editorPacketFiles: \(result.editorPacketFileCount)")
            print("xmlContainsMediaReferences: \(result.premiereXMLContainsMediaRefs)")
            if !result.succeeded {
                Foundation.exit(1)
            }
        } catch {
            fputs("synthetic handoff smoke failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func smokeSyntheticStudio(root: URL, args: [String]) {
        let duration = durationArgument(args) ?? 1
        let keepProject = args.contains("--keep")
        do {
            let result = try ProjectStudioSyntheticSmoke.run(repositoryRoot: root, durationSeconds: duration)
            defer {
                if !keepProject {
                    ProjectStudioSyntheticSmoke.removeProject(result)
                }
            }
            print("ok: synthetic studio smoke \(result.succeeded ? "passed" : "failed")")
            print("project: \(result.projectURL.path)")
            print("kept: \(keepProject)")
            print("built: \(result.syntheticBuildResult.builtCount)")
            print("failed: \(result.syntheticBuildResult.failureCount)")
            print("sourceMapStatus: \(result.sourceMapStatus.readinessLabel)")
            print("sourceMapCoverage: \(result.sourceMapStatus.coverageLabel)")
            print("mediaReady: \(result.mediaPreviewSummary.readyCount)")
            print("mediaMissing: \(result.mediaPreviewSummary.missingCount)")
            print("renderSucceeded: \(result.renderResult.succeeded)")
            print("renderStatus: \(result.renderResult.status.readinessLabel)")
            print("finalVideo: \(result.projectURL.appendingPathComponent("09_output/final.mp4").path)")
            print("editorPacket: \(result.editorPacketResult.packetURL.path)")
            print("editorPacketManifest: \(result.editorPacketResult.manifestURL.path)")
            print("editorPacketMedia: \(result.editorPacketMediaCount)")
            print("editorPacketVerify: \(result.editorPacketVerificationStatus.readinessLabel)")
            print("indexDocuments: \(result.indexStatus.documentCount)")
            print("studioStatus: \(result.studioStatus.readinessLabel)")
            print("studioScore: \(result.studioStatus.scoreLabel)")
            print("nextAction: \(result.studioStatus.nextAction)")
            if !result.succeeded {
                Foundation.exit(1)
            }
        } catch {
            fputs("synthetic studio smoke failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func smokeStudioAcceptance(root: URL, args: [String]) {
        let duration = durationArgument(args) ?? 1
        let keepProject = args.contains("--keep")
        do {
            let result = try ProjectStudioAcceptanceSmoke.run(repositoryRoot: root, durationSeconds: duration)
            defer {
                if !keepProject {
                    ProjectStudioAcceptanceSmoke.removeProject(result)
                }
            }
            print("ok: \(result.summaryLabel)")
            print("appServerUserAgent: \(result.appServerResponse.userAgent)")
            print("appServerCodexHome: \(result.appServerResponse.codexHome)")
            print("appServerPlatform: \(result.appServerResponse.platformFamily)/\(result.appServerResponse.platformOs)")
            print("project: \(result.studioSmokeResult.projectURL.path)")
            print("kept: \(keepProject)")
            print("renderSucceeded: \(result.studioSmokeResult.renderResult.succeeded)")
            print("renderStatus: \(result.studioSmokeResult.renderResult.status.readinessLabel)")
            print("sourceMapStatus: \(result.studioSmokeResult.sourceMapStatus.readinessLabel)")
            print("mediaMissing: \(result.studioSmokeResult.mediaPreviewSummary.missingCount)")
            print("finalVideo: \(result.studioSmokeResult.projectURL.appendingPathComponent("09_output/final.mp4").path)")
            print("editorPacketMedia: \(result.studioSmokeResult.editorPacketMediaCount)")
            print("editorPacketVerify: \(result.studioSmokeResult.editorPacketVerificationStatus.readinessLabel)")
            print("indexDocuments: \(result.studioSmokeResult.indexStatus.documentCount)")
            print("studioStatus: \(result.studioSmokeResult.studioStatus.readinessLabel)")
            print("studioScore: \(result.studioSmokeResult.studioStatus.scoreLabel)")
            print("nextAction: \(result.studioSmokeResult.studioStatus.nextAction)")
            if !result.succeeded {
                Foundation.exit(1)
            }
        } catch {
            fputs("studio acceptance smoke failed: \(error)\n", stderr)
            Foundation.exit(1)
        }
    }

    private static func smokeAppServer(root: URL) {
        let session = CodexAppServerSession(workspace: root)
        do {
            try session.start()
            let response = try session.initialize(timeout: 15)
            print("ok: initialized")
            print("userAgent: \(response.userAgent)")
            print("codexHome: \(response.codexHome)")
            print("platform: \(response.platformFamily)/\(response.platformOs)")
            session.stop()
        } catch {
            fputs("app-server smoke failed: \(error)\n", stderr)
            let diagnostics = session.process.recentDiagnostics()
            if !diagnostics.isEmpty {
                fputs(diagnostics.joined(separator: "\n") + "\n", stderr)
            }
            session.stop()
            Foundation.exit(1)
        }
    }

    private static func smokeThread(root: URL) {
        let session = CodexAppServerSession(workspace: root)
        do {
            try session.start()
            _ = try session.initialize(timeout: 15)
            let start = try session.startThread(ephemeral: true, timeout: 20)
            let read = try session.readThread(threadID: start.thread.id, includeTurns: false, timeout: 20)
            print("ok: thread started")
            print("threadId: \(start.thread.id)")
            print("model: \(start.model)")
            print("cwd: \(read.thread.cwd)")
            print("ephemeral: \(read.thread.ephemeral)")
            session.stop()
        } catch {
            fputs("thread smoke failed: \(error)\n", stderr)
            let diagnostics = session.process.recentDiagnostics()
            if !diagnostics.isEmpty {
                fputs(diagnostics.joined(separator: "\n") + "\n", stderr)
            }
            session.stop()
            Foundation.exit(1)
        }
    }

    private static func smokeTurn(root: URL) {
        let session = CodexAppServerSession(workspace: root)
        do {
            try session.start()
            _ = try session.initialize(timeout: 15)
            let start = try session.startThread(ephemeral: true, timeout: 20)
            let summary = try session.runTurnAndWait(
                threadID: start.thread.id,
                text: "Reply exactly: Video OS Studio turn smoke ok. Do not run tools.",
                readOnly: true,
                timeout: 120
            )
            print("ok: turn completed")
            print("threadId: \(start.thread.id)")
            print("turnId: \(summary.turnId)")
            print("status: \(summary.status)")
            print("assistant: \(summary.assistantText)")
            print("events: \(summary.eventMethods.joined(separator: ","))")
            session.stop()
            if summary.status != "completed" {
                Foundation.exit(1)
            }
        } catch {
            fputs("turn smoke failed: \(error)\n", stderr)
            let diagnostics = session.process.recentDiagnostics()
            if !diagnostics.isEmpty {
                fputs(diagnostics.joined(separator: "\n") + "\n", stderr)
            }
            session.stop()
            Foundation.exit(1)
        }
    }

    private static func printUsage() {
        print("""
        usage: videoos-studio-cli [doctor|projects|project-init|codex-plan|policy-status|library-status|studio-goal-status|native-editor-visual-qa-status|studio-status|studio-action|gate-status|intent-status|intent-alignment|review-status|planning-status|analysis-plan|analysis-run|compile-plan|compile-run|request-sample|agent-jobs|agent-prompt|annotations-status|clip-note-add|clip-note-clear|clip-note-prompt|index-rebuild|index-status|index-search|index-context|media-status|media-source-map-status|media-relink-plan|media-relink-apply|media-synthetic-plan|media-synthetic-build|media-proxy-plan|media-proxy-build|monitor-status|timeline-markers|audio-map|audio-waveform|interview-reframe|audio-story-plan|audio-story-run|marlin-status|marlin-runtime-status|marlin-model-access-status|marlin-preference-status|marlin-preference-apply|marlin-representative-plan|marlin-eval-queue|marlin-eval-next|marlin-eval-plan|marlin-materialize|marlin-eval-run|playback-contract-status|render-status|render-plan|render-run|handoff-status|handoff-export-premiere|handoff-packet-status|handoff-packet-verify|handoff-export-packet|handoff-synthetic-smoke|studio-synthetic-smoke|studio-acceptance-smoke|app-server-smoke|thread-smoke|turn-smoke]

        Commands:
          doctor            Print repository and app-server readiness.
          projects          List local Video OS projects.
          project-init      Create a project from projects/_template and optionally link source media. Optional: --source-dir=<path>.
          codex-plan        Print the Codex App Server launch command.
          policy-status     Print VLM and Marlin policy defaults from runtime/analysis-defaults.yaml.
          library-status    Print material-library, preview-media, RAG, Marlin, audio, and handoff readiness.
          studio-goal-status
                            Print objective-level coverage across native app, Codex runtime, Marlin, RAG, audio, rough cut, editor UI, handoff, render, and representative coverage.
          native-editor-visual-qa-status
                            Print repository visual QA evidence for the native NLE-style editor surface.
          studio-status     Print cross-pipeline studio readiness across Codex, material/RAG, intent, Marlin, audio, review, handoff, and render.
          studio-action     Print or execute the first queued Studio action, or a named action id. Optional: <action-id|--id=<id>> --execute --run-codex --approve-codex-write --timeout=<sec> --context-query=<query> --context-limit=<n>.
          gate-status       Print project_state gates, review status, render readiness, and the next operator action.
          intent-status     Print creative brief, autonomy, must-have, must-avoid, and blocker summary.
          intent-alignment  Print rough-cut evidence alignment against the current creative brief and review.
          review-status     Print review_report.yaml and review_patch.json readiness and finding counts.
          planning-status   Print intent, analysis, selects, blueprint, and next Codex planning job readiness.
          analysis-plan     Print source-media analysis command for a project.
          analysis-run      Run source-media analysis and rebuild the SQLite RAG index. Optional: --skip-stt --skip-vlm --skip-peak --skip-marlin --skip-appraiser --skip-media-link --skip-preflight --no-index.
          compile-plan      Print rough-cut timeline compiler command for a project.
          compile-run       Run rough-cut timeline compile and rebuild the SQLite RAG index. Optional: --patch=<file> --review-patch --fps=<num> --source-map=<file> --skip-preview --confirm-brief-defaults --no-index.
          request-sample    Print JSON-RPC requests for the first agent loop.
          agent-jobs        Print agent job write contracts. Optional: <project-id>.
          agent-prompt      Print a job prompt, optionally with indexed RAG context. Optional: --context-query=<query>.
          annotations-status
                            Print editor handoff annotation status for a project.
          clip-note-add     Add or update a selected timeline clip note.
          clip-note-clear   Remove a selected timeline clip note.
          clip-note-prompt  Print the read-only Codex prompt for a selected clip note.
          index-rebuild     Rebuild 03_analysis/search/project_index.sqlite for a project.
          index-status      Print SQLite search index status for a project.
          index-search      Search a rebuilt project SQLite index.
          index-context     Print prompt-ready RAG context with artifact/time citations from the index.
          media-status      Print source media preview readiness for a project.
          media-source-map-status
                            Print durable source_map.json coverage and broken-path diagnostics.
          media-relink-plan Plan source_map.json relinks from one or more search roots. Optional: --from-source-map --include-synthetic.
          media-relink-apply
                            Write source_map.json relinks and project symlinks for matched missing or explicitly included synthetic media. Optional: --from-source-map --include-synthetic.
          media-synthetic-plan
                            Plan short generated source videos for demo/QA projects.
          media-synthetic-build
                            Build generated source videos and source_map.json. Optional: --duration=<sec> --force.
          media-proxy-plan  Print ffmpeg preview-proxy commands for unsupported source media.
          media-proxy-build Execute preview-proxy transcodes for unsupported source media.
          monitor-status    Print program monitor visual/audio/next clip state for a frame.
          timeline-markers  Print timeline markers with frame and timecode.
          audio-map         Print timeline-positioned audio events, story cues, and BGM beats.
          audio-waveform    Extract normalized waveform peaks for audio timeline clips.
          interview-reframe Analyze face landmarks, look direction, and hand poses, then print a safe zoom/pan proposal. Required: --source=<video>. Optional: --in-us=<n> --out-us=<n> --width=<px> --height=<px> --samples=<n>.
          audio-story-plan  Print the audio story graph build command for transcript/BGM/audio-event evidence.
          audio-story-run   Build 03_analysis/audio_story_graph.json and rebuild the SQLite RAG index. Optional: --no-index.
          marlin-status     Print Marlin-2B temporal VLM evaluation readiness.
          marlin-runtime-status
                            Print local Python dependency readiness for live Marlin-2B evaluation.
          marlin-model-access-status
                            Print Hugging Face token and gated NemoStation/Marlin-2B access readiness.
          marlin-preference-status
                            Print repository-level evidence for promoting Marlin-2B to Marlin-first temporal VLM priority.
          marlin-preference-apply
                            Promote Marlin-first temporal semantics after the evidence gate passes. Requires --confirm to write runtime/analysis-defaults.yaml.
          marlin-representative-plan
                            Print representative Marlin coverage across interview, music, and documentary projects.
          marlin-eval-queue
                            Print runnable and blocked projects for representative Marlin-2B evaluation.
          marlin-eval-next
                            Print or run the next runnable non-candidate Marlin evaluation. Optional: --execute --mock --request-timeout-ms=<ms> --max-sources=<n> --skip-existing --caption-only --chunk-seconds=<sec> --chunk-overlap-seconds=<sec> --max-chunks=<n>.
          marlin-eval-plan  Print the Marlin-only evaluation command for existing analyzed media. Optional: --request-timeout-ms=<ms> --max-sources=<n> --skip-existing --caption-only --chunk-seconds=<sec> --chunk-overlap-seconds=<sec> --max-chunks=<n>.
          marlin-materialize
                            Apply existing 03_analysis/marlin_events.json evidence to segment peaks and rebuild the SQLite RAG index.
          marlin-eval-run   Run Marlin-only evaluation for existing analyzed media. Optional: --mock --request-timeout-ms=<ms> --max-sources=<n> --skip-existing --caption-only --chunk-seconds=<sec> --chunk-overlap-seconds=<sec> --max-chunks=<n>.
          playback-contract-status
                            Print whether preview-manifest.json matches the current timeline (approval-grade playback).
          render-status     Print final render/package artifact readiness.
          render-plan       Print the render/package worker command. Optional: --skip-render --assembly=<path> --supplied-final=<path>.
          render-run        Run final render/package worker. Optional: --skip-render --assembly=<path> --supplied-final=<path>.
          handoff-status    Print Premiere XML handoff readiness and output path.
          handoff-export-premiere
                            Export timeline.json to FCP7 XML for Premiere import.
          handoff-packet-status
                            Print editor packet readiness and paths.
          handoff-packet-verify
                            Verify exported editor packet manifest files and preview/final media presence.
          handoff-export-packet
                            Export Premiere XML, annotations, review artifacts, and media into an editor packet.
          handoff-synthetic-smoke
                            Build a temporary synthetic project and verify source-map, Premiere XML, and editor packet export. Optional: --duration=<sec> --keep.
          studio-synthetic-smoke
                            Build a temporary synthetic project and verify source-map, render/package, final media, and editor packet export. Optional: --duration=<sec> --keep.
          studio-acceptance-smoke
                            Verify Codex App Server initialize plus the full temporary synthetic studio render/package/editor-packet loop. Optional: --duration=<sec> --keep.
          app-server-smoke  Start Codex App Server and run initialize handshake.
          thread-smoke      Start an ephemeral Codex thread and read it back.
          turn-smoke        Start a read-only Codex turn and wait for completion.
        """)
    }

    private static func resolveProject(root: URL, args: [String]) throws -> ProjectSummary {
        let projects = ProjectScanner.scanProjects(in: root)
        if let raw = args.first {
            if let project = projects.first(where: { $0.id == raw || $0.path.path == raw }) {
                return project
            }

            let url = URL(fileURLWithPath: raw, relativeTo: root).standardizedFileURL
            if let project = projects.first(where: { $0.path.standardizedFileURL == url }) {
                return project
            }
            if let project = ProjectScanner.summarizeProject(at: URL(fileURLWithPath: (raw as NSString).expandingTildeInPath, relativeTo: root)) {
                return project
            }
            throw CLIError.message("project not found: \(raw)")
        }

        guard let project = projects.first else {
            throw CLIError.message("no projects found under \(root.appendingPathComponent("projects").path)")
        }
        return project
    }

    private static func resolvePathArgument(_ value: String, root: URL) -> URL {
        if value.hasPrefix("/") {
            return URL(fileURLWithPath: value).standardizedFileURL
        }
        return root.appendingPathComponent(value).standardizedFileURL
    }

    private static func durationArgument(_ args: [String]) -> Double? {
        args.first { $0.hasPrefix("--duration=") }
            .map { String($0.dropFirst("--duration=".count)) }
            .flatMap(Double.init)
    }

    private static func intOption(_ args: [String], name: String) -> Int? {
        let prefix = "--\(name)="
        return args.first { $0.hasPrefix(prefix) }
            .map { String($0.dropFirst(prefix.count)) }
            .flatMap(Int.init)
    }

    private static func marlinRequestTimeoutMs(from args: [String]) throws -> Int? {
        guard let raw = try valueOption(
            args,
            names: ["--request-timeout-ms", "--timeout-ms"],
            errorLabel: "--request-timeout-ms"
        ) else {
            return nil
        }
        guard let value = Int(raw), value > 0 else {
            throw CLIError.message("--request-timeout-ms requires a positive integer millisecond value")
        }
        return value
    }

    private static func marlinMaxSources(from args: [String]) throws -> Int? {
        guard let raw = try valueOption(
            args,
            names: ["--max-sources"],
            errorLabel: "--max-sources"
        ) else {
            return nil
        }
        guard let value = Int(raw), value > 0 else {
            throw CLIError.message("--max-sources requires a positive integer value")
        }
        return value
    }

    private static func marlinChunkSeconds(from args: [String]) throws -> Int? {
        try positiveIntegerOption(args, name: "--chunk-seconds")
    }

    private static func marlinChunkOverlapSeconds(from args: [String]) throws -> Int? {
        guard let raw = try valueOption(
            args,
            names: ["--chunk-overlap-seconds"],
            errorLabel: "--chunk-overlap-seconds"
        ) else {
            return nil
        }
        guard let value = Int(raw), value >= 0 else {
            throw CLIError.message("--chunk-overlap-seconds requires a non-negative integer value")
        }
        return value
    }

    private static func marlinMaxChunks(from args: [String]) throws -> Int? {
        try positiveIntegerOption(args, name: "--max-chunks")
    }

    private static func positiveIntegerOption(_ args: [String], name: String) throws -> Int? {
        guard let raw = try valueOption(
            args,
            names: [name],
            errorLabel: name
        ) else {
            return nil
        }
        guard let value = Int(raw), value > 0 else {
            throw CLIError.message("\(name) requires a positive integer value")
        }
        return value
    }

    private static func valueOption(_ args: [String], names: Set<String>, errorLabel: String) throws -> String? {
        for name in names {
            let prefix = "\(name)="
            if let inline = args.first(where: { $0.hasPrefix(prefix) }) {
                return String(inline.dropFirst(prefix.count))
            }
            if let index = args.firstIndex(of: name) {
                guard args.indices.contains(index + 1), !args[index + 1].hasPrefix("--") else {
                    throw CLIError.message("\(errorLabel) requires a value")
                }
                return args[index + 1]
            }
        }
        return nil
    }

    private static func marlinEvaluationProjectArgs(from args: [String]) -> [String] {
        positionalArguments(from: args, valueOptions: [
            "--request-timeout-ms",
            "--timeout-ms",
            "--max-sources",
            "--chunk-seconds",
            "--chunk-overlap-seconds",
            "--max-chunks",
        ])
    }

    private static func positionalArguments(from args: [String], valueOptions: Set<String>) -> [String] {
        var result: [String] = []
        var skipNext = false
        for arg in args {
            if skipNext {
                skipNext = false
                continue
            }
            if valueOptions.contains(arg) {
                skipNext = true
                continue
            }
            if arg.hasPrefix("--") {
                continue
            }
            result.append(arg)
        }
        return result
    }

    private static func sourceDirectoryArgument(_ args: [String]) -> String? {
        if let inline = args.first(where: { $0.hasPrefix("--source-dir=") }) {
            return String(inline.dropFirst("--source-dir=".count))
        }
        guard let index = args.firstIndex(of: "--source-dir"), args.indices.contains(index + 1) else {
            return nil
        }
        return args[index + 1]
    }

    private static func analysisOptions(_ args: [String]) -> ProjectAnalysisRunOptions {
        ProjectAnalysisRunOptions(
            skipSTT: args.contains("--skip-stt"),
            skipVLM: args.contains("--skip-vlm"),
            skipDiarize: args.contains("--skip-diarize"),
            skipPeak: args.contains("--skip-peak"),
            skipMarlin: args.contains("--skip-marlin"),
            skipAppraiser: args.contains("--skip-appraiser"),
            skipMediaLink: args.contains("--skip-media-link"),
            skipPreflight: args.contains("--skip-preflight"),
            language: stringOption("--language", args: args),
            contentHint: stringOption("--content-hint", args: args),
            concurrency: stringOption("--concurrency", args: args).flatMap(Int.init),
            noCache: args.contains("--no-cache"),
            clearCache: args.contains("--clear-cache")
        )
    }

    private static func roughCutCompileOptions(root: URL, projectURL: URL, args: [String]) -> ProjectRoughCutCompileOptions {
        let explicitPatch = stringOption("--patch", args: args).map { resolvePathArgument($0, root: root) }
        let reviewPatch = projectURL.appendingPathComponent("06_review/review_patch.json")
        return ProjectRoughCutCompileOptions(
            patchURL: args.contains("--review-patch") ? reviewPatch : explicitPatch,
            fps: stringOption("--fps", args: args).flatMap(Int.init),
            sourceMapURL: stringOption("--source-map", args: args).map { resolvePathArgument($0, root: root) },
            skipPreview: args.contains("--skip-preview"),
            skipConfirmations: !args.contains("--confirm-brief-defaults")
        )
    }

    private static func renderRunOptions(root: URL, args: [String]) -> ProjectRenderRunOptions {
        ProjectRenderRunOptions(
            skipRender: args.contains("--skip-render"),
            assemblyURL: stringOption("--assembly", args: args).map { resolvePathArgument($0, root: root) },
            suppliedFinalURL: stringOption("--supplied-final", args: args).map { resolvePathArgument($0, root: root) }
        )
    }

    private static func stringOption(_ name: String, args: [String]) -> String? {
        if let inline = args.first(where: { $0.hasPrefix("\(name)=") }) {
            return String(inline.dropFirst(name.count + 1))
        }
        guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else {
            return nil
        }
        return args[index + 1]
    }
}

private enum CLIError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let message):
            return message
        }
    }
}
