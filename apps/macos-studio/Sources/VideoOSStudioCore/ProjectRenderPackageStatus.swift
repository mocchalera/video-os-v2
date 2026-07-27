import Foundation

public struct ProjectRenderLayoutQAReviewItem: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { issueID }

    public let issueID: String
    public let code: String
    public let severity: String
    public let title: String
    public let remediation: String
    public let layerIDs: [String]
    public let startFrame: Int?
    public let endFrame: Int?
    public let startTimecode: String?
    public let endTimecode: String?

    public var timeRangeLabel: String {
        if let startTimecode, let endTimecode {
            return "\(startTimecode)–\(endTimecode)"
        }
        if let startFrame, let endFrame {
            return "\(startFrame)f–\(endFrame)f"
        }
        return "全体"
    }

    enum CodingKeys: String, CodingKey {
        case issueID = "issue_id"
        case code
        case severity
        case title = "title_ja"
        case remediation = "remediation_ja"
        case layerIDs = "layer_ids"
        case startFrame = "start_frame"
        case endFrame = "end_frame"
        case startTimecode = "start_timecode"
        case endTimecode = "end_timecode"
    }
}

public struct ProjectRenderSpeechCadenceReviewItem: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { issueID }

    public let issueID: String
    public let code: String
    public let severity: String
    public let clipID: String
    public let assetID: String
    public let silenceEventID: String
    public let timelineStartFrame: Int
    public let timelineEndFrame: Int
    public let startTimecode: String
    public let endTimecode: String
    public let durationMS: Int
    public let suggestedAction: String
    public let title: String
    public let remediation: String

    public var timeRangeLabel: String {
        "\(startTimecode)–\(endTimecode)"
    }

    public var durationLabel: String {
        String(format: "%.1f秒", Double(durationMS) / 1_000)
    }

    public var suggestedActionLabel: String {
        switch suggestedAction {
        case "trim_in": return "IN点を詰める"
        case "jump_cut": return "ジャンプカット候補"
        case "trim_out": return "OUT点を詰める"
        default: return suggestedAction
        }
    }

    enum CodingKeys: String, CodingKey {
        case issueID = "issue_id"
        case code
        case severity
        case clipID = "clip_id"
        case assetID = "asset_id"
        case silenceEventID = "silence_event_id"
        case timelineStartFrame = "timeline_start_frame"
        case timelineEndFrame = "timeline_end_frame"
        case startTimecode = "start_timecode"
        case endTimecode = "end_timecode"
        case durationMS = "duration_ms"
        case suggestedAction = "suggested_action"
        case title = "title_ja"
        case remediation = "remediation_ja"
    }
}

public struct ProjectRenderCaptionDeliveryReviewItem: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { issueID }

    public let issueID: String
    public let code: String
    public let severity: String
    public let captionID: String
    public let assetID: String
    public let segmentID: String
    public let textExcerpt: String
    public let timelineStartFrame: Int
    public let timelineEndFrame: Int
    public let startTimecode: String
    public let endTimecode: String
    public let measuredMS: Int
    public let thresholdMS: Int
    public let suggestedAction: String
    public let title: String
    public let remediation: String

    public var timeRangeLabel: String {
        "\(startTimecode)–\(endTimecode)"
    }

    public var measurementLabel: String {
        let measured = String(format: "%.1f秒", Double(measuredMS) / 1_000)
        let threshold = String(format: "%.1f秒", Double(thresholdMS) / 1_000)
        return "\(measured)（基準 \(threshold)）"
    }

    public var suggestedActionLabel: String {
        switch suggestedAction {
        case "delay_in": return "字幕INを遅らせる"
        case "advance_in": return "字幕INを早める"
        case "extend_out": return "字幕OUTを延ばす"
        case "extend_read_time": return "読了時間を延ばす"
        default: return suggestedAction
        }
    }

    enum CodingKeys: String, CodingKey {
        case issueID = "issue_id"
        case code
        case severity
        case captionID = "caption_id"
        case assetID = "asset_id"
        case segmentID = "segment_id"
        case textExcerpt = "text_excerpt"
        case timelineStartFrame = "timeline_start_frame"
        case timelineEndFrame = "timeline_end_frame"
        case startTimecode = "start_timecode"
        case endTimecode = "end_timecode"
        case measuredMS = "measured_ms"
        case thresholdMS = "threshold_ms"
        case suggestedAction = "suggested_action"
        case title = "title_ja"
        case remediation = "remediation_ja"
    }
}

public struct ProjectRenderPackageStatus: Equatable, Sendable {
    public let projectURL: URL
    public let packageURL: URL
    public let qaReportURL: URL
    public let packageManifestURL: URL
    public let publishedFinalVideoURL: URL
    public let packageFinalVideoURL: URL
    public let finalMixURL: URL
    public let qaReportExists: Bool
    public let qaReportReadable: Bool
    public let qaPassed: Bool?
    public let qaProjectID: String?
    public let qaSourceOfTruth: String?
    public let qaCheckCount: Int
    public let qaFailedCheckCount: Int
    public let layoutQAStatus: String?
    public let layoutQAReviewItems: [ProjectRenderLayoutQAReviewItem]
    public let speechCadenceStatus: String?
    public let speechCadenceReviewItems: [ProjectRenderSpeechCadenceReviewItem]
    public let captionDeliveryStatus: String?
    public let captionDeliveryReviewItems: [ProjectRenderCaptionDeliveryReviewItem]
    public let packageManifestExists: Bool
    public let packageManifestReadable: Bool
    public let manifestProjectID: String?
    public let manifestSourceOfTruth: String?
    public let manifestCreatedAt: String?
    public let packageContractMatches: Bool
    public let publishedFinalVideoExists: Bool
    public let packageFinalVideoExists: Bool
    public let finalMixExists: Bool
    public let verificationStatus: ProjectPackageVerificationStatus

    public var layoutQAReviewSummary: String {
        switch layoutQAStatus {
        case "verified":
            return layoutQAReviewItems.isEmpty
                ? "レイアウト検証済み"
                : "検証結果不整合"
        case "blocked":
            return "要修正 \(layoutQAReviewItems.count)件"
        case "incomplete":
            return "証拠不足 \(layoutQAReviewItems.count)件"
        case .some(let status):
            return status
        case nil:
            return "未確認"
        }
    }

    public var speechCadenceReviewSummary: String {
        switch speechCadenceStatus {
        case "verified":
            return speechCadenceReviewItems.isEmpty
                ? "音声テンポ検証済み"
                : "検証結果不整合"
        case "review_required":
            return "間を確認 \(speechCadenceReviewItems.count)件"
        case "incomplete":
            return "波形証拠不足"
        case "not_applicable":
            return "対象外"
        case .some(let status):
            return status
        case nil:
            return "未確認"
        }
    }

    public var captionDeliveryReviewSummary: String {
        switch captionDeliveryStatus {
        case "verified":
            return captionDeliveryReviewItems.isEmpty
                ? "字幕タイミング検証済み"
                : "検証結果不整合"
        case "review_required":
            return "字幕タイミング確認 \(captionDeliveryReviewItems.count)件"
        case "incomplete":
            return "単語タイミング証拠不足"
        case "not_applicable":
            return "対象外"
        case .some(let status):
            return status
        case nil:
            return "未確認"
        }
    }

    public var readinessLabel: String {
        let anyArtifactExists = packageManifestExists || qaReportExists || packageFinalVideoExists
            || finalMixExists || publishedFinalVideoExists
        if !anyArtifactExists { return "not rendered" }
        if !missingRequiredArtifacts.isEmpty { return "package incomplete" }
        if verificationStatus.ready, !packageContractMatches { return "package contract mismatch" }
        return verificationStatus.readinessLabel
    }

    public var missingRequiredArtifacts: [String] {
        var missing: [String] = []
        if !qaReportExists {
            missing.append("07_package/qa-report.json")
        }
        if !packageManifestExists {
            missing.append("07_package/package_manifest.json")
        }
        if !publishedFinalVideoExists {
            missing.append("09_output/final.mp4")
        }
        return missing
    }
}

public enum ProjectRenderPackageStatusReader {
    public static func status(
        projectURL: URL,
        expectedProjectID: String? = nil,
        expectedSourceOfTruth: String? = nil,
        verificationStatus: ProjectPackageVerificationStatus = ProjectPackageVerificationRunner.pending()
    ) -> ProjectRenderPackageStatus {
        let packageURL = projectURL.appendingPathComponent("07_package")
        let deliveryResolution = ProjectActiveDeliveryReader.resolution(projectURL: projectURL)
        let activeDelivery: ProjectActiveDeliveryPaths?
        let legacyAllowed: Bool
        switch deliveryResolution {
        case .active(let paths):
            activeDelivery = paths
            legacyAllowed = false
        case .absent:
            activeDelivery = nil
            legacyAllowed = true
        case .invalid:
            activeDelivery = nil
            legacyAllowed = false
        }
        let failClosedURL = packageURL.appendingPathComponent(".invalid-active-delivery")
        let qaReportURL = activeDelivery?.qaReportURL ?? (legacyAllowed ? packageURL.appendingPathComponent("qa-report.json") : failClosedURL.appendingPathComponent("qa-report.json"))
        let manifestURL = activeDelivery?.packageManifestURL ?? (legacyAllowed ? packageURL.appendingPathComponent("package_manifest.json") : failClosedURL.appendingPathComponent("package_manifest.json"))
        let publishedFinalVideoURL = activeDelivery?.finalVideoURL ?? (legacyAllowed ? projectURL.appendingPathComponent("09_output/final.mp4") : failClosedURL.appendingPathComponent("final.mp4"))
        let packageFinalVideoURL = activeDelivery?.finalVideoURL ?? (legacyAllowed ? packageURL.appendingPathComponent("video/final.mp4") : failClosedURL.appendingPathComponent("package-final.mp4"))
        let finalMixURL = activeDelivery?.finalMixURL ?? (legacyAllowed ? packageURL.appendingPathComponent("audio/final_mix.wav") : failClosedURL.appendingPathComponent("final_mix.wav"))
        let fileManager = FileManager.default

        let qaReport = decode(ProjectPackageQAReport.self, from: qaReportURL)
        let manifest = decode(ProjectPackageManifest.self, from: manifestURL)
        let qaReportExists = fileManager.fileExists(atPath: qaReportURL.path)
        let manifestExists = fileManager.fileExists(atPath: manifestURL.path)
        let layoutQA = qaReport?.metrics?.deterministicLayoutQA
        let speechCadenceQA = qaReport?.metrics?.speechCadenceQA
        let captionDeliveryQA = qaReport?.metrics?.captionDeliveryQA
        let identityMatches = (expectedProjectID == nil || verificationStatus.projectID == expectedProjectID)
            && (expectedSourceOfTruth == nil || verificationStatus.sourceOfTruth == expectedSourceOfTruth)

        return ProjectRenderPackageStatus(
            projectURL: projectURL,
            packageURL: packageURL,
            qaReportURL: qaReportURL,
            packageManifestURL: manifestURL,
            publishedFinalVideoURL: publishedFinalVideoURL,
            packageFinalVideoURL: packageFinalVideoURL,
            finalMixURL: finalMixURL,
            qaReportExists: qaReportExists,
            qaReportReadable: qaReportExists ? qaReport != nil : false,
            qaPassed: qaReport?.passed,
            qaProjectID: qaReport?.projectID,
            qaSourceOfTruth: qaReport?.sourceOfTruth.rawValue,
            qaCheckCount: qaReport?.checks.count ?? 0,
            qaFailedCheckCount: qaReport?.checks.filter { !$0.passed }.count ?? 0,
            layoutQAStatus: layoutQA?.status,
            layoutQAReviewItems: layoutQA?.reviewItems ?? [],
            speechCadenceStatus: speechCadenceQA?.status,
            speechCadenceReviewItems: speechCadenceQA?.reviewItems ?? [],
            captionDeliveryStatus: captionDeliveryQA?.status,
            captionDeliveryReviewItems: captionDeliveryQA?.reviewItems ?? [],
            packageManifestExists: manifestExists,
            packageManifestReadable: manifestExists ? manifest != nil : false,
            manifestProjectID: manifest?.projectID,
            manifestSourceOfTruth: manifest?.sourceOfTruth.rawValue,
            manifestCreatedAt: manifest?.createdAt,
            packageContractMatches: verificationStatus.ready && identityMatches,
            publishedFinalVideoExists: fileManager.fileExists(atPath: publishedFinalVideoURL.path),
            packageFinalVideoExists: fileManager.fileExists(atPath: packageFinalVideoURL.path),
            finalMixExists: fileManager.fileExists(atPath: finalMixURL.path),
            verificationStatus: verificationStatus
        )
    }

    private static func decode<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

}

private struct ProjectPackageQAReport: Decodable {
    struct Check: Decodable {
        let name: String
        let passed: Bool
        let details: String
    }

    struct Metrics: Decodable {
        struct DeterministicLayoutQA: Decodable {
            let status: String
            let reviewItems: [ProjectRenderLayoutQAReviewItem]?

            enum CodingKeys: String, CodingKey {
                case status
                case reviewItems = "review_items"
            }
        }

        struct SpeechCadenceQA: Decodable {
            let status: String
            let reviewItems: [ProjectRenderSpeechCadenceReviewItem]?

            enum CodingKeys: String, CodingKey {
                case status
                case reviewItems = "review_items"
            }
        }

        struct CaptionDeliveryQA: Decodable {
            let status: String
            let reviewItems: [ProjectRenderCaptionDeliveryReviewItem]?

            enum CodingKeys: String, CodingKey {
                case status
                case reviewItems = "review_items"
            }
        }

        let deterministicLayoutQA: DeterministicLayoutQA?
        let speechCadenceQA: SpeechCadenceQA?
        let captionDeliveryQA: CaptionDeliveryQA?

        enum CodingKeys: String, CodingKey {
            case deterministicLayoutQA = "deterministic_layout_qa"
            case speechCadenceQA = "speech_cadence_qa"
            case captionDeliveryQA = "caption_delivery_qa"
        }
    }

    let version: String
    let projectID: String
    let sourceOfTruth: ProjectPackageSourceOfTruth
    let qaProfile: ProjectPackageSourceOfTruth
    let passed: Bool
    let checks: [Check]
    let metrics: Metrics?

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case qaProfile = "qa_profile"
        case passed
        case sourceOfTruth = "source_of_truth"
        case checks
        case metrics
    }
}

private enum ProjectPackageSourceOfTruth: String, Decodable {
    case engineRender = "engine_render"
    case nleFinishing = "nle_finishing"
}

private struct ProjectPackageManifest: Decodable {
    struct ArtifactReference: Decodable {
        let path: String
        let sha256: String
    }

    struct Artifacts: Decodable {
        let finalVideo: ArtifactReference
        let qaReport: ArtifactReference

        enum CodingKeys: String, CodingKey {
            case finalVideo = "final_video"
            case qaReport = "qa_report"
        }
    }

    struct Provenance: Decodable {
        let editorialTimelineHash: String

        enum CodingKeys: String, CodingKey {
            case editorialTimelineHash = "editorial_timeline_hash"
        }
    }

    let version: String
    let projectID: String
    let sourceOfTruth: ProjectPackageSourceOfTruth
    let baseTimelineVersion: String
    let packagingProjectionHash: String
    let createdAt: String
    let artifacts: Artifacts
    let provenance: Provenance

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case sourceOfTruth = "source_of_truth"
        case baseTimelineVersion = "base_timeline_version"
        case packagingProjectionHash = "packaging_projection_hash"
        case createdAt = "created_at"
        case artifacts
        case provenance
    }
}
