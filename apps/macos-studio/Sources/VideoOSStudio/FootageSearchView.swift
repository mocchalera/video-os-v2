import AppKit
import SwiftUI
import UniformTypeIdentifiers
import VideoOSStudioCore

struct FootageSearchView: View {
    @ObservedObject var feedbackSession: StudioFeedbackSession
    let projectURL: URL
    let repositoryRoot: URL
    let evidenceStore: ProjectEvidenceStore?
    let timeline: TimelineDocument?
    let selectedClip: TimelineClip?
    let onPreview: (FootageSearchRunner.SearchResult) -> Void
    @Binding var isPresented: Bool

    @State private var mode: FootageSearchModeOption = .hybrid
    @State private var query = ""
    @State private var imageQueryPath = ""
    @State private var audioQueryPath = ""
    @State private var limit = 20
    @State private var selectedBeatID: String
    @State private var response: FootageSearchRunner.SearchResponse?
    @State private var isSearching = false
    @FocusState private var queryFieldFocused: Bool

    init(
        feedbackSession: StudioFeedbackSession,
        projectURL: URL,
        repositoryRoot: URL,
        evidenceStore: ProjectEvidenceStore?,
        timeline: TimelineDocument?,
        selectedClip: TimelineClip?,
        initialBeatID: String?,
        onPreview: @escaping (FootageSearchRunner.SearchResult) -> Void,
        isPresented: Binding<Bool>
    ) {
        self.feedbackSession = feedbackSession
        self.projectURL = projectURL
        self.repositoryRoot = repositoryRoot
        self.evidenceStore = evidenceStore
        self.timeline = timeline
        self.selectedClip = selectedClip
        self.onPreview = onPreview
        self._isPresented = isPresented
        self._selectedBeatID = State(initialValue: Self.initialSelectedBeatID(
            timeline: timeline,
            selectedClip: selectedClip,
            initialBeatID: initialBeatID
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            controls
                .padding(18)
            Divider()
            resultsPanel
                .padding(18)
        }
        .frame(width: 980, height: 680)
        .onSubmit {
            Task { await runSearch() }
        }
        .onAppear {
            DispatchQueue.main.async {
                queryFieldFocused = true
            }
        }
        .onChange(of: isSearching) { _, searching in
            guard !searching else { return }
            DispatchQueue.main.async {
                queryFieldFocused = true
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("素材検索")
        .accessibilityHint("検索条件、検索結果、差し替え操作の順に操作します。")
        .accessibilityIdentifier("FootageSearch.Sheet")
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("素材を検索")
                    .font(.headline)
                    .accessibilityIdentifier("FootageSearch.Title")
                Text(projectURL.lastPathComponent)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("FootageSearch.ProjectName")
            }
            Spacer()
            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .keyboardShortcut(.cancelAction)
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .focusable(true)
            .help("閉じる")
            .accessibilityLabel("素材検索を閉じる")
            .accessibilityHint("Escapeで閉じることもできます。")
            .accessibilityIdentifier("FootageSearch.CloseButton")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Picker("検索モード", selection: $mode) {
                    ForEach(FootageSearchModeOption.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 460)
                .accessibilityIdentifier("FootageSearch.ModePicker")

                Stepper("件数 \(limit)", value: $limit, in: 1...50)
                    .frame(width: 140, alignment: .leading)
                    .accessibilityIdentifier("FootageSearch.LimitStepper")

                Spacer()
            }

            HStack(spacing: 8) {
                TextField("検索語句", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($queryFieldFocused)
                    .accessibilityLabel("検索語句")
                    .accessibilityHint("Enterで素材検索を実行します。")
                    .accessibilityIdentifier("FootageSearch.QueryField")
                Button {
                    Task { await runSearch() }
                } label: {
                    Label(isSearching ? "検索中" : "検索", systemImage: "magnifyingglass")
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(isSearching)
                .focusable(true)
                .accessibilityLabel(isSearching ? "素材を検索中" : "素材を検索")
                .accessibilityHint("現在の検索条件で素材を検索します。")
                .accessibilityIdentifier("FootageSearch.SearchButton")
            }

            HStack(spacing: 10) {
                PathPickerRow(
                    id: "VisualAnchor",
                    label: "画像の手がかり",
                    systemImage: "photo",
                    value: $imageQueryPath,
                    allowedFileTypes: ["jpg", "jpeg", "png", "webp"]
                )
                PathPickerRow(
                    id: "AudioAnchor",
                    label: "音声の手がかり",
                    systemImage: "waveform",
                    value: $audioQueryPath,
                    allowedFileTypes: ["wav", "mp3", "flac"]
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("FootageSearch.Controls")
    }

    private var resultsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("検索結果")
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("FootageSearch.ResultsLabel")
                Text("\(response?.results.count ?? 0)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                    .accessibilityIdentifier("FootageSearch.ResultCount")
                Spacer()
                if let dbStatus = response?.db_status {
                    Text(dbStatus)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("FootageSearch.DBStatus")
                }
            }

            if let error = response?.error {
                ContentUnavailableView(
                    "素材検索に失敗しました",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("FootageSearch.ErrorMessage")
            } else if isSearching {
                ProgressView("素材を検索しています...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("FootageSearch.Progress")
            } else if let response, response.results.isEmpty {
                ContentUnavailableView(
                    "検索結果がありません",
                    systemImage: "magnifyingglass",
                    description: Text(emptyResultsDescription(response))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("FootageSearch.EmptyResults")
            } else if let response {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(response.results) { result in
                            FootageSearchResultCard(
                                result: result,
                                thumbnailURL: thumbnailURL(for: result),
                                selectedBeatID: $selectedBeatID,
                                beatIDs: beatIDs,
                                canUse: targetClip(for: selectedBeatID) != nil,
                                onPreview: { onPreview(result) },
                                onUse: { use(result) }
                            )
                        }
                    }
                    .padding(.trailing, 4)
                }
                .accessibilityIdentifier("FootageSearch.ResultsList")
            } else {
                ContentUnavailableView(
                    "検索条件を入力してください",
                    systemImage: "magnifyingglass",
                    description: Text("テキスト検索、画像の手がかり、音声の手がかりを組み合わせて素材を探せます。")
                )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("FootageSearch.EmptyState")
            }
        }
    }

    private var beatIDs: [String] {
        let ids = timeline?.displayTracks
            .flatMap(\.clips)
            .compactMap(\.beatID)
            .filter { !$0.isEmpty } ?? []
        return Array(Set(ids)).sorted()
    }

    private func emptyResultsDescription(_ response: FootageSearchRunner.SearchResponse) -> String {
        let warnings = response.warnings ?? []
        if warnings.isEmpty {
            return "検索語句、検索モード、件数を変えて再検索してください。"
        }
        return warnings.joined(separator: " ")
    }

    private func runSearch() async {
        isSearching = true
        response = nil
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let imagePath = imageQueryPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let audioPath = audioQueryPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = await FootageSearchRunner.search(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            mode: mode.rawValue,
            query: trimmedQuery.isEmpty ? nil : trimmedQuery,
            imageQueryPath: imagePath.isEmpty ? nil : imagePath,
            audioQueryPath: audioPath.isEmpty ? nil : audioPath,
            limit: limit
        )
        response = result
        isSearching = false
    }

    private func thumbnailURL(for result: FootageSearchRunner.SearchResult) -> URL? {
        ProjectThumbnailCache.thumbnailURL(
            projectURL: projectURL,
            assetID: result.asset_id,
            keyFramePath: result.key_frame_path,
            assets: evidenceStore?.assets
        )
    }

    private func use(_ result: FootageSearchRunner.SearchResult) {
        guard let target = targetClip(for: selectedBeatID) else { return }
        feedbackSession.addOp(result.makeReplaceSegmentOperation(targetClipID: target.id, mode: mode.rawValue))
    }

    private func targetClip(for beatID: String) -> TimelineClip? {
        if let selectedClip, beatID.isEmpty || selectedClip.beatID == beatID {
            return selectedClip
        }
        guard !beatID.isEmpty else { return selectedClip }
        return timeline?.displayTracks
            .flatMap(\.clips)
            .sorted { $0.timelineInFrame < $1.timelineInFrame }
            .first { $0.beatID == beatID }
    }

    private static func initialSelectedBeatID(
        timeline: TimelineDocument?,
        selectedClip: TimelineClip?,
        initialBeatID: String?
    ) -> String {
        if let initialBeatID, !initialBeatID.isEmpty {
            return initialBeatID
        }
        if let beatID = selectedClip?.beatID, !beatID.isEmpty {
            return beatID
        }
        return timeline?.displayTracks
            .flatMap(\.clips)
            .sorted { $0.timelineInFrame < $1.timelineInFrame }
            .compactMap(\.beatID)
            .first { !$0.isEmpty } ?? ""
    }
}

private enum FootageSearchModeOption: String, CaseIterable, Identifiable {
    case text
    case visual
    case audio
    case hybrid
    case multimodal

    var id: String { rawValue }

    var title: String {
        switch self {
        case .text: return "テキスト"
        case .visual: return "画像"
        case .audio: return "音声"
        case .hybrid: return "ハイブリッド"
        case .multimodal: return "マルチモーダル"
        }
    }
}

private struct PathPickerRow: View {
    let id: String
    let label: String
    let systemImage: String
    @Binding var value: String
    let allowedFileTypes: [String]

    var body: some View {
        HStack(spacing: 6) {
            Label(label, systemImage: systemImage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 108, alignment: .leading)
            TextField(label, text: $value)
                .textFieldStyle(.roundedBorder)
                .font(.caption.monospaced())
                .accessibilityLabel(label)
                .accessibilityIdentifier("FootageSearch.\(id).Field")
            Button {
                chooseFile()
            } label: {
                Image(systemName: "folder")
            }
            .help(label)
            .focusable(true)
            .accessibilityLabel("\(label)ファイルを選択")
            .accessibilityIdentifier("FootageSearch.\(id).Button")
        }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = allowedFileTypes.compactMap { UTType(filenameExtension: $0) }
        guard panel.runModal() == .OK, let url = panel.urls.first else { return }
        value = url.path
    }
}

private struct FootageSearchResultCard: View {
    private static let thumbnailSize = CGSize(width: 170, height: 96)

    let result: FootageSearchRunner.SearchResult
    let thumbnailURL: URL?
    @Binding var selectedBeatID: String
    let beatIDs: [String]
    let canUse: Bool
    let onPreview: () -> Void
    let onUse: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            FootageSearchThumbnailView(url: thumbnailURL)
                .frame(width: Self.thumbnailSize.width, height: Self.thumbnailSize.height)
                .fixedSize()
                .accessibilityHidden(true)
                .accessibilityIdentifier("FootageSearch.Thumbnail.\(resultAccessibilitySuffix)")

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(result.segment_id)
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("FootageSearch.ResultSegment.\(resultAccessibilitySuffix)")
                    Text(formatSearchScore(result.score))
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.green.opacity(0.14), in: Capsule())
                        .foregroundStyle(.green)
                        .accessibilityIdentifier("FootageSearch.ResultScore.\(resultAccessibilitySuffix)")
                    Text(searchDurationLabel(result))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("FootageSearch.ResultDuration.\(resultAccessibilitySuffix)")
                    Spacer(minLength: 8)
                }

                Text((result.summary ?? "-").truncatedForFootageSearch(to: 80))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("FootageSearch.ResultSummary.\(resultAccessibilitySuffix)")

                if !displayTags.isEmpty {
                    SearchTags(items: displayTags)
                        .accessibilityIdentifier("FootageSearch.ResultTags.\(resultAccessibilitySuffix)")
                }

                ScoreBars(scores: result.scores ?? [:])
                    .accessibilityIdentifier("FootageSearch.ScoreBars.\(resultAccessibilitySuffix)")

                HStack(spacing: 8) {
                    Button {
                        onPreview()
                    } label: {
                        Label("プレビュー", systemImage: "play.fill")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .focusable(true)
                    .accessibilityLabel("\(result.segment_id)をプレビュー")
                    .accessibilityIdentifier("FootageSearch.PreviewButton.\(resultAccessibilitySuffix)")

                    Spacer()

                    Picker("差し替え先ビート", selection: $selectedBeatID) {
                        Text("選択中").tag("")
                        ForEach(beatIDs, id: \.self) { beatID in
                            Text(beatID).tag(beatID)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 170)
                    .accessibilityLabel("差し替え先ビート")
                    .accessibilityIdentifier("FootageSearch.BeatPicker.\(resultAccessibilitySuffix)")

                    Button {
                        onUse()
                    } label: {
                        Label("差替え", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!canUse)
                    .focusable(true)
                    .accessibilityLabel("\(result.segment_id)で差し替え")
                    .accessibilityHint(canUse ? "選択中のビートのクリップをこの素材で差し替えます。" : "差し替え先のクリップが見つからないため実行できません。")
                    .accessibilityIdentifier("FootageSearch.UseButton.\(resultAccessibilitySuffix)")
                }
            }
            .layoutPriority(1)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(.quaternary, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(resultAccessibilityLabel)
        .accessibilityHint("プレビュー、差し替え先ビート、差替えの順に操作できます。")
    }

    private var resultAccessibilitySuffix: String {
        footageSearchAccessibilitySuffix(result.segment_id)
    }

    private var displayTags: [(label: String, source: String)] {
        let tagItems = (result.tags ?? []).prefix(4).map { tag in
            (label: localizedEvidenceTag(tag), source: "原文タグ: \(tag)")
        }
        let qualityItems = (result.quality_flags ?? []).prefix(2).map { flag in
            (label: localizedQualityFlag(flag), source: "品質フラグ: \(flag)")
        }
        return Array(tagItems + qualityItems)
    }

    private var resultAccessibilityLabel: String {
        let summary = (result.summary ?? "説明なし").truncatedForFootageSearch(to: 80)
        return "\(result.segment_id)、スコア \(formatSearchScore(result.score))、長さ \(searchDurationLabel(result))。\(summary)"
    }
}

private struct SearchTags: View {
    let items: [(label: String, source: String)]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(items, id: \.source) { item in
                Text(item.label)
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.tertiary.opacity(0.45), in: RoundedRectangle(cornerRadius: 5))
                    .help(item.source)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("タグ \(items.map(\.label).joined(separator: "、"))")
    }
}

private struct FootageSearchThumbnailView: View {
    private static let size = CGSize(width: 170, height: 96)

    let url: URL?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(.quaternary)
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: Self.size.width, height: Self.size.height)
                    .clipped()
            } else {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
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

private struct ScoreBars: View {
    let scores: [String: Double]

    private let channels: [(key: String, label: String, color: Color)] = [
        ("e5_text", "テキスト", .blue),
        ("qwen_visual", "画像特徴", .purple),
        ("qwen_text", "画像説明", .teal),
        ("clap_audio", "音声", .orange),
        ("lexical", "単語一致", .gray),
    ]

    var body: some View {
        VStack(spacing: 4) {
            ForEach(channels, id: \.key) { channel in
                HStack(spacing: 6) {
                    Text(channel.label)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(width: 72, alignment: .leading)
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(.quaternary)
                            Capsule()
                                .fill(channel.color.opacity(score(for: channel.key) == nil ? 0.12 : 0.72))
                                .frame(width: geometry.size.width * CGFloat(score(for: channel.key) ?? 0))
                        }
                    }
                    .frame(height: 5)
                    Text(score(for: channel.key).map(formatSearchScore) ?? "-")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(width: 34, alignment: .trailing)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(scoreSummaryLabel)
    }

    private func score(for key: String) -> Double? {
        guard let value = scores[key], value.isFinite else { return nil }
        return max(0, min(value, 1))
    }

    private var scoreSummaryLabel: String {
        let parts = channels.map { channel in
            "\(channel.label) \(score(for: channel.key).map(formatSearchScore) ?? "-")"
        }
        return "検索スコア \(parts.joined(separator: "、"))"
    }
}

private func formatSearchScore(_ value: Double) -> String {
    String(format: "%.2f", value)
}

private func searchDurationLabel(_ result: FootageSearchRunner.SearchResult) -> String {
    let seconds = Double(max(0, result.src_out_us - result.src_in_us)) / 1_000_000
    return String(format: "%.1fs", seconds)
}

private extension String {
    func truncatedForFootageSearch(to maxLength: Int) -> String {
        guard count > maxLength else { return self }
        let index = self.index(startIndex, offsetBy: max(0, maxLength - 3))
        return "\(self[..<index])..."
    }
}

private func footageSearchAccessibilitySuffix(_ value: String) -> String {
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    let sanitized = String(value.map { allowed.contains($0) ? $0 : "_" })
    return sanitized.isEmpty ? "unknown" : sanitized
}
