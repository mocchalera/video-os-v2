import XCTest
@testable import VideoOSStudioCore

final class TimelineSourceInsertPlanTests: XCTestCase {
    func testPlanPrefersUnusedCandidateAndCreatesVideoTargetTrack() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SRC_USED", assetID: "AST_SRC", role: "support", confidence: 0.99),
                makeCandidate(segmentID: "SEG_SRC_NEW", assetID: "AST_SRC", role: "support", confidence: 0.70),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            playheadFrame: 36,
            reason: "Studio source monitor insert"
        ))

        XCTAssertEqual(plan.candidate.segment_id, "SEG_SRC_NEW")
        XCTAssertEqual(plan.insertedClipID, "CLP_0003")
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.targetKind, .video)
        XCTAssertEqual(plan.timelineInFrame, 36)
        XCTAssertEqual(plan.durationFrames, 48)
        XCTAssertEqual(plan.beatID, "b01")
        XCTAssertEqual(plan.changedClipIDs, ["CLP_0003"])

        let insertedTrack = try XCTUnwrap(plan.timeline.tracks.video.first { $0.id == "V2" })
        XCTAssertEqual(insertedTrack.clips.map(\.id), ["CLP_0003"])
        XCTAssertEqual(insertedTrack.clips[0].segmentID, "SEG_SRC_NEW")
        XCTAssertEqual(insertedTrack.clips[0].candidateRef, "SEG_SRC_NEW")
        XCTAssertEqual(plan.operation.opName, "insert_segment")
    }

    func testBestCandidateForSourceBinDragPrefersUnusedHighConfidenceCandidate() throws {
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_USED_HIGH", assetID: "AST_BIN", role: "support", confidence: 0.99),
                makeCandidate(segmentID: "SEG_UNUSED_LOW", assetID: "AST_BIN", role: "support", confidence: 0.60),
                makeCandidate(segmentID: "SEG_OTHER_ASSET", assetID: "AST_OTHER", role: "support", confidence: 1.0),
            ],
            beatPlans: []
        )

        let candidate = try XCTUnwrap(TimelineSourceInsertPlan.bestCandidate(
            in: dataSource,
            sourceAssetID: "AST_BIN",
            usedSegmentIDs: ["SEG_USED_HIGH"]
        ))

        XCTAssertEqual(candidate.segment_id, "SEG_UNUSED_LOW")
    }

    func testBestCandidateForSourceBinDragReturnsNilForMissingAsset() throws {
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_OTHER_ASSET", assetID: "AST_OTHER", role: "support", confidence: 1.0),
            ],
            beatPlans: []
        )

        XCTAssertNil(TimelineSourceInsertPlan.bestCandidate(
            in: dataSource,
            sourceAssetID: "AST_BIN",
            usedSegmentIDs: []
        ))
    }

    func testSourceBinQuickInsertUsesResolvedCandidateAtPlayhead() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SRC_USED", assetID: "AST_SRC", role: "support", confidence: 0.99),
                makeCandidate(segmentID: "SEG_SRC_BIN", assetID: "AST_SRC", role: "support", confidence: 0.66),
            ],
            beatPlans: []
        )
        let usedSegmentIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.segmentID))
        let candidate = try XCTUnwrap(TimelineSourceInsertPlan.bestCandidate(
            in: dataSource,
            sourceAssetID: "AST_SRC",
            usedSegmentIDs: usedSegmentIDs
        ))

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            playheadFrame: 36,
            reason: "Studio source bin quick insert at playhead",
            candidateID: candidate.id
        ))

        XCTAssertEqual(candidate.segment_id, "SEG_SRC_BIN")
        XCTAssertEqual(plan.candidate.segment_id, "SEG_SRC_BIN")
        XCTAssertEqual(plan.timelineInFrame, 36)
        XCTAssertEqual(plan.timeline.tracks.video.first { $0.id == "V2" }?.clips.last?.segmentID, "SEG_SRC_BIN")
        XCTAssertEqual(plan.operation.opName, "insert_segment")
    }

    func testPlanCanAppendCandidateAtTimelineEnd() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SRC_APPEND", assetID: "AST_SRC", role: "support", confidence: 0.72),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            playheadFrame: timeline.totalFrames,
            reason: "Studio source monitor append to timeline end",
            candidateID: "SEG_SRC_APPEND"
        ))

        XCTAssertEqual(timeline.totalFrames, 48)
        XCTAssertEqual(plan.timelineInFrame, 48)
        XCTAssertEqual(plan.proposedTimelineInFrame, 48)
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertNil(plan.laneLift)
        XCTAssertEqual(plan.timeline.totalFrames, 96)
        XCTAssertEqual(plan.timeline.tracks.video.first { $0.id == "V2" }?.clips.last?.segmentID, "SEG_SRC_APPEND")
        guard case let .insertSegment(_, _, _, timelineInFrame, _, targetTrackID, _, _, _) = plan.operation else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(timelineInFrame, 48)
        XCTAssertNil(targetTrackID)
    }

    func testPlanSanitizesUnsupportedCandidateRole() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_REJECT", assetID: "AST_REJECT", role: "reject", confidence: 0.90),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_REJECT",
            playheadFrame: 48,
            reason: "Studio source monitor insert"
        ))

        XCTAssertEqual(plan.role, "support")
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.operation.opName, "insert_segment")
    }

    func testPlanRoutesDialogueCandidateToAudioTrack() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_DIALOGUE", assetID: "AST_DIALOGUE", role: "dialogue", confidence: 0.85),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_DIALOGUE",
            playheadFrame: 96,
            reason: "Studio source monitor insert"
        ))

        XCTAssertEqual(plan.targetTrackID, "A1")
        XCTAssertEqual(plan.targetKind, .audio)
        let audioTrack = try XCTUnwrap(plan.timeline.tracks.audio.first { $0.id == "A1" })
        XCTAssertEqual(audioTrack.clips.last?.segmentID, "SEG_DIALOGUE")
    }

    func testPlanUsesExplicitCandidateIDWhenProvided() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_STRONG", assetID: "AST_PICK", role: "support", confidence: 0.95),
                makeCandidate(segmentID: "SEG_SELECTED", assetID: "AST_PICK", role: "support", confidence: 0.45),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_PICK",
            playheadFrame: 96,
            reason: "Studio source monitor insert",
            candidateID: "SEG_SELECTED"
        ))

        XCTAssertEqual(plan.candidate.segment_id, "SEG_SELECTED")
        XCTAssertEqual(plan.timeline.tracks.video.first { $0.id == "V2" }?.clips.last?.segmentID, "SEG_SELECTED")
    }

    func testPlanUsesSourceRangeOverrideForMarkedInsert() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_MARKED", assetID: "AST_MARKED", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 500_000, sourceOutUS: 1_500_000))

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_MARKED",
            playheadFrame: 96,
            reason: "Studio source monitor marked insert",
            candidateID: "SEG_MARKED",
            sourceRangeOverride: range
        ))

        let insertedClip = try XCTUnwrap(plan.timeline.tracks.video.first { $0.id == "V2" }?.clips.last)
        XCTAssertEqual(insertedClip.sourceInUS, 500_000)
        XCTAssertEqual(insertedClip.sourceOutUS, 1_500_000)
        XCTAssertEqual(insertedClip.timelineDurationFrames, 24)
        guard case let .insertSegment(_, _, _, _, durationFrames, _, sourceInUS, sourceOutUS, _) = plan.operation else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(durationFrames, 24)
        XCTAssertEqual(sourceInUS, 500_000)
        XCTAssertEqual(sourceOutUS, 1_500_000)
    }

    func testPlanEmitsBothSourceRangeFieldsWhenOnlyInPointChanges() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_MARKED", assetID: "AST_MARKED", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 500_000, sourceOutUS: 2_000_000))

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_MARKED",
            playheadFrame: 96,
            reason: "Studio source monitor marked insert",
            candidateID: "SEG_MARKED",
            sourceRangeOverride: range
        ))

        guard case let .insertSegment(_, _, _, _, _, _, sourceInUS, sourceOutUS, _) = plan.operation else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(sourceInUS, 500_000)
        XCTAssertEqual(sourceOutUS, 2_000_000)
        XCTAssertTrue(plan.operation.isValidForStudioSession)
    }

    func testPlanRejectsSourceRangeOutsideCandidate() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_MARKED", assetID: "AST_MARKED", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 250_000, sourceOutUS: 2_500_000))

        XCTAssertNil(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_MARKED",
            playheadFrame: 96,
            reason: "Studio source monitor marked insert",
            candidateID: "SEG_MARKED",
            sourceRangeOverride: range
        ))
    }

    func testSourceRangeMarkPlanMapsDragFractionsToCandidateRange() throws {
        let range = try XCTUnwrap(TimelineSourceRangeMarkPlan.range(
            candidateSourceInUS: 1_000,
            candidateSourceOutUS: 9_000,
            currentSourceInUS: nil,
            currentSourceOutUS: nil,
            handle: .inPoint,
            normalizedPosition: 0.25
        ))

        XCTAssertEqual(range.sourceInUS, 3_000)
        XCTAssertEqual(range.sourceOutUS, 9_000)
        XCTAssertEqual(
            TimelineSourceRangeMarkPlan.fraction(
                sourceUS: range.sourceInUS,
                candidateSourceInUS: 1_000,
                candidateSourceOutUS: 9_000
            ),
            0.25,
            accuracy: 0.0001
        )
    }

    func testSourceRangeMarkPlanClampsOutHandleWithinCandidate() throws {
        let range = try XCTUnwrap(TimelineSourceRangeMarkPlan.range(
            candidateSourceInUS: 1_000,
            candidateSourceOutUS: 9_000,
            currentSourceInUS: 3_000,
            currentSourceOutUS: 7_000,
            handle: .outPoint,
            normalizedPosition: 1.3
        ))

        XCTAssertEqual(range.sourceInUS, 3_000)
        XCTAssertEqual(range.sourceOutUS, 9_000)
    }

    func testSourceRangeMarkPlanPreventsHandleInversion() throws {
        let inRange = try XCTUnwrap(TimelineSourceRangeMarkPlan.range(
            candidateSourceInUS: 1_000,
            candidateSourceOutUS: 9_000,
            currentSourceInUS: 3_000,
            currentSourceOutUS: 5_000,
            handle: .inPoint,
            normalizedPosition: 0.95
        ))
        let outRange = try XCTUnwrap(TimelineSourceRangeMarkPlan.range(
            candidateSourceInUS: 1_000,
            candidateSourceOutUS: 9_000,
            currentSourceInUS: 3_000,
            currentSourceOutUS: 5_000,
            handle: .outPoint,
            normalizedPosition: 0
        ))

        XCTAssertEqual(inRange.sourceInUS, 4_999)
        XCTAssertEqual(inRange.sourceOutUS, 5_000)
        XCTAssertEqual(outRange.sourceInUS, 3_000)
        XCTAssertEqual(outRange.sourceOutUS, 3_001)
    }

    func testSourceRangeMarkPlanSuppressesIdenticalRangePublication() throws {
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 3_000, sourceOutUS: 5_000))

        XCTAssertFalse(TimelineSourceRangeMarkPlan.shouldPublishRange(
            currentSourceInUS: 3_000,
            currentSourceOutUS: 5_000,
            nextRange: range
        ))
        XCTAssertTrue(TimelineSourceRangeMarkPlan.shouldPublishRange(
            currentSourceInUS: 3_001,
            currentSourceOutUS: 5_000,
            nextRange: range
        ))
        XCTAssertTrue(TimelineSourceRangeMarkPlan.shouldPublishRange(
            currentSourceInUS: nil,
            currentSourceOutUS: nil,
            nextRange: range
        ))
        XCTAssertFalse(TimelineSourceRangeMarkPlan.shouldPublishRange(
            currentSourceInUS: nil,
            currentSourceOutUS: nil,
            nextRange: nil
        ))
        XCTAssertTrue(TimelineSourceRangeMarkPlan.shouldPublishRange(
            currentSourceInUS: 3_000,
            currentSourceOutUS: nil,
            nextRange: nil
        ))
    }

    func testPlanUsesCompatiblePreferredTargetTrackForTimelineDrop() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_DROP", assetID: "AST_DROP", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_DROP",
            playheadFrame: 72,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_DROP",
            preferredTargetTrackID: "V1"
        ))

        XCTAssertEqual(plan.targetTrackID, "V1")
        XCTAssertEqual(plan.targetKind, .video)
        XCTAssertEqual(plan.timeline.tracks.video.first { $0.id == "V1" }?.clips.last?.segmentID, "SEG_DROP")
        guard case let .insertSegment(_, _, _, _, _, targetTrackID, _, _, _) = plan.operation else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(targetTrackID, "V1")
    }

    func testPlanSnapsSourceDropStartToNearbyEditPoint() throws {
        let timeline = try makeTimelineWithSecondVideoTrackAndMarker(frame: 96)
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SNAP_EDIT", assetID: "AST_SNAP_EDIT", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SNAP_EDIT",
            playheadFrame: 50,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_SNAP_EDIT",
            preferredTargetTrackID: "V1",
            snapThresholdFrames: 4,
            snapPlayheadFrame: 80
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 50)
        XCTAssertEqual(plan.timelineInFrame, 48)
        XCTAssertEqual(plan.snap?.kind, .editPoint)
        XCTAssertEqual(plan.snap?.alignment, .start)
        XCTAssertEqual(plan.snap?.frame, 48)
        XCTAssertEqual(plan.snap?.label, "CLP_0002 末尾")
        XCTAssertNil(plan.laneLift)
        guard case let .insertSegment(_, _, _, timelineInFrame, _, _, _, _, _) = plan.operation else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(timelineInFrame, 48)
    }

    func testPlanSnapsSourceDropStartToPlayheadOnEmptyTargetLane() throws {
        let timeline = try makeTimelineWithSecondVideoTrackAndMarker(frame: 96)
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SNAP_PLAYHEAD", assetID: "AST_SNAP_PLAYHEAD", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SNAP_PLAYHEAD",
            playheadFrame: 52,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_SNAP_PLAYHEAD",
            preferredTargetTrackID: "V2",
            snapThresholdFrames: 3,
            snapPlayheadFrame: 54
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 52)
        XCTAssertEqual(plan.timelineInFrame, 54)
        XCTAssertEqual(plan.snap?.kind, .playhead)
        XCTAssertEqual(plan.snap?.alignment, .start)
        XCTAssertEqual(plan.snap?.frame, 54)
        XCTAssertEqual(plan.targetTrackID, "V2")
    }

    func testPlanSnapsSourceDropStartToMarkerOnEmptyTargetLane() throws {
        let timeline = try makeTimelineWithSecondVideoTrackAndMarker(frame: 54, label: "Act 2")
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SNAP_MARKER", assetID: "AST_SNAP_MARKER", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SNAP_MARKER",
            playheadFrame: 51,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_SNAP_MARKER",
            preferredTargetTrackID: "V2",
            snapThresholdFrames: 3
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 51)
        XCTAssertEqual(plan.timelineInFrame, 54)
        XCTAssertEqual(plan.snap?.kind, .marker)
        XCTAssertEqual(plan.snap?.alignment, .start)
        XCTAssertEqual(plan.snap?.frame, 54)
        XCTAssertEqual(plan.snap?.label, "Act 2")
    }

    func testPlanUsesSnappedFrameBeforeResolvingSourceDropLaneLift() throws {
        let timeline = try makeTimelineWithSecondVideoTrackAndMarker(frame: 96)
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_SNAP_LIFT", assetID: "AST_SNAP_LIFT", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SNAP_LIFT",
            playheadFrame: 26,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_SNAP_LIFT",
            preferredTargetTrackID: "V1",
            snapThresholdFrames: 3
        ))

        XCTAssertEqual(plan.proposedTimelineInFrame, 26)
        XCTAssertEqual(plan.timelineInFrame, 24)
        XCTAssertEqual(plan.snap?.kind, .editPoint)
        XCTAssertEqual(plan.snap?.label, "CLP_0001 末尾")
        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.requestedTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_0002"])
    }

    func testPlanUsesCompatiblePreferredAudioTrackForTimelineDrop() throws {
        let timeline = try makeTimelineWithSecondAudioTrack()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_MUSIC", assetID: "AST_MUSIC", role: "music", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_MUSIC",
            playheadFrame: 72,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_MUSIC",
            preferredTargetTrackID: "A2"
        ))

        XCTAssertEqual(plan.targetTrackID, "A2")
        XCTAssertEqual(plan.targetKind, .audio)
        XCTAssertEqual(plan.timeline.tracks.audio.first { $0.id == "A2" }?.clips.last?.segmentID, "SEG_MUSIC")
    }

    func testPlanLiftsSourceDropFromOccupiedPreferredVideoTrackToOpenTrack() throws {
        let timeline = try makeTimelineWithSecondVideoTrack()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_LAYERED", assetID: "AST_LAYERED", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_LAYERED",
            playheadFrame: 12,
            reason: "Studio source monitor layered drop",
            candidateID: "SEG_LAYERED",
            preferredTargetTrackID: "V1"
        ))

        XCTAssertEqual(plan.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.requestedTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V2")
        XCTAssertEqual(plan.laneLift?.createsTrack, false)
        XCTAssertEqual(plan.laneLift?.overlappedClipIDs, ["CLP_0001", "CLP_0002"])
        XCTAssertEqual(plan.timeline.tracks.video.first { $0.id == "V2" }?.clips.last?.segmentID, "SEG_LAYERED")
    }

    func testPlanCreatesNewVideoTrackWhenAllSourceDropTargetsOverlap() throws {
        let timeline = try makeTimelineWithOccupiedVideoTracks()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_NEW_LAYER", assetID: "AST_NEW_LAYER", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_NEW_LAYER",
            playheadFrame: 12,
            reason: "Studio source monitor new layered drop",
            candidateID: "SEG_NEW_LAYER",
            preferredTargetTrackID: "V1"
        ))

        XCTAssertEqual(plan.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.requestedTrackID, "V1")
        XCTAssertEqual(plan.laneLift?.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertEqual(plan.timeline.tracks.video.first { $0.id == "V3" }?.clips.last?.segmentID, "SEG_NEW_LAYER")
        guard case let .insertSegment(_, _, _, _, _, targetTrackID, _, _, _) = plan.operation else {
            return XCTFail("Expected insert_segment")
        }
        XCTAssertEqual(targetTrackID, "V3")
    }

    func testPlanDoesNotLiftDefaultSupportInsertDownToPrimaryVideoTrack() throws {
        let timeline = makeTimelineWithOccupiedSupportTrackAndOpenPrimary()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_STACK_UP", assetID: "AST_STACK_UP", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_STACK_UP",
            playheadFrame: 12,
            reason: "Studio source monitor stack upward",
            candidateID: "SEG_STACK_UP"
        ))

        XCTAssertEqual(plan.laneLift?.requestedTrackID, "V2")
        XCTAssertEqual(plan.targetTrackID, "V3")
        XCTAssertEqual(plan.laneLift?.createsTrack, true)
        XCTAssertTrue(plan.timeline.tracks.video.first { $0.id == "V1" }?.clips.isEmpty == true)
    }

    func testPlanRejectsIncompatiblePreferredTargetTrackForTimelineDrop() throws {
        let timeline = try makeTimelineWithSecondAudioTrack()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-insert-test",
            candidates: [
                makeCandidate(segmentID: "SEG_VIDEO", assetID: "AST_VIDEO", role: "support", confidence: 0.80),
            ],
            beatPlans: []
        )

        XCTAssertNil(TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_VIDEO",
            playheadFrame: 72,
            reason: "Studio source monitor drag drop",
            candidateID: "SEG_VIDEO",
            preferredTargetTrackID: "A2"
        ))
    }

    private func makeCandidate(
        segmentID: String,
        assetID: String,
        role: String,
        confidence: Double
    ) -> BrowserCandidate {
        BrowserCandidate(
            candidate_id: nil,
            segment_id: segmentID,
            asset_id: assetID,
            src_in_us: 0,
            src_out_us: 2_000_000,
            role: role,
            confidence: confidence,
            why_it_matches: "candidate \(segmentID)",
            risks: [],
            eligible_beats: ["b_insert"],
            story_role: nil,
            evidence: [],
            motif_tags: [],
            trim_hint: nil,
            editorial_signals: nil
        )
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "source-insert-test",
          "sequence": {
            "name": "Source Insert Test",
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
                    "clip_id": "CLP_0001",
                    "segment_id": "SEG_MAIN",
                    "asset_id": "AST_MAIN",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "hero",
                    "motivation": "main",
                    "beat_id": "b01"
                  },
                  {
                    "clip_id": "CLP_0002",
                    "segment_id": "SEG_SRC_USED",
                    "asset_id": "AST_SRC",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 24,
                    "role": "support",
                    "motivation": "already used",
                    "beat_id": "b01"
                  }
                ]
              }
            ],
            "audio": [
              {
                "track_id": "A1",
                "kind": "audio",
                "clips": []
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

    private func makeTimelineWithSecondAudioTrack() throws -> TimelineDocument {
        let timeline = try makeTimeline()
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video,
                audio: [TimelineTrack(id: "A1", kind: .audio, clips: []), TimelineTrack(id: "A2", kind: .audio, clips: [])],
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

    private func makeTimelineWithSecondVideoTrackAndMarker(
        frame: Int,
        label: String = "Snap marker"
    ) throws -> TimelineDocument {
        let timeline = try makeTimelineWithSecondVideoTrack()
        let marker = try JSONDecoder().decode(TimelineMarker.self, from: Data("""
        {
          "marker_id": "MRK_SNAP",
          "frame": \(frame),
          "label": "\(label)"
        }
        """.utf8))
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: timeline.tracks,
            markers: [marker],
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeTimelineWithOccupiedVideoTracks() throws -> TimelineDocument {
        let timeline = try makeTimeline()
        let v2Clip = TimelineClip(
            id: "CLP_0003",
            segmentID: "SEG_EXISTING_V2",
            assetID: "AST_EXISTING_V2",
            sourceInUS: 0,
            sourceOutUS: 2_000_000,
            timelineInFrame: 0,
            timelineDurationFrames: 96,
            role: "support",
            motivation: "occupied second video track",
            confidence: nil,
            beatID: "b01",
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: nil
        )
        return TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: TimelineTrackCollection(
                video: timeline.tracks.video + [TimelineTrack(id: "V2", kind: .video, clips: [v2Clip])],
                audio: timeline.tracks.audio,
                overlay: timeline.tracks.overlay,
                caption: timeline.tracks.caption
            ),
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash
        )
    }

    private func makeTimelineWithOccupiedSupportTrackAndOpenPrimary() -> TimelineDocument {
        let sequence = TimelineSequence(
            name: "Source Insert Test",
            fpsNum: 24,
            fpsDen: 1,
            width: 1920,
            height: 1080,
            startFrame: 0,
            outputAspectRatio: nil
        )
        let v2Clip = TimelineClip(
            id: "CLP_0001",
            segmentID: "SEG_EXISTING_V2",
            assetID: "AST_EXISTING_V2",
            sourceInUS: 0,
            sourceOutUS: 2_000_000,
            timelineInFrame: 0,
            timelineDurationFrames: 96,
            role: "support",
            motivation: "occupied support track",
            confidence: nil,
            beatID: "b01",
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: nil
        )
        return TimelineDocument(
            version: "1",
            projectID: "source-insert-test",
            sequence: sequence,
            tracks: TimelineTrackCollection(
                video: [
                    TimelineTrack(id: "V1", kind: .video, clips: []),
                    TimelineTrack(id: "V2", kind: .video, clips: [v2Clip]),
                ],
                audio: [TimelineTrack(id: "A1", kind: .audio, clips: [])],
                overlay: [],
                caption: []
            ),
            markers: [],
            transitions: [],
            sourceHash: nil
        )
    }
}
