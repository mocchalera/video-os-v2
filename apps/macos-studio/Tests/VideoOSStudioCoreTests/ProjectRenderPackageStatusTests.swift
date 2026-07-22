import XCTest
@testable import VideoOSStudioCore

final class ProjectRenderPackageStatusTests: XCTestCase {
    func testStatusReportsMissingRenderArtifacts() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: .unavailable("package verification is pending")
        )

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

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: verifiedPackage()
        )

        XCTAssertEqual(status.readinessLabel, "render packaged")
        XCTAssertTrue(status.qaReportExists)
        XCTAssertTrue(status.qaReportReadable)
        XCTAssertEqual(status.qaPassed, true)
        XCTAssertEqual(status.qaProjectID, "demo")
        XCTAssertEqual(status.qaSourceOfTruth, "engine_render")
        XCTAssertEqual(status.qaCheckCount, 2)
        XCTAssertEqual(status.qaFailedCheckCount, 0)
        XCTAssertTrue(status.packageManifestExists)
        XCTAssertTrue(status.packageManifestReadable)
        XCTAssertEqual(status.manifestProjectID, "demo")
        XCTAssertEqual(status.manifestSourceOfTruth, "engine_render")
        XCTAssertEqual(status.manifestCreatedAt, "2026-05-22T00:00:00Z")
        XCTAssertTrue(status.packageContractMatches)
        XCTAssertTrue(status.publishedFinalVideoExists)
        XCTAssertTrue(status.packageFinalVideoExists)
        XCTAssertTrue(status.finalMixExists)
        XCTAssertEqual(status.missingRequiredArtifacts, [])
    }

    func testStatusReportsFailedQA() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-failed-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: false)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: rejectedPackage("qa failed")
        )

        XCTAssertEqual(status.readinessLabel, "qa failed")
        XCTAssertEqual(status.qaPassed, false)
        XCTAssertEqual(status.qaFailedCheckCount, 1)
    }

    func testStatusRejectsPartialQAAndManifestContracts() throws {
        let qaProject = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-partial-qa-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: qaProject, qaPassed: true, includeQADetails: false)

        var status = ProjectRenderPackageStatusReader.status(
            projectURL: qaProject,
            verificationStatus: rejectedPackage("qa report unreadable")
        )

        XCTAssertEqual(status.readinessLabel, "qa report unreadable")
        XCTAssertFalse(status.qaReportReadable)

        let manifestProject = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-partial-manifest-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: manifestProject, qaPassed: true, includeManifestProvenance: false)

        status = ProjectRenderPackageStatusReader.status(
            projectURL: manifestProject,
            verificationStatus: rejectedPackage("package manifest unreadable")
        )

        XCTAssertEqual(status.readinessLabel, "package manifest unreadable")
        XCTAssertFalse(status.packageManifestReadable)
    }

    func testStatusRejectsProjectAndSourceOfTruthMismatches() throws {
        let projectMismatch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-project-mismatch-\(UUID().uuidString)")
        try writeRenderPackageFixture(
            project: projectMismatch,
            qaPassed: true,
            manifestProjectID: "other"
        )

        var status = ProjectRenderPackageStatusReader.status(
            projectURL: projectMismatch,
            verificationStatus: rejectedPackage("package contract mismatch")
        )

        XCTAssertEqual(status.readinessLabel, "package contract mismatch")
        XCTAssertFalse(status.packageContractMatches)

        let sourceMismatch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-source-mismatch-\(UUID().uuidString)")
        try writeRenderPackageFixture(
            project: sourceMismatch,
            qaPassed: true,
            manifestSourceOfTruth: "nle_finishing"
        )

        status = ProjectRenderPackageStatusReader.status(
            projectURL: sourceMismatch,
            verificationStatus: rejectedPackage("package contract mismatch")
        )

        XCTAssertEqual(status.readinessLabel, "package contract mismatch")
        XCTAssertFalse(status.packageContractMatches)
    }
}

private func verifiedPackage() -> ProjectPackageVerificationStatus {
    ProjectPackageVerificationStatus(
        ready: true,
        readinessLabel: "render packaged",
        projectID: "demo",
        sourceOfTruth: "engine_render"
    )
}

private func rejectedPackage(_ readinessLabel: String) -> ProjectPackageVerificationStatus {
    ProjectPackageVerificationStatus(
        ready: false,
        readinessLabel: readinessLabel,
        issues: [readinessLabel],
        projectID: "demo",
        sourceOfTruth: "engine_render"
    )
}

private func writeRenderPackageFixture(
    project: URL,
    qaPassed: Bool,
    qaProjectID: String = "demo",
    manifestProjectID: String = "demo",
    qaSourceOfTruth: String = "engine_render",
    manifestSourceOfTruth: String = "engine_render",
    includeQADetails: Bool = true,
    includeManifestProvenance: Bool = true
) throws {
    let package = project.appendingPathComponent("07_package")
    let video = package.appendingPathComponent("video")
    let audio = package.appendingPathComponent("audio")
    let timeline = project.appendingPathComponent("05_timeline")
    let output = project.appendingPathComponent("09_output")
    try FileManager.default.createDirectory(at: video, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: timeline, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    try Data([0x00, 0x01]).write(to: video.appendingPathComponent("final.mp4"), options: .atomic)
    try Data([0x02, 0x03]).write(to: audio.appendingPathComponent("final_mix.wav"), options: .atomic)
    try Data([0x04, 0x05]).write(to: output.appendingPathComponent("final.mp4"), options: .atomic)
    try #"{"version":"1","project_id":"demo","tracks":{"video":[],"audio":[]}}"#.write(
        to: timeline.appendingPathComponent("timeline.json"),
        atomically: true,
        encoding: .utf8
    )
    try "project_id: demo\n".write(
        to: project.appendingPathComponent("project_state.yaml"),
        atomically: true,
        encoding: .utf8
    )
    let qaDetails = includeQADetails ? #", "details": "ok""# : ""
    let loudnessDetails = includeQADetails ? #", "details": "measured""# : ""
    try """
    {
      "version": "1",
      "project_id": "\(qaProjectID)",
      "source_of_truth": "\(qaSourceOfTruth)",
      "qa_profile": "\(qaSourceOfTruth)",
      "passed": \(qaPassed ? "true" : "false"),
      "checks": [
        { "name": "timeline_schema_valid", "passed": true\(qaDetails) },
        { "name": "loudness", "passed": \(qaPassed ? "true" : "false")\(loudnessDetails) }
      ]
    }
    """.write(to: package.appendingPathComponent("qa-report.json"), atomically: true, encoding: .utf8)
    let provenance = includeManifestProvenance
        ? """
        ,
          "provenance": {
            "editorial_timeline_hash": "timeline"
          }
        """
        : ""
    try """
    {
      "version": "package-v1",
      "project_id": "\(manifestProjectID)",
      "source_of_truth": "\(manifestSourceOfTruth)",
      "base_timeline_version": "1",
      "packaging_projection_hash": "abc123",
      "created_at": "2026-05-22T00:00:00Z",
      "artifacts": {
        "final_video": { "path": "09_output/final.mp4", "sha256": "abc" },
        "qa_report": { "path": "07_package/qa-report.json", "sha256": "def" }
      }\(provenance)
    }
    """.write(to: package.appendingPathComponent("package_manifest.json"), atomically: true, encoding: .utf8)
}
