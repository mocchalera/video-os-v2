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
        let captionPackageDir = project.appendingPathComponent("07_package/captions")
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: handoffDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: audioPackageDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: captionPackageDir, withIntermediateDirectories: true)
        try "<xmeml version=\"5\"></xmeml>"
            .write(to: outputDir.appendingPathComponent("demo_premiere.xml"), atomically: true, encoding: .utf8)
        try Data([0x00, 0x01, 0x02])
            .write(to: timelineDir.appendingPathComponent("preview-first30s.mp4"), options: .atomic)
        try Data([0x03, 0x04, 0x05])
            .write(to: outputDir.appendingPathComponent("final.mp4"), options: .atomic)
        try Data([0x06, 0x07, 0x08])
            .write(to: audioPackageDir.appendingPathComponent("final_mix.wav"), options: .atomic)
        try "1\n00:00:00,000 --> 00:00:02,000\n字幕\n"
            .write(to: captionPackageDir.appendingPathComponent("ja.srt"), atomically: true, encoding: .utf8)
        try #"{"version":"caption-approval/v1"}"#
            .write(to: project.appendingPathComponent("07_package/caption_approval.json"), atomically: true, encoding: .utf8)
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
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("captions/ja.srt").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.packetURL.appendingPathComponent("captions/caption_approval.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.manifestURL.path))
        XCTAssertEqual(result.files.map(\.lastPathComponent).sorted(), [
            "caption_approval.json",
            "demo_premiere.xml",
            "editor_annotations.json",
            "editor_notes.md",
            "final_audio-final_mix.wav",
            "final_media-final.mp4",
            "ja.srt",
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
        XCTAssertTrue(notes.contains("## Included Assets"))
        XCTAssertTrue(notes.contains("preview_media: media/preview_media-preview-first30s.mp4"))
        XCTAssertTrue(notes.contains("final_media: media/final_media-final.mp4"))
        XCTAssertTrue(notes.contains("final_audio: media/final_audio-final_mix.wav"))
        XCTAssertTrue(notes.contains("caption_sidecar: captions/ja.srt"))
        XCTAssertTrue(notes.contains("caption_approval: captions/caption_approval.json"))

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
            "final_audio",
            "caption_sidecar",
            "caption_approval"
        ])

        let verified = ProjectEditorPacketVerificationStatusReader.status(projectURL: project)
        XCTAssertEqual(verified.readinessLabel, "packet verified")
        XCTAssertTrue(verified.packetExists)
        XCTAssertTrue(verified.manifestReadable)
        XCTAssertEqual(verified.manifestProjectID, "demo")
        XCTAssertEqual(verified.manifestFileCount, 10)
        XCTAssertEqual(verified.existingFileCount, 10)
        XCTAssertEqual(verified.missingFileCount, 0)
        XCTAssertEqual(verified.mediaFileCount, 3)
        XCTAssertTrue(verified.previewMediaIncluded)
        XCTAssertTrue(verified.finalMediaIncluded)
        XCTAssertTrue(verified.finalAudioIncluded)
        XCTAssertTrue(verified.captionSidecarIncluded)
        XCTAssertTrue(verified.captionApprovalIncluded)
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

    func testPremiereFinishReviewStrictlyDecodesClosedProjection() throws {
        let projection = try JSONDecoder().decode(
            ProjectPremiereFinishReviewProjection.self,
            from: Data(premiereFinishReviewJSON.utf8)
        )

        XCTAssertEqual(projection.version, "premiere-finish-review/v2")
        XCTAssertEqual(projection.projectID, "demo")
        XCTAssertEqual(projection.profileID, "adobe_premiere_fcp7xml_v1")
        XCTAssertEqual(projection.baseTimelineSHA256, premiereFinishReviewHash)
        XCTAssertFalse(projection.hardwareVerified)
        XCTAssertEqual(projection.surfaces.count, 4)
        guard case let .visualEffect(item) = projection.surfaces[3] else {
            return XCTFail("Expected a visual effect surface")
        }
        XCTAssertEqual(item.status, .ready)
        XCTAssertEqual(item.rawStatus, .reusable)
        XCTAssertEqual(item.target.effectIDs, ["transform.zoom", "effect.contrast"])
        XCTAssertEqual(item.requestSHA256, premiereFinishReviewHash)
    }

    func testPremiereFinishReviewRejectsUnknownInvalidDuplicateAndUnsortedValues() throws {
        let invalidDocuments = [
            premiereFinishReviewJSON.replacingOccurrences(
                of: "\"surfaces\": [",
                with: "\"unexpected\": true, \"surfaces\": ["
            ),
            premiereFinishReviewJSON.replacingOccurrences(
                of: "\"hardware_verified\": false",
                with: "\"hardware_verified\": true"
            ),
            premiereFinishReviewJSON.replacingOccurrences(
                of: "\"raw_status\": \"reusable\"",
                with: "\"raw_status\": \"ready\""
            ),
            premiereFinishReviewJSON.replacingOccurrences(
                of: "\"request_sha256\":",
                with: "\"request_sha\":"
            ),
            premiereFinishReviewJSON.replacingOccurrences(
                of: "\"effect_ids\": [\"transform.zoom\", \"effect.contrast\"]",
                with: "\"effect_ids\": [\"effect.contrast\", \"transform.zoom\"]"
            ),
            premiereFinishReviewJSON.replacingOccurrences(
                of: "    {\n      \"kind\": \"transition\"",
                with: "    {\n      \"kind\": \"text\",\n      \"target\": {\"track_id\": \"V1\", \"clip_id\": \"title-1\", \"overlay_id\": \"overlay-1\"},\n      \"source\": {\"role\": \"title\", \"text\": \"Title\", \"styling_class\": \"hero\", \"writing_mode\": null, \"anchor\": null, \"authored_source\": null, \"timeline_in_frame\": 0, \"timeline_duration_frames\": 24},\n      \"status\": \"blocked\", \"raw_status\": \"report_only\", \"reason_code\": \"profile_text_export_blocked\", \"action_code\": \"review_text_then_wait_for_full_handoff\"\n    },\n    {\n      \"kind\": \"transition\""
            )
        ]

        for document in invalidDocuments {
            XCTAssertThrowsError(
                try JSONDecoder().decode(
                    ProjectPremiereFinishReviewProjection.self,
                    from: Data(document.utf8)
                )
            )
        }
    }

    func testPremiereFinishReviewDecodeTaxonomySeparatesUnknownFromInvalidProjection() {
        let unknownEnum = premiereFinishReviewJSON.replacingOccurrences(
            of: "\"raw_status\": \"reusable\"",
            with: "\"raw_status\": \"future_status\""
        )
        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewDecoder.decode(Data(unknownEnum.utf8))
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .unknownValue)
        }

        let missingRequiredNullable = premiereFinishReviewJSON.replacingOccurrences(
            of: "\"reason\": null, ",
            with: ""
        )
        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewDecoder.decode(Data(missingRequiredNullable.utf8))
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .invalidProjection)
        }

        let extraField = premiereFinishReviewJSON.replacingOccurrences(
            of: "\"surfaces\": [",
            with: "\"unexpected\": true, \"surfaces\": ["
        )
        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewDecoder.decode(Data(extraField.utf8))
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .invalidProjection)
        }
    }

    func testPremiereFinishReviewClientUsesOnlyValidatedLocalProjectionInvocation() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-finish-review-client-\(UUID().uuidString)")
        let executable = root.appendingPathComponent("node_modules/tsx/dist/cli.mjs")
        let binaryLink = root.appendingPathComponent("node_modules/.bin/tsx")
        let script = root.appendingPathComponent("scripts/premiere-finish-review.ts")
        let project = root.appendingPathComponent("projects/demo")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: binaryLink.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try FileManager.default.createSymbolicLink(at: binaryLink, withDestinationURL: executable)
        try "// read-only projection\n".write(to: script, atomically: true, encoding: .utf8)

        let generation = ProjectPremiereFinishReviewProjectGeneration(
            projectURL: project,
            projectID: "demo",
            timelineSHA256: premiereFinishReviewHash,
            revision: 7
        )
        let request = ProjectPremiereFinishReviewRequest(id: 11, projectGeneration: generation)
        var captured: ProjectPremiereFinishReviewInvocation?
        let projection = try ProjectPremiereFinishReviewClient.load(
            repositoryRoot: root,
            request: request
        ) { invocation in
            captured = invocation
            return ProjectPremiereFinishReviewProcessResult(
                status: 0,
                stdout: premiereFinishReviewJSON,
                stderr: ""
            )
        }

        XCTAssertEqual(projection.projectID, "demo")
        XCTAssertEqual(captured?.executableURL.path, executable.resolvingSymlinksInPath().path)
        XCTAssertEqual(captured?.workingDirectoryURL.path, root.resolvingSymlinksInPath().path)
        XCTAssertEqual(captured?.arguments, [
            script.path,
            project.path,
            "--json"
        ])
    }

    func testPremiereFinishReviewClientStrictlyMapsStatusOneErrorEnvelopes() throws {
        let fixture = try makePremiereFinishReviewClientFixture()
        let supported: [(String, ProjectPremiereFinishReviewFailure)] = [
            ("invalid_projection", .invalidProjection),
            ("unknown_value", .unknownValue),
            ("unsupported_profile", .unsupportedProfile),
            ("duplicate_target", .duplicateTarget),
            ("tool_unavailable", .toolUnavailable),
            ("preflight_contract_error", .preflightContractError),
            ("timeline_revision_changed", .timelineRevisionChanged)
        ]

        for (code, expected) in supported {
            XCTAssertThrowsError(
                try ProjectPremiereFinishReviewClient.load(
                    repositoryRoot: fixture.root,
                    request: fixture.request
                ) { _ in
                    ProjectPremiereFinishReviewProcessResult(
                        status: 1,
                        stdout: "",
                        stderr: "{\"version\":\"premiere-finish-review-error/v1\",\"code\":\""
                            + code
                            + "\",\"message\":\"closed failure\"}\n"
                    )
                }
            ) { error in
                XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, expected, "code: \(code)")
            }
        }
    }

    func testPremiereFinishReviewClientRejectsMalformedUnknownAndUnsupportedFailures() throws {
        let fixture = try makePremiereFinishReviewClientFixture()
        let malformedEnvelopes = [
            "not-json",
            "{\"version\":\"premiere-finish-review-error/v1\",\"code\":\"invalid_projection\"}",
            "{\"version\":\"premiere-finish-review-error/v1\",\"code\":\"invalid_projection\",\"message\":\"failure\",\"extra\":true}"
        ]
        for stderr in malformedEnvelopes {
            XCTAssertThrowsError(
                try ProjectPremiereFinishReviewClient.load(
                    repositoryRoot: fixture.root,
                    request: fixture.request
                ) { _ in
                    ProjectPremiereFinishReviewProcessResult(status: 1, stdout: "", stderr: stderr)
                }
            ) { error in
                XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .invalidProjection)
            }
        }

        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewClient.load(
                repositoryRoot: fixture.root,
                request: fixture.request
            ) { _ in
                ProjectPremiereFinishReviewProcessResult(
                    status: 1,
                    stdout: "",
                    stderr: "{\"version\":\"premiere-finish-review-error/v1\",\"code\":\"future_error\",\"message\":\"failure\"}"
                )
            }
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .unknownValue)
        }

        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewClient.load(
                repositoryRoot: fixture.root,
                request: fixture.request
            ) { _ in
                ProjectPremiereFinishReviewProcessResult(status: 2, stdout: "", stderr: "")
            }
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .unsupportedExit(2))
        }
    }

    func testPremiereFinishReviewClientRejectsMissingEscapingAndSymlinkedNodeModules() throws {
        let missing = try makePremiereFinishReviewClientFixture()
        try FileManager.default.removeItem(at: missing.binaryLink)
        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewClient.invocation(
                repositoryRoot: missing.root,
                projectURL: missing.project
            )
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .toolUnavailable)
        }

        let escaping = try makePremiereFinishReviewClientFixture()
        try FileManager.default.removeItem(at: escaping.binaryLink)
        let externalExecutable = escaping.root.deletingLastPathComponent()
            .appendingPathComponent("external-tsx-" + UUID().uuidString)
        try "#!/bin/sh\n".write(to: externalExecutable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: externalExecutable.path)
        try FileManager.default.createSymbolicLink(at: escaping.binaryLink, withDestinationURL: externalExecutable)
        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewClient.invocation(
                repositoryRoot: escaping.root,
                projectURL: escaping.project
            )
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .toolUnavailable)
        }

        let symlinked = try makePremiereFinishReviewClientFixture()
        let externalNodeModules = symlinked.root.deletingLastPathComponent()
            .appendingPathComponent("external-node-modules-" + UUID().uuidString)
        try FileManager.default.moveItem(
            at: symlinked.root.appendingPathComponent("node_modules"),
            to: externalNodeModules
        )
        try FileManager.default.createSymbolicLink(
            at: symlinked.root.appendingPathComponent("node_modules"),
            withDestinationURL: externalNodeModules
        )
        XCTAssertThrowsError(
            try ProjectPremiereFinishReviewClient.invocation(
                repositoryRoot: symlinked.root,
                projectURL: symlinked.project
            )
        ) { error in
            XCTAssertEqual(error as? ProjectPremiereFinishReviewFailure, .toolUnavailable)
        }
    }

    func testPremiereFinishReviewReducerRefreshCancelStaleAndMismatchFailClosed() throws {
        let projection = try JSONDecoder().decode(
            ProjectPremiereFinishReviewProjection.self,
            from: Data(premiereFinishReviewJSON.utf8)
        )
        let project = URL(fileURLWithPath: "/repo/projects/demo")
        let firstGeneration = ProjectPremiereFinishReviewProjectGeneration(
            projectURL: project,
            projectID: "demo",
            timelineSHA256: premiereFinishReviewHash,
            revision: 1
        )
        let secondGeneration = ProjectPremiereFinishReviewProjectGeneration(
            projectURL: project,
            projectID: "demo",
            timelineSHA256: premiereFinishReviewHash,
            revision: 2
        )
        let first = ProjectPremiereFinishReviewRequest(id: 1, projectGeneration: firstGeneration)
        let second = ProjectPremiereFinishReviewRequest(id: 2, projectGeneration: secondGeneration)
        var reducer = ProjectPremiereFinishReviewReducer()

        reducer.refresh(first)
        reducer.refresh(second)
        XCTAssertFalse(reducer.receive(.success(projection), for: first, selectedProjectID: "demo", timelineSHA256: premiereFinishReviewHash))
        XCTAssertTrue(reducer.receive(.success(projection), for: second, selectedProjectID: "demo", timelineSHA256: premiereFinishReviewHash))
        XCTAssertEqual(reducer.state, .loaded(request: second, projection: projection))

        reducer.refresh(first)
        reducer.cancel()
        XCTAssertEqual(reducer.state, .idle)
        XCTAssertFalse(reducer.receive(.success(projection), for: first, selectedProjectID: "demo", timelineSHA256: premiereFinishReviewHash))

        reducer.refresh(second)
        XCTAssertTrue(reducer.receive(.success(projection), for: second, selectedProjectID: "other", timelineSHA256: premiereFinishReviewHash))
        XCTAssertEqual(reducer.state, .failed(request: second, error: .selectedProjectMismatch))

        reducer.refresh(second)
        XCTAssertTrue(reducer.receive(.success(projection), for: second, selectedProjectID: "demo", timelineSHA256: "sha256:\(String(repeating: "f", count: 64))"))
        XCTAssertEqual(reducer.state, .failed(request: second, error: .timelineRevisionMismatch))

        reducer.refresh(second)
        XCTAssertTrue(reducer.receive(.failure(.preflightContractError), for: second, selectedProjectID: "demo", timelineSHA256: premiereFinishReviewHash))
        XCTAssertEqual(reducer.state, .failed(request: second, error: .preflightContractError))
    }

    func testPremiereFinishReviewRouteAdapterOpensReviewExactlyOnceForEveryClosedEntry() {
        var opened: [ProjectPremiereFinishReviewEntry] = []
        let adapter = ProjectPremiereFinishReviewRouteAdapter { entry in
            opened.append(entry)
        }

        for entry in ProjectPremiereFinishReviewEntry.allCases {
            let before = opened.count
            adapter.route(entry)
            XCTAssertEqual(opened.count, before + 1)
            XCTAssertEqual(opened.last, entry)
        }
        XCTAssertEqual(ProjectPremiereFinishReviewEntry.allCases.count, 13)
        XCTAssertEqual(opened, ProjectPremiereFinishReviewEntry.allCases)
    }
}

private let premiereFinishReviewHash = "sha256:\(String(repeating: "a", count: 64))"

private let premiereFinishReviewJSON = """
{
  "version": "premiere-finish-review/v2",
  "project_id": "demo",
  "profile_id": "adobe_premiere_fcp7xml_v1",
  "base_timeline_sha256": "\(premiereFinishReviewHash)",
  "hardware_verified": false,
  "surfaces": [
    {
      "kind": "text",
      "target": {"track_id": "V1", "clip_id": "title-1", "overlay_id": "overlay-1"},
      "source": {"role": "title", "text": "Title", "styling_class": "hero", "writing_mode": null, "anchor": null, "authored_source": null, "timeline_in_frame": 0, "timeline_duration_frames": 24},
      "status": "blocked", "raw_status": "report_only", "reason_code": "profile_text_export_blocked", "action_code": "review_text_then_wait_for_full_handoff"
    },
    {
      "kind": "transition",
      "target": {"transition_id": "tr-1", "track_id": "V1", "from_clip_id": "clip-1", "to_clip_id": "clip-2"},
      "source": {"transition_type": "cross_dissolve", "transition_frames": 12, "applied_skill_id": null, "degraded_from_skill_id": null, "confidence": 0.9},
      "status": "report_only", "raw_status": "allowed_type_report_only", "reason_code": "profile_transition_report_only", "action_code": "review_transition_then_wait_for_full_handoff"
    },
    {
      "kind": "audio",
      "target": {"track_id": "A1", "clip_id": "audio-1", "effect_id": "audiolevels"},
      "source": {"audio_policy": {"mode": "dialogue", "gain_unit": "db", "duck_music_db": -8, "nat_gain": null, "nat_sound_gain": null, "bgm_gain": null, "a1_loudnorm": true, "preserve_nat_sound": false, "fade_in_frames": 4, "fade_out_frames": 4, "nat_sound_fade_in_frames": null, "nat_sound_fade_out_frames": null, "bgm_fade_in_frames": null, "bgm_fade_out_frames": null}},
      "status": "provisional_roundtrip", "raw_status": "provisional_roundtrip", "reason_code": "profile_audiolevels_provisional", "action_code": "review_audio_levels_then_wait_for_full_handoff"
    },
    {
      "kind": "visual_effect",
      "target": {"track_id": "V1", "clip_id": "clip-1", "effect_ids": ["transform.zoom", "effect.contrast"]},
      "status": "ready", "raw_status": "reusable", "reason": null, "action_code": "reuse_available_but_execution_blocked", "request_sha256": "\(premiereFinishReviewHash)"
    }
  ]
}
"""

private struct PremiereFinishReviewClientFixture {
    let root: URL
    let executable: URL
    let binaryLink: URL
    let script: URL
    let project: URL
    let request: ProjectPremiereFinishReviewRequest
}

private func makePremiereFinishReviewClientFixture() throws -> PremiereFinishReviewClientFixture {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-finish-review-client-fixture-" + UUID().uuidString)
    let executable = root.appendingPathComponent("node_modules/tsx/dist/cli.mjs")
    let binaryLink = root.appendingPathComponent("node_modules/.bin/tsx")
    let script = root.appendingPathComponent("scripts/premiere-finish-review.ts")
    let project = root.appendingPathComponent("projects/demo")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: binaryLink.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    try FileManager.default.createSymbolicLink(at: binaryLink, withDestinationURL: executable)
    try "// read-only projection\n".write(to: script, atomically: true, encoding: .utf8)
    let generation = ProjectPremiereFinishReviewProjectGeneration(
        projectURL: project,
        projectID: "demo",
        timelineSHA256: premiereFinishReviewHash,
        revision: 1
    )
    return PremiereFinishReviewClientFixture(
        root: root,
        executable: executable,
        binaryLink: binaryLink,
        script: script,
        project: project,
        request: ProjectPremiereFinishReviewRequest(id: 1, projectGeneration: generation)
    )
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
