import XCTest
@testable import VideoOSStudioCore

final class TimelineSplitPlanTests: XCTestCase {
    func testSplitAtPlayheadBuildsCompilerOperation() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineSplitPlan.make(
            selection: selection,
            playheadFrame: 24,
            reason: "split at playhead"
        ))

        XCTAssertEqual(plan.targetClipID, "CLP_A")
        XCTAssertEqual(plan.trackID, "V1")
        XCTAssertEqual(plan.playheadFrame, 24)
        XCTAssertEqual(plan.leftDurationFrames, 24)
        XCTAssertEqual(plan.rightDurationFrames, 24)
        XCTAssertEqual(plan.splitSourceUS, 1_000_000)
        XCTAssertEqual(plan.operations.map(\.opName), ["split_segment"])

        guard case let .splitSegment(targetClipID, splitTimelineFrame, reason) = plan.operations[0] else {
            return XCTFail("Expected split_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_A")
        XCTAssertEqual(splitTimelineFrame, 24)
        XCTAssertEqual(reason, "split at playhead")
    }

    func testBoundaryPlayheadsAreRejected() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelineSplitPlan.make(
            selection: selection,
            playheadFrame: 0,
            reason: "start boundary"
        ))
        XCTAssertNil(TimelineSplitPlan.make(
            selection: selection,
            playheadFrame: 48,
            reason: "end boundary"
        ))
    }

    func testMissingSourceRangeIsRejected() throws {
        let timeline = try makeTimeline(sourceFields: false)
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelineSplitPlan.make(
            selection: selection,
            playheadFrame: 24,
            reason: "missing source"
        ))
    }

    func testNextClipIDMatchesCompilerGeneratedIDScope() throws {
        let timeline = try makeNumericTimeline()

        XCTAssertEqual(TimelineSplitPlan.nextClipID(in: timeline), "CLP_0008")
    }

    func testGeneratedRightClipPreviewMatchesSplitPlan() throws {
        let timeline = try makeNumericTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_0002"))
        let plan = try XCTUnwrap(TimelineSplitPlan.make(
            selection: selection,
            playheadFrame: 24,
            reason: "blade click"
        ))
        let rightClipID = TimelineSplitPlan.nextClipID(in: timeline)

        let updatedTimeline = try XCTUnwrap(timeline.splittingClip(
            plan.targetClipID,
            atTimelineFrame: plan.playheadFrame,
            rightClipID: rightClipID,
            reason: "blade click"
        ))
        let left = try XCTUnwrap(updatedTimeline.clipSelection(for: "CLP_0002")?.clip)
        let right = try XCTUnwrap(updatedTimeline.clipSelection(for: "CLP_0008")?.clip)

        XCTAssertEqual(left.timelineInFrame, 0)
        XCTAssertEqual(left.timelineDurationFrames, 24)
        XCTAssertEqual(left.sourceOutUS, plan.splitSourceUS)
        XCTAssertEqual(right.timelineInFrame, 24)
        XCTAssertEqual(right.timelineDurationFrames, 24)
        XCTAssertEqual(right.sourceInUS, plan.splitSourceUS)
        XCTAssertEqual(plan.operations.map(\.opName), ["split_segment"])
    }

    private func makeTimeline(sourceFields: Bool = true) throws -> TimelineDocument {
        let sourceJSON = sourceFields
            ? """
                    "src_in_us": 0,
                    "src_out_us": 2000000,
            """
            : ""
        let json = """
        {
          "version": "1",
          "project_id": "split-test",
          "sequence": {
            "name": "Split Test",
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
        \(sourceJSON)
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

    private func makeNumericTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "split-numeric-test",
          "sequence": {
            "name": "Split Numeric Test",
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
                    "clip_id": "CLP_0002",
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
            "audio": [
              {
                "track_id": "A1",
                "kind": "audio",
                "clips": [
                  {
                    "clip_id": "CLP_0007",
                    "segment_id": "SEG_AUDIO",
                    "asset_id": "AST_AUDIO",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "nat_sound",
                    "motivation": "test"
                  }
                ]
              }
            ]
          },
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
