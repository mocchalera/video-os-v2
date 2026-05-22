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
    public let qaSourceOfTruth: String?
    public let qaCheckCount: Int
    public let qaFailedCheckCount: Int
    public let packageManifestExists: Bool
    public let packageManifestReadable: Bool
    public let manifestSourceOfTruth: String?
    public let manifestCreatedAt: String?
    public let publishedFinalVideoExists: Bool
    public let packageFinalVideoExists: Bool
    public let finalMixExists: Bool

    public var readinessLabel: String {
        if qaReportExists, !qaReportReadable { return "qa report unreadable" }
        if packageManifestExists, !packageManifestReadable { return "package manifest unreadable" }
        if qaPassed == false { return "qa failed" }
        if publishedFinalVideoExists, qaReportExists, packageManifestExists, qaPassed == true {
            return "render packaged"
        }
        if packageManifestExists || qaReportExists || packageFinalVideoExists || finalMixExists || publishedFinalVideoExists {
            return "package incomplete"
        }
        return "not rendered"
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
    public static func status(projectURL: URL) -> ProjectRenderPackageStatus {
        let packageURL = projectURL.appendingPathComponent("07_package")
        let qaReportURL = packageURL.appendingPathComponent("qa-report.json")
        let manifestURL = packageURL.appendingPathComponent("package_manifest.json")
        let publishedFinalVideoURL = projectURL.appendingPathComponent("09_output/final.mp4")
        let packageFinalVideoURL = packageURL.appendingPathComponent("video/final.mp4")
        let finalMixURL = packageURL.appendingPathComponent("audio/final_mix.wav")
        let fileManager = FileManager.default

        let qaReport = decode(ProjectPackageQAReport.self, from: qaReportURL)
        let manifest = decode(ProjectPackageManifestSummary.self, from: manifestURL)
        let qaReportExists = fileManager.fileExists(atPath: qaReportURL.path)
        let manifestExists = fileManager.fileExists(atPath: manifestURL.path)

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
            qaSourceOfTruth: qaReport?.sourceOfTruth,
            qaCheckCount: qaReport?.checks.count ?? 0,
            qaFailedCheckCount: qaReport?.checks.filter { !$0.passed }.count ?? 0,
            packageManifestExists: manifestExists,
            packageManifestReadable: manifestExists ? manifest != nil : false,
            manifestSourceOfTruth: manifest?.sourceOfTruth,
            manifestCreatedAt: manifest?.createdAt,
            publishedFinalVideoExists: fileManager.fileExists(atPath: publishedFinalVideoURL.path),
            packageFinalVideoExists: fileManager.fileExists(atPath: packageFinalVideoURL.path),
            finalMixExists: fileManager.fileExists(atPath: finalMixURL.path)
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
    }

    let passed: Bool
    let sourceOfTruth: String
    let checks: [Check]

    enum CodingKeys: String, CodingKey {
        case passed
        case sourceOfTruth = "source_of_truth"
        case checks
    }
}

private struct ProjectPackageManifestSummary: Decodable {
    let sourceOfTruth: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case sourceOfTruth = "source_of_truth"
        case createdAt = "created_at"
    }
}
