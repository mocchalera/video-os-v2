import Foundation

public struct VideoOSAgentJobReadiness: Equatable, Sendable {
    public let canRun: Bool
    public let label: String

    public init(canRun: Bool, label: String) {
        self.canRun = canRun
        self.label = label
    }
}

public enum VideoOSAgentJobReadinessResolver {
    public static func readiness(
        for job: VideoOSAgentJob,
        hasActiveThread: Bool,
        project: ProjectSummary?,
        planningStatus: ProjectPlanningStatus?,
        selectedTimelineClipAvailable: Bool = false
    ) -> VideoOSAgentJobReadiness {
        guard hasActiveThread else {
            return VideoOSAgentJobReadiness(canRun: false, label: "ジョブを実行する前にエージェントセッションを開始してください。")
        }
        guard let project else {
            return VideoOSAgentJobReadiness(canRun: false, label: "ジョブを実行する前にプロジェクトを選択してください。")
        }

        switch job {
        case .status:
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        case .validate:
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        case .clipAnnotation:
            guard selectedTimelineClipAvailable else {
                return VideoOSAgentJobReadiness(canRun: false, label: "この読み取り専用ジョブを実行する前にタイムラインのクリップを選択してください。")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        case .triage:
            guard let planningStatus else {
                return VideoOSAgentJobReadiness(canRun: false, label: "設計状況がまだ読み込まれていません。")
            }
            guard planningStatus.hasCreativeBrief else {
                return VideoOSAgentJobReadiness(canRun: false, label: "候補抽出には creative_brief が必要です。")
            }
            guard planningStatus.analysisReady else {
                return VideoOSAgentJobReadiness(canRun: false, label: "候補抽出には解析済みの素材とセグメントが必要です。")
            }
            guard planningStatus.dialogueEvidenceReady else {
                return VideoOSAgentJobReadiness(canRun: false, label: "候補抽出には文字起こしと音声ストーリー根拠が必要です。先に音声解析を実行してください。")
            }
            let label = planningStatus.hasSelects
                ? "selects_candidates.yaml は既にあります。解析根拠が変わった場合だけ再実行してください。"
                : job.approvalSummary
            return VideoOSAgentJobReadiness(canRun: true, label: label)
        case .blueprint:
            guard let planningStatus else {
                return VideoOSAgentJobReadiness(canRun: false, label: "設計状況がまだ読み込まれていません。")
            }
            guard planningStatus.hasCreativeBrief else {
                return VideoOSAgentJobReadiness(canRun: false, label: "構成設計には creative_brief が必要です。")
            }
            guard planningStatus.hasUnresolvedBlockers else {
                return VideoOSAgentJobReadiness(canRun: false, label: "構成設計には意図整理で作成された unresolved_blockers.yaml が必要です。")
            }
            guard planningStatus.hasSelects else {
                return VideoOSAgentJobReadiness(canRun: false, label: "構成設計には selects_candidates.yaml が必要です。先に候補抽出を実行してください。")
            }
            guard planningStatus.dialogueEvidenceReady else {
                return VideoOSAgentJobReadiness(canRun: false, label: "構成設計には文字起こしと音声ストーリー根拠が必要です。先に音声解析を実行してください。")
            }
            let label = planningStatus.hasBlueprint
                ? "edit_blueprint.yaml は既にあります。候補または意図が変わった場合だけ再実行してください。"
                : job.approvalSummary
            return VideoOSAgentJobReadiness(canRun: true, label: label)
        case .compile:
            guard let planningStatus else {
                return VideoOSAgentJobReadiness(canRun: false, label: "設計状況がまだ読み込まれていません。")
            }
            guard planningStatus.hasSelects else {
                return VideoOSAgentJobReadiness(canRun: false, label: "粗編集生成には selects_candidates.yaml が必要です。先に候補抽出を実行してください。")
            }
            guard planningStatus.hasBlueprint else {
                return VideoOSAgentJobReadiness(canRun: false, label: "粗編集生成には edit_blueprint.yaml が必要です。先に構成設計を実行してください。")
            }
            guard planningStatus.isBlueprintFresh else {
                return VideoOSAgentJobReadiness(canRun: false, label: "edit_blueprint.yaml が候補または意図より古いです。先に構成設計を再実行してください。")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: project.hasTimeline ? "timeline.json は既にあります。書き込み計画を確認してから再生成してください。" : job.approvalSummary)
        case .review:
            guard project.hasTimeline else {
                return VideoOSAgentJobReadiness(canRun: false, label: "レビューには生成済みの timeline.json が必要です。")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: project.hasReview ? "レビュー成果物は既にあります。タイムライン変更後だけ再実行してください。" : job.approvalSummary)
        case .render:
            guard project.hasTimeline else {
                return VideoOSAgentJobReadiness(canRun: false, label: "書き出しには生成済みの timeline.json が必要です。")
            }
            guard project.hasReview else {
                return VideoOSAgentJobReadiness(canRun: false, label: "書き出し前にレビュー成果物が必要です。")
            }
            return VideoOSAgentJobReadiness(canRun: true, label: job.approvalSummary)
        }
    }
}
