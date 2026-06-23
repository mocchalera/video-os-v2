import Foundation

public struct ProjectMarlinEvaluationStatus: Equatable, Sendable {
    public let projectURL: URL
    public let analysisDefaultsURL: URL
    public let artifactURL: URL
    public let segmentsURL: URL
    public let artifactExists: Bool
    public let artifactReadable: Bool
    public let segmentsExists: Bool
    public let segmentsReadable: Bool
    public let policyEnabled: Bool?
    public let policyMode: String?
    public let policyModelAlias: String?
    public let policyMock: Bool?
    public let artifactModelAlias: String?
    public let artifactModelSnapshot: String?
    public let artifactConnectorVersion: String?
    public let artifactInferenceMode: String?
    public let assetCount: Int
    public let eventCount: Int
    public let findResultCount: Int
    public let segmentCount: Int
    public let segmentsWithMarlinPeakCount: Int
    public let materializableSegmentCount: Int
    public let marlinInterestPointCount: Int

    public var readinessLabel: String {
        if artifactExists, !artifactReadable { return "artifact unreadable" }
        if !artifactExists { return "not evaluated" }
        if isMockArtifact { return "mock evaluation" }
        if eventCount == 0, findResultCount == 0 { return "no temporal events" }
        if segmentsExists, !segmentsReadable { return "segments unreadable" }
        if segmentCount > 0,
           coverageRatio < 0.3,
           materializableSegmentCount > 0 {
            return "needs segment materialization"
        }
        if canPreferMarlin {
            return "candidate for preferred VLM"
        }
        return "needs more footage evaluation"
    }

    public var coverageRatio: Double {
        guard segmentCount > 0 else { return 0 }
        let covered = max(segmentsWithMarlinPeakCount, marlinInterestPointCount)
        return Double(covered) / Double(segmentCount)
    }

    public var canPreferMarlin: Bool {
        artifactReadable
            && !isMockArtifact
            && (eventCount + findResultCount) > 0
            && segmentCount > 0
            && coverageRatio >= 0.3
            && segmentsWithMarlinPeakCount > 0
    }

    public var isMockArtifact: Bool {
        artifactInferenceMode == "mock" || artifactModelSnapshot == "mock"
    }

    public var modelLabel: String {
        artifactModelAlias ?? policyModelAlias ?? "NemoStation/Marlin-2B"
    }

    public var recommendation: String {
        switch readinessLabel {
        case "candidate for preferred VLM":
            return "Marlin evidence is affecting segment peak selection. Keep hybrid fallback, but this project is a candidate for Marlin-first temporal semantics."
        case "mock evaluation":
            return "This Marlin artifact was produced in mock mode. Use it for workflow QA only; run a live Marlin-2B pass before counting it as preference evidence."
        case "needs segment materialization":
            return "Marlin events exist, but segments do not show Marlin-derived peaks yet. Run marlin-materialize to apply existing evidence before changing VLM priority."
        case "needs more footage evaluation":
            return "Marlin produced evidence, but coverage is still too low for a default preference decision. Test more representative interview and music-video footage."
        case "no temporal events":
            return "The artifact decoded, but no timestamped event or find evidence was produced."
        case "artifact unreadable":
            return "Fix or regenerate 03_analysis/marlin_events.json before evaluating Marlin."
        default:
            return "Run a local Marlin-2B analysis pass before considering it as the preferred temporal VLM."
        }
    }
}

public enum ProjectMarlinEvaluationStatusReader {
    public static func status(projectURL: URL, repositoryRoot: URL? = nil) -> ProjectMarlinEvaluationStatus {
        let root = repositoryRoot ?? inferRepositoryRoot(from: projectURL)
        let defaultsURL = root.appendingPathComponent("runtime/analysis-defaults.yaml")
        let artifactURL = projectURL.appendingPathComponent("03_analysis/marlin_events.json")
        let segmentsURL = projectURL.appendingPathComponent("03_analysis/segments.json")
        let fileManager = FileManager.default
        let policy = MarlinPolicySummary.load(from: defaultsURL)

        let artifactExists = fileManager.fileExists(atPath: artifactURL.path)
        let segmentsExists = fileManager.fileExists(atPath: segmentsURL.path)
        let artifact = try? MarlinEventDocument.load(from: artifactURL)
        let segments = try? AnalysisSegmentDocument.load(from: segmentsURL)

        let items = artifact?.items ?? []
        let segmentItems = segments?.items ?? []
        let marlinInterestPoints = segmentItems.reduce(0) { count, segment in
            count + segment.interestPoints.filter { point in
                point.source?.hasPrefix("marlin") == true
            }.count
        }

        let segmentsWithMarlinPeak = segmentItems.filter { isMarlinPeak($0.peakAnalysis) }.count
        let materializableSegments = materializableSegmentCount(segments: segmentItems, artifactItems: items)

        return ProjectMarlinEvaluationStatus(
            projectURL: projectURL,
            analysisDefaultsURL: defaultsURL,
            artifactURL: artifactURL,
            segmentsURL: segmentsURL,
            artifactExists: artifactExists,
            artifactReadable: artifactExists ? artifact != nil : false,
            segmentsExists: segmentsExists,
            segmentsReadable: segmentsExists ? segments != nil : false,
            policyEnabled: policy?.enabled,
            policyMode: policy?.mode,
            policyModelAlias: policy?.modelAlias,
            policyMock: policy?.mock,
            artifactModelAlias: artifact?.model.modelAlias,
            artifactModelSnapshot: artifact?.model.modelSnapshot,
            artifactConnectorVersion: artifact?.model.connectorVersion,
            artifactInferenceMode: artifact?.model.inferenceMode,
            assetCount: items.count,
            eventCount: items.reduce(0) { $0 + $1.events.count },
            findResultCount: items.reduce(0) { $0 + $1.findResults.count },
            segmentCount: segmentItems.count,
            segmentsWithMarlinPeakCount: segmentsWithMarlinPeak,
            materializableSegmentCount: materializableSegments,
            marlinInterestPointCount: marlinInterestPoints
        )
    }

    private static func inferRepositoryRoot(from projectURL: URL) -> URL {
        let projectsURL = projectURL.deletingLastPathComponent()
        if projectsURL.lastPathComponent == "projects" {
            return projectsURL.deletingLastPathComponent()
        }
        return projectURL
    }

    private static func isMarlinPeak(_ peak: SegmentPeakAnalysis?) -> Bool {
        guard let provenance = peak?.provenance else { return false }
        if provenance.precisionMode == "marlin_temporal_semantics" { return true }
        return provenance.fusionVersion?.hasPrefix("marlin") == true
    }

    private static func materializableSegmentCount(
        segments: [AnalysisSegment],
        artifactItems: [MarlinAssetEvents]
    ) -> Int {
        let materializableAssetIDs = Set(
            artifactItems
                .filter { !$0.scene.isEmpty || !$0.events.isEmpty || !$0.findResults.isEmpty }
                .map(\.assetID)
        )
        return segments.filter { segment in
            !isMarlinPeak(segment.peakAnalysis)
                && materializableAssetIDs.contains(segment.assetID)
        }.count
    }
}

private struct MarlinPolicySummary: Equatable {
    let enabled: Bool?
    let mode: String?
    let modelAlias: String?
    let mock: Bool?

    static func load(from url: URL) -> MarlinPolicySummary? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        var inMarlinSection = false
        var values: [String: String] = [:]

        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if rawLine.hasPrefix("marlin:") {
                inMarlinSection = true
                continue
            }
            if inMarlinSection, !rawLine.hasPrefix(" "), !rawLine.hasPrefix("\t") {
                break
            }
            guard inMarlinSection, let separator = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<separator])
            let rawValue = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            if !rawValue.isEmpty {
                values[key] = rawValue.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }
        }

        return MarlinPolicySummary(
            enabled: parseBool(values["enabled"]),
            mode: values["mode"],
            modelAlias: values["model_alias"],
            mock: parseBool(values["mock"])
        )
    }

    private static func parseBool(_ value: String?) -> Bool? {
        guard let value else { return nil }
        switch value.lowercased() {
        case "true": return true
        case "false": return false
        default: return nil
        }
    }
}
