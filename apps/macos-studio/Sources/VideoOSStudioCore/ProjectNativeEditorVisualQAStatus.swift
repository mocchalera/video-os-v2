import Foundation

public struct ProjectNativeEditorVisualQAStatus: Equatable, Sendable {
    public let reportURL: URL
    public let reportExists: Bool
    public let reportReadable: Bool
    public let reportStatus: String?
    public let projectID: String?
    public let capturedAt: String?
    public let screenshotPath: String?
    public let screenshotExists: Bool
    public let passedSurfaceIDs: [String]
    public let missingSurfaceIDs: [String]
    public let failedSurfaceIDs: [String]

    public var isPassed: Bool {
        reportExists
            && reportReadable
            && reportStatus == "pass"
            && screenshotExists
            && missingSurfaceIDs.isEmpty
            && failedSurfaceIDs.isEmpty
    }

    public var readinessLabel: String {
        guard reportExists else { return "visual QA missing" }
        guard reportReadable else { return "visual QA unreadable" }
        guard reportStatus == "pass" else { return "visual QA not passed" }
        guard screenshotExists else { return "visual QA screenshot missing" }
        guard missingSurfaceIDs.isEmpty else { return "visual QA incomplete" }
        guard failedSurfaceIDs.isEmpty else { return "visual QA failed" }
        return "visual QA passed"
    }

    public var detail: String {
        let captured = capturedAt ?? "unknown capture time"
        let screenshot = screenshotPath ?? "-"
        if isPassed {
            return "\(passedSurfaceIDs.count) required editor surfaces passed / captured \(captured) / screenshot \(screenshot)"
        }
        let missing = missingSurfaceIDs.isEmpty ? "none" : missingSurfaceIDs.joined(separator: ",")
        let failed = failedSurfaceIDs.isEmpty ? "none" : failedSurfaceIDs.joined(separator: ",")
        return "missing=\(missing) / failed=\(failed) / captured \(captured) / screenshot \(screenshot)"
    }

    public var recommendation: String {
        if isPassed {
            return "Native viewer, inspector, transport, timeline, and audio lanes have current visual QA evidence."
        }
        return "Run the app, inspect the native editor surfaces, capture a screenshot, and update reports/native-editor-visual-qa.json."
    }
}

public enum ProjectNativeEditorVisualQAStatusReader {
    public static let requiredSurfaceIDs = ["viewer", "inspector", "timeline", "transport", "audio_lanes"]

    public static func status(repositoryRoot: URL) -> ProjectNativeEditorVisualQAStatus {
        let reportURL = repositoryRoot.appendingPathComponent("reports/native-editor-visual-qa.json")
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: reportURL.path) else {
            return ProjectNativeEditorVisualQAStatus(
                reportURL: reportURL,
                reportExists: false,
                reportReadable: false,
                reportStatus: nil,
                projectID: nil,
                capturedAt: nil,
                screenshotPath: nil,
                screenshotExists: false,
                passedSurfaceIDs: [],
                missingSurfaceIDs: requiredSurfaceIDs,
                failedSurfaceIDs: []
            )
        }

        guard let report = try? JSONDecoder().decode(NativeEditorVisualQAReport.self, from: Data(contentsOf: reportURL)) else {
            return ProjectNativeEditorVisualQAStatus(
                reportURL: reportURL,
                reportExists: true,
                reportReadable: false,
                reportStatus: nil,
                projectID: nil,
                capturedAt: nil,
                screenshotPath: nil,
                screenshotExists: false,
                passedSurfaceIDs: [],
                missingSurfaceIDs: requiredSurfaceIDs,
                failedSurfaceIDs: []
            )
        }

        let surfaceStatusByID = Dictionary(uniqueKeysWithValues: report.surfaces.map { ($0.id, $0.status) })
        let passed = requiredSurfaceIDs.filter { surfaceStatusByID[$0] == "pass" }
        let missing = requiredSurfaceIDs.filter { surfaceStatusByID[$0] == nil }
        let failed = requiredSurfaceIDs.filter { surfaceStatusByID[$0] != nil && surfaceStatusByID[$0] != "pass" }
        let screenshotExists = report.screenshotPath.map { path in
            let url = path.hasPrefix("/")
                ? URL(fileURLWithPath: path)
                : repositoryRoot.appendingPathComponent(path)
            return fileManager.fileExists(atPath: url.path)
        } ?? false

        return ProjectNativeEditorVisualQAStatus(
            reportURL: reportURL,
            reportExists: true,
            reportReadable: true,
            reportStatus: report.status,
            projectID: report.projectID,
            capturedAt: report.capturedAt,
            screenshotPath: report.screenshotPath,
            screenshotExists: screenshotExists,
            passedSurfaceIDs: passed,
            missingSurfaceIDs: missing,
            failedSurfaceIDs: failed
        )
    }
}

private struct NativeEditorVisualQAReport: Decodable {
    let status: String
    let projectID: String?
    let capturedAt: String?
    let screenshotPath: String?
    let surfaces: [Surface]

    enum CodingKeys: String, CodingKey {
        case status
        case projectID = "project_id"
        case capturedAt = "captured_at"
        case screenshotPath = "screenshot_path"
        case surfaces
    }

    struct Surface: Decodable {
        let id: String
        let status: String
    }
}
