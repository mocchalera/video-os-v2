import Foundation

public struct ProjectPackagePreflightStatus: Equatable, Sendable, Decodable {
    public let available: Bool
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
        projectDir: String? = nil,
        issues: [String] = [],
        nextSteps: [String] = [],
        sourceOfTruth: String? = nil,
        autonomyMode: String? = nil,
        projectID: String? = nil,
        currentState: String? = nil,
        visualQaSummary: String? = nil
    ) {
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

    public var contractIsComplete: Bool {
        guard ok else { return true }
        return !(projectID?.isEmpty ?? true)
            && (currentState == "approved" || currentState == "packaged")
            && (sourceOfTruth == "engine_render" || sourceOfTruth == "nle_finishing")
    }

    public var failureLabel: String? {
        guard available else { return "package preflight unavailable" }
        guard contractIsComplete else { return "package preflight incomplete" }
        guard ok else { return issues.first ?? "package preflight blocked" }
        return nil
    }

    public var canPackage: Bool {
        failureLabel == nil
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
            let expectedExitStatus: Int32 = decoded.ok ? 0 : 1
            guard output.status == expectedExitStatus else {
                return .unavailable("package preflight returned a contradictory exit status")
            }
            guard let reportedProjectDir = decoded.projectDir,
                  !reportedProjectDir.isEmpty else {
                return .unavailable("package preflight omitted the project path")
            }
            let reportedURL = URL(fileURLWithPath: reportedProjectDir).standardizedFileURL
            if reportedURL.path != projectURL.standardizedFileURL.path {
                return .unavailable("package preflight returned a different project path")
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
