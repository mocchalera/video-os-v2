import XCTest
@testable import VideoOSStudioCore

final class TimelineClipSelectionPublishingTests: XCTestCase {
    func testClearedSelectionIDsAreEmpty() {
        XCTAssertEqual(TimelineClipSelectionPublishing.clearedSelectionIDs(), [])
    }

    func testSingleSelectionIDsNormalizeOptionalPrimaryID() {
        XCTAssertEqual(TimelineClipSelectionPublishing.singleSelectionIDs(primaryID: "clip-a"), ["clip-a"])
        XCTAssertEqual(TimelineClipSelectionPublishing.singleSelectionIDs(primaryID: nil), [])
    }

    func testShouldPublishSuppressesIdenticalSelectionState() {
        XCTAssertFalse(TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: nil,
            currentSelectedIDs: [],
            nextPrimaryID: nil,
            nextSelectedIDs: []
        ))

        XCTAssertFalse(TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: "clip-a",
            currentSelectedIDs: ["clip-a", "clip-b"],
            nextPrimaryID: "clip-a",
            nextSelectedIDs: ["clip-b", "clip-a"]
        ))

        XCTAssertFalse(TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: "clip-a",
            currentSelectedIDs: ["clip-a"],
            nextPrimaryID: "clip-a",
            nextSelectedIDs: ["clip-a"]
        ))
    }

    func testShouldPublishWhenSelectionStateChanges() {
        XCTAssertTrue(TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: "clip-a",
            currentSelectedIDs: ["clip-a"],
            nextPrimaryID: "clip-b",
            nextSelectedIDs: ["clip-a"]
        ))

        XCTAssertTrue(TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: "clip-a",
            currentSelectedIDs: ["clip-a"],
            nextPrimaryID: "clip-a",
            nextSelectedIDs: ["clip-a", "clip-b"]
        ))

        XCTAssertTrue(TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: "clip-a",
            currentSelectedIDs: [],
            nextPrimaryID: "clip-a",
            nextSelectedIDs: ["clip-a"]
        ))
    }
}
