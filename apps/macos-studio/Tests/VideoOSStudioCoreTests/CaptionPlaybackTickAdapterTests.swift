import XCTest
@testable import VideoOSStudioCore

final class CaptionPlaybackTickAdapterTests: XCTestCase {
    func testNonFiniteTicksAreIgnored() {
        for seconds in [Double.nan, .infinity, -.infinity] {
            XCTAssertNil(
                CaptionPlaybackTickAdapter.decision(
                    seconds: seconds,
                    isPlaying: true,
                    loopStartSeconds: 2,
                    loopEndSeconds: 6
                )
            )
        }
    }

    func testFiniteTickUpdatesCurrentTimeWithoutRestartBeforeLoopEnd() throws {
        let decision = try XCTUnwrap(
            CaptionPlaybackTickAdapter.decision(
                seconds: 5.999,
                isPlaying: true,
                loopStartSeconds: 2,
                loopEndSeconds: 6
            )
        )

        XCTAssertEqual(decision.currentSeconds, 5.999)
        XCTAssertNil(decision.restartAtSeconds)
    }

    func testPausedTickAtLoopEndDoesNotRestart() throws {
        let decision = try XCTUnwrap(
            CaptionPlaybackTickAdapter.decision(
                seconds: 6,
                isPlaying: false,
                loopStartSeconds: 2,
                loopEndSeconds: 6
            )
        )

        XCTAssertEqual(decision.currentSeconds, 6)
        XCTAssertNil(decision.restartAtSeconds)
    }

    func testPlayingTickAtLoopEndRestartsAtExactLoopStart() throws {
        let decision = try XCTUnwrap(
            CaptionPlaybackTickAdapter.decision(
                seconds: 6,
                isPlaying: true,
                loopStartSeconds: 2,
                loopEndSeconds: 6
            )
        )

        XCTAssertEqual(decision.currentSeconds, 2)
        XCTAssertEqual(decision.restartAtSeconds, 2)
    }
}
