import XCTest
@testable import VideoOSStudioCore

final class ProjectNativeEditorVisualQAStatusTests: XCTestCase {
    func testStatusReportsMissingVisualQAArtifact() throws {
        let root = temporaryRoot("native-editor-qa-missing")

        let status = ProjectNativeEditorVisualQAStatusReader.status(repositoryRoot: root)

        XCTAssertFalse(status.isPassed)
        XCTAssertEqual(status.readinessLabel, "visual QA missing")
        XCTAssertEqual(status.missingSurfaceIDs, ProjectNativeEditorVisualQAStatusReader.requiredSurfaceIDs)
    }

    func testStatusPassesWhenReportScreenshotAndRequiredSurfacesExist() throws {
        let root = temporaryRoot("native-editor-qa-pass")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("reports"), withIntermediateDirectories: true)
        try Data([0x01]).write(to: root.appendingPathComponent("reports/native-editor-visual-qa.png"))
        try """
        {
          "version": "1",
          "status": "pass",
          "project_id": "demo",
          "captured_at": "2026-05-22T11:07:00+09:00",
          "screenshot_path": "reports/native-editor-visual-qa.png",
          "surfaces": [
            { "id": "viewer", "status": "pass" },
            { "id": "inspector", "status": "pass" },
            { "id": "timeline", "status": "pass" },
            { "id": "transport", "status": "pass" },
            { "id": "audio_lanes", "status": "pass" }
          ]
        }
        """.write(to: root.appendingPathComponent("reports/native-editor-visual-qa.json"), atomically: true, encoding: .utf8)

        let status = ProjectNativeEditorVisualQAStatusReader.status(repositoryRoot: root)

        XCTAssertTrue(status.isPassed)
        XCTAssertEqual(status.readinessLabel, "visual QA passed")
        XCTAssertEqual(status.projectID, "demo")
        XCTAssertTrue(status.missingSurfaceIDs.isEmpty)
        XCTAssertTrue(status.failedSurfaceIDs.isEmpty)
    }

    func testStatusFailsWhenRequiredSurfaceIsMissing() throws {
        let root = temporaryRoot("native-editor-qa-incomplete")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("reports"), withIntermediateDirectories: true)
        try Data([0x01]).write(to: root.appendingPathComponent("reports/native-editor-visual-qa.png"))
        try """
        {
          "status": "pass",
          "screenshot_path": "reports/native-editor-visual-qa.png",
          "surfaces": [
            { "id": "viewer", "status": "pass" },
            { "id": "inspector", "status": "pass" }
          ]
        }
        """.write(to: root.appendingPathComponent("reports/native-editor-visual-qa.json"), atomically: true, encoding: .utf8)

        let status = ProjectNativeEditorVisualQAStatusReader.status(repositoryRoot: root)

        XCTAssertFalse(status.isPassed)
        XCTAssertEqual(status.readinessLabel, "visual QA incomplete")
        XCTAssertEqual(status.missingSurfaceIDs, ["timeline", "transport", "audio_lanes"])
    }

    private func temporaryRoot(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }
}
