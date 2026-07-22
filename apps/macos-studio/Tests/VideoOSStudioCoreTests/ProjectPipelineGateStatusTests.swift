import XCTest
@testable import VideoOSStudioCore

final class ProjectPipelineGateStatusTests: XCTestCase {
    func testStatusReportsRevisionPassWhenReviewNeedsWork() throws {
        let (root, project) = try temporaryPipelineProject(
            "videoos-pipeline-revision",
            state: "critique_ready",
            reviewStatus: "needs_revision",
            patchOperations: 2
        )

        let status = ProjectPipelineGateStatusReader.status(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight("current_state is critique_ready")
        )

        XCTAssertEqual(status.readinessLabel, "needs revision pass")
        XCTAssertEqual(status.currentState, "critique_ready")
        XCTAssertEqual(status.reviewPatchOperationCount, 2)
        XCTAssertEqual(status.gates["review_gate"], "open")
        XCTAssertEqual(status.gateSummaryLabel, "analysis=ready / planning=open / compile=open / timeline=open / review=open / packaging=blocked")
        XCTAssertEqual(status.nextAction, "Apply the review patch, then run Review again before render.")
    }

    func testStatusReportsReadyToRenderWhenApproved() throws {
        let (root, project) = try temporaryPipelineProject(
            "videoos-pipeline-render",
            state: "approved",
            reviewStatus: "approved",
            patchOperations: 0
        )

        let status = ProjectPipelineGateStatusReader.status(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: readyPreflight()
        )

        XCTAssertEqual(status.readinessLabel, "ready to render")
        XCTAssertTrue(status.renderCanRun)
        XCTAssertEqual(status.nextAction, "Render the final package or export the editor handoff packet.")
    }

    func testStatusPrioritizesReviewRevisionOverRenderRunnableState() throws {
        let (root, project) = try temporaryPipelineProject(
            "videoos-pipeline-renderable-revision",
            state: "approved",
            reviewStatus: "needs_revision",
            patchOperations: 1
        )

        let status = ProjectPipelineGateStatusReader.status(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: readyPreflight()
        )

        XCTAssertTrue(status.renderCanRun)
        XCTAssertEqual(status.readinessLabel, "needs revision pass")
        XCTAssertEqual(status.nextAction, "Apply the review patch, then run Review again before render.")
    }

    func testStatusReportsMissingTimelineBeforeReview() throws {
        let (root, project) = try temporaryPipelineProject(
            "videoos-pipeline-missing-timeline",
            state: "selects_ready",
            reviewStatus: nil,
            patchOperations: 0,
            timeline: false
        )

        let status = ProjectPipelineGateStatusReader.status(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight("timeline is missing")
        )

        XCTAssertEqual(status.readinessLabel, "needs compile")
        XCTAssertEqual(status.nextAction, "Compile the rough cut before review or render.")
    }

    private func readyPreflight() -> ProjectPackagePreflightStatus {
        ProjectPackagePreflightStatus(
            ok: true,
            sourceOfTruth: "engine_render",
            autonomyMode: "full",
            projectID: "demo",
            currentState: "approved",
            visualQaSummary: "verified"
        )
    }

    private func blockedPreflight(_ issue: String) -> ProjectPackagePreflightStatus {
        ProjectPackagePreflightStatus(ok: false, issues: [issue])
    }

    private func temporaryPipelineProject(
        _ prefix: String,
        state: String,
        reviewStatus: String?,
        patchOperations: Int,
        timeline: Bool = true
    ) throws -> (URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
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
        if timeline {
            try FileManager.default.createDirectory(at: project.appendingPathComponent("05_timeline"), withIntermediateDirectories: true)
            try #"{"version":"1","sequence":{"fps":24},"tracks":{"video":[],"audio":[]}}"#
                .write(to: project.appendingPathComponent("05_timeline/timeline.json"), atomically: true, encoding: .utf8)
        }
        if let reviewStatus {
            try """
            summary_judgment:
              status: \(reviewStatus)
            """.write(to: project.appendingPathComponent("06_review/review_report.yaml"), atomically: true, encoding: .utf8)
            let operations = (0..<patchOperations)
                .map { #"{ "op": "add_marker", "reason": "review", "label": "marker\#($0)" }"# }
                .joined(separator: ",")
            try """
            {
              "timeline_version": "1",
              "operations": [\(operations)]
            }
            """.write(to: project.appendingPathComponent("06_review/review_patch.json"), atomically: true, encoding: .utf8)
        }
        try """
        current_state: \(state)
        gates:
          analysis_gate: ready
          planning_gate: open
          compile_gate: open
          timeline_gate: open
          review_gate: open
          packaging_gate: blocked
        last_updated: 2026-05-22T00:00:00Z
        """.write(to: project.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)
        return (root, project)
    }
}
