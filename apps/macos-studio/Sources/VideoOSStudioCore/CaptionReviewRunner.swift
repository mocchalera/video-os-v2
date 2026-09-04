import Foundation

public struct CaptionReviewActionResult: Equatable, Sendable {
    public let success: Bool
    public let message: String
    public let approvalHash: String?
    public let approvalStatus: String?
    public let generationID: String?
    public let finalPath: String?

    public init(success: Bool, message: String, approvalHash: String? = nil, approvalStatus: String? = nil, generationID: String? = nil, finalPath: String? = nil) {
        self.success = success
        self.message = message
        self.approvalHash = approvalHash
        self.approvalStatus = approvalStatus
        self.generationID = generationID
        self.finalPath = finalPath
    }
}

public struct CaptionVisualReviewActionResult: Equatable, Sendable {
    public let success: Bool
    public let message: String
    public let document: CaptionVisualReviewDocument?

    public init(success: Bool, message: String, document: CaptionVisualReviewDocument? = nil) {
        self.success = success
        self.message = message
        self.document = document
    }
}

public struct CaptionCanonicalPreviewActionResult: Equatable, Sendable {
    public let success: Bool
    public let message: String
    public let document: CaptionCanonicalPreviewDocument?

    public init(success: Bool, message: String, document: CaptionCanonicalPreviewDocument? = nil) {
        self.success = success
        self.message = message
        self.document = document
    }
}

public struct CaptionReviewRunnerError: Error, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}

public enum CaptionReviewRunner {
    public static func load(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String = ""
    ) async -> Result<CaptionReviewQueueDocument, CaptionReviewRunnerError> {
        await Task.detached(priority: .userInitiated) {
            do {
                let output = try SubprocessRunner.run(
                    arguments: queueArguments(projectURL: projectURL, reviewer: reviewer),
                    currentDirectoryURL: repositoryRoot
                )
                guard output.exitCode == 0 else {
                    return .failure(CaptionReviewRunnerError(
                        processFailureReason(command: "caption review queue", output: output)
                    ))
                }
                do {
                    let document = try JSONDecoder().decode(
                        CaptionReviewQueueDocument.self,
                        from: Data(output.stdout.utf8)
                    )
                    return .success(document)
                } catch {
                    return .failure(CaptionReviewRunnerError("Invalid caption review queue JSON: \(error)"))
                }
            } catch {
                return .failure(CaptionReviewRunnerError("Caption review queue failed to run: \(error)"))
            }
        }.value
    }

    public static func initializeIfNeeded(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String
    ) async -> CaptionReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            let patchURL = projectURL
                .appendingPathComponent("07_package", isDirectory: true)
                .appendingPathComponent("caption_review_patch.json")
            if FileManager.default.fileExists(atPath: patchURL.path) {
                return CaptionReviewActionResult(success: true, message: "字幕レビューを再開しました。")
            }
            return runAction(
                command: "caption review init",
                arguments: initializeArguments(projectURL: projectURL, reviewer: reviewer),
                repositoryRoot: repositoryRoot,
                successMessage: "字幕レビューを開始しました。"
            )
        }.value
    }

    public static func edit(
        projectURL: URL,
        repositoryRoot: URL,
        captionID: String,
        text: String,
        startFrame: Int,
        endFrame: Int,
        expectedTextHash: String,
        state: CaptionReviewState,
        reviewer: String
    ) async -> CaptionReviewActionResult {
        let initialized = await initializeIfNeeded(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: reviewer
        )
        guard initialized.success else { return initialized }
        return await Task.detached(priority: .userInitiated) {
            runAction(
                command: "caption review edit",
                arguments: editArguments(
                    projectURL: projectURL,
                    captionID: captionID,
                    text: text,
                    startFrame: startFrame,
                    endFrame: endFrame,
                    expectedTextHash: expectedTextHash,
                    state: state
                ),
                repositoryRoot: repositoryRoot,
                successMessage: "\(captionID)を保存しました。"
            )
        }.value
    }

    public static func split(
        projectURL: URL,
        repositoryRoot: URL,
        captionID: String,
        splitFrame: Int,
        expectedTextHash: String,
        reviewer: String
    ) async -> CaptionReviewActionResult {
        let initialized = await initializeIfNeeded(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: reviewer
        )
        guard initialized.success else { return initialized }
        return await Task.detached(priority: .userInitiated) {
            runAction(
                command: "caption review split",
                arguments: splitArguments(
                    projectURL: projectURL,
                    captionID: captionID,
                    splitFrame: splitFrame,
                    expectedTextHash: expectedTextHash
                ),
                repositoryRoot: repositoryRoot,
                successMessage: "\(captionID)を分割しました。"
            )
        }.value
    }

    public static func merge(
        projectURL: URL,
        repositoryRoot: URL,
        first: CaptionReviewQueueItem,
        second: CaptionReviewQueueItem,
        reviewer: String
    ) async -> CaptionReviewActionResult {
        let initialized = await initializeIfNeeded(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: reviewer
        )
        guard initialized.success else { return initialized }
        return await Task.detached(priority: .userInitiated) {
            runAction(
                command: "caption review merge",
                arguments: mergeArguments(projectURL: projectURL, first: first, second: second),
                repositoryRoot: repositoryRoot,
                successMessage: "\(first.captionID)と\(second.captionID)を結合しました。"
            )
        }.value
    }

    public static func undo(
        projectURL: URL,
        repositoryRoot: URL
    ) async -> CaptionReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            runAction(
                command: "caption review undo",
                arguments: undoArguments(projectURL: projectURL),
                repositoryRoot: repositoryRoot,
                successMessage: "直前の字幕編集を取り消しました。"
            )
        }.value
    }

    public static func proposeGlossaryTerm(
        projectURL: URL,
        repositoryRoot: URL,
        captionID: String,
        canonical: String,
        variants: [String],
        reviewer: String
    ) async -> CaptionReviewActionResult {
        let initialized = await initializeIfNeeded(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot,
            reviewer: reviewer
        )
        guard initialized.success else { return initialized }
        return await Task.detached(priority: .userInitiated) {
            runAction(
                command: "caption review glossary-propose",
                arguments: glossaryProposalArguments(
                    projectURL: projectURL,
                    captionID: captionID,
                    canonical: canonical,
                    variants: variants
                ),
                repositoryRoot: repositoryRoot,
                successMessage: "「\(canonical)」をプロジェクト用語集候補へ追加しました。"
            )
        }.value
    }

    public static func approve(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String
    ) async -> CaptionReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            runAction(
                command: "caption review approve",
                arguments: approveArguments(projectURL: projectURL, reviewer: reviewer),
                repositoryRoot: repositoryRoot,
                successMessage: "字幕を承認しました。"
            )
        }.value
    }

    public static func prepareDraft(projectURL: URL, repositoryRoot: URL) async -> CaptionReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            runAction(command: "caption review prepare", arguments: prepareArguments(projectURL: projectURL), repositoryRoot: repositoryRoot, successMessage: "字幕ドラフトを準備しました。")
        }.value
    }

    public static func verifySafe(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String,
        baseCaptionDraftHash: String,
        items: [CaptionReviewQueueItem]
    ) async -> CaptionReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            runAction(command: "caption review verify-safe", arguments: verifySafeArguments(projectURL: projectURL, reviewer: reviewer, baseCaptionDraftHash: baseCaptionDraftHash, items: items), repositoryRoot: repositoryRoot, successMessage: "安全な字幕を一括確認しました。")
        }.value
    }

    public static func finalize(projectURL: URL, repositoryRoot: URL) async -> CaptionReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            runAction(command: "caption finalize", arguments: finalizeArguments(projectURL: projectURL), repositoryRoot: repositoryRoot, successMessage: "承認字幕で再レンダーしました。")
        }.value
    }

    public static func initializeVisualReview(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String,
        typographyPolicyURL: URL? = nil
    ) async -> CaptionVisualReviewActionResult {
        await runVisualCommand(
            command: "caption review visual-init",
            arguments: visualInitArguments(projectURL: projectURL, reviewer: reviewer, typographyPolicyURL: typographyPolicyURL),
            repositoryRoot: repositoryRoot,
            successMessage: "グラフィカル字幕レビューを開始しました。"
        )
    }

    public static func visualStatus(
        projectURL: URL,
        repositoryRoot: URL,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) async -> CaptionVisualReviewActionResult {
        await runVisualCommand(
            command: "caption review visual-status",
            arguments: visualStatusArguments(
                projectURL: projectURL,
                typographyPolicyURL: typographyPolicyURL,
                safeZoneProfileURL: safeZoneProfileURL,
                accessibility: accessibility
            ),
            repositoryRoot: repositoryRoot,
            successMessage: "canonical字幕visual stateを読み込みました。"
        )
    }

    public static func previewVisualTreatment(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) async -> CaptionVisualReviewActionResult {
        await runVisualCommand(
            command: "caption review visual-preview",
            arguments: visualPreviewArguments(
                projectURL: projectURL,
                reviewer: reviewer,
                expectedPatchHash: expectedPatchHash,
                typographyPolicyURL: typographyPolicyURL,
                safeZoneProfileURL: safeZoneProfileURL,
                accessibility: accessibility
            ),
            repositoryRoot: repositoryRoot,
            successMessage: "candidate canonical preview receiptを更新しました。"
        )
    }

    public static func applyVisualTreatment(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String,
        operation: CaptionVisualTreatmentOperation,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) async -> CaptionVisualReviewActionResult {
        await runVisualCommand(
            command: "caption review visual-apply",
            arguments: visualApplyArguments(
                projectURL: projectURL,
                reviewer: reviewer,
                operation: operation,
                expectedPatchHash: expectedPatchHash,
                typographyPolicyURL: typographyPolicyURL,
                safeZoneProfileURL: safeZoneProfileURL,
                accessibility: accessibility
            ),
            repositoryRoot: repositoryRoot,
            successMessage: "グラフィカル字幕patchを保存しました。"
        )
    }

    public static func undoVisualTreatment(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) async -> CaptionVisualReviewActionResult {
        await runVisualCommand(
            command: "caption review visual-undo",
            arguments: visualUndoArguments(
                projectURL: projectURL,
                reviewer: reviewer,
                expectedPatchHash: expectedPatchHash,
                typographyPolicyURL: typographyPolicyURL,
                safeZoneProfileURL: safeZoneProfileURL,
                accessibility: accessibility
            ),
            repositoryRoot: repositoryRoot,
            successMessage: "グラフィカル字幕patchを1操作戻しました。"
        )
    }

    public static func approveVisualTreatment(
        projectURL: URL,
        repositoryRoot: URL,
        reviewer: String,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) async -> CaptionVisualReviewActionResult {
        await runVisualCommand(
            command: "caption review visual-approve",
            arguments: visualApproveArguments(
                projectURL: projectURL,
                reviewer: reviewer,
                expectedPatchHash: expectedPatchHash,
                typographyPolicyURL: typographyPolicyURL,
                safeZoneProfileURL: safeZoneProfileURL,
                accessibility: accessibility
            ),
            repositoryRoot: repositoryRoot,
            successMessage: "グラフィカル字幕を人間承認しました。"
        )
    }

    public static func refreshCanonicalPreview(
        projectURL: URL,
        repositoryRoot: URL
    ) async -> CaptionCanonicalPreviewActionResult {
        await Task.detached(priority: .userInitiated) {
            do {
                let output = try SubprocessRunner.run(
                    arguments: canonicalPreviewArguments(projectURL: projectURL),
                    currentDirectoryURL: repositoryRoot
                )
                guard output.exitCode == 0 else {
                    return CaptionCanonicalPreviewActionResult(
                        success: false,
                        message: processFailureReason(command: "canonical preview", output: output)
                    )
                }
                guard let document = canonicalPreviewDocument(projectURL: projectURL) else {
                    return CaptionCanonicalPreviewActionResult(
                        success: false,
                        message: "canonical preview receiptが生成されませんでした。"
                    )
                }
                return CaptionCanonicalPreviewActionResult(
                    success: true,
                    message: "canonical previewを更新しました。",
                    document: document
                )
            } catch {
                return CaptionCanonicalPreviewActionResult(success: false, message: "canonical preview failed to run: \(error)")
            }
        }.value
    }

    public static func queueArguments(projectURL: URL, reviewer: String = "") -> [String] {
        var arguments = [
            "npx", "tsx", "scripts/caption-review.ts", "queue",
            "--project", projectURL.path,
            "--format", "json",
            "--severity", "all",
        ]
        if !reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            arguments.append(contentsOf: ["--reviewer", reviewer])
        }
        return arguments
    }

    public static func prepareArguments(projectURL: URL) -> [String] {
        ["npx", "tsx", "scripts/caption-review.ts", "prepare", "--project", projectURL.path]
    }

    public static func verifySafeArguments(projectURL: URL, reviewer: String, baseCaptionDraftHash: String, items: [CaptionReviewQueueItem]) -> [String] {
        var arguments = ["npx", "tsx", "scripts/caption-review.ts", "verify-safe", "--project", projectURL.path, "--reviewer", reviewer, "--base-caption-draft-hash", baseCaptionDraftHash]
        for item in items.sorted(by: { $0.captionID < $1.captionID }) {
            arguments.append(contentsOf: ["--caption-text-hash", "\(item.captionID)=\(item.textHash)"])
        }
        return arguments
    }

    public static func finalizeArguments(projectURL: URL) -> [String] {
        ["npx", "tsx", "scripts/caption-finalize.ts", "run", "--project", projectURL.path, "--json"]
    }

    public static func visualInitArguments(projectURL: URL, reviewer: String, typographyPolicyURL: URL? = nil) -> [String] {
        var arguments = ["npx", "tsx", "scripts/caption-review.ts", "visual-init", "--project", projectURL.path, "--reviewer", reviewer]
        if let typographyPolicyURL { arguments.append(contentsOf: ["--typography-policy", typographyPolicyURL.path]) }
        return arguments
    }

    public static func visualStatusArguments(
        projectURL: URL,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) -> [String] {
        var arguments = ["npx", "tsx", "scripts/caption-review.ts", "visual-status", "--project", projectURL.path]
        appendVisualContextArguments(&arguments, typographyPolicyURL: typographyPolicyURL, safeZoneProfileURL: safeZoneProfileURL, accessibility: accessibility)
        return arguments
    }

    public static func visualPreviewArguments(
        projectURL: URL,
        reviewer: String,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) -> [String] {
        var arguments = [
            "npx", "tsx", "scripts/caption-review.ts", "visual-preview",
            "--project", projectURL.path,
            "--reviewer", reviewer,
            "--expected-patch-hash", expectedPatchHash,
        ]
        appendVisualContextArguments(&arguments, typographyPolicyURL: typographyPolicyURL, safeZoneProfileURL: safeZoneProfileURL, accessibility: accessibility)
        return arguments
    }

    public static func visualApplyArguments(
        projectURL: URL,
        reviewer: String,
        operation: CaptionVisualTreatmentOperation,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) -> [String] {
        var arguments = [
            "npx", "tsx", "scripts/caption-review.ts", "visual-apply",
            "--project", projectURL.path,
            "--reviewer", reviewer,
            "--expected-patch-hash", expectedPatchHash,
            "--visual-operation-json", encodedVisualOperation(operation),
        ]
        appendVisualContextArguments(&arguments, typographyPolicyURL: typographyPolicyURL, safeZoneProfileURL: safeZoneProfileURL, accessibility: accessibility)
        return arguments
    }

    public static func visualUndoArguments(
        projectURL: URL,
        reviewer: String,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) -> [String] {
        var arguments = [
            "npx", "tsx", "scripts/caption-review.ts", "visual-undo",
            "--project", projectURL.path,
            "--reviewer", reviewer,
            "--expected-patch-hash", expectedPatchHash,
        ]
        appendVisualContextArguments(&arguments, typographyPolicyURL: typographyPolicyURL, safeZoneProfileURL: safeZoneProfileURL, accessibility: accessibility)
        return arguments
    }

    public static func visualApproveArguments(
        projectURL: URL,
        reviewer: String,
        expectedPatchHash: String,
        typographyPolicyURL: URL? = nil,
        safeZoneProfileURL: URL? = nil,
        accessibility: CaptionVisualAccessibility? = nil
    ) -> [String] {
        var arguments = ["npx", "tsx", "scripts/caption-review.ts", "visual-approve", "--project", projectURL.path, "--reviewer", reviewer, "--expected-patch-hash", expectedPatchHash, "--preapproval-receipt", projectURL.appendingPathComponent("07_package", isDirectory: true).appendingPathComponent("caption_visual_treatment_preapproval_receipt.json").path]
        appendVisualContextArguments(&arguments, typographyPolicyURL: typographyPolicyURL, safeZoneProfileURL: safeZoneProfileURL, accessibility: accessibility)
        return arguments
    }

    public static func canonicalPreviewArguments(projectURL: URL) -> [String] {
        ["npx", "tsx", "scripts/preview-segment.ts", projectURL.path, "--baseline-fast", "--first-n-sec", "30"]
    }

    public static func initializeArguments(projectURL: URL, reviewer: String) -> [String] {
        [
            "npx", "tsx", "scripts/caption-review.ts", "init",
            "--project", projectURL.path,
            "--reviewer", reviewer,
        ]
    }

    public static func editArguments(
        projectURL: URL,
        captionID: String,
        text: String,
        startFrame: Int,
        endFrame: Int,
        expectedTextHash: String,
        state: CaptionReviewState
    ) -> [String] {
        [
            "npx", "tsx", "scripts/caption-review.ts", "edit",
            "--project", projectURL.path,
            "--caption-id", captionID,
            "--text", text,
            "--start-frame", String(startFrame),
            "--end-frame", String(endFrame),
            "--base-text-hash", expectedTextHash,
            "--state", state.rawValue,
            "--category", "other",
        ]
    }

    public static func splitArguments(
        projectURL: URL,
        captionID: String,
        splitFrame: Int,
        expectedTextHash: String
    ) -> [String] {
        [
            "npx", "tsx", "scripts/caption-review.ts", "split",
            "--project", projectURL.path,
            "--caption-id", captionID,
            "--split-frame", String(splitFrame),
            "--base-text-hash", expectedTextHash,
        ]
    }

    public static func mergeArguments(
        projectURL: URL,
        first: CaptionReviewQueueItem,
        second: CaptionReviewQueueItem
    ) -> [String] {
        [
            "npx", "tsx", "scripts/caption-review.ts", "merge",
            "--project", projectURL.path,
            "--caption-id", first.captionID,
            "--next-caption-id", second.captionID,
            "--base-text-hash", first.textHash,
            "--next-base-text-hash", second.textHash,
        ]
    }

    public static func undoArguments(projectURL: URL) -> [String] {
        [
            "npx", "tsx", "scripts/caption-review.ts", "undo",
            "--project", projectURL.path,
        ]
    }

    public static func glossaryProposalArguments(
        projectURL: URL,
        captionID: String,
        canonical: String,
        variants: [String]
    ) -> [String] {
        var arguments = [
            "npx", "tsx", "scripts/caption-review.ts", "glossary-propose",
            "--project", projectURL.path,
            "--caption-id", captionID,
            "--canonical", canonical,
        ]
        for variant in variants where !variant.isEmpty {
            arguments.append(contentsOf: ["--variant", variant])
        }
        return arguments
    }

    public static func approveArguments(projectURL: URL, reviewer: String) -> [String] {
        [
            "npx", "tsx", "scripts/caption-review.ts", "approve",
            "--project", projectURL.path,
            "--reviewer", reviewer,
        ]
    }

    private static func runAction(
        command: String,
        arguments: [String],
        repositoryRoot: URL,
        successMessage: String
    ) -> CaptionReviewActionResult {
        do {
            let output = try SubprocessRunner.run(
                arguments: arguments,
                currentDirectoryURL: repositoryRoot
            )
            guard output.exitCode == 0 else {
                return CaptionReviewActionResult(
                    success: false,
                    message: processFailureReason(command: command, output: output)
                )
            }
            return decodeSuccessPayload(output.stdout, successMessage: successMessage)
        } catch {
            return CaptionReviewActionResult(success: false, message: "\(command) failed to run: \(error)")
        }
    }

    private static func runVisualCommand(
        command: String,
        arguments: [String],
        repositoryRoot: URL,
        successMessage: String
    ) async -> CaptionVisualReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            do {
                let output = try SubprocessRunner.run(
                    arguments: arguments,
                    currentDirectoryURL: repositoryRoot
                )
                guard output.exitCode == 0 else {
                    return CaptionVisualReviewActionResult(
                        success: false,
                        message: processFailureReason(command: command, output: output)
                    )
                }
                guard let data = output.stdout.data(using: .utf8) else {
                    return CaptionVisualReviewActionResult(success: false, message: "\(command) returned invalid UTF-8 JSON.")
                }
                do {
                    let document = try JSONDecoder().decode(CaptionVisualReviewDocument.self, from: data)
                    return CaptionVisualReviewActionResult(success: true, message: successMessage, document: document)
                } catch {
                    return CaptionVisualReviewActionResult(success: false, message: "Invalid \(command) JSON: \(error)")
                }
            } catch {
                return CaptionVisualReviewActionResult(success: false, message: "\(command) failed to run: \(error)")
            }
        }.value
    }

    private static func appendVisualContextArguments(
        _ arguments: inout [String],
        typographyPolicyURL: URL?,
        safeZoneProfileURL: URL?,
        accessibility: CaptionVisualAccessibility?
    ) {
        if let typographyPolicyURL {
            arguments.append(contentsOf: ["--typography-policy", typographyPolicyURL.path])
        }
        if let safeZoneProfileURL {
            arguments.append(contentsOf: ["--safe-zone-profile", safeZoneProfileURL.path])
        }
        guard let accessibility else { return }
        if accessibility.reducedMotion { arguments.append("--reduced-motion") }
        if accessibility.highContrast { arguments.append("--high-contrast") }
        if accessibility.audioOff { arguments.append("--audio-off") }
        if accessibility.smallScreen { arguments.append("--small-screen") }
    }

    private static func encodedVisualOperation(_ operation: CaptionVisualTreatmentOperation) -> String {
        guard let data = try? JSONEncoder().encode(operation),
              let value = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return value
    }

    private static func canonicalPreviewDocument(projectURL: URL) -> CaptionCanonicalPreviewDocument? {
        let outputURL = projectURL
            .appendingPathComponent("05_timeline", isDirectory: true)
            .appendingPathComponent("preview-baseline-fast-first30s.mp4")
        let receiptURL = URL(fileURLWithPath: "\(outputURL.path).receipt.json")
        let routeReceiptURL = URL(fileURLWithPath: "\(outputURL.path).render-route.json")
        guard let data = try? Data(contentsOf: receiptURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }

        let inputs = root["inputs"] as? [String: Any]
        let inputVisual = inputs?["caption_visual_treatment"] as? [String: Any]
        let parity = root["parity"] as? [String: Any]
        let parityVisual = parity?["caption_visual_treatment"] as? [String: Any]
        let actualOutput = root["actual_output"] as? [String: Any]
        let routeReceipt = root["canonical_route_receipt"] as? [String: Any]
        let status = (parityVisual?["status"] as? String).flatMap(CaptionVisualTreatmentStatus.init(rawValue:))
        let parityMatches = parityVisual?["matches"] as? Bool

        return CaptionCanonicalPreviewDocument(
            outputPath: actualOutput?["path"] as? String ?? outputURL.path,
            receiptPath: receiptURL.path,
            routeReceiptPath: routeReceipt?["path"] as? String ?? (FileManager.default.fileExists(atPath: routeReceiptURL.path) ? routeReceiptURL.path : nil),
            visualInputHash: parityVisual?["resolved_input_hash"] as? String ?? inputVisual?["input_hash"] as? String,
            approvalHash: parityVisual?["approval_hash"] as? String ?? inputVisual?["approval_hash"] as? String,
            visualTreatmentPatchHash: parityVisual?["visual_treatment_patch_hash"] as? String ?? inputVisual?["visual_treatment_patch_hash"] as? String,
            typographyPolicyHash: parityVisual?["typography_policy_hash"] as? String ?? inputVisual?["typography_policy_hash"] as? String,
            platformSafeZoneProfileID: parityVisual?["platform_safe_zone_profile_id"] as? String ?? inputVisual?["platform_safe_zone_profile_id"] as? String,
            platformSafeZoneProfilePath: parityVisual?["platform_safe_zone_profile_path"] as? String ?? inputVisual?["platform_safe_zone_profile_path"] as? String,
            platformSafeZoneProfileHash: parityVisual?["platform_safe_zone_profile_hash"] as? String ?? inputVisual?["platform_safe_zone_profile_hash"] as? String,
            textTimingHash: parityVisual?["text_timing_hash"] as? String ?? inputVisual?["text_timing_hash"] as? String,
            capabilityHash: parityVisual?["capability_hash"] as? String ?? inputVisual?["capability_hash"] as? String,
            visualStatus: status,
            parityStatus: parity?["status"] as? String,
            parityMatches: parityMatches
        )
    }

    public static func decodeSuccessPayload(
        _ stdout: String,
        successMessage: String
    ) -> CaptionReviewActionResult {
        let payload = (try? JSONSerialization.jsonObject(with: Data(stdout.utf8))) as? [String: Any]
        let active = (payload?["active_delivery"] ?? payload?["activeDelivery"]) as? [String: Any]
        let artifacts = active?["artifacts"] as? [String: Any]
        let final = artifacts?["final_video"] as? [String: Any]
        return CaptionReviewActionResult(
            success: true,
            message: successMessage,
            approvalHash: payload?["approval_hash"] as? String,
            approvalStatus: payload?["status"] as? String,
            generationID: (payload?["generation_id"] ?? payload?["generationId"]) as? String,
            finalPath: final?["path"] as? String
        )
    }

    private static func processFailureReason(
        command: String,
        output: SubprocessRunner.Output
    ) -> String {
        let diagnostic = [output.stderr, output.stdout]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        let detail = diagnostic.map { value in
            value.count > 360 ? "\(value.prefix(360))..." : value
        }
        if let detail {
            return "\(command) exited with code \(output.exitCode): \(detail)"
        }
        return "\(command) exited with code \(output.exitCode)"
    }
}
