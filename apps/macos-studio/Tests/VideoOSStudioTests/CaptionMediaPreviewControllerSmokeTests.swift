import AVFoundation
import XCTest
@testable import VideoOSStudio

final class CaptionMediaPreviewControllerSmokeTests: XCTestCase {
    @MainActor
    func testPeriodicTicksDriveActualControllerStateAndLoopTransport() async {
        let observer = CaptionPlaybackTimeObserverSpy()
        let transport = CaptionPlaybackTransportSpy()
        let controller = CaptionMediaPreviewController(
            playbackObserver: observer,
            playbackTransport: transport,
            initialIsPlaying: true,
            initialCurrentSeconds: 2,
            loopStartSeconds: 2,
            loopEndSeconds: 6
        )

        observer.fire(CMTime(seconds: 4, preferredTimescale: 600))
        await Task.yield()
        XCTAssertEqual(controller.currentSeconds, 4)

        observer.fire(.invalid)
        await Task.yield()
        observer.fire(.positiveInfinity)
        await Task.yield()
        XCTAssertEqual(controller.currentSeconds, 4)
        XCTAssertTrue(transport.seekSeconds.isEmpty)
        XCTAssertEqual(transport.playCount, 0)

        observer.fire(CMTime(seconds: 5.99, preferredTimescale: 600))
        await Task.yield()
        XCTAssertEqual(controller.currentSeconds, 5.99)
        XCTAssertTrue(transport.seekSeconds.isEmpty)
        XCTAssertEqual(transport.playCount, 0)

        observer.fire(CMTime(seconds: 6, preferredTimescale: 600))
        await Task.yield()
        XCTAssertEqual(controller.currentSeconds, 2)
        XCTAssertEqual(transport.seekSeconds, [2])
        XCTAssertEqual(transport.playCount, 1)
    }

    @MainActor
    func testControllerRemovalUnregistersObserverExactlyOnce() {
        let observer = CaptionPlaybackTimeObserverSpy()
        let transport = CaptionPlaybackTransportSpy()
        weak var releasedController: CaptionMediaPreviewController?

        autoreleasepool {
            var controller: CaptionMediaPreviewController? = CaptionMediaPreviewController(
                playbackObserver: observer,
                playbackTransport: transport
            )
            releasedController = controller
            XCTAssertEqual(observer.addCount, 1)
            controller = nil
        }

        XCTAssertNil(releasedController)
        XCTAssertEqual(observer.removeCount, 1)
        XCTAssertTrue(observer.removedToken === observer.token)
    }
}

private final class CaptionPlaybackTimeObserverSpy: CaptionPlaybackTimeObserving {
    let token = NSObject()
    private var handler: (@Sendable (CMTime) -> Void)?
    private(set) var addCount = 0
    private(set) var removeCount = 0
    private(set) var removedToken: AnyObject?

    func addPeriodicTimeObserver(
        _ handler: @escaping @Sendable (CMTime) -> Void
    ) -> Any {
        addCount += 1
        self.handler = handler
        return token
    }

    func removeTimeObserver(_ token: Any) {
        removeCount += 1
        removedToken = token as AnyObject
    }

    func fire(_ time: CMTime) {
        handler?(time)
    }
}

private final class CaptionPlaybackTransportSpy: CaptionPlaybackTransporting {
    private(set) var seekSeconds: [Double] = []
    private(set) var playCount = 0

    func seek(to seconds: Double) {
        seekSeconds.append(seconds)
    }

    func play() {
        playCount += 1
    }
}
