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
        XCTAssertEqual(noThread.label, "Start an agent session before running jobs.")

        let noProject = VideoOSAgentJobReadinessResolver.readiness(
            for: .status,
            hasActiveThread: true,
            project: nil,
            planningStatus: status
        )
        XCTAssertFalse(noProject.canRun)
        XCTAssertEqual(noProject.label, "Select a project before running jobs.")
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
        XCTAssertEqual(missingIntent.label, "Triage requires a creative brief.")

        let missingAnalysis = VideoOSAgentJobReadinessResolver.readiness(
            for: .triage,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus(assetCount: 1, segmentCount: 0)
        )
        XCTAssertFalse(missingAnalysis.canRun)
        XCTAssertEqual(missingAnalysis.label, "Triage requires analyzed assets and segments.")

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
        XCTAssertEqual(blueprintMissingBlockers.label, "Blueprint requires unresolved_blockers.yaml from intent.")

        let blueprintMissingSelects = VideoOSAgentJobReadinessResolver.readiness(
            for: .blueprint,
            hasActiveThread: true,
            project: project,
            planningStatus: makePlanningStatus()
        )
        XCTAssertFalse(blueprintMissingSelects.canRun)
        XCTAssertEqual(blueprintMissingSelects.label, "Blueprint requires selects_candidates.yaml. Run Triage first.")

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
        XCTAssertEqual(compileMissingBlueprint.label, "Compile requires edit_blueprint.yaml. Run Blueprint first.")

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
        XCTAssertEqual(clipMissingSelection.label, "Select a timeline clip before running this read-only job.")

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
        XCTAssertEqual(reviewBlocked.label, "Review requires a compiled timeline.json.")

        let renderMissingReview = VideoOSAgentJobReadinessResolver.readiness(
            for: .render,
            hasActiveThread: true,
            project: makeProject(hasTimeline: true, hasReview: false),
            planningStatus: status
        )
        XCTAssertFalse(renderMissingReview.canRun)
        XCTAssertEqual(renderMissingReview.label, "Render requires review artifacts before packaging.")

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
        hasSelects: Bool = false,
        hasBlueprint: Bool = false,
        hasUncertaintyRegister: Bool = false
    ) -> ProjectPlanningStatus {
        ProjectPlanningStatus(
            projectURL: URL(fileURLWithPath: "/repo/projects/demo"),
            hasCreativeBrief: hasCreativeBrief,
            hasUnresolvedBlockers: hasUnresolvedBlockers,
            assetCount: assetCount,
            segmentCount: segmentCount,
            hasSelects: hasSelects,
            hasBlueprint: hasBlueprint,
            hasUncertaintyRegister: hasUncertaintyRegister
        )
    }
}
