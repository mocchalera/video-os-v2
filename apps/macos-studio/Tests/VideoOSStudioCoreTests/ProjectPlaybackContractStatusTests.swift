import XCTest
@testable import VideoOSStudioCore

final class ProjectPlaybackContractStatusTests: XCTestCase {
    private func makeProject() throws -> URL {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-playback-contract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: project.appendingPathComponent("05_timeline"),
            withIntermediateDirectories: true
        )
        return project
    }

    private func write(_ project: URL, _ relative: String, _ content: String) throws {
        try Data(content.utf8).write(to: project.appendingPathComponent(relative))
    }

    func testFileHash16MatchesCanonicalDefinition() {
        // sha256("hello") = 2cf24dba5fb0a30e... — same value the Node
        // runtime/preview/playback-contract.ts test asserts.
        XCTAssertEqual(
            ProjectPlaybackContractStatusReader.fileHash16(Data("hello".utf8)),
            "2cf24dba5fb0a30e"
        )
    }

    func testMissingTimeline() throws {
        let project = try makeProject()
        let status = ProjectPlaybackContractStatusReader.status(projectURL: project)
        XCTAssertEqual(status.state, .missingTimeline)
        XCTAssertFalse(status.isApprovalGrade)
    }

    func testMissingManifest() throws {
        let project = try makeProject()
        try write(project, "05_timeline/timeline.json", "{}")
        let status = ProjectPlaybackContractStatusReader.status(projectURL: project)
        XCTAssertEqual(status.state, .missingManifest)
        XCTAssertNotNil(status.timelineHash)
    }

    func testLegacyManifestWithoutHash() throws {
        let project = try makeProject()
        try write(project, "05_timeline/timeline.json", "{}")
        try write(project, "05_timeline/preview-manifest.json", #"{"version": "1"}"#)
        let status = ProjectPlaybackContractStatusReader.status(projectURL: project)
        XCTAssertEqual(status.state, .legacyManifest)
    }

    func testExactWhenHashesMatch() throws {
        let project = try makeProject()
        try write(project, "05_timeline/timeline.json", #"{"v":1}"#)
        let hash = ProjectPlaybackContractStatusReader.fileHash16(Data(#"{"v":1}"#.utf8))
        try write(
            project,
            "05_timeline/preview-manifest.json",
            #"{"version": "1", "base_timeline_hash": "\#(hash)"}"#
        )
        let status = ProjectPlaybackContractStatusReader.status(projectURL: project)
        XCTAssertEqual(status.state, .exact)
        XCTAssertTrue(status.isApprovalGrade)
        XCTAssertEqual(status.timelineHash, status.manifestBaseTimelineHash)
    }

    func testStaleAfterTimelineChanges() throws {
        let project = try makeProject()
        let hash = ProjectPlaybackContractStatusReader.fileHash16(Data(#"{"v":1}"#.utf8))
        try write(
            project,
            "05_timeline/preview-manifest.json",
            #"{"version": "1", "base_timeline_hash": "\#(hash)"}"#
        )
        try write(project, "05_timeline/timeline.json", #"{"v":2}"#)
        let status = ProjectPlaybackContractStatusReader.status(projectURL: project)
        XCTAssertEqual(status.state, .stale)
        XCTAssertFalse(status.isApprovalGrade)
    }
}
