import XCTest
@testable import VideoOSStudioCore

final class ProjectAudioTimelineMapTests: XCTestCase {
    func testBuildMapsAudioEventsStoryNodesAndBGMBeatsToTimelineFrames() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-audio-map-\(UUID().uuidString)")
        try writeAudioMapFixtureProject(at: root)

        let timeline = try TimelineDocument.load(projectURL: root)
        let evidence = ProjectEvidenceStore.load(projectURL: root)
        let map = ProjectAudioTimelineMap.build(timeline: timeline, evidence: evidence)

        XCTAssertEqual(map.cues.map(\.kind), [.audioEvent, .audioStory, .bgmDownbeat, .bgmBeat, .bgmSection])
        XCTAssertEqual(map.cues.map(\.frame), [30, 30, 30, 60, 60])
        XCTAssertEqual(map.cues.first?.label, "soft laugh")
        XCTAssertEqual(map.cues.first?.endFrame, 45)
        XCTAssertEqual(map.cues.first(where: { $0.kind == .bgmDownbeat })?.label, "downbeat 1")
        XCTAssertEqual(map.cues.first(where: { $0.kind == .bgmSection })?.endFrame, 90)
    }
}

private func writeAudioMapFixtureProject(at root: URL) throws {
    let timelineDir = root.appendingPathComponent("05_timeline")
    let analysisDir = root.appendingPathComponent("03_analysis")
    try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)

    try """
    {
      "version": "1",
      "project_id": "demo",
      "sequence": {
        "name": "Audio Map",
        "fps_num": 30,
        "fps_den": 1,
        "width": 1920,
        "height": 1080,
        "start_frame": 0
      },
      "tracks": {
        "video": [],
        "audio": [
          {
            "track_id": "A1",
            "kind": "audio",
            "clips": [
              {
                "clip_id": "ACL_001",
                "segment_id": "SEG_001",
                "asset_id": "AST_001",
                "src_in_us": 0,
                "src_out_us": 3000000,
                "timeline_in_frame": 0,
                "timeline_duration_frames": 90,
                "role": "bgm",
                "motivation": "fixture"
              }
            ]
          }
        ]
      },
      "markers": []
    }
    """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "event_id": "AE_001",
          "asset_id": "AST_001",
          "type": "laughter",
          "start_us": 1000000,
          "end_us": 1500000,
          "label": "soft laugh",
          "confidence": {
            "score": 0.8,
            "source": "fixture",
            "status": "ready"
          }
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("audio_events.json"), atomically: true, encoding: .utf8)

    try """
    {
      "version": "1.0.0",
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "nodes": [
        {
          "node_id": "ASN_001",
          "node_type": "reaction",
          "asset_id": "AST_001",
          "start_us": 1000000,
          "end_us": 1300000,
          "text": "laugh lands after line",
          "story_role": "reaction",
          "refs": {},
          "confidence": {
            "score": 0.7,
            "source": "fixture",
            "status": "ready"
          }
        }
      ],
      "edges": []
    }
    """.write(to: analysisDir.appendingPathComponent("audio_story_graph.json"), atomically: true, encoding: .utf8)

    try """
    {
      "version": "1",
      "project_id": "demo",
      "analysis_status": "ready",
      "music_asset": {
        "asset_id": "AST_001",
        "path": "02_media/source/music.wav"
      },
      "bpm": 120,
      "meter": "4/4",
      "duration_sec": 3,
      "beats_sec": [1.0, 2.0],
      "downbeats_sec": [1.0],
      "sections": [
        {
          "id": "BGM_A",
          "label": "intro",
          "start_sec": 2.0,
          "end_sec": 3.0,
          "energy": 0.6
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("bgm_analysis.json"), atomically: true, encoding: .utf8)
}
