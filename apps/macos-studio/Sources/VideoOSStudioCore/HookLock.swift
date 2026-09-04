import Foundation

public struct TimelineHookLock: Decodable, Equatable, Sendable {
    public let policy: String
    public let locked: Bool
    public let sequenceID: String
    public let lockRevision: Int
    public let fingerprint: String
    public let anchorIDs: [String]
    public let protectedClipIDs: [String]
    public let protectedBeatIDs: [String]
    public let reason: String

    enum CodingKeys: String, CodingKey {
        case policy
        case locked
        case sequenceID = "sequence_id"
        case lockRevision = "lock_revision"
        case fingerprint
        case anchorIDs = "anchor_ids"
        case protectedClipIDs = "protected_clip_ids"
        case protectedBeatIDs = "protected_beat_ids"
        case reason
    }

    public init(
        policy: String = "hook-lock/v1",
        locked: Bool = true,
        sequenceID: String,
        lockRevision: Int = 0,
        fingerprint: String,
        anchorIDs: [String],
        protectedClipIDs: [String],
        protectedBeatIDs: [String],
        reason: String
    ) {
        self.policy = policy
        self.locked = locked
        self.sequenceID = sequenceID
        self.lockRevision = lockRevision
        self.fingerprint = fingerprint
        self.anchorIDs = anchorIDs
        self.protectedClipIDs = protectedClipIDs
        self.protectedBeatIDs = protectedBeatIDs
        self.reason = reason
    }

    public var displayLabel: String {
        locked ? "Hook locked" : "Hook unlocked"
    }

    public var detailLabel: String {
        "Hook locked: " + String(protectedClipIDs.count) + " protected clip(s), " + String(protectedBeatIDs.count) + " protected beat(s)"
    }
}

public extension TimelineDocument {
    func hookLockRejection(for operation: ReviewPatchOperation) -> String? {
        guard let hookLock, hookLock.locked else { return nil }

        switch operation {
        case .addMarker, .addNote, .changeAudioFinish:
            return nil
        case let .insertSegment(beatID, _, _, timelineInFrame, durationFrames, _, _, _, _):
            if hookLock.protectedBeatIDs.contains(beatID) {
                return hookLockRejectionMessage(hookLock: hookLock, target: beatID)
            }
            let insertedOutFrame = timelineInFrame + durationFrames
            let overlapsProtectedClip = displayTracks
                .flatMap(\.clips)
                .contains { clip in
                    hookLock.protectedClipIDs.contains(clip.id)
                        && timelineInFrame < clip.timelineOutFrame
                        && clip.timelineInFrame < insertedOutFrame
                }
            return overlapsProtectedClip
                ? hookLockRejectionMessage(hookLock: hookLock, target: beatID)
                : nil
        default:
            let referencedClipIDs = operation.referencedClipIDs
            guard let protectedID = referencedClipIDs
                .intersection(Set(hookLock.protectedClipIDs))
                .sorted()
                .first else {
                return nil
            }
            return hookLockRejectionMessage(hookLock: hookLock, target: protectedID)
        }
    }

    func hookLockRejection(to next: TimelineDocument) -> String? {
        guard let currentLock = hookLock, currentLock.locked else { return nil }
        guard let nextLock = next.hookLock,
              nextLock.locked,
              nextLock.fingerprint == currentLock.fingerprint else {
            return "Hook is locked: the Hook fingerprint cannot change in Studio."
        }
        guard nextLock.policy == currentLock.policy,
              nextLock.sequenceID == currentLock.sequenceID,
              nextLock.lockRevision == currentLock.lockRevision,
              nextLock.anchorIDs == currentLock.anchorIDs,
              nextLock.protectedClipIDs == currentLock.protectedClipIDs,
              nextLock.protectedBeatIDs == currentLock.protectedBeatIDs,
              nextLock.reason == currentLock.reason else {
            return "Hook is locked: the authoritative Hook lock projection cannot change in Studio."
        }

        let currentClips = Dictionary(
            uniqueKeysWithValues: displayTracks
                .flatMap(\.clips)
                .filter { currentLock.protectedClipIDs.contains($0.id) }
                .map { ($0.id, $0) }
        )
        let nextClips = Dictionary(
            uniqueKeysWithValues: next.displayTracks
                .flatMap(\.clips)
                .filter { currentLock.protectedClipIDs.contains($0.id) }
                .map { ($0.id, $0) }
        )

        for clipID in currentLock.protectedClipIDs {
            guard let currentClip = currentClips[clipID],
                  let nextClip = nextClips[clipID] else {
                return hookLockRejectionMessage(hookLock: currentLock, target: clipID)
            }
            guard currentClip == nextClip else {
                return hookLockRejectionMessage(hookLock: currentLock, target: clipID)
            }
        }
        return nil
    }

    var hookLockStatusText: String? {
        hookLock?.locked == true ? hookLock?.displayLabel : nil
    }

    private func hookLockRejectionMessage(hookLock: TimelineHookLock, target: String) -> String {
        "Hook is locked: Studio mutation rejected for protected target \(target) (\(hookLock.reason))."
    }
}
