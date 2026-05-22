import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinRepresentativePlanTests: XCTestCase {
    func testPlanTracksRepresentativeInterviewMusicAndDocumentaryCoverage() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-marlin-representative-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try "{}".write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "worker".write(to: root.appendingPathComponent("scripts/marlin-evaluate.ts"), atomically: true, encoding: .utf8)

        try writeProject(
            at: root.appendingPathComponent("projects/interview-project"),
            title: "Participant Voice Interview",
            format: "testimonial-promo",
            primary: "Participant voices explain the offer in interview form.",
            mustHave: ["speaker dialogue", "participant voice"],
            mediaExists: true
        )
        try writeProject(
            at: root.appendingPathComponent("projects/music-growth-project"),
            title: "Growth MV",
            format: "keepsake-growth-film",
            primary: "Family growth story cut to BGM beat sync.",
            mustHave: ["BGM beat sync", "chronological growth"],
            mediaExists: true
        )
        try writeProject(
            at: root.appendingPathComponent("projects/blocked-documentary-project"),
            title: "Family Documentary",
            format: "family-documentary",
            primary: "Chronological family growth record.",
            mustHave: ["family", "growth"],
            mediaExists: false
        )

        let plan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: root)

        XCTAssertEqual(plan.targetBucketCount, 3)
        XCTAssertEqual(plan.coveredBucketCount, 3)
        XCTAssertEqual(plan.readinessLabel, "representative evaluation ready")
        XCTAssertTrue(plan.nextAction.contains("marlin-eval-run"))
        XCTAssertEqual(plan.buckets.first { $0.id == "interview-dialogue" }?.readinessLabel, "ready to evaluate")
        XCTAssertEqual(plan.buckets.first { $0.id == "music-beat" }?.readinessLabel, "ready to evaluate")
        XCTAssertEqual(plan.buckets.first { $0.id == "documentary-growth" }?.readinessLabel, "ready to evaluate")
        XCTAssertTrue(plan.projects.first { $0.id == "music-growth-project" }?.tags.contains("music-beat") ?? false)
        XCTAssertTrue(plan.projects.first { $0.id == "music-growth-project" }?.tags.contains("documentary-growth") ?? false)
    }

    private func writeProject(
        at project: URL,
        title: String,
        format: String,
        primary: String,
        mustHave: [String],
        mediaExists: Bool
    ) throws {
        let intentDir = project.appendingPathComponent("01_intent")
        let analysisDir = project.appendingPathComponent("03_analysis")
        let mediaDir = project.appendingPathComponent("02_media/source")
        try FileManager.default.createDirectory(at: intentDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        if mediaExists {
            try Data([0x00]).write(to: mediaDir.appendingPathComponent("source.mov"))
        }

        try """
        version: "1"
        project:
          title: "\(title)"
          strategy: message-first
          format: "\(format)"
        message:
          primary: "\(primary)"
        audience:
          primary: operators
        emotion_curve:
          - arc
        must_have:
        \(mustHave.map { "  - \"\($0)\"" }.joined(separator: "\n"))
        """.write(to: intentDir.appendingPathComponent("creative_brief.yaml"), atomically: true, encoding: .utf8)

        try """
        {
          "project_id": "\(project.lastPathComponent)",
          "artifact_version": "analysis-v1",
          "items": [
            {
              "asset_id": "AST_001",
              "filename": "source.mov",
              "role_guess": "source",
              "duration_us": 1000000,
              "has_transcript": false,
              "segment_ids": ["SEG_001"],
              "quality_flags": [],
              "tags": ["source"]
            }
          ]
        }
        """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
    }
}
