import Foundation

public struct ProjectStudioPatchPromotionPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let scriptURL: URL
    public let patchURL: URL
    public let backupTimelineURL: URL?
    public let hasSelects: Bool
    public let hasBlueprint: Bool
    public let hasTimeline: Bool

    public var canRun: Bool {
        FileManager.default.fileExists(atPath: scriptURL.path)
            && FileManager.default.fileExists(atPath: patchURL.path)
            && hasSelects
            && hasBlueprint
            && hasTimeline
    }

    public var readinessLabel: String {
        if !FileManager.default.fileExists(atPath: scriptURL.path) {
            return "missing promote script"
        }
        if !FileManager.default.fileExists(atPath: patchURL.path) {
            return "patch file missing"
        }
        if !hasSelects {
            return "missing selects"
        }
        if !hasBlueprint {
            return "missing blueprint"
        }
        if !hasTimeline {
            return "missing timeline"
        }
        return "ready to promote"
    }

    public var commandArguments: [String] {
        var args = [
            "npx",
            "tsx",
            scriptURL.path,
            "--project",
            projectURL.path,
            "--patch",
            patchURL.path,
            "--json"
        ]
        if let backupTimelineURL {
            args += ["--backup-timeline", backupTimelineURL.path]
        }
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

public struct ProjectStudioPatchPromotionOutput: Codable, Equatable, Sendable {
    public let applied_ops: Int
    public let skipped_ops: Int
    public let selects_modified: Bool
    public let blueprint_modified: Bool
    public let modified_beat_ids: [String]
    public let warnings: [String]
    public let dry_run: Bool
}

public struct ProjectStudioPatchPromotionResult: Equatable, Sendable {
    public let plan: ProjectStudioPatchPromotionPlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let output: ProjectStudioPatchPromotionOutput?

    public var succeeded: Bool {
        exitCode == 0 && (output?.applied_ops ?? 0) > 0
    }
}

public enum ProjectStudioPatchPromotionError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        }
    }
}

public enum ProjectStudioPatchPromotionPlanner {
    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        patchURL: URL
    ) -> ProjectStudioPatchPromotionPlan {
        ProjectStudioPatchPromotionPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/promote-studio-patch.ts"),
            patchURL: patchURL,
            backupTimelineURL: backupTimelineURL(projectURL: projectURL, patchURL: patchURL),
            hasSelects: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("04_plan/selects_candidates.yaml").path),
            hasBlueprint: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("04_plan/edit_blueprint.yaml").path),
            hasTimeline: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("05_timeline/timeline.json").path)
        )
    }

    private static func backupTimelineURL(projectURL: URL, patchURL: URL) -> URL? {
        let index = PatchHistoryIndex.load(projectURL: projectURL)
        let patchPath = patchURL.standardizedFileURL.path
        let projectPath = projectURL.standardizedFileURL.path
        let relativePatchPath = patchPath.hasPrefix(projectPath + "/")
            ? String(patchPath.dropFirst(projectPath.count + 1))
            : patchURL.lastPathComponent
        guard let record = index.records.last(where: { $0.patch_path == relativePatchPath || projectURL.appendingPathComponent($0.patch_path).standardizedFileURL.path == patchPath }),
              !record.timeline_backup_path.isEmpty
        else {
            return nil
        }
        let url = projectURL.appendingPathComponent(record.timeline_backup_path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

public enum ProjectStudioPatchPromotionRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func run(plan: ProjectStudioPatchPromotionPlan) throws -> ProjectStudioPatchPromotionResult {
        try run(plan: plan, runner: { workingDirectory, arguments in
            try runProcess(workingDirectory: workingDirectory, arguments: arguments)
        })
    }

    public static func run(
        plan: ProjectStudioPatchPromotionPlan,
        runner: Runner
    ) throws -> ProjectStudioPatchPromotionResult {
        guard plan.canRun else {
            throw ProjectStudioPatchPromotionError.notReady(plan.readinessLabel)
        }
        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        let output = try? JSONDecoder().decode(
            ProjectStudioPatchPromotionOutput.self,
            from: Data(result.stdout.utf8)
        )
        return ProjectStudioPatchPromotionResult(
            plan: plan,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            output: output
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
