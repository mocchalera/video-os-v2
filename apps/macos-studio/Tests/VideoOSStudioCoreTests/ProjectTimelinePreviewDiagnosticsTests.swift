import XCTest
@testable import VideoOSStudioCore

final class ProjectTimelinePreviewDiagnosticsTests: XCTestCase {
    func testStatusSummarizesTimelinePreviewCompositionAndRepeatRisk() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let timelineDir = root.appendingPathComponent("05_timeline")
        let planDir = root.appendingPathComponent("04_plan")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: planDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "diagnostics",
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "clips": [
                  { "clip_id": "CLP_0001", "asset_id": "AST_A", "timeline_in_frame": 0 },
                  { "clip_id": "CLP_0002", "asset_id": "AST_A", "timeline_in_frame": 24 },
                  { "clip_id": "CLP_0003", "asset_id": "AST_A", "timeline_in_frame": 48 }
                ]
              }
            ],
            "audio": [
              {
                "track_id": "A1",
                "clips": [
                  { "clip_id": "ACL_0001", "asset_id": "AST_A", "timeline_in_frame": 0 },
                  { "clip_id": "ACL_0002", "asset_id": "AST_A", "timeline_in_frame": 24 }
                ]
              }
            ]
          },
          "transitions": [
            { "transition_id": "tr_0001", "transition_type": "cut" },
            { "transition_id": "tr_0002", "transition_type": "cut" }
          ]
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
        try """
        version: "1"
        candidates:
          - segment_id: SEG_A
            asset_id: AST_A
          - segment_id: SEG_B
            asset_id: AST_A
        """.write(to: planDir.appendingPathComponent("selects_candidates.yaml"), atomically: true, encoding: .utf8)

        let status = statusWithPreview(projectURL: root, durationSeconds: 4)

        XCTAssertTrue(status.hasTimeline)
        XCTAssertEqual(status.trackCompositionLabel, "V1 1素材/3クリップ・A1 1素材/2クリップ")
        XCTAssertEqual(status.candidatePoolLabel, "1素材/2候補")
        XCTAssertEqual(status.transitionLabel, "カットのみ 2件")
        XCTAssertEqual(status.previewCoverageLabel, "プレビュー全尺 4.0s/2.0s")
        XCTAssertEqual(status.previewAudioLabel, "プレビュー音声あり")
        XCTAssertEqual(status.previewSourceLabel, "生成済みタイムラインプレビュー: preview.mp4")
        XCTAssertEqual(status.repeatRiskLabel, "同一素材連続 V1 2件 / A1 1件")
        XCTAssertTrue(status.editorialStructureNeedsAttention)
        XCTAssertEqual(status.editorialStructureLabel, "構成注意: カットのみ / 同一素材連続 V1 2件 / A1 1件")
        XCTAssertTrue(status.recommendation.contains("選定結果由来"))
    }

    func testStatusReturnsEmptyWhenTimelineIsMissing() {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-missing-\(UUID().uuidString)")

        let status = statusWithPreview(projectURL: root, durationSeconds: 4)

        XCTAssertFalse(status.hasTimeline)
        XCTAssertEqual(status.trackCompositionLabel, "-")
        XCTAssertEqual(status.recommendation, "timeline.json がありません。先に粗編集を生成してください。")
    }

    func testStatusReportsNonAdjacentAssetReuseAsRepeatRisk() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-reuse-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "diagnostics",
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "clips": [
                  { "clip_id": "CLP_0001", "asset_id": "AST_A", "timeline_in_frame": 0 },
                  { "clip_id": "CLP_0002", "asset_id": "AST_B", "timeline_in_frame": 24 },
                  { "clip_id": "CLP_0003", "asset_id": "AST_A", "timeline_in_frame": 48 }
                ]
              }
            ],
            "audio": [
              {
                "track_id": "A1",
                "clips": [
                  { "clip_id": "ACL_0001", "asset_id": "AST_A", "timeline_in_frame": 0 },
                  { "clip_id": "ACL_0002", "asset_id": "AST_A", "timeline_in_frame": 24 }
                ]
              }
            ]
          },
          "transitions": [
            { "transition_id": "tr_0001", "transition_type": "cut" },
            { "transition_id": "tr_0002", "transition_type": "cut" }
          ]
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        let status = statusWithPreview(projectURL: root, durationSeconds: 4)

        XCTAssertEqual(status.sameAssetAdjacentPairCount, 0)
        XCTAssertEqual(status.sameAudioAssetAdjacentPairCount, 1)
        XCTAssertEqual(status.repeatRiskLabel, "同一素材連続 A1 1件")
        XCTAssertEqual(status.editorialStructureLabel, "構成注意: カットのみ / 同一素材連続 A1 1件")
        XCTAssertTrue(status.recommendation.contains("候補"))
    }

    func testStatusReportsPreviewCoverageGapBeforeTimelineCompositionAdvice() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-gap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "diagnostics",
          "sequence": { "fps_num": 24, "fps_den": 1 },
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "clips": [
                  { "clip_id": "CLP_0001", "asset_id": "AST_A", "timeline_in_frame": 0, "timeline_duration_frames": 240 }
                ]
              }
            ],
            "audio": []
          },
          "transitions": []
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        let status = statusWithPreview(projectURL: root, durationSeconds: 4)

        XCTAssertEqual(status.previewCoverageLabel, "プレビュー不足 4.0s/10.0s")
        XCTAssertTrue(status.previewCoverageNeedsAttention)
        XCTAssertTrue(status.recommendation.contains("タイムライン全尺より短い"))
        XCTAssertTrue(status.recommendation.contains("トランジション"))
    }

    func testStatusTreatsCollapsedGapRoughCutAsExpectedPreview() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-rough-cut-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let timelineDir = root.appendingPathComponent("05_timeline")
        let outputDir = root.appendingPathComponent("09_output")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "diagnostics",
          "sequence": { "fps_num": 24, "fps_den": 1 },
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "clips": [
                  { "clip_id": "CLP_0001", "asset_id": "AST_A", "timeline_in_frame": 144, "timeline_duration_frames": 96 }
                ]
              }
            ],
            "audio": []
          },
          "transitions": []
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
        try """
        {
          "timeline_span_sec": 10.0,
          "timeline_content_sec": 4.0,
          "gap_sec": 6.0,
          "gap_count": 1,
          "crossfade_overlap_sec": 0.0,
          "source_clamp_sec": 0.0,
          "expected_rendered_sec": 4.0,
          "actual_rendered_sec": 4.0,
          "parity_delta_sec": 0.0,
          "parity_pass": true
        }
        """.write(to: outputDir.appendingPathComponent("render-report.json"), atomically: true, encoding: .utf8)

        let previewURL = outputDir.appendingPathComponent("rough-cut.mp4")
        let preview = ProjectMediaReference(
            assetID: "timeline-preview",
            filename: previewURL.lastPathComponent,
            displayName: "Preview",
            url: previewURL,
            exists: true,
            sourceInUS: nil,
            sourceOutUS: nil,
            previewTimeUS: 0,
            resolvedFrom: "09_output/rough-cut"
        )
        let status = ProjectTimelinePreviewDiagnosticsReader.status(
            projectURL: root,
            previewResolver: { _, _ in preview },
            durationReader: { _ in 4 },
            audioStreamReader: { _ in true }
        )

        XCTAssertEqual(status.timelineDurationSeconds, 10)
        XCTAssertEqual(status.previewCoverageLabel, "空白詰めプレビュー 4.0s/期待4.0s（空白6.0s詰め）")
        XCTAssertFalse(status.previewCoverageNeedsAttention)
        XCTAssertTrue(status.previewUsesCollapsedGapContract)
        XCTAssertTrue(status.recommendation.contains("renderer契約どおり"))
    }

    func testStatusReportsMissingPreviewAudioWhenTimelineHasA1Clips() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-no-audio-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "diagnostics",
          "sequence": { "fps_num": 24, "fps_den": 1 },
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "clips": [
                  { "clip_id": "CLP_0001", "asset_id": "AST_A", "timeline_in_frame": 0, "timeline_duration_frames": 48 }
                ]
              }
            ],
            "audio": [
              {
                "track_id": "A1",
                "clips": [
                  { "clip_id": "ACL_0001", "asset_id": "AST_A", "timeline_in_frame": 0, "timeline_duration_frames": 48 }
                ]
              }
            ]
          },
          "transitions": []
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        let previewURL = root.appendingPathComponent("05_timeline/previews/preview.mp4")
        let preview = ProjectMediaReference(
            assetID: "timeline-preview",
            filename: previewURL.lastPathComponent,
            displayName: "Preview",
            url: previewURL,
            exists: true,
            sourceInUS: nil,
            sourceOutUS: nil,
            previewTimeUS: 0,
            resolvedFrom: "05_timeline/previews"
        )
        let status = ProjectTimelinePreviewDiagnosticsReader.status(
            projectURL: root,
            previewResolver: { _, _ in preview },
            durationReader: { _ in 2 },
            audioStreamReader: { _ in false }
        )

        XCTAssertEqual(status.previewAudioLabel, "プレビュー音声なし")
        XCTAssertTrue(status.previewAudioNeedsAttention)
        XCTAssertTrue(status.recommendation.contains("A1音声クリップ"))
    }

    func testStatusReportsMissingPreviewMedia() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-preview-diagnostics-no-preview-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let timelineDir = root.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "diagnostics",
          "sequence": { "fps_num": 24, "fps_den": 1 },
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "clips": [
                  { "clip_id": "CLP_0001", "asset_id": "AST_A", "timeline_in_frame": 0, "timeline_duration_frames": 48 }
                ]
              }
            ],
            "audio": []
          },
          "transitions": []
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        let status = ProjectTimelinePreviewDiagnosticsReader.status(
            projectURL: root,
            previewResolver: { _, _ in nil },
            durationReader: { _ in nil }
        )

        XCTAssertEqual(status.previewCoverageLabel, "プレビュー動画なし")
        XCTAssertTrue(status.previewCoverageNeedsAttention)
        XCTAssertTrue(status.recommendation.contains("元素材確認にフォールバック"))
    }

    private func statusWithPreview(
        projectURL: URL,
        durationSeconds: Double
    ) -> ProjectTimelinePreviewDiagnostics {
        let previewURL = projectURL.appendingPathComponent("05_timeline/previews/preview.mp4")
        let preview = ProjectMediaReference(
            assetID: "timeline-preview",
            filename: previewURL.lastPathComponent,
            displayName: "Preview",
            url: previewURL,
            exists: true,
            sourceInUS: nil,
            sourceOutUS: nil,
            previewTimeUS: 0,
            resolvedFrom: "05_timeline/previews"
        )
        return ProjectTimelinePreviewDiagnosticsReader.status(
            projectURL: projectURL,
            previewResolver: { _, _ in preview },
            durationReader: { _ in durationSeconds },
            audioStreamReader: { _ in true }
        )
    }
}
