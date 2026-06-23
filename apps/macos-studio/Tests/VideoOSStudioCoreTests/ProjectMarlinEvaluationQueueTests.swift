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
        let materializeProject = root.appendingPathComponent("projects/materialize-project")
        let blockedProject = root.appendingPathComponent("projects/blocked-project")
        let candidateProject = root.appendingPathComponent("projects/candidate-project")
        try writeQueueProject(at: readyProject, mediaExists: true, marlinCandidate: false)
        try writeQueueProject(at: materializeProject, mediaExists: true, marlinCandidate: false, marlinArtifact: true)
        try writeQueueProject(at: blockedProject, mediaExists: false, marlinCandidate: false)
        try writeQueueProject(at: candidateProject, mediaExists: true, marlinCandidate: true)

        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: root)

        XCTAssertEqual(queue.projectCount, 4)
        XCTAssertEqual(queue.runnableProjectCount, 3)
        XCTAssertEqual(queue.candidateProjectCount, 1)
        XCTAssertEqual(queue.mediaBlockedProjectCount, 1)
        XCTAssertEqual(queue.readinessLabel, "candidate evidence exists")
        XCTAssertEqual(queue.items.map(\.id), ["candidate-project", "materialize-project", "ready-project", "blocked-project"])
        XCTAssertEqual(queue.items[0].priorityLabel, "candidate")
        XCTAssertEqual(queue.items[1].priorityLabel, "materialize peaks")
        XCTAssertEqual(queue.items[2].priorityLabel, "ready to evaluate")
        XCTAssertEqual(queue.items[3].priorityLabel, "relink media")
        XCTAssertTrue(queue.items[1].recommendation.contains("marlin-materialize materialize-project"))
        XCTAssertTrue(queue.items[2].recommendation.contains("marlin-eval-run ready-project"))
        XCTAssertTrue(queue.nextAction.contains("marlin-materialize materialize-project"))

        let next = ProjectMarlinEvaluationNextPlanner.plan(repositoryRoot: root)
        XCTAssertTrue(next.canRun)
        XCTAssertEqual(next.item?.id, "ready-project")
        XCTAssertEqual(next.runPlan?.projectURL.path, readyProject.path)
        XCTAssertTrue(next.runPlan?.commandLine().contains("ready-project") == true)
    }

    func testQueueDoesNotRecommendBoundedRunWhenReadySourcesAreAlreadyEvaluated() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-marlin-queue-exhausted-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "worker".write(to: root.appendingPathComponent("scripts/marlin-evaluate.ts"), atomically: true, encoding: .utf8)

        let exhaustedProject = root.appendingPathComponent("projects/exhausted-project")
        try writeQueueProject(
            at: exhaustedProject,
            mediaExists: true,
            marlinCandidate: false,
            marlinArtifact: true,
            extraMissingAsset: true,
            strongExistingPeak: true
        )

        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: root)

        XCTAssertEqual(queue.items.map(\.id), ["exhausted-project"])
        XCTAssertEqual(queue.items[0].sourceCount, 1)
        XCTAssertEqual(queue.items[0].defaultSelectedSourceCount, 0)
        XCTAssertFalse(queue.items[0].canRunDefaultEvaluation)
        XCTAssertEqual(queue.items[0].priorityLabel, "relink media")
        XCTAssertTrue(queue.items[0].recommendation.contains("No unevaluated ready source files remain"))
        XCTAssertTrue(queue.nextAction.contains("Relink media for exhausted-project"))

        let next = ProjectMarlinEvaluationNextPlanner.plan(repositoryRoot: root, skipExisting: true)
        XCTAssertNil(next.item)
        XCTAssertNil(next.runPlan)
        XCTAssertFalse(next.canRun)
        XCTAssertTrue(next.recommendation.contains("Relink media for exhausted-project"))
    }

    private func writeQueueProject(
        at project: URL,
        mediaExists: Bool,
        marlinCandidate: Bool,
        marlinArtifact: Bool = false,
        extraMissingAsset: Bool = false,
        strongExistingPeak: Bool = false
    ) throws {
        let analysisDir = project.appendingPathComponent("03_analysis")
        let mediaDir = project.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        if mediaExists {
            try Data([0x00]).write(to: mediaDir.appendingPathComponent("interview.mov"))
        }

        let extraAsset = extraMissingAsset
            ? """
              ,
              {
                "asset_id": "AST_MISSING",
                "filename": "missing.mov",
                "role_guess": "b-roll",
                "duration_us": 1000000,
                "has_transcript": false,
                "segment_ids": ["SEG_MISSING"],
                "quality_flags": [],
                "tags": ["b-roll"]
              }
              """
            : ""

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
            }\(extraAsset)
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

        let peak: String
        if marlinCandidate {
            peak =
            """
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
        } else if strongExistingPeak {
            peak =
            """
              ,
              "peak_analysis": {
                "selected_peak_us": 500000,
                "confidence": 0.95,
                "support_signals": {
                  "fused_peak_score": 0.95
                },
                "provenance": {
                  "precision_mode": "action_only",
                  "fusion_version": "peak-fusion-v1"
                }
              }
              """
        } else {
            peak = ""
        }

        let extraSegment = extraMissingAsset
            ? """
              ,
              {
                "segment_id": "SEG_MISSING",
                "asset_id": "AST_MISSING",
                "src_in_us": 0,
                "src_out_us": 1000000,
                "summary": "missing b-roll",
                "transcript_excerpt": "",
                "quality_flags": [],
                "tags": ["b-roll"],
                "interest_points": []
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
            }\(extraSegment)
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)

        guard marlinCandidate || marlinArtifact else { return }
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
