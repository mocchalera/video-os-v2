import XCTest
@testable import VideoOSStudioCore

final class VideoOSAgentJobReadinessTests: XCTestCase {
    func testReadinessRequiresActiveThreadAndProject() {
        let project = makeProject()
        let status = makePlanningStatus()

        let noThread = VideoOSAgentJobReadinessResolver.readiness(
            for: .status,
            hasActiveThread: false,
            project: project,
            planningStatus: status
        )
        XCTAssertFalse(noThread.canRun)
        XCTAssertEqual(noThread.label, "ジョブを実行する前にエージェントセッションを開始してください。")

        let noProject = VideoOSAgentJobReadinessResolver.readiness(
            for: .status,
            hasActiveThread: true,
            project: nil,
            planningStatus: status
        )
        XCTAssertFalse(noProject.canRun)
        XCTAssertEqual(noProject.label, "ジョブを実行する前にプロジェクトを選択してください。")
    }

    func testPlanningJobsGateOnIntentAnalysisSelectsAndBlueprint() {
        let project = makeProject()

        let missingIntent = VideoOSAgentJobReadinessResolver.readiness(
            for: .triage,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(hasCreativeBrief: false)
        )
        XCTAssertFalse(missingIntent.canRun)
        XCTAssertEqual(missingIntent.label, "候補抽出には creative_brief が必要です。")

        let missingAnalysis = VideoOSAgentJobReadinessResolver.readiness(
            for: .triage,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(assetCount: 1, segmentCount: 0)
        )
        XCTAssertFalse(missingAnalysis.canRun)
        XCTAssertEqual(missingAnalysis.label, "候補抽出には解析済みの素材とセグメントが必要です。")

        let triageMissingDialogueEvidence = VideoOSAgentJobReadinessResolver.readiness(
            for: .triage,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(dialogueEvidenceRequired: true)
        )
        XCTAssertFalse(triageMissingDialogueEvidence.canRun)
        XCTAssertEqual(triageMissingDialogueEvidence.label, "候補抽出には文字起こしと音声ストーリー根拠が必要です。先に音声解析を実行してください。")

        let triageReady = VideoOSAgentJobReadinessResolver.readiness(
            for: .triage,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus()
        )
        XCTAssertTrue(triageReady.canRun)

        let blueprintMissingBlockers = VideoOSAgentJobReadinessResolver.readiness(
            for: .blueprint,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(hasUnresolvedBlockers: false, hasSelects: true)
        )
        XCTAssertFalse(blueprintMissingBlockers.canRun)
        XCTAssertEqual(blueprintMissingBlockers.label, "構成設計には意図整理で作成された unresolved_blockers.yaml が必要です。")

        let blueprintMissingSelects = VideoOSAgentJobReadinessResolver.readiness(
            for: .blueprint,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus()
        )
        XCTAssertFalse(blueprintMissingSelects.canRun)
        XCTAssertEqual(blueprintMissingSelects.label, "構成設計には selects_candidates.yaml が必要です。先に候補抽出を実行してください。")

        let blueprintMissingDialogueEvidence = VideoOSAgentJobReadinessResolver.readiness(
            for: .blueprint,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(dialogueEvidenceRequired: true, hasSelects: true)
        )
        XCTAssertFalse(blueprintMissingDialogueEvidence.canRun)
        XCTAssertEqual(blueprintMissingDialogueEvidence.label, "構成設計には文字起こしと音声ストーリー根拠が必要です。先に音声解析を実行してください。")

        let blueprintReady = VideoOSAgentJobReadinessResolver.readiness(
            for: .blueprint,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(hasSelects: true)
        )
        XCTAssertTrue(blueprintReady.canRun)

        let compileMissingBlueprint = VideoOSAgentJobReadinessResolver.readiness(
            for: .compile,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(hasSelects: true)
        )
        XCTAssertFalse(compileMissingBlueprint.canRun)
        XCTAssertEqual(compileMissingBlueprint.label, "粗編集生成には edit_blueprint.yaml が必要です。先に構成設計を実行してください。")

        let compileStaleBlueprint = VideoOSAgentJobReadinessResolver.readiness(
            for: .compile,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(
                hasSelects: true,
                hasBlueprint: true,
                isBlueprintFresh: false,
                blueprintStaleReason: "edit_blueprint.yaml is older than selects_candidates.yaml"
            )
        )
        XCTAssertFalse(compileStaleBlueprint.canRun)
        XCTAssertEqual(compileStaleBlueprint.label, "edit_blueprint.yaml が候補または意図より古いです。先に構成設計を再実行してください。")

        let compileReady = VideoOSAgentJobReadinessResolver.readiness(
            for: .compile,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(hasSelects: true, hasBlueprint: true)
        )
        XCTAssertTrue(compileReady.canRun)
    }

    func testTimelineJobsGateOnTimelineReviewAndClipSelection() {
        let status = makePlanningStatus(hasSelects: true, hasBlueprint: true)
        let draftProject = makeProject(hasTimeline: false, hasReview: false)

        let clipMissingSelection = VideoOSAgentJobReadinessResolver.readiness(
            for: .clipAnnotation,
            hasActiveThread: true,
            project: draftProject,
            planningStatus: status,
            selectedTimelineClipAvailable: false
        )
        XCTAssertFalse(clipMissingSelection.canRun)
        XCTAssertEqual(clipMissingSelection.label, "この読み取り専用ジョブを実行する前にタイムラインのクリップを選択してください。")

        let clipReady = VideoOSAgentJobReadinessResolver.readiness(
            for: .clipAnnotation,
            hasActiveThread: true,
            project: draftProject,
            planningStatus: status,
            selectedTimelineClipAvailable: true
        )
        XCTAssertTrue(clipReady.canRun)

        let reviewBlocked = VideoOSAgentJobReadinessResolver.readiness(
            for: .review,
            hasActiveThread: true,
            project: draftProject,
            planningStatus: status
        )
        XCTAssertFalse(reviewBlocked.canRun)
        XCTAssertEqual(reviewBlocked.label, "レビューには生成済みの timeline.json が必要です。")

        let renderMissingReview = VideoOSAgentJobReadinessResolver.readiness(
            for: .render,
            hasActiveThread: true,
            project: makeProject(hasTimeline: true, hasReview: false),
            planningStatus: status
        )
        XCTAssertFalse(renderMissingReview.canRun)
        XCTAssertEqual(renderMissingReview.label, "書き出し前にレビュー成果物が必要です。")

        let renderReady = VideoOSAgentJobReadinessResolver.readiness(
            for: .render,
            hasActiveThread: true,
            project: makeProject(hasTimeline: true, hasReview: true),
            planningStatus: status
        )
        XCTAssertTrue(renderReady.canRun)
    }

    private func makeProject(
        hasTimeline: Bool = false,
        hasReview: Bool = false
    ) -> ProjectSummary {
        ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "draft",
            hasTimeline: hasTimeline,
            hasReview: hasReview,
            mediaFileCount: 0
        )
    }

    private func makePlanningStatus(
        hasCreativeBrief: Bool = true,
        hasUnresolvedBlockers: Bool = true,
        assetCount: Int = 1,
        segmentCount: Int = 1,
        transcriptItemCount: Int = 0,
        audioEvidenceCount: Int = 0,
        dialogueEvidenceRequired: Bool = false,
        hasSelects: Bool = false,
        hasBlueprint: Bool = false,
        isBlueprintFresh: Bool = true,
        blueprintStaleReason: String? = nil,
        hasUncertaintyRegister: Bool = false
    ) -> ProjectPlanningStatus {
        ProjectPlanningStatus(
            projectURL: URL(fileURLWithPath: "/repo/projects/demo"),
            hasCreativeBrief: hasCreativeBrief,
            hasUnresolvedBlockers: hasUnresolvedBlockers,
            assetCount: assetCount,
            segmentCount: segmentCount,
            transcriptItemCount: transcriptItemCount,
            audioEvidenceCount: audioEvidenceCount,
            dialogueEvidenceRequired: dialogueEvidenceRequired,
            hasSelects: hasSelects,
            hasBlueprint: hasBlueprint,
            isBlueprintFresh: isBlueprintFresh,
            blueprintStaleReason: blueprintStaleReason,
            hasUncertaintyRegister: hasUncertaintyRegister
        )
    }
}
