import Foundation

public enum TimelineTrackDensity: String, CaseIterable, Identifiable, Sendable {
    case compact
    case standard
    case expanded

    public var id: String { rawValue }

    public var localizedLabel: String {
        switch self {
        case .compact: return "密"
        case .standard: return "標準"
        case .expanded: return "広"
        }
    }

    public var detailLabel: String {
        switch self {
        case .compact: return "密度高"
        case .standard: return "標準"
        case .expanded: return "広め"
        }
    }

    public var rowHeight: Double {
        switch self {
        case .compact: return 28
        case .standard: return 32
        case .expanded: return 40
        }
    }

    public var clipHeight: Double {
        switch self {
        case .compact: return 24
        case .standard: return 28
        case .expanded: return 34
        }
    }

    public var laneLiftRowHeight: Double {
        clipHeight * 2 + 8
    }

    public var transitionTargetHeight: Double {
        switch self {
        case .compact: return 26
        case .standard: return 32
        case .expanded: return 36
        }
    }

    public var transitionTargetActiveHeight: Double {
        switch self {
        case .compact: return 30
        case .standard: return 36
        case .expanded: return 40
        }
    }
}

public enum TimelineViewportScale {
    public static let defaultPixelsPerFrame: Double = 3.2
    public static let minimumPixelsPerFrame: Double = 0.8
    public static let maximumPixelsPerFrame: Double = 12.8
    public static let defaultTimelineSkimPublishThresholdFrames = 2

    public static func clampedPixelsPerFrame(_ value: Double) -> Double {
        min(max(value, minimumPixelsPerFrame), maximumPixelsPerFrame)
    }

    public static func zoomedIn(from value: Double) -> Double {
        clampedPixelsPerFrame(clampedPixelsPerFrame(value) * 1.6)
    }

    public static func zoomedOut(from value: Double) -> Double {
        clampedPixelsPerFrame(clampedPixelsPerFrame(value) / 1.6)
    }

    public static func laneWidth(
        totalFrames: Int,
        viewportWidth: Double,
        pixelsPerFrame: Double,
        fitToViewport: Bool
    ) -> Double {
        let safeViewportWidth = max(320, viewportWidth)
        guard !fitToViewport else { return safeViewportWidth }
        let detailWidth = Double(max(totalFrames, 1)) * clampedPixelsPerFrame(pixelsPerFrame)
        return max(safeViewportWidth, detailWidth)
    }

    public static func displayLabel(pixelsPerFrame: Double, fitToViewport: Bool) -> String {
        if fitToViewport { return "全体表示" }
        let percentage = Int((clampedPixelsPerFrame(pixelsPerFrame) / defaultPixelsPerFrame * 100).rounded())
        return "\(percentage)%"
    }

    public static func visibleFrameRange(
        laneOffsetX: Double,
        viewportLaneWidth: Double,
        laneWidth: Double,
        totalFrames: Int
    ) -> ClosedRange<Int> {
        let safeTotalFrames = max(0, totalFrames)
        guard safeTotalFrames > 0, laneWidth > 0 else { return 0...0 }

        let visibleWidth = max(0, min(viewportLaneWidth, laneWidth))
        let startX = max(0, min(laneOffsetX, laneWidth))
        let endX = max(startX, min(startX + visibleWidth, laneWidth))
        let startFrame = Int(floor(startX / laneWidth * Double(safeTotalFrames)))
        let endFrame = Int(ceil(endX / laneWidth * Double(safeTotalFrames)))
        return max(0, min(startFrame, safeTotalFrames))...max(0, min(endFrame, safeTotalFrames))
    }

    public static func shouldFollowPlayhead(
        playheadFrame: Int,
        visibleFrameRange: ClosedRange<Int>,
        totalFrames: Int,
        edgeMarginRatio: Double = 0.18
    ) -> Bool {
        let safeTotalFrames = max(0, totalFrames)
        guard safeTotalFrames > 0 else { return false }

        let lower = max(0, min(visibleFrameRange.lowerBound, safeTotalFrames))
        let upper = max(lower, min(visibleFrameRange.upperBound, safeTotalFrames))
        let visibleSpan = upper - lower
        guard visibleSpan > 0, visibleSpan < safeTotalFrames else { return false }

        let margin = max(1, Int((Double(visibleSpan) * max(0, min(edgeMarginRatio, 0.45))).rounded(.up)))
        let boundedPlayhead = max(0, min(playheadFrame, safeTotalFrames))
        return boundedPlayhead <= lower + margin || boundedPlayhead >= upper - margin
    }

    public static func shouldRevealPlayheadAfterNavigation(
        playheadFrame: Int,
        visibleFrameRange: ClosedRange<Int>,
        totalFrames: Int
    ) -> Bool {
        shouldFollowPlayhead(
            playheadFrame: playheadFrame,
            visibleFrameRange: visibleFrameRange,
            totalFrames: totalFrames,
            edgeMarginRatio: 0.14
        )
    }

    public static func shouldRevealFrameDuringTimelineDrag(
        frame: Int,
        visibleFrameRange: ClosedRange<Int>,
        totalFrames: Int
    ) -> Bool {
        shouldFollowPlayhead(
            playheadFrame: frame,
            visibleFrameRange: visibleFrameRange,
            totalFrames: totalFrames,
            edgeMarginRatio: 0.20
        )
    }

    public static func transitionDurationDragRevealFrame(
        boundaryFrame: Int,
        existingDurationFrames: Int,
        frameDelta: Int,
        totalFrames: Int
    ) -> Int {
        let safeTotalFrames = max(0, totalFrames)
        let safeBoundaryFrame = max(0, min(boundaryFrame, safeTotalFrames))
        let previewDurationFrames = max(1, existingDurationFrames + frameDelta)
        let previewHalfDuration = max(1, Int(ceil(Double(previewDurationFrames) / 2)))
        let edgeFrame = frameDelta < 0
            ? safeBoundaryFrame - previewHalfDuration
            : safeBoundaryFrame + previewHalfDuration
        return max(0, min(edgeFrame, safeTotalFrames))
    }

    public static func transitionDurationDragViewerPreviewFrame(
        boundaryFrame: Int,
        existingDurationFrames: Int,
        frameDelta: Int,
        totalFrames: Int
    ) -> Int {
        let safeTotalFrames = max(0, totalFrames)
        let safeBoundaryFrame = max(0, min(boundaryFrame, safeTotalFrames))
        let previewDurationFrames = max(1, existingDurationFrames + frameDelta)
        let leadingFrames = previewDurationFrames / 2
        let trailingFrames = previewDurationFrames - leadingFrames
        let previewOffset = if frameDelta < 0 {
            -Int(ceil(Double(leadingFrames) * 0.5))
        } else {
            Int(ceil(Double(max(0, trailingFrames - 1)) * 0.5))
        }
        return max(0, min(safeBoundaryFrame + previewOffset, safeTotalFrames))
    }

    public static func timelineFrame(
        atLaneX x: Double,
        laneWidth: Double,
        totalFrames: Int
    ) -> Int {
        guard laneWidth > 0, totalFrames > 0 else { return 0 }
        let boundedX = max(0, min(x, laneWidth))
        let frame = Int((boundedX / laneWidth * Double(totalFrames)).rounded(.down))
        return max(0, min(frame, totalFrames))
    }

    public static func timelineFrame(
        atClipLocalX x: Double,
        clipStartFrame: Int,
        clipDurationFrames: Int,
        clipWidth: Double
    ) -> Int {
        let safeDurationFrames = max(0, clipDurationFrames)
        guard clipWidth > 0, safeDurationFrames > 0 else {
            return max(0, clipStartFrame)
        }

        let boundedX = max(0, min(x, clipWidth))
        let offsetFrames = Int((boundedX / clipWidth * Double(safeDurationFrames)).rounded(.down))
        let firstFrame = max(0, clipStartFrame)
        let lastFrame = firstFrame + safeDurationFrames - 1
        return max(firstFrame, min(firstFrame + offsetFrames, lastFrame))
    }

    public static func shouldPublishTimelineSkimPreview(
        previousFrame: Int?,
        previousTrackID: String?,
        previousClipID: String?,
        nextFrame: Int,
        nextTrackID: String,
        nextClipID: String?,
        minimumFrameDelta: Int = defaultTimelineSkimPublishThresholdFrames
    ) -> Bool {
        guard previousTrackID == nextTrackID else { return true }
        guard previousClipID == nextClipID else { return true }
        guard let previousFrame else { return true }
        guard previousFrame != nextFrame else { return false }

        let threshold = max(1, minimumFrameDelta)
        return abs(nextFrame - previousFrame) >= threshold
    }

    public static func thumbnailCellCount(
        clipWidth: Double,
        minimumClipWidth: Double = 44,
        cellWidth: Double = 72,
        maximumCells: Int = 4
    ) -> Int {
        let safeWidth = max(0, clipWidth)
        guard maximumCells > 0, safeWidth >= max(0, minimumClipWidth) else { return 0 }

        let cellsByWidth = Int((safeWidth / max(1, cellWidth)).rounded(.down))
        return max(1, min(maximumCells, cellsByWidth))
    }
}

public enum TimelineOverviewScale {
    public static func normalizedPosition(frame: Int, totalFrames: Int) -> Double {
        guard totalFrames > 0 else { return 0 }
        let boundedFrame = max(0, min(frame, totalFrames))
        return Double(boundedFrame) / Double(totalFrames)
    }

    public static func xPosition(frame: Int, totalFrames: Int, width: Double) -> Double {
        max(0, width) * normalizedPosition(frame: frame, totalFrames: totalFrames)
    }

    public static func frame(atX x: Double, width: Double, totalFrames: Int) -> Int {
        guard width > 0, totalFrames > 0 else { return 0 }
        let boundedX = max(0, min(x, width))
        return max(0, min(Int((boundedX / width * Double(totalFrames)).rounded()), totalFrames))
    }

    public static func clippedRange(
        startFrame: Int,
        durationFrames: Int,
        totalFrames: Int
    ) -> ClosedRange<Double> {
        guard totalFrames > 0 else { return 0...0 }
        let start = max(0, min(startFrame, totalFrames))
        let end = max(start, min(start + max(0, durationFrames), totalFrames))
        return (Double(start) / Double(totalFrames))...(Double(end) / Double(totalFrames))
    }
}
