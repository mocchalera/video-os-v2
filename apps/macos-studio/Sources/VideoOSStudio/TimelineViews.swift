import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct TimelinePanel: View {
    var project: ProjectSummary?
    var timeline: TimelineDocument?
    var status: String
    var audioCues: [TimelineAudioCue]
    var audioWaveforms: [TimelineAudioWaveform]
    var audioWaveformStatus: String
    var recentlyChangedClipIDs: Set<String>
    @Binding var selectedClipID: TimelineClip.ID?
    var playheadFrame: Int
    var onScrubPlayhead: (Int) -> Void
    var onSelectClip: (TimelineClip.ID) -> Void
    var onOpenSwapBrowser: (TimelineClip) -> Void
    var onOpenFootageSearch: (TimelineClip) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Timeline")
                    .font(.headline)
                Spacer()
                Text(project?.hasTimeline == true ? "timeline.json" : "waiting for compile")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let timeline {
                TimelineRuler(timeline: timeline, playheadFrame: playheadFrame)
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
                    let labelWidth: CGFloat = 34
                    let rowSpacing: CGFloat = 10
                    let trailingPadding: CGFloat = 18
                    let viewportLaneWidth = max(320, geometry.size.width - labelWidth - rowSpacing - trailingPadding)
                    let laneWidth = max(viewportLaneWidth, CGFloat(timeline.totalFrames) * 3.2)

                    ScrollView([.horizontal, .vertical]) {
                        VStack(alignment: .leading, spacing: 6) {
                            TimelineMarkerLane(
                                markers: ProjectTimelineMarkerMap.build(timeline: timeline).markers,
                                totalFrames: timeline.totalFrames,
                                playheadFrame: playheadFrame,
                                laneWidth: laneWidth
                            )
                            ForEach(timeline.displayTracks) { track in
                                TimelineTrackRow(
                                    track: track,
                                    totalFrames: timeline.totalFrames,
                                    laneWidth: laneWidth,
                                    audioCues: audioCues.filter { $0.trackID == track.id },
                                    audioWaveforms: audioWaveforms.filter { $0.trackID == track.id },
                                    recentlyChangedClipIDs: recentlyChangedClipIDs,
                                    selectedClipID: $selectedClipID,
                                    playheadFrame: playheadFrame,
                                    onSelectClip: onSelectClip,
                                    onOpenSwapBrowser: onOpenSwapBrowser,
                                    onOpenFootageSearch: onOpenFootageSearch
                                )
                            }
                        }
                        .padding(.trailing, trailingPadding)
                        .frame(
                            minWidth: geometry.size.width,
                            maxWidth: .infinity,
                            alignment: .topLeading
                        )
                    }
                }
                .frame(minHeight: 132, maxHeight: .infinity)
            } else {
                TimelineEmptyState(status: status)
            }
        }
        .padding(18)
    }
}

struct TimelineRuler: View {
    var timeline: TimelineDocument
    var playheadFrame: Int

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                rulerItems
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 12) {
                    LabeledContent("Sequence", value: timeline.sequence.name)
                    LabeledContent("Playhead", value: timeline.sequence.framesToTimecode(playheadFrame))
                    LabeledContent("FPS", value: timeline.sequence.fps.formatted(.number.precision(.fractionLength(0...2))))
                }
                HStack(spacing: 12) {
                    LabeledContent("Duration", value: formatSeconds(timeline.totalSeconds))
                    LabeledContent("Canvas", value: "\(timeline.sequence.width)x\(timeline.sequence.height)")
                }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    @ViewBuilder
    private var rulerItems: some View {
        LabeledContent("Sequence", value: timeline.sequence.name)
        LabeledContent("Playhead", value: timeline.sequence.framesToTimecode(playheadFrame))
        LabeledContent("FPS", value: timeline.sequence.fps.formatted(.number.precision(.fractionLength(0...2))))
        LabeledContent("Duration", value: formatSeconds(timeline.totalSeconds))
        LabeledContent("Canvas", value: "\(timeline.sequence.width)x\(timeline.sequence.height)")
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }
}

struct TimelineMarkerLane: View {
    var markers: [TimelineMarkerCue]
    var totalFrames: Int
    var playheadFrame: Int
    var laneWidth: CGFloat

    var body: some View {
        HStack(spacing: 10) {
            Text("M")
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
                ForEach(markers) { marker in
                    TimelineMarkerChip(marker: marker)
                        .offset(x: markerOffset(marker.frame))
                }
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: 24)
                    .offset(x: markerOffset(playheadFrame))
            }
            .frame(width: laneWidth, height: 24)
        }
    }

    private func markerOffset(_ frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

struct TimelineMarkerChip: View {
    var marker: TimelineMarkerCue

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
            Text(marker.label)
                .font(.system(size: 9, weight: .semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 5)
        .frame(height: 18)
        .background(color.opacity(0.18), in: Capsule())
        .overlay {
            Capsule().stroke(color.opacity(0.75), lineWidth: 1)
        }
        .foregroundStyle(color)
        .help("\(marker.kind.rawValue) / \(marker.timecode) / \(marker.label)")
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

struct TimelineTrackRow: View {
    @EnvironmentObject private var feedbackSession: StudioFeedbackSession

    var track: TimelineTrack
    var totalFrames: Int
    var laneWidth: CGFloat
    var audioCues: [TimelineAudioCue]
    var audioWaveforms: [TimelineAudioWaveform]
    var recentlyChangedClipIDs: Set<String>
    @Binding var selectedClipID: TimelineClip.ID?
    var playheadFrame: Int
    var onSelectClip: (TimelineClip.ID) -> Void
    var onOpenSwapBrowser: (TimelineClip) -> Void
    var onOpenFootageSearch: (TimelineClip) -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(track.id)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
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
                ForEach(audioCues) { cue in
                    TimelineAudioCueOverlay(
                        cue: cue,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames
                    )
                }
                ForEach(track.clips.sorted { $0.timelineInFrame < $1.timelineInFrame }) { clip in
                    Button {
                        onSelectClip(clip.id)
                    } label: {
                        TimelineClipBlock(
                            clip: clip,
                            trackKind: track.kind,
                            isSelected: selectedClipID == clip.id,
                            isUnderPlayhead: clip.containsTimelineFrame(playheadFrame),
                            isWidthExpanded: isClipWidthExpanded(clip),
                            feedbackState: feedbackState(for: clip)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibilityLabel(for: clip))
                    .accessibilityIdentifier("Timeline.Clip.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                    .frame(
                        width: clipWidth(clip),
                        height: 28
                    )
                    .offset(x: clipOffset(clip))
                    .zIndex(zIndex(for: clip))
                    .contextMenu {
                        Button("Approve") {
                            feedbackSession.approvedClipIDs.insert(clip.id)
                        }
                        .accessibilityIdentifier("Timeline.ContextMenu.Approve.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                        Button("Reject") {
                            feedbackSession.addOp(.removeSegment(target_clip_id: clip.id, reason: "Rejected by operator"))
                            feedbackSession.rejectedClipIDs.insert(clip.id)
                        }
                        .accessibilityIdentifier("Timeline.ContextMenu.Reject.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                        if track.kind == .video || track.kind == .audio {
                            Button("Swap...") {
                                onOpenSwapBrowser(clip)
                            }
                            .accessibilityIdentifier("Timeline.ContextMenu.Swap.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                            Button("Search for replacement...") {
                                onOpenFootageSearch(clip)
                            }
                            .accessibilityIdentifier("Timeline.ContextMenu.SearchReplacement.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                        }
                        Button("Remove") {
                            feedbackSession.addOp(.removeSegment(target_clip_id: clip.id, reason: "Removed by operator"))
                        }
                        .accessibilityIdentifier("Timeline.ContextMenu.Remove.\(timelineAccessibilitySuffix(track.id)).\(timelineAccessibilitySuffix(clip.id))")
                    }
                }
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: 32)
                    .offset(x: playheadOffset)
            }
            .frame(width: laneWidth, height: 32)
        }
    }

    private var playheadOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(playheadFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private func clipOffset(_ clip: TimelineClip) -> CGFloat {
        laneWidth * CGFloat(clip.timelineInFrame) / CGFloat(max(totalFrames, 1))
    }

    private func clipWidth(_ clip: TimelineClip) -> CGFloat {
        max(44, laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1)))
    }

    private func rawClipWidth(_ clip: TimelineClip) -> CGFloat {
        laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1))
    }

    private func isClipWidthExpanded(_ clip: TimelineClip) -> Bool {
        rawClipWidth(clip) < 44
    }

    private func zIndex(for clip: TimelineClip) -> Double {
        if selectedClipID == clip.id { return 10 }
        if clip.containsTimelineFrame(playheadFrame) { return 8 }
        if isClipWidthExpanded(clip) { return 4 }
        return 1
    }

    private func accessibilityLabel(for clip: TimelineClip) -> String {
        "\(track.id) \(clip.role) \(clip.segmentID)"
    }

    private func feedbackState(for clip: TimelineClip) -> TimelineClipFeedbackState {
        TimelineClipFeedbackState(
            isApproved: feedbackSession.approvedClipIDs.contains(clip.id),
            isRejected: feedbackSession.rejectedClipIDs.contains(clip.id),
            isPendingSwap: feedbackSession.hasPendingSwap(for: clip.id),
            isPendingRemove: feedbackSession.hasPendingRemove(for: clip.id),
            isRecentlyChanged: recentlyChangedClipIDs.contains(clip.id)
        )
    }
}

struct TimelineWaveformOverlay: View {
    var waveform: TimelineAudioWaveform
    var clip: TimelineClip
    var laneWidth: CGFloat
    var totalFrames: Int

    var body: some View {
        Canvas { context, size in
            guard waveform.peaks.count > 1 else { return }
            let midY = size.height / 2
            let step = size.width / CGFloat(max(waveform.peaks.count - 1, 1))
            var path = Path()

            for (index, peak) in waveform.peaks.enumerated() {
                let x = CGFloat(index) * step
                let height = max(1, CGFloat(peak) * (size.height * 0.42))
                path.move(to: CGPoint(x: x, y: midY - height))
                path.addLine(to: CGPoint(x: x, y: midY + height))
            }

            context.stroke(path, with: .color(.primary.opacity(0.42)), lineWidth: 1)
        }
        .frame(width: width, height: 24)
        .offset(x: offset, y: 4)
        .allowsHitTesting(false)
        .help("waveform: \(waveform.assetID) / \(waveform.resolvedFrom)")
        .accessibilityIdentifier("Timeline.Waveform.\(timelineAccessibilitySuffix(waveform.trackID)).\(timelineAccessibilitySuffix(waveform.clipID))")
    }

    private var offset: CGFloat {
        laneWidth * CGFloat(clip.timelineInFrame) / CGFloat(max(totalFrames, 1))
    }

    private var width: CGFloat {
        max(44, laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1)))
    }
}

struct TimelineAudioCueOverlay: View {
    var cue: TimelineAudioCue
    var laneWidth: CGFloat
    var totalFrames: Int

    var body: some View {
        Group {
            if cue.kind == .bgmBeat || cue.kind == .bgmDownbeat {
                Rectangle()
                    .fill(color)
                    .frame(width: cue.kind == .bgmDownbeat ? 3 : 1.5, height: cue.kind == .bgmDownbeat ? 30 : 22)
                    .offset(x: offset(for: cue.frame), y: cue.kind == .bgmDownbeat ? 1 : 5)
            } else {
                RoundedRectangle(cornerRadius: 2)
                    .fill(color.opacity(0.72))
                    .frame(width: width, height: cue.kind == .bgmSection ? 8 : 11)
                    .overlay(alignment: .leading) {
                        if width > 64 {
                            Text(cue.label)
                                .font(.system(size: 8, weight: .semibold))
                                .lineLimit(1)
                                .padding(.horizontal, 4)
                                .foregroundStyle(.primary)
                        }
                    }
                    .offset(x: offset(for: cue.frame), y: cue.kind == .bgmSection ? 23 : 3)
            }
        }
        .help("\(cue.kind.rawValue): \(cue.label)\(cue.detail.map { " / \($0)" } ?? "")")
        .accessibilityIdentifier("Timeline.AudioCue.\(timelineAccessibilitySuffix(cue.id))")
    }

    private var width: CGFloat {
        guard let endFrame = cue.endFrame else { return 8 }
        let frames = max(1, endFrame - cue.frame)
        return max(8, laneWidth * CGFloat(frames) / CGFloat(max(totalFrames, 1)))
    }

    private func offset(for frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var color: Color {
        switch cue.kind {
        case .audioEvent: return .orange
        case .audioStory: return .teal
        case .bgmBeat: return .green.opacity(0.75)
        case .bgmDownbeat: return .green
        case .bgmSection: return .mint
        }
    }
}

struct TimelineClipFeedbackState: Equatable {
    var isApproved: Bool
    var isRejected: Bool
    var isPendingSwap: Bool
    var isPendingRemove: Bool
    var isRecentlyChanged: Bool

    static let none = TimelineClipFeedbackState(
        isApproved: false,
        isRejected: false,
        isPendingSwap: false,
        isPendingRemove: false,
        isRecentlyChanged: false
    )
}

struct TimelineClipBlock: View {
    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var isSelected: Bool
    var isUnderPlayhead: Bool
    var isWidthExpanded: Bool = false
    var feedbackState: TimelineClipFeedbackState = .none

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .fill(color.opacity(isUnderPlayhead ? 0.98 : (trackKind == .audio ? 0.70 : 0.82)))
                .opacity(feedbackState.isRejected ? 0.30 : 1)

            RoundedRectangle(cornerRadius: 4)
                .stroke(borderColor, lineWidth: borderLineWidth)

            if feedbackState.isPendingRemove {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.red.opacity(0.85), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }

            if feedbackState.isRecentlyChanged {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color.blue.opacity(0.85), lineWidth: 2)
            }

            HStack(spacing: 4) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(clip.role)
                        .font(.caption2.weight(.semibold))
                        .minimumScaleFactor(isWidthExpanded ? 0.65 : 1)
                    Text(clip.segmentID)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .minimumScaleFactor(isWidthExpanded ? 0.6 : 1)
                }
                .lineLimit(1)
                .foregroundStyle(.primary)

                Spacer(minLength: 2)

                feedbackIcons
            }
            .padding(.horizontal, 6)
        }
        .shadow(
            color: feedbackState.isRecentlyChanged ? Color.blue.opacity(0.8) : .clear,
            radius: feedbackState.isRecentlyChanged ? 6 : 0
        )
        .animation(.easeOut(duration: 5.0), value: feedbackState.isRecentlyChanged)
        .help("\(clip.id) / \(clip.motivation)")
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch clip.role {
        case "hero": return .blue
        case "dialogue": return .indigo
        case "support": return .cyan
        case "transition": return .purple
        case "texture": return .mint
        case "music", "bgm": return .green
        case "nat_sound", "ambient": return .orange
        case "title": return .pink
        default: return trackKind == .audio ? .orange : .gray
        }
    }

    private var borderColor: Color {
        if feedbackState.isApproved {
            return .green
        }
        if isSelected {
            return .accentColor
        }
        if isUnderPlayhead {
            return Color.primary.opacity(0.45)
        }
        return .clear
    }

    private var borderLineWidth: CGFloat {
        feedbackState.isApproved || isSelected ? 2 : 1
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

private func timelineAccessibilitySuffix(_ text: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
    let mapped = text.unicodeScalars.map { scalar -> String in
        allowed.contains(scalar) ? String(scalar) : "-"
    }.joined()
    let collapsed = mapped.split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
    return collapsed.isEmpty ? "item" : collapsed
}
