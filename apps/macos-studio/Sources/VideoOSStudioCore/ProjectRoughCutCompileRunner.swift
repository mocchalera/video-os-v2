import Foundation

public struct ProjectRoughCutCompileOptions: Equatable, Sendable {
    public var patchURL: URL?
    public var fps: Int?
    public var sourceMapURL: URL?
    public var skipPreview: Bool
    public var skipConfirmations: Bool

    public init(
        patchURL: URL? = nil,
        fps: Int? = nil,
        sourceMapURL: URL? = nil,
        skipPreview: Bool = false,
        skipConfirmations: Bool = true
    ) {
        self.patchURL = patchURL
        self.fps = fps
        self.sourceMapURL = sourceMapURL
        self.skipPreview = skipPreview
        self.skipConfirmations = skipConfirmations
    }
}

public struct ProjectRoughCutCompilePlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let scriptURL: URL
    public let options: ProjectRoughCutCompileOptions
    public let hasCreativeBrief: Bool
    public let hasSelects: Bool
    public let hasBlueprint: Bool
    public let resolvedSourceMapURL: URL?

    public var timelineURL: URL {
        projectURL.appendingPathComponent("05_timeline/timeline.json")
    }

    public var canRun: Bool {
        FileManager.default.fileExists(atPath: scriptURL.path)
            && hasCreativeBrief
            && hasSelects
            && hasBlueprint
            && patchIsReadable
    }

    public var readinessLabel: String {
        if !FileManager.default.fileExists(atPath: scriptURL.path) {
            return "missing compile script"
        }
        if !hasCreativeBrief {
            return "missing creative brief"
        }
        if !hasSelects {
            return "missing selects"
        }
        if !hasBlueprint {
            return "missing blueprint"
        }
        if !patchIsReadable {
            return "patch file missing"
        }
        return FileManager.default.fileExists(atPath: timelineURL.path) ? "ready to recompile" : "ready"
    }

    public var commandArguments: [String] {
        var args = ["npx", "tsx", scriptURL.path, projectURL.path]
        if let patchURL = options.patchURL {
            args += ["--patch", patchURL.path]
        }
        if let fps = options.fps {
            args += ["--fps", "\(max(1, fps))"]
        }
        if let sourceMapURL = resolvedSourceMapURL {
            args += ["--source-map", sourceMapURL.path]
        }
        if options.skipPreview {
            args.append("--skip-preview")
        }
        if options.skipConfirmations {
            args += ["--skip-confirmations", "true"]
        }
        return args
    }

    public var commandLine: String {
        commandArguments.map(shellQuote).joined(separator: " ")
    }

    private var patchIsReadable: Bool {
        guard let patchURL = options.patchURL else { return true }
        return FileManager.default.fileExists(atPath: patchURL.path)
    }

    private func shellQuote(_ value: String) -> String {
        guard !value.isEmpty else { return "''" }
        if value.range(of: #"[^A-Za-z0-9_@%+=:,./-]"#, options: .regularExpression) == nil {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

public struct ProjectRoughCutCompileResult: Equatable, Sendable {
    public let plan: ProjectRoughCutCompilePlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let timelineExists: Bool
    public let indexSummary: ProjectIndexSummary?

    public var succeeded: Bool {
        exitCode == 0 && timelineExists
    }
}

public enum ProjectRoughCutCompileError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        }
    }
}

public enum ProjectRoughCutCompilePlanner {
    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        options: ProjectRoughCutCompileOptions = ProjectRoughCutCompileOptions()
    ) -> ProjectRoughCutCompilePlan {
        let sourceMapURL = options.sourceMapURL ?? defaultSourceMapURL(projectURL: projectURL)
        return ProjectRoughCutCompilePlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/compile-timeline.ts"),
            options: options,
            hasCreativeBrief: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("01_intent/creative_brief.yaml").path),
            hasSelects: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("04_plan/selects_candidates.yaml").path),
            hasBlueprint: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("04_plan/edit_blueprint.yaml").path),
            resolvedSourceMapURL: sourceMapURL
        )
    }

    private static func defaultSourceMapURL(projectURL: URL) -> URL? {
        let url = projectURL.appendingPathComponent("02_media/source_map.json")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

public enum ProjectRoughCutCompileRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func run(
        plan: ProjectRoughCutCompilePlan,
        rebuildIndex: Bool = true
    ) throws -> ProjectRoughCutCompileResult {
        try run(plan: plan, rebuildIndex: rebuildIndex, runner: { workingDirectory, arguments in
            try runProcess(workingDirectory: workingDirectory, arguments: arguments)
        })
    }

    public static func run(
        plan: ProjectRoughCutCompilePlan,
        rebuildIndex: Bool = true,
        runner: Runner
    ) throws -> ProjectRoughCutCompileResult {
        guard plan.canRun else {
            throw ProjectRoughCutCompileError.notReady(plan.readinessLabel)
        }
        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        let timelineExists = FileManager.default.fileExists(atPath: plan.timelineURL.path)
        let indexSummary = result.status == 0 && timelineExists && rebuildIndex
            ? try ProjectSQLiteIndex.rebuild(projectURL: plan.projectURL)
            : nil
        return ProjectRoughCutCompileResult(
            plan: plan,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            timelineExists: timelineExists,
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
