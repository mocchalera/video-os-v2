import XCTest
@testable import VideoOSStudioCore

final class FootageSearchRunnerTests: XCTestCase {
    func testSearchResponseRoundTrip() throws {
        let response = FootageSearchRunner.SearchResponse(
            queryText: "bright river",
            db_status: "ready",
            mode_used: "hybrid",
            results: [
                FootageSearchRunner.SearchResult(
                    segment_id: "SEG_001",
                    asset_id: "AST_001",
                    src_in_us: 100,
                    src_out_us: 2_100_000,
                    score: 0.91,
                    scores: ["e5_text": 0.72, "qwen_visual": 0.88],
                    key_frame_path: "03_analysis/frames/SEG_001/representative.jpg",
                    tags: ["river"],
                    quality_flags: [],
                    summary: "Bright river landscape"
                )
            ],
            warnings: []
        )

        let data = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(FootageSearchRunner.SearchResponse.self, from: data)

        XCTAssertEqual(decoded, response)
    }

    func testDecodesPerChannelScoresFromFootageSearchJSON() throws {
        let json = """
        {
          "query": { "query": "river", "mode": "hybrid" },
          "db_status": "ready",
          "mode_used": "hybrid",
          "results": [
            {
              "segment_id": "SEG_001",
              "asset_id": "AST_001",
              "src_in_us": 0,
              "src_out_us": 3000000,
              "score": 0.87,
              "scores": {
                "semantic": 0.70,
                "e5_text": 0.70,
                "qwen_visual": 0.88,
                "qwen_text": 0.64,
                "clap_audio": 0.51,
                "lexical": 0.42,
                "weights": { "qwen_visual": 0.35 },
                "embedding_matches": []
              },
              "key_frame_path": "03_analysis/frames/SEG_001/representative.jpg",
              "tags": ["river"],
              "quality_flags": [],
              "summary": "River view"
            }
          ],
          "warnings": []
        }
        """

        let decoded = try JSONDecoder().decode(FootageSearchRunner.SearchResponse.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.queryText, "river")
        XCTAssertEqual(decoded.results.first?.scores?["e5_text"], 0.70)
        XCTAssertEqual(decoded.results.first?.scores?["qwen_visual"], 0.88)
        XCTAssertEqual(decoded.results.first?.scores?["qwen_text"], 0.64)
        XCTAssertEqual(decoded.results.first?.scores?["clap_audio"], 0.51)
        XCTAssertEqual(decoded.results.first?.scores?["lexical"], 0.42)
        XCTAssertNil(decoded.results.first?.scores?["weights"])
    }

    func testDecodesErrorResponse() throws {
        let json = """
        {
          "query": "river",
          "db_status": null,
          "mode_used": "visual",
          "results": [],
          "warnings": null,
          "error": "footage-search-cli exited with code 1"
        }
        """

        let decoded = try JSONDecoder().decode(FootageSearchRunner.SearchResponse.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.queryText, "river")
        XCTAssertEqual(decoded.mode_used, "visual")
        XCTAssertEqual(decoded.results, [])
        XCTAssertEqual(decoded.error, "footage-search-cli exited with code 1")
    }

    func testDecodesNullQueryAsNilQueryText() throws {
        let json = """
        {
          "query": null,
          "db_status": "missing",
          "mode_used": "visual",
          "results": [],
          "warnings": []
        }
        """

        let decoded = try JSONDecoder().decode(FootageSearchRunner.SearchResponse.self, from: Data(json.utf8))

        XCTAssertNil(decoded.queryText)
        XCTAssertEqual(decoded.mode_used, "visual")
        XCTAssertEqual(decoded.results, [])
    }

    func testSearchResultMakesReplaceSegmentOperationWithSegmentCandidateRef() throws {
        let result = FootageSearchRunner.SearchResult(
            segment_id: "SEG_0123",
            asset_id: "AST_0123",
            src_in_us: 1_200_000,
            src_out_us: 4_800_000,
            score: 0.92,
            summary: "Low-angle campfire detail with hands entering frame"
        )

        let operation = result.makeReplaceSegmentOperation(targetClipID: "CLP_0007", mode: "hybrid")

        XCTAssertEqual(operation, .replaceSegment(
            target_clip_id: "CLP_0007",
            with_segment_id: "SEG_0123",
            with_candidate_ref: "SEG_0123",
            new_src_in_us: nil,
            new_src_out_us: nil,
            reason: "Swap selected in Footage Search (hybrid): Low-angle campfire detail with hands entering frame"
        ))
        XCTAssertTrue(operation.isValidForStudioSession)
    }

    func testSearchResultReplaceSegmentOperationFallsBackToSegmentIDAndTruncatesReason() throws {
        let summary = String(repeating: "visual-match-", count: 12)
        let result = FootageSearchRunner.SearchResult(
            segment_id: "SEG_LONG",
            asset_id: "AST_LONG",
            src_in_us: 0,
            src_out_us: 3_000_000,
            score: 0.81,
            summary: summary
        )

        let operation = result.makeReplaceSegmentOperation(targetClipID: "CLP_0008", mode: "multimodal")
        guard case let .replaceSegment(_, segmentID, candidateRef, sourceInUS, sourceOutUS, reason) = operation else {
            return XCTFail("Expected replace_segment")
        }

        XCTAssertEqual(segmentID, "SEG_LONG")
        XCTAssertEqual(candidateRef, "SEG_LONG")
        XCTAssertNil(sourceInUS)
        XCTAssertNil(sourceOutUS)
        XCTAssertLessThanOrEqual(reason.count, "Swap selected in Footage Search (multimodal): ".count + 96)
        XCTAssertTrue(reason.hasSuffix("..."))
        XCTAssertTrue(operation.isValidForStudioSession)
    }
}
