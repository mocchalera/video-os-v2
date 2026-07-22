import Foundation

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
        let qaReportURL = packageURL.appendingPathComponent("qa-report.json")
        let manifestURL = packageURL.appendingPathComponent("package_manifest.json")
        let publishedFinalVideoURL = projectURL.appendingPathComponent("09_output/final.mp4")
        let packageFinalVideoURL = packageURL.appendingPathComponent("video/final.mp4")
        let finalMixURL = packageURL.appendingPathComponent("audio/final_mix.wav")
        let fileManager = FileManager.default

        let qaReport = decode(ProjectPackageQAReport.self, from: qaReportURL)
        let manifest = decode(ProjectPackageManifest.self, from: manifestURL)
        let qaReportExists = fileManager.fileExists(atPath: qaReportURL.path)
        let manifestExists = fileManager.fileExists(atPath: manifestURL.path)
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

    let version: String
    let projectID: String
    let sourceOfTruth: ProjectPackageSourceOfTruth
    let qaProfile: ProjectPackageSourceOfTruth
    let passed: Bool
    let checks: [Check]

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case qaProfile = "qa_profile"
        case passed
        case sourceOfTruth = "source_of_truth"
        case checks
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
