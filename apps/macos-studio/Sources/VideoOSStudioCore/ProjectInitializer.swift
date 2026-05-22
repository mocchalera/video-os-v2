import Foundation

public struct ProjectInitializationPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectID: String
    public let sourceDirectory: URL?
    public let projectURL: URL
    public let commandArguments: [String]

    public var commandLine: String {
        commandArguments.map(shellQuote).joined(separator: " ")
    }

    private func shellQuote(_ value: String) -> String {
        guard !value.isEmpty else { return "''" }
        if value.range(of: #"[^A-Za-z0-9_@%+=:,./-]"#, options: .regularExpression) == nil {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

public struct ProjectInitializationResult: Equatable, Sendable {
    public let plan: ProjectInitializationPlan
    public let stdout: String
    public let stderr: String
    public let projectURL: URL
    public let sourceLinkURL: URL?
    public let nextStepCommand: String?
}

public enum ProjectInitializationError: Error, Equatable, CustomStringConvertible {
    case invalidProjectID(String)
    case reservedProjectID
    case templateMissing(URL)
    case projectAlreadyExists(URL)
    case sourceDirectoryMissing(URL)
    case processFailed(status: Int32, stdout: String, stderr: String)
    case projectMissing(URL)

    public var description: String {
        switch self {
        case .invalidProjectID(let projectID):
            return "Invalid project id '\(projectID)'. Use letters, numbers, dots, underscores, or hyphens only."
        case .reservedProjectID:
            return "Project id '_template' is reserved."
        case .templateMissing(let url):
            return "Template project was not found: \(url.path)"
        case .projectAlreadyExists(let url):
            return "Project already exists: \(url.path)"
        case .sourceDirectoryMissing(let url):
            return "Source directory was not found: \(url.path)"
        case .processFailed(let status, let stdout, let stderr):
            return "Project init failed with status \(status).\n\(stdout)\n\(stderr)"
        case .projectMissing(let url):
            return "Project init finished but the project directory was not found: \(url.path)"
        }
    }
}

public enum ProjectInitializer {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func plan(
        repositoryRoot: URL,
        projectID: String,
        sourceDirectory: URL? = nil
    ) throws -> ProjectInitializationPlan {
        let normalizedID = projectID.trimmingCharacters(in: .whitespacesAndNewlines)
        try validateProjectID(normalizedID)

        let templateURL = repositoryRoot.appendingPathComponent("projects/_template")
        guard isDirectory(templateURL) else {
            throw ProjectInitializationError.templateMissing(templateURL)
        }

        let projectURL = repositoryRoot.appendingPathComponent("projects/\(normalizedID)")
        if FileManager.default.fileExists(atPath: projectURL.path) {
            throw ProjectInitializationError.projectAlreadyExists(projectURL)
        }

        let sourceURL = sourceDirectory?.standardizedFileURL
        if let sourceURL, !isDirectory(sourceURL) {
            throw ProjectInitializationError.sourceDirectoryMissing(sourceURL)
        }

        var arguments = ["npx", "tsx", "scripts/init-project.ts", normalizedID]
        if let sourceURL {
            arguments += ["--source-dir", sourceURL.path]
        }
        return ProjectInitializationPlan(
            repositoryRoot: repositoryRoot,
            projectID: normalizedID,
            sourceDirectory: sourceURL,
            projectURL: projectURL,
            commandArguments: arguments
        )
    }

    public static func run(plan: ProjectInitializationPlan) throws -> ProjectInitializationResult {
        try run(plan: plan, runner: { workingDirectory, arguments in
            try runProcess(workingDirectory: workingDirectory, arguments: arguments)
        })
    }

    public static func run(
        plan: ProjectInitializationPlan,
        runner: Runner
    ) throws -> ProjectInitializationResult {
        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        guard result.status == 0 else {
            throw ProjectInitializationError.processFailed(status: result.status, stdout: result.stdout, stderr: result.stderr)
        }
        guard FileManager.default.fileExists(atPath: plan.projectURL.path) else {
            throw ProjectInitializationError.projectMissing(plan.projectURL)
        }

        let sourceLinkURL = plan.projectURL.appendingPathComponent("02_media/source")
        return ProjectInitializationResult(
            plan: plan,
            stdout: result.stdout,
            stderr: result.stderr,
            projectURL: plan.projectURL,
            sourceLinkURL: FileManager.default.fileExists(atPath: sourceLinkURL.path) ? sourceLinkURL : nil,
            nextStepCommand: parseNextStepCommand(result.stdout)
        )
    }

    private static func validateProjectID(_ projectID: String) throws {
        guard projectID != "_template" else {
            throw ProjectInitializationError.reservedProjectID
        }
        guard projectID.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil else {
            throw ProjectInitializationError.invalidProjectID(projectID)
        }
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private static func parseNextStepCommand(_ stdout: String) -> String? {
        let lines = stdout.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let nextIndex = lines.firstIndex(of: "Next step:") else { return nil }
        return lines.dropFirst(nextIndex + 1).first { !$0.isEmpty }
    }

    private static func runProcess(
        workingDirectory: URL,
        arguments: [String]
    ) throws -> ProjectInitializationProcessResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = arguments
        process.currentDirectoryURL = workingDirectory

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()

        return ProjectInitializationProcessResult(
            status: process.terminationStatus,
            stdout: String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "",
            stderr: String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        )
    }
}

public struct ProjectInitializationProcessResult: Equatable, Sendable {
    public let status: Int32
    public let stdout: String
    public let stderr: String
}
