import XCTest
@testable import VideoOSStudioCore

final class CaptionReviewDocumentTests: XCTestCase {
    func testLegacyQueueWithoutCaptionStyleUsesBackwardCompatibleDefault() throws {
        let json = """
        {
          "version": "caption-review-queue/v1",
          "project": "/tmp/project",
          "fps": 24,
          "can_undo": false,
          "total_caption_count": 0,
          "matched_caption_count": 0,
          "exported_caption_count": 0,
          "items": []
        }
        """

        let document = try JSONDecoder().decode(
            CaptionReviewQueueDocument.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(document.captionStyle, .default)
    }

    func testDecodesSharedCLIQueueContractAndSummaries() throws {
        let json = """
        {
          "version": "caption-review-queue/v1",
          "project": "/tmp/project",
          "fps": 24,
          "caption_style": {
            "preset_id": "longform-event",
            "font_family": "Hiragino Sans",
            "font_weight": 700,
            "font_size_px_1080": 56,
            "line_height_px_1080": 70,
            "outline_px_1080": 4,
            "margin_v_1080": 48,
            "max_width_ratio": 0.9,
            "alignment": "bottom_center"
          },
          "can_undo": true,
          "undo_depth": 3,
          "glossary_proposals": [
            {
              "canonical": "Tomy",
              "variants": ["富井"],
              "source_caption_ids": ["SC_001"]
            }
          ],
          "total_caption_count": 3,
          "matched_caption_count": 3,
          "exported_caption_count": 3,
          "items": [
            {
              "caption_id": "SC_001",
              "timeline_in_frame": 24,
              "timeline_duration_frames": 48,
              "text": "聞きたいことが\\nあります",
              "text_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "review_state": "unreviewed",
              "risk_score": 100,
              "issues": [
                {
                  "code": "unnatural_line_break",
                  "severity": "block",
                  "message": "日本語の語境界を確認してください"
                }
              ]
            },
            {
              "caption_id": "SC_002",
              "timeline_in_frame": 72,
              "timeline_duration_frames": 48,
              "text": "確認済みです",
              "text_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "review_state": "verified",
              "risk_score": 0,
              "issues": []
            },
            {
              "caption_id": "SC_003",
              "timeline_in_frame": 120,
              "timeline_duration_frames": 48,
              "text": "タイミングを確認",
              "text_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              "review_state": "flagged",
              "risk_score": 120,
              "issues": [
                {
                  "code": "timing_fallback",
                  "severity": "warn",
                  "message": "word timing fallback"
                }
              ]
            }
          ]
        }
        """

        let document = try JSONDecoder().decode(
            CaptionReviewQueueDocument.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(document.items.count, 3)
        XCTAssertEqual(document.fps, 24)
        XCTAssertEqual(document.captionStyle.presetID, "longform-event")
        XCTAssertEqual(document.captionStyle.fontSizePx1080, 56)
        XCTAssertTrue(document.canUndo)
        XCTAssertEqual(document.undoDepth, 3)
        XCTAssertEqual(document.glossaryProposals.first?.canonical, "Tomy")
        XCTAssertEqual(document.glossaryProposals.first?.variants, ["富井"])
        XCTAssertEqual(document.blockingCount, 1)
        XCTAssertEqual(document.warningCount, 1)
        XCTAssertEqual(document.verifiedCount, 1)
        XCTAssertEqual(document.flaggedCount, 1)
        XCTAssertEqual(document.items[0].text, "聞きたいことが\nあります")
        XCTAssertTrue(document.items[0].hasBlockingIssue)
    }

    func testStudioRunnerUsesTheSharedCaptionReviewCLIForQueueAndEdit() {
        let projectURL = URL(fileURLWithPath: "/tmp/video project")

        XCTAssertEqual(CaptionReviewRunner.queueArguments(projectURL: projectURL), [
            "npx", "tsx", "scripts/caption-review.ts", "queue",
            "--project", "/tmp/video project",
            "--format", "json",
            "--severity", "all",
        ])
        XCTAssertEqual(CaptionReviewRunner.editArguments(
            projectURL: projectURL,
            captionID: "SC_001",
            text: "修正後\n二行目",
            startFrame: 24,
            endFrame: 72,
            expectedTextHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            state: .verified
        ), [
            "npx", "tsx", "scripts/caption-review.ts", "edit",
            "--project", "/tmp/video project",
            "--caption-id", "SC_001",
            "--text", "修正後\n二行目",
            "--start-frame", "24",
            "--end-frame", "72",
            "--base-text-hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--state", "verified",
            "--category", "other",
        ])
    }

    func testRunnerRoutesSplitMergeAndUndoThroughSharedCLI() {
        let projectURL = URL(fileURLWithPath: "/tmp/project")
        let first = CaptionReviewQueueItem(
            captionID: "SC_001",
            timelineInFrame: 24,
            timelineDurationFrames: 48,
            text: "前半",
            textHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            reviewState: .unreviewed,
            riskScore: 0,
            issues: []
        )
        let second = CaptionReviewQueueItem(
            captionID: "SC_002",
            timelineInFrame: 72,
            timelineDurationFrames: 48,
            text: "後半",
            textHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            reviewState: .unreviewed,
            riskScore: 0,
            issues: []
        )

        XCTAssertEqual(CaptionReviewRunner.splitArguments(
            projectURL: projectURL,
            captionID: first.captionID,
            splitFrame: 48,
            expectedTextHash: first.textHash
        ).suffix(6), [
            "--caption-id", "SC_001",
            "--split-frame", "48",
            "--base-text-hash", first.textHash,
        ])
        XCTAssertEqual(CaptionReviewRunner.mergeArguments(
            projectURL: projectURL,
            first: first,
            second: second
        ).suffix(8), [
            "--caption-id", "SC_001",
            "--next-caption-id", "SC_002",
            "--base-text-hash", first.textHash,
            "--next-base-text-hash", second.textHash,
        ])
        XCTAssertEqual(CaptionReviewRunner.undoArguments(projectURL: projectURL).suffix(3), [
            "undo", "--project", "/tmp/project",
        ])
        XCTAssertEqual(CaptionReviewRunner.glossaryProposalArguments(
            projectURL: projectURL,
            captionID: "SC_001",
            canonical: "Tomy",
            variants: ["富井"]
        ).suffix(6), [
            "--caption-id", "SC_001",
            "--canonical", "Tomy",
            "--variant", "富井",
        ])
    }

    func testConflictPreservesLoadedCurrentAndWorkingVersions() {
        let loaded = CaptionReviewQueueItem(
            captionID: "SC_001",
            timelineInFrame: 24,
            timelineDurationFrames: 48,
            text: "読み込み時",
            textHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            reviewState: .unreviewed,
            riskScore: 0,
            issues: []
        )
        let current = CaptionReviewQueueItem(
            captionID: "SC_001",
            timelineInFrame: 25,
            timelineDurationFrames: 49,
            text: "現在版",
            textHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            reviewState: .unreviewed,
            riskScore: 0,
            issues: []
        )
        let conflict = CaptionReviewConflict(
            loaded: loaded,
            current: current,
            workingText: "作業案",
            workingStartFrame: 26,
            workingEndFrame: 76
        )

        XCTAssertEqual(conflict.loaded.text, "読み込み時")
        XCTAssertEqual(conflict.current.text, "現在版")
        XCTAssertEqual(conflict.workingText, "作業案")
        XCTAssertEqual(conflict.workingStartFrame, 26)
        XCTAssertEqual(conflict.workingEndFrame, 76)
    }

    func testApprovalArgumentsAlwaysCarryTheHumanReviewer() {
        let arguments = CaptionReviewRunner.approveArguments(
            projectURL: URL(fileURLWithPath: "/tmp/project"),
            reviewer: "Human Editor"
        )

        XCTAssertEqual(arguments.suffix(2), ["--reviewer", "Human Editor"])
    }
}
