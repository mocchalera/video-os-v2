import CryptoKit
import Foundation

public struct BGMReviewResolvedSource: Equatable, Sendable {
    public let candidateID: String
    public let url: URL
    public let contentHash: String

    public init(candidateID: String, url: URL, contentHash: String) {
        self.candidateID = candidateID
        self.url = url
        self.contentHash = contentHash
    }
}

public enum BGMReviewSourceResolver {
    private static let supportedAudioExtensions = Set(["wav", "mp3", "m4a", "aif", "aiff", "flac"])

    public static func resolve(
        candidate: BGMShortlistReviewCandidate,
        queueURL: URL
    ) throws -> BGMReviewResolvedSource {
        let source = try parseSourceReference(candidate)
        let aggregateDirectory = queueURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .standardizedFileURL
        let parentDirectory = aggregateDirectory.deletingLastPathComponent()
        let aggregateName = aggregateDirectory.lastPathComponent
        let baseName = aggregateName.replacingOccurrences(
            of: #"-[0-9]+$"#,
            with: "",
            options: .regularExpression
        )
        let batchDirectory = parentDirectory.appendingPathComponent(
            source.batch == 1 ? baseName : "\(baseName)-\(source.batch - 1)",
            isDirectory: true
        )
        let inputDirectory = batchDirectory.appendingPathComponent("input", isDirectory: true)
        let sourceURL = inputDirectory.appendingPathComponent(source.filename, isDirectory: false)
        let realInput = inputDirectory.resolvingSymlinksInPath().standardizedFileURL
        let realSource = sourceURL.resolvingSymlinksInPath().standardizedFileURL

        guard isContained(realSource, in: realInput),
              FileManager.default.fileExists(atPath: realSource.path),
              (try? realSource.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
              supportedAudioExtensions.contains(realSource.pathExtension.lowercased()) else {
            throw BGMReviewDocumentError("候補音源がprivate batch内の通常音声ファイルとして解決できません。")
        }
        let actualHash = try sha256(for: realSource)
        guard actualHash == candidate.contentHash else {
            throw BGMReviewDocumentError("候補音源がshortlist作成時から変更されています。再確認してください。")
        }
        return BGMReviewResolvedSource(
            candidateID: candidate.candidateID,
            url: realSource,
            contentHash: actualHash
        )
    }

    public static func sha256(for url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
            hasher.update(data: data)
        }
        return "sha256:" + hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func parseSourceReference(
        _ candidate: BGMShortlistReviewCandidate
    ) throws -> (batch: Int, filename: String) {
        let prefix = "batch:\(candidate.batch)/input/"
        guard candidate.batch > 0,
              candidate.sourceRef.hasPrefix(prefix) else {
            throw BGMReviewDocumentError("候補音源のbatch参照が不正です。")
        }
        let filename = String(candidate.sourceRef.dropFirst(prefix.count))
        guard filename == candidate.filename,
              !filename.isEmpty,
              filename != ".",
              filename != "..",
              !filename.contains("/"),
              !filename.contains("\\"),
              filename.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f }) else {
            throw BGMReviewDocumentError("候補音源のファイル名が安全ではありません。")
        }
        return (candidate.batch, filename)
    }

    private static func isContained(_ candidate: URL, in root: URL) -> Bool {
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        return candidate.path.hasPrefix(rootPath) && candidate.path != root.path
    }
}
