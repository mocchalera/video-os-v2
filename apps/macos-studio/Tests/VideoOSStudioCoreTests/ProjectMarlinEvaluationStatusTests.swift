import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinEvaluationStatusTests: XCTestCase {
    func testStatusReportsMissingMarlinArtifact() throws {
        let project = try makeProjectFixture(name: "videoos-marlin-missing")

        let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "not evaluated")
        XCTAssertFalse(status.artifactExists)
        XCTAssertFalse(status.canPreferMarlin)
        XCTAssertEqual(status.recommendation, "Run a local Marlin-2B analysis pass before considering it as the preferred temporal VLM.")
    }

    func testStatusReportsPreferredCandidateWhenMarlinAffectsSegmentPeaks() throws {
        let project = try makeProjectFixture(name: "videoos-marlin-candidate")
        try writeMarlinEvents(project: project, eventCount: 2, findCount: 1)
        try writeSegments(project: project, includeMarlinPeak: true)

        let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "candidate for preferred VLM")
        XCTAssertTrue(status.artifactReadable)
        XCTAssertEqual(status.artifactModelAlias, "NemoStation/Marlin-2B")
        XCTAssertEqual(status.assetCount, 1)
        XCTAssertEqual(status.eventCount, 2)
        XCTAssertEqual(status.findResultCount, 1)
        XCTAssertEqual(status.segmentCount, 3)
        XCTAssertEqual(status.segmentsWithMarlinPeakCount, 1)
        XCTAssertEqual(status.coverageRatio, 1.0 / 3.0, accuracy: 0.001)
        XCTAssertTrue(status.canPreferMarlin)
    }

    func testStatusDoesNotTreatMockArtifactAsPreferenceEvidence() throws {
        let project = try makeProjectFixture(name: "videoos-marlin-mock")
        try writeMarlinEvents(project: project, eventCount: 2, findCount: 1, inferenceMode: "mock")
        try writeSegments(project: project, includeMarlinPeak: true)

        let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "mock evaluation")
        XCTAssertEqual(status.artifactInferenceMode, "mock")
        XCTAssertTrue(status.isMockArtifact)
        XCTAssertFalse(status.canPreferMarlin)
        XCTAssertTrue(status.recommendation.contains("workflow QA only"))
    }

    func testStatusRequiresSegmentMaterializationBeforePreference() throws {
        let project = try makeProjectFixture(name: "videoos-marlin-unmaterialized")
        try writeMarlinEvents(project: project, eventCount: 1, findCount: 1)
        try writeSegments(project: project, includeMarlinPeak: false)

        let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "needs segment materialization")
        XCTAssertFalse(status.canPreferMarlin)
        XCTAssertEqual(status.segmentsWithMarlinPeakCount, 0)
        XCTAssertEqual(status.materializableSegmentCount, 1)
    }

    func testStatusRoutesPartialUnmaterializedCoverageToMaterialization() throws {
        let project = try makeProjectFixture(name: "videoos-marlin-partial-materialization")
        try writeMarlinEvents(project: project, eventCount: 2, findCount: 1)
        try writeSegmentsWithPeakFlags(project: project, marlinPeaks: [false, true, false, false])

        let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "needs segment materialization")
        XCTAssertFalse(status.canPreferMarlin)
        XCTAssertEqual(status.segmentCount, 4)
        XCTAssertEqual(status.segmentsWithMarlinPeakCount, 1)
        XCTAssertEqual(status.materializableSegmentCount, 1)
        XCTAssertEqual(status.coverageRatio, 0.25, accuracy: 0.001)
    }

    func testStatusDoesNotLoopMaterializationForStrongerExistingPeak() throws {
        let project = try makeProjectFixture(name: "videoos-marlin-nonreplaceable-peak")
        try writeTwoAssetMarlinEvents(project: project)
        try writeMixedMaterializedAndStrongPeakSegments(project: project, fusedPeakScore: 0.86)

        let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project)

        XCTAssertEqual(status.readinessLabel, "needs more footage evaluation")
        XCTAssertFalse(status.canPreferMarlin)
        XCTAssertEqual(status.segmentCount, 4)
        XCTAssertEqual(status.segmentsWithMarlinPeakCount, 1)
        XCTAssertEqual(status.materializableSegmentCount, 0)
    }
}

private func makeProjectFixture(name: String) throws -> URL {
    let project = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("\(name)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
        at: project.appendingPathComponent("03_analysis"),
        withIntermediateDirectories: true
    )
    return project
}

private func writeMarlinEvents(
    project: URL,
    eventCount: Int,
    findCount: Int,
    inferenceMode: String = "live"
) throws {
    let events = (0..<eventCount).map { index in
        """
        {
          "event_id": "MEV_A001_\(String(format: "%04d", index))",
          "start_us": \(index * 1000000),
          "end_us": \((index + 1) * 1000000),
          "description": "strong temporal moment \(index)",
          "confidence": 0.8,
          "source_pass": "marlin_caption"
        }
        """
    }.joined(separator: ",")
    let finds = (0..<findCount).map { index in
        """
        {
          "query": "strongest action moment",
          "span_start_us": \(index * 1000000),
          "span_end_us": \((index + 1) * 1000000),
          "format_ok": true,
          "confidence": 0.7
        }
        """
    }.joined(separator: ",")
    try """
    {
      "project_id": "fixture",
      "artifact_version": "1",
      "model": {
        "provider": "marlin",
        "model_alias": "NemoStation/Marlin-2B",
        "model_snapshot": "test-snapshot",
        "connector_version": "marlin-local-v1",
        "inference_mode": "\(inferenceMode)"
      },
      "items": [
        {
          "asset_id": "A001",
          "source_path": "02_media/source/a001.mp4",
          "scene": "interview",
          "caption": "subject reacts",
          "events": [\(events)],
          "find_results": [\(finds)]
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/marlin_events.json"),
        atomically: true,
        encoding: .utf8
    )
}

private func writeTwoAssetMarlinEvents(project: URL) throws {
    try """
    {
      "project_id": "fixture",
      "artifact_version": "1",
      "model": {
        "provider": "marlin",
        "model_alias": "NemoStation/Marlin-2B",
        "model_snapshot": "test-snapshot",
        "connector_version": "marlin-local-v1",
        "inference_mode": "live"
      },
      "items": [
        {
          "asset_id": "A001",
          "source_path": "02_media/source/a001.mp4",
          "scene": "first materialized scene",
          "caption": "subject reacts",
          "events": [
            {
              "event_id": "MEV_A001_0001",
              "start_us": 0,
              "end_us": 1000000,
              "description": "existing marlin-covered moment",
              "confidence": 0.8,
              "source_pass": "marlin_caption"
            }
          ],
          "find_results": []
        },
        {
          "asset_id": "A002",
          "source_path": "02_media/source/a002.mp4",
          "scene": "second strong existing scene",
          "caption": "subject reacts",
          "events": [
            {
              "event_id": "MEV_A002_0001",
              "start_us": 0,
              "end_us": 1000000,
              "description": "lower confidence marlin moment",
              "confidence": 0.8,
              "source_pass": "marlin_caption"
            }
          ],
          "find_results": []
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/marlin_events.json"),
        atomically: true,
        encoding: .utf8
    )
}

private func writeSegments(project: URL, includeMarlinPeak: Bool) throws {
    let peakAnalysis = includeMarlinPeak
        ? """
          ,
          "peak_analysis": {
            "selected_peak_us": 1500000,
            "confidence": 0.82,
            "provenance": {
              "precision_mode": "marlin_temporal_semantics",
              "fusion_version": "marlin-segment-peak-v1"
            }
          }
        """
        : ""
    try """
    {
      "project_id": "fixture",
      "artifact_version": "1",
      "items": [
        {
          "segment_id": "S001",
          "asset_id": "A001",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "opening",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []\(peakAnalysis)
        },
        {
          "segment_id": "S002",
          "asset_id": "A001",
          "src_in_us": 3000000,
          "src_out_us": 6000000,
          "summary": "middle",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        },
        {
          "segment_id": "S003",
          "asset_id": "A001",
          "src_in_us": 6000000,
          "src_out_us": 9000000,
          "summary": "ending",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/segments.json"),
        atomically: true,
        encoding: .utf8
    )
}

private func writeSegmentsWithPeakFlags(project: URL, marlinPeaks: [Bool]) throws {
    let items = marlinPeaks.enumerated().map { index, includeMarlinPeak in
        let sourceInUS = index * 3_000_000
        let sourceOutUS = sourceInUS + 3_000_000
        let peakAnalysis = includeMarlinPeak
            ? """
              ,
              "peak_analysis": {
                "selected_peak_us": \(sourceInUS + 1_500_000),
                "confidence": 0.82,
                "provenance": {
                  "precision_mode": "marlin_temporal_semantics",
                  "fusion_version": "marlin-segment-peak-v1"
                }
              }
            """
            : ""
        return """
            {
              "segment_id": "S\(String(format: "%03d", index + 1))",
              "asset_id": "A001",
              "src_in_us": \(sourceInUS),
              "src_out_us": \(sourceOutUS),
              "summary": "segment \(index + 1)",
              "transcript_excerpt": "",
              "quality_flags": [],
              "tags": [],
              "interest_points": []\(peakAnalysis)
            }
        """
    }.joined(separator: ",")

    try """
    {
      "project_id": "fixture",
      "artifact_version": "1",
      "items": [
    \(items)
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/segments.json"),
        atomically: true,
        encoding: .utf8
    )
}

private func writeMixedMaterializedAndStrongPeakSegments(project: URL, fusedPeakScore: Double) throws {
    try """
    {
      "project_id": "fixture",
      "artifact_version": "1",
      "items": [
        {
          "segment_id": "S001",
          "asset_id": "A001",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "opening",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": [],
          "peak_analysis": {
            "selected_peak_us": 1500000,
            "confidence": 0.82,
            "provenance": {
              "precision_mode": "marlin_temporal_semantics",
              "fusion_version": "marlin-segment-peak-v1"
            }
          }
        },
        {
          "segment_id": "S002",
          "asset_id": "A002",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "second",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": [],
          "peak_analysis": {
            "selected_peak_us": 1500000,
            "confidence": 0.86,
            "support_signals": {
              "fused_peak_score": \(fusedPeakScore)
            },
            "provenance": {
              "precision_mode": "action_only",
              "fusion_version": "peak-fusion-v1"
            }
          }
        },
        {
          "segment_id": "S003",
          "asset_id": "A003",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "third",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        },
        {
          "segment_id": "S004",
          "asset_id": "A004",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "fourth",
          "transcript_excerpt": "",
          "quality_flags": [],
          "tags": [],
          "interest_points": []
        }
      ]
    }
    """.write(
        to: project.appendingPathComponent("03_analysis/segments.json"),
        atomically: true,
        encoding: .utf8
    )
}
