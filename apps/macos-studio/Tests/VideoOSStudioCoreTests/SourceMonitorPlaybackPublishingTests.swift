import XCTest
@testable import VideoOSStudioCore

final class SourceMonitorPlaybackPublishingTests: XCTestCase {
    func testPlaybackTimeUSConvertsSecondsToMicroseconds() {
        XCTAssertEqual(SourceMonitorPlaybackPublishing.playbackTimeUS(seconds: 1.25), 1_250_000)
        XCTAssertEqual(SourceMonitorPlaybackPublishing.playbackTimeUS(seconds: 0), 0)
        XCTAssertNil(SourceMonitorPlaybackPublishing.playbackTimeUS(seconds: -.infinity))
        XCTAssertNil(SourceMonitorPlaybackPublishing.playbackTimeUS(seconds: .nan))
        XCTAssertNil(SourceMonitorPlaybackPublishing.playbackTimeUS(seconds: -0.1))
    }

    func testShouldPublishPlaybackTimeSuppressesIdenticalValues() {
        XCTAssertFalse(SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(previousUS: nil, nextUS: nil))
        XCTAssertFalse(SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(previousUS: 1_250_000, nextUS: 1_250_000))
        XCTAssertTrue(SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(previousUS: nil, nextUS: 1_250_000))
        XCTAssertTrue(SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(previousUS: 1_250_000, nextUS: nil))
        XCTAssertTrue(SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(previousUS: 1_250_000, nextUS: 1_250_001))
    }
}
