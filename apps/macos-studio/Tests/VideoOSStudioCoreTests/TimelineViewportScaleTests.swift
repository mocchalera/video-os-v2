import XCTest
@testable import VideoOSStudioCore

final class TimelineViewportScaleTests: XCTestCase {
    func testLaneWidthFitsViewportWhenFitModeIsEnabled() {
        let width = TimelineViewportScale.laneWidth(
            totalFrames: 2_400,
            viewportWidth: 960,
            pixelsPerFrame: TimelineViewportScale.defaultPixelsPerFrame,
            fitToViewport: true
        )

        XCTAssertEqual(width, 960)
        XCTAssertEqual(
            TimelineViewportScale.displayLabel(
                pixelsPerFrame: TimelineViewportScale.defaultPixelsPerFrame,
                fitToViewport: true
            ),
            "全体表示"
        )
    }

    func testLaneWidthUsesClampedDetailScaleOutsideFitMode() {
        XCTAssertEqual(
            TimelineViewportScale.laneWidth(
                totalFrames: 100,
                viewportWidth: 960,
                pixelsPerFrame: 0.01,
                fitToViewport: false
            ),
            960
        )
        XCTAssertEqual(
            TimelineViewportScale.laneWidth(
                totalFrames: 1_000,
                viewportWidth: 320,
                pixelsPerFrame: 99,
                fitToViewport: false
            ),
            12_800
        )
    }

    func testZoomStepsClampAndReportRelativePercent() {
        let zoomedIn = TimelineViewportScale.zoomedIn(from: TimelineViewportScale.defaultPixelsPerFrame)
        let zoomedOut = TimelineViewportScale.zoomedOut(from: TimelineViewportScale.defaultPixelsPerFrame)

        XCTAssertEqual(zoomedIn, 5.12, accuracy: 0.0001)
        XCTAssertEqual(zoomedOut, 2.0, accuracy: 0.0001)
        XCTAssertEqual(TimelineViewportScale.zoomedOut(from: 0.01), TimelineViewportScale.minimumPixelsPerFrame)
        XCTAssertEqual(TimelineViewportScale.zoomedIn(from: 99), TimelineViewportScale.maximumPixelsPerFrame)
        XCTAssertEqual(TimelineViewportScale.displayLabel(pixelsPerFrame: zoomedIn, fitToViewport: false), "160%")
    }

    func testTrackDensityHeightsKeepStandardTimelineStable() {
        XCTAssertEqual(TimelineTrackDensity.standard.rowHeight, 32)
        XCTAssertEqual(TimelineTrackDensity.standard.clipHeight, 28)
        XCTAssertEqual(TimelineTrackDensity.standard.laneLiftRowHeight, 64)
        XCTAssertEqual(TimelineTrackDensity.standard.transitionTargetHeight, 32)
        XCTAssertEqual(TimelineTrackDensity.standard.transitionTargetActiveHeight, 36)

        XCTAssertLessThan(TimelineTrackDensity.compact.rowHeight, TimelineTrackDensity.standard.rowHeight)
        XCTAssertGreaterThan(TimelineTrackDensity.expanded.rowHeight, TimelineTrackDensity.standard.rowHeight)
        XCTAssertEqual(TimelineTrackDensity.allCases.map(\.localizedLabel), ["密", "標準", "広"])
    }

    func testOverviewScaleMapsFramesAndClipRanges() {
        XCTAssertEqual(
            TimelineOverviewScale.normalizedPosition(frame: 250, totalFrames: 1_000),
            0.25,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            TimelineOverviewScale.xPosition(frame: 500, totalFrames: 1_000, width: 320),
            160,
            accuracy: 0.0001
        )
        XCTAssertEqual(TimelineOverviewScale.frame(atX: 80, width: 320, totalFrames: 1_000), 250)
        XCTAssertEqual(TimelineOverviewScale.frame(atX: -10, width: 320, totalFrames: 1_000), 0)
        XCTAssertEqual(TimelineOverviewScale.frame(atX: 999, width: 320, totalFrames: 1_000), 1_000)

        let range = TimelineOverviewScale.clippedRange(
            startFrame: 900,
            durationFrames: 250,
            totalFrames: 1_000
        )
        XCTAssertEqual(range.lowerBound, 0.9, accuracy: 0.0001)
        XCTAssertEqual(range.upperBound, 1.0, accuracy: 0.0001)
    }

    func testVisibleFrameRangeMapsScrolledViewportToTimelineFrames() {
        XCTAssertEqual(
            TimelineViewportScale.visibleFrameRange(
                laneOffsetX: 0,
                viewportLaneWidth: 320,
                laneWidth: 1_280,
                totalFrames: 2_400
            ),
            0...600
        )

        XCTAssertEqual(
            TimelineViewportScale.visibleFrameRange(
                laneOffsetX: 480,
                viewportLaneWidth: 320,
                laneWidth: 1_280,
                totalFrames: 2_400
            ),
            900...1_500
        )

        XCTAssertEqual(
            TimelineViewportScale.visibleFrameRange(
                laneOffsetX: 1_260,
                viewportLaneWidth: 320,
                laneWidth: 1_280,
                totalFrames: 2_400
            ),
            2_362...2_400
        )
    }

    func testVisibleFrameRangeReportsWholeTimelineWhenViewportCoversLane() {
        XCTAssertEqual(
            TimelineViewportScale.visibleFrameRange(
                laneOffsetX: -100,
                viewportLaneWidth: 1_600,
                laneWidth: 1_280,
                totalFrames: 2_400
            ),
            0...2_400
        )

        XCTAssertEqual(
            TimelineViewportScale.visibleFrameRange(
                laneOffsetX: 0,
                viewportLaneWidth: 320,
                laneWidth: 0,
                totalFrames: 2_400
            ),
            0...0
        )
    }

    func testShouldFollowPlayheadNearVisibleRangeEdgesOnly() {
        XCTAssertTrue(
            TimelineViewportScale.shouldFollowPlayhead(
                playheadFrame: 950,
                visibleFrameRange: 900...1_500,
                totalFrames: 2_400
            )
        )
        XCTAssertTrue(
            TimelineViewportScale.shouldFollowPlayhead(
                playheadFrame: 1_420,
                visibleFrameRange: 900...1_500,
                totalFrames: 2_400
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldFollowPlayhead(
                playheadFrame: 1_200,
                visibleFrameRange: 900...1_500,
                totalFrames: 2_400
            )
        )
    }

    func testShouldFollowPlayheadDoesNotRequestScrollWhenWholeTimelineIsVisible() {
        XCTAssertFalse(
            TimelineViewportScale.shouldFollowPlayhead(
                playheadFrame: 2_300,
                visibleFrameRange: 0...2_400,
                totalFrames: 2_400
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldFollowPlayhead(
                playheadFrame: 0,
                visibleFrameRange: 0...0,
                totalFrames: 0
            )
        )
    }

    func testShouldRevealPlayheadAfterNavigationOnlyNearEdgesOrOutsideVisibleRange() {
        XCTAssertTrue(
            TimelineViewportScale.shouldRevealPlayheadAfterNavigation(
                playheadFrame: 180,
                visibleFrameRange: 400...900,
                totalFrames: 1_200
            )
        )
        XCTAssertTrue(
            TimelineViewportScale.shouldRevealPlayheadAfterNavigation(
                playheadFrame: 840,
                visibleFrameRange: 400...900,
                totalFrames: 1_200
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldRevealPlayheadAfterNavigation(
                playheadFrame: 650,
                visibleFrameRange: 400...900,
                totalFrames: 1_200
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldRevealPlayheadAfterNavigation(
                playheadFrame: 1_100,
                visibleFrameRange: 0...1_200,
                totalFrames: 1_200
            )
        )
    }

    func testShouldRevealFrameDuringTimelineDragOnlyNearEdgesOrOutsideVisibleRange() {
        XCTAssertTrue(
            TimelineViewportScale.shouldRevealFrameDuringTimelineDrag(
                frame: 1_020,
                visibleFrameRange: 400...900,
                totalFrames: 1_200
            )
        )
        XCTAssertTrue(
            TimelineViewportScale.shouldRevealFrameDuringTimelineDrag(
                frame: 805,
                visibleFrameRange: 400...900,
                totalFrames: 1_200
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldRevealFrameDuringTimelineDrag(
                frame: 650,
                visibleFrameRange: 400...900,
                totalFrames: 1_200
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldRevealFrameDuringTimelineDrag(
                frame: 1_180,
                visibleFrameRange: 0...1_200,
                totalFrames: 1_200
            )
        )
    }

    func testTransitionDurationDragRevealFrameTargetsMovingEdge() {
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragRevealFrame(
                boundaryFrame: 500,
                existingDurationFrames: 60,
                frameDelta: 24,
                totalFrames: 1_200
            ),
            542
        )
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragRevealFrame(
                boundaryFrame: 500,
                existingDurationFrames: 60,
                frameDelta: -18,
                totalFrames: 1_200
            ),
            479
        )
    }

    func testTransitionDurationDragRevealFrameClampsToTimelineBounds() {
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragRevealFrame(
                boundaryFrame: 10,
                existingDurationFrames: 60,
                frameDelta: -30,
                totalFrames: 1_200
            ),
            0
        )
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragRevealFrame(
                boundaryFrame: 1_190,
                existingDurationFrames: 60,
                frameDelta: 30,
                totalFrames: 1_200
            ),
            1_200
        )
    }

    func testTransitionDurationDragViewerPreviewFrameTargetsVisibleInterior() {
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragViewerPreviewFrame(
                boundaryFrame: 500,
                existingDurationFrames: 60,
                frameDelta: 24,
                totalFrames: 1_200
            ),
            521
        )
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragViewerPreviewFrame(
                boundaryFrame: 500,
                existingDurationFrames: 60,
                frameDelta: -18,
                totalFrames: 1_200
            ),
            489
        )
    }

    func testTransitionDurationDragViewerPreviewFrameClampsToTimelineBounds() {
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragViewerPreviewFrame(
                boundaryFrame: 0,
                existingDurationFrames: 60,
                frameDelta: -30,
                totalFrames: 1_200
            ),
            0
        )
        XCTAssertEqual(
            TimelineViewportScale.transitionDurationDragViewerPreviewFrame(
                boundaryFrame: 1_200,
                existingDurationFrames: 60,
                frameDelta: 30,
                totalFrames: 1_200
            ),
            1_200
        )
    }

    func testTimelineSkimmingFrameMappingKeepsLaneAndClipFramesBounded() {
        XCTAssertEqual(
            TimelineViewportScale.timelineFrame(atLaneX: 160, laneWidth: 320, totalFrames: 1_000),
            500
        )
        XCTAssertEqual(
            TimelineViewportScale.timelineFrame(atLaneX: -12, laneWidth: 320, totalFrames: 1_000),
            0
        )
        XCTAssertEqual(
            TimelineViewportScale.timelineFrame(atLaneX: 999, laneWidth: 320, totalFrames: 1_000),
            1_000
        )

        XCTAssertEqual(
            TimelineViewportScale.timelineFrame(
                atClipLocalX: 0,
                clipStartFrame: 240,
                clipDurationFrames: 120,
                clipWidth: 60
            ),
            240
        )
        XCTAssertEqual(
            TimelineViewportScale.timelineFrame(
                atClipLocalX: 30,
                clipStartFrame: 240,
                clipDurationFrames: 120,
                clipWidth: 60
            ),
            300
        )
        XCTAssertEqual(
            TimelineViewportScale.timelineFrame(
                atClipLocalX: 60,
                clipStartFrame: 240,
                clipDurationFrames: 120,
                clipWidth: 60
            ),
            359
        )
    }

    func testTimelineSkimPreviewPublishThresholdSuppressesSubFrameChurn() {
        let threshold = TimelineViewportScale.defaultTimelineSkimPublishThresholdFrames

        XCTAssertTrue(
            TimelineViewportScale.shouldPublishTimelineSkimPreview(
                previousFrame: nil,
                previousTrackID: nil,
                previousClipID: nil,
                nextFrame: 24,
                nextTrackID: "V1",
                nextClipID: "clip-001"
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldPublishTimelineSkimPreview(
                previousFrame: 24,
                previousTrackID: "V1",
                previousClipID: "clip-001",
                nextFrame: 24,
                nextTrackID: "V1",
                nextClipID: "clip-001"
            )
        )
        XCTAssertFalse(
            TimelineViewportScale.shouldPublishTimelineSkimPreview(
                previousFrame: 24,
                previousTrackID: "V1",
                previousClipID: "clip-001",
                nextFrame: 24 + threshold - 1,
                nextTrackID: "V1",
                nextClipID: "clip-001"
            )
        )
        XCTAssertTrue(
            TimelineViewportScale.shouldPublishTimelineSkimPreview(
                previousFrame: 24,
                previousTrackID: "V1",
                previousClipID: "clip-001",
                nextFrame: 24 + threshold,
                nextTrackID: "V1",
                nextClipID: "clip-001"
            )
        )
        XCTAssertTrue(
            TimelineViewportScale.shouldPublishTimelineSkimPreview(
                previousFrame: 24,
                previousTrackID: "V1",
                previousClipID: "clip-001",
                nextFrame: 24,
                nextTrackID: "V1",
                nextClipID: "clip-002"
            )
        )
        XCTAssertTrue(
            TimelineViewportScale.shouldPublishTimelineSkimPreview(
                previousFrame: 24,
                previousTrackID: "V1",
                previousClipID: "clip-001",
                nextFrame: 24,
                nextTrackID: "A1",
                nextClipID: "clip-001"
            )
        )
    }

    func testThumbnailCellCountKeepsTimelineClipThumbnailsLegible() {
        XCTAssertEqual(TimelineViewportScale.thumbnailCellCount(clipWidth: 12), 0)
        XCTAssertEqual(TimelineViewportScale.thumbnailCellCount(clipWidth: 44), 1)
        XCTAssertEqual(TimelineViewportScale.thumbnailCellCount(clipWidth: 143), 1)
        XCTAssertEqual(TimelineViewportScale.thumbnailCellCount(clipWidth: 144), 2)
        XCTAssertEqual(TimelineViewportScale.thumbnailCellCount(clipWidth: 360), 4)
        XCTAssertEqual(TimelineViewportScale.thumbnailCellCount(clipWidth: 360, maximumCells: 0), 0)
    }
}
