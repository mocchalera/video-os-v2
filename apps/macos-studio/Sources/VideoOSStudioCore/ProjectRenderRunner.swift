import Foundation

public struct ProjectRenderRunOptions: Equatable, Sendable {
    public var skipRender: Bool
    public var assemblyURL: URL?
    public var suppliedFinalURL: URL?

    public init(
        skipRender: Bool = false,
        assemblyURL: URL? = nil,
        suppliedFinalURL: URL? = nil
    ) {
        self.skipRender = skipRender
        self.assemblyURL = assemblyURL
        self.suppliedFinalURL = suppliedFinalURL
    }
}

public struct ProjectRenderRunPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let scriptURL: URL
    public let options: ProjectRenderRunOptions
    public let hasCreativeBrief: Bool
    public let hasBlueprint: Bool
    public let hasTimeline: Bool
    public let hasReview: Bool
    public let preflightStatus: ProjectPackagePreflightStatus
    public let hasPackageFinalVideo: Bool

    public var currentState: String? { preflightStatus.currentState }
    public var sourceOfTruthDecision: String? { preflightStatus.sourceOfTruth }

    public var canRun: Bool {
        FileManager.default.fileExists(atPath: scriptURL.path)
            && hasCreativeBrief
            && hasBlueprint
            && hasTimeline
            && hasReview
            && preflightStatus.canPackage
            && nleFinalIsAvailable
            && assemblyIsReadable
            && suppliedFinalIsReadable
    }

    public var readinessLabel: String {
        if !FileManager.default.fileExists(atPath: scriptURL.path) {
            return "missing render worker"
        }
        if !hasCreativeBrief {
            return "missing creative brief"
        }
        if !hasBlueprint {
            return "missing edit blueprint"
        }
        if !hasTimeline {
            return "missing timeline"
        }
        if !hasReview {
            return "missing review"
        }
        if let preflightFailure = preflightStatus.failureLabel {
            return preflightFailure
        }
        if !nleFinalIsAvailable {
            return "supplied final missing"
        }
        if !assemblyIsReadable {
            return "assembly file missing"
        }
        if !suppliedFinalIsReadable {
            return "supplied final missing"
        }
        return options.skipRender ? "ready to validate package" : "ready to render"
    }

    public var commandArguments: [String] {
        [
            "npx",
            "tsx",
            scriptURL.path,
            projectURL.path,
            "render",
            optionsJSON
        ]
    }

    public var commandLine: String {
        commandArguments.map(shellQuote).joined(separator: " ")
    }

    private var assemblyIsReadable: Bool {
        guard let assemblyURL = options.assemblyURL else { return true }
        return FileManager.default.fileExists(atPath: assemblyURL.path)
    }

    private var suppliedFinalIsReadable: Bool {
        guard let suppliedFinalURL = options.suppliedFinalURL else { return true }
        return FileManager.default.fileExists(atPath: suppliedFinalURL.path)
    }

    private var nleFinalIsAvailable: Bool {
        guard sourceOfTruthDecision == "nle_finishing" else { return true }
        if hasPackageFinalVideo { return true }
        guard let suppliedFinalURL = options.suppliedFinalURL else { return false }
        return FileManager.default.fileExists(atPath: suppliedFinalURL.path)
    }

    private var optionsJSON: String {
        var object: [String: Any] = [
            "skip_render": options.skipRender
        ]
        if let assemblyURL = options.assemblyURL {
            object["assembly_path"] = assemblyURL.path
        }
        if let suppliedFinalURL = options.suppliedFinalURL {
            object["supplied_final_path"] = suppliedFinalURL.path
        }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            ?? Data(#"{"skip_render":false}"#.utf8)
        return String(data: data, encoding: .utf8) ?? #"{"skip_render":false}"#
    }

    private func shellQuote(_ value: String) -> String {
        guard !value.isEmpty else { return "''" }
        if value.range(of: #"[^A-Za-z0-9_@%+=:,./-]"#, options: .regularExpression) == nil {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

public struct ProjectRenderRunResult: Equatable, Sendable {
    public let plan: ProjectRenderRunPlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let status: ProjectRenderPackageStatus

    public var succeeded: Bool {
        exitCode == 0
            && status.packageContractMatches
            && status.verificationStatus.ready
    }
}

public enum ProjectRenderRunError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        }
    }
}

public enum ProjectRenderRunPlanner {
    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        options: ProjectRenderRunOptions = ProjectRenderRunOptions(),
        preflightStatus: ProjectPackagePreflightStatus? = nil
    ) -> ProjectRenderRunPlan {
        let resolvedPreflight = preflightStatus ?? ProjectPackagePreflightRunner.pending()
        let sourceOfTruth = resolvedPreflight.sourceOfTruth
        let deliveryResolution = ProjectActiveDeliveryReader.resolution(projectURL: projectURL)
        let activeDelivery: ProjectActiveDeliveryPaths?
        let legacyAllowed: Bool
        switch deliveryResolution {
        case .active(let paths):
            activeDelivery = paths
            legacyAllowed = false
        case .absent:
            activeDelivery = nil
            legacyAllowed = true
        case .invalid:
            activeDelivery = nil
            legacyAllowed = false
        }
        let packageFinalVideoURL = activeDelivery?.finalVideoURL
            ?? (legacyAllowed
                ? projectURL.appendingPathComponent("07_package/video/final.mp4")
                : projectURL.appendingPathComponent("07_package/.invalid-active-delivery/package-final.mp4"))
        var resolvedOptions = options
        if sourceOfTruth == "nle_finishing", resolvedOptions.suppliedFinalURL == nil {
            let publishedFinalURL = activeDelivery?.finalVideoURL
                ?? (legacyAllowed
                    ? projectURL.appendingPathComponent("09_output/final.mp4")
                    : projectURL.appendingPathComponent("07_package/.invalid-active-delivery/final.mp4"))
            if FileManager.default.fileExists(atPath: publishedFinalURL.path) {
                resolvedOptions.suppliedFinalURL = publishedFinalURL
            }
        }

        return ProjectRenderRunPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/editor-job-worker.ts"),
            options: resolvedOptions,
            hasCreativeBrief: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("01_intent/creative_brief.yaml").path),
            hasBlueprint: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("04_plan/edit_blueprint.yaml").path),
            hasTimeline: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("05_timeline/timeline.json").path),
            hasReview: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("06_review/review_report.yaml").path),
            preflightStatus: resolvedPreflight,
            hasPackageFinalVideo: FileManager.default.fileExists(atPath: packageFinalVideoURL.path)
        )
    }

}

public enum ProjectRenderRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult
    public typealias PackageVerifier = @Sendable (
        _ repositoryRoot: URL,
        _ projectURL: URL
    ) -> ProjectPackageVerificationStatus

    public static func run(
        plan: ProjectRenderRunPlan
    ) throws -> ProjectRenderRunResult {
        try run(
            plan: plan,
            packageVerifier: { repositoryRoot, projectURL in
                ProjectPackageVerificationRunner.status(
                    repositoryRoot: repositoryRoot,
                    projectURL: projectURL
                )
            },
            runner: { workingDirectory, arguments in
                try runProcess(workingDirectory: workingDirectory, arguments: arguments)
            }
        )
    }

    public static func run(
        plan: ProjectRenderRunPlan,
        runner: Runner
    ) throws -> ProjectRenderRunResult {
        try run(
            plan: plan,
            packageVerifier: { repositoryRoot, projectURL in
                ProjectPackageVerificationRunner.status(
                    repositoryRoot: repositoryRoot,
                    projectURL: projectURL
                )
            },
            runner: runner
        )
    }

    public static func run(
        plan: ProjectRenderRunPlan,
        packageVerifier: PackageVerifier,
        runner: Runner
    ) throws -> ProjectRenderRunResult {
        guard plan.canRun else {
            throw ProjectRenderRunError.notReady(plan.readinessLabel)
        }
        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        let verification = packageVerifier(plan.repositoryRoot, plan.projectURL)
        return ProjectRenderRunResult(
            plan: plan,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            status: ProjectRenderPackageStatusReader.status(
                projectURL: plan.projectURL,
                expectedProjectID: plan.preflightStatus.projectID,
                expectedSourceOfTruth: plan.preflightStatus.sourceOfTruth,
                verificationStatus: verification
            )
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
