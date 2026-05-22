import XCTest
@testable import VideoOSStudioCore

final class ProjectPlanningStatusTests: XCTestCase {
    func testStatusMovesFromAnalysisToTriageToBlueprintToCompile() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-planning-status-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try "created_at: 2026-05-22T00:00:00Z\n".write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
        try "items: []\n".write(to: project.appendingPathComponent("01_intent/unresolved_blockers.yaml"), atomically: true, encoding: .utf8)

        var status = ProjectPlanningStatusReader.status(projectURL: project)
        XCTAssertEqual(status.readinessLabel, "waiting for analysis")
        XCTAssertNil(status.nextAgentJob)

        try writePlanningAnalysisArtifacts(project: project)
        status = ProjectPlanningStatusReader.status(projectURL: project)
        XCTAssertEqual(status.readinessLabel, "ready for triage")
        XCTAssertEqual(status.nextAgentJob, .triage)

        try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
        try "project_id: demo\ncandidates: []\n".write(to: project.appendingPathComponent("04_plan/selects_candidates.yaml"), atomically: true, encoding: .utf8)
        status = ProjectPlanningStatusReader.status(projectURL: project)
        XCTAssertEqual(status.readinessLabel, "ready for blueprint")
        XCTAssertEqual(status.nextAgentJob, .blueprint)

        try "project_id: demo\nbeats: []\n".write(to: project.appendingPathComponent("04_plan/edit_blueprint.yaml"), atomically: true, encoding: .utf8)
        status = ProjectPlanningStatusReader.status(projectURL: project)
        XCTAssertEqual(status.readinessLabel, "planning ready")
        XCTAssertEqual(status.nextAgentJob, .compile)
    }

    func testStatusRequiresCreativeBriefBeforePlanning() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-planning-no-brief-\(UUID().uuidString)")
        try writePlanningAnalysisArtifacts(project: project)

        let status = ProjectPlanningStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "missing creative brief")
        XCTAssertNil(status.nextAgentJob)
        XCTAssertTrue(status.recommendation.contains("editing intent"))
    }

    private func writePlanningAnalysisArtifacts(project: URL) throws {
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
