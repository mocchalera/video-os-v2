import XCTest
@testable import VideoOSStudioCore

final class QADashboardDocumentTests: XCTestCase {
    func testQAIterationReportJSONRoundTrip() throws {
        let data = Data("""
        {
          "iteration": 1,
          "total_issues": 2,
          "fixable_issues": 1,
          "overall_qa_score": 0.84,
          "brief_alignment_scores": {
            "composite": 0.533,
            "selects.intent_message_alignment": 0.25,
            "blueprint.intent_message_alignment": 0.7
          },
          "issues": [
            {
              "issue_id": "QAISSUE_001",
              "type": "continuity",
              "severity": 0.65,
              "timestamp_sec": 17.5,
              "clip_id": "CLP_0004",
              "beat_id": "b02",
              "description": "Scene repeats.",
              "fixable": true
            },
            {
              "issue_id": "QAISSUE_002",
              "type": "quality",
              "severity": 0.4,
              "timestamp_sec": 21.25,
              "description": "Open exposure issue.",
              "fixable": false
            }
          ],
          "fixes": [
            {
              "issue_id": "QAISSUE_001",
              "issue": {
                "issue_id": "QAISSUE_001",
                "type": "continuity",
                "severity": 0.65,
                "timestamp_sec": 17.5,
                "clip_id": "CLP_0004",
                "beat_id": "b02",
                "description": "Scene repeats.",
                "fixable": true
              },
              "fix_type": "insert",
              "target_clip_id": "CLP_0002",
              "target_beat_id": "b02",
              "replacement": {
                "segment_id": "SEG_BRIDGE",
                "search_mode": "visual",
                "search_score": 0.922,
                "matched_frame_path": "03_analysis/frames/SEG_BRIDGE/representative.jpg",
                "reason": "Bridge visual continuity."
              },
              "expected_improvement": 0.6,
              "risk": "medium"
            }
          ],
          "timestamp": "2026-06-22T00:00:00.000Z"
        }
        """.utf8)

        let decoded = try JSONDecoder().decode(QAIterationReport.self, from: data)
        let encoded = try JSONEncoder().encode(decoded)
        let roundTripped = try JSONDecoder().decode(QAIterationReport.self, from: encoded)

        XCTAssertEqual(roundTripped, decoded)
        XCTAssertEqual(decoded.overall_qa_score, 84)
        XCTAssertEqual(decoded.issues?.map(\.issue_id), ["QAISSUE_001", "QAISSUE_002"])
        XCTAssertEqual(decoded.fixes?.first?.replacement?.segment_id, "SEG_BRIDGE")
    }

    func testBriefAlignmentScoresKeepSelectsAndBlueprintSeparate() throws {
        let report = try decodeReport(
            iteration: 1,
            score: 76,
            scores: [
                "intent_message_alignment": 0.25,
                "selects.intent_message_alignment": 0.25,
                "blueprint.intent_message_alignment": 0.7,
                "selects.visual_variety_and_focus": 0.8,
                "blueprint.visual_variety_and_focus": 0.4
            ]
        )

        XCTAssertEqual(report.brief_alignment_scores?["selects.intent_message_alignment"], 0.25)
        XCTAssertEqual(report.brief_alignment_scores?["blueprint.intent_message_alignment"], 0.7)
        XCTAssertEqual(report.brief_alignment_scores?["intent_message_alignment"], 0.25)
    }

    func testDashboardScoreComputedProperties() throws {
        let baseline = try decodeReport(iteration: 1, score: 76, fixCount: 2)
        let latest = try decodeReport(iteration: 2, score: 84, fixCount: 1)
        let index = QAImprovementIndexDocument(
            version: "1",
            project_id: "demo",
            run_id: "2026-06-22T00:00:00.000Z",
            base_timeline_hash: "base",
            result_timeline_hash: "result",
            convergence_reason: "score_plateau",
            iterations: []
        )

        let document = QADashboardDocument(index: index, iterations: [baseline, latest])

        XCTAssertEqual(document.baselineScore, 76)
        XCTAssertEqual(document.latestScore, 84)
        XCTAssertEqual(document.scoreImprovement, 8)
        XCTAssertEqual(document.totalFixesApplied, 3)
        XCTAssertEqual(document.convergenceReason, "score_plateau")
    }

    func testLatestIssuesByClipIDGroupsLatestReportIssuesBySeverity() throws {
        let baseline = try decodeReport(iteration: 1, score: 76)
        let latest = try JSONDecoder().decode(QAIterationReport.self, from: Data("""
        {
          "iteration": 2,
          "total_issues": 3,
          "fixable_issues": 2,
          "overall_qa_score": 84,
          "brief_alignment_scores": { "composite": 0.5 },
          "issues": [
            {
              "issue_id": "QAISSUE_LOW",
              "type": "continuity",
              "severity": 0.25,
              "timestamp_sec": 12.0,
              "clip_id": "CLP_0004",
              "description": "Minor continuity wobble.",
              "fixable": true
            },
            {
              "issue_id": "QAISSUE_HIGH",
              "type": "pacing",
              "severity": 0.9,
              "timestamp_sec": 10.0,
              "clip_id": "CLP_0004",
              "description": "The clip drags before the beat.",
              "fixable": true
            },
            {
              "issue_id": "QAISSUE_GLOBAL",
              "type": "overall",
              "severity": 0.6,
              "timestamp_sec": 20.0,
              "description": "Global issue without a clip target.",
              "fixable": false
            }
          ],
          "fixes": [],
          "timestamp": "2026-06-22T00:00:02.000Z"
        }
        """.utf8))
        let document = QADashboardDocument(index: nil, iterations: [baseline, latest])

        XCTAssertEqual(document.latestIssuesByClipID.keys.sorted(), ["CLP_0004"])
        XCTAssertEqual(document.latestIssuesByClipID["CLP_0004"]?.map(\.issue_id), ["QAISSUE_HIGH", "QAISSUE_LOW"])
    }

    func testLoadUsesIndexManifestWhenPresent() throws {
        let project = try temporaryQAProject()
        try writeReviewFile(project: project, "qa-improvement-report-iter1.json", reportJSON(iteration: 1, score: 76))
        try writeReviewFile(project: project, "qa-improvement-report-iter2.json", reportJSON(iteration: 2, score: 84))
        try writeReviewFile(project: project, "qa-improvement-report-iter99.json", reportJSON(iteration: 99, score: 10))
        try writeReviewFile(project: project, "qa-improvement-index.json", """
        {
          "version": "1",
          "project_id": "demo",
          "run_id": "2026-06-22T00:00:00.000Z",
          "base_timeline_hash": "base",
          "result_timeline_hash": "result",
          "convergence_reason": "max_iterations",
          "iterations": [
            { "path": "06_review/qa-improvement-report-iter1.json", "iteration": 1 },
            { "path": "06_review/qa-improvement-report-iter2.json", "iteration": 2 }
          ]
        }
        """)

        let document = QADashboardDocument.load(projectURL: project)

        XCTAssertEqual(document.index?.run_id, "2026-06-22T00:00:00.000Z")
        XCTAssertEqual(document.iterations.map(\.iteration), [1, 2])
        XCTAssertEqual(document.latestScore, 84)
        XCTAssertEqual(document.convergenceReason, "max_iterations")
    }

    func testLoadFallsBackToLegacyIterationGlobWithoutIndex() throws {
        let project = try temporaryQAProject()
        try writeReviewFile(project: project, "qa-improvement-report-iter2.json", reportJSON(iteration: 2, score: 84))
        try writeReviewFile(project: project, "qa-improvement-report-iter1.json", reportJSON(iteration: 1, score: 76))

        let document = QADashboardDocument.load(projectURL: project)

        XCTAssertNil(document.index)
        XCTAssertEqual(document.iterations.map(\.iteration), [1, 2])
        XCTAssertEqual(document.baselineScore, 76)
        XCTAssertEqual(document.scoreImprovement, 8)
    }

    private func decodeReport(
        iteration: Int,
        score: Int,
        fixCount: Int = 0,
        scores: [String: Double] = ["composite": 0.5]
    ) throws -> QAIterationReport {
        try JSONDecoder().decode(QAIterationReport.self, from: Data(reportJSON(
            iteration: iteration,
            score: score,
            fixCount: fixCount,
            scores: scores
        ).utf8))
    }

    private func reportJSON(
        iteration: Int,
        score: Int,
        fixCount: Int = 0,
        scores: [String: Double] = ["composite": 0.5]
    ) -> String {
        let scorePairs = scores
            .map { "\"\($0.key)\": \($0.value)" }
            .sorted()
            .joined(separator: ", ")
        let fixes = (0..<fixCount)
            .map { index in
                """
                {
                  "issue_id": "QAISSUE_\(iteration)_\(index)",
                  "fix_type": "swap",
                  "target_clip_id": "CLP_\(index)",
                  "target_beat_id": "b01"
                }
                """
            }
            .joined(separator: ",")
        return """
        {
          "iteration": \(iteration),
          "total_issues": \(fixCount),
          "fixable_issues": \(fixCount),
          "overall_qa_score": \(score),
          "brief_alignment_scores": { \(scorePairs) },
          "issues": [],
          "fixes": [\(fixes)],
          "timestamp": "2026-06-22T00:00:0\(iteration).000Z"
        }
        """
    }

    private func temporaryQAProject() throws -> URL {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-qa-dashboard-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent("06_review"),
            withIntermediateDirectories: true
        )
        return project
    }

    private func writeReviewFile(project: URL, _ filename: String, _ content: String) throws {
        try content.write(
            to: project.appendingPathComponent("06_review").appendingPathComponent(filename),
            atomically: true,
            encoding: .utf8
        )
    }
}
