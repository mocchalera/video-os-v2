import XCTest
@testable import VideoOSStudioCore

final class ProjectIntentSummaryTests: XCTestCase {
    func testSummaryReadsBriefAndBlockersForNativeIntentView() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-intent-\(UUID().uuidString)")
        try writeIntentFixture(at: root, blockerStatus: "blocker")

        let summary = ProjectIntentSummaryReader.summary(projectURL: root)

        XCTAssertEqual(summary.readinessLabel, "intent blocked")
        XCTAssertEqual(summary.displayTitle, "Mountain Reset")
        XCTAssertEqual(summary.strategy, "message-first")
        XCTAssertEqual(summary.format, "short-brand-film")
        XCTAssertEqual(summary.runtimeTargetSeconds, "28")
        XCTAssertEqual(summary.primaryMessage, "Recovery is an intentional slowing down, not a performance.")
        XCTAssertEqual(summary.primaryAudience, "urban adults 30-45")
        XCTAssertEqual(summary.emotionCurve, ["curiosity", "grounding", "release"])
        XCTAssertEqual(summary.mustHave, ["morning light", "audible breathing"])
        XCTAssertEqual(summary.mustAvoid, ["summit rhetoric"])
        XCTAssertEqual(summary.autonomyLabel, "collaborative")
        XCTAssertEqual(summary.mayDecideCount, 1)
        XCTAssertEqual(summary.mustAsk, ["changing message"])
        XCTAssertEqual(summary.blockerCount, 1)
        XCTAssertEqual(summary.openBlockerQuestions, ["Need music rights approval?"])
    }

    func testSummaryReportsReadyWhenNoBlockingQuestionsRemain() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-intent-ready-\(UUID().uuidString)")
        try writeIntentFixture(at: root, blockerStatus: "resolved")

        let summary = ProjectIntentSummaryReader.summary(projectURL: root)

        XCTAssertEqual(summary.readinessLabel, "intent ready")
        XCTAssertEqual(summary.blockerCount, 0)
        XCTAssertEqual(summary.recommendation, "Intent is readable; use it to guide triage, blueprint, review, and handoff decisions.")
    }

    func testSummaryReportsMissingBrief() {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-intent-missing-\(UUID().uuidString)")

        let summary = ProjectIntentSummaryReader.summary(projectURL: root)

        XCTAssertEqual(summary.readinessLabel, "missing creative brief")
        XCTAssertFalse(summary.briefExists)
    }
}

private func writeIntentFixture(at root: URL, blockerStatus: String) throws {
    let intentDir = root.appendingPathComponent("01_intent")
    try FileManager.default.createDirectory(at: intentDir, withIntermediateDirectories: true)
    try """
    version: "1"
    project_id: demo
    project:
      title: Mountain Reset
      strategy: message-first
      format: short-brand-film
      runtime_target_sec: 28
    message:
      primary: Recovery is an intentional slowing down, not a performance.
    audience:
      primary: urban adults 30-45
    emotion_curve:
      - curiosity
      - grounding
      - release
    must_have:
      - morning light
      - audible breathing
    must_avoid:
      - summit rhetoric
    autonomy:
      mode: collaborative
      may_decide:
        - exact cut position
      must_ask:
        - changing message
    resolved_assumptions:
      - observed tone
    """.write(to: intentDir.appendingPathComponent("creative_brief.yaml"), atomically: true, encoding: .utf8)

    try """
    version: "1"
    project_id: demo
    blockers:
      - id: BLK_001
        question: Need music rights approval?
        status: \(blockerStatus)
        why_it_matters: Cannot ship without approval.
        allowed_temporary_assumption: null
    """.write(to: intentDir.appendingPathComponent("unresolved_blockers.yaml"), atomically: true, encoding: .utf8)
}
