import CryptoKit
import Foundation
import XCTest
@testable import VideoOSStudioCore

final class BGMReviewTests: XCTestCase {
    private var temporaryRoots: [URL] = []

    override func tearDownWithError() throws {
        for root in temporaryRoots {
            try? FileManager.default.removeItem(at: root)
        }
        temporaryRoots = []
    }

    func testDocumentLoadsFiveIndependentGatesAndComputedProgress() throws {
        let fixture = try makeFixture()
        let document = try BGMReviewDocumentLoader.load(from: fixture.queueURL)

        XCTAssertEqual(document.tracks.count, 1)
        XCTAssertEqual(document.candidates.count, 1)
        XCTAssertEqual(document.completedReviewCount, 0)
        XCTAssertEqual(document.counts.sourceVerified, 1)
        XCTAssertEqual(document.candidates[0].review.musicalFit, .pending)
        XCTAssertEqual(document.candidates[0].review.dialogueBed, .pending)
        XCTAssertFalse(document.candidates[0].review.passesCandidateGate)
    }

    func testDocumentRejectsCountDriftBeforeStudioDisplaysQueue() throws {
        let fixture = try makeFixture(shortlistedCount: 2)
        XCTAssertThrowsError(try BGMReviewDocumentLoader.load(from: fixture.queueURL)) { error in
            XCTAssertTrue(error.localizedDescription.contains("集計値"))
        }
    }

    func testSourceResolverInfersPrivateBatchesAndVerifiesSHA() throws {
        let fixture = try makeFixture()
        let document = try BGMReviewDocumentLoader.load(from: fixture.queueURL)
        let source = try BGMReviewSourceResolver.resolve(
            candidate: try XCTUnwrap(document.candidates.first),
            queueURL: fixture.queueURL
        )

        XCTAssertEqual(source.url, fixture.audioURL.resolvingSymlinksInPath().standardizedFileURL)
        XCTAssertEqual(source.contentHash, try BGMReviewSourceResolver.sha256(for: fixture.audioURL))
    }

    func testSourceResolverRejectsChangedBytesAndSymlinkEscape() throws {
        let changedFixture = try makeFixture()
        let changedDocument = try BGMReviewDocumentLoader.load(from: changedFixture.queueURL)
        try Data("changed".utf8).append(to: changedFixture.audioURL)
        XCTAssertThrowsError(try BGMReviewSourceResolver.resolve(
            candidate: try XCTUnwrap(changedDocument.candidates.first),
            queueURL: changedFixture.queueURL
        )) { error in
            XCTAssertTrue(error.localizedDescription.contains("変更"))
        }

        let escapedFixture = try makeFixture(filename: "linked.wav", createAudio: false)
        let outsideURL = escapedFixture.root.appendingPathComponent("outside.wav")
        try Data("fixture audio".utf8).write(to: outsideURL)
        try FileManager.default.createSymbolicLink(
            at: escapedFixture.audioURL,
            withDestinationURL: outsideURL
        )
        XCTAssertThrowsError(try BGMReviewSourceResolver.resolve(
            candidate: try XCTUnwrap(BGMReviewDocumentLoader.load(from: escapedFixture.queueURL).candidates.first),
            queueURL: escapedFixture.queueURL
        )) { error in
            XCTAssertTrue(error.localizedDescription.contains("private batch"))
        }
    }

    func testRunnerBuildsArgumentVectorWithoutShellInterpolation() {
        let arguments = BGMReviewRunner.reviewArguments(
            queueURL: URL(fileURLWithPath: "/private/My Queue/review.json"),
            candidateID: "trust-clarity-low-01--b1--000000000000",
            reviewer: "Music Reviewer",
            musicalFit: .approved,
            dialogueBed: .passed,
            artifactQuality: .passed,
            originality: .passed,
            rights: .operatorDeclaredOK,
            notes: ["Dialogue fit passed.", "No artifacts heard."]
        )

        XCTAssertEqual(Array(arguments.prefix(4)), ["npx", "tsx", "scripts/bgm-shortlist.ts", "review"])
        XCTAssertTrue(arguments.contains("/private/My Queue/review.json"))
        XCTAssertTrue(arguments.contains("operator_declared_ok"))
        XCTAssertEqual(arguments.filter { $0 == "--note" }.count, 2)
        XCTAssertEqual(arguments.last, "--json")
    }

    @MainActor
    func testSessionRequiresAnActualReviewChangeBeforeSave() async throws {
        let fixture = try makeFixture()
        let session = BGMReviewSession(
            projectURL: fixture.root,
            repositoryRoot: fixture.root,
            reviewer: "Music Reviewer"
        )

        await session.load(queueURL: fixture.queueURL)

        XCTAssertEqual(session.selectedCandidateID, session.document?.candidates.first?.candidateID)
        XCTAssertFalse(session.hasUnsavedChanges)
        XCTAssertFalse(session.canSave)

        session.musicalFit = .approved

        XCTAssertTrue(session.hasUnsavedChanges)
    }

    private func makeFixture(
        shortlistedCount: Int = 1,
        filename: String = "candidate.wav",
        createAudio: Bool = true
    ) throws -> (root: URL, queueURL: URL, audioURL: URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("video-os-bgm-review-\(UUID().uuidString)", isDirectory: true)
        temporaryRoots.append(root)
        let batch = root.appendingPathComponent("music-workspace", isDirectory: true)
        let input = batch.appendingPathComponent("input", isDirectory: true)
        let aggregate = root.appendingPathComponent("music-workspace-2", isDirectory: true)
        let analysis = aggregate.appendingPathComponent("analysis", isDirectory: true)
        try FileManager.default.createDirectory(at: input, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: analysis, withIntermediateDirectories: true)
        let audioURL = input.appendingPathComponent(filename)
        let audioData = Data("fixture audio".utf8)
        if createAudio { try audioData.write(to: audioURL) }
        let hash = "sha256:" + audioData.sha256Hex
        let queueURL = analysis.appendingPathComponent("musical-review-queue.json")
        let json = """
        {
          "version": "1.0.0",
          "artifact_kind": "bgm-shortlist-review",
          "created_at": "2026-07-17T03:00:00.000Z",
          "source": {
            "shortlist_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "shortlist_created_at": "2026-07-17T03:00:00.000Z",
            "candidate_count_considered": 12,
            "method_warning": "Do not treat this ranking as musical acceptance."
          },
          "catalog": {
            "pack_id": "video-os-core-bgm-v1",
            "schema_version": "1.0",
            "content_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          "status": "ready_for_musical_review",
          "counts": {
            "tracks": 1,
            "shortlisted_candidates": \(shortlistedCount),
            "source_verified": 1,
            "promotion_eligible": 0,
            "errors": 0,
            "warnings": 0
          },
          "tracks": [{
            "track_id": "trust-clarity-low-01",
            "working_title": "Clear Ground",
            "family": "trust_clarity",
            "intensity": "low",
            "use_cases": ["executive interview"],
            "note": "Technical preselection only.",
            "candidates": [{
              "candidate_id": "trust-clarity-low-01--b1--\(hash.dropFirst(7).prefix(12))",
              "technical_rank": 1,
              "batch": 1,
              "filename": "\(filename)",
              "source_ref": "batch:1/input/\(filename)",
              "content_hash": "\(hash)",
              "size_bytes": \(audioData.count),
              "source_verified": true,
              "target_duration_sec": 149,
              "duration_sec": 148.6,
              "target_bpm": 84,
              "measured_bpm": 84.1,
              "normalized_bpm": 84.1,
              "technical_score": 98.2,
              "source_comment": "Audition under dialogue.",
              "recommended_for_audition": true,
              "review": {
                "musical_fit": "pending",
                "dialogue_bed": "pending",
                "artifact_quality": "pending",
                "originality": "pending",
                "rights": "pending",
                "reviewer_ref": null,
                "reviewed_at": null,
                "notes": []
              },
              "promotion_eligible": false
            }]
          }],
          "issues": []
        }
        """
        try Data(json.utf8).write(to: queueURL)
        return (root, queueURL, audioURL)
    }
}

private extension Data {
    var sha256Hex: String {
        SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined()
    }

    func append(to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: self)
    }
}
