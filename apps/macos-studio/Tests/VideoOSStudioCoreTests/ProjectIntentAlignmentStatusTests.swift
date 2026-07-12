import XCTest
@testable import VideoOSStudioCore

final class ProjectIntentAlignmentStatusTests: XCTestCase {
    func testStatusReportsAlignedWhenMustHaveEvidenceAndReviewMatch() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-intent-align-\(UUID().uuidString)")
        try writeAlignmentFixture(at: root, reviewStatus: "pass", mismatch: false)

        let status = ProjectIntentAlignmentStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "intent aligned")
        XCTAssertEqual(status.coverageLabel, "2/2 must-have cues")
        XCTAssertEqual(status.mustHaveCovered, ["morning light", "audible breathing"])
        XCTAssertEqual(status.mustHaveMissing, [])
        XCTAssertEqual(status.mustAvoidAcknowledged, ["triumphal summit rhetoric"])
        XCTAssertEqual(status.briefMismatchCount, 0)
    }

    func testStatusReportsReviewNeedsRevisionBeforeAligned() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-intent-align-review-\(UUID().uuidString)")
        try writeAlignmentFixture(at: root, reviewStatus: "needs_revision", mismatch: false)

        let status = ProjectIntentAlignmentStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "review needs revision")
        XCTAssertEqual(status.recommendation, "Review recommends another pass; inspect weaknesses before final handoff.")
    }

    func testStatusReportsBriefMismatch() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-intent-align-mismatch-\(UUID().uuidString)")
        try writeAlignmentFixture(at: root, reviewStatus: "pass", mismatch: true)

        let status = ProjectIntentAlignmentStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "brief mismatch")
        XCTAssertEqual(status.briefMismatchCount, 1)
    }

    private func writeAlignmentFixture(at root: URL, reviewStatus: String, mismatch: Bool) throws {
        let intentDir = root.appendingPathComponent("01_intent")
        let planDir = root.appendingPathComponent("04_plan")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let reviewDir = root.appendingPathComponent("06_review")
        for dir in [intentDir, planDir, timelineDir, reviewDir] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        try """
        version: "1"
        project_id: demo
        project:
          title: Mountain Reset
          strategy: message-first
        message:
          primary: Recovery is slow.
        audience:
          primary: adults
        emotion_curve:
          - grounding
          - release
          - warmth
        must_have:
          - morning light
          - audible breathing
        must_avoid:
          - triumphal summit rhetoric
        autonomy:
          may_decide: []
          must_ask: []
        resolved_assumptions:
          - quiet
        """.write(to: intentDir.appendingPathComponent("creative_brief.yaml"), atomically: true, encoding: .utf8)
        try """
        version: "1"
        project_id: demo
        blockers: []
        """.write(to: intentDir.appendingPathComponent("unresolved_blockers.yaml"), atomically: true, encoding: .utf8)
        try """
        beats:
          - notes: morning light and audible breath protect against summit rhetoric
        """.write(to: planDir.appendingPathComponent("edit_blueprint.yaml"), atomically: true, encoding: .utf8)
        try #"{"tracks":{"video":[]},"provenance":{"brief_path":"01_intent/creative_brief.yaml"}}"#.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
        try """
        summary_judgment:
          status: \(reviewStatus)
        mismatches_to_brief:\(mismatch ? "\n  - summary: wrong message" : " []")
        mismatches_to_blueprint: []
        """.write(to: reviewDir.appendingPathComponent("review_report.yaml"), atomically: true, encoding: .utf8)
    }
}
