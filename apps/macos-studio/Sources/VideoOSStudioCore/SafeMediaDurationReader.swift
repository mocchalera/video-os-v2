import AVFoundation
import CoreMedia
import Foundation

enum SafeMediaDurationReader {
    private static let queue = DispatchQueue(label: "videoos.safe-media-duration-reader", qos: .utility)

    static func seconds(for url: URL, timeout: TimeInterval = 1.0) -> Double? {
        let semaphore = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var duration: Double?

        queue.async {
            let asset = AVURLAsset(url: url)
            let seconds = CMTimeGetSeconds(asset.duration)
            let value = seconds.isFinite && seconds > 0 ? seconds : nil

            lock.lock()
            duration = value
            lock.unlock()
            semaphore.signal()
        }

        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            return nil
        }

        lock.lock()
        defer { lock.unlock() }
        return duration
    }
}
