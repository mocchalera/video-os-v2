import XCTest
@testable import VideoOSStudioCore

final class ProjectStudioAcceptanceSmokeTests: XCTestCase {
    func testAcceptanceSmokeCombinesAppServerAndStudioPackageLoop() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-acceptance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "worker".write(to: root.appendingPathComponent("scripts/editor-job-worker.ts"), atomically: true, encoding: .utf8)

        let result = try ProjectStudioAcceptanceSmoke.run(
            repositoryRoot: root,
            durationSeconds: 1,
            appServerChecker: { _ in
                CodexInitializeResponse(
                    codexHome: "/tmp/codex",
                    platformFamily: "unix",
                    platformOs: "macos",
                    userAgent: "Codex Desktop test"
                )
            },
            studioSmokeRunner: { repositoryRoot, seconds in
                try ProjectStudioSyntheticSmoke.run(
                    repositoryRoot: repositoryRoot,
                    durationSeconds: seconds,
                    syntheticBuilder: { projectURL, durationSeconds in
                        ProjectSyntheticMediaBuilder.build(projectURL: projectURL, durationSeconds: durationSeconds, force: true) { arguments in
                            let output = try XCTUnwrap(arguments.last)
                            try Data([0x00, 0x01, 0x02]).write(to: URL(fileURLWithPath: output))
                        }
                    },
                    preflightReader: { _, _ in
                        ProjectPackagePreflightStatus(
                            ok: true,
                            sourceOfTruth: "nle_finishing",
                            autonomyMode: "full",
                            projectID: "synthetic-studio-smoke",
                            currentState: "approved",
                            visualQaSummary: "verified"
                        )
                    },
                    renderRunner: { plan in
                        let outputDir = plan.projectURL.appendingPathComponent("09_output")
                        let packageDir = plan.projectURL.appendingPathComponent("07_package")
                        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
                        try FileManager.default.createDirectory(at: packageDir.appendingPathComponent("video"), withIntermediateDirectories: true)
                        try FileManager.default.createDirectory(at: packageDir.appendingPathComponent("audio"), withIntermediateDirectories: true)
                        let finalURL = outputDir.appendingPathComponent("final.mp4")
                        let packageFinalURL = packageDir.appendingPathComponent("video/final.mp4")
                        let finalMixURL = packageDir.appendingPathComponent("audio/final_mix.wav")
                        try Data([0x03, 0x04, 0x05]).write(to: finalURL)
                        try Data([0x03, 0x04, 0x05]).write(to: packageFinalURL)
                        try Data([0x06, 0x07, 0x08]).write(to: finalMixURL)
                        try """
                        {
                          "version": "1",
                          "project_id": "synthetic-studio-smoke",
                          "passed": true,
                          "source_of_truth": "nle_finishing",
                          "qa_profile": "nle_finishing",
                          "checks": [
                            { "name": "synthetic", "passed": true, "details": "ok" }
                          ],
                          "metrics": {},
                          "artifacts": {}
                        }
                        """.write(to: packageDir.appendingPathComponent("qa-report.json"), atomically: true, encoding: .utf8)
                        try """
                        {
                          "version": "package-v1",
                          "project_id": "synthetic-studio-smoke",
                          "source_of_truth": "nle_finishing",
                          "base_timeline_version": "1",
                          "packaging_projection_hash": "synthetic",
                          "created_at": "2026-05-22T00:00:00Z",
                          "artifacts": {
                            "final_video": { "path": "09_output/final.mp4", "sha256": "video" },
                            "qa_report": { "path": "07_package/qa-report.json", "sha256": "qa" }
                          },
                          "provenance": {
                            "editorial_timeline_hash": "timeline"
                          }
                        }
                        """.write(to: packageDir.appendingPathComponent("package_manifest.json"), atomically: true, encoding: .utf8)
                        let status = ProjectRenderPackageStatusReader.status(
                            projectURL: plan.projectURL,
                            verificationStatus: ProjectPackageVerificationStatus(
                                ready: true,
                                readinessLabel: "render packaged",
                                projectID: "synthetic-studio-smoke",
                                sourceOfTruth: "nle_finishing"
                            )
                        )
                        return ProjectRenderRunResult(plan: plan, exitCode: 0, stdout: "", stderr: "", status: status)
                    },
                    editorPacketExporter: { root, projectURL in
                        let plan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL)
                        try FileManager.default.createDirectory(at: plan.handoffPlan.outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                        try "<xmeml version=\"5\" />".write(to: plan.handoffPlan.outputURL, atomically: true, encoding: .utf8)
                        return try ProjectEditorPacketExporter.export(
                            repositoryRoot: root,
                            projectURL: projectURL,
                            exportPremiereXML: false,
                            generatedAt: Date(timeIntervalSince1970: 0)
                        )
                    }
                )
            }
        )

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.summaryLabel, "acceptance smoke passed")
        XCTAssertEqual(result.appServerResponse.platformOs, "macos")
        XCTAssertTrue(result.studioSmokeResult.renderResult.succeeded)
        XCTAssertGreaterThanOrEqual(result.studioSmokeResult.editorPacketMediaCount, 2)
        XCTAssertEqual(result.studioSmokeResult.editorPacketVerificationStatus.readinessLabel, "packet verified")
        XCTAssertGreaterThan(result.studioSmokeResult.indexStatus.documentCount, 0)
        XCTAssertEqual(result.studioSmokeResult.studioStatus.scoreLabel, "9/9")

        ProjectStudioAcceptanceSmoke.removeProject(result)
        XCTAssertFalse(FileManager.default.fileExists(atPath: result.studioSmokeResult.projectURL.path))
    }
}
