import XCTest
@testable import VideoOSStudioCore

final class ProjectSyntheticHandoffSmokeTests: XCTestCase {
    func testSmokeBuildsDurableSourceMapAndPacketWithInjectedExporters() throws {
        let repositoryRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-synthetic-smoke-repo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repositoryRoot, withIntermediateDirectories: true)

        let result = try ProjectSyntheticHandoffSmoke.run(
            repositoryRoot: repositoryRoot,
            durationSeconds: 1,
            syntheticBuilder: { projectURL, seconds in
                ProjectSyntheticMediaBuilder.build(projectURL: projectURL, durationSeconds: seconds, force: true) { arguments in
                    let output = try XCTUnwrap(arguments.last)
                    try Data([0]).write(to: URL(fileURLWithPath: output))
                }
            },
            premiereXMLExporter: { root, projectURL in
                let plan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL)
                try FileManager.default.createDirectory(at: plan.outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try """
                <?xml version="1.0" encoding="UTF-8"?>
                <xmeml>
                  <pathurl>file://interview.mov</pathurl>
                  <pathurl>file://camera.mp4</pathurl>
                </xmeml>
                """.write(to: plan.outputURL, atomically: true, encoding: .utf8)
                return ProjectHandoffExportResult(plan: plan, outputURL: plan.outputURL, stdout: "", stderr: "")
            },
            editorPacketExporter: { root, projectURL in
                let plan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL)
                try FileManager.default.createDirectory(at: plan.packetURL, withIntermediateDirectories: true)
                try "notes".write(to: plan.editorNotesURL, atomically: true, encoding: .utf8)
                try "{}".write(to: plan.manifestURL, atomically: true, encoding: .utf8)
                return ProjectEditorPacketResult(
                    plan: plan,
                    packetURL: plan.packetURL,
                    manifestURL: plan.manifestURL,
                    files: [plan.editorNotesURL, plan.manifestURL]
                )
            }
        )

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.syntheticBuildResult.builtCount, 2)
        XCTAssertEqual(result.syntheticBuildResult.mappedCount, 2)
        XCTAssertEqual(result.sourceMapStatus.readinessLabel, "source map ready")
        XCTAssertEqual(result.sourceMapStatus.coverageLabel, "2 / 2")
        XCTAssertEqual(result.mediaPreviewSummary.readyCount, 2)
        XCTAssertEqual(result.mediaPreviewSummary.missingCount, 0)
        XCTAssertEqual(result.handoffPlan.readinessLabel, "ready")
        XCTAssertFalse(result.handoffPlan.usesTemporarySourceMap)
        XCTAssertTrue(result.premiereXMLContainsMediaRefs)
        XCTAssertEqual(result.editorPacketFileCount, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.editorPacketManifestURL.path))

        ProjectSyntheticHandoffSmoke.removeProject(result)
        XCTAssertFalse(FileManager.default.fileExists(atPath: result.projectURL.path))
    }
}
