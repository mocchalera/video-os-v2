public enum SourceMonitorPlaybackPublishing {
    public static func playbackTimeUS(seconds: Double) -> Int? {
        guard seconds.isFinite, seconds >= 0 else { return nil }
        return max(0, Int((seconds * 1_000_000).rounded()))
    }

    public static func shouldPublishPlaybackTime(previousUS: Int?, nextUS: Int?) -> Bool {
        previousUS != nextUS
    }
}
