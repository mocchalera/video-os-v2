import AppKit
import AVFoundation
import AVKit
import SwiftUI
import UniformTypeIdentifiers
import VideoOSStudioCore

private enum BGMReviewDesign {
    static let panePadding: CGFloat = 16
    static let cardRadius: CGFloat = 12
    static let compactSpacing: CGFloat = 8
    static let sectionSpacing: CGFloat = 14
    static let auditionSeconds: Double = 15
}

@MainActor
private final class BGMAuditionController: ObservableObject {
    @Published private(set) var dialoguePlayer: AVPlayer?
    @Published private(set) var isPlaying = false
    @Published private(set) var modeLabel = "停止中"
    @Published var dialogueVolume = 0.92 {
        didSet { dialoguePlayer?.volume = Float(dialogueVolume) }
    }
    @Published var musicBedVolume = 0.18 {
        didSet {
            if modeLabel == "会話重ね" { musicPlayer?.volume = Float(musicBedVolume) }
        }
    }

    private var musicPlayer: AVPlayer?
    private var musicURL: URL?
    private var dialogueURL: URL?
    private var stopTask: Task<Void, Never>?
    private var playbackGeneration = 0

    func prepare(musicURL: URL?, dialogueURL: URL?) {
        stop()
        self.musicURL = musicURL
        self.dialogueURL = dialogueURL
        musicPlayer = musicURL.map { AVPlayer(url: $0) }
        dialoguePlayer = dialogueURL.map { AVPlayer(url: $0) }
        dialoguePlayer?.volume = Float(dialogueVolume)
    }

    func playMusicOnly() {
        guard musicURL != nil else { return }
        start(withDialogue: false)
    }

    func playWithDialogue() {
        guard musicURL != nil, dialogueURL != nil else { return }
        start(withDialogue: true)
    }

    func stop() {
        playbackGeneration += 1
        stopTask?.cancel()
        stopTask = nil
        musicPlayer?.pause()
        dialoguePlayer?.pause()
        musicPlayer?.seek(to: .zero)
        dialoguePlayer?.seek(to: .zero)
        isPlaying = false
        modeLabel = "停止中"
    }

    private func start(withDialogue: Bool) {
        playbackGeneration += 1
        let generation = playbackGeneration
        stopTask?.cancel()
        musicPlayer?.pause()
        dialoguePlayer?.pause()
        musicPlayer?.seek(to: .zero)
        dialoguePlayer?.seek(to: .zero)
        musicPlayer?.volume = Float(withDialogue ? musicBedVolume : 0.68)
        dialoguePlayer?.volume = Float(dialogueVolume)
        if withDialogue { dialoguePlayer?.play() }
        musicPlayer?.play()
        isPlaying = true
        modeLabel = withDialogue ? "会話重ね" : "BGM単体"
        stopTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(BGMReviewDesign.auditionSeconds * 1_000_000_000))
            guard !Task.isCancelled, let self, self.playbackGeneration == generation else { return }
            self.stop()
        }
    }
}

struct BGMReviewView: View {
    private enum CandidateFilter: String, CaseIterable, Identifiable {
        case pending = "未完了"
        case eligible = "採用候補"
        case all = "すべて"

        var id: String { rawValue }
    }

    @Environment(\.dismiss) private var dismiss
    @StateObject private var session: BGMReviewSession
    @StateObject private var audition = BGMAuditionController()
    @AppStorage("VideoOSStudio.BGMReviewQueuePath") private var lastQueuePath = ""
    @State private var filter: CandidateFilter = .pending
    @State private var searchText = ""
    private let dialoguePreviewURL: URL?

    init(projectURL: URL, repositoryRoot: URL) {
        self.dialoguePreviewURL = ProjectMediaResolver.resolveTimelinePreview(
            projectURL: projectURL,
            playheadSeconds: 0
        )?.url
        _session = StateObject(wrappedValue: BGMReviewSession(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if session.isBusy && session.document == nil {
                ProgressView("BGMレビューキューを読み込んでいます...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if session.document == nil {
                emptyState
            } else {
                HSplitView {
                    candidatePane
                        .frame(minWidth: 300, idealWidth: 350, maxWidth: 420)
                    auditionPane
                        .frame(minWidth: 460, idealWidth: 620)
                    reviewPane
                        .frame(minWidth: 300, idealWidth: 340, maxWidth: 390)
                }
            }
            Divider()
            statusBar
        }
        .frame(minWidth: 1_160, minHeight: 760)
        .task { await loadLastQueueIfAvailable() }
        .onChange(of: session.resolvedAudioURL) { _, musicURL in
            audition.prepare(musicURL: musicURL, dialogueURL: dialoguePreviewURL)
        }
        .onChange(of: session.selectedCandidateID) { _, _ in audition.stop() }
        .onDisappear { audition.stop() }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Label("BGM試聴・レビュー", systemImage: "music.note.list")
                .font(.title2.weight(.semibold))

            if let document = session.document {
                summaryChip("SHA確認", value: document.counts.sourceVerified, color: .green)
                summaryChip("完了", value: document.completedReviewCount, color: .blue)
                summaryChip("未完了", value: session.pendingCandidateCount, color: .orange)
                summaryChip("採用候補", value: document.counts.promotionEligible, color: .purple)
            }

            Spacer()

            Button {
                chooseQueue()
            } label: {
                Label(session.queueURL == nil ? "キューを選択" : "キューを変更", systemImage: "folder")
            }
            .accessibilityIdentifier("BGMReviewChooseQueueButton")

            Button {
                guard let queueURL = session.queueURL else { return }
                Task { await session.load(queueURL: queueURL, preferredCandidateID: session.selectedCandidateID) }
            } label: {
                Label("再読み込み", systemImage: "arrow.clockwise")
            }
            .disabled(session.queueURL == nil || session.isBusy)
            .accessibilityIdentifier("BGMReviewReloadButton")

            Button("閉じる") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("BGMレビューキューを選択", systemImage: "music.note.list")
        } description: {
            Text(session.errorMessage ?? "technical-shortlistから生成したmusical-review-queue.jsonを開いてください。音源は移動・コピーしません。")
        } actions: {
            Button("レビューキューを開く") { chooseQueue() }
                .buttonStyle(.borderedProminent)
        }
        .accessibilityIdentifier("BGMReviewEmptyState")
    }

    private var candidatePane: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Picker("表示", selection: $filter) {
                    ForEach(CandidateFilter.allCases) { item in
                        Text(item.rawValue).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                TextField("曲名・用途・候補を検索", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("BGMReviewSearchField")
            }
            .padding(12)

            Divider()

            List(selection: Binding(
                get: { session.selectedCandidateID },
                set: { session.select($0) }
            )) {
                ForEach(filteredTracks) { track in
                    Section {
                        ForEach(track.candidates) { candidate in
                            BGMReviewCandidateRow(candidate: candidate)
                                .tag(candidate.candidateID)
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(track.workingTitle)
                                .font(.caption.weight(.semibold))
                            Text("\(track.family.replacingOccurrences(of: "_", with: " ")) ・ \(track.intensity)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .accessibilityIdentifier("BGMReviewCandidateList")
            .overlay {
                if filteredTracks.isEmpty {
                    ContentUnavailableView(
                        "候補がありません",
                        systemImage: "line.3.horizontal.decrease.circle",
                        description: Text("表示条件または検索語を変更してください。")
                    )
                }
            }
        }
    }

    private var auditionPane: some View {
        VStack(alignment: .leading, spacing: BGMReviewDesign.sectionSpacing) {
            if let candidate = session.selectedCandidate, let track = session.selectedTrack {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(track.workingTitle)
                            .font(.title2.weight(.semibold))
                        Spacer()
                        metricChip("Rank", value: "#\(candidate.technicalRank)")
                        metricChip("BPM", value: String(format: "%.1f", candidate.normalizedBPM))
                        metricChip("Tech", value: String(format: "%.1f", candidate.technicalScore))
                    }
                    Text(candidate.filename)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                ZStack {
                    RoundedRectangle(cornerRadius: BGMReviewDesign.cardRadius)
                        .fill(Color.black)
                    if let player = audition.dialoguePlayer {
                        VideoPlayer(player: player)
                            .clipShape(RoundedRectangle(cornerRadius: BGMReviewDesign.cardRadius))
                    } else {
                        VStack(spacing: 10) {
                            Image(systemName: "waveform.badge.exclamationmark")
                                .font(.system(size: 34, weight: .light))
                            Text("照合済みタイムラインプレビューがありません")
                                .font(.callout.weight(.medium))
                            Text("BGM単体試聴はできます。会話重ね評価には現在のtimelineからpreviewを生成してください。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: 360)
                        }
                        .foregroundStyle(.white)
                    }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
                .accessibilityIdentifier("BGMReviewDialoguePreview")

                HStack(spacing: 10) {
                    Button {
                        audition.playMusicOnly()
                    } label: {
                        Label("BGM単体 15秒", systemImage: "music.note")
                    }
                    .disabled(!session.isSourceVerified)

                    Button {
                        audition.playWithDialogue()
                    } label: {
                        Label("会話と重ねる 15秒", systemImage: "person.wave.2")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!session.isSourceVerified || dialoguePreviewURL == nil)
                    .accessibilityIdentifier("BGMReviewDialogueAuditionButton")

                    Button {
                        audition.stop()
                    } label: {
                        Label("停止", systemImage: "stop.fill")
                    }
                    .disabled(!audition.isPlaying)

                    Spacer()
                    Label(audition.modeLabel, systemImage: audition.isPlaying ? "speaker.wave.2.fill" : "speaker.slash")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(audition.isPlaying ? .green : .secondary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("会話重ね時のBGM")
                            .font(.caption.weight(.medium))
                        Slider(value: $audition.musicBedVolume, in: 0.05...0.40)
                        Text("\(Int(audition.musicBedVolume * 100))%")
                            .font(.caption.monospacedDigit())
                            .frame(width: 38, alignment: .trailing)
                    }
                    HStack {
                        Text("会話音声")
                            .font(.caption.weight(.medium))
                        Slider(value: $audition.dialogueVolume, in: 0.45...1.0)
                        Text("\(Int(audition.dialogueVolume * 100))%")
                            .font(.caption.monospacedDigit())
                            .frame(width: 38, alignment: .trailing)
                    }
                }
                .padding(12)
                .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: BGMReviewDesign.cardRadius))

                VStack(alignment: .leading, spacing: 6) {
                    Label("生成時コメント", systemImage: "quote.bubble")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(candidate.sourceComment)
                        .font(.callout)
                        .textSelection(.enabled)
                    Text(track.note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: BGMReviewDesign.cardRadius))

                Spacer(minLength: 0)
            } else {
                ContentUnavailableView("候補を選択", systemImage: "music.note", description: Text("左のリストから試聴する候補を選んでください。"))
            }
        }
        .padding(BGMReviewDesign.panePadding)
    }

    private var reviewPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: BGMReviewDesign.sectionSpacing) {
                Text("人間レビュー")
                    .font(.title3.weight(.semibold))

                TextField("レビュー担当者", text: $session.reviewer)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("BGMReviewReviewerField")

                BGMReviewGateCard(
                    title: "音楽的適合",
                    detail: "構成意図、ムード、展開が映像目的に合うか",
                    icon: "music.quarternote.3",
                    isResolved: session.musicalFit.isResolved
                ) {
                    Picker("音楽的適合", selection: $session.musicalFit) {
                        Text("未確認").tag(BGMMusicalFit.pending)
                        Text("採用").tag(BGMMusicalFit.approved)
                        Text("不採用").tag(BGMMusicalFit.rejected)
                    }
                    .labelsHidden()
                }

                BGMReviewGateCard(
                    title: "会話との相性",
                    detail: "発話を隠さず、呼吸や間を邪魔しないか",
                    icon: "person.wave.2",
                    isResolved: session.dialogueBed.isResolved
                ) {
                    passFailPicker("会話との相性", selection: $session.dialogueBed)
                }

                BGMReviewGateCard(
                    title: "生成ノイズ・品質",
                    detail: "破綻、クリック、濁り、不自然な終端がないか",
                    icon: "waveform.path.ecg",
                    isResolved: session.artifactQuality.isResolved
                ) {
                    passFailPicker("生成ノイズ・品質", selection: $session.artifactQuality)
                }

                BGMReviewGateCard(
                    title: "独自性・類似性",
                    detail: "既知曲や固有フレーズへの懸念がないか",
                    icon: "fingerprint",
                    isResolved: session.originality.isResolved
                ) {
                    Picker("独自性・類似性", selection: $session.originality) {
                        Text("未確認").tag(BGMOriginalityReview.pending)
                        Text("問題なし").tag(BGMOriginalityReview.passed)
                        Text("懸念あり").tag(BGMOriginalityReview.concern)
                    }
                    .labelsHidden()
                }

                BGMReviewGateCard(
                    title: "権利証跡",
                    detail: "生成時プラン・規約・所有主体をprivate証跡で確認。ライセンス確認済みは資格あるレビュー時のみ",
                    icon: "checkmark.shield",
                    isResolved: session.rights.isResolved
                ) {
                    Picker("権利証跡", selection: $session.rights) {
                        Text("未確認").tag(BGMRightsReview.pending)
                        Text("運用者確認済み").tag(BGMRightsReview.operatorDeclaredOK)
                        Text("ライセンス確認済み").tag(BGMRightsReview.licensed)
                        Text("利用不可").tag(BGMRightsReview.blocked)
                    }
                    .labelsHidden()
                }

                VStack(alignment: .leading, spacing: 7) {
                    Text("レビューコメント")
                        .font(.caption.weight(.semibold))
                    TextEditor(text: $session.notesText)
                        .font(.body)
                        .frame(minHeight: 90)
                        .padding(6)
                        .background(.background, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
                        .accessibilityIdentifier("BGMReviewNotesEditor")
                    Text("1行を1件の記録として保存します。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let candidate = session.selectedCandidate {
                    Label(
                        candidate.promotionEligible ? "採用候補ゲート通過" : "採用候補ゲート未通過",
                        systemImage: candidate.promotionEligible ? "checkmark.seal.fill" : "circle.dotted"
                    )
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(candidate.promotionEligible ? .green : .secondary)
                    Text("採用候補になっても公開・OSS収録には別途リリース承認が必要です。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Button("保留へ戻す") { session.resetDraftToPending() }
                        .disabled(session.selectedCandidate == nil || session.isBusy)
                    Spacer()
                    Button("保存") {
                        audition.stop()
                        Task { await session.saveSelected() }
                    }
                    .disabled(!session.canSave)
                    Button("保存して次へ") {
                        audition.stop()
                        Task { await session.saveSelected(advanceToNextPending: true) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!session.canSave)
                    .accessibilityIdentifier("BGMReviewSaveAndNextButton")
                }
            }
            .padding(BGMReviewDesign.panePadding)
        }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Image(systemName: session.errorMessage == nil ? "info.circle" : "exclamationmark.triangle.fill")
                .foregroundStyle(session.errorMessage == nil ? Color.secondary : Color.orange)
            Text(session.errorMessage ?? session.statusMessage)
                .font(.caption)
                .lineLimit(2)
            Spacer()
            if session.isBusy {
                ProgressView().controlSize(.small)
            } else if session.isSourceVerified {
                Label("SHA確認済み", systemImage: "checkmark.shield.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
            }
            if let queueURL = session.queueURL {
                Text(queueURL.lastPathComponent)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var filteredTracks: [BGMShortlistReviewTrack] {
        guard let document = session.document else { return [] }
        let normalizedQuery = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return document.tracks.compactMap { track in
            let candidates = track.candidates.filter { candidate in
                let matchesFilter: Bool
                switch filter {
                case .pending: matchesFilter = !candidate.review.isComplete
                case .eligible: matchesFilter = candidate.promotionEligible
                case .all: matchesFilter = true
                }
                guard matchesFilter else { return false }
                guard !normalizedQuery.isEmpty else { return true }
                return [track.trackID, track.workingTitle, track.family, track.useCases.joined(separator: " "), candidate.filename, candidate.candidateID]
                    .contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            }
            guard !candidates.isEmpty else { return nil }
            return BGMShortlistReviewTrack(
                trackID: track.trackID,
                workingTitle: track.workingTitle,
                family: track.family,
                intensity: track.intensity,
                useCases: track.useCases,
                note: track.note,
                candidates: candidates
            )
        }
    }

    private func passFailPicker(
        _ title: String,
        selection: Binding<BGMPassFailReview>
    ) -> some View {
        Picker(title, selection: selection) {
            Text("未確認").tag(BGMPassFailReview.pending)
            Text("合格").tag(BGMPassFailReview.passed)
            Text("不合格").tag(BGMPassFailReview.failed)
        }
        .labelsHidden()
    }

    private func summaryChip(_ label: String, value: Int, color: Color) -> some View {
        HStack(spacing: 6) {
            Text("\(value)").font(.caption.monospacedDigit().weight(.bold))
            Text(label).font(.caption.weight(.medium))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
        .accessibilityLabel("\(label) \(value)件")
    }

    private func metricChip(_ label: String, value: String) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit().weight(.semibold))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
    }

    private func chooseQueue() {
        let panel = NSOpenPanel()
        panel.title = "BGMレビューキューを選択"
        panel.prompt = "開く"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        if let queueURL = session.queueURL {
            panel.directoryURL = queueURL.deletingLastPathComponent()
        }
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            lastQueuePath = url.path
            Task { await session.load(queueURL: url) }
        }
    }

    private func loadLastQueueIfAvailable() async {
        guard session.document == nil, !lastQueuePath.isEmpty else { return }
        let url = URL(fileURLWithPath: lastQueuePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        await session.load(queueURL: url)
    }
}

private struct BGMReviewCandidateRow: View {
    let candidate: BGMShortlistReviewCandidate

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(statusColor)
                .frame(width: 4, height: 36)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("#\(candidate.technicalRank)")
                        .font(.caption.monospacedDigit().weight(.bold))
                    Text(candidate.filename)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack(spacing: 8) {
                    Text("Tech \(candidate.technicalScore, format: .number.precision(.fractionLength(1)))")
                    Text("\(candidate.normalizedBPM, format: .number.precision(.fractionLength(1))) BPM")
                    Label(reviewLabel, systemImage: reviewIcon)
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("候補\(candidate.technicalRank)、\(reviewLabel)")
    }

    private var statusColor: Color {
        if candidate.promotionEligible { return .green }
        if candidate.review.isComplete { return .orange }
        return .secondary.opacity(0.55)
    }

    private var reviewLabel: String {
        if candidate.promotionEligible { return "採用候補" }
        if candidate.review.isComplete { return "確認完了" }
        return "未完了"
    }

    private var reviewIcon: String {
        if candidate.promotionEligible { return "checkmark.seal.fill" }
        if candidate.review.isComplete { return "exclamationmark.circle" }
        return "circle.dotted"
    }
}

private struct BGMReviewGateCard<Control: View>: View {
    let title: String
    let detail: String
    let icon: String
    let isResolved: Bool
    @ViewBuilder let control: () -> Control

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: icon)
                    .frame(width: 18)
                    .foregroundStyle(isResolved ? .green : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.callout.weight(.semibold))
                    Text(detail).font(.caption2).foregroundStyle(.secondary)
                }
            }
            control()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: BGMReviewDesign.cardRadius))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(isResolved ? Color.green : Color.secondary.opacity(0.35))
                .frame(width: 3)
                .padding(.vertical, 8)
        }
    }
}
