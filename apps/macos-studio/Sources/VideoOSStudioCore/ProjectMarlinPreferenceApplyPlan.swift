import Foundation

public struct ProjectMarlinPreferenceApplyPlan: Equatable, Sendable {
    public let decision: ProjectMarlinPreferenceDecision
    public let policyURL: URL
    public let targetEnabled: Bool
    public let targetMode: String

    public var canApply: Bool {
        decision.canPreferMarlinAsDefault
    }

    public var currentPolicyLabel: String {
        decision.policyStatus.marlinPolicyLabel
    }

    public var targetPolicyLabel: String {
        "\(targetEnabled ? "enabled" : "disabled") / \(targetMode) / \(decision.policyStatus.marlinMock == true ? "mock" : "live")"
    }

    public var needsChange: Bool {
        decision.policyStatus.marlinEnabled != targetEnabled || decision.policyStatus.marlinMode != targetMode
    }

    public var readinessLabel: String {
        if !canApply { return decision.decisionLabel }
        return needsChange ? "ready to apply Marlin-first policy" : "Marlin-first policy already applied"
    }

    public var recommendation: String {
        if canApply {
            return "Apply Marlin-first temporal semantics only with operator confirmation; keep the existing VLM fallback for frame-bundle and arbitrary visual prompts."
        }
        return decision.recommendation
    }
}

public struct ProjectMarlinPreferenceApplyResult: Equatable, Sendable {
    public let plan: ProjectMarlinPreferenceApplyPlan
    public let wrotePolicy: Bool
    public let policyURL: URL
    public let previousPolicyLabel: String
    public let nextPolicyLabel: String
}

public enum ProjectMarlinPreferenceApplyError: Error, CustomStringConvertible, Equatable {
    case notReady(String)
    case confirmationRequired
    case policyMissing(String)
    case policyUnreadable(String)
    case policyUpdateFailed(String)

    public var description: String {
        switch self {
        case .notReady(let reason):
            return "Marlin preference is not ready: \(reason)"
        case .confirmationRequired:
            return "Pass --confirm after reviewing the Marlin preference gate before changing analysis defaults."
        case .policyMissing(let path):
            return "analysis policy is missing: \(path)"
        case .policyUnreadable(let path):
            return "analysis policy is unreadable: \(path)"
        case .policyUpdateFailed(let reason):
            return "analysis policy update failed: \(reason)"
        }
    }
}

public enum ProjectMarlinPreferenceApplier {
    public static func plan(
        repositoryRoot: URL,
        targetMode: String = "primary"
    ) -> ProjectMarlinPreferenceApplyPlan {
        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: repositoryRoot)
        return ProjectMarlinPreferenceApplyPlan(
            decision: decision,
            policyURL: decision.policyStatus.policyURL,
            targetEnabled: true,
            targetMode: targetMode
        )
    }

    public static func apply(
        repositoryRoot: URL,
        confirm: Bool,
        force: Bool = false,
        targetMode: String = "primary"
    ) throws -> ProjectMarlinPreferenceApplyResult {
        let plan = plan(repositoryRoot: repositoryRoot, targetMode: targetMode)
        guard plan.canApply || force else {
            throw ProjectMarlinPreferenceApplyError.notReady(plan.decision.recommendation)
        }
        guard confirm else {
            throw ProjectMarlinPreferenceApplyError.confirmationRequired
        }

        let policyURL = plan.policyURL
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: policyURL.path) else {
            throw ProjectMarlinPreferenceApplyError.policyMissing(policyURL.path)
        }
        guard let text = try? String(contentsOf: policyURL, encoding: .utf8) else {
            throw ProjectMarlinPreferenceApplyError.policyUnreadable(policyURL.path)
        }

        let nextText = try updateMarlinSection(text: text, enabled: true, mode: targetMode)
        if nextText != text {
            try nextText.write(to: policyURL, atomically: true, encoding: .utf8)
        }
        let nextPolicy = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
        return ProjectMarlinPreferenceApplyResult(
            plan: plan,
            wrotePolicy: nextText != text,
            policyURL: policyURL,
            previousPolicyLabel: plan.currentPolicyLabel,
            nextPolicyLabel: nextPolicy.marlinPolicyLabel
        )
    }

    static func updateMarlinSection(text: String, enabled: Bool, mode: String) throws -> String {
        var lines = text.components(separatedBy: .newlines)
        var inMarlin = false
        var foundMarlin = false
        var updatedEnabled = false
        var updatedMode = false
        var insertIndex: Int?

        for index in lines.indices {
            let rawLine = lines[index]
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") {
                continue
            }

            let isTopLevel = !rawLine.hasPrefix(" ") && !rawLine.hasPrefix("\t")
            if isTopLevel {
                if inMarlin {
                    insertIndex = index
                    inMarlin = false
                }
                if trimmed == "marlin:" {
                    foundMarlin = true
                    inMarlin = true
                    insertIndex = index + 1
                }
                continue
            }

            guard inMarlin else { continue }
            insertIndex = index + 1
            if trimmed.hasPrefix("enabled:") {
                lines[index] = "  enabled: \(enabled ? "true" : "false")"
                updatedEnabled = true
            } else if trimmed.hasPrefix("mode:") {
                lines[index] = "  mode: \(mode)"
                updatedMode = true
            }
        }

        guard foundMarlin else {
            throw ProjectMarlinPreferenceApplyError.policyUpdateFailed("missing marlin section")
        }

        var insertions: [String] = []
        if !updatedEnabled {
            insertions.append("  enabled: \(enabled ? "true" : "false")")
        }
        if !updatedMode {
            insertions.append("  mode: \(mode)")
        }
        if !insertions.isEmpty {
            lines.insert(contentsOf: insertions, at: insertIndex ?? lines.count)
        }

        return lines.joined(separator: "\n")
    }
}
