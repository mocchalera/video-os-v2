import XCTest
@testable import VideoOSStudioCore

final class TimelineExtendTrimPlanTests: XCTestCase {
    func testExtendStartUsesPreviousGapAndSourceHandle() throws {
        let timeline = try makeTimeline(previousGapFrames: 24, nextGapFrames: 24)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineExtendTrimPlan.make(
            timeline: timeline,
            selection: selection,
            edge: .start,
            deltaFrames: 12,
            assetDurationUS: 8_000_000,
            reason: "extend start"
        ))

        XCTAssertEqual(plan.edge, .start)
        XCTAssertEqual(plan.clipID, "CLP_B")
        XCTAssertEqual(plan.oldTimelineInFrame, 60)
        XCTAssertEqual(plan.newTimelineInFrame, 48)
        XCTAssertEqual(plan.oldDurationFrames, 48)
        XCTAssertEqual(plan.newDurationFrames, 60)
        XCTAssertEqual(plan.oldSourceInUS, 2_000_000)
        XCTAssertEqual(plan.oldSourceOutUS, 4_000_000)
        XCTAssertEqual(plan.newSourceInUS, 1_500_000)
        XCTAssertEqual(plan.newSourceOutUS, 4_000_000)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment", "move_segment"])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, _, _) = plan.operations[1] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_B")
        XCTAssertEqual(timelineInFrame, 48)
        XCTAssertEqual(durationFrames, 60)
    }

    func testApplyingExtendStartUpdatesImmediateTimelineDisplay() throws {
        let timeline = try makeTimeline(previousGapFrames: 24, nextGapFrames: 24)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineExtendTrimPlan.make(
            timeline: timeline,
            selection: selection,
            edge: .start,
            deltaFrames: 12,
            assetDurationUS: 8_000_000,
            reason: "extend start"
        ))

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_B")?.clip)

        XCTAssertEqual(clip.timelineInFrame, 48)
        XCTAssertEqual(clip.timelineDurationFrames, 60)
        XCTAssertEqual(clip.sourceInUS, 1_500_000)
        XCTAssertEqual(clip.sourceOutUS, 4_000_000)
    }

    func testExtendEndUsesNextGapAndAssetDuration() throws {
        let timeline = try makeTimeline(previousGapFrames: 24, nextGapFrames: 24)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineExtendTrimPlan.make(
            timeline: timeline,
            selection: selection,
            edge: .end,
            deltaFrames: 12,
            assetDurationUS: 5_000_000,
            reason: "extend end"
        ))

        XCTAssertEqual(plan.edge, .end)
        XCTAssertEqual(plan.newTimelineInFrame, 60)
        XCTAssertEqual(plan.newDurationFrames, 60)
        XCTAssertEqual(plan.newSourceInUS, 2_000_000)
        XCTAssertEqual(plan.newSourceOutUS, 4_500_000)

        guard case let .trimSegment(targetClipID, sourceInUS, sourceOutUS, _) = plan.operations[0] else {
            return XCTFail("Expected trim_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_B")
        XCTAssertEqual(sourceInUS, 2_000_000)
        XCTAssertEqual(sourceOutUS, 4_500_000)
    }

    func testExtendStartRejectsInsufficientGapOrSourceHandle() throws {
        let timeline = try makeTimeline(previousGapFrames: 6, nextGapFrames: 24)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        XCTAssertNil(TimelineExtendTrimPlan.make(
            timeline: timeline,
            selection: selection,
            edge: .start,
            deltaFrames: 12,
            assetDurationUS: 8_000_000,
            reason: "gap too small"
        ))

        let noSourceHandleTimeline = try makeTimeline(
            previousGapFrames: 24,
            nextGapFrames: 24,
            selectedSourceInUS: 250_000
        )
        let noSourceHandleSelection = try XCTUnwrap(noSourceHandleTimeline.clipSelection(for: "CLP_B"))
        XCTAssertNil(TimelineExtendTrimPlan.make(
            timeline: noSourceHandleTimeline,
            selection: noSourceHandleSelection,
            edge: .start,
            deltaFrames: 12,
            assetDurationUS: 8_000_000,
            reason: "source underflow"
        ))
    }

    func testExtendEndRejectsInsufficientGapOrAssetDuration() throws {
        let timeline = try makeTimeline(previousGapFrames: 24, nextGapFrames: 6)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        XCTAssertNil(TimelineExtendTrimPlan.make(
            timeline: timeline,
            selection: selection,
            edge: .end,
            deltaFrames: 12,
            assetDurationUS: 5_000_000,
            reason: "gap too small"
        ))

        let timelineWithGap = try makeTimeline(previousGapFrames: 24, nextGapFrames: 24)
        let selectionWithGap = try XCTUnwrap(timelineWithGap.clipSelection(for: "CLP_B"))
        XCTAssertNil(TimelineExtendTrimPlan.make(
            timeline: timelineWithGap,
            selection: selectionWithGap,
            edge: .end,
            deltaFrames: 12,
            assetDurationUS: nil,
            reason: "missing duration"
        ))
        XCTAssertNil(TimelineExtendTrimPlan.make(
            timeline: timelineWithGap,
            selection: selectionWithGap,
            edge: .end,
            deltaFrames: 12,
            assetDurationUS: 4_250_000,
            reason: "asset too short"
        ))
    }

    private func makeTimeline(
        previousGapFrames: Int,
        nextGapFrames: Int,
        selectedSourceInUS: Int = 2_000_000
    ) throws -> TimelineDocument {
        let bStart = 36 + previousGapFrames
        let bEnd = bStart + 48
        let cStart = bEnd + nextGapFrames
        let json = """
        {
          "version": "1",
          "project_id": "extend-trim-test",
          "sequence": {
            "name": "Extend Trim Test",
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
                    "src_in_us": \(selectedSourceInUS),
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
