import XCTest
@testable import VideoOSStudioCore

final class ProjectInitializerTests: XCTestCase {
    func testPlanBuildsInitProjectCommandWithSourceDirectory() throws {
        let root = try temporaryRepository("videoos-init-plan")
        let source = root.appendingPathComponent("source-footage")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)

        let plan = try ProjectInitializer.plan(
            repositoryRoot: root,
            projectID: " client-cut_001 ",
            sourceDirectory: source
        )

        XCTAssertEqual(plan.projectID, "client-cut_001")
        XCTAssertEqual(plan.projectURL, root.appendingPathComponent("projects/client-cut_001"))
        XCTAssertEqual(plan.commandArguments, [
            "npx",
            "tsx",
            "scripts/init-project.ts",
            "client-cut_001",
            "--source-dir",
            source.path
        ])
        XCTAssertTrue(plan.commandLine.contains("scripts/init-project.ts"))
    }

    func testPlanRejectsReservedExistingOrInvalidProjects() throws {
        let root = try temporaryRepository("videoos-init-validation")

        XCTAssertThrowsError(try ProjectInitializer.plan(repositoryRoot: root, projectID: "_template")) { error in
            XCTAssertEqual(error as? ProjectInitializationError, .reservedProjectID)
        }
        XCTAssertThrowsError(try ProjectInitializer.plan(repositoryRoot: root, projectID: "bad id")) { error in
            XCTAssertEqual(error as? ProjectInitializationError, .invalidProjectID("bad id"))
        }

        let missingSource = root.appendingPathComponent("missing-source")
        XCTAssertThrowsError(
            try ProjectInitializer.plan(repositoryRoot: root, projectID: "missing-media", sourceDirectory: missingSource)
        ) { error in
            XCTAssertEqual(error as? ProjectInitializationError, .sourceDirectoryMissing(missingSource))
        }

        let existing = root.appendingPathComponent("projects/existing")
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: true)
        XCTAssertThrowsError(try ProjectInitializer.plan(repositoryRoot: root, projectID: "existing")) { error in
            guard case .projectAlreadyExists(let url) = error as? ProjectInitializationError else {
                XCTFail("Expected projectAlreadyExists, got \(error)")
                return
            }
            XCTAssertEqual(url.path, existing.path)
        }
    }

    func testRunUsesInjectedRunnerAndParsesNextStep() throws {
        let root = try temporaryRepository("videoos-init-run")
        let source = root.appendingPathComponent("source-footage")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let plan = try ProjectInitializer.plan(repositoryRoot: root, projectID: "smoke", sourceDirectory: source)

        let result = try ProjectInitializer.run(plan: plan) { _, _ in
            try FileManager.default.createDirectory(at: plan.projectURL.appendingPathComponent("02_media"), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(
                at: plan.projectURL.appendingPathComponent("02_media/source"),
                withDestinationURL: source
            )
            return ProjectInitializationProcessResult(
                status: 0,
                stdout: """
                [init-project] Created projects/smoke

                Next step:
                  npx tsx scripts/analyze.ts projects/smoke/02_media/source/* --project projects/smoke
                """,
                stderr: ""
            )
        }

        XCTAssertEqual(result.projectURL, plan.projectURL)
        XCTAssertEqual(result.sourceLinkURL, plan.projectURL.appendingPathComponent("02_media/source"))
        XCTAssertEqual(result.nextStepCommand, "npx tsx scripts/analyze.ts projects/smoke/02_media/source/* --project projects/smoke")
    }

    func testRunReportsProcessFailureAndMissingProject() throws {
        let root = try temporaryRepository("videoos-init-failures")
        let plan = try ProjectInitializer.plan(repositoryRoot: root, projectID: "broken")

        XCTAssertThrowsError(
            try ProjectInitializer.run(plan: plan) { _, _ in
                ProjectInitializationProcessResult(status: 17, stdout: "out", stderr: "err")
            }
        ) { error in
            XCTAssertEqual(
                error as? ProjectInitializationError,
                .processFailed(status: 17, stdout: "out", stderr: "err")
            )
        }

        XCTAssertThrowsError(
            try ProjectInitializer.run(plan: plan) { _, _ in
                ProjectInitializationProcessResult(status: 0, stdout: "", stderr: "")
            }
        ) { error in
            XCTAssertEqual(error as? ProjectInitializationError, .projectMissing(plan.projectURL))
        }
    }

    private func temporaryRepository(_ prefix: String) throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("projects/_template"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("schemas"), withIntermediateDirectories: true)
        return root
    }
}
