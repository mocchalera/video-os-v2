import XCTest
@testable import VideoOSStudioCore

@MainActor
final class TimelineRippleDeletePlanTests: XCTestCase {
    func testPlanRemovesSelectedClipAndMovesFollowingClipsOnSameTrack() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))

        let plan = try XCTUnwrap(TimelineRippleDeletePlan.make(
            timeline: timeline,
            selection: selection,
            reason: "Ripple delete"
        ))

        XCTAssertEqual(plan.deletedClipID, "CLP_B")
        XCTAssertEqual(plan.trackID, "V1")
        XCTAssertEqual(plan.shiftFrames, 12)
        XCTAssertEqual(plan.movedClipIDs, ["CLP_C"])
        XCTAssertEqual(plan.operations.map(\.opName), ["remove_segment", "move_segment"])

        guard case let .removeSegment(targetClipID, _) = plan.operations[0] else {
            return XCTFail("Expected remove_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_B")

        guard case let .moveSegment(targetClipID, timelineInFrame, durationFrames, _, _) = plan.operations[1] else {
            return XCTFail("Expected move_segment")
        }
        XCTAssertEqual(targetClipID, "CLP_C")
        XCTAssertEqual(timelineInFrame, 36)
        XCTAssertNil(durationFrames)
    }

    func testPlanKeepsDeleteOnlyWhenThereAreNoFollowingClips() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_C"))

        let plan = try XCTUnwrap(TimelineRippleDeletePlan.make(
            timeline: timeline,
            selection: selection,
            reason: "Ripple delete"
        ))

        XCTAssertEqual(plan.movedClipIDs, [])
        XCTAssertEqual(plan.operations.map(\.opName), ["remove_segment"])
    }

    func testApplyingRippleDeleteRemovesClipAndMovesFollowingClipsImmediately() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))
        let plan = try XCTUnwrap(TimelineRippleDeletePlan.make(
            timeline: timeline,
            selection: selection,
            reason: "Ripple delete"
        ))

        let updatedTimeline = try XCTUnwrap(timeline.applyingRippleDelete(plan))
        let remainingIDs = updatedTimeline.displayTracks.flatMap(\.clips).map(\.id)

        XCTAssertFalse(remainingIDs.contains("CLP_B"))
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_C")?.clip.timelineInFrame, 36)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 0)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_AUD")?.clip.timelineInFrame, 48)
    }

    func testGroupPlanRemovesMultipleClipsAndMovesFollowersByCumulativeDeletedDuration() throws {
        let timeline = try makeMultiDeleteTimeline()

        let plan = try XCTUnwrap(TimelineRippleDeleteGroupPlan.make(
            timeline: timeline,
            clipIDs: ["CLP_B", "CLP_D"],
            reason: "Ripple delete selection"
        ))

        XCTAssertEqual(plan.deletedClipIDs, ["CLP_B", "CLP_D"])
        XCTAssertEqual(plan.trackID, "V1")
        XCTAssertEqual(plan.shiftFrames, 15)
        XCTAssertEqual(plan.movedClipIDs, ["CLP_C", "CLP_E"])
        XCTAssertEqual(plan.operations.map(\.opName), [
            "remove_segment",
            "remove_segment",
            "move_segment",
            "move_segment"
        ])

        guard case let .moveSegment(firstMovedID, firstFrame, _, _, _) = plan.operations[2] else {
            return XCTFail("Expected first move_segment")
        }
        XCTAssertEqual(firstMovedID, "CLP_C")
        XCTAssertEqual(firstFrame, 15)

        guard case let .moveSegment(secondMovedID, secondFrame, _, _, _) = plan.operations[3] else {
            return XCTFail("Expected second move_segment")
        }
        XCTAssertEqual(secondMovedID, "CLP_E")
        XCTAssertEqual(secondFrame, 30)

        let updatedTimeline = try XCTUnwrap(timeline.applyingRippleDelete(plan))
        let remainingIDs = updatedTimeline.displayTracks.flatMap(\.clips).map(\.id)
        XCTAssertFalse(remainingIDs.contains("CLP_B"))
        XCTAssertFalse(remainingIDs.contains("CLP_D"))
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_A")?.clip.timelineInFrame, 0)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_C")?.clip.timelineInFrame, 15)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_E")?.clip.timelineInFrame, 30)
    }

    func testGroupPlanRejectsSelectionsAcrossTracks() throws {
        let timeline = try makeTimeline()

        XCTAssertNil(TimelineRippleDeleteGroupPlan.make(
            timeline: timeline,
            clipIDs: ["CLP_B", "CLP_AUD"],
            reason: "Ripple delete selection"
        ))
    }

    func testGroupPlanRippleDeletesAlignedCrossTrackSelectionWithSharedShift() throws {
        let timeline = try makeCrossTrackRippleTimeline()

        let plan = try XCTUnwrap(TimelineRippleDeleteGroupPlan.make(
            timeline: timeline,
            clipIDs: ["CLP_V_DELETE", "CLP_A_DELETE"],
            reason: "Ripple delete aligned selection"
        ))

        XCTAssertEqual(plan.deletedClipIDs, ["CLP_V_DELETE", "CLP_A_DELETE"])
        XCTAssertEqual(plan.trackID, "V1")
        XCTAssertEqual(plan.trackIDs, ["V1", "A1"])
        XCTAssertEqual(plan.shiftFrames, 12)
        XCTAssertEqual(plan.rangeInFrame, 24)
        XCTAssertEqual(plan.rangeOutFrame, 36)
        XCTAssertTrue(plan.isCrossTrackRipple)
        XCTAssertEqual(plan.movedClipIDs, ["CLP_V_AFTER", "CLP_A_AFTER"])
        XCTAssertEqual(plan.operations.map(\.opName), [
            "remove_segment",
            "remove_segment",
            "move_segment",
            "move_segment"
        ])

        let updatedTimeline = try XCTUnwrap(timeline.applyingRippleDelete(plan))
        let remainingIDs = updatedTimeline.displayTracks.flatMap(\.clips).map(\.id)
        XCTAssertFalse(remainingIDs.contains("CLP_V_DELETE"))
        XCTAssertFalse(remainingIDs.contains("CLP_A_DELETE"))
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_V_AFTER")?.clip.timelineInFrame, 36)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_A_AFTER")?.clip.timelineInFrame, 36)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_V_BEFORE")?.clip.timelineInFrame, 0)
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_A_BEFORE")?.clip.timelineInFrame, 0)
    }

    func testGroupPlanRejectsCrossTrackSelectionWhenRangesDoNotAlign() throws {
        let timeline = try makeCrossTrackRippleTimeline()

        XCTAssertNil(TimelineRippleDeleteGroupPlan.make(
            timeline: timeline,
            clipIDs: ["CLP_V_DELETE", "CLP_A_AFTER"],
            reason: "Ripple delete misaligned selection"
        ))
    }

    func testLiftDeletePlanRemovesCrossTrackSelectionWithoutMovingFollowers() throws {
        let timeline = try makeTimelineWithTransition()

        let plan = try XCTUnwrap(TimelineLiftDeletePlan.make(
            timeline: timeline,
            clipIDs: ["CLP_B", "CLP_AUD"],
            reason: "Lift delete selection"
        ))

        XCTAssertEqual(plan.deletedClipIDs, ["CLP_B", "CLP_AUD"])
        XCTAssertEqual(plan.trackIDs, ["V1", "A1"])
        XCTAssertEqual(plan.operations.map(\.opName), ["remove_segment", "remove_segment"])

        let updatedTimeline = try XCTUnwrap(timeline.applyingLiftDelete(plan))
        let remainingIDs = updatedTimeline.displayTracks.flatMap(\.clips).map(\.id)
        XCTAssertFalse(remainingIDs.contains("CLP_B"))
        XCTAssertFalse(remainingIDs.contains("CLP_AUD"))
        XCTAssertEqual(updatedTimeline.clipSelection(for: "CLP_C")?.clip.timelineInFrame, 48)
        XCTAssertTrue(updatedTimeline.transitions.isEmpty)
    }

    func testQueueRippleDeleteClearsDeletedClipEditsAndSkipsRemovedFollowers() throws {
        let timeline = try makeTimeline()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "CLP_B"))
        let plan = try XCTUnwrap(TimelineRippleDeletePlan.make(
            timeline: timeline,
            selection: selection,
            reason: "Ripple delete"
        ))
        let session = StudioFeedbackSession()

        session.addOp(.trimSegment(
            target_clip_id: "CLP_B",
            new_src_in_us: 100,
            new_src_out_us: 900,
            reason: "trim"
        ))
        session.addOp(.removeSegment(target_clip_id: "CLP_C", reason: "remove later clip"))

        session.queueRippleDelete(plan)

        XCTAssertEqual(session.pendingOps.map(\.opName), ["remove_segment", "remove_segment"])
        XCTAssertTrue(session.hasPendingRemove(for: "CLP_B"))
        XCTAssertTrue(session.hasPendingRemove(for: "CLP_C"))
        XCTAssertFalse(session.hasPendingTrim(for: "CLP_B"))
        XCTAssertFalse(session.hasPendingMove(for: "CLP_C"))
        XCTAssertTrue(session.rejectedClipIDs.contains("CLP_B"))
        XCTAssertTrue(session.detectConflicts().isEmpty)
    }

    func testQueueGroupRippleDeleteClearsDeletedClipEditsAndTransitionReferences() throws {
        let timeline = try makeMultiDeleteTimeline()
        let plan = try XCTUnwrap(TimelineRippleDeleteGroupPlan.make(
            timeline: timeline,
            clipIDs: ["CLP_B", "CLP_D"],
            reason: "Ripple delete selection"
        ))
        let session = StudioFeedbackSession()

        session.addOp(.trimSegment(
            target_clip_id: "CLP_B",
            new_src_in_us: 100,
            new_src_out_us: 900,
            reason: "trim"
        ))
        session.addOp(.setTransition(
            from_clip_id: "CLP_B",
            to_clip_id: "CLP_C",
            track_id: "V1",
            transition_type: "crossfade",
            transition_frames: 12,
            applied_skill_id: nil,
            reason: "transition"
        ))

        session.queueRippleDelete(plan)

        XCTAssertEqual(session.pendingOps.map(\.opName), [
            "remove_segment",
            "remove_segment",
            "move_segment",
            "move_segment"
        ])
        XCTAssertTrue(session.hasPendingRemove(for: "CLP_B"))
        XCTAssertTrue(session.hasPendingRemove(for: "CLP_D"))
        XCTAssertFalse(session.hasPendingTrim(for: "CLP_B"))
        XCTAssertFalse(session.pendingOps.contains { $0.opName == "set_transition" })
        XCTAssertEqual(session.rejectedClipIDs, ["CLP_B", "CLP_D"])
        XCTAssertTrue(session.detectConflicts().isEmpty)
    }

    func testQueueLiftDeleteClearsDeletedClipEditsAndTransitionReferences() throws {
        let timeline = try makeTimelineWithTransition()
        let plan = try XCTUnwrap(TimelineLiftDeletePlan.make(
            timeline: timeline,
            clipIDs: ["CLP_B", "CLP_AUD"],
            reason: "Lift delete selection"
        ))
        let session = StudioFeedbackSession()

        session.addOp(.trimSegment(
            target_clip_id: "CLP_B",
            new_src_in_us: 100,
            new_src_out_us: 900,
            reason: "trim"
        ))
        session.addOp(.setTransition(
            from_clip_id: "CLP_B",
            to_clip_id: "CLP_C",
            track_id: "V1",
            transition_type: "crossfade",
            transition_frames: 12,
            applied_skill_id: nil,
            reason: "transition"
        ))

        session.queueLiftDelete(plan)

        XCTAssertEqual(session.pendingOps.map(\.opName), ["remove_segment", "remove_segment"])
        XCTAssertTrue(session.hasPendingRemove(for: "CLP_B"))
        XCTAssertTrue(session.hasPendingRemove(for: "CLP_AUD"))
        XCTAssertFalse(session.hasPendingTrim(for: "CLP_B"))
        XCTAssertFalse(session.pendingOps.contains { $0.opName == "set_transition" })
        XCTAssertEqual(session.rejectedClipIDs, ["CLP_AUD", "CLP_B"])
        XCTAssertTrue(session.detectConflicts().isEmpty)
    }

    private func makeTimeline() throws -> TimelineDocument {
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
                    "src_out_us": 500000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 12,
                    "role": "dialogue",
                    "motivation": "b"
                  },
                  {
                    "clip_id": "CLP_C",
                    "segment_id": "SEG_C",
                    "asset_id": "AST_C",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 48,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "c"
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
                    "clip_id": "CLP_AUD",
                    "segment_id": "SEG_AUD",
                    "asset_id": "AST_AUD",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 48,
                    "timeline_duration_frames": 24,
                    "role": "music",
                    "motivation": "audio"
                  }
                ]
              }
            ],
            "overlay": [],
            "caption": []
          },
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }

    private func makeTimelineWithTransition() throws -> TimelineDocument {
        let timeline = try makeTimeline()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: timeline.tracks,
            markers: timeline.markers,
            transitions: [
                TimelineTransition(
                    id: TimelineTransition.stableID(trackID: "V1", fromClipID: "CLP_B", toClipID: "CLP_C"),
                    fromClipID: "CLP_B",
                    toClipID: "CLP_C",
                    trackID: "V1",
                    transitionType: "crossfade",
                    transitionFrames: 12,
                    appliedSkillID: nil
                )
            ],
            sourceHash: timeline.sourceHash
        )
    }

    private func makeMultiDeleteTimeline() throws -> TimelineDocument {
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
                    "timeline_duration_frames": 10,
                    "role": "support",
                    "motivation": "a"
                  },
                  {
                    "clip_id": "CLP_B",
                    "segment_id": "SEG_B",
                    "asset_id": "AST_B",
                    "src_in_us": 0,
                    "src_out_us": 500000,
                    "timeline_in_frame": 10,
                    "timeline_duration_frames": 5,
                    "role": "dialogue",
                    "motivation": "b"
                  },
                  {
                    "clip_id": "CLP_C",
                    "segment_id": "SEG_C",
                    "asset_id": "AST_C",
                    "src_in_us": 0,
                    "src_out_us": 500000,
                    "timeline_in_frame": 20,
                    "timeline_duration_frames": 5,
                    "role": "support",
                    "motivation": "c"
                  },
                  {
                    "clip_id": "CLP_D",
                    "segment_id": "SEG_D",
                    "asset_id": "AST_D",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 30,
                    "timeline_duration_frames": 10,
                    "role": "support",
                    "motivation": "d"
                  },
                  {
                    "clip_id": "CLP_E",
                    "segment_id": "SEG_E",
                    "asset_id": "AST_E",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 45,
                    "timeline_duration_frames": 10,
                    "role": "support",
                    "motivation": "e"
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

    private func makeCrossTrackRippleTimeline() throws -> TimelineDocument {
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
                    "clip_id": "CLP_V_BEFORE",
                    "segment_id": "SEG_V_BEFORE",
                    "asset_id": "AST_V_BEFORE",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "before"
                  },
                  {
                    "clip_id": "CLP_V_DELETE",
                    "segment_id": "SEG_V_DELETE",
                    "asset_id": "AST_V_DELETE",
                    "src_in_us": 0,
                    "src_out_us": 500000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 12,
                    "role": "dialogue",
                    "motivation": "delete"
                  },
                  {
                    "clip_id": "CLP_V_AFTER",
                    "segment_id": "SEG_V_AFTER",
                    "asset_id": "AST_V_AFTER",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 48,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "after"
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
                    "clip_id": "CLP_A_BEFORE",
                    "segment_id": "SEG_A_BEFORE",
                    "asset_id": "AST_A_BEFORE",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "dialogue",
                    "motivation": "before audio"
                  },
                  {
                    "clip_id": "CLP_A_DELETE",
                    "segment_id": "SEG_A_DELETE",
                    "asset_id": "AST_A_DELETE",
                    "src_in_us": 0,
                    "src_out_us": 500000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 12,
                    "role": "dialogue",
                    "motivation": "delete audio"
                  },
                  {
                    "clip_id": "CLP_A_AFTER",
                    "segment_id": "SEG_A_AFTER",
                    "asset_id": "AST_A_AFTER",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 48,
                    "timeline_duration_frames": 24,
                    "role": "dialogue",
                    "motivation": "after audio"
                  }
                ]
              }
            ],
            "overlay": [],
            "caption": []
          },
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
