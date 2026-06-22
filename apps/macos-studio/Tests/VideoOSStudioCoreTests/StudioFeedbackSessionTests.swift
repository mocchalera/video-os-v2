import XCTest
@testable import VideoOSStudioCore

@MainActor
final class StudioFeedbackSessionTests: XCTestCase {
    func testAddOpAppendsPendingOperation() {
        let session = StudioFeedbackSession()

        session.addOp(.removeSegment(target_clip_id: "CLP_001", reason: "Rejected by operator"))

        XCTAssertEqual(session.pendingOps.count, 1)
        XCTAssertTrue(session.isDirty)
    }

    func testAddOpDeduplicatesReplaceForSameClipKeepingLatest() {
        let session = StudioFeedbackSession()

        session.addOp(.replaceSegment(
            target_clip_id: "CLP_001",
            with_segment_id: "SEG_OLD",
            with_candidate_ref: "candidate:old",
            reason: "old"
        ))
        session.addOp(.replaceSegment(
            target_clip_id: "CLP_001",
            with_segment_id: "SEG_NEW",
            with_candidate_ref: "candidate:new",
            reason: "new"
        ))

        XCTAssertEqual(session.pendingOps.count, 1)
        guard case let .replaceSegment(_, segmentID, candidateRef, reason) = session.pendingOps[0] else {
            return XCTFail("Expected replace_segment")
        }
        XCTAssertEqual(segmentID, "SEG_NEW")
        XCTAssertEqual(candidateRef, "candidate:new")
        XCTAssertEqual(reason, "new")
    }

    func testDetectConflictsForRemoveAndReplaceOnSameClip() {
        let session = StudioFeedbackSession()

        session.addOp(.replaceSegment(
            target_clip_id: "CLP_001",
            with_segment_id: "SEG_NEW",
            with_candidate_ref: nil,
            reason: "swap"
        ))
        session.addOp(.removeSegment(target_clip_id: "CLP_001", reason: "remove"))

        let conflicts = session.detectConflicts()

        XCTAssertEqual(conflicts.count, 1)
        XCTAssertEqual(conflicts.first?.clipID, "CLP_001")
        XCTAssertEqual(conflicts.first?.operationIndices, [0, 1])
    }

    func testDetectConflictsForRemoveAndTrimOnSameClip() {
        let session = StudioFeedbackSession()

        session.addOp(.trimSegment(
            target_clip_id: "CLP_001",
            new_src_in_us: 10,
            new_src_out_us: 1_000,
            reason: "tighten"
        ))
        session.addOp(.removeSegment(target_clip_id: "CLP_001", reason: "remove"))

        let conflicts = session.detectConflicts()

        XCTAssertEqual(conflicts.count, 1)
        XCTAssertEqual(conflicts.first?.clipID, "CLP_001")
        XCTAssertEqual(conflicts.first?.operationIndices, [0, 1])
    }

    func testSerializeOmitsAddNoteFromCompilerPatchOperations() {
        let session = StudioFeedbackSession()

        session.addOp(.addNote(target_clip_id: "CLP_001", text: "operator note"))
        session.addOp(.removeSegment(target_clip_id: "CLP_002", reason: "remove"))

        let envelope = session.serialize(projectID: "demo")

        XCTAssertEqual(session.pendingOps.map(\.opName), ["add_note", "remove_segment"])
        XCTAssertEqual(envelope.patch.operations.map(\.opName), ["remove_segment"])
    }

    func testChangedClipIDsUseCompilerBoundTargetsAndInsertBeats() {
        let session = StudioFeedbackSession()

        session.addOp(.addNote(target_clip_id: "CLP_NOTE", text: "operator note"))
        session.addOp(.addMarker(frame: 12, label: "beat", kind: "note"))
        session.addOp(.insertSegment(
            beat_id: "b02",
            segment_id: "SEG_INSERT",
            role: "support",
            new_timeline_in_frame: 90,
            new_duration_frames: 30,
            reason: "insert"
        ))
        session.addOp(.trimSegment(
            target_clip_id: "CLP_002",
            new_src_in_us: 10,
            new_src_out_us: 1_000,
            reason: "tighten"
        ))
        session.addOp(.replaceSegment(
            target_clip_id: "CLP_001",
            with_segment_id: "SEG_NEW",
            with_candidate_ref: "candidate:new",
            reason: "swap"
        ))
        session.addOp(.removeSegment(target_clip_id: "CLP_002", reason: "remove"))

        XCTAssertEqual(session.changedClipIDs, ["CLP_001", "CLP_002", "b02"])
    }

    func testSerializeProducesCompilerSchemaShape() throws {
        let session = StudioFeedbackSession()
        session.addOp(.trimSegment(
            target_clip_id: "CLP_001",
            new_src_in_us: 10,
            new_src_out_us: 1_000,
            reason: "tighten"
        ))

        let envelope = session.serialize(projectID: "demo")
        let data = try JSONEncoder().encode(envelope.patch)

        assertCompilerPatchSchemaShape(data)
        let decoded = try JSONDecoder().decode(ReviewPatchDocument.self, from: data)
        XCTAssertEqual(decoded.timeline_version, "1")
        XCTAssertEqual(decoded.operations, envelope.patch.operations)
    }

    func testCaptureBaselineStoresHashAndVersion() throws {
        let projectURL = try temporaryProject(withTimeline: studioFeedbackTimelineJSON)
        let timeline = try TimelineDocument.load(projectURL: projectURL)
        let expectedHash = ProjectPlaybackContractStatusReader.fileHash16(Data(studioFeedbackTimelineJSON.utf8))
        let session = StudioFeedbackSession()

        session.captureBaseline(from: timeline)

        XCTAssertEqual(session.baseTimelineHash, expectedHash)
        XCTAssertEqual(session.baseTimelineVersion, "7")
    }

    func testClearAllClearsDirtyState() {
        let session = StudioFeedbackSession()
        session.addOp(.removeSegment(target_clip_id: "CLP_001", reason: "remove"))
        session.approvedClipIDs.insert("CLP_002")
        session.rejectedClipIDs.insert("CLP_001")

        session.clearAll()

        XCTAssertFalse(session.isDirty)
        XCTAssertTrue(session.pendingOps.isEmpty)
        XCTAssertTrue(session.approvedClipIDs.isEmpty)
        XCTAssertTrue(session.rejectedClipIDs.isEmpty)
    }
}

func assertCompilerPatchSchemaShape(
    _ data: Data,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let allowedTopLevelKeys: Set<String> = ["timeline_version", "operations"]
    let allowedOperationKeys: Set<String> = [
        "op",
        "target_clip_id",
        "with_segment_id",
        "new_src_in_us",
        "new_src_out_us",
        "new_timeline_in_frame",
        "new_duration_frames",
        "reason",
        "confidence",
        "evidence",
        "audio_policy",
        "beat_id",
        "role",
        "label",
        "with_candidate_ref"
    ]
    let allowedOps: Set<String> = [
        "replace_segment",
        "trim_segment",
        "move_segment",
        "insert_segment",
        "remove_segment",
        "change_audio_policy",
        "add_marker",
        "add_note"
    ]

    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return XCTFail("Patch JSON is not an object", file: file, line: line)
    }
    XCTAssertEqual(Set(root.keys), allowedTopLevelKeys, file: file, line: line)
    XCTAssertNotNil(root["timeline_version"] as? String, file: file, line: line)
    guard let operations = root["operations"] as? [[String: Any]] else {
        return XCTFail("operations is not an array of objects", file: file, line: line)
    }

    for operation in operations {
        XCTAssertTrue(Set(operation.keys).isSubset(of: allowedOperationKeys), file: file, line: line)
        guard let op = operation["op"] as? String else {
            return XCTFail("operation missing op", file: file, line: line)
        }
        XCTAssertTrue(allowedOps.contains(op), file: file, line: line)
        XCTAssertNotNil(operation["reason"] as? String, file: file, line: line)
    }
}

func temporaryProject(withTimeline timelineJSON: String) throws -> URL {
    let projectURL = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-studio-feedback-\(UUID().uuidString)")
    let timelineDir = projectURL.appendingPathComponent("05_timeline")
    try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
    try timelineJSON.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
    return projectURL
}

let studioFeedbackTimelineJSON = """
{
  "version": "7",
  "project_id": "demo",
  "sequence": {
    "name": "Demo",
    "fps_num": 30,
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
            "clip_id": "CLP_001",
            "segment_id": "SEG_001",
            "asset_id": "AST_001",
            "src_in_us": 0,
            "src_out_us": 1000000,
            "timeline_in_frame": 0,
            "timeline_duration_frames": 30,
            "role": "hero",
            "motivation": "fixture"
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
