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
