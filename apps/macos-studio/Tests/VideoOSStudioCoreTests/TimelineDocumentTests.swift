import XCTest
@testable import VideoOSStudioCore

final class TimelineDocumentTests: XCTestCase {
    func testLoadTimelineDocumentComputesDisplayTracksAndDuration() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try fixtureTimeline.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )

        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertEqual(document.projectID, "demo")
        XCTAssertEqual(document.sequence.name, "Demo Rough Cut")
        XCTAssertEqual(document.sequence.fps, 30)
        XCTAssertEqual(document.displayTracks.map(\.id), ["V1", "A1"])
        XCTAssertEqual(document.totalFrames, 150)
        XCTAssertEqual(document.totalSeconds, 5)
        XCTAssertEqual(document.displayTracks.first?.clips.first?.role, "hero")
        XCTAssertEqual(document.sequence.framesToTimecode(90), "00:00:03:00")

        let selection = try XCTUnwrap(document.clipSelection(for: "CLP_001"))
        XCTAssertEqual(selection.trackID, "V1")
        XCTAssertEqual(selection.trackKind, .video)
        XCTAssertEqual(selection.clip.timelineOutFrame, 90)
        XCTAssertEqual(selection.clip.sourceDurationSeconds, 3)
        XCTAssertTrue(selection.clip.containsTimelineFrame(30))
        XCTAssertFalse(selection.clip.containsTimelineFrame(90))
        XCTAssertEqual(selection.clip.sourceTimeUS(atTimelineFrame: 45), 1_500_000)
        XCTAssertEqual(selection.clip.candidateRef, "legacy:SEG_001:0:3000000")
        XCTAssertEqual(selection.clip.qualityFlags, ["minor_highlight_clip"])
        XCTAssertNil(document.clipSelection(for: "missing"))

        XCTAssertEqual(document.programSelection(atFrame: 10)?.clip.id, "CLP_001")
        XCTAssertEqual(document.programSelection(atFrame: 100)?.clip.id, "ACL_001")
        XCTAssertEqual(document.visualProgramSelection(atFrame: 10)?.clip.id, "CLP_001")
        XCTAssertNil(document.visualProgramSelection(atFrame: 100))
        XCTAssertEqual(document.audioProgramSelection(atFrame: 10)?.clip.id, "ACL_001")
        XCTAssertEqual(document.audioProgramSelection(atFrame: 100)?.clip.id, "ACL_001")
        XCTAssertEqual(document.programSelection(afterFrame: 10)?.clip.id, "ACL_001")
        XCTAssertNil(document.programSelection(afterFrame: 100))

        let snapshot = document.monitorSnapshot(atFrame: 45)
        XCTAssertEqual(snapshot.frame, 45)
        XCTAssertEqual(snapshot.timecode, "00:00:01:15")
        XCTAssertEqual(snapshot.visual?.clipID, "CLP_001")
        XCTAssertEqual(snapshot.visual?.sourceTimeUS, 1_500_000)
        XCTAssertEqual(snapshot.audio?.clipID, "ACL_001")
        XCTAssertEqual(snapshot.audio?.sourceTimeUS, 1_500_000)
        XCTAssertEqual(snapshot.program?.clipID, "CLP_001")
        XCTAssertEqual(snapshot.nextProgram?.clipID, "ACL_001")
        XCTAssertEqual(document.markers.first?.id, "MKR_001")
        XCTAssertEqual(document.markers.first?.kind, nil)
    }

    func testLoadTimelineDocumentBuildsDisplayCaptionTrackFromClipCaptions() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-captions-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        let captionTimeline = fixtureTimeline.replacingOccurrences(
            of: """
                        \"candidate_ref\": \"legacy:SEG_001:0:3000000\"
            """,
            with: """
                        \"candidate_ref\": \"legacy:SEG_001:0:3000000\",
                        \"captions\": [
                          {
                            \"text\": \"導入の字幕\",
                            \"in_frame\": 10,
                            \"out_frame\": 40,
                            \"style\": \"simple-shadow\"
                          },
                          {
                            \"text\": \"続きの字幕\",
                            \"in_frame\": 42,
                            \"out_frame\": 76,
                            \"style\": \"simple-shadow\"
                          }
                        ]
            """
        )
        try captionTimeline.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )

        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertTrue(document.tracks.caption.isEmpty)
        XCTAssertEqual(document.tracks.video.first?.clips.first?.captions.count, 2)
        XCTAssertEqual(document.displayTracks.map(\.id), ["V1", "C1", "A1"])

        let captionTrack = try XCTUnwrap(document.displayTracks.first { $0.kind == .caption })
        XCTAssertEqual(captionTrack.clips.map(\.id), ["CLP_001__caption_1", "CLP_001__caption_2"])
        XCTAssertEqual(captionTrack.clips.first?.role, "caption")
        XCTAssertEqual(captionTrack.clips.first?.segmentID, "導入の字幕")
        XCTAssertEqual(captionTrack.clips.first?.captionText, "導入の字幕")
        XCTAssertEqual(captionTrack.clips.first?.timelineInFrame, 10)
        XCTAssertEqual(captionTrack.clips.first?.timelineDurationFrames, 30)
    }

    func testTimelineMarkerAllowsKindOnlyGeneratedMarkers() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-marker-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try fixtureTimeline.replacingOccurrences(
            of: "{ \"marker_id\": \"MKR_001\", \"frame\": 90, \"label\": \"beat\" }",
            with: "{ \"frame\": 90, \"kind\": \"beat\", \"label\": \"b02: settle\" }"
        )
        .write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )

        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertEqual(document.markers.first?.id, "beat-90-b02: settle")
        XCTAssertEqual(document.markers.first?.kind, "beat")
    }

    func testLoadTimelineDefaultsMissingMarkersForOlderProjects() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-no-markers-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        let timelineWithoutMarkers = fixtureTimeline.replacingOccurrences(
            of: """
            ,
              "markers": [
                { "marker_id": "MKR_001", "frame": 90, "label": "beat" }
              ]
            """,
            with: ""
        )
        try timelineWithoutMarkers.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )

        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertEqual(document.displayTracks.map(\.id), ["V1", "A1"])
        XCTAssertEqual(document.markers, [])
    }

    func testClipIDsInTrackIntersectingFrameRangeReturnsTimelineOrderedClips() throws {
        let sequence = TimelineSequence(
            name: "Selection Test",
            fpsNum: 30,
            fpsDen: 1,
            width: 1920,
            height: 1080,
            startFrame: 0,
            outputAspectRatio: "16:9"
        )
        let document = TimelineDocument(
            version: "1",
            projectID: "demo",
            sequence: sequence,
            tracks: TimelineTrackCollection(
                video: [
                    TimelineTrack(
                        id: "V1",
                        kind: .video,
                        clips: [
                            makeClip(id: "CLP_A", start: 0, duration: 60),
                            makeClip(id: "CLP_B", start: 72, duration: 48),
                            makeClip(id: "CLP_C", start: 150, duration: 30)
                        ]
                    )
                ],
                audio: [],
                overlay: [],
                caption: []
            ),
            markers: []
        )

        XCTAssertEqual(document.clipIDs(inTrack: "V1", intersectingFrameRange: 0...20), ["CLP_A"])
        XCTAssertEqual(document.clipIDs(inTrack: "V1", intersectingFrameRange: 55...76), ["CLP_A", "CLP_B"])
        XCTAssertEqual(document.clipIDs(inTrack: "V1", intersectingFrameRange: 120...150), ["CLP_C"])
        XCTAssertEqual(document.clipIDs(inTrack: "V1", intersectingFrameRange: 121...149), [])
        XCTAssertEqual(document.clipIDs(inTrack: "missing", intersectingFrameRange: 0...180), [])
    }

    func testLoadTimelineInfersMissingTrackKindForOlderProjects() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-no-track-kind-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        let timelineWithoutTrackKinds = fixtureTimeline
            .replacingOccurrences(of: "        \"kind\": \"video\",\n", with: "")
            .replacingOccurrences(of: "        \"kind\": \"audio\",\n", with: "")
        try timelineWithoutTrackKinds.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )

        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertEqual(document.tracks.video.first?.kind, .video)
        XCTAssertEqual(document.tracks.audio.first?.kind, .audio)
        XCTAssertEqual(document.displayTracks.map(\.id), ["V1", "A1"])
    }

    func testAudioProgramSelectionPrefersDialogueOverNatSoundAtSameFrame() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-audio-priority-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        let overlappingAudioTimeline = fixtureTimeline.replacingOccurrences(
            of: "\"motivation\": \"original clip audio\"\n          }",
            with: """
            \"motivation\": \"original clip audio\"
                      },
                              {
                                \"clip_id\": \"ACL_DIALOGUE\",
                                \"segment_id\": \"SEG_002\",
                                \"asset_id\": \"AST_002\",
                                \"src_in_us\": 1000000,
                                \"src_out_us\": 6000000,
                                \"timeline_in_frame\": 0,
                                \"timeline_duration_frames\": 150,
                                \"role\": \"dialogue\",
                                \"motivation\": \"primary speech\"
                              }
            """
        )
        try overlappingAudioTimeline.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )

        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertEqual(document.audioProgramSelection(atFrame: 10)?.clip.id, "ACL_DIALOGUE")
    }

    func testPlaybackSyncStateOnlyAdvancesForForceSeekOrProgramClipBoundary() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-sync-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try fixtureTimeline.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )
        let document = try TimelineDocument.load(projectURL: root)

        var sync = TimelinePlaybackSyncState()

        XCTAssertEqual(sync.update(timeline: document, frame: 0, forceSeek: true), 1)
        XCTAssertEqual(sync.lastProgramClipID, "CLP_001")
        XCTAssertEqual(sync.update(timeline: document, frame: 30, forceSeek: false), 1)
        XCTAssertEqual(sync.update(timeline: document, frame: 100, forceSeek: false), 2)
        XCTAssertEqual(sync.lastProgramClipID, "ACL_001")
        XCTAssertEqual(sync.update(timeline: document, frame: 110, forceSeek: true), 3)

        var audioSync = TimelinePlaybackSyncState()
        XCTAssertEqual(audioSync.update(currentClipID: "ACL_001", forceSeek: true), 1)
        XCTAssertEqual(audioSync.update(currentClipID: "ACL_001", forceSeek: false), 1)
        XCTAssertEqual(audioSync.update(currentClipID: nil, forceSeek: false), 2)
    }

    func testQATimestampJumpTargetNormalizesFrameAndProgramClip() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-qa-jump-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try fixtureTimeline.write(
            to: timelineDir.appendingPathComponent("timeline.json"),
            atomically: true,
            encoding: .utf8
        )
        let document = try TimelineDocument.load(projectURL: root)

        XCTAssertEqual(document.qaTimestampJumpTarget(for: 1.5), QATimestampJumpTarget(frame: 45, clipID: "CLP_001"))
        XCTAssertEqual(document.qaTimestampJumpTarget(for: 3.25), QATimestampJumpTarget(frame: 98, clipID: "ACL_001"))
        XCTAssertEqual(document.qaTimestampJumpTarget(for: -2), QATimestampJumpTarget(frame: 0, clipID: "CLP_001"))
        XCTAssertEqual(document.qaTimestampJumpTarget(for: .nan), QATimestampJumpTarget(frame: 0, clipID: "CLP_001"))
        XCTAssertEqual(document.qaTimestampJumpTarget(for: 99), QATimestampJumpTarget(frame: 150, clipID: nil))
    }
}

private func makeClip(id: TimelineClip.ID, start: Int, duration: Int) -> TimelineClip {
    TimelineClip(
        id: id,
        segmentID: "SEG_\(id)",
        assetID: "AST_\(id)",
        sourceInUS: 0,
        sourceOutUS: duration * 33_333,
        timelineInFrame: start,
        timelineDurationFrames: duration,
        role: "support",
        motivation: "selection test",
        confidence: nil,
        beatID: nil,
        fallbackSegmentIDs: [],
        qualityFlags: [],
        candidateRef: nil
    )
}

private let fixtureTimeline = """
{
  "version": "1",
  "project_id": "demo",
  "sequence": {
    "name": "Demo Rough Cut",
    "fps_num": 30,
    "fps_den": 1,
    "width": 1920,
    "height": 1080,
    "start_frame": 0,
    "output_aspect_ratio": "16:9"
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
            "motivation": "opening moment",
            "confidence": 0.92,
            "beat_id": "b01",
            "quality_flags": [
              "minor_highlight_clip"
            ],
            "candidate_ref": "legacy:SEG_001:0:3000000"
          }
        ]
      }
    ],
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
            "src_out_us": 5000000,
            "timeline_in_frame": 0,
            "timeline_duration_frames": 150,
            "role": "nat_sound",
            "motivation": "original clip audio"
          }
        ]
      }
    ]
  },
  "markers": [
    { "marker_id": "MKR_001", "frame": 90, "label": "beat" }
  ],
  "provenance": {
    "brief_path": "01_intent/creative_brief.yaml",
    "blueprint_path": "04_plan/edit_blueprint.yaml",
    "selects_path": "04_plan/selects_candidates.yaml"
  }
}
"""
