import XCTest
@testable import VideoOSStudioCore

final class ProjectMediaResolverTests: XCTestCase {
    func testResolveSelectedClipPrefersSourceMapEntry() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-resolver-\(UUID().uuidString)")
        let mediaDir = root.appendingPathComponent("02_media")
        let sourceDir = mediaDir.appendingPathComponent("source")
        try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
        let source = sourceDir.appendingPathComponent("interview.mov")
        try Data([0, 1, 2]).write(to: source)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "media_dir": "02_media",
          "generated_at": "2026-05-22T00:00:00Z",
          "items": [
            {
              "asset_id": "AST_001",
              "source_locator": "02_media/source/interview.mov",
              "local_source_path": "\(source.path)",
              "link_path": "02_media/interview.mov",
              "display_name": "Interview A"
            }
          ]
        }
        """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveSelectedClip(
            projectURL: root,
            clip: mediaResolverClip,
            assets: nil
        ))

        XCTAssertEqual(reference.assetID, "AST_001")
        XCTAssertEqual(reference.displayName, "Interview A")
        XCTAssertEqual(reference.url?.standardizedFileURL.path, source.standardizedFileURL.path)
        XCTAssertTrue(reference.exists)
        XCTAssertEqual(reference.resolvedFrom, "source_map.local_source_path")
        XCTAssertEqual(reference.sourceRangeLabel, "0:01-0:04")
    }

    func testResolveSelectedClipFallsBackToMissingSourceFilename() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-resolver-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let assets = try JSONDecoder().decode(AnalysisAssetDocument.self, from: Data("""
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "interview.mov",
              "role_guess": "interview",
              "duration_us": 10000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            }
          ]
        }
        """.utf8))

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveSelectedClip(
            projectURL: root,
            clip: mediaResolverClip,
            assets: assets
        ))

        XCTAssertEqual(reference.filename, "interview.mov")
        XCTAssertEqual(reference.url?.path, root.appendingPathComponent("02_media/source/interview.mov").path)
        XCTAssertFalse(reference.exists)
        XCTAssertFalse(reference.isVideoPlaybackReady)
        XCTAssertFalse(reference.isAudioPlaybackReady)
        XCTAssertEqual(reference.resolvedFrom, "02_media/source")
    }

    func testPreviewSummaryClassifiesDirectMissingAndProxyNeededAssets() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-preview-\(UUID().uuidString)")
        let mediaDir = root.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        try Data([0]).write(to: mediaDir.appendingPathComponent("ready.mov"))
        try Data([0]).write(to: mediaDir.appendingPathComponent("needs.mxf"))
        let analysisDir = root.appendingPathComponent("03_analysis")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try """
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_READY",
              "filename": "ready.mov",
              "role_guess": "b-roll",
              "duration_us": 1000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            },
            {
              "asset_id": "AST_PROXY",
              "filename": "needs.mxf",
              "role_guess": "b-roll",
              "duration_us": 1000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            },
            {
              "asset_id": "AST_MISSING",
              "filename": "missing.mov",
              "role_guess": "interview",
              "duration_us": 1000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

        let summary = ProjectMediaResolver.previewSummary(projectURL: root, assets: nil)

        XCTAssertEqual(summary.items.map(\.assetID), ["AST_READY", "AST_PROXY", "AST_MISSING"])
        XCTAssertEqual(summary.readyCount, 1)
        XCTAssertEqual(summary.proxyNeededCount, 1)
        XCTAssertEqual(summary.missingCount, 1)
        XCTAssertEqual(summary.items[0].playbackStatus, .directVideo)
        XCTAssertEqual(summary.items[1].playbackStatus, .needsProxy)
        XCTAssertEqual(summary.items[2].playbackStatus, .missing)

        let plan = ProjectMediaProxyPlanner.plan(projectURL: root, assets: nil)
        XCTAssertEqual(plan.totalCount, 1)
        XCTAssertEqual(plan.pendingCount, 1)
        XCTAssertEqual(plan.items.first?.assetID, "AST_PROXY")
        XCTAssertEqual(plan.items.first?.outputURL.path, root.appendingPathComponent("02_media/proxy/AST_PROXY.mp4").path)
        XCTAssertTrue(plan.items.first?.commandLine.contains("ffmpeg") == true)
        XCTAssertTrue(plan.items.first?.ffmpegArguments.contains("libx264") == true)
        XCTAssertTrue(plan.items.first?.ffmpegArguments.contains("-hide_banner") == true)
        XCTAssertTrue(plan.items.first?.ffmpegArguments.contains("scale='min(1280,iw)':-2") == true)
    }

    func testExistingProxyMakesUnsupportedSourceReadyForViewer() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-proxy-\(UUID().uuidString)")
        let sourceDir = root.appendingPathComponent("02_media/source")
        let proxyDir = root.appendingPathComponent("02_media/proxy")
        try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: proxyDir, withIntermediateDirectories: true)
        try Data([0]).write(to: sourceDir.appendingPathComponent("camera.mxf"))
        let proxyURL = proxyDir.appendingPathComponent("AST_001.mp4")
        try Data([1]).write(to: proxyURL)

        let assets = try JSONDecoder().decode(AnalysisAssetDocument.self, from: Data("""
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "camera.mxf",
              "role_guess": "interview",
              "duration_us": 10000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            }
          ]
        }
        """.utf8))

        let summary = ProjectMediaResolver.previewSummary(projectURL: root, assets: assets)
        XCTAssertEqual(summary.readyCount, 1)
        XCTAssertEqual(summary.proxyNeededCount, 0)
        XCTAssertEqual(summary.items.first?.playbackStatus, .proxyVideo)
        XCTAssertEqual(summary.items.first?.url?.path, proxyURL.path)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveSelectedClip(
            projectURL: root,
            clip: mediaResolverClip,
            assets: assets
        ))
        XCTAssertEqual(reference.url?.path, proxyURL.path)
        XCTAssertTrue(reference.isPlayableVideo)
        XCTAssertTrue(reference.isVideoPlaybackReady)
        XCTAssertTrue(reference.isAudioPlaybackReady)
        XCTAssertEqual(reference.resolvedFrom, "02_media/proxy")

        let plan = ProjectMediaProxyPlanner.plan(projectURL: root, assets: assets)
        XCTAssertTrue(plan.items.isEmpty)
    }

    func testRelinkerPlansAndWritesSourceMapForMissingAssets() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-relink-\(UUID().uuidString)")
        let analysisDir = root.appendingPathComponent("03_analysis")
        let externalDir = root.appendingPathComponent("external-media")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: externalDir, withIntermediateDirectories: true)
        let source = externalDir.appendingPathComponent("interview.mov")
        try Data([0, 1, 2]).write(to: source)
        try """
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "interview.mov",
              "role_guess": "interview",
              "duration_us": 10000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

        let plan = ProjectMediaRelinker.plan(projectURL: root, searchRoots: [externalDir])

        XCTAssertEqual(plan.statusLabel, "1 matched")
        XCTAssertTrue(plan.canApply)
        XCTAssertEqual(plan.matchedCount, 1)
        XCTAssertEqual(plan.items.first?.candidateURL?.standardizedFileURL.path, source.standardizedFileURL.path)

        let result = try ProjectMediaRelinker.apply(plan: plan, generatedAt: Date(timeIntervalSince1970: 0))
        let summary = ProjectMediaResolver.previewSummary(projectURL: root, assets: nil)

        XCTAssertEqual(result.linkedCount, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.sourceMapURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.symlinkURLs[0].path))
        let symlinkDestination = try FileManager.default.destinationOfSymbolicLink(atPath: result.symlinkURLs[0].path)
        XCTAssertEqual(URL(fileURLWithPath: symlinkDestination).standardizedFileURL.path, source.standardizedFileURL.path)
        XCTAssertEqual(summary.readyCount, 1)
        XCTAssertEqual(summary.missingCount, 0)
        XCTAssertEqual(summary.items.first?.resolvedFrom, "source_map.local_source_path")
    }

    func testRelinkerRefusesToOverwriteNonSymlinkRelinkPath() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-relink-overwrite-\(UUID().uuidString)")
        let analysisDir = root.appendingPathComponent("03_analysis")
        let externalDir = root.appendingPathComponent("external-media")
        let relinkDir = root.appendingPathComponent("02_media/relinked")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: externalDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: relinkDir, withIntermediateDirectories: true)
        try Data([0]).write(to: externalDir.appendingPathComponent("interview.mov"))
        try Data([1]).write(to: relinkDir.appendingPathComponent("AST_001-interview.mov"))
        try """
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "interview.mov",
              "role_guess": "interview",
              "duration_us": 10000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

        let plan = ProjectMediaRelinker.plan(projectURL: root, searchRoots: [externalDir])

        XCTAssertThrowsError(try ProjectMediaRelinker.apply(plan: plan)) { error in
            guard case ProjectMediaRelinkError.refusingToOverwriteNonSymlink = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testProxyBuilderRunsPlannedTranscodeThroughInjectableRunner() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-proxy-build-\(UUID().uuidString)")
        let sourceDir = root.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
        try Data([0]).write(to: sourceDir.appendingPathComponent("camera.mxf"))

        let assets = try JSONDecoder().decode(AnalysisAssetDocument.self, from: Data("""
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_BUILD",
              "filename": "camera.mxf",
              "role_guess": "interview",
              "duration_us": 10000000,
              "has_transcript": false,
              "segment_ids": [],
              "quality_flags": [],
              "tags": []
            }
          ]
        }
        """.utf8))

        var capturedArguments: [[String]] = []
        let result = ProjectMediaProxyBuilder.build(projectURL: root, assets: assets) { arguments in
            capturedArguments.append(arguments)
            let output = try XCTUnwrap(arguments.last)
            try Data([1]).write(to: URL(fileURLWithPath: output))
        }

        XCTAssertEqual(result.plan.totalCount, 1)
        XCTAssertEqual(result.builtCount, 1)
        XCTAssertEqual(result.skippedCount, 0)
        XCTAssertTrue(result.failures.isEmpty)
        XCTAssertEqual(capturedArguments.count, 1)
        XCTAssertTrue(capturedArguments[0].contains("libx264"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("02_media/proxy/AST_BUILD.mp4").path))
    }
}

private let mediaResolverClip: TimelineClip = {
    let data = Data("""
    {
      "clip_id": "CLP_001",
      "segment_id": "SEG_001",
      "asset_id": "AST_001",
      "src_in_us": 1000000,
      "src_out_us": 4200000,
      "timeline_in_frame": 0,
      "timeline_duration_frames": 77,
      "role": "hero",
      "motivation": "fixture",
      "fallback_segment_ids": [],
      "quality_flags": []
    }
    """.utf8)
    return try! JSONDecoder().decode(TimelineClip.self, from: data)
}()
