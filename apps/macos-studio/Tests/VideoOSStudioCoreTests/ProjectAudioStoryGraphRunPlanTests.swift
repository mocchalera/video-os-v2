import XCTest
@testable import VideoOSStudioCore

final class ProjectAudioStoryGraphRunPlanTests: XCTestCase {
    func testPlanBuildsAudioStoryGraphCommandWhenAnalysisExists() throws {
        let root = temporaryURL("videoos-audio-story-root")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("03_analysis"), withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("scripts/build-audio-story-graph.ts"))
        try "{}".write(to: project.appendingPathComponent("03_analysis/assets.json"), atomically: true, encoding: .utf8)

        let plan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready")
        XCTAssertEqual(plan.commandArguments, ["npx", "tsx", root.appendingPathComponent("scripts/build-audio-story-graph.ts").path, project.path])
    }

    func testRunRebuildsIndexAfterSuccessfulGraphBuild() throws {
        let root = temporaryURL("videoos-audio-story-run-root")
        let project = root.appendingPathComponent("projects/demo")
        try writeIndexableAudioStoryProject(at: project)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("scripts/build-audio-story-graph.ts"))
        let plan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectAudioStoryGraphRunner.run(plan: plan, runner: { _, _ in
            let graph = """
            {
              "version": "1.0.0",
              "project_id": "demo",
              "artifact_version": "analysis-v3",
              "created_at": "2026-05-22T00:00:00Z",
              "source_media_manifest_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
              "inputs": {
                "transcript_hashes": [],
                "audio_events_hash": null,
                "bgm_analysis_hash": null,
                "coverage_report_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
              },
              "nodes": [
                {
                  "node_id": "UTTREF_demo_1",
                  "node_type": "utterance",
                  "asset_id": "AST_001",
                  "start_us": 1000000,
                  "end_us": 2000000,
                  "text": "The key line lands.",
                  "story_role": "setup",
                  "refs": {
                    "transcript_ref": "TR_AST_001",
                    "speaker_ref": "SPK_S1",
                    "audio_event_ref": null,
                    "bgm_ref": null
                  },
                  "confidence": {
                    "score": 0.9,
                    "source": "test",
                    "status": "ready"
                  }
                }
              ],
              "edges": [],
              "coverage": {
                "status": "partial",
                "dialogue_lane": "ready",
                "audio_event_lane": "skipped",
                "music_lane": "skipped",
                "missing_inputs": ["audio_events", "bgm_analysis"]
              },
              "provenance": {
                "producer": "analysis-pipeline",
                "inputs": [],
                "hash_policy": {
                  "algorithm": "sha256",
                  "canonicalization": "normalized-json-v1",
                  "excluded_fields": ["created_at"]
                }
              }
            }
            """
            let analysisDir = project.appendingPathComponent("03_analysis")
            try graph.write(to: analysisDir.appendingPathComponent("audio_story_graph.json"), atomically: true, encoding: .utf8)
            return ProjectInitializationProcessResult(status: 0, stdout: "nodes: 1", stderr: "")
        })

        XCTAssertTrue(result.succeeded)
        XCTAssertNotNil(result.indexSummary)
        XCTAssertEqual(result.indexSummary?.audioStoryNodeCount, 1)
    }

    private func temporaryURL(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }
}

private func writeIndexableAudioStoryProject(at root: URL) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
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
          "duration_us": 4000000,
          "has_transcript": true,
          "transcript_ref": "TR_AST_001",
          "segment_ids": ["SEG_001"],
          "quality_flags": [],
          "tags": ["dialogue"]
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
          "src_out_us": 4000000,
          "summary": "speaker lands the key line",
          "transcript_excerpt": "The key line lands.",
          "quality_flags": [],
          "tags": ["dialogue"]
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
}
