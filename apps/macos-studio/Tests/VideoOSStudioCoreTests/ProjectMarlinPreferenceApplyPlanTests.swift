import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinPreferenceApplyPlanTests: XCTestCase {
    func testApplyRefusesWhenPreferenceGateIsNotReady() throws {
        let root = try makePreferenceApplyRepository()
        try writePreferenceApplyProject(root: root, id: "interview")

        XCTAssertThrowsError(
            try ProjectMarlinPreferenceApplier.apply(repositoryRoot: root, confirm: true)
        ) { error in
            XCTAssertTrue(String(describing: error).contains("not ready"))
        }
    }

    func testApplyRequiresExplicitConfirmationWhenGateIsReady() throws {
        let root = try makeReadyPreferenceApplyRepository()

        XCTAssertThrowsError(
            try ProjectMarlinPreferenceApplier.apply(repositoryRoot: root, confirm: false)
        ) { error in
            XCTAssertEqual(error as? ProjectMarlinPreferenceApplyError, .confirmationRequired)
        }
    }

    func testApplyPromotesMarlinFirstPolicyWhenGateIsReadyAndConfirmed() throws {
        let root = try makeReadyPreferenceApplyRepository()
        let result = try ProjectMarlinPreferenceApplier.apply(repositoryRoot: root, confirm: true)

        XCTAssertTrue(result.wrotePolicy)
        XCTAssertEqual(result.previousPolicyLabel, "disabled / hybrid / live")
        XCTAssertEqual(result.nextPolicyLabel, "enabled / primary / live")

        let policy = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: root)
        XCTAssertEqual(policy.marlinEnabled, true)
        XCTAssertEqual(policy.marlinMode, "primary")
    }
}

private func makeReadyPreferenceApplyRepository() throws -> URL {
    let root = try makePreferenceApplyRepository()
    try writePreferenceApplyProject(root: root, id: "interview")
    try writePreferenceApplyProject(root: root, id: "music-video")
    return root
}

private func makePreferenceApplyRepository() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-marlin-preference-apply-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("projects"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("runtime"), withIntermediateDirectories: true)
    try """
    version: "1"
    marlin:
      enabled: false
      model_alias: NemoStation/Marlin-2B
      mode: hybrid
      mock: false
    """.write(to: root.appendingPathComponent("runtime/analysis-defaults.yaml"), atomically: true, encoding: .utf8)
    return root
}

private func writePreferenceApplyProject(root: URL, id: String) throws {
    let project = root.appendingPathComponent("projects/\(id)")
    try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: project.appendingPathComponent("03_analysis"), withIntermediateDirectories: true)
    try writePreferenceApplyBrief(project: project, id: id)
    try """
    {
      "project_id": "\(id)",
      "artifact_version": "1",
      "model": {
        "provider": "marlin",
        "model_alias": "NemoStation/Marlin-2B",
        "model_snapshot": "test-snapshot",
        "connector_version": "marlin-local-v1"
      },
      "items": [
        {
          "asset_id": "A001",
          "source_path": "02_media/source/a001.mp4",
          "scene": "representative footage",
          "events": [
            {
              "event_id": "MEV_A001_0001",
              "start_us": 1000000,
              "end_us": 2000000,
              "description": "clear temporal moment",
              "confidence": 0.8,
              "source_pass": "marlin_caption"
            }
          ],
          "find_results": [
            {
              "query": "strongest moment",
              "span_start_us": 1000000,
              "span_end_us": 2000000,
              "format_ok": true,
              "confidence": 0.7
            }
          ]
        }
      ]
    }
    """.write(to: project.appendingPathComponent("03_analysis/marlin_events.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "\(id)",
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
    """.write(to: project.appendingPathComponent("03_analysis/segments.json"), atomically: true, encoding: .utf8)
}

private func writePreferenceApplyBrief(project: URL, id: String) throws {
    let text: String
    if id == "interview" {
        text = """
        version: "1"
        project:
          title: Interview Candidate
          strategy: message-first
          format: testimonial-promo
        message:
          primary: Interview dialogue explains the offer through participant testimony.
        audience:
          primary: operators
        emotion_curve:
          - clarity
        must_have:
          - speaker dialogue
          - participant interview
        """
    } else {
        text = """
        version: "1"
        project:
          title: Music Growth Candidate
          strategy: chronological growth film cut to BGM
          format: keepsake-growth-film
        message:
          primary: Family growth story aligned to BGM beat sync.
        audience:
          primary: family
        emotion_curve:
          - growth
        must_have:
          - BGM beat sync
          - chronological family growth
        """
    }
    try text.write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
}
