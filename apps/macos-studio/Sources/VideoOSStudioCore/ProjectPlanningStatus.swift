import Foundation

public struct ProjectPlanningStatus: Equatable, Sendable {
    public let projectURL: URL
    public let hasCreativeBrief: Bool
    public let hasUnresolvedBlockers: Bool
    public let assetCount: Int
    public let segmentCount: Int
    public let hasSelects: Bool
    public let hasBlueprint: Bool
    public let hasUncertaintyRegister: Bool

    public var analysisReady: Bool {
        assetCount > 0 && segmentCount > 0
    }

    public var readinessLabel: String {
        if !hasCreativeBrief {
            return "missing creative brief"
        }
        if !analysisReady {
            return "waiting for analysis"
        }
        if !hasSelects {
            return "ready for triage"
        }
        if !hasBlueprint {
            return "ready for blueprint"
        }
        return "planning ready"
    }

    public var nextAgentJob: VideoOSAgentJob? {
        if !hasCreativeBrief || !analysisReady {
            return nil
        }
        if !hasSelects {
            return .triage
        }
        if !hasBlueprint {
            return .blueprint
        }
        return .compile
    }

    public var recommendation: String {
        if !hasCreativeBrief {
            return "Define the editing intent before selecting footage."
        }
        if !analysisReady {
            return "Run source analysis so Codex has assets and segments to select from."
        }
        if !hasSelects {
            return "Run the Triage Codex job to create selects_candidates.yaml from analyzed material."
        }
        if !hasBlueprint {
            return "Run the Blueprint Codex job to turn selects into an edit_blueprint.yaml."
        }
        return "Planning artifacts are ready; compile the rough cut."
    }
}

public enum ProjectPlanningStatusReader {
    public static func status(projectURL: URL) -> ProjectPlanningStatus {
        let evidence = ProjectEvidenceStore.load(projectURL: projectURL)
        let fileManager = FileManager.default
        return ProjectPlanningStatus(
            projectURL: projectURL,
            hasCreativeBrief: fileManager.fileExists(atPath: projectURL.appendingPathComponent("01_intent/creative_brief.yaml").path),
            hasUnresolvedBlockers: fileManager.fileExists(atPath: projectURL.appendingPathComponent("01_intent/unresolved_blockers.yaml").path),
            assetCount: evidence.assets?.items.count ?? 0,
            segmentCount: evidence.segments?.items.count ?? 0,
            hasSelects: fileManager.fileExists(atPath: projectURL.appendingPathComponent("04_plan/selects_candidates.yaml").path),
            hasBlueprint: fileManager.fileExists(atPath: projectURL.appendingPathComponent("04_plan/edit_blueprint.yaml").path),
            hasUncertaintyRegister: fileManager.fileExists(atPath: projectURL.appendingPathComponent("04_plan/uncertainty_register.yaml").path)
        )
    }
}
