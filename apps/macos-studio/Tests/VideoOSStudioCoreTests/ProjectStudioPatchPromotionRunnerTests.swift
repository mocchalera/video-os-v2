import XCTest
@testable import VideoOSStudioCore

final class ProjectStudioPatchPromotionRunnerTests: XCTestCase {
    func testPlanBuildsPromoteCommandWithPatchAndBackup() throws {
        let (root, project, patchURL, backupURL) = try temporaryPromotionProject()

        let plan = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            patchURL: patchURL
        )

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready to promote")
        XCTAssertEqual(plan.backupTimelineURL?.path, backupURL.path)
        XCTAssertTrue(plan.commandArguments.contains { $0.hasSuffix("scripts/promote-studio-patch.ts") })
        XCTAssertTrue(plan.commandArguments.contains("--project"))
        XCTAssertTrue(plan.commandArguments.contains(project.path))
        XCTAssertTrue(plan.commandArguments.contains("--patch"))
        XCTAssertTrue(plan.commandArguments.contains(patchURL.path))
        XCTAssertTrue(plan.commandArguments.contains("--backup-timeline"))
        XCTAssertTrue(plan.commandArguments.contains("--json"))
    }

    func testPlanReportsMissingPromoteScript() throws {
        let (root, project, patchURL, _) = try temporaryPromotionProject()
        try FileManager.default.removeItem(at: root.appendingPathComponent("scripts/promote-studio-patch.ts"))

        let plan = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            patchURL: patchURL
        )

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing promote script")
    }

    func testRunDecodesPromotionOutput() throws {
        let (root, project, patchURL, _) = try temporaryPromotionProject()
        let plan = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: root,
            projectURL: project,
            patchURL: patchURL
        )

        let result = try ProjectStudioPatchPromotionRunner.run(plan: plan) { _, arguments in
            XCTAssertTrue(arguments.contains("--json"))
            return ProjectInitializationProcessResult(
                status: 0,
                stdout: #"{"applied_ops":1,"skipped_ops":0,"selects_modified":false,"blueprint_modified":true,"modified_beat_ids":["b1"],"warnings":[],"dry_run":false}"#,
                stderr: ""
            )
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.output?.applied_ops, 1)
        XCTAssertEqual(result.output?.modified_beat_ids, ["b1"])
    }

    private func temporaryPromotionProject() throws -> (URL, URL, URL, URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-promote-plan-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        let scriptsDir = root.appendingPathComponent("scripts")
        let planDir = project.appendingPathComponent("04_plan")
        let timelineDir = project.appendingPathComponent("05_timeline")
        let reviewDir = project.appendingPathComponent("06_review")
        let historyDir = reviewDir.appendingPathComponent("patch_history")
        try FileManager.default.createDirectory(at: scriptsDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: planDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: historyDir, withIntermediateDirectories: true)

        try "script".write(to: scriptsDir.appendingPathComponent("promote-studio-patch.ts"), atomically: true, encoding: .utf8)
        try "project_id: demo\ncandidates: []\n".write(to: planDir.appendingPathComponent("selects_candidates.yaml"), atomically: true, encoding: .utf8)
        try "project_id: demo\nbeats: []\n".write(to: planDir.appendingPathComponent("edit_blueprint.yaml"), atomically: true, encoding: .utf8)
        try #"{"version":"1","project_id":"demo","created_at":"2026-06-23T00:00:00Z","sequence":{"name":"demo","fps_num":24,"fps_den":1,"width":1920,"height":1080,"start_frame":0},"tracks":{"video":[],"audio":[]},"markers":[],"provenance":{"brief_path":"","blueprint_path":"","selects_path":"","compiler_version":"test"}}"#
            .write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        let patchURL = reviewDir.appendingPathComponent("studio_patch_1.json")
        try #"{"timeline_version":"1","operations":[{"op":"replace_segment","target_clip_id":"CLP_A","with_segment_id":"SEG_B","reason":"swap"}]}"#
            .write(to: patchURL, atomically: true, encoding: .utf8)
        let backupURL = historyDir.appendingPathComponent("timeline_backup_1.json")
        try #"{"version":"1"}"#.write(to: backupURL, atomically: true, encoding: .utf8)
        let index = PatchHistoryIndex(project_id: "demo", records: [
            PatchHistoryRecord(
                patch_path: "06_review/studio_patch_1.json",
                base_timeline_hash: "base",
                result_timeline_hash: "result",
                timeline_backup_path: "06_review/patch_history/timeline_backup_1.json",
                created_at: "2026-06-23T00:00:00Z",
                source: "studio_ui",
                changed_clip_ids: ["CLP_A"],
                op_count: 1
            )
        ])
        try index.save(projectURL: project)
        return (root, project, patchURL, backupURL)
    }
}
