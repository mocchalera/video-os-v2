import XCTest
@testable import VideoOSStudioCore

final class ProjectStudioReadinessStatusTests: XCTestCase {
    func testStatusReportsIngestNeededForEmptyProject() throws {
        let (root, project) = try temporaryStudioProject("videoos-studio-empty")
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)

        let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.readinessLabel, "needs ingest")
        XCTAssertEqual(status.scoreLabel, "1/9")
        XCTAssertEqual(status.marlinDefaultLabel, "not evaluated")
        XCTAssertEqual(status.capabilities.first?.id, "codex-runtime")
        XCTAssertTrue(status.capabilities.first?.isReady == true)
        XCTAssertTrue(status.nextAction.contains("Run analysis"))
        XCTAssertEqual(status.nextCommand, "swift run videoos-studio-cli analysis-run demo")
        XCTAssertEqual(status.capability("material-rag")?.nextCommand, "swift run videoos-studio-cli analysis-run demo")
        XCTAssertEqual(status.capability("audio-story")?.nextCommand, "swift run videoos-studio-cli audio-story-run demo")
        XCTAssertEqual(status.actionQueue.first?.id, "material-rag")
        XCTAssertEqual(status.actionQueue.first?.command, "swift run videoos-studio-cli analysis-run demo")
    }

    func testStatusSurfacesReviewPatchAsNextAction() throws {
        let (root, project) = try temporaryStudioProject("videoos-studio-review")
        try writeStudioFixture(
            root: root,
            project: project,
            currentState: "critique_ready",
            reviewStatus: "needs_revision",
            patchOperations: 2
        )

        let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.readinessLabel, "needs revision pass")
        XCTAssertEqual(status.pipelineLabel, "needs revision pass")
        XCTAssertEqual(status.marlinLabel, "candidate for preferred VLM")
        XCTAssertEqual(status.marlinDefaultLabel, "needs representative coverage")
        XCTAssertTrue(status.marlinDefaultDetail.contains("1/1 candidate projects"))
        XCTAssertEqual(status.capability("rough-cut-review")?.readinessLabel, "needs revision pass")
        XCTAssertEqual(status.nextAction, "Apply the review patch, then run Review again before render.")
        XCTAssertEqual(status.nextCommand, "swift run videoos-studio-cli compile-run demo --review-patch")
        XCTAssertEqual(status.actionQueue.first?.id, "rough-cut-review")
        XCTAssertEqual(status.actionQueue.first?.command, "swift run videoos-studio-cli compile-run demo --review-patch")
        XCTAssertTrue(status.actionQueue.contains { $0.id == "marlin-default" && !$0.isBlocking })
    }

    func testStatusReportsStudioReadyWhenApprovedAndRunnable() throws {
        let (root, project) = try temporaryStudioProject("videoos-studio-approved")
        try writeStudioFixture(
            root: root,
            project: project,
            currentState: "approved",
            reviewStatus: "approved",
            patchOperations: 0
        )

        let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.readinessLabel, "studio ready")
        XCTAssertEqual(status.scoreLabel, "9/9")
        XCTAssertEqual(status.marlinDefaultLabel, "needs representative coverage")
        XCTAssertNil(status.nextCommand)
        XCTAssertTrue(status.capability("final-render")?.isReady == true)
        XCTAssertTrue(status.capability("editor-handoff")?.isReady == true)
        XCTAssertEqual(status.actionQueue.map(\.id), ["marlin-default"])
    }

    func testMarlinDefaultActionUsesBoundedSkipExistingEvaluationCommand() throws {
        let (root, project) = try temporaryStudioProject("videoos-studio-marlin-default")
        try writeStudioFixture(
            root: root,
            project: project,
            currentState: "approved",
            reviewStatus: "approved",
            patchOperations: 0
        )
        try writeRunnableMarlinProject(root: root, id: "next-marlin")

        let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.marlinDefaultNextCommand, expectedBoundedMarlinNextCommand())
        XCTAssertEqual(status.actionQueue.first { $0.id == "marlin-default" }?.command, expectedBoundedMarlinNextCommand())
    }

    func testMarlinDefaultActionRoutesExhaustedSkipExistingProjectToRelink() throws {
        let (root, project) = try temporaryStudioProject("videoos-studio-marlin-relink")
        try writeStudioFixture(
            root: root,
            project: project,
            currentState: "approved",
            reviewStatus: "approved",
            patchOperations: 0
        )
        try writeExhaustedMarlinProject(root: root, id: "blocked-marlin")

        let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project)

        let expected = "swift run videoos-studio-cli media-relink-plan blocked-marlin --from-source-map"
        XCTAssertEqual(status.marlinDefaultNextCommand, expected)
        XCTAssertEqual(status.actionQueue.first { $0.id == "marlin-default" }?.command, expected)
    }

    func testStatusRoutesExistingMarlinArtifactsToMaterialization() throws {
        let (root, project) = try temporaryStudioProject("videoos-studio-marlin-materialize")
        try writeStudioFixture(
            root: root,
            project: project,
            currentState: "approved",
            reviewStatus: "approved",
            patchOperations: 0
        )
        try writeStudioSegmentsWithoutMarlinPeaks(project: project)

        let status = ProjectStudioReadinessStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.marlinLabel, "needs segment materialization")
        XCTAssertEqual(status.capability("marlin-temporal-vlm")?.nextCommand, "swift run videoos-studio-cli marlin-materialize demo")
        XCTAssertEqual(status.marlinDefaultNextCommand, "swift run videoos-studio-cli marlin-materialize demo")
        XCTAssertTrue(status.actionQueue.contains { $0.id == "marlin-temporal-vlm" && $0.command == "swift run videoos-studio-cli marlin-materialize demo" })
    }

    private func temporaryStudioProject(_ prefix: String) throws -> (URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        return (root, project)
    }
}

private extension ProjectStudioReadinessStatus {
    func capability(_ id: String) -> ProjectStudioReadinessCapability? {
        capabilities.first { $0.id == id }
    }
}

private func expectedBoundedMarlinNextCommand() -> String {
    "swift run videoos-studio-cli marlin-eval-next --execute --request-timeout-ms=900000 --max-sources=2 --skip-existing --caption-only --chunk-seconds=30 --chunk-overlap-seconds=3 --max-chunks=2"
}

private func writeStudioFixture(
    root: URL,
    project: URL,
    currentState: String,
    reviewStatus: String,
    patchOperations: Int
) throws {
    try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
    try "worker".write(to: root.appendingPathComponent("scripts/editor-job-worker.ts"), atomically: true, encoding: .utf8)
    try "marlin".write(to: root.appendingPathComponent("scripts/marlin-evaluate.ts"), atomically: true, encoding: .utf8)

    try writeStudioAnalysisFixture(project: project)
    _ = try ProjectSQLiteIndex.rebuild(projectURL: project)

    try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
    try "primary_message: Keep the quiet reset.\n".write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
    try "items: []\n".write(to: project.appendingPathComponent("01_intent/unresolved_blockers.yaml"), atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
    try "items: []\n".write(to: project.appendingPathComponent("04_plan/selects_candidates.yaml"), atomically: true, encoding: .utf8)
    try "beats: []\n".write(to: project.appendingPathComponent("04_plan/edit_blueprint.yaml"), atomically: true, encoding: .utf8)

    try FileManager.default.createDirectory(at: project.appendingPathComponent("05_timeline"), withIntermediateDirectories: true)
    try "{}".write(to: project.appendingPathComponent("05_timeline/timeline.json"), atomically: true, encoding: .utf8)

    try FileManager.default.createDirectory(at: project.appendingPathComponent("06_review"), withIntermediateDirectories: true)
    try """
    summary_judgment:
      status: \(reviewStatus)
    """.write(to: project.appendingPathComponent("06_review/review_report.yaml"), atomically: true, encoding: .utf8)
    let operations = (0..<patchOperations)
        .map { "{ \"op\": \"add_marker\", \"reason\": \"review\", \"label\": \"marker\($0)\" }" }
        .joined(separator: ",")
    try """
    {
      "timeline_version": "1",
      "operations": [\(operations)]
    }
    """.write(to: project.appendingPathComponent("06_review/review_patch.json"), atomically: true, encoding: .utf8)

    try """
    current_state: \(currentState)
    gates:
      analysis_gate: ready
      planning_gate: open
      compile_gate: open
      timeline_gate: open
      review_gate: open
      packaging_gate: blocked
    last_updated: 2026-05-22T00:00:00Z
    """.write(to: project.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)
}

private func writeRunnableMarlinProject(root: URL, id: String) throws {
    let project = root.appendingPathComponent("projects/\(id)")
    let analysisDir = project.appendingPathComponent("03_analysis")
    let sourceDir = project.appendingPathComponent("02_media/source")
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    try Data().write(to: sourceDir.appendingPathComponent("candidate.mov"))

    try """
    {
      "project_id": "\(id)",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "asset_id": "AST_RUNNABLE",
          "filename": "candidate.mov",
          "role_guess": "interview",
          "duration_us": 1000000,
          "has_transcript": false,
          "source_locator": "02_media/source/candidate.mov"
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "\(id)",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "segment_id": "SEG_RUNNABLE",
          "asset_id": "AST_RUNNABLE",
          "src_in_us": 0,
          "src_out_us": 1000000,
          "summary": "candidate",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
}

private func writeExhaustedMarlinProject(root: URL, id: String) throws {
    let project = root.appendingPathComponent("projects/\(id)")
    let analysisDir = project.appendingPathComponent("03_analysis")
    let mediaDir = project.appendingPathComponent("02_media")
    let sourceDir = mediaDir.appendingPathComponent("source")
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    try Data().write(to: sourceDir.appendingPathComponent("ready.mov"))

    try """
    {
      "project_id": "\(id)",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "asset_id": "AST_READY",
          "filename": "ready.mov",
          "role_guess": "interview",
          "duration_us": 1000000,
          "has_transcript": false,
          "source_locator": "02_media/source/ready.mov"
        },
        {
          "asset_id": "AST_MISSING",
          "filename": "missing.mov",
          "role_guess": "b-roll",
          "duration_us": 1000000,
          "has_transcript": false,
          "source_locator": "/Volumes/Offline/missing.mov"
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "\(id)",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "segment_id": "SEG_READY",
          "asset_id": "AST_READY",
          "src_in_us": 0,
          "src_out_us": 1000000,
          "summary": "ready source already evaluated",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": [],
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
        },
        {
          "segment_id": "SEG_MISSING",
          "asset_id": "AST_MISSING",
          "src_in_us": 0,
          "src_out_us": 1000000,
          "summary": "missing source",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "\(id)",
      "artifact_version": "marlin-events-v1",
      "model": {
        "provider": "marlin",
        "model_alias": "NemoStation/Marlin-2B",
        "model_snapshot": "test",
        "connector_version": "marlin-local-v1"
      },
      "items": [
        {
          "asset_id": "AST_READY",
          "source_path": "02_media/source/ready.mov",
          "scene": "ready",
          "caption": "ready source",
          "events": [
            {
              "event_id": "MEV_READY",
              "start_us": 0,
              "end_us": 1000000,
              "description": "ready source",
              "confidence": 0.9,
              "source_pass": "caption"
            }
          ],
          "find_results": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("marlin_events.json"), atomically: true, encoding: .utf8)

    try """
    {
      "version": "1",
      "project_id": "\(id)",
      "media_dir": "02_media",
      "items": [
        {
          "asset_id": "AST_READY",
          "source_locator": "02_media/source/ready.mov",
          "local_source_path": "02_media/source/ready.mov",
          "link_path": "02_media/relinked/AST_READY-ready.mov"
        },
        {
          "asset_id": "AST_MISSING",
          "source_locator": "/Volumes/Offline/missing.mov",
          "local_source_path": "/Volumes/Offline/missing.mov",
          "link_path": "02_media/relinked/AST_MISSING-missing.mov"
        }
      ]
    }
    """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)
}

private func writeStudioAnalysisFixture(project: URL) throws {
    let analysisDir = project.appendingPathComponent("03_analysis")
    let transcriptDir = analysisDir.appendingPathComponent("transcripts")
    let sourceDir = project.appendingPathComponent("02_media/source")
    try FileManager.default.createDirectory(at: transcriptDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    try Data().write(to: sourceDir.appendingPathComponent("interview.mov"))

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "asset_id": "AST_001",
          "filename": "interview.mov",
          "role_guess": "interview",
          "duration_us": 12000000,
          "has_transcript": true,
          "transcript_ref": "TR_AST_001",
          "segment_ids": ["SEG_001", "SEG_002", "SEG_003"],
          "quality_flags": [],
          "tags": ["interview", "quiet"]
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
          "src_out_us": 3000000,
          "summary": "opening quiet reset",
          "transcript_excerpt": "I came here to get quiet again.",
          "quality_flags": [],
          "tags": ["interview"],
          "interest_points": [],
          "peak_analysis": {
            "selected_peak_us": 1500000,
            "confidence": 0.82,
            "provenance": {
              "precision_mode": "marlin_temporal_semantics",
              "fusion_version": "marlin-segment-peak-v1"
            }
          }
        },
        {
          "segment_id": "SEG_002",
          "asset_id": "AST_001",
          "src_in_us": 3000000,
          "src_out_us": 6000000,
          "summary": "middle",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        },
        {
          "segment_id": "SEG_003",
          "asset_id": "AST_001",
          "src_in_us": 6000000,
          "src_out_us": 9000000,
          "summary": "ending",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "transcript_ref": "TR_AST_001",
      "asset_id": "AST_001",
      "items": [
        {
          "speaker": "S1",
          "start_us": 1200000,
          "end_us": 4400000,
          "text": "I came here to get quiet again."
        }
      ]
    }
    """.write(to: transcriptDir.appendingPathComponent("TR_AST_001.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "event_id": "AE_001",
          "asset_id": "AST_001",
          "type": "dialogue_emphasis",
          "start_us": 1000000,
          "end_us": 2000000,
          "label": "soft emphasis",
          "confidence": { "score": 0.8, "source": "fixture", "status": "ok" }
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("audio_events.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "1",
      "model": {
        "provider": "marlin",
        "model_alias": "NemoStation/Marlin-2B",
        "model_snapshot": "test-snapshot",
        "connector_version": "marlin-local-v1"
      },
      "items": [
        {
          "asset_id": "AST_001",
          "source_path": "02_media/source/interview.mov",
          "scene": "interview",
          "caption": "subject pauses before a quiet reset",
          "events": [
            {
              "event_id": "MEV_001",
              "start_us": 1000000,
              "end_us": 2000000,
              "description": "quiet emotional peak",
              "confidence": 0.86,
              "source_pass": "marlin_caption"
            }
          ],
          "find_results": [
            {
              "query": "strongest quiet reset",
              "span_start_us": 1000000,
              "span_end_us": 2000000,
              "format_ok": true,
              "confidence": 0.8
            }
          ]
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("marlin_events.json"), atomically: true, encoding: .utf8)
}

private func writeStudioSegmentsWithoutMarlinPeaks(project: URL) throws {
    let analysisDir = project.appendingPathComponent("03_analysis")
    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "segment_id": "SEG_001",
          "asset_id": "AST_001",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "opening quiet reset",
          "transcript_excerpt": "I came here to get quiet again.",
          "quality_flags": [],
          "tags": ["interview"],
          "interest_points": []
        },
        {
          "segment_id": "SEG_002",
          "asset_id": "AST_001",
          "src_in_us": 3000000,
          "src_out_us": 6000000,
          "summary": "middle",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        },
        {
          "segment_id": "SEG_003",
          "asset_id": "AST_001",
          "src_in_us": 6000000,
          "src_out_us": 9000000,
          "summary": "ending",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
}
