import Foundation

public enum StudioCommandPaletteCommand: String, CaseIterable, Identifiable, Sendable {
    case refreshProjects = "refresh-projects"
    case newProjectFromSource = "new-project-from-source"
    case checkCodexAppServer = "check-codex-app-server"
    case startAgentSession = "start-agent-session"
    case stopAgentSession = "stop-agent-session"
    case runSelectedAgentJob = "run-selected-agent-job"
    case runReadOnlyAgentTurn = "run-read-only-agent-turn"
    case prepareTimelineAgentPrompt = "prepare-timeline-agent-prompt"
    case runAgentTightenSelection = "run-agent-tighten-selection"
    case runAgentShortenBeat = "run-agent-shorten-beat"
    case runAgentFindStrongerAlternate = "run-agent-find-stronger-alternate"
    case runAgentExplainCut = "run-agent-explain-cut"
    case approvePendingAgentJob = "approve-pending-agent-job"
    case runSourceAnalysis = "run-source-analysis"
    case compileRoughCut = "compile-rough-cut"
    case applyReviewPatch = "apply-review-patch"
    case openSwapBrowser = "open-swap-browser"
    case searchFootage = "search-footage"
    case rebuildSearchIndex = "rebuild-search-index"
    case runMarlinEvaluation = "run-marlin-evaluation"
    case buildAudioStoryGraph = "build-audio-story-graph"
    case openBGMReview = "open-bgm-review"
    case buildPreviewProxies = "build-preview-proxies"
    case relinkMissingMedia = "relink-missing-media"
    case exportPremiereXML = "export-premiere-xml"
    case exportEditorPacket = "export-editor-packet"
    case renderFinalPackage = "render-final-package"
    case promoFinish = "promo-finish"
    case runStudioAcceptanceSmoke = "run-studio-acceptance-smoke"
    case playTimeline = "play-timeline"
    case playTimelineReverse = "play-timeline-reverse"
    case pauseTimeline = "pause-timeline"
    case stepTimelineBackward = "step-timeline-backward"
    case stepTimelineForward = "step-timeline-forward"
    case jumpToPreviousTimelineEditPoint = "jump-to-previous-timeline-edit-point"
    case jumpToNextTimelineEditPoint = "jump-to-next-timeline-edit-point"
    case markSourceMonitorInAtPlaybackTime = "mark-source-monitor-in-at-playback-time"
    case markSourceMonitorOutAtPlaybackTime = "mark-source-monitor-out-at-playback-time"
    case nudgeSourceMonitorMarkInEarlier = "nudge-source-monitor-mark-in-earlier"
    case nudgeSourceMonitorMarkInLater = "nudge-source-monitor-mark-in-later"
    case nudgeSourceMonitorMarkOutEarlier = "nudge-source-monitor-mark-out-earlier"
    case nudgeSourceMonitorMarkOutLater = "nudge-source-monitor-mark-out-later"
    case resetSourceMonitorMarkedRange = "reset-source-monitor-marked-range"
    case selectPreviousSourceMonitorCandidate = "select-previous-source-monitor-candidate"
    case selectNextSourceMonitorCandidate = "select-next-source-monitor-candidate"
    case insertSourceMonitorAtPlayhead = "insert-source-monitor-at-playhead"
    case appendSourceMonitorToTimelineEnd = "append-source-monitor-to-timeline-end"
    case overwriteSourceMonitorAtPlayhead = "overwrite-source-monitor-at-playhead"
    case replaceSelectedClipWithSourceMonitor = "replace-selected-clip-with-source-monitor"
    case revealSelectedClipInSourceMonitor = "reveal-selected-clip-in-source-monitor"
    case setLoopRangeToSelection = "set-loop-range-to-selection"
    case toggleLoopPlayback = "toggle-loop-playback"
    case clearLoopRange = "clear-loop-range"
    case selectAllTimelineClips = "select-all-timeline-clips"
    case clearTimelineSelection = "clear-timeline-selection"
    case selectPreviousTimelineClip = "select-previous-timeline-clip"
    case selectNextTimelineClip = "select-next-timeline-clip"
    case extendTimelineSelectionPrevious = "extend-timeline-selection-previous"
    case extendTimelineSelectionNext = "extend-timeline-selection-next"
    case deleteTimelineSelection = "delete-timeline-selection"
    case applyDefaultCrossfadeTransition = "apply-default-crossfade-transition"
    case shortenSelectedTransition = "shorten-selected-transition"
    case lengthenSelectedTransition = "lengthen-selected-transition"
    case trimTimelineClipStartToPlayhead = "trim-timeline-clip-start-to-playhead"
    case trimTimelineClipEndToPlayhead = "trim-timeline-clip-end-to-playhead"
    case zoomTimelineOut = "zoom-timeline-out"
    case zoomTimelineIn = "zoom-timeline-in"
    case fitTimelineToWindow = "fit-timeline-to-window"
    case resetTimelineZoom = "reset-timeline-zoom"
    case toggleTimelineSnapping = "toggle-timeline-snapping"
    case toggleTimelineBladeMode = "toggle-timeline-blade-mode"

    public var id: String { rawValue }

    public func title(isPlaying: Bool = false) -> String {
        switch self {
        case .refreshProjects:
            return "プロジェクトを更新"
        case .newProjectFromSource:
            return "素材から新規プロジェクト"
        case .checkCodexAppServer:
            return "Codex接続を確認"
        case .startAgentSession:
            return "エージェントセッションを開始"
        case .stopAgentSession:
            return "セッションを停止"
        case .runSelectedAgentJob:
            return "選択中のジョブを実行"
        case .runReadOnlyAgentTurn:
            return "読み取り専用で相談"
        case .prepareTimelineAgentPrompt:
            return "AI相談プロンプトを準備"
        case .runAgentTightenSelection:
            return "AIに選択範囲を短く相談"
        case .runAgentShortenBeat:
            return "AIにこのビートを短く相談"
        case .runAgentFindStrongerAlternate:
            return "AIに代替素材を相談"
        case .runAgentExplainCut:
            return "AIにカットを説明させる"
        case .approvePendingAgentJob:
            return "保留中ジョブを承認"
        case .runSourceAnalysis:
            return "素材解析を実行"
        case .compileRoughCut:
            return "粗編集を生成"
        case .applyReviewPatch:
            return "レビュー修正を反映"
        case .openSwapBrowser:
            return "差し替え候補を開く"
        case .searchFootage:
            return "素材を検索"
        case .rebuildSearchIndex:
            return "検索インデックスを再構築"
        case .runMarlinEvaluation:
            return "Marlin評価を実行"
        case .buildAudioStoryGraph:
            return "音声ストーリーを構築"
        case .openBGMReview:
            return "BGM試聴・レビューを開く"
        case .buildPreviewProxies:
            return "プレビュー素材を作成"
        case .relinkMissingMedia:
            return "未リンク素材を再接続"
        case .exportPremiereXML:
            return "Premiere XMLを書き出し"
        case .exportEditorPacket:
            return "編集者パケットを書き出し"
        case .renderFinalPackage:
            return "最終動画を書き出し"
        case .promoFinish:
            return "宣材テロップ仕上げ"
        case .runStudioAcceptanceSmoke:
            return "受け入れチェックを実行"
        case .playTimeline:
            return isPlaying ? "再生を一時停止" : "タイムラインを再生"
        case .playTimelineReverse:
            return "逆再生"
        case .pauseTimeline:
            return "再生を停止"
        case .stepTimelineBackward:
            return "1フレーム戻る"
        case .stepTimelineForward:
            return "1フレーム進む"
        case .jumpToPreviousTimelineEditPoint:
            return "前の編集点へ移動"
        case .jumpToNextTimelineEditPoint:
            return "次の編集点へ移動"
        case .markSourceMonitorInAtPlaybackTime:
            return "ソースINを現在位置へ"
        case .markSourceMonitorOutAtPlaybackTime:
            return "ソースOUTを現在位置へ"
        case .nudgeSourceMonitorMarkInEarlier:
            return "ソースINを0.5秒前へ"
        case .nudgeSourceMonitorMarkInLater:
            return "ソースINを0.5秒後ろへ"
        case .nudgeSourceMonitorMarkOutEarlier:
            return "ソースOUTを0.5秒前へ"
        case .nudgeSourceMonitorMarkOutLater:
            return "ソースOUTを0.5秒後ろへ"
        case .resetSourceMonitorMarkedRange:
            return "ソース範囲をリセット"
        case .selectPreviousSourceMonitorCandidate:
            return "前のソース候補"
        case .selectNextSourceMonitorCandidate:
            return "次のソース候補"
        case .insertSourceMonitorAtPlayhead:
            return "ソースを再生位置へ追加"
        case .appendSourceMonitorToTimelineEnd:
            return "ソースを末尾へ追加"
        case .overwriteSourceMonitorAtPlayhead:
            return "ソースで上書き"
        case .replaceSelectedClipWithSourceMonitor:
            return "選択クリップをソースで置換"
        case .revealSelectedClipInSourceMonitor:
            return "選択クリップをソース確認"
        case .setLoopRangeToSelection:
            return "選択範囲をループ"
        case .toggleLoopPlayback:
            return "ループ再生をオン/オフ"
        case .clearLoopRange:
            return "ループ範囲を解除"
        case .selectAllTimelineClips:
            return "タイムラインを全選択"
        case .clearTimelineSelection:
            return "タイムライン選択を解除"
        case .selectPreviousTimelineClip:
            return "前のクリップを選択"
        case .selectNextTimelineClip:
            return "次のクリップを選択"
        case .extendTimelineSelectionPrevious:
            return "前へ範囲選択"
        case .extendTimelineSelectionNext:
            return "次へ範囲選択"
        case .deleteTimelineSelection:
            return "選択項目を削除"
        case .applyDefaultCrossfadeTransition:
            return "クロスフェードを適用"
        case .shortenSelectedTransition:
            return "トランジションを短く"
        case .lengthenSelectedTransition:
            return "トランジションを長く"
        case .trimTimelineClipStartToPlayhead:
            return "先頭を再生位置へトリム"
        case .trimTimelineClipEndToPlayhead:
            return "末尾を再生位置へトリム"
        case .zoomTimelineOut:
            return "タイムラインを縮小"
        case .zoomTimelineIn:
            return "タイムラインを拡大"
        case .fitTimelineToWindow:
            return "タイムライン全体を表示"
        case .resetTimelineZoom:
            return "タイムライン100%"
        case .toggleTimelineSnapping:
            return "吸着をオン/オフ"
        case .toggleTimelineBladeMode:
            return "ブレードをオン/オフ"
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
        case .prepareTimelineAgentPrompt:
            return "doc.text"
        case .runAgentTightenSelection:
            return "timeline.selection"
        case .runAgentShortenBeat:
            return "metronome"
        case .runAgentFindStrongerAlternate:
            return "magnifyingglass.circle"
        case .runAgentExplainCut:
            return "questionmark.bubble"
        case .approvePendingAgentJob:
            return "checkmark.shield"
        case .runSourceAnalysis:
            return "waveform.path.ecg"
        case .compileRoughCut:
            return "timeline.selection"
        case .applyReviewPatch:
            return "wrench.and.screwdriver"
        case .openSwapBrowser:
            return "arrow.triangle.2.circlepath"
        case .searchFootage:
            return "waveform.badge.magnifyingglass"
        case .rebuildSearchIndex:
            return "magnifyingglass.circle"
        case .runMarlinEvaluation:
            return "sparkles.tv"
        case .buildAudioStoryGraph:
            return "waveform.badge.magnifyingglass"
        case .openBGMReview:
            return "music.note.list"
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
        case .promoFinish:
            return "captions.bubble"
        case .runStudioAcceptanceSmoke:
            return "checkmark.shield"
        case .playTimeline:
            return isPlaying ? "pause.fill" : "play.fill"
        case .playTimelineReverse:
            return "backward.fill"
        case .pauseTimeline:
            return "stop.fill"
        case .stepTimelineBackward:
            return "backward.end.fill"
        case .stepTimelineForward:
            return "forward.end.fill"
        case .jumpToPreviousTimelineEditPoint:
            return "arrow.up.to.line"
        case .jumpToNextTimelineEditPoint:
            return "arrow.down.to.line"
        case .markSourceMonitorInAtPlaybackTime:
            return "arrow.down.left.video"
        case .markSourceMonitorOutAtPlaybackTime:
            return "arrow.up.right.video"
        case .nudgeSourceMonitorMarkInEarlier:
            return "arrow.left.to.line"
        case .nudgeSourceMonitorMarkInLater:
            return "arrow.right.to.line"
        case .nudgeSourceMonitorMarkOutEarlier:
            return "arrow.left"
        case .nudgeSourceMonitorMarkOutLater:
            return "arrow.right"
        case .resetSourceMonitorMarkedRange:
            return "arrow.counterclockwise"
        case .selectPreviousSourceMonitorCandidate:
            return "chevron.left.square"
        case .selectNextSourceMonitorCandidate:
            return "chevron.right.square"
        case .insertSourceMonitorAtPlayhead:
            return "plus.rectangle.on.rectangle"
        case .appendSourceMonitorToTimelineEnd:
            return "text.append"
        case .overwriteSourceMonitorAtPlayhead:
            return "square.and.arrow.down.on.square"
        case .replaceSelectedClipWithSourceMonitor:
            return "arrow.triangle.2.circlepath"
        case .revealSelectedClipInSourceMonitor:
            return "scope"
        case .setLoopRangeToSelection:
            return "repeat.circle"
        case .toggleLoopPlayback:
            return "repeat"
        case .clearLoopRange:
            return "repeat.circle.fill"
        case .selectAllTimelineClips:
            return "rectangle.3.group"
        case .clearTimelineSelection:
            return "xmark.circle"
        case .selectPreviousTimelineClip:
            return "arrow.left.to.line"
        case .selectNextTimelineClip:
            return "arrow.right.to.line"
        case .extendTimelineSelectionPrevious:
            return "arrow.left.and.line.vertical.and.arrow.right"
        case .extendTimelineSelectionNext:
            return "arrow.left.and.line.vertical.and.arrow.right"
        case .deleteTimelineSelection:
            return "trash"
        case .applyDefaultCrossfadeTransition:
            return "rectangle.on.rectangle"
        case .shortenSelectedTransition:
            return "minus"
        case .lengthenSelectedTransition:
            return "plus"
        case .trimTimelineClipStartToPlayhead:
            return "arrow.right.to.line"
        case .trimTimelineClipEndToPlayhead:
            return "arrow.left.to.line"
        case .zoomTimelineOut:
            return "minus.magnifyingglass"
        case .zoomTimelineIn:
            return "plus.magnifyingglass"
        case .fitTimelineToWindow:
            return "arrow.up.left.and.arrow.down.right"
        case .resetTimelineZoom:
            return "1.magnifyingglass"
        case .toggleTimelineSnapping:
            return "magnet"
        case .toggleTimelineBladeMode:
            return "scissors"
        }
    }

    public var keywords: [String] {
        switch self {
        case .refreshProjects:
            return ["project", "reload", "status", "プロジェクト", "更新", "状態"]
        case .newProjectFromSource:
            return ["import", "source", "ingest", "素材", "新規", "読み込み"]
        case .checkCodexAppServer:
            return ["agent", "runtime", "codex", "接続", "確認"]
        case .startAgentSession:
            return ["codex", "thread", "agent", "開始", "セッション"]
        case .stopAgentSession:
            return ["codex", "thread", "agent", "停止", "セッション"]
        case .runSelectedAgentJob:
            return ["codex", "job", "approval", "ジョブ", "実行", "承認"]
        case .runReadOnlyAgentTurn:
            return ["codex", "prompt", "read only", "相談", "読み取り専用"]
        case .prepareTimelineAgentPrompt:
            return ["agent", "ai", "timeline", "selection", "prompt", "prepare", "preview", "read only", "review_patch", "相談", "選択", "プロンプト", "準備", "プレビュー", "読み取り専用"]
        case .runAgentTightenSelection:
            return ["agent", "ai", "timeline", "selection", "tighten", "shorter", "preview", "read only", "相談", "選択", "短く", "整える", "読み取り専用"]
        case .runAgentShortenBeat:
            return ["agent", "ai", "timeline", "beat", "shorten", "rhythm", "preview", "read only", "相談", "ビート", "短く", "リズム", "読み取り専用"]
        case .runAgentFindStrongerAlternate:
            return ["agent", "ai", "timeline", "alternate", "stronger", "source", "replace", "search", "preview", "read only", "相談", "代替", "素材", "差し替え", "検索", "読み取り専用"]
        case .runAgentExplainCut:
            return ["agent", "ai", "timeline", "explain", "cut", "why", "diagnosis", "preview", "read only", "相談", "説明", "カット", "理由", "診断", "読み取り専用"]
        case .approvePendingAgentJob:
            return ["approval", "write", "codex", "承認", "保留", "書き込み"]
        case .runSourceAnalysis:
            return ["analysis", "ingest", "source", "素材", "解析"]
        case .compileRoughCut:
            return ["compile", "timeline", "rough cut", "粗編集", "生成", "タイムライン"]
        case .applyReviewPatch:
            return ["review", "patch", "compile", "レビュー", "修正", "反映"]
        case .openSwapBrowser:
            return ["swap", "candidate", "replace", "browser", "差替え", "差し替え", "候補", "クリップ"]
        case .searchFootage:
            return ["footage", "visual", "audio", "qwen", "clap", "search", "素材", "検索", "差替え", "映像", "音声"]
        case .rebuildSearchIndex:
            return ["rag", "sqlite", "material", "search", "素材", "検索", "インデックス"]
        case .runMarlinEvaluation:
            return ["vlm", "marlin", "temporal", "評価", "時間"]
        case .buildAudioStoryGraph:
            return ["audio", "story", "bgm", "音声", "ストーリー"]
        case .openBGMReview:
            return ["bgm", "music", "audition", "review", "rights", "楽曲", "試聴", "レビュー", "権利"]
        case .buildPreviewProxies:
            return ["media", "proxy", "preview", "プレビュー", "プロキシ", "素材"]
        case .relinkMissingMedia:
            return ["media", "source map", "relink", "未リンク", "再接続", "素材"]
        case .exportPremiereXML:
            return ["handoff", "premiere", "xml", "書き出し", "納品"]
        case .exportEditorPacket:
            return ["handoff", "packet", "editor", "編集者", "パケット", "納品"]
        case .renderFinalPackage:
            return ["render", "package", "final", "最終", "動画", "書き出し"]
        case .promoFinish:
            return ["promo", "finish", "caption", "subtitle", "telop", "宣材", "テロップ", "字幕", "仕上げ"]
        case .runStudioAcceptanceSmoke:
            return ["smoke", "acceptance", "codex", "受け入れ", "チェック"]
        case .playTimeline:
            return ["transport", "viewer", "timeline", "source monitor", "source", "monitor", "play", "pause", "l", "space", "再生", "一時停止", "タイムライン", "ソース"]
        case .playTimelineReverse:
            return ["transport", "viewer", "timeline", "source monitor", "source", "monitor", "reverse", "shuttle", "j", "backward", "逆再生", "巻き戻し", "シャトル", "タイムライン", "ソース"]
        case .pauseTimeline:
            return ["transport", "viewer", "timeline", "source monitor", "source", "monitor", "pause", "stop", "k", "停止", "一時停止", "タイムライン", "ソース"]
        case .stepTimelineBackward:
            return ["transport", "viewer", "timeline", "source monitor", "source", "monitor", "frame", "step", "back", "comma", "1フレーム", "戻る", "コマ送り", "ソース"]
        case .stepTimelineForward:
            return ["transport", "viewer", "timeline", "source monitor", "source", "monitor", "frame", "step", "forward", "period", "1フレーム", "進む", "コマ送り", "ソース"]
        case .jumpToPreviousTimelineEditPoint:
            return ["transport", "viewer", "timeline", "edit point", "previous", "up", "arrow", "marker", "boundary", "編集点", "前", "上", "矢印", "マーカー", "境界"]
        case .jumpToNextTimelineEditPoint:
            return ["transport", "viewer", "timeline", "edit point", "next", "down", "arrow", "marker", "boundary", "編集点", "次", "下", "矢印", "マーカー", "境界"]
        case .markSourceMonitorInAtPlaybackTime:
            return ["source", "monitor", "mark", "in", "i", "range", "viewer", "素材", "ソース", "マーク", "イン", "現在位置", "範囲"]
        case .markSourceMonitorOutAtPlaybackTime:
            return ["source", "monitor", "mark", "out", "o", "range", "viewer", "素材", "ソース", "マーク", "アウト", "現在位置", "範囲"]
        case .nudgeSourceMonitorMarkInEarlier:
            return ["source", "monitor", "mark", "in", "nudge", "earlier", "range", "trim", "option [", "opt [", "0.5", "素材", "ソース", "イン", "IN", "前", "戻す", "範囲", "微調整", "⌥["]
        case .nudgeSourceMonitorMarkInLater:
            return ["source", "monitor", "mark", "in", "nudge", "later", "range", "trim", "option ]", "opt ]", "0.5", "素材", "ソース", "イン", "IN", "後ろ", "送る", "範囲", "微調整", "⌥]"]
        case .nudgeSourceMonitorMarkOutEarlier:
            return ["source", "monitor", "mark", "out", "nudge", "earlier", "range", "trim", "shift option [", "shift opt [", "0.5", "素材", "ソース", "アウト", "OUT", "前", "詰める", "範囲", "微調整", "⇧⌥["]
        case .nudgeSourceMonitorMarkOutLater:
            return ["source", "monitor", "mark", "out", "nudge", "later", "range", "trim", "shift option ]", "shift opt ]", "0.5", "素材", "ソース", "アウト", "OUT", "後ろ", "伸ばす", "範囲", "微調整", "⇧⌥]"]
        case .resetSourceMonitorMarkedRange:
            return ["source", "monitor", "mark", "range", "reset", "clear", "shift r", "素材", "ソース", "マーク", "範囲", "リセット", "候補全体", "戻す", "⇧R"]
        case .selectPreviousSourceMonitorCandidate:
            return ["source", "monitor", "candidate", "previous", "select", "[", "viewer", "素材", "ソース", "候補", "前", "前候補", "選択"]
        case .selectNextSourceMonitorCandidate:
            return ["source", "monitor", "candidate", "next", "select", "]", "viewer", "素材", "ソース", "候補", "次", "次候補", "選択"]
        case .insertSourceMonitorAtPlayhead:
            return ["source", "monitor", "insert", "add", "playhead", "w", "edit", "overwrite", "viewer", "素材", "ソース", "追加", "挿入", "再生位置", "編集"]
        case .appendSourceMonitorToTimelineEnd:
            return ["source", "monitor", "append", "end", "timeline", "e", "edit", "fcpx", "viewer", "素材", "ソース", "追加", "末尾", "最後", "タイムライン", "編集"]
        case .overwriteSourceMonitorAtPlayhead:
            return ["source", "monitor", "overwrite", "replace range", "playhead", "d", "edit", "viewer", "素材", "ソース", "上書き", "再生位置", "編集"]
        case .replaceSelectedClipWithSourceMonitor:
            return ["source", "monitor", "replace", "selected", "clip", "r", "edit", "viewer", "素材", "ソース", "置換", "選択", "クリップ", "編集"]
        case .revealSelectedClipInSourceMonitor:
            return ["source", "monitor", "match frame", "reveal", "selected", "clip", "f", "viewer", "素材", "ソース", "確認", "選択", "クリップ", "マッチフレーム", "元素材"]
        case .setLoopRangeToSelection:
            return ["transport", "viewer", "timeline", "loop", "range", "selection", "clip", "transition", "multi", "r", "ループ", "範囲", "選択", "クリップ", "トランジション", "複数"]
        case .toggleLoopPlayback:
            return ["transport", "viewer", "timeline", "loop", "range", "repeat", "r", "ループ", "範囲", "繰り返し", "再生"]
        case .clearLoopRange:
            return ["transport", "viewer", "timeline", "loop", "range", "clear", "解除", "ループ", "範囲", "クリア"]
        case .selectAllTimelineClips:
            return ["timeline", "select", "all", "cmd", "command", "a", "clips", "全選択", "選択", "すべて", "クリップ"]
        case .clearTimelineSelection:
            return ["timeline", "clear", "selection", "escape", "esc", "cancel", "tool", "選択解除", "解除", "クリア", "ツール"]
        case .selectPreviousTimelineClip:
            return ["timeline", "select", "previous", "clip", "left", "arrow", "前", "前のクリップ", "選択", "矢印", "タイムライン"]
        case .selectNextTimelineClip:
            return ["timeline", "select", "next", "clip", "right", "arrow", "次", "次のクリップ", "選択", "矢印", "タイムライン"]
        case .extendTimelineSelectionPrevious:
            return ["timeline", "selection", "extend", "previous", "clip", "shift", "left", "arrow", "範囲選択", "前", "拡張", "タイムライン"]
        case .extendTimelineSelectionNext:
            return ["timeline", "selection", "extend", "next", "clip", "shift", "right", "arrow", "範囲選択", "次", "拡張", "タイムライン"]
        case .deleteTimelineSelection:
            return ["timeline", "delete", "backspace", "remove", "ripple", "lift", "cross-track", "multi-track", "trash", "transition", "clip", "削除", "リップル", "リフト", "複数トラック", "選択", "クリップ", "トランジション"]
        case .applyDefaultCrossfadeTransition:
            return ["timeline", "transition", "crossfade", "default", "apply", "command", "cmd", "t", "fcp", "edit point", "viewer", "トランジション", "クロスフェード", "デフォルト", "適用", "編集点", "反映"]
        case .shortenSelectedTransition:
            return ["timeline", "transition", "duration", "shorten", "shorter", "trim", "shift", "[", "crossfade", "トランジション", "長さ", "短く", "短縮", "尺", "クロスフェード"]
        case .lengthenSelectedTransition:
            return ["timeline", "transition", "duration", "lengthen", "longer", "extend", "shift", "]", "crossfade", "トランジション", "長さ", "長く", "延長", "尺", "クロスフェード"]
        case .trimTimelineClipStartToPlayhead:
            return ["timeline", "trim", "playhead", "q", "top", "tail", "start", "ripple trim", "edit", "再生位置", "トリム", "先頭", "詰める", "クリップ", "編集点"]
        case .trimTimelineClipEndToPlayhead:
            return ["timeline", "trim", "playhead", "w", "tail", "top", "end", "ripple trim", "edit", "再生位置", "トリム", "末尾", "詰める", "クリップ", "編集点"]
        case .zoomTimelineOut:
            return ["timeline", "zoom", "out", "-", "縮小", "ズーム", "全体", "表示"]
        case .zoomTimelineIn:
            return ["timeline", "zoom", "in", "+", "=", "拡大", "ズーム", "詳細", "表示"]
        case .fitTimelineToWindow:
            return ["timeline", "zoom", "fit", "overview", "full", "全体", "表示", "フィット"]
        case .resetTimelineZoom:
            return ["timeline", "zoom", "reset", "100", "default", "標準", "リセット", "表示"]
        case .toggleTimelineSnapping:
            return ["timeline", "snap", "snapping", "magnet", "magnetic", "n", "吸着", "磁気", "マグネット", "スナップ"]
        case .toggleTimelineBladeMode:
            return ["timeline", "blade", "split", "cut", "b", "scissors", "ブレード", "分割", "カット", "はさみ"]
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
