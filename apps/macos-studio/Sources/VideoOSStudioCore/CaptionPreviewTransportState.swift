import Foundation

public struct CaptionPreviewTransportState: Equatable, Sendable {
    public enum Readiness: String, Equatable, Sendable { case idle, loading, ready, failed }
    public private(set) var generation = 0
    public private(set) var readiness: Readiness = .idle
    public private(set) var isPlaying = false
    public private(set) var currentSeconds = 0.0
    public private(set) var loopStartSeconds = 0.0
    public private(set) var loopEndSeconds = 0.0

    public mutating func reselect(loopStart: Double, loopEnd: Double) -> Int {
        generation += 1
        readiness = .loading
        isPlaying = false
        loopStartSeconds = max(0, loopStart)
        loopEndSeconds = max(loopStartSeconds, loopEnd)
        currentSeconds = loopStartSeconds
        return generation
    }

    public mutating func itemBecameReady(generation expected: Int) {
        guard expected == generation else { return }
        // Readiness remains loading until the initial seek completion arrives.
        readiness = .loading
    }

    public mutating func initialSeekCompleted(generation expected: Int, success: Bool) {
        guard expected == generation else { return }
        readiness = success ? .ready : .failed
    }

    public mutating func play() {
        guard readiness == .ready else { return }
        if currentSeconds < loopStartSeconds || currentSeconds >= loopEndSeconds {
            currentSeconds = loopStartSeconds
        }
        isPlaying = true
    }

    public mutating func pause() { isPlaying = false }

    @discardableResult
    public mutating func tick(_ seconds: Double) -> Bool {
        guard seconds.isFinite else { return false }
        currentSeconds = seconds
        if isPlaying, seconds >= loopEndSeconds {
            currentSeconds = loopStartSeconds
            return true
        }
        return false
    }
}
