import XCTest
@testable import VideoOSStudioCore

final class ProjectArtifactDiffTests: XCTestCase {
    func testSnapshotDiffDetectsCanonicalArtifactChangesAndSkipsSearchIndex() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-artifact-diff-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let reviewDir = root.appendingPathComponent("06_review")
        let searchDir = root.appendingPathComponent("03_analysis/search")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: searchDir, withIntermediateDirectories: true)

        let timeline = timelineDir.appendingPathComponent("timeline.json")
        let removed = reviewDir.appendingPathComponent("old_report.yaml")
        let ignored = searchDir.appendingPathComponent("project_index.sqlite")
        try #"{"version":"1"}"#.write(to: timeline, atomically: true, encoding: .utf8)
        try "old: true\n".write(to: removed, atomically: true, encoding: .utf8)
        try "before".write(to: ignored, atomically: true, encoding: .utf8)

        let before = try ProjectArtifactSnapshot.capture(projectURL: root)

        try #"{"version":"2"}"#.write(to: timeline, atomically: true, encoding: .utf8)
        try "new: true\n".write(to: reviewDir.appendingPathComponent("review_report.yaml"), atomically: true, encoding: .utf8)
        try FileManager.default.removeItem(at: removed)
        try "after".write(to: ignored, atomically: true, encoding: .utf8)

        let after = try ProjectArtifactSnapshot.capture(projectURL: root)
        let diffs = before.diff(to: after)

        XCTAssertEqual(diffs.map(\.relativePath), [
            "06_review/review_report.yaml",
            "05_timeline/timeline.json",
            "06_review/old_report.yaml"
        ])
        XCTAssertEqual(diffs.map(\.kind), [.added, .modified, .removed])
        XCTAssertFalse(diffs.contains { $0.relativePath.hasPrefix("03_analysis/search/") })
        XCTAssertEqual(diffs[0].detailLines.prefix(2), [
            "+ new: true",
            "+ "
        ])
        XCTAssertEqual(diffs[1].detailLines.prefix(3), [
            "  {",
            "-   \"version\" : \"1\"",
            "+   \"version\" : \"2\""
        ])
    }
}
