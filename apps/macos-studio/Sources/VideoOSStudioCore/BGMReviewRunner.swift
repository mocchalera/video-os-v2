import Foundation

public struct BGMReviewActionResult: Equatable, Sendable {
    public let success: Bool
    public let message: String
    public let promotionEligible: Bool

    public init(success: Bool, message: String, promotionEligible: Bool = false) {
        self.success = success
        self.message = message
        self.promotionEligible = promotionEligible
    }
}

private struct BGMReviewCLIResponse: Decodable {
    let ok: Bool
    let candidateID: String?
    let promotionEligible: Bool?

    enum CodingKeys: String, CodingKey {
        case ok
        case candidateID = "candidate_id"
        case promotionEligible = "promotion_eligible"
    }
}

public enum BGMReviewRunner {
    public static func save(
        queueURL: URL,
        repositoryRoot: URL,
        candidateID: String,
        reviewer: String,
        musicalFit: BGMMusicalFit,
        dialogueBed: BGMPassFailReview,
        artifactQuality: BGMPassFailReview,
        originality: BGMOriginalityReview,
        rights: BGMRightsReview,
        notes: [String]
    ) async -> BGMReviewActionResult {
        await Task.detached(priority: .userInitiated) {
            do {
                let output = try SubprocessRunner.run(
                    arguments: reviewArguments(
                        queueURL: queueURL,
                        candidateID: candidateID,
                        reviewer: reviewer,
                        musicalFit: musicalFit,
                        dialogueBed: dialogueBed,
                        artifactQuality: artifactQuality,
                        originality: originality,
                        rights: rights,
                        notes: notes
                    ),
                    currentDirectoryURL: repositoryRoot
                )
                guard output.exitCode == 0 else {
                    return BGMReviewActionResult(success: false, message: processFailureReason(output: output))
                }
                guard let data = output.stdout.data(using: .utf8),
                      let response = try? JSONDecoder().decode(BGMReviewCLIResponse.self, from: data),
                      response.ok,
                      response.candidateID == candidateID else {
                    return BGMReviewActionResult(success: false, message: "BGMレビュー保存結果を確認できませんでした。")
                }
                return BGMReviewActionResult(
                    success: true,
                    message: response.promotionEligible == true
                        ? "レビューを保存しました。採用候補ゲートを通過しています（公開許諾は別途必要です）。"
                        : "レビューを保存しました。未通過の確認ゲートがあります。",
                    promotionEligible: response.promotionEligible == true
                )
            } catch {
                return BGMReviewActionResult(success: false, message: "BGMレビューを保存できませんでした: \(error)")
            }
        }.value
    }

    public static func reviewArguments(
        queueURL: URL,
        candidateID: String,
        reviewer: String,
        musicalFit: BGMMusicalFit,
        dialogueBed: BGMPassFailReview,
        artifactQuality: BGMPassFailReview,
        originality: BGMOriginalityReview,
        rights: BGMRightsReview,
        notes: [String]
    ) -> [String] {
        var arguments = [
            "npx", "tsx", "scripts/bgm-shortlist.ts", "review",
            "--queue", queueURL.path,
            "--candidate", candidateID,
            "--reviewer", reviewer,
            "--musical-fit", musicalFit.rawValue,
            "--dialogue-bed", dialogueBed.rawValue,
            "--artifact-quality", artifactQuality.rawValue,
            "--originality", originality.rawValue,
            "--rights", rights.rawValue,
        ]
        for note in notes {
            arguments.append(contentsOf: ["--note", note])
        }
        arguments.append("--json")
        return arguments
    }

    private static func processFailureReason(output: SubprocessRunner.Output) -> String {
        let diagnostic = [output.stderr, output.stdout]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        if let diagnostic {
            let detail = diagnostic.count > 360 ? "\(diagnostic.prefix(360))..." : diagnostic
            return "BGMレビュー保存に失敗しました（終了コード\(output.exitCode)）: \(detail)"
        }
        return "BGMレビュー保存に失敗しました（終了コード\(output.exitCode)）。"
    }
}
