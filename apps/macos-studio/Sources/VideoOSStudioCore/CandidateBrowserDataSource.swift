import Foundation

public struct CandidateBrowserDataSource: Codable, Equatable, Sendable {
    public let projectID: String
    public let candidates: [BrowserCandidate]
    public let beatPlans: [BrowserBeatPlan]
    public let loadError: String?

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case candidates
        case beatPlans = "beat_plans"
        case loadError = "load_error"
    }

    public init(
        projectID: String,
        candidates: [BrowserCandidate],
        beatPlans: [BrowserBeatPlan],
        loadError: String? = nil
    ) {
        self.projectID = projectID
        self.candidates = candidates
        self.beatPlans = beatPlans
        self.loadError = loadError
    }

    public static func empty(projectID: String = "", loadError: String? = nil) -> CandidateBrowserDataSource {
        CandidateBrowserDataSource(projectID: projectID, candidates: [], beatPlans: [], loadError: loadError)
    }

    public static func load(projectURL: URL, repositoryRoot: URL) async -> CandidateBrowserDataSource {
        await Task.detached(priority: .userInitiated) {
            do {
                let output = try SubprocessRunner.run(
                    arguments: [
                        "npx",
                        "tsx",
                        "scripts/read-candidates.ts",
                        "--project",
                        projectURL.path,
                        "--json",
                    ],
                    currentDirectoryURL: repositoryRoot
                )
                guard output.exitCode == 0 else {
                    return CandidateBrowserDataSource.empty(
                        projectID: projectURL.lastPathComponent,
                        loadError: processFailureReason(output: output)
                    )
                }
                let data = Data(output.stdout.utf8)
                do {
                    return try JSONDecoder().decode(CandidateBrowserDataSource.self, from: data)
                } catch {
                    return CandidateBrowserDataSource.empty(
                        projectID: projectURL.lastPathComponent,
                        loadError: "Invalid candidate JSON: \(error)"
                    )
                }
            } catch {
                return CandidateBrowserDataSource.empty(
                    projectID: projectURL.lastPathComponent,
                    loadError: "Candidate reader failed to run: \(error)"
                )
            }
        }.value
    }

    public func candidates(forBeat beatID: String) -> [BrowserCandidate] {
        var ordered = candidates
            .filter { $0.eligible_beats.contains(beatID) }
            .sorted {
                if $0.confidence == $1.confidence {
                    return $0.id < $1.id
                }
                return $0.confidence > $1.confidence
            }

        var includedRefs = Set<String>()
        for candidate in ordered {
            includedRefs.formUnion(candidate.referenceKeys)
        }

        for ref in fallbacks(forBeat: beatID) where !includedRefs.contains(ref) {
            guard let candidate = candidates.first(where: { $0.matches(reference: ref) }) else {
                continue
            }
            ordered.append(candidate)
            includedRefs.formUnion(candidate.referenceKeys)
        }

        return ordered
    }

    public func fallbacks(forBeat beatID: String) -> [String] {
        beatPlans.first { $0.beat_id == beatID }?.fallback_candidate_refs ?? []
    }

    private static func processFailureReason(output: SubprocessRunner.Output) -> String {
        let diagnostic = firstNonEmptyDiagnostic(output.stderr, output.stdout)
        if let diagnostic {
            return "read-candidates exited with code \(output.exitCode): \(diagnostic)"
        }
        return "read-candidates exited with code \(output.exitCode)"
    }

    private static func firstNonEmptyDiagnostic(_ values: String...) -> String? {
        let diagnostic = values
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        guard let diagnostic else { return nil }
        return diagnostic.count > 280 ? "\(diagnostic.prefix(280))..." : diagnostic
    }
}

public struct BrowserCandidate: Codable, Equatable, Identifiable, Sendable {
    public var id: String { candidate_id ?? segment_id }
    public let candidate_id: String?
    public let segment_id: String
    public let asset_id: String
    public let key_frame_path: String?
    public let src_in_us: Int
    public let src_out_us: Int
    public let role: String
    public let confidence: Double
    public let why_it_matches: String
    public let risks: [String]
    public let eligible_beats: [String]
    public let story_role: String?
    public let evidence: [String]
    public let motif_tags: [String]
    public let trim_hint: BrowserTrimHint?
    public let editorial_signals: BrowserEditorialSignals?

    public init(
        candidate_id: String?,
        segment_id: String,
        asset_id: String,
        key_frame_path: String? = nil,
        src_in_us: Int,
        src_out_us: Int,
        role: String,
        confidence: Double,
        why_it_matches: String,
        risks: [String],
        eligible_beats: [String],
        story_role: String?,
        evidence: [String],
        motif_tags: [String],
        trim_hint: BrowserTrimHint?,
        editorial_signals: BrowserEditorialSignals?
    ) {
        self.candidate_id = candidate_id
        self.segment_id = segment_id
        self.asset_id = asset_id
        self.key_frame_path = key_frame_path
        self.src_in_us = src_in_us
        self.src_out_us = src_out_us
        self.role = role
        self.confidence = confidence
        self.why_it_matches = why_it_matches
        self.risks = risks
        self.eligible_beats = eligible_beats
        self.story_role = story_role
        self.evidence = evidence
        self.motif_tags = motif_tags
        self.trim_hint = trim_hint
        self.editorial_signals = editorial_signals
    }

    fileprivate var referenceKeys: Set<String> {
        Set([candidate_id, Optional(segment_id), Optional(id)].compactMap { $0 })
    }

    fileprivate func matches(reference: String) -> Bool {
        referenceKeys.contains(reference)
    }
}

public struct BrowserTrimHint: Codable, Equatable, Sendable {
    public let source_center_us: Int
    public let preferred_duration_us: Int
    public let recommended_in_us: Int
    public let recommended_out_us: Int
    public let peak_ref: String?
    public let rationale: String?

    public init(
        source_center_us: Int,
        preferred_duration_us: Int,
        recommended_in_us: Int,
        recommended_out_us: Int,
        peak_ref: String?,
        rationale: String?
    ) {
        self.source_center_us = source_center_us
        self.preferred_duration_us = preferred_duration_us
        self.recommended_in_us = recommended_in_us
        self.recommended_out_us = recommended_out_us
        self.peak_ref = peak_ref
        self.rationale = rationale
    }
}

public struct BrowserEditorialSignals: Codable, Equatable, Sendable {
    public let peak_ref: String?
    public let peak_type: String?
    public let peak_strength_score: Double

    public init(peak_ref: String?, peak_type: String?, peak_strength_score: Double) {
        self.peak_ref = peak_ref
        self.peak_type = peak_type
        self.peak_strength_score = peak_strength_score
    }
}

public struct BrowserBeatPlan: Codable, Equatable, Identifiable, Sendable {
    public var id: String { beat_id }
    public let beat_id: String
    public let label: String
    public let target_duration_frames: Int
    public let primary_candidate_ref: String?
    public let fallback_candidate_refs: [String]

    public init(
        beat_id: String,
        label: String,
        target_duration_frames: Int,
        primary_candidate_ref: String?,
        fallback_candidate_refs: [String]
    ) {
        self.beat_id = beat_id
        self.label = label
        self.target_duration_frames = target_duration_frames
        self.primary_candidate_ref = primary_candidate_ref
        self.fallback_candidate_refs = fallback_candidate_refs
    }
}
