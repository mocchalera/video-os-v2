import XCTest
@testable import VideoOSStudioCore

final class StudioProductStageTests: XCTestCase {
    func testProductRouteCollapsesInternalSurfacesIntoSixVisibleStages() {
        XCTAssertEqual(StudioProductStage.stage(for: .intent), .brief)
        XCTAssertEqual(StudioProductStage.stage(for: .ingest), .sources)
        XCTAssertEqual(StudioProductStage.stage(for: .triage), .sources)
        XCTAssertEqual(StudioProductStage.stage(for: .blueprint), .story)
        XCTAssertEqual(StudioProductStage.stage(for: .compile), .cut)
        XCTAssertEqual(StudioProductStage.stage(for: .review), .review)
        XCTAssertEqual(StudioProductStage.stage(for: .package), .export)
        XCTAssertEqual(StudioProductStage.allCases.map(\.rawValue), [
            "Brief", "Sources", "Story", "Cut", "Review", "Export",
        ])
    }

    func testSourcesStageAdvancesFromAnalysisToCandidateSelection() {
        XCTAssertEqual(StudioProductStage.sources.preferredSurface(analysisReady: false), .ingest)
        XCTAssertEqual(StudioProductStage.sources.preferredSurface(analysisReady: true), .triage)
    }

    func testProjectStateSelectsTheCurrentProductStageOnOpen() {
        XCTAssertEqual(
            StudioProductStage.preferredSurface(projectState: "intent_pending", hasTimeline: false, hasReview: false),
            .intent
        )
        XCTAssertEqual(
            StudioProductStage.preferredSurface(projectState: "media_analyzed", hasTimeline: false, hasReview: false),
            .ingest
        )
        XCTAssertEqual(
            StudioProductStage.preferredSurface(projectState: "timeline_drafted", hasTimeline: true, hasReview: false),
            .compile
        )
        XCTAssertEqual(
            StudioProductStage.preferredSurface(projectState: "approved", hasTimeline: true, hasReview: true),
            .review
        )
        XCTAssertEqual(
            StudioProductStage.preferredSurface(projectState: "packaged", hasTimeline: true, hasReview: true),
            .package
        )
    }
}
