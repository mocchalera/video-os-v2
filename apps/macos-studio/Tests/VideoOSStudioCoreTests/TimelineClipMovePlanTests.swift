import XCTest
@testable import VideoOSStudioCore

final class TimelineClipMovePlanTests: XCTestCase {
    func testMoveSnapsClipStartToPreviousEditPoint() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: -11,
            snapThresholdFrames: 3,
            playheadFrame: 60,
            reason: "magnetic move"
        ))

        XCTAssertEqual(plan.targetClipID, "CLP_B")
        XCTAssertEqual(plan.trackID, "V1")
        XCTAssertEqual(plan.proposedTimelineInFrame, 37)
        XCTAssertEqual(plan.newTimelineInFrame, 36)
        XCTAssertEqual(plan.snap?.kind, .editPoint)
        XCTAssertEqual(plan.snap?.alignment, .start)
        XCTAssertEqual(plan.operations.map(\.opName), ["move_segment"])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, _) = plan.operations[0] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_B")
        XCTAssertEqual(timelineInFrame, 36)
        XCTAssertNil(durationFrames)
        XCTAssertNil(targetTrackID)
    }

    func testMoveSnapsClipEndToPlayhead() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_C"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 23,
            snapThresholdFrames: 3,
            playheadFrame: 132,
            reason: "snap end"
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 107)
        XCTAssertEqual(plan.newTimelineInFrame, 108)
        XCTAssertEqual(plan.snap?.kind, .playhead)
        XCTAssertEqual(plan.snap?.alignment, .end)
        XCTAssertEqual(plan.snap?.frame, 132)
    }

    func testMoveSnapsClipStartToMarker() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_C"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 28,
            snapThresholdFrames: 4,
            playheadFrame: 0,
            reason: "snap marker"
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 112)
        XCTAssertEqual(plan.newTimelineInFrame, 110)
        XCTAssertEqual(plan.snap?.kind, .marker)
        XCTAssertEqual(plan.snap?.label, "beat")
    }

    func testZeroSnapThresholdDisablesExactEditPointSnap() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: -12,
            snapThresholdFrames: 0,
            playheadFrame: 60,
            reason: "snapping off"
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 36)
        XCTAssertEqual(plan.newTimelineInFrame, 36)
        XCTAssertNil(plan.snap)
    }

    func testMoveLiftsOverlappingVideoClipToANewLane() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 60,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "overlap"
        ))

        XCTAssertEqual(plan.newTimelineInFrame, 60)
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_B", "CLP_C"])
        XCTAssertEqual(plan.displacements, [])
        XCTAssertEqual(plan.operations.map(\.opName), ["move_segment"])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, _) = plan.operations[0] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_A")
        XCTAssertEqual(timelineInFrame, 60)
        XCTAssertNil(durationFrames)
        XCTAssertEqual(targetTrackID, "V2")

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 60)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V1")
        XCTAssertEqual(moved.tracks.video.map(\.id), ["V1", "V2"])
    }

    func testMoveReusesOpenVideoLaneBeforeCreatingANewTrack() throws {
        let timeline = try makeTimelineWithSecondVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 60,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "overlap"
        ))

        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.createsTrack, false)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_B", "CLP_C"])
    }

    func testMoveCanTargetOpenCompatibleTrackWithoutChangingTiming() throws {
        let timeline = try makeTimelineWithSecondVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "vertical move",
            preferredTargetTrackID: "V2"
        ))

        XCTAssertEqual(plan.newTimelineInFrame, 0)
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertNil(plan.laneLift)
        XCTAssertEqual(plan.displacements, [])
        XCTAssertEqual(plan.operations.map(\.opName), ["move_segment"])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, _) = plan.operations[0] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_A")
        XCTAssertEqual(timelineInFrame, 0)
        XCTAssertNil(durationFrames)
        XCTAssertEqual(targetTrackID, "V2")

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 0)
    }

    func testMoveCreatesNewTargetTrackWhenExplicitTargetOverlapsAndNoOpenTrackExists() throws {
        let timeline = try makeTimelineWithOccupiedSecondVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "vertical move",
            preferredTargetTrackID: "V2"
        ))

        XCTAssertEqual(plan.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_BLOCKER"])
        XCTAssertEqual(plan.displacements, [])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, _) = plan.operations[0] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_A")
        XCTAssertEqual(timelineInFrame, 0)
        XCTAssertNil(durationFrames)
        XCTAssertEqual(targetTrackID, "V3")

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V3")
        XCTAssertEqual(moved.tracks.video.map(\.id), ["V1", "V2", "V3"])
    }

    func testMoveLiftsFromOccupiedExplicitTargetToOpenCompatibleTrack() throws {
        let timeline = try makeTimelineWithOccupiedSecondAndOpenThirdVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "vertical move",
            preferredTargetTrackID: "V2"
        ))

        XCTAssertEqual(plan.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.createsTrack, false)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_BLOCKER"])
        XCTAssertEqual(plan.displacements, [])

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V3")
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V2" })?.clips.map(\.id), ["CLP_BLOCKER"])
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V3" })?.clips.map(\.id), ["CLP_A"])
    }

    func testMoveRejectsExplicitTargetTrackWhenTrackKindDiffers() throws {
        let timeline = try makeTimelineWithAudioTargetTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        XCTAssertNil(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "vertical move",
            preferredTargetTrackID: "A1"
        ))
    }

    func testMoveLiftsOverlappingAudioClipToANewLane() throws {
        let timeline = try makeAudioTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "ACL_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 60,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "overlap audio"
        ))

        XCTAssertEqual(plan.newTimelineInFrame, 60)
        XCTAssertEqual(plan.targetTrackID, "A2")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "A1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "A2")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["ACL_B", "ACL_C"])
        XCTAssertEqual(plan.displacements, [])

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, _) = plan.operations[0] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "ACL_A")
        XCTAssertEqual(timelineInFrame, 60)
        XCTAssertNil(durationFrames)
        XCTAssertEqual(targetTrackID, "A2")

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "ACL_A")?.clip.timelineInFrame, 60)
        XCTAssertEqual(moved.clipSelection(for: "ACL_A")?.trackID, "A2")
        XCTAssertEqual(moved.clipSelection(for: "ACL_B")?.trackID, "A1")
        XCTAssertEqual(moved.tracks.audio.map(\.id), ["A1", "A2"])
    }

    func testMoveReusesOpenAudioLaneBeforeCreatingANewTrack() throws {
        let timeline = try makeAudioTimelineWithSecondAudioTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "ACL_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 60,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "overlap audio"
        ))

        XCTAssertEqual(plan.targetTrackID, "A2")
        XCTAssertEqual(plan.laneLift?.createsTrack, false)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["ACL_B", "ACL_C"])
        XCTAssertEqual(plan.displacements, [])
    }

    func testHalfSecondNudgeMovesClipExactlyAndUpdatesImmediateTimeline() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: -12,
            snapThresholdFrames: 0,
            playheadFrame: 36,
            reason: "toolbar nudge"
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 36)
        XCTAssertEqual(plan.newTimelineInFrame, 36)
        XCTAssertNil(plan.snap)
        XCTAssertEqual(plan.operations.map(\.opName), ["move_segment"])

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.clip.timelineInFrame, 36)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V1")
        XCTAssertEqual(moved.clipSelection(for: "CLP_C")?.clip.timelineInFrame, 84)
    }

    func testHalfSecondNudgeIntoOverlapLiftsClipToNewLane() throws {
        let timeline = try makeAdjacentGroupTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: 12,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "toolbar nudge overlap"
        ))

        XCTAssertEqual(plan.newTimelineInFrame, 12)
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_B"])

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 12)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V1")
        XCTAssertEqual(moved.tracks.video.map(\.id), ["V1", "V2"])
    }

    func testMovingClipReturnsTimelineWithUpdatedDisplayPosition() throws {
        let timeline = try makeTimeline()

        let moved = try XCTUnwrap(timeline.movingClip("CLP_B", toTimelineInFrame: 36))

        XCTAssertEqual(timeline.clipSelection(for: "CLP_B")?.clip.timelineInFrame, 48)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.clip.timelineInFrame, 36)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.clip.timelineDurationFrames, 24)
        XCTAssertEqual(moved.sourceHash, timeline.sourceHash)
    }

    func testMovingClipCanCreateTargetTrackForImmediateDisplay() throws {
        let timeline = try makeTimeline()

        let moved = try XCTUnwrap(timeline.movingClip("CLP_A", toTimelineInFrame: 60, targetTrackID: "V2"))

        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V1" })?.clips.map(\.id), ["CLP_B", "CLP_C"])
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V2" })?.clips.map(\.id), ["CLP_A"])
    }

    func testMovingClipToAnotherTrackDropsStaleTransitionsForImmediateDisplay() throws {
        let timeline = try makeTimeline()
        let transitioned = TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: timeline.tracks,
            markers: timeline.markers,
            transitions: [
                TimelineTransition(
                    id: "TRN_DROP",
                    fromClipID: "CLP_A",
                    toClipID: "CLP_B",
                    trackID: "V1",
                    transitionType: "crossfade",
                    transitionFrames: 12,
                    appliedSkillID: "ui.crossfade_bridge"
                ),
                TimelineTransition(
                    id: "TRN_KEEP",
                    fromClipID: "CLP_B",
                    toClipID: "CLP_C",
                    trackID: "V1",
                    transitionType: "crossfade",
                    transitionFrames: 12,
                    appliedSkillID: "ui.crossfade_bridge"
                )
            ],
            sourceHash: timeline.sourceHash
        )

        let moved = try XCTUnwrap(transitioned.movingClip("CLP_A", toTimelineInFrame: 60, targetTrackID: "V2"))

        XCTAssertEqual(moved.transitions.map(\.id), ["TRN_KEEP"])
    }

    func testGroupMoveMovesSelectedClipsTogetherByResolvedAnchorDelta() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 12,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "group move"
        ))

        XCTAssertEqual(plan.targetClipID, "CLP_A")
        XCTAssertEqual(plan.movedClipIDs, ["CLP_A", "CLP_B"])
        XCTAssertEqual(plan.resolvedFrameDelta, 12)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_A"), 12)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_B"), 60)
        XCTAssertEqual(plan.displacements, [])
        XCTAssertEqual(plan.operations.map(\.opName), ["move_segment", "move_segment"])

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 12)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.clip.timelineInFrame, 60)
        XCTAssertEqual(moved.clipSelection(for: "CLP_C")?.clip.timelineInFrame, 84)
    }

    func testGroupMoveDoesNotSnapAnchorToAnotherSelectedClip() throws {
        let timeline = try makeAdjacentGroupTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 8,
            snapThresholdFrames: 3,
            playheadFrame: 90,
            reason: "group move"
        ))

        XCTAssertEqual(plan.resolvedFrameDelta, 8)
        XCTAssertNil(plan.snap)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_A"), 8)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_B"), 38)
    }

    func testGroupMoveLiftsSelectedClipsToNewLaneWhenImplicitMoveOverlapsUnselectedClip() throws {
        let timeline = try makeDenseGroupTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 12,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "group move"
        ))

        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_A"), 12)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_B"), 36)
        XCTAssertEqual(plan.sourceTrackID, "V1")
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_C"])
        XCTAssertEqual(plan.displacements, [])

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 12)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.clip.timelineInFrame, 36)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_C")?.trackID, "V1")
        XCTAssertEqual(moved.clipSelection(for: "CLP_C")?.clip.timelineInFrame, 36)
        XCTAssertEqual(moved.tracks.video.map(\.id), ["V1", "V2"])
    }

    func testGroupMoveReusesOpenLaneWhenImplicitMoveOverlapsUnselectedClip() throws {
        let timeline = try makeDenseGroupTimelineWithSecondVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 12,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "group move"
        ))

        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.createsTrack, false)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_C"])
        XCTAssertEqual(plan.displacements, [])

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V2")
        XCTAssertEqual(moved.tracks.video.map(\.id), ["V1", "V2"])
    }

    func testGroupMoveCanTargetOpenCompatibleTrackWithoutChangingTiming() throws {
        let timeline = try makeTimelineWithSecondVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "group vertical move",
            preferredTargetTrackID: "V2"
        ))

        XCTAssertEqual(plan.sourceTrackID, "V1")
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.resolvedFrameDelta, 0)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_A"), 0)
        XCTAssertEqual(plan.newTimelineInFrame(for: "CLP_B"), 48)
        XCTAssertEqual(plan.displacements, [])
        XCTAssertEqual(plan.operations.map(\.opName), ["move_segment", "move_segment"])

        for operation in plan.operations {
            guard case let .moveSegment(_, _, _, targetTrackID, _) = operation else {
                return XCTFail("Expected move_segment")
            }
            XCTAssertEqual(targetTrackID, "V2")
        }

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V2")
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 0)
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.clip.timelineInFrame, 48)
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V1" })?.clips.map(\.id), ["CLP_C"])
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V2" })?.clips.map(\.id), ["CLP_A", "CLP_B"])
    }

    func testGroupMoveLiftsFromOccupiedExplicitTargetToOpenCompatibleTrack() throws {
        let timeline = try makeTimelineWithOccupiedSecondAndOpenThirdVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "group vertical move",
            preferredTargetTrackID: "V2"
        ))

        XCTAssertEqual(plan.sourceTrackID, "V1")
        XCTAssertEqual(plan.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.createsTrack, false)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_BLOCKER"])
        XCTAssertEqual(plan.resolvedFrameDelta, 0)
        XCTAssertEqual(plan.displacements, [])

        for operation in plan.operations {
            guard case let .moveSegment(_, _, _, targetTrackID, _) = operation else {
                return XCTFail("Expected move_segment")
            }
            XCTAssertEqual(targetTrackID, "V3")
        }

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V3")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V3")
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V2" })?.clips.map(\.id), ["CLP_BLOCKER"])
        XCTAssertEqual(moved.tracks.video.first(where: { $0.id == "V3" })?.clips.map(\.id), ["CLP_A", "CLP_B"])
    }

    func testGroupMoveCreatesNewTargetTrackWhenExplicitTargetOverlapsAndNoOpenTrackExists() throws {
        let timeline = try makeTimelineWithOccupiedSecondVideoTrack()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_A"))

        let plan = try XCTUnwrap(TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: selection,
            selectedClipIDs: ["CLP_A", "CLP_B"],
            frameDelta: 0,
            snapThresholdFrames: 0,
            playheadFrame: 0,
            reason: "group vertical move",
            preferredTargetTrackID: "V2"
        ))

        XCTAssertEqual(plan.sourceTrackID, "V1")
        XCTAssertEqual(plan.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.sourceTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_BLOCKER"])
        XCTAssertEqual(plan.resolvedFrameDelta, 0)

        let moved = timeline.applyingTimelineMoveOperations(plan.operations)
        XCTAssertEqual(moved.clipSelection(for: "CLP_A")?.trackID, "V3")
        XCTAssertEqual(moved.clipSelection(for: "CLP_B")?.trackID, "V3")
        XCTAssertEqual(moved.tracks.video.map(\.id), ["V1", "V2", "V3"])
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "move-test",
          "sequence": {
            "name": "Move Test",
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
                    "role": "support",
                    "motivation": "a"
                  },
                  {
                    "clip_id": "CLP_B",
                    "segment_id": "SEG_B",
                    "asset_id": "AST_B",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 48,
                    "timeline_duration_frames": 24,
                    "role": "dialogue",
                    "motivation": "b"
                  },
                  {
                    "clip_id": "CLP_C",
                    "segment_id": "SEG_C",
                    "asset_id": "AST_C",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 84,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "c"
                  }
                ]
              }
            ],
            "audio": [],
            "overlay": [],
            "caption": []
          },
          "markers": [
            { "marker_id": "MKR_beat", "frame": 110, "label": "beat", "kind": "beat" },
            { "marker_id": "MKR_tail", "frame": 140, "label": "tail", "kind": "marker" }
          ]
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }

    private func makeAdjacentGroupTimeline() throws -> TimelineDocument {
        try makeCustomVideoTimeline(clips: [
            ("CLP_A", 0, 24),
            ("CLP_B", 30, 24),
            ("CLP_C", 90, 24)
        ])
    }

    private func makeDenseGroupTimeline() throws -> TimelineDocument {
        try makeCustomVideoTimeline(clips: [
            ("CLP_A", 0, 24),
            ("CLP_B", 24, 24),
            ("CLP_C", 36, 24)
        ])
    }

    private func makeDenseGroupTimelineWithSecondVideoTrack() throws -> TimelineDocument {
        let timeline = try makeDenseGroupTimeline()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video + [TimelineTrack(id: "V2", kind: .video, clips: [])],
                audio: timeline.tracks.audio,
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeTimelineWithSecondVideoTrack() throws -> TimelineDocument {
        let timeline = try makeTimeline()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video + [TimelineTrack(id: "V2", kind: .video, clips: [])],
                audio: timeline.tracks.audio,
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeTimelineWithOccupiedSecondVideoTrack() throws -> TimelineDocument {
        let timeline = try makeTimeline()
        let source = try XCTUnwrap(timeline.tracks.video.first?.clips.first)
        let blocker = TimelineClip(
            id: "CLP_BLOCKER",
            segmentID: "SEG_BLOCKER",
            assetID: source.assetID,
            sourceInUS: source.sourceInUS,
            sourceOutUS: source.sourceOutUS,
            timelineInFrame: 0,
            timelineDurationFrames: 36,
            role: source.role,
            motivation: "target track blocker",
            confidence: source.confidence,
            beatID: source.beatID,
            fallbackSegmentIDs: source.fallbackSegmentIDs,
            qualityFlags: source.qualityFlags,
            candidateRef: source.candidateRef
        )
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video + [TimelineTrack(id: "V2", kind: .video, clips: [blocker])],
                audio: timeline.tracks.audio,
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeTimelineWithOccupiedSecondAndOpenThirdVideoTrack() throws -> TimelineDocument {
        let timeline = try makeTimelineWithOccupiedSecondVideoTrack()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video + [TimelineTrack(id: "V3", kind: .video, clips: [])],
                audio: timeline.tracks.audio,
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeTimelineWithAudioTargetTrack() throws -> TimelineDocument {
        let timeline = try makeTimeline()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video,
                audio: [TimelineTrack(id: "A1", kind: .audio, clips: [])],
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeAudioTimeline() throws -> TimelineDocument {
        let videoTimeline = try makeTimeline()
        let audioClips = try XCTUnwrap(videoTimeline.tracks.video.first?.clips).enumerated().map { index, clip in
            TimelineClip(
                id: "ACL_\(String(UnicodeScalar(65 + index)!))",
                segmentID: "ASEG_\(index)",
                assetID: "AAST_\(index)",
                sourceInUS: clip.sourceInUS,
                sourceOutUS: clip.sourceOutUS,
                timelineInFrame: clip.timelineInFrame,
                timelineDurationFrames: clip.timelineDurationFrames,
                role: "dialogue",
                motivation: clip.motivation,
                confidence: clip.confidence,
                beatID: clip.beatID,
                fallbackSegmentIDs: clip.fallbackSegmentIDs,
                qualityFlags: clip.qualityFlags,
                candidateRef: clip.candidateRef
            )
        }
        return TimelineDocument(
            version: videoTimeline.version,
            projectID: videoTimeline.projectID,
            sequence: videoTimeline.sequence,
            tracks: TimelineTrackCollection(
                video: [],
                audio: [TimelineTrack(id: "A1", kind: .audio, clips: audioClips)],
                overlay: [],
                caption: []
            ),
            markers: videoTimeline.markers,
            transitions: [],
            sourceHash: videoTimeline.sourceHash
        )
    }

    private func makeAudioTimelineWithSecondAudioTrack() throws -> TimelineDocument {
        let timeline = try makeAudioTimeline()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video,
                audio: timeline.tracks.audio + [TimelineTrack(id: "A2", kind: .audio, clips: [])],
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeCustomVideoTimeline(clips: [(id: String, timelineInFrame: Int, durationFrames: Int)]) throws -> TimelineDocument {
        let videoClips = clips.enumerated().map { index, item in
            TimelineClip(
                id: item.id,
                segmentID: "SEG_\(index)",
                assetID: "AST_\(index)",
                sourceInUS: 0,
                sourceOutUS: item.durationFrames * 1_000_000 / 24,
                timelineInFrame: item.timelineInFrame,
                timelineDurationFrames: item.durationFrames,
                role: index == 1 ? "dialogue" : "support",
                motivation: item.id,
                confidence: nil,
                beatID: nil,
                fallbackSegmentIDs: [],
                qualityFlags: [],
                candidateRef: nil
            )
        }
        let sequence = TimelineSequence(
            name: "Group Move Test",
            fpsNum: 24,
            fpsDen: 1,
            width: 1920,
            height: 1080,
            startFrame: 0,
            outputAspectRatio: nil
        )
        return TimelineDocument(
            version: "1",
            projectID: "group-move-test",
            sequence: sequence,
            tracks: TimelineTrackCollection(
                video: [TimelineTrack(id: "V1", kind: .video, clips: videoClips)],
                audio: [],
                overlay: [],
                caption: []
            ),
            markers: [],
            transitions: []
        )
    }
}
