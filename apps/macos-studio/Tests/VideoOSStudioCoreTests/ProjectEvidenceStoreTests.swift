import XCTest
@testable import VideoOSStudioCore

final class ProjectEvidenceStoreTests: XCTestCase {
    func testEvidenceLoadsAssetSegmentTranscriptAndMarlinContextForClip() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-evidence-\(UUID().uuidString)")
        try writeFixtureProject(at: root)
        let timeline = try TimelineDocument.load(projectURL: root)
        let clip = try XCTUnwrap(timeline.clipSelection(for: "CLP_001")?.clip)

        let store = ProjectEvidenceStore.load(projectURL: root)
        let evidence = store.evidence(for: clip)

        XCTAssertEqual(evidence.asset?.filename, "interview.mov")
        XCTAssertEqual(evidence.segment?.summary, "subject explains why the place matters")
        XCTAssertEqual(evidence.segment?.tags, ["interview", "quiet"])
        XCTAssertEqual(evidence.transcriptItems.map(\.text), ["I came here to get quiet again."])
        XCTAssertEqual(evidence.marlinAsset?.scene, "cabin interview")
        XCTAssertEqual(evidence.marlinEvents.map(\.description), ["subject smiles before speaking"])
        XCTAssertEqual(evidence.marlinFindResults.map(\.query), ["visible breath"])
        XCTAssertEqual(evidence.audioEvents.map(\.type), ["laughter"])
        XCTAssertEqual(evidence.audioStoryNodes.map(\.storyRole), ["reaction"])
        XCTAssertEqual(evidence.bgmSections.map(\.label), ["verse"])
        XCTAssertTrue(evidence.hasAnalysis)
    }

    func testEvidenceToleratesMissingAnalysisArtifacts() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-evidence-missing-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try fixtureTimeline.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )
        let timeline = try TimelineDocument.load(projectURL: root)
        let clip = try XCTUnwrap(timeline.clipSelection(for: "CLP_001")?.clip)

        let evidence = ProjectEvidenceStore.load(projectURL: root).evidence(for: clip)

        XCTAssertNil(evidence.asset)
        XCTAssertNil(evidence.segment)
        XCTAssertTrue(evidence.transcriptItems.isEmpty)
        XCTAssertTrue(evidence.marlinEvents.isEmpty)
        XCTAssertTrue(evidence.audioEvents.isEmpty)
        XCTAssertTrue(evidence.audioStoryNodes.isEmpty)
        XCTAssertTrue(evidence.bgmSections.isEmpty)
        XCTAssertFalse(evidence.hasAnalysis)
    }
}

private func writeFixtureProject(at root: URL) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
    let transcriptDir = analysisDir.appendingPathComponent("transcripts")
    let timelineDir = root.appendingPathComponent("05_timeline")
    try FileManager.default.createDirectory(at: transcriptDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)

    try fixtureAssets.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
    try fixtureSegments.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
    try fixtureTranscript.write(to: transcriptDir.appendingPathComponent("TR_AST_001.json"), atomically: true, encoding: .utf8)
    try fixtureMarlin.write(to: analysisDir.appendingPathComponent("marlin_events.json"), atomically: true, encoding: .utf8)
    try fixtureAudioEvents.write(to: analysisDir.appendingPathComponent("audio_events.json"), atomically: true, encoding: .utf8)
    try fixtureAudioStoryGraph.write(to: analysisDir.appendingPathComponent("audio_story_graph.json"), atomically: true, encoding: .utf8)
    try fixtureBGMAnalysis.write(to: analysisDir.appendingPathComponent("bgm_analysis.json"), atomically: true, encoding: .utf8)
    try fixtureTimeline.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
}

private let fixtureAssets = """
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
      "tags": ["interview"]
    }
  ]
}
"""

private let fixtureSegments = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "items": [
    {
      "segment_id": "SEG_001",
      "asset_id": "AST_001",
      "src_in_us": 1000000,
      "src_out_us": 5000000,
      "summary": "subject explains why the place matters",
      "transcript_excerpt": "I came here to get quiet again.",
      "transcript_ref": "TR_AST_001",
      "quality_flags": [],
      "tags": ["interview", "quiet"],
      "interest_points": [
        {
          "frame_us": 2200000,
          "label": "small smile",
          "confidence": 0.8,
          "source": "vlm"
        }
      ]
    }
  ]
}
"""

private let fixtureTranscript = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "transcript_ref": "TR_AST_001",
  "asset_id": "AST_001",
  "items": [
    {
      "speaker": "S1",
      "speaker_key": "AST_001:speaker_1",
      "start_us": 1200000,
      "end_us": 4400000,
      "text": "I came here to get quiet again."
    },
    {
      "speaker": "S1",
      "start_us": 7000000,
      "end_us": 7600000,
      "text": "Outside the selected clip."
    }
  ]
}
"""

private let fixtureMarlin = """
{
  "project_id": "demo",
  "artifact_version": "marlin-events-v1",
  "model": {
    "provider": "marlin",
    "model_alias": "NemoStation/Marlin-2B",
    "model_snapshot": "local",
    "connector_version": "marlin-local-v1"
  },
  "items": [
    {
      "asset_id": "AST_001",
      "source_path": "02_media/source/interview.mov",
      "scene": "cabin interview",
      "caption": "person near a bright window",
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
          "confidence": 0.72,
          "raw": "00:02.0-00:02.3"
        }
      ]
    }
  ]
}
"""

private let fixtureAudioEvents = """
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
    },
    {
      "event_id": "AE_AST_001_outside",
      "asset_id": "AST_001",
      "type": "silence",
      "start_us": 8000000,
      "end_us": 9000000
    }
  ]
}
"""

private let fixtureAudioStoryGraph = """
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

private let fixtureBGMAnalysis = """
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

private let fixtureTimeline = """
{
  "version": "1",
  "project_id": "demo",
  "sequence": {
    "name": "Demo",
    "fps_num": 24,
    "fps_den": 1,
    "width": 1920,
    "height": 1080,
    "start_frame": 0
  },
  "tracks": {
    "video": [
      {
        "track_id": "V1",
        "kind": "video",
        "clips": [
          {
            "clip_id": "CLP_001",
            "segment_id": "SEG_001",
            "asset_id": "AST_001",
            "src_in_us": 1000000,
            "src_out_us": 5000000,
            "timeline_in_frame": 0,
            "timeline_duration_frames": 96,
            "role": "dialogue",
            "motivation": "clear setup"
          }
        ]
      }
    ]
  },
  "markers": []
}
"""
