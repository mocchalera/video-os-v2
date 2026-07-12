import XCTest
@testable import VideoOSStudioCore

final class ProjectRoughCutCompileRunnerTests: XCTestCase {
    func testPlanBuildsCompileCommandWithCanonicalInputsAndSourceMap() throws {
        let (root, project) = try temporaryCompileProject("videoos-compile-plan")
        let sourceMap = project.appendingPathComponent("02_media/source_map.json")
        try FileManager.default.createDirectory(at: sourceMap.deletingLastPathComponent(), withIntermediateDirectories: true)
        try #"{"version":"1","project_id":"demo","media_dir":"02_media","generated_at":"2026-05-22T00:00:00Z","items":[]}"#
            .write(to: sourceMap, atomically: true, encoding: .utf8)

        let plan = ProjectRoughCutCompilePlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            options: ProjectRoughCutCompileOptions(fps: 30, skipPreview: true)
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready")
        XCTAssertTrue(plan.hasCreativeBrief)
        XCTAssertTrue(plan.hasSelects)
        XCTAssertTrue(plan.hasBlueprint)
        XCTAssertTrue(plan.commandArguments.contains { $0.hasSuffix("scripts/compile-timeline.ts") })
        XCTAssertTrue(plan.commandArguments.contains(project.path))
        XCTAssertTrue(plan.commandArguments.contains("--fps"))
        XCTAssertTrue(plan.commandArguments.contains("30"))
        XCTAssertTrue(plan.commandArguments.contains("--source-map"))
        XCTAssertTrue(plan.commandArguments.contains(sourceMap.path))
        XCTAssertTrue(plan.commandArguments.contains("--skip-preview"))
        XCTAssertTrue(plan.commandArguments.contains("--skip-confirmations"))
    }

    func testPlanReportsMissingBlueprint() throws {
        let (root, project) = try temporaryCompileProject("videoos-compile-missing")
        try FileManager.default.removeItem(at: project.appendingPathComponent("04_plan/edit_blueprint.yaml"))

        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing blueprint")
    }

    func testPlanBuildsCompileCommandWithReviewPatch() throws {
        let (root, project) = try temporaryCompileProject("videoos-compile-review-patch")
        let reviewDir = project.appendingPathComponent("06_review")
        let reviewPatch = reviewDir.appendingPathComponent("review_patch.json")
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)
        try #"{"timeline_version":"tl-v1","operations":[]}"#
            .write(to: reviewPatch, atomically: true, encoding: .utf8)

        let plan = ProjectRoughCutCompilePlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            options: ProjectRoughCutCompileOptions(patchURL: reviewPatch, skipPreview: true)
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertTrue(plan.commandArguments.contains("--patch"))
        XCTAssertTrue(plan.commandArguments.contains(reviewPatch.path))
        XCTAssertTrue(plan.commandLine.contains("review_patch.json"))
    }

    func testRunRebuildsIndexAfterSuccessfulCompile() throws {
        let (root, project) = try temporaryCompileProject("videoos-compile-run")
        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectRoughCutCompileRunner.run(plan: plan) { _, arguments in
            XCTAssertTrue(arguments.contains { $0.hasSuffix("scripts/compile-timeline.ts") })
            XCTAssertTrue(arguments.contains(project.path))
            try writeCompiledTimelineArtifacts(project: project)
            try writeCompileAnalysisArtifacts(project: project)
            return ProjectInitializationProcessResult(status: 0, stdout: "Timeline compiled", stderr: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertTrue(result.timelineExists)
        XCTAssertEqual(result.indexSummary?.assetCount, 1)
        XCTAssertEqual(result.indexSummary?.segmentCount, 1)
        XCTAssertEqual(result.indexSummary?.searchDocumentCount, 2)
        XCTAssertTrue(ProjectSQLiteIndex.status(projectURL: project).exists)
    }

    func testRunDoesNotRebuildIndexAfterFailedCompile() throws {
        let (root, project) = try temporaryCompileProject("videoos-compile-fail")
        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectRoughCutCompileRunner.run(plan: plan) { _, _ in
            ProjectInitializationProcessResult(status: 1, stdout: "", stderr: "blocked")
        }

        XCTAssertFalse(result.succeeded)
        XCTAssertNil(result.indexSummary)
        XCTAssertFalse(ProjectSQLiteIndex.status(projectURL: project).exists)
    }

    private func temporaryCompileProject(_ prefix: String) throws -> (URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "script".write(to: root.appendingPathComponent("scripts/compile-timeline.ts"), atomically: true, encoding: .utf8)
        try "created_at: 2026-05-22T00:00:00Z\n".write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
        try "project_id: demo\ncandidates: []\n".write(to: project.appendingPathComponent("04_plan/selects_candidates.yaml"), atomically: true, encoding: .utf8)
        try "project_id: demo\nbeats: []\n".write(to: project.appendingPathComponent("04_plan/edit_blueprint.yaml"), atomically: true, encoding: .utf8)
        return (root, project)
    }

    private func writeCompiledTimelineArtifacts(project: URL) throws {
        let timelineDir = project.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try #"{"version":"1.0","sequence":{"name":"Demo","fps":24,"width":1920,"height":1080},"tracks":{"video":[],"audio":[]},"markers":[]}"#
            .write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
    }

    private func writeCompileAnalysisArtifacts(project: URL) throws {
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
