import XCTest
@testable import VideoOSStudioCore

final class VideoOSAgentJobTests: XCTestCase {
    func testStatusJobBuildsReadOnlyPromptForSelectedProject() {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "critique_ready",
            hasTimeline: true,
            hasReview: true,
            mediaFileCount: 0
        )
        let prompt = VideoOSAgentJob.status.prompt(project: project, repositoryRoot: URL(fileURLWithPath: "/repo"))

        XCTAssertTrue(VideoOSAgentJob.status.readOnly)
        XCTAssertTrue(prompt.contains("npx tsx scripts/status.ts projects/demo"))
        XCTAssertTrue(prompt.contains("Do not modify files"))
    }

    func testCompileJobNamesCompilerAsOnlyTimelineWriter() {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "selects_ready",
            hasTimeline: false,
            hasReview: false,
            mediaFileCount: 0
        )
        let prompt = VideoOSAgentJob.compile.prompt(project: project, repositoryRoot: URL(fileURLWithPath: "/repo"))

        XCTAssertFalse(VideoOSAgentJob.compile.readOnly)
        XCTAssertTrue(prompt.contains(".codex/commands/compile.md"))
        XCTAssertTrue(prompt.contains("only the compiler may write `05_timeline/timeline.json`"))
        XCTAssertTrue(prompt.contains("npx tsx scripts/compile-timeline.ts projects/demo"))
        XCTAssertTrue(prompt.contains(#""engine_action":"run_compile""#))
        XCTAssertTrue(prompt.contains("Use `run_compile` only if compile and planning gates are open"))
    }

    func testEngineDecisionExtractsPlainOrFencedJSON() {
        let plain = #"{"engine_action":"run_compile","reason":"compile gate is open"}"#
        let fenced = """
        The deterministic compiler may run.
        ```json
        {"engine_action":"block","reason":"edit_blueprint.yaml is missing"}
        ```
        """

        XCTAssertEqual(VideoOSAgentEngineDecision.extract(from: plain)?.engineAction, .runCompile)
        XCTAssertEqual(VideoOSAgentEngineDecision.extract(from: plain)?.reason, "compile gate is open")
        XCTAssertEqual(VideoOSAgentEngineDecision.extract(from: fenced)?.engineAction, .block)
        XCTAssertNil(VideoOSAgentEngineDecision.extract(from: #"{"engine_action":"run_compile","reason":""}"#))
    }

    func testWriteJobsExposeOperatorApprovalMetadata() {
        XCTAssertFalse(VideoOSAgentJob.status.requiresOperatorApproval)
        XCTAssertFalse(VideoOSAgentJob.validate.requiresOperatorApproval)
        XCTAssertFalse(VideoOSAgentJob.clipAnnotation.requiresOperatorApproval)
        XCTAssertTrue(VideoOSAgentJob.triage.requiresOperatorApproval)
        XCTAssertTrue(VideoOSAgentJob.blueprint.requiresOperatorApproval)
        XCTAssertTrue(VideoOSAgentJob.compile.requiresOperatorApproval)
        XCTAssertTrue(VideoOSAgentJob.review.requiresOperatorApproval)
        XCTAssertTrue(VideoOSAgentJob.render.requiresOperatorApproval)

        XCTAssertEqual(VideoOSAgentJob.status.sandboxLabel, "read-only / network off")
        XCTAssertEqual(VideoOSAgentJob.clipAnnotation.sandboxLabel, "read-only / network off")
        XCTAssertTrue(VideoOSAgentJob.clipAnnotation.requiresSelectedTimelineClip)
        XCTAssertEqual(VideoOSAgentJob.compile.sandboxLabel, "workspace-write / user reviewed")
        XCTAssertEqual(VideoOSAgentJob.render.sandboxLabel, "workspace-write / user reviewed")
        XCTAssertTrue(VideoOSAgentJob.triage.plannedWriteScopes.contains("projects/<id>/04_plan/selects_candidates.yaml"))
        XCTAssertTrue(VideoOSAgentJob.blueprint.plannedWriteScopes.contains("projects/<id>/04_plan/edit_blueprint.yaml"))
        XCTAssertTrue(VideoOSAgentJob.compile.plannedWriteScopes.contains("projects/<id>/05_timeline/"))
        XCTAssertTrue(VideoOSAgentJob.review.plannedWriteScopes.contains("projects/<id>/06_review/review_report.yaml"))
        XCTAssertTrue(VideoOSAgentJob.render.plannedWriteScopes.contains("projects/<id>/07_package/"))
        XCTAssertTrue(VideoOSAgentJob.render.plannedWriteScopes.contains("projects/<id>/09_output/final.mp4"))
        XCTAssertTrue(VideoOSAgentJob.compile.approvalSummary.contains("deterministic compiler"))
        XCTAssertTrue(VideoOSAgentJob.clipAnnotation.approvalSummary.contains("selected-clip editor note"))
        XCTAssertTrue(VideoOSAgentJob.render.approvalSummary.contains("final render"))

        XCTAssertTrue(VideoOSAgentJob.clipAnnotation.showsTimelineConsultationControls)
        XCTAssertFalse(VideoOSAgentJob.triage.showsTimelineConsultationControls)
        XCTAssertFalse(VideoOSAgentJob.blueprint.showsTimelineConsultationControls)
        XCTAssertTrue(VideoOSAgentJob.status.showsFreeformPromptControls)
        XCTAssertTrue(VideoOSAgentJob.clipAnnotation.showsFreeformPromptControls)
        XCTAssertFalse(VideoOSAgentJob.triage.showsFreeformPromptControls)
        XCTAssertFalse(VideoOSAgentJob.blueprint.showsFreeformPromptControls)
    }

    func testWriteContractsBindAllowedArtifactsToProjectID() {
        let status = VideoOSAgentJob.status.writeContract(projectID: "demo")
        XCTAssertTrue(status.readOnly)
        XCTAssertEqual(status.allowedArtifactRoots, [])
        XCTAssertEqual(status.entrypoint, "npx tsx scripts/status.ts projects/demo")
        XCTAssertTrue(status.forbiddenWrites.contains("any repository file mutation"))

        let clipAnnotation = VideoOSAgentJob.clipAnnotation.writeContract(projectID: "demo")
        XCTAssertTrue(clipAnnotation.readOnly)
        XCTAssertEqual(clipAnnotation.entrypoint, "Codex read-only turn using selected timeline clip evidence")
        XCTAssertTrue(clipAnnotation.forbiddenWrites.contains("saving or clearing projects/demo/07_handoff/editor_annotations.json"))

        let triage = VideoOSAgentJob.triage.writeContract(projectID: "demo")
        XCTAssertFalse(triage.readOnly)
        XCTAssertEqual(triage.commandContract, ".codex/commands/triage.md")
        XCTAssertTrue(triage.allowedArtifactRoots.contains("projects/demo/04_plan/selects_candidates.yaml"))
        XCTAssertTrue(triage.expectedArtifacts.contains("projects/demo/04_plan/selects_candidates.yaml"))
        XCTAssertTrue(triage.forbiddenWrites.contains("timeline writes under projects/demo/05_timeline/"))

        let blueprint = VideoOSAgentJob.blueprint.writeContract(projectID: "demo")
        XCTAssertFalse(blueprint.readOnly)
        XCTAssertEqual(blueprint.commandContract, ".codex/commands/blueprint.md")
        XCTAssertTrue(blueprint.allowedArtifactRoots.contains("projects/demo/04_plan/edit_blueprint.yaml"))
        XCTAssertTrue(blueprint.expectedArtifacts.contains("projects/demo/04_plan/uncertainty_register.yaml"))
        XCTAssertTrue(blueprint.forbiddenWrites.contains("timeline writes under projects/demo/05_timeline/"))

        let compile = VideoOSAgentJob.compile.writeContract(projectID: "demo")
        XCTAssertFalse(compile.readOnly)
        XCTAssertEqual(compile.commandContract, ".codex/commands/compile.md")
        XCTAssertEqual(compile.entrypoint, "npx tsx scripts/compile-timeline.ts projects/demo")
        XCTAssertTrue(compile.allowedArtifactRoots.contains("projects/demo/05_timeline/"))
        XCTAssertTrue(compile.expectedArtifacts.contains("projects/demo/05_timeline/timeline.json"))
        XCTAssertTrue(compile.expectedArtifacts.contains("projects/demo/05_timeline/preview-manifest.json"))
        XCTAssertTrue(compile.forbiddenWrites.contains("review artifacts under projects/demo/06_review/"))

        let review = VideoOSAgentJob.review.writeContract(projectID: "demo")
        XCTAssertFalse(review.readOnly)
        XCTAssertEqual(review.commandContract, ".codex/commands/review.md")
        XCTAssertTrue(review.allowedArtifactRoots.contains("projects/demo/06_review/review_report.yaml"))
        XCTAssertTrue(review.expectedArtifacts.contains("projects/demo/06_review/review_patch.json"))
        XCTAssertTrue(review.forbiddenWrites.contains("auto-compiling or modifying projects/demo/05_timeline/timeline.json"))

        let render = VideoOSAgentJob.render.writeContract(projectID: "demo")
        XCTAssertFalse(render.readOnly)
        XCTAssertEqual(render.commandContract, ".codex/commands/render.md")
        XCTAssertEqual(render.entrypoint, "runtime/commands/render.ts via .codex/commands/render.md")
        XCTAssertTrue(render.allowedArtifactRoots.contains("projects/demo/07_package/"))
        XCTAssertTrue(render.allowedArtifactRoots.contains("projects/demo/09_output/final.mp4"))
        XCTAssertTrue(render.expectedArtifacts.contains("projects/demo/07_package/package_manifest.json"))
        XCTAssertTrue(render.expectedArtifacts.contains("projects/demo/09_output/final.mp4"))
        XCTAssertTrue(render.forbiddenWrites.contains("auto-compiling or modifying projects/demo/05_timeline/timeline.json"))
    }

    func testPromptsIncludeExplicitWriteContract() {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "selects_ready",
            hasTimeline: false,
            hasReview: false,
            mediaFileCount: 0
        )
        let prompt = VideoOSAgentJob.review.prompt(project: project, repositoryRoot: URL(fileURLWithPath: "/repo"))

        XCTAssertTrue(prompt.contains("Write contract:"))
        XCTAssertTrue(prompt.contains("- Command contract: `.codex/commands/review.md`"))
        XCTAssertTrue(prompt.contains("- Expected artifacts:"))
        XCTAssertTrue(prompt.contains("`projects/demo/06_review/review_report.yaml`"))
        XCTAssertTrue(prompt.contains("auto-compiling or modifying projects/demo/05_timeline/timeline.json"))
    }

    func testPromptCanIncludeCitedRAGContext() {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "selects_ready",
            hasTimeline: false,
            hasReview: false,
            mediaFileCount: 0
        )
        let context = ProjectRAGContextPack.build(
            query: "quiet",
            results: [
                ProjectSearchResult(
                    documentID: "segment:SEG_001",
                    kind: "segment",
                    assetID: "AST_001",
                    segmentID: "SEG_001",
                    startUS: 1_000_000,
                    endUS: 5_000_000,
                    title: "quiet interview line",
                    text: "I came here to get quiet again.",
                    tags: "interview,quiet"
                )
            ]
        )

        let prompt = VideoOSAgentJob.triage.prompt(project: project, repositoryRoot: URL(fileURLWithPath: "/repo"), ragContext: context)

        XCTAssertTrue(prompt.contains("Material RAG context for query `quiet`:"))
        XCTAssertTrue(prompt.contains("doc=segment:SEG_001"))
        XCTAssertTrue(prompt.contains("asset=AST_001"))
        XCTAssertTrue(prompt.contains("segment=SEG_001"))
        XCTAssertTrue(prompt.contains("time=00:01.000-00:05.000"))
        XCTAssertTrue(prompt.contains("I came here to get quiet again."))
    }

    func testRenderJobNamesPackageOutputsAndBlocksTimelineWrites() {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "approved",
            hasTimeline: true,
            hasReview: true,
            mediaFileCount: 0
        )
        let prompt = VideoOSAgentJob.render.prompt(project: project, repositoryRoot: URL(fileURLWithPath: "/repo"))

        XCTAssertFalse(VideoOSAgentJob.render.readOnly)
        XCTAssertTrue(prompt.contains(".codex/commands/render.md"))
        XCTAssertTrue(prompt.contains("approved or rerunnable packaged project"))
        XCTAssertTrue(prompt.contains("Do not auto-compile or modify `05_timeline/timeline.json`"))
        XCTAssertTrue(prompt.contains("`projects/demo/07_package/`"))
        XCTAssertTrue(prompt.contains("`projects/demo/09_output/final.mp4`"))
    }

    func testClipAnnotationJobBuildsReadOnlySelectedClipPrompt() throws {
        let project = ProjectSummary(
            id: "demo",
            name: "demo",
            path: URL(fileURLWithPath: "/repo/projects/demo"),
            stateLabel: "critique_ready",
            hasTimeline: true,
            hasReview: false,
            mediaFileCount: 0
        )
        let timeline = try decodeTimelineFixture()
        let selection = try XCTUnwrap(timeline.clipSelection(for: "clip-001"))
        let prompt = VideoOSAgentJob.clipAnnotation.prompt(
            project: project,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            selection: selection,
            timeline: timeline,
            evidence: nil,
            existingNote: nil
        )

        XCTAssertTrue(VideoOSAgentJob.clipAnnotation.readOnly)
        XCTAssertTrue(prompt.contains("Run the selected-clip annotation proposal job"))
        XCTAssertTrue(prompt.contains("Clip: clip-001"))
        XCTAssertTrue(prompt.contains(#"{"clip_id":"...","note":"...","handoff_instruction":"..."}"#))
        XCTAssertTrue(prompt.contains("- Mode: read-only selected-clip annotation proposal"))
        XCTAssertTrue(prompt.contains("- Allowed writes: none"))
        XCTAssertTrue(prompt.contains("saving or clearing projects/demo/07_handoff/editor_annotations.json"))
    }

    func testWriteContractFlagsDiffsOutsideAllowedArtifacts() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-write-contract-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let reviewDir = root.appendingPathComponent("06_review")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)

        let timeline = timelineDir.appendingPathComponent("timeline.json")
        let report = reviewDir.appendingPathComponent("review_report.yaml")
        try #"{"version":"1"}"#.write(to: timeline, atomically: true, encoding: .utf8)

        let before = try ProjectArtifactSnapshot.capture(projectURL: root)
        try #"{"version":"2"}"#.write(to: timeline, atomically: true, encoding: .utf8)
        try "ok: true\n".write(to: report, atomically: true, encoding: .utf8)
        let diffs = before.diff(to: try ProjectArtifactSnapshot.capture(projectURL: root))

        let compileViolations = VideoOSAgentJob.compile
            .writeContract(projectID: "demo")
            .violations(for: diffs)
        XCTAssertEqual(compileViolations.map(\.relativePath), ["06_review/review_report.yaml"])
        XCTAssertEqual(compileViolations.first?.reason, "outside allowed write contract")

        let readOnlyViolations = VideoOSAgentJob.status
            .writeContract(projectID: "demo")
            .violations(for: diffs)
        XCTAssertEqual(Set(readOnlyViolations.map(\.relativePath)), Set(["05_timeline/timeline.json", "06_review/review_report.yaml"]))
        XCTAssertEqual(readOnlyViolations.first?.reason, "read-only job changed a canonical artifact")

        let renderViolations = VideoOSAgentJob.render
            .writeContract(projectID: "demo")
            .violations(for: diffs)
        XCTAssertEqual(Set(renderViolations.map(\.relativePath)), Set(["05_timeline/timeline.json", "06_review/review_report.yaml"]))
    }
}

private func decodeTimelineFixture() throws -> TimelineDocument {
    let data = """
    {
      "version": "1",
      "project_id": "demo",
      "sequence": {
        "name": "Demo",
        "fps_num": 24,
        "fps_den": 1,
        "width": 1920,
        "height": 1080,
        "start_frame": 0
      },
      "tracks": {
        "video": [
          {
            "track_id": "V1",
            "kind": "video",
            "clips": [
              {
                "clip_id": "clip-001",
                "segment_id": "SEG_001",
                "asset_id": "AST_001",
                "src_in_us": 0,
                "src_out_us": 1000000,
                "timeline_in_frame": 0,
                "timeline_duration_frames": 24,
                "role": "hook",
                "motivation": "natural pause sells the thought",
                "confidence": 0.9,
                "quality_flags": ["slight_wind"]
              }
            ]
          }
        ],
        "audio": []
      },
      "markers": []
    }
    """.data(using: .utf8)!
    return try JSONDecoder().decode(TimelineDocument.self, from: data)
}
