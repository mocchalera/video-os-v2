import XCTest
@testable import VideoOSStudioCore

final class ProjectLibraryReadinessStatusTests: XCTestCase {
    func testStatusReportsNotAnalyzedWhenCanonicalEvidenceIsMissing() throws {
        let root = temporaryProjectURL("videoos-library-empty")

        let status = ProjectLibraryReadinessStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "not analyzed")
        XCTAssertFalse(status.analysisReady)
        XCTAssertFalse(status.mediaReady)
        XCTAssertFalse(status.ragReady)
        XCTAssertEqual(status.assetCount, 0)
        XCTAssertTrue(status.recommendation.contains("Run analysis"))
    }

    func testStatusReportsIndexMissingForAnalyzedRelinkedMediaWithoutRAGCache() throws {
        let root = temporaryProjectURL("videoos-library-index-missing")
        try writeLibraryFixtureProject(at: root, includeMedia: true, includeTimeline: false, includeAnnotations: false)

        let status = ProjectLibraryReadinessStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "index missing")
        XCTAssertTrue(status.analysisReady)
        XCTAssertTrue(status.mediaReady)
        XCTAssertFalse(status.ragReady)
        XCTAssertEqual(status.assetCount, 1)
        XCTAssertEqual(status.segmentCount, 1)
        XCTAssertEqual(status.transcriptDocumentCount, 1)
        XCTAssertEqual(status.transcriptItemCount, 1)
        XCTAssertEqual(status.mediaReadyCount, 1)
        XCTAssertEqual(status.mediaMissingCount, 0)
        XCTAssertTrue(status.recommendation.contains("SQLite project index"))
    }

    func testStatusReportsLibraryReadyWhenMediaIndexTimelineAndAnnotationsExist() throws {
        let root = temporaryProjectURL("videoos-library-ready")
        try writeLibraryFixtureProject(at: root, includeMedia: true, includeTimeline: true, includeAnnotations: true)
        _ = try ProjectSQLiteIndex.rebuild(projectURL: root)

        let status = ProjectLibraryReadinessStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "library ready")
        XCTAssertTrue(status.analysisReady)
        XCTAssertTrue(status.mediaReady)
        XCTAssertTrue(status.ragReady)
        XCTAssertTrue(status.timelineExists)
        XCTAssertTrue(status.handoffAnnotationsExist)
        XCTAssertEqual(status.indexDocumentCount, 3)
        XCTAssertTrue(status.recommendation.contains("ready for review"))
    }

    private func temporaryProjectURL(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }
}

private func writeLibraryFixtureProject(
    at root: URL,
    includeMedia: Bool,
    includeTimeline: Bool,
    includeAnnotations: Bool
) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
    let transcriptDir = analysisDir.appendingPathComponent("transcripts")
    let sourceDir = root.appendingPathComponent("02_media/source")
    try FileManager.default.createDirectory(at: transcriptDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)

    try libraryFixtureAssets.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
    try libraryFixtureSegments.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
    try libraryFixtureTranscript.write(to: transcriptDir.appendingPathComponent("TR_AST_001.json"), atomically: true, encoding: .utf8)

    if includeMedia {
        try Data().write(to: sourceDir.appendingPathComponent("interview.mov"))
    }
    if includeTimeline {
        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try "{}".write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
    }
    if includeAnnotations {
        let handoffDir = root.appendingPathComponent("07_handoff")
        try FileManager.default.createDirectory(at: handoffDir, withIntermediateDirectories: true)
        try "{}".write(to: handoffDir.appendingPathComponent("editor_annotations.json"), atomically: true, encoding: .utf8)
    }
}

private let libraryFixtureAssets = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "items": [
    {
      "asset_id": "AST_001",
      "filename": "interview.mov",
      "role_guess": "interview",
      "duration_us": 12000000,
      "has_transcript": true,
      "transcript_ref": "TR_AST_001",
      "segment_ids": ["SEG_001"],
      "quality_flags": [],
      "tags": ["interview", "quiet"]
    }
  ]
}
"""

private let libraryFixtureSegments = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "items": [
    {
      "segment_id": "SEG_001",
      "asset_id": "AST_001",
      "src_in_us": 1000000,
      "src_out_us": 5000000,
      "summary": "subject explains quiet reset",
      "transcript_excerpt": "I came here to get quiet again.",
      "quality_flags": [],
      "tags": ["interview", "quiet"]
    }
  ]
}
"""

private let libraryFixtureTranscript = """
{
  "project_id": "demo",
  "artifact_version": "analysis-v1",
  "transcript_ref": "TR_AST_001",
  "asset_id": "AST_001",
  "items": [
    {
      "speaker": "S1",
      "start_us": 1200000,
      "end_us": 4400000,
      "text": "I came here to get quiet again."
    }
  ]
}
"""
