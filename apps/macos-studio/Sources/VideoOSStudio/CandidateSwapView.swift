import AppKit
import SwiftUI
import VideoOSStudioCore

struct CandidateSwapView: View {
    let clip: TimelineClip
    let beatID: String?
    let dataSource: CandidateBrowserDataSource
    let evidenceStore: ProjectEvidenceStore?
    let projectURL: URL?
    @ObservedObject var feedbackSession: StudioFeedbackSession
    var onSearchForMore: (() -> Void)?
    @Binding var isPresented: Bool

    private var resolvedBeatID: String {
        beatID ?? clip.beatID ?? ""
    }

    private var beatPlan: BrowserBeatPlan? {
        dataSource.beatPlans.first { $0.beat_id == resolvedBeatID }
    }

    private var fallbackRefs: [String] {
        guard !resolvedBeatID.isEmpty else { return [] }
        return dataSource.fallbacks(forBeat: resolvedBeatID)
    }

    private var alternatives: [BrowserCandidate] {
        let candidates = resolvedBeatID.isEmpty
            ? dataSource.candidates.sorted { $0.confidence > $1.confidence }
            : dataSource.candidates(forBeat: resolvedBeatID)
        return candidates.filter { $0.segment_id != clip.segmentID }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HStack(alignment: .top, spacing: 0) {
                currentClipPanel
                    .frame(width: 300)
                    .padding(18)
                Divider()
                alternativesPanel
                    .padding(18)
            }
        }
        .frame(width: 920, height: 580)
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Swap: \(clip.id)")
                    .font(.headline)
                Text(resolvedBeatID.isEmpty ? clip.segmentID : "\(clip.segmentID) / \(resolvedBeatID)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help("Close")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    private var currentClipPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Current Clip")
                .font(.subheadline.weight(.semibold))

            ThumbnailView(url: thumbnailURL(assetID: clip.assetID))
                .frame(height: 156)

            VStack(alignment: .leading, spacing: 8) {
                metadataRow("Segment", clip.segmentID)
                metadataRow("Role", clip.role)
                metadataRow("Beat", resolvedBeatID.isEmpty ? "-" : resolvedBeatID)
                metadataRow("Confidence", clip.confidence.map(formatScore) ?? "-")
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Motivation")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(clip.motivation.isEmpty ? "-" : clip.motivation)
                    .font(.callout)
                    .lineLimit(6)
            }

            if let beatPlan {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("Beat Target")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("\(beatPlan.label) / \(beatPlan.target_duration_frames) frames")
                        .font(.caption)
                    if !fallbackRefs.isEmpty {
                        Text("\(fallbackRefs.count) planned fallbacks")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()
        }
    }

    private var alternativesPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Alternatives")
                    .font(.subheadline.weight(.semibold))
                Text("\(alternatives.count)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Button {
                    onSearchForMore?()
                } label: {
                    Label("Search for more", systemImage: "magnifyingglass")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(onSearchForMore == nil)
            }

            if let loadError = dataSource.loadError {
                ContentUnavailableView(
                    "Candidate data failed to load: \(loadError)",
                    systemImage: "exclamationmark.triangle"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if alternatives.isEmpty {
                ContentUnavailableView(
                    "No candidates are eligible",
                    systemImage: "rectangle.stack.badge.minus",
                    description: Text(emptyCandidatesDescription)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(alternatives) { candidate in
                            CandidateCard(
                                candidate: candidate,
                                thumbnailURL: thumbnailURL(
                                    assetID: candidate.asset_id,
                                    keyFramePath: candidate.key_frame_path
                                ),
                                isFallback: fallbackRefs.contains(candidate.id) || fallbackRefs.contains(candidate.segment_id),
                                isCurrentSegment: candidate.segment_id == clip.segmentID,
                                onUse: { use(candidate) }
                            )
                        }
                    }
                    .padding(.trailing, 4)
                }
            }
        }
    }

    private func metadataRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .font(.caption.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var emptyCandidatesDescription: String {
        resolvedBeatID.isEmpty ? "Candidate data is empty." : "No candidates are eligible for \(resolvedBeatID)."
    }

    private func thumbnailURL(assetID: String, keyFramePath: String? = nil) -> URL? {
        guard let projectURL else { return nil }
        return ProjectThumbnailCache.thumbnailURL(
            projectURL: projectURL,
            assetID: assetID,
            keyFramePath: keyFramePath,
            assets: evidenceStore?.assets
        )
    }

    private func use(_ candidate: BrowserCandidate) {
        feedbackSession.addOp(.replaceSegment(
            target_clip_id: clip.id,
            with_segment_id: candidate.segment_id,
            with_candidate_ref: candidate.candidate_id,
            reason: "Swap selected in Candidate Browser: \(candidate.why_it_matches.truncated(to: 96))"
        ))
        isPresented = false
    }
}

private struct CandidateCard: View {
    let candidate: BrowserCandidate
    let thumbnailURL: URL?
    let isFallback: Bool
    let isCurrentSegment: Bool
    let onUse: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ThumbnailView(url: thumbnailURL)
                .frame(width: 170, height: 96)

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(candidate.segment_id)
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    confidenceBadge
                    roleChip
                    if isFallback {
                        Text("fallback")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Color.blue.opacity(0.12), in: Capsule())
                            .foregroundStyle(.blue)
                    }
                    Spacer(minLength: 8)
                }

                Text(candidate.why_it_matches.truncated(to: 80))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                if !candidate.evidence.isEmpty {
                    FlowTags(items: Array(candidate.evidence.prefix(3)))
                }

                HStack(spacing: 10) {
                    if let trim = candidate.trim_hint {
                        Label("\(formatSeconds(trim.recommended_in_us))-\(formatSeconds(trim.recommended_out_us))", systemImage: "scissors")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        onUse()
                    } label: {
                        Label("Use This", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isCurrentSegment)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    private var confidenceBadge: some View {
        Text(formatScore(candidate.confidence))
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(confidenceColor.opacity(0.14), in: Capsule())
            .foregroundStyle(confidenceColor)
            .help("Confidence")
    }

    private var roleChip: some View {
        Text(candidate.role)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
    }

    private var confidenceColor: Color {
        if candidate.confidence >= 0.8 { return .green }
        if candidate.confidence >= 0.6 { return .yellow }
        return .red
    }
}

private struct ThumbnailView: View {
    let url: URL?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(.quaternary)
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
        }
        .clipped()
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    private var image: NSImage? {
        guard let url else { return nil }
        return NSImage(contentsOf: url)
    }
}

private struct FlowTags: View {
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items, id: \.self) { item in
                Text(item.truncated(to: 72))
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.tertiary.opacity(0.45), in: RoundedRectangle(cornerRadius: 5))
            }
        }
    }
}

private func formatScore(_ value: Double) -> String {
    String(format: "%.2f", value)
}

private func formatSeconds(_ microseconds: Int) -> String {
    let seconds = Double(microseconds) / 1_000_000
    return String(format: "%.1fs", seconds)
}

private extension String {
    func truncated(to maxLength: Int) -> String {
        guard count > maxLength else { return self }
        let index = self.index(startIndex, offsetBy: max(0, maxLength - 3))
        return "\(self[..<index])..."
    }
}
