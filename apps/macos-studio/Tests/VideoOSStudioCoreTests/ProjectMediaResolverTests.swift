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
        XCTAssertFalse(reference.isSyntheticPreview)
        XCTAssertFalse(reference.isProxyPreview)
        XCTAssertEqual(reference.viewerStartSeconds, 1)
        XCTAssertEqual(reference.viewerModeLabel, "Source preview")
        XCTAssertFalse(reference.viewerNeedsAttention)
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
        XCTAssertEqual(summary.playableVideoCount, 1)
        XCTAssertEqual(summary.proxyNeededCount, 1)
        XCTAssertEqual(summary.missingCount, 1)
        XCTAssertEqual(summary.syntheticPreviewCount, 0)
        XCTAssertFalse(summary.isViewerVideoReady)
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
        XCTAssertEqual(summary.playableVideoCount, 1)
        XCTAssertEqual(summary.proxyNeededCount, 0)
        XCTAssertTrue(summary.isViewerVideoReady)
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
        XCTAssertTrue(reference.isProxyPreview)
        XCTAssertEqual(reference.viewerModeLabel, "Proxy preview")
        XCTAssertTrue(reference.viewerNeedsAttention)

        let plan = ProjectMediaProxyPlanner.plan(projectURL: root, assets: assets)
        XCTAssertTrue(plan.items.isEmpty)
    }

    func testTimelinePreviewUsesReadyPreviewArtifact() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-\(UUID().uuidString)")
        let previewsDir = root.appendingPathComponent("05_timeline/previews")
        try FileManager.default.createDirectory(at: previewsDir, withIntermediateDirectories: true)
        let preview = previewsDir.appendingPathComponent("preview-abc123.mp4")
        try Data([0, 1, 2]).write(to: preview)
        try """
        {
          "renderSpecHash": "abc123",
          "timelineRevision": "sha256:abc",
          "generatedAt": "2026-06-22T00:00:00Z",
          "status": "ready",
          "warnings": [],
          "videoPath": "preview-abc123.mp4"
        }
        """.write(to: previewsDir.appendingPathComponent("preview.json"), atomically: true, encoding: .utf8)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 12.5
        ))

        XCTAssertEqual(reference.url?.path, preview.path)
        XCTAssertEqual(reference.filename, "preview-abc123.mp4")
        XCTAssertEqual(reference.displayName, "Exact preview")
        XCTAssertEqual(reference.resolvedFrom, "05_timeline/previews")
        XCTAssertTrue(reference.exists)
        XCTAssertTrue(reference.isTimelinePreview)
        XCTAssertTrue(reference.isVideoPlaybackReady)
        XCTAssertEqual(reference.viewerStartSeconds, 12.5, accuracy: 0.001)
        XCTAssertEqual(reference.viewerModeLabel, "Timeline preview")
        XCTAssertFalse(reference.viewerNeedsAttention)
    }

    func testPreferredProgramMediaUsesTimelinePreviewBeforeSourceClip() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-program-preview-priority-\(UUID().uuidString)")
        let preview = root.appendingPathComponent("05_timeline/previews/preview.mp4")
        let source = root.appendingPathComponent("02_media/source/source.mp4")
        try FileManager.default.createDirectory(at: preview.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0]).write(to: preview)
        try Data([1]).write(to: source)

        let timelinePreview = ProjectMediaReference(
            assetID: "timeline-preview",
            filename: "preview.mp4",
            displayName: "Exact preview",
            url: preview,
            exists: true,
            sourceInUS: nil,
            sourceOutUS: nil,
            previewTimeUS: 1_000_000,
            resolvedFrom: "05_timeline/previews"
        )
        let sourceClip = ProjectMediaReference(
            assetID: "AST_SOURCE",
            filename: "source.mp4",
            displayName: "Source",
            url: source,
            exists: true,
            sourceInUS: 10_000_000,
            sourceOutUS: 12_000_000,
            previewTimeUS: 10_000_000,
            resolvedFrom: "02_media/source"
        )

        let preferred = ProjectMediaResolver.preferredProgramMedia(
            timelinePreview: timelinePreview,
            source: sourceClip
        )

        XCTAssertEqual(preferred?.resolvedFrom, "05_timeline/previews")
        XCTAssertEqual(preferred?.url?.path, preview.path)
    }

    func testPreferredProgramMediaFallsBackToSourceWhenNoTimelinePreviewExists() throws {
        let source = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-program-preview-source-\(UUID().uuidString).mp4")
        try Data([1]).write(to: source)
        let sourceClip = ProjectMediaReference(
            assetID: "AST_SOURCE",
            filename: source.lastPathComponent,
            displayName: "Source",
            url: source,
            exists: true,
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            previewTimeUS: 0,
            resolvedFrom: "02_media/source"
        )

        let preferred = ProjectMediaResolver.preferredProgramMedia(
            timelinePreview: nil,
            source: sourceClip
        )

        XCTAssertEqual(preferred?.resolvedFrom, "02_media/source")
        XCTAssertEqual(preferred?.url?.path, source.path)
    }

    func testTimelinePreviewFallsBackToRoughCutAndSkipsExpiredFirst30s() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-roughcut-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let outputDir = root.appendingPathComponent("09_output")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try Data([0]).write(to: timelineDir.appendingPathComponent("preview-first30s.mp4"))
        let roughCut = outputDir.appendingPathComponent("rough-cut.mp4")
        try Data([1]).write(to: roughCut)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 45
        ))

        XCTAssertEqual(reference.url?.path, roughCut.path)
        XCTAssertEqual(reference.displayName, "Rendered rough cut")
        XCTAssertEqual(reference.resolvedFrom, "09_output/rough-cut")
        XCTAssertEqual(reference.viewerStartSeconds, 45, accuracy: 0.001)
    }

    func testTimelinePreviewUsesLatestLegacyEditorPreviewBeforeRenderedFallback() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-legacy-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let outputDir = root.appendingPathComponent("09_output")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try Data([0]).write(to: timelineDir.appendingPathComponent("preview-editor-100.mp4"))
        let latestLegacy = timelineDir.appendingPathComponent("preview-editor-200.mp4")
        try Data([1]).write(to: latestLegacy)
        try Data([2]).write(to: outputDir.appendingPathComponent("rough-cut.mp4"))

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 12
        ))

        XCTAssertEqual(reference.url?.standardizedFileURL.path, latestLegacy.standardizedFileURL.path)
        XCTAssertEqual(reference.displayName, "Legacy editor preview")
        XCTAssertEqual(reference.resolvedFrom, "05_timeline/preview-editor")
        XCTAssertTrue(reference.isTimelinePreview)
        XCTAssertEqual(reference.viewerModeLabel, "Timeline preview")
    }

    func testTimelinePreviewSkipsLegacyEditorPreviewWhenPlayheadExceedsFileDuration() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-short-legacy-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let outputDir = root.appendingPathComponent("09_output")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        let legacyPreview = timelineDir.appendingPathComponent("preview-editor-200.mp4")
        let roughCut = outputDir.appendingPathComponent("rough-cut.mp4")
        try Data([0]).write(to: legacyPreview)
        try Data([1]).write(to: roughCut)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 74.8,
            durationReader: { url in
                url.lastPathComponent == "preview-editor-200.mp4" ? 8 : 90
            }
        ))

        XCTAssertEqual(reference.url?.standardizedFileURL.path, roughCut.standardizedFileURL.path)
        XCTAssertEqual(reference.displayName, "Rendered rough cut")
        XCTAssertEqual(reference.resolvedFrom, "09_output/rough-cut")
    }

    func testProgramMediaFallsBackToSourceWhenOnlyLegacyPreviewIsTooShort() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-program-preview-short-legacy-\(UUID().uuidString)")
        let timelineDir = root.appendingPathComponent("05_timeline")
        let source = root.appendingPathComponent("02_media/source/source.mp4")
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        let legacyPreview = timelineDir.appendingPathComponent("preview-editor-200.mp4")
        try Data([0]).write(to: legacyPreview)
        try Data([1]).write(to: source)

        let timelinePreview = ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 74.8,
            durationReader: { _ in 8 }
        )
        let sourceClip = ProjectMediaReference(
            assetID: "AST_SOURCE",
            filename: "source.mp4",
            displayName: "Source",
            url: source,
            exists: true,
            sourceInUS: 60_000_000,
            sourceOutUS: 75_000_000,
            previewTimeUS: 74_800_000,
            resolvedFrom: "02_media/source"
        )

        let preferred = ProjectMediaResolver.preferredProgramMedia(
            timelinePreview: timelinePreview,
            source: sourceClip
        )

        XCTAssertNil(timelinePreview)
        XCTAssertEqual(preferred?.resolvedFrom, "02_media/source")
        XCTAssertEqual(preferred?.url?.standardizedFileURL.path, source.standardizedFileURL.path)
    }

    func testTimelinePreviewFallsBackToFinalAndPackagedAssembly() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-final-\(UUID().uuidString)")
        let outputDir = root.appendingPathComponent("09_output")
        let packageVideoDir = root.appendingPathComponent("07_package/video")
        let packageDir = root.appendingPathComponent("07_package")
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: packageVideoDir, withIntermediateDirectories: true)
        try Data([0]).write(to: packageDir.appendingPathComponent("assembly.mp4"))
        try Data([1]).write(to: packageVideoDir.appendingPathComponent("final.mp4"))
        let final = outputDir.appendingPathComponent("final.mp4")
        try Data([2]).write(to: final)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 3
        ))

        XCTAssertEqual(reference.url?.path, final.path)
        XCTAssertEqual(reference.displayName, "Final render")
        XCTAssertEqual(reference.resolvedFrom, "09_output/final")
        XCTAssertTrue(reference.isTimelinePreview)
    }

    func testTimelinePreviewFallsBackToLatestRenderedOutputBeforePackagedMedia() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-latest-output-\(UUID().uuidString)")
        let outputDir = root.appendingPathComponent("09_output")
        let packageVideoDir = root.appendingPathComponent("07_package/video")
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: packageVideoDir, withIntermediateDirectories: true)
        try Data([0]).write(to: packageVideoDir.appendingPathComponent("final.mp4"))

        let older = outputDir.appendingPathComponent("ax1_promo_v4.mp4")
        let rawSidecar = outputDir.appendingPathComponent("ax1_promo_v5.raw.mp4")
        let latest = outputDir.appendingPathComponent("ax1_promo_v5.mp4")
        try Data([1]).write(to: older)
        try Data([2]).write(to: rawSidecar)
        try Data([3]).write(to: latest)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 100)], ofItemAtPath: older.path)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 300)], ofItemAtPath: rawSidecar.path)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 200)], ofItemAtPath: latest.path)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 5
        ))

        XCTAssertEqual(reference.url?.standardizedFileURL.path, latest.standardizedFileURL.path)
        XCTAssertEqual(reference.filename, "ax1_promo_v5.mp4")
        XCTAssertEqual(reference.displayName, "Latest rendered output")
        XCTAssertEqual(reference.resolvedFrom, "09_output/latest")
        XCTAssertTrue(reference.isTimelinePreview)
        XCTAssertEqual(reference.viewerModeLabel, "Timeline preview")
    }

    func testTimelinePreviewFallsBackToPackagedAssemblyWhenNoFinalRenderExists() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-timeline-preview-assembly-\(UUID().uuidString)")
        let packageDir = root.appendingPathComponent("07_package")
        try FileManager.default.createDirectory(at: packageDir, withIntermediateDirectories: true)
        let assembly = packageDir.appendingPathComponent("assembly.mp4")
        try Data([0]).write(to: assembly)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveTimelinePreview(
            projectURL: root,
            playheadSeconds: 4
        ))

        XCTAssertEqual(reference.url?.path, assembly.path)
        XCTAssertEqual(reference.displayName, "Packaged assembly preview")
        XCTAssertEqual(reference.resolvedFrom, "07_package/assembly")
        XCTAssertTrue(reference.isTimelinePreview)
    }

    func testViewerDiagnosticExplainsMissingProjectMediaWhenNoClipIsResolved() {
        let summary = ProjectMediaPreviewSummary(items: [
            previewStatus(assetID: "AST_MISSING", filename: "missing.mov", status: .missing)
        ])

        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: nil,
            previewSummary: summary
        )

        XCTAssertEqual(diagnostic.title, "Source media unavailable")
        XCTAssertEqual(diagnostic.action, .relinkSourceMedia)
        XCTAssertEqual(diagnostic.actionLabel, "Relink source media")
        XCTAssertEqual(diagnostic.severity, .warning)
        XCTAssertTrue(diagnostic.detail.contains("1 asset(s) are missing"))
    }

    func testViewerDiagnosticExplainsProxyRequirementWhenNoClipIsResolved() {
        let summary = ProjectMediaPreviewSummary(items: [
            previewStatus(assetID: "AST_PROXY", filename: "camera.mxf", status: .needsProxy)
        ])

        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: nil,
            previewSummary: summary
        )

        XCTAssertEqual(diagnostic.title, "Preview proxies needed")
        XCTAssertEqual(diagnostic.action, .buildPreviewProxies)
        XCTAssertEqual(diagnostic.actionLabel, "Build preview proxies")
        XCTAssertEqual(diagnostic.severity, .warning)
    }

    func testViewerDiagnosticExposesBuildPreviewMediaActionWhenNoPlayableVideoExists() {
        let summary = ProjectMediaPreviewSummary(items: [
            previewStatus(assetID: "AST_AUDIO", filename: "voice.wav", status: .directAudio)
        ])

        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: nil,
            previewSummary: summary
        )

        XCTAssertEqual(diagnostic.title, "No playable video")
        XCTAssertEqual(diagnostic.action, .buildPreviewMedia)
        XCTAssertEqual(diagnostic.actionLabel, "Build preview media")
        XCTAssertEqual(diagnostic.severity, .warning)
    }

    func testViewerDiagnosticPromptsForPlayheadWhenPlayableMediaExistsButNoClipIsResolved() {
        let summary = ProjectMediaPreviewSummary(items: [
            previewStatus(assetID: "AST_READY", filename: "ready.mov", status: .directVideo)
        ])

        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: nil,
            previewSummary: summary
        )

        XCTAssertEqual(diagnostic.title, "Move playhead onto a clip")
        XCTAssertNil(diagnostic.actionLabel)
        XCTAssertEqual(diagnostic.severity, .info)
    }

    func testViewerDiagnosticExplainsMissingResolvedMedia() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-viewer-diagnostic-missing-\(UUID().uuidString)")
        let reference = ProjectMediaReference(
            assetID: "AST_001",
            filename: "missing.mov",
            displayName: "Missing",
            url: root.appendingPathComponent("02_media/source/missing.mov"),
            exists: false,
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            previewTimeUS: nil,
            resolvedFrom: "02_media/source"
        )

        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: reference,
            previewSummary: ProjectMediaPreviewSummary(items: [])
        )

        XCTAssertEqual(diagnostic.title, "Source media unavailable")
        XCTAssertEqual(diagnostic.action, .relinkSourceMedia)
        XCTAssertEqual(diagnostic.actionLabel, "Relink source media")
        XCTAssertEqual(diagnostic.severity, .warning)
        XCTAssertTrue(diagnostic.detail.contains("missing.mov"))
    }

    func testViewerDiagnosticMarksReadySourcePreview() {
        let reference = ProjectMediaReference(
            assetID: "AST_001",
            filename: "ready.mov",
            displayName: "Ready",
            url: URL(fileURLWithPath: "/tmp/ready.mov"),
            exists: true,
            sourceInUS: 0,
            sourceOutUS: 1_000_000,
            previewTimeUS: nil,
            resolvedFrom: "02_media/source"
        )

        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: reference,
            previewSummary: ProjectMediaPreviewSummary(items: [])
        )

        XCTAssertEqual(diagnostic.title, "Source preview ready")
        XCTAssertNil(diagnostic.actionLabel)
        XCTAssertEqual(diagnostic.severity, .ready)
    }

    func testSyntheticReferenceReportsViewerStartAtZero() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-synthetic-\(UUID().uuidString)")
        let mediaDir = root.appendingPathComponent("02_media")
        let syntheticDir = mediaDir.appendingPathComponent("synthetic")
        try FileManager.default.createDirectory(at: syntheticDir, withIntermediateDirectories: true)
        let synthetic = syntheticDir.appendingPathComponent("demo.mp4")
        try Data([0, 1, 2]).write(to: synthetic)
        try """
        {
          "version": "1",
          "project_id": "demo",
          "media_dir": "02_media",
          "generated_at": "2026-05-22T00:00:00Z",
          "items": [
            {
              "asset_id": "AST_001",
              "source_locator": "02_media/synthetic/demo.mp4",
              "local_source_path": "\(synthetic.path)",
              "link_path": "02_media/synthetic/demo.mp4",
              "display_name": "Synthetic Demo"
            }
          ]
        }
        """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

        let reference = try XCTUnwrap(ProjectMediaResolver.resolveSelectedClip(
            projectURL: root,
            clip: mediaResolverClip,
            assets: nil,
            previewTimeUS: 12_000_000
        ))

        XCTAssertTrue(reference.exists)
        XCTAssertTrue(reference.isSyntheticPreview)
        XCTAssertEqual(reference.sourceStartSeconds, 12)
        XCTAssertEqual(reference.viewerStartSeconds, 0)
        XCTAssertEqual(reference.viewerModeLabel, "Synthetic preview")
        XCTAssertTrue(reference.viewerNeedsAttention)
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

    func testRelinkerRequiresExplicitFlagBeforeReplacingSyntheticPreview() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-media-relink-synthetic-\(UUID().uuidString)")
        let analysisDir = root.appendingPathComponent("03_analysis")
        let mediaDir = root.appendingPathComponent("02_media")
        let syntheticDir = mediaDir.appendingPathComponent("synthetic")
        let externalDir = root.appendingPathComponent("external-media")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: syntheticDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: externalDir, withIntermediateDirectories: true)
        let synthetic = syntheticDir.appendingPathComponent("interview.mp4")
        let source = externalDir.appendingPathComponent("interview.mp4")
        try Data([0]).write(to: synthetic)
        try Data([1, 2, 3]).write(to: source)
        try """
        {
          "project_id": "demo",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "interview.mp4",
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
        try """
        {
          "version": "1",
          "project_id": "demo",
          "media_dir": "02_media",
          "generated_at": "2026-05-22T00:00:00Z",
          "items": [
            {
              "asset_id": "AST_001",
              "source_locator": "02_media/synthetic/interview.mp4",
              "local_source_path": "\(synthetic.path)",
              "link_path": "02_media/synthetic/interview.mp4",
              "display_name": "Synthetic Demo"
            }
          ]
        }
        """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

        let defaultPlan = ProjectMediaRelinker.plan(projectURL: root, searchRoots: [externalDir])

        XCTAssertEqual(defaultPlan.statusLabel, "no relinks needed")
        XCTAssertFalse(defaultPlan.canApply)
        XCTAssertEqual(defaultPlan.items, [])

        let syntheticPlan = ProjectMediaRelinker.plan(
            projectURL: root,
            searchRoots: [externalDir],
            includeSynthetic: true
        )

        XCTAssertEqual(syntheticPlan.statusLabel, "1 matched")
        XCTAssertEqual(syntheticPlan.syntheticAssetCount, 1)
        XCTAssertEqual(ProjectMediaResolver.previewSummary(projectURL: root, assets: nil).syntheticPreviewCount, 1)
        XCTAssertEqual(syntheticPlan.items.first?.reason, .syntheticPreview)
        XCTAssertEqual(syntheticPlan.items.first?.currentURL?.standardizedFileURL.path, synthetic.standardizedFileURL.path)
        XCTAssertEqual(syntheticPlan.items.first?.candidateURL?.standardizedFileURL.path, source.standardizedFileURL.path)

        let result = try ProjectMediaRelinker.apply(plan: syntheticPlan, generatedAt: Date(timeIntervalSince1970: 0))
        let reference = try XCTUnwrap(ProjectMediaResolver.resolveSelectedClip(
            projectURL: root,
            clip: mediaResolverClip,
            assets: nil
        ))

        XCTAssertEqual(result.linkedCount, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.symlinkURLs[0].path))
        XCTAssertEqual(reference.url?.standardizedFileURL.path, source.standardizedFileURL.path)
        XCTAssertFalse(reference.isSyntheticPreview)
        XCTAssertEqual(reference.viewerModeLabel, "Source preview")
        XCTAssertFalse(reference.viewerNeedsAttention)
        XCTAssertEqual(ProjectMediaResolver.previewSummary(projectURL: root, assets: nil).syntheticPreviewCount, 0)
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

private func previewStatus(
    assetID: String,
    filename: String,
    status: ProjectMediaPreviewStatus.PlaybackStatus
) -> ProjectMediaPreviewStatus {
    ProjectMediaPreviewStatus(
        assetID: assetID,
        filename: filename,
        url: URL(fileURLWithPath: "/tmp/\(filename)"),
        exists: status != .missing,
        resolvedFrom: "fixture",
        playbackStatus: status
    )
}
