import Foundation

public struct TimelineAgentReviewPatchOperationSummary: Equatable, Identifiable, Sendable {
    public let id: String
    public let operationName: String
    public let targetLabel: String
    public let impactLabel: String
    public let isCompilerReady: Bool
    public let isStudioReady: Bool
}

public struct TimelineAgentReviewPatchDraft: Equatable, Sendable {
    public let patch: ReviewPatchDocument
    public let operationSummaries: [TimelineAgentReviewPatchOperationSummary]
    public let warnings: [String]

    public var operationCount: Int {
        operationSummaries.count
    }

    public var compilerReadyCount: Int {
        operationSummaries.filter(\.isCompilerReady).count
    }

    public var studioReadyCount: Int {
        operationSummaries.filter(\.isStudioReady).count
    }

    public var summaryLabel: String {
        "\(operationCount)件 / 保存可能 \(compilerReadyCount)件"
    }

    public static func extract(
        from assistantText: String,
        expectedTimelineVersion: String?,
        selectedClipIDs: Set<String> = []
    ) -> TimelineAgentReviewPatchDraft? {
        let candidates = jsonCandidates(from: assistantText)
        for candidate in candidates {
            guard let patch = decodePatch(from: candidate),
                  !patch.operations.isEmpty else {
                continue
            }
            return make(
                patch: patch,
                expectedTimelineVersion: expectedTimelineVersion,
                selectedClipIDs: selectedClipIDs
            )
        }
        return nil
    }

    private static func make(
        patch: ReviewPatchDocument,
        expectedTimelineVersion: String?,
        selectedClipIDs: Set<String>
    ) -> TimelineAgentReviewPatchDraft {
        var warnings: [String] = []
        if let expectedTimelineVersion,
           patch.timeline_version != expectedTimelineVersion {
            warnings.append("timeline_versionが現在のタイムラインと異なります。")
        }

        let operationSummaries = patch.operations.enumerated().map { index, operation in
            TimelineAgentReviewPatchOperationSummary(
                id: "\(index)-\(operation.opName)-\(operation.targetClipID ?? operation.changedClipID ?? "timeline")",
                operationName: operation.opName,
                targetLabel: operation.targetClipID ?? transitionTargetLabel(operation) ?? operation.changedClipID ?? "timeline",
                impactLabel: impactLabel(operation),
                isCompilerReady: operation.isValidForCompilerSchema,
                isStudioReady: operation.isValidForStudioSession
            )
        }

        let invalidStudioCount = operationSummaries.filter { !$0.isStudioReady }.count
        if invalidStudioCount > 0 {
            warnings.append("\(invalidStudioCount)件の操作はStudio候補として読み込めません。")
        }

        let compilerReadyCount = operationSummaries.filter(\.isCompilerReady).count
        if compilerReadyCount == 0 {
            warnings.append("timeline.jsonへ保存できる編集操作がありません。")
        }

        if !selectedClipIDs.isEmpty {
            let referencedClipIDs = Set(patch.operations.flatMap(\.referencedClipIDs))
            let outsideSelection = referencedClipIDs.subtracting(selectedClipIDs).sorted()
            if !outsideSelection.isEmpty {
                warnings.append("選択範囲外のclipを参照しています: \(outsideSelection.joined(separator: ", "))")
            }
        }

        return TimelineAgentReviewPatchDraft(
            patch: patch,
            operationSummaries: operationSummaries,
            warnings: warnings
        )
    }

    private static func transitionTargetLabel(_ operation: ReviewPatchOperation) -> String? {
        guard case let .setTransition(fromClipID, toClipID, trackID, _, _, _, _) = operation else {
            return nil
        }
        return "\(trackID):\(fromClipID)->\(toClipID)"
    }

    private static func impactLabel(_ operation: ReviewPatchOperation) -> String {
        switch operation {
        case let .trimSegment(_, sourceInUS, sourceOutUS, _):
            return "source \(formatMicroseconds(sourceInUS))-\(formatMicroseconds(sourceOutUS))"
        case let .moveSegment(_, timelineInFrame, durationFrames, targetTrackID, _):
            var parts = ["frame \(timelineInFrame)"]
            if let durationFrames {
                parts.append("duration \(durationFrames)f")
            }
            if let targetTrackID {
                parts.append("track \(targetTrackID)")
            }
            return parts.joined(separator: " / ")
        case let .replaceSegment(_, segmentID, candidateRef, sourceInUS, sourceOutUS, _):
            var parts = ["replace with \(segmentID)"]
            if let candidateRef {
                parts.append(candidateRef)
            }
            if let sourceInUS, let sourceOutUS {
                parts.append("source \(formatMicroseconds(sourceInUS))-\(formatMicroseconds(sourceOutUS))")
            }
            return parts.joined(separator: " / ")
        case let .splitSegment(_, splitFrame, _):
            return "split at frame \(splitFrame)"
        case .removeSegment:
            return "remove from timeline preview"
        case let .setTransition(_, _, trackID, transitionType, transitionFrames, appliedSkillID, _):
            var parts = ["\(trackID) \(transitionType)", "\(transitionFrames)f"]
            if let appliedSkillID {
                parts.append(appliedSkillID)
            }
            return parts.joined(separator: " / ")
        case let .insertSegment(_, segmentID, role, timelineInFrame, durationFrames, targetTrackID, sourceInUS, sourceOutUS, _):
            var parts = ["insert \(segmentID)", role, "frame \(timelineInFrame)"]
            parts.append("duration \(durationFrames)f")
            if let targetTrackID {
                parts.append("track \(targetTrackID)")
            }
            if let sourceInUS, let sourceOutUS {
                parts.append("source \(formatMicroseconds(sourceInUS))-\(formatMicroseconds(sourceOutUS))")
            }
            return parts.joined(separator: " / ")
        case let .changeAudioPolicy(clipID, policy, _):
            return "\(clipID) audio \(policy)"
        case let .addMarker(frame, label, _):
            return "marker \(frame): \(label)"
        case let .addNote(targetClipID, text):
            return "\(targetClipID) note: \(text)"
        }
    }

    private static func formatMicroseconds(_ value: Int) -> String {
        String(format: "%.3fs", Double(value) / 1_000_000)
    }

    private static func decodePatch(from candidate: String) -> ReviewPatchDocument? {
        guard let data = candidate.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        if let patch = try? decoder.decode(ReviewPatchDocument.self, from: data) {
            return patch
        }
        if let envelope = try? decoder.decode(TimelineAgentReviewPatchEnvelope.self, from: data) {
            return envelope.resolvedPatch
        }
        return nil
    }

    private static func jsonCandidates(from text: String) -> [String] {
        var candidates: [String] = []
        let nsText = text as NSString
        let pattern = #"```(?:json|review_patch)?\s*\n([\s\S]*?)```"#
        if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
            for match in regex.matches(in: text, range: NSRange(location: 0, length: nsText.length)) {
                guard match.numberOfRanges > 1 else { continue }
                candidates.append(nsText.substring(with: match.range(at: 1)))
            }
        }
        candidates.append(contentsOf: balancedJSONObjects(in: text))

        var seen: Set<String> = []
        return candidates
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .filter { candidate in
                if seen.contains(candidate) { return false }
                seen.insert(candidate)
                return true
            }
    }

    private static func balancedJSONObjects(in text: String) -> [String] {
        var results: [String] = []
        var depth = 0
        var startIndex: String.Index?
        var inString = false
        var isEscaped = false
        var index = text.startIndex

        while index < text.endIndex {
            let character = text[index]
            if inString {
                if isEscaped {
                    isEscaped = false
                } else if character == "\\" {
                    isEscaped = true
                } else if character == "\"" {
                    inString = false
                }
            } else if character == "\"" {
                inString = true
            } else if character == "{" {
                if depth == 0 {
                    startIndex = index
                }
                depth += 1
            } else if character == "}" {
                depth = max(0, depth - 1)
                if depth == 0, let objectStart = startIndex {
                    results.append(String(text[objectStart...index]))
                    startIndex = nil
                }
            }
            index = text.index(after: index)
        }
        return results
    }
}

private struct TimelineAgentReviewPatchEnvelope: Decodable {
    let review_patch: ReviewPatchDocument?
    let patch: ReviewPatchDocument?
    let timeline_version: String?
    let operations: [ReviewPatchOperation]?

    var resolvedPatch: ReviewPatchDocument? {
        if let review_patch { return review_patch }
        if let patch { return patch }
        guard let timeline_version, let operations else { return nil }
        return ReviewPatchDocument(timeline_version: timeline_version, operations: operations)
    }
}
