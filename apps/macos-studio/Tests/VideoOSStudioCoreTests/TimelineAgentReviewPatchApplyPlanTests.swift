import XCTest
@testable import VideoOSStudioCore

final class TimelineAgentReviewPatchApplyPlanTests: XCTestCase {
    func testAppliesSupportedDraftOperationsToTimelinePreview() {
        let timeline = makeTimeline()
        let draft = makeDraft(operations: [
            .trimSegment(
                target_clip_id: "CLP_0001",
                new_src_in_us: 500_000,
                new_src_out_us: 3_000_000,
                reason: "Tighten opening."
            ),
            .splitSegment(
                target_clip_id: "CLP_0002",
                split_timeline_frame: 45,
                reason: "Create a reaction beat."
            ),
            .setTransition(
                from_clip_id: "CLP_0001",
                to_clip_id: "CLP_0002",
                track_id: "V1",
                transition_type: "crossfade",
                transition_frames: 8,
                applied_skill_id: nil,
                reason: "Soften edit."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(draft: draft, timeline: timeline)

        XCTAssertTrue(plan.canApply)
        XCTAssertEqual(plan.operations.count, 3)
        XCTAssertEqual(plan.changedClipIDs, ["CLP_0001", "CLP_0002", "CLP_0003"])
        XCTAssertNil(plan.selectedClipID)
        XCTAssertEqual(plan.selectedTransitionID, "TRN_V1_CLP_0001_CLP_0002")
        XCTAssertEqual(plan.focusFrame, 30)
        XCTAssertEqual(plan.updatedTimeline.clipSelection(for: "CLP_0001")?.clip.sourceInUS, 500_000)
        XCTAssertEqual(plan.updatedTimeline.clipSelection(for: "CLP_0002")?.clip.timelineDurationFrames, 15)
        XCTAssertEqual(plan.updatedTimeline.clipSelection(for: "CLP_0003")?.clip.timelineInFrame, 45)
        XCTAssertEqual(plan.updatedTimeline.transitions.first?.transitionType, "crossfade")
        XCTAssertEqual(plan.updatedTimeline.transitions.first?.transitionFrames, 8)
        XCTAssertEqual(plan.previewDiffs.map(\.operationName), ["trim_segment", "split_segment", "set_transition"])
        XCTAssertEqual(plan.previewDiffs[0].beforeLabel, "V1 frame 0-30 / src 0.000s-3.000s / SEG_CLP_0001")
        XCTAssertEqual(plan.previewDiffs[0].afterLabel, "V1 frame 0-30 / src 0.500s-3.000s / SEG_CLP_0001")
        XCTAssertEqual(plan.previewDiffs[1].beforeLabel, "V1 frame 30-60 / src 3.000s-6.000s / SEG_CLP_0002")
        XCTAssertEqual(plan.previewDiffs[1].afterLabel, "CLP_0002 V1 frame 30-45 / src 3.000s-4.500s / SEG_CLP_0002 + CLP_0003 V1 frame 45-60 / src 4.500s-6.000s / SEG_CLP_0002")
        XCTAssertEqual(plan.previewDiffs[2].beforeLabel, "cut")
        XCTAssertEqual(plan.previewDiffs[2].afterLabel, "V1 crossfade / 8f")
    }

    func testAppliesReplaceSegmentWhenCandidateDataSourceCanResolveCandidate() {
        let timeline = makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "demo",
            candidates: [
                makeCandidate(
                    candidateID: "candidate-strong",
                    segmentID: "SEG_REPLACE",
                    assetID: "ASSET_REPLACE",
                    role: "support",
                    confidence: 0.82
                ),
            ],
            beatPlans: []
        )
        let draft = makeDraft(operations: [
            .replaceSegment(
                target_clip_id: "CLP_0001",
                with_segment_id: "SEG_REPLACE",
                with_candidate_ref: "candidate-strong",
                new_src_in_us: 1_200_000,
                new_src_out_us: 2_400_000,
                reason: "Use the stronger reaction."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(
            draft: draft,
            timeline: timeline,
            candidateDataSource: dataSource
        )

        XCTAssertTrue(plan.canApply)
        XCTAssertEqual(plan.operations.count, 1)
        XCTAssertEqual(plan.changedClipIDs, ["CLP_0001"])
        XCTAssertEqual(plan.selectedClipID, "CLP_0001")
        XCTAssertEqual(plan.focusFrame, 0)
        let replaced = plan.updatedTimeline.clipSelection(for: "CLP_0001")?.clip
        XCTAssertEqual(replaced?.segmentID, "SEG_REPLACE")
        XCTAssertEqual(replaced?.assetID, "ASSET_REPLACE")
        XCTAssertEqual(replaced?.role, "support")
        XCTAssertEqual(replaced?.sourceInUS, 1_200_000)
        XCTAssertEqual(replaced?.sourceOutUS, 2_400_000)
        XCTAssertEqual(replaced?.candidateRef, "candidate-strong")
        XCTAssertEqual(plan.previewDiffs.count, 1)
        XCTAssertEqual(plan.previewDiffs[0].operationName, "replace_segment")
        XCTAssertEqual(plan.previewDiffs[0].beforeLabel, "V1 frame 0-30 / src 0.000s-3.000s / SEG_CLP_0001")
        XCTAssertEqual(plan.previewDiffs[0].afterLabel, "V1 frame 0-30 / src 1.200s-2.400s / SEG_REPLACE")
    }

    func testPreviewDiffsDescribeMoveAndRemoveBeforeTimelineMutation() {
        let timeline = makeTimeline()
        let draft = makeDraft(operations: [
            .moveSegment(
                target_clip_id: "CLP_0001",
                new_timeline_in_frame: 12,
                new_duration_frames: 24,
                target_track_id: nil,
                reason: "Move the opening beat."
            ),
            .removeSegment(
                target_clip_id: "CLP_0002",
                reason: "Remove duplicate beat."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(draft: draft, timeline: timeline)

        XCTAssertTrue(plan.canApply)
        XCTAssertEqual(plan.previewDiffs.map(\.operationName), ["move_segment", "remove_segment"])
        XCTAssertEqual(plan.previewDiffs[0].targetLabel, "CLP_0001")
        XCTAssertEqual(plan.previewDiffs[0].beforeLabel, "V1 frame 0-30 / src 0.000s-3.000s / SEG_CLP_0001")
        XCTAssertEqual(plan.previewDiffs[0].afterLabel, "V1 frame 12-36 / src 0.000s-3.000s / SEG_CLP_0001")
        XCTAssertEqual(plan.previewDiffs[1].targetLabel, "CLP_0002")
        XCTAssertEqual(plan.previewDiffs[1].beforeLabel, "V1 frame 30-60 / src 3.000s-6.000s / SEG_CLP_0002")
        XCTAssertEqual(plan.previewDiffs[1].afterLabel, "removed")
        XCTAssertEqual(timeline.clipSelection(for: "CLP_0001")?.clip.timelineInFrame, 0)
        XCTAssertEqual(timeline.clipSelection(for: "CLP_0002")?.clip.timelineInFrame, 30)
    }

    func testRejectsVersionMismatch() {
        let timeline = makeTimeline(version: "2")
        let draft = makeDraft(version: "1", operations: [
            .moveSegment(
                target_clip_id: "CLP_0001",
                new_timeline_in_frame: 12,
                new_duration_frames: nil,
                target_track_id: nil,
                reason: "Move earlier."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(draft: draft, timeline: timeline)

        XCTAssertFalse(plan.canApply)
        XCTAssertEqual(plan.operations, [])
        XCTAssertEqual(plan.updatedTimeline, timeline)
        XCTAssertEqual(plan.previewDiffs, [])
        XCTAssertEqual(plan.blockedReasons, ["timeline_versionが現在のタイムラインと異なるため表示へ反映できません。"])
    }

    func testUnsupportedOperationPreventsPartialApply() {
        let timeline = makeTimeline()
        let draft = makeDraft(operations: [
            .trimSegment(
                target_clip_id: "CLP_0001",
                new_src_in_us: 500_000,
                new_src_out_us: 3_000_000,
                reason: "Tighten opening."
            ),
            .insertSegment(
                beat_id: "beat-new",
                segment_id: "SEG_NEW",
                role: "support",
                new_timeline_in_frame: 60,
                new_duration_frames: 20,
                target_track_id: "V1",
                new_src_in_us: nil,
                new_src_out_us: nil,
                reason: "Add a new beat."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(draft: draft, timeline: timeline)

        XCTAssertFalse(plan.canApply)
        XCTAssertEqual(plan.operations, [])
        XCTAssertEqual(plan.updatedTimeline, timeline)
        XCTAssertEqual(plan.previewDiffs, [])
        XCTAssertEqual(plan.blockedReasons, ["insert_segment はまだTimeline表示への直接反映に対応していません。"])
    }

    func testReplaceSegmentWithoutCandidateDataSourcePreventsPartialApply() {
        let timeline = makeTimeline()
        let draft = makeDraft(operations: [
            .trimSegment(
                target_clip_id: "CLP_0001",
                new_src_in_us: 500_000,
                new_src_out_us: 3_000_000,
                reason: "Tighten opening."
            ),
            .replaceSegment(
                target_clip_id: "CLP_0002",
                with_segment_id: "SEG_REPLACE",
                with_candidate_ref: nil,
                new_src_in_us: nil,
                new_src_out_us: nil,
                reason: "Use a better shot."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(draft: draft, timeline: timeline)

        XCTAssertFalse(plan.canApply)
        XCTAssertEqual(plan.operations, [])
        XCTAssertEqual(plan.updatedTimeline, timeline)
        XCTAssertEqual(plan.previewDiffs, [])
        XCTAssertEqual(plan.blockedReasons, ["replace_segment を表示反映するにはselect候補の読み込みが必要です。"])
    }

    func testReplaceSegmentWithoutCandidateRefDoesNotResolveUnrelatedNilIDCandidate() {
        let timeline = makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "demo",
            candidates: [
                makeCandidate(
                    candidateID: nil,
                    segmentID: "SEG_OTHER",
                    assetID: "ASSET_OTHER",
                    role: "support",
                    confidence: 0.72
                ),
            ],
            beatPlans: []
        )
        let draft = makeDraft(operations: [
            .replaceSegment(
                target_clip_id: "CLP_0001",
                with_segment_id: "SEG_REPLACE",
                with_candidate_ref: nil,
                new_src_in_us: nil,
                new_src_out_us: nil,
                reason: "Use a better shot."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(
            draft: draft,
            timeline: timeline,
            candidateDataSource: dataSource
        )

        XCTAssertFalse(plan.canApply)
        XCTAssertEqual(plan.operations, [])
        XCTAssertEqual(plan.updatedTimeline, timeline)
        XCTAssertEqual(plan.previewDiffs, [])
        XCTAssertEqual(plan.blockedReasons, ["SEG_REPLACE に対応するselect候補を確認できません。"])
    }

    func testRejectsNonAdjacentTransition() {
        let timeline = makeTimeline(secondClipStart: 42)
        let draft = makeDraft(operations: [
            .setTransition(
                from_clip_id: "CLP_0001",
                to_clip_id: "CLP_0002",
                track_id: "V1",
                transition_type: "crossfade",
                transition_frames: 8,
                applied_skill_id: nil,
                reason: "Soften edit."
            ),
        ])

        let plan = TimelineAgentReviewPatchApplyPlan.evaluate(draft: draft, timeline: timeline)

        XCTAssertFalse(plan.canApply)
        XCTAssertEqual(plan.operations, [])
        XCTAssertEqual(plan.updatedTimeline, timeline)
        XCTAssertEqual(plan.previewDiffs, [])
        XCTAssertEqual(plan.blockedReasons, ["CLP_0001 → CLP_0002 は隣接していないためトランジションを反映できません。"])
    }

    private func makeDraft(
        version: String = "1",
        operations: [ReviewPatchOperation]
    ) -> TimelineAgentReviewPatchDraft {
        TimelineAgentReviewPatchDraft.extract(
            from: encodedPatch(version: version, operations: operations),
            expectedTimelineVersion: version
        )!
    }

    private func encodedPatch(version: String, operations: [ReviewPatchOperation]) -> String {
        let patch = ReviewPatchDocument(timeline_version: version, operations: operations)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try! encoder.encode(patch)
        return String(data: data, encoding: .utf8)!
    }

    private func makeTimeline(
        version: String = "1",
        secondClipStart: Int = 30
    ) -> TimelineDocument {
        TimelineDocument(
            version: version,
            projectID: "demo",
            sequence: TimelineSequence(
                name: "Agent Patch Apply",
                fpsNum: 30,
                fpsDen: 1,
                width: 1920,
                height: 1080,
                startFrame: 0,
                outputAspectRatio: "16:9"
            ),
            tracks: TimelineTrackCollection(
                video: [
                    TimelineTrack(
                        id: "V1",
                        kind: .video,
                        clips: [
                            makeClip(id: "CLP_0001", start: 0, sourceInUS: 0),
                            makeClip(id: "CLP_0002", start: secondClipStart, sourceInUS: 3_000_000),
                        ]
                    ),
                ],
                audio: [],
                overlay: [],
                caption: []
            ),
            markers: [],
            transitions: [],
            sourceHash: "hash"
        )
    }

    private func makeClip(
        id: String,
        start: Int,
        sourceInUS: Int
    ) -> TimelineClip {
        TimelineClip(
            id: id,
            segmentID: "SEG_\(id)",
            assetID: "ASSET_\(id)",
            sourceInUS: sourceInUS,
            sourceOutUS: sourceInUS + 3_000_000,
            timelineInFrame: start,
            timelineDurationFrames: 30,
            role: "hero",
            motivation: "fixture",
            confidence: 0.9,
            beatID: "beat-\(id)",
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: nil
        )
    }

    private func makeCandidate(
        candidateID: String?,
        segmentID: String,
        assetID: String,
        role: String,
        confidence: Double
    ) -> BrowserCandidate {
        BrowserCandidate(
            candidate_id: candidateID,
            segment_id: segmentID,
            asset_id: assetID,
            src_in_us: 1_000_000,
            src_out_us: 3_000_000,
            role: role,
            confidence: confidence,
            why_it_matches: "candidate \(segmentID)",
            risks: [],
            eligible_beats: ["beat"],
            story_role: nil,
            evidence: [],
            motif_tags: [],
            trim_hint: nil,
            editorial_signals: nil
        )
    }
}
