import XCTest
@testable import VideoOSStudioCore

final class ProjectPackageVerificationStatusTests: XCTestCase {
    func testArgumentsUseReadOnlyExistingPackageVerifier() throws {
        let root = try makeRoot()
        let project = root.appendingPathComponent("projects/demo")

        let arguments = ProjectPackageVerificationRunner.arguments(
            repositoryRoot: root,
            projectURL: project
        )

        XCTAssertEqual(arguments.suffix(2), ["--verify-existing", "--json"])
        XCTAssertFalse(arguments.contains("--preflight-only"))
    }

    func testDecodesReadyVerifierResultAndRequiresMatchingPathAndExit() throws {
        let root = try makeRoot()
        let project = root.appendingPathComponent("projects/demo")
        let json = """
        {
          "ready": true,
          "projectDir": "\(project.path)",
          "readinessLabel": "render packaged",
          "issues": [],
          "checks": [{"name":"package","passed":true,"details":"ok"}],
          "projectId": "demo",
          "sourceOfTruth": "engine_render"
        }
        """

        let status = ProjectPackageVerificationRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { _, _ in
            ProjectInitializationProcessResult(status: 0, stdout: json, stderr: "")
        }

        XCTAssertTrue(status.available)
        XCTAssertTrue(status.ready)
        XCTAssertEqual(status.projectID, "demo")
        XCTAssertEqual(status.checks.count, 1)
    }

    func testRejectsContradictoryExitStatus() throws {
        let root = try makeRoot()
        let project = root.appendingPathComponent("projects/demo")
        let json = """
        {
          "ready": true,
          "projectDir": "\(project.path)",
          "readinessLabel": "render packaged",
          "issues": [],
          "checks": [{"name":"package","passed":true,"details":"ok"}],
          "projectId": "demo",
          "sourceOfTruth": "engine_render"
        }
        """

        let status = ProjectPackageVerificationRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { _, _ in
            ProjectInitializationProcessResult(status: 1, stdout: json, stderr: "")
        }

        XCTAssertFalse(status.available)
        XCTAssertEqual(status.issues, ["package verification returned a contradictory exit status"])
    }

    func testRejectsDifferentProjectPath() throws {
        let root = try makeRoot()
        let project = root.appendingPathComponent("projects/demo")
        let json = """
        {"ready":false,"projectDir":"/tmp/other","readinessLabel":"package incomplete","issues":["missing"],"checks":[]}
        """

        let status = ProjectPackageVerificationRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { _, _ in
            ProjectInitializationProcessResult(status: 1, stdout: json, stderr: "")
        }

        XCTAssertFalse(status.available)
        XCTAssertEqual(status.issues, ["package verification returned a different project path"])
    }

    func testRejectsReadyJSONWithIncompleteContract() throws {
        let root = try makeRoot()
        let project = root.appendingPathComponent("projects/demo")
        let json = """
        {"ready":true,"projectDir":"\(project.path)","readinessLabel":"render packaged","issues":[],"checks":[]}
        """

        let status = ProjectPackageVerificationRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { _, _ in
            ProjectInitializationProcessResult(status: 0, stdout: json, stderr: "")
        }

        XCTAssertFalse(status.available)
        XCTAssertEqual(status.issues, ["package verification returned an incomplete contract"])
    }

    private func makeRoot() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-package-verifier-\(UUID().uuidString)")
        let script = root.appendingPathComponent("scripts/package.ts")
        try FileManager.default.createDirectory(
            at: script.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "worker".write(to: script, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
}
