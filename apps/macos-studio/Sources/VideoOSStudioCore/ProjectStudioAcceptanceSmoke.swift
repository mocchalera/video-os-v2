import Foundation

public struct ProjectStudioAcceptanceSmokeResult: Equatable, Sendable {
    public let appServerResponse: CodexInitializeResponse
    public let studioSmokeResult: ProjectStudioSyntheticSmokeResult

    public var succeeded: Bool {
        !appServerResponse.userAgent.isEmpty && studioSmokeResult.succeeded
    }

    public var summaryLabel: String {
        succeeded ? "acceptance smoke passed" : "acceptance smoke failed"
    }
}

public enum ProjectStudioAcceptanceSmoke {
    public typealias AppServerChecker = @Sendable (_ repositoryRoot: URL) throws -> CodexInitializeResponse
    public typealias StudioSmokeRunner = @Sendable (_ repositoryRoot: URL, _ durationSeconds: Double) throws -> ProjectStudioSyntheticSmokeResult

    public static func run(
        repositoryRoot: URL,
        durationSeconds: Double = 1
    ) throws -> ProjectStudioAcceptanceSmokeResult {
        try run(
            repositoryRoot: repositoryRoot,
            durationSeconds: durationSeconds,
            appServerChecker: { root in
                try checkAppServer(repositoryRoot: root)
            },
            studioSmokeRunner: { root, seconds in
                try ProjectStudioSyntheticSmoke.run(repositoryRoot: root, durationSeconds: seconds)
            }
        )
    }

    public static func run(
        repositoryRoot: URL,
        durationSeconds: Double = 1,
        appServerChecker: AppServerChecker,
        studioSmokeRunner: StudioSmokeRunner
    ) throws -> ProjectStudioAcceptanceSmokeResult {
        let appServer = try appServerChecker(repositoryRoot)
        let studio = try studioSmokeRunner(repositoryRoot, durationSeconds)
        return ProjectStudioAcceptanceSmokeResult(
            appServerResponse: appServer,
            studioSmokeResult: studio
        )
    }

    public static func removeProject(_ result: ProjectStudioAcceptanceSmokeResult) {
        ProjectStudioSyntheticSmoke.removeProject(result.studioSmokeResult)
    }

    private static func checkAppServer(repositoryRoot: URL) throws -> CodexInitializeResponse {
        let session = CodexAppServerSession(workspace: repositoryRoot)
        try session.start()
        defer { session.stop() }
        return try session.initialize(timeout: 15)
    }
}
