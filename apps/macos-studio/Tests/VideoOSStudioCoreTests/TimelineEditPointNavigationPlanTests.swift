import XCTest
@testable import VideoOSStudioCore

final class TimelineEditPointNavigationPlanTests: XCTestCase {
    func testNextJumpUsesNearestEditPointAndTransitionBoundary() throws {
        let timeline = try makeTimeline()

        let plan = TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: 12,
            direction: .next
        )

        XCTAssertEqual(plan?.frame, 60)
        XCTAssertEqual(plan?.timecode, "00:00:02:00")
        XCTAssertEqual(plan?.targetLabel, "トランジション / クリップ開始 / クリップ終了")
        XCTAssertEqual(plan?.statusMessage, "次の編集点 00:00:02:00 へ移動しました（トランジション / クリップ開始 / クリップ終了）。")
    }

    func testPreviousJumpPrefersNearestMarkerBeforePlayhead() throws {
        let timeline = try makeTimeline()

        let plan = TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: 100,
            direction: .previous
        )

        XCTAssertEqual(plan?.frame, 90)
        XCTAssertEqual(plan?.timecode, "00:00:03:00")
        XCTAssertEqual(plan?.targetLabel, "マーカー")
    }

    func testNextJumpIncludesClipOutAndTimelineEnd() throws {
        let timeline = try makeTimeline()

        let clipOut = TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: 90,
            direction: .next
        )
        XCTAssertEqual(clipOut?.frame, 120)
        XCTAssertEqual(clipOut?.targetLabel, "クリップ終了")

        let clipStart = TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: 121,
            direction: .next
        )
        XCTAssertEqual(clipStart?.frame, 150)
        XCTAssertEqual(clipStart?.targetLabel, "クリップ開始")

        let timelineEnd = TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: 151,
            direction: .next
        )
        XCTAssertEqual(timelineEnd?.frame, 180)
        XCTAssertEqual(timelineEnd?.targetLabel, "タイムライン末尾 / クリップ終了")
    }

    func testNavigationStopsAtTimelineBoundaries() throws {
        let timeline = try makeTimeline()

        XCTAssertNil(TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: 0,
            direction: .previous
        ))
        XCTAssertNil(TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: timeline.totalFrames,
            direction: .next
        ))
    }

    private func makeTimeline() throws -> TimelineDocument {
        let marker = try JSONDecoder().decode(TimelineMarker.self, from: Data("""
        { "marker_id": "M1", "frame": 90, "label": "beat", "kind": "beat" }
        """.utf8))
        return TimelineDocument(
            version: "1.0",
            projectID: "project",
            sequence: TimelineSequence(
                name: "Sequence",
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
                            makeClip(id: "CLP_A", start: 0, duration: 60),
                            makeClip(id: "CLP_B", start: 60, duration: 60),
                            makeClip(id: "CLP_C", start: 150, duration: 30)
                        ]
                    )
                ],
                audio: [],
                overlay: [],
                caption: []
            ),
            markers: [marker],
            transitions: [
                TimelineTransition(
                    id: "TRN_V1_CLP_A_CLP_B",
                    fromClipID: "CLP_A",
                    toClipID: "CLP_B",
                    trackID: "V1",
                    transitionType: "crossfade",
                    transitionFrames: 12,
                    appliedSkillID: nil
                )
            ]
        )
    }

    private func makeClip(id: String, start: Int, duration: Int) -> TimelineClip {
        TimelineClip(
            id: id,
            segmentID: "SEG_\(id)",
            assetID: "asset-\(id)",
            sourceInUS: nil,
            sourceOutUS: nil,
            timelineInFrame: start,
            timelineDurationFrames: duration,
            role: "main",
            motivation: "",
            confidence: nil,
            beatID: nil,
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: nil
        )
    }
}
