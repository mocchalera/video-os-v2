import XCTest
@testable import VideoOSStudioCore

final class ProjectEditorAnnotationProposalTests: XCTestCase {
    func testExtractParsesPlainOrFencedJSONForExpectedClip() {
        let plain = #"{"clip_id":"clip-001","note":"Use this as the emotional button.","handoff_instruction":"Hold through the final blink before cutting."}"#
        let parsed = ProjectEditorAnnotationProposal.extract(from: plain, expectedClipID: "clip-001")
        XCTAssertEqual(parsed?.note, "Use this as the emotional button.")
        XCTAssertEqual(parsed?.handoffInstruction, "Hold through the final blink before cutting.")

        let fenced = """
        Here is the proposal:
        ```json
        {"clip_id":"clip-001","note":"Natural pause sells the thought.","handoff_instruction":"Keep the pause; do not cover with B-roll."}
        ```
        """
        XCTAssertEqual(ProjectEditorAnnotationProposal.extract(from: fenced, expectedClipID: "clip-001")?.note, "Natural pause sells the thought.")
    }

    func testExtractRejectsWrongClipOrEmptyFields() {
        let wrongClip = #"{"clip_id":"clip-999","note":"Use it.","handoff_instruction":"Use it."}"#
        XCTAssertNil(ProjectEditorAnnotationProposal.extract(from: wrongClip, expectedClipID: "clip-001"))

        let empty = #"{"clip_id":"clip-001","note":" ","handoff_instruction":"Use it."}"#
        XCTAssertNil(ProjectEditorAnnotationProposal.extract(from: empty, expectedClipID: "clip-001"))
    }

    func testPromptIncludesClipAndEvidenceWithoutAllowingWrites() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "compiled",
            hasTimeline: true,
            hasReview: false,
            mediaFileCount: 1
        )
        let timeline = try JSONDecoder().decode(TimelineDocument.self, from: Data(annotationProposalTimelineJSON.utf8))
        let selection = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))
        let prompt = ProjectEditorAnnotationProposalPrompt.make(
            project: project,
            selection: selection,
            timeline: timeline,
            evidence: nil,
            existingNote: nil
        )

        XCTAssertTrue(prompt.contains("Do not modify files"))
        XCTAssertTrue(prompt.contains(#"{"clip_id":"...","note":"...","handoff_instruction":"..."}"#))
        XCTAssertTrue(prompt.contains("Clip: clip-001"))
        XCTAssertTrue(prompt.contains("Timeline: 00:00:01:00-00:00:03:00"))
    }
}

private let annotationProposalTimelineJSON = """
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
            "motivation": "speaker lands the key idea"
          }
        ]
      }
    ],
    "audio": [],
    "overlay": [],
    "caption": []
  },
  "markers": []
}
"""
