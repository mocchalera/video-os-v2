import Foundation

public enum CaptionWaveformTiming {
    public static func frameDelta(
        translationPoints: Double,
        widthPoints: Double,
        loopDurationSeconds: Double,
        fps: Double
    ) -> Int {
        guard widthPoints > 0, loopDurationSeconds > 0, fps > 0 else { return 0 }
        return Int((translationPoints / widthPoints * loopDurationSeconds * fps).rounded())
    }

    public static func clampedStartFrame(
        _ candidate: Int,
        endFrame: Int,
        loopStartFrame: Int,
        loopEndFrame: Int
    ) -> Int {
        let upperBound = min(endFrame - 1, loopEndFrame - 1)
        return min(max(candidate, loopStartFrame), max(loopStartFrame, upperBound))
    }

    public static func clampedEndFrame(
        _ candidate: Int,
        startFrame: Int,
        loopStartFrame: Int,
        loopEndFrame: Int
    ) -> Int {
        let lowerBound = max(startFrame + 1, loopStartFrame + 1)
        return max(min(candidate, loopEndFrame), min(loopEndFrame, lowerBound))
    }
}
