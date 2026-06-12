import CryptoKit
import Foundation

/// Playback contract — is `preview-manifest.json` still derived from the
/// current `timeline.json`?
///
/// Review surfaces must not present playback as approval-grade when the
/// manifest predates the timeline on disk. The deterministic compiler
/// stamps `base_timeline_hash` into the manifest; this reader re-derives
/// the hash and classifies the contract state.
///
/// Mirrors `runtime/preview/playback-contract.ts` — keep the two in sync.
public enum ProjectPlaybackContractState: String, Equatable, Sendable {
    case exact
    case stale
    case legacyManifest = "legacy_manifest"
    case missingManifest = "missing_manifest"
    case missingTimeline = "missing_timeline"
}

public struct ProjectPlaybackContractStatus: Equatable, Sendable {
    public let state: ProjectPlaybackContractState
    public let timelineHash: String?
    public let manifestBaseTimelineHash: String?

    /// True only when playback can be treated as approval-grade.
    public var isApprovalGrade: Bool {
        state == .exact
    }

    public var readinessLabel: String {
        switch state {
        case .exact: return "exact preview"
        case .stale: return "stale preview"
        case .legacyManifest: return "legacy preview manifest"
        case .missingManifest: return "no preview manifest"
        case .missingTimeline: return "no timeline"
        }
    }

    public var recommendation: String {
        switch state {
        case .exact:
            return "Preview manifest matches the current timeline. Playback is approval-grade."
        case .stale:
            return "Timeline changed after the preview manifest was generated. Recompile before approving."
        case .legacyManifest:
            return "Preview manifest predates contract stamping. Recompile to make playback approval-grade."
        case .missingManifest:
            return "No preview manifest. Compile the timeline to generate one."
        case .missingTimeline:
            return "No timeline.json. Compile the rough cut first."
        }
    }
}

public enum ProjectPlaybackContractStatusReader {
    public static func status(projectURL: URL) -> ProjectPlaybackContractStatus {
        let timelineURL = projectURL.appendingPathComponent("05_timeline/timeline.json")
        let manifestURL = projectURL.appendingPathComponent("05_timeline/preview-manifest.json")

        guard let timelineData = try? Data(contentsOf: timelineURL) else {
            return ProjectPlaybackContractStatus(
                state: .missingTimeline,
                timelineHash: nil,
                manifestBaseTimelineHash: nil
            )
        }
        let timelineHash = fileHash16(timelineData)

        guard let manifestData = try? Data(contentsOf: manifestURL) else {
            return ProjectPlaybackContractStatus(
                state: .missingManifest,
                timelineHash: timelineHash,
                manifestBaseTimelineHash: nil
            )
        }

        guard
            let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
            let baseHash = manifest["base_timeline_hash"] as? String,
            !baseHash.isEmpty
        else {
            return ProjectPlaybackContractStatus(
                state: .legacyManifest,
                timelineHash: timelineHash,
                manifestBaseTimelineHash: nil
            )
        }

        return ProjectPlaybackContractStatus(
            state: baseHash == timelineHash ? .exact : .stale,
            timelineHash: timelineHash,
            manifestBaseTimelineHash: baseHash
        )
    }

    /// Canonical artifact hash: sha256 of the raw file bytes, first 16 hex
    /// chars. Same definition as runtime/state/reconcile.computeFileHash.
    public static func fileHash16(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}
