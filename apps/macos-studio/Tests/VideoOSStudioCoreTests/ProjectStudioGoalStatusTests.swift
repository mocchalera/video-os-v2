import XCTest
@testable import VideoOSStudioCore

final class ProjectStudioGoalStatusTests: XCTestCase {
    func testGoalStatusKeepsObjectiveGapsVisibleAfterNativeScaffoldExists() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-studio-goal-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try writeNativeStudioScaffold(root: root)

        let status = ProjectStudioGoalStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.requirements.count, 10)
        XCTAssertEqual(status.requirement("native-gui-cli")?.isSatisfied, true)
        XCTAssertEqual(status.requirement("codex-app-server")?.isSatisfied, true)
        XCTAssertEqual(status.requirement("material-db-rag")?.isSatisfied, false)
        XCTAssertEqual(status.requirement("native-editor-ui")?.isSatisfied, false)
        XCTAssertEqual(status.nextRequirement?.id, "material-db-rag")
        XCTAssertEqual(status.nextCommand, "swift run videoos-studio-cli analysis-run demo")
        XCTAssertNotEqual(status.readinessLabel, "objective verified")
    }

    func testGoalStatusNeverTreatsNativeEditorPolishAsProvenByArtifactsAlone() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-studio-goal-editor-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try writeNativeStudioScaffold(root: root)

        let status = ProjectStudioGoalStatusReader.status(repositoryRoot: root, projectURL: project)

        let editor = try XCTUnwrap(status.requirement("native-editor-ui"))
        XCTAssertFalse(editor.isSatisfied)
        XCTAssertTrue(editor.nextAction.contains("timeline") || editor.nextAction.contains("visual QA"))
    }

    func testGoalStatusUsesSourceMapSuggestedRelinkWhenBrokenAbsolutePathsExist() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-studio-goal-source-map-\(UUID().uuidString)")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try writeNativeStudioScaffold(root: root)
        try writeGoalAnalysisWithBrokenSourceMap(project: project)

        let status = ProjectStudioGoalStatusReader.status(repositoryRoot: root, projectURL: project)

        XCTAssertEqual(status.nextRequirement?.id, "material-db-rag")
        XCTAssertEqual(status.nextCommand, "swift run videoos-studio-cli media-relink-plan demo --from-source-map")
        XCTAssertEqual(status.requirement("material-db-rag")?.nextCommand, "swift run videoos-studio-cli media-relink-plan demo --from-source-map")
    }
}

private extension ProjectStudioGoalStatus {
    func requirement(_ id: String) -> ProjectStudioGoalRequirement? {
        requirements.first { $0.id == id }
    }
}

private func writeNativeStudioScaffold(root: URL) throws {
    let fileManager = FileManager.default
    try fileManager.createDirectory(at: root.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudio"), withIntermediateDirectories: true)
    try fileManager.createDirectory(at: root.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudioCLI"), withIntermediateDirectories: true)
    try fileManager.createDirectory(at: root.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudioCore"), withIntermediateDirectories: true)
    try fileManager.createDirectory(at: root.appendingPathComponent("script"), withIntermediateDirectories: true)

    try "// package\n".write(to: root.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
    try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
    try "gui".write(to: root.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudio/ContentView.swift"), atomically: true, encoding: .utf8)
    try "cli".write(to: root.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudioCLI/main.swift"), atomically: true, encoding: .utf8)
    try "protocol".write(to: root.appendingPathComponent("apps/macos-studio/Sources/VideoOSStudioCore/CodexAppServerProtocol.swift"), atomically: true, encoding: .utf8)
    try "#!/bin/sh\n".write(to: root.appendingPathComponent("script/build_and_run.sh"), atomically: true, encoding: .utf8)
}

private func writeGoalAnalysisWithBrokenSourceMap(project: URL) throws {
    let analysisDir = project.appendingPathComponent("03_analysis")
    let mediaDir = project.appendingPathComponent("02_media")
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "asset_id": "AST_001",
          "filename": "interview.mov",
          "role_guess": "interview",
          "duration_us": 1000000,
          "has_transcript": false,
          "segment_ids": ["SEG_001"],
          "quality_flags": [],
          "tags": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "segment_id": "SEG_001",
          "asset_id": "AST_001",
          "src_in_us": 0,
          "src_out_us": 1000000,
          "summary": "opening",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)
    try """
    {
      "version": "1",
      "project_id": "demo",
      "media_dir": "02_media",
      "items": [
        {
          "asset_id": "AST_001",
          "source_locator": "/Volumes/Offline/interview.mov",
          "local_source_path": "/Volumes/Offline/interview.mov",
          "link_path": "02_media/relinked/AST_001-interview.mov"
        }
      ]
    }
    """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)
}
