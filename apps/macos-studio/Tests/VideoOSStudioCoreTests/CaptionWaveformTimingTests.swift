import XCTest
@testable import VideoOSStudioCore

final class CaptionWaveformTimingTests: XCTestCase {
    func testConvertsPointerTranslationToFrameDelta() {
        XCTAssertEqual(CaptionWaveformTiming.frameDelta(
            translationPoints: 100,
            widthPoints: 500,
            loopDurationSeconds: 5,
            fps: 24
        ), 24)
    }

    func testStartHandleCannotCrossOutOrLeaveVisibleLoop() {
        XCTAssertEqual(CaptionWaveformTiming.clampedStartFrame(
            200,
            endFrame: 100,
            loopStartFrame: 40,
            loopEndFrame: 160
        ), 99)
        XCTAssertEqual(CaptionWaveformTiming.clampedStartFrame(
            10,
            endFrame: 100,
            loopStartFrame: 40,
            loopEndFrame: 160
        ), 40)
    }

    func testEndHandleCannotCrossInOrLeaveVisibleLoop() {
        XCTAssertEqual(CaptionWaveformTiming.clampedEndFrame(
            40,
            startFrame: 80,
            loopStartFrame: 20,
            loopEndFrame: 140
        ), 81)
        XCTAssertEqual(CaptionWaveformTiming.clampedEndFrame(
            180,
            startFrame: 80,
            loopStartFrame: 20,
            loopEndFrame: 140
        ), 140)
    }
}
