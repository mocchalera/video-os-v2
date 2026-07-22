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
            "prepare-timeline-agent-prompt",
            "run-agent-tighten-selection",
            "run-agent-shorten-beat",
            "run-agent-find-stronger-alternate",
            "run-agent-explain-cut",
            "approve-pending-agent-job",
            "run-source-analysis",
            "compile-rough-cut",
            "apply-review-patch",
            "open-swap-browser",
            "search-footage",
            "rebuild-search-index",
            "run-marlin-evaluation",
            "build-audio-story-graph",
            "open-bgm-review",
            "build-preview-proxies",
            "relink-missing-media",
            "export-premiere-xml",
            "export-editor-packet",
            "render-final-package",
            "promo-finish",
            "run-studio-acceptance-smoke",
            "play-timeline",
            "play-timeline-reverse",
            "pause-timeline",
            "step-timeline-backward",
            "step-timeline-forward",
            "jump-to-previous-timeline-edit-point",
            "jump-to-next-timeline-edit-point",
            "mark-source-monitor-in-at-playback-time",
            "mark-source-monitor-out-at-playback-time",
            "nudge-source-monitor-mark-in-earlier",
            "nudge-source-monitor-mark-in-later",
            "nudge-source-monitor-mark-out-earlier",
            "nudge-source-monitor-mark-out-later",
            "reset-source-monitor-marked-range",
            "select-previous-source-monitor-candidate",
            "select-next-source-monitor-candidate",
            "insert-source-monitor-at-playhead",
            "append-source-monitor-to-timeline-end",
            "overwrite-source-monitor-at-playhead",
            "replace-selected-clip-with-source-monitor",
            "reveal-selected-clip-in-source-monitor",
            "set-loop-range-to-selection",
            "toggle-loop-playback",
            "clear-loop-range",
            "select-all-timeline-clips",
            "clear-timeline-selection",
            "select-previous-timeline-clip",
            "select-next-timeline-clip",
            "extend-timeline-selection-previous",
            "extend-timeline-selection-next",
            "delete-timeline-selection",
            "apply-default-crossfade-transition",
            "shorten-selected-transition",
            "lengthen-selected-transition",
            "trim-timeline-clip-start-to-playhead",
            "trim-timeline-clip-end-to-playhead",
            "zoom-timeline-out",
            "zoom-timeline-in",
            "fit-timeline-to-window",
            "reset-timeline-zoom",
            "toggle-timeline-snapping",
            "toggle-timeline-blade-mode"
        ])
        XCTAssertEqual(Set(commands.map(\.accessibilityIdentifier)).count, commands.count)
        XCTAssertTrue(commands.allSatisfy { $0.accessibilityIdentifier.hasPrefix("CommandPaletteItem.") })
    }

    func testSearchMatchesTitlesSubtitlesAndKeywords() {
        XCTAssertTrue(StudioCommandPaletteCommand.searchFootage.matches(query: "qwen audio"))
        XCTAssertTrue(StudioCommandPaletteCommand.relinkMissingMedia.matches(query: "source map"))
        XCTAssertTrue(StudioCommandPaletteCommand.rebuildSearchIndex.matches(query: "material RAG"))
        XCTAssertTrue(StudioCommandPaletteCommand.renderFinalPackage.matches(query: "final"))
        XCTAssertTrue(StudioCommandPaletteCommand.promoFinish.matches(query: "テロップ promo"))
        XCTAssertTrue(StudioCommandPaletteCommand.compileRoughCut.matches(query: "rough cut"))
        XCTAssertTrue(StudioCommandPaletteCommand.openSwapBrowser.matches(query: "差替え 候補"))
        XCTAssertTrue(StudioCommandPaletteCommand.openBGMReview.matches(query: "BGM 試聴 権利"))
        XCTAssertTrue(StudioCommandPaletteCommand.applyReviewPatch.matches(
            query: "deterministic compiler",
            subtitle: "Apply review_patch.json through the deterministic compiler."
        ))
        XCTAssertTrue(StudioCommandPaletteCommand.runAgentTightenSelection.matches(query: "agent selection tighten"))
        XCTAssertTrue(StudioCommandPaletteCommand.prepareTimelineAgentPrompt.matches(query: "prompt preview review_patch"))
        XCTAssertTrue(StudioCommandPaletteCommand.prepareTimelineAgentPrompt.matches(query: "AI プロンプト 準備"))
        XCTAssertTrue(StudioCommandPaletteCommand.runAgentShortenBeat.matches(query: "AI ビート 短く"))
        XCTAssertTrue(StudioCommandPaletteCommand.runAgentFindStrongerAlternate.matches(query: "代替 素材"))
        XCTAssertTrue(StudioCommandPaletteCommand.runAgentExplainCut.matches(query: "カット 説明"))
        XCTAssertFalse(StudioCommandPaletteCommand.renderFinalPackage.matches(query: "qwen audio"))
    }

    func testPlaybackCommandReflectsCurrentPlaybackState() {
        let command = StudioCommandPaletteCommand.playTimeline

        XCTAssertEqual(command.title(isPlaying: false), "タイムラインを再生")
        XCTAssertEqual(command.systemImage(isPlaying: false), "play.fill")
        XCTAssertEqual(command.title(isPlaying: true), "再生を一時停止")
        XCTAssertEqual(command.systemImage(isPlaying: true), "pause.fill")
        XCTAssertTrue(command.matches(query: "pause", isPlaying: true))
        XCTAssertTrue(command.matches(query: "再生", isPlaying: false))
        XCTAssertTrue(command.matches(query: "transport", isPlaying: false))
        XCTAssertTrue(command.matches(query: "l", isPlaying: false))
        XCTAssertTrue(command.matches(query: "source monitor play", isPlaying: false))
    }

    func testTransportFrameCommandsExposeProfessionalShortcuts() {
        XCTAssertEqual(StudioCommandPaletteCommand.playTimelineReverse.title(), "逆再生")
        XCTAssertEqual(StudioCommandPaletteCommand.playTimelineReverse.systemImage(), "backward.fill")
        XCTAssertEqual(StudioCommandPaletteCommand.pauseTimeline.title(), "再生を停止")
        XCTAssertEqual(StudioCommandPaletteCommand.pauseTimeline.systemImage(), "stop.fill")
        XCTAssertEqual(StudioCommandPaletteCommand.stepTimelineBackward.title(), "1フレーム戻る")
        XCTAssertEqual(StudioCommandPaletteCommand.stepTimelineForward.title(), "1フレーム進む")
        XCTAssertEqual(StudioCommandPaletteCommand.jumpToPreviousTimelineEditPoint.title(), "前の編集点へ移動")
        XCTAssertEqual(StudioCommandPaletteCommand.jumpToPreviousTimelineEditPoint.systemImage(), "arrow.up.to.line")
        XCTAssertEqual(StudioCommandPaletteCommand.jumpToNextTimelineEditPoint.title(), "次の編集点へ移動")
        XCTAssertEqual(StudioCommandPaletteCommand.jumpToNextTimelineEditPoint.systemImage(), "arrow.down.to.line")
        XCTAssertTrue(StudioCommandPaletteCommand.playTimelineReverse.matches(query: "j reverse"))
        XCTAssertTrue(StudioCommandPaletteCommand.playTimelineReverse.matches(query: "シャトル 逆再生"))
        XCTAssertTrue(StudioCommandPaletteCommand.playTimelineReverse.matches(query: "source monitor j"))
        XCTAssertTrue(StudioCommandPaletteCommand.pauseTimeline.matches(query: "k stop"))
        XCTAssertTrue(StudioCommandPaletteCommand.pauseTimeline.matches(query: "source monitor k"))
        XCTAssertTrue(StudioCommandPaletteCommand.stepTimelineBackward.matches(query: "comma frame"))
        XCTAssertTrue(StudioCommandPaletteCommand.stepTimelineBackward.matches(query: "source monitor comma"))
        XCTAssertFalse(StudioCommandPaletteCommand.stepTimelineBackward.matches(query: "j frame"))
        XCTAssertTrue(StudioCommandPaletteCommand.stepTimelineBackward.matches(query: "コマ送り 戻る"))
        XCTAssertTrue(StudioCommandPaletteCommand.stepTimelineForward.matches(query: "period forward"))
        XCTAssertTrue(StudioCommandPaletteCommand.stepTimelineForward.matches(query: "source monitor period"))
        XCTAssertTrue(StudioCommandPaletteCommand.stepTimelineForward.matches(query: "1フレーム 進む"))
        XCTAssertTrue(StudioCommandPaletteCommand.jumpToPreviousTimelineEditPoint.matches(query: "up edit point"))
        XCTAssertTrue(StudioCommandPaletteCommand.jumpToNextTimelineEditPoint.matches(query: "down marker"))
        XCTAssertTrue(StudioCommandPaletteCommand.jumpToPreviousTimelineEditPoint.matches(query: "前 編集点"))
        XCTAssertTrue(StudioCommandPaletteCommand.jumpToNextTimelineEditPoint.matches(query: "次 マーカー"))
        XCTAssertEqual(StudioCommandPaletteCommand.markSourceMonitorInAtPlaybackTime.title(), "ソースINを現在位置へ")
        XCTAssertEqual(StudioCommandPaletteCommand.markSourceMonitorInAtPlaybackTime.systemImage(), "arrow.down.left.video")
        XCTAssertEqual(StudioCommandPaletteCommand.markSourceMonitorOutAtPlaybackTime.title(), "ソースOUTを現在位置へ")
        XCTAssertTrue(StudioCommandPaletteCommand.markSourceMonitorInAtPlaybackTime.matches(query: "source mark in"))
        XCTAssertTrue(StudioCommandPaletteCommand.markSourceMonitorOutAtPlaybackTime.matches(query: "source mark out"))
        XCTAssertTrue(StudioCommandPaletteCommand.markSourceMonitorInAtPlaybackTime.matches(query: "ソース 現在位置"))
        XCTAssertEqual(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInEarlier.title(), "ソースINを0.5秒前へ")
        XCTAssertEqual(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInEarlier.systemImage(), "arrow.left.to.line")
        XCTAssertEqual(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInLater.title(), "ソースINを0.5秒後ろへ")
        XCTAssertEqual(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutEarlier.title(), "ソースOUTを0.5秒前へ")
        XCTAssertEqual(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutLater.title(), "ソースOUTを0.5秒後ろへ")
        XCTAssertEqual(StudioCommandPaletteCommand.resetSourceMonitorMarkedRange.title(), "ソース範囲をリセット")
        XCTAssertEqual(StudioCommandPaletteCommand.resetSourceMonitorMarkedRange.systemImage(), "arrow.counterclockwise")
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInEarlier.matches(query: "source in nudge earlier"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInLater.matches(query: "source in nudge later"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutEarlier.matches(query: "source out nudge earlier"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutLater.matches(query: "source out nudge later"))
        XCTAssertTrue(StudioCommandPaletteCommand.resetSourceMonitorMarkedRange.matches(query: "source range reset"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInEarlier.matches(query: "option ["))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInLater.matches(query: "option ]"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutEarlier.matches(query: "shift option ["))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutLater.matches(query: "shift option ]"))
        XCTAssertTrue(StudioCommandPaletteCommand.resetSourceMonitorMarkedRange.matches(query: "shift r"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkInEarlier.matches(query: "ソース IN 前"))
        XCTAssertTrue(StudioCommandPaletteCommand.nudgeSourceMonitorMarkOutLater.matches(query: "ソース OUT 後ろ"))
        XCTAssertTrue(StudioCommandPaletteCommand.resetSourceMonitorMarkedRange.matches(query: "ソース 範囲 リセット"))
        XCTAssertEqual(StudioCommandPaletteCommand.selectPreviousSourceMonitorCandidate.title(), "前のソース候補")
        XCTAssertEqual(StudioCommandPaletteCommand.selectPreviousSourceMonitorCandidate.systemImage(), "chevron.left.square")
        XCTAssertEqual(StudioCommandPaletteCommand.selectNextSourceMonitorCandidate.title(), "次のソース候補")
        XCTAssertEqual(StudioCommandPaletteCommand.selectNextSourceMonitorCandidate.systemImage(), "chevron.right.square")
        XCTAssertTrue(StudioCommandPaletteCommand.selectPreviousSourceMonitorCandidate.matches(query: "source candidate previous ["))
        XCTAssertTrue(StudioCommandPaletteCommand.selectNextSourceMonitorCandidate.matches(query: "source candidate next ]"))
        XCTAssertTrue(StudioCommandPaletteCommand.selectPreviousSourceMonitorCandidate.matches(query: "ソース 候補 前"))
        XCTAssertTrue(StudioCommandPaletteCommand.selectNextSourceMonitorCandidate.matches(query: "ソース 候補 次"))
        XCTAssertEqual(StudioCommandPaletteCommand.insertSourceMonitorAtPlayhead.title(), "ソースを再生位置へ追加")
        XCTAssertEqual(StudioCommandPaletteCommand.insertSourceMonitorAtPlayhead.systemImage(), "plus.rectangle.on.rectangle")
        XCTAssertEqual(StudioCommandPaletteCommand.appendSourceMonitorToTimelineEnd.title(), "ソースを末尾へ追加")
        XCTAssertEqual(StudioCommandPaletteCommand.appendSourceMonitorToTimelineEnd.systemImage(), "text.append")
        XCTAssertEqual(StudioCommandPaletteCommand.overwriteSourceMonitorAtPlayhead.title(), "ソースで上書き")
        XCTAssertEqual(StudioCommandPaletteCommand.overwriteSourceMonitorAtPlayhead.systemImage(), "square.and.arrow.down.on.square")
        XCTAssertEqual(StudioCommandPaletteCommand.replaceSelectedClipWithSourceMonitor.title(), "選択クリップをソースで置換")
        XCTAssertEqual(StudioCommandPaletteCommand.replaceSelectedClipWithSourceMonitor.systemImage(), "arrow.triangle.2.circlepath")
        XCTAssertEqual(StudioCommandPaletteCommand.revealSelectedClipInSourceMonitor.title(), "選択クリップをソース確認")
        XCTAssertEqual(StudioCommandPaletteCommand.revealSelectedClipInSourceMonitor.systemImage(), "scope")
        XCTAssertTrue(StudioCommandPaletteCommand.insertSourceMonitorAtPlayhead.matches(query: "source insert w"))
        XCTAssertTrue(StudioCommandPaletteCommand.appendSourceMonitorToTimelineEnd.matches(query: "source append e"))
        XCTAssertTrue(StudioCommandPaletteCommand.appendSourceMonitorToTimelineEnd.matches(query: "末尾 追加"))
        XCTAssertTrue(StudioCommandPaletteCommand.overwriteSourceMonitorAtPlayhead.matches(query: "source overwrite d"))
        XCTAssertTrue(StudioCommandPaletteCommand.replaceSelectedClipWithSourceMonitor.matches(query: "source replace r"))
        XCTAssertTrue(StudioCommandPaletteCommand.revealSelectedClipInSourceMonitor.matches(query: "match frame source"))
        XCTAssertTrue(StudioCommandPaletteCommand.revealSelectedClipInSourceMonitor.matches(query: "元素材 確認"))
        XCTAssertTrue(StudioCommandPaletteCommand.insertSourceMonitorAtPlayhead.matches(query: "ソース 追加"))
        XCTAssertTrue(StudioCommandPaletteCommand.overwriteSourceMonitorAtPlayhead.matches(query: "ソース 上書き"))
        XCTAssertTrue(StudioCommandPaletteCommand.replaceSelectedClipWithSourceMonitor.matches(query: "ソース 置換"))
        XCTAssertEqual(StudioCommandPaletteCommand.setLoopRangeToSelection.title(), "選択範囲をループ")
        XCTAssertEqual(StudioCommandPaletteCommand.setLoopRangeToSelection.systemImage(), "repeat.circle")
        XCTAssertEqual(StudioCommandPaletteCommand.toggleLoopPlayback.title(), "ループ再生をオン/オフ")
        XCTAssertEqual(StudioCommandPaletteCommand.clearLoopRange.title(), "ループ範囲を解除")
        XCTAssertTrue(StudioCommandPaletteCommand.setLoopRangeToSelection.matches(query: "r loop selection"))
        XCTAssertTrue(StudioCommandPaletteCommand.setLoopRangeToSelection.matches(query: "transition loop"))
        XCTAssertTrue(StudioCommandPaletteCommand.setLoopRangeToSelection.matches(query: "複数 トランジション"))
        XCTAssertTrue(StudioCommandPaletteCommand.toggleLoopPlayback.matches(query: "ループ 繰り返し"))
        XCTAssertTrue(StudioCommandPaletteCommand.clearLoopRange.matches(query: "loop clear"))
        XCTAssertEqual(StudioCommandPaletteCommand.selectAllTimelineClips.title(), "タイムラインを全選択")
        XCTAssertEqual(StudioCommandPaletteCommand.selectAllTimelineClips.systemImage(), "rectangle.3.group")
        XCTAssertTrue(StudioCommandPaletteCommand.selectAllTimelineClips.matches(query: "command a select all"))
        XCTAssertTrue(StudioCommandPaletteCommand.selectAllTimelineClips.matches(query: "全選択 クリップ"))
        XCTAssertEqual(StudioCommandPaletteCommand.clearTimelineSelection.title(), "タイムライン選択を解除")
        XCTAssertEqual(StudioCommandPaletteCommand.clearTimelineSelection.systemImage(), "xmark.circle")
        XCTAssertTrue(StudioCommandPaletteCommand.clearTimelineSelection.matches(query: "esc clear selection"))
        XCTAssertTrue(StudioCommandPaletteCommand.clearTimelineSelection.matches(query: "選択解除 ツール"))
        XCTAssertEqual(StudioCommandPaletteCommand.selectPreviousTimelineClip.title(), "前のクリップを選択")
        XCTAssertEqual(StudioCommandPaletteCommand.selectPreviousTimelineClip.systemImage(), "arrow.left.to.line")
        XCTAssertEqual(StudioCommandPaletteCommand.selectNextTimelineClip.title(), "次のクリップを選択")
        XCTAssertTrue(StudioCommandPaletteCommand.selectPreviousTimelineClip.matches(query: "left arrow previous"))
        XCTAssertTrue(StudioCommandPaletteCommand.selectNextTimelineClip.matches(query: "right arrow next"))
        XCTAssertEqual(StudioCommandPaletteCommand.extendTimelineSelectionPrevious.title(), "前へ範囲選択")
        XCTAssertEqual(StudioCommandPaletteCommand.extendTimelineSelectionNext.title(), "次へ範囲選択")
        XCTAssertTrue(StudioCommandPaletteCommand.extendTimelineSelectionPrevious.matches(query: "shift left extend"))
        XCTAssertTrue(StudioCommandPaletteCommand.extendTimelineSelectionNext.matches(query: "shift right 範囲選択"))
        XCTAssertEqual(StudioCommandPaletteCommand.deleteTimelineSelection.title(), "選択項目を削除")
        XCTAssertEqual(StudioCommandPaletteCommand.deleteTimelineSelection.systemImage(), "trash")
        XCTAssertTrue(StudioCommandPaletteCommand.deleteTimelineSelection.matches(query: "delete backspace ripple"))
        XCTAssertTrue(StudioCommandPaletteCommand.deleteTimelineSelection.matches(query: "lift cross-track delete"))
        XCTAssertTrue(StudioCommandPaletteCommand.deleteTimelineSelection.matches(query: "削除 トランジション"))
        XCTAssertTrue(StudioCommandPaletteCommand.deleteTimelineSelection.matches(query: "複数トラック 削除"))
        XCTAssertEqual(StudioCommandPaletteCommand.applyDefaultCrossfadeTransition.title(), "クロスフェードを適用")
        XCTAssertEqual(StudioCommandPaletteCommand.applyDefaultCrossfadeTransition.systemImage(), "rectangle.on.rectangle")
        XCTAssertTrue(StudioCommandPaletteCommand.applyDefaultCrossfadeTransition.matches(query: "command t crossfade"))
        XCTAssertTrue(StudioCommandPaletteCommand.applyDefaultCrossfadeTransition.matches(query: "default transition"))
        XCTAssertTrue(StudioCommandPaletteCommand.applyDefaultCrossfadeTransition.matches(query: "クロスフェード 編集点"))
        XCTAssertEqual(StudioCommandPaletteCommand.shortenSelectedTransition.title(), "トランジションを短く")
        XCTAssertEqual(StudioCommandPaletteCommand.shortenSelectedTransition.systemImage(), "minus")
        XCTAssertEqual(StudioCommandPaletteCommand.lengthenSelectedTransition.title(), "トランジションを長く")
        XCTAssertEqual(StudioCommandPaletteCommand.lengthenSelectedTransition.systemImage(), "plus")
        XCTAssertTrue(StudioCommandPaletteCommand.shortenSelectedTransition.matches(query: "transition duration shorten"))
        XCTAssertTrue(StudioCommandPaletteCommand.lengthenSelectedTransition.matches(query: "transition duration lengthen"))
        XCTAssertTrue(StudioCommandPaletteCommand.shortenSelectedTransition.matches(query: "トランジション 短く"))
        XCTAssertTrue(StudioCommandPaletteCommand.lengthenSelectedTransition.matches(query: "トランジション 長く"))
        XCTAssertEqual(StudioCommandPaletteCommand.trimTimelineClipStartToPlayhead.title(), "先頭を再生位置へトリム")
        XCTAssertEqual(StudioCommandPaletteCommand.trimTimelineClipStartToPlayhead.systemImage(), "arrow.right.to.line")
        XCTAssertEqual(StudioCommandPaletteCommand.trimTimelineClipEndToPlayhead.title(), "末尾を再生位置へトリム")
        XCTAssertEqual(StudioCommandPaletteCommand.trimTimelineClipEndToPlayhead.systemImage(), "arrow.left.to.line")
        XCTAssertTrue(StudioCommandPaletteCommand.trimTimelineClipStartToPlayhead.matches(query: "q trim playhead"))
        XCTAssertTrue(StudioCommandPaletteCommand.trimTimelineClipEndToPlayhead.matches(query: "w trim playhead"))
        XCTAssertTrue(StudioCommandPaletteCommand.trimTimelineClipStartToPlayhead.matches(query: "先頭 再生位置"))
        XCTAssertTrue(StudioCommandPaletteCommand.trimTimelineClipEndToPlayhead.matches(query: "末尾 再生位置"))
        XCTAssertEqual(StudioCommandPaletteCommand.zoomTimelineOut.title(), "タイムラインを縮小")
        XCTAssertEqual(StudioCommandPaletteCommand.zoomTimelineIn.systemImage(), "plus.magnifyingglass")
        XCTAssertEqual(StudioCommandPaletteCommand.fitTimelineToWindow.title(), "タイムライン全体を表示")
        XCTAssertEqual(StudioCommandPaletteCommand.resetTimelineZoom.title(), "タイムライン100%")
        XCTAssertTrue(StudioCommandPaletteCommand.zoomTimelineOut.matches(query: "timeline zoom out"))
        XCTAssertTrue(StudioCommandPaletteCommand.zoomTimelineIn.matches(query: "ズーム 拡大"))
        XCTAssertTrue(StudioCommandPaletteCommand.fitTimelineToWindow.matches(query: "fit 全体"))
        XCTAssertTrue(StudioCommandPaletteCommand.resetTimelineZoom.matches(query: "reset 100"))
        XCTAssertEqual(StudioCommandPaletteCommand.toggleTimelineSnapping.title(), "吸着をオン/オフ")
        XCTAssertEqual(StudioCommandPaletteCommand.toggleTimelineSnapping.systemImage(), "magnet")
        XCTAssertTrue(StudioCommandPaletteCommand.toggleTimelineSnapping.matches(query: "n snap magnet"))
        XCTAssertTrue(StudioCommandPaletteCommand.toggleTimelineSnapping.matches(query: "吸着 スナップ"))
        XCTAssertEqual(StudioCommandPaletteCommand.toggleTimelineBladeMode.title(), "ブレードをオン/オフ")
        XCTAssertEqual(StudioCommandPaletteCommand.toggleTimelineBladeMode.systemImage(), "scissors")
        XCTAssertTrue(StudioCommandPaletteCommand.toggleTimelineBladeMode.matches(query: "b blade split"))
        XCTAssertTrue(StudioCommandPaletteCommand.toggleTimelineBladeMode.matches(query: "ブレード 分割"))
    }

    func testAgentCommandAvailabilityFollowsSessionLifecycle() {
        let noProject = StudioCommandAvailabilityContext()
        XCTAssertTrue(noProject.isEnabled(.checkCodexAppServer))
        XCTAssertFalse(noProject.isEnabled(.startAgentSession))
        XCTAssertEqual(noProject.disabledReason(for: .startAgentSession), "プロジェクト未選択")
        XCTAssertFalse(noProject.isEnabled(.stopAgentSession))
        XCTAssertEqual(noProject.disabledReason(for: .stopAgentSession), "有効なスレッドがありません")

        let readyToStart = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: false,
            hasActiveThread: false,
            selectedAgentJobCanRun: false,
            hasPendingApproval: false,
            hasSelectedTimelineClip: false
        )
        XCTAssertTrue(readyToStart.isEnabled(.startAgentSession))
        XCTAssertFalse(readyToStart.isEnabled(.runReadOnlyAgentTurn))
        XCTAssertFalse(readyToStart.isEnabled(.openSwapBrowser))
        XCTAssertEqual(readyToStart.disabledReason(for: .openSwapBrowser), "クリップ未選択")

        let projectWithCurrentClip = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: false,
            hasActiveThread: false,
            selectedAgentJobCanRun: false,
            hasPendingApproval: false,
            hasSelectedTimelineClip: true
        )
        XCTAssertTrue(projectWithCurrentClip.isEnabled(.openSwapBrowser))
        XCTAssertNil(projectWithCurrentClip.disabledReason(for: .openSwapBrowser))

        let activeThread = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: false,
            hasActiveThread: true,
            selectedAgentJobCanRun: true,
            hasPendingApproval: true,
            hasSelectedTimelineClip: true
        )
        XCTAssertFalse(activeThread.isEnabled(.startAgentSession))
        XCTAssertEqual(activeThread.disabledReason(for: .startAgentSession), "すでに接続中")
        XCTAssertTrue(activeThread.isEnabled(.stopAgentSession))
        XCTAssertTrue(activeThread.isEnabled(.runSelectedAgentJob))
        XCTAssertTrue(activeThread.isEnabled(.runReadOnlyAgentTurn))
        XCTAssertTrue(activeThread.isEnabled(.approvePendingAgentJob))
        XCTAssertTrue(activeThread.isEnabled(.openSwapBrowser))

        let checking = StudioCommandAvailabilityContext(
            hasSelectedProject: true,
            isAppServerChecking: true,
            hasActiveThread: true,
            selectedAgentJobCanRun: false,
            hasPendingApproval: true,
            hasSelectedTimelineClip: true
        )
        XCTAssertFalse(checking.isEnabled(.checkCodexAppServer))
        XCTAssertFalse(checking.isEnabled(.startAgentSession))
        XCTAssertTrue(checking.isEnabled(.stopAgentSession))
        XCTAssertFalse(checking.isEnabled(.runReadOnlyAgentTurn))
        XCTAssertFalse(checking.isEnabled(.approvePendingAgentJob))
    }
}
