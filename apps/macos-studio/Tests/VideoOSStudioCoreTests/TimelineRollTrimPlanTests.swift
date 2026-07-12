import XCTest
@testable import VideoOSStudioCore

final class TimelineRollTrimPlanTests: XCTestCase {
    func testIncomingRollLeftShortensPreviousAndExtendsSelectedStart() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .incoming,
            direction: .left,
            deltaFrames: 12,
            assetDurationsUSByID: ["AST_A": 8_000_000, "AST_B": 9_000_000],
            reason: "roll incoming left"
        ))

        XCTAssertEqual(plan.boundary, .incoming)
        XCTAssertEqual(plan.direction, .left)
        XCTAssertEqual(plan.leftClipID, "CLP_A")
        XCTAssertEqual(plan.rightClipID, "CLP_B")
        XCTAssertEqual(plan.oldBoundaryFrame, 48)
        XCTAssertEqual(plan.newBoundaryFrame, 36)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment", "move_segment", "trim_segment", "move_segment"])

        guard case let .trimSegment(leftID, leftSourceIn, leftSourceOut, _) = plan.operations[0] else {
            return XCTFail("Expected left trim_segment")
        }
        XCTAssertEqual(leftID, "CLP_A")
        XCTAssertEqual(leftSourceIn, 1_000_000)
        XCTAssertEqual(leftSourceOut, 2_500_000)

        guard case let .moveSegment(leftMoveID, leftTimelineIn, leftDuration, _, _) = plan.operations[1] else {
            return XCTFail("Expected left move_segment")
        }
        XCTAssertEqual(leftMoveID, "CLP_A")
        XCTAssertEqual(leftTimelineIn, 0)
        XCTAssertEqual(leftDuration, 36)

        guard case let .trimSegment(rightID, rightSourceIn, rightSourceOut, _) = plan.operations[2] else {
            return XCTFail("Expected right trim_segment")
        }
        XCTAssertEqual(rightID, "CLP_B")
        XCTAssertEqual(rightSourceIn, 4_500_000)
        XCTAssertEqual(rightSourceOut, 7_000_000)

        guard case let .moveSegment(rightMoveID, rightTimelineIn, rightDuration, _, _) = plan.operations[3] else {
            return XCTFail("Expected right move_segment")
        }
        XCTAssertEqual(rightMoveID, "CLP_B")
        XCTAssertEqual(rightTimelineIn, 36)
        XCTAssertEqual(rightDuration, 60)
    }

    func testApplyingIncomingRollUpdatesImmediateTimelineDisplay() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .incoming,
            direction: .left,
            deltaFrames: 12,
            assetDurationsUSByID: ["AST_A": 8_000_000, "AST_B": 9_000_000],
            reason: "roll incoming left"
        ))

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let left = try XCTUnwrap(updated.clipSelection(for: "CLP_A")?.clip)
        let right = try XCTUnwrap(updated.clipSelection(for: "CLP_B")?.clip)

        XCTAssertEqual(left.timelineInFrame, 0)
        XCTAssertEqual(left.timelineDurationFrames, 36)
        XCTAssertEqual(left.sourceInUS, 1_000_000)
        XCTAssertEqual(left.sourceOutUS, 2_500_000)
        XCTAssertEqual(right.timelineInFrame, 36)
        XCTAssertEqual(right.timelineDurationFrames, 60)
        XCTAssertEqual(right.sourceInUS, 4_500_000)
        XCTAssertEqual(right.sourceOutUS, 7_000_000)
    }

    func testOutgoingRollRightExtendsSelectedEndAndShortensNextStart() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .outgoing,
            direction: .right,
            deltaFrames: 12,
            assetDurationsUSByID: ["AST_B": 9_000_000, "AST_C": 12_000_000],
            reason: "roll outgoing right"
        ))

        XCTAssertEqual(plan.boundary, .outgoing)
        XCTAssertEqual(plan.direction, .right)
        XCTAssertEqual(plan.leftClipID, "CLP_B")
        XCTAssertEqual(plan.rightClipID, "CLP_C")
        XCTAssertEqual(plan.oldBoundaryFrame, 96)
        XCTAssertEqual(plan.newBoundaryFrame, 108)

        guard case let .trimSegment(leftID, leftSourceIn, leftSourceOut, _) = plan.operations[0] else {
            return XCTFail("Expected left trim_segment")
        }
        XCTAssertEqual(leftID, "CLP_B")
        XCTAssertEqual(leftSourceIn, 5_000_000)
        XCTAssertEqual(leftSourceOut, 7_500_000)

        guard case let .moveSegment(leftMoveID, leftTimelineIn, leftDuration, _, _) = plan.operations[1] else {
            return XCTFail("Expected left move_segment")
        }
        XCTAssertEqual(leftMoveID, "CLP_B")
        XCTAssertEqual(leftTimelineIn, 48)
        XCTAssertEqual(leftDuration, 60)

        guard case let .trimSegment(rightID, rightSourceIn, rightSourceOut, _) = plan.operations[2] else {
            return XCTFail("Expected right trim_segment")
        }
        XCTAssertEqual(rightID, "CLP_C")
        XCTAssertEqual(rightSourceIn, 9_500_000)
        XCTAssertEqual(rightSourceOut, 11_000_000)

        guard case let .moveSegment(rightMoveID, rightTimelineIn, rightDuration, _, _) = plan.operations[3] else {
            return XCTFail("Expected right move_segment")
        }
        XCTAssertEqual(rightMoveID, "CLP_C")
        XCTAssertEqual(rightTimelineIn, 108)
        XCTAssertEqual(rightDuration, 36)
    }

    func testRollUsesArbitraryDragFrameDelta() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .outgoing,
            direction: .right,
            deltaFrames: 6,
            assetDurationsUSByID: ["AST_B": 9_000_000, "AST_C": 12_000_000],
            reason: "drag roll outgoing right"
        ))

        XCTAssertEqual(plan.shiftFrames, 6)
        XCTAssertEqual(plan.oldBoundaryFrame, 96)
        XCTAssertEqual(plan.newBoundaryFrame, 102)

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let left = try XCTUnwrap(updated.clipSelection(for: "CLP_B")?.clip)
        let right = try XCTUnwrap(updated.clipSelection(for: "CLP_C")?.clip)

        XCTAssertEqual(left.timelineInFrame, 48)
        XCTAssertEqual(left.timelineDurationFrames, 54)
        XCTAssertEqual(left.sourceInUS, 5_000_000)
        XCTAssertEqual(left.sourceOutUS, 7_250_000)
        XCTAssertEqual(right.timelineInFrame, 102)
        XCTAssertEqual(right.timelineDurationFrames, 42)
        XCTAssertEqual(right.sourceInUS, 9_250_000)
        XCTAssertEqual(right.sourceOutUS, 11_000_000)
    }

    func testRollRightRequiresAssetDurationWhenExtendingLeftClip() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        XCTAssertNil(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .outgoing,
            direction: .right,
            deltaFrames: 12,
            assetDurationsUSByID: [:],
            reason: "missing duration"
        ))
        XCTAssertNil(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .outgoing,
            direction: .right,
            deltaFrames: 12,
            assetDurationsUSByID: ["AST_B": 7_250_000],
            reason: "too short"
        ))
    }

    func testRollRequiresTouchingAdjacentClips() throws {
        let timeline = try makeTimelineWithGap()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        XCTAssertNil(TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: .incoming,
            direction: .left,
            deltaFrames: 12,
            assetDurationsUSByID: ["AST_A": 8_000_000, "AST_B": 9_000_000],
            reason: "gap"
        ))
    }

    private func makeTimeline() throws -> TimelineDocument {
        try decodeTimeline(gapFrames: 0)
    }

    private func makeTimelineWithGap() throws -> TimelineDocument {
        try decodeTimeline(gapFrames: 6)
    }

    private func decodeTimeline(gapFrames: Int) throws -> TimelineDocument {
        let bStart = 48 + gapFrames
        let bEnd = bStart + 48
        let cStart = bEnd
        let json = """
        {
          "version": "1",
          "project_id": "roll-trim-test",
          "sequence": {
            "name": "Roll Trim Test",
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
                    "src_in_us": 1000000,
                    "src_out_us": 3000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "test"
                  },
                  {
                    "clip_id": "CLP_B",
                    "segment_id": "SEG_B",
                    "asset_id": "AST_B",
                    "src_in_us": 5000000,
                    "src_out_us": 7000000,
                    "timeline_in_frame": \(bStart),
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "test"
                  },
                  {
                    "clip_id": "CLP_C",
                    "segment_id": "SEG_C",
                    "asset_id": "AST_C",
                    "src_in_us": 9000000,
                    "src_out_us": 11000000,
                    "timeline_in_frame": \(cStart),
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "test"
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
