import XCTest
@testable import VideoOSStudioCore

final class TimelinePlayheadTrimPlanTests: XCTestCase {
    func testStartTrimMovesTimelineInAndShortensDuration() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: 24,
            edge: .start,
            reason: "trim start to playhead"
        ))

        XCTAssertEqual(plan.targetClipID, "CLP_A")
        XCTAssertEqual(plan.edge, .start)
        XCTAssertEqual(plan.removedFrames, 24)
        XCTAssertEqual(plan.newTimelineInFrame, 24)
        XCTAssertEqual(plan.newDurationFrames, 24)
        XCTAssertEqual(plan.newSourceInUS, 1_000_000)
        XCTAssertEqual(plan.newSourceOutUS, 2_000_000)
        XCTAssertEqual(plan.operations.map(\.opName), ["trim_segment", "move_segment"])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, _, _) = plan.operations[1] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_A")
        XCTAssertEqual(timelineInFrame, 24)
        XCTAssertEqual(durationFrames, 24)
    }

    func testEndTrimKeepsTimelineInAndShortensDuration() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: 24,
            edge: .end,
            reason: "trim end to playhead"
        ))

        XCTAssertEqual(plan.edge, .end)
        XCTAssertEqual(plan.removedFrames, 24)
        XCTAssertEqual(plan.newTimelineInFrame, 0)
        XCTAssertEqual(plan.newDurationFrames, 24)
        XCTAssertEqual(plan.newSourceInUS, 0)
        XCTAssertEqual(plan.newSourceOutUS, 1_000_000)

        guard case let .trimSegment(targetClipID, sourceInUS, sourceOutUS, _) = plan.operations[0] else {
            return XCTFail("Expected trim_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_A")
        XCTAssertEqual(sourceInUS, 0)
        XCTAssertEqual(sourceOutUS, 1_000_000)
    }

    func testApplyingStartTrimPlanUpdatesImmediateTimelineDisplay() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))
        let plan = try XCTUnwrap(TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: 24,
            edge: .start,
            reason: "trim start to playhead"
        ))

        let updatedTimeline = timeline.applyingTimelineTrimOperations(plan.operations)
        let updatedClip = try XCTUnwrap(updatedTimeline.clipSelection(for: "CLP_A")?.clip)

        XCTAssertEqual(updatedClip.timelineInFrame, 24)
        XCTAssertEqual(updatedClip.timelineDurationFrames, 24)
        XCTAssertEqual(updatedClip.sourceInUS, 1_000_000)
        XCTAssertEqual(updatedClip.sourceOutUS, 2_000_000)
    }

    func testApplyingEndTrimPlanUpdatesImmediateTimelineDisplay() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))
        let plan = try XCTUnwrap(TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: 24,
            edge: .end,
            reason: "trim end to playhead"
        ))

        let updatedTimeline = timeline.applyingTimelineTrimOperations(plan.operations)
        let updatedClip = try XCTUnwrap(updatedTimeline.clipSelection(for: "CLP_A")?.clip)

        XCTAssertEqual(updatedClip.timelineInFrame, 0)
        XCTAssertEqual(updatedClip.timelineDurationFrames, 24)
        XCTAssertEqual(updatedClip.sourceInUS, 0)
        XCTAssertEqual(updatedClip.sourceOutUS, 1_000_000)
    }

    func testBoundaryPlayheadsAreRejected() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: 0,
            edge: .start,
            reason: "start boundary"
        ))
        XCTAssertNil(TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: 48,
            edge: .end,
            reason: "end boundary"
        ))
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "trim-test",
          "sequence": {
            "name": "Trim Test",
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
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
