import XCTest
@testable import VideoOSStudioCore

final class ProjectSyntheticMediaBuilderTests: XCTestCase {
    func testPlanCreatesFfmpegCommandsForAnalyzedAssets() throws {
        let root = temporaryProjectURL("videoos-synthetic-plan")
        try writeSyntheticFixtureAssets(at: root)

        let plan = ProjectSyntheticMediaPlanner.plan(projectURL: root, durationSeconds: 4)

        XCTAssertEqual(plan.totalCount, 2)
        XCTAssertEqual(plan.pendingCount, 2)
        XCTAssertEqual(plan.statusLabel, "2 synthetic media files pending")
        XCTAssertEqual(plan.items.map(\.outputURL.lastPathComponent), ["interview.mov", "camera.mp4"])
        XCTAssertTrue(plan.items[0].ffmpegArguments.contains("libx264"))
        XCTAssertTrue(plan.items[0].commandLine.contains("ffmpeg"))
    }

    func testBuildRunsFfmpegAndRelinksGeneratedMedia() throws {
        let root = temporaryProjectURL("videoos-synthetic-build")
        try writeSyntheticFixtureAssets(at: root)
        var capturedArguments: [[String]] = []

        let result = ProjectSyntheticMediaBuilder.build(projectURL: root, durationSeconds: 3) { arguments in
            capturedArguments.append(arguments)
            let output = try XCTUnwrap(arguments.last)
            try Data([0]).write(to: URL(fileURLWithPath: output))
        }
        let sourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: root)
        let mediaStatus = ProjectMediaResolver.previewSummary(projectURL: root, assets: nil)

        XCTAssertEqual(capturedArguments.count, 2)
        XCTAssertEqual(result.builtCount, 2)
        XCTAssertEqual(result.skippedCount, 0)
        XCTAssertEqual(result.failureCount, 0)
        XCTAssertNotNil(result.sourceMapURL)
        XCTAssertEqual(result.mappedCount, 2)
        XCTAssertEqual(sourceMapStatus.readinessLabel, "source map ready")
        XCTAssertEqual(sourceMapStatus.coverageLabel, "2 / 2")
        XCTAssertEqual(mediaStatus.readyCount, 2)
        XCTAssertEqual(mediaStatus.missingCount, 0)
    }

    private func temporaryProjectURL(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }
}

private func writeSyntheticFixtureAssets(at root: URL) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
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
          "segment_ids": [],
          "quality_flags": [],
          "tags": []
        },
        {
          "asset_id": "AST_002",
          "filename": "camera.mxf",
          "role_guess": "b-roll",
          "duration_us": 1000000,
          "has_transcript": false,
          "segment_ids": [],
          "quality_flags": [],
          "tags": []
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
}
