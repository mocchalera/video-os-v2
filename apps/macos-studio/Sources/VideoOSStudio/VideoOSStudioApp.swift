import AppKit
import SwiftUI
import VideoOSStudioCore

final class StudioMenuCommandAvailabilityStore {
    static let shared = StudioMenuCommandAvailabilityStore()

    var context = StudioCommandAvailabilityContext()

    private init() {}
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    private static var retainedDelegate: AppDelegate?
    private var mainWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var commandPaletteKeyMonitor: Any?

    static func main() {
        StudioBundledFontRegistry.register()
        let app = NSApplication.shared
        let delegate = AppDelegate()
        retainedDelegate = delegate
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.mainMenu = delegate.makeMainMenu()
        app.finishLaunching()
        delegate.showMainWindow()
        app.activate(ignoringOtherApps: true)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installCommandPaletteKeyboardMonitor()
        showMainWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    deinit {
        if let commandPaletteKeyMonitor {
            NSEvent.removeMonitor(commandPaletteKeyMonitor)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow()
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        false
    }

    func application(_ application: NSApplication, shouldSaveSecureApplicationState coder: NSCoder) -> Bool {
        false
    }

    func application(_ application: NSApplication, shouldRestoreSecureApplicationState coder: NSCoder) -> Bool {
        false
    }

    func application(_ sender: NSApplication, shouldSaveApplicationState coder: NSCoder) -> Bool {
        false
    }

    func application(_ sender: NSApplication, shouldRestoreApplicationState coder: NSCoder) -> Bool {
        false
    }

    @objc private func showMainWindow() {
        presentMainWindow(scheduleFocusRetries: true)
    }

    private func presentMainWindow(scheduleFocusRetries: Bool) {
        let window = existingOrNewMainWindow()
        ensureUsableMainWindowFrame(window, requireMainDisplayVisibility: true)
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        guard scheduleFocusRetries else { return }
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window else { return }
            self.ensureUsableMainWindowFrame(window, requireMainDisplayVisibility: true)
            guard self.shouldReassertMainWindow(window) else { return }
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            window.orderFrontRegardless()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self, weak window] in
            guard let self, let window else { return }
            self.ensureUsableMainWindowFrame(window, requireMainDisplayVisibility: true)
            guard self.shouldReassertMainWindow(window) else { return }
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            window.orderFrontRegardless()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self, weak window] in
            guard let self, let window else { return }
            self.ensureUsableMainWindowFrame(window, requireMainDisplayVisibility: true)
            guard self.shouldReassertMainWindow(window) else { return }
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            window.orderFrontRegardless()
        }
    }

    private func shouldReassertMainWindow(_ window: NSWindow) -> Bool {
        if !window.isVisible || window.isMiniaturized { return true }
        guard let keyWindow = NSApp.keyWindow else { return true }
        return keyWindow === window
    }

    @objc private func showSettingsWindow() {
        let window = existingOrNewSettingsWindow()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func refreshProjects() {
        NotificationCenter.default.post(name: .refreshStudioProjects, object: nil)
    }

    @objc private func initializeProject() {
        NotificationCenter.default.post(name: .initializeStudioProject, object: nil)
    }

    @objc private func openCommandPalette() {
        presentMainWindow(scheduleFocusRetries: false)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openStudioCommandPalette, object: nil)
        }
    }

    @objc private func closeCommandPalette() {
        NotificationCenter.default.post(name: .closeStudioCommandPalette, object: nil)
    }

    private func installCommandPaletteKeyboardMonitor() {
        guard commandPaletteKeyMonitor == nil else { return }
        commandPaletteKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if self.isCommandK(event) {
                self.openCommandPalette()
                return nil
            }
            if self.isEscape(event), self.isCommandPaletteWindow(NSApp.keyWindow) {
                self.closeCommandPalette()
                return nil
            }
            return event
        }
    }

    private func isCommandK(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        return flags == [.command]
            && event.charactersIgnoringModifiers?.lowercased() == "k"
    }

    private func isEscape(_ event: NSEvent) -> Bool {
        event.keyCode == 53
    }

    private func isCommandPaletteWindow(_ window: NSWindow?) -> Bool {
        guard let window else { return false }
        return window.identifier?.rawValue == "CommandPalettePanel" || window.title == "Command Palette"
    }

    @objc private func runAnalysis() {
        NotificationCenter.default.post(name: .runStudioAnalysis, object: nil)
    }

    @objc private func compileRoughCut() {
        NotificationCenter.default.post(name: .compileStudioRoughCut, object: nil)
    }

    @objc private func compileReviewPatch() {
        NotificationCenter.default.post(name: .compileStudioReviewPatch, object: nil)
    }

    @objc private func runReviewJob() {
        NotificationCenter.default.post(name: .runStudioReviewJob, object: nil)
    }

    @objc private func rebuildSearchIndex() {
        NotificationCenter.default.post(name: .rebuildStudioSearchIndex, object: nil)
    }

    @objc private func openSwapBrowser() {
        NotificationCenter.default.post(name: .openStudioSwapBrowser, object: nil)
    }

    @objc private func openFootageSearch() {
        NotificationCenter.default.post(name: .openStudioFootageSearch, object: nil)
    }

    @objc private func runMarlinEvaluation() {
        NotificationCenter.default.post(name: .runStudioMarlinEvaluation, object: nil)
    }

    @objc private func buildAudioStoryGraph() {
        NotificationCenter.default.post(name: .buildStudioAudioStoryGraph, object: nil)
    }

    @objc private func checkAppServer() {
        NotificationCenter.default.post(name: .checkStudioAppServer, object: nil)
    }

    @objc private func startAgentSession() {
        NotificationCenter.default.post(name: .startStudioAgentSession, object: nil)
    }

    @objc private func stopAgentSession() {
        NotificationCenter.default.post(name: .stopStudioAgentSession, object: nil)
    }

    @objc private func runSelectedAgentJob() {
        NotificationCenter.default.post(name: .runStudioSelectedAgentJob, object: nil)
    }

    @objc private func runReadOnlyAgentTurn() {
        NotificationCenter.default.post(name: .runStudioReadOnlyAgentTurn, object: nil)
    }

    @objc private func approvePendingAgentJob() {
        NotificationCenter.default.post(name: .approveStudioPendingAgentJob, object: nil)
    }

    @objc private func cancelPendingAgentJob() {
        NotificationCenter.default.post(name: .cancelStudioPendingAgentJob, object: nil)
    }

    @objc private func buildPreviewProxies() {
        NotificationCenter.default.post(name: .buildStudioPreviewProxies, object: nil)
    }

    @objc private func runSyntheticStudioSmoke() {
        NotificationCenter.default.post(name: .runStudioSyntheticSmoke, object: nil)
    }

    @objc private func runAcceptanceSmoke() {
        NotificationCenter.default.post(name: .runStudioAcceptanceSmoke, object: nil)
    }

    @objc private func relinkMedia() {
        NotificationCenter.default.post(name: .relinkStudioMedia, object: nil)
    }

    @objc private func exportPremiereXML() {
        NotificationCenter.default.post(name: .exportStudioPremiereXML, object: nil)
    }

    @objc private func exportEditorPacket() {
        NotificationCenter.default.post(name: .exportStudioEditorPacket, object: nil)
    }

    @objc private func revealEditorPacket() {
        NotificationCenter.default.post(name: .revealStudioEditorPacket, object: nil)
    }

    @objc private func runRender() {
        NotificationCenter.default.post(name: .runStudioRender, object: nil)
    }

    @objc private func togglePlayback() {
        NotificationCenter.default.post(name: .toggleStudioPlayback, object: nil)
    }

    @objc private func playForward() {
        NotificationCenter.default.post(name: .playStudioPlaybackForward, object: nil)
    }

    @objc private func playReverse() {
        NotificationCenter.default.post(name: .playStudioPlaybackReverse, object: nil)
    }

    @objc private func pausePlayback() {
        NotificationCenter.default.post(name: .pauseStudioPlayback, object: nil)
    }

    @objc private func stepBackward() {
        NotificationCenter.default.post(name: .stepStudioPlaybackBackward, object: nil)
    }

    @objc private func stepForward() {
        NotificationCenter.default.post(name: .stepStudioPlaybackForward, object: nil)
    }

    @objc private func setLoopToSelection() {
        NotificationCenter.default.post(name: .setStudioPlaybackLoopToSelection, object: nil)
    }

    @objc private func toggleLoopPlayback() {
        NotificationCenter.default.post(name: .toggleStudioPlaybackLoop, object: nil)
    }

    @objc private func clearLoopRange() {
        NotificationCenter.default.post(name: .clearStudioPlaybackLoop, object: nil)
    }

    @objc private func zoomTimelineOut() {
        NotificationCenter.default.post(name: .zoomStudioTimelineOut, object: nil)
    }

    @objc private func zoomTimelineIn() {
        NotificationCenter.default.post(name: .zoomStudioTimelineIn, object: nil)
    }

    @objc private func fitTimelineToWindow() {
        NotificationCenter.default.post(name: .fitStudioTimelineToWindow, object: nil)
    }

    @objc private func resetTimelineZoom() {
        NotificationCenter.default.post(name: .resetStudioTimelineZoom, object: nil)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let action = menuItem.action else { return true }
        let context = StudioMenuCommandAvailabilityStore.shared.context
        switch action {
        case #selector(checkAppServer):
            return context.isEnabled(.checkCodexAppServer)
        case #selector(startAgentSession):
            return context.isEnabled(.startAgentSession)
        case #selector(stopAgentSession):
            return context.isEnabled(.stopAgentSession)
        case #selector(runSelectedAgentJob):
            return context.isEnabled(.runSelectedAgentJob)
        case #selector(runReadOnlyAgentTurn):
            return context.isEnabled(.runReadOnlyAgentTurn)
        case #selector(approvePendingAgentJob):
            return context.isEnabled(.approvePendingAgentJob)
        case #selector(cancelPendingAgentJob):
            return context.hasPendingApproval
        case #selector(openSwapBrowser):
            return context.hasSelectedTimelineClip
        case #selector(openFootageSearch):
            return context.hasSelectedProject
        default:
            return true
        }
    }

    private func existingOrNewMainWindow() -> NSWindow {
        if let mainWindow {
            return mainWindow
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Video OS Studio"
        window.identifier = NSUserInterfaceItemIdentifier("VideoOSStudioMainWindow")
        window.minSize = NSSize(width: 1180, height: 760)
        window.isRestorable = false
        window.center()
        window.contentViewController = NSHostingController(
            rootView: ContentView()
                .frame(minWidth: 1180, minHeight: 760)
        )
        window.delegate = self
        mainWindow = window
        return window
    }

    private func ensureUsableMainWindowFrame(_ window: NSWindow, requireMainDisplayVisibility: Bool = false) {
        let frame = window.frame
        let visibleFrames = NSScreen.screens.map(\.visibleFrame)
        let launchVisibleFrame = NSScreen.screens.first {
            $0.frame.origin.x == 0 && $0.frame.origin.y == 0
        }?.visibleFrame ?? NSScreen.main?.visibleFrame
        let hasUsableVisibleArea = visibleFrames.contains { visibleFrame in
            let intersection = frame.intersection(visibleFrame)
            return intersection.width >= 800 && intersection.height >= 600
        }
        let hasUsableLaunchDisplayArea = launchVisibleFrame.map { visibleFrame in
            let intersection = frame.intersection(visibleFrame)
            return intersection.width >= 800 && intersection.height >= 600
        } ?? false

        let needsLaunchDisplayReset = requireMainDisplayVisibility && !hasUsableLaunchDisplayArea
        guard frame.width < 1000 || frame.height < 700 || !hasUsableVisibleArea || needsLaunchDisplayReset else {
            return
        }

        let screenFrame = (requireMainDisplayVisibility ? launchVisibleFrame : nil)
            ?? visibleFrames.first { frame in
                frame.origin.x >= 0 && frame.origin.y >= 0
            }
            ?? visibleFrames.first
            ?? NSRect(x: 0, y: 0, width: 1280, height: 820)
        let targetSize = NSSize(
            width: min(max(1180, screenFrame.width * 0.82), screenFrame.width),
            height: min(max(760, screenFrame.height * 0.82), screenFrame.height)
        )
        let targetOrigin = NSPoint(
            x: screenFrame.midX - targetSize.width / 2,
            y: screenFrame.midY - targetSize.height / 2
        )
        window.setFrame(NSRect(origin: targetOrigin, size: targetSize), display: true)
    }

    private func existingOrNewSettingsWindow() -> NSWindow {
        if let settingsWindow {
            return settingsWindow
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 520),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "設定"
        window.minSize = NSSize(width: 620, height: 460)
        window.center()
        window.contentViewController = NSHostingController(rootView: SettingsView())
        settingsWindow = window
        return window
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === mainWindow {
            mainWindow = nil
        }
        if window === settingsWindow {
            settingsWindow = nil
        }
    }

    func windowDidResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === mainWindow else { return }
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window else { return }
            self.ensureUsableMainWindowFrame(window)
        }
    }

    func windowDidMove(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === mainWindow else { return }
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window else { return }
            self.ensureUsableMainWindowFrame(window)
        }
    }

    private func makeMainMenu() -> NSMenu {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        appMenu.addItem(withTitle: "Video OS Studioについて", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "設定...", action: #selector(showSettingsWindow), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        let commandPaletteItem = NSMenuItem(title: "コマンド検索...", action: #selector(openCommandPalette), keyEquivalent: "k")
        commandPaletteItem.target = self
        appMenu.addItem(commandPaletteItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Video OS Studioを終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let studioItem = NSMenuItem()
        let studioMenu = NSMenu(title: "スタジオ")
        studioItem.submenu = studioMenu
        mainMenu.addItem(studioItem)

        let refreshItem = NSMenuItem(title: "プロジェクトを更新", action: #selector(refreshProjects), keyEquivalent: "r")
        refreshItem.target = self
        studioMenu.addItem(refreshItem)

        let initializeItem = NSMenuItem(title: "素材から新規プロジェクト...", action: #selector(initializeProject), keyEquivalent: "n")
        initializeItem.target = self
        studioMenu.addItem(initializeItem)
        studioMenu.addItem(.separator())

        let analysisItem = NSMenuItem(title: "素材解析を実行", action: #selector(runAnalysis), keyEquivalent: "a")
        analysisItem.target = self
        analysisItem.keyEquivalentModifierMask = [.command, .option]
        studioMenu.addItem(analysisItem)

        let compileItem = NSMenuItem(title: "粗編集を生成", action: #selector(compileRoughCut), keyEquivalent: "c")
        compileItem.target = self
        compileItem.keyEquivalentModifierMask = [.command, .option]
        studioMenu.addItem(compileItem)

        let applyReviewPatchItem = NSMenuItem(title: "レビュー修正を反映", action: #selector(compileReviewPatch), keyEquivalent: "j")
        applyReviewPatchItem.target = self
        applyReviewPatchItem.keyEquivalentModifierMask = [.command, .option]
        studioMenu.addItem(applyReviewPatchItem)

        let reviewItem = NSMenuItem(title: "Codexでレビュー実行", action: #selector(runReviewJob), keyEquivalent: "u")
        reviewItem.target = self
        reviewItem.keyEquivalentModifierMask = [.command, .option]
        studioMenu.addItem(reviewItem)

        let rebuildIndexItem = NSMenuItem(title: "検索インデックスを再構築", action: #selector(rebuildSearchIndex), keyEquivalent: "i")
        rebuildIndexItem.target = self
        rebuildIndexItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(rebuildIndexItem)

        let openSwapItem = NSMenuItem(title: "差し替え候補を開く...", action: #selector(openSwapBrowser), keyEquivalent: "s")
        openSwapItem.target = self
        openSwapItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(openSwapItem)

        let searchFootageItem = NSMenuItem(title: "素材を検索...", action: #selector(openFootageSearch), keyEquivalent: "f")
        searchFootageItem.target = self
        searchFootageItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(searchFootageItem)

        let marlinItem = NSMenuItem(title: "Marlin評価を実行", action: #selector(runMarlinEvaluation), keyEquivalent: "m")
        marlinItem.target = self
        marlinItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(marlinItem)

        let audioStoryItem = NSMenuItem(title: "音声ストーリーグラフを作成", action: #selector(buildAudioStoryGraph), keyEquivalent: "g")
        audioStoryItem.target = self
        audioStoryItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(audioStoryItem)

        let proxyItem = NSMenuItem(title: "プレビュー用プロキシを作成", action: #selector(buildPreviewProxies), keyEquivalent: "p")
        proxyItem.target = self
        proxyItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(proxyItem)

        let syntheticSmokeItem = NSMenuItem(title: "Studioスモークを実行", action: #selector(runSyntheticStudioSmoke), keyEquivalent: "")
        syntheticSmokeItem.target = self
        studioMenu.addItem(syntheticSmokeItem)

        let acceptanceSmokeItem = NSMenuItem(title: "受け入れチェックを実行", action: #selector(runAcceptanceSmoke), keyEquivalent: "")
        acceptanceSmokeItem.target = self
        studioMenu.addItem(acceptanceSmokeItem)

        let relinkItem = NSMenuItem(title: "未リンク素材を再接続...", action: #selector(relinkMedia), keyEquivalent: "l")
        relinkItem.target = self
        relinkItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(relinkItem)
        studioMenu.addItem(.separator())

        let exportPremiereItem = NSMenuItem(title: "Premiere XMLを書き出し", action: #selector(exportPremiereXML), keyEquivalent: "e")
        exportPremiereItem.target = self
        exportPremiereItem.keyEquivalentModifierMask = [.command, .shift]
        studioMenu.addItem(exportPremiereItem)

        let exportPacketItem = NSMenuItem(title: "編集者パケットを書き出し", action: #selector(exportEditorPacket), keyEquivalent: "e")
        exportPacketItem.target = self
        exportPacketItem.keyEquivalentModifierMask = [.command, .option]
        studioMenu.addItem(exportPacketItem)

        let revealPacketItem = NSMenuItem(title: "編集者パケットを表示", action: #selector(revealEditorPacket), keyEquivalent: "")
        revealPacketItem.target = self
        studioMenu.addItem(revealPacketItem)

        let renderItem = NSMenuItem(title: "最終動画を書き出し", action: #selector(runRender), keyEquivalent: "r")
        renderItem.target = self
        renderItem.keyEquivalentModifierMask = [.command, .option]
        studioMenu.addItem(renderItem)

        let agentItem = NSMenuItem()
        let agentMenu = NSMenu(title: "エージェント")
        agentItem.submenu = agentMenu
        mainMenu.addItem(agentItem)

        let checkAgentItem = NSMenuItem(title: "Codex App Serverを確認", action: #selector(checkAppServer), keyEquivalent: "k")
        checkAgentItem.target = self
        checkAgentItem.keyEquivalentModifierMask = [.command, .shift]
        agentMenu.addItem(checkAgentItem)

        let startAgentItem = NSMenuItem(title: "エージェントセッションを開始", action: #selector(startAgentSession), keyEquivalent: "a")
        startAgentItem.target = self
        startAgentItem.keyEquivalentModifierMask = [.command, .shift]
        agentMenu.addItem(startAgentItem)

        let stopAgentItem = NSMenuItem(title: "エージェントセッションを停止", action: #selector(stopAgentSession), keyEquivalent: "")
        stopAgentItem.target = self
        agentMenu.addItem(stopAgentItem)
        agentMenu.addItem(.separator())

        let runJobItem = NSMenuItem(title: "選択ジョブを実行", action: #selector(runSelectedAgentJob), keyEquivalent: "\r")
        runJobItem.target = self
        runJobItem.keyEquivalentModifierMask = [.command]
        agentMenu.addItem(runJobItem)

        let readOnlyTurnItem = NSMenuItem(title: "読み取り専用で実行", action: #selector(runReadOnlyAgentTurn), keyEquivalent: "\r")
        readOnlyTurnItem.target = self
        readOnlyTurnItem.keyEquivalentModifierMask = [.command, .option]
        agentMenu.addItem(readOnlyTurnItem)
        agentMenu.addItem(.separator())

        let approveItem = NSMenuItem(title: "保留中の書き込みを承認", action: #selector(approvePendingAgentJob), keyEquivalent: "\r")
        approveItem.target = self
        approveItem.keyEquivalentModifierMask = [.command, .shift]
        agentMenu.addItem(approveItem)

        let cancelApprovalItem = NSMenuItem(title: "保留中の書き込みをキャンセル", action: #selector(cancelPendingAgentJob), keyEquivalent: "\u{1b}")
        cancelApprovalItem.target = self
        cancelApprovalItem.keyEquivalentModifierMask = []
        agentMenu.addItem(cancelApprovalItem)

        let transportItem = NSMenuItem()
        let transportMenu = NSMenu(title: "再生")
        transportItem.submenu = transportMenu
        mainMenu.addItem(transportItem)

        let playItem = NSMenuItem(title: "再生/一時停止", action: #selector(togglePlayback), keyEquivalent: " ")
        playItem.target = self
        playItem.keyEquivalentModifierMask = []
        transportMenu.addItem(playItem)

        let playForwardItem = NSMenuItem(title: "再生（タイムラインフォーカス時 L）", action: #selector(playForward), keyEquivalent: "")
        playForwardItem.target = self
        transportMenu.addItem(playForwardItem)

        let playReverseItem = NSMenuItem(title: "逆再生（タイムラインフォーカス時 J）", action: #selector(playReverse), keyEquivalent: "")
        playReverseItem.target = self
        transportMenu.addItem(playReverseItem)

        let pauseItem = NSMenuItem(title: "停止（タイムラインフォーカス時 K）", action: #selector(pausePlayback), keyEquivalent: "")
        pauseItem.target = self
        transportMenu.addItem(pauseItem)
        transportMenu.addItem(.separator())

        let stepBackItem = NSMenuItem(title: "1フレーム戻る", action: #selector(stepBackward), keyEquivalent: ",")
        stepBackItem.target = self
        stepBackItem.keyEquivalentModifierMask = []
        transportMenu.addItem(stepBackItem)

        let stepForwardItem = NSMenuItem(title: "1フレーム進む", action: #selector(stepForward), keyEquivalent: ".")
        stepForwardItem.target = self
        stepForwardItem.keyEquivalentModifierMask = []
        transportMenu.addItem(stepForwardItem)
        transportMenu.addItem(.separator())

        let setLoopItem = NSMenuItem(title: "選択範囲をループ範囲に設定（タイムラインフォーカス時 R）", action: #selector(setLoopToSelection), keyEquivalent: "")
        setLoopItem.target = self
        transportMenu.addItem(setLoopItem)

        let toggleLoopItem = NSMenuItem(title: "ループ再生をオン/オフ", action: #selector(toggleLoopPlayback), keyEquivalent: "")
        toggleLoopItem.target = self
        transportMenu.addItem(toggleLoopItem)

        let clearLoopItem = NSMenuItem(title: "ループ範囲を解除", action: #selector(clearLoopRange), keyEquivalent: "")
        clearLoopItem.target = self
        transportMenu.addItem(clearLoopItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "表示")
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let zoomOutItem = NSMenuItem(title: "タイムラインを縮小", action: #selector(zoomTimelineOut), keyEquivalent: "-")
        zoomOutItem.target = self
        zoomOutItem.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(zoomOutItem)

        let zoomInItem = NSMenuItem(title: "タイムラインを拡大", action: #selector(zoomTimelineIn), keyEquivalent: "=")
        zoomInItem.target = self
        zoomInItem.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(zoomInItem)

        let resetZoomItem = NSMenuItem(title: "タイムライン100%", action: #selector(resetTimelineZoom), keyEquivalent: "1")
        resetZoomItem.target = self
        resetZoomItem.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(resetZoomItem)

        let fitTimelineItem = NSMenuItem(title: "タイムライン全体を表示", action: #selector(fitTimelineToWindow), keyEquivalent: "9")
        fitTimelineItem.target = self
        fitTimelineItem.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(fitTimelineItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "ウィンドウ")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        let showMainItem = NSMenuItem(title: "Video OS Studioを表示", action: #selector(showMainWindow), keyEquivalent: "0")
        showMainItem.target = self
        windowMenu.addItem(showMainItem)
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "しまう", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "拡大/縮小", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        return mainMenu
    }
}

extension Notification.Name {
    static let openStudioCommandPalette = Notification.Name("VideoOSStudioOpenCommandPalette")
    static let closeStudioCommandPalette = Notification.Name("VideoOSStudioCloseCommandPalette")
    static let initializeStudioProject = Notification.Name("VideoOSStudioInitializeProject")
    static let refreshStudioProjects = Notification.Name("VideoOSStudioRefreshProjects")
    static let runStudioAnalysis = Notification.Name("VideoOSStudioRunAnalysis")
    static let compileStudioRoughCut = Notification.Name("VideoOSStudioCompileRoughCut")
    static let compileStudioReviewPatch = Notification.Name("VideoOSStudioCompileReviewPatch")
    static let runStudioReviewJob = Notification.Name("VideoOSStudioRunReviewJob")
    static let rebuildStudioSearchIndex = Notification.Name("VideoOSStudioRebuildSearchIndex")
    static let openStudioSwapBrowser = Notification.Name("VideoOSStudioOpenSwapBrowser")
    static let openStudioFootageSearch = Notification.Name("VideoOSStudioOpenFootageSearch")
    static let runStudioMarlinEvaluation = Notification.Name("VideoOSStudioRunMarlinEvaluation")
    static let buildStudioAudioStoryGraph = Notification.Name("VideoOSStudioBuildAudioStoryGraph")
    static let checkStudioAppServer = Notification.Name("VideoOSStudioCheckAppServer")
    static let startStudioAgentSession = Notification.Name("VideoOSStudioStartAgentSession")
    static let stopStudioAgentSession = Notification.Name("VideoOSStudioStopAgentSession")
    static let runStudioSelectedAgentJob = Notification.Name("VideoOSStudioRunSelectedAgentJob")
    static let runStudioReadOnlyAgentTurn = Notification.Name("VideoOSStudioRunReadOnlyAgentTurn")
    static let approveStudioPendingAgentJob = Notification.Name("VideoOSStudioApprovePendingAgentJob")
    static let cancelStudioPendingAgentJob = Notification.Name("VideoOSStudioCancelPendingAgentJob")
    static let buildStudioPreviewProxies = Notification.Name("VideoOSStudioBuildPreviewProxies")
    static let runStudioSyntheticSmoke = Notification.Name("VideoOSStudioRunSyntheticSmoke")
    static let runStudioAcceptanceSmoke = Notification.Name("VideoOSStudioRunAcceptanceSmoke")
    static let relinkStudioMedia = Notification.Name("VideoOSStudioRelinkMedia")
    static let exportStudioPremiereXML = Notification.Name("VideoOSStudioExportPremiereXML")
    static let exportStudioEditorPacket = Notification.Name("VideoOSStudioExportEditorPacket")
    static let revealStudioEditorPacket = Notification.Name("VideoOSStudioRevealEditorPacket")
    static let runStudioRender = Notification.Name("VideoOSStudioRunRender")
    static let playStudioPlaybackForward = Notification.Name("VideoOSStudioPlayPlaybackForward")
    static let playStudioPlaybackReverse = Notification.Name("VideoOSStudioPlayPlaybackReverse")
    static let pauseStudioPlayback = Notification.Name("VideoOSStudioPausePlayback")
    static let toggleStudioPlayback = Notification.Name("VideoOSStudioTogglePlayback")
    static let stepStudioPlaybackBackward = Notification.Name("VideoOSStudioStepPlaybackBackward")
    static let stepStudioPlaybackForward = Notification.Name("VideoOSStudioStepPlaybackForward")
    static let setStudioPlaybackLoopToSelection = Notification.Name("VideoOSStudioSetPlaybackLoopToSelection")
    static let toggleStudioPlaybackLoop = Notification.Name("VideoOSStudioTogglePlaybackLoop")
    static let clearStudioPlaybackLoop = Notification.Name("VideoOSStudioClearPlaybackLoop")
    static let zoomStudioTimelineIn = Notification.Name("VideoOSStudioZoomTimelineIn")
    static let zoomStudioTimelineOut = Notification.Name("VideoOSStudioZoomTimelineOut")
    static let fitStudioTimelineToWindow = Notification.Name("VideoOSStudioFitTimelineToWindow")
    static let resetStudioTimelineZoom = Notification.Name("VideoOSStudioResetTimelineZoom")
}
