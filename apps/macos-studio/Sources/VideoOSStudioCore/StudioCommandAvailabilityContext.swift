import Foundation

public struct StudioCommandAvailabilityContext: Equatable, Sendable {
    public var hasSelectedProject: Bool
    public var isAppServerChecking: Bool
    public var hasActiveThread: Bool
    public var selectedAgentJobCanRun: Bool
    public var hasPendingApproval: Bool
    public var hasSelectedTimelineClip: Bool

    public init(
        hasSelectedProject: Bool = false,
        isAppServerChecking: Bool = false,
        hasActiveThread: Bool = false,
        selectedAgentJobCanRun: Bool = false,
        hasPendingApproval: Bool = false,
        hasSelectedTimelineClip: Bool = false
    ) {
        self.hasSelectedProject = hasSelectedProject
        self.isAppServerChecking = isAppServerChecking
        self.hasActiveThread = hasActiveThread
        self.selectedAgentJobCanRun = selectedAgentJobCanRun
        self.hasPendingApproval = hasPendingApproval
        self.hasSelectedTimelineClip = hasSelectedTimelineClip
    }

    public func isEnabled(_ command: StudioCommandPaletteCommand) -> Bool {
        switch command {
        case .checkCodexAppServer:
            return !isAppServerChecking
        case .startAgentSession:
            return hasSelectedProject && !hasActiveThread && !isAppServerChecking
        case .stopAgentSession:
            return hasActiveThread
        case .runSelectedAgentJob:
            return selectedAgentJobCanRun
        case .runReadOnlyAgentTurn:
            return hasActiveThread && !isAppServerChecking
        case .approvePendingAgentJob:
            return hasPendingApproval && hasActiveThread && !isAppServerChecking
        case .openSwapBrowser:
            return hasSelectedProject && hasSelectedTimelineClip
        case .searchFootage:
            return hasSelectedProject
        default:
            return true
        }
    }

    public func disabledReason(for command: StudioCommandPaletteCommand) -> String? {
        guard !isEnabled(command) else { return nil }
        switch command {
        case .checkCodexAppServer:
            return "確認中"
        case .startAgentSession:
            if !hasSelectedProject { return "プロジェクト未選択" }
            if hasActiveThread { return "すでに接続中" }
            return "確認中"
        case .stopAgentSession:
            return "有効なスレッドがありません"
        case .runSelectedAgentJob:
            if !hasSelectedProject { return "プロジェクト未選択" }
            if !hasActiveThread { return "有効なスレッドがありません" }
            return "ジョブ未準備"
        case .runReadOnlyAgentTurn:
            if !hasActiveThread { return "有効なスレッドがありません" }
            return "確認中"
        case .approvePendingAgentJob:
            if !hasPendingApproval { return "保留中のジョブがありません" }
            if !hasActiveThread { return "有効なスレッドがありません" }
            return "確認中"
        case .openSwapBrowser:
            if !hasSelectedProject { return "プロジェクト未選択" }
            return "クリップ未選択"
        case .searchFootage:
            return "プロジェクト未選択"
        default:
            return nil
        }
    }
}
