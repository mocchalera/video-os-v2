import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinPreferenceDecisionTests: XCTestCase {
    func testDecisionRequiresRepresentativeCandidateProjectsBeforeDefaultPreference() throws {
        let root = try makeMarlinPreferenceRepository()
        try writePreferenceProject(root: root, id: "interview", includeMarlinPeak: true)

        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)

        XCTAssertEqual(decision.evaluatedProjectCount, 1)
        XCTAssertEqual(decision.candidateProjectCount, 1)
        XCTAssertEqual(decision.decisionLabel, "needs representative coverage")
        XCTAssertFalse(decision.canPreferMarlinAsDefault)
        XCTAssertTrue(decision.recommendation.contains("representative projects"))
    }

    func testDecisionAllowsMarlinFirstWhenAllRepresentativeProjectsAreCandidates() throws {
        let root = try makeMarlinPreferenceRepository()
        try writePreferenceProject(root: root, id: "interview", includeMarlinPeak: true)
        try writePreferenceProject(root: root, id: "music-video", includeMarlinPeak: true)

        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)

        XCTAssertEqual(decision.evaluatedProjectCount, 2)
        XCTAssertEqual(decision.candidateProjectCount, 2)
        XCTAssertEqual(decision.representativeCandidateBucketCount, 3)
        XCTAssertEqual(decision.representativeTargetBucketCount, 3)
        XCTAssertEqual(decision.blockedEvaluatedProjectCount, 0)
        XCTAssertEqual(decision.decisionLabel, "ready for Marlin-first temporal VLM")
        XCTAssertEqual(decision.aggregateCoverageRatio, 1.0 / 3.0, accuracy: 0.001)
        XCTAssertTrue(decision.canPreferMarlinAsDefault)
    }

    func testDecisionBlocksWhenCandidateProjectsDoNotCoverRepresentativeCategories() throws {
        let root = try makeMarlinPreferenceRepository()
        try writePreferenceProject(root: root, id: "music-video", includeMarlinPeak: true)
        try writePreferenceProject(root: root, id: "documentary", includeMarlinPeak: true)

        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)

        XCTAssertEqual(decision.evaluatedProjectCount, 2)
        XCTAssertEqual(decision.candidateProjectCount, 2)
        XCTAssertEqual(decision.representativeCandidateBucketCount, 2)
        XCTAssertEqual(decision.representativeTargetBucketCount, 3)
        XCTAssertEqual(decision.decisionLabel, "needs representative category evidence")
        XCTAssertFalse(decision.canPreferMarlinAsDefault)
        XCTAssertTrue(decision.recommendation.contains("interview/dialogue"))
    }

    func testDecisionBlocksWhenEvaluatedProjectLacksMarlinPeakMaterialization() throws {
        let root = try makeMarlinPreferenceRepository()
        try writePreferenceProject(root: root, id: "interview", includeMarlinPeak: true)
        try writePreferenceProject(root: root, id: "music-video", includeMarlinPeak: true)
        try writePreferenceProject(root: root, id: "documentary", includeMarlinPeak: false)

        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)

        XCTAssertEqual(decision.evaluatedProjectCount, 3)
        XCTAssertEqual(decision.candidateProjectCount, 2)
        XCTAssertEqual(decision.blockedEvaluatedProjectCount, 1)
        XCTAssertEqual(decision.decisionLabel, "partially ready")
        XCTAssertFalse(decision.canPreferMarlinAsDefault)
    }

    func testDecisionIgnoresMockArtifactsAsRepresentativeEvidence() throws {
        let root = try makeMarlinPreferenceRepository()
        try writePreferenceProject(root: root, id: "interview", includeMarlinPeak: true, inferenceMode: "mock")
        try writePreferenceProject(root: root, id: "music-video", includeMarlinPeak: true)

        let decision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)

        XCTAssertEqual(decision.evaluatedProjectCount, 1)
        XCTAssertEqual(decision.candidateProjectCount, 1)
        XCTAssertEqual(decision.representativeCandidateBucketCount, 2)
        XCTAssertEqual(decision.decisionLabel, "needs representative coverage")
        XCTAssertFalse(decision.canPreferMarlinAsDefault)
    }
}

private func makeMarlinPreferenceRepository() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-marlin-preference-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("projects"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("runtime"), withIntermediateDirectories: true)
    try """
    marlin:
      enabled: false
      mode: hybrid
      model_alias: NemoStation/Marlin-2B
      mock: false
    """.write(to: root.appendingPathComponent("runtime/analysis-defaults.yaml"), atomically: true, encoding: .utf8)
    return root
}

private func writePreferenceProject(
    root: URL,
    id: String,
    includeMarlinPeak: Bool,
    inferenceMode: String = "live"
) throws {
    let project = root.appendingPathComponent("projects/\(id)")
    try FileManager.default.createDirectory(at: project.appendingPathComponent("01_intent"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: project.appendingPathComponent("03_analysis"), withIntermediateDirectories: true)
    try writePreferenceBrief(project: project, id: id)
    try """
    {
      "project_id": "\(id)",
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
          "scene": "representative footage",
          "caption": "subject reacts",
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
    """.write(to: project.appendingPathComponent("03_analysis/segments.json"), atomically: true, encoding: .utf8)
}

private func writePreferenceBrief(project: URL, id: String) throws {
    let text: String
    switch id {
    case "interview":
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
    case "music-video":
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
    default:
        text = """
        version: "1"
        project:
          title: Documentary Candidate
          strategy: chronological documentary
          format: family-documentary
        message:
          primary: Documentary growth record with chronological emotional arc.
        audience:
          primary: family
        emotion_curve:
          - growth
        must_have:
          - family documentary
          - chronological growth
        """
    }
    try text.write(to: project.appendingPathComponent("01_intent/creative_brief.yaml"), atomically: true, encoding: .utf8)
}
