import XCTest
@testable import VideoOSStudioCore

final class ProjectRAGContextPackTests: XCTestCase {
    func testBuildCreatesPromptReadyCitationsFromSearchIndex() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-rag-context-\(UUID().uuidString)")
        try writeRAGFixtureProject(at: root)
        _ = try ProjectSQLiteIndex.rebuild(projectURL: root)

        let pack = try ProjectRAGContextPack.build(projectURL: root, query: "quiet", limit: 4)

        XCTAssertFalse(pack.isEmpty)
        XCTAssertEqual(pack.query, "quiet")
        XCTAssertTrue(pack.promptText.contains("Material RAG context for query `quiet`:"))
        XCTAssertTrue(pack.promptText.contains("doc=segment:SEG_RAG_001"))
        XCTAssertTrue(pack.promptText.contains("asset=AST_RAG_001"))
        XCTAssertTrue(pack.promptText.contains("segment=SEG_RAG_001"))
        XCTAssertTrue(pack.promptText.contains("time=00:01.000-00:05.000"))
        XCTAssertTrue(pack.promptText.contains("I came here to get quiet again."))
    }

    func testEmptyQueryReturnsEmptyPackWithoutOpeningIndex() throws {
        let pack = try ProjectRAGContextPack.build(projectURL: URL(fileURLWithPath: "/missing"), query: "   ")

        XCTAssertTrue(pack.isEmpty)
        XCTAssertEqual(pack.promptText, "Material RAG context for query ``: no indexed evidence found.")
    }
}

private func writeRAGFixtureProject(at root: URL) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
    let transcriptDir = analysisDir.appendingPathComponent("transcripts")
    try FileManager.default.createDirectory(at: transcriptDir, withIntermediateDirectories: true)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "asset_id": "AST_RAG_001",
          "filename": "interview.mov",
          "role_guess": "interview",
          "duration_us": 12000000,
          "has_transcript": true,
          "transcript_ref": "TR_AST_RAG_001",
          "segments": 1,
          "segment_ids": ["SEG_RAG_001"],
          "quality_flags": [],
          "tags": ["interview", "quiet"]
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "segment_id": "SEG_RAG_001",
          "asset_id": "AST_RAG_001",
          "src_in_us": 1000000,
          "src_out_us": 5000000,
          "summary": "subject explains quiet reset",
          "transcript_excerpt": "I came here to get quiet again.",
          "quality_flags": [],
          "tags": ["interview", "quiet"]
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "transcript_ref": "TR_AST_RAG_001",
      "asset_id": "AST_RAG_001",
      "items": [
        {
          "speaker": "S1",
          "start_us": 1200000,
          "end_us": 4400000,
          "text": "I came here to get quiet again."
        }
      ]
    }
    """.write(to: transcriptDir.appendingPathComponent("TR_AST_RAG_001.json"), atomically: true, encoding: .utf8)
}
