import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinEvaluationQueueTests: XCTestCase {
    func testQueueRanksCandidatesRunnableProjectsAndMediaBlockers() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-marlin-queue-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "worker".write(to: root.appendingPathComponent("scripts/marlin-evaluate.ts"), atomically: true, encoding: .utf8)

        let readyProject = root.appendingPathComponent("projects/ready-project")
        let blockedProject = root.appendingPathComponent("projects/blocked-project")
        let candidateProject = root.appendingPathComponent("projects/candidate-project")
        try writeQueueProject(at: readyProject, mediaExists: true, marlinCandidate: false)
        try writeQueueProject(at: blockedProject, mediaExists: false, marlinCandidate: false)
        try writeQueueProject(at: candidateProject, mediaExists: true, marlinCandidate: true)

        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: root)

        XCTAssertEqual(queue.projectCount, 3)
        XCTAssertEqual(queue.runnableProjectCount, 2)
        XCTAssertEqual(queue.candidateProjectCount, 1)
        XCTAssertEqual(queue.mediaBlockedProjectCount, 1)
        XCTAssertEqual(queue.readinessLabel, "candidate evidence exists")
        XCTAssertEqual(queue.items.map(\.id), ["candidate-project", "ready-project", "blocked-project"])
        XCTAssertEqual(queue.items[0].priorityLabel, "candidate")
        XCTAssertEqual(queue.items[1].priorityLabel, "ready to evaluate")
        XCTAssertEqual(queue.items[2].priorityLabel, "relink media")
        XCTAssertTrue(queue.items[1].recommendation.contains("marlin-eval-run ready-project"))

        let next = ProjectMarlinEvaluationNextPlanner.plan(repositoryRoot: root)
        XCTAssertTrue(next.canRun)
        XCTAssertEqual(next.item?.id, "ready-project")
        XCTAssertEqual(next.runPlan?.projectURL.path, readyProject.path)
        XCTAssertTrue(next.runPlan?.commandLine().contains("ready-project") == true)
    }

    private func writeQueueProject(at project: URL, mediaExists: Bool, marlinCandidate: Bool) throws {
        let analysisDir = project.appendingPathComponent("03_analysis")
        let mediaDir = project.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        if mediaExists {
            try Data([0x00]).write(to: mediaDir.appendingPathComponent("interview.mov"))
        }

        try """
        {
          "project_id": "\(project.lastPathComponent)",
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

        let peak = marlinCandidate
            ? """
              ,
              "peak_analysis": {
                "selected_peak_us": 500000,
                "confidence": 0.9,
                "provenance": {
                  "precision_mode": "marlin_temporal_semantics",
                  "fusion_version": "marlin-fixture"
                }
              }
              """
            : ""
        try """
        {
          "project_id": "\(project.lastPathComponent)",
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
              "tags": ["interview"],
              "interest_points": []\(peak)
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)

        guard marlinCandidate else { return }
        try """
        {
          "project_id": "\(project.lastPathComponent)",
          "artifact_version": "marlin-events-v1",
          "model": {
            "provider": "marlin",
            "model_alias": "NemoStation/Marlin-2B",
            "model_snapshot": "test",
            "connector_version": "marlin-local-v1"
          },
          "items": [
            {
              "asset_id": "AST_001",
              "source_path": "02_media/source/interview.mov",
              "scene": "interview",
              "caption": "subject introduces the idea",
              "events": [
                {
                  "event_id": "MEV_001",
                  "start_us": 0,
                  "end_us": 1000000,
                  "description": "main moment",
                  "confidence": 0.9,
                  "source_pass": "caption"
                }
              ],
              "find_results": [
                {
                  "query": "main moment",
                  "span_start_us": 0,
                  "span_end_us": 1000000,
                  "format_ok": true,
                  "confidence": 0.9
                }
              ]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("marlin_events.json"), atomically: true, encoding: .utf8)
    }
}
