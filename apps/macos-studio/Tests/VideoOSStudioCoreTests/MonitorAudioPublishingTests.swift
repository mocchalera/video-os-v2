import XCTest
@testable import VideoOSStudioCore

final class MonitorAudioPublishingTests: XCTestCase {
    func testClampedVolumeKeepsVolumeInSliderBounds() {
        XCTAssertEqual(MonitorAudioPublishing.clampedVolume(-0.2), 0)
        XCTAssertEqual(MonitorAudioPublishing.clampedVolume(0.5), 0.5)
        XCTAssertEqual(MonitorAudioPublishing.clampedVolume(1.4), 1)
    }

    func testShouldPublishVolumeSuppressesIdenticalValues() {
        XCTAssertFalse(MonitorAudioPublishing.shouldPublishVolume(previous: 0.85, next: 0.85))
        XCTAssertTrue(MonitorAudioPublishing.shouldPublishVolume(previous: 0.85, next: 0.5))
    }

    func testShouldClearMuteOnlyForAudibleMutedMonitor() {
        XCTAssertTrue(MonitorAudioPublishing.shouldClearMute(previousMuted: true, volume: 0.1))
        XCTAssertFalse(MonitorAudioPublishing.shouldClearMute(previousMuted: true, volume: 0))
        XCTAssertFalse(MonitorAudioPublishing.shouldClearMute(previousMuted: false, volume: 0.1))
    }
}
