import AVFoundation
import Foundation

public struct ProjectAudioWaveformMap: Equatable, Sendable {
    public let waveforms: [TimelineAudioWaveform]

    public static func build(
        projectURL: URL,
        timeline: TimelineDocument,
        assets: AnalysisAssetDocument?,
        sampleCount: Int = 96
    ) -> ProjectAudioWaveformMap {
        var cache: [URL: [Double]] = [:]
        var waveforms: [TimelineAudioWaveform] = []

        for track in timeline.tracks.audio {
            for clip in track.clips {
                guard let media = ProjectMediaResolver.resolveSelectedClip(projectURL: projectURL, clip: clip, assets: assets),
                      media.exists,
                      media.canPlayAudio,
                      let url = media.url else {
                    continue
                }

                let peaks: [Double]
                if let cached = cache[url] {
                    peaks = cached
                } else {
                    guard let extracted = try? AudioWaveformExtractor.extractPeaks(from: url, sampleCount: sampleCount), !extracted.isEmpty else {
                        continue
                    }
                    cache[url] = extracted
                    peaks = extracted
                }

                waveforms.append(TimelineAudioWaveform(
                    id: "waveform:\(track.id):\(clip.id)",
                    trackID: track.id,
                    clipID: clip.id,
                    assetID: clip.assetID,
                    resolvedFrom: media.resolvedFrom,
                    peaks: peaks
                ))
            }
        }

        return ProjectAudioWaveformMap(waveforms: waveforms)
    }
}

public struct TimelineAudioWaveform: Identifiable, Equatable, Sendable {
    public let id: String
    public let trackID: String
    public let clipID: String
    public let assetID: String
    public let resolvedFrom: String
    public let peaks: [Double]
}

public enum AudioWaveformExtractor {
    public static func extractPeaks(from url: URL, sampleCount: Int = 96) throws -> [Double] {
        let cappedSampleCount = max(1, min(sampleCount, 512))
        let file = try AVAudioFile(forReading: url)
        let totalFrames = Int(file.length)
        guard totalFrames > 0 else { return [] }

        let format = file.processingFormat
        let channelCount = max(1, Int(format.channelCount))
        let bucketSize = max(1, Int(ceil(Double(totalFrames) / Double(cappedSampleCount))))
        let chunkCapacity = AVAudioFrameCount(min(max(bucketSize, 1024), 8192))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkCapacity) else { return [] }

        var peaks: [Double] = []
        var currentPeak: Float = 0
        var framesInBucket = 0
        var framesRead = 0

        while framesRead < totalFrames {
            let framesToRead = min(Int(chunkCapacity), totalFrames - framesRead)
            try file.read(into: buffer, frameCount: AVAudioFrameCount(framesToRead))
            let count = Int(buffer.frameLength)
            guard count > 0 else { break }
            guard let channels = buffer.floatChannelData else { return [] }

            for frame in 0..<count {
                var samplePeak: Float = 0
                for channel in 0..<channelCount {
                    samplePeak = max(samplePeak, abs(channels[channel][frame]))
                }
                currentPeak = max(currentPeak, samplePeak)
                framesInBucket += 1

                if framesInBucket >= bucketSize {
                    peaks.append(Double(min(currentPeak, 1)))
                    currentPeak = 0
                    framesInBucket = 0
                }
            }

            framesRead += count
        }

        if framesInBucket > 0 {
            peaks.append(Double(min(currentPeak, 1)))
        }

        let maxPeak = peaks.max() ?? 0
        guard maxPeak > 0 else { return Array(repeating: 0, count: max(1, peaks.count)) }
        return peaks.prefix(cappedSampleCount).map { min(1, $0 / maxPeak) }
    }
}
