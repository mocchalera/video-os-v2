import Foundation

public struct ProjectLibraryReadinessStatus: Equatable, Sendable {
    public let projectURL: URL
    public let assetCount: Int
    public let segmentCount: Int
    public let transcriptDocumentCount: Int
    public let transcriptItemCount: Int
    public let marlinEventCount: Int
    public let marlinFindResultCount: Int
    public let audioEventCount: Int
    public let audioStoryNodeCount: Int
    public let bgmSectionCount: Int
    public let bgmBeatCount: Int
    public let mediaReadyCount: Int
    public let mediaMissingCount: Int
    public let mediaProxyNeededCount: Int
    public let indexExists: Bool
    public let indexDocumentCount: Int
    public let indexUpdatedAt: String?
    public let indexURL: URL
    public let timelineExists: Bool
    public let handoffAnnotationsExist: Bool

    public var readinessLabel: String {
        if assetCount == 0 { return "not analyzed" }
        if mediaMissingCount > 0 { return "media relink needed" }
        if mediaProxyNeededCount > 0 { return "preview proxies needed" }
        if !indexExists { return "index missing" }
        if segmentCount == 0 { return "segments missing" }
        if timelineExists { return "library ready" }
        return "ready for compile"
    }

    public var mediaReady: Bool {
        assetCount > 0 && mediaMissingCount == 0 && mediaProxyNeededCount == 0
    }

    public var ragReady: Bool {
        indexExists && indexDocumentCount > 0
    }

    public var analysisReady: Bool {
        assetCount > 0 && segmentCount > 0
    }

    public var marlinReady: Bool {
        marlinEventCount > 0 || marlinFindResultCount > 0
    }

    public var audioReady: Bool {
        audioEventCount > 0 || audioStoryNodeCount > 0 || bgmSectionCount > 0 || bgmBeatCount > 0
    }

    public var ragCoverageLabel: String {
        guard indexExists else { return "missing" }
        return "\(indexDocumentCount) docs"
    }

    public var evidenceSummary: String {
        "\(assetCount) assets / \(segmentCount) segments / \(transcriptItemCount) transcript items / \(marlinEventCount + marlinFindResultCount) Marlin signals / \(audioEventCount + audioStoryNodeCount + bgmBeatCount) audio signals"
    }

    public var recommendation: String {
        if assetCount == 0 {
            return "Run analysis to create assets, segments, transcripts, and searchable project evidence."
        }
        if mediaMissingCount > 0 {
            return "Relink missing source media or add a source map before native preview and handoff."
        }
        if mediaProxyNeededCount > 0 {
            return "Build preview proxies so unsupported source media can play in the native viewer."
        }
        if !indexExists || indexDocumentCount == 0 {
            return "Rebuild the SQLite project index so Codex turns can use material search/RAG context."
        }
        if segmentCount == 0 {
            return "Run segment analysis before compile or clip-level agent work."
        }
        if !timelineExists {
            return "Library evidence is ready; compile a rough cut from the current brief and selects."
        }
        return "Library, media preview, RAG cache, and timeline are ready for review, render, or editor handoff."
    }
}

public enum ProjectLibraryReadinessStatusReader {
    public static func status(projectURL: URL) -> ProjectLibraryReadinessStatus {
        let evidence = ProjectEvidenceStore.load(projectURL: projectURL)
        let media = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: evidence.assets)
        let index = ProjectSQLiteIndex.status(projectURL: projectURL)
        let fileManager = FileManager.default
        let transcriptItemCount = evidence.transcripts.values.reduce(0) { $0 + $1.items.count }
        let marlinItems = evidence.marlinEvents?.items ?? []
        let bgm = evidence.bgmAnalysis

        return ProjectLibraryReadinessStatus(
            projectURL: projectURL,
            assetCount: evidence.assets?.items.count ?? 0,
            segmentCount: evidence.segments?.items.count ?? 0,
            transcriptDocumentCount: evidence.transcripts.count,
            transcriptItemCount: transcriptItemCount,
            marlinEventCount: marlinItems.reduce(0) { $0 + $1.events.count },
            marlinFindResultCount: marlinItems.reduce(0) { $0 + $1.findResults.count },
            audioEventCount: evidence.audioEvents?.items.count ?? 0,
            audioStoryNodeCount: evidence.audioStoryGraph?.nodes.count ?? 0,
            bgmSectionCount: bgm?.sections.count ?? 0,
            bgmBeatCount: bgm?.beats.count ?? 0,
            mediaReadyCount: media.readyCount,
            mediaMissingCount: media.missingCount,
            mediaProxyNeededCount: media.proxyNeededCount,
            indexExists: index.exists,
            indexDocumentCount: index.documentCount,
            indexUpdatedAt: index.updatedAt,
            indexURL: index.indexURL,
            timelineExists: fileManager.fileExists(atPath: projectURL.appendingPathComponent("05_timeline/timeline.json").path),
            handoffAnnotationsExist: fileManager.fileExists(atPath: projectURL.appendingPathComponent("07_handoff/editor_annotations.json").path)
        )
    }
}
