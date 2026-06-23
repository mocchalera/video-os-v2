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

    func testPlanDropsCompletedWholeAssetSourcesWhenSkippingExisting() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let sourceA = project.appendingPathComponent("02_media/source/a.mp4")
        let sourceB = project.appendingPathComponent("02_media/source/b.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [sourceA, sourceB],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts"),
            sourceAssetIDsByPath: [
                sourceA.path: "A001",
                sourceB.path: "A002",
            ],
            existingMarlinItemsByAssetID: [
                "A001": makeMarlinAssetItem(assetID: "A001", chunkIndices: [nil]),
            ],
            sourceDurationsByPath: [
                sourceA.path: 4,
                sourceB.path: 4,
            ]
        )

        let selected = plan.selectedSourceURLs(skipExisting: true, chunkSeconds: 30)
        let args = plan.processArguments(skipExisting: true, chunkSeconds: 30)

        XCTAssertEqual(selected, [sourceB])
        XCTAssertFalse(args.contains(sourceA.path))
        XCTAssertTrue(args.contains(sourceB.path))
    }

    func testPlanKeepsIncompleteChunkedSourceWhenSkippingExisting() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let source = project.appendingPathComponent("02_media/source/long.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [source],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts"),
            sourceAssetIDsByPath: [source.path: "A001"],
            existingMarlinItemsByAssetID: [
                "A001": makeMarlinAssetItem(assetID: "A001", chunkIndices: [0]),
            ],
            sourceDurationsByPath: [source.path: 70]
        )

        XCTAssertEqual(plan.selectedSourceURLs(skipExisting: true, chunkSeconds: 30), [source])
    }

    func testPlanDropsCompletedChunkedSourceWhenSkippingExisting() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let source = project.appendingPathComponent("02_media/source/long.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [source],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts"),
            sourceAssetIDsByPath: [source.path: "A001"],
            existingMarlinItemsByAssetID: [
                "A001": makeMarlinAssetItem(assetID: "A001", chunkIndices: [0, 1, 2]),
            ],
            sourceDurationsByPath: [source.path: 70]
        )

        XCTAssertTrue(plan.selectedSourceURLs(skipExisting: true, chunkSeconds: 30).isEmpty)
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

    func testRunnerRefusesWhenSkipExistingLeavesNoSelectedSources() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let source = project.appendingPathComponent("02_media/source/clip.mp4")
        let plan = ProjectMarlinEvaluationRunPlan(
            repositoryRoot: root,
            projectURL: project,
            sourceURLs: [source],
            skippedSourceCount: 0,
            scriptURL: root.appendingPathComponent("scripts/marlin-evaluate.ts"),
            sourceAssetIDsByPath: [source.path: "A001"],
            existingMarlinItemsByAssetID: [
                "A001": makeMarlinAssetItem(assetID: "A001", chunkIndices: [nil]),
            ],
            sourceDurationsByPath: [source.path: 4]
        )

        let result = try ProjectMarlinEvaluationRunner.run(
            plan: plan,
            mock: true,
            skipExisting: true,
            chunkSeconds: 30
        ) { _, _ in
            XCTFail("Runner should not execute with an empty selected source list")
            return ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "unexpected", standardError: "")
        }

        XCTAssertFalse(result.succeeded)
        XCTAssertTrue(result.standardError.contains("No selected Marlin source files remain"))
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

    func testMaterializationPlanBuildsCommandFromExistingArtifacts() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        try writeAssets(project: project, filename: "interview.mp4", sourceLocator: "02_media/source/interview.mp4")
        try writeSegments(project: project)
        try writeMarlinEvents(project: project)

        let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(plan.readinessLabel, "ready")
        XCTAssertTrue(plan.canRun)
        XCTAssertTrue(plan.commandLine().contains("scripts/marlin-materialize.ts"))
        XCTAssertTrue(plan.commandLine().contains("--project"))
        XCTAssertFalse(plan.commandLine().contains("marlin-evaluate.ts"))
    }

    func testMaterializationRunnerUsesInjectedProcess() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectMarlinMaterializationRunner.run(plan: plan) { cwd, args in
            XCTAssertEqual(cwd, root)
            XCTAssertTrue(args.contains("npx"))
            XCTAssertTrue(args.contains("tsx"))
            XCTAssertTrue(args.contains(root.appendingPathComponent("scripts/marlin-materialize.ts").path))
            XCTAssertFalse(args.contains("--mock"))
            return ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "ok", standardError: "")
        }

        XCTAssertTrue(result.succeeded)
    }

    func testMaterializationRunAndRefreshIndexRebuildsSearchAfterSuccess() throws {
        let root = try makeRootFixture()
        let project = root.appendingPathComponent("projects/demo")
        try writeAssets(project: project, filename: "interview.mp4", sourceLocator: "02_media/source/interview.mp4")
        try writeSegments(project: project)
        let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectMarlinMaterializationRunner.runAndRefreshIndex(plan: plan) { _, _ in
            ProjectMarlinEvaluationRunResult(exitCode: 0, standardOutput: "ok", standardError: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.indexSummary?.assetCount, 1)
        XCTAssertEqual(result.indexSummary?.searchDocumentCount, 2)
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
    try Data([0x00]).write(to: root.appendingPathComponent("scripts/marlin-materialize.ts"))
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

private func writeSegments(project: URL) throws {
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
          "segment_id": "SEG_001",
          "asset_id": "A001",
          "src_in_us": 0,
          "src_out_us": 1000000,
          "summary": "intro",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/segments.json"),
        atomically: true,
        encoding: .utf8
    )
}

private func writeMarlinEvents(project: URL) throws {
    try FileManager.default.createDirectory(
        at: project.appendingPathComponent("03_analysis"),
        withIntermediateDirectories: true
    )
    try """
    {
      "project_id": "demo",
      "artifact_version": "marlin-events-v1",
      "model": {
        "provider": "marlin",
        "model_alias": "NemoStation/Marlin-2B",
        "model_snapshot": "test",
        "connector_version": "marlin-local-v1"
      },
      "items": [
        {
          "asset_id": "A001",
          "source_path": "02_media/source/interview.mp4",
          "scene": "intro",
          "caption": "intro",
          "events": [],
          "find_results": []
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/marlin_events.json"),
        atomically: true,
        encoding: .utf8
    )
}

private func makeMarlinAssetItem(assetID: String, chunkIndices: [Int?]) -> MarlinAssetEvents {
    MarlinAssetEvents(
        assetID: assetID,
        sourcePath: "02_media/source/\(assetID).mp4",
        scene: "scene",
        caption: "caption",
        events: chunkIndices.enumerated().map { index, chunkIndex in
            MarlinEvent(
                id: "MEV_\(assetID)_\(index)",
                startUS: index * 1_000_000,
                endUS: (index + 1) * 1_000_000,
                description: "event \(index)",
                confidence: 0.7,
                sourcePass: "marlin_caption",
                chunkIndex: chunkIndex
            )
        },
        findResults: []
    )
}
