public enum MonitorAudioPublishing {
    public static func clampedVolume(_ volume: Double) -> Double {
        max(0, min(volume, 1))
    }

    public static func shouldPublishVolume(
        previous: Double,
        next: Double
    ) -> Bool {
        previous != next
    }

    public static func shouldClearMute(
        previousMuted: Bool,
        volume: Double
    ) -> Bool {
        previousMuted && volume > 0
    }
}
