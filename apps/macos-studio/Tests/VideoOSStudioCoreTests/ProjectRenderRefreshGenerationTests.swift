import XCTest
@testable import VideoOSStudioCore

final class ProjectRenderRefreshGenerationTests: XCTestCase {
    func testLaterSameProjectRefreshInvalidatesEarlierCompletion() {
        var generation = ProjectRenderRefreshGeneration()
        let first = generation.issue(projectID: "demo")
        let second = generation.issue(projectID: "demo")

        XCTAssertFalse(generation.isCurrent(first, selectedProjectID: "demo"))
        XCTAssertTrue(generation.isCurrent(second, selectedProjectID: "demo"))
    }

    func testReverseCompletionAppliesOnlyLatestIssuedRefresh() {
        var generation = ProjectRenderRefreshGeneration()
        let first = generation.issue(projectID: "demo")
        let second = generation.issue(projectID: "demo")
        var applied: [String] = []

        for (token, value) in [(second, "new"), (first, "old")] {
            if generation.isCurrent(token, selectedProjectID: "demo") {
                applied.append(value)
            }
        }

        XCTAssertEqual(applied, ["new"])
    }

    func testProjectSelectionMustStillMatchLatestRefresh() {
        var generation = ProjectRenderRefreshGeneration()
        let token = generation.issue(projectID: "demo")

        XCTAssertFalse(generation.isCurrent(token, selectedProjectID: "other"))
        XCTAssertFalse(generation.isCurrent(token, selectedProjectID: nil))
        XCTAssertTrue(generation.isCurrent(token, selectedProjectID: "demo"))
    }
}
