import Combine
import Foundation

public enum EditorialPreferenceSourceKind: String, CaseIterable, Identifiable, Sendable {
    case canonicalBlueprint
    case canonicalReviewPatch
    case latestStudioPatch

    public var id: String { rawValue }
}

public enum EditorialPreferenceMemorySourceEvent: String, CaseIterable, Identifiable, Sendable {
    case blueprintAcceptance = "blueprint_acceptance"
    case reviewPatchAcceptance = "review_patch_acceptance"
    case reviewPatchRejection = "review_patch_rejection"

    public var id: String { rawValue }
}

public enum EditorialPreferenceType: String, CaseIterable, Identifiable, Sendable {
    case pacing
    case chronology
    case transitionStyle = "transition_style"
    case repetitionTolerance = "repetition_tolerance"
    case bgmLoudness = "bgm_loudness"
    case captionDensity = "caption_density"
    case deliveryPreference = "delivery_preference"

    public var id: String { rawValue }
}

public enum EditorialPreferencePrimitiveKind: String, CaseIterable, Identifiable, Sendable {
    case string
    case enumeration = "enum"
    case number
    case boolean

    public var id: String { rawValue }
}

public enum EditorialPreferenceScope: String, CaseIterable, Identifiable, Sendable {
    case project
    case profile
    case series

    public var id: String { rawValue }
}

public struct EditorialPreferenceRememberDraft: Equatable, Sendable {
    public var actorID: String
    public var sourceEvent: EditorialPreferenceMemorySourceEvent
    public var sourceKind: EditorialPreferenceSourceKind
    public var preferenceType: EditorialPreferenceType
    public var primitiveKind: EditorialPreferencePrimitiveKind
    public var primitiveValue: String
    public var scope: EditorialPreferenceScope
    public var scopeRef: String
    public var supersedesEntryID: String

    public init(
        actorID: String = "",
        sourceEvent: EditorialPreferenceMemorySourceEvent = .blueprintAcceptance,
        sourceKind: EditorialPreferenceSourceKind = .canonicalBlueprint,
        preferenceType: EditorialPreferenceType = .pacing,
        primitiveKind: EditorialPreferencePrimitiveKind = .enumeration,
        primitiveValue: String = "",
        scope: EditorialPreferenceScope = .project,
        scopeRef: String = "",
        supersedesEntryID: String = ""
    ) {
        self.actorID = actorID
        self.sourceEvent = sourceEvent
        self.sourceKind = sourceKind
        self.preferenceType = preferenceType
        self.primitiveKind = primitiveKind
        self.primitiveValue = primitiveValue
        self.scope = scope
        self.scopeRef = scopeRef
        self.supersedesEntryID = supersedesEntryID
    }
}

public struct EditorialPreferenceRedactDraft: Equatable, Sendable {
    public var targetEntryID: String
    public var reason: String
    public var actorID: String

    public init(targetEntryID: String = "", reason: String = "", actorID: String = "") {
        self.targetEntryID = targetEntryID
        self.reason = reason
        self.actorID = actorID
    }
}

/// Pure submission state. An action ID survives a failed retry, but is replaced
/// after success, a semantic draft change, or a project change.
public struct EditorialPreferenceMemoryActionState: Equatable, Sendable {
    public private(set) var projectID: String?
    public private(set) var rememberActionID: String?
    public private(set) var redactActionID: String?
    private var submittedRememberDraft: EditorialPreferenceRememberDraft?
    private var submittedRedactDraft: EditorialPreferenceRedactDraft?

    public init(projectID: String? = nil) {
        self.projectID = projectID
    }

    public mutating func reset(projectID: String?) {
        self.projectID = projectID
        rememberActionID = nil
        redactActionID = nil
        submittedRememberDraft = nil
        submittedRedactDraft = nil
    }

    public mutating func prepareRemember(
        draft: EditorialPreferenceRememberDraft,
        generateID: () -> String = { UUID().uuidString }
    ) -> String {
        if rememberActionID == nil || submittedRememberDraft != draft {
            rememberActionID = generateID()
            submittedRememberDraft = draft
        }
        return rememberActionID!
    }

    public mutating func prepareRedact(
        draft: EditorialPreferenceRedactDraft,
        generateID: () -> String = { UUID().uuidString }
    ) -> String {
        if redactActionID == nil || submittedRedactDraft != draft {
            redactActionID = generateID()
            submittedRedactDraft = draft
        }
        return redactActionID!
    }

    public mutating func markRememberSucceeded(actionID: String) {
        guard rememberActionID == actionID else { return }
        rememberActionID = nil
        submittedRememberDraft = nil
    }

    public mutating func markRedactSucceeded(actionID: String) {
        guard redactActionID == actionID else { return }
        redactActionID = nil
        submittedRedactDraft = nil
    }
}

@MainActor
public final class EditorialPreferenceMemorySession: ObservableObject {
    @Published public var rememberDraft: EditorialPreferenceRememberDraft
    @Published public var redactDraft: EditorialPreferenceRedactDraft
    @Published public private(set) var actionState: EditorialPreferenceMemoryActionState
    @Published public var isRunning = false
    @Published public var statusMessage = "判断の記憶はまだ実行されていません。"

    public init(projectID: String? = nil) {
        rememberDraft = EditorialPreferenceRememberDraft(scopeRef: projectID ?? "")
        redactDraft = EditorialPreferenceRedactDraft()
        actionState = EditorialPreferenceMemoryActionState(projectID: projectID)
    }

    public func resetForProject(_ projectID: String?) {
        rememberDraft = EditorialPreferenceRememberDraft(scopeRef: projectID ?? "")
        redactDraft = EditorialPreferenceRedactDraft()
        actionState.reset(projectID: projectID)
        isRunning = false
        statusMessage = projectID == nil
            ? "プロジェクトを選択してください。"
            : "このプロジェクトでは判断の記憶をまだ実行していません。"
    }

    public func prepareRememberActionID(generateID: () -> String = { UUID().uuidString }) -> String {
        actionState.prepareRemember(draft: rememberDraft, generateID: generateID)
    }

    public func prepareRedactActionID(generateID: () -> String = { UUID().uuidString }) -> String {
        actionState.prepareRedact(draft: redactDraft, generateID: generateID)
    }

    public func markRememberSucceeded(actionID: String) {
        guard actionState.rememberActionID == actionID else { return }
        actionState.markRememberSucceeded(actionID: actionID)
        rememberDraft.primitiveValue = ""
        rememberDraft.supersedesEntryID = ""
    }

    public func markRedactSucceeded(actionID: String) {
        guard actionState.redactActionID == actionID else { return }
        actionState.markRedactSucceeded(actionID: actionID)
        redactDraft.targetEntryID = ""
        redactDraft.reason = ""
    }
}

public struct ProjectEditorialPreferenceMemoryPlan: Equatable, Sendable {
    public enum Action: String, Sendable {
        case remember
        case redact
    }

    public let action: Action
    public let repositoryRoot: URL
    public let projectURL: URL
    public let projectID: String
    public let scriptURL: URL
    public let sourceURL: URL?
    public let commandArguments: [String]
    public let readinessIssues: [String]

    public var canRun: Bool { readinessIssues.isEmpty }
    public var readinessLabel: String { readinessIssues.first ?? "ready" }
}

public enum ProjectEditorialPreferenceMemoryPlanner {
    public static func rememberPlan(
        repositoryRoot: URL,
        projectURL: URL,
        projectID: String,
        actionID: String,
        draft: EditorialPreferenceRememberDraft
    ) -> ProjectEditorialPreferenceMemoryPlan {
        let scriptURL = repositoryRoot.appendingPathComponent("scripts/editorial-preference-memory.ts")
        let source = resolveSource(projectURL: projectURL, projectID: projectID, kind: draft.sourceKind)
        var issues = baseReadinessIssues(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            projectID: projectID,
            scriptURL: scriptURL
        )
        issues += source.issues
        if !isTrimmedNonEmpty(actionID, maximum: 256) { issues.append("action ID is required") }
        if !validCombination(event: draft.sourceEvent, source: draft.sourceKind) {
            issues.append("source outcome and artifact kind do not match")
        }
        issues += rememberDraftIssues(draft, projectID: projectID)

        var arguments = [
            "npx", "tsx", scriptURL.path, "remember",
            "--project", projectURL.path,
            "--project-id", projectID,
            "--action-id", actionID,
            "--actor-id", draft.actorID,
            "--source-event", draft.sourceEvent.rawValue,
            "--source", source.relativePath ?? "",
            "--type", draft.preferenceType.rawValue,
            "--kind", draft.primitiveKind.rawValue,
            "--value", draft.primitiveValue,
            "--scope", draft.scope.rawValue,
            "--scope-ref", effectiveScopeRef(draft, projectID: projectID)
        ]
        if !draft.supersedesEntryID.isEmpty {
            arguments += ["--supersedes", draft.supersedesEntryID]
        }
        arguments.append("--json")

        return ProjectEditorialPreferenceMemoryPlan(
            action: .remember,
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            projectID: projectID,
            scriptURL: scriptURL,
            sourceURL: source.url,
            commandArguments: arguments,
            readinessIssues: unique(issues)
        )
    }

    public static func redactPlan(
        repositoryRoot: URL,
        projectURL: URL,
        projectID: String,
        actionID: String,
        draft: EditorialPreferenceRedactDraft
    ) -> ProjectEditorialPreferenceMemoryPlan {
        let scriptURL = repositoryRoot.appendingPathComponent("scripts/editorial-preference-memory.ts")
        var issues = baseReadinessIssues(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            projectID: projectID,
            scriptURL: scriptURL
        )
        if !isTrimmedNonEmpty(actionID, maximum: 256) { issues.append("action ID is required") }
        if !isTrimmedNonEmpty(draft.actorID, maximum: 256) { issues.append("actor is required") }
        if !isTrimmedNonEmpty(draft.targetEntryID, maximum: 128) { issues.append("target entry ID is required") }
        if !isTrimmedNonEmpty(draft.reason, maximum: 256) { issues.append("redaction reason is required") }
        let arguments = [
            "npx", "tsx", scriptURL.path, "redact",
            "--project", projectURL.path,
            "--project-id", projectID,
            "--action-id", actionID,
            "--actor-id", draft.actorID,
            "--target", draft.targetEntryID,
            "--reason", draft.reason,
            "--json"
        ]
        return ProjectEditorialPreferenceMemoryPlan(
            action: .redact,
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            projectID: projectID,
            scriptURL: scriptURL,
            sourceURL: nil,
            commandArguments: arguments,
            readinessIssues: unique(issues)
        )
    }

    public static func effectiveScopeRef(_ draft: EditorialPreferenceRememberDraft, projectID: String) -> String {
        draft.scope == .project ? projectID : draft.scopeRef
    }

    private static func validCombination(
        event: EditorialPreferenceMemorySourceEvent,
        source: EditorialPreferenceSourceKind
    ) -> Bool {
        switch source {
        case .canonicalBlueprint:
            return event == .blueprintAcceptance
        case .canonicalReviewPatch, .latestStudioPatch:
            return event == .reviewPatchAcceptance || event == .reviewPatchRejection
        }
    }

    private static func rememberDraftIssues(_ draft: EditorialPreferenceRememberDraft, projectID: String) -> [String] {
        var issues: [String] = []
        if !isTrimmedNonEmpty(draft.actorID, maximum: 256) { issues.append("actor is required") }
        if !isTrimmedNonEmpty(draft.primitiveValue, maximum: draft.primitiveKind == .enumeration ? 64 : 256) {
            issues.append("preference value is required")
        }
        if !draft.supersedesEntryID.isEmpty && !isTrimmedNonEmpty(draft.supersedesEntryID, maximum: 128) {
            issues.append("supersedes entry ID is invalid")
        }
        let allowedKinds: [EditorialPreferenceType: Set<EditorialPreferencePrimitiveKind>] = [
            .pacing: [.string, .enumeration],
            .chronology: [.boolean, .enumeration],
            .transitionStyle: [.string, .enumeration],
            .repetitionTolerance: [.number, .enumeration],
            .bgmLoudness: [.number, .enumeration],
            .captionDensity: [.number, .enumeration],
            .deliveryPreference: [.string, .enumeration]
        ]
        if allowedKinds[draft.preferenceType]?.contains(draft.primitiveKind) != true {
            issues.append("preference type and value kind do not match")
        }
        if draft.primitiveKind == .number {
            guard let value = Double(draft.primitiveValue), value.isFinite else {
                issues.append("number value is invalid")
                return issues
            }
            let range = draft.preferenceType == .bgmLoudness ? -60.0 ... 12.0 : 0.0 ... 1.0
            if !range.contains(value) { issues.append("number value is outside the allowed range") }
        }
        if draft.primitiveKind == .boolean && !["true", "false"].contains(draft.primitiveValue) {
            issues.append("boolean value must be true or false")
        }
        if draft.primitiveKind == .enumeration,
           draft.primitiveValue.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"#, options: .regularExpression) == nil {
            issues.append("enum value contains unsupported characters")
        }
        let scopeRef = effectiveScopeRef(draft, projectID: projectID)
        if !isTrimmedNonEmpty(scopeRef, maximum: 256) { issues.append("scope reference is required") }
        return issues
    }

    private static func baseReadinessIssues(
        repositoryRoot: URL,
        projectURL: URL,
        projectID: String,
        scriptURL: URL
    ) -> [String] {
        var issues: [String] = []
        if !isDirectory(repositoryRoot) { issues.append("repository root is missing") }
        if !isDirectory(projectURL) { issues.append("project directory is missing") }
        if !isTrimmedNonEmpty(projectID, maximum: 256) { issues.append("project ID is required") }
        if !FileManager.default.fileExists(atPath: scriptURL.path) { issues.append("editorial preference writer script is missing") }
        if isDirectory(projectURL), isTrimmedNonEmpty(projectID, maximum: 256) {
            let stateURL = projectURL.appendingPathComponent("project_state.yaml")
            guard let text = try? String(contentsOf: stateURL, encoding: .utf8) else {
                issues.append("project state is missing")
                return issues
            }
            guard projectIDFromState(text) == projectID else {
                issues.append("project state project ID does not match")
                return issues
            }
        }
        return issues
    }

    private static func resolveSource(
        projectURL: URL,
        projectID: String,
        kind: EditorialPreferenceSourceKind
    ) -> (url: URL?, relativePath: String?, issues: [String]) {
        switch kind {
        case .canonicalBlueprint:
            return source(projectURL: projectURL, relativePath: "04_plan/edit_blueprint.yaml")
        case .canonicalReviewPatch:
            return source(projectURL: projectURL, relativePath: "06_review/review_patch.json")
        case .latestStudioPatch:
            let indexURL = PatchHistoryIndex.indexURL(projectURL: projectURL)
            guard FileManager.default.fileExists(atPath: indexURL.path),
                  let data = try? Data(contentsOf: indexURL),
                  let index = try? JSONDecoder().decode(PatchHistoryIndex.self, from: data)
            else {
                return (nil, nil, ["patch history index is missing or invalid"])
            }
            guard index.project_id == projectID else {
                return (nil, nil, ["patch history project ID does not match"])
            }
            guard let latest = index.records.last else {
                return (nil, nil, ["registered Studio patch is missing"])
            }
            let relativePath = latest.patch_path
            guard !relativePath.isEmpty,
                  !relativePath.hasPrefix("../"),
                  !(relativePath as NSString).isAbsolutePath else {
                return (nil, nil, ["latest Studio patch path is invalid"])
            }
            return source(projectURL: projectURL, relativePath: relativePath)
        }
    }

    private static func source(
        projectURL: URL,
        relativePath: String
    ) -> (url: URL?, relativePath: String?, issues: [String]) {
        let url = projectURL.appendingPathComponent(relativePath).standardizedFileURL
        let root = projectURL.standardizedFileURL.path
        guard url.path == root || url.path.hasPrefix(root + "/") else {
            return (nil, nil, ["source artifact escapes the project"])
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            return (url, relativePath, ["source artifact is missing"])
        }
        let realRoot = projectURL.resolvingSymlinksInPath().standardizedFileURL.path
        let realSource = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard realSource == realRoot || realSource.hasPrefix(realRoot + "/") else {
            return (url, relativePath, ["source artifact symlink escapes the project"])
        }
        return (url, relativePath, [])
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private static func isTrimmedNonEmpty(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.count <= maximum && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func projectIDFromState(_ text: String) -> String? {
        for rawLine in text.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("project_id:") else { continue }
            var value = String(line.dropFirst("project_id:".count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let comment = value.firstIndex(of: "#") {
                value = String(value[..<comment]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if value.count >= 2,
               (value.hasPrefix("\"") && value.hasSuffix("\"") || value.hasPrefix("'") && value.hasSuffix("'")) {
                value.removeFirst()
                value.removeLast()
            }
            return value.isEmpty ? nil : value
        }
        return nil
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}

public struct ProjectEditorialPreferenceMemoryOutput: Decodable, Equatable, Sendable {
    public struct Entry: Decodable, Equatable, Sendable {
        public let projectID: String
        public let entryID: String

        private enum CodingKeys: String, CodingKey {
            case projectID = "project_id"
            case entryID = "entry_id"
        }
    }

    public let status: String
    public let entry: Entry
    public let path: String
    public let consumedOffset: Int
    public let consumedHash: String

    private enum CodingKeys: String, CodingKey {
        case status, entry, path
        case consumedOffset = "consumedOffset"
        case consumedHash = "consumedHash"
    }
}

public struct ProjectEditorialPreferenceMemoryResult: Equatable, Sendable {
    public let plan: ProjectEditorialPreferenceMemoryPlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let output: ProjectEditorialPreferenceMemoryOutput?

    public var succeeded: Bool {
        exitCode == 0 && output.map { ["appended", "idempotent"].contains($0.status) } == true
    }
}

public enum ProjectEditorialPreferenceMemoryError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let reason): return reason
        }
    }
}

public enum ProjectEditorialPreferenceMemoryRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func run(plan: ProjectEditorialPreferenceMemoryPlan) throws -> ProjectEditorialPreferenceMemoryResult {
        try run(plan: plan) { workingDirectory, arguments in
            let output = try SubprocessRunner.run(arguments: arguments, currentDirectoryURL: workingDirectory)
            return ProjectInitializationProcessResult(status: output.exitCode, stdout: output.stdout, stderr: output.stderr)
        }
    }

    public static func run(
        plan: ProjectEditorialPreferenceMemoryPlan,
        runner: Runner
    ) throws -> ProjectEditorialPreferenceMemoryResult {
        guard plan.canRun else { throw ProjectEditorialPreferenceMemoryError.notReady(plan.readinessLabel) }
        let process = try runner(plan.repositoryRoot, plan.commandArguments)
        let output = try? JSONDecoder().decode(ProjectEditorialPreferenceMemoryOutput.self, from: Data(process.stdout.utf8))
        return ProjectEditorialPreferenceMemoryResult(
            plan: plan,
            exitCode: process.status,
            stdout: process.stdout,
            stderr: process.stderr,
            output: output
        )
    }
}
