import Foundation

public struct StudioCommandAvailabilityContext: Equatable, Sendable {
    public var hasSelectedProject: Bool
    public var isAppServerChecking: Bool
    public var hasActiveThread: Bool
    public var selectedAgentJobCanRun: Bool
    public var hasPendingApproval: Bool

    public init(
        hasSelectedProject: Bool = false,
        isAppServerChecking: Bool = false,
        hasActiveThread: Bool = false,
        selectedAgentJobCanRun: Bool = false,
        hasPendingApproval: Bool = false
    ) {
        self.hasSelectedProject = hasSelectedProject
        self.isAppServerChecking = isAppServerChecking
        self.hasActiveThread = hasActiveThread
        self.selectedAgentJobCanRun = selectedAgentJobCanRun
        self.hasPendingApproval = hasPendingApproval
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
        default:
            return true
        }
    }

    public func disabledReason(for command: StudioCommandPaletteCommand) -> String? {
        guard !isEnabled(command) else { return nil }
        switch command {
        case .checkCodexAppServer:
            return "Checking"
        case .startAgentSession:
            if !hasSelectedProject { return "No project" }
            if hasActiveThread { return "Already active" }
            return "Checking"
        case .stopAgentSession:
            return "No active thread"
        case .runSelectedAgentJob:
            if !hasSelectedProject { return "No project" }
            if !hasActiveThread { return "No active thread" }
            return "Job not ready"
        case .runReadOnlyAgentTurn:
            if !hasActiveThread { return "No active thread" }
            return "Checking"
        case .approvePendingAgentJob:
            if !hasPendingApproval { return "No pending job" }
            if !hasActiveThread { return "No active thread" }
            return "Checking"
        default:
            return nil
        }
    }
}
