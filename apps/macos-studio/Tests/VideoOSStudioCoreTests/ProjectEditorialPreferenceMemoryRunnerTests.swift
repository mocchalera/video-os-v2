import XCTest
@testable import VideoOSStudioCore

final class ProjectEditorialPreferenceMemoryRunnerTests: XCTestCase {
    func testRememberDraftKeepsEveryExplicitHumanField() {
        let draft = EditorialPreferenceRememberDraft(
            actorID: "human-1",
            sourceEvent: .reviewPatchRejection,
            sourceKind: .canonicalReviewPatch,
            preferenceType: .transitionStyle,
            primitiveKind: .enumeration,
            primitiveValue: "no_flash",
            scope: .series,
            scopeRef: "SERIES-1",
            supersedesEntryID: "EPM-old"
        )

        XCTAssertEqual(draft.actorID, "human-1")
        XCTAssertEqual(draft.sourceEvent, .reviewPatchRejection)
        XCTAssertEqual(draft.sourceKind, .canonicalReviewPatch)
        XCTAssertEqual(draft.preferenceType, .transitionStyle)
        XCTAssertEqual(draft.primitiveKind, .enumeration)
        XCTAssertEqual(draft.primitiveValue, "no_flash")
        XCTAssertEqual(draft.scope, .series)
        XCTAssertEqual(draft.scopeRef, "SERIES-1")
        XCTAssertEqual(draft.supersedesEntryID, "EPM-old")
    }

    func testPlannerBuildsStableArgvAndKeepsSpecialCharactersInSingleArguments() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let actor = "editor name; $(touch nope)"
        let value = "preserve 'quiet' pauses; no shell"
        let draft = EditorialPreferenceRememberDraft(
            actorID: actor,
            sourceEvent: .blueprintAcceptance,
            sourceKind: .canonicalBlueprint,
            preferenceType: .deliveryPreference,
            primitiveKind: .string,
            primitiveValue: value,
            scope: .project,
            scopeRef: "ignored-by-project-scope",
            supersedesEntryID: "EPM_old;still-one-arg"
        )

        let plan = ProjectEditorialPreferenceMemoryPlanner.rememberPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: "action-1",
            draft: draft
        )

        XCTAssertTrue(plan.canRun, plan.readinessIssues.joined(separator: ", "))
        XCTAssertEqual(Array(plan.commandArguments.prefix(4)), ["npx", "tsx", plan.scriptURL.path, "remember"])
        XCTAssertEqual(valueAfter("--actor-id", in: plan.commandArguments), actor)
        XCTAssertEqual(valueAfter("--value", in: plan.commandArguments), value)
        XCTAssertEqual(valueAfter("--scope-ref", in: plan.commandArguments), "eye-project")
        XCTAssertEqual(valueAfter("--supersedes", in: plan.commandArguments), "EPM_old;still-one-arg")
        XCTAssertEqual(plan.commandArguments.last, "--json")
    }

    func testPlannerRejectsMissingReadinessInputsAndEventSourceMismatches() throws {
        let missingRoot = temporaryDirectory("eye-memory-missing")
        let missingPlan = ProjectEditorialPreferenceMemoryPlanner.rememberPlan(
            repositoryRoot: missingRoot,
            projectURL: missingRoot.appendingPathComponent("project"),
            projectID: "",
            actionID: "action",
            draft: validRememberDraft()
        )
        XCTAssertFalse(missingPlan.canRun)
        XCTAssertTrue(missingPlan.readinessIssues.contains("repository root is missing"))
        XCTAssertTrue(missingPlan.readinessIssues.contains("project directory is missing"))
        XCTAssertTrue(missingPlan.readinessIssues.contains("project ID is required"))
        XCTAssertTrue(missingPlan.readinessIssues.contains("editorial preference writer script is missing"))
        XCTAssertTrue(missingPlan.readinessIssues.contains("source artifact is missing"))

        let fixture = try makeFixture(projectID: "eye-project")
        var blueprintRejected = validRememberDraft()
        blueprintRejected.sourceEvent = .reviewPatchRejection
        XCTAssertFalse(makeRememberPlan(fixture, draft: blueprintRejected).canRun)

        var reviewAsBlueprint = validRememberDraft()
        reviewAsBlueprint.sourceKind = .canonicalReviewPatch
        XCTAssertFalse(makeRememberPlan(fixture, draft: reviewAsBlueprint).canRun)

        let missingAction = ProjectEditorialPreferenceMemoryPlanner.rememberPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: " action ",
            draft: validRememberDraft()
        )
        XCTAssertTrue(missingAction.readinessIssues.contains("action ID is required"))
    }

    func testPlannerChecksProjectStateIdentityAndSourceRealpathContainment() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        try Data("version: 1\nproject_id: other-project\n".utf8)
            .write(to: fixture.project.appendingPathComponent("project_state.yaml"))
        XCTAssertTrue(makeRememberPlan(fixture, draft: validRememberDraft()).readinessIssues.contains("project state project ID does not match"))

        try Data("version: 1\nproject_id: eye-project\n".utf8)
            .write(to: fixture.project.appendingPathComponent("project_state.yaml"))
        let outside = temporaryDirectory("eye-memory-outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let outsideBlueprint = outside.appendingPathComponent("edit_blueprint.yaml")
        try Data().write(to: outsideBlueprint)
        let blueprint = fixture.project.appendingPathComponent("04_plan/edit_blueprint.yaml")
        try FileManager.default.removeItem(at: blueprint)
        try FileManager.default.createSymbolicLink(at: blueprint, withDestinationURL: outsideBlueprint)

        XCTAssertTrue(makeRememberPlan(fixture, draft: validRememberDraft()).readinessIssues.contains("source artifact symlink escapes the project"))
    }

    func testPlannerSelectsOnlyLatestRegisteredStudioPatch() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let historyDirectory = fixture.project.appendingPathComponent("06_review/patch_history")
        try FileManager.default.createDirectory(at: historyDirectory, withIntermediateDirectories: true)
        let oldPath = "06_review/studio_patch_old.json"
        let latestPath = "06_review/studio_patch_latest.json"
        try Data("{}".utf8).write(to: fixture.project.appendingPathComponent(oldPath))
        try Data("{}".utf8).write(to: fixture.project.appendingPathComponent(latestPath))
        var index = PatchHistoryIndex(project_id: "eye-project")
        index.append(record: patchRecord(path: oldPath))
        index.append(record: patchRecord(path: latestPath))
        try index.save(projectURL: fixture.project)
        var draft = validRememberDraft()
        draft.sourceEvent = .reviewPatchAcceptance
        draft.sourceKind = .latestStudioPatch

        let plan = makeRememberPlan(fixture, draft: draft)

        XCTAssertTrue(plan.canRun, plan.readinessIssues.joined(separator: ", "))
        XCTAssertEqual(plan.sourceURL?.standardizedFileURL, fixture.project.appendingPathComponent(latestPath).standardizedFileURL)
        XCTAssertEqual(valueAfter("--source", in: plan.commandArguments), latestPath)

        try FileManager.default.removeItem(at: fixture.project.appendingPathComponent(latestPath))
        XCTAssertFalse(makeRememberPlan(fixture, draft: draft).canRun)
    }

    func testPlannerRejectsWrongPatchHistoryProjectAndUnsafeLatestPath() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        var draft = validRememberDraft()
        draft.sourceEvent = .reviewPatchAcceptance
        draft.sourceKind = .latestStudioPatch
        var wrongProject = PatchHistoryIndex(project_id: "other-project")
        wrongProject.append(record: patchRecord(path: "06_review/review_patch.json"))
        try wrongProject.save(projectURL: fixture.project)
        XCTAssertTrue(makeRememberPlan(fixture, draft: draft).readinessIssues.contains("patch history project ID does not match"))

        var unsafe = PatchHistoryIndex(project_id: "eye-project")
        unsafe.append(record: patchRecord(path: "../outside.json"))
        try unsafe.save(projectURL: fixture.project)
        XCTAssertTrue(makeRememberPlan(fixture, draft: draft).readinessIssues.contains("latest Studio patch path is invalid"))
    }

    func testProjectProfileAndSeriesScopeRules() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        var draft = validRememberDraft()
        draft.scope = .project
        draft.scopeRef = "wrong-value-is-ignored"
        XCTAssertEqual(valueAfter("--scope-ref", in: makeRememberPlan(fixture, draft: draft).commandArguments), "eye-project")

        for scope in [EditorialPreferenceScope.profile, .series] {
            draft.scope = scope
            draft.scopeRef = ""
            XCTAssertTrue(makeRememberPlan(fixture, draft: draft).readinessIssues.contains("scope reference is required"))
            draft.scopeRef = "context with spaces"
            let plan = makeRememberPlan(fixture, draft: draft)
            XCTAssertTrue(plan.canRun, plan.readinessIssues.joined(separator: ", "))
            XCTAssertEqual(valueAfter("--scope-ref", in: plan.commandArguments), "context with spaces")
        }
    }

    func testActionIDRetriesResetOnlyOnContentSuccessOrProjectChange() {
        var state = EditorialPreferenceMemoryActionState(projectID: "one")
        var draft = validRememberDraft()
        let first = state.prepareRemember(draft: draft, generateID: { "remember-1" })
        XCTAssertEqual(state.prepareRemember(draft: draft, generateID: { "unexpected" }), first)

        draft.primitiveValue = "slow"
        XCTAssertEqual(state.prepareRemember(draft: draft, generateID: { "remember-2" }), "remember-2")
        state.markRememberSucceeded(actionID: "remember-2")
        XCTAssertEqual(state.prepareRemember(draft: draft, generateID: { "remember-3" }), "remember-3")

        let redact = EditorialPreferenceRedactDraft(targetEntryID: "EPM-1", reason: "incorrect", actorID: "human")
        XCTAssertEqual(state.prepareRedact(draft: redact, generateID: { "redact-1" }), "redact-1")
        XCTAssertEqual(state.prepareRedact(draft: redact, generateID: { "unexpected" }), "redact-1")
        state.reset(projectID: "two")
        XCTAssertNil(state.rememberActionID)
        XCTAssertNil(state.redactActionID)
        XCTAssertEqual(state.projectID, "two")
    }

    @MainActor
    func testProjectSelectionSessionResetClearsDraftsActionsAndExecutionState() {
        let session = EditorialPreferenceMemorySession(projectID: "one")
        session.rememberDraft.actorID = "editor"
        session.rememberDraft.primitiveValue = "tight"
        session.redactDraft = EditorialPreferenceRedactDraft(targetEntryID: "EPM-1", reason: "wrong", actorID: "editor")
        _ = session.prepareRememberActionID(generateID: { "remember-1" })
        _ = session.prepareRedactActionID(generateID: { "redact-1" })
        session.isRunning = true
        session.statusMessage = "実行中"

        session.resetForProject("two")

        XCTAssertEqual(session.actionState.projectID, "two")
        XCTAssertNil(session.actionState.rememberActionID)
        XCTAssertNil(session.actionState.redactActionID)
        XCTAssertEqual(session.rememberDraft, EditorialPreferenceRememberDraft(scopeRef: "two"))
        XCTAssertEqual(session.redactDraft, EditorialPreferenceRedactDraft())
        XCTAssertFalse(session.isRunning)
        XCTAssertEqual(session.statusMessage, "このプロジェクトでは判断の記憶をまだ実行していません。")
    }

    @MainActor
    func testSuccessfulRememberClearsValueAndSupersessionBeforeAnotherSubmission() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let session = EditorialPreferenceMemorySession(projectID: "eye-project")
        session.rememberDraft.actorID = "editor"
        session.rememberDraft.primitiveValue = "tight"
        session.rememberDraft.supersedesEntryID = "EPM-old"
        let actionID = session.prepareRememberActionID(generateID: { "remember-1" })

        session.markRememberSucceeded(actionID: actionID)

        XCTAssertEqual(session.rememberDraft.actorID, "editor")
        XCTAssertEqual(session.rememberDraft.primitiveValue, "")
        XCTAssertEqual(session.rememberDraft.supersedesEntryID, "")
        let nextPlan = ProjectEditorialPreferenceMemoryPlanner.rememberPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: "remember-2",
            draft: session.rememberDraft
        )
        XCTAssertFalse(nextPlan.canRun)
        XCTAssertTrue(nextPlan.readinessIssues.contains("preference value is required"))
    }

    @MainActor
    func testSuccessfulRedactClearsTargetAndReasonBeforeAnotherSubmission() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let session = EditorialPreferenceMemorySession(projectID: "eye-project")
        session.redactDraft = EditorialPreferenceRedactDraft(
            targetEntryID: "EPM-target",
            reason: "incorrect",
            actorID: "editor"
        )
        let actionID = session.prepareRedactActionID(generateID: { "redact-1" })

        session.markRedactSucceeded(actionID: actionID)

        XCTAssertEqual(session.redactDraft.actorID, "editor")
        XCTAssertEqual(session.redactDraft.targetEntryID, "")
        XCTAssertEqual(session.redactDraft.reason, "")
        let nextPlan = ProjectEditorialPreferenceMemoryPlanner.redactPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: "redact-2",
            draft: session.redactDraft
        )
        XCTAssertFalse(nextPlan.canRun)
        XCTAssertTrue(nextPlan.readinessIssues.contains("target entry ID is required"))
        XCTAssertTrue(nextPlan.readinessIssues.contains("redaction reason is required"))
    }

    func testRunnerDecodesSuccessAndRejectsNonzeroOrMalformedJSON() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let plan = makeRememberPlan(fixture, draft: validRememberDraft())
        let json = #"{"status":"appended","entry":{"project_id":"eye-project","entry_id":"EPM_1"},"path":"/tmp/memory.jsonl","consumedOffset":42,"consumedHash":"sha256:abc"}"#
        let success = try ProjectEditorialPreferenceMemoryRunner.run(plan: plan) { workingDirectory, arguments in
            XCTAssertEqual(workingDirectory, fixture.root)
            XCTAssertEqual(arguments, plan.commandArguments)
            return ProjectInitializationProcessResult(status: 0, stdout: json, stderr: "")
        }
        XCTAssertTrue(success.succeeded)
        XCTAssertEqual(success.output?.entry.entryID, "EPM_1")

        let nonzero = try ProjectEditorialPreferenceMemoryRunner.run(plan: plan) { _, _ in
            ProjectInitializationProcessResult(status: 2, stdout: json, stderr: "rejected")
        }
        XCTAssertFalse(nonzero.succeeded)

        let malformed = try ProjectEditorialPreferenceMemoryRunner.run(plan: plan) { _, _ in
            ProjectInitializationProcessResult(status: 0, stdout: "not-json", stderr: "")
        }
        XCTAssertFalse(malformed.succeeded)
        XCTAssertNil(malformed.output)
    }

    func testRedactPlanRequiresExplicitFieldsAndUsesAppendOnlyCLIAction() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let invalid = ProjectEditorialPreferenceMemoryPlanner.redactPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: "action-redact",
            draft: EditorialPreferenceRedactDraft()
        )
        XCTAssertFalse(invalid.canRun)
        XCTAssertTrue(invalid.readinessIssues.contains("actor is required"))
        XCTAssertTrue(invalid.readinessIssues.contains("target entry ID is required"))
        XCTAssertTrue(invalid.readinessIssues.contains("redaction reason is required"))

        let reason = "判断が変わった; keep as one argv"
        let plan = ProjectEditorialPreferenceMemoryPlanner.redactPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: "action-redact",
            draft: EditorialPreferenceRedactDraft(targetEntryID: "EPM_target", reason: reason, actorID: "human")
        )
        XCTAssertTrue(plan.canRun, plan.readinessIssues.joined(separator: ", "))
        XCTAssertEqual(Array(plan.commandArguments.prefix(4)), ["npx", "tsx", plan.scriptURL.path, "redact"])
        XCTAssertEqual(valueAfter("--target", in: plan.commandArguments), "EPM_target")
        XCTAssertEqual(valueAfter("--reason", in: plan.commandArguments), reason)
        XCTAssertNil(plan.sourceURL)
    }

    @MainActor
    func testPlanningAndDraftSerializationDoNotInvokeWriterOrCreateMemory() throws {
        let fixture = try makeFixture(projectID: "eye-project")
        let memoryURL = fixture.project.appendingPathComponent("00_project/editorial_preference_memory.jsonl")
        let session = StudioFeedbackSession()
        session.addOp(.removeSegment(target_clip_id: "clip-1", reason: "human rejection"))
        _ = session.serialize(projectID: "eye-project")
        _ = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            patchURL: fixture.project.appendingPathComponent("06_review/review_patch.json")
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: memoryURL.path))
    }

    private func validRememberDraft() -> EditorialPreferenceRememberDraft {
        EditorialPreferenceRememberDraft(
            actorID: "human",
            sourceEvent: .blueprintAcceptance,
            sourceKind: .canonicalBlueprint,
            preferenceType: .pacing,
            primitiveKind: .enumeration,
            primitiveValue: "tight",
            scope: .project,
            scopeRef: ""
        )
    }

    private func makeRememberPlan(
        _ fixture: (root: URL, project: URL),
        draft: EditorialPreferenceRememberDraft
    ) -> ProjectEditorialPreferenceMemoryPlan {
        ProjectEditorialPreferenceMemoryPlanner.rememberPlan(
            repositoryRoot: fixture.root,
            projectURL: fixture.project,
            projectID: "eye-project",
            actionID: "action",
            draft: draft
        )
    }

    private func makeFixture(projectID: String) throws -> (root: URL, project: URL) {
        let root = temporaryDirectory("eye-memory")
        let project = root.appendingPathComponent("projects/\(projectID)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("04_plan"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.appendingPathComponent("06_review"), withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("scripts/editorial-preference-memory.ts"))
        try Data().write(to: project.appendingPathComponent("04_plan/edit_blueprint.yaml"))
        try Data("{}".utf8).write(to: project.appendingPathComponent("06_review/review_patch.json"))
        try Data("version: 1\nproject_id: \(projectID)\ncurrent_state: blueprint_ready\n".utf8)
            .write(to: project.appendingPathComponent("project_state.yaml"))
        return (root, project)
    }

    private func temporaryDirectory(_ prefix: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }

    private func valueAfter(_ flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private func patchRecord(path: String) -> PatchHistoryRecord {
        PatchHistoryRecord(
            patch_path: path,
            base_timeline_hash: "base",
            result_timeline_hash: "result",
            timeline_backup_path: "backup",
            created_at: "2026-07-20T00:00:00Z",
            source: "studio",
            changed_clip_ids: [],
            op_count: 0
        )
    }
}
