import XCTest
@testable import VideoOSStudioCore

final class TimelineAgentConsultationPromptTests: XCTestCase {
    func testConsultationIntentLocalizedTitlesMatchPanelLabels() {
        XCTAssertEqual(TimelineAgentConsultationIntent.tightenSelection.localizedTitle, "短く整える")
        XCTAssertEqual(TimelineAgentConsultationIntent.shortenBeat.localizedTitle, "このビートを短く")
        XCTAssertEqual(TimelineAgentConsultationIntent.findStrongerAlternate.localizedTitle, "代替を探す")
        XCTAssertEqual(TimelineAgentConsultationIntent.explainCut.localizedTitle, "カットを説明")
    }

    func testPromptIncludesSelectedClipsTransitionAndReadOnlyPreviewContract() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "Demo Edit",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: false,
            mediaFileCount: 2
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(timelineConsultationJSON.utf8))
        let first = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))
        let second = try XCTUnwrap(timeline.clipSelection(for: "clip-002"))
        let transition = try XCTUnwrap(timeline.transitions.first)

        let prompt = TimelineAgentConsultationPrompt.make(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            timeline: timeline,
            intent: .tightenSelection,
            selectedClips: [second, first],
            selectedTransition: transition
        )

        XCTAssertTrue(prompt.contains("Do not modify files or write artifacts"))
        XCTAssertTrue(prompt.contains("PREVIEW, not applied"))
        XCTAssertTrue(prompt.contains("fenced `review_patch` JSON block"))
        XCTAssertTrue(prompt.contains("\"timeline_version\": \"1\""))
        XCTAssertTrue(prompt.contains("Task: Suggest how to tighten"))
        XCTAssertTrue(prompt.contains("Selection range: 00:00:01:00-00:00:05:00"))
        XCTAssertTrue(prompt.contains("Selected transition:"))
        XCTAssertTrue(prompt.contains("- Transition: TRN_V1_clip-001_clip-002"))
        XCTAssertTrue(prompt.contains("- Available handles: 48 frames"))
        XCTAssertTrue(prompt.contains("- Clip: clip-001"))
        XCTAssertTrue(prompt.contains("- Clip: clip-002"))
        XCTAssertLessThan(
            try XCTUnwrap(prompt.range(of: "- Clip: clip-001")?.lowerBound),
            try XCTUnwrap(prompt.range(of: "- Clip: clip-002")?.lowerBound)
        )
    }

    func testPromptCanFocusOnAlternateSearchWithoutTimelineWrites() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "Demo Edit",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: false,
            mediaFileCount: 2
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(timelineConsultationJSON.utf8))
        let selection = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))

        let prompt = TimelineAgentConsultationPrompt.make(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            timeline: timeline,
            intent: .findStrongerAlternate,
            selectedClips: [selection],
            selectedTransition: nil
        )

        XCTAssertTrue(prompt.contains("search-alternate"))
        XCTAssertTrue(prompt.contains("stronger source material"))
        XCTAssertTrue(prompt.contains("Mark every timeline-changing suggestion as PREVIEW"))
        XCTAssertTrue(prompt.contains("Evidence to verify"))
    }

    func testPromptIncludesQAIssuesForSelectedClip() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "Demo Edit",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: true,
            mediaFileCount: 2
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(timelineConsultationJSON.utf8))
        let selection = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))
        let issue = try JSONDecoder().decode(QAIssueItem.self, from: Data("""
        {
          "issue_id": "QAISSUE_PACING",
          "type": "pacing",
          "severity": 0.82,
          "timestamp_sec": 1.25,
          "clip_id": "clip-001",
          "beat_id": "b01",
          "description": "The setup lingers before the reaction cut.",
          "fixable": true,
          "suggested_fix_type": "trim",
          "search_query": "tighter reaction bridge"
        }
        """.utf8))

        let prompt = TimelineAgentConsultationPrompt.make(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            timeline: timeline,
            intent: .tightenSelection,
            selectedClips: [selection],
            selectedTransition: nil,
            qaIssuesByClipID: ["clip-001": [issue]]
        )

        XCTAssertTrue(prompt.contains("QA issues:"))
        XCTAssertTrue(prompt.contains("QAISSUE_PACING [pacing, severity 0.82, fixable, 00:00:01:06]"))
        XCTAssertTrue(prompt.contains("The setup lingers before the reaction cut."))
        XCTAssertTrue(prompt.contains("Suggested fix: trim."))
        XCTAssertTrue(prompt.contains("Search: tighter reaction bridge."))
    }

    func testPromptIncludesRichLocalEvidenceSignalsForSelectedClip() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "Demo Edit",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: true,
            mediaFileCount: 2
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(timelineConsultationJSON.utf8))
        let selection = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))
        let evidence = ClipEvidence(
            asset: try decodeFixture(AnalysisAsset.self, from: """
            {
              "asset_id": "AST_001",
              "filename": "reaction.mov",
              "role_guess": "b-roll",
              "duration_us": 6000000,
              "has_transcript": true,
              "transcript_ref": "tr_ast_001",
              "segment_ids": ["SEG_001"],
              "quality_flags": [],
              "tags": ["reaction", "closeup"]
            }
            """),
            segment: try decodeFixture(AnalysisSegment.self, from: """
            {
              "segment_id": "SEG_001",
              "asset_id": "AST_001",
              "src_in_us": 1000000,
              "src_out_us": 3000000,
              "summary": "Speaker reaction turns the beat.",
              "transcript_excerpt": "This is the key reaction.",
              "transcript_ref": "tr_ast_001",
              "quality_flags": [],
              "tags": ["payoff"],
              "interest_points": [
                {
                  "frame_us": 1800000,
                  "label": "reaction peak",
                  "confidence": 0.91,
                  "source": "marlin"
                }
              ],
              "peak_analysis": {
                "selected_peak_us": 1920000,
                "confidence": 0.88,
                "support_signals": {
                  "fused_peak_score": 0.76
                },
                "provenance": {
                  "precision_mode": "frame",
                  "fusion_version": "v2"
                }
              }
            }
            """),
            transcriptItems: [
                try decodeFixture(TranscriptItem.self, from: """
                {
                  "speaker": "Host",
                  "speaker_key": "host",
                  "start_us": 1200000,
                  "end_us": 2200000,
                  "text": "This lands better after the reaction."
                }
                """)
            ],
            marlinAsset: nil,
            marlinEvents: [
                try decodeFixture(MarlinEvent.self, from: """
                {
                  "event_id": "ME_001",
                  "start_us": 1500000,
                  "end_us": 2300000,
                  "description": "face turns toward camera",
                  "confidence": 0.83,
                  "source_pass": "temporal",
                  "chunk_index": 1
                }
                """)
            ],
            marlinFindResults: [
                try decodeFixture(MarlinFindResult.self, from: """
                {
                  "query": "stronger reaction bridge",
                  "span_start_us": 1600000,
                  "span_end_us": 2200000,
                  "format_ok": true,
                  "confidence": 0.79,
                  "raw": "tight reaction before the speaker resumes"
                }
                """)
            ],
            audioEvents: [
                try decodeFixture(AudioEvent.self, from: """
                {
                  "event_id": "AE_001",
                  "asset_id": "AST_001",
                  "type": "speech",
                  "start_us": 1200000,
                  "end_us": 2200000,
                  "label": "clean dialogue"
                }
                """)
            ],
            audioStoryNodes: [
                try decodeFixture(AudioStoryNode.self, from: """
                {
                  "node_id": "ASN_001",
                  "node_type": "beat",
                  "asset_id": "AST_001",
                  "start_us": 1200000,
                  "end_us": 2200000,
                  "text": "payoff turn",
                  "story_role": "reaction",
                  "refs": {
                    "transcript_ref": "tr_ast_001",
                    "speaker_ref": "host",
                    "audio_event_ref": "AE_001",
                    "bgm_ref": "BGM_A"
                  },
                  "confidence": {
                    "score": 0.82,
                    "source": "audio-story",
                    "status": "ok",
                    "label": "strong"
                  }
                }
                """)
            ],
            bgmSections: [
                try decodeFixture(BGMSection.self, from: """
                {
                  "id": "BGM_A",
                  "label": "chorus",
                  "start_sec": 1.0,
                  "end_sec": 3.5,
                  "energy": 0.82
                }
                """)
            ]
        )

        let prompt = TimelineAgentConsultationPrompt.make(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            timeline: timeline,
            intent: .explainCut,
            selectedClips: [selection],
            selectedTransition: nil,
            evidenceByClipID: ["clip-001": evidence]
        )

        XCTAssertTrue(prompt.contains("Segment interest points: reaction peak @1.800s confidence 0.91 marlin"))
        XCTAssertTrue(prompt.contains("Segment peak: 1.920s, confidence 0.88, fused peak 0.76, frame"))
        XCTAssertTrue(prompt.contains("Marlin temporal cues: face turns toward camera"))
        XCTAssertTrue(prompt.contains("Marlin find hits: stronger reaction bridge @1.600s-2.200s confidence 0.79 tight reaction before the speaker resumes"))
        XCTAssertTrue(prompt.contains("Audio cues: clean dialogue"))
        XCTAssertTrue(prompt.contains("Audio story cues: beat: reaction: payoff turn"))
        XCTAssertTrue(prompt.contains("BGM sections: chorus 1.000s-3.500s energy 0.82"))
        XCTAssertTrue(prompt.contains("PREVIEW, not applied"))
        XCTAssertTrue(prompt.contains("\"timeline_version\": \"1\""))
    }

    func testPromptCanAskAgentToShortenSelectedBeatAsPreviewOnly() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "Demo Edit",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: false,
            mediaFileCount: 2
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(timelineConsultationJSON.utf8))
        let first = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))
        let second = try XCTUnwrap(timeline.clipSelection(for: "clip-002"))

        let prompt = TimelineAgentConsultationPrompt.make(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            timeline: timeline,
            intent: .shortenBeat,
            selectedClips: [first, second],
            selectedTransition: nil
        )

        XCTAssertTrue(prompt.contains("make the selected beat shorter"))
        XCTAssertTrue(prompt.contains("rhythmic"))
        XCTAssertTrue(prompt.contains("without breaking continuity"))
        XCTAssertTrue(prompt.contains("PREVIEW operations"))
        XCTAssertTrue(prompt.contains("Optional structured patch"))
        XCTAssertTrue(prompt.contains("\"timeline_version\": \"1\""))
        XCTAssertTrue(prompt.contains("- Clip: clip-001"))
        XCTAssertTrue(prompt.contains("- Clip: clip-002"))
    }

    func testExplainCutPromptKeepsManualReadOnlyEditingLoop() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "Demo Edit",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: false,
            mediaFileCount: 2
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(timelineConsultationJSON.utf8))
        let selection = try XCTUnwrap(timeline.clipSelection(for: "clip-002"))

        let prompt = TimelineAgentConsultationPrompt.make(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            timeline: timeline,
            intent: .explainCut,
            selectedClips: [selection],
            selectedTransition: nil
        )

        XCTAssertTrue(prompt.contains("professional video editor in a manual timeline editing loop"))
        XCTAssertTrue(prompt.contains("Do not modify files or write artifacts"))
        XCTAssertTrue(prompt.contains("Task: Explain why the selected clip"))
        XCTAssertTrue(prompt.contains("PREVIEW operations"))
        XCTAssertTrue(prompt.contains("- Clip: clip-002"))
    }
}

private func decodeFixture<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private let timelineConsultationJSON = """
{
  "version": "1",
  "project_id": "demo",
  "sequence": {
    "name": "Demo",
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
            "clip_id": "clip-001",
            "segment_id": "SEG_001",
            "asset_id": "AST_001",
            "src_in_us": 1000000,
            "src_out_us": 3000000,
            "timeline_in_frame": 24,
            "timeline_duration_frames": 48,
            "role": "primary",
            "motivation": "speaker lands the setup"
          },
          {
            "clip_id": "clip-002",
            "segment_id": "SEG_002",
            "asset_id": "AST_002",
            "src_in_us": 3000000,
            "src_out_us": 5000000,
            "timeline_in_frame": 72,
            "timeline_duration_frames": 48,
            "role": "payoff",
            "motivation": "reaction pays off the setup"
          }
        ]
      }
    ],
    "audio": [],
    "overlay": [],
    "caption": []
  },
  "markers": [],
  "transitions": [
    {
      "transition_id": "TRN_V1_clip-001_clip-002",
      "from_clip_id": "clip-001",
      "to_clip_id": "clip-002",
      "track_id": "V1",
      "transition_type": "crossfade",
      "transition_frames": 12,
      "applied_skill_id": "crossfade"
    }
  ]
}
"""
