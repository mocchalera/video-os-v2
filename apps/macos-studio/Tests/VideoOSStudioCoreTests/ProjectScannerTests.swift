import XCTest
@testable import VideoOSStudioCore

final class ProjectScannerTests: XCTestCase {
    func testLocateRepositoryRootFindsPackageAndSchemas() throws {
        let root = try makeTemporaryRepository()
        let nested = root.appendingPathComponent("apps/macos-studio")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)

        XCTAssertEqual(ProjectScanner.locateRepositoryRoot(startingAt: nested).path, root.path)
    }

    func testLocateRepositoryRootUsesAdditionalCandidatesForBundledAppLaunches() throws {
        let root = try makeTemporaryRepository()
        let unrelated = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)

        XCTAssertEqual(
            ProjectScanner.locateRepositoryRoot(startingAt: unrelated, additionalCandidates: [root]).path,
            root.path
        )
    }

    func testScanProjectsSkipsTemplateAndReadsState() throws {
        let root = try makeTemporaryRepository()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("projects/_template"), withIntermediateDirectories: true)
        let project = root.appendingPathComponent("projects/sample")
        try FileManager.default.createDirectory(at: project.appendingPathComponent("05_timeline"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("06_review"), withIntermediateDirectories: true)
        try "current_state: critique_ready\n".write(to: project.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)
        try "{}".write(to: project.appendingPathComponent("05_timeline/timeline.json"), atomically: true, encoding: .utf8)

        let projects = ProjectScanner.scanProjects(in: root)

        XCTAssertEqual(projects.map(\.id), ["sample"])
        XCTAssertEqual(projects.first?.stateLabel, "critique_ready")
        XCTAssertEqual(projects.first?.hasTimeline, true)
        XCTAssertEqual(projects.first?.hasReview, false)
    }

    func testSummarizeProjectCountsProfessionalMediaFormats() throws {
        let root = try makeTemporaryRepository()
        let project = root.appendingPathComponent("external-cut")
        let source = project.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try Data([0]).write(to: source.appendingPathComponent("camera-a.mxf"))
        try Data([1]).write(to: source.appendingPathComponent("music.flac"))
        try "current_state: ingest_ready\n".write(to: project.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)

        let summary = try XCTUnwrap(ProjectScanner.summarizeProject(at: project))

        XCTAssertEqual(summary.id, "external-cut")
        XCTAssertEqual(summary.stateLabel, "ingest_ready")
        XCTAssertEqual(summary.mediaFileCount, 2)
    }

    private func makeTemporaryRepository() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("schemas"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("projects"), withIntermediateDirectories: true)
        return root
    }
}
