import Foundation

enum StudioDragPayload {
    private static let sourceCandidatePrefix = "videoos-source-candidate"
    private static let transitionPrefix = "videoos-transition"
    private static let separator = "\t"

    static func sourceCandidate(assetID: String, candidateID: String) -> String {
        [sourceCandidatePrefix, assetID, candidateID].joined(separator: separator)
    }

    static func parseSourceCandidate(_ value: String) -> (assetID: String, candidateID: String)? {
        let parts = value.components(separatedBy: separator)
        guard parts.count == 3,
              parts[0] == sourceCandidatePrefix,
              !parts[1].isEmpty,
              !parts[2].isEmpty
        else {
            return nil
        }
        return (parts[1], parts[2])
    }

    static func transition(transitionID: String) -> String {
        [transitionPrefix, transitionID].joined(separator: separator)
    }

    static func parseTransition(_ value: String) -> String? {
        let parts = value.components(separatedBy: separator)
        guard parts.count == 2,
              parts[0] == transitionPrefix,
              !parts[1].isEmpty
        else {
            return nil
        }
        return parts[1]
    }

    static func parseTransitionPresetID(_ value: String) -> String? {
        guard parseSourceCandidate(value) == nil else { return nil }
        guard parseTransition(value) == nil else { return nil }
        return value.isEmpty ? nil : value
    }
}
