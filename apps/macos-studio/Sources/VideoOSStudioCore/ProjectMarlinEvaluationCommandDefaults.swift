import Foundation

public enum ProjectMarlinEvaluationCommandDefaults {
    public static let requestTimeoutMs = 900_000
    public static let maxSources = 2
    public static let chunkSeconds = 30
    public static let chunkOverlapSeconds = 3
    public static let maxChunks = 2

    public static var boundedSkipExistingArgs: [String] {
        [
            "--request-timeout-ms=\(requestTimeoutMs)",
            "--max-sources=\(maxSources)",
            "--skip-existing",
            "--caption-only",
            "--chunk-seconds=\(chunkSeconds)",
            "--chunk-overlap-seconds=\(chunkOverlapSeconds)",
            "--max-chunks=\(maxChunks)"
        ]
    }
}
