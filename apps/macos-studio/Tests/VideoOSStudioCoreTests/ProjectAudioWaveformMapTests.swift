import Foundation
import XCTest
@testable import VideoOSStudioCore

final class ProjectAudioWaveformMapTests: XCTestCase {
    func testExtractorUsesAssetReaderForVideoContainers() {
        XCTAssertEqual(AudioWaveformExtractor.preferredBackend(for: URL(fileURLWithPath: "/tmp/interview.mp4")), .assetReader)
        XCTAssertEqual(AudioWaveformExtractor.preferredBackend(for: URL(fileURLWithPath: "/tmp/interview.mov")), .assetReader)
        XCTAssertEqual(AudioWaveformExtractor.preferredBackend(for: URL(fileURLWithPath: "/tmp/tone.wav")), .audioFile)
    }

    func testBuildExtractsNormalizedPeaksForAudioTimelineClip() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videoos-waveform-\(UUID().uuidString)")
        try writeWaveformFixtureProject(at: root)

        let timeline = try TimelineDocument.load(projectURL: root)
        let assets = try AnalysisAssetDocument.load(from: root.appendingPathComponent("03_analysis/assets.json"))
        let map = ProjectAudioWaveformMap.build(projectURL: root, timeline: timeline, assets: assets, sampleCount: 4)

        let waveform = try XCTUnwrap(map.waveforms.first)
        XCTAssertEqual(waveform.trackID, "A1")
        XCTAssertEqual(waveform.clipID, "ACL_001")
        XCTAssertEqual(waveform.assetID, "AST_AUDIO")
        XCTAssertEqual(waveform.resolvedFrom, "02_media/source")
        XCTAssertEqual(waveform.peaks.count, 4)
        XCTAssertLessThan(waveform.peaks[0], waveform.peaks[1])
        XCTAssertLessThan(waveform.peaks[1], waveform.peaks[2])
        XCTAssertLessThan(waveform.peaks[2], waveform.peaks[3])
        XCTAssertEqual(waveform.peaks[3], 1, accuracy: 0.01)
    }
}

private func writeWaveformFixtureProject(at root: URL) throws {
    let timelineDir = root.appendingPathComponent("05_timeline")
    let analysisDir = root.appendingPathComponent("03_analysis")
    let mediaDir = root.appendingPathComponent("02_media/source")
    try FileManager.default.createDirectory(at: timelineDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: analysisDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)

    try writeMonoWav(
        to: mediaDir.appendingPathComponent("tone.wav"),
        samples: [
            0, 512, 1024, 2048,
            0, 4096, 6144, 8192,
            0, 12288, 14336, 16384,
            0, 20480, 24576, 32760
        ],
        sampleRate: 8_000
    )

    try """
    {
      "version": "1",
      "project_id": "demo",
      "sequence": {
        "name": "Waveform",
        "fps_num": 30,
        "fps_den": 1,
        "width": 1920,
        "height": 1080,
        "start_frame": 0
      },
      "tracks": {
        "video": [],
        "audio": [
          {
            "track_id": "A1",
            "kind": "audio",
            "clips": [
              {
                "clip_id": "ACL_001",
                "segment_id": "SEG_001",
                "asset_id": "AST_AUDIO",
                "src_in_us": 0,
                "src_out_us": 2000,
                "timeline_in_frame": 0,
                "timeline_duration_frames": 16,
                "role": "bgm",
                "motivation": "fixture"
              }
            ]
          }
        ]
      },
      "markers": []
    }
    """.write(to: timelineDir.appendingPathComponent("timeline.json"), atomically: true, encoding: .utf8)

    try """
    {
      "project_id": "demo",
      "artifact_version": "analysis-v1",
      "items": [
        {
          "asset_id": "AST_AUDIO",
          "filename": "tone.wav",
          "role_guess": "bgm",
          "duration_us": 2000,
          "has_transcript": false,
          "segment_ids": [],
          "quality_flags": [],
          "tags": ["bgm"]
        }
      ]
    }
    """.write(to: analysisDir.appendingPathComponent("assets.json"), atomically: true, encoding: .utf8)
}

private func writeMonoWav(to url: URL, samples: [Int16], sampleRate: Int) throws {
    var data = Data()
    let byteRate = sampleRate * 2
    let dataSize = samples.count * 2
    let chunkSize = 36 + dataSize

    data.appendAscii("RIFF")
    data.appendUInt32LE(UInt32(chunkSize))
    data.appendAscii("WAVE")
    data.appendAscii("fmt ")
    data.appendUInt32LE(16)
    data.appendUInt16LE(1)
    data.appendUInt16LE(1)
    data.appendUInt32LE(UInt32(sampleRate))
    data.appendUInt32LE(UInt32(byteRate))
    data.appendUInt16LE(2)
    data.appendUInt16LE(16)
    data.appendAscii("data")
    data.appendUInt32LE(UInt32(dataSize))
    for sample in samples {
        data.appendUInt16LE(UInt16(bitPattern: sample))
    }
    try data.write(to: url, options: .atomic)
}

private extension Data {
    mutating func appendAscii(_ value: String) {
        append(contentsOf: value.data(using: .ascii) ?? Data())
    }

    mutating func appendUInt16LE(_ value: UInt16) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 24) & 0xff))
    }
}
