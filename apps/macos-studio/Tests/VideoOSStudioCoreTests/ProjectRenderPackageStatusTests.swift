import XCTest
@testable import VideoOSStudioCore

final class ProjectRenderPackageStatusTests: XCTestCase {
    func testStatusReportsMissingRenderArtifacts() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: .unavailable("package verification is pending")
        )

        XCTAssertEqual(status.readinessLabel, "not rendered")
        XCTAssertFalse(status.qaReportExists)
        XCTAssertFalse(status.packageManifestExists)
        XCTAssertFalse(status.publishedFinalVideoExists)
        XCTAssertEqual(status.missingRequiredArtifacts, [
            "07_package/qa-report.json",
            "07_package/package_manifest.json",
            "09_output/final.mp4"
        ])
    }

    func testStatusReportsCompletePackagedRender() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-complete-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: true)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: verifiedPackage()
        )

        XCTAssertEqual(status.readinessLabel, "render packaged")
        XCTAssertTrue(status.qaReportExists)
        XCTAssertTrue(status.qaReportReadable)
        XCTAssertEqual(status.qaPassed, true)
        XCTAssertEqual(status.qaProjectID, "demo")
        XCTAssertEqual(status.qaSourceOfTruth, "engine_render")
        XCTAssertEqual(status.qaCheckCount, 2)
        XCTAssertEqual(status.qaFailedCheckCount, 0)
        XCTAssertTrue(status.packageManifestExists)
        XCTAssertTrue(status.packageManifestReadable)
        XCTAssertEqual(status.manifestProjectID, "demo")
        XCTAssertEqual(status.manifestSourceOfTruth, "engine_render")
        XCTAssertEqual(status.manifestCreatedAt, "2026-05-22T00:00:00Z")
        XCTAssertTrue(status.packageContractMatches)
        XCTAssertTrue(status.publishedFinalVideoExists)
        XCTAssertTrue(status.packageFinalVideoExists)
        XCTAssertTrue(status.finalMixExists)
        XCTAssertEqual(status.missingRequiredArtifacts, [])
    }

    func testStatusReportsFailedQA() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-failed-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: false, includeLayoutIssue: true)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: rejectedPackage("qa failed")
        )

        XCTAssertEqual(status.readinessLabel, "qa failed")
        XCTAssertEqual(status.qaPassed, false)
        XCTAssertEqual(status.qaFailedCheckCount, 1)
        XCTAssertEqual(status.layoutQAStatus, "blocked")
        XCTAssertEqual(status.layoutQAReviewSummary, "要修正 1件")
        XCTAssertEqual(status.layoutQAReviewItems.map(\.code), ["caption_visual_collision"])
        XCTAssertEqual(status.layoutQAReviewItems.first?.timeRangeLabel, "00:00:02.000–00:00:03.000")
        XCTAssertEqual(status.layoutQAReviewItems.first?.layerIDs, ["CAP_1", "CTA_1"])
        XCTAssertEqual(status.layoutQAReviewItems.first?.title, "字幕と画面テキストが衝突")
        XCTAssertEqual(status.layoutQAReviewItems.first?.remediation, "字幕またはCTAの表示区間・位置を分離してください。")
    }

    func testStatusReportsVerifiedLayoutWithoutFalseReviewItems() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-layout-clean-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: true, includeVerifiedLayout: true)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: verifiedPackage()
        )

        XCTAssertEqual(status.layoutQAStatus, "verified")
        XCTAssertEqual(status.layoutQAReviewSummary, "レイアウト検証済み")
        XCTAssertTrue(status.layoutQAReviewItems.isEmpty)
    }

    func testStatusReportsWaveformGroundedSpeechCadenceReviewItems() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-cadence-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: true)
        try writeSpeechCadenceMetric(project: project)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: verifiedPackage()
        )

        XCTAssertEqual(status.speechCadenceStatus, "review_required")
        XCTAssertEqual(status.speechCadenceReviewSummary, "間を確認 1件")
        XCTAssertEqual(status.speechCadenceReviewItems.map(\.code), ["excessive_internal_silence"])
        XCTAssertEqual(status.speechCadenceReviewItems.first?.timeRangeLabel, "00:00:01.001–00:00:01.802")
        XCTAssertEqual(status.speechCadenceReviewItems.first?.durationLabel, "0.8秒")
        XCTAssertEqual(status.speechCadenceReviewItems.first?.suggestedActionLabel, "ジャンプカット候補")
        XCTAssertEqual(status.speechCadenceReviewItems.first?.clipID, "CLIP_001")
        XCTAssertEqual(status.speechCadenceReviewItems.first?.title, "発話中の間が長い")
    }

    func testStatusReportsCaptionDeliveryReviewItems() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-caption-delivery-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: project, qaPassed: true)
        try writeCaptionDeliveryMetric(project: project)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: verifiedPackage()
        )

        XCTAssertEqual(status.captionDeliveryStatus, "review_required")
        XCTAssertEqual(status.captionDeliveryReviewSummary, "字幕タイミング確認 1件")
        XCTAssertEqual(status.captionDeliveryReviewItems.map(\.code), ["insufficient_read_time"])
        XCTAssertEqual(status.captionDeliveryReviewItems.first?.timeRangeLabel, "00:00:05.005–00:00:05.506")
        XCTAssertEqual(status.captionDeliveryReviewItems.first?.measurementLabel, "0.5秒（基準 0.8秒）")
        XCTAssertEqual(status.captionDeliveryReviewItems.first?.suggestedActionLabel, "読了時間を延ばす")
        XCTAssertEqual(status.captionDeliveryReviewItems.first?.captionID, "SC_FLASH")
        XCTAssertEqual(status.captionDeliveryReviewItems.first?.textExcerpt, "馬鹿げてますよね")
        XCTAssertEqual(status.captionDeliveryReviewItems.first?.title, "字幕を読む時間が短い")
    }

    func testStatusRejectsPartialQAAndManifestContracts() throws {
        let qaProject = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-partial-qa-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: qaProject, qaPassed: true, includeQADetails: false)

        var status = ProjectRenderPackageStatusReader.status(
            projectURL: qaProject,
            verificationStatus: rejectedPackage("qa report unreadable")
        )

        XCTAssertEqual(status.readinessLabel, "qa report unreadable")
        XCTAssertFalse(status.qaReportReadable)

        let manifestProject = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-partial-manifest-\(UUID().uuidString)")
        try writeRenderPackageFixture(project: manifestProject, qaPassed: true, includeManifestProvenance: false)

        status = ProjectRenderPackageStatusReader.status(
            projectURL: manifestProject,
            verificationStatus: rejectedPackage("package manifest unreadable")
        )

        XCTAssertEqual(status.readinessLabel, "package manifest unreadable")
        XCTAssertFalse(status.packageManifestReadable)
    }

    func testStatusRejectsProjectAndSourceOfTruthMismatches() throws {
        let projectMismatch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-project-mismatch-\(UUID().uuidString)")
        try writeRenderPackageFixture(
            project: projectMismatch,
            qaPassed: true,
            manifestProjectID: "other"
        )

        var status = ProjectRenderPackageStatusReader.status(
            projectURL: projectMismatch,
            verificationStatus: rejectedPackage("package contract mismatch")
        )

        XCTAssertEqual(status.readinessLabel, "package contract mismatch")
        XCTAssertFalse(status.packageContractMatches)

        let sourceMismatch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-render-status-source-mismatch-\(UUID().uuidString)")
        try writeRenderPackageFixture(
            project: sourceMismatch,
            qaPassed: true,
            manifestSourceOfTruth: "nle_finishing"
        )

        status = ProjectRenderPackageStatusReader.status(
            projectURL: sourceMismatch,
            verificationStatus: rejectedPackage("package contract mismatch")
        )

        XCTAssertEqual(status.readinessLabel, "package contract mismatch")
        XCTAssertFalse(status.packageContractMatches)
    }
}

private func verifiedPackage() -> ProjectPackageVerificationStatus {
    ProjectPackageVerificationStatus(
        ready: true,
        readinessLabel: "render packaged",
        projectID: "demo",
        sourceOfTruth: "engine_render"
    )
}

private func rejectedPackage(_ readinessLabel: String) -> ProjectPackageVerificationStatus {
    ProjectPackageVerificationStatus(
        ready: false,
        readinessLabel: readinessLabel,
        issues: [readinessLabel],
        projectID: "demo",
        sourceOfTruth: "engine_render"
    )
}

private func writeRenderPackageFixture(
    project: URL,
    qaPassed: Bool,
    qaProjectID: String = "demo",
    manifestProjectID: String = "demo",
    qaSourceOfTruth: String = "engine_render",
    manifestSourceOfTruth: String = "engine_render",
    includeQADetails: Bool = true,
    includeManifestProvenance: Bool = true,
    includeLayoutIssue: Bool = false,
    includeVerifiedLayout: Bool = false
) throws {
    let package = project.appendingPathComponent("07_package")
    let video = package.appendingPathComponent("video")
    let audio = package.appendingPathComponent("audio")
    let timeline = project.appendingPathComponent("05_timeline")
    let output = project.appendingPathComponent("09_output")
    try FileManager.default.createDirectory(at: video, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: timeline, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    try Data([0x00, 0x01]).write(to: video.appendingPathComponent("final.mp4"), options: .atomic)
    try Data([0x02, 0x03]).write(to: audio.appendingPathComponent("final_mix.wav"), options: .atomic)
    try Data([0x04, 0x05]).write(to: output.appendingPathComponent("final.mp4"), options: .atomic)
    try #"{"version":"1","project_id":"demo","tracks":{"video":[],"audio":[]}}"#.write(
        to: timeline.appendingPathComponent("timeline.json"),
        atomically: true,
        encoding: .utf8
    )
    try "project_id: demo\n".write(
        to: project.appendingPathComponent("project_state.yaml"),
        atomically: true,
        encoding: .utf8
    )
    let qaDetails = includeQADetails ? #", "details": "ok""# : ""
    let loudnessDetails = includeQADetails ? #", "details": "measured""# : ""
    let layoutMetrics: String
    if includeLayoutIssue {
        layoutMetrics = """
        ,
          "metrics": {
            "deterministic_layout_qa": {
              "version": "deterministic-layout-qa/v2",
              "status": "blocked",
              "snapshot_version": "render-layout-snapshot/v1",
              "issues": [{
                "code": "caption_visual_collision",
                "severity": "blocking",
                "detail": "CAP_1 collides with cta CTA_1",
                "layer_ids": ["CAP_1", "CTA_1"],
                "start_frame": 60,
                "end_frame": 90
              }],
              "review_items": [{
                "issue_id": "LAYOUTQA_0123456789ABCDEF",
                "code": "caption_visual_collision",
                "severity": "blocking",
                "title_ja": "字幕と画面テキストが衝突",
                "remediation_ja": "字幕またはCTAの表示区間・位置を分離してください。",
                "layer_ids": ["CAP_1", "CTA_1"],
                "start_frame": 60,
                "end_frame": 90,
                "start_timecode": "00:00:02.000",
                "end_timecode": "00:00:03.000"
              }]
            }
          }
        """
    } else if includeVerifiedLayout {
        layoutMetrics = """
        ,
          "metrics": {
            "deterministic_layout_qa": {
              "version": "deterministic-layout-qa/v2",
              "status": "verified",
              "snapshot_version": "render-layout-snapshot/v1",
              "issues": [],
              "review_items": []
            }
          }
        """
    } else {
        layoutMetrics = ""
    }
    try """
    {
      "version": "1",
      "project_id": "\(qaProjectID)",
      "source_of_truth": "\(qaSourceOfTruth)",
      "qa_profile": "\(qaSourceOfTruth)",
      "passed": \(qaPassed ? "true" : "false"),
      "checks": [
        { "name": "timeline_schema_valid", "passed": true\(qaDetails) },
        { "name": "loudness", "passed": \(qaPassed ? "true" : "false")\(loudnessDetails) }
      ]\(layoutMetrics)
    }
    """.write(to: package.appendingPathComponent("qa-report.json"), atomically: true, encoding: .utf8)
    let provenance = includeManifestProvenance
        ? """
        ,
          "provenance": {
            "editorial_timeline_hash": "timeline"
          }
        """
        : ""
    try """
    {
      "version": "package-v1",
      "project_id": "\(manifestProjectID)",
      "source_of_truth": "\(manifestSourceOfTruth)",
      "base_timeline_version": "1",
      "packaging_projection_hash": "abc123",
      "created_at": "2026-05-22T00:00:00Z",
      "artifacts": {
        "final_video": { "path": "09_output/final.mp4", "sha256": "abc" },
        "qa_report": { "path": "07_package/qa-report.json", "sha256": "def" }
      }\(provenance)
    }
    """.write(to: package.appendingPathComponent("package_manifest.json"), atomically: true, encoding: .utf8)
}

private func writeSpeechCadenceMetric(project: URL) throws {
    let reportURL = project
        .appendingPathComponent("07_package")
        .appendingPathComponent("qa-report.json")
    let data = try Data(contentsOf: reportURL)
    var report = try XCTUnwrap(
        JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
    report["metrics"] = [
        "speech_cadence_qa": [
            "version": "speech-cadence-qa/v1",
            "status": "review_required",
            "mode": "aggressive",
            "checked_clip_count": 1,
            "silence_event_count": 1,
            "intentional_hold_count": 0,
            "thresholds": [
                "head_silence_max_ms": 350,
                "internal_silence_max_ms": 600,
                "tail_silence_max_ms": 350,
                "source": "short-form-retention/aggressive/v1",
            ],
            "review_items": [[
                "issue_id": "CADENCEQA_0123456789ABCDEF",
                "code": "excessive_internal_silence",
                "severity": "review",
                "clip_id": "CLIP_001",
                "asset_id": "AST_001",
                "silence_event_id": "AE_INTERNAL",
                "source_start_us": 1_000_000,
                "source_end_us": 1_800_000,
                "timeline_start_frame": 30,
                "timeline_end_frame": 54,
                "start_timecode": "00:00:01.001",
                "end_timecode": "00:00:01.802",
                "duration_ms": 801,
                "suggested_action": "jump_cut",
                "title_ja": "発話中の間が長い",
                "remediation_ja": "文脈と表情を確認して詰めてください。",
            ]],
        ],
    ]
    try JSONSerialization.data(
        withJSONObject: report,
        options: [.prettyPrinted, .sortedKeys]
    ).write(to: reportURL, options: .atomic)
}

private func writeCaptionDeliveryMetric(project: URL) throws {
    let reportURL = project
        .appendingPathComponent("07_package")
        .appendingPathComponent("qa-report.json")
    let data = try Data(contentsOf: reportURL)
    var report = try XCTUnwrap(
        JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
    report["metrics"] = [
        "caption_delivery_qa": [
            "version": "caption-delivery-qa/v1",
            "status": "review_required",
            "mode": "aggressive",
            "checked_caption_count": 1,
            "evidence_caption_count": 1,
            "incomplete_caption_count": 0,
            "intentional_reveal_count": 0,
            "thresholds": [
                "ordinary_lead_frames": 2,
                "question_audio_first_frames": 0,
                "max_lag_ms": 120,
                "speech_end_tolerance_frames": 1,
                "min_dwell_ms": 800,
                "cps_limit": 16,
                "source": "caption-semantic-timing+short-form-retention/aggressive/v1",
            ],
            "review_items": [[
                "issue_id": "CAPTIONQA_0123456789ABCDEF",
                "code": "insufficient_read_time",
                "severity": "review",
                "caption_id": "SC_FLASH",
                "asset_id": "AST_001",
                "segment_id": "SEG_001",
                "text_excerpt": "馬鹿げてますよね",
                "caption_start_frame": 150,
                "caption_end_frame": 165,
                "audio_start_frame": 150,
                "audio_end_frame": 156,
                "timeline_start_frame": 150,
                "timeline_end_frame": 165,
                "start_timecode": "00:00:05.005",
                "end_timecode": "00:00:05.506",
                "measured_ms": 501,
                "threshold_ms": 800,
                "suggested_action": "extend_read_time",
                "title_ja": "字幕を読む時間が短い",
                "remediation_ja": "読了時間を確保してください。",
            ]],
        ],
    ]
    try JSONSerialization.data(
        withJSONObject: report,
        options: [.prettyPrinted, .sortedKeys]
    ).write(to: reportURL, options: .atomic)
}
