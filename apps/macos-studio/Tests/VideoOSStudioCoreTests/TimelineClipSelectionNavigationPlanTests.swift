import XCTest
@testable import VideoOSStudioCore

final class TimelineClipSelectionNavigationPlanTests: XCTestCase {
    func testNextAndPreviousNavigateWithinSelectedTrack() {
        let timeline = makeTimeline()

        let next = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: "CLP_B",
            currentSelectedClipIDs: ["CLP_B"],
            playheadFrame: 72,
            direction: .next,
            extendingSelection: false
        )
        XCTAssertEqual(next?.primaryClipID, "CLP_C")
        XCTAssertEqual(next?.selectedClipIDs, ["CLP_C"])
        XCTAssertEqual(next?.playheadFrame, 150)
        XCTAssertEqual(next?.statusMessage, "V1 の CLP_C を選択しました（00:00:05:00-00:00:06:00）。")

        let previous = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: "CLP_B",
            currentSelectedClipIDs: ["CLP_B"],
            playheadFrame: 72,
            direction: .previous,
            extendingSelection: false
        )
        XCTAssertEqual(previous?.primaryClipID, "CLP_A")
        XCTAssertEqual(previous?.selectedClipIDs, ["CLP_A"])
        XCTAssertEqual(previous?.playheadFrame, 0)
    }

    func testShiftNavigationExtendsContiguousRangeOnSelectedTrack() {
        let timeline = makeTimeline()

        let next = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: "CLP_B",
            currentSelectedClipIDs: ["CLP_A", "CLP_B"],
            playheadFrame: 72,
            direction: .next,
            extendingSelection: true
        )
        XCTAssertEqual(next?.primaryClipID, "CLP_C")
        XCTAssertEqual(next?.selectedClipIDs, ["CLP_A", "CLP_B", "CLP_C"])
        XCTAssertEqual(next?.statusMessage, "V1 の 3件を範囲選択しました（00:00:05:00-00:00:06:00）。")

        let previous = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: "CLP_B",
            currentSelectedClipIDs: ["CLP_B", "CLP_C"],
            playheadFrame: 72,
            direction: .previous,
            extendingSelection: true
        )
        XCTAssertEqual(previous?.primaryClipID, "CLP_A")
        XCTAssertEqual(previous?.selectedClipIDs, ["CLP_A", "CLP_B", "CLP_C"])
    }

    func testNavigationStartsFromPlayheadWhenNothingIsSelected() {
        let timeline = makeTimeline()

        let next = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: nil,
            currentSelectedClipIDs: [],
            playheadFrame: 70,
            direction: .next,
            extendingSelection: false
        )
        XCTAssertEqual(next?.primaryClipID, "CLP_B")
        XCTAssertEqual(next?.playheadFrame, 72)

        let previous = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: nil,
            currentSelectedClipIDs: [],
            playheadFrame: 140,
            direction: .previous,
            extendingSelection: false
        )
        XCTAssertEqual(previous?.primaryClipID, "CLP_B")
    }

    func testNavigationStopsAtTrackEdges() {
        let timeline = makeTimeline()

        XCTAssertNil(TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: "CLP_A",
            currentSelectedClipIDs: ["CLP_A"],
            playheadFrame: 0,
            direction: .previous,
            extendingSelection: false
        ))
        XCTAssertNil(TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: "CLP_C",
            currentSelectedClipIDs: ["CLP_C"],
            playheadFrame: 150,
            direction: .next,
            extendingSelection: false
        ))
    }

    private func makeTimeline() -> TimelineDocument {
        TimelineDocument(
            version: "1",
            projectID: "navigation-test",
            sequence: TimelineSequence(
                name: "Navigation Test",
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
                            makeClip(id: "CLP_B", start: 72, duration: 48),
                            makeClip(id: "CLP_C", start: 150, duration: 30)
                        ]
                    ),
                    TimelineTrack(
                        id: "V2",
                        kind: .video,
                        clips: [
                            makeClip(id: "CLP_D", start: 72, duration: 48)
                        ]
                    )
                ],
                audio: [],
                overlay: [],
                caption: []
            ),
            markers: []
        )
    }

    private func makeClip(id: String, start: Int, duration: Int) -> TimelineClip {
        TimelineClip(
            id: id,
            segmentID: "SEG_\(id)",
            assetID: "asset-\(id)",
            sourceInUS: 0,
            sourceOutUS: Int(Double(duration) / 30.0 * 1_000_000.0),
            timelineInFrame: start,
            timelineDurationFrames: duration,
            role: "broll",
            motivation: "test",
            confidence: 0.9,
            beatID: nil,
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: "candidate-\(id)"
        )
    }
}
