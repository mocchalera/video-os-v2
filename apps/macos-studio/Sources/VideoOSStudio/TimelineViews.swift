import AppKit
import AVFoundation
import SwiftUI
import UniformTypeIdentifiers
import VideoOSStudioCore

private let timelineTrackHeaderWidth: CGFloat = 48
private let timelineDetailScrollCoordinateSpaceName = "Timeline.DetailScrollCoordinateSpace"

private struct TimelineScrollContentFramePreferenceKey: PreferenceKey {
    static var defaultValue: CGRect = .zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

struct TimelinePanel: View {
    @EnvironmentObject private var feedbackSession: StudioFeedbackSession
    @AppStorage("VideoOSStudio.timelineFollowPlayheadEnabled") private var isTimelineFollowPlayheadEnabled = true
    @State private var activeMovePreview: TimelineClipMovePlan?
    @State private var activeGroupMovePreview: TimelineClipGroupMovePlan?
    @State private var activeBlockedMoveTarget: TimelineTrackMoveBlockedTarget?
    @State private var activeSourceDropPreview: TimelineSourceCandidateDropPreview?
    @State private var activeTransitionPresetDragID: String?
    @State private var transitionPresetDragToken = UUID()
    @State private var activeTransitionMoveID: TimelineTransition.ID?
    @State private var transitionMoveDragToken = UUID()
    @State private var playheadLocateRequest = 0
    @State private var timelineScrollContentFrame: CGRect = .zero
    @State private var lastFollowedPlayheadFrame: Int?
    @State private var activeDragRevealFrame: Int?

    var project: ProjectSummary?
    var timeline: TimelineDocument?
    var status: String
    var audioCues: [TimelineAudioCue]
    var audioWaveforms: [TimelineAudioWaveform]
    var assetDurationsUSByID: [String: Int]
    var thumbnailURLByAssetID: [String: URL]
    var audioWaveformStatus: String
    var recentlyChangedClipIDs: Set<String>
    var selectedClip: TimelineClipSelection?
    var selectedClipCount: Int
    var selectedClipIDs: Set<TimelineClip.ID>
    var sourceOverwritePreview: TimelineSourceOverwritePreview?
    var playbackLoopRange: TimelinePlaybackRange?
    var isLoopPlaybackEnabled: Bool
    var isPlaying: Bool
    var playheadRevealRequest: Int
    var timelineSkimPreview: TimelineSkimPreview?
    var timelineZoomLabel: String
    var timelinePixelsPerFrame: Double
    var isTimelineFitToWindowEnabled: Bool
    var timelineTrackDensity: TimelineTrackDensity
    var isSnappingEnabled: Bool
    var isBladeModeEnabled: Bool
    var canTrimSelectedClip: Bool
    var canTrimSelectedClipStartToPlayhead: Bool
    var canTrimSelectedClipEndToPlayhead: Bool
    var canExtendSelectedClipStart: Bool
    var canExtendSelectedClipEnd: Bool
    var canRollIncomingEditLeft: Bool
    var canRollIncomingEditRight: Bool
    var canRollOutgoingEditLeft: Bool
    var canRollOutgoingEditRight: Bool
    var canSlipSelectedClipLeft: Bool
    var canSlipSelectedClipRight: Bool
    var canSplitSelectedClipAtPlayhead: Bool
    var canDeleteSelection: Bool
    var canRippleDeleteSelectedClip: Bool
    var canNudgeSelectedClipEarlier: Bool
    var canNudgeSelectedClipLater: Bool
    var canRemoveSelectedTransition: Bool
    var canShortenSelectedTransition: Bool
    var canLengthenSelectedTransition: Bool
    var isPatchApplying: Bool
    @Binding var selectedClipID: TimelineClip.ID?
    @Binding var selectedTransitionID: TimelineTransition.ID?
    @Binding var isMultiSelectMode: Bool
    var playheadFrame: Int
    var onScrubPlayhead: (Int) -> Void
    var onPreviewTimelineSkim: (Int, TimelineTrack.ID, TimelineClip.ID?) -> Void
    var onEndTimelineSkim: () -> Void
    var onSelectClip: (TimelineClip.ID, Bool) -> Void
    var onSelectClipRange: (TimelineTrack.ID, ClosedRange<Int>) -> Void
    var onTimelineZoomChange: (Double) -> Void
    var onTrackDensityChange: (TimelineTrackDensity) -> Void
    var onZoomTimelineIn: () -> Void
    var onZoomTimelineOut: () -> Void
    var onFitTimelineToWindow: () -> Void
    var onResetTimelineZoom: () -> Void
    var onToggleMultiSelectMode: () -> Void
    var onToggleSnapping: () -> Void
    var onToggleBladeMode: () -> Void
    var onApproveSelected: () -> Void
    var onRejectSelected: () -> Void
    var onTrimSelectedStart: () -> Void
    var onTrimSelectedEnd: () -> Void
    var onTrimSelectedStartToPlayhead: () -> Void
    var onTrimSelectedEndToPlayhead: () -> Void
    var onExtendStart: () -> Void
    var onExtendEnd: () -> Void
    var onRollIncomingLeft: () -> Void
    var onRollIncomingRight: () -> Void
    var onRollOutgoingLeft: () -> Void
    var onRollOutgoingRight: () -> Void
    var onSlipLeft: () -> Void
    var onSlipRight: () -> Void
    var onNudgeEarlier: () -> Void
    var onNudgeLater: () -> Void
    var onSplitAtPlayhead: () -> Void
    var onDeleteSelection: () -> Void
    var onBladeSplitClip: (TimelineClip.ID, Int) -> Void
    var onPreviewDragTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int, Int) -> Void
    var onEndDragTrimPreview: () -> Void
    var onDragTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int, Int) -> Void
    var onPreviewRollTrim: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void
    var onEndRollTrimPreview: () -> Void
    var onDragRollTrim: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void
    var onPreviewSlipTrim: (TimelineClip.ID, Int) -> Void
    var onEndSlipTrimPreview: () -> Void
    var onDragSlipTrim: (TimelineClip.ID, Int) -> Void
    var onBeginClipBodyDrag: (TimelineClip.ID) -> Void
    var onDragMove: (TimelineClip.ID, Int, Int, TimelineTrack.ID?) -> Void
    var onPreviewMove: (TimelineClip.ID, Int, Int, TimelineTrack.ID?) -> Void
    var onEndMovePreview: () -> Void
    var onApplyTransitionPreset: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onApplyTransitionPresetNearContext: (String) -> Void
    var onPreviewTransitionPresetDrop: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewDefaultTransitionEditPointHover: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionMove: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onMoveTransition: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onSelectTransition: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onAdjustTransitionDuration: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID, Int) -> Void
    var onPreviewTransitionDuration: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID, Int) -> Void
    var onEndTransitionDurationPreview: () -> Void
    var onShortenSelectedTransition: () -> Void
    var onLengthenSelectedTransition: () -> Void
    var onRemoveSelectedTransition: () -> Void
    var onRippleDeleteSelected: () -> Void
    var onPreviewSourceCandidateDrop: (String, String, Int, TimelineTrack.ID, Int) -> TimelineSourceCandidateDropPreview?
    var onDropSourceCandidate: (String, String, Int, TimelineTrack.ID, Int) -> Void
    var onApplyPatch: () -> Void
    var onUndoPatch: () -> Void
    var onOpenSwapBrowser: (TimelineClip) -> Void
    var onOpenFootageSearch: (TimelineClip) -> Void
    var onRevealClipSource: (TimelineClip.ID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("タイムライン")
                    .font(.headline)
                Spacer()
                if timeline != nil {
                    TimelineViewportControls(
                        zoomLabel: timelineZoomLabel,
                        pixelsPerFrame: timelinePixelsPerFrame,
                        isFitToWindow: isTimelineFitToWindowEnabled,
                        isFollowPlayheadEnabled: isTimelineFollowPlayheadEnabled,
                        trackDensity: timelineTrackDensity,
                        onZoomChange: onTimelineZoomChange,
                        onToggleFollowPlayhead: {
                            isTimelineFollowPlayheadEnabled.toggle()
                            if isTimelineFollowPlayheadEnabled {
                                playheadLocateRequest += 1
                            }
                        },
                        onTrackDensityChange: onTrackDensityChange,
                        onZoomIn: onZoomTimelineIn,
                        onZoomOut: onZoomTimelineOut,
                        onFitToWindow: onFitTimelineToWindow,
                        onResetZoom: onResetTimelineZoom
                    )
                }
                Text(project?.hasTimeline == true ? "timeline.json" : "粗編集の生成待ち")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let timeline {
                TimelineEditToolbar(
                    feedbackSession: feedbackSession,
                    selectedClip: selectedClip,
                    selectedClips: selectedClipSelections(in: timeline),
                    selectedTransition: timeline.transitions.first { $0.id == selectedTransitionID },
                    selectedClipCount: selectedClipCount,
                    sequence: timeline.sequence,
                    isMultiSelectMode: $isMultiSelectMode,
                    isSnappingEnabled: isSnappingEnabled,
                    isBladeModeEnabled: isBladeModeEnabled,
                    onToggleMultiSelectMode: onToggleMultiSelectMode,
                    onToggleSnapping: onToggleSnapping,
                    onToggleBladeMode: onToggleBladeMode,
                    canTrimSelectedClip: canTrimSelectedClip,
                    canTrimSelectedClipStartToPlayhead: canTrimSelectedClipStartToPlayhead,
                    canTrimSelectedClipEndToPlayhead: canTrimSelectedClipEndToPlayhead,
                    canExtendSelectedClipStart: canExtendSelectedClipStart,
                    canExtendSelectedClipEnd: canExtendSelectedClipEnd,
                    canRollIncomingEditLeft: canRollIncomingEditLeft,
                    canRollIncomingEditRight: canRollIncomingEditRight,
                    canRollOutgoingEditLeft: canRollOutgoingEditLeft,
                    canRollOutgoingEditRight: canRollOutgoingEditRight,
                    canSlipSelectedClipLeft: canSlipSelectedClipLeft,
                    canSlipSelectedClipRight: canSlipSelectedClipRight,
                    canSplitSelectedClipAtPlayhead: canSplitSelectedClipAtPlayhead,
                    canDeleteSelection: canDeleteSelection,
                    canRippleDeleteSelectedClip: canRippleDeleteSelectedClip,
                    canNudgeSelectedClipEarlier: canNudgeSelectedClipEarlier,
                    canNudgeSelectedClipLater: canNudgeSelectedClipLater,
                    canRemoveSelectedTransition: canRemoveSelectedTransition,
                    canShortenSelectedTransition: canShortenSelectedTransition,
                    canLengthenSelectedTransition: canLengthenSelectedTransition,
                    isPatchApplying: isPatchApplying,
                    onApprove: onApproveSelected,
                    onReject: onRejectSelected,
                    onTrimStart: onTrimSelectedStart,
                    onTrimEnd: onTrimSelectedEnd,
                    onTrimStartToPlayhead: onTrimSelectedStartToPlayhead,
                    onTrimEndToPlayhead: onTrimSelectedEndToPlayhead,
                    onExtendStart: onExtendStart,
                    onExtendEnd: onExtendEnd,
                    onRollIncomingLeft: onRollIncomingLeft,
                    onRollIncomingRight: onRollIncomingRight,
                    onRollOutgoingLeft: onRollOutgoingLeft,
                    onRollOutgoingRight: onRollOutgoingRight,
                    onSlipLeft: onSlipLeft,
                    onSlipRight: onSlipRight,
                    onNudgeEarlier: onNudgeEarlier,
                    onNudgeLater: onNudgeLater,
                    onSplitAtPlayhead: onSplitAtPlayhead,
                    onDeleteSelection: onDeleteSelection,
                    onRippleDelete: onRippleDeleteSelected,
                    onSwap: {
                        guard let clip = selectedClip?.clip else { return }
                        onOpenSwapBrowser(clip)
                    },
                    onSearch: {
                        guard let clip = selectedClip?.clip else { return }
                        onOpenFootageSearch(clip)
                    },
                    activeTransitionPresetDragID: activeTransitionPresetDragID,
                    onBeginTransitionPresetDrag: beginTransitionPresetDrag,
                    onApplyTransitionPresetNearContext: onApplyTransitionPresetNearContext,
                    onShortenTransition: onShortenSelectedTransition,
                    onLengthenTransition: onLengthenSelectedTransition,
                    onRemoveTransition: onRemoveSelectedTransition,
                    onApplyPatch: onApplyPatch,
                    onUndoPatch: onUndoPatch
                )
                TimelineRuler(
                    timeline: timeline,
                    playheadFrame: playheadFrame,
                    playbackLoopRange: playbackLoopRange,
                    isLoopPlaybackEnabled: isLoopPlaybackEnabled,
                    isSnappingEnabled: isSnappingEnabled,
                    onScrubPlayhead: onScrubPlayhead
                )
                Text(audioWaveformStatus)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Slider(
                    value: Binding(
                        get: { Double(playheadFrame) },
                        set: { onScrubPlayhead(Int($0.rounded())) }
                    ),
                    in: 0...Double(max(timeline.totalFrames, 1)),
                    step: 1
                )
                GeometryReader { geometry in
                    let labelWidth = timelineTrackHeaderWidth
                    let rowSpacing: CGFloat = 10
                    let trailingPadding: CGFloat = 18
                    let viewportLaneWidth = max(320, geometry.size.width - labelWidth - rowSpacing - trailingPadding)
                    let laneWidth = CGFloat(TimelineViewportScale.laneWidth(
                        totalFrames: timeline.totalFrames,
                        viewportWidth: Double(viewportLaneWidth),
                        pixelsPerFrame: timelinePixelsPerFrame,
                        fitToViewport: isTimelineFitToWindowEnabled
                    ))
                    let visibleFrameRange = TimelineViewportScale.visibleFrameRange(
                        laneOffsetX: Double(timelineVisibleLaneOffsetX(
                            contentFrame: timelineScrollContentFrame,
                            laneLeadingX: labelWidth + rowSpacing
                        )),
                        viewportLaneWidth: Double(viewportLaneWidth),
                        laneWidth: Double(laneWidth),
                        totalFrames: timeline.totalFrames
                    )
                    let recommendedTransitionDropTargetID = recommendedTransitionDropTargetID(in: timeline)

                    VStack(alignment: .leading, spacing: 6) {
                        TimelineOverviewStrip(
                            timeline: timeline,
                            playheadFrame: playheadFrame,
                            visibleFrameRange: visibleFrameRange,
                            playbackLoopRange: playbackLoopRange,
                            isLoopPlaybackEnabled: isLoopPlaybackEnabled,
                            isSnappingEnabled: isSnappingEnabled,
                            onScrubPlayhead: { frame in
                                onScrubPlayhead(frame)
                                playheadLocateRequest += 1
                            },
                            onLocatePlayhead: {
                                playheadLocateRequest += 1
                            }
                        )
                        .frame(height: 60)

                        ScrollViewReader { scrollProxy in
                            ScrollView([.horizontal, .vertical]) {
                                VStack(alignment: .leading, spacing: 6) {
                                    TimelinePlayheadScrollAnchorRow(
                                        playheadFrame: playheadFrame,
                                        dragRevealFrame: activeDragRevealFrame,
                                        totalFrames: timeline.totalFrames,
                                        laneWidth: laneWidth
                                    )
                                    .frame(height: 1)
                                    TimelineMarkerLane(
                                        markers: ProjectTimelineMarkerMap.build(timeline: timeline).markers,
                                        totalFrames: timeline.totalFrames,
                                        playheadFrame: playheadFrame,
                                        laneWidth: laneWidth
                                    )
                                    ForEach(timeline.displayTracks) { track in
                                        TimelineTrackRow(
                                            timeline: timeline,
                                            track: track,
                                            totalFrames: timeline.totalFrames,
                                            laneWidth: laneWidth,
                                            audioCues: audioCues.filter { $0.trackID == track.id },
                                            audioWaveforms: audioWaveforms.filter { $0.trackID == track.id },
                                            assetDurationsUSByID: assetDurationsUSByID,
                                            thumbnailURLByAssetID: thumbnailURLByAssetID,
                                            trackDensity: timelineTrackDensity,
                                            recentlyChangedClipIDs: recentlyChangedClipIDs,
                                            selectedClipIDs: selectedClipIDs,
                                            sourceOverwritePreview: sourceOverwritePreview,
                                            isSnappingEnabled: isSnappingEnabled,
                                            isMultiSelectMode: isMultiSelectMode,
                                            isBladeModeEnabled: isBladeModeEnabled,
                                            selectedClipID: $selectedClipID,
                                            selectedTransitionID: $selectedTransitionID,
                                            activeMovePreview: $activeMovePreview,
                                            activeGroupMovePreview: $activeGroupMovePreview,
                                            activeBlockedMoveTarget: $activeBlockedMoveTarget,
                                            activeSourceDropPreview: $activeSourceDropPreview,
                                            activeDragRevealFrame: $activeDragRevealFrame,
                                            activeTransitionPresetDragID: activeTransitionPresetDragID,
                                            activeTransitionMoveID: activeTransitionMoveID,
                                            recommendedTransitionDropTargetID: recommendedTransitionDropTargetID,
                                            playheadFrame: playheadFrame,
                                            timelineSkimPreview: timelineSkimPreview,
                                            transitions: timeline.transitions.filter { $0.trackID == track.id },
                                            onSelectClip: onSelectClip,
                                            onSelectClipRange: onSelectClipRange,
                                            onScrubPlayhead: onScrubPlayhead,
                                            onPreviewTimelineSkim: onPreviewTimelineSkim,
                                            onEndTimelineSkim: onEndTimelineSkim,
                                            onBladeSplitClip: onBladeSplitClip,
                                            onPreviewDragTrim: onPreviewDragTrim,
                                            onEndDragTrimPreview: onEndDragTrimPreview,
                                            onDragTrim: onDragTrim,
                                            onPreviewRollTrim: onPreviewRollTrim,
                                            onEndRollTrimPreview: onEndRollTrimPreview,
                                            onDragRollTrim: onDragRollTrim,
                                            onPreviewSlipTrim: onPreviewSlipTrim,
                                            onEndSlipTrimPreview: onEndSlipTrimPreview,
                                            onDragSlipTrim: onDragSlipTrim,
                                            onBeginClipBodyDrag: onBeginClipBodyDrag,
                                            onDragMove: onDragMove,
                                            onPreviewMove: onPreviewMove,
                                            onEndMovePreview: onEndMovePreview,
                                            onApplyTransitionPreset: onApplyTransitionPreset,
                                            onPreviewTransitionPresetDrop: onPreviewTransitionPresetDrop,
                                            onPreviewDefaultTransitionEditPointHover: onPreviewDefaultTransitionEditPointHover,
                                            onPreviewTransitionMove: onPreviewTransitionMove,
                                            onMoveTransition: onMoveTransition,
                                            onSelectTransition: onSelectTransition,
                                            onAdjustTransitionDuration: onAdjustTransitionDuration,
                                            onPreviewTransitionDuration: onPreviewTransitionDuration,
                                            onEndTransitionDurationPreview: onEndTransitionDurationPreview,
                                            onBeginTransitionMoveDrag: beginTransitionMoveDrag,
                                            onEndTransitionPresetDrag: endTransitionPresetDrag,
                                            onEndTransitionMoveDrag: endTransitionMoveDrag,
                                            onPreviewSourceCandidateDrop: onPreviewSourceCandidateDrop,
                                            onDropSourceCandidate: onDropSourceCandidate,
                                            onOpenSwapBrowser: onOpenSwapBrowser,
                                            onOpenFootageSearch: onOpenFootageSearch,
                                            onRevealClipSource: onRevealClipSource
                                        )
                                    }
                                }
                                .padding(.trailing, trailingPadding)
                                .frame(
                                    minWidth: geometry.size.width,
                                    maxWidth: .infinity,
                                    alignment: .topLeading
                                )
                                .background(
                                    GeometryReader { proxy in
                                        Color.clear.preference(
                                            key: TimelineScrollContentFramePreferenceKey.self,
                                            value: proxy.frame(in: .named(timelineDetailScrollCoordinateSpaceName))
                                        )
                                    }
                                )
                            }
                            .coordinateSpace(name: timelineDetailScrollCoordinateSpaceName)
                            .onPreferenceChange(TimelineScrollContentFramePreferenceKey.self) { frame in
                                if timelineScrollContentFrame != frame {
                                    timelineScrollContentFrame = frame
                                }
                            }
                            .onChange(of: playheadLocateRequest) { _, _ in
                                withAnimation(.easeOut(duration: 0.18)) {
                                    scrollProxy.scrollTo(TimelineScrollTarget.playhead, anchor: .center)
                                }
                            }
                            .onChange(of: playheadRevealRequest) { _, _ in
                                guard TimelineViewportScale.shouldRevealPlayheadAfterNavigation(
                                    playheadFrame: playheadFrame,
                                    visibleFrameRange: visibleFrameRange,
                                    totalFrames: timeline.totalFrames
                                ) else { return }

                                withAnimation(.easeOut(duration: 0.18)) {
                                    scrollProxy.scrollTo(TimelineScrollTarget.playhead, anchor: .center)
                                }
                            }
                            .onChange(of: activeDragRevealFrame) { _, frame in
                                guard let frame,
                                      TimelineViewportScale.shouldRevealFrameDuringTimelineDrag(
                                        frame: frame,
                                        visibleFrameRange: visibleFrameRange,
                                        totalFrames: timeline.totalFrames
                                      )
                                else { return }

                                withAnimation(.linear(duration: 0.10)) {
                                    scrollProxy.scrollTo(TimelineScrollTarget.dragReveal, anchor: .center)
                                }
                            }
                            .onChange(of: playheadFrame) { _, newFrame in
                                guard isPlaying, isTimelineFollowPlayheadEnabled else { return }
                                guard TimelineViewportScale.shouldFollowPlayhead(
                                    playheadFrame: newFrame,
                                    visibleFrameRange: visibleFrameRange,
                                    totalFrames: timeline.totalFrames
                                ) else { return }

                                let visibleSpan = max(1, visibleFrameRange.upperBound - visibleFrameRange.lowerBound)
                                let minimumFollowDelta = max(1, visibleSpan / 12)
                                if let lastFollowedPlayheadFrame,
                                   abs(newFrame - lastFollowedPlayheadFrame) < minimumFollowDelta {
                                    return
                                }

                                lastFollowedPlayheadFrame = newFrame
                                withAnimation(.linear(duration: 0.12)) {
                                    scrollProxy.scrollTo(TimelineScrollTarget.playhead, anchor: .center)
                                }
                            }
                            .onChange(of: isTimelineFollowPlayheadEnabled) { _, isEnabled in
                                guard isEnabled else {
                                    lastFollowedPlayheadFrame = nil
                                    return
                                }
                                lastFollowedPlayheadFrame = playheadFrame
                                withAnimation(.easeOut(duration: 0.18)) {
                                    scrollProxy.scrollTo(TimelineScrollTarget.playhead, anchor: .center)
                                }
                            }
                            .onChange(of: isPlaying) { _, isPlaying in
                                if !isPlaying {
                                    lastFollowedPlayheadFrame = nil
                                }
                            }
                        }
                    }
                }
                .frame(minHeight: 132, maxHeight: .infinity)
            } else {
                TimelineEmptyState(status: status)
            }
        }
        .padding(18)
    }

    private func beginTransitionPresetDrag(_ presetID: String) {
        activeTransitionPresetDragID = presetID
        if let timeline,
           let target = recommendedTransitionDropTarget(in: timeline) {
            onPreviewTransitionPresetDrop(
                presetID,
                target.trackID,
                target.fromClipID,
                target.toClipID
            )
        }
        let token = UUID()
        transitionPresetDragToken = token
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            guard transitionPresetDragToken == token else { return }
            activeTransitionPresetDragID = nil
            onEndTransitionDurationPreview()
        }
    }

    private func endTransitionPresetDrag() {
        transitionPresetDragToken = UUID()
        activeTransitionPresetDragID = nil
        onEndTransitionDurationPreview()
    }

    private func beginTransitionMoveDrag(_ transitionID: TimelineTransition.ID) {
        activeTransitionMoveID = transitionID
        let token = UUID()
        transitionMoveDragToken = token
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            guard transitionMoveDragToken == token else { return }
            activeTransitionMoveID = nil
        }
    }

    private func endTransitionMoveDrag() {
        transitionMoveDragToken = UUID()
        activeTransitionMoveID = nil
    }

    private func timelineVisibleLaneOffsetX(contentFrame: CGRect, laneLeadingX: CGFloat) -> CGFloat {
        let contentOffsetX = max(0, -contentFrame.minX)
        return max(0, contentOffsetX - laneLeadingX)
    }

    private func recommendedTransitionDropTargetID(in timeline: TimelineDocument) -> TimelineTransition.ID? {
        guard activeTransitionPresetDragID != nil else { return nil }
        return recommendedTransitionDropTarget(in: timeline)?.transitionID
    }

    private func recommendedTransitionDropTarget(in timeline: TimelineDocument) -> TimelineTransitionPlacementTarget? {
        var ids = selectedClipIDs
        if let selectedClipID {
            ids.insert(selectedClipID)
        }
        let blockedClipIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.id).filter {
            feedbackSession.hasPendingRemove(for: $0) || feedbackSession.rejectedClipIDs.contains($0)
        })
        return TimelineTransitionPlacementResolver.resolve(
            timeline: timeline,
            selectedClipIDs: ids,
            selectedTransitionID: selectedTransitionID,
            playheadFrame: playheadFrame,
            blockedClipIDs: blockedClipIDs
        )
    }

    private func selectedClipSelections(in timeline: TimelineDocument) -> [TimelineClipSelection] {
        let ids: Set<TimelineClip.ID>
        if !selectedClipIDs.isEmpty {
            ids = selectedClipIDs
        } else if let selectedClip {
            ids = [selectedClip.clip.id]
        } else {
            ids = []
        }

        guard !ids.isEmpty else { return [] }

        return timeline.displayTracks
            .flatMap { track in
                track.clips.compactMap { clip -> TimelineClipSelection? in
                    guard ids.contains(clip.id) else { return nil }
                    return TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip)
                }
            }
            .sorted { lhs, rhs in
                if lhs.clip.timelineInFrame == rhs.clip.timelineInFrame {
                    if lhs.trackID == rhs.trackID {
                        return lhs.clip.id < rhs.clip.id
                    }
                    return lhs.trackID < rhs.trackID
                }
                return lhs.clip.timelineInFrame < rhs.clip.timelineInFrame
            }
    }
}

private struct TimelineViewportControls: View {
    var zoomLabel: String
    var pixelsPerFrame: Double
    var isFitToWindow: Bool
    var isFollowPlayheadEnabled: Bool
    var trackDensity: TimelineTrackDensity
    var onZoomChange: (Double) -> Void
    var onToggleFollowPlayhead: () -> Void
    var onTrackDensityChange: (TimelineTrackDensity) -> Void
    var onZoomIn: () -> Void
    var onZoomOut: () -> Void
    var onFitToWindow: () -> Void
    var onResetZoom: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onZoomOut) {
                Image(systemName: "minus.magnifyingglass")
            }
            .buttonStyle(.borderless)
            .help("タイムラインを縮小（タイムラインフォーカス時 -）")
            .accessibilityLabel("タイムラインを縮小")
            .accessibilityIdentifier("Timeline.ZoomOut")

            Slider(
                value: Binding(
                    get: { pixelsPerFrame },
                    set: { onZoomChange($0) }
                ),
                in: TimelineViewportScale.minimumPixelsPerFrame...TimelineViewportScale.maximumPixelsPerFrame
            )
            .frame(width: 92)
            .disabled(isFitToWindow)
            .help(isFitToWindow ? "全体表示中です。拡大/縮小または100%で詳細表示に戻ります。" : "タイムライン表示倍率")
            .accessibilityLabel("タイムライン表示倍率")
            .accessibilityValue(zoomLabel)
            .accessibilityIdentifier("Timeline.ZoomSlider")

            Button(action: onZoomIn) {
                Image(systemName: "plus.magnifyingglass")
            }
            .buttonStyle(.borderless)
            .help("タイムラインを拡大（タイムラインフォーカス時 =）")
            .accessibilityLabel("タイムラインを拡大")
            .accessibilityIdentifier("Timeline.ZoomIn")

            Button("全体", action: onFitToWindow)
                .buttonStyle(.borderless)
                .font(.caption.weight(.semibold))
                .help("タイムライン全体を現在の幅に収めます")
                .accessibilityIdentifier("Timeline.FitToWindow")

            Button("100%", action: onResetZoom)
                .buttonStyle(.borderless)
                .font(.caption.weight(.semibold))
                .help("タイムライン倍率を標準へ戻します")
                .accessibilityIdentifier("Timeline.ResetZoom")

            Text(zoomLabel)
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(isFitToWindow ? .green : .secondary)
                .frame(width: 54, alignment: .trailing)
                .accessibilityIdentifier("Timeline.ZoomLabel")

            Toggle(isOn: Binding(
                get: { isFollowPlayheadEnabled },
                set: { _ in onToggleFollowPlayhead() }
            )) {
                Label("追従", systemImage: "scope")
                    .labelStyle(.titleAndIcon)
                    .font(.caption.weight(.semibold))
                    .fixedSize(horizontal: true, vertical: false)
            }
            .toggleStyle(.button)
            .help(isFollowPlayheadEnabled ? "再生中に再生位置が表示範囲の端へ近づいたらタイムラインを追従します" : "再生中のタイムライン自動追従を停止しています")
            .accessibilityLabel("再生位置へ追従")
            .accessibilityValue(isFollowPlayheadEnabled ? "オン" : "オフ")
            .accessibilityIdentifier("Timeline.FollowPlayhead")

            Picker(
                "密度",
                selection: Binding(
                    get: { trackDensity },
                    set: { onTrackDensityChange($0) }
                )
            ) {
                ForEach(TimelineTrackDensity.allCases) { density in
                    Text(density.localizedLabel)
                        .tag(density)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 104)
            .help("トラックの高さ: \(trackDensity.detailLabel)")
            .accessibilityLabel("タイムライントラック密度")
            .accessibilityValue(trackDensity.detailLabel)
            .accessibilityIdentifier("Timeline.TrackDensityPicker")
        }
        .controlSize(.small)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Timeline.ViewportControls")
    }
}

struct TimelineEditToolbar: View {
    @ObservedObject var feedbackSession: StudioFeedbackSession

    var selectedClip: TimelineClipSelection?
    var selectedClips: [TimelineClipSelection]
    var selectedTransition: TimelineTransition?
    var selectedClipCount: Int
    var sequence: TimelineSequence
    @Binding var isMultiSelectMode: Bool
    var isSnappingEnabled: Bool
    var isBladeModeEnabled: Bool
    var onToggleMultiSelectMode: () -> Void
    var onToggleSnapping: () -> Void
    var onToggleBladeMode: () -> Void
    var canTrimSelectedClip: Bool
    var canTrimSelectedClipStartToPlayhead: Bool
    var canTrimSelectedClipEndToPlayhead: Bool
    var canExtendSelectedClipStart: Bool
    var canExtendSelectedClipEnd: Bool
    var canRollIncomingEditLeft: Bool
    var canRollIncomingEditRight: Bool
    var canRollOutgoingEditLeft: Bool
    var canRollOutgoingEditRight: Bool
    var canSlipSelectedClipLeft: Bool
    var canSlipSelectedClipRight: Bool
    var canSplitSelectedClipAtPlayhead: Bool
    var canDeleteSelection: Bool
    var canRippleDeleteSelectedClip: Bool
    var canNudgeSelectedClipEarlier: Bool
    var canNudgeSelectedClipLater: Bool
    var canRemoveSelectedTransition: Bool
    var canShortenSelectedTransition: Bool
    var canLengthenSelectedTransition: Bool
    var isPatchApplying: Bool
    var onApprove: () -> Void
    var onReject: () -> Void
    var onTrimStart: () -> Void
    var onTrimEnd: () -> Void
    var onTrimStartToPlayhead: () -> Void
    var onTrimEndToPlayhead: () -> Void
    var onExtendStart: () -> Void
    var onExtendEnd: () -> Void
    var onRollIncomingLeft: () -> Void
    var onRollIncomingRight: () -> Void
    var onRollOutgoingLeft: () -> Void
    var onRollOutgoingRight: () -> Void
    var onSlipLeft: () -> Void
    var onSlipRight: () -> Void
    var onNudgeEarlier: () -> Void
    var onNudgeLater: () -> Void
    var onSplitAtPlayhead: () -> Void
    var onDeleteSelection: () -> Void
    var onRippleDelete: () -> Void
    var onSwap: () -> Void
    var onSearch: () -> Void
    var activeTransitionPresetDragID: String?
    var onBeginTransitionPresetDrag: (String) -> Void
    var onApplyTransitionPresetNearContext: (String) -> Void
    var onShortenTransition: () -> Void
    var onLengthenTransition: () -> Void
    var onRemoveTransition: () -> Void
    var onApplyPatch: () -> Void
    var onUndoPatch: () -> Void

    private var hasSelectedClip: Bool {
        selectedClipCount > 0
    }

    private var hasSingleSelectedClip: Bool {
        selectedClipCount == 1 && selectedClip != nil
    }

    private var hasPendingPatch: Bool {
        feedbackSession.isDirty
    }

    private var hasPatchConflicts: Bool {
        !feedbackSession.detectConflicts().isEmpty
    }

    private var canUndoPatch: Bool {
        !feedbackSession.patchHistory.isEmpty
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                selectedItemSummary

                toolbarSection("Timeline.EditToolbar.Section.Modes", label: "タイムライン操作モード") {
                    Toggle(isOn: Binding(
                        get: { isMultiSelectMode },
                        set: { _ in onToggleMultiSelectMode() }
                    )) {
                        Label("複数選択", systemImage: "checklist")
                            .labelStyle(.titleAndIcon)
                            .font(.caption.weight(.semibold))
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .toggleStyle(.button)
                    .controlSize(.small)
                    .help("オンにすると、クリックしたクリップを選択に追加/解除します。Command/Shiftクリックでも追加/解除できます")
                    .accessibilityIdentifier("Timeline.EditToolbar.MultiSelectMode")

                    Toggle(isOn: Binding(
                        get: { isSnappingEnabled },
                        set: { _ in onToggleSnapping() }
                    )) {
                        Label("吸着", systemImage: "magnet")
                            .labelStyle(.titleAndIcon)
                            .font(.caption.weight(.semibold))
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .toggleStyle(.button)
                    .controlSize(.small)
                    .help(isSnappingEnabled
                        ? "オン: ドラッグとスクラブは近い編集点、再生位置、マーカーへ吸着します。タイムラインフォーカス時はNキーで切り替えます"
                        : "オフ: ドラッグとスクラブはカーソル位置を優先します。タイムラインフォーカス時はNキーで切り替えます")
                    .accessibilityLabel("タイムライン吸着")
                    .accessibilityValue(isSnappingEnabled ? "オン" : "オフ")
                    .accessibilityIdentifier("Timeline.EditToolbar.Snapping")

                    Toggle(isOn: Binding(
                        get: { isBladeModeEnabled },
                        set: { _ in onToggleBladeMode() }
                    )) {
                        Label("ブレード", systemImage: "scissors")
                            .labelStyle(.titleAndIcon)
                            .font(.caption.weight(.semibold))
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .toggleStyle(.button)
                    .controlSize(.small)
                    .help("オンにすると、タイムライン上のクリップをクリックした位置で分割します。タイムラインフォーカス時はBキーで切り替えます")
                    .accessibilityIdentifier("Timeline.EditToolbar.BladeMode")
                }

                toolbarSection("Timeline.EditToolbar.Section.Transitions", label: "トランジション編集") {
                    TimelineTransitionPresetPalette(
                        activePresetDragID: activeTransitionPresetDragID,
                        onBeginDrag: onBeginTransitionPresetDrag,
                        onApply: onApplyTransitionPresetNearContext
                    )

                    toolbarButton("長さ−", systemImage: "minus", accessibilityID: "Timeline.EditToolbar.TransitionDurationShorter", action: onShortenTransition)
                        .disabled(!hasSelectedTransition || !canShortenSelectedTransition)
                        .help("選択中のトランジションを0.5秒短くします")

                    toolbarButton("長さ＋", systemImage: "plus", accessibilityID: "Timeline.EditToolbar.TransitionDurationLonger", action: onLengthenTransition)
                        .disabled(!hasSelectedTransition || !canLengthenSelectedTransition)
                        .help("選択中のトランジションを0.5秒長くします")

                    toolbarButton("トランジション削除", systemImage: "minus.circle", accessibilityID: "Timeline.EditToolbar.RemoveTransition", action: onRemoveTransition)
                        .disabled(!hasSelectedTransition || !canRemoveSelectedTransition)
                        .help("選択中のトランジションを外してcutへ戻します")
                }

                toolbarSection("Timeline.EditToolbar.Section.SelectionEdits", label: "選択クリップの評価、削除、移動") {
                    toolbarButton("承認", systemImage: "checkmark.circle", accessibilityID: "Timeline.EditToolbar.Approve", action: onApprove)
                        .disabled(!hasSelectedClip)
                        .help(selectedClipCount > 1 ? "選択中の\(selectedClipCount)件を承認" : "選択クリップを承認")

                    toolbarButton("却下", systemImage: "xmark.circle", accessibilityID: "Timeline.EditToolbar.Reject", action: onReject)
                        .disabled(!hasSelectedClip)
                        .help(selectedClipCount > 1 ? "選択中の\(selectedClipCount)件を却下して削除候補にします" : "選択クリップを却下して削除候補にします")

                    toolbarButton("削除", systemImage: "trash", accessibilityID: "Timeline.EditToolbar.DeleteSelection", action: onDeleteSelection)
                        .disabled(!(hasSelectedClip || hasSelectedTransition) || !canDeleteSelection)
                        .help(deleteSelectionHelp)

                    toolbarButton("リップル削除", systemImage: "arrow.left.to.line.compact", accessibilityID: "Timeline.EditToolbar.RippleDelete", action: onRippleDelete)
                        .disabled(!hasSelectedClip || !canRippleDeleteSelectedClip)
                        .help(rippleDeleteHelp)

                    toolbarButton("位置←", systemImage: "arrow.left", accessibilityID: "Timeline.EditToolbar.NudgeEarlier", action: onNudgeEarlier)
                        .disabled(!hasSelectedClip || !canNudgeSelectedClipEarlier)
                        .help(selectedClipCount > 1 ? "選択中の\(selectedClipCount)件を0.5秒前へ移動します" : "選択クリップを0.5秒前へ移動します")

                    toolbarButton("位置→", systemImage: "arrow.right", accessibilityID: "Timeline.EditToolbar.NudgeLater", action: onNudgeLater)
                        .disabled(!hasSelectedClip || !canNudgeSelectedClipLater)
                        .help(selectedClipCount > 1 ? "選択中の\(selectedClipCount)件を0.5秒後ろへ移動します" : "選択クリップを0.5秒後ろへ移動します")
                }

                toolbarSection("Timeline.EditToolbar.Section.Trim", label: "トリムと伸長") {
                    toolbarButton("先頭を詰める", systemImage: "arrow.forward.to.line.compact", accessibilityID: "Timeline.EditToolbar.TrimStart", action: onTrimStart)
                        .disabled(!hasSingleSelectedClip || !canTrimSelectedClip)
                        .help("選択クリップの先頭を0.5秒詰めます")

                    toolbarButton("末尾を詰める", systemImage: "arrow.backward.to.line.compact", accessibilityID: "Timeline.EditToolbar.TrimEnd", action: onTrimEnd)
                        .disabled(!hasSingleSelectedClip || !canTrimSelectedClip)
                        .help("選択クリップの末尾を0.5秒詰めます")

                    toolbarButton("先頭を伸ばす", systemImage: "arrow.left.to.line", accessibilityID: "Timeline.EditToolbar.ExtendStart", action: onExtendStart)
                        .disabled(!hasSingleSelectedClip || !canExtendSelectedClipStart)
                        .help("前の空きスペースと素材の余白を使い、選択クリップの先頭を0.5秒伸ばします")

                    toolbarButton("末尾を伸ばす", systemImage: "arrow.right.to.line", accessibilityID: "Timeline.EditToolbar.ExtendEnd", action: onExtendEnd)
                        .disabled(!hasSingleSelectedClip || !canExtendSelectedClipEnd)
                        .help("次の空きスペースと素材の余白を使い、選択クリップの末尾を0.5秒伸ばします")

                    toolbarButton("先頭を再生位置へ", systemImage: "arrow.right.to.line", accessibilityID: "Timeline.EditToolbar.TrimStartToPlayhead", action: onTrimStartToPlayhead)
                        .disabled(!hasSingleSelectedClip || !canTrimSelectedClipStartToPlayhead)
                        .help("選択クリップの先頭を現在の再生位置まで詰めます")

                    toolbarButton("末尾を再生位置へ", systemImage: "arrow.left.to.line", accessibilityID: "Timeline.EditToolbar.TrimEndToPlayhead", action: onTrimEndToPlayhead)
                        .disabled(!hasSingleSelectedClip || !canTrimSelectedClipEndToPlayhead)
                        .help("選択クリップの末尾を現在の再生位置まで詰めます")
                }

                toolbarSection("Timeline.EditToolbar.Section.EditPoint", label: "編集点と素材範囲") {
                    toolbarButton("前編集点←", systemImage: "arrow.left.and.right", accessibilityID: "Timeline.EditToolbar.RollIncomingLeft", action: onRollIncomingLeft)
                        .disabled(!hasSingleSelectedClip || !canRollIncomingEditLeft)
                        .help("前のクリップとの編集点を0.5秒左へロールします")

                    toolbarButton("前編集点→", systemImage: "arrow.left.and.right", accessibilityID: "Timeline.EditToolbar.RollIncomingRight", action: onRollIncomingRight)
                        .disabled(!hasSingleSelectedClip || !canRollIncomingEditRight)
                        .help("前のクリップとの編集点を0.5秒右へロールします")

                    toolbarButton("次編集点←", systemImage: "arrow.left.and.right", accessibilityID: "Timeline.EditToolbar.RollOutgoingLeft", action: onRollOutgoingLeft)
                        .disabled(!hasSingleSelectedClip || !canRollOutgoingEditLeft)
                        .help("次のクリップとの編集点を0.5秒左へロールします")

                    toolbarButton("次編集点→", systemImage: "arrow.left.and.right", accessibilityID: "Timeline.EditToolbar.RollOutgoingRight", action: onRollOutgoingRight)
                        .disabled(!hasSingleSelectedClip || !canRollOutgoingEditRight)
                        .help("次のクリップとの編集点を0.5秒右へロールします")

                    toolbarButton("スリップ←", systemImage: "arrow.left.arrow.right", accessibilityID: "Timeline.EditToolbar.SlipLeft", action: onSlipLeft)
                        .disabled(!hasSingleSelectedClip || !canSlipSelectedClipLeft)
                        .help("タイムライン上の位置と尺を変えず、素材範囲を0.5秒前へ送ります")

                    toolbarButton("スリップ→", systemImage: "arrow.left.arrow.right", accessibilityID: "Timeline.EditToolbar.SlipRight", action: onSlipRight)
                        .disabled(!hasSingleSelectedClip || !canSlipSelectedClipRight)
                        .help("タイムライン上の位置と尺を変えず、素材範囲を0.5秒後ろへ送ります")

                    toolbarButton("分割", systemImage: "scissors", accessibilityID: "Timeline.EditToolbar.SplitAtPlayhead", action: onSplitAtPlayhead)
                        .disabled(!hasSingleSelectedClip || !canSplitSelectedClipAtPlayhead)
                        .help("選択クリップを現在の再生位置で分割します")
                }

                toolbarSection("Timeline.EditToolbar.Section.Source", label: "素材差し替え") {
                    toolbarButton("差し替え", systemImage: "arrow.triangle.2.circlepath", accessibilityID: "Timeline.EditToolbar.Swap", action: onSwap)
                        .disabled(!hasSingleSelectedClip)
                        .help("選択クリップの差し替え候補を開く")

                    toolbarButton("検索", systemImage: "waveform.badge.magnifyingglass", accessibilityID: "Timeline.EditToolbar.Search", action: onSearch)
                        .disabled(!hasSingleSelectedClip)
                        .help("選択クリップの差し替え素材を検索")
                }

                toolbarSection("Timeline.EditToolbar.Section.Session", label: "Studio編集の保存") {
                    toolbarButton("保存", systemImage: "square.and.arrow.down", accessibilityID: "Timeline.EditToolbar.ApplyPatch", action: onApplyPatch)
                        .disabled(!hasPendingPatch || hasPatchConflicts || isPatchApplying)
                        .help("表示済みのタイムライン編集を保存してプレビューを更新")

                    toolbarButton("戻す", systemImage: "arrow.uturn.backward", accessibilityID: "Timeline.EditToolbar.UndoPatch", action: onUndoPatch)
                        .disabled(!canUndoPatch || isPatchApplying)
                        .help("直前に保存したStudio編集を戻す")

                    if hasPatchConflicts {
                        Label("競合あり", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("Timeline.EditToolbar.ConflictWarning")
                    }
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 34)
        }
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Timeline.EditToolbar")
    }

    private var selectedItemSummary: some View {
        HStack(spacing: 6) {
            Image(systemName: selectedItemSystemImage)
                .foregroundStyle(selectedItemColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(selectedItemLabel)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(selectedItemDetail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(minWidth: 150, maxWidth: selectedItemSummaryMaxWidth, alignment: .leading)
        .accessibilityIdentifier(selectedItemAccessibilityID)
        .help(selectedItemHelp)
    }

    private var hasSelectedTransition: Bool {
        selectedTransition != nil
    }

    private var selectedItemSummaryMaxWidth: CGFloat {
        activeSelectedClips.count > 1 ? 320 : 240
    }

    private var rippleDeleteHelp: String {
        if selectedClipCount > 1 {
            return canRippleDeleteSelectedClip
                ? "選択中の\(selectedClipCount)件を削除し、対応する後続クリップを前へ詰めます"
                : "同じトラック内、または同じ時間範囲を覆う複数トラックのクリップだけをリップル削除できます"
        }
        return "選択クリップを削除し、同じトラックの後続クリップを前へ詰めます"
    }

    private var deleteSelectionHelp: String {
        if hasSelectedTransition {
            return "選択中のトランジションを外してcutへ戻します"
        }
        if selectedClipCount > 1 {
            return canRippleDeleteSelectedClip
                ? "選択クリップを削除し、対応する後続クリップを前へ詰めます"
                : "複数トラックの選択クリップを削除し、空き時間は保持します"
        }
        if hasSelectedClip {
            return "選択クリップを削除します。同じトラックの後続クリップは前へ詰まります"
        }
        return "削除するクリップまたはトランジションを選択してください"
    }

    private var selectedItemSystemImage: String {
        if hasSelectedTransition { return "rectangle.on.rectangle.angled" }
        return "selection.pin.in.out"
    }

    private var selectedItemColor: Color {
        if hasSelectedTransition { return .purple }
        return hasSelectedClip ? Color.accentColor : Color.secondary
    }

    private var selectedItemLabel: String {
        if selectedTransition != nil {
            return "トランジション選択"
        }
        return selectedClipLabel
    }

    private var selectedItemDetail: String {
        if let selectedTransition {
            return transitionSummary(selectedTransition)
        }
        return selectedClipDetail
    }

    private var selectedItemHelp: String {
        if let selectedTransition {
            return "\(transitionSummary(selectedTransition))。横ドラッグで長さを調整できます。"
        }
        if activeSelectedClips.count > 1 {
            return "\(selectedClipLabel)。\(multiSelectionRangeDetail)。選択範囲をドラッグ、位置←/→、Delete、Rでまとめて操作できます。主クリップ: \(selectedClip?.clip.id ?? activeSelectedClips.first?.clip.id ?? "-")"
        }
        return selectedClipDetail
    }

    private var selectedItemAccessibilityID: String {
        hasSelectedTransition ? "Timeline.EditToolbar.SelectedTransition" : "Timeline.EditToolbar.SelectedClip"
    }

    private var selectedClipLabel: String {
        let clips = activeSelectedClips
        if clips.count > 1 {
            return "\(clips.count)クリップ / \(trackSummary(for: clips))"
        }
        guard let selectedClip else { return "クリップ未選択" }
        return "\(selectedClip.trackID) / \(localizedClipRole(selectedClip.clip.role))"
    }

    private var selectedClipDetail: String {
        let clips = activeSelectedClips
        if clips.count > 1 {
            return multiSelectionRangeDetail
        }
        guard let selectedClip else { return "タイムライン上のクリップを選択" }
        return "\(selectedClip.clip.id) / \(selectedClip.clip.segmentID)"
    }

    private var activeSelectedClips: [TimelineClipSelection] {
        if !selectedClips.isEmpty {
            return selectedClips
        }
        if let selectedClip {
            return [selectedClip]
        }
        return []
    }

    private var multiSelectionRangeDetail: String {
        let clips = activeSelectedClips
        guard clips.count > 1,
              let lowerFrame = clips.map(\.clip.timelineInFrame).min(),
              let upperFrame = clips.map(\.clip.timelineOutFrame).max()
        else {
            return "複数選択中"
        }

        let durationFrames = max(0, upperFrame - lowerFrame)
        let start = sequence.framesToTimecode(lowerFrame)
        let end = sequence.framesToTimecode(upperFrame)
        let seconds = sequence.framesToSeconds(durationFrames)
        return "\(start)-\(end) / \(String(format: "%.2fs", seconds))"
    }

    private func trackSummary(for clips: [TimelineClipSelection]) -> String {
        let orderedTrackIDs = clips.reduce(into: [TimelineTrack.ID]()) { result, selection in
            guard !result.contains(selection.trackID) else { return }
            result.append(selection.trackID)
        }
        guard !orderedTrackIDs.isEmpty else { return "trackなし" }
        if orderedTrackIDs.count <= 3 {
            return orderedTrackIDs.joined(separator: ",")
        }
        let visibleTracks = orderedTrackIDs.prefix(2).joined(separator: ",")
        return "\(visibleTracks)+\(orderedTrackIDs.count - 2)"
    }

    private func transitionSummary(_ transition: TimelineTransition) -> String {
        let durationFrames = transition.transitionFrames ?? 0
        let durationText = durationFrames > 0
            ? "\(durationFrames)f / \(String(format: "%.2fs", sequence.framesToSeconds(durationFrames)))"
            : "長さ未設定"
        return "\(transition.trackID) / \(localizedTimelineTransitionType(transition.transitionType)) / \(durationText) / \(transition.fromClipID)→\(transition.toClipID)"
    }

    private func toolbarButton(
        _ title: String,
        systemImage: String,
        accessibilityID: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(.caption.weight(.semibold))
                .frame(width: 24, height: 22)
                .contentShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .accessibilityLabel(title)
        .accessibilityIdentifier(accessibilityID)
    }

    @ViewBuilder
    private func toolbarSection(
        _ accessibilityID: String,
        label: String,
        @ViewBuilder content: () -> some View
    ) -> some View {
        HStack(spacing: 3) {
            content()
        }
        .padding(.horizontal, 3)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.primary.opacity(0.035))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(accessibilityID)
    }
}

private struct TimelineTransitionPresetPalette: View {
    var activePresetDragID: String?
    var onBeginDrag: (String) -> Void
    var onApply: (String) -> Void

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "square.stack.3d.down.forward")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .help("トランジション")
            ForEach(TimelineTransitionPreset.allCases) { preset in
                TimelineTransitionPresetChip(
                    preset: preset,
                    isActiveDrag: activePresetDragID == preset.id,
                    onBeginDrag: onBeginDrag,
                    onApply: onApply
                )
            }
            if let activePresetDragSummary {
                TimelineTransitionPresetDragStatus(preset: activePresetDragSummary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Timeline.TransitionPresetPalette")
    }

    private var activePresetDragSummary: TimelineTransitionPreset? {
        guard let activePresetDragID,
              let preset = TimelineTransitionPreset(rawValue: activePresetDragID)
        else {
            return nil
        }
        return preset
    }
}

private struct TimelineTransitionPresetDragStatus: View {
    let preset: TimelineTransitionPreset

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "hand.draw.fill")
                .font(.system(size: 9, weight: .bold))
            Text(preset.localizedLabel)
                .font(.caption2.weight(.bold))
                .lineLimit(1)
            Text("\(preset.defaultFrames)f")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .padding(.horizontal, 3)
                .frame(height: 14)
                .background(Color.accentColor.opacity(0.14), in: Capsule())
            Image(systemName: "arrow.down.to.line.compact")
                .font(.system(size: 8, weight: .bold))
            Text("編集点")
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.accentColor)
        .padding(.horizontal, 7)
        .frame(height: 23)
        .background(Color.accentColor.opacity(0.12), in: Capsule())
        .overlay {
            Capsule().stroke(Color.accentColor.opacity(0.42), lineWidth: 1)
        }
        .shadow(color: Color.accentColor.opacity(0.12), radius: 3, y: 1)
        .help("\(preset.localizedLabel) \(preset.defaultFrames)f をTimelineの編集点へドラッグ中")
        .accessibilityLabel("\(preset.localizedLabel) \(preset.defaultFrames)フレームを編集点へドラッグ中")
        .accessibilityIdentifier("Timeline.TransitionPresetDragStatus")
    }
}

private struct TimelineTransitionPresetChip: View {
    var preset: TimelineTransitionPreset
    var isActiveDrag: Bool
    var onBeginDrag: (String) -> Void
    var onApply: (String) -> Void

    var body: some View {
        HStack(spacing: 4) {
            Label(preset.localizedLabel, systemImage: systemImage)
                .labelStyle(.titleAndIcon)

            if isDefaultTransition {
                Image(systemName: "command")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }

            TimelineTransitionPresetDragAffordance(
                defaultFrames: preset.defaultFrames,
                isActiveDrag: isActiveDrag
            )
        }
            .font(.caption.weight(.semibold))
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 6)
            .frame(height: 24)
            .background(chipBackground, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(chipBorderColor, lineWidth: isActiveDrag ? 1.5 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 5))
            .onTapGesture {
                onApply(preset.id)
            }
            .onDrag {
                onBeginDrag(preset.id)
                return NSItemProvider(object: preset.id as NSString)
            }
            .help(helpText)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityHint(isDefaultTransition ? "Command-Tでも適用できます" : "クリックまたはドラッグで適用できます")
            .accessibilityIdentifier("Timeline.TransitionPreset.\(timelineAccessibilitySuffix(preset.id))")
    }

    private var isDefaultTransition: Bool {
        preset.isDefaultPreset
    }

    private var chipBackground: Color {
        isActiveDrag ? Color.accentColor.opacity(0.18) : Color(nsColor: .textBackgroundColor).opacity(0.78)
    }

    private var chipBorderColor: Color {
        isActiveDrag ? Color.accentColor.opacity(0.82) : Color.accentColor.opacity(0.35)
    }

    private var helpText: String {
        let base = "\(preset.localizedLabel) / クリックで選択または再生位置近くの編集点へ適用。編集点へドラッグしても適用できます（\(preset.defaultFrames)f）"
        guard isDefaultTransition else { return base }
        return "\(base)。デフォルトトランジションとしてCommand-Tでも適用できます"
    }

    private var accessibilityLabel: String {
        isDefaultTransition ? "\(preset.localizedLabel)デフォルトトランジション" : "\(preset.localizedLabel)トランジション"
    }

    private var systemImage: String {
        switch preset {
        case .crossfade: return "rectangle.on.rectangle"
        case .dipToBlack: return "circle.lefthalf.filled"
        case .matchCutSoft: return "point.3.connected.trianglepath.dotted"
        }
    }
}

private struct TimelineTransitionPresetDragAffordance: View {
    var defaultFrames: Int
    var isActiveDrag: Bool

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "hand.draw")
                .font(.system(size: 8, weight: .bold))
            Text("\(defaultFrames)f")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
        }
        .foregroundStyle(isActiveDrag ? Color.accentColor : Color.secondary)
        .padding(.horizontal, 4)
        .frame(height: 15)
        .background(
            (isActiveDrag ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.10)),
            in: Capsule()
        )
        .accessibilityHidden(true)
    }
}

private enum TimelineScrollTarget {
    static let playhead = "Timeline.ScrollTarget.Playhead"
    static let dragReveal = "Timeline.ScrollTarget.DragReveal"
}

private struct TimelineOverviewStrip: View {
    @State private var activeScrubFrame: Int?
    @State private var activeScrubSnap: TimelinePlayheadScrubSnap?

    var timeline: TimelineDocument
    var playheadFrame: Int
    var visibleFrameRange: ClosedRange<Int>
    var playbackLoopRange: TimelinePlaybackRange?
    var isLoopPlaybackEnabled: Bool
    var isSnappingEnabled: Bool
    var onScrubPlayhead: (Int) -> Void
    var onLocatePlayhead: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onLocatePlayhead) {
                Image(systemName: "scope")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("現在の再生位置へスクロール")
            .accessibilityLabel("現在の再生位置へスクロール")
            .accessibilityIdentifier("Timeline.Overview.LocatePlayhead")

            VStack(alignment: .leading, spacing: 4) {
                TimelineOverviewRoleLegend(entries: roleLegendEntries)

                GeometryReader { geometry in
                    let width = max(1, geometry.size.width)
                    let height = max(1, geometry.size.height)

                    TimelineOverviewCanvas(
                        timeline: timeline,
                        playheadFrame: playheadFrame,
                        visibleFrameRange: visibleFrameRange,
                        playbackLoopRange: normalizedLoopRange,
                        isLoopPlaybackEnabled: isLoopPlaybackEnabled,
                        activeScrubFrame: activeScrubFrame,
                        activeScrubSnap: activeScrubSnap,
                        width: width,
                        height: height
                    )
                    .contentShape(Rectangle())
                    .gesture(scrubGesture(width: width))
                    .help("クリックまたはドラッグで再生位置を移動")
                    .accessibilityLabel("タイムライン全体俯瞰")
                    .accessibilityValue(overviewAccessibilityValue)
                    .accessibilityIdentifier("Timeline.OverviewStrip")
                }
            }
        }
        .frame(minHeight: 54)
    }

    private var roleLegendEntries: [TimelineRoleLegendEntry] {
        timelineRoleLegendEntries(for: timeline)
    }

    private var normalizedLoopRange: TimelinePlaybackRange? {
        TimelinePlaybackLoop.normalizedRange(playbackLoopRange, totalFrames: timeline.totalFrames)
    }

    private func scrubGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                scrub(toX: value.location.x, width: width)
            }
            .onEnded { value in
                scrub(toX: value.location.x, width: width)
                activeScrubFrame = nil
                activeScrubSnap = nil
            }
    }

    private func scrub(toX x: CGFloat, width: CGFloat) {
        let proposedFrame = TimelineOverviewScale.frame(
            atX: Double(x),
            width: Double(width),
            totalFrames: timeline.totalFrames
        )
        let resolved = TimelinePlayheadScrubSnapResolver.resolve(
            timeline: timeline,
            proposedFrame: proposedFrame,
            thresholdFrames: overviewSnapThresholdFrames(width: width)
        )
        activeScrubFrame = resolved.frame
        activeScrubSnap = resolved.snap
        onScrubPlayhead(resolved.frame)
    }

    private func overviewSnapThresholdFrames(width: CGFloat) -> Int {
        guard isSnappingEnabled else { return 0 }
        return max(1, Int(((10 / max(width, 1)) * CGFloat(max(timeline.totalFrames, 1))).rounded()))
    }

    private func xPosition(for frame: Int, width: CGFloat) -> CGFloat {
        CGFloat(TimelineOverviewScale.xPosition(
            frame: frame,
            totalFrames: timeline.totalFrames,
            width: Double(width)
        ))
    }

    private var overviewAccessibilityValue: String {
        let timecode = timeline.sequence.framesToTimecode(activeScrubFrame ?? playheadFrame)
        var components = [
            timecode,
            "表示: \(timeline.sequence.framesToTimecode(visibleFrameRange.lowerBound))-\(timeline.sequence.framesToTimecode(visibleFrameRange.upperBound))"
        ]
        if let normalizedLoopRange {
            let prefix = isLoopPlaybackEnabled ? "ループ" : "保持範囲"
            components.append("\(prefix): \(timeline.sequence.framesToTimecode(normalizedLoopRange.startFrame))-\(timeline.sequence.framesToTimecode(normalizedLoopRange.endFrame))")
        }
        if let activeScrubSnap {
            components.append("吸着: \(activeScrubSnap.label)")
        }
        return components.joined(separator: " / ")
    }
}

private struct TimelineRoleLegendEntry: Identifiable {
    var role: String
    var trackKind: TimelineTrackKind
    var count: Int

    var id: String {
        "\(timelineTrackKindKey(trackKind))-\(role)"
    }
}

private struct TimelineOverviewRoleLegend: View {
    var entries: [TimelineRoleLegendEntry]

    var body: some View {
        if !entries.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(entries) { entry in
                        TimelineOverviewRoleLegendChip(entry: entry)
                    }
                }
                .padding(.trailing, 2)
            }
            .frame(height: 18)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("タイムラインのロール")
            .accessibilityIdentifier("Timeline.Overview.RoleLegend")
        }
    }
}

private struct TimelineOverviewRoleLegendChip: View {
    var entry: TimelineRoleLegendEntry

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color.opacity(0.95))
                .frame(width: 6, height: 6)
            Text(localizedClipRole(entry.role))
                .lineLimit(1)
            Text("\(entry.count)")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .font(.system(size: 9, weight: .semibold))
        .padding(.horizontal, 6)
        .frame(height: 16)
        .background(Color.secondary.opacity(0.10), in: Capsule())
        .overlay {
            Capsule().stroke(color.opacity(0.48), lineWidth: 0.8)
        }
        .help("\(localizedClipRole(entry.role)) \(entry.count) clips")
        .accessibilityLabel("\(localizedClipRole(entry.role)) \(entry.count) clips")
        .accessibilityIdentifier("Timeline.Overview.RoleLegend.\(timelineAccessibilitySuffix(entry.role))")
    }

    private var color: Color {
        timelineClipRoleColor(role: entry.role, trackKind: entry.trackKind)
    }
}

private struct TimelineOverviewCanvas: View {
    var timeline: TimelineDocument
    var playheadFrame: Int
    var visibleFrameRange: ClosedRange<Int>
    var playbackLoopRange: TimelinePlaybackRange?
    var isLoopPlaybackEnabled: Bool
    var activeScrubFrame: Int?
    var activeScrubSnap: TimelinePlayheadScrubSnap?
    var width: CGFloat
    var height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.secondary.opacity(0.12))

            if let playbackLoopRange {
                TimelinePlaybackLoopRangeBand(
                    range: playbackLoopRange,
                    sequence: timeline.sequence,
                    totalFrames: timeline.totalFrames,
                    laneWidth: width,
                    height: max(12, height - 8),
                    yOffset: 4,
                    isEnabled: isLoopPlaybackEnabled,
                    accessibilityIdentifier: "Timeline.Overview.LoopRange"
                )
                .zIndex(0.6)
            }

            ForEach(trackBands) { band in
                TimelineOverviewTrackBand(
                    track: band.track,
                    totalFrames: timeline.totalFrames,
                    width: width,
                    yOffset: band.yOffset,
                    bandHeight: band.bandHeight
                )
            }

            ForEach(ProjectTimelineMarkerMap.build(timeline: timeline).markers) { marker in
                TimelineOverviewMarkerLine(
                    marker: marker,
                    totalFrames: timeline.totalFrames,
                    width: width,
                    height: height
                )
            }

            if shouldShowVisibleFrameRange {
                TimelineOverviewViewportWindow(
                    frameRange: visibleFrameRange,
                    sequence: timeline.sequence,
                    totalFrames: timeline.totalFrames,
                    width: width,
                    height: height
                )
                .zIndex(1)
            }

            TimelineOverviewPlayheadLine(
                frame: playheadFrame,
                totalFrames: timeline.totalFrames,
                width: width,
                height: height
            )

            if let activeScrubSnap {
                TimelinePlayheadScrubSnapIndicator(
                    snap: activeScrubSnap,
                    laneWidth: width,
                    totalFrames: timeline.totalFrames,
                    height: max(18, height - 2)
                )
                .offset(y: 3)
                .zIndex(2)
            }

            if let activeScrubFrame {
                TimelineOverviewScrubBadge(
                    timecode: timeline.sequence.framesToTimecode(activeScrubFrame),
                    snap: activeScrubSnap
                )
                .offset(x: scrubBadgeOffset(for: activeScrubFrame, hasSnap: activeScrubSnap != nil), y: 3)
                .zIndex(3)
            }
        }
    }

    private var shouldShowVisibleFrameRange: Bool {
        visibleFrameRange.lowerBound > 0 || visibleFrameRange.upperBound < timeline.totalFrames
    }

    private var trackBands: [TimelineOverviewTrackBandModel] {
        let tracks = timeline.displayTracks
        let trackCount = max(1, tracks.count)
        let availableHeight = max(18, height - 10)
        let rowStride = availableHeight / CGFloat(trackCount)
        let bandHeight = max(3, min(7, rowStride - 1))
        return tracks.indices.map { index in
            let yOffset = 5 + CGFloat(index) * rowStride + max(0, (rowStride - bandHeight) / 2)
            return TimelineOverviewTrackBandModel(
                track: tracks[index],
                yOffset: yOffset,
                bandHeight: bandHeight
            )
        }
    }

    private func scrubBadgeOffset(for frame: Int, hasSnap: Bool) -> CGFloat {
        let badgeWidth: CGFloat = hasSnap ? 172 : 82
        let centered = xPosition(for: frame) - badgeWidth / 2
        return max(0, min(centered, max(0, width - badgeWidth)))
    }

    private func xPosition(for frame: Int) -> CGFloat {
        CGFloat(TimelineOverviewScale.xPosition(
            frame: frame,
            totalFrames: timeline.totalFrames,
            width: Double(width)
        ))
    }
}

private struct TimelineOverviewTrackBandModel: Identifiable {
    var track: TimelineTrack
    var yOffset: CGFloat
    var bandHeight: CGFloat

    var id: TimelineTrack.ID { track.id }
}

private struct TimelineOverviewTrackBand: View {
    var track: TimelineTrack
    var totalFrames: Int
    var width: CGFloat
    var yOffset: CGFloat
    var bandHeight: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color.secondary.opacity(0.10))
                .frame(width: width, height: bandHeight)

            ForEach(track.clips) { clip in
                TimelineOverviewClipPill(
                    clip: clip,
                    trackKind: track.kind,
                    totalFrames: totalFrames,
                    width: width,
                    bandHeight: bandHeight
                )
            }
        }
        .offset(y: yOffset)
    }
}

private struct TimelineOverviewClipPill: View {
    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var totalFrames: Int
    var width: CGFloat
    var bandHeight: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(timelineOverviewClipColor(clip: clip, trackKind: trackKind).opacity(0.78))
            .frame(width: clipWidth, height: bandHeight)
            .offset(x: x)
    }

    private var range: ClosedRange<Double> {
        TimelineOverviewScale.clippedRange(
            startFrame: clip.timelineInFrame,
            durationFrames: clip.timelineDurationFrames,
            totalFrames: totalFrames
        )
    }

    private var x: CGFloat {
        width * CGFloat(range.lowerBound)
    }

    private var clipWidth: CGFloat {
        max(2, width * CGFloat(range.upperBound - range.lowerBound))
    }
}

private struct TimelineOverviewMarkerLine: View {
    var marker: TimelineMarkerCue
    var totalFrames: Int
    var width: CGFloat
    var height: CGFloat

    var body: some View {
        Rectangle()
            .fill(timelineOverviewMarkerColor(marker.kind).opacity(0.72))
            .frame(width: 1.5, height: height - 8)
            .offset(x: x, y: 4)
    }

    private var x: CGFloat {
        CGFloat(TimelineOverviewScale.xPosition(
            frame: marker.frame,
            totalFrames: totalFrames,
            width: Double(width)
        ))
    }
}

private struct TimelineOverviewViewportWindow: View {
    var frameRange: ClosedRange<Int>
    var sequence: TimelineSequence
    var totalFrames: Int
    var width: CGFloat
    var height: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(Color.accentColor.opacity(0.08))
            .overlay {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(
                        Color.accentColor.opacity(0.62),
                        style: StrokeStyle(lineWidth: 1.1, dash: [5, 3])
                    )
            }
            .frame(width: windowWidth, height: max(18, height - 4))
            .offset(x: windowX, y: 2)
            .allowsHitTesting(false)
            .help("現在の表示範囲 \(rangeLabel)")
            .accessibilityLabel("現在のタイムライン表示範囲")
            .accessibilityValue(rangeLabel)
            .accessibilityIdentifier("Timeline.Overview.ViewportWindow")
    }

    private var rangeLabel: String {
        "\(sequence.framesToTimecode(frameRange.lowerBound))-\(sequence.framesToTimecode(frameRange.upperBound))"
    }

    private var startX: CGFloat {
        CGFloat(TimelineOverviewScale.xPosition(
            frame: frameRange.lowerBound,
            totalFrames: totalFrames,
            width: Double(width)
        ))
    }

    private var endX: CGFloat {
        CGFloat(TimelineOverviewScale.xPosition(
            frame: frameRange.upperBound,
            totalFrames: totalFrames,
            width: Double(width)
        ))
    }

    private var windowWidth: CGFloat {
        min(width, max(12, endX - startX))
    }

    private var windowX: CGFloat {
        max(0, min(startX, max(0, width - windowWidth)))
    }
}

private struct TimelineOverviewPlayheadLine: View {
    var frame: Int
    var totalFrames: Int
    var width: CGFloat
    var height: CGFloat

    var body: some View {
        Rectangle()
            .fill(Color.accentColor)
            .frame(width: 2, height: height)
            .offset(x: x)
    }

    private var x: CGFloat {
        CGFloat(TimelineOverviewScale.xPosition(
            frame: frame,
            totalFrames: totalFrames,
            width: Double(width)
        ))
    }
}

private struct TimelineOverviewScrubBadge: View {
    var timecode: String
    var snap: TimelinePlayheadScrubSnap?

    var body: some View {
        HStack(spacing: 4) {
            Text(timecode)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
            if let snap {
                Image(systemName: snap.kind.iconName)
                    .font(.system(size: 8, weight: .bold))
                    .accessibilityHidden(true)
                Text("吸着 \(snap.label)")
                    .font(.system(size: 8, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
            }
        }
        .foregroundStyle(snap == nil ? Color.primary : Color.accentColor)
        .padding(.horizontal, 6)
        .frame(width: snap == nil ? 82 : 172, height: 18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.accentColor.opacity(snap == nil ? 0.45 : 0.72), lineWidth: 1)
        }
        .help(snap.map { "吸着: \($0.label)" } ?? "再生位置")
        .accessibilityLabel(snap.map { "再生位置 \(timecode) 吸着 \($0.label)" } ?? "再生位置 \(timecode)")
        .accessibilityIdentifier("Timeline.Overview.ScrubPreview")
    }
}

private func timelineOverviewClipColor(clip: TimelineClip, trackKind: TimelineTrackKind) -> Color {
    timelineClipRoleColor(role: clip.role, trackKind: trackKind)
}

private func timelineClipRoleColor(role: String, trackKind: TimelineTrackKind) -> Color {
    switch timelineNormalizedClipRole(role) {
    case "hero":
        return .blue
    case "dialogue", "interview", "voiceover", "narration":
        return .indigo
    case "support", "b-roll", "b_roll", "cutaway":
        return .cyan
    case "transition":
        return .purple
    case "texture":
        return .mint
    case "music", "bgm":
        return .green
    case "nat_sound", "ambient", "room_tone":
        return .orange
    case "title", "caption":
        return .pink
    default:
        switch trackKind {
        case .audio:
            return .orange
        case .overlay:
            return .purple
        case .caption:
            return .pink
        case .video:
            return .gray
        }
    }
}

private func timelineClipRoleAbbreviation(_ role: String) -> String {
    let normalized = timelineNormalizedClipRole(role)
    switch normalized {
    case "hero":
        return "主"
    case "dialogue", "interview", "voiceover", "narration":
        return "会"
    case "support", "b-roll", "b_roll", "cutaway":
        return "補"
    case "transition":
        return "繋"
    case "texture":
        return "質"
    case "music", "bgm":
        return "音"
    case "nat_sound":
        return "現"
    case "ambient", "room_tone":
        return "環"
    case "title", "caption":
        return "字"
    default:
        let trimmed = role.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "?" }
        return String(trimmed.prefix(trimmed.count > 3 ? 2 : 1)).uppercased()
    }
}

private func timelineRoleLegendEntries(for timeline: TimelineDocument) -> [TimelineRoleLegendEntry] {
    var entriesByKey: [String: TimelineRoleLegendEntry] = [:]
    for track in timeline.displayTracks {
        for clip in track.clips {
            let role = timelineNormalizedClipRole(clip.role)
            let key = "\(timelineTrackKindKey(track.kind))-\(role)"
            if var entry = entriesByKey[key] {
                entry.count += 1
                entriesByKey[key] = entry
            } else {
                entriesByKey[key] = TimelineRoleLegendEntry(role: role, trackKind: track.kind, count: 1)
            }
        }
    }
    return entriesByKey.values.sorted { lhs, rhs in
        let lhsRoleSort = timelineRoleSortIndex(lhs.role)
        let rhsRoleSort = timelineRoleSortIndex(rhs.role)
        if lhsRoleSort != rhsRoleSort { return lhsRoleSort < rhsRoleSort }
        let lhsTrackSort = timelineTrackKindSortIndex(lhs.trackKind)
        let rhsTrackSort = timelineTrackKindSortIndex(rhs.trackKind)
        if lhsTrackSort != rhsTrackSort { return lhsTrackSort < rhsTrackSort }
        return localizedClipRole(lhs.role) < localizedClipRole(rhs.role)
    }
}

private func timelineNormalizedClipRole(_ role: String) -> String {
    role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

private func timelineRoleSortIndex(_ role: String) -> Int {
    switch timelineNormalizedClipRole(role) {
    case "hero":
        return 0
    case "dialogue", "interview", "voiceover", "narration":
        return 10
    case "support", "b-roll", "b_roll", "cutaway":
        return 20
    case "transition":
        return 30
    case "texture":
        return 40
    case "title", "caption":
        return 50
    case "music", "bgm":
        return 60
    case "nat_sound":
        return 70
    case "ambient", "room_tone":
        return 80
    default:
        return 100
    }
}

private func timelineTrackKindSortIndex(_ kind: TimelineTrackKind) -> Int {
    switch kind {
    case .video:
        return 0
    case .overlay:
        return 1
    case .caption:
        return 2
    case .audio:
        return 3
    }
}

private func timelineTrackKindKey(_ kind: TimelineTrackKind) -> String {
    switch kind {
    case .video:
        return "video"
    case .overlay:
        return "overlay"
    case .caption:
        return "caption"
    case .audio:
        return "audio"
    }
}

private func timelineTrackKindIconName(_ kind: TimelineTrackKind) -> String {
    switch kind {
    case .video:
        return "film"
    case .audio:
        return "waveform"
    case .overlay:
        return "square.stack.3d.up"
    case .caption:
        return "captions.bubble"
    }
}

private func timelineTrackKindShortLabel(_ kind: TimelineTrackKind) -> String {
    switch kind {
    case .video:
        return "映像"
    case .audio:
        return "音声"
    case .overlay:
        return "重ね"
    case .caption:
        return "字幕"
    }
}

private func timelineTrackKindColor(_ kind: TimelineTrackKind) -> Color {
    switch kind {
    case .video:
        return .blue
    case .audio:
        return .orange
    case .overlay:
        return .purple
    case .caption:
        return .pink
    }
}

private func timelineOverviewMarkerColor(_ kind: TimelineMarkerCue.Kind) -> Color {
    switch kind {
    case .beat: return .green
    case .note: return .blue
    case .warning: return .orange
    case .chapter: return .purple
    case .marker: return .secondary
    }
}

private struct TimelinePlayheadScrollAnchorRow: View {
    var playheadFrame: Int
    var dragRevealFrame: Int?
    var totalFrames: Int
    var laneWidth: CGFloat

    var body: some View {
        HStack(spacing: 10) {
            Color.clear
                .frame(width: timelineTrackHeaderWidth, height: 1)
            ZStack(alignment: .leading) {
                anchorLine(
                    frame: playheadFrame,
                    id: TimelineScrollTarget.playhead,
                    accessibilityID: "Timeline.PlayheadScrollAnchor"
                )
                if let dragRevealFrame {
                    anchorLine(
                        frame: dragRevealFrame,
                        id: TimelineScrollTarget.dragReveal,
                        accessibilityID: "Timeline.DragRevealScrollAnchor"
                    )
                }
            }
            .frame(width: laneWidth, height: 1)
        }
        .frame(height: 1)
    }

    @ViewBuilder
    private func anchorLine(frame: Int, id: String, accessibilityID: String) -> some View {
        let anchorX = xPosition(for: frame)
        HStack(spacing: 0) {
            Color.clear
                .frame(width: anchorX, height: 1)
            Color.clear
                .frame(width: 1, height: 1)
                .id(id)
                .accessibilityIdentifier(accessibilityID)
            Color.clear
                .frame(width: max(0, laneWidth - anchorX - 1), height: 1)
        }
        .frame(width: laneWidth, height: 1)
    }

    private func xPosition(for frame: Int) -> CGFloat {
        let x = CGFloat(TimelineOverviewScale.xPosition(
            frame: frame,
            totalFrames: totalFrames,
            width: Double(laneWidth)
        ))
        return max(0, min(x, laneWidth))
    }

}

struct TimelineRuler: View {
    @State private var activeScrubFrame: Int?
    @State private var activeScrubSnap: TimelinePlayheadScrubSnap?

    var timeline: TimelineDocument
    var playheadFrame: Int
    var playbackLoopRange: TimelinePlaybackRange?
    var isLoopPlaybackEnabled: Bool
    var isSnappingEnabled: Bool
    var onScrubPlayhead: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    rulerItems
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 12) {
                        LabeledContent("シーケンス", value: timeline.sequence.name)
                        LabeledContent("再生位置", value: timeline.sequence.framesToTimecode(playheadFrame))
                        LabeledContent("FPS", value: timeline.sequence.fps.formatted(.number.precision(.fractionLength(0...2))))
                    }
                    HStack(spacing: 12) {
                        LabeledContent("長さ", value: formatSeconds(timeline.totalSeconds))
                        LabeledContent("画面", value: "\(timeline.sequence.width)x\(timeline.sequence.height)")
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)

            GeometryReader { geometry in
                let width = max(1, geometry.size.width)
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(.quaternary)
                        .frame(height: 14)
                        .offset(y: 10)
                    if let normalizedLoopRange {
                        TimelinePlaybackLoopRangeBand(
                            range: normalizedLoopRange,
                            sequence: timeline.sequence,
                            totalFrames: timeline.totalFrames,
                            laneWidth: width,
                            height: 14,
                            yOffset: 10,
                            isEnabled: isLoopPlaybackEnabled,
                            accessibilityIdentifier: "Timeline.Ruler.LoopRange"
                        )
                        .zIndex(0.5)
                    }
                    ForEach(tickFrames, id: \.self) { frame in
                        Rectangle()
                            .fill(Color.secondary.opacity(frame == 0 || frame == timeline.totalFrames ? 0.46 : 0.28))
                            .frame(width: 1, height: frame == 0 || frame == timeline.totalFrames ? 14 : 8)
                            .offset(x: offset(for: frame, width: width), y: frame == 0 || frame == timeline.totalFrames ? 10 : 13)
                    }
                    Rectangle()
                        .fill(Color.accentColor.opacity(activeScrubFrame == nil ? 0.78 : 1))
                        .frame(width: 2, height: 26)
                        .offset(x: offset(for: playheadFrame, width: width), y: 4)
                    if activeScrubFrame == nil {
                        TimelineRulerPlayheadBadge(
                            timecode: timeline.sequence.framesToTimecode(playheadFrame),
                            frame: playheadFrame,
                            totalFrames: timeline.totalFrames,
                            laneWidth: width
                        )
                        .zIndex(3)
                    }
                    if let activeScrubSnap {
                        TimelinePlayheadScrubSnapIndicator(
                            snap: activeScrubSnap,
                            laneWidth: width,
                            totalFrames: timeline.totalFrames,
                            height: 26
                        )
                        .offset(y: 4)
                        .zIndex(2)
                    }
                    if let activeScrubFrame {
                        TimelineRulerScrubBadge(
                            timecode: timeline.sequence.framesToTimecode(activeScrubFrame),
                            snap: activeScrubSnap
                        )
                        .offset(x: scrubBadgeOffset(for: activeScrubFrame, hasSnap: activeScrubSnap != nil, width: width), y: 0)
                        .help(activeScrubSnap.map { "吸着: \($0.label)" } ?? "再生位置")
                        .accessibilityIdentifier("Timeline.RulerScrubPreview")
                    }
                }
                .contentShape(Rectangle())
                .gesture(scrubGesture(width: width))
                .help(scrubHelpText)
                .accessibilityLabel("タイムライン再生位置")
                .accessibilityValue(timeline.sequence.framesToTimecode(playheadFrame))
                .accessibilityIdentifier("Timeline.RulerScrubLane")
            }
            .frame(height: 32)
        }
    }

    @ViewBuilder
    private var rulerItems: some View {
        LabeledContent("シーケンス", value: timeline.sequence.name)
        LabeledContent("再生位置", value: timeline.sequence.framesToTimecode(playheadFrame))
        LabeledContent("FPS", value: timeline.sequence.fps.formatted(.number.precision(.fractionLength(0...2))))
        LabeledContent("長さ", value: formatSeconds(timeline.totalSeconds))
        LabeledContent("画面", value: "\(timeline.sequence.width)x\(timeline.sequence.height)")
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }

    private var tickFrames: [Int] {
        let totalFrames = max(timeline.totalFrames, 1)
        let segmentCount = 8
        let frames = (0...segmentCount).map { index in
            Int((Double(totalFrames) * Double(index) / Double(segmentCount)).rounded())
        }
        return Array(Set(frames)).sorted()
    }

    private var normalizedLoopRange: TimelinePlaybackRange? {
        TimelinePlaybackLoop.normalizedRange(playbackLoopRange, totalFrames: timeline.totalFrames)
    }

    private func scrubGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                scrub(toX: value.location.x, width: width)
            }
            .onEnded { value in
                scrub(toX: value.location.x, width: width)
                activeScrubFrame = nil
                activeScrubSnap = nil
            }
    }

    private func scrub(toX x: CGFloat, width: CGFloat) {
        let resolved = TimelinePlayheadScrubSnapResolver.resolve(
            timeline: timeline,
            proposedFrame: frame(forX: x, width: width),
            thresholdFrames: scrubSnapThresholdFrames(width: width)
        )
        let previousScrubFrame = activeScrubFrame
        activeScrubFrame = resolved.frame
        activeScrubSnap = resolved.snap
        if previousScrubFrame != resolved.frame || playheadFrame != resolved.frame {
            onScrubPlayhead(resolved.frame)
        }
    }

    private func frame(forX x: CGFloat, width: CGFloat) -> Int {
        let normalizedX = max(0, min(x, width))
        let totalFrames = max(timeline.totalFrames, 1)
        let frame = Int((normalizedX / max(width, 1)) * CGFloat(totalFrames))
        return max(0, min(frame, timeline.totalFrames))
    }

    private func scrubSnapThresholdFrames(width: CGFloat) -> Int {
        guard isSnappingEnabled else { return 0 }
        return max(1, Int(((10 / max(width, 1)) * CGFloat(max(timeline.totalFrames, 1))).rounded()))
    }

    private func offset(for frame: Int, width: CGFloat) -> CGFloat {
        let totalFrames = max(timeline.totalFrames, 1)
        return max(0, min(width - 1, width * CGFloat(max(0, min(frame, timeline.totalFrames))) / CGFloat(totalFrames)))
    }

    private func scrubBadgeOffset(for frame: Int, hasSnap: Bool, width: CGFloat) -> CGFloat {
        let badgeWidth = TimelineRulerScrubBadge.badgeWidth(hasSnap: hasSnap)
        let centeredX = offset(for: frame, width: width) - badgeWidth / 2
        return max(0, min(centeredX, max(0, width - badgeWidth)))
    }

    private var scrubHelpText: String {
        let timecode = timeline.sequence.framesToTimecode(activeScrubFrame ?? playheadFrame)
        guard let activeScrubSnap else { return timecode }
        return "\(timecode) / 吸着: \(activeScrubSnap.label)"
    }
}

private struct TimelineRulerScrubBadge: View {
    var timecode: String
    var snap: TimelinePlayheadScrubSnap?

    var body: some View {
        HStack(spacing: 4) {
            Text(timecode)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
            if let snap {
                Image(systemName: snap.kind.iconName)
                    .font(.system(size: 8, weight: .bold))
                    .accessibilityHidden(true)
                Text("吸着 \(snap.label)")
                    .font(.system(size: 8, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
            }
        }
        .foregroundStyle(snap == nil ? Color.primary : Color.accentColor)
        .padding(.horizontal, 6)
        .frame(width: Self.badgeWidth(hasSnap: snap != nil), height: 18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.accentColor.opacity(0.45), lineWidth: 1)
        }
        .accessibilityLabel(snap.map { "再生位置 \(timecode) 吸着 \($0.label)" } ?? "再生位置 \(timecode)")
    }

    static func badgeWidth(hasSnap: Bool) -> CGFloat {
        hasSnap ? 172 : 82
    }
}

private struct TimelineRulerPlayheadBadge: View {
    private static let badgeWidth: CGFloat = 96

    var timecode: String
    var frame: Int
    var totalFrames: Int
    var laneWidth: CGFloat

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "play.fill")
                .font(.system(size: 7, weight: .bold))
                .accessibilityHidden(true)
            Text(timecode)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
        }
        .foregroundStyle(Color.accentColor)
        .padding(.horizontal, 6)
        .frame(width: Self.badgeWidth, height: 18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.accentColor.opacity(0.45), lineWidth: 1)
        }
        .offset(x: badgeOffset, y: 0)
        .help("再生位置 \(timecode)")
        .accessibilityLabel("再生位置 \(timecode)")
        .accessibilityIdentifier("Timeline.Ruler.PlayheadTimecode")
    }

    private var badgeOffset: CGFloat {
        let playheadX = laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
        let centeredX = playheadX - Self.badgeWidth / 2
        return max(0, min(centeredX, max(0, laneWidth - Self.badgeWidth)))
    }
}

private struct TimelinePlaybackLoopRangeBand: View {
    var range: TimelinePlaybackRange
    var sequence: TimelineSequence
    var totalFrames: Int
    var laneWidth: CGFloat
    var height: CGFloat
    var yOffset: CGFloat
    var isEnabled: Bool
    var accessibilityIdentifier: String

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(color.opacity(isEnabled ? 0.22 : 0.12))
            .overlay {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(color.opacity(isEnabled ? 0.70 : 0.40), lineWidth: isEnabled ? 1.2 : 0.9)
            }
            .frame(width: bandWidth, height: height)
            .offset(x: x, y: yOffset)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isEnabled ? "ループ範囲" : "保持中のループ範囲")
            .accessibilityValue("\(sequence.framesToTimecode(range.startFrame))-\(sequence.framesToTimecode(range.endFrame))")
            .accessibilityIdentifier(accessibilityIdentifier)
            .help("\(isEnabled ? "ループ範囲" : "保持中のループ範囲") \(sequence.framesToTimecode(range.startFrame))-\(sequence.framesToTimecode(range.endFrame))")
    }

    private var color: Color {
        isEnabled ? .green : .secondary
    }

    private var x: CGFloat {
        laneWidth * CGFloat(max(0, min(range.startFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var bandWidth: CGFloat {
        let startFrame = max(0, min(range.startFrame, totalFrames))
        let endFrame = max(startFrame + 1, min(range.endFrame, totalFrames))
        let width = laneWidth * CGFloat(endFrame - startFrame) / CGFloat(max(totalFrames, 1))
        return max(3, width)
    }
}

private struct TimelinePlayheadScrubSnap: Equatable {
    let kind: TimelinePlayheadScrubSnapKind
    let frame: Int
    let distanceFrames: Int
    let label: String
}

private enum TimelinePlayheadScrubSnapKind: Equatable {
    case editPoint
    case marker
    case timelineStart
    case timelineEnd

    var priority: Int {
        switch self {
        case .editPoint: return 0
        case .marker: return 1
        case .timelineStart, .timelineEnd: return 2
        }
    }

    var iconName: String {
        switch self {
        case .editPoint: return "arrow.left.and.line.vertical.and.arrow.right"
        case .marker: return "mappin"
        case .timelineStart: return "backward.end"
        case .timelineEnd: return "forward.end"
        }
    }
}

private struct TimelinePlayheadScrubSnapResolver {
    static func resolve(
        timeline: TimelineDocument,
        proposedFrame: Int,
        thresholdFrames: Int
    ) -> (frame: Int, snap: TimelinePlayheadScrubSnap?) {
        let totalFrames = max(0, timeline.totalFrames)
        let boundedFrame = max(0, min(proposedFrame, totalFrames))
        guard thresholdFrames > 0 else {
            return (boundedFrame, nil)
        }
        let threshold = max(0, thresholdFrames)
        let candidates = snapCandidates(for: timeline, totalFrames: totalFrames)
        let matches = candidates.compactMap { candidate -> (candidate: Candidate, distance: Int)? in
            let distance = abs(candidate.frame - boundedFrame)
            guard distance <= threshold else { return nil }
            return (candidate, distance)
        }
        .sorted { lhs, rhs in
            if lhs.distance != rhs.distance {
                return lhs.distance < rhs.distance
            }
            if lhs.candidate.kind.priority != rhs.candidate.kind.priority {
                return lhs.candidate.kind.priority < rhs.candidate.kind.priority
            }
            return lhs.candidate.frame < rhs.candidate.frame
        }

        guard let match = matches.first else {
            return (boundedFrame, nil)
        }

        return (
            match.candidate.frame,
            TimelinePlayheadScrubSnap(
                kind: match.candidate.kind,
                frame: match.candidate.frame,
                distanceFrames: match.distance,
                label: match.candidate.label
            )
        )
    }

    private static func snapCandidates(
        for timeline: TimelineDocument,
        totalFrames: Int
    ) -> [Candidate] {
        var candidates: [Candidate] = [
            Candidate(
                frame: 0,
                kind: .timelineStart,
                label: "タイムライン先頭"
            )
        ]

        if totalFrames > 0 {
            candidates.append(Candidate(
                frame: totalFrames,
                kind: .timelineEnd,
                label: "タイムライン末尾"
            ))
        }

        for marker in ProjectTimelineMarkerMap.build(timeline: timeline).markers {
            candidates.append(Candidate(
                frame: marker.frame,
                kind: .marker,
                label: marker.label.isEmpty ? "マーカー" : marker.label
            ))
        }

        for track in timeline.displayTracks {
            for clip in track.clips {
                let label = clip.segmentID.isEmpty ? clip.id : clip.segmentID
                candidates.append(Candidate(
                    frame: max(0, min(clip.timelineInFrame, totalFrames)),
                    kind: .editPoint,
                    label: "\(label) 先頭"
                ))
                candidates.append(Candidate(
                    frame: max(0, min(clip.timelineOutFrame, totalFrames)),
                    kind: .editPoint,
                    label: "\(label) 末尾"
                ))
            }
        }

        return candidates
    }

    private struct Candidate: Equatable {
        let frame: Int
        let kind: TimelinePlayheadScrubSnapKind
        let label: String
    }
}

private struct TimelinePlayheadScrubSnapIndicator: View {
    var snap: TimelinePlayheadScrubSnap
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat = 32

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.accentColor.opacity(0.88))
                .frame(width: 2, height: height)
                .shadow(color: Color.accentColor.opacity(0.36), radius: 3)
            Image(systemName: snap.kind.iconName)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 15, height: 15)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle().stroke(Color.accentColor.opacity(0.7), lineWidth: 1)
                }
                .offset(x: -6, y: -8)
        }
        .offset(x: snapOffset)
        .help("吸着: \(snap.label)")
        .accessibilityLabel("playhead吸着先 \(snap.label)")
        .accessibilityIdentifier("Timeline.PlayheadScrubSnapIndicator")
    }

    private var snapOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(snap.frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

private struct TimelineMarkerLaneHeader: View {
    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 3) {
                Image(systemName: "flag.fill")
                    .font(.system(size: 8, weight: .bold))
                Text("M")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }
            Text("マーカー")
                .font(.system(size: 7, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(Color.blue.opacity(0.86))
        .frame(width: timelineTrackHeaderWidth, alignment: .trailing)
        .help("マーカー")
        .accessibilityLabel("マーカー レーン")
        .accessibilityIdentifier("Timeline.MarkerLane.Header")
    }
}

struct TimelineMarkerLane: View {
    var markers: [TimelineMarkerCue]
    var totalFrames: Int
    var playheadFrame: Int
    var laneWidth: CGFloat

    var body: some View {
        HStack(spacing: 10) {
            TimelineMarkerLaneHeader()
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
                ForEach(markerPlacements) { placement in
                    TimelineMarkerChip(marker: placement.marker)
                        .offset(x: markerOffset(placement.marker.frame), y: placement.yOffset)
                }
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: laneHeight)
                    .offset(x: markerOffset(playheadFrame))
            }
            .frame(width: laneWidth, height: laneHeight)
        }
    }

    private var laneHeight: CGFloat {
        markers.count > 1 ? 42 : 24
    }

    private var markerPlacements: [TimelineMarkerPlacement] {
        let sortedMarkers = markers.sorted { lhs, rhs in
            if lhs.frame == rhs.frame { return lhs.id < rhs.id }
            return lhs.frame < rhs.frame
        }
        var lastXByRow = [CGFloat](
            repeating: -CGFloat.greatestFiniteMagnitude,
            count: 2
        )
        var placements: [TimelineMarkerPlacement] = []
        let minimumGap: CGFloat = 88

        for marker in sortedMarkers {
            let x = markerOffset(marker.frame)
            let row: Int
            if x - lastXByRow[0] >= minimumGap {
                row = 0
            } else if x - lastXByRow[1] >= minimumGap {
                row = 1
            } else {
                row = lastXByRow[0] <= lastXByRow[1] ? 0 : 1
            }
            lastXByRow[row] = x
            placements.append(TimelineMarkerPlacement(marker: marker, row: row))
        }
        return placements
    }

    private func markerOffset(_ frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

private struct TimelineMarkerPlacement: Identifiable {
    let marker: TimelineMarkerCue
    let row: Int

    var id: TimelineMarkerCue.ID { marker.id }

    var yOffset: CGFloat {
        row == 0 ? 3 : 21
    }
}

struct TimelineMarkerChip: View {
    var marker: TimelineMarkerCue

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
            Text(localizedTimelineMarkerLabel(marker.label))
                .font(.system(size: 9, weight: .semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 5)
        .frame(maxWidth: 128, alignment: .leading)
        .frame(height: 18)
        .background(color.opacity(0.18), in: Capsule())
        .overlay {
            Capsule().stroke(color.opacity(0.75), lineWidth: 1)
        }
        .foregroundStyle(color)
        .help("\(localizedTimelineMarkerKind(marker.kind.rawValue)) / \(marker.timecode) / \(localizedTimelineMarkerLabel(marker.label))")
        .accessibilityIdentifier("Timeline.Marker.\(timelineAccessibilitySuffix(marker.id))")
    }

    private var color: Color {
        switch marker.kind {
        case .beat: return .green
        case .note: return .blue
        case .warning: return .orange
        case .chapter: return .purple
        case .marker: return .secondary
        }
    }

    private var systemImage: String {
        switch marker.kind {
        case .beat: return "metronome"
        case .note: return "note.text"
        case .warning: return "exclamationmark.triangle"
        case .chapter: return "bookmark"
        case .marker: return "mappin"
        }
    }
}

private struct TimelineMarqueeSelection: Equatable {
    var startFrame: Int
    var endFrame: Int

    var lowerFrame: Int {
        min(startFrame, endFrame)
    }

    var upperFrame: Int {
        max(startFrame, endFrame)
    }

    var frameRange: ClosedRange<Int> {
        lowerFrame...upperFrame
    }
}

private struct TimelineMarqueeSelectionOverlay: View {
    var selection: TimelineMarqueeSelection
    var sequence: TimelineSequence
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.accentColor.opacity(0.14))
                .overlay {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(
                            Color.accentColor.opacity(0.72),
                            style: StrokeStyle(lineWidth: 1.2, dash: [5, 3])
                        )
                }
            HStack(spacing: 0) {
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2)
                Spacer(minLength: 0)
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2)
            }
        }
        .frame(width: overlayWidth, height: overlayHeight)
        .offset(x: overlayX, y: 2)
        .allowsHitTesting(false)
        .accessibilityLabel("範囲選択")
        .accessibilityValue("\(sequence.framesToTimecode(selection.lowerFrame))-\(sequence.framesToTimecode(selection.upperFrame))")
        .accessibilityIdentifier("Timeline.SelectionMarquee")
    }

    private var overlayX: CGFloat {
        boundaryOffset(selection.lowerFrame)
    }

    private var overlayWidth: CGFloat {
        max(2, boundaryOffset(selection.upperFrame) - overlayX)
    }

    private var overlayHeight: CGFloat {
        max(12, height - 4)
    }

    private func boundaryOffset(_ frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

private struct TimelineTrackHeader: View {
    var track: TimelineTrack

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 3) {
                Image(systemName: timelineTrackKindIconName(track.kind))
                    .font(.system(size: 8, weight: .bold))
                    .frame(width: 10)
                Text(track.id)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
            }
            Text(timelineTrackKindShortLabel(track.kind))
                .font(.system(size: 7, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(timelineTrackKindColor(track.kind).opacity(0.88))
        .frame(width: timelineTrackHeaderWidth, alignment: .trailing)
        .help("\(track.id) \(localizedTrackKind(track.kind))")
        .accessibilityLabel("\(track.id) \(localizedTrackKind(track.kind)) トラック")
        .accessibilityIdentifier("Timeline.TrackHeader.\(timelineAccessibilitySuffix(track.id))")
    }
}

struct TimelineTrackRow: View {
    @EnvironmentObject private var feedbackSession: StudioFeedbackSession
    @State private var activeDragClipID: TimelineClip.ID?
    @State private var activeDragTranslation: CGFloat = 0
    @State private var activeLaneScrubFrame: Int?
    @State private var activeLaneScrubSnap: TimelinePlayheadScrubSnap?
    @State private var activeMarqueeSelection: TimelineMarqueeSelection?
    @State private var activeTrimPreview: TimelineDragTrimPlan?
    @State private var activeRollPreview: TimelineRollTrimPlan?
    @State private var activeSlipPreview: TimelineSlipTrimPlan?
    @State private var activeLaneTransitionPresetTargetID: TimelineTransition.ID?
    @State private var activeLaneTransitionMoveTargetID: TimelineTransition.ID?

    var timeline: TimelineDocument
    var track: TimelineTrack
    var totalFrames: Int
    var laneWidth: CGFloat
    var audioCues: [TimelineAudioCue]
    var audioWaveforms: [TimelineAudioWaveform]
    var assetDurationsUSByID: [String: Int]
    var thumbnailURLByAssetID: [String: URL]
    var trackDensity: TimelineTrackDensity
    var recentlyChangedClipIDs: Set<String>
    var selectedClipIDs: Set<TimelineClip.ID>
    var sourceOverwritePreview: TimelineSourceOverwritePreview?
    var isSnappingEnabled: Bool
    var isMultiSelectMode: Bool
    var isBladeModeEnabled: Bool
    @Binding var selectedClipID: TimelineClip.ID?
    @Binding var selectedTransitionID: TimelineTransition.ID?
    @Binding var activeMovePreview: TimelineClipMovePlan?
    @Binding var activeGroupMovePreview: TimelineClipGroupMovePlan?
    @Binding var activeBlockedMoveTarget: TimelineTrackMoveBlockedTarget?
    @Binding var activeSourceDropPreview: TimelineSourceCandidateDropPreview?
    @Binding var activeDragRevealFrame: Int?
    var activeTransitionPresetDragID: String?
    var activeTransitionMoveID: TimelineTransition.ID?
    var recommendedTransitionDropTargetID: TimelineTransition.ID?
    var playheadFrame: Int
    var timelineSkimPreview: TimelineSkimPreview?
    var transitions: [TimelineTransition]
    var onSelectClip: (TimelineClip.ID, Bool) -> Void
    var onSelectClipRange: (TimelineTrack.ID, ClosedRange<Int>) -> Void
    var onScrubPlayhead: (Int) -> Void
    var onPreviewTimelineSkim: (Int, TimelineTrack.ID, TimelineClip.ID?) -> Void
    var onEndTimelineSkim: () -> Void
    var onBladeSplitClip: (TimelineClip.ID, Int) -> Void
    var onPreviewDragTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int, Int) -> Void
    var onEndDragTrimPreview: () -> Void
    var onDragTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int, Int) -> Void
    var onPreviewRollTrim: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void
    var onEndRollTrimPreview: () -> Void
    var onDragRollTrim: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void
    var onPreviewSlipTrim: (TimelineClip.ID, Int) -> Void
    var onEndSlipTrimPreview: () -> Void
    var onDragSlipTrim: (TimelineClip.ID, Int) -> Void
    var onBeginClipBodyDrag: (TimelineClip.ID) -> Void
    var onDragMove: (TimelineClip.ID, Int, Int, TimelineTrack.ID?) -> Void
    var onPreviewMove: (TimelineClip.ID, Int, Int, TimelineTrack.ID?) -> Void
    var onEndMovePreview: () -> Void
    var onApplyTransitionPreset: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionPresetDrop: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewDefaultTransitionEditPointHover: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionMove: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onMoveTransition: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onSelectTransition: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onAdjustTransitionDuration: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID, Int) -> Void
    var onPreviewTransitionDuration: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID, Int) -> Void
    var onEndTransitionDurationPreview: () -> Void
    var onBeginTransitionMoveDrag: (TimelineTransition.ID) -> Void
    var onEndTransitionPresetDrag: () -> Void
    var onEndTransitionMoveDrag: () -> Void
    var onPreviewSourceCandidateDrop: (String, String, Int, TimelineTrack.ID, Int) -> TimelineSourceCandidateDropPreview?
    var onDropSourceCandidate: (String, String, Int, TimelineTrack.ID, Int) -> Void
    var onOpenSwapBrowser: (TimelineClip) -> Void
    var onOpenFootageSearch: (TimelineClip) -> Void
    var onRevealClipSource: (TimelineClip.ID) -> Void

    var body: some View {
        HStack(spacing: 10) {
            TimelineTrackHeader(track: track)
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
                    .contentShape(Rectangle())
                    .gesture(laneInteractionGesture)
                    .onContinuousHover { phase in
                        handleLaneSkimHover(phase)
                    }
                    .help(laneInteractionHelpText)
                    .accessibilityLabel(
                        isMultiSelectMode
                            ? "\(track.id) \(localizedTrackKind(track.kind)) 範囲選択"
                            : "\(track.id) \(localizedTrackKind(track.kind)) 再生位置"
                    )
                    .accessibilityValue(timeline.sequence.framesToTimecode(playheadFrame))
                    .accessibilityIdentifier("Timeline.TrackScrubLane.\(timelineAccessibilitySuffix(track.id))")
                if isLaneLiftTargetRowActive {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.teal.opacity(0.08))
                        .overlay {
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(
                                    Color.teal.opacity(0.62),
                                    style: StrokeStyle(lineWidth: 1.4, dash: [6, 4])
                                )
                        }
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("Timeline.LaneLiftTargetLane.\(timelineAccessibilitySuffix(track.id))")
                }
                if isExplicitTrackMoveTargetRowActive {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.accentColor.opacity(0.08))
                        .overlay {
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(
                                    Color.accentColor.opacity(0.64),
                                    style: StrokeStyle(lineWidth: 1.4, dash: [7, 4])
                                )
                        }
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("Timeline.TrackMoveTargetLane.\(timelineAccessibilitySuffix(track.id))")
                }
                if isBlockedTrackMoveTargetRowActive {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.red.opacity(0.08))
                        .overlay {
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(
                                    Color.red.opacity(0.66),
                                    style: StrokeStyle(lineWidth: 1.4, dash: [5, 4])
                                )
                        }
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("Timeline.TrackMoveBlockedLane.\(timelineAccessibilitySuffix(track.id))")
                }
                if let clipLaneGuide = clipLaneDropGuide {
                    TimelineClipLaneDropGuide(
                        model: clipLaneGuide,
                        width: laneWidth,
                        height: rowHeight
                    )
                    .zIndex(11)
                }
                if let transitionLaneGuide = transitionLaneDropGuide {
                    TimelineTransitionLaneDropGuide(
                        model: transitionLaneGuide,
                        width: laneWidth,
                        height: rowHeight
                    )
                    .zIndex(12)
                }
                if let transitionBlockedGuide = transitionLaneBlockedGuide {
                    TimelineTransitionLaneDropGuide(
                        model: transitionBlockedGuide,
                        width: laneWidth,
                        height: rowHeight
                    )
                    .zIndex(12)
                }
                if let sourceCandidateLaneGuide = sourceCandidateLaneDropGuide {
                    TimelineSourceCandidateLaneDropGuide(
                        model: sourceCandidateLaneGuide,
                        width: laneWidth,
                        height: rowHeight
                    )
                    .zIndex(12)
                }
                if let sourceDropPreview = visibleSourceDropPreview {
                    TimelineSourceCandidateDropGhost(
                        preview: sourceDropPreview,
                        sequence: timeline.sequence,
                        width: sourceDropGhostWidth(sourceDropPreview),
                        height: clipBlockHeight
                    )
                    .offset(
                        x: boundaryOffset(sourceDropPreview.timelineInFrame),
                        y: baseLaneYOffset
                    )
                    .zIndex(13)

                    TimelineSourceCandidateDropCue(
                        preview: sourceDropPreview,
                        timecode: timeline.sequence.framesToTimecode(sourceDropPreview.timelineInFrame),
                        durationText: durationSecondsLabel(sourceDropPreview.durationFrames)
                    )
                    .offset(
                        x: max(4, min(boundaryOffset(sourceDropPreview.timelineInFrame) + 6, laneWidth - 262)),
                        y: 7
                    )
                    .zIndex(26)
                }
                if let overwritePreview = activeSourceOverwritePreview {
                    TimelineSourceOverwritePreviewBand(
                        preview: overwritePreview,
                        sequence: timeline.sequence,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: clipBlockHeight + 12
                    )
                    .offset(y: max(1, baseLaneYOffset - 6))
                    .zIndex(14)
                }
                if let groupRangeCue = groupMoveRangeCue {
                    TimelineGroupMoveRangeCue(
                        model: groupRangeCue,
                        sequence: timeline.sequence,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: clipBlockHeight + 10
                    )
                    .offset(y: max(1, groupRangeCue.yOffset - 5))
                    .zIndex(15)
                }
                if isLaneLiftPreviewActive {
                    Rectangle()
                        .fill(Color.primary.opacity(0.10))
                        .frame(height: 1)
                        .offset(y: max(clipBlockHeight + 3, baseLaneYOffset - 2.5))
                    if let cue = laneLiftCreateCue {
                        TimelineLaneLiftCreateCue(model: cue, width: laneLiftCreateCueWidth)
                            .offset(x: laneLiftCreateCueX, y: 5)
                            .zIndex(17)
                    }
                }
                if let activeMarqueeSelection {
                    TimelineMarqueeSelectionOverlay(
                        selection: activeMarqueeSelection,
                        sequence: timeline.sequence,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(9)
                }
                ForEach(audioWaveforms) { waveform in
                    if let clip = track.clips.first(where: { $0.id == waveform.clipID }) {
                        TimelineWaveformOverlay(
                            waveform: waveform,
                            clip: clip,
                            laneWidth: laneWidth,
                            totalFrames: totalFrames
                        )
                    }
                }
                .offset(y: baseLaneYOffset)
                ForEach(audioCues) { cue in
                    TimelineAudioCueOverlay(
                        cue: cue,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames
                    )
                }
                .offset(y: baseLaneYOffset)
                ForEach(track.clips.sorted { $0.timelineInFrame < $1.timelineInFrame }) { clip in
                    let width = displayedClipWidth(clip)
                    Button {
                        if isBladeModeEnabled {
                            onBladeSplitClip(clip.id, bladeSplitFrame(for: clip, localX: width / 2, clipWidth: width))
                        } else {
                            onSelectClip(clip.id, isExtendingSelectionClick)
                        }
                    } label: {
                        TimelineClipBlock(
                            clip: clip,
                            trackKind: track.kind,
                            trackDensity: trackDensity,
                            isSelected: isSelected(clip),
                            isUnderPlayhead: clip.containsTimelineFrame(playheadFrame),
                            isViewerActive: activeViewerClipIDs.contains(clip.id),
                            isWidthExpanded: isClipWidthExpanded(clip),
                            isTrimEligible: canShowTrimAffordance(for: clip),
                            showsActiveTrimHandles: canShowTrimHandles(for: clip),
                            feedbackState: feedbackState(for: clip),
                            movePreviewRole: movePreviewRole(for: clip),
                            isTrimPreviewing: activeTrimPreview?.targetClipID == clip.id,
                            isBodyDragActive: activeDragClipID == clip.id,
                            isSkimPreviewing: activeTrackSkimPreview?.clipID == clip.id,
                            isBladeModeActive: isBladeModeEnabled,
                            thumbnailURL: thumbnailURLByAssetID[clip.assetID],
                            timingMetadataLabel: clipTimingMetadataLabel(for: clip)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibilityLabel(for: clip))
                    .accessibilityValue(accessibilityValue(for: clip))
                    .accessibilityIdentifier("Timeline.Clip.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                    .frame(
                        width: width,
                        height: clipBlockHeight
                    )
                    .onContinuousHover { phase in
                        handleClipSkimHover(phase, clip: clip, clipWidth: width)
                    }
                    .simultaneousGesture(clipMoveDragGesture(for: clip, clipWidth: width))
                    .overlay {
                        ZStack {
                            if canShowTrimHandles(for: clip) && !isBladeModeEnabled {
                                TimelineTrimHandleOverlay(
                                    trackID: track.id,
                                    clip: clip,
                                    clipWidth: width,
                                    laneWidth: laneWidth,
                                    totalFrames: totalFrames,
                                    snapThresholdFrames: magneticSnapThresholdFrames,
                                    onPreviewTrim: { _, edge, frameDelta in
                                        activeMovePreview = nil
                                        activeGroupMovePreview = nil
                                        activeBlockedMoveTarget = nil
                                        activeRollPreview = nil
                                        activeSlipPreview = nil
                                        onEndMovePreview()
                                        onEndRollTrimPreview()
                                        onEndSlipTrimPreview()
                                        let preview = makeTrimPreview(for: clip, edge: edge, frameDelta: frameDelta)
                                        activeTrimPreview = preview
                                        activeDragRevealFrame = preview?.targetBoundaryFrame
                                        if preview != nil {
                                            onPreviewDragTrim(clip.id, edge, frameDelta, magneticSnapThresholdFrames)
                                        } else {
                                            onEndDragTrimPreview()
                                        }
                                    },
                                    onEndTrimPreview: {
                                        activeTrimPreview = nil
                                        activeDragRevealFrame = nil
                                        onEndDragTrimPreview()
                                    },
                                    onDragTrim: onDragTrim
                                )
                                .zIndex(4)
                            }
                            if !isBladeModeEnabled && (canShowRollHandle(for: clip, boundary: .incoming) || canShowRollHandle(for: clip, boundary: .outgoing)) {
                                TimelineRollHandleOverlay(
                                    trackID: track.id,
                                    clip: clip,
                                    sequence: timeline.sequence,
                                    clipWidth: width,
                                    laneWidth: laneWidth,
                                    totalFrames: totalFrames,
                                    incomingPreview: activeRollPreview?.clipIDPairIncludes(clip.id) == true && activeRollPreview?.boundary == .incoming ? activeRollPreview : nil,
                                    outgoingPreview: activeRollPreview?.clipIDPairIncludes(clip.id) == true && activeRollPreview?.boundary == .outgoing ? activeRollPreview : nil,
                                    canRollIncoming: canShowRollHandle(for: clip, boundary: .incoming),
                                    canRollOutgoing: canShowRollHandle(for: clip, boundary: .outgoing),
                                    onPreviewRoll: { _, boundary, frameDelta in
                                        activeMovePreview = nil
                                        activeGroupMovePreview = nil
                                        activeBlockedMoveTarget = nil
                                        activeTrimPreview = nil
                                        activeSlipPreview = nil
                                        onEndMovePreview()
                                        onEndDragTrimPreview()
                                        onEndSlipTrimPreview()
                                        let preview = makeRollPreview(for: clip, boundary: boundary, frameDelta: frameDelta)
                                        activeRollPreview = preview
                                        activeDragRevealFrame = preview?.newBoundaryFrame
                                        if preview != nil {
                                            onPreviewRollTrim(clip.id, boundary, frameDelta)
                                        } else {
                                            onEndRollTrimPreview()
                                        }
                                    },
                                    onEndRollPreview: {
                                        activeRollPreview = nil
                                        activeDragRevealFrame = nil
                                        onEndRollTrimPreview()
                                    },
                                    onDragRoll: onDragRollTrim
                                )
                                .zIndex(6)
                            }
                            if canShowSlipHandle(for: clip) && !isBladeModeEnabled {
                                TimelineSlipHandleOverlay(
                                    trackID: track.id,
                                    clip: clip,
                                    clipWidth: width,
                                    laneWidth: laneWidth,
                                    totalFrames: totalFrames,
                                    preview: activeSlipPreview?.clipID == clip.id ? activeSlipPreview : nil,
                                    onPreviewSlip: { _, frameDelta in
                                        activeMovePreview = nil
                                        activeGroupMovePreview = nil
                                        activeBlockedMoveTarget = nil
                                        activeTrimPreview = nil
                                        activeRollPreview = nil
                                        onEndMovePreview()
                                        onEndDragTrimPreview()
                                        onEndRollTrimPreview()
                                        activeSlipPreview = makeSlipPreview(for: clip, frameDelta: frameDelta)
                                        if activeSlipPreview != nil {
                                            onPreviewSlipTrim(clip.id, frameDelta)
                                        } else {
                                            onEndSlipTrimPreview()
                                        }
                                    },
                                    onEndSlipPreview: {
                                        activeSlipPreview = nil
                                        onEndSlipTrimPreview()
                                    },
                                    onDragSlip: onDragSlipTrim
                                )
                                .zIndex(5)
                            }
                            if isBladeModeEnabled {
                                TimelineBladeClickOverlay(
                                    clipID: clip.id,
                                    onSplitAtLocalX: { localX in
                                        onBladeSplitClip(
                                            clip.id,
                                            bladeSplitFrame(for: clip, localX: localX, clipWidth: width)
                                        )
                                    }
                                )
                            }
                        }
                    }
                    .offset(
                        x: displayedClipOffset(clip),
                        y: clipLaneYOffset(for: clip)
                    )
                    .opacity(clipOpacity(for: clip))
                    .zIndex(zIndex(for: clip))
                    .contextMenu {
                        Button("承認") {
                            feedbackSession.approveClip(clip.id)
                        }
                        .accessibilityIdentifier("Timeline.ContextMenu.Approve.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                        Button("却下") {
                            feedbackSession.rejectClip(clip.id, reason: "ユーザーが却下")
                        }
                        .accessibilityIdentifier("Timeline.ContextMenu.Reject.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                        if track.kind == .video || track.kind == .audio {
                            Button("ソース確認") {
                                onRevealClipSource(clip.id)
                            }
                            .accessibilityIdentifier("Timeline.ContextMenu.RevealSource.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                            Button("差し替え...") {
                                onOpenSwapBrowser(clip)
                            }
                            .accessibilityIdentifier("Timeline.ContextMenu.Swap.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                            Button("差し替え素材を検索...") {
                                onOpenFootageSearch(clip)
                            }
                            .accessibilityIdentifier("Timeline.ContextMenu.SearchReplacement.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                        }
                        Button("削除") {
                            feedbackSession.rejectClip(clip.id, reason: "ユーザーが削除")
                        }
                        .accessibilityIdentifier("Timeline.ContextMenu.Remove.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                    }
                    .overlay(alignment: .topLeading) {
                        if let impact = sourceOverwriteImpact(for: clip) {
                            TimelineSourceOverwriteImpactBadge(
                                trackID: track.id,
                                clipID: clip.id,
                                impact: impact
                            )
                            .offset(x: 4, y: -11)
                            .zIndex(27)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if let avoidTargetTrackID = laneLiftAvoidanceTargetID(for: clip) {
                            TimelineLaneLiftAvoidedClipBadge(
                                trackID: track.id,
                                clipID: clip.id,
                                targetTrackID: avoidTargetTrackID
                            )
                            .offset(x: -4, y: -11)
                            .zIndex(28)
                        }
                    }
                }
                if let ghost = laneLiftTargetGhost {
                    TimelineLaneLiftTargetGhost(
                        trackID: track.id,
                        clip: ghost.clip,
                        trackKind: track.kind,
                        width: laneLiftTargetGhostWidth(for: ghost),
                        targetTrackID: ghost.targetTrackID,
                        timecode: ghost.timecode,
                        durationText: ghost.durationText
                    )
                    .offset(
                        x: boundaryOffset(ghost.timelineInFrame),
                        y: baseLaneYOffset
                    )
                    .zIndex(23)
                }
                if let ghost = trackMoveTargetGhost {
                    TimelineTrackMoveTargetGhost(
                        trackID: track.id,
                        clip: ghost.clip,
                        trackKind: track.kind,
                        width: trackMoveTargetGhostWidth(for: ghost),
                        targetTrackID: ghost.targetTrackID,
                        timecode: ghost.timecode,
                        durationText: ghost.durationText
                    )
                    .offset(
                        x: boundaryOffset(ghost.timelineInFrame),
                        y: baseLaneYOffset
                    )
                    .zIndex(23)
                }
                ForEach(groupMoveTargetGhosts) { ghost in
                    TimelineGroupMoveTargetGhost(
                        trackID: track.id,
                        clip: ghost.clip,
                        trackKind: track.kind,
                        width: groupMoveTargetGhostWidth(for: ghost),
                        targetTrackID: ghost.targetTrackID,
                        timecode: ghost.timecode,
                        durationText: ghost.durationText,
                        isLaneLifted: ghost.isLaneLifted
                    )
                    .offset(
                        x: boundaryOffset(ghost.timelineInFrame),
                        y: baseLaneYOffset
                    )
                    .zIndex(23)
                }
                if let blocked = trackMoveBlockedCue {
                    TimelineTrackMoveBlockedCue(
                        trackID: track.id,
                        clipID: blocked.clipID,
                        width: trackMoveBlockedCueWidth(for: blocked),
                        reason: blocked.reason,
                        durationText: blocked.durationText
                    )
                    .offset(
                        x: boundaryOffset(blocked.timelineInFrame),
                        y: baseLaneYOffset
                    )
                    .zIndex(23)
                }
                if let landingCue = clipMoveLandingCue {
                    TimelineClipMoveLandingCue(
                        trackID: track.id,
                        model: landingCue,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: 28
                    )
                    .offset(y: landingCue.yOffset)
                    .zIndex(24)
                }
                ForEach(transitionDropTargets) { target in
                    let existingTransition = transition(for: target)
                    let targetWidth = transitionTargetWidth(existingTransition)
                    let hitAreaWidth = transitionHitAreaWidth(existingTransition)
                    TimelineTransitionDropTarget(
                        sequence: timeline.sequence,
                        target: target,
                        existingTransition: existingTransition,
                        targetWidth: targetWidth,
                        hitAreaWidth: hitAreaWidth,
                        pixelsPerFrame: laneWidth / CGFloat(max(totalFrames, 1)),
                        totalFrames: totalFrames,
                        trackDensity: trackDensity,
                        isSelected: existingTransition?.id == selectedTransitionID,
                        activeDragRevealFrame: $activeDragRevealFrame,
                        activePresetDragID: activeTransitionPresetDragID,
                        activeTransitionMoveID: activeTransitionMoveID,
                        activeTransitionMoveSummary: activeTransitionMoveSummary,
                        isLanePresetDropTarget: target.transitionID == activeLaneTransitionPresetTargetID,
                        isLaneTransitionMoveTarget: target.transitionID == activeLaneTransitionMoveTargetID,
                        isRecommendedPresetDropTarget: target.transitionID == recommendedTransitionDropTargetID,
                        onApplyTransitionPreset: onApplyTransitionPreset,
                        onPreviewTransitionPresetDrop: onPreviewTransitionPresetDrop,
                        onPreviewDefaultTransitionEditPointHover: onPreviewDefaultTransitionEditPointHover,
                        onPreviewTransitionMove: onPreviewTransitionMove,
                        onMoveTransition: onMoveTransition,
                        onSelectTransition: onSelectTransition,
                        onAdjustTransitionDuration: onAdjustTransitionDuration,
                        onPreviewTransitionDuration: onPreviewTransitionDuration,
                        onEndTransitionDurationPreview: onEndTransitionDurationPreview,
                        onBeginTransitionMoveDrag: onBeginTransitionMoveDrag,
                        onEndTransitionPresetDrag: onEndTransitionPresetDrag,
                        onEndTransitionMoveDrag: onEndTransitionMoveDrag
                    )
                    .offset(x: boundaryOffset(target.boundaryFrame) - hitAreaWidth / 2, y: baseLaneYOffset)
                    .zIndex(16)
                }
                if let trimPreview = activeTrimPreview {
                    TimelineTrimBoundaryIndicator(
                        plan: trimPreview,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(18)
                    TimelineTrimPreviewBadge(
                        plan: trimPreview,
                        sequence: timeline.sequence
                    )
                    .offset(
                        x: trimPreviewBadgeOffset(for: trimPreview),
                        y: baseLaneYOffset + 2
                    )
                    .zIndex(19)
                }
                if let moveBadge = movePreviewBadge {
                    TimelineMovePreviewBadge(model: moveBadge)
                        .offset(
                            x: movePreviewBadgeOffset(for: moveBadge.anchorFrame),
                            y: movePreviewBadgeYOffset
                        )
                        .zIndex(24)
                }
                if let snap = activeMovePreview?.snap ?? activeGroupMovePreview?.snap ?? activeTrimPreview?.snap {
                    TimelineSnapIndicator(
                        snap: snap,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(18)
                }
                if let sourceDropPreview = visibleSourceDropPreview,
                   sourceDropPreview.isCompatibleTarget,
                   let sourceSnap = sourceDropPreview.snap {
                    TimelineSourceDropSnapIndicator(
                        snap: sourceSnap,
                        color: sourceDropPreview.isLaneLifted ? .teal : .orange,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(18)
                }
                if let transitionSnapTarget = activeTransitionLaneSnapTarget {
                    TimelineTransitionDropSnapIndicator(
                        model: transitionSnapTarget,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(18)
                }
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: rowHeight)
                    .offset(x: playheadOffset)
                if let skimPreview = activeTrackSkimPreview {
                    TimelineSkimPreviewIndicator(
                        trackID: track.id,
                        frame: skimPreview.frame,
                        timecode: timeline.sequence.framesToTimecode(skimPreview.frame),
                        isClipBound: skimPreview.clipID != nil,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(21)
                }
                if let activeLaneScrubSnap {
                    TimelinePlayheadScrubSnapIndicator(
                        snap: activeLaneScrubSnap,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames,
                        height: rowHeight
                    )
                    .zIndex(22)
                }
                if let activeLaneScrubFrame {
                    TimelineLaneScrubBadge(
                        timecode: timeline.sequence.framesToTimecode(activeLaneScrubFrame),
                        snap: activeLaneScrubSnap
                    )
                    .offset(
                        x: laneScrubBadgeOffset(for: activeLaneScrubFrame, hasSnap: activeLaneScrubSnap != nil),
                        y: max(1, baseLaneYOffset - 1)
                    )
                    .zIndex(23)
                }
            }
            .onDrop(
                of: [UTType.plainText],
                delegate: TimelineSourceCandidateDropDelegate(
                    timeline: timeline,
                    trackID: track.id,
                    totalFrames: totalFrames,
                    laneWidth: laneWidth,
                    snapThresholdFrames: magneticSnapThresholdFrames,
                    blockedTransitionClipIDs: blockedTransitionClipIDs,
                    activePreview: $activeSourceDropPreview,
                    activeTransitionPresetTargetID: $activeLaneTransitionPresetTargetID,
                    activeTransitionMoveTargetID: $activeLaneTransitionMoveTargetID,
                    onPreviewSourceCandidate: onPreviewSourceCandidateDrop,
                    onDropSourceCandidate: onDropSourceCandidate,
                    onPreviewTransitionPresetDrop: onPreviewTransitionPresetDrop,
                    onApplyTransitionPreset: onApplyTransitionPreset,
                    onPreviewTransitionMove: onPreviewTransitionMove,
                    onMoveTransition: onMoveTransition,
                    onEndTransitionDropPreview: onEndTransitionDurationPreview,
                    onEndTransitionPresetDrag: onEndTransitionPresetDrag,
                    onEndTransitionMoveDrag: onEndTransitionMoveDrag
                )
            )
            .frame(width: laneWidth, height: rowHeight)
        }
        .onChange(of: activeTransitionPresetDragID) { _, newValue in
            if newValue == nil {
                activeLaneTransitionPresetTargetID = nil
            }
        }
        .onChange(of: activeTransitionMoveID) { _, newValue in
            if newValue == nil {
                activeLaneTransitionMoveTargetID = nil
            }
        }
    }

    private var rowHeight: CGFloat {
        CGFloat(isLaneLiftPreviewActive ? trackDensity.laneLiftRowHeight : trackDensity.rowHeight)
    }

    private var activeTrackSkimPreview: TimelineSkimPreview? {
        guard canPreviewTimelineSkim,
              let preview = timelineSkimPreview,
              preview.trackID == track.id
        else {
            return nil
        }
        return preview
    }

    private var canPreviewTimelineSkim: Bool {
        !isMultiSelectMode
            && !isBladeModeEnabled
            && activeDragClipID == nil
            && activeLaneScrubFrame == nil
            && activeMarqueeSelection == nil
            && activeTrimPreview == nil
            && activeMovePreview == nil
            && activeGroupMovePreview == nil
            && activeBlockedMoveTarget == nil
            && activeSourceDropPreview == nil
            && activeTransitionPresetDragID == nil
            && activeTransitionMoveID == nil
    }

    private var blockedTransitionClipIDs: Set<TimelineClip.ID> {
        Set(track.clips.map(\.id).filter {
            feedbackSession.hasPendingRemove(for: $0) || feedbackSession.rejectedClipIDs.contains($0)
        })
    }

    private var clipBlockHeight: CGFloat {
        CGFloat(trackDensity.clipHeight)
    }

    private var isLaneLiftPreviewActive: Bool {
        if activeMovePreview?.trackID == track.id && activeMovePreview?.laneLift?.createsTrack == true {
            return true
        }
        if let preview = activeGroupMovePreview,
           preview.sourceTrackID == track.id,
           preview.laneLift?.createsTrack == true {
            return true
        }
        return false
    }

    private var isLaneLiftTargetRowActive: Bool {
        if let preview = activeMovePreview,
           let laneLift = preview.laneLift,
           !laneLift.createsTrack {
            return laneLift.targetTrackID == track.id
        }
        if let preview = activeGroupMovePreview,
           let laneLift = preview.laneLift,
           !laneLift.createsTrack {
            return laneLift.targetTrackID == track.id
        }
        return false
    }

    private var isExplicitTrackMoveTargetRowActive: Bool {
        guard let preview = activeMovePreview,
              preview.laneLift == nil,
              preview.trackID != track.id
        else { return false }
        return preview.targetTrackID == track.id
    }

    private var isBlockedTrackMoveTargetRowActive: Bool {
        activeBlockedMoveTarget?.targetTrackID == track.id
    }

    private var clipLaneDropGuide: TimelineClipLaneDropGuideModel? {
        guard activeTransitionPresetDragID == nil,
              activeTransitionMoveID == nil,
              activeSourceDropPreview == nil,
              isCrossLaneClipMovePreviewActive,
              !isLaneLiftPreviewActive,
              !isLaneLiftTargetRowActive,
              !isExplicitTrackMoveTargetRowActive,
              !isBlockedTrackMoveTargetRowActive,
              let source = activeClipMoveSource,
              source.sourceTrackID != track.id,
              source.kind == track.kind
        else {
            return nil
        }

        let overlaps = clipMoveWouldOverlapThisTrack
        let title = source.isGroup ? "\(source.count)クリップ 移動可能" : "クリップ移動可能"
        let snapText = source.snapLabel.map { " / 吸着 \($0)" } ?? ""
        let detail = overlaps
            ? "\(track.id) \(source.targetTimecode)\(snapText) は重なりあり。空きレーンへ自動回避"
            : "\(track.id) \(source.targetTimecode)\(snapText) へ直接移動できます"
        return TimelineClipLaneDropGuideModel(
            trackID: track.id,
            title: title,
            durationText: source.durationText,
            detail: detail,
            systemImage: overlaps ? "square.stack.3d.up" : "arrow.up.and.down",
            color: overlaps ? .teal : .accentColor
        )
    }

    private var isCrossLaneClipMovePreviewActive: Bool {
        if let preview = activeMovePreview {
            return preview.targetTrackID != preview.trackID || preview.laneLift != nil
        }
        if let preview = activeGroupMovePreview {
            return preview.targetTrackID != nil || preview.laneLift != nil
        }
        return false
    }

    private var activeClipMoveSource: TimelineClipLaneDropSource? {
        if let preview = activeMovePreview,
           let sourceTrack = timeline.displayTracks.first(where: { $0.id == preview.trackID }) {
            return TimelineClipLaneDropSource(
                sourceTrackID: preview.trackID,
                kind: sourceTrack.kind,
                count: 1,
                isGroup: false,
                durationText: durationSecondsLabel(preview.durationFrames),
                targetTimecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrame),
                snapLabel: preview.snap?.label
            )
        }
        if let preview = activeGroupMovePreview,
           let sourceTrackID = preview.sourceTrackID,
           let sourceTrack = timeline.displayTracks.first(where: { $0.id == sourceTrackID }) {
            let fallbackDurationFrames = timeline.displayTracks
                .flatMap(\.clips)
                .first(where: { preview.movedClipIDs.contains($0.id) })?
                .timelineDurationFrames ?? 0
            return TimelineClipLaneDropSource(
                sourceTrackID: sourceTrackID,
                kind: sourceTrack.kind,
                count: preview.movedClipIDs.count,
                isGroup: true,
                durationText: groupMoveSpanDurationFrames(for: preview).map(durationSecondsLabel)
                    ?? durationSecondsLabel(fallbackDurationFrames),
                targetTimecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrames.values.min() ?? 0),
                snapLabel: preview.snap?.label
            )
        }
        return nil
    }

    private var clipMoveWouldOverlapThisTrack: Bool {
        if let preview = activeMovePreview {
            return track.clips.contains { clip in
                clip.id != preview.targetClipID
                    && intervalsOverlap(
                        startA: preview.newTimelineInFrame,
                        endA: preview.newTimelineInFrame + preview.durationFrames,
                        startB: clip.timelineInFrame,
                        endB: clip.timelineOutFrame
                    )
            }
        }
        if let preview = activeGroupMovePreview {
            let movedIntervals: [(start: Int, end: Int)] = timeline.displayTracks.flatMap(\.clips).compactMap { clip in
                guard preview.movedClipIDs.contains(clip.id),
                      let start = preview.newTimelineInFrame(for: clip.id)
                else {
                    return nil
                }
                return (start, start + clip.timelineDurationFrames)
            }
            return track.clips.contains { clip in
                guard !preview.movedClipIDs.contains(clip.id) else { return false }
                return movedIntervals.contains {
                    intervalsOverlap(
                        startA: $0.start,
                        endA: $0.end,
                        startB: clip.timelineInFrame,
                        endB: clip.timelineOutFrame
                    )
                }
            }
        }
        return false
    }

    private func intervalsOverlap(startA: Int, endA: Int, startB: Int, endB: Int) -> Bool {
        startA < endB && startB < endA
    }

    private var activeSourceOverwritePreview: TimelineSourceOverwritePreview? {
        guard let sourceOverwritePreview,
              sourceOverwritePreview.targetTrackID == track.id
        else { return nil }
        return sourceOverwritePreview
    }

    private var visibleSourceDropPreview: TimelineSourceCandidateDropPreview? {
        guard let preview = activeSourceDropPreview else { return nil }
        if preview.targetTrackID == track.id {
            return preview
        }
        if !preview.isCompatibleTarget && preview.requestedTrackID == track.id {
            return preview
        }
        if preview.isCompatibleTarget,
           preview.laneLiftCreatesTrack,
           preview.requestedTrackID == track.id {
            return preview
        }
        return nil
    }

    private var sourceCandidateLaneDropGuide: TimelineSourceCandidateLaneDropGuideModel? {
        guard activeTransitionPresetDragID == nil,
              activeTransitionMoveID == nil,
              let preview = activeSourceDropPreview,
              track.kind == preview.targetTrackKind
        else {
            return nil
        }

        if preview.isLaneLifted, preview.requestedTrackID == track.id {
            return TimelineSourceCandidateLaneDropGuideModel(
                trackID: track.id,
                title: "\(preview.segmentID) 自動回避",
                detail: "\(sourceCandidateLandingSummary(preview)) / \(preview.overlappedClipCount)件の重なりを避けて \(preview.targetTrackID) へ配置",
                systemImage: "square.stack.3d.up",
                color: .teal
            )
        }

        if preview.isLaneLifted, preview.targetTrackID == track.id {
            return TimelineSourceCandidateLaneDropGuideModel(
                trackID: track.id,
                title: "\(preview.segmentID) 回避先",
                detail: "\(sourceCandidateLandingSummary(preview)) / \(preview.requestedTrackID) で重なった素材をこのレーンへ磁気配置",
                systemImage: "arrow.triangle.branch",
                color: .teal
            )
        }

        if preview.targetTrackID == track.id || preview.requestedTrackID == track.id {
            let snapText = sourceCandidateSnapSummary(preview.snap)
            return TimelineSourceCandidateLaneDropGuideModel(
                trackID: track.id,
                title: "\(preview.segmentID) ドロップ可能",
                detail: "\(preview.roleLabel)素材 / \(sourceCandidateLandingSummary(preview)) / \(snapText)",
                systemImage: preview.snap == nil ? "plus.rectangle.on.rectangle" : "magnet",
                color: .orange
            )
        }

        return TimelineSourceCandidateLaneDropGuideModel(
            trackID: track.id,
            title: "\(preview.roleLabel)素材を配置可能",
            detail: "\(sourceCandidateLandingSummary(preview)) / この \(localizedTrackKind(track.kind)) レーンへドラッグして追加",
            systemImage: "plus.rectangle.on.rectangle",
            color: .orange
        )
    }

    private func sourceCandidateLandingSummary(_ preview: TimelineSourceCandidateDropPreview) -> String {
        "\(timeline.sequence.framesToTimecode(preview.timelineInFrame)) / 尺\(durationSecondsLabel(preview.durationFrames))"
    }

    private func sourceCandidateSnapSummary(_ snap: TimelineSourceInsertSnap?) -> String {
        snap.map { "吸着 \($0.label)" } ?? "その位置へ追加"
    }

    private var transitionLaneDropGuide: TimelineTransitionLaneDropGuideModel? {
        let targets = eligibleTransitionLaneDropTargets
        guard !targets.isEmpty else { return nil }

        if let activeTransitionPresetDragID,
           let preset = TimelineTransitionPreset(rawValue: activeTransitionPresetDragID) {
            let presetSummary = "\(preset.localizedLabel) \(preset.defaultFrames)f"
            let targetRangeSuffix = transitionLaneTargetRangeText(for: targets).map { " / \($0)" } ?? ""
            let primaryTarget = transitionLanePrimaryTargetText(
                for: targets,
                targetID: activeLaneTransitionPresetTargetID,
                fallbackTargetID: recommendedTransitionDropTargetID
            )
            return TimelineTransitionLaneDropGuideModel(
                trackID: track.id,
                title: "\(presetSummary) レーンで離す",
                detail: "離すと最寄り \(primaryTarget) へ磁気適用 / \(targets.count)候補\(targetRangeSuffix)",
                systemImage: "magnet",
                color: .accentColor
            )
        }

        if let activeTransitionMoveID {
            let moveTargets = targets.filter { $0.transitionID != activeTransitionMoveID }
            guard !moveTargets.isEmpty else { return nil }
            let moveTitle = activeTransitionMoveSummary.map { "\($0) 移動レーン" } ?? "トランジション移動レーン"
            let targetRangeSuffix = transitionLaneTargetRangeText(for: moveTargets).map { " / \($0)" } ?? ""
            let primaryTarget = transitionLanePrimaryTargetText(
                for: moveTargets,
                targetID: activeLaneTransitionMoveTargetID
            )
            return TimelineTransitionLaneDropGuideModel(
                trackID: track.id,
                title: moveTitle,
                detail: "最寄り \(primaryTarget) / \(moveTargets.count)候補\(targetRangeSuffix)",
                systemImage: "arrowshape.turn.up.right.fill",
                color: .orange
            )
        }

        return nil
    }

    private var transitionLaneBlockedGuide: TimelineTransitionLaneDropGuideModel? {
        guard track.kind != .video && track.kind != .overlay else { return nil }

        if let activeTransitionPresetDragID,
           let preset = TimelineTransitionPreset(rawValue: activeTransitionPresetDragID) {
            return TimelineTransitionLaneDropGuideModel(
                trackID: track.id,
                title: "\(preset.localizedLabel) 対象外",
                detail: "\(localizedTrackKind(track.kind))レーンには適用不可 / V・O編集点へ移動",
                systemImage: "nosign",
                color: .red
            )
        }

        if activeTransitionMoveID != nil {
            return TimelineTransitionLaneDropGuideModel(
                trackID: track.id,
                title: "トランジション移動不可",
                detail: "\(localizedTrackKind(track.kind))レーンは対象外 / V・O編集点へ移動",
                systemImage: "nosign",
                color: .red
            )
        }

        return nil
    }

    private func transitionLanePrimaryTargetText(
        for targets: [TimelineTransitionDropTargetModel],
        targetID: TimelineTransition.ID?,
        fallbackTargetID: TimelineTransition.ID? = nil
    ) -> String {
        let target = targetID.flatMap { id in
            targets.first { $0.transitionID == id }
        } ?? fallbackTargetID.flatMap { id in
            targets.first { $0.transitionID == id }
        } ?? targets.first
        guard let target else { return "編集点" }
        return "@ \(timeline.sequence.framesToTimecode(target.boundaryFrame)) \(target.fromClipID)→\(target.toClipID)"
    }

    private var activeTransitionLaneSnapTarget: TimelineTransitionDropSnapIndicatorModel? {
        let targets = eligibleTransitionLaneDropTargets
        guard !targets.isEmpty else { return nil }

        if let activeTransitionPresetDragID,
           TimelineTransitionPreset(rawValue: activeTransitionPresetDragID) != nil,
           let target = activeLaneTransitionPresetTargetID.flatMap({ id in
               targets.first { $0.transitionID == id }
           }) {
            return TimelineTransitionDropSnapIndicatorModel(
                target: target,
                label: "Drop \(timeline.sequence.framesToTimecode(target.boundaryFrame))",
                color: .accentColor,
                systemImage: "magnet"
            )
        }

        if let activeTransitionMoveID,
           let target = activeLaneTransitionMoveTargetID.flatMap({ id in
               targets.first {
                   $0.transitionID == id && $0.transitionID != activeTransitionMoveID
               }
           }) {
            return TimelineTransitionDropSnapIndicatorModel(
                target: target,
                label: timeline.sequence.framesToTimecode(target.boundaryFrame),
                color: .orange,
                systemImage: "arrowshape.turn.up.right.fill"
            )
        }

        return nil
    }

    private var eligibleTransitionLaneDropTargets: [TimelineTransitionDropTargetModel] {
        guard track.kind == .video || track.kind == .overlay else { return [] }
        return transitionDropTargets.filter {
            !blockedTransitionClipIDs.contains($0.fromClipID)
                && !blockedTransitionClipIDs.contains($0.toClipID)
        }
    }

    private func transitionLaneTargetRangeText(for targets: [TimelineTransitionDropTargetModel]) -> String? {
        let boundaryFrames = targets.map(\.boundaryFrame).sorted()
        guard let firstFrame = boundaryFrames.first else { return nil }
        guard let lastFrame = boundaryFrames.last, lastFrame != firstFrame else {
            return timeline.sequence.framesToTimecode(firstFrame)
        }
        return "\(timeline.sequence.framesToTimecode(firstFrame))-\(timeline.sequence.framesToTimecode(lastFrame))"
    }

    private var activeTransitionMoveSummary: String? {
        guard let activeTransitionMoveID,
              let transition = transitions.first(where: {
                $0.id == activeTransitionMoveID && $0.isVisibleTimelineTransition
              })
        else {
            return nil
        }
        return transitionMoveSummary(transition)
    }

    private func transitionMoveSummary(_ transition: TimelineTransition) -> String {
        let frames = transition.transitionFrames.map { "\($0)f" } ?? "長さ未設定"
        return "\(localizedTimelineTransitionType(transition.transitionType)) \(frames)"
    }

    private var baseLaneYOffset: CGFloat {
        isLaneLiftPreviewActive
            ? liftedLaneYOffset + clipBlockHeight + 4
            : max(2, (rowHeight - clipBlockHeight) / 2)
    }

    private var liftedLaneYOffset: CGFloat {
        max(2, (rowHeight - (clipBlockHeight * 2 + 4)) / 2)
    }

    private var laneLiftIconOffset: CGFloat {
        if let preview = activeMovePreview, preview.trackID == track.id {
            return max(6, min(laneWidth - 24, boundaryOffset(preview.newTimelineInFrame) + 6))
        }
        if let preview = activeGroupMovePreview,
           preview.sourceTrackID == track.id,
           let startFrame = preview.newTimelineInFrames.values.min() {
            return max(6, min(laneWidth - 24, boundaryOffset(startFrame) + 6))
        }
        return 8
    }

    private var laneLiftCreateCueX: CGFloat {
        max(4, min(laneLiftIconOffset, max(4, laneWidth - laneLiftCreateCueWidth - 4)))
    }

    private var laneLiftCreateCueWidth: CGFloat {
        min(max(190, laneWidth * 0.30), max(80, laneWidth - 8))
    }

    private var laneLiftCreateCue: TimelineLaneLiftCreateCueModel? {
        if let preview = activeMovePreview,
           preview.trackID == track.id,
           let laneLift = preview.laneLift,
           laneLift.createsTrack {
            return TimelineLaneLiftCreateCueModel(
                trackID: track.id,
                targetTrackID: laneLift.targetTrackID,
                timecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrame),
                durationText: durationSecondsLabel(preview.durationFrames),
                movedClipCount: 1,
                overlappedClipCount: laneLift.overlappedClipIDs.count
            )
        }
        if let preview = activeGroupMovePreview,
           preview.sourceTrackID == track.id,
           let laneLift = preview.laneLift,
           laneLift.createsTrack {
            let fallbackDurationFrames = timeline.displayTracks
                .flatMap(\.clips)
                .first(where: { preview.movedClipIDs.contains($0.id) })?
                .timelineDurationFrames ?? 0
            return TimelineLaneLiftCreateCueModel(
                trackID: track.id,
                targetTrackID: laneLift.targetTrackID,
                timecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrames.values.min() ?? 0),
                durationText: groupMoveSpanDurationFrames(for: preview).map(durationSecondsLabel)
                    ?? durationSecondsLabel(fallbackDurationFrames),
                movedClipCount: preview.movedClipIDs.count,
                overlappedClipCount: laneLift.overlappedClipIDs.count
            )
        }
        return nil
    }

    private var laneLiftTargetGhost: TimelineLaneLiftTargetGhostModel? {
        guard let preview = activeMovePreview,
              let laneLift = preview.laneLift,
              !laneLift.createsTrack,
              laneLift.targetTrackID == track.id,
              let clip = clip(for: preview.targetClipID)
        else { return nil }
        return TimelineLaneLiftTargetGhostModel(
            clip: clip,
            timelineInFrame: preview.newTimelineInFrame,
            durationFrames: preview.durationFrames,
            durationText: String(format: "%.1fs", timeline.sequence.framesToSeconds(preview.durationFrames)),
            timecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrame),
            targetTrackID: laneLift.targetTrackID
        )
    }

    private var trackMoveTargetGhost: TimelineTrackMoveTargetGhostModel? {
        guard let preview = activeMovePreview,
              preview.laneLift == nil,
              preview.trackID != track.id,
              preview.targetTrackID == track.id,
              let clip = clip(for: preview.targetClipID)
        else { return nil }
        return TimelineTrackMoveTargetGhostModel(
            clip: clip,
            timelineInFrame: preview.newTimelineInFrame,
            durationFrames: preview.durationFrames,
            durationText: String(format: "%.1fs", timeline.sequence.framesToSeconds(preview.durationFrames)),
            timecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrame),
            targetTrackID: preview.targetTrackID
        )
    }

    private var groupMoveTargetGhosts: [TimelineGroupMoveTargetGhostModel] {
        guard let preview = activeGroupMovePreview,
              let targetTrackID = preview.targetTrackID,
              targetTrackID == track.id,
              preview.laneLift?.createsTrack != true
        else { return [] }
        return preview.movedClipIDs.compactMap { clipID -> TimelineGroupMoveTargetGhostModel? in
            guard let clip = clip(for: clipID),
                  let timelineInFrame = preview.newTimelineInFrame(for: clipID)
            else { return nil }
            return TimelineGroupMoveTargetGhostModel(
                clip: clip,
                timelineInFrame: timelineInFrame,
                durationFrames: clip.timelineDurationFrames,
                durationText: String(format: "%.1fs", timeline.sequence.framesToSeconds(clip.timelineDurationFrames)),
                timecode: timeline.sequence.framesToTimecode(timelineInFrame),
                targetTrackID: targetTrackID,
                isLaneLifted: preview.laneLift != nil
            )
        }
        .sorted { lhs, rhs in
            if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.clip.id < rhs.clip.id }
            return lhs.timelineInFrame < rhs.timelineInFrame
        }
    }

    private var trackMoveBlockedCue: TimelineTrackMoveBlockedCueModel? {
        guard let blocked = activeBlockedMoveTarget,
              blocked.targetTrackID == track.id
        else { return nil }
        return TimelineTrackMoveBlockedCueModel(
            clipID: blocked.clipID,
            timelineInFrame: blocked.timelineInFrame,
            durationFrames: blocked.durationFrames,
            durationText: durationSecondsLabel(blocked.durationFrames),
            reason: blocked.reason
        )
    }

    private var groupMoveRangeCue: TimelineGroupMoveRangeCueModel? {
        guard activeDragClipID != nil, let preview = activeGroupMovePreview else { return nil }
        let movedSourceClips: [TimelineClip]
        if let targetTrackID = preview.targetTrackID {
            if preview.laneLift?.createsTrack == true {
                guard preview.sourceTrackID == track.id else { return nil }
            } else {
                guard targetTrackID == track.id else { return nil }
            }
            movedSourceClips = timeline.displayTracks.flatMap(\.clips).filter { preview.movedClipIDs.contains($0.id) }
        } else {
            movedSourceClips = track.clips.filter { preview.movedClipIDs.contains($0.id) }
        }
        let movedIntervals = movedSourceClips.compactMap { clip -> (start: Int, end: Int)? in
            guard let startFrame = preview.newTimelineInFrame(for: clip.id),
                  clip.timelineDurationFrames > 0
            else { return nil }
            return (startFrame, startFrame + clip.timelineDurationFrames)
        }
        guard let startFrame = movedIntervals.map({ $0.start }).min(),
              let endFrame = movedIntervals.map({ $0.end }).max(),
              endFrame > startFrame
        else { return nil }
        return TimelineGroupMoveRangeCueModel(
            trackID: track.id,
            startFrame: startFrame,
            endFrame: endFrame,
            resolvedFrameDelta: preview.resolvedFrameDelta,
            movedClipCount: movedIntervals.count,
            totalMovedClipCount: preview.movedClipIDs.count,
            targetTrackID: preview.targetTrackID,
            laneLiftCreatesTrack: preview.laneLift?.createsTrack ?? false,
            yOffset: preview.laneLift?.createsTrack == true ? liftedLaneYOffset : baseLaneYOffset,
            displacementCount: preview.displacements.count,
            snapLabel: preview.snap?.label
        )
    }

    private var clipMoveLandingCue: TimelineClipMoveLandingCueModel? {
        guard activeDragClipID != nil else { return nil }
        if let preview = activeMovePreview {
            let isCreatedLane = preview.laneLift?.createsTrack == true
            guard preview.targetTrackID == track.id || (isCreatedLane && preview.trackID == track.id) else { return nil }
            return TimelineClipMoveLandingCueModel(
                clipID: preview.targetClipID,
                timelineInFrame: preview.newTimelineInFrame,
                targetTrackID: preview.targetTrackID,
                timecode: timeline.sequence.framesToTimecode(preview.newTimelineInFrame),
                durationText: durationSecondsLabel(preview.durationFrames),
                detailText: clipMoveLandingDetail(
                    frameDelta: preview.newTimelineInFrame - preview.originalTimelineInFrame,
                    movedCount: 1,
                    targetTrackID: preview.targetTrackID,
                    laneLift: preview.laneLift,
                    displacementCount: preview.displacements.count,
                    snap: preview.snap
                ),
                iconName: clipMoveLandingIconName(for: preview),
                color: preview.laneLift == nil ? .accentColor : .teal,
                yOffset: isCreatedLane ? liftedLaneYOffset : baseLaneYOffset
            )
        }
        if let preview = activeGroupMovePreview,
           let movedClip = firstMovedGroupClipOnTrack(for: preview),
           let newTimelineInFrame = preview.newTimelineInFrame(for: movedClip.id) {
            return TimelineClipMoveLandingCueModel(
                clipID: movedClip.id,
                timelineInFrame: newTimelineInFrame,
                targetTrackID: preview.targetTrackID ?? track.id,
                timecode: timeline.sequence.framesToTimecode(newTimelineInFrame),
                durationText: groupMoveSpanDurationFrames(for: preview).map(durationSecondsLabel) ?? durationSecondsLabel(movedClip.timelineDurationFrames),
                detailText: clipMoveLandingDetail(
                    frameDelta: preview.resolvedFrameDelta,
                    movedCount: preview.movedClipIDs.count,
                    targetTrackID: preview.targetTrackID,
                    laneLift: preview.laneLift,
                    displacementCount: preview.displacements.count,
                    snap: preview.snap
                ),
                iconName: "rectangle.3.group",
                color: .purple,
                yOffset: preview.laneLift?.createsTrack == true ? liftedLaneYOffset : baseLaneYOffset
            )
        }
        return nil
    }

    private var movePreviewBadge: TimelineMovePreviewBadgeModel? {
        guard activeDragClipID != nil else { return nil }
        if let preview = activeMovePreview, preview.trackID == track.id {
            let frameDelta = preview.newTimelineInFrame - preview.originalTimelineInFrame
            return TimelineMovePreviewBadgeModel(
                anchorFrame: preview.newTimelineInFrame,
                iconName: preview.laneLift == nil ? "hand.draw" : "square.stack.3d.up",
                title: "移動 \(signedFramesLabel(frameDelta))",
                detail: movePreviewDetail(
                    frameDelta: frameDelta,
                    movedCount: 1,
                    movedDurationFrames: preview.durationFrames,
                    targetTrackID: preview.targetTrackID,
                    laneLift: preview.laneLift,
                    displacementCount: preview.displacements.count,
                    snap: preview.snap
                ),
                color: preview.laneLift == nil ? .accentColor : .teal
            )
        }
        if let preview = activeGroupMovePreview,
           shouldShowGroupMoveBadge(for: preview),
           let activeDragClipID,
           let anchorFrame = preview.newTimelineInFrame(for: activeDragClipID) {
            return TimelineMovePreviewBadgeModel(
                anchorFrame: anchorFrame,
                iconName: "rectangle.3.group",
                title: "グループ \(signedFramesLabel(preview.resolvedFrameDelta))",
                detail: movePreviewDetail(
                    frameDelta: preview.resolvedFrameDelta,
                    movedCount: preview.movedClipIDs.count,
                    movedDurationFrames: groupMoveSpanDurationFrames(for: preview),
                    targetTrackID: preview.targetTrackID,
                    laneLift: preview.laneLift,
                    displacementCount: preview.displacements.count,
                    snap: preview.snap
                ),
                color: .purple
            )
        }
        return nil
    }

    private var movePreviewBadgeYOffset: CGFloat {
        isLaneLiftPreviewActive ? liftedLaneYOffset + 3 : baseLaneYOffset + 3
    }

    private func shouldShowGroupMoveBadge(for preview: TimelineClipGroupMovePlan) -> Bool {
        if preview.laneLift?.createsTrack == true {
            return preview.sourceTrackID == track.id
        }
        if let targetTrackID = preview.targetTrackID {
            return targetTrackID == track.id
        }
        guard let activeDragClipID else { return false }
        return track.clips.contains { $0.id == activeDragClipID }
    }

    private var transitionDropTargets: [TimelineTransitionDropTargetModel] {
        guard track.kind == .video || track.kind == .overlay else { return [] }
        let sortedClips = track.clips.sorted { lhs, rhs in
            if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.id < rhs.id }
            return lhs.timelineInFrame < rhs.timelineInFrame
        }
        guard sortedClips.count > 1 else { return [] }

        return zip(sortedClips, sortedClips.dropFirst()).compactMap { left, right in
            guard left.timelineOutFrame == right.timelineInFrame else { return nil }
            return TimelineTransitionDropTargetModel(
                trackID: track.id,
                fromClipID: left.id,
                toClipID: right.id,
                boundaryFrame: left.timelineOutFrame
            )
        }
    }

    private var playheadOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(playheadFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var laneInteractionGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if isMultiSelectMode {
                    updateMarqueeSelection(startX: value.startLocation.x, currentX: value.location.x)
                } else {
                    scrubTrackLane(toX: value.location.x)
                }
            }
            .onEnded { value in
                if isMultiSelectMode {
                    finishMarqueeSelection(startX: value.startLocation.x, currentX: value.location.x)
                } else {
                    scrubTrackLane(toX: value.location.x)
                    activeLaneScrubFrame = nil
                    activeLaneScrubSnap = nil
                }
            }
    }

    private func scrubTrackLane(toX x: CGFloat) {
        let resolved = TimelinePlayheadScrubSnapResolver.resolve(
            timeline: timeline,
            proposedFrame: frame(forLaneX: x),
            thresholdFrames: magneticSnapThresholdFrames
        )
        let previousScrubFrame = activeLaneScrubFrame
        activeLaneScrubFrame = resolved.frame
        activeLaneScrubSnap = resolved.snap
        activeMovePreview = nil
        activeGroupMovePreview = nil
        activeBlockedMoveTarget = nil
        activeTrimPreview = nil
        onEndMovePreview()
        if previousScrubFrame != resolved.frame || playheadFrame != resolved.frame {
            onScrubPlayhead(resolved.frame)
        }
    }

    private func updateMarqueeSelection(startX: CGFloat, currentX: CGFloat) {
        let selection = TimelineMarqueeSelection(
            startFrame: frame(forLaneX: startX),
            endFrame: frame(forLaneX: currentX)
        )
        activeMarqueeSelection = selection
        activeLaneScrubFrame = nil
        activeLaneScrubSnap = nil
        activeMovePreview = nil
        activeGroupMovePreview = nil
        activeBlockedMoveTarget = nil
        activeTrimPreview = nil
        onEndMovePreview()
    }

    private func finishMarqueeSelection(startX: CGFloat, currentX: CGFloat) {
        let selection = TimelineMarqueeSelection(
            startFrame: frame(forLaneX: startX),
            endFrame: frame(forLaneX: currentX)
        )
        activeMarqueeSelection = nil
        activeLaneScrubFrame = nil
        activeLaneScrubSnap = nil
        guard abs(currentX - startX) >= 4 else { return }
        onSelectClipRange(track.id, selection.frameRange)
    }

    private func frame(forLaneX x: CGFloat) -> Int {
        TimelineViewportScale.timelineFrame(
            atLaneX: Double(x),
            laneWidth: Double(laneWidth),
            totalFrames: totalFrames
        )
    }

    private func handleLaneSkimHover(_ phase: HoverPhase) {
        guard canPreviewTimelineSkim else {
            onEndTimelineSkim()
            return
        }
        switch phase {
        case .active(let location):
            onPreviewTimelineSkim(frame(forLaneX: location.x), track.id, nil)
        case .ended:
            onEndTimelineSkim()
        }
    }

    private func handleClipSkimHover(_ phase: HoverPhase, clip: TimelineClip, clipWidth: CGFloat) {
        guard canPreviewTimelineSkim else {
            onEndTimelineSkim()
            return
        }
        switch phase {
        case .active(let location):
            let frame = TimelineViewportScale.timelineFrame(
                atClipLocalX: Double(location.x),
                clipStartFrame: clip.timelineInFrame,
                clipDurationFrames: clip.timelineDurationFrames,
                clipWidth: Double(clipWidth)
            )
            onPreviewTimelineSkim(frame, track.id, clip.id)
        case .ended:
            onEndTimelineSkim()
        }
    }

    private func laneScrubBadgeOffset(for frame: Int, hasSnap: Bool) -> CGFloat {
        let badgeWidth = TimelineLaneScrubBadge.badgeWidth(hasSnap: hasSnap)
        let centeredX = boundaryOffset(frame) - badgeWidth / 2
        return max(4, min(centeredX, max(4, laneWidth - badgeWidth - 4)))
    }

    private var laneInteractionHelpText: String {
        if isMultiSelectMode {
            if let activeMarqueeSelection {
                return "\(timeline.sequence.framesToTimecode(activeMarqueeSelection.lowerFrame))-\(timeline.sequence.framesToTimecode(activeMarqueeSelection.upperFrame))"
            }
            return "空レーンをドラッグして範囲選択"
        }
        let timecode = timeline.sequence.framesToTimecode(activeLaneScrubFrame ?? playheadFrame)
        guard let activeLaneScrubSnap else { return timecode }
        return "\(timecode) / 吸着: \(activeLaneScrubSnap.label)"
    }

    private func transition(for target: TimelineTransitionDropTargetModel) -> TimelineTransition? {
        transitions.first {
            $0.trackID == target.trackID
                && $0.fromClipID == target.fromClipID
                && $0.toClipID == target.toClipID
                && $0.isVisibleTimelineTransition
        }
    }

    private func transitionTargetWidth(_ transition: TimelineTransition?) -> CGFloat {
        guard let frames = transition?.transitionFrames, frames > 0 else { return 72 }
        return max(24, CGFloat(frames) * laneWidth / CGFloat(max(totalFrames, 1)))
    }

    private func transitionHitAreaWidth(_ transition: TimelineTransition?) -> CGFloat {
        let targetWidth = transitionTargetWidth(transition)
        guard transition != nil else { return max(112, targetWidth) }
        return max(72, targetWidth + 32)
    }

    private func boundaryOffset(_ frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private func clipOffset(_ clip: TimelineClip) -> CGFloat {
        laneWidth * CGFloat(clip.timelineInFrame) / CGFloat(max(totalFrames, 1))
    }

    private func clipWidth(_ clip: TimelineClip) -> CGFloat {
        max(44, laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func displayedClipOffset(_ clip: TimelineClip) -> CGFloat {
        if let preview = activeTrimPreview, preview.targetClipID == clip.id {
            return boundaryOffset(preview.newTimelineInFrame)
        }
        return clipOffset(clip) + dragPreviewOffset(for: clip)
    }

    private func displayedClipWidth(_ clip: TimelineClip) -> CGFloat {
        if let preview = activeTrimPreview, preview.targetClipID == clip.id {
            return max(44, laneWidth * CGFloat(preview.newDurationFrames) / CGFloat(max(totalFrames, 1)))
        }
        return clipWidth(clip)
    }

    private func bladeSplitFrame(for clip: TimelineClip, localX: CGFloat, clipWidth: CGFloat) -> Int {
        let clampedX = max(0, min(localX, max(clipWidth, 1)))
        let fraction = clampedX / max(clipWidth, 1)
        let offsetFrames = Int((fraction * CGFloat(max(clip.timelineDurationFrames, 1))).rounded())
        let rawFrame = clip.timelineInFrame + offsetFrames
        return max(clip.timelineInFrame + 1, min(rawFrame, clip.timelineOutFrame - 1))
    }

    private func sourceDropGhostWidth(_ preview: TimelineSourceCandidateDropPreview) -> CGFloat {
        max(54, laneWidth * CGFloat(preview.durationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func rawClipWidth(_ clip: TimelineClip) -> CGFloat {
        laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1))
    }

    private func dragPreviewOffset(for clip: TimelineClip) -> CGFloat {
        if let preview = activeMovePreview,
           preview.trackID == track.id,
           preview.targetClipID == clip.id,
           preview.laneLift == nil,
           preview.targetTrackID != track.id {
            return 0
        }
        if let preview = activeGroupMovePreview,
           let targetTrackID = preview.targetTrackID,
           targetTrackID != track.id,
           preview.movedClipIDs.contains(clip.id) {
            return 0
        }
        if let frameOffset = movePreviewFrameOffset(for: clip) {
            return CGFloat(frameOffset) * laneWidth / CGFloat(max(totalFrames, 1))
        }
        return activeDragClipID == clip.id ? activeDragTranslation : 0
    }

    private func clipLaneYOffset(for clip: TimelineClip) -> CGFloat {
        guard let preview = activeMovePreview,
              preview.trackID == track.id,
              preview.laneLift?.createsTrack == true
        else {
            return baseLaneYOffset
        }
        return preview.targetClipID == clip.id ? liftedLaneYOffset : baseLaneYOffset
    }

    private func clipOpacity(for clip: TimelineClip) -> Double {
        if let preview = activeGroupMovePreview,
           let targetTrackID = preview.targetTrackID,
           targetTrackID != track.id,
           preview.movedClipIDs.contains(clip.id) {
            return 0.28
        }
        guard let preview = activeMovePreview,
              preview.trackID == track.id,
              preview.targetClipID == clip.id
        else { return 1 }
        if let laneLift = preview.laneLift {
            return laneLift.createsTrack ? 1 : 0.28
        }
        if preview.targetTrackID != track.id {
            return 0.28
        }
        return 1
    }

    private func laneLiftTargetGhostWidth(for ghost: TimelineLaneLiftTargetGhostModel) -> CGFloat {
        max(44, laneWidth * CGFloat(ghost.durationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func trackMoveTargetGhostWidth(for ghost: TimelineTrackMoveTargetGhostModel) -> CGFloat {
        max(44, laneWidth * CGFloat(ghost.durationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func groupMoveTargetGhostWidth(for ghost: TimelineGroupMoveTargetGhostModel) -> CGFloat {
        max(44, laneWidth * CGFloat(ghost.durationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func trackMoveBlockedCueWidth(for blocked: TimelineTrackMoveBlockedCueModel) -> CGFloat {
        max(142, laneWidth * CGFloat(blocked.durationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func groupBlockedCueDurationFrames(anchorClip: TimelineClip) -> Int {
        let intervals = track.clips.compactMap { clip -> (start: Int, end: Int)? in
            guard selectedClipIDs.contains(clip.id), clip.timelineDurationFrames > 0 else { return nil }
            return (clip.timelineInFrame, clip.timelineOutFrame)
        }
        guard let startFrame = intervals.map(\.start).min(),
              let endFrame = intervals.map(\.end).max(),
              endFrame > startFrame
        else { return anchorClip.timelineDurationFrames }
        return endFrame - startFrame
    }

    private func clipMoveLandingIconName(for preview: TimelineClipMovePlan) -> String {
        if preview.laneLift != nil { return "square.stack.3d.up" }
        if preview.targetTrackID != preview.trackID { return "arrow.up.and.down" }
        return "arrow.down.to.line"
    }

    private func firstMovedGroupClipOnTrack(for preview: TimelineClipGroupMovePlan) -> TimelineClip? {
        if preview.laneLift?.createsTrack == true {
            guard preview.sourceTrackID == track.id else { return nil }
            return timeline.displayTracks
                .flatMap(\.clips)
                .sorted { lhs, rhs in
                    if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.id < rhs.id }
                    return lhs.timelineInFrame < rhs.timelineInFrame
                }
                .first { preview.movedClipIDs.contains($0.id) }
        }
        if let targetTrackID = preview.targetTrackID {
            guard targetTrackID == track.id else { return nil }
            return timeline.displayTracks
                .flatMap(\.clips)
                .sorted { lhs, rhs in
                    if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.id < rhs.id }
                    return lhs.timelineInFrame < rhs.timelineInFrame
                }
                .first { preview.movedClipIDs.contains($0.id) }
        }
        return track.clips
            .sorted { lhs, rhs in
                if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.id < rhs.id }
                return lhs.timelineInFrame < rhs.timelineInFrame
            }
            .first { preview.movedClipIDs.contains($0.id) }
    }

    private func clip(for clipID: TimelineClip.ID) -> TimelineClip? {
        for displayTrack in timeline.displayTracks {
            if let clip = displayTrack.clips.first(where: { $0.id == clipID }) {
                return clip
            }
        }
        return nil
    }

    private func sourceOverwriteImpact(for clip: TimelineClip) -> TimelineSourceOverwriteImpact? {
        guard let preview = activeSourceOverwritePreview else { return nil }
        if preview.removedClipIDs.contains(clip.id) { return .remove }
        if preview.splitClipIDs.contains(clip.id) { return .split }
        if preview.trimmedClipIDs.contains(clip.id) { return .trim }
        return nil
    }

    private func laneLiftAvoidanceTargetID(for clip: TimelineClip) -> TimelineTrack.ID? {
        if let laneLift = activeMovePreview?.laneLift,
           laneLift.overlappedClipIDs.contains(clip.id) {
            return laneLift.targetTrackID
        }
        if let laneLift = activeGroupMovePreview?.laneLift,
           laneLift.overlappedClipIDs.contains(clip.id) {
            return laneLift.targetTrackID
        }
        return nil
    }

    private func clipMoveDragGesture(for clip: TimelineClip, clipWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                guard isClipBodyDrag(startX: value.startLocation.x, clipWidth: clipWidth) else { return }
                if activeDragClipID != clip.id {
                    onBeginClipBodyDrag(clip.id)
                }
                activeDragClipID = clip.id
                activeDragTranslation = value.translation.width
                activeRollPreview = nil
                activeSlipPreview = nil
                onEndRollTrimPreview()
                onEndSlipTrimPreview()
                let delta = frameDelta(forDragTranslation: value.translation.width)
                if shouldPreviewSelectedGroupMove(for: clip) {
                    let targetTrack = explicitMoveTargetTrack(forVerticalTranslation: value.translation.height)
                    let targetTrackID = compatibleMoveTargetTrackID(targetTrack)
                    let preview = makeGroupMovePreview(for: clip, frameDelta: delta, targetTrackID: targetTrackID)
                    activeMovePreview = nil
                    activeBlockedMoveTarget = makeBlockedGroupMoveTarget(
                        for: clip,
                        frameDelta: delta,
                        targetTrack: targetTrack,
                        preview: preview
                    )
                    activeGroupMovePreview = preview
                    if let preview {
                        activeDragRevealFrame = preview.newTimelineInFrame(for: preview.targetClipID)
                    } else {
                        activeDragRevealFrame = nil
                    }
                    if preview != nil {
                        onPreviewMove(clip.id, delta, magneticSnapThresholdFrames, targetTrackID)
                    } else {
                        onEndMovePreview()
                    }
                } else {
                    let targetTrack = explicitMoveTargetTrack(forVerticalTranslation: value.translation.height)
                    let targetTrackID = compatibleMoveTargetTrackID(targetTrack)
                    let preview = makeMovePreview(for: clip, frameDelta: delta, targetTrackID: targetTrackID)
                    activeMovePreview = preview
                    activeBlockedMoveTarget = makeBlockedMoveTarget(
                        for: clip,
                        frameDelta: delta,
                        targetTrack: targetTrack,
                        preview: preview
                    )
                    activeGroupMovePreview = nil
                    activeDragRevealFrame = preview?.newTimelineInFrame
                    if preview != nil {
                        onPreviewMove(clip.id, delta, magneticSnapThresholdFrames, targetTrackID)
                    } else {
                        onEndMovePreview()
                    }
                }
            }
            .onEnded { value in
                defer {
                    activeDragClipID = nil
                    activeDragTranslation = 0
                    activeMovePreview = nil
                    activeGroupMovePreview = nil
                    activeBlockedMoveTarget = nil
                    activeDragRevealFrame = nil
                    activeRollPreview = nil
                    activeSlipPreview = nil
                    onEndMovePreview()
                    onEndRollTrimPreview()
                    onEndSlipTrimPreview()
                }
                guard isClipBodyDrag(startX: value.startLocation.x, clipWidth: clipWidth) else { return }
                let delta = frameDelta(forDragTranslation: value.translation.width)
                let targetTrackID = shouldPreviewSelectedGroupMove(for: clip)
                    ? compatibleMoveTargetTrackID(explicitMoveTargetTrack(forVerticalTranslation: value.translation.height))
                    : compatibleMoveTargetTrackID(explicitMoveTargetTrack(forVerticalTranslation: value.translation.height))
                guard delta != 0 || targetTrackID != nil else { return }
                onDragMove(clip.id, delta, magneticSnapThresholdFrames, targetTrackID)
            }
    }

    private func isClipBodyDrag(startX: CGFloat, clipWidth: CGFloat) -> Bool {
        let guardWidth = min(20, max(8, clipWidth * 0.22))
        return startX > guardWidth && startX < clipWidth - guardWidth
    }

    private func frameDelta(forDragTranslation translation: CGFloat) -> Int {
        Int(((translation / max(laneWidth, 1)) * CGFloat(max(totalFrames, 1))).rounded())
    }

    private var magneticSnapThresholdFrames: Int {
        guard isSnappingEnabled else { return 0 }
        return max(1, Int(((12 / max(laneWidth, 1)) * CGFloat(max(totalFrames, 1))).rounded()))
    }

    private var trackDragRowStride: CGFloat {
        38
    }

    private func explicitMoveTargetTrack(forVerticalTranslation translation: CGFloat) -> TimelineTrack? {
        guard abs(translation) >= trackDragRowStride * 0.55 else { return nil }
        let step = Int((translation / trackDragRowStride).rounded())
        guard step != 0,
              let sourceIndex = timeline.displayTracks.firstIndex(where: { $0.id == track.id })
        else { return nil }
        let targetIndex = max(0, min(timeline.displayTracks.count - 1, sourceIndex + step))
        let candidate = timeline.displayTracks[targetIndex]
        guard candidate.id != track.id else { return nil }
        return candidate
    }

    private func compatibleMoveTargetTrackID(_ candidate: TimelineTrack?) -> TimelineTrack.ID? {
        guard let candidate, candidate.kind == track.kind else { return nil }
        return candidate.id
    }

    private func makeBlockedMoveTarget(
        for clip: TimelineClip,
        frameDelta: Int,
        targetTrack: TimelineTrack?,
        preview: TimelineClipMovePlan?
    ) -> TimelineTrackMoveBlockedTarget? {
        guard let targetTrack, preview == nil else { return nil }
        let reason = targetTrack.kind == track.kind
            ? "重なりで不可"
            : "\(localizedTrackKind(targetTrack.kind))は不可"
        return TimelineTrackMoveBlockedTarget(
            clipID: clip.id,
            sourceTrackID: track.id,
            targetTrackID: targetTrack.id,
            timelineInFrame: max(0, clip.timelineInFrame + frameDelta),
            durationFrames: clip.timelineDurationFrames,
            reason: reason
        )
    }

    private func makeBlockedGroupMoveTarget(
        for clip: TimelineClip,
        frameDelta: Int,
        targetTrack: TimelineTrack?,
        preview: TimelineClipGroupMovePlan?
    ) -> TimelineTrackMoveBlockedTarget? {
        guard let targetTrack, preview == nil else { return nil }
        let selectedClipCountOnSourceTrack = track.clips.filter { selectedClipIDs.contains($0.id) }.count
        let reason: String
        if targetTrack.kind != track.kind {
            reason = "\(localizedTrackKind(targetTrack.kind))は不可"
        } else if selectedClipCountOnSourceTrack != selectedClipIDs.count {
            reason = "複数trackは不可"
        } else {
            reason = "重なりで不可"
        }
        return TimelineTrackMoveBlockedTarget(
            clipID: clip.id,
            sourceTrackID: track.id,
            targetTrackID: targetTrack.id,
            timelineInFrame: max(0, clip.timelineInFrame + frameDelta),
            durationFrames: groupBlockedCueDurationFrames(anchorClip: clip),
            reason: reason
        )
    }

    private func isClipWidthExpanded(_ clip: TimelineClip) -> Bool {
        rawClipWidth(clip) < 44
    }

    private func canShowTrimHandles(for clip: TimelineClip) -> Bool {
        isSelected(clip)
            && selectedClipIDs.count <= 1
            && canShowTrimAffordance(for: clip)
    }

    private func canShowSlipHandle(for clip: TimelineClip) -> Bool {
        isSelected(clip)
            && selectedClipIDs.count <= 1
            && canShowTrimAffordance(for: clip)
            && clip.sourceInUS != nil
            && clip.sourceOutUS != nil
    }

    private func canShowRollHandle(for clip: TimelineClip, boundary: TimelineRollTrimBoundary) -> Bool {
        isSelected(clip)
            && selectedClipIDs.count <= 1
            && !feedbackSession.hasPendingRemove(for: clip.id)
            && (makeRollPreview(for: clip, boundary: boundary, frameDelta: -1) != nil
                || makeRollPreview(for: clip, boundary: boundary, frameDelta: 1) != nil)
    }

    private func canShowTrimAffordance(for clip: TimelineClip) -> Bool {
        clip.sourceDurationSeconds != nil
            && clip.timelineDurationFrames > 1
            && !feedbackSession.hasPendingRemove(for: clip.id)
    }

    private func makeMovePreview(
        for clip: TimelineClip,
        frameDelta: Int,
        targetTrackID: TimelineTrack.ID? = nil
    ) -> TimelineClipMovePlan? {
        guard frameDelta != 0 || targetTrackID != nil else { return nil }
        return TimelineClipMovePlan.make(
            timeline: timeline,
            selection: TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip),
            frameDelta: frameDelta,
            snapThresholdFrames: magneticSnapThresholdFrames,
            playheadFrame: playheadFrame,
            reason: "Studio timeline magnetic drag preview",
            preferredTargetTrackID: targetTrackID
        )
    }

    private func makeTrimPreview(
        for clip: TimelineClip,
        edge: TimelinePlayheadTrimEdge,
        frameDelta: Int
    ) -> TimelineDragTrimPlan? {
        guard frameDelta != 0 else { return nil }
        let targetBoundaryFrame: Int
        switch edge {
        case .start:
            targetBoundaryFrame = clip.timelineInFrame + frameDelta
        case .end:
            targetBoundaryFrame = clip.timelineOutFrame + frameDelta
        }
        return TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip),
            targetBoundaryFrame: targetBoundaryFrame,
            edge: edge,
            snapThresholdFrames: magneticSnapThresholdFrames,
            playheadFrame: playheadFrame,
            assetDurationUS: assetDurationsUSByID[clip.assetID],
            reason: "Studio timeline drag trim preview"
        )
    }

    private func makeRollPreview(
        for clip: TimelineClip,
        boundary: TimelineRollTrimBoundary,
        frameDelta: Int
    ) -> TimelineRollTrimPlan? {
        guard frameDelta != 0 else { return nil }
        let direction: TimelineRollTrimDirection = frameDelta < 0 ? .left : .right
        return TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip),
            boundary: boundary,
            direction: direction,
            deltaFrames: abs(frameDelta),
            assetDurationsUSByID: assetDurationsUSByID,
            reason: "Studio timeline drag roll preview"
        )
    }

    private func makeSlipPreview(
        for clip: TimelineClip,
        frameDelta: Int
    ) -> TimelineSlipTrimPlan? {
        guard frameDelta != 0 else { return nil }
        let direction: TimelineSlipTrimDirection = frameDelta < 0 ? .left : .right
        return TimelineSlipTrimPlan.make(
            selection: TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip),
            direction: direction,
            deltaFrames: abs(frameDelta),
            assetDurationUS: assetDurationsUSByID[clip.assetID],
            reason: "Studio timeline drag slip preview"
        )
    }

    private func trimPreviewBadgeOffset(for plan: TimelineDragTrimPlan) -> CGFloat {
        let badgeWidth: CGFloat = 116
        let boundaryX = boundaryOffset(plan.targetBoundaryFrame)
        let preferredX = plan.edge == .start ? boundaryX + 8 : boundaryX - badgeWidth - 8
        return max(4, min(laneWidth - badgeWidth - 4, preferredX))
    }

    private func movePreviewBadgeOffset(for frame: Int) -> CGFloat {
        let badgeWidth: CGFloat = 164
        let preferredX = boundaryOffset(frame) + 8
        return max(4, min(laneWidth - badgeWidth - 4, preferredX))
    }

    private func movePreviewDetail(
        frameDelta: Int,
        movedCount: Int,
        movedDurationFrames: Int?,
        targetTrackID: TimelineTrack.ID?,
        laneLift: TimelineClipMoveLaneLift?,
        displacementCount: Int,
        snap: TimelineClipMoveSnap?
    ) -> String {
        var parts = [signedSecondsLabel(frameDelta)]
        if let movedDurationFrames, movedDurationFrames > 0 {
            parts.append("尺\(durationSecondsLabel(movedDurationFrames))")
        }
        if movedCount > 1 {
            parts.append("\(movedCount) clips")
        }
        if let laneLift {
            parts.append(laneLift.createsTrack ? "→\(laneLift.targetTrackID) 新規" : "→\(laneLift.targetTrackID)")
        } else if let targetTrackID, targetTrackID != track.id {
            parts.append("→\(targetTrackID)")
        }
        if displacementCount > 0 {
            parts.append("押し出し \(displacementCount)")
        }
        if let snap {
            parts.append("吸着 \(snap.label)")
        }
        return parts.joined(separator: " / ")
    }

    private func clipMoveLandingDetail(
        frameDelta: Int,
        movedCount: Int,
        targetTrackID: TimelineTrack.ID?,
        laneLift: TimelineClipMoveLaneLift?,
        displacementCount: Int,
        snap: TimelineClipMoveSnap?
    ) -> String {
        var parts = [signedSecondsLabel(frameDelta)]
        if movedCount > 1 {
            parts.append("\(movedCount) clips")
        }
        if let laneLift {
            parts.append(laneLift.createsTrack ? "→\(laneLift.targetTrackID) 新規" : "→\(laneLift.targetTrackID)")
        } else if let targetTrackID, targetTrackID != track.id {
            parts.append("→\(targetTrackID)")
        }
        if displacementCount > 0 {
            parts.append("押\(displacementCount)")
        }
        if let snap {
            parts.append("吸着 \(snap.label)")
        }
        return parts.joined(separator: " / ")
    }

    private func groupMoveSpanDurationFrames(for preview: TimelineClipGroupMovePlan) -> Int? {
        let movedIntervals = timeline.displayTracks
            .flatMap(\.clips)
            .filter { preview.movedClipIDs.contains($0.id) }
            .compactMap { clip -> (start: Int, end: Int)? in
                guard let startFrame = preview.newTimelineInFrame(for: clip.id),
                      clip.timelineDurationFrames > 0
                else { return nil }
                return (startFrame, startFrame + clip.timelineDurationFrames)
            }
        guard let startFrame = movedIntervals.map(\.start).min(),
              let endFrame = movedIntervals.map(\.end).max(),
              endFrame > startFrame
        else {
            return nil
        }
        return endFrame - startFrame
    }

    private func signedFramesLabel(_ frames: Int) -> String {
        frames > 0 ? "+\(frames)f" : "\(frames)f"
    }

    private func signedSecondsLabel(_ frames: Int) -> String {
        let sign = frames > 0 ? "+" : (frames < 0 ? "-" : "")
        let seconds = timeline.sequence.framesToSeconds(abs(frames))
        return String(format: "%@%.1fs", sign, seconds)
    }

    private func durationSecondsLabel(_ frames: Int) -> String {
        String(format: "%.1fs", timeline.sequence.framesToSeconds(max(0, frames)))
    }

    private func clipTimingMetadataLabel(for clip: TimelineClip) -> String? {
        let rawWidth = rawClipWidth(clip)
        guard rawWidth >= 86 else { return nil }
        var parts = [durationSecondsLabel(clip.timelineDurationFrames)]
        if rawWidth >= 150,
           let sourceInUS = clip.sourceInUS,
           let sourceOutUS = clip.sourceOutUS,
           sourceOutUS > sourceInUS {
            parts.append("src \(sourceClockLabel(sourceInUS))-\(sourceClockLabel(sourceOutUS))")
        }
        return parts.joined(separator: " · ")
    }

    private func sourceClockLabel(_ microseconds: Int) -> String {
        let seconds = Double(max(0, microseconds)) / 1_000_000
        guard seconds >= 60 else { return String(format: "%.1fs", seconds) }
        let minutes = Int(seconds / 60)
        let remainingSeconds = seconds - Double(minutes * 60)
        return String(format: "%d:%04.1f", minutes, remainingSeconds)
    }

    private func makeGroupMovePreview(
        for clip: TimelineClip,
        frameDelta: Int,
        targetTrackID: TimelineTrack.ID? = nil
    ) -> TimelineClipGroupMovePlan? {
        guard frameDelta != 0 || targetTrackID != nil else { return nil }
        return TimelineClipGroupMovePlan.make(
            timeline: timeline,
            anchorSelection: TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip),
            selectedClipIDs: selectedClipIDs,
            frameDelta: frameDelta,
            snapThresholdFrames: magneticSnapThresholdFrames,
            playheadFrame: playheadFrame,
            reason: "Studio timeline magnetic group drag preview",
            preferredTargetTrackID: targetTrackID
        )
    }

    private func shouldPreviewSelectedGroupMove(for clip: TimelineClip) -> Bool {
        selectedClipIDs.contains(clip.id) && selectedClipIDs.count > 1
    }

    private func movePreviewFrameOffset(for clip: TimelineClip) -> Int? {
        if let preview = activeGroupMovePreview {
            if let targetTrackID = preview.targetTrackID,
               targetTrackID != track.id,
               preview.movedClipIDs.contains(clip.id) {
                return nil
            }
            if let newTimelineInFrame = preview.newTimelineInFrame(for: clip.id) {
                return newTimelineInFrame - clip.timelineInFrame
            }
            if let displacement = preview.displacements.first(where: { $0.clipID == clip.id }) {
                return displacement.newTimelineInFrame - clip.timelineInFrame
            }
        }
        guard let preview = activeMovePreview else { return nil }
        if preview.targetClipID == clip.id {
            guard preview.laneLift != nil || preview.targetTrackID == track.id else { return nil }
            return preview.newTimelineInFrame - clip.timelineInFrame
        }
        if let displacement = preview.displacements.first(where: { $0.clipID == clip.id }) {
            return displacement.newTimelineInFrame - clip.timelineInFrame
        }
        return nil
    }

    private func movePreviewRole(for clip: TimelineClip) -> TimelineClipMovePreviewRole {
        if let preview = activeGroupMovePreview {
            if preview.movedClipIDs.contains(clip.id) {
                if let targetTrackID = preview.targetTrackID, targetTrackID != track.id {
                    return .liftedTarget
                }
                return .target
            }
            if preview.displacements.contains(where: { $0.clipID == clip.id }) {
                return .displaced
            }
            return .none
        }
        guard let preview = activeMovePreview else { return .none }
        if preview.targetClipID == clip.id {
            if preview.targetTrackID != track.id {
                return .liftedTarget
            }
            return preview.laneLift == nil ? .target : .liftedTarget
        }
        if preview.displacements.contains(where: { $0.clipID == clip.id }) {
            return .displaced
        }
        return .none
    }

    private func zIndex(for clip: TimelineClip) -> Double {
        if activeGroupMovePreview?.movedClipIDs.contains(clip.id) == true { return 22 }
        if activeGroupMovePreview?.displacements.contains(where: { $0.clipID == clip.id }) == true { return 12 }
        if activeMovePreview?.targetClipID == clip.id { return 22 }
        if activeMovePreview?.displacements.contains(where: { $0.clipID == clip.id }) == true { return 12 }
        if isSelected(clip) { return 10 }
        if activeViewerClipIDs.contains(clip.id) { return 9 }
        if clip.containsTimelineFrame(playheadFrame) { return 8 }
        if isClipWidthExpanded(clip) { return 4 }
        return 1
    }

    private var activeViewerClipIDs: Set<TimelineClip.ID> {
        var ids = Set<TimelineClip.ID>()
        if let visualClipID = timeline.visualProgramSelection(atFrame: playheadFrame)?.clip.id {
            ids.insert(visualClipID)
        }
        if let audioClipID = timeline.audioProgramSelection(atFrame: playheadFrame)?.clip.id {
            ids.insert(audioClipID)
        }
        return ids
    }

    private var isExtendingSelectionClick: Bool {
        let flags = NSEvent.modifierFlags
        return flags.contains(.command) || flags.contains(.shift)
    }

    private func isSelected(_ clip: TimelineClip) -> Bool {
        selectedClipIDs.contains(clip.id) || selectedClipID == clip.id
    }

    private func accessibilityLabel(for clip: TimelineClip) -> String {
        "\(track.id) \(localizedClipRole(clip.role)) \(clip.segmentID)"
    }

    private func accessibilityValue(for clip: TimelineClip) -> String {
        var values = [isSelected(clip) ? "選択中" : "未選択"]
        if activeViewerClipIDs.contains(clip.id) {
            values.append("Viewer参照中")
        } else if clip.containsTimelineFrame(playheadFrame) {
            values.append("再生位置下")
        }
        values.append(isBladeModeEnabled ? "ブレードでクリック位置を分割できます" : "クリップ本体をドラッグできます")
        if activeDragClipID == clip.id {
            values.append("ドラッグ中")
        }
        if let avoidTargetTrackID = laneLiftAvoidanceTargetID(for: clip) {
            values.append("重なり回避対象。移動クリップは\(avoidTargetTrackID)へ逃がします")
        }
        if let preview = activeMovePreview, preview.targetClipID == clip.id {
            values.append("着地点 \(preview.targetTrackID) \(timeline.sequence.framesToTimecode(preview.newTimelineInFrame))")
        }
        if let preview = activeGroupMovePreview,
           preview.movedClipIDs.contains(clip.id),
           let newTimelineInFrame = preview.newTimelineInFrame(for: clip.id) {
            values.append("グループ移動着地点 \(timeline.sequence.framesToTimecode(newTimelineInFrame))")
        }
        if let preview = activeGroupMovePreview,
           let displacement = preview.displacements.first(where: { $0.clipID == clip.id }) {
            values.append("グループ移動で押し出し \(timeline.sequence.framesToTimecode(displacement.newTimelineInFrame))")
        }
        if canShowTrimHandles(for: clip) {
            values.append("端をドラッグしてトリムできます")
        } else if canShowTrimAffordance(for: clip) {
            values.append("選択すると端をドラッグしてトリムできます")
        }
        values.append("長さ \(durationSecondsLabel(clip.timelineDurationFrames))")
        if let sourceInUS = clip.sourceInUS,
           let sourceOutUS = clip.sourceOutUS,
           sourceOutUS > sourceInUS {
            values.append("素材範囲 \(sourceClockLabel(sourceInUS))-\(sourceClockLabel(sourceOutUS))")
        }
        return values.joined(separator: "、")
    }

    private func feedbackState(for clip: TimelineClip) -> TimelineClipFeedbackState {
        TimelineClipFeedbackState(
            isApproved: feedbackSession.approvedClipIDs.contains(clip.id),
            isRejected: feedbackSession.rejectedClipIDs.contains(clip.id),
            isPendingSwap: feedbackSession.hasPendingSwap(for: clip.id),
            isPendingTrim: feedbackSession.hasPendingTrim(for: clip.id),
            isPendingMove: feedbackSession.hasPendingMove(for: clip.id),
            isPendingSplit: feedbackSession.hasPendingSplit(for: clip.id),
            isPendingRemove: feedbackSession.hasPendingRemove(for: clip.id),
            isRecentlyChanged: recentlyChangedClipIDs.contains(clip.id)
        )
    }
}

private struct TimelineTransitionDropTargetModel: Identifiable, Equatable {
    let trackID: TimelineTrack.ID
    let fromClipID: TimelineClip.ID
    let toClipID: TimelineClip.ID
    let boundaryFrame: Int

    var id: String {
        "\(trackID)-\(fromClipID)-\(toClipID)"
    }

    var transitionID: TimelineTransition.ID {
        TimelineTransition.stableID(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID)
    }
}

private struct TimelineSnapIndicator: View {
    var snap: TimelineClipMoveSnap
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat = 32

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.accentColor.opacity(0.86))
                .frame(width: 2, height: height)
                .shadow(color: Color.accentColor.opacity(0.36), radius: 3)
            Image(systemName: iconName)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 15, height: 15)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle().stroke(Color.accentColor.opacity(0.7), lineWidth: 1)
                }
                .offset(x: -6, y: -8)
        }
        .offset(x: snapOffset)
        .help("吸着: \(snap.label)")
        .accessibilityLabel("吸着先 \(snap.label)")
        .accessibilityIdentifier("Timeline.MagneticSnapIndicator")
    }

    private var snapOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(snap.frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var iconName: String {
        switch snap.kind {
        case .editPoint: return "arrow.left.and.line.vertical.and.arrow.right"
        case .playhead: return "playpause"
        case .marker: return "mappin"
        case .timelineStart: return "backward.end"
        }
    }
}

private struct TimelineSourceDropSnapIndicator: View {
    var snap: TimelineSourceInsertSnap
    var color: Color
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat = 32

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(color.opacity(0.82))
                .frame(width: 2, height: height)
                .shadow(color: color.opacity(0.30), radius: 3)
            Image(systemName: iconName)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 15, height: 15)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle().stroke(color.opacity(0.68), lineWidth: 1)
                }
                .offset(x: -6, y: -8)
        }
        .offset(x: snapOffset)
        .help("ソース追加の吸着: \(snap.label)")
        .accessibilityLabel("ソース追加の吸着先 \(snap.label)")
        .accessibilityIdentifier("Timeline.SourceDropMagneticSnapIndicator")
    }

    private var snapOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(snap.frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var iconName: String {
        switch snap.kind {
        case .editPoint: return "arrow.left.and.line.vertical.and.arrow.right"
        case .playhead: return "playpause"
        case .marker: return "mappin"
        case .timelineStart: return "backward.end"
        }
    }
}

private struct TimelineTrimBoundaryIndicator: View {
    var plan: TimelineDragTrimPlan
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat = 32

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.orange.opacity(0.88))
                .frame(width: 2, height: height)
                .shadow(color: Color.orange.opacity(0.32), radius: 3)
            Image(systemName: edgeIconName)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.orange)
                .frame(width: 15, height: 15)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle().stroke(Color.orange.opacity(0.72), lineWidth: 1)
                }
                .offset(x: -6, y: height - 14)
        }
        .offset(x: boundaryOffset)
        .help("トリム境界: \(plan.targetBoundaryFrame)f")
        .accessibilityLabel("トリム境界 \(plan.targetBoundaryFrame) フレーム")
        .accessibilityIdentifier("Timeline.TrimBoundaryIndicator")
    }

    private var boundaryOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(plan.targetBoundaryFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var edgeIconName: String {
        switch (plan.edge, plan.isExtension) {
        case (.start, true): return "arrow.left.to.line"
        case (.start, false): return "arrow.right.to.line"
        case (.end, true): return "arrow.right.to.line"
        case (.end, false): return "arrow.left.to.line"
        }
    }
}

private struct TimelineTrimPreviewBadge: View {
    var plan: TimelineDragTrimPlan
    var sequence: TimelineSequence

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "scissors")
                .font(.system(size: 9, weight: .bold))
            Text(edgeLabel)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
            Text(framesLabel)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
            Text(secondsLabel)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
            if plan.snap != nil {
                Image(systemName: "magnet")
                    .font(.system(size: 8, weight: .bold))
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 6)
        .frame(width: 116, height: 18, alignment: .leading)
        .foregroundStyle(Color.orange)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.orange.opacity(0.68), lineWidth: 1)
        }
        .shadow(color: Color.orange.opacity(0.20), radius: 3, y: 1)
        .help(helpText)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.TrimPreviewBadge")
    }

    private var edgeLabel: String {
        plan.edge == .start ? "IN" : "OUT"
    }

    private var secondsLabel: String {
        String(format: "%.1fs", sequence.framesToSeconds(plan.changedFrames))
    }

    private var framesLabel: String {
        plan.isExtension ? "+\(plan.addedFrames)f" : "-\(plan.removedFrames)f"
    }

    private var helpText: String {
        let action = plan.isExtension ? "伸ばします" : "詰めます"
        if let snap = plan.snap {
            return "\(edgeLabel) を \(plan.changedFrames) フレーム\(action)。\(snap.label)に吸着。"
        }
        return "\(edgeLabel) を \(plan.changedFrames) フレーム\(action)。"
    }
}

private struct TimelineMovePreviewBadgeModel {
    let anchorFrame: Int
    let iconName: String
    let title: String
    let detail: String
    let color: Color
}

private struct TimelineMovePreviewBadge: View {
    var model: TimelineMovePreviewBadgeModel

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: model.iconName)
                .font(.system(size: 9, weight: .bold))
            VStack(alignment: .leading, spacing: 0) {
                Text(model.title)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                Text(model.detail)
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .frame(width: 164, height: 24, alignment: .leading)
        .foregroundStyle(model.color)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(model.color.opacity(0.65), lineWidth: 1)
        }
        .shadow(color: model.color.opacity(0.22), radius: 4, y: 1)
        .help("\(model.title) / \(model.detail)")
        .accessibilityLabel("\(model.title) \(model.detail)")
        .accessibilityIdentifier("Timeline.MovePreviewBadge")
    }
}

private struct TimelineGroupMoveRangeCueModel {
    let trackID: TimelineTrack.ID
    let startFrame: Int
    let endFrame: Int
    let resolvedFrameDelta: Int
    let movedClipCount: Int
    let totalMovedClipCount: Int
    let targetTrackID: TimelineTrack.ID?
    let laneLiftCreatesTrack: Bool
    let yOffset: CGFloat
    let displacementCount: Int
    let snapLabel: String?
}

private struct TimelineGroupMoveRangeCue: View {
    var model: TimelineGroupMoveRangeCueModel
    var sequence: TimelineSequence
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.purple.opacity(0.12))
                .overlay {
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(
                            Color.purple.opacity(0.72),
                            style: StrokeStyle(lineWidth: 1.2, dash: [7, 4])
                        )
                }
                .frame(width: bandWidth, height: height)
                .offset(x: startX)

            Rectangle()
                .fill(Color.purple.opacity(0.82))
                .frame(width: 2, height: height + 5)
                .offset(x: startX)
            Rectangle()
                .fill(Color.purple.opacity(0.82))
                .frame(width: 2, height: height + 5)
                .offset(x: endX)

            HStack(spacing: 4) {
                Image(systemName: "rectangle.3.group")
                    .font(.system(size: 8, weight: .bold))
                Text("グループ")
                    .font(.system(size: 9, weight: .bold))
                Text(movedClipText)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                Text(deltaText)
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text("尺\(spanDurationText)")
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                if let targetTrackID = model.targetTrackID {
                    Text(model.laneLiftCreatesTrack ? "→\(targetTrackID) 新規" : "→\(targetTrackID)")
                        .font(.system(size: 8, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                if model.displacementCount > 0 {
                    Text("押\(model.displacementCount)")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                if model.snapLabel != nil {
                    Image(systemName: "magnet")
                        .font(.system(size: 7, weight: .bold))
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .foregroundStyle(Color.purple)
            .padding(.horizontal, 6)
            .frame(width: badgeWidth, height: 18, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(Color.purple.opacity(0.62), lineWidth: 1)
            }
            .shadow(color: Color.purple.opacity(0.18), radius: 3, y: 1)
            .offset(x: badgeX, y: 2)
        }
        .frame(width: laneWidth, height: height + 6, alignment: .topLeading)
        .allowsHitTesting(false)
        .help(helpText)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.GroupMoveRangeCue.\(timelineAccessibilitySuffix(model.trackID))")
    }

    private var startX: CGFloat {
        offset(for: model.startFrame)
    }

    private var endX: CGFloat {
        offset(for: model.endFrame)
    }

    private var bandWidth: CGFloat {
        max(48, endX - startX)
    }

    private var badgeWidth: CGFloat {
        214
    }

    private var badgeX: CGFloat {
        max(4, min(startX + 6, max(4, laneWidth - badgeWidth - 4)))
    }

    private var movedClipText: String {
        if model.movedClipCount == model.totalMovedClipCount {
            return "\(model.movedClipCount) clips"
        }
        return "\(model.movedClipCount)/\(model.totalMovedClipCount) clips"
    }

    private var deltaText: String {
        let sign = model.resolvedFrameDelta > 0 ? "+" : (model.resolvedFrameDelta < 0 ? "-" : "")
        let seconds = sequence.framesToSeconds(abs(model.resolvedFrameDelta))
        return String(format: "%@%.1fs", sign, seconds)
    }

    private var spanDurationText: String {
        String(format: "%.1fs", sequence.framesToSeconds(max(0, model.endFrame - model.startFrame)))
    }

    private var timecodeRangeText: String {
        "\(sequence.framesToTimecode(model.startFrame))-\(sequence.framesToTimecode(model.endFrame))"
    }

    private var helpText: String {
        var parts = [
            "\(model.trackID) の選択グループ着地範囲 \(timecodeRangeText)",
            "\(movedClipText) \(deltaText)",
            "範囲尺 \(spanDurationText)"
        ]
        if let targetTrackID = model.targetTrackID {
            parts.append(model.laneLiftCreatesTrack ? "\(targetTrackID)を作成して移動" : "\(targetTrackID)へ移動")
        }
        if model.displacementCount > 0 {
            parts.append("重なった \(model.displacementCount) 件を押し出します")
        }
        if let snapLabel = model.snapLabel {
            parts.append("\(snapLabel)に吸着")
        }
        return parts.joined(separator: " / ")
    }

    private func offset(for frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

private enum TimelineSourceOverwriteImpact {
    case remove
    case trim
    case split

    var label: String {
        switch self {
        case .remove: return "削除"
        case .trim: return "trim"
        case .split: return "split"
        }
    }

    var iconName: String {
        switch self {
        case .remove: return "xmark"
        case .trim: return "scissors"
        case .split: return "square.split.2x1"
        }
    }

    var color: Color {
        switch self {
        case .remove: return .red
        case .trim: return .orange
        case .split: return .purple
        }
    }
}

private struct TimelineSourceOverwritePreviewBand: View {
    var preview: TimelineSourceOverwritePreview
    var sequence: TimelineSequence
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.orange.opacity(0.14))
                .overlay {
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(
                            Color.orange.opacity(0.76),
                            style: StrokeStyle(lineWidth: 1.4, dash: [6, 4])
                        )
                }
                .frame(width: bandWidth, height: height)
                .offset(x: startX)

            Rectangle()
                .fill(Color.orange.opacity(0.92))
                .frame(width: 2, height: height + 7)
                .offset(x: startX)
            Rectangle()
                .fill(splitLineColor)
                .frame(width: 2, height: height + 7)
                .offset(x: endX)

            HStack(spacing: 4) {
                Image(systemName: "square.and.arrow.down.on.square")
                    .font(.system(size: 8, weight: .bold))
                Text("上書き")
                    .font(.system(size: 9, weight: .bold))
                Text(preview.segmentID)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text(operationSummary)
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(Color.orange)
            .padding(.horizontal, 6)
            .frame(width: badgeWidth, height: 18, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(Color.orange.opacity(0.64), lineWidth: 1)
            }
            .shadow(color: Color.orange.opacity(0.20), radius: 3, y: 1)
            .offset(x: badgeX, y: -9)
        }
        .frame(width: laneWidth, height: height + 8, alignment: .topLeading)
        .allowsHitTesting(false)
        .help(helpText)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.SourceOverwritePreview.\(timelineAccessibilitySuffix(preview.targetTrackID))")
    }

    private var startX: CGFloat {
        offset(for: preview.timelineInFrame)
    }

    private var endX: CGFloat {
        offset(for: preview.overwriteOutFrame)
    }

    private var bandWidth: CGFloat {
        max(44, endX - startX)
    }

    private var badgeWidth: CGFloat {
        228
    }

    private var badgeX: CGFloat {
        max(4, min(startX + 6, max(4, laneWidth - badgeWidth - 4)))
    }

    private var splitLineColor: Color {
        preview.splitClipIDs.isEmpty ? Color.orange.opacity(0.92) : Color.purple.opacity(0.92)
    }

    private var operationSummary: String {
        var parts = [String(format: "%.1fs", sequence.framesToSeconds(preview.durationFrames))]
        if !preview.removedClipIDs.isEmpty { parts.append("削除 \(preview.removedClipIDs.count)") }
        if !preview.trimmedClipIDs.isEmpty { parts.append("trim \(preview.trimmedClipIDs.count)") }
        if !preview.splitClipIDs.isEmpty { parts.append("split \(preview.splitClipIDs.count)") }
        return parts.joined(separator: " / ")
    }

    private var helpText: String {
        let inTimecode = sequence.framesToTimecode(preview.timelineInFrame)
        let outTimecode = sequence.framesToTimecode(preview.overwriteOutFrame)
        return "\(preview.targetTrackID) \(inTimecode)-\(outTimecode) を \(preview.segmentID) \(preview.markedRangeLabel) で上書きします。\(operationSummary)"
    }

    private func offset(for frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

private struct TimelineSourceOverwriteImpactBadge: View {
    var trackID: TimelineTrack.ID
    var clipID: TimelineClip.ID
    var impact: TimelineSourceOverwriteImpact

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: impact.iconName)
                .font(.system(size: 7, weight: .bold))
            Text(impact.label)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .lineLimit(1)
        }
        .foregroundStyle(impact.color)
        .padding(.horizontal, 5)
        .frame(height: 15)
        .background(.regularMaterial, in: Capsule())
        .overlay {
            Capsule().stroke(impact.color.opacity(0.64), lineWidth: 1)
        }
        .shadow(color: impact.color.opacity(0.18), radius: 2, y: 1)
        .allowsHitTesting(false)
        .help("\(clipID) は上書き時に \(impact.label)")
        .accessibilityLabel("\(clipID) は上書き時に \(impact.label)")
        .accessibilityIdentifier("Timeline.SourceOverwriteImpact.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clipID))")
    }
}

private struct TimelineLaneLiftAvoidedClipBadge: View {
    var trackID: TimelineTrack.ID
    var clipID: TimelineClip.ID
    var targetTrackID: TimelineTrack.ID

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.up.forward")
                .font(.system(size: 7, weight: .bold))
            Text("回避")
                .font(.system(size: 8, weight: .bold))
                .lineLimit(1)
            Text(targetTrackID)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .lineLimit(1)
        }
        .foregroundStyle(Color.teal)
        .padding(.horizontal, 5)
        .frame(height: 15)
        .background(.regularMaterial, in: Capsule())
        .overlay {
            Capsule().stroke(Color.teal.opacity(0.64), lineWidth: 1)
        }
        .shadow(color: Color.teal.opacity(0.18), radius: 2, y: 1)
        .allowsHitTesting(false)
        .help("\(clipID) との重なりを避けて \(targetTrackID) へ逃がします")
        .accessibilityLabel("\(clipID) との重なりを避けて \(targetTrackID) へ逃がします")
        .accessibilityIdentifier("Timeline.LaneLiftAvoidedClip.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clipID))")
    }
}

private struct TimelineLaneLiftTargetGhostModel {
    let clip: TimelineClip
    let timelineInFrame: Int
    let durationFrames: Int
    let durationText: String
    let timecode: String
    let targetTrackID: TimelineTrack.ID
}

private struct TimelineLaneLiftCreateCueModel {
    let trackID: TimelineTrack.ID
    let targetTrackID: TimelineTrack.ID
    let timecode: String
    let durationText: String
    let movedClipCount: Int
    let overlappedClipCount: Int
}

private struct TimelineLaneLiftCreateCue: View {
    let model: TimelineLaneLiftCreateCueModel
    let width: CGFloat

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 8, weight: .bold))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 4) {
                    Text("新規 \(model.targetTrackID)")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                    Text(model.timecode)
                        .font(.system(size: 7, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(detailText)
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.74)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.teal)
        .padding(.horizontal, 6)
        .frame(width: width, height: 25, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.teal.opacity(0.56), lineWidth: 1)
        }
        .shadow(color: Color.teal.opacity(0.18), radius: 3, y: 1)
        .allowsHitTesting(false)
        .help(helpText)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.LaneLiftCreateCue.\(timelineAccessibilitySuffix(model.trackID))")
    }

    private var detailText: String {
        "\(model.movedClipCount)クリップ / 尺\(model.durationText) / \(model.overlappedClipCount)件を回避"
    }

    private var helpText: String {
        "\(model.targetTrackID) を新規作成し、\(model.timecode) へ \(model.movedClipCount) クリップを重なり回避配置します。尺 \(model.durationText)、回避 \(model.overlappedClipCount) 件。"
    }
}

private struct TimelineClipLaneDropSource {
    let sourceTrackID: TimelineTrack.ID
    let kind: TimelineTrackKind
    let count: Int
    let isGroup: Bool
    let durationText: String
    let targetTimecode: String
    let snapLabel: String?
}

private struct TimelineClipLaneDropGuideModel {
    let trackID: TimelineTrack.ID
    let title: String
    let durationText: String
    let detail: String
    let systemImage: String
    let color: Color
}

private struct TimelineClipLaneDropGuide: View {
    let model: TimelineClipLaneDropGuideModel
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 4)
                .fill(model.color.opacity(0.045))
                .overlay {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(
                            model.color.opacity(0.34),
                            style: StrokeStyle(lineWidth: 1, dash: [7, 5])
                        )
                }
            HStack(spacing: 5) {
                Image(systemName: model.systemImage)
                    .font(.system(size: 8, weight: .bold))
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 4) {
                        Text(model.title)
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                        Text("尺\(model.durationText)")
                            .font(.system(size: 7, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    Text(model.detail)
                        .font(.system(size: 7, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                }
            }
            .foregroundStyle(model.color)
            .padding(.horizontal, 6)
            .frame(width: guideWidth, height: 25, alignment: .leading)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(model.color.opacity(0.48), lineWidth: 1)
            }
            .offset(x: 8, y: max(4, min(9, height * 0.18)))
        }
        .frame(width: width, height: height)
        .allowsHitTesting(false)
        .help("\(model.trackID): \(model.title) / 尺 \(model.durationText) / \(model.detail)")
        .accessibilityLabel("\(model.trackID) \(model.title)。尺 \(model.durationText)。\(model.detail)")
        .accessibilityIdentifier("Timeline.ClipLaneDropGuide.\(timelineAccessibilitySuffix(model.trackID))")
    }

    private var guideWidth: CGFloat {
        let preferred = max(248, width * 0.46)
        let available = max(72, width - 12)
        return min(preferred, available)
    }
}

private struct TimelineSourceCandidateLaneDropGuideModel {
    let trackID: TimelineTrack.ID
    let title: String
    let detail: String
    let systemImage: String
    let color: Color
}

private struct TimelineSourceCandidateLaneDropGuide: View {
    let model: TimelineSourceCandidateLaneDropGuideModel
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 4)
                .fill(model.color.opacity(0.055))
                .overlay {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(
                            model.color.opacity(0.42),
                            style: StrokeStyle(lineWidth: 1.2, dash: [6, 4])
                        )
                }
            HStack(spacing: 5) {
                Image(systemName: model.systemImage)
                    .font(.system(size: 9, weight: .bold))
                VStack(alignment: .leading, spacing: 0) {
                    Text(model.title)
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                    Text(model.detail)
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .foregroundStyle(model.color)
            .padding(.horizontal, 7)
            .frame(width: guideWidth, height: 28, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(model.color.opacity(0.56), lineWidth: 1)
            }
            .shadow(color: model.color.opacity(0.18), radius: 4, y: 1)
            .offset(x: 8, y: max(4, min(8, height * 0.12)))
        }
        .frame(width: width, height: height)
        .allowsHitTesting(false)
        .help("\(model.trackID): \(model.detail)")
        .accessibilityLabel("\(model.trackID) \(model.title)。\(model.detail)")
        .accessibilityIdentifier("Timeline.SourceCandidateLaneDropGuide.\(timelineAccessibilitySuffix(model.trackID))")
    }

    private var guideWidth: CGFloat {
        let preferred = max(270, width * 0.52)
        let available = max(72, width - 12)
        return min(preferred, available)
    }
}

private struct TimelineLaneLiftTargetGhost: View {
    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var width: CGFloat
    var targetTrackID: TimelineTrack.ID
    var timecode: String
    var durationText: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            TimelineClipBlock(
                clip: clip,
                trackKind: trackKind,
                isSelected: true,
                isUnderPlayhead: false,
                isWidthExpanded: width <= 48,
                isTrimEligible: false,
                showsActiveTrimHandles: false,
                feedbackState: .none,
                movePreviewRole: .liftedTarget,
                isTrimPreviewing: false,
                isBodyDragActive: true
            )
            .frame(width: width, height: 28)
            .allowsHitTesting(false)

            HStack(spacing: 3) {
                Image(systemName: "arrow.down.right")
                    .font(.system(size: 7, weight: .bold))
                Text(targetTrackID)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                Text(timecode)
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text("尺\(durationText)")
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .foregroundStyle(Color.teal)
            .padding(.horizontal, 5)
            .frame(height: 15)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(Color.teal.opacity(0.62), lineWidth: 1)
            }
            .offset(x: 4, y: -7)
        }
        .help("\(clip.id) を \(targetTrackID) \(timecode) へ移動します / 尺 \(durationText)")
        .accessibilityLabel("\(clip.id) の移動先 \(targetTrackID) \(timecode)、尺 \(durationText)")
        .accessibilityIdentifier("Timeline.LaneLiftTargetGhost.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clip.id))")
    }
}

private struct TimelineTrackMoveTargetGhostModel {
    let clip: TimelineClip
    let timelineInFrame: Int
    let durationFrames: Int
    let durationText: String
    let timecode: String
    let targetTrackID: TimelineTrack.ID
}

private struct TimelineGroupMoveTargetGhostModel: Identifiable {
    var id: TimelineClip.ID { clip.id }

    let clip: TimelineClip
    let timelineInFrame: Int
    let durationFrames: Int
    let durationText: String
    let timecode: String
    let targetTrackID: TimelineTrack.ID
    let isLaneLifted: Bool
}

struct TimelineTrackMoveBlockedTarget {
    let clipID: TimelineClip.ID
    let sourceTrackID: TimelineTrack.ID
    let targetTrackID: TimelineTrack.ID
    let timelineInFrame: Int
    let durationFrames: Int
    let reason: String
}

private struct TimelineTrackMoveBlockedCueModel {
    let clipID: TimelineClip.ID
    let timelineInFrame: Int
    let durationFrames: Int
    let durationText: String
    let reason: String
}

private struct TimelineClipMoveLandingCueModel {
    let clipID: TimelineClip.ID
    let timelineInFrame: Int
    let targetTrackID: TimelineTrack.ID
    let timecode: String
    let durationText: String
    let detailText: String
    let iconName: String
    let color: Color
    let yOffset: CGFloat
}

private struct TimelineTrackMoveTargetGhost: View {
    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var width: CGFloat
    var targetTrackID: TimelineTrack.ID
    var timecode: String
    var durationText: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            TimelineClipBlock(
                clip: clip,
                trackKind: trackKind,
                isSelected: true,
                isUnderPlayhead: false,
                isWidthExpanded: width <= 48,
                isTrimEligible: false,
                showsActiveTrimHandles: false,
                feedbackState: .none,
                movePreviewRole: .target,
                isTrimPreviewing: false,
                isBodyDragActive: true
            )
            .frame(width: width, height: 28)
            .allowsHitTesting(false)

            HStack(spacing: 3) {
                Image(systemName: "arrow.up.and.down")
                    .font(.system(size: 7, weight: .bold))
                Text(targetTrackID)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                Text(timecode)
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text("尺\(durationText)")
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, 5)
            .frame(height: 15)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(Color.accentColor.opacity(0.62), lineWidth: 1)
            }
            .offset(x: 4, y: -7)
        }
        .help("\(clip.id) を \(targetTrackID) \(timecode) へ直接移動します / 尺 \(durationText)")
        .accessibilityLabel("\(clip.id) の直接移動先 \(targetTrackID) \(timecode)、尺 \(durationText)")
        .accessibilityIdentifier("Timeline.TrackMoveTargetGhost.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clip.id))")
    }
}

private struct TimelineGroupMoveTargetGhost: View {
    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var width: CGFloat
    var targetTrackID: TimelineTrack.ID
    var timecode: String
    var durationText: String
    var isLaneLifted: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            TimelineClipBlock(
                clip: clip,
                trackKind: trackKind,
                isSelected: true,
                isUnderPlayhead: false,
                isWidthExpanded: width <= 48,
                isTrimEligible: false,
                showsActiveTrimHandles: false,
                feedbackState: .none,
                movePreviewRole: isLaneLifted ? .liftedTarget : .target,
                isTrimPreviewing: false,
                isBodyDragActive: true
            )
            .frame(width: width, height: 28)
            .allowsHitTesting(false)

            HStack(spacing: 3) {
                Image(systemName: "rectangle.3.group")
                    .font(.system(size: 7, weight: .bold))
                Text(targetTrackID)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                Text(timecode)
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text("尺\(durationText)")
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .frame(height: 15)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(color.opacity(0.62), lineWidth: 1)
            }
            .offset(x: 4, y: -7)
        }
        .help(helpText)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.GroupMoveTargetGhost.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clip.id))")
    }

    private var color: Color {
        isLaneLifted ? .teal : .purple
    }

    private var helpText: String {
        isLaneLifted
            ? "\(clip.id) をグループごと \(targetTrackID) \(timecode) へ重なり回避移動します / 尺 \(durationText)"
            : "\(clip.id) をグループごと \(targetTrackID) \(timecode) へ移動します / 尺 \(durationText)"
    }
}

private struct TimelineTrackMoveBlockedCue: View {
    var trackID: TimelineTrack.ID
    var clipID: TimelineClip.ID
    var width: CGFloat
    var reason: String
    var durationText: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.red.opacity(0.10))
                .overlay {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color.red.opacity(0.78), style: StrokeStyle(lineWidth: 1.6, dash: [4, 3]))
                }
                .frame(width: width, height: 28)

            HStack(spacing: 3) {
                Image(systemName: "xmark.octagon.fill")
                    .font(.system(size: 7, weight: .bold))
                Text(reason)
                    .font(.system(size: 8, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text("尺\(durationText)")
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .foregroundStyle(Color.red)
            .padding(.horizontal, 5)
            .frame(width: badgeWidth, height: 15, alignment: .leading)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(Color.red.opacity(0.62), lineWidth: 1)
            }
            .offset(x: 4, y: -7)
        }
        .help("\(clipID) は \(trackID) へ移動できません: \(reason) / 尺 \(durationText)")
        .accessibilityLabel("\(clipID) は \(trackID) へ移動できません。\(reason)。尺 \(durationText)")
        .accessibilityIdentifier("Timeline.TrackMoveBlockedCue.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clipID))")
    }

    private var badgeWidth: CGFloat {
        min(max(136, width - 8), 172)
    }
}

private struct TimelineClipMoveLandingCue: View {
    var trackID: TimelineTrack.ID
    var model: TimelineClipMoveLandingCueModel
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(model.color.opacity(0.92))
                .frame(width: 2, height: height)
                .shadow(color: model.color.opacity(0.34), radius: 3)
                .offset(x: landingX)

            HStack(spacing: 4) {
                Image(systemName: model.iconName)
                    .font(.system(size: 8, weight: .bold))
                Text(model.targetTrackID)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                Text(model.timecode)
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Text("尺\(model.durationText)")
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(model.detailText)
                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .foregroundStyle(model.color)
            .padding(.horizontal, 6)
            .frame(width: badgeWidth, height: 17, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(model.color.opacity(0.64), lineWidth: 1)
            }
            .shadow(color: model.color.opacity(0.20), radius: 3, y: 1)
            .offset(x: badgeX, y: -8)
        }
        .frame(width: laneWidth, height: height, alignment: .topLeading)
        .allowsHitTesting(false)
        .help("\(model.clipID) の着地点 \(model.targetTrackID) \(model.timecode) / 尺 \(model.durationText) / \(model.detailText)")
        .accessibilityLabel("\(model.clipID) の着地点 \(model.targetTrackID) \(model.timecode)、尺 \(model.durationText)、\(model.detailText)")
        .accessibilityIdentifier("Timeline.ClipMoveLandingCue.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(model.clipID))")
    }

    private var landingX: CGFloat {
        laneWidth * CGFloat(max(0, min(model.timelineInFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var badgeWidth: CGFloat {
        238
    }

    private var badgeX: CGFloat {
        max(4, min(landingX + 6, max(4, laneWidth - badgeWidth - 4)))
    }
}

private struct TimelineLaneScrubBadge: View {
    var timecode: String
    var snap: TimelinePlayheadScrubSnap?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "playpause")
                .font(.system(size: 8, weight: .bold))
                .accessibilityHidden(true)
            Text(timecode)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
            if let snap {
                Image(systemName: snap.kind.iconName)
                    .font(.system(size: 8, weight: .bold))
                    .accessibilityHidden(true)
                Text("吸着 \(snap.label)")
                    .font(.system(size: 8, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
            }
        }
        .foregroundStyle(Color.accentColor)
        .padding(.horizontal, 6)
        .frame(width: Self.badgeWidth(hasSnap: snap != nil), height: 18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.accentColor.opacity(0.45), lineWidth: 1)
        }
        .shadow(color: Color.accentColor.opacity(0.18), radius: 3, y: 1)
        .accessibilityLabel(snap.map { "再生位置 \(timecode) 吸着 \($0.label)" } ?? "再生位置 \(timecode)")
        .accessibilityIdentifier("Timeline.TrackScrubPreview")
    }

    static func badgeWidth(hasSnap: Bool) -> CGFloat {
        hasSnap ? 172 : 82
    }
}

private struct TimelineSkimPreviewIndicator: View {
    var trackID: TimelineTrack.ID
    var frame: Int
    var timecode: String
    var isClipBound: Bool
    var laneWidth: CGFloat
    var totalFrames: Int
    var height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.cyan.opacity(0.88))
                .frame(width: 1.5, height: height)
                .offset(x: xPosition)

            HStack(spacing: 4) {
                Image(systemName: isClipBound ? "viewfinder" : "cursorarrow.rays")
                    .font(.system(size: 8, weight: .bold))
                Text("SKIM")
                    .font(.system(size: 9, weight: .black, design: .monospaced))
                Text(timecode)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.cyan)
            .padding(.horizontal, 6)
            .frame(width: badgeWidth, height: 18, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(Color.cyan.opacity(0.52), lineWidth: 1)
            }
            .shadow(color: Color.cyan.opacity(0.18), radius: 3, y: 1)
            .offset(x: badgeX, y: 2)
        }
        .frame(width: laneWidth, height: height, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityLabel("スキムプレビュー \(timecode)")
        .accessibilityIdentifier("Timeline.SkimPreview.\(timelineAccessibilitySuffix(trackID))")
        .help("再生ヘッドを動かさずにViewerへ表示中: \(timecode)")
    }

    private var xPosition: CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var badgeWidth: CGFloat {
        118
    }

    private var badgeX: CGFloat {
        max(4, min(xPosition + 6, max(4, laneWidth - badgeWidth - 4)))
    }
}

private struct TimelineSourceCandidateDropCue: View {
    let preview: TimelineSourceCandidateDropPreview
    let timecode: String
    let durationText: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
            Text(trackLabel)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
            Text(timecode)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
            Text(preview.markedRangeLabel)
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text("尺\(durationText)")
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
            if let snapLabel {
                Text(snapLabel)
                    .font(.system(size: 7, weight: .heavy, design: .monospaced))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.72)
        .foregroundStyle(color)
        .padding(.horizontal, 7)
        .frame(width: cueWidth, height: 21, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(color.opacity(0.55), lineWidth: 1)
        }
        .shadow(color: color.opacity(0.20), radius: 4, y: 1)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("Timeline.SourceCandidateDropCue.\(timelineAccessibilitySuffix(preview.targetTrackID))")
    }

    private var color: Color {
        if !preview.isCompatibleTarget { return .red }
        return preview.isLaneLifted ? .teal : .orange
    }

    private var systemImage: String {
        if !preview.isCompatibleTarget { return "nosign" }
        if preview.snap != nil, !preview.isLaneLifted { return "arrow.left.and.line.vertical.and.arrow.right" }
        return preview.isLaneLifted ? "square.stack.3d.up" : "plus.rectangle.on.rectangle"
    }

    private var trackLabel: String {
        guard preview.isLaneLifted else { return preview.targetTrackID }
        return "\(preview.requestedTrackID)->\(preview.targetTrackID)"
    }

    private var snapLabel: String? {
        preview.snap.map { "吸着 \($0.label)" }
    }

    private var cueWidth: CGFloat {
        preview.snap == nil ? 292 : 318
    }

    private var accessibilityLabel: String {
        if preview.isCompatibleTarget {
            let snapText = preview.snap.map { "、\($0.label)へ吸着" } ?? ""
            if preview.isLaneLifted {
                return "\(preview.requestedTrackID) の重なりを避けて \(preview.targetTrackID) \(timecode) に \(preview.segmentID) \(preview.markedRangeLabel) を尺\(durationText)で追加\(snapText)"
            }
            return "\(preview.targetTrackID) \(timecode) に \(preview.segmentID) \(preview.markedRangeLabel) を尺\(durationText)で追加\(snapText)"
        }
        return "\(preview.requestedTrackID) には \(preview.segmentID) \(preview.markedRangeLabel) を追加できません"
    }
}

private struct TimelineSourceCandidateDropGhost: View {
    let preview: TimelineSourceCandidateDropPreview
    let sequence: TimelineSequence
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 5)
                .fill(color.opacity(preview.isCompatibleTarget ? 0.18 : 0.10))
                .overlay {
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(
                            color.opacity(preview.isCompatibleTarget ? 0.78 : 0.68),
                            style: StrokeStyle(lineWidth: 1.3, dash: [6, 4])
                        )
                }

            HStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 8, weight: .bold))
                Text(preview.segmentID)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(durationLabel)
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                if shouldShowMarkedRangeLabel {
                    Text(preview.markedRangeLabel)
                        .font(.system(size: 7, weight: .semibold, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .padding(.horizontal, 4)
                        .frame(height: 13)
                        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 3))
                }
                if let snapBadgeText {
                    Text(snapBadgeText)
                        .font(.system(size: 7, weight: .heavy, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .padding(.horizontal, 4)
                        .frame(height: 13)
                        .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 3))
                }
            }
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .frame(width: max(46, width - 4), height: min(18, height), alignment: .leading)
            .offset(x: 2, y: max(2, (height - min(18, height)) / 2))
        }
        .frame(width: width, height: height)
        .allowsHitTesting(false)
        .help(helpText)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.SourceCandidateDropGhost.\(timelineAccessibilitySuffix(preview.targetTrackID))")
    }

    private var color: Color {
        if !preview.isCompatibleTarget { return .red }
        return preview.isLaneLifted ? .teal : .orange
    }

    private var systemImage: String {
        if !preview.isCompatibleTarget { return "exclamationmark.triangle" }
        if preview.snap != nil, !preview.isLaneLifted { return "arrow.left.and.line.vertical.and.arrow.right" }
        return preview.isLaneLifted ? "square.stack.3d.up" : "film.stack"
    }

    private var durationLabel: String {
        String(format: "%.1fs", sequence.framesToSeconds(preview.durationFrames))
    }

    private var helpText: String {
        if preview.isCompatibleTarget {
            let snapText = preview.snap.map { "。吸着先は \($0.label) です" } ?? ""
            if preview.isLaneLifted {
                let target = preview.laneLiftCreatesTrack ? "新規\(preview.targetTrackID)" : preview.targetTrackID
                return "\(preview.segmentID) \(preview.markedRangeLabel) は \(preview.requestedTrackID) の\(preview.overlappedClipCount)件の重なりを避けて \(target) に \(durationLabel) で追加します\(snapText)"
            }
            return "\(preview.segmentID) \(preview.markedRangeLabel) を \(preview.targetTrackID) に \(durationLabel) で追加します\(snapText)"
        }
        return "\(preview.segmentID) は \(preview.requestedTrackID) に追加できません。候補の種類は \(preview.roleLabel) です"
    }

    private var shouldShowMarkedRangeLabel: Bool {
        width >= 138
    }

    private var snapBadgeText: String? {
        guard let snap = preview.snap, width >= 96 else { return nil }
        guard width >= 150 else { return "吸着" }
        return "吸着 \(snap.label)"
    }
}

private enum TimelineLaneDropPayload {
    case sourceCandidate(assetID: String, candidateID: String)
    case transitionPreset(String)
    case transition(TimelineTransition.ID)
}

private struct TimelineSourceCandidateDropDelegate: DropDelegate {
    let timeline: TimelineDocument
    let trackID: TimelineTrack.ID
    let totalFrames: Int
    let laneWidth: CGFloat
    let snapThresholdFrames: Int
    let blockedTransitionClipIDs: Set<TimelineClip.ID>
    @Binding var activePreview: TimelineSourceCandidateDropPreview?
    @Binding var activeTransitionPresetTargetID: TimelineTransition.ID?
    @Binding var activeTransitionMoveTargetID: TimelineTransition.ID?
    var onPreviewSourceCandidate: (String, String, Int, TimelineTrack.ID, Int) -> TimelineSourceCandidateDropPreview?
    var onDropSourceCandidate: (String, String, Int, TimelineTrack.ID, Int) -> Void
    var onPreviewTransitionPresetDrop: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onApplyTransitionPreset: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionMove: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onMoveTransition: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onEndTransitionDropPreview: () -> Void
    var onEndTransitionPresetDrag: () -> Void
    var onEndTransitionMoveDrag: () -> Void

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [UTType.plainText])
    }

    func dropEntered(info: DropInfo) {
        updatePreview(info: info)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        updatePreview(info: info)
        return DropProposal(operation: activeTransitionMoveTargetID == nil ? .copy : .move)
    }

    func dropExited(info: DropInfo) {
        if activePreview?.requestedTrackID == trackID {
            activePreview = nil
        }
        activeTransitionPresetTargetID = nil
        activeTransitionMoveTargetID = nil
        onEndTransitionDropPreview()
    }

    func performDrop(info: DropInfo) -> Bool {
        let frame = frame(for: info.location.x)
        if activePreview?.requestedTrackID == trackID {
            activePreview = nil
        }
        loadLanePayload(from: info) { payload in
            guard let payload else { return }
            switch payload {
            case .sourceCandidate(let assetID, let candidateID):
                activeTransitionPresetTargetID = nil
                activeTransitionMoveTargetID = nil
                onEndTransitionDropPreview()
                onDropSourceCandidate(assetID, candidateID, frame, trackID, snapThresholdFrames)
            case .transitionPreset(let presetID):
                activePreview = nil
                activeTransitionMoveTargetID = nil
                guard let target = transitionTarget(near: frame) else {
                    activeTransitionPresetTargetID = nil
                    onEndTransitionDropPreview()
                    onEndTransitionPresetDrag()
                    return
                }
                activeTransitionPresetTargetID = nil
                onApplyTransitionPreset(
                    presetID,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
                onEndTransitionPresetDrag()
            case .transition(let transitionID):
                activePreview = nil
                activeTransitionPresetTargetID = nil
                guard let target = transitionMoveTarget(transitionID: transitionID, near: frame) else {
                    activeTransitionMoveTargetID = nil
                    onEndTransitionDropPreview()
                    onEndTransitionMoveDrag()
                    return
                }
                activeTransitionMoveTargetID = nil
                onMoveTransition(
                    transitionID,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
                onEndTransitionMoveDrag()
            }
        }
        return true
    }

    private func updatePreview(info: DropInfo) {
        let frame = frame(for: info.location.x)
        loadLanePayload(from: info) { payload in
            guard let payload else {
                activePreview = nil
                activeTransitionPresetTargetID = nil
                activeTransitionMoveTargetID = nil
                onEndTransitionDropPreview()
                return
            }
            switch payload {
            case .sourceCandidate(let assetID, let candidateID):
                activeTransitionPresetTargetID = nil
                activeTransitionMoveTargetID = nil
                onEndTransitionDropPreview()
                activePreview = onPreviewSourceCandidate(assetID, candidateID, frame, trackID, snapThresholdFrames)
            case .transitionPreset(let presetID):
                activePreview = nil
                activeTransitionMoveTargetID = nil
                guard let target = transitionTarget(near: frame) else {
                    activeTransitionPresetTargetID = nil
                    onEndTransitionDropPreview()
                    return
                }
                activeTransitionPresetTargetID = target.transitionID
                onPreviewTransitionPresetDrop(
                    presetID,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
            case .transition(let transitionID):
                activePreview = nil
                activeTransitionPresetTargetID = nil
                guard let target = transitionMoveTarget(transitionID: transitionID, near: frame) else {
                    activeTransitionMoveTargetID = nil
                    onEndTransitionDropPreview()
                    return
                }
                activeTransitionMoveTargetID = target.transitionID
                onPreviewTransitionMove(
                    transitionID,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
            }
        }
    }

    private func frame(for x: CGFloat) -> Int {
        let normalized = max(0, min(x / max(laneWidth, 1), 1))
        return max(0, min(Int((normalized * CGFloat(max(totalFrames, 1))).rounded()), totalFrames))
    }

    private func transitionTarget(near frame: Int) -> TimelineTransitionPlacementTarget? {
        TimelineTransitionPlacementResolver.resolveNearestOnTrack(
            timeline: timeline,
            trackID: trackID,
            proposedFrame: frame,
            blockedClipIDs: blockedTransitionClipIDs
        )
    }

    private func transitionMoveTarget(
        transitionID: TimelineTransition.ID,
        near frame: Int
    ) -> TimelineTransitionPlacementTarget? {
        TimelineTransitionPlacementResolver.resolveNearestRelocationOnTrack(
            timeline: timeline,
            sourceTransitionID: transitionID,
            trackID: trackID,
            proposedFrame: frame,
            blockedClipIDs: blockedTransitionClipIDs
        )
    }

    private func loadLanePayload(
        from info: DropInfo,
        completion: @escaping (TimelineLaneDropPayload?) -> Void
    ) {
        guard let provider = info.itemProviders(for: [UTType.plainText]).first else {
            completion(nil)
            return
        }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            let text = (object as? NSString).map(String.init)
            let payload: TimelineLaneDropPayload?
            if let source = text.flatMap(StudioDragPayload.parseSourceCandidate) {
                payload = .sourceCandidate(assetID: source.assetID, candidateID: source.candidateID)
            } else if let transitionID = text.flatMap(StudioDragPayload.parseTransition) {
                payload = .transition(transitionID)
            } else if let presetID = text.flatMap(StudioDragPayload.parseTransitionPresetID),
                      TimelineTransitionPreset(rawValue: presetID) != nil {
                payload = .transitionPreset(presetID)
            } else {
                payload = nil
            }
            DispatchQueue.main.async {
                completion(payload)
            }
        }
    }
}

private struct TimelineTransitionDropTarget: View {
    @State private var isTargeted = false
    @State private var isHovering = false
    @State private var durationDragTranslation: CGFloat = 0
    @State private var activeDurationFrameDelta = 0
    @State private var hasBegunDurationDrag = false
    @State private var previewedPresetID: String?
    @State private var previewedTransitionMoveID: TimelineTransition.ID?
    @State private var isDefaultPresetHoverPreviewing = false

    var sequence: TimelineSequence
    var target: TimelineTransitionDropTargetModel
    var existingTransition: TimelineTransition?
    var targetWidth: CGFloat
    var hitAreaWidth: CGFloat
    var pixelsPerFrame: CGFloat
    var totalFrames: Int
    var trackDensity: TimelineTrackDensity
    var isSelected: Bool
    @Binding var activeDragRevealFrame: Int?
    var activePresetDragID: String?
    var activeTransitionMoveID: TimelineTransition.ID?
    var activeTransitionMoveSummary: String?
    var isLanePresetDropTarget: Bool
    var isLaneTransitionMoveTarget: Bool
    var isRecommendedPresetDropTarget: Bool
    var onApplyTransitionPreset: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionPresetDrop: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewDefaultTransitionEditPointHover: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionMove: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onMoveTransition: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onSelectTransition: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onAdjustTransitionDuration: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID, Int) -> Void
    var onPreviewTransitionDuration: (TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID, Int) -> Void
    var onEndTransitionDurationPreview: () -> Void
    var onBeginTransitionMoveDrag: (TimelineTransition.ID) -> Void
    var onEndTransitionPresetDrag: () -> Void
    var onEndTransitionMoveDrag: () -> Void

    var body: some View {
        ZStack {
            Color.clear
                .frame(width: hitAreaWidth, height: hitAreaHeight)
            if existingTransition == nil {
                TimelineTransitionLandingGuide(
                    width: hitAreaWidth,
                    height: hitAreaHeight,
                    color: borderColor,
                    isActive: isInteractionActive || isLanePresetDropTarget || isLaneTransitionMoveTarget || isRecommendedPresetDropTarget || isPresetDragCandidateVisible || isTransitionMoveCandidateVisible
                )
                .accessibilityHidden(true)
            } else {
                TimelineTransitionDurationGrip(
                    width: displayWidth,
                    color: borderColor,
                    isActive: isInteractionActive || isSelected
                )
                .accessibilityHidden(true)
            }
            ZStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(backgroundColor)
                RoundedRectangle(cornerRadius: 4)
                    .stroke(borderColor, style: StrokeStyle(lineWidth: borderWidth, dash: existingTransition == nil ? [3, 3] : []))
                Image(systemName: systemImage)
                    .font(.system(size: existingTransition == nil ? 12 : 10, weight: .bold))
                    .foregroundStyle(borderColor)
                if let presetSummary = previewedPresetSummary, existingTransition == nil {
                    Text(presetSummary)
                        .font(.system(size: 8, weight: .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(borderColor)
                        .padding(.horizontal, 4)
                        .frame(width: max(40, targetWidth - 8), alignment: .center)
                        .offset(y: 11)
                } else if let bodyCueLabel = transitionPresetBodyCueLabel {
                    Text(bodyCueLabel)
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .foregroundStyle(borderColor)
                        .padding(.horizontal, 4)
                        .frame(width: max(40, targetWidth - 8), alignment: .center)
                        .offset(y: 11)
                }
                if let durationLabel = existingTransitionDurationLabel {
                    Text(durationLabel)
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.76)
                        .foregroundStyle(borderColor)
                        .padding(.horizontal, 3)
                        .frame(width: max(24, displayWidth - 6), alignment: .center)
                        .offset(y: 10)
                }
            }
            .frame(width: displayWidth, height: targetHeight)
            if let existingTransition {
                TimelineTransitionMoveHandle(color: borderColor, isActive: isInteractionActive || isSelected)
                    .onDrag {
                        selectTransitionIfPresent()
                        onBeginTransitionMoveDrag(existingTransition.id)
                        return NSItemProvider(object: StudioDragPayload.transition(transitionID: existingTransition.id) as NSString)
                    }
                    .help("中央をドラッグして別の編集点へ移動")
                    .accessibilityLabel("\(target.fromClipID) → \(target.toClipID) のトランジション移動ハンドル")
                    .accessibilityIdentifier("Timeline.TransitionMoveHandle.\(timelineAccessibilitySuffix(target.trackID)).\(timelineAccessibilitySuffix(target.fromClipID)).\(timelineAccessibilitySuffix(target.toClipID))")
                    .zIndex(6)
            }
            if let cue = dropCandidateCue {
                TimelineTransitionDropCandidateCue(
                    label: cue.label,
                    color: borderColor
                )
                .offset(y: -23)
                .zIndex(3)
            }
            if let cue = dropMagnetCue {
                TimelineTransitionDropMagnetCue(
                    title: cue.title,
                    detail: cue.detail,
                    color: borderColor,
                    height: hitAreaHeight + 8
                )
                .offset(y: -30)
                .zIndex(5)
            }
            if let preview = durationBadgePreview {
                TimelineTransitionDurationPreviewBadge(
                    deltaFrames: preview.deltaFrames,
                    durationFrames: preview.durationFrames,
                    secondsLabel: preview.secondsLabel,
                    color: borderColor
                )
                .offset(y: -27)
                .zIndex(4)
            }
        }
        .frame(width: max(hitAreaWidth, displayWidth), height: max(hitAreaHeight, targetHeight))
        .contentShape(Rectangle())
        .simultaneousGesture(editPointClickGesture)
        .simultaneousGesture(durationDragGesture)
        .onDrop(
            of: [UTType.plainText],
            delegate: TimelineTransitionDropDelegate(
                target: target,
                isTargeted: $isTargeted,
                previewedPresetID: $previewedPresetID,
                previewedTransitionMoveID: $previewedTransitionMoveID,
                onApplyTransitionPreset: onApplyTransitionPreset,
                onPreviewTransitionPresetDrop: onPreviewTransitionPresetDrop,
                onPreviewTransitionMove: onPreviewTransitionMove,
                onMoveTransition: onMoveTransition,
                onEndTransitionDropPreview: onEndTransitionDurationPreview,
                onEndTransitionPresetDrag: onEndTransitionPresetDrag,
                onEndTransitionMoveDrag: onEndTransitionMoveDrag
            )
        )
        .onContinuousHover { phase in
            switch phase {
            case .active(let location):
                handleVisibleWellHover(isInsideVisibleTransitionWell(location.x))
            case .ended:
                handleVisibleWellHover(false)
            }
        }
        .onChange(of: existingTransition?.id) { _, newValue in
            if newValue != nil {
                endDefaultPresetHoverPreviewIfNeeded()
            }
        }
        .onDisappear {
            endDefaultPresetHoverPreviewIfNeeded()
        }
        .scaleEffect(isInteractionActive ? 1.06 : 1, anchor: .center)
        .shadow(color: borderColor.opacity(isInteractionActive ? 0.24 : 0), radius: isInteractionActive ? 5 : 0)
        .animation(.easeOut(duration: 0.12), value: isInteractionActive)
        .help(helpText)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(helpText)
        .accessibilityIdentifier("Timeline.TransitionDropTarget.\(timelineAccessibilitySuffix(target.trackID)).\(timelineAccessibilitySuffix(target.fromClipID)).\(timelineAccessibilitySuffix(target.toClipID))")
    }

    private var displayWidth: CGFloat {
        guard existingTransition != nil else { return targetWidth }
        return max(18, targetWidth + durationDragTranslation)
    }

    private var targetHeight: CGFloat {
        CGFloat(isInteractionActive ? trackDensity.transitionTargetActiveHeight : trackDensity.transitionTargetHeight)
    }

    private var hitAreaHeight: CGFloat {
        if existingTransition == nil {
            return targetHeight + 2
        }
        return targetHeight + (isInteractionActive ? 2 : 0)
    }

    private var isInteractionActive: Bool {
        isTargeted
            || isHovering
            || previewedPresetID != nil
            || previewedTransitionMoveID != nil
            || isLanePresetDropTarget
            || isLaneTransitionMoveTarget
            || isRecommendedPresetDropTarget
            || activeDurationFrameDelta != 0
    }

    private var backgroundColor: Color {
        if previewedTransitionMoveID != nil { return Color.orange.opacity(0.24) }
        if isTargeted { return Color.accentColor.opacity(0.24) }
        if isHovering { return Color.accentColor.opacity(0.18) }
        if isSelected { return Color.accentColor.opacity(0.20) }
        if isLanePresetDropTarget { return Color.accentColor.opacity(0.21) }
        if isLaneTransitionMoveTarget { return Color.orange.opacity(0.22) }
        if isRecommendedPresetDropTarget { return Color.accentColor.opacity(0.18) }
        if existingTransition != nil { return Color.purple.opacity(0.20) }
        if isTransitionMoveCandidateVisible { return Color.orange.opacity(0.14) }
        if isPresetDragCandidateVisible { return Color.accentColor.opacity(0.16) }
        return Color.accentColor.opacity(0.10)
    }

    private var borderColor: Color {
        if previewedTransitionMoveID != nil { return .orange }
        if isTargeted { return .accentColor }
        if isHovering { return .accentColor }
        if isSelected { return .accentColor }
        if isLanePresetDropTarget { return .accentColor }
        if isLaneTransitionMoveTarget { return .orange }
        if isRecommendedPresetDropTarget { return .accentColor }
        if existingTransition != nil { return .purple }
        if isTransitionMoveCandidateVisible { return .orange.opacity(0.90) }
        if isPresetDragCandidateVisible { return .accentColor.opacity(0.92) }
        return .accentColor.opacity(0.74)
    }

    private var borderWidth: CGFloat {
        if isLanePresetDropTarget { return 2.2 }
        if isLaneTransitionMoveTarget { return 2.2 }
        if isRecommendedPresetDropTarget { return 2 }
        if isPresetDragCandidateVisible || isTransitionMoveCandidateVisible { return 1.5 }
        if isTargeted || isHovering || isSelected { return 1.8 }
        return existingTransition == nil ? 1.2 : 1
    }

    private var railOpacity: Double {
        isInteractionActive ? 0.28 : 0.12
    }

    private var systemImage: String {
        if previewedTransitionMoveID != nil { return "arrowshape.turn.up.right.fill" }
        if previewedPresetID != nil, existingTransition == nil { return "sparkles" }
        if isLanePresetDropTarget { return "scope" }
        if isLaneTransitionMoveTarget { return "arrowshape.turn.up.right.fill" }
        if isRecommendedPresetDropTarget { return "scope" }
        if isTransitionMoveCandidateVisible { return "arrow.down.to.line.compact" }
        return existingTransition == nil ? "rectangle.on.rectangle" : "arrow.left.and.right"
    }

    private var previewedPresetSummary: String? {
        guard let previewedPresetID,
              let preset = TimelineTransitionPreset(rawValue: previewedPresetID)
        else {
            return nil
        }
        return transitionPresetDropSummary(preset)
    }

    private var activePresetDragSummary: String? {
        guard let activePresetDragID,
              let preset = TimelineTransitionPreset(rawValue: activePresetDragID)
        else {
            return nil
        }
        return transitionPresetDropSummary(preset)
    }

    private var activePresetDragFrameLabel: String? {
        guard let activePresetDragID,
              let preset = TimelineTransitionPreset(rawValue: activePresetDragID)
        else {
            return nil
        }
        return "\(preset.defaultFrames)f"
    }

    private func transitionPresetDropSummary(_ preset: TimelineTransitionPreset) -> String {
        "\(preset.localizedLabel) \(preset.defaultFrames)f"
    }

    private var transitionPresetBodyCueLabel: String? {
        guard existingTransition == nil,
              previewedPresetID == nil,
              previewedTransitionMoveID == nil,
              let frameLabel = activePresetDragFrameLabel
        else {
            return nil
        }
        if isLanePresetDropTarget {
            return "近傍 \(frameLabel)"
        }
        if isRecommendedPresetDropTarget {
            return "推奨 \(frameLabel)"
        }
        guard isPresetDragCandidateVisible else { return nil }
        return "Drop \(frameLabel)"
    }

    private var existingTransitionDurationLabel: String? {
        guard existingTransition != nil, isExistingTransitionDurationLabelVisible else { return nil }
        if let durationFrames = previewTransitionFrames, activeDurationFrameDelta != 0 {
            return "\(durationFrames)f"
        }
        guard let frames = existingTransition?.transitionFrames else { return nil }
        return "\(frames)f"
    }

    private var isExistingTransitionDurationLabelVisible: Bool {
        existingTransition != nil
            && (isSelected || isInteractionActive || isHovering)
            && displayWidth >= 28
    }

    private var isPresetDragCandidateVisible: Bool {
        existingTransition == nil
            && activePresetDragSummary != nil
            && !isTargeted
            && previewedPresetID == nil
            && previewedTransitionMoveID == nil
    }

    private var isTransitionMoveCandidateVisible: Bool {
        guard let activeTransitionMoveID else { return false }
        return activeTransitionMoveID != target.transitionID
            && !isTargeted
            && previewedPresetID == nil
            && previewedTransitionMoveID == nil
    }

    private var dropCandidateCue: TimelineTransitionDropCandidateCueModel? {
        if isLanePresetDropTarget, let activePresetDragSummary {
            return TimelineTransitionDropCandidateCueModel(label: "離す \(activePresetDragSummary) \(candidateTimecodeSuffix)")
        }
        if isLaneTransitionMoveTarget {
            return TimelineTransitionDropCandidateCueModel(label: "近傍 \(activeTransitionMoveSummary ?? "移動") \(candidateTimecodeSuffix)")
        }
        if isRecommendedPresetDropTarget, let activePresetDragSummary {
            return TimelineTransitionDropCandidateCueModel(label: "推奨 \(activePresetDragSummary) \(candidateTimecodeSuffix)")
        }
        if isTransitionMoveCandidateVisible {
            return TimelineTransitionDropCandidateCueModel(label: "移動 \(activeTransitionMoveSummary ?? "Move") \(candidateTimecodeSuffix)")
        }
        guard isPresetDragCandidateVisible, let activePresetDragSummary else { return nil }
        return TimelineTransitionDropCandidateCueModel(label: "\(activePresetDragSummary) \(candidateTimecodeSuffix)")
    }

    private var candidateTimecodeSuffix: String {
        "@ \(sequence.framesToTimecode(target.boundaryFrame))"
    }

    private var dropMagnetCue: TimelineTransitionDropMagnetCueModel? {
        if previewedTransitionMoveID != nil {
            return TimelineTransitionDropMagnetCueModel(
                title: "\(activeTransitionMoveSummary ?? "トランジション") 移動先 @ \(targetTimecode)",
                detail: magnetCueDetail
            )
        }
        if isLaneTransitionMoveTarget {
            return TimelineTransitionDropMagnetCueModel(
                title: "\(activeTransitionMoveSummary ?? "トランジション") 近傍移動 @ \(targetTimecode)",
                detail: magnetCueDetail
            )
        }
        if isLanePresetDropTarget {
            return TimelineTransitionDropMagnetCueModel(
                title: "\(activePresetDragSummary ?? "トランジション") 吸着 @ \(targetTimecode)",
                detail: presetMagnetCueDetail
            )
        }
        if isRecommendedPresetDropTarget {
            return TimelineTransitionDropMagnetCueModel(
                title: "推奨 \(activePresetDragSummary ?? "トランジション") @ \(targetTimecode)",
                detail: presetMagnetCueDetail
            )
        }
        guard existingTransition == nil, isTargeted || previewedPresetID != nil else { return nil }
        let presetSummary = previewedPresetSummary ?? "トランジション"
        let title = isDefaultPresetHoverPreviewing
            ? "\(presetSummary) プレビュー @ \(targetTimecode)"
            : "\(presetSummary) 吸着 @ \(targetTimecode)"
        return TimelineTransitionDropMagnetCueModel(
            title: title,
            detail: presetMagnetCueDetail
        )
    }

    private var targetTimecode: String {
        sequence.framesToTimecode(target.boundaryFrame)
    }

    private var magnetCueDetail: String {
        "\(targetTimecode) / \(target.fromClipID) → \(target.toClipID)"
    }

    private var presetMagnetCueDetail: String {
        "離すと適用 / \(targetTimecode) / \(target.fromClipID) → \(target.toClipID)"
    }

    private var durationBadgePreview: TimelineTransitionDurationBadgePreview? {
        guard existingTransition != nil,
              activeDurationFrameDelta != 0,
              let durationFrames = previewTransitionFrames
        else {
            return nil
        }
        return TimelineTransitionDurationBadgePreview(
            deltaFrames: activeDurationFrameDelta,
            durationFrames: durationFrames,
            secondsLabel: String(format: "%.2fs", sequence.framesToSeconds(durationFrames))
        )
    }

    private var previewTransitionFrames: Int? {
        guard let transitionFrames = existingTransition?.transitionFrames else { return nil }
        return max(1, transitionFrames + activeDurationFrameDelta)
    }

    private var helpText: String {
        if previewedTransitionMoveID != nil {
            return "\(target.fromClipID) → \(target.toClipID): \(activeTransitionMoveSummary ?? "トランジション") の移動をプレビュー中。離すと移動"
        }
        if let presetSummary = previewedPresetSummary, existingTransition == nil {
            if isDefaultPresetHoverPreviewing {
                return "\(target.fromClipID) → \(target.toClipID): \(presetSummary) をプレビュー中。クリックで適用"
            }
            return "\(target.fromClipID) → \(target.toClipID): \(presetSummary) をプレビュー中。離すと適用"
        }
        if let preview = durationBadgePreview {
            let delta = preview.deltaFrames > 0 ? "+\(preview.deltaFrames)" : "\(preview.deltaFrames)"
            return "\(target.fromClipID) → \(target.toClipID): 長さ \(preview.durationFrames)f / \(preview.secondsLabel)（\(delta)f）をプレビュー中"
        }
        if let existingTransition {
            let frames = existingTransition.transitionFrames.map { "\($0)f" } ?? "duration unset"
            let durationHelp = isSelected
                ? "選択中は本体の左右領域を横ドラッグで長さ調整"
                : "左右ドラッグで長さ調整"
            return "\(target.fromClipID) → \(target.toClipID): \(existingTransition.transitionType) \(frames)。中央ドラッグで移動、\(durationHelp)"
        }
        if isLanePresetDropTarget, let activePresetDragSummary {
            return "\(target.fromClipID) → \(target.toClipID): \(activePresetDragSummary) の近いドロップ先。レーン上で離すとこの編集点へ吸着"
        }
        if isLaneTransitionMoveTarget {
            return "\(target.fromClipID) → \(target.toClipID): \(activeTransitionMoveSummary ?? "トランジション") の近い移動先。レーン上で離すとこの編集点へ移動"
        }
        if isRecommendedPresetDropTarget, let activePresetDragSummary {
            return "\(target.fromClipID) → \(target.toClipID): \(activePresetDragSummary) の推奨ドロップ先。離すとこの編集点へ吸着"
        }
        if isTransitionMoveCandidateVisible {
            return "\(target.fromClipID) → \(target.toClipID): \(activeTransitionMoveSummary ?? "トランジション") をここへ移動できます"
        }
        if let activePresetDragSummary {
            return "\(target.fromClipID) → \(target.toClipID): \(activePresetDragSummary) をドロップできます"
        }
        return "\(target.fromClipID) → \(target.toClipID) の編集点。クリックで\(TimelineTransitionPreset.defaultPreset.localizedLabel)、またはプリセットをドロップ"
    }

    private var editPointClickGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onEnded { value in
                guard abs(value.translation.width) < 4,
                      abs(value.translation.height) < 4
                else {
                    return
                }
                if existingTransition != nil {
                    selectTransitionIfPresent()
                    return
                }
                guard isInsideVisibleTransitionWell(value.location.x) else { return }
                endDefaultPresetHoverPreviewIfNeeded()
                onApplyTransitionPreset(
                    TimelineTransitionPreset.defaultPreset.id,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
            }
    }

    private var durationDragGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard existingTransition != nil, isDurationDragStart(value.startLocation.x) else { return }
                if !hasBegunDurationDrag {
                    hasBegunDurationDrag = true
                    selectTransitionIfPresent()
                }
                let frameDelta = frameDelta(for: value.translation.width)
                activeDurationFrameDelta = frameDelta
                durationDragTranslation = CGFloat(frameDelta) * max(pixelsPerFrame, 0.1)
                guard frameDelta != 0 else {
                    activeDragRevealFrame = nil
                    onEndTransitionDurationPreview()
                    return
                }
                activeDragRevealFrame = TimelineViewportScale.transitionDurationDragRevealFrame(
                    boundaryFrame: target.boundaryFrame,
                    existingDurationFrames: existingTransition?.transitionFrames ?? 1,
                    frameDelta: frameDelta,
                    totalFrames: totalFrames
                )
                onPreviewTransitionDuration(target.trackID, target.fromClipID, target.toClipID, frameDelta)
            }
            .onEnded { value in
                defer {
                    hasBegunDurationDrag = false
                    activeDurationFrameDelta = 0
                    durationDragTranslation = 0
                    activeDragRevealFrame = nil
                    onEndTransitionDurationPreview()
                }
                guard existingTransition != nil, isDurationDragStart(value.startLocation.x) else { return }
                let frameDelta = frameDelta(for: value.translation.width)
                guard frameDelta != 0 else { return }
                onAdjustTransitionDuration(target.trackID, target.fromClipID, target.toClipID, frameDelta)
            }
    }

    private func frameDelta(for translation: CGFloat) -> Int {
        Int((translation / max(pixelsPerFrame, 0.1)).rounded())
    }

    private func isDurationDragStart(_ x: CGFloat) -> Bool {
        TimelineTransitionDurationDragRegion.allowsDurationDrag(
            startX: Double(x),
            hitAreaWidth: Double(hitAreaWidth),
            displayWidth: Double(displayWidth),
            isSelected: isSelected
        )
    }

    private func isInsideVisibleTransitionWell(_ x: CGFloat) -> Bool {
        let frameWidth = max(hitAreaWidth, displayWidth)
        let visualLeft = max(0, (frameWidth - displayWidth) / 2)
        let visualRight = min(frameWidth, visualLeft + displayWidth)
        return x >= visualLeft && x <= visualRight
    }

    private var canPreviewDefaultPresetOnHover: Bool {
        existingTransition == nil
            && activePresetDragID == nil
            && activeTransitionMoveID == nil
            && !isTargeted
            && !isLanePresetDropTarget
            && !isLaneTransitionMoveTarget
            && !isRecommendedPresetDropTarget
            && previewedTransitionMoveID == nil
            && activeDurationFrameDelta == 0
    }

    private func handleVisibleWellHover(_ isInsideVisibleWell: Bool) {
        isHovering = isInsideVisibleWell
        if isInsideVisibleWell {
            beginDefaultPresetHoverPreviewIfNeeded()
        } else {
            endDefaultPresetHoverPreviewIfNeeded()
        }
    }

    private func beginDefaultPresetHoverPreviewIfNeeded() {
        guard canPreviewDefaultPresetOnHover, !isDefaultPresetHoverPreviewing else { return }
        isDefaultPresetHoverPreviewing = true
        previewedPresetID = TimelineTransitionPreset.defaultPreset.id
        onPreviewDefaultTransitionEditPointHover(
            target.trackID,
            target.fromClipID,
            target.toClipID
        )
    }

    private func endDefaultPresetHoverPreviewIfNeeded() {
        guard isDefaultPresetHoverPreviewing else { return }
        isDefaultPresetHoverPreviewing = false
        guard previewedPresetID == TimelineTransitionPreset.defaultPreset.id else { return }
        previewedPresetID = nil
        onEndTransitionDurationPreview()
    }

    private func selectTransitionIfPresent() {
        guard existingTransition != nil else { return }
        onSelectTransition(target.trackID, target.fromClipID, target.toClipID)
    }

}

private struct TimelineTransitionDropMagnetCueModel {
    let title: String
    let detail: String
}

private struct TimelineTransitionDropCandidateCueModel {
    let label: String
}

private struct TimelineTransitionLaneDropGuideModel {
    let trackID: TimelineTrack.ID
    let title: String
    let detail: String
    let systemImage: String
    let color: Color
}

private struct TimelineTransitionDropSnapIndicatorModel {
    let target: TimelineTransitionDropTargetModel
    let label: String
    let color: Color
    let systemImage: String
}

private struct TimelineTransitionDropSnapIndicator: View {
    let model: TimelineTransitionDropSnapIndicatorModel
    let laneWidth: CGFloat
    let totalFrames: Int
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(model.color.opacity(0.86))
                .frame(width: 2, height: height)
                .shadow(color: model.color.opacity(0.34), radius: 4)
            HStack(spacing: 3) {
                Image(systemName: model.systemImage)
                    .font(.system(size: 8, weight: .bold))
                Text(model.label)
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundStyle(model.color)
            .padding(.horizontal, 5)
            .frame(minWidth: 70, minHeight: 17)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule().stroke(model.color.opacity(0.66), lineWidth: 1)
            }
            .shadow(color: model.color.opacity(0.22), radius: 3, y: 1)
            .offset(x: badgeXOffset, y: -8)
        }
        .offset(x: snapOffset)
        .allowsHitTesting(false)
        .help("\(model.target.fromClipID)→\(model.target.toClipID) の編集点 \(model.label) へ吸着")
        .accessibilityLabel("\(model.target.trackID) transition吸着先 \(model.label) \(model.target.fromClipID) から \(model.target.toClipID)")
        .accessibilityIdentifier("Timeline.TransitionDropSnapIndicator.\(timelineAccessibilitySuffix(model.target.trackID))")
    }

    private var snapOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(model.target.boundaryFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var badgeXOffset: CGFloat {
        let badgeWidth: CGFloat = 86
        if snapOffset + badgeWidth + 8 > laneWidth {
            return -badgeWidth - 8
        }
        return 8
    }
}

private struct TimelineTransitionLaneDropGuide: View {
    let model: TimelineTransitionLaneDropGuideModel
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 4)
                .fill(model.color.opacity(0.055))
                .overlay {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(
                            model.color.opacity(0.44),
                            style: StrokeStyle(lineWidth: 1.2, dash: [8, 5])
                        )
                }
            HStack(spacing: 5) {
                Image(systemName: model.systemImage)
                    .font(.system(size: 9, weight: .bold))
                VStack(alignment: .leading, spacing: 0) {
                    Text(model.title)
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                    Text(model.detail)
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                }
            }
            .foregroundStyle(model.color)
            .padding(.horizontal, 7)
            .frame(width: guideWidth, height: 28, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(model.color.opacity(0.58), lineWidth: 1)
            }
            .shadow(color: model.color.opacity(0.18), radius: 4, y: 1)
            .offset(x: 8, y: max(4, min(8, height * 0.12)))
        }
        .frame(width: width, height: height)
        .allowsHitTesting(false)
        .help("\(model.trackID): \(model.detail)")
        .accessibilityLabel("\(model.trackID) \(model.title)。\(model.detail)")
        .accessibilityIdentifier("Timeline.TransitionLaneDropGuide.\(timelineAccessibilitySuffix(model.trackID))")
    }

    private var guideWidth: CGFloat {
        let preferred = max(260, width * 0.50)
        let available = max(72, width - 12)
        return min(preferred, available)
    }
}

private struct TimelineTransitionDropCandidateCue: View {
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "magnet")
                .font(.system(size: 8, weight: .bold))
            Text(label)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 5)
        .frame(width: 166, height: 18)
        .background(.regularMaterial, in: Capsule())
        .overlay {
            Capsule().stroke(color.opacity(0.50), lineWidth: 1)
        }
        .shadow(color: color.opacity(0.18), radius: 3, y: 1)
        .accessibilityLabel("\(label) をドロップできます")
        .accessibilityIdentifier("Timeline.TransitionDropCandidateCue")
    }
}

private struct TimelineTransitionDropMagnetCue: View {
    let title: String
    let detail: String
    let color: Color
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .top) {
            Rectangle()
                .fill(color.opacity(0.88))
                .frame(width: 2, height: height)
                .shadow(color: color.opacity(0.42), radius: 4)
                .offset(y: 10)
            HStack(spacing: 5) {
                Image(systemName: "magnet")
                    .font(.system(size: 9, weight: .bold))
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.68)
                    Text(detail)
                        .font(.system(size: 8, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.76)
                }
                Image(systemName: "arrow.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .padding(.horizontal, 7)
            .frame(width: 266, height: 25, alignment: .leading)
            .foregroundStyle(color)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(color.opacity(0.62), lineWidth: 1)
            }
            .shadow(color: color.opacity(0.22), radius: 4, y: 1)
        }
        .frame(width: 268, height: height + 28)
        .accessibilityLabel("\(title) \(detail)")
        .accessibilityIdentifier("Timeline.TransitionDropMagnetCue")
    }
}

private struct TimelineTransitionLandingGuide: View {
    var width: CGFloat
    var height: CGFloat
    var color: Color
    var isActive: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7)
                .fill(color.opacity(isActive ? 0.10 : 0.045))
            RoundedRectangle(cornerRadius: 7)
                .stroke(
                    color.opacity(isActive ? 0.42 : 0.22),
                    style: StrokeStyle(lineWidth: isActive ? 1.2 : 1, dash: [5, 4])
                )
            Capsule()
                .fill(color.opacity(isActive ? 0.32 : 0.16))
                .frame(width: max(12, width - 16), height: isActive ? 4 : 2)
            HStack {
                landingBracket
                Spacer(minLength: 8)
                landingBracket
            }
            .padding(.horizontal, 8)
        }
        .frame(width: width, height: height)
        .accessibilityIdentifier("Timeline.TransitionLandingGuide")
    }

    private var landingBracket: some View {
        VStack(spacing: 2) {
            Capsule()
                .fill(color.opacity(isActive ? 0.58 : 0.34))
                .frame(width: 3, height: 8)
            Capsule()
                .fill(color.opacity(isActive ? 0.42 : 0.22))
                .frame(width: 11, height: 2)
        }
    }
}

private struct TimelineTransitionDurationGrip: View {
    var width: CGFloat
    var color: Color
    var isActive: Bool

    var body: some View {
        HStack {
            grip
            Spacer(minLength: 4)
            grip
        }
        .frame(width: max(24, width + 12), height: 30)
        .accessibilityIdentifier("Timeline.TransitionDurationGrip")
    }

    private var grip: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(color.opacity(isActive ? 0.72 : 0.36))
            .frame(width: 3, height: isActive ? 24 : 18)
            .overlay {
                RoundedRectangle(cornerRadius: 1.5)
                    .stroke(Color.primary.opacity(isActive ? 0.18 : 0.08), lineWidth: 0.5)
            }
    }
}

private struct TimelineTransitionMoveHandle: View {
    var color: Color
    var isActive: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(.regularMaterial)
            Circle()
                .stroke(color.opacity(isActive ? 0.78 : 0.48), lineWidth: isActive ? 1.2 : 1)
            Image(systemName: "arrow.left.and.right")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(color.opacity(isActive ? 0.95 : 0.72))
        }
        .frame(width: 20, height: 20)
        .shadow(color: color.opacity(isActive ? 0.20 : 0.08), radius: isActive ? 4 : 2, y: 1)
        .accessibilityIdentifier("Timeline.TransitionMoveHandle")
    }
}

private struct TimelineTransitionDurationBadgePreview {
    let deltaFrames: Int
    let durationFrames: Int
    let secondsLabel: String
}

private struct TimelineTransitionDurationPreviewBadge: View {
    let deltaFrames: Int
    let durationFrames: Int
    let secondsLabel: String
    let color: Color

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.left.and.right")
                .font(.system(size: 8, weight: .bold))
            Text(deltaLabel)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
            Text("\(durationFrames)f")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
            Text(secondsLabel)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .foregroundStyle(color)
        .padding(.horizontal, 7)
        .frame(minWidth: 118, minHeight: 20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(color.opacity(0.44), lineWidth: 1)
        }
        .shadow(color: color.opacity(0.20), radius: 4, y: 1)
        .accessibilityLabel("トランジション長さ \(durationFrames) フレーム、\(secondsLabel)、\(deltaLabel)")
        .accessibilityIdentifier("Timeline.TransitionDurationPreviewBadge")
    }

    private var deltaLabel: String {
        deltaFrames > 0 ? "+\(deltaFrames)f" : "\(deltaFrames)f"
    }
}

private enum TimelineTransitionDragPayload: Equatable {
    case preset(String)
    case transition(TimelineTransition.ID)
}

private struct TimelineTransitionDropDelegate: DropDelegate {
    let target: TimelineTransitionDropTargetModel
    @Binding var isTargeted: Bool
    @Binding var previewedPresetID: String?
    @Binding var previewedTransitionMoveID: TimelineTransition.ID?
    var onApplyTransitionPreset: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionPresetDrop: (String, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onPreviewTransitionMove: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onMoveTransition: (TimelineTransition.ID, TimelineTrack.ID, TimelineClip.ID, TimelineClip.ID) -> Void
    var onEndTransitionDropPreview: () -> Void
    var onEndTransitionPresetDrag: () -> Void
    var onEndTransitionMoveDrag: () -> Void

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [UTType.plainText])
    }

    func dropEntered(info: DropInfo) {
        isTargeted = true
        loadPayload(from: info) { payload in
            preview(payload)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        if previewedPresetID == nil && previewedTransitionMoveID == nil {
            loadPayload(from: info) { payload in
                preview(payload)
            }
        }
        return DropProposal(operation: previewedTransitionMoveID == nil ? .copy : .move)
    }

    func dropExited(info: DropInfo) {
        isTargeted = false
        previewedPresetID = nil
        previewedTransitionMoveID = nil
        onEndTransitionDropPreview()
    }

    func performDrop(info: DropInfo) -> Bool {
        isTargeted = false
        loadPayload(from: info) { payload in
            switch payload {
            case .preset(let presetID):
                onApplyTransitionPreset(
                    presetID,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
                onEndTransitionPresetDrag()
            case .transition(let transitionID):
                guard transitionID != target.transitionID else {
                    clearPreview()
                    onEndTransitionMoveDrag()
                    return
                }
                onMoveTransition(
                    transitionID,
                    target.trackID,
                    target.fromClipID,
                    target.toClipID
                )
                onEndTransitionMoveDrag()
            }
            clearPreview()
        }
        return true
    }

    private func preview(_ payload: TimelineTransitionDragPayload) {
        switch payload {
        case .preset(let presetID):
            guard previewedPresetID != presetID || previewedTransitionMoveID != nil else { return }
            previewedTransitionMoveID = nil
            previewedPresetID = presetID
            onPreviewTransitionPresetDrop(
                presetID,
                target.trackID,
                target.fromClipID,
                target.toClipID
            )
        case .transition(let transitionID):
            guard transitionID != target.transitionID else {
                clearPreview()
                return
            }
            guard previewedTransitionMoveID != transitionID || previewedPresetID != nil else { return }
            previewedPresetID = nil
            previewedTransitionMoveID = transitionID
            onPreviewTransitionMove(
                transitionID,
                target.trackID,
                target.fromClipID,
                target.toClipID
            )
        }
    }

    private func clearPreview() {
        previewedPresetID = nil
        previewedTransitionMoveID = nil
        onEndTransitionDropPreview()
    }

    private func loadPayload(from info: DropInfo, completion: @escaping (TimelineTransitionDragPayload) -> Void) {
        guard let provider = info.itemProviders(for: [UTType.plainText]).first else {
            return
        }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let text = (object as? NSString).map(String.init) else { return }
            let payload: TimelineTransitionDragPayload?
            if let transitionID = StudioDragPayload.parseTransition(text) {
                payload = .transition(transitionID)
            } else if let presetID = StudioDragPayload.parseTransitionPresetID(text) {
                payload = .preset(presetID)
            } else {
                payload = nil
            }
            guard let payload else { return }
            DispatchQueue.main.async {
                completion(payload)
            }
        }
    }
}

private struct TimelineBladeClickOverlay: View {
    var clipID: TimelineClip.ID
    var onSplitAtLocalX: (CGFloat) -> Void

    var body: some View {
        GeometryReader { proxy in
            Rectangle()
                .fill(Color.clear)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0, coordinateSpace: .local)
                        .onEnded { value in
                            let translation = value.translation
                            guard abs(translation.width) < 4, abs(translation.height) < 4 else { return }
                            onSplitAtLocalX(max(0, min(value.location.x, proxy.size.width)))
                        }
                )
                .help("ブレード: クリック位置で \(clipID) を分割")
                .accessibilityLabel("ブレードでクリップを分割")
                .accessibilityValue(clipID)
                .accessibilityIdentifier("Timeline.BladeOverlay.\(timelineAccessibilitySuffix(clipID))")
        }
        .allowsHitTesting(true)
    }
}

private struct TimelineRollHandleOverlay: View {
    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var sequence: TimelineSequence
    var clipWidth: CGFloat
    var laneWidth: CGFloat
    var totalFrames: Int
    var incomingPreview: TimelineRollTrimPlan?
    var outgoingPreview: TimelineRollTrimPlan?
    var canRollIncoming: Bool
    var canRollOutgoing: Bool
    var onPreviewRoll: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void
    var onEndRollPreview: () -> Void
    var onDragRoll: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void

    var body: some View {
        ZStack(alignment: .top) {
            if canRollIncoming {
                TimelineRollHandle(
                    trackID: trackID,
                    clip: clip,
                    sequence: sequence,
                    boundary: .incoming,
                    laneWidth: laneWidth,
                    totalFrames: totalFrames,
                    preview: incomingPreview,
                    onPreviewRoll: onPreviewRoll,
                    onEndRollPreview: onEndRollPreview,
                    onDragRoll: onDragRoll
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .offset(x: -26, y: -13)
            }

            if canRollOutgoing {
                TimelineRollHandle(
                    trackID: trackID,
                    clip: clip,
                    sequence: sequence,
                    boundary: .outgoing,
                    laneWidth: laneWidth,
                    totalFrames: totalFrames,
                    preview: outgoingPreview,
                    onPreviewRoll: onPreviewRoll,
                    onEndRollPreview: onEndRollPreview,
                    onDragRoll: onDragRoll
                )
                .frame(maxWidth: .infinity, alignment: .trailing)
                .offset(x: 26, y: -13)
            }
        }
        .frame(width: clipWidth, height: 38, alignment: .top)
    }
}

private struct TimelineRollHandle: View {
    @State private var isHovering = false
    @State private var dragTranslation: CGFloat = 0

    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var sequence: TimelineSequence
    var boundary: TimelineRollTrimBoundary
    var laneWidth: CGFloat
    var totalFrames: Int
    var preview: TimelineRollTrimPlan?
    var onPreviewRoll: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void
    var onEndRollPreview: () -> Void
    var onDragRoll: (TimelineClip.ID, TimelineRollTrimBoundary, Int) -> Void

    var body: some View {
        ZStack(alignment: .top) {
            if let preview {
                TimelineRollPreviewBadge(plan: preview, sequence: sequence)
                    .offset(y: -20)
                    .zIndex(2)
            }

            HStack(spacing: 4) {
                Image(systemName: "arrow.left.and.right")
                    .font(.system(size: 8, weight: .bold))
                Text("ROLL")
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .foregroundStyle(.purple)
            .padding(.horizontal, 6)
            .frame(width: 58, height: 18)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule()
                    .stroke(Color.purple.opacity(isHovering || preview != nil ? 0.86 : 0.55), lineWidth: isHovering || preview != nil ? 1.2 : 0.8)
            }
            .shadow(color: Color.purple.opacity(isHovering || preview != nil ? 0.24 : 0.10), radius: 3, y: 1)
            .offset(x: dragTranslation * 0.08)
            .contentShape(Capsule())
            .gesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { value in
                        dragTranslation = value.translation.width
                        let frameDelta = frameDelta(for: value.translation.width)
                        guard frameDelta != 0 else {
                            onEndRollPreview()
                            return
                        }
                        onPreviewRoll(clip.id, boundary, frameDelta)
                    }
                    .onEnded { value in
                        defer {
                            dragTranslation = 0
                            onEndRollPreview()
                        }
                        let frameDelta = frameDelta(for: value.translation.width)
                        guard frameDelta != 0 else { return }
                        onDragRoll(clip.id, boundary, frameDelta)
                    }
            )
            .onHover { isHovering = $0 }
            .help(helpText)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier("Timeline.RollHandle.\(boundaryAccessibilityLabel).\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clip.id))")
        }
        .frame(width: 120, height: 38)
    }

    private var boundaryAccessibilityLabel: String {
        boundary == .incoming ? "Incoming" : "Outgoing"
    }

    private var accessibilityLabel: String {
        boundary == .incoming
            ? "\(clip.id) の前編集点ロールハンドル"
            : "\(clip.id) の次編集点ロールハンドル"
    }

    private var helpText: String {
        boundary == .incoming
            ? "左右へドラッグして前の編集点をロール。左右のclip尺を保ちながら境界を移動します。"
            : "左右へドラッグして次の編集点をロール。左右のclip尺を保ちながら境界を移動します。"
    }

    private func frameDelta(for translation: CGFloat) -> Int {
        let width = max(laneWidth, 1)
        let frames = CGFloat(max(totalFrames, 1))
        return Int(((translation / width) * frames).rounded())
    }
}

private struct TimelineRollPreviewBadge: View {
    var plan: TimelineRollTrimPlan
    var sequence: TimelineSequence

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.left.and.right")
                .font(.system(size: 8, weight: .bold))
            Text(directionLabel)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
            Text("\(plan.shiftFrames)f")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
            Text(secondsLabel)
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .padding(.horizontal, 6)
        .frame(width: 126, height: 18, alignment: .leading)
        .foregroundStyle(.purple)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.purple.opacity(0.68), lineWidth: 1)
        }
        .shadow(color: Color.purple.opacity(0.20), radius: 3, y: 1)
        .help("編集点を\(directionLabel)へ \(plan.shiftFrames) フレームロール")
        .accessibilityIdentifier("Timeline.RollPreviewBadge.\(timelineAccessibilitySuffix(plan.trackID)).\(timelineAccessibilitySuffix(plan.leftClipID)).\(timelineAccessibilitySuffix(plan.rightClipID))")
    }

    private var directionLabel: String {
        plan.direction == .left ? "CUT←" : "CUT→"
    }

    private var secondsLabel: String {
        String(format: "%.1fs", sequence.framesToSeconds(plan.shiftFrames))
    }
}

private extension TimelineRollTrimPlan {
    func clipIDPairIncludes(_ clipID: TimelineClip.ID) -> Bool {
        leftClipID == clipID || rightClipID == clipID
    }
}

private struct TimelineSlipHandleOverlay: View {
    @State private var isHovering = false
    @State private var dragTranslation: CGFloat = 0

    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var clipWidth: CGFloat
    var laneWidth: CGFloat
    var totalFrames: Int
    var preview: TimelineSlipTrimPlan?
    var onPreviewSlip: (TimelineClip.ID, Int) -> Void
    var onEndSlipPreview: () -> Void
    var onDragSlip: (TimelineClip.ID, Int) -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            if let preview {
                TimelineSlipPreviewBadge(plan: preview)
                    .offset(y: -18)
                    .zIndex(2)
            }

            HStack(spacing: 4) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 8, weight: .bold))
                Text("SLIP")
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .foregroundStyle(.cyan)
            .padding(.horizontal, 6)
            .frame(width: controlWidth, height: 18)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule()
                    .stroke(Color.cyan.opacity(isHovering || preview != nil ? 0.88 : 0.55), lineWidth: isHovering || preview != nil ? 1.2 : 0.8)
            }
            .shadow(color: Color.cyan.opacity(isHovering || preview != nil ? 0.24 : 0.10), radius: 3, y: 1)
            .offset(x: dragTranslation * 0.10)
            .contentShape(Capsule())
            .gesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { value in
                        dragTranslation = value.translation.width
                        let frameDelta = frameDelta(for: value.translation.width)
                        guard frameDelta != 0 else {
                            onEndSlipPreview()
                            return
                        }
                        onPreviewSlip(clip.id, frameDelta)
                    }
                    .onEnded { value in
                        defer {
                            dragTranslation = 0
                            onEndSlipPreview()
                        }
                        let frameDelta = frameDelta(for: value.translation.width)
                        guard frameDelta != 0 else { return }
                        onDragSlip(clip.id, frameDelta)
                    }
            )
            .onHover { isHovering = $0 }
            .help("左右へドラッグして、タイムライン上の位置と尺を保ったまま素材範囲をスリップ")
            .accessibilityLabel("\(clip.id) の素材範囲スリップハンドル")
            .accessibilityIdentifier("Timeline.SlipHandle.\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clip.id))")
        }
        .frame(width: clipWidth, height: 32, alignment: .bottom)
    }

    private var controlWidth: CGFloat {
        min(86, max(50, clipWidth * 0.56))
    }

    private func frameDelta(for translation: CGFloat) -> Int {
        let width = max(laneWidth, 1)
        let frames = CGFloat(max(totalFrames, 1))
        return Int(((translation / width) * frames).rounded())
    }
}

private struct TimelineSlipPreviewBadge: View {
    var plan: TimelineSlipTrimPlan

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.left.arrow.right")
                .font(.system(size: 8, weight: .bold))
            Text(directionLabel)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
            Text("\(plan.shiftFrames)f")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
            Text(secondsLabel)
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .padding(.horizontal, 6)
        .frame(width: 120, height: 18, alignment: .leading)
        .foregroundStyle(.cyan)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 5))
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(Color.cyan.opacity(0.68), lineWidth: 1)
        }
        .shadow(color: Color.cyan.opacity(0.20), radius: 3, y: 1)
        .help("素材範囲を\(directionLabel)へ \(plan.shiftFrames) フレームスリップ")
        .accessibilityIdentifier("Timeline.SlipPreviewBadge.\(timelineAccessibilitySuffix(plan.clipID))")
    }

    private var directionLabel: String {
        plan.direction == .left ? "SRC←" : "SRC→"
    }

    private var secondsLabel: String {
        String(format: "%.1fs", Double(plan.shiftUS) / 1_000_000)
    }
}

private struct TimelineTrimHandleOverlay: View {
    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var clipWidth: CGFloat
    var laneWidth: CGFloat
    var totalFrames: Int
    var snapThresholdFrames: Int
    var onPreviewTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int) -> Void
    var onEndTrimPreview: () -> Void
    var onDragTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int, Int) -> Void

    var body: some View {
        ZStack {
            TimelineTrimHandle(
                edge: .start,
                trackID: trackID,
                clip: clip,
                laneWidth: laneWidth,
                totalFrames: totalFrames,
                snapThresholdFrames: snapThresholdFrames,
                onPreviewTrim: onPreviewTrim,
                onEndTrimPreview: onEndTrimPreview,
                onDragTrim: onDragTrim
            )
            .frame(maxWidth: .infinity, alignment: .leading)

            TimelineTrimHandle(
                edge: .end,
                trackID: trackID,
                clip: clip,
                laneWidth: laneWidth,
                totalFrames: totalFrames,
                snapThresholdFrames: snapThresholdFrames,
                onPreviewTrim: onPreviewTrim,
                onEndTrimPreview: onEndTrimPreview,
                onDragTrim: onDragTrim
            )
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(width: clipWidth, height: 30)
        .allowsHitTesting(true)
    }
}

private struct TimelineTrimHandle: View {
    @State private var isHovering = false

    var edge: TimelinePlayheadTrimEdge
    var trackID: TimelineTrack.ID
    var clip: TimelineClip
    var laneWidth: CGFloat
    var totalFrames: Int
    var snapThresholdFrames: Int
    var onPreviewTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int) -> Void
    var onEndTrimPreview: () -> Void
    var onDragTrim: (TimelineClip.ID, TimelinePlayheadTrimEdge, Int, Int) -> Void

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.clear)
                .frame(width: 18, height: 30)
            RoundedRectangle(cornerRadius: 2)
                .fill(isHovering ? Color.accentColor : Color.white.opacity(0.86))
                .frame(width: 6, height: 24)
                .overlay {
                    RoundedRectangle(cornerRadius: 2)
                        .stroke(Color.accentColor.opacity(0.95), lineWidth: 1)
                }
                .shadow(color: .black.opacity(isHovering ? 0.24 : 0.12), radius: 2, y: 1)
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 3)
                .onChanged { value in
                    let frameDelta = frameDelta(for: value.translation.width)
                    guard frameDelta != 0 else {
                        onEndTrimPreview()
                        return
                    }
                    onPreviewTrim(clip.id, edge, frameDelta)
                }
                .onEnded { value in
                    defer { onEndTrimPreview() }
                    let frameDelta = frameDelta(for: value.translation.width)
                    guard frameDelta != 0 else { return }
                    onDragTrim(clip.id, edge, frameDelta, snapThresholdFrames)
                }
        )
        .onHover { isHovering = $0 }
        .help(helpText)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("Timeline.TrimHandle.\(accessibilityEdgeLabel).\(timelineAccessibilitySuffix(trackID)).\(timelineAccessibilitySuffix(clip.id))")
    }

    private var accessibilityEdgeLabel: String {
        edge == .start ? "Start" : "End"
    }

    private var accessibilityLabel: String {
        edge == .start
            ? "\(clip.id) の先頭トリムハンドル"
            : "\(clip.id) の末尾トリムハンドル"
    }

    private var helpText: String {
        edge == .start
            ? "左右へドラッグして選択クリップの先頭を詰める/伸ばす"
            : "左右へドラッグして選択クリップの末尾を詰める/伸ばす"
    }

    private func frameDelta(for translation: CGFloat) -> Int {
        let width = max(laneWidth, 1)
        let frames = CGFloat(max(totalFrames, 1))
        return Int(((translation / width) * frames).rounded())
    }
}

enum TimelineClipMovePreviewRole: Equatable {
    case none
    case target
    case liftedTarget
    case displaced
}

struct TimelineClipFeedbackState: Equatable {
    var isApproved: Bool
    var isRejected: Bool
    var isPendingSwap: Bool
    var isPendingTrim: Bool
    var isPendingMove: Bool
    var isPendingSplit: Bool
    var isPendingRemove: Bool
    var isRecentlyChanged: Bool

    static let none = TimelineClipFeedbackState(
        isApproved: false,
        isRejected: false,
        isPendingSwap: false,
        isPendingTrim: false,
        isPendingMove: false,
        isPendingSplit: false,
        isPendingRemove: false,
        isRecentlyChanged: false
    )
}

private struct TimelineClipTrimAffordance: View {
    var clipID: TimelineClip.ID
    var color: Color
    var isActive: Bool
    var isPreviewing: Bool
    var trackDensity: TimelineTrackDensity

    var body: some View {
        HStack {
            grip
                .frame(maxHeight: .infinity, alignment: .center)
            Spacer(minLength: 0)
            grip
                .frame(maxHeight: .infinity, alignment: .center)
        }
        .padding(.horizontal, 2)
        .accessibilityIdentifier("Timeline.ClipTrimAffordance.\(timelineAccessibilitySuffix(clipID))")
    }

    private var grip: some View {
        VStack(spacing: 2) {
            Capsule()
                .fill(color.opacity(isActive ? 0.78 : 0.42))
                .frame(width: gripCapWidth, height: 2)
            RoundedRectangle(cornerRadius: 2)
                .fill(color.opacity(isActive ? 0.95 : 0.58))
                .frame(width: gripStemWidth, height: gripStemHeight)
            Capsule()
                .fill(color.opacity(isActive ? 0.78 : 0.42))
                .frame(width: gripCapWidth, height: 2)
        }
        .frame(width: gripContainerWidth, height: gripContainerHeight)
        .background(
            color.opacity(isActive ? 0.12 : 0.06),
            in: RoundedRectangle(cornerRadius: 4)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 4)
                .stroke(
                    color.opacity(isPreviewing ? 0.70 : (isActive ? 0.46 : 0.24)),
                    lineWidth: isActive ? 1 : 0.7
                )
        }
    }

    private var gripStemHeight: CGFloat {
        switch trackDensity {
        case .compact: return isActive ? 16 : 13
        case .standard: return isActive ? 21 : 17
        case .expanded: return isActive ? 25 : 20
        }
    }

    private var gripContainerHeight: CGFloat {
        switch trackDensity {
        case .compact: return 22
        case .standard: return 26
        case .expanded: return 30
        }
    }

    private var gripCapWidth: CGFloat {
        isActive ? 8 : 6
    }

    private var gripStemWidth: CGFloat {
        isActive ? 5 : 4
    }

    private var gripContainerWidth: CGFloat {
        isActive ? 13 : 11
    }
}

private struct TimelineClipViewerActiveCue: View {
    var clipID: TimelineClip.ID
    var trackKind: TimelineTrackKind

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.accentColor.opacity(0.88))
                .frame(height: 3)
                .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .overlay(alignment: .topLeading) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 15, height: 15)
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle().stroke(Color.accentColor.opacity(0.62), lineWidth: 0.8)
                }
                .padding(2)
        }
        .allowsHitTesting(false)
        .accessibilityLabel("Viewer参照中")
        .accessibilityIdentifier("Timeline.Clip.ViewerActiveCue.\(timelineAccessibilitySuffix(clipID))")
    }

    private var systemImage: String {
        trackKind == .audio ? "speaker.wave.2.fill" : "play.fill"
    }
}

private struct TimelineClipThumbnailStrip: View {
    var url: URL
    var clipID: TimelineClip.ID
    var roleColor: Color
    var isEmphasized: Bool

    var body: some View {
        GeometryReader { proxy in
            let cellCount = TimelineViewportScale.thumbnailCellCount(clipWidth: Double(proxy.size.width))
            if let image, cellCount > 0 {
                let dividerCount = max(0, cellCount - 1)
                let cellWidth = max(1, (proxy.size.width - CGFloat(dividerCount)) / CGFloat(cellCount))

                HStack(spacing: 1) {
                    ForEach(0..<cellCount, id: \.self) { _ in
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: cellWidth, height: proxy.size.height)
                            .clipped()
                    }
                }
                .overlay(Color.black.opacity(isEmphasized ? 0.16 : 0.22))
                .overlay(roleColor.opacity(isEmphasized ? 0.08 : 0.13))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        }
        .allowsHitTesting(false)
        .accessibilityIdentifier("Timeline.ClipThumbnailStrip.\(timelineAccessibilitySuffix(clipID))")
    }

    private var image: NSImage? {
        NSImage(contentsOf: url)
    }
}

struct TimelineClipBlock: View {
    @State private var isHovering = false

    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var trackDensity: TimelineTrackDensity = .standard
    var isSelected: Bool
    var isUnderPlayhead: Bool
    var isViewerActive = false
    var isWidthExpanded: Bool = false
    var isTrimEligible = false
    var showsActiveTrimHandles = false
    var feedbackState: TimelineClipFeedbackState = .none
    var movePreviewRole: TimelineClipMovePreviewRole = .none
    var isTrimPreviewing = false
    var isBodyDragActive = false
    var isSkimPreviewing = false
    var isBladeModeActive = false
    var thumbnailURL: URL? = nil
    var timingMetadataLabel: String? = nil

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .fill(color.opacity(fillOpacity))
                .opacity(feedbackState.isRejected ? 0.30 : 1)

            if let thumbnailURL, shouldShowThumbnailStrip {
                TimelineClipThumbnailStrip(
                    url: thumbnailURL,
                    clipID: clip.id,
                    roleColor: color,
                    isEmphasized: isHovering || isSelected || isUnderPlayhead || isViewerActive || isBodyDragActive
                )
                .opacity(thumbnailStripOpacity)
            }

            RoundedRectangle(cornerRadius: 4)
                .stroke(borderColor, lineWidth: borderLineWidth)

            if isInteractionCued {
                Capsule()
                    .fill(interactionColor.opacity(isBodyDragActive ? 0.90 : 0.66))
                    .frame(width: 3, height: 18)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .padding(.leading, 3)
            }

            if shouldShowTrimAffordance {
                TimelineClipTrimAffordance(
                    clipID: clip.id,
                    color: trimAffordanceColor,
                    isActive: showsActiveTrimHandles || isTrimPreviewing,
                    isPreviewing: isTrimPreviewing,
                    trackDensity: trackDensity
                )
            }

            if feedbackState.isPendingRemove {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.red.opacity(0.85), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }

            if feedbackState.isRecentlyChanged {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.blue.opacity(0.85), lineWidth: 2)
            }

            if movePreviewRole != .none {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(
                        movePreviewColor,
                        style: StrokeStyle(
                            lineWidth: 2,
                            dash: movePreviewRole == .displaced ? [5, 3] : []
                        )
                    )
                    .shadow(color: movePreviewColor.opacity(0.28), radius: 4)
            }

            if isTrimPreviewing {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.orange.opacity(0.95), lineWidth: 2)
                    .shadow(color: Color.orange.opacity(0.30), radius: 4)
            }

            if isSkimPreviewing {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.cyan.opacity(0.90), lineWidth: 1.6)
                    .shadow(color: Color.cyan.opacity(0.22), radius: 4)
            }

            if isBladeModeActive {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(
                        Color.orange.opacity(0.88),
                        style: StrokeStyle(lineWidth: 1.8, dash: [5, 3])
                    )
                    .shadow(color: Color.orange.opacity(0.22), radius: 4)
            }

            if isViewerActive {
                TimelineClipViewerActiveCue(
                    clipID: clip.id,
                    trackKind: trackKind
                )
            }

            HStack(spacing: 4) {
                VStack(alignment: .leading, spacing: 1) {
                    roleBadge
                    if trackDensity != .compact {
                        Text(clipBlockSubtitle)
                            .font(.system(size: trackDensity == .expanded ? 10 : 9, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .minimumScaleFactor(isWidthExpanded ? 0.6 : 1)
                            .truncationMode(.tail)
                    }
                }
                .lineLimit(1)
                .foregroundStyle(.primary)

                Spacer(minLength: 2)

                feedbackIcons
            }
            .padding(.horizontal, 6)

            if movePreviewRole != .none {
                Image(systemName: movePreviewIcon)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(movePreviewColor)
                    .frame(width: 16, height: 16)
                    .background(.regularMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(movePreviewColor.opacity(0.65), lineWidth: 1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(3)
            }

            if isTrimPreviewing {
                Image(systemName: "scissors")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.orange)
                    .frame(width: 16, height: 16)
                    .background(.regularMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(Color.orange.opacity(0.70), lineWidth: 1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(3)
            }

            if isSkimPreviewing {
                Image(systemName: "viewfinder")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.cyan)
                    .frame(width: 16, height: 16)
                    .background(.regularMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(Color.cyan.opacity(0.68), lineWidth: 1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(3)
                    .accessibilityIdentifier("Timeline.ClipSkimCue.\(timelineAccessibilitySuffix(clip.id))")
            }

            if isBladeModeActive {
                Image(systemName: "scissors")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.orange)
                    .frame(width: 16, height: 16)
                    .background(.regularMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(Color.orange.opacity(0.72), lineWidth: 1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(3)
                    .accessibilityIdentifier("Timeline.BladeCue.\(timelineAccessibilitySuffix(clip.id))")
            }

            if canShowInteractionCue {
                Image(systemName: isBodyDragActive ? "hand.raised.fill" : "hand.draw")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(interactionColor)
                    .frame(width: 16, height: 16)
                    .background(.regularMaterial, in: Circle())
                    .overlay {
                        Circle().stroke(interactionColor.opacity(0.62), lineWidth: 1)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(3)
                    .accessibilityIdentifier("Timeline.ClipDragCue.\(timelineAccessibilitySuffix(clip.id))")
            }

            if let timingMetadataLabel, shouldShowTimingMetadata {
                Text(timingMetadataLabel)
                    .font(.system(size: trackDensity == .expanded ? 9 : 8, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(.regularMaterial, in: Capsule())
                    .overlay {
                        Capsule().stroke(borderColor.opacity(0.55), lineWidth: 0.8)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(.leading, 6)
                    .padding(.bottom, 3)
                    .accessibilityIdentifier("Timeline.Clip.TimingMetadata.\(timelineAccessibilitySuffix(clip.id))")
            }
        }
        .scaleEffect(isBodyDragActive ? 1.018 : (isHovering ? 1.008 : 1), anchor: .center)
        .shadow(
            color: clipShadowColor,
            radius: clipShadowRadius,
            y: clipShadowYOffset
        )
        .animation(.easeOut(duration: 5.0), value: feedbackState.isRecentlyChanged)
        .animation(.easeOut(duration: 0.12), value: isHovering)
        .animation(.easeOut(duration: 0.12), value: isBodyDragActive)
        .animation(.easeOut(duration: 0.12), value: showsActiveTrimHandles)
        .animation(.easeOut(duration: 0.12), value: isSkimPreviewing)
        .animation(.easeOut(duration: 0.12), value: isBladeModeActive)
        .onHover { isHovering = $0 }
        .help(helpText)
        .accessibilityElement(children: .combine)
    }

    private var fillOpacity: Double {
        if isSkimPreviewing { return trackKind == .audio ? 0.86 : 0.96 }
        if isBodyDragActive || movePreviewRole != .none { return 0.98 }
        if isUnderPlayhead { return 0.98 }
        if isHovering || isSelected { return trackKind == .audio ? 0.82 : 0.92 }
        return trackKind == .audio ? 0.70 : 0.82
    }

    private var shouldShowThumbnailStrip: Bool {
        trackKind == .video || trackKind == .overlay
    }

    private var thumbnailStripOpacity: Double {
        if feedbackState.isRejected { return 0.30 }
        if isBodyDragActive || movePreviewRole != .none { return 0.58 }
        if isHovering || isSelected || isUnderPlayhead || isViewerActive { return 0.50 }
        return 0.42
    }

    private var roleFont: Font {
        switch trackDensity {
        case .compact:
            return .system(size: 10, weight: .semibold)
        case .standard:
            return .caption2.weight(.semibold)
        case .expanded:
            return .caption.weight(.semibold)
        }
    }

    private var roleBadge: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(roleAccentColor.opacity(0.95))
                .frame(width: roleDotSize, height: roleDotSize)
            Text(roleBadgeLabel)
                .font(roleFont)
                .lineLimit(1)
                .minimumScaleFactor(isWidthExpanded ? 0.65 : 1)
        }
        .padding(.horizontal, roleBadgeHorizontalPadding)
        .frame(height: roleBadgeHeight)
        .background(Color.primary.opacity(0.10), in: Capsule())
        .overlay {
            Capsule().stroke(roleAccentColor.opacity(0.55), lineWidth: 0.8)
        }
        .accessibilityIdentifier("Timeline.Clip.RoleBadge.\(timelineAccessibilitySuffix(clip.id))")
    }

    private var roleBadgeLabel: String {
        if trackKind == .caption {
            return "字幕"
        }
        return isWidthExpanded ? timelineClipRoleAbbreviation(clip.role) : localizedClipRole(clip.role)
    }

    private var roleBadgeHeight: CGFloat {
        switch trackDensity {
        case .compact: return 15
        case .standard: return 16
        case .expanded: return 18
        }
    }

    private var roleBadgeHorizontalPadding: CGFloat {
        isWidthExpanded ? 4 : 5
    }

    private var roleDotSize: CGFloat {
        trackDensity == .expanded ? 6 : 5
    }

    private var roleAccentColor: Color {
        timelineClipRoleColor(role: clip.role, trackKind: trackKind)
    }

    private var color: Color {
        roleAccentColor
    }

    private var borderColor: Color {
        if feedbackState.isApproved {
            return .green
        }
        if isViewerActive {
            return .accentColor
        }
        if isBladeModeActive {
            return .orange
        }
        if isBodyDragActive {
            return .accentColor
        }
        if isSelected {
            return .accentColor
        }
        if isHovering {
            return Color.primary.opacity(0.45)
        }
        if isUnderPlayhead {
            return Color.primary.opacity(0.45)
        }
        return .clear
    }

    private var borderLineWidth: CGFloat {
        if isBladeModeActive { return 1.8 }
        if isBodyDragActive { return 2.2 }
        if isViewerActive { return 1.8 }
        if isHovering { return 1.4 }
        return feedbackState.isApproved || isSelected ? 2 : 1
    }

    private var isInteractionCued: Bool {
        isHovering || isSelected || isBodyDragActive || movePreviewRole != .none || isTrimPreviewing || isBladeModeActive
    }

    private var canShowInteractionCue: Bool {
        (isHovering || isSelected || isBodyDragActive)
            && movePreviewRole == .none
            && !isTrimPreviewing
            && !isBladeModeActive
            && !feedbackState.isPendingRemove
    }

    private var shouldShowTimingMetadata: Bool {
        timingMetadataLabel != nil
            && trackDensity != .compact
            && (isHovering || isSelected || isBodyDragActive || isTrimPreviewing || isSkimPreviewing || isViewerActive)
            && movePreviewRole == .none
            && !isBladeModeActive
            && !feedbackState.isPendingRemove
    }

    private var shouldShowTrimAffordance: Bool {
        isTrimEligible
            && !isBodyDragActive
            && !isBladeModeActive
            && movePreviewRole == .none
            && !feedbackState.isPendingRemove
            && (isHovering || isSelected || showsActiveTrimHandles || isTrimPreviewing)
    }

    private var interactionColor: Color {
        isBodyDragActive ? .accentColor : (isSelected ? .accentColor : Color.primary.opacity(0.64))
    }

    private var trimAffordanceColor: Color {
        if isTrimPreviewing { return .orange }
        if showsActiveTrimHandles || isSelected { return .accentColor }
        return Color.primary.opacity(0.62)
    }

    private var clipShadowColor: Color {
        if feedbackState.isRecentlyChanged { return Color.blue.opacity(0.8) }
        if isViewerActive { return Color.accentColor.opacity(0.22) }
        if isBladeModeActive { return Color.orange.opacity(0.24) }
        if isBodyDragActive { return Color.accentColor.opacity(0.32) }
        if isHovering { return Color.primary.opacity(0.16) }
        return .clear
    }

    private var clipShadowRadius: CGFloat {
        if feedbackState.isRecentlyChanged { return 6 }
        if isViewerActive { return 4 }
        if isBodyDragActive { return 5 }
        if isHovering { return 3 }
        return 0
    }

    private var helpText: String {
        if isBladeModeActive {
            return "ブレード: \(clip.id) をクリック位置で分割"
        }
        if trackKind == .caption, let captionText = clip.captionText {
            return "\(clip.id) / \(localizedTimelineFreeText(captionText))"
        }
        return "\(clip.id) / \(localizedTimelineFreeText(clip.motivation))"
    }

    private var clipBlockSubtitle: String {
        if trackKind == .caption, let captionText = clip.captionText {
            return captionText
        }
        return clip.segmentID
    }

    private var clipShadowYOffset: CGFloat {
        isBodyDragActive || isHovering ? 1 : 0
    }

    private var movePreviewColor: Color {
        switch movePreviewRole {
        case .none: return .clear
        case .target: return .accentColor
        case .liftedTarget: return .teal
        case .displaced: return .orange
        }
    }

    private var movePreviewIcon: String {
        switch movePreviewRole {
        case .none: return "circle"
        case .target: return "hand.draw"
        case .liftedTarget: return "square.stack.3d.up"
        case .displaced: return "arrow.right"
        }
    }

    @ViewBuilder
    private var feedbackIcons: some View {
        if feedbackState.isApproved {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        }
        if feedbackState.isRejected {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
        }
        if feedbackState.isPendingSwap {
            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                .foregroundStyle(.blue)
        }
        if feedbackState.isPendingTrim {
            Image(systemName: "scissors.circle.fill")
                .foregroundStyle(.orange)
        }
        if feedbackState.isPendingMove {
            Image(systemName: "arrow.left.arrow.right.circle.fill")
                .foregroundStyle(.purple)
        }
        if feedbackState.isPendingSplit {
            Image(systemName: "scissors.circle")
                .foregroundStyle(.teal)
        }
    }
}

private func localizedTimelineTransitionType(_ transitionType: String) -> String {
    switch transitionType {
    case "crossfade":
        return "クロスフェード"
    case "fade_to_black", "dip_to_black":
        return "Dip"
    case "match_cut", "match_cut_soft":
        return "Match"
    default:
        return transitionType
    }
}

struct TimelineEmptyState: View {
    var status: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(.quaternary)
            VStack(spacing: 8) {
                Image(systemName: "timeline.selection")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            .frame(height: 28)
        }
        .frame(minHeight: 120)
    }
}

func timelineAccessibilitySuffix(_ text: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
    let mapped = text.unicodeScalars.map { scalar -> String in
        allowed.contains(scalar) ? String(scalar) : "-"
    }.joined()
    let collapsed = mapped.split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
    return collapsed.isEmpty ? "item" : collapsed
}
