import Foundation

public struct ProjectActiveDeliveryPaths: Equatable, Sendable {
    public let generationID: String
    public let generationURL: URL
    public let captionApprovalURL: URL
    public let captionASSURL: URL
    public let captionSRTURL: URL
    public let finalVideoURL: URL
    public let qaReportURL: URL
    public let packageManifestURL: URL
    public let previewURL: URL
    public let previewReceiptURL: URL
    public let receiptURL: URL
    public let finalMixURL: URL
}

public enum ProjectActiveDeliveryResolution: Equatable, Sendable {
    case absent
    case active(ProjectActiveDeliveryPaths)
    case invalid
}

public enum ProjectActiveDeliveryReader {
    public static func paths(projectURL: URL) -> ProjectActiveDeliveryPaths? {
        guard case let .active(paths) = resolution(projectURL: projectURL) else { return nil }
        return paths
    }

    public static func resolution(projectURL: URL) -> ProjectActiveDeliveryResolution {
        let project = projectURL.standardizedFileURL
        let pointerURL = project.appendingPathComponent("07_package/active_delivery.json")
        guard FileManager.default.fileExists(atPath: pointerURL.path) else { return .absent }
        guard let data = try? Data(contentsOf: pointerURL),
              let pointer = try? JSONDecoder().decode(Pointer.self, from: data),
              pointer.version == "active-delivery/v1",
              !pointer.projectID.isEmpty,
              ISO8601DateFormatter().date(from: pointer.activatedAt) != nil,
              pointer.generationID.range(of: #"^[a-f0-9]{24}$"#, options: .regularExpression) != nil,
              pointer.generationPath == "07_package/caption-finalize/generations/\(pointer.generationID)",
              pointer.hashesAreWellFormed
        else { return .invalid }

        let generationURL = project.appendingPathComponent(pointer.generationPath).standardizedFileURL
        let generationsRoot = project
            .appendingPathComponent("07_package/caption-finalize/generations")
            .standardizedFileURL
        guard isContained(generationURL, in: generationsRoot) else { return .invalid }

        guard let approvalURL = resolve(
            pointer.approvalIntent.path,
            projectURL: project,
            rootURL: project.appendingPathComponent("07_package/caption-finalize/intents")
        ),
        let captionASSURL = resolve(pointer.artifacts.captionASS.path, projectURL: project, rootURL: generationURL),
        let captionSRTURL = resolve(pointer.artifacts.captionSRT.path, projectURL: project, rootURL: generationURL),
        let finalVideoURL = resolve(pointer.artifacts.finalVideo.path, projectURL: project, rootURL: generationURL),
        let qaReportURL = resolve(pointer.artifacts.qaReport.path, projectURL: project, rootURL: generationURL),
        let manifestURL = resolve(pointer.artifacts.packageManifest.path, projectURL: project, rootURL: generationURL),
        let previewURL = resolve(pointer.artifacts.preview.path, projectURL: project, rootURL: generationURL),
        let previewReceiptURL = resolve(pointer.artifacts.previewReceipt.path, projectURL: project, rootURL: generationURL),
        let receiptURL = resolve(pointer.artifacts.receipt.path, projectURL: project, rootURL: generationURL)
        else { return .invalid }

        let required = [approvalURL, captionASSURL, captionSRTURL, finalVideoURL, qaReportURL,
                        manifestURL, previewURL, previewReceiptURL, receiptURL]
        guard required.allSatisfy(isRegularFile),
              verifyHash(pointer.approvalIntent, at: approvalURL),
              verifyHash(pointer.artifacts.captionASS, at: captionASSURL),
              verifyHash(pointer.artifacts.captionSRT, at: captionSRTURL),
              verifyHash(pointer.artifacts.qaReport, at: qaReportURL),
              verifyHash(pointer.artifacts.packageManifest, at: manifestURL),
              verifyHash(pointer.artifacts.previewReceipt, at: previewReceiptURL),
              verifyHash(pointer.artifacts.receipt, at: receiptURL),
              verifyVideoIdentity(pointer.artifacts.finalVideo, at: finalVideoURL),
              verifyVideoIdentity(pointer.artifacts.preview, at: previewURL),
              let receiptData = try? Data(contentsOf: receiptURL),
              let receipt = try? JSONDecoder().decode(FinalizeReceipt.self, from: receiptData),
              (receipt.version == "caption-finalize-receipt/v1"
                || receipt.version == "caption-finalize-receipt/v2"),
              receipt.generationID == pointer.generationID,
              receipt.approvalSHA256 == pointer.inputs.approvalSHA256,
              receipt.timelineSHA256 == pointer.inputs.timelineSHA256,
              receipt.verification.qaPassed,
              receipt.verification.packageReady,
              receipt.verification.packagePreflightVersion == "package-preflight/v2",
              receipt.verification.packagePreflightDecision == "ready_to_run",
              receipt.artifacts.matches(pointer: pointer),
              verifyPreviewReceipt(
                finalizeReceipt: receipt,
                pointer: pointer,
                previewReceiptURL: previewReceiptURL,
                generationURL: generationURL
              ),
              currentInputHashesMatch(pointer: pointer, projectURL: project)
        else { return .invalid }
        return .active(ProjectActiveDeliveryPaths(
            generationID: pointer.generationID,
            generationURL: generationURL,
            captionApprovalURL: approvalURL,
            captionASSURL: captionASSURL,
            captionSRTURL: captionSRTURL,
            finalVideoURL: finalVideoURL,
            qaReportURL: qaReportURL,
            packageManifestURL: manifestURL,
            previewURL: previewURL,
            previewReceiptURL: previewReceiptURL,
            receiptURL: receiptURL,
            finalMixURL: generationURL.appendingPathComponent("audio/final_mix.wav")
        ))
    }

    private static func resolve(_ relativePath: String, projectURL: URL, rootURL: URL) -> URL? {
        guard !relativePath.hasPrefix("/") else { return nil }
        let resolved = projectURL.appendingPathComponent(relativePath).standardizedFileURL
        guard isContained(resolved, in: rootURL.standardizedFileURL) else { return nil }
        let realResolved = resolved.resolvingSymlinksInPath().standardizedFileURL
        let realRoot = rootURL.resolvingSymlinksInPath().standardizedFileURL
        return isContained(realResolved, in: realRoot) ? resolved : nil
    }

    private static func isContained(_ candidate: URL, in root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path.hasSuffix("/")
            ? root.standardizedFileURL.path
            : root.standardizedFileURL.path + "/"
        return candidate.standardizedFileURL.path.hasPrefix(rootPath)
    }

    private static func isRegularFile(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
    }

    private static func verifyHash(_ artifact: Pointer.Artifact, at url: URL) -> Bool {
        guard !artifact.isVideo else { return false }
        return (try? BGMReviewSourceResolver.sha256(for: url)) == artifact.sha256
    }

    private static func verifyVideoIdentity(_ artifact: Pointer.Artifact, at url: URL) -> Bool {
        guard artifact.isVideo,
              let expectedSize = artifact.sizeBytes,
              let expectedMtime = artifact.mtimeMs,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attributes[.size] as? NSNumber)?.int64Value,
              let modificationDate = attributes[.modificationDate] as? Date
        else { return false }
        let mtimeMs = Int64((modificationDate.timeIntervalSince1970 * 1_000).rounded())
        return size == expectedSize && mtimeMs == expectedMtime
    }

    private static func verifyPreviewReceipt(
        finalizeReceipt: FinalizeReceipt,
        pointer: Pointer,
        previewReceiptURL: URL,
        generationURL: URL
    ) -> Bool {
        // v1 predates hash-bound preview/font identity and remains readable.
        guard finalizeReceipt.version == "caption-finalize-receipt/v2" else { return true }
        guard let data = try? Data(contentsOf: previewReceiptURL),
              let receipt = try? JSONDecoder().decode(PreviewReceipt.self, from: data),
              receipt.version == "caption-finalize-preview-receipt/v2",
              receipt.approvalSHA256 == pointer.inputs.approvalSHA256,
              receipt.timelineSHA256 == pointer.inputs.timelineSHA256,
              receipt.previewSHA256 == pointer.artifacts.preview.sha256,
              receipt.sourceFinalSHA256 == pointer.artifacts.finalVideo.sha256,
              receipt.previewSizeBytes == pointer.artifacts.preview.sizeBytes,
              receipt.previewMtimeMs == pointer.artifacts.preview.mtimeMs,
              receipt.sourceFinalSizeBytes == pointer.artifacts.finalVideo.sizeBytes,
              receipt.sourceFinalMtimeMs == pointer.artifacts.finalVideo.mtimeMs,
              let fontManifest = finalizeReceipt.artifacts.fontManifest,
              receipt.fontManifestSHA256 == fontManifest.sha256,
              let fontManifestURL = resolve(
                fontManifest.path,
                projectURL: generationURL
                    .deletingLastPathComponent()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent(),
                rootURL: generationURL
              ),
              verifyHash(fontManifest, at: fontManifestURL)
        else { return false }
        return true
    }

    private static func currentInputHashesMatch(pointer: Pointer, projectURL: URL) -> Bool {
        let timelineURL = projectURL.appendingPathComponent("05_timeline/timeline.json")
        if FileManager.default.fileExists(atPath: timelineURL.path),
           (try? BGMReviewSourceResolver.sha256(for: timelineURL)) != pointer.inputs.timelineSHA256 {
            return false
        }
        let approvalURL = projectURL.appendingPathComponent("07_package/caption_approval.json")
        if FileManager.default.fileExists(atPath: approvalURL.path),
           (try? BGMReviewSourceResolver.sha256(for: approvalURL)) != pointer.inputs.approvalSHA256 {
            return false
        }
        return true
    }
}

private struct Pointer: Decodable {
    struct Artifact: Decodable, Equatable {
        let path: String
        let sha256: String
        let sizeBytes: Int64?
        let mtimeMs: Int64?

        var hashIsWellFormed: Bool {
            sha256.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil
        }
        var isVideo: Bool { sizeBytes != nil && mtimeMs != nil }

        enum CodingKeys: String, CodingKey {
            case path, sha256
            case sizeBytes = "size_bytes"
            case mtimeMs = "mtime_ms"
        }
    }
    struct Artifacts: Decodable {
        let captionASS: Artifact
        let captionSRT: Artifact
        let finalVideo: Artifact
        let qaReport: Artifact
        let packageManifest: Artifact
        let preview: Artifact
        let previewReceipt: Artifact
        let receipt: Artifact

        enum CodingKeys: String, CodingKey {
            case captionASS = "caption_ass"
            case captionSRT = "caption_srt"
            case finalVideo = "final_video"
            case qaReport = "qa_report"
            case packageManifest = "package_manifest"
            case preview
            case previewReceipt = "preview_receipt"
            case receipt
        }
    }

    let version: String
    let projectID: String
    let generationID: String
    let generationPath: String
    let activatedAt: String
    let approvalIntent: Artifact
    let inputs: Inputs
    let artifacts: Artifacts

    struct Inputs: Decodable {
        let approvalSHA256: String
        let timelineSHA256: String
        let generationKey: String

        enum CodingKeys: String, CodingKey {
            case approvalSHA256 = "approval_sha256"
            case timelineSHA256 = "timeline_sha256"
            case generationKey = "generation_key"
        }
    }

    var hashesAreWellFormed: Bool {
        let inputHashes = [inputs.approvalSHA256, inputs.timelineSHA256, inputs.generationKey]
        return inputHashes.allSatisfy { $0.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil }
            && approvalIntent.hashIsWellFormed
            && artifacts.all.allSatisfy(\.hashIsWellFormed)
    }

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case generationID = "generation_id"
        case generationPath = "generation_path"
        case activatedAt = "activated_at"
        case approvalIntent = "approval_intent"
        case inputs
        case artifacts
    }
}

private extension Pointer.Artifacts {
    var all: [Pointer.Artifact] {
        [captionASS, captionSRT, finalVideo, qaReport, packageManifest, preview, previewReceipt, receipt]
    }
}

private struct FinalizeReceipt: Decodable {
    struct Artifacts: Decodable {
        let approvalIntent: Pointer.Artifact
        let captionASS: Pointer.Artifact
        let captionSRT: Pointer.Artifact
        let finalVideo: Pointer.Artifact
        let qaReport: Pointer.Artifact
        let packageManifest: Pointer.Artifact
        let preview: Pointer.Artifact
        let previewReceipt: Pointer.Artifact
        let fontManifest: Pointer.Artifact?

        enum CodingKeys: String, CodingKey {
            case approvalIntent = "approval_intent"
            case captionASS = "caption_ass"
            case captionSRT = "caption_srt"
            case finalVideo = "final_video"
            case qaReport = "qa_report"
            case packageManifest = "package_manifest"
            case preview, previewReceipt = "preview_receipt"
            case fontManifest = "font_manifest"
        }

        func matches(pointer: Pointer) -> Bool {
            approvalIntent == pointer.approvalIntent
                && captionASS == pointer.artifacts.captionASS
                && captionSRT == pointer.artifacts.captionSRT
                && finalVideo == pointer.artifacts.finalVideo
                && qaReport == pointer.artifacts.qaReport
                && packageManifest == pointer.artifacts.packageManifest
                && preview == pointer.artifacts.preview
                && previewReceipt == pointer.artifacts.previewReceipt
        }
    }

    struct Verification: Decodable {
        let qaPassed: Bool
        let packageReady: Bool
        let packagePreflightVersion: String
        let packagePreflightDecision: String

        enum CodingKeys: String, CodingKey {
            case qaPassed = "qa_passed"
            case packageReady = "package_ready"
            case packagePreflightVersion = "package_preflight_version"
            case packagePreflightDecision = "package_preflight_decision"
        }
    }

    let version: String
    let generationID: String
    let approvalSHA256: String
    let timelineSHA256: String
    let artifacts: Artifacts
    let verification: Verification

    enum CodingKeys: String, CodingKey {
        case version, artifacts, verification
        case generationID = "generation_id"
        case approvalSHA256 = "approval_sha256"
        case timelineSHA256 = "timeline_sha256"
    }
}

private struct PreviewReceipt: Decodable {
    let version: String
    let sourceFinalSHA256: String
    let sourceFinalSizeBytes: Int64
    let sourceFinalMtimeMs: Int64
    let previewSHA256: String
    let previewSizeBytes: Int64
    let previewMtimeMs: Int64
    let approvalSHA256: String
    let timelineSHA256: String
    let fontManifestSHA256: String

    enum CodingKeys: String, CodingKey {
        case version
        case sourceFinalSHA256 = "source_final_sha256"
        case sourceFinalSizeBytes = "source_final_size_bytes"
        case sourceFinalMtimeMs = "source_final_mtime_ms"
        case previewSHA256 = "preview_sha256"
        case previewSizeBytes = "preview_size_bytes"
        case previewMtimeMs = "preview_mtime_ms"
        case approvalSHA256 = "approval_sha256"
        case timelineSHA256 = "timeline_sha256"
        case fontManifestSHA256 = "font_manifest_sha256"
    }
}
