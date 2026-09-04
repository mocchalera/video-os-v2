import Combine
import Foundation

public enum CaptionReviewerRefreshPolicy {
    public static let delayNanoseconds: UInt64 = 300_000_000
    public static func shouldRefresh(from oldValue: String, to newValue: String) -> Bool {
        oldValue.trimmingCharacters(in: .whitespacesAndNewlines)
            != newValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

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

public enum CaptionVisualApprovalGate {
    public static func canonicalReceiptParityMatches(
        input: CaptionVisualTreatmentInputDocument,
        preview: CaptionCanonicalPreviewDocument
    ) -> Bool {
        preview.parityMatches == true
            && preview.visualInputHash == input.inputHash
            && preview.approvalHash == input.approvalHash
            && preview.visualTreatmentPatchHash == input.visualTreatmentPatchHash
            && preview.typographyPolicyHash == input.typographyPolicyHash
            && preview.textTimingHash == input.textTimingHash
            && preview.capabilityHash == input.capabilityHash
            && preview.platformSafeZoneProfileID == input.platformSafeZoneProfileID
            && preview.platformSafeZoneProfilePath == input.platformSafeZoneProfilePath
            && preview.platformSafeZoneProfileHash == input.platformSafeZoneProfileHash
            && (preview.evidenceKind != "preapproval" || preview.expectedPatchHash == input.visualTreatmentPatchHash)
    }
}

public enum CaptionVisualDraftResolution {
    public static func canBeginRebase(
        conflict: CaptionVisualReviewConflict?,
        isInFlight: Bool
    ) -> Bool {
        conflict != nil && !isInFlight
    }

    public static func successfulApplyConsumesConflict(
        _ conflict: CaptionVisualReviewConflict?
    ) -> Bool {
        // A successful service append is the single canonical history unit.
        // The stale conflict is consumed only after that append succeeds.
        conflict != nil
    }

    public static func rebase(
        _ draft: CaptionVisualTreatmentOperation,
        onto patchHash: String
    ) -> CaptionVisualTreatmentOperation {
        var rebased = draft
        rebased.expectedCurrentHash = patchHash
        return rebased
    }

    public static func adoptCurrent(_ current: CaptionVisualTreatmentOperation) -> CaptionVisualTreatmentOperation {
        var adopted = current
        adopted.expectedCurrentHash = nil
        return adopted
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
    @Published public var reviewer: String {
        didSet { scheduleReviewerReadinessRefresh(from: oldValue, to: reviewer) }
    }
    @Published public private(set) var isBusy = false
    @Published public private(set) var statusMessage = "字幕ドラフトを読み込んでいます。"
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var conflict: CaptionReviewConflict?
    @Published public private(set) var requiresManualConflictSave = false
    @Published public private(set) var isTextCompositionActive = false
    @Published public private(set) var approvalHash: String?
    @Published public private(set) var approvalStatus: String?
    @Published public private(set) var activeGenerationID: String?
    @Published public private(set) var activeFinalPath: String?
    @Published public private(set) var visualReview: CaptionVisualReviewDocument?
    @Published public private(set) var visualDraft: CaptionVisualTreatmentOperation?
    @Published public private(set) var visualConflict: CaptionVisualReviewConflict?
    @Published public private(set) var canonicalPreview: CaptionCanonicalPreviewDocument?
    @Published public private(set) var isVisualBusy = false
    @Published public private(set) var isVisualRebaseInFlight = false
    @Published public private(set) var visualStatusMessage = "グラフィカル字幕レビューは未開始です。"
    @Published public private(set) var visualErrorMessage: String?

    public let projectURL: URL
    public let repositoryRoot: URL
    public let fontRuntimeStatus: CaptionFontRuntimeStatus?
    private var autosaveTask: Task<Void, Never>?
    private var reviewerReadinessTask: Task<Void, Never>?

    public init(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String = NSFullUserName(),
        fontRuntimeStatus: CaptionFontRuntimeStatus? = nil
    ) {
        self.projectURL = projectURL
        self.repositoryRoot = repositoryRoot
        self.reviewer = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        self.fontRuntimeStatus = fontRuntimeStatus
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

    public var selectedVisualIdentity: CaptionVisualIdentity? {
        guard let selectedCaptionID else { return nil }
        return visualReview?.input?.identity(for: selectedCaptionID)
    }

    public var selectedVisualTreatment: CaptionVisualTreatmentOperation? {
        visualDraft ?? selectedVisualIdentity?.treatment
    }

    public var visualHasUnsavedChange: Bool {
        guard let visualDraft else { return false }
        return normalizedVisualOperation(visualDraft) != normalizedVisualOperation(selectedVisualIdentity?.treatment)
    }

    public var visualCapabilities: CaptionVisualTreatmentCapabilities? {
        visualReview?.capabilities
    }

    public var visualCanEdit: Bool {
        guard let selectedItem,
              selectedItem.reviewState == .verified,
              let input = visualReview?.input,
              let projection = input.projection(for: selectedCaptionID ?? ""),
              input.status == .ready || input.status == .fallback,
              input.rendererRoute.speechCaptions == "ffmpeg-libass",
              !reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !hasUnsavedChange,
              !isBusy,
              !isVisualBusy
        else { return false }
        return selectedVisualIdentity != nil && projection.effectSupported && projection.animationSupported
    }

    public var canUndoVisual: Bool {
        guard let history = visualReview?.patch?.session.actionOperationCounts else {
            return (visualReview?.patch?.session.lastActionOperationCount ?? 0) > 0
        }
        return !history.isEmpty
    }

    public var visualRiskCaptionIDs: Set<String> {
        guard let input = visualReview?.input else { return [] }
        let reasons = input.degradedReasons + input.blockedReasons + input.fallbacks.map {
            CaptionVisualReason(captionID: $0.captionID, reason: $0.reason)
        }
        return Set(reasons.map(\.captionID).filter { $0 != "__approval__" && $0 != "__accessibility__" && $0 != "__patch__" })
    }

    public var visualApprovalBlockers: [String] {
        guard visualReview != nil else { return [] }
        return visualIntegrityBlockers(requireVisualApprovalReceipt: visualReview?.approvalHash != nil)
    }

    private func visualIntegrityBlockers(requireVisualApprovalReceipt: Bool) -> [String] {
        var blockers: [String] = []
        if reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            blockers.append("レビュー担当者が未入力です。")
        }
        guard let input = visualReview?.input else {
            blockers.append("canonical visual inputを読み込んでください。")
            return blockers
        }
        if input.rendererRoute.speechCaptions != "ffmpeg-libass" {
            blockers.append("external/NLE routeのためcanonical Studio表示・承認を停止しています。")
        }
        if input.status == .blocked || input.status == .humanHold {
            blockers.append(contentsOf: input.blockedReasons.map { "\($0.captionID): \($0.reason)" })
        }
        if visualHasUnsavedChange {
            blockers.append("未保存のvisual patchがあります。保存してから承認してください。")
        }
        if let profile = visualReview?.safeZoneProfile, profile.isHumanHold {
            blockers.append("safe-zone profileは未検証またはHOLDです。実測値なしに安全範囲を保証できません。")
        }
        let hasPreapprovalEvidence = canonicalPreview?.evidenceKind == "preapproval"
            && canonicalPreview?.expectedPatchHash == input.visualTreatmentPatchHash
        if let selectedCaptionID {
            guard let projection = input.projection(for: selectedCaptionID) else {
                blockers.append("selected captionのcanonical resolved projectionがありません。exact previewと承認を停止しています。")
                return uniqueMessages(blockers)
            }
            if !projection.effectSupported || !projection.animationSupported {
                blockers.append("selected captionのeffect/animation capabilityが未対応です。近似表示と承認を停止しています。")
            }
            if !projection.studioPreviewSupported && !hasPreapprovalEvidence {
                blockers.append(contentsOf: projection.studioPreviewUnavailableReasons.map { "Studio exact preview unavailable: \($0)。canonical preapproval receiptが必要です。" })
            }
        }
        guard let preview = canonicalPreview else {
            blockers.append("canonical preview receiptがありません。更新してparityを確認してください。")
            return blockers
        }
        if !CaptionVisualApprovalGate.canonicalReceiptParityMatches(input: input, preview: preview) {
            blockers.append("Studio表示とcanonical previewのparityが一致しません。")
        }
        if preview.visualInputHash != visualReview?.inputHash {
            blockers.append("visual input hashがcanonical receiptと一致しません。")
        }
        if preview.approvalHash != input.approvalHash {
            blockers.append("caption approval hashがcanonical receiptと一致しません。")
        }
        if preview.visualTreatmentPatchHash != input.visualTreatmentPatchHash {
            blockers.append("visual patch hashがcanonical receiptと一致しません。")
        }
        if preview.typographyPolicyHash != input.typographyPolicyHash {
            blockers.append("typography policy hashがcanonical receiptと一致しません。")
        }
        if preview.textTimingHash != input.textTimingHash {
            blockers.append("text/timing hashがcanonical receiptと一致しません。")
        }
        if preview.capabilityHash != input.capabilityHash {
            blockers.append("capability hashがcanonical receiptと一致しません。")
        }
        if preview.platformSafeZoneProfileID != input.platformSafeZoneProfileID {
            blockers.append("safe-zone profile IDがcanonical receiptと一致しません。")
        }
        if preview.platformSafeZoneProfilePath != input.platformSafeZoneProfilePath {
            blockers.append("safe-zone profile pathがcanonical receiptと一致しません。")
        }
        if preview.platformSafeZoneProfileHash != input.platformSafeZoneProfileHash {
            blockers.append("safe-zone profile hashがcanonical receiptと一致しません。")
        }
        if requireVisualApprovalReceipt, visualReview?.approvalHash == nil {
            blockers.append("visual treatmentの人間承認receiptがありません。")
        }
        return uniqueMessages(blockers)
    }

    public var canApproveVisual: Bool {
        guard !isBusy,
              !isVisualBusy,
              !visualHasUnsavedChange,
              let input = visualReview?.input,
              input.status == .ready || input.status == .fallback,
              input.rendererRoute.speechCaptions == "ffmpeg-libass",
              !reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              approvalStatus == "approved" || document?.currentApproval?.status == "approved"
        else { return false }
        return visualIntegrityBlockers(requireVisualApprovalReceipt: false).isEmpty
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
        return !isBusy && !isTextCompositionActive
            && document.approvalReadiness.canApprove
            && approvalBlockers.isEmpty
    }

    public var approvalBlockers: [CaptionApprovalReadiness.Blocker] {
        guard let document else { return [] }
        var blockers = document.approvalReadiness.blockers
        if let runtimeBlocker = fontRuntimeStatus?.blocker(
            requiredFamily: document.captionStyle.fontFamily
        ), !blockers.contains(where: { $0.code == runtimeBlocker.code }) {
            blockers.append(runtimeBlocker)
        }
        if visualReview != nil && approvalStatus == "approved" {
            for message in visualApprovalBlockers {
                let blocker = CaptionApprovalReadiness.Blocker(code: "visual_parity", message: message)
                if !blockers.contains(blocker) { blockers.append(blocker) }
            }
        }
        return blockers
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
            repositoryRoot: repositoryRoot,
            reviewer: reviewer
        )
        switch result {
        case let .success(document):
            self.document = document
            items = document.items
            approvalHash = document.currentApproval?.hash
            approvalStatus = document.currentApproval?.status
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
            await refreshVisualStatusIfAvailable()
        case let .failure(error):
            document = nil
            items = []
            selectedCaptionID = nil
            draftText = ""
            visualReview = nil
            visualDraft = nil
            visualConflict = nil
            canonicalPreview = nil
            errorMessage = error.message
            statusMessage = "字幕レビューを読み込めませんでした。"
        }
        isBusy = false
    }

    public func select(_ captionID: String?) {
        autosaveTask?.cancel()
        conflict = nil
        visualConflict = nil
        requiresManualConflictSave = false
        isTextCompositionActive = false
        selectedCaptionID = captionID
        draftText = selectedItem?.text ?? ""
        draftStartFrame = selectedItem?.timelineInFrame ?? 0
        draftEndFrame = selectedItem?.timelineOutFrame ?? 1
        visualDraft = visualOperation(for: captionID)
    }

    public func reportVisualSelectionBlocked() {
        visualErrorMessage = "未保存のvisual patchがあります。保存またはResetしてから字幕を移動してください。"
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
            let blockerMessage = approvalBlockers.map(\.message).joined(separator: "\n")
            errorMessage = blockerMessage.isEmpty ? "承認条件を確認してください。" : blockerMessage
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
        if result.success {
            approvalHash = result.approvalHash
            approvalStatus = result.approvalStatus
            await load(statusOverride: result.message)
        }
        isBusy = false
    }

    public func refreshReviewerReadiness() async {
        await load(preferredCaptionID: selectedCaptionID)
    }

    public func initializeVisualReview() async {
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            visualErrorMessage = "レビュー担当者名を入力してください。"
            return
        }
        guard approvalStatus == "approved" || document?.currentApproval?.status == "approved" else {
            visualErrorMessage = "字幕のtext/timingを先に人間承認してください。"
            return
        }
        isBusy = true
        isVisualBusy = true
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.initializeVisualReview(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: actor
        )
        isVisualBusy = false
        isBusy = false
        visualStatusMessage = result.message
        if result.success {
            visualErrorMessage = nil
            await refreshVisualStatus()
        } else {
            visualErrorMessage = result.message
        }
    }

    public func refreshVisualStatus(
        accessibility: CaptionVisualAccessibility? = nil,
        preservingDraft: CaptionVisualTreatmentOperation? = nil
    ) async {
        isVisualBusy = true
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.visualStatus(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            accessibility: accessibility
        )
        isVisualBusy = false
        visualStatusMessage = result.message
        guard result.success, let document = result.document else {
            visualErrorMessage = result.message
            return
        }
        visualReview = document
        canonicalPreview = nil
        visualErrorMessage = nil
        visualDraft = preservingDraft ?? visualOperation(for: selectedCaptionID)
    }

    public func applyVisualTreatment(
        accessibility: CaptionVisualAccessibility? = nil,
        preserveConflictOnFailure: Bool = false
    ) async {
        guard let selectedCaptionID,
              let draft = visualDraft,
              let patchHash = visualReview?.patchHash,
              visualCanEdit
        else {
            visualErrorMessage = "確認済み字幕を選び、canonical visual stateを読み込んでください。"
            return
        }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            visualErrorMessage = "レビュー担当者名を入力してください。"
            return
        }
        var operation = draft
        operation.expectedCurrentHash = patchHash
        isBusy = true
        isVisualBusy = true
        if !preserveConflictOnFailure {
            visualConflict = nil
        }
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.applyVisualTreatment(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: actor,
            operation: operation,
            expectedPatchHash: patchHash,
            accessibility: accessibility
        )
        isVisualBusy = false
        isBusy = false
        visualStatusMessage = result.message
        if result.success, let document = result.document {
            visualReview = document
            visualDraft = visualOperation(for: selectedCaptionID)
            if CaptionVisualDraftResolution.successfulApplyConsumesConflict(visualConflict) {
                visualConflict = nil
            }
            visualErrorMessage = nil
            statusMessage = result.message
            await refreshPreapprovalPreview(accessibility: accessibility)
        } else {
            visualErrorMessage = result.message
            if isVisualStaleMessage(result.message) {
                visualConflict = CaptionVisualReviewConflict(
                    captionID: selectedCaptionID,
                    expectedPatchHash: patchHash,
                    currentPatchHash: patchHashFromStaleMessage(result.message),
                    message: "別のvisual編集でcanonical patchが更新されました。現在版をrefreshしてから作業を続けてください。"
                )
                await refreshVisualStatus(accessibility: accessibility, preservingDraft: draft)
            }
        }
    }

    public func rebaseVisualConflict(
        accessibility: CaptionVisualAccessibility? = nil
    ) async {
        guard CaptionVisualDraftResolution.canBeginRebase(conflict: visualConflict, isInFlight: isVisualRebaseInFlight) else {
            visualErrorMessage = "visual rebaseは既に実行中です。"
            return
        }
        guard let pendingDraft = visualDraft else {
            visualErrorMessage = "保持中のvisual draftがありません。"
            return
        }
        isVisualRebaseInFlight = true
        defer { isVisualRebaseInFlight = false }
        await refreshVisualStatus(accessibility: accessibility, preservingDraft: pendingDraft)
        guard let currentPatchHash = visualReview?.patchHash else {
            visualErrorMessage = "current canonical patch hashを取得できないためrebaseを停止しました。"
            return
        }
        let rebased = CaptionVisualDraftResolution.rebase(pendingDraft, onto: currentPatchHash)
        visualDraft = rebased
        await applyVisualTreatment(accessibility: accessibility, preserveConflictOnFailure: true)
    }

    public func discardVisualConflictAndAdoptCurrent(
        accessibility: CaptionVisualAccessibility? = nil
    ) async {
        await refreshVisualStatus(accessibility: accessibility)
        guard visualErrorMessage == nil else { return }
        resetVisualDraft()
    }

    public func undoVisualTreatment(
        accessibility: CaptionVisualAccessibility? = nil
    ) async {
        guard let patchHash = visualReview?.patchHash else {
            visualErrorMessage = "visual patch stateを読み込んでください。"
            return
        }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            visualErrorMessage = "レビュー担当者名を入力してください。"
            return
        }
        isBusy = true
        isVisualBusy = true
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.undoVisualTreatment(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: actor,
            expectedPatchHash: patchHash,
            accessibility: accessibility
        )
        isVisualBusy = false
        isBusy = false
        visualStatusMessage = result.message
        if result.success, let document = result.document {
            visualReview = document
            visualDraft = visualOperation(for: selectedCaptionID)
            visualConflict = nil
        } else {
            visualErrorMessage = result.message
            if isVisualStaleMessage(result.message) {
                visualConflict = CaptionVisualReviewConflict(
                    captionID: selectedCaptionID ?? "__visual__",
                    expectedPatchHash: patchHash,
                    currentPatchHash: patchHashFromStaleMessage(result.message),
                    message: "canonical visual historyが更新されています。refresh後にundo対象を確認してください."
                )
                await refreshVisualStatus(accessibility: accessibility, preservingDraft: visualDraft)
            }
        }
    }

    public func approveVisualTreatment(
        accessibility: CaptionVisualAccessibility? = nil
    ) async {
        guard visualReview != nil else {
            visualErrorMessage = "visual reviewを開始してください。"
            return
        }
        guard !visualHasUnsavedChange else {
            visualErrorMessage = "未保存のvisual patchがあります。先に保存してください。"
            return
        }
        guard let input = visualReview?.input,
              input.status == .ready || input.status == .fallback
        else {
            visualErrorMessage = visualApprovalBlockers.joined(separator: "\n")
            return
        }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            visualErrorMessage = "レビュー担当者名を入力してください。"
            return
        }
        guard approvalStatus == "approved" || document?.currentApproval?.status == "approved" else {
            visualErrorMessage = "字幕のtext/timingを先に人間承認してください。"
            return
        }
        guard canApproveVisual else {
            visualErrorMessage = visualApprovalBlockers.joined(separator: "\n")
            return
        }
        guard let expectedPatchHash = visualReview?.patchHash else {
            visualErrorMessage = "current visual patch hashがありません。承認を停止しました。"
            return
        }
        isBusy = true
        isVisualBusy = true
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.approveVisualTreatment(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: actor,
            expectedPatchHash: expectedPatchHash,
            accessibility: accessibility
        )
        isVisualBusy = false
        isBusy = false
        visualStatusMessage = result.message
        if result.success, let document = result.document {
            visualReview = document
            visualDraft = visualOperation(for: selectedCaptionID)
            visualErrorMessage = nil
            await refreshCanonicalPreview()
        } else {
            visualErrorMessage = result.message
        }
    }

    public func refreshCanonicalPreview() async {
        isBusy = true
        isVisualBusy = true
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.refreshCanonicalPreview(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot
        )
        isVisualBusy = false
        isBusy = false
        if result.success, let document = result.document {
            canonicalPreview = document
            visualStatusMessage = result.message
            visualErrorMessage = visualApprovalBlockers.isEmpty ? nil : visualApprovalBlockers.joined(separator: "\n")
        } else {
            visualStatusMessage = result.message
            visualErrorMessage = result.message
        }
    }

    public func refreshPreapprovalPreview(
        accessibility: CaptionVisualAccessibility? = nil
    ) async {
        guard let patchHash = visualReview?.patchHash else {
            visualErrorMessage = "candidate visual patch hashがありません。"
            return
        }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else {
            visualErrorMessage = "レビュー担当者名を入力してください。"
            return
        }
        isBusy = true
        isVisualBusy = true
        visualErrorMessage = nil
        let result = await CaptionReviewRunner.previewVisualTreatment(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: actor,
            expectedPatchHash: patchHash,
            accessibility: accessibility
        )
        isVisualBusy = false
        isBusy = false
        visualStatusMessage = result.message
        guard result.success, let document = result.document else {
            visualErrorMessage = result.message
            return
        }
        visualReview = document
        canonicalPreview = document.preapprovalPreviewDocument
        visualErrorMessage = visualApprovalBlockers.isEmpty ? nil : visualApprovalBlockers.joined(separator: "\n")
    }

    public func updateVisualDraft(_ operation: CaptionVisualTreatmentOperation) {
        guard selectedCaptionID == operation.captionID else { return }
        visualDraft = operation
    }

    public func nudgeVisualDraft(horizontal: Double = 0, vertical: Double = 0) {
        guard var operation = visualDraft ?? visualOperation(for: selectedCaptionID) else { return }
        var rect = operation.rect ?? defaultVisualRect(for: operation.anchor)
        rect.x = min(max(rect.x + horizontal, 0), max(0, 1 - rect.width))
        rect.y = min(max(rect.y + vertical, 0), max(0, 1 - rect.height))
        operation.rect = rect
        visualDraft = operation
    }

    public func resizeVisualDraft(delta: Double) {
        guard var operation = visualDraft ?? visualOperation(for: selectedCaptionID) else { return }
        let current = operation.referenceScale ?? 1
        operation.referenceScale = min(max(current + delta, 0.25), 4)
        visualDraft = operation
    }

    public func resetVisualDraft() {
        visualDraft = visualOperation(for: selectedCaptionID)
        visualConflict = nil
        visualErrorMessage = nil
    }

    public func dismissVisualConflict() {
        visualConflict = nil
        visualErrorMessage = nil
    }

    private func refreshVisualStatusIfAvailable() async {
        let patchURL = projectURL
            .appendingPathComponent("07_package", isDirectory: true)
            .appendingPathComponent("caption_visual_treatment_patch.json")
        guard FileManager.default.fileExists(atPath: patchURL.path) else {
            visualReview = nil
            visualDraft = nil
            visualConflict = nil
            visualStatusMessage = "グラフィカル字幕レビューは未開始です。"
            return
        }
        await refreshVisualStatus()
    }

    private func visualOperation(for captionID: String?) -> CaptionVisualTreatmentOperation? {
        guard let captionID,
              let identity = visualReview?.input?.identity(for: captionID)
        else { return nil }
        if let treatment = identity.treatment { return treatment }
        if let requested = identity.requestedTreatment { return requested }
        let preferredStyle = visualReview?.input?.projection(for: captionID)?.styleRef
            ?? document?.captionStyle.presetID
        let styleRef = preferredStyle.flatMap { candidate in
            visualReview?.capabilities?.styleRefs.contains(candidate) == true ? candidate : nil
        } ?? visualReview?.capabilities?.styleRefs.first ?? preferredStyle ?? "default"
        return CaptionVisualTreatmentOperation(
            captionID: identity.captionID,
            stableRootID: identity.stableRootID,
            anchor: .bottomCenter,
            rect: defaultVisualRect(for: .bottomCenter),
            styleRef: styleRef,
            referenceScale: 1,
            hierarchyRole: .speech,
            fallback: .registeredFallback
        )
    }

    private func defaultVisualRect(for anchor: CaptionVisualAnchor) -> CaptionVisualRect {
        let width = 0.72
        let height = 0.14
        let x: Double
        let y: Double
        switch anchor {
        case .topLeft, .center, .bottomLeft: x = 0.08
        case .topCenter, .bottomCenter: x = (1 - width) / 2
        case .topRight, .bottomRight: x = 1 - width - 0.08
        }
        switch anchor {
        case .topLeft, .topCenter, .topRight: y = 0.08
        case .center: y = (1 - height) / 2
        case .bottomLeft, .bottomCenter, .bottomRight: y = 1 - height - 0.08
        }
        return CaptionVisualRect(x: x, y: y, width: width, height: height)
    }

    private func normalizedVisualOperation(_ operation: CaptionVisualTreatmentOperation?) -> CaptionVisualTreatmentOperation? {
        guard var operation else { return nil }
        operation.expectedCurrentHash = nil
        return operation
    }

    private func isVisualStaleMessage(_ message: String) -> Bool {
        message.localizedCaseInsensitiveContains("changed since")
            || message.localizedCaseInsensitiveContains("expected=")
            || message.localizedCaseInsensitiveContains("stale")
    }

    private func patchHashFromStaleMessage(_ message: String) -> String? {
        guard let marker = message.range(of: "current=") else { return nil }
        let value = message[marker.upperBound...].split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == ")" }).first
        return value.map(String.init)
    }

    private func uniqueMessages(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    private func scheduleReviewerReadinessRefresh(from oldValue: String, to newValue: String) {
        reviewerReadinessTask?.cancel()
        guard CaptionReviewerRefreshPolicy.shouldRefresh(from: oldValue, to: newValue) else { return }
        reviewerReadinessTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: CaptionReviewerRefreshPolicy.delayNanoseconds)
            guard !Task.isCancelled, let self, !self.isBusy else { return }
            await self.refreshReviewerReadiness()
        }
    }

    public func prepareDraft() async {
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.prepareDraft(projectURL: projectURL, repositoryRoot: repositoryRoot)
        isBusy = false
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        if result.success { await load(statusOverride: result.message) }
    }

    public func verifySafeCaptions() async {
        guard let document, let baseHash = document.baseCaptionDraftHash else { return }
        let actor = reviewer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actor.isEmpty else { errorMessage = "レビュー担当者名を入力してください。"; return }
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.verifySafe(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: actor,
            baseCaptionDraftHash: baseHash,
            items: document.items
        )
        isBusy = false
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        if result.success { await load(statusOverride: result.message) }
    }

    public func finalizeApprovedCaptions() async {
        guard approvalStatus == "approved" else { return }
        isBusy = true
        errorMessage = nil
        let result = await CaptionReviewRunner.finalize(projectURL: projectURL, repositoryRoot: repositoryRoot)
        isBusy = false
        statusMessage = result.message
        errorMessage = result.success ? nil : result.message
        if result.success {
            activeGenerationID = result.generationID
            activeFinalPath = result.finalPath
        }
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
