import Foundation

public struct ProjectPlanningStatus: Equatable, Sendable {
    public let projectURL: URL
    public let hasCreativeBrief: Bool
    public let hasUnresolvedBlockers: Bool
    public let assetCount: Int
    public let segmentCount: Int
    public let transcriptDocumentCount: Int
    public let transcriptItemCount: Int
    public let audioEvidenceCount: Int
    public let dialogueEvidenceRequired: Bool
    public let hasSelects: Bool
    public let hasBlueprint: Bool
    public let isBlueprintFresh: Bool
    public let blueprintStaleReason: String?
    public let hasUncertaintyRegister: Bool

    public init(
        projectURL: URL,
        hasCreativeBrief: Bool,
        hasUnresolvedBlockers: Bool,
        assetCount: Int,
        segmentCount: Int,
        transcriptDocumentCount: Int = 0,
        transcriptItemCount: Int = 0,
        audioEvidenceCount: Int = 0,
        dialogueEvidenceRequired: Bool = false,
        hasSelects: Bool,
        hasBlueprint: Bool,
        isBlueprintFresh: Bool = true,
        blueprintStaleReason: String? = nil,
        hasUncertaintyRegister: Bool
    ) {
        self.projectURL = projectURL
        self.hasCreativeBrief = hasCreativeBrief
        self.hasUnresolvedBlockers = hasUnresolvedBlockers
        self.assetCount = assetCount
        self.segmentCount = segmentCount
        self.transcriptDocumentCount = transcriptDocumentCount
        self.transcriptItemCount = transcriptItemCount
        self.audioEvidenceCount = audioEvidenceCount
        self.dialogueEvidenceRequired = dialogueEvidenceRequired
        self.hasSelects = hasSelects
        self.hasBlueprint = hasBlueprint
        self.isBlueprintFresh = isBlueprintFresh
        self.blueprintStaleReason = blueprintStaleReason
        self.hasUncertaintyRegister = hasUncertaintyRegister
    }

    public var analysisReady: Bool {
        assetCount > 0 && segmentCount > 0
    }

    public var dialogueEvidenceReady: Bool {
        !dialogueEvidenceRequired || (transcriptItemCount > 0 && audioEvidenceCount > 0)
    }

    public var dialogueEvidenceLabel: String {
        if !dialogueEvidenceRequired {
            return "not required"
        }
        return dialogueEvidenceReady ? "ready" : "missing"
    }

    public var blueprintFreshnessLabel: String {
        if !hasBlueprint {
            return "missing"
        }
        return isBlueprintFresh ? "fresh" : "stale"
    }

    public var readinessLabel: String {
        if !hasCreativeBrief {
            return "missing creative brief"
        }
        if !analysisReady {
            return "waiting for analysis"
        }
        if dialogueEvidenceRequired && !dialogueEvidenceReady {
            return "dialogue evidence missing"
        }
        if !hasSelects {
            return "ready for triage"
        }
        if !hasBlueprint {
            return "ready for blueprint"
        }
        if !isBlueprintFresh {
            return "blueprint stale"
        }
        return "planning ready"
    }

    public var nextAgentJob: VideoOSAgentJob? {
        if !hasCreativeBrief || !analysisReady {
            return nil
        }
        if dialogueEvidenceRequired && !dialogueEvidenceReady {
            return nil
        }
        if !hasSelects {
            return .triage
        }
        if !hasBlueprint {
            return .blueprint
        }
        if !isBlueprintFresh {
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
        if dialogueEvidenceRequired && !dialogueEvidenceReady {
            return "Run audio, diarization, transcript, and BGM analysis before selecting interview or dialogue clips."
        }
        if !hasSelects {
            return "Run the Triage Codex job to create selects_candidates.yaml from analyzed material."
        }
        if !hasBlueprint {
            return "Run the Blueprint Codex job to turn selects into an edit_blueprint.yaml."
        }
        if !isBlueprintFresh {
            return "Run the Blueprint Codex job again because edit_blueprint.yaml is older than its planning inputs."
        }
        return "Planning artifacts are ready; compile the rough cut."
    }
}

public enum ProjectPlanningStatusReader {
    public static func status(projectURL: URL) -> ProjectPlanningStatus {
        let evidence = ProjectEvidenceStore.load(projectURL: projectURL)
        let fileManager = FileManager.default
        let briefURL = projectURL.appendingPathComponent("01_intent/creative_brief.yaml")
        let selectsURL = projectURL.appendingPathComponent("04_plan/selects_candidates.yaml")
        let blueprintURL = projectURL.appendingPathComponent("04_plan/edit_blueprint.yaml")
        let transcriptItemCount = evidence.transcripts.values.reduce(0) { $0 + $1.items.count }
        let audioEvidenceCount = (evidence.audioEvents?.items.count ?? 0) + (evidence.audioStoryGraph?.nodes.count ?? 0)
        let blueprintFreshness = blueprintFreshness(
            blueprintURL: blueprintURL,
            inputs: [
                ("creative_brief.yaml", briefURL),
                ("selects_candidates.yaml", selectsURL)
            ],
            fileManager: fileManager
        )
        return ProjectPlanningStatus(
            projectURL: projectURL,
            hasCreativeBrief: fileManager.fileExists(atPath: briefURL.path),
            hasUnresolvedBlockers: fileManager.fileExists(atPath: projectURL.appendingPathComponent("01_intent/unresolved_blockers.yaml").path),
            assetCount: evidence.assets?.items.count ?? 0,
            segmentCount: evidence.segments?.items.count ?? 0,
            transcriptDocumentCount: evidence.transcripts.count,
            transcriptItemCount: transcriptItemCount,
            audioEvidenceCount: audioEvidenceCount,
            dialogueEvidenceRequired: dialogueEvidenceRequired(projectURL: projectURL, briefURL: briefURL, evidence: evidence),
            hasSelects: fileManager.fileExists(atPath: selectsURL.path),
            hasBlueprint: fileManager.fileExists(atPath: blueprintURL.path),
            isBlueprintFresh: blueprintFreshness.isFresh,
            blueprintStaleReason: blueprintFreshness.reason,
            hasUncertaintyRegister: fileManager.fileExists(atPath: projectURL.appendingPathComponent("04_plan/uncertainty_register.yaml").path)
        )
    }

    private static func dialogueEvidenceRequired(
        projectURL: URL,
        briefURL: URL,
        evidence: ProjectEvidenceStore
    ) -> Bool {
        let keywords = [
            "interview", "testimonial", "seminar", "dialogue", "speaker", "participant", "talking_head",
            "インタビュー", "セミナー", "対話", "話者", "参加者", "講演", "研修", "証言", "経営者", "リーダー"
        ]
        let text = dialogueEvidenceText(projectURL: projectURL, briefURL: briefURL, evidence: evidence)
        return keywords.contains { text.contains($0) }
    }

    private static func dialogueEvidenceText(
        projectURL: URL,
        briefURL: URL,
        evidence: ProjectEvidenceStore
    ) -> String {
        var parts: [String] = [projectURL.lastPathComponent]
        if let brief = try? String(contentsOf: briefURL, encoding: .utf8) {
            parts.append(brief)
        }
        for asset in evidence.assets?.items ?? [] {
            parts.append(asset.filename)
            if let roleGuess = asset.roleGuess {
                parts.append(roleGuess)
            }
            parts.append(contentsOf: asset.tags)
        }
        for segment in evidence.segments?.items ?? [] {
            parts.append(segment.summary)
            parts.append(segment.transcriptExcerpt)
            parts.append(contentsOf: segment.tags)
            parts.append(contentsOf: segment.interestPoints.map(\.label))
        }
        return parts.joined(separator: " ").lowercased()
    }

    private static func blueprintFreshness(
        blueprintURL: URL,
        inputs: [(label: String, url: URL)],
        fileManager: FileManager
    ) -> (isFresh: Bool, reason: String?) {
        guard fileManager.fileExists(atPath: blueprintURL.path),
              let blueprintDate = modificationDate(blueprintURL, fileManager: fileManager)
        else {
            return (true, nil)
        }

        let staleInputs = inputs.compactMap { input -> String? in
            guard fileManager.fileExists(atPath: input.url.path),
                  let inputDate = modificationDate(input.url, fileManager: fileManager),
                  inputDate > blueprintDate
            else {
                return nil
            }
            return input.label
        }

        guard !staleInputs.isEmpty else {
            return (true, nil)
        }
        return (false, "edit_blueprint.yaml is older than \(staleInputs.joined(separator: ", "))")
    }

    private static func modificationDate(_ url: URL, fileManager: FileManager) -> Date? {
        try? fileManager.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
    }
}
