import XCTest
@testable import VideoOSStudioCore

final class ProjectActiveDeliveryTests: XCTestCase {
    func testActiveDeliveryDrivesRenderStatusAndPreview() throws {
        let project = try makeProject()
        let generation = try writeActiveDelivery(project: project)

        guard case let .active(paths) = ProjectActiveDeliveryReader.resolution(projectURL: project) else {
            return XCTFail("expected active delivery")
        }
        XCTAssertEqual(paths.generationID, "0123456789abcdef01234567")
        XCTAssertEqual(paths.finalVideoURL.path, generation.appendingPathComponent("video/final.mp4").path)

        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: .unavailable("pending")
        )
        XCTAssertEqual(status.publishedFinalVideoURL.path, paths.finalVideoURL.path)
        XCTAssertTrue(status.publishedFinalVideoExists)
        XCTAssertTrue(status.qaReportExists)
        XCTAssertTrue(status.packageManifestExists)

        let preview = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: project,
            playheadSeconds: 0,
            durationReader: { _ in 30 }
        ))
        XCTAssertEqual(preview.resolvedFrom, "active_delivery/preview")
        XCTAssertEqual(preview.url?.path, generation.appendingPathComponent("preview/final.mp4").path)
    }

    func testV2ActiveDeliveryValidatesSmallReceiptAndFontArtifacts() throws {
        let project = try makeProject()
        let generation = try writeActiveDelivery(project: project, receiptVersion: "v2")

        guard case let .active(paths) = ProjectActiveDeliveryReader.resolution(projectURL: project) else {
            return XCTFail("expected hash-bound v2 active delivery")
        }
        XCTAssertEqual(paths.generationURL.standardizedFileURL.path, generation.standardizedFileURL.path)

        let manifest = generation.appendingPathComponent("font-manifest.json")
        try Data("tampered".utf8).write(to: manifest)
        XCTAssertEqual(ProjectActiveDeliveryReader.resolution(projectURL: project), .invalid)
    }

    func testInvalidPointerDoesNotExposeLegacyFinal() throws {
        let project = try makeProject()
        let legacyFinal = project.appendingPathComponent("09_output/final.mp4")
        try FileManager.default.createDirectory(at: legacyFinal.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([9]).write(to: legacyFinal)
        let pointer = project.appendingPathComponent("07_package/active_delivery.json")
        try FileManager.default.createDirectory(at: pointer.deletingLastPathComponent(), withIntermediateDirectories: true)
        try #"{"version":"active-delivery/v1","generation_id":"broken"}"#.write(
            to: pointer,
            atomically: true,
            encoding: .utf8
        )

        XCTAssertEqual(ProjectActiveDeliveryReader.resolution(projectURL: project), .invalid)
        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: .unavailable("invalid active delivery")
        )
        XCTAssertFalse(status.publishedFinalVideoExists)
        XCTAssertNotEqual(status.publishedFinalVideoURL.path, legacyFinal.path)
        XCTAssertNil(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: project,
            playheadSeconds: 0,
            durationReader: { _ in 30 }
        ))
    }

    func testOneByteVideoTamperInvalidatesActiveDeliveryWithoutLegacyFallback() throws {
        let project = try makeProject()
        let generation = try writeActiveDelivery(project: project)
        let legacyFinal = project.appendingPathComponent("09_output/final.mp4")
        try FileManager.default.createDirectory(at: legacyFinal.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([9]).write(to: legacyFinal)
        let preview = generation.appendingPathComponent("preview/final.mp4")
        var bytes = try Data(contentsOf: preview)
        bytes[0] ^= 0xff
        try bytes.write(to: preview)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSinceNow: 2)],
            ofItemAtPath: preview.path
        )

        XCTAssertEqual(ProjectActiveDeliveryReader.resolution(projectURL: project), .invalid)
        XCTAssertNil(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: project,
            playheadSeconds: 0,
            durationReader: { _ in 30 }
        ))
        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: .unavailable("tampered active delivery")
        )
        XCTAssertFalse(status.publishedFinalVideoExists)
        XCTAssertNotEqual(status.publishedFinalVideoURL.path, legacyFinal.path)
    }

    func testOneByteSmallArtifactTamperFailsImmediateHashBinding() throws {
        let project = try makeProject()
        let generation = try writeActiveDelivery(project: project)
        let captionASS = generation.appendingPathComponent("captions/speech.ass")
        var bytes = try Data(contentsOf: captionASS)
        bytes[0] ^= 0xff
        try bytes.write(to: captionASS)

        XCTAssertEqual(ProjectActiveDeliveryReader.resolution(projectURL: project), .invalid)
        XCTAssertNil(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: project,
            playheadSeconds: 0,
            durationReader: { _ in 30 }
        ))
    }

    func testVideoIdentityDoesNotSynchronouslyRehashLargeMedia() throws {
        let project = try makeProject()
        let generation = try writeActiveDelivery(project: project)
        let preview = generation.appendingPathComponent("preview/final.mp4")
        let attributes = try FileManager.default.attributesOfItem(atPath: preview.path)
        let modificationDate = attributes[.modificationDate] as! Date
        try Data([7]).write(to: preview)
        try FileManager.default.setAttributes([.modificationDate: modificationDate], ofItemAtPath: preview.path)

        guard case .active = ProjectActiveDeliveryReader.resolution(projectURL: project) else {
            return XCTFail("video body hash must not run synchronously in Studio; Node receipts own that hash")
        }
    }

    func testAbsentPointerKeepsLegacyFallback() throws {
        let project = try makeProject()
        let legacyFinal = project.appendingPathComponent("09_output/final.mp4")
        try FileManager.default.createDirectory(at: legacyFinal.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1]).write(to: legacyFinal)

        XCTAssertEqual(ProjectActiveDeliveryReader.resolution(projectURL: project), .absent)
        let status = ProjectRenderPackageStatusReader.status(
            projectURL: project,
            verificationStatus: .unavailable("legacy")
        )
        XCTAssertEqual(status.publishedFinalVideoURL.path, legacyFinal.path)
        XCTAssertTrue(status.publishedFinalVideoExists)
    }
}

private func makeProject() throws -> URL {
    let project = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-active-delivery-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    return project
}

@discardableResult
private func writeActiveDelivery(project: URL, receiptVersion: String = "v1") throws -> URL {
    let generationID = "0123456789abcdef01234567"
    let root = "07_package/caption-finalize"
    let generationRelative = "\(root)/generations/\(generationID)"
    let generation = project.appendingPathComponent(generationRelative)
    let files = [
        "captions/speech.ass",
        "captions/speech.approved.srt",
        "video/final.mp4",
        "qa-report.json",
        "package_manifest.json",
        "preview/final.mp4",
        "preview/receipt.json",
        "caption-finalize-receipt.json",
    ]
    for file in files {
        let url = generation.appendingPathComponent(file)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if file == "qa-report.json" {
            try #"{"version":"1","project_id":"demo","source_of_truth":"engine_render","qa_profile":"engine_render","passed":true,"checks":[]}"#.write(to: url, atomically: true, encoding: .utf8)
        } else if file == "package_manifest.json" {
            try #"{"version":"1","project_id":"demo","source_of_truth":"engine_render","base_timeline_version":"1","packaging_projection_hash":"x","created_at":"2026-07-23T00:00:00Z","artifacts":{"final_video":{"path":"x","sha256":"x"},"qa_report":{"path":"x","sha256":"x"}},"provenance":{"editorial_timeline_hash":"x","source_inputs_hash":"0000000000000000000000000000000000000000000000000000000000000000","source_inputs_attestation_status":"verified"}}"#.write(to: url, atomically: true, encoding: .utf8)
        } else {
            try Data([1]).write(to: url)
        }
    }
    if receiptVersion == "v2" {
        try #"{"version":"font-staging-manifest/v1","font_id":"noto-sans-jp","family":"VideoOS Noto Sans JP Black","fallback_used":false,"assets":[]}"#.write(
            to: generation.appendingPathComponent("font-manifest.json"),
            atomically: true,
            encoding: .utf8
        )
    }
    let intentRelative = "\(root)/intents/intent.json"
    let intent = project.appendingPathComponent(intentRelative)
    try FileManager.default.createDirectory(at: intent.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data([2]).write(to: intent)
    func artifact(relative: String, url: URL, video: Bool = false) throws -> [String: Any] {
        var result: [String: Any] = [
            "path": relative,
            "sha256": try BGMReviewSourceResolver.sha256(for: url),
        ]
        if video {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            result["size_bytes"] = (attributes[.size] as! NSNumber).int64Value
            let date = attributes[.modificationDate] as! Date
            result["mtime_ms"] = Int64((date.timeIntervalSince1970 * 1_000).rounded())
        }
        return result
    }
    let approvalArtifact = try artifact(relative: intentRelative, url: intent)
    let finalVideoArtifact = try artifact(
        relative: "\(generationRelative)/video/final.mp4",
        url: generation.appendingPathComponent("video/final.mp4"),
        video: true
    )
    let previewArtifact = try artifact(
        relative: "\(generationRelative)/preview/final.mp4",
        url: generation.appendingPathComponent("preview/final.mp4"),
        video: true
    )
    let zeroHash = "sha256:" + String(repeating: "0", count: 64)
    let fontManifestArtifact = receiptVersion == "v2"
        ? try artifact(
            relative: "\(generationRelative)/font-manifest.json",
            url: generation.appendingPathComponent("font-manifest.json")
        )
        : nil
    if receiptVersion == "v2" {
        try writeJSON([
            "version": "caption-finalize-preview-receipt/v2",
            "created_at": "2026-07-23T00:00:00Z",
            "source_final_sha256": finalVideoArtifact["sha256"]!,
            "source_final_size_bytes": finalVideoArtifact["size_bytes"]!,
            "source_final_mtime_ms": finalVideoArtifact["mtime_ms"]!,
            "preview_sha256": previewArtifact["sha256"]!,
            "preview_size_bytes": previewArtifact["size_bytes"]!,
            "preview_mtime_ms": previewArtifact["mtime_ms"]!,
            "approval_sha256": approvalArtifact["sha256"]!,
            "timeline_sha256": zeroHash,
            "font_manifest_sha256": fontManifestArtifact!["sha256"]!,
        ], to: generation.appendingPathComponent("preview/receipt.json"))
    }
    var receiptArtifacts: [String: Any] = [
        "approval_intent": approvalArtifact,
        "caption_ass": try artifact(relative: "\(generationRelative)/captions/speech.ass", url: generation.appendingPathComponent("captions/speech.ass")),
        "caption_srt": try artifact(relative: "\(generationRelative)/captions/speech.approved.srt", url: generation.appendingPathComponent("captions/speech.approved.srt")),
        "final_video": finalVideoArtifact,
        "qa_report": try artifact(relative: "\(generationRelative)/qa-report.json", url: generation.appendingPathComponent("qa-report.json")),
        "package_manifest": try artifact(relative: "\(generationRelative)/package_manifest.json", url: generation.appendingPathComponent("package_manifest.json")),
        "preview": previewArtifact,
        "preview_receipt": try artifact(relative: "\(generationRelative)/preview/receipt.json", url: generation.appendingPathComponent("preview/receipt.json")),
    ]
    if let fontManifestArtifact {
        receiptArtifacts["font_manifest"] = fontManifestArtifact
    }
    let receiptURL = generation.appendingPathComponent("caption-finalize-receipt.json")
    try writeJSON([
        "version": "caption-finalize-receipt/\(receiptVersion)",
        "project_id": "demo",
        "generation_id": generationID,
        "generation_key": zeroHash,
        "approval_sha256": approvalArtifact["sha256"]!,
        "timeline_sha256": zeroHash,
        "created_at": "2026-07-23T00:00:00Z",
        "artifacts": receiptArtifacts,
        "verification": [
            "qa_passed": true,
            "package_ready": true,
            "package_preflight_version": "package-preflight/v2",
            "package_preflight_decision": "ready_to_run",
        ],
    ], to: receiptURL)
    let pointerArtifacts: [String: Any] = [
        "caption_ass": receiptArtifacts["caption_ass"]!,
        "caption_srt": receiptArtifacts["caption_srt"]!,
        "final_video": receiptArtifacts["final_video"]!,
        "qa_report": receiptArtifacts["qa_report"]!,
        "package_manifest": receiptArtifacts["package_manifest"]!,
        "preview": receiptArtifacts["preview"]!,
        "preview_receipt": receiptArtifacts["preview_receipt"]!,
        "receipt": try artifact(relative: "\(generationRelative)/caption-finalize-receipt.json", url: receiptURL),
    ]
    let pointer = project.appendingPathComponent("07_package/active_delivery.json")
    try writeJSON([
        "version": "active-delivery/v1",
        "project_id": "demo",
        "generation_id": generationID,
        "generation_path": generationRelative,
        "activated_at": "2026-07-23T00:00:00Z",
        "approval_intent": approvalArtifact,
        "inputs": ["approval_sha256": approvalArtifact["sha256"]!, "timeline_sha256": zeroHash, "generation_key": zeroHash],
        "artifacts": pointerArtifacts,
    ], to: pointer)
    return generation
}

private func writeJSON(_ value: [String: Any], to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url, options: .atomic)
}
