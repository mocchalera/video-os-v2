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
    @FocusState private var searchForMoreFocused: Bool
    @FocusState private var emptySearchForMoreFocused: Bool
    @FocusState private var closeButtonFocused: Bool
    @AccessibilityFocusState private var searchForMoreAccessibilityFocused: Bool
    @AccessibilityFocusState private var emptySearchForMoreAccessibilityFocused: Bool
    @AccessibilityFocusState private var closeButtonAccessibilityFocused: Bool

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
        .onAppear {
            focusSearchForMoreControl()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("差し替え候補")
        .accessibilityHint("現在のクリップ、候補一覧、差し替え操作の順に操作します。")
        .accessibilityIdentifier("CandidateSwap.Sheet")
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("差替え: \(clip.id)")
                    .font(.headline)
                    .accessibilityIdentifier("CandidateSwap.Title")
                Text(resolvedBeatID.isEmpty ? clip.segmentID : "\(clip.segmentID) / \(resolvedBeatID)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("CandidateSwap.Subtitle")
            }
            Spacer()
            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .keyboardShortcut(.cancelAction)
            .focusable(true)
            .focused($closeButtonFocused)
            .accessibilityFocused($closeButtonAccessibilityFocused)
            .help("閉じる")
            .accessibilityLabel("差し替え候補を閉じる")
            .accessibilityHint("Escapeで閉じることもできます。")
            .accessibilityIdentifier("CandidateSwap.CloseButton")
            .accessibilitySortPriority(90)
            .overlay {
                searchForMoreFocusRing(isFocused: closeButtonFocused)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    private var currentClipPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("現在のクリップ")
                .font(.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("CandidateSwap.CurrentClipHeader")

            ThumbnailView(url: thumbnailURL(assetID: clip.assetID))
                .frame(height: 156)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 8) {
                metadataRow("セグメント", clip.segmentID)
                metadataRow("役割", localizedClipRole(clip.role))
                metadataRow("ビート", resolvedBeatID.isEmpty ? "-" : resolvedBeatID)
                metadataRow("信頼度", clip.confidence.map(formatScore) ?? "-")
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("選定理由（原文）")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                Text(clip.motivation.isEmpty ? "-" : clip.motivation)
                    .font(.callout)
                    .lineLimit(6)
                    .accessibilityLabel("選定理由（原文） \(clip.motivation.isEmpty ? "-" : clip.motivation)")
            }

            if let beatPlan {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("ビート目標")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.isHeader)
                    Text("\(localizedTimelineMarkerLabel(beatPlan.label)) / \(beatPlan.target_duration_frames)フレーム")
                        .font(.caption)
                        .accessibilityLabel("ビート目標 \(localizedTimelineMarkerLabel(beatPlan.label))、\(beatPlan.target_duration_frames)フレーム")
                    if !fallbackRefs.isEmpty {
                        Text("予備候補 \(fallbackRefs.count)件")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("CandidateSwap.CurrentClipPanel")
    }

    private var alternativesPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("候補")
                    .font(.subheadline.weight(.semibold))
                Text("\(alternatives.count)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                    .accessibilityIdentifier("CandidateSwap.AlternativeCount")
                Spacer()
                if shouldShowToolbarSearchForMore {
                    Button {
                        onSearchForMore?()
                    } label: {
                        Label("素材をさらに検索", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(onSearchForMore == nil)
                    .focusable(true)
                    .focused($searchForMoreFocused)
                    .accessibilityFocused($searchForMoreAccessibilityFocused)
                    .accessibilityLabel("素材をさらに検索")
                    .accessibilityHint("現在の候補で足りない場合に素材検索を開きます。")
                    .accessibilityIdentifier("CandidateSwap.SearchForMoreButton")
                    .accessibilitySortPriority(40)
                    .overlay {
                        searchForMoreFocusRing(isFocused: searchForMoreFocused)
                    }
                }
            }

            if let loadError = dataSource.loadError {
                ContentUnavailableView(
                    "候補データを読み込めません",
                    systemImage: "exclamationmark.triangle",
                    description: Text(loadError)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("CandidateSwap.LoadError")
            } else if alternatives.isEmpty {
                emptyCandidatesView
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value)")
    }

    private var emptyCandidatesDescription: String {
        resolvedBeatID.isEmpty ? "候補データが空です。" : "\(resolvedBeatID) に使える候補がありません。"
    }

    private var shouldShowToolbarSearchForMore: Bool {
        !alternatives.isEmpty || dataSource.loadError != nil
    }

    private var emptyCandidatesView: some View {
        VStack(spacing: 14) {
            Image(systemName: "rectangle.stack.badge.minus")
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("差し替え候補がありません")
                .font(.title2.weight(.semibold))
            Text(emptyCandidatesDescription)
                .font(.callout)
                .foregroundStyle(.secondary)
            if onSearchForMore != nil {
                Button {
                    onSearchForMore?()
                } label: {
                    Label("素材をさらに検索", systemImage: "magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .focusable(true)
                .focused($emptySearchForMoreFocused)
                .accessibilityFocused($emptySearchForMoreAccessibilityFocused)
                .accessibilityLabel("素材をさらに検索")
                .accessibilityHint("差し替え候補がないため、素材検索を開いて候補を探します。")
                .accessibilityIdentifier("CandidateSwap.EmptySearchForMoreButton")
                .accessibilitySortPriority(100)
                .overlay {
                    searchForMoreFocusRing(isFocused: emptySearchForMoreFocused)
                }
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("差し替え候補がありません。\(emptyCandidatesDescription)")
        .accessibilityHint(onSearchForMore == nil ? "Escapeで閉じます。" : "素材をさらに検索ボタンで候補を探します。Escapeで閉じます。")
        .accessibilityIdentifier("CandidateSwap.EmptyState")
    }

    private func focusSearchForMoreControl() {
        guard onSearchForMore != nil else { return }
        DispatchQueue.main.async {
            focusPrimarySearchForMoreControl()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            focusPrimarySearchForMoreControl()
        }
    }

    private func focusPrimarySearchForMoreControl() {
        if alternatives.isEmpty {
            emptySearchForMoreFocused = true
            emptySearchForMoreAccessibilityFocused = true
        } else {
            searchForMoreFocused = true
            searchForMoreAccessibilityFocused = true
        }
    }

    private func searchForMoreFocusRing(isFocused: Bool) -> some View {
        RoundedRectangle(cornerRadius: 7)
            .stroke(Color.accentColor, lineWidth: isFocused ? 2 : 0)
            .padding(-3)
            .allowsHitTesting(false)
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
        feedbackSession.addOp(candidate.makeReplaceSegmentOperation(targetClipID: clip.id))
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
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(candidate.segment_id)
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("CandidateSwap.CandidateSegment.\(accessibilitySuffix(candidate.id))")
                    confidenceBadge
                    roleChip
                    if isFallback {
                        Text("予備")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Color.blue.opacity(0.12), in: Capsule())
                            .foregroundStyle(.blue)
                    }
                    Spacer(minLength: 8)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text("候補理由（原文）")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(candidate.why_it_matches.truncated(to: 80))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

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
                        Label("この候補に差替え", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isCurrentSegment)
                    .accessibilityLabel("\(candidate.segment_id) に差し替え")
                    .accessibilityHint(isCurrentSegment ? "現在と同じセグメントのため差し替えできません。" : "現在のクリップをこの候補に差し替えます。")
                    .accessibilityIdentifier("CandidateSwap.UseButton.\(accessibilitySuffix(candidate.id))")
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(.quaternary, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(candidateAccessibilityLabel)
        .accessibilityHint(isCurrentSegment ? "現在と同じセグメントです。" : "差し替えボタンでこの候補を使います。")
    }

    private var confidenceBadge: some View {
        Text(formatScore(candidate.confidence))
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(confidenceColor.opacity(0.14), in: Capsule())
            .foregroundStyle(confidenceColor)
            .help("信頼度")
    }

    private var roleChip: some View {
        Text(localizedClipRole(candidate.role))
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

    private var candidateAccessibilityLabel: String {
        let role = localizedClipRole(candidate.role)
        let reason = candidate.why_it_matches.truncated(to: 80)
        return "\(candidate.segment_id)、役割 \(role)、信頼度 \(formatScore(candidate.confidence))。\(reason)"
    }

    private func accessibilitySuffix(_ text: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        let mapped = text.unicodeScalars.map { scalar -> String in
            allowed.contains(scalar) ? String(scalar) : "-"
        }.joined()
        let collapsed = mapped.split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return collapsed.isEmpty ? "candidate" : collapsed
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
                Text(localizedEvidenceTag(item).truncated(to: 72))
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.tertiary.opacity(0.45), in: RoundedRectangle(cornerRadius: 5))
                    .help("原文タグ: \(item)")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("根拠タグ \(items.map(localizedEvidenceTag).joined(separator: "、"))")
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
