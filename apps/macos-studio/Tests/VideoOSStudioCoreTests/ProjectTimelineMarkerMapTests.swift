import XCTest
@testable import VideoOSStudioCore

final class ProjectTimelineMarkerMapTests: XCTestCase {
    func testBuildNormalizesSortsAndTimecodesTimelineMarkers() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-marker-map-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try markerMapFixtureTimeline.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        let timeline = try TimelineDocument.load(projectURL: root)
        let map = ProjectTimelineMarkerMap.build(timeline: timeline)

        XCTAssertEqual(map.markers.map(\.frame), [0, 45, 120])
        XCTAssertEqual(map.markers.map(\.timecode), ["00:00:00:00", "00:00:01:15", "00:00:04:00"])
        XCTAssertEqual(map.markers.map(\.kind), [.beat, .note, .marker])
        XCTAssertEqual(map.markers.map(\.label), ["b01: hook", "keep silence", "legacy"])
    }
}

private let markerMapFixtureTimeline = """
{
  "version": "1",
  "project_id": "demo",
  "sequence": {
    "name": "Marker Map",
    "fps_num": 30,
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
            "src_in_us": 0,
            "src_out_us": 3000000,
            "timeline_in_frame": 0,
            "timeline_duration_frames": 90,
            "role": "hero",
            "motivation": "fixture"
          }
        ]
      }
    ],
    "audio": []
  },
  "markers": [
    { "frame": 45, "kind": "note", "label": "keep silence" },
    { "frame": 0, "kind": "beat", "label": "b01: hook" },
    { "marker_id": "MKR_legacy", "frame": 120, "label": "legacy" }
  ]
}
"""
