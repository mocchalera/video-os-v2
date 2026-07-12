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

enum AudioWaveformBackend: Equatable {
    case audioFile
    case assetReader
}

public enum AudioWaveformExtractor {
    public static func extractPeaks(from url: URL, sampleCount: Int = 96) throws -> [Double] {
        let cappedSampleCount = max(1, min(sampleCount, 512))
        switch preferredBackend(for: url) {
        case .audioFile:
            do {
                return try extractAudioFilePeaks(from: url, sampleCount: cappedSampleCount)
            } catch {
                return try extractAssetReaderPeaks(from: url, sampleCount: cappedSampleCount)
            }
        case .assetReader:
            return try extractAssetReaderPeaks(from: url, sampleCount: cappedSampleCount)
        }
    }

    static func preferredBackend(for url: URL) -> AudioWaveformBackend {
        switch url.pathExtension.lowercased() {
        case "mov", "mp4", "m4v":
            return .assetReader
        default:
            return .audioFile
        }
    }

    private static func extractAudioFilePeaks(from url: URL, sampleCount cappedSampleCount: Int) throws -> [Double] {
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

        return normalize(peaks: Array(peaks.prefix(cappedSampleCount)))
    }

    private static func extractAssetReaderPeaks(from url: URL, sampleCount cappedSampleCount: Int) throws -> [Double] {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else { return [] }
        let formatInfo = audioFormatInfo(for: track)
        let channelCount = formatInfo.channelCount
        let durationSeconds = CMTimeGetSeconds(track.timeRange.duration)
        let estimatedTotalFrames = max(
            1,
            durationSeconds.isFinite && durationSeconds > 0
                ? Int(durationSeconds * formatInfo.sampleRate)
                : 1
        )

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsNonInterleaved: false
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return [] }
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? AudioWaveformExtractionError.readerFailed("AVAssetReader could not start.")
        }

        var peaks = Array(repeating: 0.0, count: cappedSampleCount)
        var framesRead = 0

        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            let byteCount = CMBlockBufferGetDataLength(blockBuffer)
            guard byteCount > 0 else { continue }

            var data = Data(count: byteCount)
            let status = data.withUnsafeMutableBytes { rawBuffer in
                CMBlockBufferCopyDataBytes(
                    blockBuffer,
                    atOffset: 0,
                    dataLength: byteCount,
                    destination: rawBuffer.baseAddress!
                )
            }
            guard status == noErr else { continue }

            let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
            data.withUnsafeBytes { rawBuffer in
                guard let baseAddress = rawBuffer.baseAddress else { return }
                let samples = baseAddress.assumingMemoryBound(to: Float.self)
                let availableFrameCount = min(
                    frameCount,
                    byteCount / MemoryLayout<Float>.size / channelCount
                )

                for frame in 0..<availableFrameCount {
                    var framePeak: Float = 0
                    let sampleOffset = frame * channelCount
                    for channel in 0..<channelCount {
                        framePeak = max(framePeak, abs(samples[sampleOffset + channel]))
                    }
                    let bucket = min(
                        cappedSampleCount - 1,
                        framesRead * cappedSampleCount / estimatedTotalFrames
                    )
                    peaks[bucket] = max(peaks[bucket], Double(min(framePeak, 1)))
                    framesRead += 1
                }
            }
        }

        if reader.status == .failed || reader.status == .cancelled {
            throw reader.error ?? AudioWaveformExtractionError.readerFailed("AVAssetReader failed.")
        }
        guard framesRead > 0 else { return [] }
        return normalize(peaks: peaks)
    }

    private static func audioFormatInfo(for track: AVAssetTrack) -> (sampleRate: Double, channelCount: Int) {
        for description in track.formatDescriptions {
            let audioDescription = description as! CMAudioFormatDescription
            guard let stream = CMAudioFormatDescriptionGetStreamBasicDescription(audioDescription)?.pointee else { continue }
            return (
                sampleRate: stream.mSampleRate > 0 ? stream.mSampleRate : 48_000,
                channelCount: max(1, Int(stream.mChannelsPerFrame))
            )
        }
        return (sampleRate: 48_000, channelCount: 1)
    }

    private static func normalize(peaks: [Double]) -> [Double] {
        let maxPeak = peaks.max() ?? 0
        guard maxPeak > 0 else { return Array(repeating: 0, count: max(1, peaks.count)) }
        return peaks.map { min(1, $0 / maxPeak) }
    }
}

private enum AudioWaveformExtractionError: Error {
    case readerFailed(String)
}
