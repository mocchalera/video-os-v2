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
        XCTAssertEqual(document.captionStyle.fontID, "noto-sans-jp")
        XCTAssertEqual(document.captionStyle.fontFamily, "VideoOS Noto Sans JP Bold")
        XCTAssertEqual(document.captionStyle.fontWeight, 700)
    }

    func testCleanLowerThirdUsesVerifiedHeavyFamilyAndNumericPreviewWeight() throws {
        let json = """
        {
          "version": "caption-review-queue/v2",
          "project": "/tmp/project",
          "status": "ready",
          "base_caption_draft_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "fps": 24,
          "caption_style": {
            "preset_id": "clean-lower-third",
            "font_id": "noto-sans-jp",
            "font_family": "VideoOS Noto Sans JP Black",
            "font_weight": 900,
            "font_size_px_1080": 60,
            "line_height_px_1080": 74,
            "outline_px_1080": 3,
            "margin_v_1080": 36,
            "max_width_ratio": 0.9,
            "alignment": "bottom_center"
          },
          "font_contract": {
            "status": "ready",
            "font_id": "noto-sans-jp",
            "family": "VideoOS Noto Sans JP Black",
            "fallback_used": false,
            "diagnostics": []
          },
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

        XCTAssertEqual(document.captionStyle.fontFamily, "VideoOS Noto Sans JP Black")
        XCTAssertEqual(document.captionStyle.fontWeight, 900)
        XCTAssertEqual(document.captionStyle.previewFontWeight, .black)
        XCTAssertEqual(CaptionReviewPreviewStyle.previewFontWeight(for: 800), .heavy)
        XCTAssertEqual(CaptionReviewPreviewStyle.previewFontWeight(for: 700), .bold)
    }

    func testUnregisteredHeavyFamilyFailsClosedInsteadOfUsingSystemFallback() {
        let status = CaptionFontRuntimeStatus(assets: [
            .init(
                role: "primary",
                family: "Noto Sans JP",
                resource: "NotoSansJP-Variable",
                state: .ready
            ),
            .init(
                role: "heavy",
                family: "VideoOS Noto Sans JP Black",
                resource: "VideoOSNotoSansJPBlack",
                state: .blocked,
                diagnostic: "missing_resource: VideoOSNotoSansJPBlack.ttf"
            ),
        ])

        XCTAssertFalse(status.canRenderCustomFont(family: "VideoOS Noto Sans JP Black"))
        XCTAssertEqual(status.blocker(requiredFamily: "VideoOS Noto Sans JP Black")?.code, "font_contract_mismatch")
        XCTAssertTrue(status.blocker(requiredFamily: "VideoOS Noto Sans JP Black")?.message.contains("missing_resource") == true)
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
        XCTAssertEqual(document.captionStyle.fontID, "noto-sans-jp")
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

    func testQueueV2RestoresApprovalAndOperationalControlsAfterReload() throws {
        let hash = "sha256:" + String(repeating: "a", count: 64)
        let json = """
        {
          "version":"caption-review-queue/v2","project":"/tmp/project","status":"ready","fps":24,
          "base_caption_draft_hash":"\(hash)","can_undo":false,"undo_depth":0,
          "approval_readiness":{"can_approve":true,"blockers":[],"warning_issue_count":1,"warnings_acknowledged":true},
          "safe_bulk_review":{"eligible_caption_ids":[],"eligible_count":0,"excluded":[],"exclusion_reason_counts":{}},
          "font_contract":{"status":"ready","font_id":"noto-sans-jp","family":"Noto Sans JP","fallback_used":false,"diagnostics":[]},
          "current_approval":{"status":"approved","hash":"\(hash)"},
          "total_caption_count":0,"matched_caption_count":0,"exported_caption_count":0,"items":[]
        }
        """
        let document = try JSONDecoder().decode(CaptionReviewQueueDocument.self, from: Data(json.utf8))
        XCTAssertTrue(document.approvalReadiness.canApprove)
        XCTAssertEqual(document.currentApproval?.status, "approved")
        XCTAssertEqual(document.currentApproval?.hash, hash)
        XCTAssertEqual(document.fontContract?.fallbackUsed, false)
    }

    func testFinalizeArgumentsAndSuccessPayloadUseExplicitCLIContract() {
        let projectURL = URL(fileURLWithPath: "/tmp/video project")
        XCTAssertEqual(CaptionReviewRunner.finalizeArguments(projectURL: projectURL), [
            "npx", "tsx", "scripts/caption-finalize.ts", "run",
            "--project", "/tmp/video project", "--json",
        ])
        let result = CaptionReviewRunner.decodeSuccessPayload("""
        {"generation_id":"gen-123","active_delivery":{"artifacts":{"final_video":{"path":"07_package/generations/gen-123/video/final.mp4"}}}}
        """, successMessage: "done")
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.generationID, "gen-123")
        XCTAssertEqual(result.finalPath, "07_package/generations/gen-123/video/final.mp4")
    }

    func testReviewerReadinessRefreshDoesNotRequireEnter() {
        XCTAssertTrue(CaptionReviewerRefreshPolicy.shouldRefresh(from: "", to: "Editor"))
        XCTAssertFalse(CaptionReviewerRefreshPolicy.shouldRefresh(from: "Editor", to: " Editor "))
        XCTAssertLessThan(CaptionReviewerRefreshPolicy.delayNanoseconds, 1_000_000_000)
    }

    func testPreviewTransportPreservesPlayLoopAndRejectsStaleReselectCompletion() {
        var transport = CaptionPreviewTransportState()
        let first = transport.reselect(loopStart: 1, loopEnd: 3)
        transport.itemBecameReady(generation: first)
        XCTAssertEqual(transport.readiness, .loading)
        transport.initialSeekCompleted(generation: first, success: true)
        transport.play()
        XCTAssertTrue(transport.isPlaying)
        XCTAssertTrue(transport.tick(3.1))
        XCTAssertEqual(transport.currentSeconds, 1)

        let second = transport.reselect(loopStart: 5, loopEnd: 7)
        transport.initialSeekCompleted(generation: first, success: false)
        XCTAssertEqual(transport.readiness, .loading)
        transport.itemBecameReady(generation: second)
        XCTAssertEqual(transport.readiness, .loading)
        transport.initialSeekCompleted(generation: second, success: true)
        XCTAssertEqual(transport.readiness, .ready)
        XCTAssertEqual(transport.currentSeconds, 5)
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

    func testVisualReviewResponseDecodesCanonicalPatchInputCapabilitiesAndIdentity() throws {
        let hash = "sha256:" + String(repeating: "a", count: 64)
        let json = """
        {
          "command":"visual-status",
          "patch_path":"07_package/caption_visual_treatment_patch.json",
          "input_path":"07_package/caption_visual_treatment_input.json",
          "patch_hash":"(hash)",
          "input_hash":"(hash)",
          "status":"ready",
          "applied_caption_ids":["SC_001"],
          "degraded_reasons":[],
          "blocked_reasons":[],
          "patch":{
            "version":"caption-visual-treatment-patch/v1",
            "project_id":"demo",
            "base_caption_draft_hash":"(hash)",
            "base_timeline_hash":"(hash)",
            "typography_policy_hash":"(hash)",
            "caption_approval_hash":"(hash)",
            "operations":[{
              "caption_id":"SC_001",
              "stable_root_id":"SC_001",
              "expected_current_hash":"(hash)",
              "anchor":"bottom_center",
              "rect":{"x":0.1,"y":0.75,"width":0.8,"height":0.12},
              "style_ref":"clean-editorial",
              "reference_scale":1.25,
              "hierarchy_role":"speech",
              "fallback":"registered_fallback"
            }],
            "session":{"reviewer":"Human Editor","updated_at":"2026-08-21T00:00:00Z","action_operation_counts":[1]}
          },
          "input":{
            "version":"caption-visual-treatment-input/v1",
            "project_id":"demo",
            "approval_hash":"(hash)",
            "typography_policy_hash":"(hash)",
            "visual_treatment_patch_hash":"(hash)",
            "caption_identity":[{
              "caption_id":"SC_001",
              "stable_root_id":"SC_001",
              "text":"テスト字幕",
              "timeline_in_frame":24,
              "timeline_duration_frames":48,
              "treatment":{
                "caption_id":"SC_001",
                "stable_root_id":"SC_001",
                "expected_current_hash":"(hash)",
                "anchor":"bottom_center",
                "rect":{"x":0.1,"y":0.75,"width":0.8,"height":0.12},
                "style_ref":"clean-editorial",
                "reference_scale":1.25,
                "hierarchy_role":"speech",
                "fallback":"registered_fallback"
              }
            }],
            "resolved_projection":[{
              "caption_id":"SC_001",
              "stable_root_id":"SC_001",
              "style_ref":"clean-editorial",
              "font_family":"VideoOS Heavy",
              "font_weight":900,
              "font_size_px_1080":60,
              "line_height_px_1080":74,
              "fill_rgba":"FFFFFFFF",
              "outline_rgba":"000000FF",
              "outline_px_1080":3,
              "shadow_px_1080":0,
              "max_width_ratio":0.9,
              "alignment":"bottom_center",
              "emphasis_scale":1,
              "effect_supported":true,
              "animation_supported":true,
              "outline_enabled":true,
              "shadow_enabled":false,
              "panel_enabled":false
            }],
            "graphical_content_identity":[],
            "status":"ready",
            "fallbacks":[],
            "renderer_route":{"speech_captions":"ffmpeg-libass","graphical_content":{"available":["remotion"],"selected":"not_selected","status":"deferred_to_next_milestone"}},
            "text_timing_hash":"(hash)",
            "capability_hash":"(hash)",
            "applied_caption_ids":["SC_001"],
            "degraded_reasons":[],
            "blocked_reasons":[],
            "input_hash":"(hash)"
          },
          "capabilities":{"style_refs":["clean-editorial"],"emphasis_refs":[],"animation_refs":[],"effect_refs":[],"hierarchy_roles":["speech"]},
          "safe_zone_profile":null
        }
        """.replacingOccurrences(of: "(hash)", with: hash)

        let document = try JSONDecoder().decode(
            CaptionVisualReviewDocument.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(document.status, .ready)
        XCTAssertEqual(document.input?.identity(for: "SC_001")?.text, "テスト字幕")
        XCTAssertEqual(document.input?.projection(for: "SC_001")?.styleRef, "clean-editorial")
        XCTAssertEqual(document.input?.projection(for: "SC_001")?.fontSizePx1080, 60)
        XCTAssertEqual(document.patch?.operations.first?.expectedCurrentHash, hash)
        XCTAssertEqual(document.capabilities?.supports(document.patch!.operations[0]), [])
        XCTAssertNil(document.safeZoneProfile)
    }

    func testVisualRunnerArgumentsCarryStableOperationAndAccessibilityContext() throws {
        let hash = "sha256:" + String(repeating: "b", count: 64)
        let operation = CaptionVisualTreatmentOperation(
            captionID: "SC_001",
            stableRootID: "SC_001",
            expectedCurrentHash: hash,
            anchor: .bottomCenter,
            rect: CaptionVisualRect(x: 0.1, y: 0.75, width: 0.8, height: 0.12),
            styleRef: "clean-editorial",
            referenceScale: 1.2,
            hierarchyRole: .speech,
            fallback: .registeredFallback
        )
        let arguments = CaptionReviewRunner.visualApplyArguments(
            projectURL: URL(fileURLWithPath: "/tmp/video project"),
            reviewer: "Human Editor",
            operation: operation,
            expectedPatchHash: hash,
            typographyPolicyURL: URL(fileURLWithPath: "/tmp/policy.json"),
            safeZoneProfileURL: URL(fileURLWithPath: "/tmp/profile.json"),
            accessibility: CaptionVisualAccessibility(reducedMotion: true, highContrast: true)
        )

        XCTAssertTrue(arguments.contains("--visual-operation-json"))
        XCTAssertTrue(arguments.contains("--expected-patch-hash"))
        XCTAssertTrue(arguments.contains("--typography-policy"))
        XCTAssertTrue(arguments.contains("--safe-zone-profile"))
        XCTAssertTrue(arguments.contains("--reduced-motion"))
        XCTAssertTrue(arguments.contains("--high-contrast"))
        let encoded = try XCTUnwrap(arguments.first { $0.contains("\"caption_id\":\"SC_001\"") })
        let decoded = try JSONDecoder().decode(CaptionVisualTreatmentOperation.self, from: Data(encoded.utf8))
        XCTAssertEqual(decoded, operation)

        let approveArguments = CaptionReviewRunner.visualApproveArguments(
            projectURL: URL(fileURLWithPath: "/tmp/video project"),
            reviewer: "Human Editor",
            expectedPatchHash: hash
        )
        XCTAssertEqual(approveArguments[approveArguments.firstIndex(of: "--expected-patch-hash")! + 1], hash)
        XCTAssertEqual(approveArguments[approveArguments.firstIndex(of: "--preapproval-receipt")! + 1], "/tmp/video project/07_package/caption_visual_treatment_preapproval_receipt.json")
        let previewArguments = CaptionReviewRunner.visualPreviewArguments(
            projectURL: URL(fileURLWithPath: "/tmp/video project"),
            reviewer: "Human Editor",
            expectedPatchHash: hash
        )
        XCTAssertTrue(previewArguments.contains("visual-preview"))
        XCTAssertEqual(previewArguments[previewArguments.firstIndex(of: "--expected-patch-hash")! + 1], hash)
    }

    func testCanonicalReceiptParityMismatchDisablesVisualApprovalGate() throws {
        let hash = "sha256:" + String(repeating: "c", count: 64)
        let inputJSON = """
        {
          "version":"caption-visual-treatment-input/v1",
          "project_id":"demo",
          "approval_hash":"\(hash)",
          "typography_policy_hash":"\(hash)",
          "visual_treatment_patch_hash":"\(hash)",
          "caption_identity":[],
          "graphical_content_identity":[],
          "status":"ready",
          "fallbacks":[],
          "renderer_route":{"speech_captions":"ffmpeg-libass","graphical_content":{"available":["remotion","hyperframes"],"selected":"not_selected","status":"deferred_to_next_milestone"}},
          "text_timing_hash":"\(hash)",
          "capability_hash":"\(hash)",
          "applied_caption_ids":[],
          "degraded_reasons":[],
          "blocked_reasons":[],
          "input_hash":"\(hash)"
        }
        """
        let input = try JSONDecoder().decode(CaptionVisualTreatmentInputDocument.self, from: Data(inputJSON.utf8))
        let preview = CaptionCanonicalPreviewDocument(
            outputPath: nil, receiptPath: nil, routeReceiptPath: nil,
            visualInputHash: hash, approvalHash: hash, visualTreatmentPatchHash: hash,
            typographyPolicyHash: hash, platformSafeZoneProfileID: nil,
            platformSafeZoneProfilePath: nil, platformSafeZoneProfileHash: nil,
            textTimingHash: hash, capabilityHash: hash, visualStatus: .ready,
            parityStatus: "pass", parityMatches: true
        )
        XCTAssertTrue(CaptionVisualApprovalGate.canonicalReceiptParityMatches(input: input, preview: preview))
        let stalePreview = CaptionCanonicalPreviewDocument(
            outputPath: nil, receiptPath: nil, routeReceiptPath: nil,
            visualInputHash: "sha256:" + String(repeating: "d", count: 64),
            approvalHash: hash, visualTreatmentPatchHash: hash,
            typographyPolicyHash: hash, platformSafeZoneProfileID: nil,
            platformSafeZoneProfilePath: nil, platformSafeZoneProfileHash: nil,
            textTimingHash: hash, capabilityHash: hash, visualStatus: .ready,
            parityStatus: "mismatch", parityMatches: false
        )
        XCTAssertFalse(CaptionVisualApprovalGate.canonicalReceiptParityMatches(input: input, preview: stalePreview))
    }

    func testVisualGestureChangedIsLocalAndEndedEmitsExactlyOneOperation() {
        let operation = CaptionVisualTreatmentOperation(
            captionID: "SC_001", stableRootID: "SC_001", anchor: .bottomCenter,
            rect: CaptionVisualRect(x: 0.1, y: 0.7, width: 0.8, height: 0.12),
            styleRef: "clean-editorial", fallback: .registeredFallback
        )
        var state = CaptionVisualGestureCommitState()
        state.changed(operation)
        XCTAssertEqual(state.pendingOperation, operation)
        XCTAssertEqual(state.ended(), operation)
        XCTAssertNil(state.ended())
    }

    func testVisualStaleDraftSurvivesAndRebaseDiffersFromAdoptCurrent() {
        let pending = CaptionVisualTreatmentOperation(
            captionID: "SC_001", stableRootID: "SC_001", expectedCurrentHash: nil,
            anchor: .bottomCenter, styleRef: "clean-editorial", fallback: .registeredFallback
        )
        let current = CaptionVisualTreatmentOperation(
            captionID: "SC_001", stableRootID: "SC_001", expectedCurrentHash: nil,
            anchor: .center, styleRef: "sns-vertical-outline", fallback: .registeredFallback
        )
        let rebased = CaptionVisualDraftResolution.rebase(pending, onto: "sha256:" + String(repeating: "e", count: 64))
        let adopted = CaptionVisualDraftResolution.adoptCurrent(current)
        XCTAssertEqual(rebased.captionID, pending.captionID)
        XCTAssertEqual(rebased.styleRef, pending.styleRef)
        XCTAssertNotEqual(rebased.expectedCurrentHash, nil)
        XCTAssertNotEqual(rebased, adopted)
        XCTAssertEqual(adopted.anchor, current.anchor)
        XCTAssertEqual(adopted.styleRef, current.styleRef)
    }

    func testVisualSessionRebaseConsumesStaleConflictOnceAfterOneCanonicalHistoryUnit() {
        let hash = "sha256:" + String(repeating: "1", count: 64)
        let conflict = CaptionVisualReviewConflict(
            captionID: "SC_001", expectedPatchHash: hash, currentPatchHash: hash, message: "stale"
        )
        let pending = CaptionVisualTreatmentOperation(
            captionID: "SC_001", stableRootID: "SC_001", expectedCurrentHash: hash,
            anchor: .bottomCenter, styleRef: "clean-editorial", fallback: .registeredFallback
        )
        XCTAssertTrue(CaptionVisualDraftResolution.canBeginRebase(conflict: conflict, isInFlight: false))
        XCTAssertFalse(CaptionVisualDraftResolution.canBeginRebase(conflict: conflict, isInFlight: true))
        XCTAssertEqual(CaptionVisualDraftResolution.rebase(pending, onto: hash).expectedCurrentHash, hash)
        XCTAssertTrue(CaptionVisualDraftResolution.successfulApplyConsumesConflict(conflict))
        let consumed: CaptionVisualReviewConflict? = nil
        XCTAssertFalse(CaptionVisualDraftResolution.canBeginRebase(conflict: consumed, isInFlight: false))
    }

    func testAnimationAndKeywordHierarchyNeverClaimExactStudioDisplay() throws {
        let hash = "sha256:" + String(repeating: "f", count: 64)
        let json = """
        {
          "version":"caption-visual-treatment-input/v1",
          "project_id":"demo",
          "approval_hash":"\(hash)",
          "typography_policy_hash":"\(hash)",
          "visual_treatment_patch_hash":"\(hash)",
          "resolved_projection":[
            {"caption_id":"SC_001","stable_root_id":"SC_001","style_ref":"default","font_family":"VideoOS Heavy","font_weight":700,"font_size_px_1080":58,"line_height_px_1080":70,"fill_rgba":"FFFFFFFF","outline_rgba":"000000FF","outline_px_1080":3,"shadow_px_1080":0,"max_width_ratio":0.8,"alignment":"bottom_center","emphasis_scale":1,"animation_ref":"semantic-reveal","hierarchy_role":"keyword","effect_supported":true,"animation_supported":true,"hierarchy_supported":true,"hierarchy_preview_supported":false,"animation_preview_supported":false,"outline_enabled":true,"shadow_enabled":false,"panel_enabled":false}
          ],
          "caption_identity":[],"graphical_content_identity":[],"status":"ready","fallbacks":[],
          "renderer_route":{"speech_captions":"ffmpeg-libass","graphical_content":{"available":["remotion","hyperframes"],"selected":"not_selected","status":"deferred_to_next_milestone"}},
          "text_timing_hash":"\(hash)","capability_hash":"\(hash)","applied_caption_ids":[],"degraded_reasons":[],"blocked_reasons":[],"input_hash":"\(hash)"
        }
        """
        let input = try JSONDecoder().decode(CaptionVisualTreatmentInputDocument.self, from: Data(json.utf8))
        let projection = try XCTUnwrap(input.projection(for: "SC_001"))
        XCTAssertTrue(projection.animationSupported)
        XCTAssertTrue(projection.hierarchySupported == true)
        XCTAssertFalse(projection.studioPreviewSupported)
        XCTAssertTrue(projection.studioPreviewUnavailableReasons.joined(separator: " ").contains("animation"))
        XCTAssertTrue(projection.studioPreviewUnavailableReasons.joined(separator: " ").contains("hierarchy"))
    }

    func testVisualTreatmentStudioContractFixtureCoversOverlayEditingCapabilitiesAndParity() throws {
        let fixtureDirectory = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil))
        let fixtureURL = fixtureDirectory.appendingPathComponent("caption-visual-treatment-contract-v1.json")
        let fixture = try JSONDecoder().decode(VisualTreatmentStudioContractFixture.self, from: Data(contentsOf: fixtureURL))

        let supported = fixture.supportedOperation
        let resized = fixture.resizeOperation
        let unsupported = fixture.unsupportedOperation
        let capabilities = fixture.capabilities
        let verifiedProfile = fixture.verifiedProfile
        let unknownProfile = fixture.unknownProfile

        XCTAssertEqual(supported.id, "SC_001")
        XCTAssertEqual(supported.rect, CaptionVisualRect(x: 0.18, y: 0.64, width: 0.64, height: 0.14))
        XCTAssertEqual(supported.referenceScale, 1.25)
        XCTAssertEqual(resized.rect, CaptionVisualRect(x: 0.13, y: 0.62, width: 0.74, height: 0.16))
        XCTAssertEqual(resized.referenceScale, 1.75)
        XCTAssertFalse(verifiedProfile.isHumanHold)
        XCTAssertTrue(verifiedProfile.geometry.isVerified)
        XCTAssertTrue(unknownProfile.isHumanHold)
        XCTAssertEqual(capabilities.supports(supported), [])
        XCTAssertEqual(capabilities.supports(unsupported), ["hierarchy_role=speaker"])

        let receipt = fixture.parity.canonicalReceipt
        let canonicalPreview = CaptionCanonicalPreviewDocument(
            outputPath: nil,
            receiptPath: "fixture.receipt.json",
            routeReceiptPath: nil,
            visualInputHash: receipt.visualInputHash,
            approvalHash: receipt.approvalHash,
            visualTreatmentPatchHash: receipt.visualTreatmentPatchHash,
            typographyPolicyHash: receipt.typographyPolicyHash,
            platformSafeZoneProfileID: receipt.platformSafeZoneProfileID,
            platformSafeZoneProfilePath: receipt.platformSafeZoneProfilePath,
            platformSafeZoneProfileHash: receipt.platformSafeZoneProfileHash,
            textTimingHash: receipt.textTimingHash,
            capabilityHash: receipt.capabilityHash,
            visualStatus: .ready,
            parityStatus: "pass",
            parityMatches: receipt.parityMatches
        )
        XCTAssertTrue(canonicalPreview.parityMatches == true)
        XCTAssertEqual(canonicalPreview.visualInputHash, fixture.parity.studioInputHash)
        XCTAssertEqual(canonicalPreview.approvalHash, fixture.parity.approvalHash)
        XCTAssertEqual(canonicalPreview.visualTreatmentPatchHash, fixture.parity.visualTreatmentPatchHash)
        XCTAssertEqual(canonicalPreview.platformSafeZoneProfileHash, fixture.parity.platformSafeZoneProfileHash)
        XCTAssertEqual(canonicalPreview.textTimingHash, fixture.parity.textTimingHash)
        XCTAssertEqual(canonicalPreview.capabilityHash, fixture.parity.capabilityHash)
    }
}

private struct VisualTreatmentStudioContractFixture: Decodable {
    let supportedOperation: CaptionVisualTreatmentOperation
    let resizeOperation: CaptionVisualTreatmentOperation
    let unsupportedOperation: CaptionVisualTreatmentOperation
    let capabilities: CaptionVisualTreatmentCapabilities
    let verifiedProfile: CaptionSafeZoneProfileDocument
    let unknownProfile: CaptionSafeZoneProfileDocument
    let parity: Parity

    enum CodingKeys: String, CodingKey {
        case supportedOperation = "supported_operation"
        case resizeOperation = "resize_operation"
        case unsupportedOperation = "unsupported_operation"
        case capabilities
        case verifiedProfile = "verified_profile"
        case unknownProfile = "unknown_profile"
        case parity
    }

    struct Parity: Decodable {
        let studioInputHash: String
        let approvalHash: String
        let visualTreatmentPatchHash: String
        let typographyPolicyHash: String
        let platformSafeZoneProfileID: String
        let platformSafeZoneProfilePath: String
        let platformSafeZoneProfileHash: String
        let textTimingHash: String
        let capabilityHash: String
        let canonicalReceipt: Receipt

        enum CodingKeys: String, CodingKey {
            case studioInputHash = "studio_input_hash"
            case approvalHash = "approval_hash"
            case visualTreatmentPatchHash = "visual_treatment_patch_hash"
            case typographyPolicyHash = "typography_policy_hash"
            case platformSafeZoneProfileID = "platform_safe_zone_profile_id"
            case platformSafeZoneProfilePath = "platform_safe_zone_profile_path"
            case platformSafeZoneProfileHash = "platform_safe_zone_profile_hash"
            case textTimingHash = "text_timing_hash"
            case capabilityHash = "capability_hash"
            case canonicalReceipt = "canonical_receipt"
        }

        struct Receipt: Decodable {
            let visualInputHash: String
            let approvalHash: String
            let visualTreatmentPatchHash: String
            let typographyPolicyHash: String
            let platformSafeZoneProfileID: String
            let platformSafeZoneProfilePath: String
            let platformSafeZoneProfileHash: String
            let textTimingHash: String
            let capabilityHash: String
            let parityMatches: Bool

            enum CodingKeys: String, CodingKey {
                case visualInputHash = "visual_input_hash"
                case approvalHash = "approval_hash"
                case visualTreatmentPatchHash = "visual_treatment_patch_hash"
                case typographyPolicyHash = "typography_policy_hash"
                case platformSafeZoneProfileID = "platform_safe_zone_profile_id"
                case platformSafeZoneProfilePath = "platform_safe_zone_profile_path"
                case platformSafeZoneProfileHash = "platform_safe_zone_profile_hash"
                case textTimingHash = "text_timing_hash"
                case capabilityHash = "capability_hash"
                case parityMatches = "parity_matches"
            }
        }
    }
}
