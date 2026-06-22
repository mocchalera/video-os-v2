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

    public var pendingSwapCount: Int {
        pendingOps.filter { $0.opName == "replace_segment" }.count
    }

    public var changedClipIDs: [String] {
        Array(Set(pendingOps.compactMap(\.changedClipID))).sorted()
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
