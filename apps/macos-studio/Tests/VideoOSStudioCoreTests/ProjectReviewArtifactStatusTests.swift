import XCTest
@testable import VideoOSStudioCore

final class ProjectReviewArtifactStatusTests: XCTestCase {
    func testStatusReportsMissingTimelineBeforeReview() throws {
        let project = try temporaryReviewProject("videoos-review-missing-timeline", timeline: false)

        let status = ProjectReviewArtifactStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "waiting for timeline")
        XCTAssertEqual(status.recommendation, "Compile a rough cut before running review.")
    }

    func testStatusReadsReviewReportAndPatchSummary() throws {
        let project = try temporaryReviewProject("videoos-review-status", timeline: true)
        try writeReviewArtifacts(project: project, judgment: "needs_revision", fatal: false)

        let status = ProjectReviewArtifactStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "needs revision")
        XCTAssertTrue(status.reportReadable)
        XCTAssertTrue(status.patchReadable)
        XCTAssertEqual(status.judgmentStatus, "needs_revision")
        XCTAssertEqual(status.rationale, "Good base, but pacing needs another pass.")
        XCTAssertEqual(status.confidence, "0.72")
        XCTAssertEqual(status.strengthCount, 1)
        XCTAssertEqual(status.weaknessCount, 2)
        XCTAssertEqual(status.fatalIssueCount, 0)
        XCTAssertEqual(status.warningCount, 1)
        XCTAssertEqual(status.briefMismatchCount, 1)
        XCTAssertEqual(status.blueprintMismatchCount, 1)
        XCTAssertEqual(status.recommendedGoal, "Tighten the middle act.")
        XCTAssertEqual(status.recommendedActions, ["Trim clip CLIP_002", "Add a dialogue marker"])
        XCTAssertEqual(status.previewPath, "05_timeline/preview-first30s.mp4")
        XCTAssertEqual(status.patchOperationCount, 2)
        XCTAssertEqual(status.patchOperationKinds, ["trim_segment": 1, "add_marker": 1])
        XCTAssertEqual(status.issueLabel, "0 fatal / 1 warning / 2 weakness")
        XCTAssertEqual(status.mismatchLabel, "1 brief / 1 blueprint")
        XCTAssertEqual(status.patchLabel, "2 operations (add_marker: 1, trim_segment: 1)")
        XCTAssertEqual(status.recommendation, "Tighten the middle act.")
    }

    func testStatusBlocksOnFatalReviewIssue() throws {
        let project = try temporaryReviewProject("videoos-review-fatal", timeline: true)
        try writeReviewArtifacts(project: project, judgment: "blocked", fatal: true)

        let status = ProjectReviewArtifactStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "blocked")
        XCTAssertEqual(status.fatalIssueCount, 1)
        XCTAssertEqual(status.recommendation, "Resolve blocking review issues before render or editor handoff.")
    }

    private func temporaryReviewProject(_ prefix: String, timeline: Bool) throws -> URL {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        if timeline {
            let timelineDir = project.appendingPathComponent("05_timeline")
            try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
            try #"{"version":"1.0","sequence":{"fps":24},"tracks":{"video":[],"audio":[]}}"#
                .write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
        }
        return project
    }

    private func writeReviewArtifacts(project: URL, judgment: String, fatal: Bool) throws {
        let reviewDir = project.appendingPathComponent("06_review")
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)
        try """
        version: "1"
        project_id: demo
        timeline_version: tl-v1
        created_at: "2026-05-22T00:00:00Z"
        summary_judgment:
          status: \(judgment)
          rationale: "Good base, but pacing needs another pass."
          confidence: 0.72
        strengths:
          - summary: Clear opening image
        weaknesses:
          - summary: Middle act drifts
          - summary: End beat arrives early
        fatal_issues:\(fatal ? "\n  - summary: Missing required source\n    severity: fatal" : " []")
        warnings:
          - summary: Music edit is abrupt
            severity: warning
        mismatches_to_brief:
          - expected_ref: must_have[0]
            observed_issue: breathing is buried
            why_it_matters: emotion cue is lost
        mismatches_to_blueprint:
          - expected_ref: beat[2]
            observed_issue: beat order changed
            why_it_matters: story arc is weaker
        recommended_next_pass:
          goal: "Tighten the middle act."
          actions:
            - Trim clip CLIP_002
            - Add a dialogue marker
        preview_path: 05_timeline/preview-first30s.mp4
        """.write(to: reviewDir.appendingPathComponent("review_report.yaml"), atomically: true, encoding: .utf8)

        try """
        {
          "timeline_version": "tl-v1",
          "operations": [
            { "op": "trim_segment", "target_clip_id": "CLIP_002", "new_duration_frames": 120, "reason": "tighten" },
            { "op": "add_marker", "beat_id": "beat-2", "label": "dialogue", "reason": "handoff note" }
          ]
        }
        """.write(to: reviewDir.appendingPathComponent("review_patch.json"), atomically: true, encoding: .utf8)
    }
}
