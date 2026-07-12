import XCTest
@testable import VideoOSStudioCore

final class ReviewPatchDocumentTests: XCTestCase {
    func testRoundTripForAllOperationTypes() throws {
        for operation in allOperationFixtures {
            let document = ReviewPatchDocument(timeline_version: "42", operations: [operation])
            let data = try JSONEncoder().encode(document)
            let decoded = try JSONDecoder().decode(ReviewPatchDocument.self, from: data)

            XCTAssertEqual(decoded, document)
        }
    }

    func testOperationDiscriminatorUsesSnakeCaseOpField() throws {
        for operation in allOperationFixtures {
            let document = ReviewPatchDocument(timeline_version: "1", operations: [operation])
            let data = try JSONEncoder().encode(document)
            let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let operations = try XCTUnwrap(root["operations"] as? [[String: Any]])
            let first = try XCTUnwrap(operations.first)

            XCTAssertEqual(first["op"] as? String, operation.opName)
            XCTAssertFalse(first.keys.contains("frame"))
            XCTAssertFalse(first.keys.contains("kind"))
            XCTAssertFalse(first.keys.contains("text"))
        }
    }

    func testTimelineVersionIsPreserved() throws {
        let document = ReviewPatchDocument(
            timeline_version: "timeline-v9",
            operations: [.removeSegment(target_clip_id: "CLP_001", reason: "remove")]
        )

        let data = try JSONEncoder().encode(document)
        let decoded = try JSONDecoder().decode(ReviewPatchDocument.self, from: data)

        XCTAssertEqual(decoded.timeline_version, "timeline-v9")
    }

    func testJSONOutputUsesCompilerSchemaKeys() throws {
        let document = ReviewPatchDocument(timeline_version: "1", operations: allOperationFixtures)
        let data = try JSONEncoder().encode(document)

        assertCompilerPatchSchemaShape(data)
    }

    func testAddNoteIsNotValidForCompilerSchema() {
        XCTAssertFalse(ReviewPatchOperation.addNote(
            target_clip_id: "CLP_001",
            text: "operator note"
        ).isValidForCompilerSchema)
    }

    func testInsertSegmentChangedClipIDUsesBeatID() {
        let operation = ReviewPatchOperation.insertSegment(
            beat_id: "beat-01",
            segment_id: "SEG_004",
            role: "support",
            new_timeline_in_frame: 72,
            new_duration_frames: 24,
            target_track_id: nil,
            new_src_in_us: nil,
            new_src_out_us: nil,
            reason: "add cutaway"
        )

        XCTAssertEqual(operation.changedClipID, "beat-01")
    }

    func testMoveSegmentDurationFramesAreOptional() throws {
        let simpleMove = ReviewPatchOperation.moveSegment(
            target_clip_id: "CLP_SIMPLE",
            new_timeline_in_frame: 12,
            new_duration_frames: nil,
            target_track_id: nil,
            reason: "move only"
        )
        let durationMove = ReviewPatchOperation.moveSegment(
            target_clip_id: "CLP_DURATION",
            new_timeline_in_frame: 24,
            new_duration_frames: 36,
            target_track_id: "V2",
            reason: "move and retime"
        )
        let document = ReviewPatchDocument(timeline_version: "1", operations: [simpleMove, durationMove])
        let data = try JSONEncoder().encode(document)
        let decoded = try JSONDecoder().decode(ReviewPatchDocument.self, from: data)

        XCTAssertEqual(decoded, document)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let operations = try XCTUnwrap(root["operations"] as? [[String: Any]])
        XCTAssertNil(operations[0]["new_duration_frames"])
        XCTAssertNil(operations[0]["target_track_id"])
        XCTAssertEqual(operations[1]["new_duration_frames"] as? Int, 36)
        XCTAssertEqual(operations[1]["target_track_id"] as? String, "V2")
    }

    func testSplitSegmentUsesTimelineFrameKey() throws {
        let operation = ReviewPatchOperation.splitSegment(
            target_clip_id: "CLP_SPLIT",
            split_timeline_frame: 42,
            reason: "split at playhead"
        )
        let document = ReviewPatchDocument(timeline_version: "1", operations: [operation])
        let data = try JSONEncoder().encode(document)
        let decoded = try JSONDecoder().decode(ReviewPatchDocument.self, from: data)

        XCTAssertEqual(decoded, document)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let operations = try XCTUnwrap(root["operations"] as? [[String: Any]])
        XCTAssertEqual(operations.first?["op"] as? String, "split_segment")
        XCTAssertEqual(operations.first?["target_clip_id"] as? String, "CLP_SPLIT")
        XCTAssertEqual(operations.first?["new_timeline_in_frame"] as? Int, 42)
        XCTAssertNil(operations.first?["new_duration_frames"])
    }
}

private let allOperationFixtures: [ReviewPatchOperation] = [
    .replaceSegment(
        target_clip_id: "CLP_001",
        with_segment_id: "SEG_002",
        with_candidate_ref: "candidate:SEG_002:0:1000000",
        new_src_in_us: 100,
        new_src_out_us: 900,
        reason: "better visual"
    ),
    .trimSegment(
        target_clip_id: "CLP_002",
        new_src_in_us: 100,
        new_src_out_us: 2_000,
        reason: "remove handle"
    ),
    .moveSegment(
        target_clip_id: "CLP_003",
        new_timeline_in_frame: 48,
        new_duration_frames: 24,
        target_track_id: nil,
        reason: "align beat"
    ),
    .splitSegment(
        target_clip_id: "CLP_004",
        split_timeline_frame: 60,
        reason: "split at playhead"
    ),
    .setTransition(
        from_clip_id: "CLP_004",
        to_clip_id: "CLP_005",
        track_id: "V1",
        transition_type: "crossfade",
        transition_frames: 12,
        applied_skill_id: "ui.crossfade_bridge",
        reason: "soften edit"
    ),
    .insertSegment(
        beat_id: "beat-01",
        segment_id: "SEG_004",
        role: "support",
        new_timeline_in_frame: 72,
        new_duration_frames: 24,
        target_track_id: "V2",
        new_src_in_us: 100,
        new_src_out_us: 900,
        reason: "add cutaway"
    ),
    .removeSegment(
        target_clip_id: "CLP_005",
        reason: "duplicate"
    ),
    .changeAudioPolicy(
        target_clip_id: "CLP_006",
        audio_policy: [
            "duck_music_db": .double(-9.5),
            "preserve_nat_sound": .bool(true),
            "fade_in_frames": .int(6),
            "fade_out_frames": .int(12)
        ],
        reason: "protect dialogue"
    ),
    .addMarker(
        frame: 120,
        label: "review note",
        kind: "review"
    ),
    .addNote(
        target_clip_id: "CLP_007",
        text: "approved by operator"
    )
]
