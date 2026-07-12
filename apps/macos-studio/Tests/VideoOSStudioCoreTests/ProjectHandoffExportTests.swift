import XCTest
@testable import VideoOSStudioCore

final class ProjectHandoffExportTests: XCTestCase {
    func testPlanRequiresTimelineAndSourceMap() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-handoff-plan-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let plan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: root)

        XCTAssertFalse(plan.canExportPremiereXML)
        XCTAssertEqual(plan.readinessLabel, "timeline missing")
        XCTAssertFalse(plan.timelineExists)
        XCTAssertFalse(plan.sourceMapExists)
        XCTAssertEqual(plan.sourceMapEntryCount, 0)
        XCTAssertEqual(plan.generatedSourceMapEntryCount, 0)
    }

    func testPlanBuildsPremiereXMLCommandAndOutputPath() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-handoff-repo-\(UUID().uuidString)")
        let project = repo.appendingPathComponent("projects/demo")
        try writeHandoffFixtureProject(at: project)

        let plan = ProjectHandoffExporter.plan(repositoryRoot: repo, projectURL: project)

        XCTAssertTrue(plan.canExportPremiereXML)
        XCTAssertEqual(plan.projectID, "demo")
        XCTAssertTrue(plan.timelineExists)
        XCTAssertTrue(plan.sourceMapExists)
        XCTAssertEqual(plan.sourceMapEntryCount, 1)
        XCTAssertEqual(plan.generatedSourceMapEntryCount, 0)
        XCTAssertEqual(plan.sourceMapReadinessLabel, "source map has broken paths")
        XCTAssertEqual(plan.sourceMapCoverageLabel, "1 / 1")
        XCTAssertEqual(plan.sourceMapReadyAssetCount, 0)
        XCTAssertEqual(plan.sourceMapMissingEntryCount, 0)
        XCTAssertEqual(plan.sourceMapBrokenEntryCount, 1)
        XCTAssertFalse(plan.usesTemporarySourceMap)
        XCTAssertEqual(plan.mediaMissingCount, 1)
        XCTAssertFalse(plan.editorAnnotationExists)
        XCTAssertEqual(plan.editorAnnotationNoteCount, 0)
        XCTAssertEqual(plan.readinessLabel, "exportable with 1 relinks")
        XCTAssertEqual(plan.outputURL.path, project.appendingPathComponent("09_output/demo_premiere.xml").path)
        XCTAssertEqual(plan.commandArguments, [
            "npx",
            "tsx",
            "scripts/export-premiere-xml.ts",
            project.path,
            "--auto-titles"
        ])
    }

    func testPlanDistinguishesTemporarySourceMapFallback() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-handoff-temporary-source-map-\(UUID().uuidString)")
        let project = repo.appendingPathComponent("projects/demo")
        try writeHandoffFixtureProject(at: project)
        try FileManager.default.removeItem(at: project.appendingPathComponent("02_media/source_map.json"))

        let plan = ProjectHandoffExporter.plan(repositoryRoot: repo, projectURL: project)

        XCTAssertTrue(plan.canExportPremiereXML)
        XCTAssertFalse(plan.sourceMapExists)
        XCTAssertEqual(plan.sourceMapEntryCount, 0)
        XCTAssertEqual(plan.generatedSourceMapEntryCount, 1)
        XCTAssertEqual(plan.sourceMapReadinessLabel, "source map missing")
        XCTAssertEqual(plan.sourceMapCoverageLabel, "0 / 1")
        XCTAssertEqual(plan.sourceMapMissingEntryCount, 1)
        XCTAssertTrue(plan.usesTemporarySourceMap)
        XCTAssertEqual(plan.readinessLabel, "exportable with temporary source map and 1 relinks")
    }

    func testPlanReportsEditorAnnotationNoteCount() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-handoff-annotations-\(UUID().uuidString)")
        let project = repo.appendingPathComponent("projects/demo")
        try writeHandoffFixtureProject(at: project)
        let handoffDir = project.appendingPathComponent("07_handoff")
        try FileManager.default.createDirectory(at: handoffDir, withIntermediateDirectories: true)
        try """
        {
          "version": "editor-annotations-v1",
          "project_id": "demo",
          "updated_at": "2026-05-22T00:00:00Z",
          "notes": [
            {
              "clip_id": "clip-001",
              "track_id": "V1",
              "track_kind": "video",
              "asset_id": "AST_001",
              "segment_id": "SEG_001",
              "timeline_in_frame": 0,
              "timeline_out_frame": 24,
              "timecode_in": "00:00:00:00",
              "timecode_out": "00:00:01:00",
              "note": "Keep the breath before the first line.",
              "handoff_instruction": "Keep the breath before the first line.",
              "author": "operator",
              "updated_at": "2026-05-22T00:00:00Z"
            }
          ]
        }
        """.write(to: handoffDir.appendingPathComponent("editor_annotations.json"), atomically: true, encoding: .utf8)

        let plan = ProjectHandoffExporter.plan(repositoryRoot: repo, projectURL: project)

        XCTAssertTrue(plan.editorAnnotationExists)
        XCTAssertEqual(plan.editorAnnotationNoteCount, 1)
    }

    func testEditorPacketExportsPremiereXMLAnnotationsAndManifest() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-editor-packet-\(UUID().uuidString)")
        let project = repo.appendingPathComponent("projects/demo")
        try writeHandoffFixtureProject(at: project)
        let outputDir = project.appendingPathComponent("09_output")
        let handoffDir = project.appendingPathComponent("07_handoff")
        let reviewDir = project.appendingPathComponent("06_review")
        let timelineDir = project.appendingPathComponent("05_timeline")
        let audioPackageDir = project.appendingPathComponent("07_package/audio")
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: handoffDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: audioPackageDir, withIntermediateDirectories: true)
        try "<xmeml version=\"5\"></xmeml>"
            .write(to: outputDir.appendingPathComponent("demo_premiere.xml"), atomically: true, encoding: .utf8)
        try Data([0x00, 0x01, 0x02])
            .write(to: timelineDir.appendingPathComponent("preview-first30s.mp4"), options: .atomic)
        try Data([0x03, 0x04, 0x05])
            .write(to: outputDir.appendingPathComponent("final.mp4"), options: .atomic)
        try Data([0x06, 0x07, 0x08])
            .write(to: audioPackageDir.appendingPathComponent("final_mix.wav"), options: .atomic)
        try """
        {
          "version": "editor-annotations-v1",
          "project_id": "demo",
          "updated_at": "2026-05-22T00:00:00Z",
          "notes": [
            {
              "clip_id": "clip-001",
              "track_id": "V1",
              "track_kind": "video",
              "asset_id": "AST_001",
              "segment_id": "SEG_001",
              "timeline_in_frame": 0,
              "timeline_out_frame": 24,
              "timecode_in": "00:00:00:00",
              "timecode_out": "00:00:01:00",
              "note": "Keep the breath before the first line.",
              "handoff_instruction": "Keep the breath before the first line.",
              "author": "operator",
              "updated_at": "2026-05-22T00:00:00Z"
            }
          ]
        }
        """.write(to: handoffDir.appendingPathComponent("editor_annotations.json"), atomically: true, encoding: .utf8)
        try """
        version: "1"
        project_id: demo
        timeline_version: "1"
        preview_path: 05_timeline/preview-first30s.mp4
        summary_judgment:
          status: needs_revision
          rationale: "Hook needs tighter trim before delivery."
        strengths: []
        weaknesses: []
        fatal_issues: []
        warnings: []
        mismatches_to_brief: []
        mismatches_to_blueprint: []
        recommended_next_pass:
          goal: "Tighten hook and verify sound bridge."
          actions:
            - "Trim the first hero shot by two frames."
            - "Check dialogue clarity before export."
          preserve: []
        """.write(to: reviewDir.appendingPathComponent("review_report.yaml"), atomically: true, encoding: .utf8)
        try #"{"timeline_version":"1","operations":[]}"#
            .write(to: reviewDir.appendingPathComponent("review_patch.json"), atomically: true, encoding: .utf8)

        let date = ISO8601DateFormatter().date(from: "2026-05-22T00:00:00Z")!
        let result = try ProjectEditorPacketExporter.export(
            repositoryRoot: repo,
            projectURL: project,
            exportPremiereXML: false,
            generatedAt: date
        )

        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("demo_premiere.xml").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("editor_notes.md").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("editor_annotations.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("review_report.yaml").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("review_patch.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("media/preview_media-preview-first30s.mp4").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("media/final_media-final.mp4").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("media/final_audio-final_mix.wav").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.manifestURL.path))
        XCTAssertEqual(result.files.map(\.lastPathComponent).sorted(), [
            "demo_premiere.xml",
            "editor_annotations.json",
            "editor_notes.md",
            "final_audio-final_mix.wav",
            "final_media-final.mp4",
            "manifest.json",
            "preview_media-preview-first30s.mp4",
            "review_patch.json",
            "review_report.yaml"
        ])
        let notes = try String(contentsOf: result.packetURL.appendingPathComponent("editor_notes.md"), encoding: .utf8)
        XCTAssertTrue(notes.contains("# Editor Packet"))
        XCTAssertTrue(notes.contains("Keep the breath before the first line."))
        XCTAssertTrue(notes.contains("Source map: source map has broken paths (1 / 1)"))
        XCTAssertTrue(notes.contains("Temporary source map: no"))
        XCTAssertTrue(notes.contains("## Review Summary"))
        XCTAssertTrue(notes.contains("Hook needs tighter trim before delivery."))
        XCTAssertTrue(notes.contains("Trim the first hero shot by two frames."))
        XCTAssertTrue(notes.contains("## Included Media"))
        XCTAssertTrue(notes.contains("preview_media: media/preview_media-preview-first30s.mp4"))
        XCTAssertTrue(notes.contains("final_media: media/final_media-final.mp4"))
        XCTAssertTrue(notes.contains("final_audio: media/final_audio-final_mix.wav"))

        let manifest = try JSONDecoder().decode(ProjectEditorPacketManifest.self, from: Data(contentsOf: result.manifestURL))
        XCTAssertEqual(manifest.version, "editor-packet-v1")
        XCTAssertEqual(manifest.projectID, "demo")
        XCTAssertEqual(manifest.annotationNotes, 1)
        XCTAssertEqual(manifest.sourceMapStatus, "source map has broken paths")
        XCTAssertEqual(manifest.sourceMapCoverage, "1 / 1")
        XCTAssertEqual(manifest.sourceMapMissingEntries, 0)
        XCTAssertEqual(manifest.sourceMapBrokenEntries, 1)
        XCTAssertFalse(manifest.usesTemporarySourceMap)
        XCTAssertEqual(manifest.files.map(\.kind), [
            "premiere_xml",
            "editor_notes",
            "editor_annotations",
            "review_report",
            "review_patch",
            "preview_media",
            "final_media",
            "final_audio"
        ])

        let verified = ProjectEditorPacketVerificationStatusReader.status(projectURL: project)
        XCTAssertEqual(verified.readinessLabel, "packet verified")
        XCTAssertTrue(verified.packetExists)
        XCTAssertTrue(verified.manifestReadable)
        XCTAssertEqual(verified.manifestProjectID, "demo")
        XCTAssertEqual(verified.manifestFileCount, 8)
        XCTAssertEqual(verified.existingFileCount, 8)
        XCTAssertEqual(verified.missingFileCount, 0)
        XCTAssertEqual(verified.mediaFileCount, 3)
        XCTAssertTrue(verified.previewMediaIncluded)
        XCTAssertTrue(verified.finalMediaIncluded)
        XCTAssertTrue(verified.finalAudioIncluded)
    }

    func testEditorPacketVerificationReportsMissingManifestFile() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-editor-packet-missing-file-\(UUID().uuidString)")
        let project = repo.appendingPathComponent("projects/demo")
        try writeHandoffFixtureProject(at: project)
        let packet = project.appendingPathComponent("09_output/editor_packet")
        try FileManager.default.createDirectory(at: packet.appendingPathComponent("media"), withIntermediateDirectories: true)
        try Data([0x00]).write(to: packet.appendingPathComponent("demo_premiere.xml"), options: .atomic)
        try """
        {
          "version": "editor-packet-v1",
          "project_id": "demo",
          "generated_at": "2026-05-22T00:00:00Z",
          "premiere_xml": "demo_premiere.xml",
          "annotation_notes": 0,
          "media_missing": 0,
          "source_map_status": "source map ready",
          "source_map_coverage": "1 / 1",
          "source_map_missing_entries": 0,
          "source_map_broken_entries": 0,
          "uses_temporary_source_map": false,
          "files": [
            {
              "kind": "premiere_xml",
              "relative_path": "demo_premiere.xml",
              "source_path": "/tmp/demo_premiere.xml"
            },
            {
              "kind": "final_media",
              "relative_path": "media/final_media-final.mp4",
              "source_path": "/tmp/final.mp4"
            }
          ]
        }
        """.write(to: packet.appendingPathComponent("manifest.json"), atomically: true, encoding: .utf8)

        let verified = ProjectEditorPacketVerificationStatusReader.status(projectURL: project)

        XCTAssertEqual(verified.readinessLabel, "packet incomplete")
        XCTAssertEqual(verified.manifestFileCount, 2)
        XCTAssertEqual(verified.existingFileCount, 1)
        XCTAssertEqual(verified.missingFiles, ["media/final_media-final.mp4"])
        XCTAssertEqual(verified.mediaFileCount, 1)
        XCTAssertTrue(verified.finalMediaIncluded)
        XCTAssertFalse(verified.finalAudioIncluded)
    }

    func testEditorPacketVerificationReadsOlderManifestWithoutSourceMapFields() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-editor-packet-legacy-manifest-\(UUID().uuidString)")
        let project = repo.appendingPathComponent("projects/demo")
        try writeHandoffFixtureProject(at: project)
        let packet = project.appendingPathComponent("09_output/editor_packet")
        try FileManager.default.createDirectory(at: packet, withIntermediateDirectories: true)
        try Data([0x00]).write(to: packet.appendingPathComponent("demo_premiere.xml"), options: .atomic)
        try """
        {
          "version": "editor-packet-v1",
          "project_id": "demo",
          "generated_at": "2026-05-22T00:00:00Z",
          "premiere_xml": "demo_premiere.xml",
          "annotation_notes": 0,
          "media_missing": 0,
          "files": [
            {
              "kind": "premiere_xml",
              "relative_path": "demo_premiere.xml",
              "source_path": "/tmp/demo_premiere.xml"
            }
          ]
        }
        """.write(to: packet.appendingPathComponent("manifest.json"), atomically: true, encoding: .utf8)

        let manifest = try JSONDecoder().decode(
            ProjectEditorPacketManifest.self,
            from: Data(contentsOf: packet.appendingPathComponent("manifest.json"))
        )
        let verified = ProjectEditorPacketVerificationStatusReader.status(projectURL: project)

        XCTAssertEqual(manifest.sourceMapStatus, "unknown")
        XCTAssertEqual(manifest.sourceMapCoverage, "unknown")
        XCTAssertFalse(manifest.usesTemporarySourceMap)
        XCTAssertEqual(verified.manifestProjectID, "demo")
        XCTAssertTrue(verified.manifestReadable)
        XCTAssertEqual(verified.readinessLabel, "packet has no media")
    }
}

private func writeHandoffFixtureProject(at project: URL) throws {
    let timelineDir = project.appendingPathComponent("05_timeline")
    let mediaDir = project.appendingPathComponent("02_media")
    let analysisDir = project.appendingPathComponent("03_analysis")
    try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)

    try """
    {
      "version": "1",
      "project_id": "demo",
      "created_at": "2026-05-22T00:00:00Z",
      "sequence": {
        "name": "Demo",
        "fps_num": 24,
        "fps_den": 1,
        "width": 1920,
        "height": 1080,
        "start_frame": 0
      },
      "tracks": {
        "video": [],
        "audio": []
      },
      "markers": []
    }
    """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

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
          "link_path": "02_media/interview.mov",
          "display_name": "Interview"
        }
      ]
    }
    """.write(to: mediaDir.appendingPathComponent("source_map.json"), atomically: true, encoding: .utf8)

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
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
}
