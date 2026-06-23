import Foundation

public struct ProjectAnalysisRunOptions: Equatable, Sendable {
    public var skipSTT: Bool
    public var skipVLM: Bool
    public var skipDiarize: Bool
    public var skipPeak: Bool
    public var skipMarlin: Bool
    public var skipAppraiser: Bool
    public var skipMediaLink: Bool
    public var skipPreflight: Bool
    public var language: String?
    public var contentHint: String?
    public var concurrency: Int?
    public var noCache: Bool
    public var clearCache: Bool

    public init(
        skipSTT: Bool = false,
        skipVLM: Bool = false,
        skipDiarize: Bool = false,
        skipPeak: Bool = false,
        skipMarlin: Bool = false,
        skipAppraiser: Bool = false,
        skipMediaLink: Bool = false,
        skipPreflight: Bool = false,
        language: String? = nil,
        contentHint: String? = nil,
        concurrency: Int? = nil,
        noCache: Bool = false,
        clearCache: Bool = false
    ) {
        self.skipSTT = skipSTT
        self.skipVLM = skipVLM
        self.skipDiarize = skipDiarize
        self.skipPeak = skipPeak
        self.skipMarlin = skipMarlin
        self.skipAppraiser = skipAppraiser
        self.skipMediaLink = skipMediaLink
        self.skipPreflight = skipPreflight
        self.language = language
        self.contentHint = contentHint
        self.concurrency = concurrency
        self.noCache = noCache
        self.clearCache = clearCache
    }

    public static let nativeLocalDefaults = ProjectAnalysisRunOptions(
        skipSTT: true,
        skipVLM: true,
        skipDiarize: true,
        skipPeak: true,
        skipMarlin: true,
        skipAppraiser: true,
        skipMediaLink: true,
        skipPreflight: true,
        concurrency: 1,
        noCache: true
    )
}

public struct ProjectAnalysisRunPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let sourceDirectory: URL
    public let sourceURLs: [URL]
    public let skippedSourceCount: Int
    public let scriptURL: URL
    public let options: ProjectAnalysisRunOptions

    public var sourceCount: Int {
        sourceURLs.count
    }

    public var canRun: Bool {
        FileManager.default.fileExists(atPath: scriptURL.path) && sourceCount > 0
    }

    public var readinessLabel: String {
        if !FileManager.default.fileExists(atPath: scriptURL.path) {
            return "missing analyze script"
        }
        if !ProjectAnalysisRunPlanner.isDirectory(sourceDirectory) {
            return "source folder missing"
        }
        if sourceURLs.isEmpty {
            return "no source media"
        }
        return "ready"
    }

    public var commandArguments: [String] {
        var args = ["npx", "tsx", scriptURL.path]
        args.append(contentsOf: sourceURLs.map(\.path))
        args += ["--project", projectURL.path]
        if options.skipSTT { args.append("--skip-stt") }
        if options.skipVLM { args.append("--skip-vlm") }
        if options.skipDiarize { args.append("--skip-diarize") }
        if options.skipPeak { args.append("--skip-peak") }
        if options.skipMarlin { args.append("--skip-marlin") }
        if options.skipAppraiser { args.append("--skip-appraiser") }
        if options.skipMediaLink { args.append("--skip-media-link") }
        if options.skipPreflight { args.append("--skip-preflight") }
        if let language = options.language, !language.isEmpty {
            args += ["--language", language]
        }
        if let contentHint = options.contentHint, !contentHint.isEmpty {
            args += ["--content-hint", contentHint]
        }
        if let concurrency = options.concurrency {
            args += ["--concurrency", "\(max(1, concurrency))"]
        }
        if options.noCache { args.append("--no-cache") }
        if options.clearCache { args.append("--clear-cache") }
        return args
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

public struct ProjectAnalysisRunResult: Equatable, Sendable {
    public let plan: ProjectAnalysisRunPlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let indexSummary: ProjectIndexSummary?

    public var succeeded: Bool {
        exitCode == 0
    }
}

public enum ProjectAnalysisRunError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        }
    }
}

public enum ProjectAnalysisRunPlanner {
    public static let mediaExtensions: Set<String> = [
        "aac", "aif", "aiff", "flac", "m4a", "m4v", "mov", "mp3", "mp4", "mxf", "wav"
    ]

    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        options: ProjectAnalysisRunOptions = ProjectAnalysisRunOptions()
    ) -> ProjectAnalysisRunPlan {
        let sourceDirectory = projectURL.appendingPathComponent("02_media/source")
        let allFiles = collectFiles(in: sourceDirectory)
        let sourceURLs = allFiles.filter { mediaExtensions.contains($0.pathExtension.lowercased()) }
        return ProjectAnalysisRunPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            sourceDirectory: sourceDirectory,
            sourceURLs: sourceURLs,
            skippedSourceCount: allFiles.count - sourceURLs.count,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/analyze.ts"),
            options: options
        )
    }

    static func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return true
        }
        let resolved = url.resolvingSymlinksInPath()
        return FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private static func collectFiles(in directory: URL) -> [URL] {
        let enumerationDirectory = directory.resolvingSymlinksInPath()
        guard isDirectory(directory),
              let enumerator = FileManager.default.enumerator(
                at: enumerationDirectory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
              ) else {
            return []
        }
        return enumerator
            .compactMap { $0 as? URL }
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
            .map { fileURL in
                let relativePath = relativePath(from: enumerationDirectory, to: fileURL)
                return directory.appendingPathComponent(relativePath)
            }
            .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    private static func relativePath(from base: URL, to url: URL) -> String {
        let basePath = base.standardizedFileURL.path
        let urlPath = url.standardizedFileURL.path
        if urlPath == basePath {
            return url.lastPathComponent
        }
        let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
        guard urlPath.hasPrefix(prefix) else {
            return url.lastPathComponent
        }
        return String(urlPath.dropFirst(prefix.count))
    }
}

public enum ProjectAnalysisRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func run(
        plan: ProjectAnalysisRunPlan,
        rebuildIndex: Bool = true
    ) throws -> ProjectAnalysisRunResult {
        try run(plan: plan, rebuildIndex: rebuildIndex, runner: { workingDirectory, arguments in
            try runProcess(workingDirectory: workingDirectory, arguments: arguments)
        })
    }

    public static func run(
        plan: ProjectAnalysisRunPlan,
        rebuildIndex: Bool = true,
        runner: Runner
    ) throws -> ProjectAnalysisRunResult {
        guard plan.canRun else {
            throw ProjectAnalysisRunError.notReady(plan.readinessLabel)
        }
        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        let indexSummary = result.status == 0 && rebuildIndex
            ? try ProjectSQLiteIndex.rebuild(projectURL: plan.projectURL)
            : nil
        return ProjectAnalysisRunResult(
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
