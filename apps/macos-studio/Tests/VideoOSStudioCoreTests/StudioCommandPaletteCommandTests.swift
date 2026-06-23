import XCTest
@testable import VideoOSStudioCore

final class StudioCommandPaletteCommandTests: XCTestCase {
    func testCommandCatalogKeepsStableOrderAndIdentifiers() {
        let commands = StudioCommandPaletteCommand.allCases

        XCTAssertEqual(commands.map(\.rawValue), [
            "refresh-projects",
            "new-project-from-source",
            "check-codex-app-server",
            "start-agent-session",
            "stop-agent-session",
            "run-selected-agent-job",
            "run-read-only-agent-turn",
            "approve-pending-agent-job",
            "run-source-analysis",
            "compile-rough-cut",
            "apply-review-patch",
            "search-footage",
            "rebuild-search-index",
            "run-marlin-evaluation",
            "build-audio-story-graph",
            "build-preview-proxies",
            "relink-missing-media",
            "export-premiere-xml",
            "export-editor-packet",
            "render-final-package",
            "run-studio-acceptance-smoke",
            "play-timeline"
        ])
        XCTAssertEqual(Set(commands.map(\.accessibilityIdentifier)).count, commands.count)
        XCTAssertTrue(commands.allSatisfy { $0.accessibilityIdentifier.hasPrefix("CommandPaletteItem.") })
    }

    func testSearchMatchesTitlesSubtitlesAndKeywords() {
        XCTAssertTrue(StudioCommandPaletteCommand.searchFootage.matches(query: "qwen audio"))
        XCTAssertTrue(StudioCommandPaletteCommand.relinkMissingMedia.matches(query: "source map"))
        XCTAssertTrue(StudioCommandPaletteCommand.rebuildSearchIndex.matches(query: "material RAG"))
        XCTAssertTrue(StudioCommandPaletteCommand.renderFinalPackage.matches(query: "final"))
        XCTAssertTrue(StudioCommandPaletteCommand.compileRoughCut.matches(query: "rough cut"))
        XCTAssertTrue(StudioCommandPaletteCommand.applyReviewPatch.matches(
            query: "deterministic compiler",
            subtitle: "Apply review_patch.json through the deterministic compiler."
        ))
        XCTAssertFalse(StudioCommandPaletteCommand.renderFinalPackage.matches(query: "qwen audio"))
    }

    func testPlaybackCommandReflectsCurrentPlaybackState() {
        let command = StudioCommandPaletteCommand.playTimeline

        XCTAssertEqual(command.title(isPlaying: false), "Play Timeline")
        XCTAssertEqual(command.systemImage(isPlaying: false), "play.fill")
        XCTAssertEqual(command.title(isPlaying: true), "Pause Playback")
        XCTAssertEqual(command.systemImage(isPlaying: true), "pause.fill")
        XCTAssertTrue(command.matches(query: "pause", isPlaying: true))
        XCTAssertTrue(command.matches(query: "transport", isPlaying: false))
    }

    func testAgentCommandAvailabilityFollowsSessionLifecycle() {
        let noProject = StudioCommandAvailabilityContext()
        XCTAssertTrue(noProject.isEnabled(.checkCodexAppServer))
        XCTAssertFalse(noProject.isEnabled(.startAgentSession))
        XCTAssertEqual(noProject.disabledReason(for: .startAgentSession), "No project")
        XCTAssertFalse(noProject.isEnabled(.stopAgentSession))
        XCTAssertEqual(noProject.disabledReason(for: .stopAgentSession), "No active thread")

        let readyToStart = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: false,
            hasActiveThread: false,
            selectedAgentJobCanRun: false,
            hasPendingApproval: false
        )
        XCTAssertTrue(readyToStart.isEnabled(.startAgentSession))
        XCTAssertFalse(readyToStart.isEnabled(.runReadOnlyAgentTurn))

        let activeThread = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: false,
            hasActiveThread: true,
            selectedAgentJobCanRun: true,
            hasPendingApproval: true
        )
        XCTAssertFalse(activeThread.isEnabled(.startAgentSession))
        XCTAssertEqual(activeThread.disabledReason(for: .startAgentSession), "Already active")
        XCTAssertTrue(activeThread.isEnabled(.stopAgentSession))
        XCTAssertTrue(activeThread.isEnabled(.runSelectedAgentJob))
        XCTAssertTrue(activeThread.isEnabled(.runReadOnlyAgentTurn))
        XCTAssertTrue(activeThread.isEnabled(.approvePendingAgentJob))

        let checking = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: true,
            hasActiveThread: true,
            selectedAgentJobCanRun: false,
            hasPendingApproval: true
        )
        XCTAssertFalse(checking.isEnabled(.checkCodexAppServer))
        XCTAssertFalse(checking.isEnabled(.startAgentSession))
        XCTAssertTrue(checking.isEnabled(.stopAgentSession))
        XCTAssertFalse(checking.isEnabled(.runReadOnlyAgentTurn))
        XCTAssertFalse(checking.isEnabled(.approvePendingAgentJob))
    }
}
