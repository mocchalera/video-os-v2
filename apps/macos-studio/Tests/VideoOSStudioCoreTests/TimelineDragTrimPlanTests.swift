import XCTest
@testable import VideoOSStudioCore

final class TimelineDragTrimPlanTests: XCTestCase {
    func testStartDragTrimMovesStartAndShortensDuration() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            selection: selection,
            targetBoundaryFrame: 12,
            edge: .start,
            reason: "drag start"
        ))

        XCTAssertEqual(plan.targetClipID, "CLP_A")
        XCTAssertEqual(plan.edge, .start)
        XCTAssertEqual(plan.targetBoundaryFrame, 12)
        XCTAssertEqual(plan.removedFrames, 12)
        XCTAssertEqual(plan.newTimelineInFrame, 12)
        XCTAssertEqual(plan.newDurationFrames, 36)
        XCTAssertEqual(plan.newSourceInUS, 500_000)
        XCTAssertEqual(plan.newSourceOutUS, 2_000_000)
        XCTAssertEqual(plan.viewerPreviewFrame, 12)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment", "move_segment"])
    }

    func testStartDragTrimOperationsUpdateImmediateTimelineDisplay() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))
        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            selection: selection,
            targetBoundaryFrame: 12,
            edge: .start,
            reason: "drag start"
        ))

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_A")?.clip)

        XCTAssertEqual(clip.timelineInFrame, 12)
        XCTAssertEqual(clip.timelineDurationFrames, 36)
        XCTAssertEqual(clip.sourceInUS, 500_000)
        XCTAssertEqual(clip.sourceOutUS, 2_000_000)
    }

    func testEndDragTrimKeepsStartAndShortensDuration() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            selection: selection,
            targetBoundaryFrame: 36,
            edge: .end,
            reason: "drag end"
        ))

        XCTAssertEqual(plan.edge, .end)
        XCTAssertEqual(plan.targetBoundaryFrame, 36)
        XCTAssertEqual(plan.removedFrames, 12)
        XCTAssertEqual(plan.newTimelineInFrame, 0)
        XCTAssertEqual(plan.newDurationFrames, 36)
        XCTAssertEqual(plan.newSourceInUS, 0)
        XCTAssertEqual(plan.newSourceOutUS, 1_500_000)
        XCTAssertEqual(plan.viewerPreviewFrame, 35)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment", "move_segment"])
    }

    func testEndDragTrimOperationsUpdateImmediateTimelineDisplay() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))
        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            selection: selection,
            targetBoundaryFrame: 36,
            edge: .end,
            reason: "drag end"
        ))

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_A")?.clip)

        XCTAssertEqual(clip.timelineInFrame, 0)
        XCTAssertEqual(clip.timelineDurationFrames, 36)
        XCTAssertEqual(clip.sourceInUS, 0)
        XCTAssertEqual(clip.sourceOutUS, 1_500_000)
    }

    func testStartDragTrimCanExtendIntoPreviousGap() throws {
        let timeline = try makeTimelineWithGaps(previousGapFrames: 24, nextGapFrames: 24)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 48,
            edge: .start,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "extend start"
        ))

        XCTAssertTrue(plan.isExtension)
        XCTAssertEqual(plan.addedFrames, 12)
        XCTAssertEqual(plan.removedFrames, 0)
        XCTAssertEqual(plan.durationDeltaFrames, 12)
        XCTAssertEqual(plan.newTimelineInFrame, 48)
        XCTAssertEqual(plan.newDurationFrames, 60)
        XCTAssertEqual(plan.newSourceInUS, 1_500_000)
        XCTAssertEqual(plan.newSourceOutUS, 4_000_000)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment", "move_segment"])

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_B")?.clip)
        XCTAssertEqual(clip.timelineInFrame, 48)
        XCTAssertEqual(clip.timelineDurationFrames, 60)
        XCTAssertEqual(clip.sourceInUS, 1_500_000)
    }

    func testEndDragTrimCanExtendIntoNextGapAndAssetDuration() throws {
        let timeline = try makeTimelineWithGaps(previousGapFrames: 24, nextGapFrames: 24)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 120,
            edge: .end,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            assetDurationUS: 5_000_000,
            reason: "extend end"
        ))

        XCTAssertTrue(plan.isExtension)
        XCTAssertEqual(plan.addedFrames, 12)
        XCTAssertEqual(plan.durationDeltaFrames, 12)
        XCTAssertEqual(plan.newTimelineInFrame, 60)
        XCTAssertEqual(plan.newDurationFrames, 60)
        XCTAssertEqual(plan.newSourceInUS, 2_000_000)
        XCTAssertEqual(plan.newSourceOutUS, 4_500_000)

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_B")?.clip)
        XCTAssertEqual(clip.timelineInFrame, 60)
        XCTAssertEqual(clip.timelineDurationFrames, 60)
        XCTAssertEqual(clip.sourceOutUS, 4_500_000)
    }

    func testDragTrimExtensionRejectsOverlapOrMissingSourceHandle() throws {
        let timeline = try makeTimelineWithGaps(previousGapFrames: 6, nextGapFrames: 6)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        XCTAssertNil(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 30,
            edge: .start,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "overlap previous"
        ))
        XCTAssertNil(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 102,
            edge: .end,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            assetDurationUS: 5_000_000,
            reason: "overlap next"
        ))

        let timelineWithEndGap = try makeTimelineWithGaps(previousGapFrames: 24, nextGapFrames: 24)
        let selectionWithEndGap = try XCTUnwrap(timelineWithEndGap.clipSelection(for: "CLP_B"))
        XCTAssertNil(TimelineDragTrimPlan.make(
            timeline: timelineWithEndGap,
            selection: selectionWithEndGap,
            targetBoundaryFrame: 120,
            edge: .end,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            assetDurationUS: nil,
            reason: "missing asset duration"
        ))
    }

    func testStartDragTrimSnapsBoundaryToPlayhead() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 22,
            edge: .start,
            snapThresholdFrames: 3,
            playheadFrame: 24,
            reason: "snap start trim"
        ))

        XCTAssertEqual(plan.proposedBoundaryFrame, 22)
        XCTAssertEqual(plan.targetBoundaryFrame, 24)
        XCTAssertEqual(plan.snap?.kind, .playhead)
        XCTAssertEqual(plan.snap?.alignment, .start)
        XCTAssertEqual(plan.snap?.distanceFrames, 2)
        XCTAssertEqual(plan.newTimelineInFrame, 24)
        XCTAssertEqual(plan.newDurationFrames, 24)

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_A")?.clip)
        XCTAssertEqual(clip.timelineInFrame, 24)
        XCTAssertEqual(clip.timelineDurationFrames, 24)
        XCTAssertEqual(clip.sourceInUS, 1_000_000)
    }

    func testEndDragTrimSnapsBoundaryToMarker() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 32,
            edge: .end,
            snapThresholdFrames: 3,
            playheadFrame: 12,
            reason: "snap end trim"
        ))

        XCTAssertEqual(plan.proposedBoundaryFrame, 32)
        XCTAssertEqual(plan.targetBoundaryFrame, 30)
        XCTAssertEqual(plan.snap?.kind, .marker)
        XCTAssertEqual(plan.snap?.alignment, .end)
        XCTAssertEqual(plan.snap?.label, "snap marker")
        XCTAssertEqual(plan.newTimelineInFrame, 0)
        XCTAssertEqual(plan.newDurationFrames, 30)

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_A")?.clip)
        XCTAssertEqual(clip.timelineInFrame, 0)
        XCTAssertEqual(clip.timelineDurationFrames, 30)
        XCTAssertEqual(clip.sourceOutUS, 1_250_000)
    }

    func testDragTrimKeepsProposedBoundaryWhenSnapIsOutOfRange() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: 20,
            edge: .start,
            snapThresholdFrames: 2,
            playheadFrame: 24,
            reason: "unsnapped start trim"
        ))

        XCTAssertEqual(plan.proposedBoundaryFrame, 20)
        XCTAssertEqual(plan.targetBoundaryFrame, 20)
        XCTAssertNil(plan.snap)
        XCTAssertEqual(plan.newTimelineInFrame, 20)
        XCTAssertEqual(plan.newDurationFrames, 28)
    }

    func testBoundaryTargetsAreRejected() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelineDragTrimPlan.make(
            selection: selection,
            targetBoundaryFrame: 0,
            edge: .start,
            reason: "start boundary"
        ))
        XCTAssertNil(TimelineDragTrimPlan.make(
            selection: selection,
            targetBoundaryFrame: 48,
            edge: .end,
            reason: "end boundary"
        ))
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "drag-trim-test",
          "sequence": {
            "name": "Drag Trim Test",
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
                    "clip_id": "CLP_A",
                    "segment_id": "SEG_A",
                    "asset_id": "AST_A",
                    "src_in_us": 0,
                    "src_out_us": 2000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "test"
                  }
                ]
              }
            ],
            "audio": []
          },
          "markers": [
            {
              "marker_id": "MRK_SNAP",
              "frame": 30,
              "label": "snap marker",
              "kind": "marker"
            }
          ]
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }

    private func makeTimelineWithGaps(
        previousGapFrames: Int,
        nextGapFrames: Int
    ) throws -> TimelineDocument {
        let bStart = 36 + previousGapFrames
        let bEnd = bStart + 48
        let cStart = bEnd + nextGapFrames
        let json = """
        {
          "version": "1",
          "project_id": "drag-trim-gap-test",
          "sequence": {
            "name": "Drag Trim Gap Test",
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
                    "clip_id": "CLP_A",
                    "segment_id": "SEG_A",
                    "asset_id": "AST_A",
                    "src_in_us": 0,
                    "src_out_us": 1500000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 36,
                    "role": "dialogue",
                    "motivation": "previous"
                  },
                  {
                    "clip_id": "CLP_B",
                    "segment_id": "SEG_B",
                    "asset_id": "AST_B",
                    "src_in_us": 2000000,
                    "src_out_us": 4000000,
                    "timeline_in_frame": \(bStart),
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "selected"
                  },
                  {
                    "clip_id": "CLP_C",
                    "segment_id": "SEG_C",
                    "asset_id": "AST_C",
                    "src_in_us": 6000000,
                    "src_out_us": 7500000,
                    "timeline_in_frame": \(cStart),
                    "timeline_duration_frames": 36,
                    "role": "dialogue",
                    "motivation": "next"
                  }
                ]
              }
            ],
            "audio": []
          },
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
