import Combine
import Foundation

@MainActor
public final class BGMReviewSession: ObservableObject {
    @Published public private(set) var document: BGMShortlistReviewDocument?
    @Published public private(set) var queueURL: URL?
    @Published public private(set) var selectedCandidateID: String?
    @Published public private(set) var resolvedAudioURL: URL?
    @Published public private(set) var isSourceVerified = false
    @Published public private(set) var isBusy = false
    @Published public private(set) var statusMessage = "BGMレビューキューを選択してください。"
    @Published public private(set) var errorMessage: String?
    @Published public var reviewer: String
    @Published public var musicalFit: BGMMusicalFit = .pending
    @Published public var dialogueBed: BGMPassFailReview = .pending
    @Published public var artifactQuality: BGMPassFailReview = .pending
    @Published public var originality: BGMOriginalityReview = .pending
    @Published public var rights: BGMRightsReview = .pending
    @Published public var notesText = ""

    public let projectURL: URL
    public let repositoryRoot: URL
    private var sourceResolutionTask: Task<Void, Never>?

    public init(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String = NSFullUserName()
    ) {
        self.projectURL = projectURL
        self.repositoryRoot = repositoryRoot
        self.reviewer = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    deinit {
        sourceResolutionTask?.cancel()
    }

    public var selectedCandidate: BGMShortlistReviewCandidate? {
        document?.candidate(id: selectedCandidateID)
    }

    public var selectedTrack: BGMShortlistReviewTrack? {
        guard let selectedCandidateID else { return nil }
        return document?.track(containing: selectedCandidateID)
    }

    public var draftNotes: [String] {
        var seen = Set<String>()
        return notesText
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public var hasUnsavedChanges: Bool {
        guard let candidate = selectedCandidate else { return false }
        let reviewChanged = candidate.review.musicalFit != musicalFit
            || candidate.review.dialogueBed != dialogueBed
            || candidate.review.artifactQuality != artifactQuality
            || candidate.review.originality != originality
            || candidate.review.rights != rights
            || candidate.review.notes != draftNotes
        let reviewerChanged = candidate.review.reviewerRef != nil
            && candidate.review.reviewerRef != normalizedReviewer
        return reviewChanged || reviewerChanged
    }

    public var canSave: Bool {
        selectedCandidate != nil
            && isSourceVerified
            && !isBusy
            && !normalizedReviewer.isEmpty
            && hasUnsavedChanges
    }

    public var pendingCandidateCount: Int {
        document?.candidates.filter { !$0.review.isComplete }.count ?? 0
    }

    public func load(queueURL: URL, preferredCandidateID: String? = nil, statusOverride: String? = nil) async {
        sourceResolutionTask?.cancel()
        isBusy = true
        errorMessage = nil
        resolvedAudioURL = nil
        isSourceVerified = false
        let result = await Task.detached(priority: .userInitiated) {
            Result { try BGMReviewDocumentLoader.load(from: queueURL) }
        }.value
        switch result {
        case let .success(document):
            self.document = document
            self.queueURL = queueURL
            let candidateID = preferredCandidateID.flatMap { requested in
                document.candidate(id: requested) == nil ? nil : requested
            } ?? document.candidates.first(where: { !$0.review.isComplete })?.candidateID
                ?? document.candidates.first?.candidateID
            statusMessage = statusOverride ?? "\(document.candidates.count)候補を読み込みました。会話と重ねて確認してください。"
            select(candidateID)
        case let .failure(error):
            document = nil
            self.queueURL = nil
            selectedCandidateID = nil
            errorMessage = error.localizedDescription
            statusMessage = "BGMレビューキューを読み込めませんでした。"
        }
        isBusy = false
    }

    public func select(_ candidateID: String?) {
        sourceResolutionTask?.cancel()
        selectedCandidateID = candidateID
        resolvedAudioURL = nil
        isSourceVerified = false
        errorMessage = nil
        guard let candidate = selectedCandidate else {
            musicalFit = .pending
            dialogueBed = .pending
            artifactQuality = .pending
            originality = .pending
            rights = .pending
            notesText = ""
            return
        }
        musicalFit = candidate.review.musicalFit
        dialogueBed = candidate.review.dialogueBed
        artifactQuality = candidate.review.artifactQuality
        originality = candidate.review.originality
        rights = candidate.review.rights
        notesText = candidate.review.notes.joined(separator: "\n")
        if normalizedReviewer.isEmpty,
           let reviewerRef = candidate.review.reviewerRef,
           !reviewerRef.isEmpty {
            reviewer = reviewerRef
        }
        resolveSource(candidate)
    }

    public func saveSelected(advanceToNextPending: Bool = false) async {
        guard let queueURL, let candidate = selectedCandidate else { return }
        guard isSourceVerified else {
            errorMessage = "候補音源のSHA確認が完了していません。"
            return
        }
        guard !normalizedReviewer.isEmpty else {
            errorMessage = "レビュー担当者名を入力してください。"
            return
        }
        isBusy = true
        errorMessage = nil
        let result = await BGMReviewRunner.save(
            queueURL: queueURL,
            repositoryRoot: repositoryRoot,
            candidateID: candidate.candidateID,
            reviewer: normalizedReviewer,
            musicalFit: musicalFit,
            dialogueBed: dialogueBed,
            artifactQuality: artifactQuality,
            originality: originality,
            rights: rights,
            notes: draftNotes
        )
        isBusy = false
        guard result.success else {
            errorMessage = result.message
            statusMessage = "BGMレビューを保存できませんでした。"
            return
        }
        let previousCandidates = document?.candidates ?? []
        let nextCandidateID = advanceToNextPending
            ? nextPendingCandidateID(after: candidate.candidateID, candidates: previousCandidates)
            : candidate.candidateID
        await load(queueURL: queueURL, preferredCandidateID: nextCandidateID, statusOverride: result.message)
    }

    public func resetDraftToPending() {
        musicalFit = .pending
        dialogueBed = .pending
        artifactQuality = .pending
        originality = .pending
        rights = .pending
        notesText = ""
    }

    private var normalizedReviewer: String {
        reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func resolveSource(_ candidate: BGMShortlistReviewCandidate) {
        guard let queueURL else { return }
        statusMessage = "\(candidate.candidateID) の元音源をSHA確認しています。"
        sourceResolutionTask = Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                Result { try BGMReviewSourceResolver.resolve(candidate: candidate, queueURL: queueURL) }
            }.value
            guard !Task.isCancelled, let self, self.selectedCandidateID == candidate.candidateID else { return }
            switch result {
            case let .success(source):
                resolvedAudioURL = source.url
                isSourceVerified = true
                statusMessage = "元音源のSHAを確認しました。単体または会話重ねで試聴できます。"
            case let .failure(error):
                resolvedAudioURL = nil
                isSourceVerified = false
                errorMessage = error.localizedDescription
                statusMessage = "候補音源を検証できませんでした。"
            }
        }
    }

    private func nextPendingCandidateID(
        after candidateID: String,
        candidates: [BGMShortlistReviewCandidate]
    ) -> String? {
        guard let currentIndex = candidates.firstIndex(where: { $0.candidateID == candidateID }) else {
            return candidates.first(where: { !$0.review.isComplete })?.candidateID
        }
        let ordered = Array(candidates[(currentIndex + 1)...]) + Array(candidates[..<currentIndex])
        return ordered.first(where: { !$0.review.isComplete })?.candidateID ?? candidateID
    }
}
