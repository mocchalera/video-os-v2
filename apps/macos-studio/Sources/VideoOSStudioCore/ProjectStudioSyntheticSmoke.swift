import Foundation
import CryptoKit

public struct ProjectStudioSyntheticSmokeResult: Equatable, Sendable {
    public let projectURL: URL
    public let syntheticBuildResult: ProjectSyntheticMediaBuildResult
    public let renderResult: ProjectRenderRunResult
    public let editorPacketResult: ProjectEditorPacketResult
    public let editorPacketVerificationStatus: ProjectEditorPacketVerificationStatus
    public let sourceMapStatus: ProjectMediaSourceMapStatus
    public let mediaPreviewSummary: ProjectMediaPreviewSummary
    public let indexSummary: ProjectIndexSummary
    public let indexStatus: ProjectIndexStatus
    public let studioStatus: ProjectStudioReadinessStatus

    public var finalVideoExists: Bool {
        FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("09_output/final.mp4").path)
    }

    public var editorPacketMediaCount: Int {
        editorPacketResult.plan.mediaIncludedCount
    }

    public var succeeded: Bool {
        syntheticBuildResult.failureCount == 0
            && sourceMapStatus.readinessLabel == "source map ready"
            && mediaPreviewSummary.missingCount == 0
            && renderResult.succeeded
            && finalVideoExists
            && editorPacketMediaCount > 0
            && editorPacketVerificationStatus.readinessLabel == "packet verified"
            && indexStatus.exists
            && indexStatus.documentCount > 0
    }
}

public enum ProjectStudioSyntheticSmoke {
    public typealias SyntheticBuilder = @Sendable (_ projectURL: URL, _ durationSeconds: Double) throws -> ProjectSyntheticMediaBuildResult
    public typealias RenderRunner = @Sendable (_ plan: ProjectRenderRunPlan) throws -> ProjectRenderRunResult
    public typealias EditorPacketExporter = @Sendable (_ repositoryRoot: URL, _ projectURL: URL) throws -> ProjectEditorPacketResult

    public static func run(repositoryRoot: URL, durationSeconds: Double = 1) throws -> ProjectStudioSyntheticSmokeResult {
        try run(
            repositoryRoot: repositoryRoot,
            durationSeconds: durationSeconds,
            syntheticBuilder: { projectURL, seconds in
                ProjectSyntheticMediaBuilder.build(projectURL: projectURL, durationSeconds: seconds, force: true)
            },
            renderRunner: { plan in
                try ProjectRenderRunner.run(plan: plan)
            },
            editorPacketExporter: { root, projectURL in
                try ProjectEditorPacketExporter.export(repositoryRoot: root, projectURL: projectURL)
            }
        )
    }

    public static func run(
        repositoryRoot: URL,
        durationSeconds: Double = 1,
        syntheticBuilder: SyntheticBuilder,
        renderRunner: RenderRunner,
        editorPacketExporter: EditorPacketExporter
    ) throws -> ProjectStudioSyntheticSmokeResult {
        let projectURL = repositoryRoot
            .appendingPathComponent("tmp")
            .appendingPathComponent("videoos-studio-synthetic-smoke-\(UUID().uuidString)")
            .appendingPathComponent("project")
        try writeFixtureProject(at: projectURL)

        let synthetic = try syntheticBuilder(projectURL, durationSeconds)
        guard let suppliedFinalURL = synthetic.plan.items.first?.outputURL else {
            throw ProjectStudioSyntheticSmokeError.syntheticFinalMissing
        }

        let renderPlan = ProjectRenderRunPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            options: ProjectRenderRunOptions(suppliedFinalURL: suppliedFinalURL)
        )
        let renderResult = try renderRunner(renderPlan)
        try ensureSyntheticFinalAudio(projectURL: projectURL)
        let packet = try editorPacketExporter(repositoryRoot, projectURL)
        let sourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL)
        let mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: nil)
        let indexSummary = try ProjectSQLiteIndex.rebuild(projectURL: projectURL)
        let indexStatus = ProjectSQLiteIndex.status(projectURL: projectURL)
        let packetVerification = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
        let studioStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: projectURL)

        return ProjectStudioSyntheticSmokeResult(
            projectURL: projectURL,
            syntheticBuildResult: synthetic,
            renderResult: renderResult,
            editorPacketResult: packet,
            editorPacketVerificationStatus: packetVerification,
            sourceMapStatus: sourceMapStatus,
            mediaPreviewSummary: mediaPreviewSummary,
            indexSummary: indexSummary,
            indexStatus: indexStatus,
            studioStatus: studioStatus
        )
    }

    public static func removeProject(_ result: ProjectStudioSyntheticSmokeResult) {
        try? FileManager.default.removeItem(at: result.projectURL.deletingLastPathComponent())
    }

    private static func ensureSyntheticFinalAudio(projectURL: URL) throws {
        let finalAudioURL = projectURL
            .appendingPathComponent("07_package")
            .appendingPathComponent("audio")
            .appendingPathComponent("final_mix.wav")
        guard !FileManager.default.fileExists(atPath: finalAudioURL.path) else { return }
        try FileManager.default.createDirectory(at: finalAudioURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try minimalSilentWAVData().write(to: finalAudioURL, options: .atomic)
    }

    private static func minimalSilentWAVData() -> Data {
        let sampleRate: UInt32 = 44_100
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let samples = 256
        let dataByteCount = UInt32(samples * Int(channels) * Int(bitsPerSample / 8))
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)

        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        appendLE32(36 + dataByteCount, to: &data)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        appendLE32(16, to: &data)
        appendLE16(1, to: &data)
        appendLE16(channels, to: &data)
        appendLE32(sampleRate, to: &data)
        appendLE32(byteRate, to: &data)
        appendLE16(blockAlign, to: &data)
        appendLE16(bitsPerSample, to: &data)
        data.append(contentsOf: Array("data".utf8))
        appendLE32(dataByteCount, to: &data)
        data.append(Data(repeating: 0, count: Int(dataByteCount)))
        return data
    }

    private static func appendLE16(_ value: UInt16, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private static func appendLE32(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private static func writeFixtureProject(at projectURL: URL) throws {
        let intentDir = projectURL.appendingPathComponent("01_intent")
        let analysisDir = projectURL.appendingPathComponent("03_analysis")
        let transcriptDir = analysisDir.appendingPathComponent("transcripts")
        let planDir = projectURL.appendingPathComponent("04_plan")
        let timelineDir = projectURL.appendingPathComponent("05_timeline")
        let reviewDir = projectURL.appendingPathComponent("06_review")
        try FileManager.default.createDirectory(at: intentDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: transcriptDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: planDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)

        try """
        version: "1"
        project_id: synthetic-studio-smoke
        message:
          primary: Verify a complete studio package loop.
        autonomy:
          mode: full
          must_ask: []
        """.write(to: intentDir.appendingPathComponent("creative_brief.yaml"), atomically: true, encoding: .utf8)
        try """
        blockers: []
        """.write(to: intentDir.appendingPathComponent("unresolved_blockers.yaml"), atomically: true, encoding: .utf8)

        try """
        {
          "project_id": "synthetic-studio-smoke",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "interview.mov",
              "role_guess": "interview",
              "duration_us": 1000000,
              "has_transcript": true,
              "transcript_ref": "TR_AST_001",
              "segment_ids": ["SEG_001"],
              "quality_flags": [],
              "tags": ["interview"]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)

        try """
        {
          "project_id": "synthetic-studio-smoke",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "segment_id": "SEG_001",
              "asset_id": "AST_001",
              "src_in_us": 0,
              "src_out_us": 1000000,
              "summary": "synthetic approved final candidate",
              "transcript_excerpt": "The speaker delivers the main line.",
              "transcript_ref": "TR_AST_001",
              "quality_flags": [],
              "tags": ["interview"],
              "interest_points": [
                {
                  "frame_us": 500000,
                  "label": "speaker lands the core line",
                  "confidence": 0.91,
                  "source": "marlin:caption"
                }
              ],
              "peak_analysis": {
                "selected_peak_us": 500000,
                "confidence": 0.91,
                "provenance": {
                  "precision_mode": "marlin_temporal_semantics",
                  "fusion_version": "marlin-synthetic-smoke"
                }
              }
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("segments.json"), atomically: true, encoding: .utf8)

        try """
        {
          "project_id": "synthetic-studio-smoke",
          "artifact_version": "analysis-v1",
          "transcript_ref": "TR_AST_001",
          "asset_id": "AST_001",
          "items": [
            {
              "speaker": "SPK_001",
              "start_us": 0,
              "end_us": 1000000,
              "text": "The speaker delivers the main line."
            }
          ]
        }
        """.write(to: transcriptDir.appendingPathComponent("TR_AST_001.json"), atomically: true, encoding: .utf8)

        try """
        {
          "project_id": "synthetic-studio-smoke",
          "artifact_version": "marlin-events-v1",
          "model": {
            "provider": "marlin",
            "model_alias": "NemoStation/Marlin-2B",
            "model_snapshot": "synthetic-smoke",
            "connector_version": "marlin-local-v1"
          },
          "items": [
            {
              "asset_id": "AST_001",
              "source_path": "02_media/source/interview.mov",
              "scene": "A synthetic interview clip used to validate temporal semantics.",
              "caption": "The speaker delivers a concise line for a rough cut smoke test.",
              "events": [
                {
                  "event_id": "MEV_AST_001_0001",
                  "start_us": 0,
                  "end_us": 1000000,
                  "description": "The speaker delivers the main line.",
                  "confidence": 0.91,
                  "source_pass": "caption"
                }
              ],
              "find_results": [
                {
                  "query": "main spoken line",
                  "span_start_us": 250000,
                  "span_end_us": 800000,
                  "format_ok": true,
                  "confidence": 0.88,
                  "raw": "0.25-0.80"
                }
              ]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("marlin_events.json"), atomically: true, encoding: .utf8)

        try """
        {
          "version": "1",
          "project_id": "synthetic-studio-smoke",
          "artifact_version": "audio-story-v1",
          "nodes": [
            {
              "node_id": "ASN_001",
              "node_type": "dialogue",
              "asset_id": "AST_001",
              "start_us": 0,
              "end_us": 1000000,
              "text": "The speaker delivers the main line.",
              "story_role": "core_message",
              "refs": {
                "transcript_ref": null,
                "speaker_ref": "SPK_001",
                "audio_event_ref": null,
                "bgm_ref": null
              },
              "confidence": {
                "score": 0.9,
                "source": "synthetic-smoke",
                "status": "ready",
                "label": "dialogue"
              }
            }
          ],
          "edges": []
        }
        """.write(to: analysisDir.appendingPathComponent("audio_story_graph.json"), atomically: true, encoding: .utf8)

        try "items: []\n".write(to: planDir.appendingPathComponent("selects_candidates.yaml"), atomically: true, encoding: .utf8)
        try """
        caption_policy:
          language: ja
          delivery_mode: burn_in
          source: none
          styling_class: clean-lower-third
        """.write(to: planDir.appendingPathComponent("edit_blueprint.yaml"), atomically: true, encoding: .utf8)

        try """
        {
          "version": "1",
          "project_id": "synthetic-studio-smoke",
          "sequence": {
            "name": "Synthetic Studio Smoke",
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
                    "role": "hero",
                    "motivation": "approved synthetic smoke clip"
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
                    "motivation": "approved synthetic smoke audio"
                  }
                ]
              }
            ]
          },
          "markers": [],
          "provenance": {
            "brief_path": "01_intent/creative_brief.yaml",
            "blueprint_path": "04_plan/edit_blueprint.yaml",
            "selects_path": "04_plan/selects_candidates.yaml",
            "compiler_version": "synthetic-studio-smoke"
          }
        }
        """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

        try """
        summary_judgment:
          status: approved
          rationale: "Synthetic smoke fixture approved for packaging."
        preview_path: null
        """.write(to: reviewDir.appendingPathComponent("review_report.yaml"), atomically: true, encoding: .utf8)
        try """
        {
          "timeline_version": "1",
          "operations": []
        }
        """.write(to: reviewDir.appendingPathComponent("review_patch.json"), atomically: true, encoding: .utf8)

        let briefHash = try fileHash16(intentDir.appendingPathComponent("creative_brief.yaml"))
        let blockersHash = try fileHash16(intentDir.appendingPathComponent("unresolved_blockers.yaml"))
        let selectsHash = try fileHash16(planDir.appendingPathComponent("selects_candidates.yaml"))
        let blueprintHash = try fileHash16(planDir.appendingPathComponent("edit_blueprint.yaml"))
        let timelineHash = try fileHash16(timelineDir.appendingPathComponent("timeline.json"))
        let reviewReportHash = try fileHash16(reviewDir.appendingPathComponent("review_report.yaml"))
        let reviewPatchHash = try fileHash16(reviewDir.appendingPathComponent("review_patch.json"))

        try """
        version: 1
        project_id: synthetic-studio-smoke
        current_state: approved
        artifact_hashes:
          brief_hash: \(briefHash)
          blockers_hash: \(blockersHash)
          analysis_artifact_version: analysis-v1
          selects_hash: \(selectsHash)
          blueprint_hash: \(blueprintHash)
          timeline_version: \(timelineHash)
          editorial_timeline_hash: \(timelineHash)
          review_report_version: \(reviewReportHash)
          review_patch_hash: \(reviewPatchHash)
        approval_record:
          status: clean
          artifact_versions:
            timeline_version: \(timelineHash)
            editorial_timeline_hash: \(timelineHash)
            review_report_version: \(reviewReportHash)
            review_patch_hash: \(reviewPatchHash)
        handoff_resolution:
          handoff_id: HND_synthetic_studio_smoke
          status: decided
          source_of_truth_decision: nle_finishing
          decided_by: synthetic-smoke
          decided_at: 2026-05-22T00:00:00Z
        gates:
          analysis_gate: ready
          planning_gate: open
          compile_gate: open
          timeline_gate: open
          review_gate: open
          packaging_gate: open
        last_updated: 2026-05-22T00:00:00Z
        """.write(to: projectURL.appendingPathComponent("project_state.yaml"), atomically: true, encoding: .utf8)
    }

    private static func fileHash16(_ url: URL) throws -> String {
        let digest = SHA256.hash(data: try Data(contentsOf: url))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}

public enum ProjectStudioSyntheticSmokeError: Error, Equatable, CustomStringConvertible {
    case syntheticFinalMissing

    public var description: String {
        switch self {
        case .syntheticFinalMissing:
            return "Synthetic studio smoke could not identify a generated final media file."
        }
    }
}
