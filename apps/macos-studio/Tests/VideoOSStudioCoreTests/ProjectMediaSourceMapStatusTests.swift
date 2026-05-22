import XCTest
@testable import VideoOSStudioCore

final class ProjectMediaSourceMapStatusTests: XCTestCase {
    func testStatusReportsMissingSourceMapForAnalyzedAssets() throws {
        let root = temporaryProjectURL("videoos-source-map-missing")
        try writeSourceMapStatusAssets(at: root, assetCount: 2)

        let status = ProjectMediaSourceMapStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "source map missing")
        XCTAssertFalse(status.exists)
        XCTAssertEqual(status.assetCount, 2)
        XCTAssertEqual(status.coverageLabel, "0 / 2")
        XCTAssertEqual(status.missingAssetIDs, ["AST_001", "AST_002"])
        XCTAssertTrue(status.recommendation.contains("Relink missing media"))
    }

    func testStatusReportsBrokenAndIncompleteEntries() throws {
        let root = temporaryProjectURL("videoos-source-map-broken")
        let mediaDir = root.appendingPathComponent("02_media")
        try writeSourceMapStatusAssets(at: root, assetCount: 2)
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "media_dir": "02_media",
          "generated_at": "2026-05-22T00:00:00Z",
          "items": [
            {
              "asset_id": "AST_001",
              "source_locator": "missing.mov",
              "local_source_path": "\(root.appendingPathComponent("external/missing.mov").path)",
              "link_path": "02_media/relinked/AST_001-missing.mov"
            }
          ]
        }
        """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

        let status = ProjectMediaSourceMapStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "source map incomplete")
        XCTAssertTrue(status.exists)
        XCTAssertEqual(status.entryCount, 1)
        XCTAssertEqual(status.coveredAssetCount, 1)
        XCTAssertEqual(status.readyAssetCount, 0)
        XCTAssertEqual(status.missingAssetIDs, ["AST_002"])
        XCTAssertEqual(status.brokenEntries.map(\.assetID), ["AST_001"])
        XCTAssertEqual(status.absoluteLocalPathCount, 1)
    }

    func testSuggestedSearchRootsComeFromBrokenAbsoluteSourceMapPaths() throws {
        let root = temporaryProjectURL("videoos-source-map-suggestions")
        let mediaDir = root.appendingPathComponent("02_media")
        let externalDir = root.appendingPathComponent("external")
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: externalDir, withIntermediateDirectories: true)
        try writeSourceMapStatusAssets(at: root, assetCount: 2)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "media_dir": "02_media",
          "generated_at": "2026-05-22T00:00:00Z",
          "items": [
            {
              "asset_id": "AST_001",
              "source_locator": "\(externalDir.appendingPathComponent("asset-1.mov").path)",
              "local_source_path": "\(externalDir.appendingPathComponent("asset-1.mov").path)",
              "link_path": "02_media/relinked/AST_001-asset-1.mov"
            },
            {
              "asset_id": "AST_002",
              "source_locator": "\(externalDir.appendingPathComponent("asset-2.mov").path)",
              "local_source_path": "\(externalDir.appendingPathComponent("asset-2.mov").path)",
              "link_path": "02_media/relinked/AST_002-asset-2.mov"
            }
          ]
        }
        """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

        let suggestions = ProjectMediaRelinker.suggestedSearchRoots(projectURL: root)

        XCTAssertEqual(suggestions.map(\.url.path), [externalDir.path])
        XCTAssertEqual(suggestions.first?.referencedAssetCount, 4)
        XCTAssertEqual(suggestions.first?.exists, true)
        XCTAssertEqual(ProjectMediaRelinker.availableSuggestedSearchRoots(projectURL: root).map(\.path), [externalDir.path])
    }

    func testAvailableSuggestedSearchRootsFiltersUnmountedDirectories() throws {
        let root = temporaryProjectURL("videoos-source-map-unmounted-suggestions")
        let mediaDir = root.appendingPathComponent("02_media")
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        try writeSourceMapStatusAssets(at: root, assetCount: 1)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "media_dir": "02_media",
          "generated_at": "2026-05-22T00:00:00Z",
          "items": [
            {
              "asset_id": "AST_001",
              "source_locator": "\(root.appendingPathComponent("not-mounted/asset-1.mov").path)",
              "local_source_path": "\(root.appendingPathComponent("not-mounted/asset-1.mov").path)",
              "link_path": "02_media/relinked/AST_001-asset-1.mov"
            }
          ]
        }
        """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

        let suggestions = ProjectMediaRelinker.suggestedSearchRoots(projectURL: root)

        XCTAssertEqual(suggestions.count, 1)
        XCTAssertFalse(try XCTUnwrap(suggestions.first).exists)
        XCTAssertEqual(ProjectMediaRelinker.availableSuggestedSearchRoots(projectURL: root), [])
    }

    func testStatusReportsReadySourceMapWithRelinkedSymlink() throws {
        let root = temporaryProjectURL("videoos-source-map-ready")
        let externalDir = root.appendingPathComponent("external")
        try FileManager.default.createDirectory(at: externalDir, withIntermediateDirectories: true)
        let source = externalDir.appendingPathComponent("asset-1.mov")
        try Data([0]).write(to: source)
        try writeSourceMapStatusAssets(at: root, assetCount: 1)
        let plan = ProjectMediaRelinker.plan(projectURL: root, searchRoots: [externalDir])
        _ = try ProjectMediaRelinker.apply(plan: plan, generatedAt: Date(timeIntervalSince1970: 0))

        let status = ProjectMediaSourceMapStatusReader.status(projectURL: root)

        XCTAssertEqual(status.readinessLabel, "source map ready")
        XCTAssertTrue(status.exists)
        XCTAssertEqual(status.coverageLabel, "1 / 1")
        XCTAssertEqual(status.readyAssetCount, 1)
        XCTAssertEqual(status.brokenEntries, [])
        XCTAssertEqual(status.relinkedSymlinkCount, 1)
        XCTAssertEqual(status.absoluteLocalPathCount, 1)
    }

    private func temporaryProjectURL(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }
}

private func writeSourceMapStatusAssets(at root: URL, assetCount: Int) throws {
    let analysisDir = root.appendingPathComponent("03_analysis")
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
    let items = (1...assetCount).map { index in
        """
        {
          "asset_id": "AST_\(String(format: "%03d", index))",
          "filename": "asset-\(index).mov",
          "role_guess": "interview",
          "duration_us": 1000000,
          "has_transcript": false,
          "segment_ids": [],
          "quality_flags": [],
          "tags": []
        }
        """
    }.joined(separator: ",")
    let json = """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [\(items)]
    }
    """
    try json.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
}
