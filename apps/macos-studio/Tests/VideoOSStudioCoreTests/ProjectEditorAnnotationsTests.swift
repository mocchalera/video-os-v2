import XCTest
@testable import VideoOSStudioCore

final class ProjectEditorAnnotationsTests: XCTestCase {
    func testUpsertNoteCreatesHandoffAnnotationForTimelineClip() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-editor-annotations-\(UUID().uuidString)")
        try writeAnnotationFixtureProject(at: project)
        let date = ISO8601DateFormatter().date(from: "2026-05-22T00:00:00Z")!

        let document = try ProjectEditorAnnotationStore.upsertNote(
            projectURL: project,
            clipID: "clip-001",
            note: "Hold this shot two frames longer.",
            handoffInstruction: "Editor: extend by two frames if music hit allows.",
            updatedAt: date
        )

        XCTAssertEqual(document.projectID, "demo")
        XCTAssertEqual(document.notes.count, 1)
        let note = try XCTUnwrap(document.note(for: "clip-001"))
        XCTAssertEqual(note.trackID, "V1")
        XCTAssertEqual(note.trackKind, "video")
        XCTAssertEqual(note.assetID, "AST_001")
        XCTAssertEqual(note.segmentID, "SEG_001")
        XCTAssertEqual(note.timelineInFrame, 24)
        XCTAssertEqual(note.timelineOutFrame, 72)
        XCTAssertEqual(note.timecodeIn, "00:00:01:00")
        XCTAssertEqual(note.timecodeOut, "00:00:03:00")
        XCTAssertEqual(note.handoffInstruction, "Editor: extend by two frames if music hit allows.")

        let reloaded = try XCTUnwrap(ProjectEditorAnnotationStore.load(projectURL: project))
        XCTAssertEqual(reloaded.notes.first?.note, "Hold this shot two frames longer.")
        XCTAssertEqual(ProjectEditorAnnotationStore.summary(projectURL: project, timeline: try TimelineDocument.load(projectURL: project)).statusLabel, "1 clip notes")
    }

    func testUpsertRejectsUnknownClipAndEmptyNote() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-editor-annotations-errors-\(UUID().uuidString)")
        try writeAnnotationFixtureProject(at: project)

        XCTAssertThrowsError(try ProjectEditorAnnotationStore.upsertNote(projectURL: project, clipID: "missing", note: "Fix")) { error in
            XCTAssertEqual(error as? ProjectEditorAnnotationError, .clipNotFound("missing"))
        }
        XCTAssertThrowsError(try ProjectEditorAnnotationStore.upsertNote(projectURL: project, clipID: "clip-001", note: "   ")) { error in
            XCTAssertEqual(error as? ProjectEditorAnnotationError, .emptyNote)
        }
    }
}

private func writeAnnotationFixtureProject(at project: URL) throws {
    let timelineDir = project.appendingPathComponent("05_timeline")
    try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
    try """
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
    """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
}
