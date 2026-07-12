import XCTest
@testable import VideoOSStudioCore

final class TimelineSourceOverwritePlanTests: XCTestCase {
    func testPlanOverwritesTargetTrackByTrimmingEdgesAndRemovingCoveredClips() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-overwrite-test",
            candidates: [
                makeCandidate(segmentID: "SEG_OVER", assetID: "AST_SRC", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceOverwritePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            playheadFrame: 24,
            reason: "Studio source monitor overwrite at playhead",
            candidateID: "SEG_OVER",
            preferredTargetTrackID: "V1"
        ))

        XCTAssertEqual(plan.insertedClipID, "CLP_0004")
        XCTAssertEqual(plan.targetTrackID, "V1")
        XCTAssertEqual(plan.timelineInFrame, 24)
        XCTAssertEqual(plan.durationFrames, 48)
        XCTAssertEqual(plan.overwriteOutFrame, 72)
        XCTAssertEqual(plan.removedClipIDs, ["CLP_0002"])
        XCTAssertEqual(plan.trimmedClipIDs, ["CLP_0001", "CLP_0003"])
        XCTAssertEqual(plan.splitClipIDs, [])
        XCTAssertEqual(plan.changedClipIDs, ["CLP_0004", "CLP_0001", "CLP_0003"])
        XCTAssertEqual(
            plan.operations.map(\.opName),
            ["insert_segment", "trim_segment", "move_segment", "remove_segment", "trim_segment", "move_segment"]
        )
        guard case let .insertSegment(_, _, _, timelineInFrame, durationFrames, targetTrackID, _, _, _) = plan.operations[0] else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(timelineInFrame, 24)
        XCTAssertEqual(durationFrames, 48)
        XCTAssertEqual(targetTrackID, "V1")

        let v1 = try XCTUnwrap(plan.timeline.tracks.video.first { $0.id == "V1" })
        XCTAssertEqual(v1.clips.map(\.id), ["CLP_0001", "CLP_0004", "CLP_0003"])

        let left = try XCTUnwrap(v1.clips.first { $0.id == "CLP_0001" })
        XCTAssertEqual(left.timelineInFrame, 0)
        XCTAssertEqual(left.timelineDurationFrames, 24)
        XCTAssertEqual(left.sourceInUS, 0)
        XCTAssertEqual(left.sourceOutUS, 1_000_000)

        let inserted = try XCTUnwrap(v1.clips.first { $0.id == "CLP_0004" })
        XCTAssertEqual(inserted.segmentID, "SEG_OVER")
        XCTAssertEqual(inserted.timelineInFrame, 24)
        XCTAssertEqual(inserted.timelineDurationFrames, 48)
        XCTAssertEqual(inserted.sourceInUS, 0)
        XCTAssertEqual(inserted.sourceOutUS, 2_000_000)

        let right = try XCTUnwrap(v1.clips.first { $0.id == "CLP_0003" })
        XCTAssertEqual(right.timelineInFrame, 72)
        XCTAssertEqual(right.timelineDurationFrames, 24)
        XCTAssertEqual(right.sourceInUS, 500_000)
        XCTAssertEqual(right.sourceOutUS, 1_500_000)
    }

    func testPlanUsesMarkedSourceRangeForOverwriteDuration() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-overwrite-test",
            candidates: [
                makeCandidate(segmentID: "SEG_OVER", assetID: "AST_SRC", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 500_000, sourceOutUS: 1_500_000))

        let plan = try XCTUnwrap(TimelineSourceOverwritePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            playheadFrame: 24,
            reason: "Studio source monitor marked overwrite",
            candidateID: "SEG_OVER",
            preferredTargetTrackID: "V1",
            sourceRangeOverride: range
        ))

        XCTAssertEqual(plan.durationFrames, 24)
        XCTAssertEqual(plan.overwriteOutFrame, 48)
        XCTAssertEqual(plan.removedClipIDs, ["CLP_0002"])
        XCTAssertEqual(plan.trimmedClipIDs, ["CLP_0001"])
        XCTAssertEqual(plan.splitClipIDs, [])
        guard case let .insertSegment(_, _, _, _, durationFrames, targetTrackID, sourceInUS, sourceOutUS, _) = plan.operations[0] else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(durationFrames, 24)
        XCTAssertEqual(targetTrackID, "V1")
        XCTAssertEqual(sourceInUS, 500_000)
        XCTAssertEqual(sourceOutUS, 1_500_000)
    }

    func testPlanSplitsMiddleSpanningClipAndPreservesTrailingRemainder() throws {
        let timeline = try makeTimelineWithMiddleSpanningClip()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-overwrite-test",
            candidates: [
                makeCandidate(segmentID: "SEG_OVER", assetID: "AST_SRC", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceOverwritePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            playheadFrame: 24,
            reason: "Studio source monitor overwrite at playhead",
            candidateID: "SEG_OVER",
            preferredTargetTrackID: "V1"
        ))

        XCTAssertEqual(plan.insertedClipID, "CLP_0002")
        XCTAssertEqual(plan.splitClipIDs, ["CLP_0001"])
        XCTAssertEqual(plan.trimmedClipIDs, ["CLP_0001"])
        XCTAssertEqual(plan.removedClipIDs, [])
        XCTAssertEqual(plan.changedClipIDs, ["CLP_0002", "CLP_0001"])
        XCTAssertEqual(
            plan.operations.map(\.opName),
            ["insert_segment", "split_segment", "trim_segment", "move_segment"]
        )

        guard case let .splitSegment(targetClipID, splitTimelineFrame, _) = plan.operations[1] else {
            return XCTFail("Expected split_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_0001")
        XCTAssertEqual(splitTimelineFrame, 72)

        let v1 = try XCTUnwrap(plan.timeline.tracks.video.first { $0.id == "V1" })
        XCTAssertEqual(v1.clips.map(\.id), ["CLP_0001", "CLP_0002", "CLP_0003", "NEXT"])

        let left = try XCTUnwrap(v1.clips.first { $0.id == "CLP_0001" })
        XCTAssertEqual(left.timelineInFrame, 0)
        XCTAssertEqual(left.timelineDurationFrames, 24)
        XCTAssertEqual(left.sourceInUS, 0)
        XCTAssertEqual(left.sourceOutUS, 1_000_000)

        let inserted = try XCTUnwrap(v1.clips.first { $0.id == "CLP_0002" })
        XCTAssertEqual(inserted.segmentID, "SEG_OVER")
        XCTAssertEqual(inserted.timelineInFrame, 24)
        XCTAssertEqual(inserted.timelineDurationFrames, 48)

        let right = try XCTUnwrap(v1.clips.first { $0.id == "CLP_0003" })
        XCTAssertEqual(right.segmentID, "SEG_LONG")
        XCTAssertEqual(right.timelineInFrame, 72)
        XCTAssertEqual(right.timelineDurationFrames, 24)
        XCTAssertEqual(right.sourceInUS, 3_000_000)
        XCTAssertEqual(right.sourceOutUS, 4_000_000)

        let transition = try XCTUnwrap(plan.timeline.transitions.first)
        XCTAssertEqual(transition.fromClipID, "CLP_0003")
        XCTAssertEqual(transition.toClipID, "NEXT")
    }

    private func makeCandidate(
        segmentID: String,
        assetID: String,
        role: String,
        confidence: Double
    ) -> BrowserCandidate {
        BrowserCandidate(
            candidate_id: nil,
            segment_id: segmentID,
            asset_id: assetID,
            src_in_us: 0,
            src_out_us: 2_000_000,
            role: role,
            confidence: confidence,
            why_it_matches: "candidate \(segmentID)",
            risks: [],
            eligible_beats: ["b01"],
            story_role: nil,
            evidence: [],
            motif_tags: [],
            trim_hint: nil,
            editorial_signals: nil
        )
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "source-overwrite-test",
          "sequence": {
            "name": "Source Overwrite Test",
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
                    "clip_id": "CLP_0001",
                    "segment_id": "SEG_LEFT",
                    "asset_id": "AST_LEFT",
                    "src_in_us": 0,
                    "src_out_us": 1500000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 36,
                    "role": "hero",
                    "motivation": "left",
                    "beat_id": "b01"
                  },
                  {
                    "clip_id": "CLP_0002",
                    "segment_id": "SEG_MID",
                    "asset_id": "AST_MID",
                    "src_in_us": 0,
                    "src_out_us": 500000,
                    "timeline_in_frame": 36,
                    "timeline_duration_frames": 12,
                    "role": "hero",
                    "motivation": "covered",
                    "beat_id": "b01"
                  },
                  {
                    "clip_id": "CLP_0003",
                    "segment_id": "SEG_RIGHT",
                    "asset_id": "AST_RIGHT",
                    "src_in_us": 0,
                    "src_out_us": 1500000,
                    "timeline_in_frame": 60,
                    "timeline_duration_frames": 36,
                    "role": "hero",
                    "motivation": "right",
                    "beat_id": "b02"
                  }
                ]
              }
            ],
            "audio": [],
            "overlay": [],
            "caption": []
          },
          "markers": [],
          "transitions": [
            {
              "transition_id": "TRN_REMOVED",
              "from_clip_id": "CLP_0001",
              "to_clip_id": "CLP_0002",
              "track_id": "V1",
              "transition_type": "crossfade",
              "transition_frames": 6
            }
          ]
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }

    private func makeTimelineWithMiddleSpanningClip() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "source-overwrite-test",
          "sequence": {
            "name": "Source Overwrite Test",
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
                    "clip_id": "CLP_0001",
                    "segment_id": "SEG_LONG",
                    "asset_id": "AST_LONG",
                    "src_in_us": 0,
                    "src_out_us": 4000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 96,
                    "role": "hero",
                    "motivation": "long",
                    "beat_id": "b01"
                  },
                  {
                    "clip_id": "NEXT",
                    "segment_id": "SEG_NEXT",
                    "asset_id": "AST_NEXT",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 96,
                    "timeline_duration_frames": 24,
                    "role": "hero",
                    "motivation": "next",
                    "beat_id": "b02"
                  }
                ]
              }
            ],
            "audio": [],
            "overlay": [],
            "caption": []
          },
          "markers": [],
          "transitions": [
            {
              "transition_id": "TRN_OUT",
              "from_clip_id": "CLP_0001",
              "to_clip_id": "NEXT",
              "track_id": "V1",
              "transition_type": "crossfade",
              "transition_frames": 6
            }
          ]
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
