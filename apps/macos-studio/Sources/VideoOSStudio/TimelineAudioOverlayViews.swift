import SwiftUI
import VideoOSStudioCore

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
                            Text(localizedTimelineFreeText(cue.label))
                                .font(.system(size: 8, weight: .semibold))
                                .lineLimit(1)
                                .padding(.horizontal, 4)
                                .foregroundStyle(.primary)
                        }
                    }
                    .offset(x: offset(for: cue.frame), y: cue.kind == .bgmSection ? 23 : 3)
            }
        }
        .help("\(localizedTimelineAudioCueKind(cue.kind)): \(localizedTimelineFreeText(cue.label))\(cue.detail.map { " / \(localizedTimelineFreeText($0))" } ?? "")")
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
