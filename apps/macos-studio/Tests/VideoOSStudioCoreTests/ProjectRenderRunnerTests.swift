import XCTest
@testable import VideoOSStudioCore

final class ProjectRenderRunnerTests: XCTestCase {
    func testPlanBuildsRenderWorkerCommandForApprovedProject() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-plan", state: "approved")

        let plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            options: ProjectRenderRunOptions(skipRender: true)
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready to validate package")
        XCTAssertTrue(plan.commandArguments.contains { $0.hasSuffix("scripts/editor-job-worker.ts") })
        XCTAssertTrue(plan.commandArguments.contains(project.path))
        XCTAssertTrue(plan.commandArguments.contains("render"))
        XCTAssertTrue(plan.commandLine.contains("skip_render"))
    }

    func testPlanRequiresApprovedOrPackagedState() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-state", state: "critique_ready")

        let plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight(
                #"current_state must be "approved" or "packaged", got "critique_ready""#
            )
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(
            plan.readinessLabel,
            #"current_state must be "approved" or "packaged", got "critique_ready""#
        )
    }

    func testPlanRequiresGate10ApprovalAndHandoff() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-gate10", state: "approved")
        try writeProjectState(project, state: "approved", approvalStatus: "pending")

        var plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight("approval_record is missing")
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "approval_record is missing")

        try writeProjectState(project, state: "approved", handoffStatus: "pending")
        plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight(
                #"handoff_resolution.status must be "decided", got "pending""#
            )
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(
            plan.readinessLabel,
            #"handoff_resolution.status must be "decided", got "pending""#
        )
    }

    func testPlanRequiresOpenReviewGateAndResolvedFatalIssues() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-review-gate", state: "approved")
        try writeProjectState(project, state: "approved", reviewGate: "blocked")

        var plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight(
                #"gates.review_gate must be "open", got "blocked""#
            )
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, #"gates.review_gate must be "open", got "blocked""#)

        try writeProjectState(project, state: "approved")
        try writeReviewReport(project, fatalIssueCount: 1)
        plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight("review_report contains 1 fatal issue(s)")
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "review_report contains 1 fatal issue(s)")
    }

    func testPlanRequiresAudioOnlyVisualQAContract() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-visual-qa", state: "approved")
        try writeReviewReport(project, visualStatus: "unverified", visualReason: "model_unavailable")

        let plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: blockedPreflight(
                #"audio-only timeline requires review_report.visual_qa status "not_applicable""#
            )
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(
            plan.readinessLabel,
            #"audio-only timeline requires review_report.visual_qa status "not_applicable""#
        )
    }

    func testPlanRequiresWorkerInputsBeforeEnablingRender() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-inputs", state: "approved")
        try FileManager.default.removeItem(at: project.appendingPathComponent("01_intent/creative_brief.yaml"))

        var plan = renderPlan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing creative brief")

        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try """
        autonomy:
          mode: full
        """.write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
        try FileManager.default.removeItem(at: project.appendingPathComponent("04_plan/edit_blueprint.yaml"))

        plan = renderPlan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing edit blueprint")
    }

    func testPlanUsesPublishedFinalForPackagedNLEFinishingProject() throws {
        let (root, project) = try temporaryRenderProject(
            "videoos-render-nle",
            state: "packaged",
            sourceOfTruthDecision: "nle_finishing"
        )

        var plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: readyPreflight(sourceOfTruth: "nle_finishing", currentState: "packaged")
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "supplied final missing")

        let publishedFinal = project.appendingPathComponent("09_output/final.mp4")
        try FileManager.default.createDirectory(at: publishedFinal.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x00, 0x01]).write(to: publishedFinal, options: .atomic)

        plan = renderPlan(
            repositoryRoot: root,
            projectURL: project,
            preflightStatus: readyPreflight(sourceOfTruth: "nle_finishing", currentState: "packaged")
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.options.suppliedFinalURL, publishedFinal)
        XCTAssertTrue(plan.commandLine.contains("supplied_final_path"))
    }

    func testRunUsesInjectedWorkerAndReadsRenderedPackageStatus() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-run", state: "approved")
        let plan = renderPlan(repositoryRoot: root, projectURL: project)

        let result = try ProjectRenderRunner.run(
            plan: plan,
            packageVerifier: { _, verifiedProject in
                XCTAssertEqual(verifiedProject, project)
                XCTAssertTrue(FileManager.default.fileExists(
                    atPath: project.appendingPathComponent("07_package/package_manifest.json").path
                ))
                return ProjectPackageVerificationStatus(
                    ready: true,
                    projectDir: project.path,
                    readinessLabel: "render packaged",
                    projectID: "demo",
                    sourceOfTruth: "engine_render"
                )
            }
        ) { _, arguments in
            XCTAssertTrue(arguments.contains("render"))
            try writeRenderPackageFixture(project: project, qaPassed: true)
            return ProjectInitializationProcessResult(status: 0, stdout: "__RESULT__{\"success\":true}__END__", stderr: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.status.readinessLabel, "render packaged")
        XCTAssertEqual(result.status.qaPassed, true)
        XCTAssertTrue(result.status.publishedFinalVideoExists)
    }

    func testRunDoesNotSucceedWhenExitIsZeroButPackageContractIsInvalid() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-invalid-package", state: "approved")
        let plan = renderPlan(repositoryRoot: root, projectURL: project)

        let result = try ProjectRenderRunner.run(
            plan: plan,
            packageVerifier: { _, _ in
                ProjectPackageVerificationStatus(
                    ready: false,
                    projectDir: project.path,
                    readinessLabel: "package manifest unreadable",
                    issues: ["package manifest invalid"],
                    projectID: "demo",
                    sourceOfTruth: "engine_render"
                )
            }
        ) { _, _ in
            try writeRenderPackageFixture(project: project, qaPassed: true)
            try "{}".write(
                to: project.appendingPathComponent("07_package/package_manifest.json"),
                atomically: true,
                encoding: .utf8
            )
            return ProjectInitializationProcessResult(status: 0, stdout: "", stderr: "")
        }

        XCTAssertFalse(result.succeeded)
        XCTAssertEqual(result.status.readinessLabel, "package manifest unreadable")
    }

    func testPreflightRunnerDecodesBlockedExitAndFailsClosedOnInvalidJSON() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-preflight", state: "approved")
        let blocked = ProjectPackagePreflightRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { workingDirectory, arguments in
            XCTAssertEqual(workingDirectory, root)
            XCTAssertTrue(arguments.contains("--preflight-only"))
            XCTAssertTrue(arguments.contains("--json"))
            return ProjectInitializationProcessResult(
                status: 1,
                stdout: """
                {"version":"package-preflight/v2","decision":"blocked","project_identity":{"status":"unresolved","evidence_count":0,"sources":[]},"structured_issues":[{"code":"PACKAGE_PREFLIGHT_APPROVAL_REQUIRED","message":"approval_record is missing"}],"next_action":{"code":"resolve_preflight_issues","message":"Resolve approval"},"ok":false,"projectDir":"\(project.path)","issues":["approval_record is missing"],"nextSteps":[],"visualQaSummary":"missing"}
                """,
                stderr: ""
            )
        }

        XCTAssertTrue(blocked.available)
        XCTAssertFalse(blocked.canPackage)
        XCTAssertEqual(blocked.failureLabel, "approval_record is missing")

        let invalid = ProjectPackagePreflightRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { _, _ in
            ProjectInitializationProcessResult(status: 0, stdout: "not-json", stderr: "")
        }

        XCTAssertFalse(invalid.available)
        XCTAssertEqual(invalid.failureLabel, "package preflight unavailable")
    }

    func testPreflightRunnerRejectsExitContradictionsWithoutReinterpretingOracleDecision() throws {
        let (root, project) = try temporaryRenderProject("videoos-render-preflight-contract", state: "approved")
        let readyJSON = """
        {"version":"package-preflight/v2","decision":"ready_to_run","project_identity":{"status":"inferred","project_id":"demo","evidence_count":1,"sources":[]},"structured_issues":[],"next_action":{"code":"run_package","message":"Run package"},"ok":true,"projectDir":"\(project.path)","issues":[],"nextSteps":[],"sourceOfTruth":"engine_render","projectId":"","currentState":"approved","visualQaSummary":"verified"}
        """
        let blockedJSON = """
        {"version":"package-preflight/v2","decision":"blocked","project_identity":{"status":"conflict","evidence_count":2,"sources":[]},"structured_issues":[{"code":"PACKAGE_PREFLIGHT_PROJECT_ID_MISMATCH","message":"blocked"}],"next_action":{"code":"resolve_project_identity","message":"Resolve identity"},"ok":false,"projectDir":"\(project.path)","issues":["blocked"],"nextSteps":[],"visualQaSummary":"missing"}
        """

        let ready = ProjectPackagePreflightRunner.status(
            repositoryRoot: root,
            projectURL: project
        ) { _, _ in
            ProjectInitializationProcessResult(status: 0, stdout: readyJSON, stderr: "")
        }
        XCTAssertTrue(ready.available)
        XCTAssertTrue(ready.canPackage)
        XCTAssertEqual(ready.projectID, "")

        for (exitCode, json) in [(Int32(1), readyJSON), (Int32(0), blockedJSON), (Int32(2), blockedJSON)] {
            let status = ProjectPackagePreflightRunner.status(
                repositoryRoot: root,
                projectURL: project
            ) { _, _ in
                ProjectInitializationProcessResult(status: exitCode, stdout: json, stderr: "")
            }

            XCTAssertFalse(status.available, "exit \(exitCode)")
            XCTAssertEqual(status.failureLabel, "package preflight unavailable", "exit \(exitCode)")
        }
    }

    private func renderPlan(
        repositoryRoot: URL,
        projectURL: URL,
        options: ProjectRenderRunOptions = ProjectRenderRunOptions(),
        preflightStatus: ProjectPackagePreflightStatus? = nil
    ) -> ProjectRenderRunPlan {
        ProjectRenderRunPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            options: options,
            preflightStatus: preflightStatus ?? readyPreflight()
        )
    }

    private func readyPreflight(
        sourceOfTruth: String = "engine_render",
        currentState: String = "approved"
    ) -> ProjectPackagePreflightStatus {
        ProjectPackagePreflightStatus(
            ok: true,
            sourceOfTruth: sourceOfTruth,
            autonomyMode: "full",
            projectID: "demo",
            currentState: currentState,
            visualQaSummary: "verified"
        )
    }

    private func blockedPreflight(_ issue: String) -> ProjectPackagePreflightStatus {
        ProjectPackagePreflightStatus(
            ok: false,
            issues: [issue],
            nextSteps: ["resolve the runtime Gate 10 blocker"]
        )
    }

    private func temporaryRenderProject(
        _ prefix: String,
        state: String,
        sourceOfTruthDecision: String = "engine_render"
    ) throws -> (URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("05_timeline"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("06_review"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "script".write(to: root.appendingPathComponent("scripts/package.ts"), atomically: true, encoding: .utf8)
        try "script".write(to: root.appendingPathComponent("scripts/editor-job-worker.ts"), atomically: true, encoding: .utf8)
        try """
        autonomy:
          mode: full
        """.write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
        try """
        caption_policy:
          source: none
          delivery_mode: both
        """.write(to: project.appendingPathComponent("04_plan/edit_blueprint.yaml"), atomically: true, encoding: .utf8)
        try #"{"version":"1","sequence":{"fps":24},"tracks":{"video":[],"audio":[]}}"#
            .write(to: project.appendingPathComponent("05_timeline/timeline.json"), atomically: true, encoding: .utf8)
        try writeReviewReport(project)
        try writeProjectState(
            project,
            state: state,
            sourceOfTruthDecision: sourceOfTruthDecision
        )
        return (root, project)
    }

    private func writeProjectState(
        _ project: URL,
        state: String,
        approvalStatus: String = "clean",
        handoffStatus: String = "decided",
        sourceOfTruthDecision: String = "engine_render",
        reviewGate: String = "open"
    ) throws {
        try """
        project_id: demo
        current_state: \(state)
        approval_record:
          status: \(approvalStatus)
        handoff_resolution:
          handoff_id: HND_test
          status: \(handoffStatus)
          source_of_truth_decision: \(sourceOfTruthDecision)
        gates:
          review_gate: \(reviewGate)
        """.write(to: project.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)
    }

    private func writeReviewReport(
        _ project: URL,
        fatalIssueCount: Int = 0,
        visualStatus: String = "not_applicable",
        visualReason: String = "audio_only_timeline"
    ) throws {
        let fatalIssues = fatalIssueCount == 0
            ? "[]"
            : "\n  - summary: unresolved"
        try """
        summary_judgment:
          status: approved
        fatal_issues: \(fatalIssues)
        visual_qa:
          status: \(visualStatus)
          reason: \(visualReason)
          min_score: 70
          issues:
            fatal: 0
            major: 0
            minor: 0
          issue_summaries: []
        """.write(to: project.appendingPathComponent("06_review/review_report.yaml"), atomically: true, encoding: .utf8)
    }

    private func writeRenderPackageFixture(project: URL, qaPassed: Bool) throws {
        let package = project.appendingPathComponent("07_package")
        let video = package.appendingPathComponent("video")
        let audio = package.appendingPathComponent("audio")
        let output = project.appendingPathComponent("09_output")
        try FileManager.default.createDirectory(at: video, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try Data([0x00, 0x01]).write(to: video.appendingPathComponent("final.mp4"), options: .atomic)
        try Data([0x02, 0x03]).write(to: audio.appendingPathComponent("final_mix.wav"), options: .atomic)
        try Data([0x04, 0x05]).write(to: output.appendingPathComponent("final.mp4"), options: .atomic)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "source_of_truth": "engine_render",
          "qa_profile": "engine_render",
          "passed": \(qaPassed ? "true" : "false"),
          "checks": [
            { "name": "timeline_schema_valid", "passed": true, "details": "ok" }
          ]
        }
        """.write(to: package.appendingPathComponent("qa-report.json"), atomically: true, encoding: .utf8)
        try """
        {
          "version": "package-v1",
          "project_id": "demo",
          "source_of_truth": "engine_render",
          "base_timeline_version": "1",
          "packaging_projection_hash": "abc123",
          "created_at": "2026-05-22T00:00:00Z",
          "artifacts": {
            "final_video": { "path": "09_output/final.mp4", "sha256": "abc" },
            "qa_report": { "path": "07_package/qa-report.json", "sha256": "def" }
          },
          "provenance": {
            "editorial_timeline_hash": "timeline"
          }
        }
        """.write(to: package.appendingPathComponent("package_manifest.json"), atomically: true, encoding: .utf8)
    }
}
