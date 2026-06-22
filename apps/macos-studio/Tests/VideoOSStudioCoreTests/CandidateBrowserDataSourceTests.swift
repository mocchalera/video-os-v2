import XCTest
@testable import VideoOSStudioCore

final class CandidateBrowserDataSourceTests: XCTestCase {
    func testBrowserCandidateJSONRoundTrip() throws {
        let json = Data("""
        {
          "project_id": "fixture",
          "candidates": [
            {
              "candidate_id": "cand_1",
              "segment_id": "SEG_001",
              "asset_id": "AST_001",
              "key_frame_path": "03_analysis/frames/SEG_001/representative.jpg",
              "src_in_us": 100,
              "src_out_us": 900,
              "role": "hero",
              "confidence": 0.91,
              "why_it_matches": "strong opening image",
              "risks": ["minor wind"],
              "eligible_beats": ["b01"],
              "story_role": "hook",
              "evidence": ["marlin event"],
              "motif_tags": ["sunrise"],
              "trim_hint": {
                "source_center_us": 500,
                "preferred_duration_us": 800,
                "recommended_in_us": 100,
                "recommended_out_us": 900,
                "peak_ref": "peak_1",
                "rationale": "use the action peak"
              },
              "editorial_signals": {
                "peak_ref": "peak_1",
                "peak_type": "visual_peak",
                "peak_strength_score": 0.7
              }
            }
          ],
          "beat_plans": [
            {
              "beat_id": "b01",
              "label": "hook",
              "target_duration_frames": 96,
              "primary_candidate_ref": "cand_1",
              "fallback_candidate_refs": ["SEG_002"]
            }
          ]
        }
        """.utf8)

        let decoded = try JSONDecoder().decode(CandidateBrowserDataSource.self, from: json)
        let encoded = try JSONEncoder().encode(decoded)
        let roundTripped = try JSONDecoder().decode(CandidateBrowserDataSource.self, from: encoded)

        XCTAssertEqual(roundTripped, decoded)
        XCTAssertEqual(decoded.projectID, "fixture")
        XCTAssertEqual(decoded.candidates.first?.id, "cand_1")
        XCTAssertEqual(decoded.candidates.first?.key_frame_path, "03_analysis/frames/SEG_001/representative.jpg")
        XCTAssertEqual(decoded.candidates.first?.trim_hint?.recommended_out_us, 900)
        XCTAssertEqual(decoded.candidates.first?.editorial_signals?.peak_type, "visual_peak")
    }

    func testCandidatesForBeatFiltersAndSortsByConfidence() {
        let dataSource = CandidateBrowserDataSource(
            projectID: "fixture",
            candidates: [
                makeCandidate(segmentID: "SEG_LOW", confidence: 0.62, beats: ["b01"]),
                makeCandidate(segmentID: "SEG_OTHER", confidence: 0.99, beats: ["b02"]),
                makeCandidate(segmentID: "SEG_HIGH", confidence: 0.87, beats: ["b01"]),
            ],
            beatPlans: []
        )

        XCTAssertEqual(dataSource.candidates(forBeat: "b01").map(\.segment_id), ["SEG_HIGH", "SEG_LOW"])
    }

    func testCandidatesForBeatAppendsFallbackRefsOutsideEligibleBeats() {
        let dataSource = CandidateBrowserDataSource(
            projectID: "fixture",
            candidates: [
                makeCandidate(segmentID: "SEG_LOW", confidence: 0.62, beats: ["b01"]),
                makeCandidate(segmentID: "SEG_HIGH", confidence: 0.87, beats: ["b01"]),
                makeCandidate(
                    candidateID: "cand_fallback",
                    segmentID: "SEG_FALLBACK_BY_CANDIDATE",
                    confidence: 0.99,
                    beats: ["b02"]
                ),
                makeCandidate(segmentID: "SEG_FALLBACK_BY_SEGMENT", confidence: 0.78, beats: []),
            ],
            beatPlans: [
                BrowserBeatPlan(
                    beat_id: "b01",
                    label: "hook",
                    target_duration_frames: 96,
                    primary_candidate_ref: "SEG_HIGH",
                    fallback_candidate_refs: [
                        "SEG_LOW",
                        "cand_fallback",
                        "SEG_FALLBACK_BY_SEGMENT",
                        "missing",
                        "cand_fallback",
                    ]
                ),
            ]
        )

        XCTAssertEqual(
            dataSource.candidates(forBeat: "b01").map(\.segment_id),
            ["SEG_HIGH", "SEG_LOW", "SEG_FALLBACK_BY_CANDIDATE", "SEG_FALLBACK_BY_SEGMENT"]
        )
    }

    func testFallbacksForBeatUseBeatPlanRefs() {
        let dataSource = CandidateBrowserDataSource(
            projectID: "fixture",
            candidates: [],
            beatPlans: [
                BrowserBeatPlan(
                    beat_id: "b01",
                    label: "hook",
                    target_duration_frames: 96,
                    primary_candidate_ref: "cand_1",
                    fallback_candidate_refs: ["SEG_002", "cand_3"]
                ),
                BrowserBeatPlan(
                    beat_id: "b02",
                    label: "middle",
                    target_duration_frames: 120,
                    primary_candidate_ref: nil,
                    fallback_candidate_refs: []
                ),
            ]
        )

        XCTAssertEqual(dataSource.fallbacks(forBeat: "b01"), ["SEG_002", "cand_3"])
        XCTAssertEqual(dataSource.fallbacks(forBeat: "missing"), [])
    }
}

private func makeCandidate(
    candidateID: String? = nil,
    segmentID: String,
    confidence: Double,
    beats: [String]
) -> BrowserCandidate {
    BrowserCandidate(
        candidate_id: candidateID,
        segment_id: segmentID,
        asset_id: "AST_\(segmentID)",
        src_in_us: 0,
        src_out_us: 1_000_000,
        role: "support",
        confidence: confidence,
        why_it_matches: "test",
        risks: [],
        eligible_beats: beats,
        story_role: nil,
        evidence: [],
        motif_tags: [],
        trim_hint: nil,
        editorial_signals: nil
    )
}
