import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinEvaluationRunPlanTests: XCTestCase {
    func testPlanBuildsMarlinEvaluateCommandFromExistingVideoSources() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let sourceDir = project.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
        let source = sourceDir.appendingPathComponent("interview.mp4")
        try Data([0x00]).write(to: source)
        try writeAssets(project: project, filename: "interview.mp4", sourceLocator: "02_media/source/interview.mp4")

        let plan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(plan.readinessLabel, "ready")
        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.sourceCount, 1)
        XCTAssertEqual(plan.sourceURLs, [source])
        XCTAssertTrue(plan.commandLine().contains("scripts/marlin-evaluate.ts"))
        XCTAssertTrue(plan.commandLine().contains("--project"))
        XCTAssertTrue(plan.commandLine(mock: true).contains("--mock"))
    }

    func testPlanIncludesRequestTimeoutBeforeVideoSources() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let source = project.appendingPathComponent("02_media/source/interview.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [source],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let args = plan.processArguments(mock: true, requestTimeoutMs: 900_000)

        XCTAssertTrue(plan.commandLine(mock: true, requestTimeoutMs: 900_000).contains("--request-timeout-ms"))
        XCTAssertEqual(Array(args.suffix(3)), ["--request-timeout-ms", "900000", source.path])
    }

    func testPlanIncludesChunkingOptionsBeforeVideoSources() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let source = project.appendingPathComponent("02_media/source/interview.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [source],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let args = plan.processArguments(
            maxSources: 1,
            skipExisting: true,
            captionOnly: true,
            chunkSeconds: 30,
            chunkOverlapSeconds: 5,
            maxChunks: 2
        )

        XCTAssertTrue(plan.commandLine(maxSources: 1, skipExisting: true, captionOnly: true, chunkSeconds: 30).contains("--chunk-seconds"))
        XCTAssertTrue(args.contains("--skip-existing"))
        XCTAssertTrue(args.contains("--caption-only"))
        XCTAssertEqual(Array(args.suffix(11)), [
            "--max-sources", "1",
            "--skip-existing",
            "--caption-only",
            "--chunk-seconds", "30",
            "--chunk-overlap-seconds", "5",
            "--max-chunks", "2",
            source.path,
        ])
    }

    func testPlanReportsNoVideoSourcesWhenAssetsAreMissing() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent("03_analysis"),
            withIntermediateDirectories: true
        )
        try writeAssets(project: project, filename: "missing.mp4", sourceLocator: "02_media/source/missing.mp4")

        let plan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(plan.readinessLabel, "no video sources")
        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.sourceCount, 0)
        XCTAssertEqual(plan.skippedSourceCount, 1)
    }

    func testRunnerUsesInjectedProcess() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/clip.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let result = try ProjectMarlinEvaluationRunner.run(plan: plan, mock: true) { cwd, args in
            XCTAssertEqual(cwd, root)
            XCTAssertTrue(args.contains("--mock"))
            XCTAssertTrue(args.contains("npx"))
            return ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "ok", standardError: "")
        }

        XCTAssertTrue(result.succeeded)
    }

    func testRunnerPassesRequestTimeoutToInjectedProcess() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/clip.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let result = try ProjectMarlinEvaluationRunner.run(
            plan: plan,
            mock: true,
            requestTimeoutMs: 900_000
        ) { _, args in
            XCTAssertEqual(Array(args.suffix(3)), ["--request-timeout-ms", "900000", project.appendingPathComponent("02_media/source/clip.mp4").path])
            return ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "ok", standardError: "")
        }

        XCTAssertTrue(result.succeeded)
    }

    func testRunnerPassesChunkingOptionsToInjectedProcess() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/clip.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let result = try ProjectMarlinEvaluationRunner.run(
            plan: plan,
            mock: true,
            maxSources: 1,
            skipExisting: true,
            captionOnly: true,
            chunkSeconds: 30,
            chunkOverlapSeconds: 5,
            maxChunks: 2
        ) { _, args in
            XCTAssertEqual(Array(args.suffix(11)), [
                "--max-sources", "1",
                "--skip-existing",
                "--caption-only",
                "--chunk-seconds", "30",
                "--chunk-overlap-seconds", "5",
                "--max-chunks", "2",
                project.appendingPathComponent("02_media/source/clip.mp4").path,
            ])
            return ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "ok", standardError: "")
        }

        XCTAssertTrue(result.succeeded)
    }

    func testRunAndRefreshIndexRebuildsSearchAfterSuccess() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        try writeAssets(project: project, filename: "interview.mp4", sourceLocator: "02_media/source/interview.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/interview.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let result = try ProjectMarlinEvaluationRunner.runAndRefreshIndex(plan: plan) { _, _ in
            ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "ok", standardError: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.indexSummary?.assetCount, 1)
        XCTAssertEqual(result.indexSummary?.searchDocumentCount, 1)
    }

    func testRunAndRefreshIndexSkipsSearchAfterFailure() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/interview.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let result = try ProjectMarlinEvaluationRunner.runAndRefreshIndex(plan: plan) { _, _ in
            ProjectMarlinEvaluationRunResult(exitCode: 2, standardOutput: "", standardError: "failed")
        }

        XCTAssertFalse(result.succeeded)
        XCTAssertNil(result.indexSummary)
    }

    func testLiveRunRefusesWhenRuntimePreflightFails() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/interview.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )

        let runtime = ProjectMarlinRuntimeStatusReader.status(
            repositoryRoot: root,
            pythonBinary: "python3",
            probeOutput: """
            torch	ok	2.10.0
            transformers	ok	5.3.0
            torchcodec	ok	0.10.0
            qwen_vl_utils	missing	ModuleNotFoundError
            av	ok	16.1.0
            PIL	ok	12.1.1
            accelerate	missing	ModuleNotFoundError
            __device__	ok	cuda=false	mps=true
            """
        )

        let guardedResult = try ProjectMarlinEvaluationRunner.run(plan: plan, runtimeStatus: runtime)

        XCTAssertFalse(guardedResult.succeeded)
        XCTAssertTrue(guardedResult.standardError.contains("Marlin runtime is not ready"))
        XCTAssertTrue(guardedResult.standardError.contains("python/requirements-marlin.txt"))
    }

    func testLiveRunRefusesWhenModelAccessPreflightFails() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [project.appendingPathComponent("02_media/source/interview.mp4")],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts")
        )
        let runtime = ProjectMarlinRuntimeStatusReader.status(
            repositoryRoot: root,
            pythonBinary: "python3",
            probeOutput: """
            torch	ok	2.11.0
            transformers	ok	5.7.1
            torchcodec	ok	0.10.0
            qwen_vl_utils	ok	0.0.14
            av	ok	16.1.0
            PIL	ok	12.1.1
            accelerate	ok	1.12.0
            __device__	ok	cuda=false	mps=true
            """
        )
        let modelAccess = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: root,
            pythonBinary: "python3",
            hasToken: false,
            probeOutput: ""
        )

        let guardedResult = try ProjectMarlinEvaluationRunner.run(
            plan: plan,
            runtimeStatus: runtime,
            modelAccessStatus: modelAccess
        )

        XCTAssertFalse(guardedResult.succeeded)
        XCTAssertTrue(guardedResult.standardError.contains("Marlin model access is not ready"))
        XCTAssertTrue(guardedResult.standardError.contains("HF_TOKEN"))
    }
}

private func makeRootFixture() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-marlin-run-plan-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
        at: root.appendingPathComponent("scripts"),
        withIntermediateDirectories: true
    )
    try Data([0x00]).write(to: root.appendingPathComponent("scripts/marlin-evaluate.ts"))
    return root
}

private func writeAssets(project: URL, filename: String, sourceLocator: String) throws {
    try FileManager.default.createDirectory(
        at: project.appendingPathComponent("03_analysis"),
        withIntermediateDirectories: true
    )
    try """
    {
      "project_id": "demo",
      "artifact_version": "1",
      "items": [
        {
          "asset_id": "A001",
          "filename": "\(filename)",
          "role_guess": "interview",
          "duration_us": 1000000,
          "has_transcript": false,
          "source_locator": "\(sourceLocator)"
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/assets.json"),
        atomically: true,
        encoding: .utf8
    )
}
