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
            reason: "add cutaway"
        )

        XCTAssertEqual(operation.changedClipID, "beat-01")
    }
}

private let allOperationFixtures: [ReviewPatchOperation] = [
    .replaceSegment(
        target_clip_id: "CLP_001",
        with_segment_id: "SEG_002",
        with_candidate_ref: "candidate:SEG_002:0:1000000",
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
        reason: "align beat"
    ),
    .insertSegment(
        beat_id: "beat-01",
        segment_id: "SEG_004",
        role: "support",
        new_timeline_in_frame: 72,
        new_duration_frames: 24,
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
