import XCTest
@testable import VideoOSStudioCore

final class ProjectRenderPackageStatusTests: XCTestCase {
    func testStatusReportsMissingRenderArtifacts() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)

        let status = ProjectRenderPackageStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "not rendered")
        XCTAssertFalse(status.qaReportExists)
        XCTAssertFalse(status.packageManifestExists)
        XCTAssertFalse(status.publishedFinalVideoExists)
        XCTAssertEqual(status.missingRequiredArtifacts, [
            "07_package/qa-report.json",
            "07_package/package_manifest.json",
            "09_output/final.mp4"
        ])
    }

    func testStatusReportsCompletePackagedRender() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-complete-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: true)

        let status = ProjectRenderPackageStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "render packaged")
        XCTAssertTrue(status.qaReportExists)
        XCTAssertTrue(status.qaReportReadable)
        XCTAssertEqual(status.qaPassed, true)
        XCTAssertEqual(status.qaSourceOfTruth, "engine_render")
        XCTAssertEqual(status.qaCheckCount, 2)
        XCTAssertEqual(status.qaFailedCheckCount, 0)
        XCTAssertTrue(status.packageManifestExists)
        XCTAssertTrue(status.packageManifestReadable)
        XCTAssertEqual(status.manifestSourceOfTruth, "engine_render")
        XCTAssertEqual(status.manifestCreatedAt, "2026-05-22T00:00:00Z")
        XCTAssertTrue(status.publishedFinalVideoExists)
        XCTAssertTrue(status.packageFinalVideoExists)
        XCTAssertTrue(status.finalMixExists)
        XCTAssertEqual(status.missingRequiredArtifacts, [])
    }

    func testStatusReportsFailedQA() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-failed-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: false)

        let status = ProjectRenderPackageStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "qa failed")
        XCTAssertEqual(status.qaPassed, false)
        XCTAssertEqual(status.qaFailedCheckCount, 1)
    }
}

private func writeRenderPackageFixture(project: URL, qaPassed: Bool) throws {
    let package = project.appendingPathComponent("07_package")
    let video = package.appendingPathComponent("video")
    let audio = package.appendingPathComponent("audio")
    let output = project.appendingPathComponent("09_output")
    try FileManager.default.createDirectory(at: video, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    try Data([0x00, 0x01]).write(to: video.appendingPathComponent("final.mp4"), options: .atomic)
    try Data([0x02, 0x03]).write(to: audio.appendingPathComponent("final_mix.wav"), options: .atomic)
    try Data([0x04, 0x05]).write(to: output.appendingPathComponent("final.mp4"), options: .atomic)
    try """
    {
      "version": "1",
      "project_id": "demo",
      "source_of_truth": "engine_render",
      "qa_profile": "engine_render",
      "passed": \(qaPassed ? "true" : "false"),
      "checks": [
        { "name": "timeline_schema_valid", "passed": true, "details": "ok" },
        { "name": "loudness", "passed": \(qaPassed ? "true" : "false"), "details": "measured" }
      ]
    }
    """.write(to: package.appendingPathComponent("qa-report.json"), atomically: true, encoding: .utf8)
    try """
    {
      "version": "package-v1",
      "project_id": "demo",
      "source_of_truth": "engine_render",
      "base_timeline_version": "1",
      "packaging_projection_hash": "abc123",
      "created_at": "2026-05-22T00:00:00Z",
      "artifacts": {
        "final_video": { "path": "09_output/final.mp4", "sha256": "abc" },
        "qa_report": { "path": "07_package/qa-report.json", "sha256": "def" }
      },
      "provenance": {
        "editorial_timeline_hash": "timeline"
      }
    }
    """.write(to: package.appendingPathComponent("package_manifest.json"), atomically: true, encoding: .utf8)
}
