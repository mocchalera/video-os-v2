import XCTest
@testable import VideoOSStudioCore

final class TimelineTransitionDropPlanTests: XCTestCase {
    func testDefaultTransitionPresetIsCrossfade() {
        XCTAssertEqual(TimelineTransitionPreset.defaultPreset, .crossfade)
        XCTAssertTrue(TimelineTransitionPreset.defaultPreset.isDefaultPreset)
        XCTAssertEqual(TimelineTransitionPreset.defaultPreset.transitionType, "crossfade")
        XCTAssertEqual(TimelineTransitionPreset.defaultPreset.appliedSkillID, "ui.crossfade_bridge")
    }

    func testTransitionPresetLabelsAreJapaneseForTimelinePalette() {
        XCTAssertEqual(TimelineTransitionPreset.crossfade.localizedLabel, "クロスフェード")
        XCTAssertEqual(TimelineTransitionPreset.dipToBlack.localizedLabel, "黒へディップ")
        XCTAssertEqual(TimelineTransitionPreset.matchCutSoft.localizedLabel, "ソフトカット")
    }

    func testPlanCreatesSetTransitionOperationForAdjacentVideoEditPoint() throws {
        let timeline = try makeTimeline()

        let plan = try XCTUnwrap(TimelineTransitionDropPlan.make(
            timeline: timeline,
            trackID: "V1",
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            preset: .crossfade,
            reason: "drop transition"
        ))

        XCTAssertEqual(plan.trackID, "V1")
        XCTAssertEqual(plan.fromClipID, "CLP_A")
        XCTAssertEqual(plan.toClipID, "CLP_B")
        XCTAssertEqual(plan.boundaryFrame, 24)
        XCTAssertEqual(plan.transitionFrames, 12)
        XCTAssertEqual(plan.operations.map(\.opName), ["set_transition"])

        guard case let .setTransition(fromClipID, toClipID, trackID, transitionType, frames, skillID, _) = plan.operations[0] else {
            return XCTFail("Expected set_transition")
        }
        XCTAssertEqual(fromClipID, "CLP_A")
        XCTAssertEqual(toClipID, "CLP_B")
        XCTAssertEqual(trackID, "V1")
        XCTAssertEqual(transitionType, "crossfade")
        XCTAssertEqual(frames, 12)
        XCTAssertEqual(skillID, "ui.crossfade_bridge")
    }

    func testPlanClampsTransitionFramesToShorterClip() throws {
        let timeline = try makeTimeline()

        let plan = try XCTUnwrap(TimelineTransitionDropPlan.make(
            timeline: timeline,
            trackID: "V1",
            fromClipID: "CLP_B",
            toClipID: "CLP_C",
            preset: .dipToBlack,
            reason: "drop dip"
        ))

        XCTAssertEqual(plan.transitionFrames, 8)
    }

    func testPlanRejectsGappedOrAudioTargets() throws {
        let timeline = try makeTimeline()

        XCTAssertNil(TimelineTransitionDropPlan.make(
            timeline: timeline,
            trackID: "V1",
            fromClipID: "CLP_C",
            toClipID: "CLP_D",
            preset: .crossfade,
            reason: "gapped"
        ))

        XCTAssertNil(TimelineTransitionDropPlan.make(
            timeline: timeline,
            trackID: "A1",
            fromClipID: "ACL_A",
            toClipID: "ACL_B",
            preset: .crossfade,
            reason: "audio"
        ))
    }

    func testSettingTransitionReturnsTimelineWithVisibleTransition() throws {
        let timeline = try makeTimeline()

        let updated = try XCTUnwrap(timeline.settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))

        XCTAssertTrue(timeline.transitions.isEmpty)
        XCTAssertEqual(updated.transitions.count, 1)
        XCTAssertEqual(updated.transitions[0].id, "TRN_V1_CLP_A_CLP_B")
        XCTAssertEqual(updated.transitions[0].transitionFrames, 12)
        XCTAssertEqual(updated.transitionHandles(trackID: "V1", fromClipID: "CLP_A", toClipID: "CLP_B"), 24)
    }

    func testDropPlanBuildsHoverPreviewTimelineAtBoundary() throws {
        let timeline = try makeTimeline()
        let plan = try XCTUnwrap(TimelineTransitionDropPlan.make(
            timeline: timeline,
            trackID: "V1",
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            preset: .crossfade,
            reason: "hover transition"
        ))

        let previewTimeline = try XCTUnwrap(timeline.settingTransition(
            fromClipID: plan.fromClipID,
            toClipID: plan.toClipID,
            trackID: plan.trackID,
            transitionType: plan.preset.transitionType,
            transitionFrames: plan.transitionFrames,
            appliedSkillID: plan.preset.appliedSkillID
        ))
        let preview = try XCTUnwrap(previewTimeline.activeVisualTransitionPreview(atFrame: plan.boundaryFrame))

        XCTAssertEqual(preview.transition.id, "TRN_V1_CLP_A_CLP_B")
        XCTAssertEqual(preview.transition.transitionType, "crossfade")
        XCTAssertEqual(preview.transition.transitionFrames, 12)
        XCTAssertEqual(preview.boundaryFrame, plan.boundaryFrame)
        XCTAssertEqual(preview.overlaySelection.clip.id, "CLP_A")
        XCTAssertEqual(preview.overlayOpacity, 0.5, accuracy: 0.001)
    }

    func testTransitionPreviewPublishingSuppressesIdenticalSelectedPreview() {
        let preview = TimelineTransitionDurationPreview(
            transitionID: "TRN_V1_CLP_A_CLP_B",
            trackID: "V1",
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            transitionType: "crossfade",
            transitionFrames: 12,
            previewFrame: 24,
            appliedSkillID: "ui.crossfade_bridge"
        )

        XCTAssertFalse(TimelineTransitionPreviewPublishing.shouldPublish(
            previous: preview,
            next: preview,
            currentSelectedTransitionID: "TRN_V1_CLP_A_CLP_B"
        ))
        XCTAssertTrue(TimelineTransitionPreviewPublishing.shouldPublish(
            previous: nil,
            next: preview,
            currentSelectedTransitionID: nil
        ))
        XCTAssertTrue(TimelineTransitionPreviewPublishing.shouldPublish(
            previous: preview,
            next: preview,
            currentSelectedTransitionID: nil
        ))
        XCTAssertTrue(TimelineTransitionPreviewPublishing.shouldPublish(
            previous: preview,
            next: preview,
            currentSelectedTransitionID: "TRN_V1_CLP_X_CLP_Y"
        ))

        let longerPreview = TimelineTransitionDurationPreview(
            transitionID: "TRN_V1_CLP_A_CLP_B",
            trackID: "V1",
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            transitionType: "crossfade",
            transitionFrames: 18,
            previewFrame: 24,
            appliedSkillID: "ui.crossfade_bridge"
        )
        XCTAssertTrue(TimelineTransitionPreviewPublishing.shouldPublish(
            previous: preview,
            next: longerPreview,
            currentSelectedTransitionID: "TRN_V1_CLP_A_CLP_B"
        ))

        let movedPreview = TimelineTransitionDurationPreview(
            transitionID: "TRN_V1_CLP_B_CLP_C",
            trackID: "V1",
            fromClipID: "CLP_B",
            toClipID: "CLP_C",
            transitionType: "crossfade",
            transitionFrames: 8,
            previewFrame: 48,
            appliedSkillID: "ui.crossfade_bridge"
        )
        XCTAssertTrue(TimelineTransitionPreviewPublishing.shouldPublish(
            previous: preview,
            next: movedPreview,
            currentSelectedTransitionID: "TRN_V1_CLP_A_CLP_B"
        ))

        XCTAssertTrue(TimelineTransitionPreviewPublishing.shouldClear(preview))
        XCTAssertFalse(TimelineTransitionPreviewPublishing.shouldClear(nil))
    }

    func testTransitionSelectionPublishingSuppressesIdenticalSelection() {
        XCTAssertFalse(TimelineTransitionSelectionPublishing.shouldPublish(previous: nil, next: nil))
        XCTAssertFalse(TimelineTransitionSelectionPublishing.shouldPublish(previous: "TRN_A", next: "TRN_A"))
        XCTAssertTrue(TimelineTransitionSelectionPublishing.shouldPublish(previous: nil, next: "TRN_A"))
        XCTAssertTrue(TimelineTransitionSelectionPublishing.shouldPublish(previous: "TRN_A", next: nil))
        XCTAssertTrue(TimelineTransitionSelectionPublishing.shouldPublish(previous: "TRN_A", next: "TRN_B"))
    }

    func testSettingTransitionUpsertsExistingEditPointTransition() throws {
        let timeline = try makeTimeline()
        let first = try XCTUnwrap(timeline.settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))

        let updated = try XCTUnwrap(first.settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 18,
            appliedSkillID: "ui.crossfade_bridge"
        ))

        XCTAssertEqual(updated.transitions.count, 1)
        XCTAssertEqual(updated.transitions[0].transitionFrames, 18)
    }

    func testActiveVisualTransitionPreviewTracksDurationAndOverlayClip() throws {
        let timeline = try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        )

        let beforeBoundary = try XCTUnwrap(timeline?.activeVisualTransitionPreview(atFrame: 20))
        XCTAssertEqual(beforeBoundary.startFrame, 18)
        XCTAssertEqual(beforeBoundary.endFrame, 30)
        XCTAssertEqual(beforeBoundary.boundaryFrame, 24)
        XCTAssertEqual(beforeBoundary.overlaySelection.clip.id, "CLP_B")
        XCTAssertEqual(beforeBoundary.overlayTimelineFrame, 26)
        XCTAssertEqual(beforeBoundary.overlayOpacity, 2.0 / 12.0, accuracy: 0.001)

        let atBoundary = try XCTUnwrap(timeline?.activeVisualTransitionPreview(atFrame: 24))
        XCTAssertEqual(atBoundary.overlaySelection.clip.id, "CLP_A")
        XCTAssertEqual(atBoundary.overlayTimelineFrame, 18)
        XCTAssertEqual(atBoundary.overlayOpacity, 0.5, accuracy: 0.001)

        let longer = try XCTUnwrap(timeline?.settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 18,
            appliedSkillID: "ui.crossfade_bridge"
        ))
        XCTAssertNil(timeline?.activeVisualTransitionPreview(atFrame: 16))
        XCTAssertNotNil(longer.activeVisualTransitionPreview(atFrame: 16))
    }

    func testSettingCutRemovesExistingEditPointTransition() throws {
        let transitioned = try XCTUnwrap(try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))

        let removed = try XCTUnwrap(transitioned.settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "cut",
            transitionFrames: 12,
            appliedSkillID: nil
        ))

        XCTAssertEqual(transitioned.transitions.count, 1)
        XCTAssertTrue(removed.transitions.isEmpty)
        XCTAssertNil(removed.activeVisualTransitionPreview(atFrame: 24))
    }

    func testRelocatePlanMovesExistingTransitionToAnotherEditPoint() throws {
        let timeline = try XCTUnwrap(try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))
        let sourceTransitionID = TimelineTransition.stableID(trackID: "V1", fromClipID: "CLP_A", toClipID: "CLP_B")

        let plan = try XCTUnwrap(TimelineTransitionRelocatePlan.make(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            targetTrackID: "V1",
            targetFromClipID: "CLP_D",
            targetToClipID: "CLP_E",
            reason: "move transition"
        ))

        XCTAssertEqual(plan.sourceTransitionID, sourceTransitionID)
        XCTAssertEqual(plan.targetTrackID, "V1")
        XCTAssertEqual(plan.targetFromClipID, "CLP_D")
        XCTAssertEqual(plan.targetToClipID, "CLP_E")
        XCTAssertEqual(plan.boundaryFrame, 96)
        XCTAssertEqual(plan.transitionType, "crossfade")
        XCTAssertEqual(plan.transitionFrames, 12)
        XCTAssertEqual(plan.operations.map(\.opName), ["set_transition", "set_transition"])

        guard case let .setTransition(targetFrom, targetTo, targetTrack, targetType, targetFrames, targetSkill, _) = plan.operations[0] else {
            return XCTFail("Expected target set_transition")
        }
        XCTAssertEqual(targetFrom, "CLP_D")
        XCTAssertEqual(targetTo, "CLP_E")
        XCTAssertEqual(targetTrack, "V1")
        XCTAssertEqual(targetType, "crossfade")
        XCTAssertEqual(targetFrames, 12)
        XCTAssertEqual(targetSkill, "ui.crossfade_bridge")

        guard case let .setTransition(sourceFrom, sourceTo, sourceTrack, sourceType, sourceFrames, sourceSkill, _) = plan.operations[1] else {
            return XCTFail("Expected source cut set_transition")
        }
        XCTAssertEqual(sourceFrom, "CLP_A")
        XCTAssertEqual(sourceTo, "CLP_B")
        XCTAssertEqual(sourceTrack, "V1")
        XCTAssertEqual(sourceType, "cut")
        XCTAssertEqual(sourceFrames, 12)
        XCTAssertNil(sourceSkill)

        XCTAssertFalse(plan.timeline.transitions.contains {
            $0.fromClipID == "CLP_A" && $0.toClipID == "CLP_B" && $0.isVisibleTimelineTransition
        })
        let moved = try XCTUnwrap(plan.timeline.transitions.first {
            $0.fromClipID == "CLP_D" && $0.toClipID == "CLP_E"
        })
        XCTAssertEqual(moved.transitionType, "crossfade")
        XCTAssertEqual(moved.transitionFrames, 12)
        XCTAssertNotNil(plan.timeline.activeVisualTransitionPreview(atFrame: 96))
    }

    func testRelocatePlanClampsExistingTransitionDurationToTargetHandles() throws {
        let timeline = try XCTUnwrap(try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 18,
            appliedSkillID: "ui.crossfade_bridge"
        ))
        let sourceTransitionID = TimelineTransition.stableID(trackID: "V1", fromClipID: "CLP_A", toClipID: "CLP_B")

        let plan = try XCTUnwrap(TimelineTransitionRelocatePlan.make(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            targetTrackID: "V1",
            targetFromClipID: "CLP_B",
            targetToClipID: "CLP_C",
            reason: "move transition"
        ))

        XCTAssertEqual(plan.transitionFrames, 8)
        guard case let .setTransition(_, _, _, _, targetFrames, _, _) = plan.operations[0] else {
            return XCTFail("Expected set_transition")
        }
        XCTAssertEqual(targetFrames, 8)
        guard case let .setTransition(_, _, _, sourceType, sourceFrames, _, _) = plan.operations[1] else {
            return XCTFail("Expected source cut")
        }
        XCTAssertEqual(sourceType, "cut")
        XCTAssertEqual(sourceFrames, 18)
    }

    func testRelocatePlanRejectsSameSourceTargetAndGappedTarget() throws {
        let timeline = try XCTUnwrap(try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))
        let sourceTransitionID = TimelineTransition.stableID(trackID: "V1", fromClipID: "CLP_A", toClipID: "CLP_B")

        XCTAssertNil(TimelineTransitionRelocatePlan.make(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            targetTrackID: "V1",
            targetFromClipID: "CLP_A",
            targetToClipID: "CLP_B",
            reason: "same target"
        ))
        XCTAssertNil(TimelineTransitionRelocatePlan.make(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            targetTrackID: "V1",
            targetFromClipID: "CLP_C",
            targetToClipID: "CLP_D",
            reason: "gapped target"
        ))
    }

    func testPlacementResolverPrioritizesSelectedTransition() throws {
        let timeline = try makeTimeline()
        let selectedTransitionID = TimelineTransition.stableID(
            trackID: "V1",
            fromClipID: "CLP_A",
            toClipID: "CLP_B"
        )

        let target = TimelineTransitionPlacementResolver.resolve(
            timeline: timeline,
            selectedClipIDs: [],
            selectedTransitionID: selectedTransitionID,
            playheadFrame: 47
        )

        XCTAssertEqual(target?.transitionID, selectedTransitionID)
        XCTAssertEqual(target?.boundaryFrame, 24)
    }

    func testPlacementResolverPrioritizesSelectedClipEditPoint() throws {
        let timeline = try makeTimeline()

        let target = TimelineTransitionPlacementResolver.resolve(
            timeline: timeline,
            selectedClipIDs: ["CLP_C"],
            selectedTransitionID: nil,
            playheadFrame: 25
        )

        XCTAssertEqual(target?.trackID, "V1")
        XCTAssertEqual(target?.fromClipID, "CLP_B")
        XCTAssertEqual(target?.toClipID, "CLP_C")
        XCTAssertEqual(target?.boundaryFrame, 48)
    }

    func testPlacementResolverFallsBackToNearestPlayheadEditPoint() throws {
        let timeline = try makeTimeline()

        let target = TimelineTransitionPlacementResolver.resolve(
            timeline: timeline,
            selectedClipIDs: [],
            selectedTransitionID: nil,
            playheadFrame: 47
        )

        XCTAssertEqual(target?.trackID, "V1")
        XCTAssertEqual(target?.fromClipID, "CLP_B")
        XCTAssertEqual(target?.toClipID, "CLP_C")
        XCTAssertEqual(target?.boundaryFrame, 48)
    }

    func testPlacementResolverSkipsBlockedClips() throws {
        let timeline = try makeTimeline()

        let target = TimelineTransitionPlacementResolver.resolve(
            timeline: timeline,
            selectedClipIDs: ["CLP_B"],
            selectedTransitionID: nil,
            playheadFrame: 23,
            blockedClipIDs: ["CLP_A", "CLP_B", "CLP_D", "CLP_E"]
        )

        XCTAssertNil(target)
    }

    func testNearestOnTrackResolverSnapsLaneDropToClosestEligibleEditPoint() throws {
        let timeline = try makeTimeline()

        let target = TimelineTransitionPlacementResolver.resolveNearestOnTrack(
            timeline: timeline,
            trackID: "V1",
            proposedFrame: 44
        )

        XCTAssertEqual(target?.trackID, "V1")
        XCTAssertEqual(target?.fromClipID, "CLP_B")
        XCTAssertEqual(target?.toClipID, "CLP_C")
        XCTAssertEqual(target?.boundaryFrame, 48)
    }

    func testNearestOnTrackResolverRejectsAudioGapsAndBlockedClips() throws {
        let timeline = try makeTimeline()

        XCTAssertNil(TimelineTransitionPlacementResolver.resolveNearestOnTrack(
            timeline: timeline,
            trackID: "A1",
            proposedFrame: 24
        ))

        let target = TimelineTransitionPlacementResolver.resolveNearestOnTrack(
            timeline: timeline,
            trackID: "V1",
            proposedFrame: 44,
            blockedClipIDs: ["CLP_C"]
        )

        XCTAssertEqual(target?.fromClipID, "CLP_A")
        XCTAssertEqual(target?.toClipID, "CLP_B")
        XCTAssertEqual(target?.boundaryFrame, 24)
    }

    func testNearestRelocationOnTrackSkipsSourceAndSnapsToNextEligibleEditPoint() throws {
        let timeline = try XCTUnwrap(try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))
        let sourceTransitionID = TimelineTransition.stableID(trackID: "V1", fromClipID: "CLP_A", toClipID: "CLP_B")

        let target = TimelineTransitionPlacementResolver.resolveNearestRelocationOnTrack(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            trackID: "V1",
            proposedFrame: 23
        )

        XCTAssertEqual(target?.trackID, "V1")
        XCTAssertEqual(target?.fromClipID, "CLP_B")
        XCTAssertEqual(target?.toClipID, "CLP_C")
        XCTAssertEqual(target?.boundaryFrame, 48)
    }

    func testNearestRelocationOnTrackSkipsBlockedAndInvalidTargets() throws {
        let timeline = try XCTUnwrap(try makeTimeline().settingTransition(
            fromClipID: "CLP_A",
            toClipID: "CLP_B",
            trackID: "V1",
            transitionType: "crossfade",
            transitionFrames: 12,
            appliedSkillID: "ui.crossfade_bridge"
        ))
        let sourceTransitionID = TimelineTransition.stableID(trackID: "V1", fromClipID: "CLP_A", toClipID: "CLP_B")

        XCTAssertNil(TimelineTransitionPlacementResolver.resolveNearestRelocationOnTrack(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            trackID: "A1",
            proposedFrame: 48
        ))

        let target = TimelineTransitionPlacementResolver.resolveNearestRelocationOnTrack(
            timeline: timeline,
            sourceTransitionID: sourceTransitionID,
            trackID: "V1",
            proposedFrame: 44,
            blockedClipIDs: ["CLP_C"]
        )

        XCTAssertEqual(target?.fromClipID, "CLP_D")
        XCTAssertEqual(target?.toClipID, "CLP_E")
        XCTAssertEqual(target?.boundaryFrame, 96)
    }

    func testTransitionDurationDragRegionAlwaysAllowsEdgeDrags() {
        XCTAssertTrue(TimelineTransitionDurationDragRegion.allowsDurationDrag(
            startX: 14,
            hitAreaWidth: 72,
            displayWidth: 48,
            isSelected: false
        ))
        XCTAssertTrue(TimelineTransitionDurationDragRegion.allowsDurationDrag(
            startX: 58,
            hitAreaWidth: 72,
            displayWidth: 48,
            isSelected: false
        ))
    }

    func testTransitionDurationDragRegionAllowsSelectedBodyButKeepsCenterForMove() {
        XCTAssertFalse(TimelineTransitionDurationDragRegion.allowsDurationDrag(
            startX: 32,
            hitAreaWidth: 96,
            displayWidth: 72,
            isSelected: false
        ))
        XCTAssertTrue(TimelineTransitionDurationDragRegion.allowsDurationDrag(
            startX: 32,
            hitAreaWidth: 96,
            displayWidth: 72,
            isSelected: true
        ))
        XCTAssertFalse(TimelineTransitionDurationDragRegion.allowsDurationDrag(
            startX: 48,
            hitAreaWidth: 96,
            displayWidth: 72,
            isSelected: true
        ))
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "transition-test",
          "sequence": {
            "name": "Transition Test",
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
                  },
                  {
                    "clip_id": "CLP_C",
                    "segment_id": "SEG_C",
                    "asset_id": "AST_C",
                    "src_in_us": 0,
                    "src_out_us": 333000,
                    "timeline_in_frame": 48,
                    "timeline_duration_frames": 8,
                    "role": "support",
                    "motivation": "c"
                  },
                  {
                    "clip_id": "CLP_D",
                    "segment_id": "SEG_D",
                    "asset_id": "AST_D",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 72,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "d"
                  },
                  {
                    "clip_id": "CLP_E",
                    "segment_id": "SEG_E",
                    "asset_id": "AST_E",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 96,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "e"
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
                    "clip_id": "ACL_A",
                    "segment_id": "ASEG_A",
                    "asset_id": "AAST_A",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "dialogue",
                    "motivation": "audio a"
                  },
                  {
                    "clip_id": "ACL_B",
                    "segment_id": "ASEG_B",
                    "asset_id": "AAST_B",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 24,
                    "role": "dialogue",
                    "motivation": "audio b"
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
