import Foundation

public struct ProjectPackageVerificationCheck: Equatable, Sendable, Decodable {
    public let name: String
    public let passed: Bool
    public let details: String

    public init(name: String, passed: Bool, details: String) {
        self.name = name
        self.passed = passed
        self.details = details
    }
}

public struct ProjectPackageVerificationStatus: Equatable, Sendable, Decodable {
    public let available: Bool
    public let ready: Bool
    public let projectDir: String?
    public let readinessLabel: String
    public let issues: [String]
    public let checks: [ProjectPackageVerificationCheck]
    public let projectID: String?
    public let sourceOfTruth: String?

    public init(
        available: Bool = true,
        ready: Bool,
        projectDir: String? = nil,
        readinessLabel: String,
        issues: [String] = [],
        checks: [ProjectPackageVerificationCheck] = [],
        projectID: String? = nil,
        sourceOfTruth: String? = nil
    ) {
        self.available = available
        self.ready = ready
        self.projectDir = projectDir
        self.readinessLabel = readinessLabel
        self.issues = issues
        self.checks = checks
        self.projectID = projectID
        self.sourceOfTruth = sourceOfTruth
    }

    private enum CodingKeys: String, CodingKey {
        case ready
        case projectDir
        case readinessLabel
        case issues
        case checks
        case projectID = "projectId"
        case sourceOfTruth
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = true
        ready = try container.decode(Bool.self, forKey: .ready)
        projectDir = try container.decodeIfPresent(String.self, forKey: .projectDir)
        readinessLabel = try container.decode(String.self, forKey: .readinessLabel)
        issues = try container.decode([String].self, forKey: .issues)
        checks = try container.decode([ProjectPackageVerificationCheck].self, forKey: .checks)
        projectID = try container.decodeIfPresent(String.self, forKey: .projectID)
        sourceOfTruth = try container.decodeIfPresent(String.self, forKey: .sourceOfTruth)
    }

    public static func unavailable(_ issue: String) -> ProjectPackageVerificationStatus {
        ProjectPackageVerificationStatus(
            available: false,
            ready: false,
            readinessLabel: "package verification unavailable",
            issues: [issue]
        )
    }

    public var contractIsComplete: Bool {
        guard ready else { return readinessLabel != "render packaged" }
        return readinessLabel == "render packaged"
            && issues.isEmpty
            && !checks.isEmpty
            && checks.allSatisfy(\.passed)
            && !(projectID?.isEmpty ?? true)
            && (sourceOfTruth == "engine_render" || sourceOfTruth == "nle_finishing")
    }
}

public enum ProjectPackageVerificationRunner {
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
            "--verify-existing",
            "--json"
        ]
    }

    public static func status(
        repositoryRoot: URL,
        projectURL: URL
    ) -> ProjectPackageVerificationStatus {
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
    ) -> ProjectPackageVerificationStatus {
        let scriptURL = repositoryRoot.appendingPathComponent("scripts/package.ts")
        guard FileManager.default.fileExists(atPath: scriptURL.path) else {
            return .unavailable("scripts/package.ts is missing")
        }
        do {
            let output = try runner(repositoryRoot, arguments(repositoryRoot: repositoryRoot, projectURL: projectURL))
            guard let data = output.stdout.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(ProjectPackageVerificationStatus.self, from: data) else {
                return .unavailable("package verification returned invalid JSON")
            }
            guard decoded.contractIsComplete else {
                return .unavailable("package verification returned an incomplete contract")
            }
            let expectedExitStatus: Int32 = decoded.ready ? 0 : 1
            guard output.status == expectedExitStatus else {
                return .unavailable("package verification returned a contradictory exit status")
            }
            guard let reportedProjectDir = decoded.projectDir,
                  !reportedProjectDir.isEmpty else {
                return .unavailable("package verification omitted the project path")
            }
            let reportedURL = URL(fileURLWithPath: reportedProjectDir).standardizedFileURL
            if reportedURL.path != projectURL.standardizedFileURL.path {
                return .unavailable("package verification returned a different project path")
            }
            return decoded
        } catch {
            return .unavailable("package verification could not run: \(error)")
        }
    }

    public static func pending() -> ProjectPackageVerificationStatus {
        .unavailable("package verification is pending")
    }
}
