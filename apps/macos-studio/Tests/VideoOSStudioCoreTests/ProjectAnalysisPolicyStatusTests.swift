import XCTest
@testable import VideoOSStudioCore

final class ProjectAnalysisPolicyStatusTests: XCTestCase {
    func testStatusReadsVLMAndMarlinDefaults() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-policy-status-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("runtime"),
            withIntermediateDirectories: true
        )
        try """
        version: "1"
        vlm:
          model_alias: gemini-2.0-flash
          input_mode: frame_bundle_plus_text_context
          prompt_template_id: m2-segment-v1
        marlin:
          enabled: false
          model_alias: NemoStation/Marlin-2B
          connector_version: marlin-local-v1
          mode: hybrid
          role: temporal_semantics
          worker_path: python/marlin_worker.py
          mock: false
          output_artifact: 03_analysis/marlin_events.json
        """.write(
            to: root.appendingPathComponent("runtime/analysis-defaults.yaml"),
            atomically: true,
            encoding: .utf8
        )

        let status = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: root)

        XCTAssertEqual(status.readinessLabel, "hybrid opt-in")
        XCTAssertEqual(status.vlmModelAlias, "gemini-2.0-flash")
        XCTAssertEqual(status.vlmInputMode, "frame_bundle_plus_text_context")
        XCTAssertEqual(status.marlinEnabled, false)
        XCTAssertEqual(status.marlinMode, "hybrid")
        XCTAssertEqual(status.marlinModelAlias, "NemoStation/Marlin-2B")
        XCTAssertEqual(status.marlinConnectorVersion, "marlin-local-v1")
        XCTAssertEqual(status.marlinOutputArtifact, "03_analysis/marlin_events.json")
        XCTAssertTrue(status.preferredVLMRule.contains("30%"))
    }

    func testStatusReportsMissingPolicy() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-policy-missing-\(UUID().uuidString)")

        let status = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: root)

        XCTAssertEqual(status.readinessLabel, "missing policy")
        XCTAssertFalse(status.policyExists)
        XCTAssertFalse(status.policyReadable)
    }
}
