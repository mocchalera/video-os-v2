import XCTest
@testable import VideoOSStudioCore

final class TimelinePlaybackTransportTests: XCTestCase {
    func testShuttleSpeedCyclesForSameDirectionAndResetsWhenDirectionChanges() {
        XCTAssertEqual(
            TimelinePlaybackShuttle.nextSpeed(
                isPlaying: false,
                currentDirection: .forward,
                currentSpeed: 0,
                requestedDirection: .forward
            ),
            1
        )
        XCTAssertEqual(
            TimelinePlaybackShuttle.nextSpeed(
                isPlaying: true,
                currentDirection: .forward,
                currentSpeed: 1,
                requestedDirection: .forward
            ),
            2
        )
        XCTAssertEqual(
            TimelinePlaybackShuttle.nextSpeed(
                isPlaying: true,
                currentDirection: .forward,
                currentSpeed: 2,
                requestedDirection: .forward
            ),
            4
        )
        XCTAssertEqual(
            TimelinePlaybackShuttle.nextSpeed(
                isPlaying: true,
                currentDirection: .forward,
                currentSpeed: 4,
                requestedDirection: .forward
            ),
            1
        )
        XCTAssertEqual(
            TimelinePlaybackShuttle.nextSpeed(
                isPlaying: true,
                currentDirection: .forward,
                currentSpeed: 4,
                requestedDirection: .reverse
            ),
            1
        )
    }

    func testSignedRateReflectsDirectionAndPauseState() {
        XCTAssertEqual(
            TimelinePlaybackShuttle.signedRate(isPlaying: false, direction: .forward, speed: 4),
            0
        )
        XCTAssertEqual(
            TimelinePlaybackShuttle.signedRate(isPlaying: true, direction: .forward, speed: 2),
            2
        )
        XCTAssertEqual(
            TimelinePlaybackShuttle.signedRate(isPlaying: true, direction: .reverse, speed: 2),
            -2
        )
    }

    func testTransportPublishingClampsPlaybackSpeed() {
        XCTAssertEqual(TimelinePlaybackTransportPublishing.clampedSpeed(0), 1)
        XCTAssertEqual(TimelinePlaybackTransportPublishing.clampedSpeed(2.5), 2.5)
        XCTAssertEqual(
            TimelinePlaybackTransportPublishing.clampedSpeed(8),
            TimelinePlaybackShuttle.maximumSpeed
        )
    }

    func testTransportPublishingSuppressesUnchangedPlaybackState() {
        XCTAssertFalse(
            TimelinePlaybackTransportPublishing.shouldPublishDirection(previous: .forward, next: .forward)
        )
        XCTAssertTrue(
            TimelinePlaybackTransportPublishing.shouldPublishDirection(previous: .forward, next: .reverse)
        )
        XCTAssertFalse(
            TimelinePlaybackTransportPublishing.shouldPublishSpeed(previous: 2, next: 2)
        )
        XCTAssertTrue(
            TimelinePlaybackTransportPublishing.shouldPublishSpeed(previous: 2, next: 4)
        )
        XCTAssertFalse(
            TimelinePlaybackTransportPublishing.shouldPublishPlaying(previous: true, next: true)
        )
        XCTAssertTrue(
            TimelinePlaybackTransportPublishing.shouldPublishPlaying(previous: false, next: true)
        )
    }

    func testLoopRangeNormalizesToTimelineBounds() {
        let range = TimelinePlaybackRange(startFrame: 10, endFrame: 30)

        XCTAssertEqual(
            TimelinePlaybackLoop.normalizedRange(range, totalFrames: 24),
            TimelinePlaybackRange(startFrame: 10, endFrame: 24)
        )
        XCTAssertNil(
            TimelinePlaybackLoop.normalizedRange(TimelinePlaybackRange(startFrame: 24, endFrame: 30), totalFrames: 24)
        )
        XCTAssertNil(TimelinePlaybackRange(startFrame: 10, endFrame: 10))
    }

    func testLoopRangeCoversMultipleClips() {
        let clips = [
            makeClip(id: "CLP_B", timelineInFrame: 20, timelineDurationFrames: 12),
            makeClip(id: "CLP_A", timelineInFrame: 4, timelineDurationFrames: 8),
            makeClip(id: "CLP_EMPTY", timelineInFrame: 40, timelineDurationFrames: 0),
        ]

        XCTAssertEqual(
            TimelinePlaybackLoop.range(covering: clips),
            TimelinePlaybackRange(startFrame: 4, endFrame: 32)
        )
        XCTAssertNil(TimelinePlaybackLoop.range(covering: []))
        XCTAssertNil(TimelinePlaybackLoop.range(covering: [makeClip(id: "CLP_EMPTY", timelineInFrame: 4, timelineDurationFrames: 0)]))
    }

    func testTransitionReviewRangeCoversTransitionWithContext() throws {
        let timeline = try makeTransitionTimeline()
        let transition = try XCTUnwrap(timeline.transitions.first)

        XCTAssertEqual(
            TimelinePlaybackLoop.transitionReviewRange(timeline: timeline, transition: transition),
            TimelinePlaybackRange(startFrame: 12, endFrame: 36)
        )
    }

    func testLoopPreparesPlaybackStartInsideRange() {
        let range = TimelinePlaybackRange(startFrame: 10, endFrame: 20)!

        XCTAssertEqual(
            TimelinePlaybackLoop.preparedStartFrame(currentFrame: 4, direction: .forward, range: range),
            10
        )
        XCTAssertEqual(
            TimelinePlaybackLoop.preparedStartFrame(currentFrame: 15, direction: .forward, range: range),
            15
        )
        XCTAssertEqual(
            TimelinePlaybackLoop.preparedStartFrame(currentFrame: 10, direction: .reverse, range: range),
            19
        )
        XCTAssertEqual(
            TimelinePlaybackLoop.preparedStartFrame(currentFrame: 24, direction: .reverse, range: range),
            19
        )
    }

    func testLoopWrapsForwardAndReverseAcrossRangeEdges() {
        let range = TimelinePlaybackRange(startFrame: 10, endFrame: 20)!

        XCTAssertNil(TimelinePlaybackLoop.loopedFrame(proposedFrame: 19, direction: .forward, range: range))
        XCTAssertEqual(
            TimelinePlaybackLoop.loopedFrame(proposedFrame: 20, direction: .forward, range: range),
            10
        )
        XCTAssertEqual(
            TimelinePlaybackLoop.loopedFrame(proposedFrame: 23, direction: .forward, range: range),
            13
        )
        XCTAssertNil(TimelinePlaybackLoop.loopedFrame(proposedFrame: 10, direction: .reverse, range: range))
        XCTAssertEqual(
            TimelinePlaybackLoop.loopedFrame(proposedFrame: 9, direction: .reverse, range: range),
            19
        )
        XCTAssertEqual(
            TimelinePlaybackLoop.loopedFrame(proposedFrame: 7, direction: .reverse, range: range),
            17
        )
    }

    func testLoopPublishingSuppressesUnchangedRange() {
        let range = TimelinePlaybackRange(startFrame: 10, endFrame: 20)

        XCTAssertFalse(
            TimelinePlaybackLoopPublishing.shouldPublishRange(
                previous: range,
                next: TimelinePlaybackRange(startFrame: 10, endFrame: 20)
            )
        )
        XCTAssertFalse(
            TimelinePlaybackLoopPublishing.shouldPublishRange(previous: nil, next: nil)
        )
    }

    func testLoopPublishingAllowsChangedRangeAndEnabledState() {
        XCTAssertTrue(
            TimelinePlaybackLoopPublishing.shouldPublishRange(
                previous: TimelinePlaybackRange(startFrame: 10, endFrame: 20),
                next: TimelinePlaybackRange(startFrame: 12, endFrame: 24)
            )
        )
        XCTAssertTrue(
            TimelinePlaybackLoopPublishing.shouldPublishRange(
                previous: TimelinePlaybackRange(startFrame: 10, endFrame: 20),
                next: nil
            )
        )
        XCTAssertFalse(
            TimelinePlaybackLoopPublishing.shouldPublishEnabled(previous: true, next: true)
        )
        XCTAssertTrue(
            TimelinePlaybackLoopPublishing.shouldPublishEnabled(previous: false, next: true)
        )
    }

    private func makeClip(
        id: String,
        timelineInFrame: Int,
        timelineDurationFrames: Int
    ) -> TimelineClip {
        TimelineClip(
            id: id,
            segmentID: "SEG_\(id)",
            assetID: "AST_\(id)",
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            timelineInFrame: timelineInFrame,
            timelineDurationFrames: timelineDurationFrames,
            role: "support",
            motivation: "test",
            confidence: nil,
            beatID: nil,
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: nil
        )
    }

    private func makeTransitionTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "test-project",
          "sequence": {
            "name": "Test",
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
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "a"
                  },
                  {
                    "clip_id": "CLP_B",
                    "segment_id": "SEG_B",
                    "asset_id": "AST_B",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "b"
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
              "transition_id": "TRN_V1_CLP_A_CLP_B",
              "from_clip_id": "CLP_A",
              "to_clip_id": "CLP_B",
              "track_id": "V1",
              "transition_type": "crossfade",
              "transition_frames": 12,
              "applied_skill_id": "crossfade"
            }
          ]
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
