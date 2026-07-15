import Combine
import Foundation

public struct CaptionReviewConflict: Identifiable, Equatable, Sendable {
    public let id: String
    public let loaded: CaptionReviewQueueItem
    public let current: CaptionReviewQueueItem
    public let workingText: String
    public let workingStartFrame: Int
    public let workingEndFrame: Int

    public init(
        loaded: CaptionReviewQueueItem,
        current: CaptionReviewQueueItem,
        workingText: String,
        workingStartFrame: Int,
        workingEndFrame: Int
    ) {
        id = "\(loaded.captionID):\(loaded.textHash):\(current.textHash)"
        self.loaded = loaded
        self.current = current
        self.workingText = workingText
        self.workingStartFrame = workingStartFrame
        self.workingEndFrame = workingEndFrame
    }
}

@MainActor
public final class CaptionReviewSession: ObservableObject {
    @Published public private(set) var document: CaptionReviewQueueDocument?
    @Published public private(set) var items: [CaptionReviewQueueItem] = []
    @Published public private(set) var selectedCaptionID: String?
    @Published public var draftText = ""
    @Published public var draftStartFrame = 0
    @Published public var draftEndFrame = 1
    @Published public var isAutosaveEnabled = true
    @Published public var reviewer: String
    @Published public private(set) var isBusy = false
    @Published public private(set) var statusMessage = "字幕ドラフトを読み込んでいます。"
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var conflict: CaptionReviewConflict?
    @Published public private(set) var requiresManualConflictSave = false
    @Published public private(set) var isTextCompositionActive = false

    public let projectURL: URL
    public let repositoryRoot: URL
    private var autosaveTask: Task<Void, Never>?

    public init(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String = NSFullUserName()
    ) {
        self.projectURL = projectURL
        self.repositoryRoot = repositoryRoot
        self.reviewer = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var selectedItem: CaptionReviewQueueItem? {
        guard let selectedCaptionID else { return nil }
        return items.first { $0.captionID == selectedCaptionID }
    }

    public var hasUnsavedTextChange: Bool {
        guard let selectedItem else { return false }
        return draftText != selectedItem.text
    }

    public var hasUnsavedTimingChange: Bool {
        guard let selectedItem else { return false }
        return draftStartFrame != selectedItem.timelineInFrame || draftEndFrame != selectedItem.timelineOutFrame
    }

    public var hasUnsavedChange: Bool {
        hasUnsavedTextChange || hasUnsavedTimingChange
    }

    public var timelineOrderedItems: [CaptionReviewQueueItem] {
        items.sorted {
            $0.timelineInFrame < $1.timelineInFrame ||
                ($0.timelineInFrame == $1.timelineInFrame && $0.captionID < $1.captionID)
        }
    }

    public var previousTimelineItem: CaptionReviewQueueItem? {
        adjacentTimelineItem(offset: -1)
    }

    public var nextTimelineItem: CaptionReviewQueueItem? {
        adjacentTimelineItem(offset: 1)
    }

    public var canUndo: Bool {
        !isBusy && (document?.canUndo ?? false)
    }

    public var undoDepth: Int {
        document?.undoDepth ?? 0
    }

    public var canApprove: Bool {
        guard let document else { return false }
        return !isBusy &&
            !isTextCompositionActive &&
            document.blockingCount == 0 &&
            document.flaggedCount == 0 &&
            document.verifiedCount == document.items.count &&
            !reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func load(
        preferredCaptionID: String? = nil,
        preferredFrame: Int? = nil,
        statusOverride: String? = nil
    ) async {
        autosaveTask?.cancel()
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.load(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot
        )
        switch result {
        case let .success(document):
            self.document = document
            items = document.items
            statusMessage = statusOverride ?? "\(document.items.count)件の字幕をリスク順で読み込みました。"
            let requestedID = preferredCaptionID ?? selectedCaptionID
            let nextID = requestedID.flatMap { selectedID in
                items.contains { $0.captionID == selectedID } ? selectedID : nil
            } ?? preferredFrame.flatMap { frame in
                items.min { lhs, rhs in
                    abs(lhs.timelineInFrame - frame) < abs(rhs.timelineInFrame - frame)
                }?.captionID
            } ?? items.first?.captionID
            select(nextID)
        case let .failure(error):
            document = nil
            items = []
            selectedCaptionID = nil
            draftText = ""
            errorMessage = error.message
            statusMessage = "字幕レビューを読み込めませんでした。"
        }
        isBusy = false
    }

    public func select(_ captionID: String?) {
        autosaveTask?.cancel()
        conflict = nil
        requiresManualConflictSave = false
        isTextCompositionActive = false
        selectedCaptionID = captionID
        draftText = selectedItem?.text ?? ""
        draftStartFrame = selectedItem?.timelineInFrame ?? 0
        draftEndFrame = selectedItem?.timelineOutFrame ?? 1
    }

    public func scheduleAutosave() {
        autosaveTask?.cancel()
        guard CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: isTextCompositionActive,
            isAutosaveEnabled: isAutosaveEnabled,
            hasUnsavedChange: hasUnsavedChange,
            isBusy: isBusy,
            hasConflict: conflict != nil,
            requiresManualConflictSave: requiresManualConflictSave,
            hasSelectedCaption: selectedCaptionID != nil
        ), let captionID = selectedCaptionID else { return }
        autosaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled, let self,
                  self.selectedCaptionID == captionID,
                  self.hasUnsavedChange,
                  !self.isTextCompositionActive,
                  !self.isBusy else { return }
            await self.saveSelected(state: .unreviewed, isAutosave: true)
        }
    }

    public func handleTextChange(isCompositionActive: Bool) {
        autosaveTask?.cancel()
        self.isTextCompositionActive = isCompositionActive
        if isCompositionActive {
            statusMessage = "日本語入力の変換確定を待っています。"
            return
        }
        scheduleAutosave()
    }

    public func saveSelected(state: CaptionReviewState, isAutosave: Bool = false) async {
        guard !isTextCompositionActive else {
            errorMessage = "日本語入力を確定してから保存してください。"
            return
        }
        guard let selectedItem else { return }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            errorMessage = "レビュー担当者名を入力してください。"
            return
        }
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.edit(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            captionID: selectedItem.captionID,
            text: draftText,
            startFrame: draftStartFrame,
            endFrame: draftEndFrame,
            expectedTextHash: selectedItem.textHash,
            state: state,
            reviewer: actor
        )
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        isBusy = false
        if result.success {
            requiresManualConflictSave = false
            let message = isAutosave ? "\(selectedItem.captionID)を自動保存しました。" : result.message
            await load(preferredCaptionID: selectedItem.captionID, statusOverride: message)
        } else {
            await detectConflict(
                loaded: selectedItem,
                workingText: draftText,
                workingStartFrame: draftStartFrame,
                workingEndFrame: draftEndFrame
            )
        }
    }

    public func splitSelected(at splitFrame: Int) async {
        guard let selectedItem else { return }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            errorMessage = "レビュー担当者名を入力してください。"
            return
        }
        guard splitFrame > selectedItem.timelineInFrame, splitFrame < selectedItem.timelineOutFrame else {
            errorMessage = "分割位置は字幕の開始と終了の間に設定してください。"
            return
        }
        autosaveTask?.cancel()
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.split(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            captionID: selectedItem.captionID,
            splitFrame: splitFrame,
            expectedTextHash: selectedItem.textHash,
            reviewer: actor
        )
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        isBusy = false
        if result.success {
            await load(preferredFrame: selectedItem.timelineInFrame, statusOverride: result.message)
        }
    }

    public func mergeSelectedWithNext() async {
        guard let selectedItem, let nextItem = nextTimelineItem else { return }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            errorMessage = "レビュー担当者名を入力してください。"
            return
        }
        autosaveTask?.cancel()
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.merge(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            first: selectedItem,
            second: nextItem,
            reviewer: actor
        )
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        isBusy = false
        if result.success {
            await load(preferredCaptionID: selectedItem.captionID, preferredFrame: selectedItem.timelineInFrame, statusOverride: result.message)
        }
    }

    public func undoLastAction() async {
        guard canUndo else { return }
        autosaveTask?.cancel()
        let preferredFrame = selectedItem?.timelineInFrame
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.undo(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot
        )
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        isBusy = false
        if result.success {
            await load(preferredFrame: preferredFrame, statusOverride: result.message)
        }
    }

    public func proposeGlossaryTerm(canonical: String, variant: String) async {
        guard let selectedItem else { return }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            errorMessage = "レビュー担当者名を入力してください。"
            return
        }
        let normalizedCanonical = canonical.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCanonical.isEmpty else {
            errorMessage = "用語集へ追加する正しい表記を入力してください。"
            return
        }
        let normalizedVariant = variant.trimmingCharacters(in: .whitespacesAndNewlines)
        autosaveTask?.cancel()
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.proposeGlossaryTerm(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            captionID: selectedItem.captionID,
            canonical: normalizedCanonical,
            variants: normalizedVariant.isEmpty ? [] : [normalizedVariant],
            reviewer: actor
        )
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        isBusy = false
        if result.success {
            await load(preferredCaptionID: selectedItem.captionID, statusOverride: result.message)
        }
    }

    public func resolveConflictUsingCurrent() {
        guard let conflict else { return }
        self.conflict = nil
        errorMessage = nil
        statusMessage = "現在版を読み込みました。必要ならもう一度修正してください。"
        select(conflict.current.captionID)
    }

    public func resolveConflictKeepingWorkingCopy() {
        guard let conflict else { return }
        self.conflict = nil
        selectedCaptionID = conflict.current.captionID
        draftText = conflict.workingText
        draftStartFrame = conflict.workingStartFrame
        draftEndFrame = conflict.workingEndFrame
        requiresManualConflictSave = true
        errorMessage = nil
        statusMessage = "現在版を基準に作業案を保持しました。内容を確認して保存してください。"
    }

    public func dismissConflict() {
        conflict = nil
        errorMessage = nil
        statusMessage = "競合解決を保留しました。現在版を読み込み直してから編集してください。"
        if let selectedCaptionID {
            select(selectedCaptionID)
        }
    }

    public func selectPreviousInTimeline() {
        select(previousTimelineItem?.captionID)
    }

    public func selectNextInTimeline() {
        select(nextTimelineItem?.captionID)
    }

    public func approve() async {
        guard canApprove else {
            errorMessage = "修正必須・要確認・未確認の字幕を解消してから承認してください。"
            return
        }
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.approve(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        isBusy = false
    }

    private func adjacentTimelineItem(offset: Int) -> CaptionReviewQueueItem? {
        guard let selectedCaptionID,
              let index = timelineOrderedItems.firstIndex(where: { $0.captionID == selectedCaptionID }) else {
            return nil
        }
        let adjacentIndex = index + offset
        guard timelineOrderedItems.indices.contains(adjacentIndex) else { return nil }
        return timelineOrderedItems[adjacentIndex]
    }


    private func detectConflict(
        loaded: CaptionReviewQueueItem,
        workingText: String,
        workingStartFrame: Int,
        workingEndFrame: Int
    ) async {
        let refreshed = await CaptionReviewRunner.load(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot
        )
        guard case let .success(document) = refreshed,
              let current = document.items.first(where: { $0.captionID == loaded.captionID }),
              current.textHash != loaded.textHash else { return }
        self.document = document
        items = document.items
        selectedCaptionID = current.captionID
        conflict = CaptionReviewConflict(
            loaded: loaded,
            current: current,
            workingText: workingText,
            workingStartFrame: workingStartFrame,
            workingEndFrame: workingEndFrame
        )
        errorMessage = "別の編集で字幕が更新されています。差分を確認してください。"
    }
}
