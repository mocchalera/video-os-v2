import XCTest
@testable import VideoOSStudioCore

final class TimelineSourceReplacePlanTests: XCTestCase {
    func testPlanReplacesSelectedVideoClipWithExplicitSourceCandidate() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-replace-test",
            candidates: [
                makeCandidate(segmentID: "SEG_STRONG", assetID: "AST_SRC", role: "support", confidence: 0.95),
                makeCandidate(segmentID: "SEG_SELECTED", assetID: "AST_SRC", role: "support", confidence: 0.45),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceReplacePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            targetClipID: "CLP_0001",
            reason: "Studio source monitor replace selected clip",
            candidateID: "SEG_SELECTED"
        ))

        XCTAssertEqual(plan.operation.opName, "replace_segment")
        XCTAssertEqual(plan.candidate.segment_id, "SEG_SELECTED")
        XCTAssertEqual(plan.targetSelection.trackID, "V1")
        XCTAssertEqual(plan.targetSelection.clip.id, "CLP_0001")
        XCTAssertEqual(plan.changedClipIDs, ["CLP_0001"])

        let replaced = try XCTUnwrap(plan.timeline.clipSelection(for: "CLP_0001")?.clip)
        XCTAssertEqual(replaced.id, "CLP_0001")
        XCTAssertEqual(replaced.segmentID, "SEG_SELECTED")
        XCTAssertEqual(replaced.assetID, "AST_SRC")
        XCTAssertEqual(replaced.sourceInUS, 1_000_000)
        XCTAssertEqual(replaced.sourceOutUS, 3_000_000)
        XCTAssertEqual(replaced.timelineInFrame, 0)
        XCTAssertEqual(replaced.timelineDurationFrames, 48)
        XCTAssertEqual(replaced.role, "support")
        XCTAssertEqual(replaced.confidence, 0.45)
        XCTAssertEqual(replaced.candidateRef, "SEG_SELECTED")
        XCTAssertEqual(replaced.fallbackSegmentIDs, [])
        XCTAssertEqual(replaced.qualityFlags, [])
        guard case let .replaceSegment(_, segmentID, candidateRef, sourceInUS, sourceOutUS, reason) = plan.operation else {
            return XCTFail("Expected replace_segment")
        }
        XCTAssertEqual(segmentID, "SEG_SELECTED")
        XCTAssertEqual(candidateRef, "SEG_SELECTED")
        XCTAssertNil(sourceInUS)
        XCTAssertNil(sourceOutUS)
        XCTAssertEqual(reason, "Studio source monitor replace selected clip")
    }

    func testPlanUsesSourceRangeOverrideForMarkedReplace() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-replace-test",
            candidates: [
                makeCandidate(segmentID: "SEG_MARKED", assetID: "AST_SRC", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 1_250_000, sourceOutUS: 2_000_000))

        let plan = try XCTUnwrap(TimelineSourceReplacePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            targetClipID: "CLP_0001",
            reason: "Studio source monitor marked replace selected clip",
            candidateID: "SEG_MARKED",
            sourceRangeOverride: range
        ))

        let replaced = try XCTUnwrap(plan.timeline.clipSelection(for: "CLP_0001")?.clip)
        XCTAssertEqual(replaced.id, "CLP_0001")
        XCTAssertEqual(replaced.segmentID, "SEG_MARKED")
        XCTAssertEqual(replaced.assetID, "AST_SRC")
        XCTAssertEqual(replaced.sourceInUS, 1_250_000)
        XCTAssertEqual(replaced.sourceOutUS, 2_000_000)
        XCTAssertEqual(replaced.timelineInFrame, 0)
        XCTAssertEqual(replaced.timelineDurationFrames, 48)
        XCTAssertEqual(replaced.candidateRef, "SEG_MARKED")
        guard case let .replaceSegment(_, segmentID, candidateRef, sourceInUS, sourceOutUS, reason) = plan.operation else {
            return XCTFail("Expected replace_segment")
        }
        XCTAssertEqual(segmentID, "SEG_MARKED")
        XCTAssertEqual(candidateRef, "SEG_MARKED")
        XCTAssertEqual(sourceInUS, 1_250_000)
        XCTAssertEqual(sourceOutUS, 2_000_000)
        XCTAssertEqual(reason, "Studio source monitor marked replace selected clip")
    }

    func testPlanRejectsSourceRangeOutsideCandidate() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-replace-test",
            candidates: [
                makeCandidate(segmentID: "SEG_MARKED", assetID: "AST_SRC", role: "support", confidence: 0.88),
            ],
            beatPlans: []
        )
        let range = try XCTUnwrap(TimelineSourceRangeOverride(sourceInUS: 900_000, sourceOutUS: 3_500_000))

        XCTAssertNil(TimelineSourceReplacePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_SRC",
            targetClipID: "CLP_0001",
            reason: "Studio source monitor marked replace selected clip",
            candidateID: "SEG_MARKED",
            sourceRangeOverride: range
        ))
    }

    func testPlanRejectsAudioCandidateForVideoClip() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-replace-test",
            candidates: [
                makeCandidate(segmentID: "SEG_DIALOGUE", assetID: "AST_DIALOGUE", role: "dialogue", confidence: 0.91),
            ],
            beatPlans: []
        )

        let plan = TimelineSourceReplacePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_DIALOGUE",
            targetClipID: "CLP_0001",
            reason: "Studio source monitor replace selected clip"
        )

        XCTAssertNil(plan)
    }

    func testPlanAllowsAudioCandidateForAudioClip() throws {
        let timeline = try makeTimeline()
        let dataSource = CandidateBrowserDataSource(
            projectID: "source-replace-test",
            candidates: [
                makeCandidate(segmentID: "SEG_DIALOGUE", assetID: "AST_DIALOGUE", role: "dialogue", confidence: 0.91),
            ],
            beatPlans: []
        )

        let plan = try XCTUnwrap(TimelineSourceReplacePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: "AST_DIALOGUE",
            targetClipID: "CLP_A001",
            reason: "Studio source monitor replace selected audio clip"
        ))

        let replaced = try XCTUnwrap(plan.timeline.clipSelection(for: "CLP_A001")?.clip)
        XCTAssertEqual(replaced.segmentID, "SEG_DIALOGUE")
        XCTAssertEqual(replaced.assetID, "AST_DIALOGUE")
        XCTAssertEqual(replaced.role, "dialogue")
        XCTAssertEqual(replaced.timelineInFrame, 0)
        XCTAssertEqual(replaced.timelineDurationFrames, 48)
    }

    private func makeCandidate(
        segmentID: String,
        assetID: String,
        role: String,
        confidence: Double
    ) -> BrowserCandidate {
        BrowserCandidate(
            candidate_id: nil,
            segment_id: segmentID,
            asset_id: assetID,
            src_in_us: 1_000_000,
            src_out_us: 3_000_000,
            role: role,
            confidence: confidence,
            why_it_matches: "candidate \(segmentID)",
            risks: [],
            eligible_beats: ["b01"],
            story_role: nil,
            evidence: [],
            motif_tags: [],
            trim_hint: nil,
            editorial_signals: nil
        )
    }

    private func makeTimeline() throws -> TimelineDocument {
        let json = """
        {
          "version": "1",
          "project_id": "source-replace-test",
          "sequence": {
            "name": "Source Replace Test",
            "fps_num": 24,
            "fps_den": 1,
            "width": 1920,
            "height": 1080,
            "start_frame": 0
          },
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "kind": "video",
                "clips": [
                  {
                    "clip_id": "CLP_0001",
                    "segment_id": "SEG_MAIN",
                    "asset_id": "AST_MAIN",
                    "src_in_us": 0,
                    "src_out_us": 2000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 48,
                    "role": "hero",
                    "motivation": "main",
                    "beat_id": "b01",
                    "candidate_ref": "SEG_MAIN",
                    "fallback_segment_ids": ["SEG_ALT"],
                    "quality_flags": ["old"]
                  }
                ]
              }
            ],
            "audio": [
              {
                "track_id": "A1",
                "kind": "audio",
                "clips": [
                  {
                    "clip_id": "CLP_A001",
                    "segment_id": "SEG_AUDIO",
                    "asset_id": "AST_AUDIO",
                    "src_in_us": 0,
                    "src_out_us": 2000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 48,
                    "role": "dialogue",
                    "motivation": "dialogue",
                    "beat_id": "b01"
                  }
                ]
              }
            ],
            "overlay": [],
            "caption": []
          },
          "markers": []
        }
        """
        return try JSONDecoder().decode(TimelineDocument.self, from: Data(json.utf8))
    }
}
