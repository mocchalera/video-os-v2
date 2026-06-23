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
        self._selectedBeatID = State(initialValue: initialBeatID ?? selectedClip?.beatID ?? "")
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
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Search Footage")
                    .font(.headline)
                Text(projectURL.lastPathComponent)
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

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Picker("Mode", selection: $mode) {
                    ForEach(FootageSearchModeOption.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 460)

                Stepper("Limit \(limit)", value: $limit, in: 1...50)
                    .frame(width: 140, alignment: .leading)

                Spacer()
            }

            HStack(spacing: 8) {
                TextField("Query", text: $query)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await runSearch() }
                } label: {
                    Label(isSearching ? "Searching" : "Search", systemImage: "magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSearching)
            }

            HStack(spacing: 10) {
                PathPickerRow(
                    label: "Visual anchor",
                    systemImage: "photo",
                    value: $imageQueryPath,
                    allowedFileTypes: ["jpg", "jpeg", "png", "webp"]
                )
                PathPickerRow(
                    label: "Audio anchor",
                    systemImage: "waveform",
                    value: $audioQueryPath,
                    allowedFileTypes: ["wav", "mp3", "flac"]
                )
            }
        }
    }

    private var resultsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Results")
                    .font(.subheadline.weight(.semibold))
                Text("\(response?.results.count ?? 0)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                if let dbStatus = response?.db_status {
                    Text(dbStatus)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }

            if let error = response?.error {
                ContentUnavailableView(
                    "Footage search failed",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if isSearching {
                ProgressView("Searching footage...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let response, response.results.isEmpty {
                ContentUnavailableView(
                    "No results",
                    systemImage: "magnifyingglass",
                    description: Text((response.warnings ?? []).joined(separator: " "))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            } else {
                ContentUnavailableView("No results", systemImage: "magnifyingglass")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        case .text: return "Text"
        case .visual: return "Visual"
        case .audio: return "Audio"
        case .hybrid: return "Hybrid"
        case .multimodal: return "Multimodal"
        }
    }
}

private struct PathPickerRow: View {
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
            Button {
                chooseFile()
            } label: {
                Image(systemName: "folder")
            }
            .help(label)
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
                .frame(width: 170, height: 96)

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(result.segment_id)
                        .font(.system(.callout, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(formatSearchScore(result.score))
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.green.opacity(0.14), in: Capsule())
                        .foregroundStyle(.green)
                    Text(searchDurationLabel(result))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                }

                Text((result.summary ?? "-").truncatedForFootageSearch(to: 80))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                ScoreBars(scores: result.scores ?? [:])

                HStack(spacing: 8) {
                    Button {
                        onPreview()
                    } label: {
                        Label("Preview", systemImage: "play.fill")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                    Spacer()

                    Picker("Use in beat", selection: $selectedBeatID) {
                        Text("Selected").tag("")
                        ForEach(beatIDs, id: \.self) { beatID in
                            Text(beatID).tag(beatID)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 170)

                    Button {
                        onUse()
                    } label: {
                        Label("Use", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!canUse)
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
}

private struct FootageSearchThumbnailView: View {
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

private struct ScoreBars: View {
    let scores: [String: Double]

    private let channels: [(key: String, label: String, color: Color)] = [
        ("e5_text", "e5_text", .blue),
        ("qwen_visual", "qwen_visual", .purple),
        ("qwen_text", "qwen_text", .teal),
        ("clap_audio", "clap_audio", .orange),
        ("lexical", "lexical", .gray),
    ]

    var body: some View {
        VStack(spacing: 4) {
            ForEach(channels, id: \.key) { channel in
                HStack(spacing: 6) {
                    Text(channel.label)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(width: 86, alignment: .leading)
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
    }

    private func score(for key: String) -> Double? {
        guard let value = scores[key], value.isFinite else { return nil }
        return max(0, min(value, 1))
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
