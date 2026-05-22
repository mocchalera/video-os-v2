import Foundation

public struct ProjectAudioStoryGraphRunPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let scriptURL: URL

    public var canRun: Bool {
        FileManager.default.fileExists(atPath: scriptURL.path)
            && FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("03_analysis/assets.json").path)
    }

    public var readinessLabel: String {
        if !FileManager.default.fileExists(atPath: scriptURL.path) {
            return "missing script"
        }
        if !FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("03_analysis/assets.json").path) {
            return "analysis missing"
        }
        return "ready"
    }

    public var commandArguments: [String] {
        ["npx", "tsx", scriptURL.path, projectURL.path]
    }

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

public struct ProjectAudioStoryGraphRunResult: Equatable, Sendable {
    public let plan: ProjectAudioStoryGraphRunPlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let indexSummary: ProjectIndexSummary?

    public var succeeded: Bool {
        exitCode == 0
    }
}

public enum ProjectAudioStoryGraphRunError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        }
    }
}

public enum ProjectAudioStoryGraphRunPlanner {
    public static func plan(repositoryRoot: URL, projectURL: URL) -> ProjectAudioStoryGraphRunPlan {
        ProjectAudioStoryGraphRunPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/build-audio-story-graph.ts")
        )
    }
}

public enum ProjectAudioStoryGraphRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func run(
        plan: ProjectAudioStoryGraphRunPlan,
        rebuildIndex: Bool = true
    ) throws -> ProjectAudioStoryGraphRunResult {
        try run(plan: plan, rebuildIndex: rebuildIndex, runner: { workingDirectory, arguments in
            try runProcess(workingDirectory: workingDirectory, arguments: arguments)
        })
    }

    public static func run(
        plan: ProjectAudioStoryGraphRunPlan,
        rebuildIndex: Bool = true,
        runner: Runner
    ) throws -> ProjectAudioStoryGraphRunResult {
        guard plan.canRun else {
            throw ProjectAudioStoryGraphRunError.notReady(plan.readinessLabel)
        }

        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        let indexSummary = result.status == 0 && rebuildIndex
            ? try ProjectSQLiteIndex.rebuild(projectURL: plan.projectURL)
            : nil

        return ProjectAudioStoryGraphRunResult(
            plan: plan,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            indexSummary: indexSummary
        )
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
