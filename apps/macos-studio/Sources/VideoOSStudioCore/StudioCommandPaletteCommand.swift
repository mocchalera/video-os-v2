import Foundation

public enum StudioCommandPaletteCommand: String, CaseIterable, Identifiable, Sendable {
    case refreshProjects = "refresh-projects"
    case newProjectFromSource = "new-project-from-source"
    case checkCodexAppServer = "check-codex-app-server"
    case startAgentSession = "start-agent-session"
    case stopAgentSession = "stop-agent-session"
    case runSelectedAgentJob = "run-selected-agent-job"
    case runReadOnlyAgentTurn = "run-read-only-agent-turn"
    case approvePendingAgentJob = "approve-pending-agent-job"
    case runSourceAnalysis = "run-source-analysis"
    case compileRoughCut = "compile-rough-cut"
    case applyReviewPatch = "apply-review-patch"
    case searchFootage = "search-footage"
    case rebuildSearchIndex = "rebuild-search-index"
    case runMarlinEvaluation = "run-marlin-evaluation"
    case buildAudioStoryGraph = "build-audio-story-graph"
    case buildPreviewProxies = "build-preview-proxies"
    case relinkMissingMedia = "relink-missing-media"
    case exportPremiereXML = "export-premiere-xml"
    case exportEditorPacket = "export-editor-packet"
    case renderFinalPackage = "render-final-package"
    case runStudioAcceptanceSmoke = "run-studio-acceptance-smoke"
    case playTimeline = "play-timeline"

    public var id: String { rawValue }

    public func title(isPlaying: Bool = false) -> String {
        switch self {
        case .refreshProjects:
            return "Refresh Projects"
        case .newProjectFromSource:
            return "New Project from Source"
        case .checkCodexAppServer:
            return "Check Codex App Server"
        case .startAgentSession:
            return "Start Agent Session"
        case .stopAgentSession:
            return "Stop Agent Session"
        case .runSelectedAgentJob:
            return "Run Selected Agent Job"
        case .runReadOnlyAgentTurn:
            return "Run Read-Only Agent Turn"
        case .approvePendingAgentJob:
            return "Approve Pending Agent Job"
        case .runSourceAnalysis:
            return "Run Source Analysis"
        case .compileRoughCut:
            return "Compile Rough Cut"
        case .applyReviewPatch:
            return "Apply Review Patch"
        case .searchFootage:
            return "Search Footage"
        case .rebuildSearchIndex:
            return "Rebuild Search Index"
        case .runMarlinEvaluation:
            return "Run Marlin Evaluation"
        case .buildAudioStoryGraph:
            return "Build Audio Story Graph"
        case .buildPreviewProxies:
            return "Build Preview Proxies"
        case .relinkMissingMedia:
            return "Relink Missing Media"
        case .exportPremiereXML:
            return "Export Premiere XML"
        case .exportEditorPacket:
            return "Export Editor Packet"
        case .renderFinalPackage:
            return "Render Final Package"
        case .runStudioAcceptanceSmoke:
            return "Run Studio Acceptance Smoke"
        case .playTimeline:
            return isPlaying ? "Pause Playback" : "Play Timeline"
        }
    }

    public func systemImage(isPlaying: Bool = false) -> String {
        switch self {
        case .refreshProjects:
            return "arrow.clockwise"
        case .newProjectFromSource:
            return "folder.badge.plus"
        case .checkCodexAppServer:
            return "network"
        case .startAgentSession:
            return "play.circle"
        case .stopAgentSession:
            return "stop.circle"
        case .runSelectedAgentJob:
            return "sparkles"
        case .runReadOnlyAgentTurn:
            return "text.bubble"
        case .approvePendingAgentJob:
            return "checkmark.shield"
        case .runSourceAnalysis:
            return "waveform.path.ecg"
        case .compileRoughCut:
            return "timeline.selection"
        case .applyReviewPatch:
            return "wrench.and.screwdriver"
        case .searchFootage:
            return "waveform.badge.magnifyingglass"
        case .rebuildSearchIndex:
            return "magnifyingglass.circle"
        case .runMarlinEvaluation:
            return "sparkles.tv"
        case .buildAudioStoryGraph:
            return "waveform.badge.magnifyingglass"
        case .buildPreviewProxies:
            return "film.stack"
        case .relinkMissingMedia:
            return "link"
        case .exportPremiereXML:
            return "square.and.arrow.up"
        case .exportEditorPacket:
            return "shippingbox"
        case .renderFinalPackage:
            return "film"
        case .runStudioAcceptanceSmoke:
            return "checkmark.shield"
        case .playTimeline:
            return isPlaying ? "pause.fill" : "play.fill"
        }
    }

    public var keywords: [String] {
        switch self {
        case .refreshProjects:
            return ["project", "reload", "status"]
        case .newProjectFromSource:
            return ["import", "source", "ingest"]
        case .checkCodexAppServer:
            return ["agent", "runtime", "codex"]
        case .startAgentSession:
            return ["codex", "thread", "agent"]
        case .stopAgentSession:
            return ["codex", "thread", "agent"]
        case .runSelectedAgentJob:
            return ["codex", "job", "approval"]
        case .runReadOnlyAgentTurn:
            return ["codex", "prompt", "read only"]
        case .approvePendingAgentJob:
            return ["approval", "write", "codex"]
        case .runSourceAnalysis:
            return ["analysis", "ingest", "source"]
        case .compileRoughCut:
            return ["compile", "timeline", "rough cut"]
        case .applyReviewPatch:
            return ["review", "patch", "compile"]
        case .searchFootage:
            return ["footage", "visual", "audio", "qwen", "clap", "search"]
        case .rebuildSearchIndex:
            return ["rag", "sqlite", "material", "search"]
        case .runMarlinEvaluation:
            return ["vlm", "marlin", "temporal"]
        case .buildAudioStoryGraph:
            return ["audio", "story", "bgm"]
        case .buildPreviewProxies:
            return ["media", "proxy", "preview"]
        case .relinkMissingMedia:
            return ["media", "source map", "relink"]
        case .exportPremiereXML:
            return ["handoff", "premiere", "xml"]
        case .exportEditorPacket:
            return ["handoff", "packet", "editor"]
        case .renderFinalPackage:
            return ["render", "package", "final"]
        case .runStudioAcceptanceSmoke:
            return ["smoke", "acceptance", "codex"]
        case .playTimeline:
            return ["transport", "viewer", "timeline", "play", "pause"]
        }
    }

    public var accessibilityIdentifier: String {
        "CommandPaletteItem.\(rawValue)"
    }

    public func searchText(
        title: String? = nil,
        subtitle: String = "",
        isPlaying: Bool = false
    ) -> String {
        ([title ?? self.title(isPlaying: isPlaying), subtitle] + keywords).joined(separator: " ")
    }

    public func matches(
        query: String,
        title: String? = nil,
        subtitle: String = "",
        isPlaying: Bool = false
    ) -> Bool {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return true }
        let searchable = searchText(title: title, subtitle: subtitle, isPlaying: isPlaying)
        let tokens = normalized.split(whereSeparator: \.isWhitespace)
        return tokens.allSatisfy { token in
            searchable.localizedCaseInsensitiveContains(String(token))
        }
    }
}
