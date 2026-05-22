import Foundation

public struct VideoOSAgentJobReadiness: Equatable, Sendable {
    public let canRun: Bool
    public let label: String

    public init(canRun: Bool, label: String) {
        self.canRun = canRun
        self.label = label
    }
}

public enum VideoOSAgentJobReadinessResolver {
    public static func readiness(
        for job: VideoOSAgentJob,
        hasActiveThread: Bool,
        project: ProjectSummary?,
        planningStatus: ProjectPlanningStatus?,
        selectedTimelineClipAvailable: Bool = false
    ) -> VideoOSAgentJobReadiness {
        guard hasActiveThread else {
            return VideoOSAgentJobReadiness(canRun: false, label: "Start an agent session before running jobs.")
        }
        guard let project else {
            return VideoOSAgentJobReadiness(canRun: false, label: "Select a project before running jobs.")
        }

        switch job {
        case .status:
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        case .validate:
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        case .clipAnnotation:
            guard selectedTimelineClipAvailable else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Select a timeline clip before running this read-only job.")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        case .triage:
            guard let planningStatus else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Planning status is not loaded.")
            }
            guard planningStatus.hasCreativeBrief else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Triage requires a creative brief.")
            }
            guard planningStatus.analysisReady else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Triage requires analyzed assets and segments.")
            }
            let label = planningStatus.hasSelects
                ? "Selects already exist; rerun only if analyzed evidence changed."
                : job.approvalSummary
            return VideoOSAgentJobReadiness(canRun: true, label: label)
        case .blueprint:
            guard let planningStatus else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Planning status is not loaded.")
            }
            guard planningStatus.hasCreativeBrief else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Blueprint requires a creative brief.")
            }
            guard planningStatus.hasUnresolvedBlockers else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Blueprint requires unresolved_blockers.yaml from intent.")
            }
            guard planningStatus.hasSelects else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Blueprint requires selects_candidates.yaml. Run Triage first.")
            }
            let label = planningStatus.hasBlueprint
                ? "Blueprint already exists; rerun only if selects or intent changed."
                : job.approvalSummary
            return VideoOSAgentJobReadiness(canRun: true, label: label)
        case .compile:
            guard let planningStatus else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Planning status is not loaded.")
            }
            guard planningStatus.hasSelects else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Compile requires selects_candidates.yaml. Run Triage first.")
            }
            guard planningStatus.hasBlueprint else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Compile requires edit_blueprint.yaml. Run Blueprint first.")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: project.hasTimeline ? "Timeline exists; recompile only after reviewing planned writes." : job.approvalSummary)
        case .review:
            guard project.hasTimeline else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Review requires a compiled timeline.json.")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: project.hasReview ? "Review artifacts already exist; rerun only after timeline changes." : job.approvalSummary)
        case .render:
            guard project.hasTimeline else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Render requires a compiled timeline.json.")
            }
            guard project.hasReview else {
                return VideoOSAgentJobReadiness(canRun: false, label: "Render requires review artifacts before packaging.")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        }
    }
}
