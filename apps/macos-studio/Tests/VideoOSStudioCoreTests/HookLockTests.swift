import XCTest
@testable import VideoOSStudioCore

@MainActor
final class HookLockTests: XCTestCase {
    func testTimelineDecodesCanonicalHookLockProvenance() throws {
        let document = try JSONDecoder().decode(
            TimelineDocument.self,
            from: Data(canonicalTimelineJSON.utf8)
        )

        XCTAssertEqual(document.hookLock?.policy, "hook-lock/v1")
        XCTAssertEqual(document.hookLock?.displayLabel, "Hook locked")
        XCTAssertEqual(document.hookLock?.protectedClipIDs, ["HOOK_CLIP"])
        XCTAssertEqual(document.hookLock?.protectedBeatIDs, ["hook-beat"])
    }

    func testStudioPatchPathRejectsHookButAllowsBodyMarkerAndNoteEdits() {
        let timeline = makeTimeline()
        let session = StudioFeedbackSession()
        session.captureBaseline(from: timeline)

        XCTAssertFalse(session.addOp(.trimSegment(
            target_clip_id: "HOOK_CLIP",
            new_src_in_us: 100_000,
            new_src_out_us: 900_000,
            reason: "tighten Hook"
        )))
        XCTAssertTrue(session.pendingOps.isEmpty)
        XCTAssertTrue(session.hookLockRejectionReason?.contains("Hook is locked") == true)

        XCTAssertFalse(session.addOp(.trimSegment(
            target_clip_id: "A1_HOOK_COMPANION",
            new_src_in_us: 100_000,
            new_src_out_us: 900_000,
            reason: "trim A1 companion"
        )))
        XCTAssertFalse(session.addOp(.removeSegment(
            target_clip_id: "A1_HOOK_COMPANION",
            reason: "remove A1 companion"
        )))

        XCTAssertTrue(session.addOp(.moveSegment(
            target_clip_id: "BODY_CLIP",
            new_timeline_in_frame: 45,
            new_duration_frames: nil,
            target_track_id: nil,
            reason: "tighten body"
        )))
        XCTAssertTrue(session.addOp(.addMarker(frame: 12, label: "body note", kind: "note")))
        XCTAssertTrue(session.addOp(.addNote(target_clip_id: "HOOK_CLIP", text: "keep the Hook")))
        XCTAssertEqual(session.pendingOps.map(\.opName), ["move_segment", "add_marker", "add_note"])
    }

    func testTimelineMutationGuardRejectsProtectedClipButPreservesBodyEdit() throws {
        let timeline = makeTimeline()
        let hookEdit = try XCTUnwrap(timeline.movingClip("HOOK_CLIP", toTimelineInFrame: 2))
        let bodyEdit = try XCTUnwrap(timeline.movingClip("BODY_CLIP", toTimelineInFrame: 50))

        XCTAssertNotNil(timeline.hookLockRejection(to: hookEdit))
        XCTAssertNil(timeline.hookLockRejection(to: bodyEdit))
        XCTAssertEqual(bodyEdit.hookLock?.fingerprint, timeline.hookLock?.fingerprint)
    }

    func testA1CompanionTrimAndRemovalAreRejectedByTimelineGuard() throws {
        let timeline = makeTimeline()
        let trimmed = try XCTUnwrap(timeline.trimmingClip(
            "A1_HOOK_COMPANION",
            sourceInUS: 100_000,
            sourceOutUS: 900_000
        ))
        XCTAssertNotNil(timeline.hookLockRejection(to: trimmed))

        let removed = try XCTUnwrap(timeline.removingClips(["A1_HOOK_COMPANION"]))
        XCTAssertNotNil(timeline.hookLockRejection(to: removed))
    }

    func testAuthoritativeLockProjectionCannotBeChangedWithSameFingerprint() throws {
        let timeline = makeTimeline()
        let changedLock = TimelineHookLock(
            sequenceID: "main",
            lockRevision: 9,
            fingerprint: "hook-fingerprint",
            anchorIDs: ["hook-anchor"],
            protectedClipIDs: ["HOOK_CLIP"],
            protectedBeatIDs: ["hook-beat"],
            reason: "explicit_blueprint_lock"
        )
        let changed = TimelineDocument(
            version: timeline.version,
            projectID: timeline.projectID,
            sequence: timeline.sequence,
            tracks: timeline.tracks,
            markers: timeline.markers,
            transitions: timeline.transitions,
            sourceHash: timeline.sourceHash,
            hookLock: changedLock
        )

        XCTAssertTrue(timeline.hookLockRejection(to: changed)?.contains("authoritative") == true)
    }

    func testMixedHookBodyBatchIsRejectedBeforePendingOpsOrDisplayedTimelineChange() {
        let timeline = makeTimeline()
        let session = StudioFeedbackSession()
        var displayedTimeline = timeline
        let mixed: [ReviewPatchOperation] = [
            .trimSegment(
                target_clip_id: "HOOK_CLIP",
                new_src_in_us: 100_000,
                new_src_out_us: 900_000,
                reason: "mixed Hook edit"
            ),
            .moveSegment(
                target_clip_id: "BODY_CLIP",
                new_timeline_in_frame: 45,
                new_duration_frames: nil,
                target_track_id: nil,
                reason: "mixed Body edit"
            ),
        ]

        XCTAssertFalse(session.addOps(mixed, against: timeline))
        XCTAssertTrue(session.pendingOps.isEmpty)
        XCTAssertEqual(displayedTimeline, timeline)

        if session.addOps([.moveSegment(
            target_clip_id: "BODY_CLIP",
            new_timeline_in_frame: 45,
            new_duration_frames: nil,
            target_track_id: nil,
            reason: "body-only edit"
        )], against: timeline) {
            displayedTimeline = timeline.movingClip("BODY_CLIP", toTimelineInFrame: 45)!
        }
        XCTAssertEqual(
            displayedTimeline.displayTracks.flatMap(\.clips).first(where: { $0.id == "BODY_CLIP" })?.timelineInFrame,
            45
        )
        XCTAssertEqual(session.pendingOps.map(\.targetClipID), ["BODY_CLIP"])
    }

    func testInsertOverlappingHookOrHookBeatIsRejected() {
        let timeline = makeTimeline()

        let overlap = timeline.hookLockRejection(for: .insertSegment(
            beat_id: "body-beat",
            segment_id: "BODY_NEW",
            role: "support",
            new_timeline_in_frame: 15,
            new_duration_frames: 20,
            target_track_id: "V1",
            new_src_in_us: 0,
            new_src_out_us: 1_000_000,
            reason: "insert body"
        ))
        let protectedBeat = timeline.hookLockRejection(for: .insertSegment(
            beat_id: "hook-beat",
            segment_id: "HOOK_NEW",
            role: "support",
            new_timeline_in_frame: 100,
            new_duration_frames: 10,
            target_track_id: "V1",
            new_src_in_us: 0,
            new_src_out_us: 500_000,
            reason: "insert Hook"
        ))

        XCTAssertNotNil(overlap)
        XCTAssertNotNil(protectedBeat)
    }

    private func makeTimeline() -> TimelineDocument {
        let lock = TimelineHookLock(
            sequenceID: "main",
            fingerprint: "hook-fingerprint",
            anchorIDs: ["hook-anchor"],
            protectedClipIDs: ["A1_HOOK_COMPANION", "HOOK_CLIP"],
            protectedBeatIDs: ["hook-beat"],
            reason: "explicit_blueprint_lock"
        )
        let sequence = TimelineSequence(
            name: "Hook lock test",
            fpsNum: 30,
            fpsDen: 1,
            width: 1_920,
            height: 1_080,
            startFrame: 0,
            outputAspectRatio: "16:9"
        )
        let hook = TimelineClip(
            id: "HOOK_CLIP",
            segmentID: "HOOK_SEG",
            assetID: "AST_HOOK",
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            timelineInFrame: 0,
            timelineDurationFrames: 30,
            role: "hero",
            motivation: "Hook",
            confidence: 1,
            beatID: "hook-beat",
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: "candidate:hook"
        )
        let body = TimelineClip(
            id: "BODY_CLIP",
            segmentID: "BODY_SEG",
            assetID: "AST_BODY",
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            timelineInFrame: 30,
            timelineDurationFrames: 30,
            role: "support",
            motivation: "Body",
            confidence: 0.8,
            beatID: "body-beat",
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: "candidate:body"
        )
        let a1Companion = TimelineClip(
            id: "A1_HOOK_COMPANION",
            segmentID: "HOOK_SEG",
            assetID: "AST_HOOK",
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            timelineInFrame: 0,
            timelineDurationFrames: 30,
            role: "dialogue",
            motivation: "A1 companion",
            confidence: 1,
            beatID: "hook-beat",
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: "candidate:hook"
        )
        return TimelineDocument(
            version: "2",
            projectID: "hook-lock-test",
            sequence: sequence,
            tracks: TimelineTrackCollection(
                video: [TimelineTrack(id: "V1", kind: .video, clips: [hook, body])],
                audio: [TimelineTrack(id: "A1", kind: .audio, clips: [a1Companion])],
                overlay: [],
                caption: []
            ),
            markers: [],
            hookLock: lock
        )
    }

    private let canonicalTimelineJSON = """
    {
      "version": "2",
      "project_id": "hook-lock-test",
      "sequence": {
        "name": "Hook lock test",
        "fps_num": 30,
        "fps_den": 1,
        "width": 1920,
        "height": 1080,
        "start_frame": 0,
        "output_aspect_ratio": "16:9"
      },
      "tracks": {
        "video": [{
          "track_id": "V1",
          "kind": "video",
          "clips": [{
            "clip_id": "HOOK_CLIP",
            "segment_id": "HOOK_SEG",
            "asset_id": "AST_HOOK",
            "src_in_us": 0,
            "src_out_us": 1000000,
            "timeline_in_frame": 0,
            "timeline_duration_frames": 30,
            "role": "hero",
            "motivation": "Hook",
            "beat_id": "hook-beat"
          }]
        }],
        "audio": [],
        "overlay": [],
        "caption": []
      },
      "markers": [],
      "transitions": [],
      "provenance": {
        "hook_lock": {
          "policy": "hook-lock/v1",
          "locked": true,
          "sequence_id": "main",
          "lock_revision": 0,
          "fingerprint": "hook-fingerprint",
          "anchor_ids": ["hook-anchor"],
          "protected_clip_ids": ["HOOK_CLIP"],
          "protected_beat_ids": ["hook-beat"],
          "reason": "explicit_blueprint_lock"
        }
      }
    }
    """
}
