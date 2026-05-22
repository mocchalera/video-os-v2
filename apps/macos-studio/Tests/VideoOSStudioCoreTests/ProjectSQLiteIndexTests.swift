import XCTest
@testable import VideoOSStudioCore

final class ProjectSQLiteIndexTests: XCTestCase {
    func testRebuildCreatesSearchableSQLiteIndex() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-sqlite-index-\(UUID().uuidString)")
        try writeSQLiteFixtureProject(at: root)

        let summary = try ProjectSQLiteIndex.rebuild(projectURL: root)
        let status = ProjectSQLiteIndex.status(projectURL: root)
        let quietResults = try ProjectSQLiteIndex.search(projectURL: root, query: "quiet")
        let marlinResults = try ProjectSQLiteIndex.search(projectURL: root, query: "visible breath")
        let audioResults = try ProjectSQLiteIndex.search(projectURL: root, query: "soft laugh")
        let bgmResults = try ProjectSQLiteIndex.search(projectURL: root, query: "downbeat")
        let continuityResults = try ProjectSQLiteIndex.search(projectURL: root, query: "mountain ridge")
        let preferenceResults = try ProjectSQLiteIndex.search(projectURL: root, query: "hold silence")

        XCTAssertTrue(FileManager.default.fileExists(atPath: summary.indexURL.path))
        XCTAssertEqual(summary.assetCount, 1)
        XCTAssertEqual(summary.segmentCount, 1)
        XCTAssertEqual(summary.transcriptItemCount, 1)
        XCTAssertEqual(summary.marlinEventCount, 1)
        XCTAssertEqual(summary.marlinFindResultCount, 1)
        XCTAssertEqual(summary.audioEventCount, 1)
        XCTAssertEqual(summary.audioStoryNodeCount, 1)
        XCTAssertEqual(summary.bgmSectionCount, 1)
        XCTAssertEqual(summary.bgmBeatCount, 3)
        XCTAssertEqual(summary.continuityEntityCount, 1)
        XCTAssertEqual(summary.continuitySegmentRefCount, 1)
        XCTAssertEqual(summary.editorialPreferenceCount, 1)
        XCTAssertEqual(summary.searchDocumentCount, 14)
        XCTAssertTrue(status.exists)
        XCTAssertEqual(status.documentCount, 14)
        XCTAssertNotNil(status.updatedAt)
        XCTAssertTrue(quietResults.contains { $0.kind == "segment" && $0.segmentID == "SEG_001" })
        XCTAssertTrue(quietResults.contains { $0.kind == "transcript" && $0.assetID == "AST_001" })
        XCTAssertEqual(marlinResults.first?.kind, "marlin_find")
        XCTAssertTrue(audioResults.contains { $0.kind == "audio_event" && $0.assetID == "AST_001" })
        XCTAssertTrue(audioResults.contains { $0.kind == "audio_story_node" && $0.assetID == "AST_001" })
        XCTAssertEqual(bgmResults.first?.kind, "bgm_beat")
        XCTAssertTrue(continuityResults.contains { $0.kind == "continuity_entity" })
        XCTAssertTrue(continuityResults.contains { $0.kind == "continuity_segment" && $0.segmentID == "SEG_001" })
        XCTAssertEqual(preferenceResults.first?.kind, "editorial_preference")
    }

    func testSearchReturnsEmptyForBlankQuery() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-sqlite-index-blank-\(UUID().uuidString)")
        try writeSQLiteFixtureProject(at: root)
        _ = try ProjectSQLiteIndex.rebuild(projectURL: root)

        XCTAssertEqual(try ProjectSQLiteIndex.search(projectURL: root, query: "   "), [])
    }
}

private func writeSQLiteFixtureProject(at root: URL) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
    let transcriptDir = analysisDir.appendingPathComponent("transcripts")
    try FileManager.default.createDirectory(at: transcriptDir, withIntermediateDirectories: true)

    try sqliteFixtureAssets.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureSegments.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureTranscript.write(to: transcriptDir.appendingPathComponent("TR_AST_001.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureMarlin.write(to: analysisDir.appendingPathComponent("marlin_events.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureAudioEvents.write(to: analysisDir.appendingPathComponent("audio_events.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureAudioStoryGraph.write(to: analysisDir.appendingPathComponent("audio_story_graph.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureBGMAnalysis.write(to: analysisDir.appendingPathComponent("bgm_analysis.json"), atomically: true, encoding: .utf8)
    try sqliteFixtureContinuityGraph.write(to: analysisDir.appendingPathComponent("continuity_graph.json"), atomically: true, encoding: .utf8)
    try sqliteFixturePreferenceMemory.write(to: analysisDir.appendingPathComponent("editorial_preference_memory.jsonl"), atomically: true, encoding: .utf8)
}

private let sqliteFixtureAssets = """
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
      "segments": 1,
      "segment_ids": ["SEG_001"],
      "quality_flags": [],
      "tags": ["interview", "quiet"]
    }
  ]
}
"""

private let sqliteFixtureSegments = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "items": [
    {
      "segment_id": "SEG_001",
      "asset_id": "AST_001",
      "src_in_us": 1000000,
      "src_out_us": 5000000,
      "summary": "subject explains quiet reset",
      "transcript_excerpt": "I came here to get quiet again.",
      "quality_flags": [],
      "tags": ["interview", "quiet"]
    }
  ]
}
"""

private let sqliteFixtureTranscript = """
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
"""

private let sqliteFixtureAudioEvents = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "items": [
    {
      "event_id": "AE_AST_001_laugh",
      "asset_id": "AST_001",
      "type": "laughter",
      "start_us": 2300000,
      "end_us": 3000000,
      "label": "soft laugh",
      "confidence": {
        "score": 0.77,
        "source": "audio-events",
        "status": "ready"
      }
    }
  ]
}
"""

private let sqliteFixtureAudioStoryGraph = """
{
  "version": "1.0.0",
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "created_at": "2026-05-22T00:00:00Z",
  "source_media_manifest_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "inputs": {
    "transcript_hashes": [],
    "audio_events_hash": null,
    "bgm_analysis_hash": null,
    "coverage_report_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "nodes": [
    {
      "node_id": "ASG_reaction_001",
      "node_type": "laughter",
      "asset_id": "AST_001",
      "start_us": 2300000,
      "end_us": 3000000,
      "text": "soft laugh after the quiet line",
      "story_role": "reaction",
      "refs": {
        "transcript_ref": "TR_AST_001",
        "speaker_ref": "SPK_001",
        "audio_event_ref": "AE_AST_001_laugh",
        "bgm_ref": "BGM_verse"
      },
      "confidence": {
        "score": 0.8,
        "source": "audio-story",
        "status": "ready"
      }
    }
  ],
  "edges": [],
  "coverage": {
    "status": "ready",
    "dialogue_lane": "ready",
    "audio_event_lane": "ready",
    "music_lane": "ready",
    "missing_inputs": []
  },
  "provenance": {
    "producer": "analysis-pipeline",
    "inputs": [],
    "hash_policy": {}
  }
}
"""

private let sqliteFixtureBGMAnalysis = """
{
  "version": "1",
  "project_id": "demo",
  "analysis_status": "ready",
  "music_asset": {
    "asset_id": "AST_BGM_001",
    "path": "02_media/source/music.wav"
  },
  "bpm": 92,
  "meter": "4/4",
  "duration_sec": 12,
  "beats_sec": [1.0, 2.0, 3.0],
  "downbeats_sec": [1.0],
  "sections": [
    {
      "id": "BGM_verse",
      "label": "verse",
      "start_sec": 1.0,
      "end_sec": 5.0,
      "energy": 0.62
    }
  ],
  "provenance": {
    "detector": "fixture",
    "sample_rate_hz": 48000
  }
}
"""

private let sqliteFixtureMarlin = """
{
  "project_id": "demo",
  "artifact_version": "marlin-events-v1",
  "model": {
    "provider": "marlin",
    "model_alias": "NemoStation/Marlin-2B",
    "model_snapshot": "local"
  },
  "items": [
    {
      "asset_id": "AST_001",
      "source_path": "02_media/source/interview.mov",
      "scene": "cabin interview",
      "caption": "person with visible breath near a window",
      "events": [
        {
          "event_id": "MEV_AST_001_0001",
          "start_us": 1800000,
          "end_us": 2600000,
          "description": "subject smiles before speaking",
          "confidence": 0.81,
          "source_pass": "marlin_caption"
        }
      ],
      "find_results": [
        {
          "query": "visible breath",
          "span_start_us": 2000000,
          "span_end_us": 2300000,
          "format_ok": true,
          "confidence": 0.72
        }
      ]
    }
  ]
}
"""

private let sqliteFixtureContinuityGraph = """
{
  "version": "1.0.0",
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "created_at": "2026-05-22T00:00:00Z",
  "source_media_manifest_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "entities": [
    {
      "entity_id": "ENT_LOCATION_mountain_ridge",
      "entity_type": "location",
      "status": "confirmed_editing_continuity",
      "label": "mountain ridge",
      "evidence_segment_ids": ["SEG_001"],
      "confidence": {
        "score": 0.82,
        "source": "continuity",
        "status": "ready"
      }
    }
  ],
  "segments": [
    {
      "segment_id": "SEG_001",
      "asset_id": "AST_001",
      "src_in_us": 1000000,
      "src_out_us": 5000000,
      "capture_basis": "manifest_timecode",
      "entity_ids": ["ENT_LOCATION_mountain_ridge"]
    }
  ],
  "edges": [],
  "risks": [],
  "provenance": {
    "producer": "analysis-pipeline",
    "inputs": [],
    "hash_policy": {}
  }
}
"""

private let sqliteFixturePreferenceMemory = """
{"version":"1.0.0","project_id":"demo","entry_id":"EPM_hold_silence","created_at":"2026-05-22T00:00:00Z","actor":{"type":"human","id":"operator"},"source_event":{"event_type":"operator_command","event_ref":"brief-note"},"preference_type":"pacing","value":{"kind":"string","data":"hold silence after emotional lines"},"scope":"project","confidence":{"score":0.9,"source":"operator","status":"ready"},"status":"active","provenance":{"producer":"operator-command","inputs":[],"hash_policy":{}}}
"""
