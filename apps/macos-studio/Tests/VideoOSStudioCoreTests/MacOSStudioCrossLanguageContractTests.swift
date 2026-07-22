import Foundation
import XCTest
@testable import VideoOSStudioCore

final class MacOSStudioCrossLanguageContractTests: XCTestCase {
    private struct Fixture: Decodable {
        let artifactVersion: String
        let playbackCases: [PlaybackCase]
        let preflightCases: [PreflightCase]
        let packageCases: [PackageCase]
    }

    private struct PlaybackCase: Decodable {
        struct Expected: Decodable {
            let state: String
            let timelineHash: String?
            let manifestBaseTimelineHash: String?

            enum CodingKeys: String, CodingKey {
                case state
                case timelineHash = "timeline_hash"
                case manifestBaseTimelineHash = "manifest_base_timeline_hash"
            }
        }

        let id: String
        let files: [String: String]
        let expected: Expected
    }

    private struct PreflightCase: Decodable {
        let id: String
        let files: [String: String]
        let expected: ProjectPackagePreflightStatus
    }

    private struct PackageCase: Decodable {
        let id: String
        let files: [String: String]
        let expected: ProjectPackageVerificationStatus
    }

    private var temporaryDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
        }
        temporaryDirectories.removeAll()
    }

    func testSharedFixtureIsBundledAndMatchesPlaybackOracle() throws {
        let fixture = try loadFixture()

        XCTAssertEqual(fixture.artifactVersion, "macos-studio-contract/v1")
        XCTAssertEqual(fixture.playbackCases.count, 5)
        for testCase in fixture.playbackCases {
            let project = try materialize(testCase.files, prefix: "playback-\(testCase.id)")
            let status = ProjectPlaybackContractStatusReader.status(projectURL: project)

            XCTAssertEqual(status.state.rawValue, testCase.expected.state, testCase.id)
            XCTAssertEqual(status.timelineHash, testCase.expected.timelineHash, testCase.id)
            XCTAssertEqual(
                status.manifestBaseTimelineHash,
                testCase.expected.manifestBaseTimelineHash,
                testCase.id
            )
        }
    }

    func testRuntimePreflightExpectationsDriveRenderReadiness() throws {
        let fixture = try loadFixture()

        XCTAssertEqual(fixture.preflightCases.count, 3)
        for testCase in fixture.preflightCases {
            let project = try materialize(testCase.files, prefix: "preflight-\(testCase.id)")
            let root = project.deletingLastPathComponent()
            try write("worker", to: root.appendingPathComponent("scripts/editor-job-worker.ts"))
            let plan = ProjectRenderRunPlanner.plan(
                repositoryRoot: root,
                projectURL: project,
                preflightStatus: testCase.expected
            )

            XCTAssertEqual(plan.canRun, testCase.expected.ok, testCase.id)
            XCTAssertEqual(plan.preflightStatus.issues, testCase.expected.issues, testCase.id)
            if testCase.expected.ok {
                XCTAssertNil(plan.preflightStatus.failureLabel, testCase.id)
            } else {
                XCTAssertEqual(plan.readinessLabel, testCase.expected.issues.first, testCase.id)
            }
        }
    }

    func testPackageProjectionMatchesSchemaOracleExpectations() throws {
        let fixture = try loadFixture()

        XCTAssertEqual(fixture.packageCases.count, 18)
        for testCase in fixture.packageCases {
            let project = try materialize(testCase.files, prefix: "package-\(testCase.id)")
            let status = ProjectRenderPackageStatusReader.status(
                projectURL: project,
                expectedProjectID: "studio-contract",
                expectedSourceOfTruth: "engine_render",
                verificationStatus: testCase.expected
            )

            XCTAssertEqual(status.packageContractMatches, testCase.expected.ready, testCase.id)
            XCTAssertEqual(status.readinessLabel, testCase.expected.readinessLabel, testCase.id)
        }
    }

    private func loadFixture() throws -> Fixture {
        let fixtureDirectory = try XCTUnwrap(
            Bundle.module.url(forResource: "Fixtures", withExtension: nil)
        )
        let fixtureURL = fixtureDirectory.appendingPathComponent("macos-studio-contract-v1.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
    }

    private func materialize(_ files: [String: String], prefix: String) throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-studio-contract-\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("project")
        temporaryDirectories.append(root)
        for (relativePath, contents) in files {
            try write(contents, to: project.appendingPathComponent(relativePath))
        }
        return project
    }

    private func write(_ contents: String, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }
}
