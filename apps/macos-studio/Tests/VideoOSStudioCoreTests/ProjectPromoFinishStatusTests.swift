import XCTest
@testable import VideoOSStudioCore

final class ProjectPromoFinishStatusTests: XCTestCase {
    func testStatusReportsMissingPromoFinishArtifacts() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-promo-finish-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)

        let status = ProjectPromoFinishStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "promo finish missing")
        XCTAssertFalse(status.subtitleSidecarExists)
        XCTAssertFalse(status.finishedVideoExists)
        XCTAssertEqual(status.captionCount, 0)
        XCTAssertEqual(status.finishedVideoURL.path, project.appendingPathComponent("09_output/promo-finished.mp4").path)
        XCTAssertEqual(status.missingRequiredArtifacts, [
            "09_output/promo-finish/subtitles.ass",
            "09_output/promo-finished.mp4"
        ])
    }

    func testStatusReadsSubtitlesAndExistingVariantOutput() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-promo-finish-ready-\(UUID().uuidString)")
        try writePromoFinishFixture(
            project: project,
            outputName: "promo-finished-impl.mp4",
            dialogueCount: 2
        )

        let status = ProjectPromoFinishStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "promo finish ready")
        XCTAssertTrue(status.subtitleSidecarExists)
        XCTAssertTrue(status.subtitleSidecarReadable)
        XCTAssertEqual(status.captionCount, 2)
        XCTAssertTrue(status.finishedVideoExists)
        XCTAssertEqual(status.finishedVideoURL.lastPathComponent, "promo-finished-impl.mp4")
        XCTAssertEqual(status.missingRequiredArtifacts, [])
    }

    func testStatusPrefersDefaultPromoFinishedOutput() throws {
        let project = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-promo-finish-default-\(UUID().uuidString)")
        try writePromoFinishFixture(
            project: project,
            outputName: "promo-finished-impl.mp4",
            dialogueCount: 1
        )
        try Data([0x02, 0x03]).write(
            to: project.appendingPathComponent("09_output/promo-finished.mp4"),
            options: .atomic
        )

        let status = ProjectPromoFinishStatusReader.status(projectURL: project)

        XCTAssertEqual(status.finishedVideoURL.lastPathComponent, "promo-finished.mp4")
        XCTAssertTrue(status.finishedVideoExists)
    }

    func testRunPlanBuildsPromoFinishCommandWhenTranscriptExists() throws {
        let (root, project) = try temporaryPromoFinishProject("videoos-promo-finish-plan")

        let plan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertTrue(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "ready to promo finish")
        XCTAssertEqual(plan.transcriptFileCount, 1)
        XCTAssertEqual(plan.commandArguments, [
            "npm",
            "run",
            "promo-finish",
            "--",
            "--project",
            project.path,
            "--output",
            project.appendingPathComponent("09_output/promo-finished.mp4").path,
            "--work-dir",
            project.appendingPathComponent("09_output/promo-finish").path
        ])
    }

    func testRunPlanRequiresTranscriptsForCaptionedPromoFinish() throws {
        let (root, project) = try temporaryPromoFinishProject("videoos-promo-finish-transcripts")
        try FileManager.default.removeItem(at: project.appendingPathComponent("03_analysis/transcripts/TR_AST_A.json"))

        let plan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: root, projectURL: project)

        XCTAssertFalse(plan.canRun)
        XCTAssertEqual(plan.readinessLabel, "missing transcripts")
    }

    func testRunnerUsesInjectedWorkerAndReadsFinishedStatus() throws {
        let (root, project) = try temporaryPromoFinishProject("videoos-promo-finish-run")
        let plan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: root, projectURL: project)

        let result = try ProjectPromoFinishRunner.run(plan: plan) { _, arguments in
            XCTAssertEqual(arguments.first, "npm")
            XCTAssertTrue(arguments.contains("promo-finish"))
            try writePromoFinishFixture(
                project: project,
                outputName: "promo-finished.mp4",
                dialogueCount: 1
            )
            return ProjectInitializationProcessResult(status: 0, stdout: "promo finish complete", stderr: "")
        }

        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.status.readinessLabel, "promo finish ready")
        XCTAssertEqual(result.status.captionCount, 1)
        XCTAssertTrue(result.status.finishedVideoExists)
    }
}

private func temporaryPromoFinishProject(_ prefix: String) throws -> (URL, URL) {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    let project = root.appendingPathComponent("projects/demo")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: project.appendingPathComponent("03_analysis/transcripts"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: project.appendingPathComponent("05_timeline"), withIntermediateDirectories: true)
    try "script".write(to: root.appendingPathComponent("scripts/render-promo-cut.ts"), atomically: true, encoding: .utf8)
    try #"{"version":"1","sequence":{"fps":24},"tracks":{"video":[],"audio":[]}}"#
        .write(to: project.appendingPathComponent("05_timeline/timeline.json"), atomically: true, encoding: .utf8)
    try """
    {
      "asset_id": "AST_A",
      "items": [
        { "start_us": 0, "end_us": 1000000, "text": "AI workflow changed our execution." }
      ]
    }
    """.write(to: project.appendingPathComponent("03_analysis/transcripts/TR_AST_A.json"), atomically: true, encoding: .utf8)
    return (root, project)
}

private func writePromoFinishFixture(project: URL, outputName: String, dialogueCount: Int) throws {
    let output = project.appendingPathComponent("09_output")
    let work = output.appendingPathComponent("promo-finish")
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    try Data([0x00, 0x01]).write(to: output.appendingPathComponent(outputName), options: .atomic)
    try Data([0x02, 0x03]).write(to: work.appendingPathComponent("base.mp4"), options: .atomic)
    try #"{"version":"1"}"#.write(to: work.appendingPathComponent("timeline.adjusted.json"), atomically: true, encoding: .utf8)
    let dialogueLines = (0..<dialogueCount)
        .map { "Dialogue: 0,0:00:0\($0).00,0:00:0\($0 + 1).00,Default,,0,0,0,,Test \($0)" }
        .joined(separator: "\n")
    try """
    [Script Info]
    ScriptType: v4.00+
    [Events]
    Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    \(dialogueLines)
    """.write(to: work.appendingPathComponent("subtitles.ass"), atomically: true, encoding: .utf8)
}
