import XCTest
@testable import VideoOSStudioCore

final class ProjectRenderRunnerTests: XCTestCase {
    func testPlanBuildsRenderWorkerCommandForApprovedProject() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-plan", state: "approved")

        let plan = ProjectRenderRunPlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            options: ProjectRenderRunOptions(skipRender: true)
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready to validate package")
        XCTAssertTrue(plan.commandArguments.contains { $0.hasSuffix("scripts/editor-job-worker.ts") })
        XCTAssertTrue(plan.commandArguments.contains(project.path))
        XCTAssertTrue(plan.commandArguments.contains("render"))
        XCTAssertTrue(plan.commandLine.contains("skip_render"))
    }

    func testPlanRequiresApprovedOrPackagedState() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-state", state: "critique_ready")

        let plan = ProjectRenderRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "state must be approved or packaged")
    }

    func testPlanRequiresWorkerInputsBeforeEnablingRender() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-inputs", state: "approved")
        try FileManager.default.removeItem(at: project.appendingPathComponent("01_intent/creative_brief.yaml"))

        var plan = ProjectRenderRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing creative brief")

        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try """
        autonomy:
          mode: full
        """.write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
        try FileManager.default.removeItem(at: project.appendingPathComponent("04_plan/edit_blueprint.yaml"))

        plan = ProjectRenderRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing edit blueprint")
    }

    func testPlanUsesPublishedFinalForPackagedNLEFinishingProject() throws {
        let (root, project) = try temporaryRenderProject(
            "videoos-render-nle",
            state: "packaged",
            sourceOfTruthDecision: "nle_finishing"
        )

        var plan = ProjectRenderRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "supplied final missing")

        let publishedFinal = project.appendingPathComponent("09_output/final.mp4")
        try FileManager.default.createDirectory(at: publishedFinal.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x00, 0x01]).write(to: publishedFinal, options: .atomic)

        plan = ProjectRenderRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.options.suppliedFinalURL, publishedFinal)
        XCTAssertTrue(plan.commandLine.contains("supplied_final_path"))
    }

    func testRunUsesInjectedWorkerAndReadsRenderedPackageStatus() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-run", state: "approved")
        let plan = ProjectRenderRunPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectRenderRunner.run(plan: plan) { _, arguments in
            XCTAssertTrue(arguments.contains("render"))
            try writeRenderPackageFixture(project: project, qaPassed: true)
            return ProjectInitializationProcessResult(status: 0, stdout: "__RESULT__{\"success\":true}__END__", stderr: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.status.readinessLabel, "render packaged")
        XCTAssertEqual(result.status.qaPassed, true)
        XCTAssertTrue(result.status.publishedFinalVideoExists)
    }

    private func temporaryRenderProject(
        _ prefix: String,
        state: String,
        sourceOfTruthDecision: String = "engine_render"
    ) throws -> (URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("05_timeline"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("06_review"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "script".write(to: root.appendingPathComponent("scripts/editor-job-worker.ts"), atomically: true, encoding: .utf8)
        try """
        autonomy:
          mode: full
        """.write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
        try """
        caption_policy:
          source: none
          delivery_mode: both
        """.write(to: project.appendingPathComponent("04_plan/edit_blueprint.yaml"), atomically: true, encoding: .utf8)
        try #"{"version":"1","sequence":{"fps":24},"tracks":{"video":[],"audio":[]}}"#
            .write(to: project.appendingPathComponent("05_timeline/timeline.json"), atomically: true, encoding: .utf8)
        try """
        summary_judgment:
          status: approved
        """.write(to: project.appendingPathComponent("06_review/review_report.yaml"), atomically: true, encoding: .utf8)
        try """
        current_state: \(state)
        approval_record:
          status: clean
        handoff_resolution:
          status: decided
          source_of_truth_decision: \(sourceOfTruthDecision)
        gates:
          review_gate: open
        """.write(to: project.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)
        return (root, project)
    }

    private func writeRenderPackageFixture(project: URL, qaPassed: Bool) throws {
        let package = project.appendingPathComponent("07_package")
        let video = package.appendingPathComponent("video")
        let audio = package.appendingPathComponent("audio")
        let output = project.appendingPathComponent("09_output")
        try FileManager.default.createDirectory(at: video, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try Data([0x00, 0x01]).write(to: video.appendingPathComponent("final.mp4"), options: .atomic)
        try Data([0x02, 0x03]).write(to: audio.appendingPathComponent("final_mix.wav"), options: .atomic)
        try Data([0x04, 0x05]).write(to: output.appendingPathComponent("final.mp4"), options: .atomic)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "source_of_truth": "engine_render",
          "qa_profile": "engine_render",
          "passed": \(qaPassed ? "true" : "false"),
          "checks": [
            { "name": "timeline_schema_valid", "passed": true, "details": "ok" }
          ]
        }
        """.write(to: package.appendingPathComponent("qa-report.json"), atomically: true, encoding: .utf8)
        try """
        {
          "version": "package-v1",
          "project_id": "demo",
          "source_of_truth": "engine_render",
          "base_timeline_version": "1",
          "packaging_projection_hash": "abc123",
          "created_at": "2026-05-22T00:00:00Z",
          "artifacts": {
            "final_video": { "path": "09_output/final.mp4", "sha256": "abc" },
            "qa_report": { "path": "07_package/qa-report.json", "sha256": "def" }
          },
          "provenance": {
            "editorial_timeline_hash": "timeline"
          }
        }
        """.write(to: package.appendingPathComponent("package_manifest.json"), atomically: true, encoding: .utf8)
    }
}
