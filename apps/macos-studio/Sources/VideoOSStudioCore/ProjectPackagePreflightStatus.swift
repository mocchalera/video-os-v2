import Foundation

public enum ProjectPackagePreflightDecision: String, Equatable, Sendable, Decodable {
    case readyToRun = "ready_to_run"
    case blocked
}

public enum ProjectPackagePreflightIdentityStatus: String, Equatable, Sendable, Decodable {
    case confirmed
    case inferred
    case unresolved
    case conflict
}

public enum ProjectPackagePreflightIdentityArtifact: String, Equatable, Sendable, Decodable {
    case timeline
    case state
    case qa
    case manifest
}

public enum ProjectPackagePreflightIdentitySourceStatus: String, Equatable, Sendable, Decodable {
    case present
    case missing
    case empty
    case malformed
}

public struct ProjectPackagePreflightIdentitySource: Equatable, Sendable, Decodable {
    public let artifact: ProjectPackagePreflightIdentityArtifact
    public let path: String
    public let status: ProjectPackagePreflightIdentitySourceStatus
    public let projectID: String?

    private enum CodingKeys: String, CodingKey {
        case artifact
        case path
        case status
        case projectID = "project_id"
    }
}

public struct ProjectPackagePreflightIdentity: Equatable, Sendable, Decodable {
    public let status: ProjectPackagePreflightIdentityStatus
    public let projectID: String?
    public let evidenceCount: Int
    public let sources: [ProjectPackagePreflightIdentitySource]

    public init(
        status: ProjectPackagePreflightIdentityStatus,
        projectID: String? = nil,
        evidenceCount: Int = 0,
        sources: [ProjectPackagePreflightIdentitySource] = []
    ) {
        self.status = status
        self.projectID = projectID
        self.evidenceCount = evidenceCount
        self.sources = sources
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case projectID = "project_id"
        case evidenceCount = "evidence_count"
        case sources
    }
}

public struct ProjectPackagePreflightIssue: Equatable, Sendable, Decodable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct ProjectPackagePreflightNextAction: Equatable, Sendable, Decodable {
    public enum Code: String, Equatable, Sendable, Decodable {
        case runPackage = "run_package"
        case resolveProjectIdentity = "resolve_project_identity"
        case resolvePreflightIssues = "resolve_preflight_issues"
    }

    public let code: Code
    public let message: String

    public init(code: Code, message: String) {
        self.code = code
        self.message = message
    }
}

public struct ProjectPackagePreflightStatus: Equatable, Sendable, Decodable {
    public let version: String
    public let decision: ProjectPackagePreflightDecision
    public let projectIdentity: ProjectPackagePreflightIdentity
    public let structuredIssues: [ProjectPackagePreflightIssue]
    public let nextAction: ProjectPackagePreflightNextAction
    public let available: Bool
    /// package-preflight/v1 compatibility projection. Studio uses decision.
    public let ok: Bool
    public let projectDir: String?
    public let issues: [String]
    public let nextSteps: [String]
    public let sourceOfTruth: String?
    public let autonomyMode: String?
    public let projectID: String?
    public let currentState: String?
    public let visualQaSummary: String?

    public init(
        available: Bool = true,
        ok: Bool,
        version: String = "package-preflight/v2",
        decision: ProjectPackagePreflightDecision? = nil,
        projectIdentity: ProjectPackagePreflightIdentity? = nil,
        structuredIssues: [ProjectPackagePreflightIssue]? = nil,
        nextAction: ProjectPackagePreflightNextAction? = nil,
        projectDir: String? = nil,
        issues: [String] = [],
        nextSteps: [String] = [],
        sourceOfTruth: String? = nil,
        autonomyMode: String? = nil,
        projectID: String? = nil,
        currentState: String? = nil,
        visualQaSummary: String? = nil
    ) {
        let resolvedDecision = decision ?? (ok ? .readyToRun : .blocked)
        self.version = version
        self.decision = resolvedDecision
        self.projectIdentity = projectIdentity ?? ProjectPackagePreflightIdentity(
            status: projectID == nil ? .unresolved : .confirmed,
            projectID: projectID,
            evidenceCount: projectID == nil ? 0 : 1
        )
        self.structuredIssues = structuredIssues ?? issues.map {
            ProjectPackagePreflightIssue(code: "PACKAGE_PREFLIGHT_BLOCKED", message: $0)
        }
        self.nextAction = nextAction ?? ProjectPackagePreflightNextAction(
            code: resolvedDecision == .readyToRun ? .runPackage : .resolvePreflightIssues,
            message: nextSteps.first ?? (resolvedDecision == .readyToRun
                ? "Run package with the same project and options."
                : "Resolve the listed preflight issues, then rerun preflight.")
        )
        self.available = available
        self.ok = ok
        self.projectDir = projectDir
        self.issues = issues
        self.nextSteps = nextSteps
        self.sourceOfTruth = sourceOfTruth
        self.autonomyMode = autonomyMode
        self.projectID = projectID
        self.currentState = currentState
        self.visualQaSummary = visualQaSummary
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case decision
        case projectIdentity = "project_identity"
        case structuredIssues = "structured_issues"
        case nextAction = "next_action"
        case ok
        case projectDir
        case issues
        case nextSteps
        case sourceOfTruth
        case autonomyMode
        case projectID = "projectId"
        case currentState
        case visualQaSummary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        guard version == "package-preflight/v2" else {
            throw DecodingError.dataCorruptedError(
                forKey: .version,
                in: container,
                debugDescription: "unsupported package preflight version"
            )
        }
        decision = try container.decode(ProjectPackagePreflightDecision.self, forKey: .decision)
        projectIdentity = try container.decode(ProjectPackagePreflightIdentity.self, forKey: .projectIdentity)
        structuredIssues = try container.decode([ProjectPackagePreflightIssue].self, forKey: .structuredIssues)
        nextAction = try container.decode(ProjectPackagePreflightNextAction.self, forKey: .nextAction)
        available = true
        ok = try container.decode(Bool.self, forKey: .ok)
        projectDir = try container.decodeIfPresent(String.self, forKey: .projectDir)
        issues = try container.decode([String].self, forKey: .issues)
        nextSteps = try container.decode([String].self, forKey: .nextSteps)
        sourceOfTruth = try container.decodeIfPresent(String.self, forKey: .sourceOfTruth)
        autonomyMode = try container.decodeIfPresent(String.self, forKey: .autonomyMode)
        projectID = try container.decodeIfPresent(String.self, forKey: .projectID)
        currentState = try container.decodeIfPresent(String.self, forKey: .currentState)
        visualQaSummary = try container.decodeIfPresent(String.self, forKey: .visualQaSummary)
    }

    public var failureLabel: String? {
        guard available else { return "package preflight unavailable" }
        guard decision == .blocked else { return nil }
        return structuredIssues.first?.message ?? issues.first ?? "package preflight blocked"
    }

    public var canPackage: Bool {
        available && decision == .readyToRun
    }

    public static func unavailable(_ issue: String) -> ProjectPackagePreflightStatus {
        ProjectPackagePreflightStatus(
            available: false,
            ok: false,
            issues: [issue]
        )
    }
}

public enum ProjectPackagePreflightRunner {
    public typealias Runner = @Sendable (
        _ workingDirectory: URL,
        _ arguments: [String]
    ) throws -> ProjectInitializationProcessResult

    public static func arguments(repositoryRoot: URL, projectURL: URL) -> [String] {
        [
            "npx",
            "tsx",
            repositoryRoot.appendingPathComponent("scripts/package.ts").path,
            projectURL.path,
            "--preflight-only",
            "--json"
        ]
    }

    public static func status(
        repositoryRoot: URL,
        projectURL: URL
    ) -> ProjectPackagePreflightStatus {
        status(repositoryRoot: repositoryRoot, projectURL: projectURL) { workingDirectory, arguments in
            let output = try SubprocessRunner.run(
                arguments: arguments,
                currentDirectoryURL: workingDirectory
            )
            return ProjectInitializationProcessResult(
                status: output.exitCode,
                stdout: output.stdout,
                stderr: output.stderr
            )
        }
    }

    public static func status(
        repositoryRoot: URL,
        projectURL: URL,
        runner: Runner
    ) -> ProjectPackagePreflightStatus {
        let scriptURL = repositoryRoot.appendingPathComponent("scripts/package.ts")
        guard FileManager.default.fileExists(atPath: scriptURL.path) else {
            return .unavailable("scripts/package.ts is missing")
        }
        do {
            let output = try runner(repositoryRoot, arguments(repositoryRoot: repositoryRoot, projectURL: projectURL))
            guard let data = output.stdout.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(ProjectPackagePreflightStatus.self, from: data) else {
                return .unavailable("package preflight returned invalid JSON")
            }
            let expectedExitStatus: Int32 = decoded.decision == .readyToRun ? 0 : 1
            guard output.status == expectedExitStatus else {
                return .unavailable("package preflight returned a contradictory exit status")
            }
            return decoded
        } catch {
            return .unavailable("package preflight could not run: \(error)")
        }
    }

    public static func pending() -> ProjectPackagePreflightStatus {
        .unavailable("package preflight is pending")
    }
}
