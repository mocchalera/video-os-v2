import Foundation

public struct ProjectSyntheticHandoffSmokeResult: Equatable, Sendable {
    public let projectURL: URL
    public let syntheticBuildResult: ProjectSyntheticMediaBuildResult
    public let sourceMapStatus: ProjectMediaSourceMapStatus
    public let mediaPreviewSummary: ProjectMediaPreviewSummary
    public let handoffPlan: ProjectHandoffExportPlan
    public let premiereXMLURL: URL
    public let editorPacketURL: URL
    public let editorPacketManifestURL: URL
    public let premiereXMLContainsMediaRefs: Bool
    public let editorPacketFileCount: Int

    public var succeeded: Bool {
        syntheticBuildResult.failureCount == 0
            && sourceMapStatus.readinessLabel == "source map ready"
            && mediaPreviewSummary.missingCount == 0
            && handoffPlan.readinessLabel == "ready"
            && !handoffPlan.usesTemporarySourceMap
            && premiereXMLContainsMediaRefs
            && editorPacketFileCount > 0
    }
}

public enum ProjectSyntheticHandoffSmoke {
    public typealias SyntheticBuilder = @Sendable (_ projectURL: URL, _ durationSeconds: Double) throws -> ProjectSyntheticMediaBuildResult
    public typealias PremiereXMLExporter = @Sendable (_ repositoryRoot: URL, _ projectURL: URL) throws -> ProjectHandoffExportResult
    public typealias EditorPacketExporter = @Sendable (_ repositoryRoot: URL, _ projectURL: URL) throws -> ProjectEditorPacketResult

    public static func run(repositoryRoot: URL, durationSeconds: Double = 1) throws -> ProjectSyntheticHandoffSmokeResult {
        try run(
            repositoryRoot: repositoryRoot,
            durationSeconds: durationSeconds,
            syntheticBuilder: { projectURL, seconds in
                ProjectSyntheticMediaBuilder.build(
                    projectURL: projectURL,
                    durationSeconds: seconds,
                    force: true
                )
            },
            premiereXMLExporter: { root, projectURL in
                try ProjectHandoffExporter.exportPremiereXML(repositoryRoot: root, projectURL: projectURL)
            },
            editorPacketExporter: { root, projectURL in
                try ProjectEditorPacketExporter.export(
                    repositoryRoot: root,
                    projectURL: projectURL,
                    exportPremiereXML: false
                )
            }
        )
    }

    public static func run(
        repositoryRoot: URL,
        durationSeconds: Double = 1,
        syntheticBuilder: SyntheticBuilder,
        premiereXMLExporter: PremiereXMLExporter,
        editorPacketExporter: EditorPacketExporter
    ) throws -> ProjectSyntheticHandoffSmokeResult {
        let projectURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("videoos-synthetic-handoff-smoke-\(UUID().uuidString)")
            .appendingPathComponent("project")
        try writeFixtureProject(at: projectURL)

        let synthetic = try syntheticBuilder(projectURL, durationSeconds)
        let sourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL)
        let mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: nil)
        let handoffPlan = ProjectHandoffExporter.plan(repositoryRoot: repositoryRoot, projectURL: projectURL)
        let premiereXML = try premiereXMLExporter(repositoryRoot, projectURL)
        let packet = try editorPacketExporter(repositoryRoot, projectURL)
        let xmlText = (try? String(contentsOf: premiereXML.outputURL, encoding: .utf8)) ?? ""
        let expectedMediaRefs = synthetic.plan.items.map { $0.outputURL.lastPathComponent }

        return ProjectSyntheticHandoffSmokeResult(
            projectURL: projectURL,
            syntheticBuildResult: synthetic,
            sourceMapStatus: sourceMapStatus,
            mediaPreviewSummary: mediaPreviewSummary,
            handoffPlan: handoffPlan,
            premiereXMLURL: premiereXML.outputURL,
            editorPacketURL: packet.packetURL,
            editorPacketManifestURL: packet.manifestURL,
            premiereXMLContainsMediaRefs: !expectedMediaRefs.isEmpty && expectedMediaRefs.allSatisfy { xmlText.contains($0) },
            editorPacketFileCount: packet.files.count
        )
    }

    public static func removeProject(_ result: ProjectSyntheticHandoffSmokeResult) {
        try? FileManager.default.removeItem(at: result.projectURL.deletingLastPathComponent())
    }

    private static func writeFixtureProject(at projectURL: URL) throws {
        let analysisDir = projectURL.appendingPathComponent("03_analysis")
        let timelineDir = projectURL.appendingPathComponent("05_timeline")
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)

        try """
        {
          "project_id": "synthetic-smoke",
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
              "tags": ["interview"]
            },
            {
              "asset_id": "AST_002",
              "filename": "camera.mxf",
              "role_guess": "b-roll",
              "duration_us": 1000000,
              "has_transcript": false,
              "segment_ids": ["SEG_002"],
              "quality_flags": [],
              "tags": ["b-roll"]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

        try """
        {
          "version": "1",
          "project_id": "synthetic-smoke",
          "sequence": {
            "name": "Synthetic Handoff Smoke",
            "fps_num": 24,
            "fps_den": 1,
            "width": 1280,
            "height": 720,
            "start_frame": 0
          },
          "tracks": {
            "video": [
              {
                "track_id": "V1",
                "kind": "video",
                "clips": [
                  {
                    "clip_id": "CLP_001",
                    "segment_id": "SEG_001",
                    "asset_id": "AST_001",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "interview",
                    "motivation": "smoke test opening"
                  },
                  {
                    "clip_id": "CLP_002",
                    "segment_id": "SEG_002",
                    "asset_id": "AST_002",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 24,
                    "timeline_duration_frames": 24,
                    "role": "b-roll",
                    "motivation": "smoke test cutaway"
                  }
                ]
              }
            ],
            "audio": [
              {
                "track_id": "A1",
                "kind": "audio",
                "clips": [
                  {
                    "clip_id": "ACL_001",
                    "segment_id": "SEG_001",
                    "asset_id": "AST_001",
                    "src_in_us": 0,
                    "src_out_us": 1000000,
                    "timeline_in_frame": 0,
                    "timeline_duration_frames": 24,
                    "role": "dialogue",
                    "motivation": "smoke test audio"
                  }
                ]
              }
            ]
          },
          "markers": [
            { "marker_id": "MKR_001", "frame": 24, "kind": "beat", "label": "cutaway" }
          ]
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)
    }
}
