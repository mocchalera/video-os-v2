import Combine
import Foundation

public struct PatchConflict: Equatable, Identifiable, Sendable {
    public let id: String
    public let clipID: String?
    public let message: String
    public let operationIndices: [Int]

    public init(id: String, clipID: String?, message: String, operationIndices: [Int]) {
        self.id = id
        self.clipID = clipID
        self.message = message
        self.operationIndices = operationIndices
    }
}

@MainActor
public final class StudioFeedbackSession: ObservableObject {
    @Published public private(set) var pendingOps: [ReviewPatchOperation] = []
    @Published public var approvedClipIDs: Set<String> = []
    @Published public var rejectedClipIDs: Set<String> = []
    @Published public private(set) var baseTimelineHash: String?
    @Published public private(set) var baseTimelineVersion: String?
    @Published public private(set) var patchHistory: [PatchHistoryRecord] = []
    @Published public private(set) var isDirty = false

    public init() {}

    public func addOp(_ op: ReviewPatchOperation) {
        guard op.isValidForStudioSession else { return }
        if let deduplicationKey = op.deduplicationKey {
            pendingOps.removeAll { $0.deduplicationKey == deduplicationKey }
        }
        pendingOps.append(op)
        updateDirtyState()
    }

    public func removePendingOps(targetClipID: String, opNames: Set<String>) {
        let originalCount = pendingOps.count
        pendingOps.removeAll { op in
            guard op.targetClipID == targetClipID else { return false }
            return opNames.contains(op.opName)
        }
        if pendingOps.count != originalCount {
            updateDirtyState()
        }
    }

    public func approveClip(_ clipID: String) {
        rejectedClipIDs.remove(clipID)
        removePendingOps(targetClipID: clipID, opNames: ["remove_segment"])
        approvedClipIDs.insert(clipID)
    }

    public func approveClips(_ clipIDs: some Sequence<String>) {
        for clipID in Set(clipIDs).sorted() {
            approveClip(clipID)
        }
    }

    public func rejectClip(_ clipID: String, reason: String) {
        approvedClipIDs.remove(clipID)
        removePendingOps(
            targetClipID: clipID,
            opNames: ["replace_segment", "trim_segment", "move_segment", "split_segment", "change_audio_policy", "change_visual_transform"]
        )
        pendingOps.removeAll { op in
            op.opName == "set_transition" && op.referencedClipIDs.contains(clipID)
        }
        addOp(.removeSegment(target_clip_id: clipID, reason: reason))
        rejectedClipIDs.insert(clipID)
        updateDirtyState()
    }

    public func rejectClips(_ clipIDs: some Sequence<String>, reason: String) {
        for clipID in Set(clipIDs).sorted() {
            rejectClip(clipID, reason: reason)
        }
    }

    public func queueRippleDelete(_ plan: TimelineRippleDeletePlan) {
        queueClipDeletion(deletedClipIDs: [plan.deletedClipID], operations: plan.operations)
    }

    public func queueRippleDelete(_ plan: TimelineRippleDeleteGroupPlan) {
        queueClipDeletion(deletedClipIDs: plan.deletedClipIDs, operations: plan.operations)
    }

    public func queueLiftDelete(_ plan: TimelineLiftDeletePlan) {
        queueClipDeletion(deletedClipIDs: plan.deletedClipIDs, operations: plan.operations)
    }

    private func queueClipDeletion(deletedClipIDs: [String], operations: [ReviewPatchOperation]) {
        let deletedClipIDSet = Set(deletedClipIDs)
        for clipID in deletedClipIDs {
            approvedClipIDs.remove(clipID)
            removePendingOps(
                targetClipID: clipID,
                opNames: ["replace_segment", "trim_segment", "move_segment", "split_segment", "change_audio_policy", "change_visual_transform"]
            )
        }
        pendingOps.removeAll { op in
            op.opName == "set_transition" && !op.referencedClipIDs.isDisjoint(with: deletedClipIDSet)
        }
        for operation in operations {
            if let targetClipID = operation.targetClipID,
               !deletedClipIDSet.contains(targetClipID),
               hasPendingRemove(for: targetClipID) {
                continue
            }
            addOp(operation)
        }
        rejectedClipIDs.formUnion(deletedClipIDSet)
    }

    public func removeOp(at index: Int) {
        guard pendingOps.indices.contains(index) else { return }
        pendingOps.remove(at: index)
        updateDirtyState()
    }

    public func clearAll() {
        pendingOps.removeAll()
        approvedClipIDs.removeAll()
        rejectedClipIDs.removeAll()
        updateDirtyState()
    }

    public func clearBaseline() {
        baseTimelineHash = nil
        baseTimelineVersion = nil
    }

    public func serialize(projectID: String) -> StudioPatchEnvelope {
        let version = baseTimelineVersion ?? "1"
        let compilerOperations = pendingOps.filter(\.isValidForCompilerSchema)
        let patch = ReviewPatchDocument(timeline_version: version, operations: compilerOperations)
        return StudioPatchEnvelope(
            project_id: projectID,
            created_at: Self.iso8601Now(),
            base_timeline_hash: baseTimelineHash ?? "",
            base_timeline_version: version,
            patch: patch,
            ui_state: StudioUIState(
                approved_clip_ids: approvedClipIDs.sorted(),
                rejected_clip_ids: rejectedClipIDs.sorted()
            )
        )
    }

    public func detectConflicts() -> [PatchConflict] {
        var conflicts: [PatchConflict] = []

        let approvedRejected = approvedClipIDs.intersection(rejectedClipIDs).sorted()
        for clipID in approvedRejected {
            conflicts.append(PatchConflict(
                id: "approved-rejected-\(clipID)",
                clipID: clipID,
                message: "Clip \(clipID) is both approved and rejected.",
                operationIndices: []
            ))
        }

        var operationsByClip: [String: [(index: Int, op: ReviewPatchOperation)]] = [:]
        for (index, op) in pendingOps.enumerated() {
            guard let clipID = op.targetClipID else { continue }
            operationsByClip[clipID, default: []].append((index, op))
        }

        for (clipID, operations) in operationsByClip {
            let removeIndices = operations
                .filter { $0.op.opName == "remove_segment" }
                .map { $0.index }
            guard !removeIndices.isEmpty else { continue }

            let incompatibleIndices = operations
                .filter { $0.op.opName != "remove_segment" }
                .map { $0.index }
            if !incompatibleIndices.isEmpty {
                conflicts.append(PatchConflict(
                    id: "remove-conflict-\(clipID)",
                    clipID: clipID,
                    message: "Clip \(clipID) has remove_segment plus another pending operation.",
                    operationIndices: (removeIndices + incompatibleIndices).sorted()
                ))
            }

            if approvedClipIDs.contains(clipID) {
                conflicts.append(PatchConflict(
                    id: "approved-remove-\(clipID)",
                    clipID: clipID,
                    message: "Clip \(clipID) is approved but also pending removal.",
                    operationIndices: removeIndices.sorted()
                ))
            }
        }

        return conflicts.sorted { $0.id < $1.id }
    }

    public func captureBaseline(from timeline: TimelineDocument) {
        baseTimelineHash = timeline.sourceHash ?? Self.fallbackHash(from: timeline)
        baseTimelineVersion = timeline.version
    }

    public func loadHistory(projectURL: URL) {
        patchHistory = PatchHistoryIndex.load(projectURL: projectURL).records
    }

    public func pruneHistory(projectURL: URL, maxBackups: Int = 20) {
        var index = PatchHistoryIndex.load(projectURL: projectURL)
        do {
            try index.pruneBackups(projectURL: projectURL, maxBackups: maxBackups)
            try index.save(projectURL: projectURL)
            patchHistory = index.records
        } catch {
            patchHistory = index.records
        }
    }

    public func hasPendingSwap(for clipID: String) -> Bool {
        pendingOps.contains {
            $0.opName == "replace_segment" && $0.targetClipID == clipID
        }
    }

    public func hasPendingRemove(for clipID: String) -> Bool {
        pendingOps.contains {
            $0.opName == "remove_segment" && $0.targetClipID == clipID
        }
    }

    public func hasPendingTrim(for clipID: String) -> Bool {
        pendingOps.contains {
            $0.opName == "trim_segment" && $0.targetClipID == clipID
        }
    }

    public func hasPendingMove(for clipID: String) -> Bool {
        pendingOps.contains {
            $0.opName == "move_segment" && $0.targetClipID == clipID
        }
    }

    public func hasPendingSplit(for clipID: String) -> Bool {
        pendingOps.contains {
            $0.opName == "split_segment" && $0.targetClipID == clipID
        }
    }

    public func pendingVisualTransform(for clipID: String) -> ReviewVisualTransform? {
        for op in pendingOps.reversed() {
            guard case let .changeVisualTransform(targetClipID, transform, _, _) = op,
                  targetClipID == clipID else { continue }
            return transform
        }
        return nil
    }

    public var pendingAudioFinish: ReviewAudioFinish? {
        for op in pendingOps.reversed() {
            guard case let .changeAudioFinish(audioFinish, _) = op else { continue }
            return audioFinish
        }
        return nil
    }

    public func pendingTrimBounds(for clipID: String) -> (sourceInUS: Int, sourceOutUS: Int)? {
        for op in pendingOps.reversed() {
            guard case let .trimSegment(targetClipID, sourceInUS, sourceOutUS, _) = op,
                  targetClipID == clipID else { continue }
            return (sourceInUS, sourceOutUS)
        }
        return nil
    }

    public var pendingSwapCount: Int {
        pendingOps.filter { $0.opName == "replace_segment" }.count
    }

    public var changedClipIDs: [String] {
        Array(Set(pendingOps.filter(\.isValidForCompilerSchema).compactMap(\.changedClipID))).sorted()
    }

    private func updateDirtyState() {
        isDirty = !pendingOps.isEmpty
    }

    private static func iso8601Now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func fallbackHash(from timeline: TimelineDocument) -> String {
        var fields = [
            timeline.version,
            timeline.projectID,
            timeline.sequence.name,
            "\(timeline.totalFrames)"
        ]
        fields += timeline.displayTracks.flatMap { track in
            [track.id, track.kind.rawValue] + track.clips.flatMap { clip in
                [
                    clip.id,
                    clip.segmentID,
                    "\(clip.timelineInFrame)",
                    "\(clip.timelineDurationFrames)"
                ]
            }
        }
        return ProjectPlaybackContractStatusReader.fileHash16(Data(fields.joined(separator: "\u{1f}").utf8))
    }
}
