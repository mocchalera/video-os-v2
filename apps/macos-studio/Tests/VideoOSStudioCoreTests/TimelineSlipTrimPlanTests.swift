import XCTest
@testable import VideoOSStudioCore

final class TimelineSlipTrimPlanTests: XCTestCase {
    func testSlipLeftMovesSourceRangeEarlierWithoutChangingTimeline() throws {
        let timeline = try makeTimeline(sourceInUS: 5_000_000, sourceOutUS: 7_000_000)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .left,
            deltaFrames: 12,
            assetDurationUS: 12_000_000,
            reason: "slip left"
        ))

        XCTAssertEqual(plan.direction, .left)
        XCTAssertEqual(plan.clipID, "CLP_A")
        XCTAssertEqual(plan.shiftFrames, 12)
        XCTAssertEqual(plan.shiftUS, 500_000)
        XCTAssertEqual(plan.oldSourceInUS, 5_000_000)
        XCTAssertEqual(plan.oldSourceOutUS, 7_000_000)
        XCTAssertEqual(plan.newSourceInUS, 4_500_000)
        XCTAssertEqual(plan.newSourceOutUS, 6_500_000)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment"])

        guard case let .trimSegment(clipID, sourceInUS, sourceOutUS, _) = plan.operations[0] else {
            return XCTFail("Expected trim_segment")
        }
        XCTAssertEqual(clipID, "CLP_A")
        XCTAssertEqual(sourceInUS, 4_500_000)
        XCTAssertEqual(sourceOutUS, 6_500_000)
    }

    func testApplyingSlipUpdatesImmediateViewerSourceRangeWithoutMovingTimeline() throws {
        let timeline = try makeTimeline(sourceInUS: 5_000_000, sourceOutUS: 7_000_000)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .right,
            deltaFrames: 12,
            assetDurationUS: 12_000_000,
            reason: "slip right"
        ))

        let updated = timeline.applyingTimelineTrimOperations(plan.operations)
        let clip = try XCTUnwrap(updated.clipSelection(for: "CLP_A")?.clip)

        XCTAssertEqual(clip.timelineInFrame, 24)
        XCTAssertEqual(clip.timelineDurationFrames, 48)
        XCTAssertEqual(clip.sourceInUS, 5_500_000)
        XCTAssertEqual(clip.sourceOutUS, 7_500_000)
    }

    func testSlipRightMovesSourceRangeLaterWithinAssetDuration() throws {
        let timeline = try makeTimeline(sourceInUS: 5_000_000, sourceOutUS: 7_000_000)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .right,
            deltaFrames: 12,
            assetDurationUS: 12_000_000,
            reason: "slip right"
        ))

        XCTAssertEqual(plan.direction, .right)
        XCTAssertEqual(plan.newSourceInUS, 5_500_000)
        XCTAssertEqual(plan.newSourceOutUS, 7_500_000)
    }

    func testSlipUsesArbitraryDragFrameDelta() throws {
        let timeline = try makeTimeline(sourceInUS: 5_000_000, sourceOutUS: 7_000_000)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .right,
            deltaFrames: 6,
            assetDurationUS: 12_000_000,
            reason: "drag slip right"
        ))

        XCTAssertEqual(plan.shiftFrames, 6)
        XCTAssertEqual(plan.shiftUS, 250_000)
        XCTAssertEqual(plan.newSourceInUS, 5_250_000)
        XCTAssertEqual(plan.newSourceOutUS, 7_250_000)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment"])
    }

    func testSlipLeftRejectsNegativeSourceIn() throws {
        let timeline = try makeTimeline(sourceInUS: 250_000, sourceOutUS: 2_250_000)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .left,
            deltaFrames: 12,
            assetDurationUS: 12_000_000,
            reason: "too far left"
        ))
    }

    func testSlipRightRequiresAssetDuration() throws {
        let timeline = try makeTimeline(sourceInUS: 5_000_000, sourceOutUS: 7_000_000)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .right,
            deltaFrames: 12,
            assetDurationUS: nil,
            reason: "missing duration"
        ))
        XCTAssertNil(TimelineSlipTrimPlan.make(
            selection: selection,
            direction: .right,
            deltaFrames: 12,
            assetDurationUS: 7_250_000,
            reason: "too short"
        ))
    }

    private func makeTimeline(sourceInUS: Int, sourceOutUS: Int) throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "slip-trim-test",
          "sequence": {
            "name": "Slip Trim Test",
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
                    "src_in_us": \(sourceInUS),
                    "src_out_us": \(sourceOutUS),
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "test",
                    "confidence": 0.9,
                    "beat_id": "b01",
                    "fallback_segment_ids": [],
                    "quality_flags": [],
                    "candidate_ref": "cand-a"
                  }
                ]
              }
            ],
            "audio": [],
            "overlay": [],
            "caption": []
          },
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
