import XCTest
@testable import VideoOSStudioCore

final class ProjectAnalysisRunnerTests: XCTestCase {
    func testPlanCollectsLinkedSourceMediaAndBuildsAnalyzeCommand() throws {
        let (root, project) = try temporaryAnalysisProject("videoos-analysis-plan")
        try Data([0]).write(to: project.appendingPathComponent("02_media/source/b-roll.mxf"))
        try Data([0]).write(to: project.appendingPathComponent("02_media/source/interview.mov"))
        try "notes".write(to: project.appendingPathComponent("02_media/source/readme.txt"), atomically: true, encoding: .utf8)

        let plan = ProjectAnalysisRunPlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            options: ProjectAnalysisRunOptions(skipSTT: true, skipVLM: true, skipPeak: true, skipMarlin: true, skipPreflight: true)
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready")
        XCTAssertEqual(plan.sourceCount, 2)
        XCTAssertEqual(plan.skippedSourceCount, 1)
        XCTAssertEqual(plan.sourceURLs.map(\.lastPathComponent), ["b-roll.mxf", "interview.mov"])
        XCTAssertTrue(plan.commandArguments.contains { $0.hasSuffix("scripts/analyze.ts") })
        XCTAssertTrue(plan.commandArguments.contains("--project"))
        XCTAssertTrue(plan.commandArguments.contains(project.path))
        XCTAssertTrue(plan.commandArguments.contains("--skip-stt"))
        XCTAssertTrue(plan.commandArguments.contains("--skip-vlm"))
        XCTAssertTrue(plan.commandLine.contains("scripts/analyze.ts"))
    }

    func testPlanFollowsSourceDirectorySymlink() throws {
        let (root, project) = try temporaryAnalysisProject("videoos-analysis-symlink", createSourceDirectory: false)
        let externalSource = root.appendingPathComponent("external-source")
        try FileManager.default.createDirectory(at: externalSource, withIntermediateDirectories: true)
        try Data([0]).write(to: externalSource.appendingPathComponent("linked.mp4"))
        try FileManager.default.createDirectory(at: project.appendingPathComponent("02_media"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: project.appendingPathComponent("02_media/source"),
            withDestinationURL: externalSource
        )

        let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.sourceCount, 1)
        XCTAssertEqual(plan.sourceURLs.first?.path, project.appendingPathComponent("02_media/source/linked.mp4").path)
    }

    func testRunRebuildsIndexAfterSuccessfulAnalysis() throws {
        let (root, project) = try temporaryAnalysisProject("videoos-analysis-run")
        try Data([0]).write(to: project.appendingPathComponent("02_media/source/interview.mov"))
        let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectAnalysisRunner.run(plan: plan) { _, arguments in
            XCTAssertTrue(arguments.contains { $0.hasSuffix("/02_media/source/interview.mov") })
            try writeAnalysisArtifacts(project: project)
            return ProjectInitializationProcessResult(status: 0, stdout: "[analyze] Pipeline complete", stderr: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.indexSummary?.assetCount, 1)
        XCTAssertEqual(result.indexSummary?.segmentCount, 1)
        XCTAssertEqual(result.indexSummary?.searchDocumentCount, 2)
        XCTAssertTrue(ProjectSQLiteIndex.status(projectURL: project).exists)
    }

    func testRunDoesNotRebuildIndexAfterFailedAnalysis() throws {
        let (root, project) = try temporaryAnalysisProject("videoos-analysis-fail")
        try Data([0]).write(to: project.appendingPathComponent("02_media/source/interview.mov"))
        let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectAnalysisRunner.run(plan: plan) { _, _ in
            ProjectInitializationProcessResult(status: 2, stdout: "", stderr: "failed")
        }

        XCTAssertFalse(result.succeeded)
        XCTAssertNil(result.indexSummary)
        XCTAssertFalse(ProjectSQLiteIndex.status(projectURL: project).exists)
    }

    private func temporaryAnalysisProject(_ prefix: String, createSourceDirectory: Bool = true) throws -> (URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("schemas"), withIntermediateDirectories: true)
        if createSourceDirectory {
            try FileManager.default.createDirectory(at: project.appendingPathComponent("02_media/source"), withIntermediateDirectories: true)
        } else {
            try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        }
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "script".write(to: root.appendingPathComponent("scripts/analyze.ts"), atomically: true, encoding: .utf8)
        return (root, project)
    }

    private func writeAnalysisArtifacts(project: URL) throws {
        let analysisDir = project.appendingPathComponent("03_analysis")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try """
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "interview.mov",
              "role_guess": "interview",
              "duration_us": 1000000,
              "has_transcript": false,
              "segment_ids": ["SEG_001"],
              "quality_flags": [],
              "tags": ["interview"]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
        try """
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "segment_id": "SEG_001",
              "asset_id": "AST_001",
              "src_in_us": 0,
              "src_out_us": 1000000,
              "summary": "subject introduces the idea",
              "transcript_excerpt": "",
              "quality_flags": [],
              "tags": ["interview"]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
    }
}
