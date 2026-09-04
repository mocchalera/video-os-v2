import Foundation
import CryptoKit

public struct ProjectHandoffExportPlan: Equatable, Sendable {
    public let projectURL: URL
    public let projectID: String
    public let timelineExists: Bool
    public let sourceMapExists: Bool
    public let sourceMapEntryCount: Int
    public let generatedSourceMapEntryCount: Int
    public let sourceMapReadinessLabel: String
    public let sourceMapCoverageLabel: String
    public let sourceMapReadyAssetCount: Int
    public let sourceMapMissingEntryCount: Int
    public let sourceMapBrokenEntryCount: Int
    public let usesTemporarySourceMap: Bool
    public let mediaReadyCount: Int
    public let mediaMissingCount: Int
    public let mediaProxyNeededCount: Int
    public let editorAnnotationExists: Bool
    public let editorAnnotationNoteCount: Int
    public let outputURL: URL
    public let commandArguments: [String]

    public var canExportPremiereXML: Bool {
        timelineExists && (sourceMapEntryCount > 0 || generatedSourceMapEntryCount > 0)
    }

    public var readinessLabel: String {
        guard timelineExists else { return "timeline missing" }
        guard sourceMapEntryCount > 0 || generatedSourceMapEntryCount > 0 else { return "source map missing" }
        if mediaMissingCount > 0 {
            if usesTemporarySourceMap {
                return "exportable with temporary source map and \(mediaMissingCount) relinks"
            }
            return "exportable with \(mediaMissingCount) relinks"
        }
        if mediaProxyNeededCount > 0 {
            return "exportable; \(mediaProxyNeededCount) native proxies pending"
        }
        return "ready"
    }

    public var commandLine: String {
        commandArguments.map(shellQuote).joined(separator: " ")
    }

    private func shellQuote(_ value: String) -> String {
        guard !value.isEmpty else { return "''" }
        if value.range(of: #"[^A-Za-z0-9_@%+=:,./-]"#, options: .regularExpression) == nil {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

public struct ProjectHandoffExportResult: Equatable, Sendable {
    public let plan: ProjectHandoffExportPlan
    public let outputURL: URL
    public let stdout: String
    public let stderr: String
}

public struct ProjectEditorPacketPlan: Equatable, Sendable {
    public let handoffPlan: ProjectHandoffExportPlan
    public let packetURL: URL
    public let manifestURL: URL
    public let premiereXMLURL: URL
    public let editorNotesURL: URL
    public let annotationSourceURL: URL
    public let annotationPacketURL: URL
    public let reviewReportSourceURL: URL
    public let reviewReportPacketURL: URL
    public let reviewPatchSourceURL: URL
    public let reviewPatchPacketURL: URL
    public let mediaSources: [ProjectEditorPacketMediaSource]
    public let receiptSources: [ProjectEditorPacketMediaSource]

    public var canExportPacket: Bool {
        handoffPlan.canExportPremiereXML
    }

    public var annotationIncluded: Bool {
        handoffPlan.editorAnnotationExists
    }

    public var reviewReportIncluded: Bool {
        FileManager.default.fileExists(atPath: reviewReportSourceURL.path)
    }

    public var reviewPatchIncluded: Bool {
        FileManager.default.fileExists(atPath: reviewPatchSourceURL.path)
    }

    public var mediaIncludedCount: Int {
        mediaSources.count
    }

    public var receiptIncludedCount: Int {
        receiptSources.count
    }

    public var readinessLabel: String {
        guard canExportPacket else { return handoffPlan.readinessLabel }
        if annotationIncluded {
            return "packet ready with \(handoffPlan.editorAnnotationNoteCount) notes"
        }
        return "packet ready without notes"
    }
}

public struct ProjectEditorPacketResult: Equatable, Sendable {
    public let plan: ProjectEditorPacketPlan
    public let packetURL: URL
    public let manifestURL: URL
    public let files: [URL]
}

public struct ProjectEditorPacketVerificationStatus: Equatable, Sendable {
    public let projectURL: URL
    public let packetURL: URL
    public let manifestURL: URL
    public let packetExists: Bool
    public let manifestExists: Bool
    public let manifestReadable: Bool
    public let manifestProjectID: String?
    public let manifestFileCount: Int
    public let existingFileCount: Int
    public let missingFiles: [String]
    public let mediaFileCount: Int
    public let previewMediaIncluded: Bool
    public let finalMediaIncluded: Bool
    public let finalAudioIncluded: Bool
    public let captionSidecarIncluded: Bool
    public let captionApprovalIncluded: Bool
    public let identityChainValid: Bool
    public let identityChainIssues: [String]

    public var missingFileCount: Int {
        missingFiles.count
    }

    public var readinessLabel: String {
        guard packetExists else { return "packet missing" }
        guard manifestExists else { return "manifest missing" }
        guard manifestReadable else { return "manifest unreadable" }
        guard missingFiles.isEmpty else { return "packet incomplete" }
        guard identityChainValid else { return "packet identity invalid" }
        guard mediaFileCount > 0 else { return "packet has no media" }
        guard finalMediaIncluded else { return "final media missing" }
        if !finalAudioIncluded {
            return "packet verified without final audio"
        }
        return "packet verified"
    }

    public var recommendation: String {
        switch readinessLabel {
        case "packet verified":
            return "Editor packet contains its manifest files, final media, and final audio."
        case "packet verified without final audio":
            return "Editor packet is internally complete, but final audio is not included. Run render/package with final_mix.wav before final handoff when audio finishing matters."
        case "final media missing":
            return "Run render/package and export the editor packet again so the human editor receives final media in the packet."
        case "packet has no media":
            return "Export after render or preview generation so the packet includes preview/final media instead of only notes and XML."
        case "packet incomplete":
            return "Re-export the editor packet; at least one file listed in manifest.json is missing from the packet folder."
        case "manifest unreadable":
            return "Regenerate the editor packet; manifest.json exists but cannot be decoded."
        case "packet identity invalid":
            return "Regenerate the editor packet; an export identity sidecar, content hash, or XML identity marker is stale or tampered."
        case "manifest missing":
            return "Export the editor packet to create manifest.json."
        default:
            return "Export the editor packet before handoff verification."
        }
    }
}

public struct ProjectEditorPacketMediaSource: Equatable, Sendable {
    public let kind: String
    public let sourceURL: URL
    public let packetRelativePath: String
}

public struct ProjectEditorPacketManifest: Codable, Equatable, Sendable {
    public struct FileEntry: Codable, Equatable, Sendable {
        public let kind: String
        public let relativePath: String
        public let sourcePath: String?
        public let contentSHA256: String?

        public init(kind: String, relativePath: String, sourcePath: String?, contentSHA256: String? = nil) {
            self.kind = kind
            self.relativePath = relativePath
            self.sourcePath = sourcePath
            self.contentSHA256 = contentSHA256
        }

        enum CodingKeys: String, CodingKey {
            case kind
            case relativePath = "relative_path"
            case sourcePath = "source_path"
            case contentSHA256 = "content_sha256"
        }
    }

    public let version: String
    public let projectID: String
    public let generatedAt: String
    public let premiereXML: String
    public let annotationNotes: Int
    public let mediaMissing: Int
    public let sourceMapStatus: String
    public let sourceMapCoverage: String
    public let sourceMapMissingEntries: Int
    public let sourceMapBrokenEntries: Int
    public let usesTemporarySourceMap: Bool
    public let files: [FileEntry]

    public init(
        version: String,
        projectID: String,
        generatedAt: String,
        premiereXML: String,
        annotationNotes: Int,
        mediaMissing: Int,
        sourceMapStatus: String,
        sourceMapCoverage: String,
        sourceMapMissingEntries: Int,
        sourceMapBrokenEntries: Int,
        usesTemporarySourceMap: Bool,
        files: [FileEntry]
    ) {
        self.version = version
        self.projectID = projectID
        self.generatedAt = generatedAt
        self.premiereXML = premiereXML
        self.annotationNotes = annotationNotes
        self.mediaMissing = mediaMissing
        self.sourceMapStatus = sourceMapStatus
        self.sourceMapCoverage = sourceMapCoverage
        self.sourceMapMissingEntries = sourceMapMissingEntries
        self.sourceMapBrokenEntries = sourceMapBrokenEntries
        self.usesTemporarySourceMap = usesTemporarySourceMap
        self.files = files
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        projectID = try container.decode(String.self, forKey: .projectID)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        premiereXML = try container.decode(String.self, forKey: .premiereXML)
        annotationNotes = try container.decode(Int.self, forKey: .annotationNotes)
        mediaMissing = try container.decode(Int.self, forKey: .mediaMissing)
        sourceMapStatus = try container.decodeIfPresent(String.self, forKey: .sourceMapStatus) ?? "unknown"
        sourceMapCoverage = try container.decodeIfPresent(String.self, forKey: .sourceMapCoverage) ?? "unknown"
        sourceMapMissingEntries = try container.decodeIfPresent(Int.self, forKey: .sourceMapMissingEntries) ?? 0
        sourceMapBrokenEntries = try container.decodeIfPresent(Int.self, forKey: .sourceMapBrokenEntries) ?? 0
        usesTemporarySourceMap = try container.decodeIfPresent(Bool.self, forKey: .usesTemporarySourceMap) ?? false
        files = try container.decode([FileEntry].self, forKey: .files)
    }

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case generatedAt = "generated_at"
        case premiereXML = "premiere_xml"
        case annotationNotes = "annotation_notes"
        case mediaMissing = "media_missing"
        case sourceMapStatus = "source_map_status"
        case sourceMapCoverage = "source_map_coverage"
        case sourceMapMissingEntries = "source_map_missing_entries"
        case sourceMapBrokenEntries = "source_map_broken_entries"
        case usesTemporarySourceMap = "uses_temporary_source_map"
        case files
    }
}

public enum ProjectHandoffExportError: Error, Equatable, CustomStringConvertible {
    case notReady(String)
    case processFailed(status: Int32, stdout: String, stderr: String)
    case outputMissing(URL)
    case packetMissingPremiereXML(URL)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        case .processFailed(let status, let stdout, let stderr):
            return "Premiere XML export failed with status \(status).\n\(stdout)\n\(stderr)"
        case .outputMissing(let url):
            return "Premiere XML export finished but output was not found: \(url.path)"
        case .packetMissingPremiereXML(let url):
            return "Editor packet requires Premiere XML before packaging: \(url.path)"
        }
    }
}

public enum ProjectHandoffExporter {
    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        autoTitles: Bool = true
    ) -> ProjectHandoffExportPlan {
        let timelineURL = TimelineDocument.timelineURL(for: projectURL)
        let timeline = try? TimelineDocument.load(from: timelineURL)
        let projectID = timeline?.projectID ?? projectURL.lastPathComponent
        let sourceMap = MediaSourceMapSummary.load(projectURL: projectURL)
        let sourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL, assets: assets)
        let mediaSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: assets)
        let annotationSummary = ProjectEditorAnnotationStore.summary(projectURL: projectURL, timeline: timeline)
        let generatedSourceMapEntryCount = sourceMap.entryCount > 0 ? 0 : mediaSummary.items.filter { $0.url != nil }.count
        let usesTemporarySourceMap = sourceMap.entryCount == 0 && generatedSourceMapEntryCount > 0
        let outputURL = projectURL
            .appendingPathComponent("09_output")
            .appendingPathComponent("\(projectID)_premiere.xml")
        var arguments = [
            "npx",
            "tsx",
            "scripts/export-premiere-xml.ts",
            projectURL.path
        ]
        if sourceMap.entryCount == 0, generatedSourceMapEntryCount > 0 {
            arguments += ["--source-map", "<generated-from-assets>"]
        }
        if autoTitles {
            arguments.append("--auto-titles")
        }

        return ProjectHandoffExportPlan(
            projectURL: projectURL,
            projectID: projectID,
            timelineExists: FileManager.default.fileExists(atPath: timelineURL.path),
            sourceMapExists: sourceMap.exists,
            sourceMapEntryCount: sourceMap.entryCount,
            generatedSourceMapEntryCount: generatedSourceMapEntryCount,
            sourceMapReadinessLabel: sourceMapStatus.readinessLabel,
            sourceMapCoverageLabel: sourceMapStatus.coverageLabel,
            sourceMapReadyAssetCount: sourceMapStatus.readyAssetCount,
            sourceMapMissingEntryCount: sourceMapStatus.missingAssetIDs.count,
            sourceMapBrokenEntryCount: sourceMapStatus.brokenEntries.count,
            usesTemporarySourceMap: usesTemporarySourceMap,
            mediaReadyCount: mediaSummary.readyCount,
            mediaMissingCount: mediaSummary.missingCount,
            mediaProxyNeededCount: mediaSummary.proxyNeededCount,
            editorAnnotationExists: annotationSummary.exists,
            editorAnnotationNoteCount: annotationSummary.noteCount,
            outputURL: outputURL,
            commandArguments: arguments
        )
    }

    public static func exportPremiereXML(
        repositoryRoot: URL,
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        autoTitles: Bool = true
    ) throws -> ProjectHandoffExportResult {
        let plan = plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: assets, autoTitles: autoTitles)
        guard plan.canExportPremiereXML else {
            throw ProjectHandoffExportError.notReady(plan.readinessLabel)
        }

        let sourceMapURL = try makeTemporarySourceMapIfNeeded(plan: plan)
        defer {
            if let sourceMapURL {
                try? FileManager.default.removeItem(at: sourceMapURL)
            }
        }

        var arguments = plan.commandArguments
        if let sourceMapURL, let placeholderIndex = arguments.firstIndex(of: "<generated-from-assets>") {
            arguments[placeholderIndex] = sourceMapURL.path
        }

        let result = try runProcess(
            executableURL: URL(fileURLWithPath: "/usr/bin/env"),
            arguments: arguments,
            workingDirectory: repositoryRoot
        )
        guard result.status == 0 else {
            throw ProjectHandoffExportError.processFailed(status: result.status, stdout: result.stdout, stderr: result.stderr)
        }
        guard FileManager.default.fileExists(atPath: plan.outputURL.path) else {
            throw ProjectHandoffExportError.outputMissing(plan.outputURL)
        }
        return ProjectHandoffExportResult(plan: plan, outputURL: plan.outputURL, stdout: result.stdout, stderr: result.stderr)
    }

    private static func runProcess(
        executableURL: URL,
        arguments: [String],
        workingDirectory: URL
    ) throws -> (status: Int32, stdout: String, stderr: String) {
        let output = try SubprocessRunner.run(
            executablePath: executableURL.path,
            arguments: arguments,
            currentDirectoryURL: workingDirectory
        )
        return (output.exitCode, output.stdout, output.stderr)
    }

    private static func makeTemporarySourceMapIfNeeded(plan: ProjectHandoffExportPlan) throws -> URL? {
        guard plan.sourceMapEntryCount == 0, plan.generatedSourceMapEntryCount > 0 else { return nil }
        let summary = ProjectMediaResolver.previewSummary(projectURL: plan.projectURL, assets: nil)
        let pairs = summary.items.compactMap { item -> (String, String)? in
            guard let path = item.url?.path else { return nil }
            return (item.assetID, path)
        }
        guard !pairs.isEmpty else { return nil }
        let sourceMap = Dictionary(uniqueKeysWithValues: pairs)
        let data = try JSONSerialization.data(withJSONObject: sourceMap, options: [.prettyPrinted, .sortedKeys])
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("videoos-\(plan.projectID)-source-map-\(UUID().uuidString).json")
        try data.write(to: url, options: .atomic)
        return url
    }
}

public enum ProjectEditorPacketExporter {
    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil
    ) -> ProjectEditorPacketPlan {
        let handoffPlan = ProjectHandoffExporter.plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: assets)
        let packetURL = projectURL
            .appendingPathComponent("09_output")
            .appendingPathComponent("editor_packet")
        return ProjectEditorPacketPlan(
            handoffPlan: handoffPlan,
            packetURL: packetURL,
            manifestURL: packetURL.appendingPathComponent("manifest.json"),
            premiereXMLURL: packetURL.appendingPathComponent(handoffPlan.outputURL.lastPathComponent),
            editorNotesURL: packetURL.appendingPathComponent("editor_notes.md"),
            annotationSourceURL: ProjectEditorAnnotationStore.annotationsURL(for: projectURL),
            annotationPacketURL: packetURL.appendingPathComponent("editor_annotations.json"),
            reviewReportSourceURL: projectURL.appendingPathComponent("06_review/review_report.yaml"),
            reviewReportPacketURL: packetURL.appendingPathComponent("review_report.yaml"),
            reviewPatchSourceURL: projectURL.appendingPathComponent("06_review/review_patch.json"),
            reviewPatchPacketURL: packetURL.appendingPathComponent("review_patch.json"),
            mediaSources: mediaSources(projectURL: projectURL),
            receiptSources: receiptSources(projectURL: projectURL, projectID: handoffPlan.projectID)
        )
    }

    public static func export(
        repositoryRoot: URL,
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        exportPremiereXML: Bool = true,
        generatedAt: Date = Date()
    ) throws -> ProjectEditorPacketResult {
        if exportPremiereXML {
            _ = try ProjectHandoffExporter.exportPremiereXML(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: assets)
        }
        let plan = plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: assets)
        guard plan.canExportPacket else {
            throw ProjectHandoffExportError.notReady(plan.readinessLabel)
        }
        let exportGeneration = try PremiereExportGraphValidator.validate(
            projectURL: projectURL,
            projectID: plan.handoffPlan.projectID
        )
        let packetReceiptSources = receiptSources(
            projectURL: projectURL,
            projectID: plan.handoffPlan.projectID,
            premiereIdentitySource: exportGeneration.identityURL
        )

        let fileManager = FileManager.default
        try fileManager.createDirectory(at: plan.packetURL, withIntermediateDirectories: true)
        let mediaPacketDirectory = plan.packetURL.appendingPathComponent("media")
        if fileManager.fileExists(atPath: mediaPacketDirectory.path) {
            try fileManager.removeItem(at: mediaPacketDirectory)
        }
        if fileManager.fileExists(atPath: plan.premiereXMLURL.path) {
            try fileManager.removeItem(at: plan.premiereXMLURL)
        }
        try fileManager.copyItem(at: exportGeneration.xmlURL, to: plan.premiereXMLURL)

        var files = [
            ProjectEditorPacketManifest.FileEntry(
                kind: "premiere_xml",
                relativePath: plan.premiereXMLURL.lastPathComponent,
                sourcePath: exportGeneration.xmlURL.path
            )
        ]
        var outputFiles = [plan.premiereXMLURL]

        let annotations = ProjectEditorAnnotationStore.load(projectURL: projectURL)
        let editorNotes = makeEditorNotesMarkdown(
            plan: plan,
            annotations: annotations,
            receiptSources: packetReceiptSources
        )
        try editorNotes.write(to: plan.editorNotesURL, atomically: true, encoding: .utf8)
        files.append(ProjectEditorPacketManifest.FileEntry(
            kind: "editor_notes",
            relativePath: plan.editorNotesURL.lastPathComponent,
            sourcePath: nil
        ))
        outputFiles.append(plan.editorNotesURL)

        if fileManager.fileExists(atPath: plan.annotationSourceURL.path) {
            if fileManager.fileExists(atPath: plan.annotationPacketURL.path) {
                try fileManager.removeItem(at: plan.annotationPacketURL)
            }
            try fileManager.copyItem(at: plan.annotationSourceURL, to: plan.annotationPacketURL)
            files.append(ProjectEditorPacketManifest.FileEntry(
                kind: "editor_annotations",
                relativePath: plan.annotationPacketURL.lastPathComponent,
                sourcePath: plan.annotationSourceURL.path
            ))
            outputFiles.append(plan.annotationPacketURL)
        }

        if fileManager.fileExists(atPath: plan.reviewReportSourceURL.path) {
            if fileManager.fileExists(atPath: plan.reviewReportPacketURL.path) {
                try fileManager.removeItem(at: plan.reviewReportPacketURL)
            }
            try fileManager.copyItem(at: plan.reviewReportSourceURL, to: plan.reviewReportPacketURL)
            files.append(ProjectEditorPacketManifest.FileEntry(
                kind: "review_report",
                relativePath: plan.reviewReportPacketURL.lastPathComponent,
                sourcePath: plan.reviewReportSourceURL.path
            ))
            outputFiles.append(plan.reviewReportPacketURL)
        }

        if fileManager.fileExists(atPath: plan.reviewPatchSourceURL.path) {
            if fileManager.fileExists(atPath: plan.reviewPatchPacketURL.path) {
                try fileManager.removeItem(at: plan.reviewPatchPacketURL)
            }
            try fileManager.copyItem(at: plan.reviewPatchSourceURL, to: plan.reviewPatchPacketURL)
            files.append(ProjectEditorPacketManifest.FileEntry(
                kind: "review_patch",
                relativePath: plan.reviewPatchPacketURL.lastPathComponent,
                sourcePath: plan.reviewPatchSourceURL.path
            ))
            outputFiles.append(plan.reviewPatchPacketURL)
        }

        for media in plan.mediaSources {
            let destination = plan.packetURL.appendingPathComponent(media.packetRelativePath)
            try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.copyItem(at: media.sourceURL, to: destination)
            files.append(ProjectEditorPacketManifest.FileEntry(
                kind: media.kind,
                relativePath: media.packetRelativePath,
                sourcePath: media.sourceURL.path
            ))
            outputFiles.append(destination)
        }

        for receipt in packetReceiptSources {
            let destination = plan.packetURL.appendingPathComponent(receipt.packetRelativePath)
            try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.copyItem(at: receipt.sourceURL, to: destination)
            files.append(ProjectEditorPacketManifest.FileEntry(
                kind: receipt.kind,
                relativePath: receipt.packetRelativePath,
                sourcePath: receipt.sourceURL.path
            ))
            outputFiles.append(destination)
        }

        files = try files.map { entry in
            let packetFile = plan.packetURL.appendingPathComponent(entry.relativePath)
            return ProjectEditorPacketManifest.FileEntry(
                kind: entry.kind,
                relativePath: entry.relativePath,
                sourcePath: entry.sourcePath,
                contentSHA256: try contentSHA256(at: packetFile)
            )
        }

        let manifest = ProjectEditorPacketManifest(
            version: "editor-packet-v1",
            projectID: plan.handoffPlan.projectID,
            generatedAt: ISO8601DateFormatter().string(from: generatedAt),
            premiereXML: plan.premiereXMLURL.lastPathComponent,
            annotationNotes: plan.handoffPlan.editorAnnotationNoteCount,
            mediaMissing: plan.handoffPlan.mediaMissingCount,
            sourceMapStatus: plan.handoffPlan.sourceMapReadinessLabel,
            sourceMapCoverage: plan.handoffPlan.sourceMapCoverageLabel,
            sourceMapMissingEntries: plan.handoffPlan.sourceMapMissingEntryCount,
            sourceMapBrokenEntries: plan.handoffPlan.sourceMapBrokenEntryCount,
            usesTemporarySourceMap: plan.handoffPlan.usesTemporarySourceMap,
            files: files
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(manifest).write(to: plan.manifestURL, options: .atomic)
        outputFiles.append(plan.manifestURL)

        return ProjectEditorPacketResult(
            plan: plan,
            packetURL: plan.packetURL,
            manifestURL: plan.manifestURL,
            files: outputFiles
        )
    }

    private static func makeEditorNotesMarkdown(
        plan: ProjectEditorPacketPlan,
        annotations: ProjectEditorAnnotationsDocument?,
        receiptSources: [ProjectEditorPacketMediaSource]
    ) -> String {
        var lines = [
            "# Editor Packet",
            "",
            "- Project: \(plan.handoffPlan.projectID)",
            "- Premiere XML: \(plan.premiereXMLURL.lastPathComponent)",
            "- Media relinks: \(plan.handoffPlan.mediaMissingCount)",
            "- Source map: \(plan.handoffPlan.sourceMapReadinessLabel) (\(plan.handoffPlan.sourceMapCoverageLabel))",
            "- Temporary source map: \(plan.handoffPlan.usesTemporarySourceMap ? "yes" : "no")",
            "- Preview/final media and caption assets: \(plan.mediaIncludedCount)",
            "- Handoff receipts: \(receiptSources.count)",
            "- Clip notes: \(annotations?.notes.count ?? 0)",
            ""
        ]

        if !plan.mediaSources.isEmpty {
            lines.append("## Included Assets")
            lines.append("")
            for media in plan.mediaSources {
                lines.append("- \(media.kind): \(media.packetRelativePath)")
            }
            lines.append("")
        }

        appendReviewSummaryMarkdown(plan: plan, to: &lines)

        if !receiptSources.isEmpty {
            lines.append("## Handoff Receipts")
            lines.append("")
            for receipt in receiptSources {
                lines.append("- \(receipt.kind): \(receipt.packetRelativePath)")
            }
            lines.append("")
        }

        guard let annotations, !annotations.notes.isEmpty else {
            lines.append("No clip notes were included.")
            lines.append("")
            return lines.joined(separator: "\n")
        }

        lines.append("## Clip Notes")
        lines.append("")
        for note in annotations.notes {
            lines.append("### \(note.timecodeIn)-\(note.timecodeOut)  \(note.clipID)")
            lines.append("")
            lines.append("- Track: \(note.trackID) / \(note.trackKind)")
            lines.append("- Asset: \(note.assetID)")
            lines.append("- Segment: \(note.segmentID)")
            lines.append("- Note: \(note.note)")
            lines.append("- Handoff: \(note.handoffInstruction)")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    private static func contentSHA256(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return "sha256:" + hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func appendReviewSummaryMarkdown(plan: ProjectEditorPacketPlan, to lines: inout [String]) {
        guard let raw = try? String(contentsOf: plan.reviewReportSourceURL, encoding: .utf8) else { return }
        lines.append("## Review Summary")
        lines.append("")
        if let status = firstMatch(in: raw, pattern: #"(?m)^\s*status:\s*"?([^"\n]+)"?\s*$"#) {
            lines.append("- Status: \(status)")
        }
        if let rationale = firstMatch(in: raw, pattern: #"(?m)^\s*rationale:\s*"([^"]+)""#) {
            lines.append("- Rationale: \(rationale)")
        }
        if let goal = firstMatch(in: raw, pattern: #"(?m)^\s*goal:\s*"([^"]+)""#) {
            lines.append("- Next pass: \(goal)")
        }

        let actions = listItems(after: "actions:", in: raw)
        if !actions.isEmpty {
            lines.append("")
            lines.append("Recommended actions:")
            for action in actions.prefix(6) {
                lines.append("- \(action)")
            }
        }
        lines.append("")
    }

    private static func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range), match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func listItems(after marker: String, in text: String) -> [String] {
        guard let markerRange = text.range(of: marker) else { return [] }
        let tail = text[markerRange.upperBound...]
        var items: [String] = []
        for line in tail.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("  - ") || line.hasPrefix("    - ") {
                items.append(line.replacingOccurrences(of: #"^\s*-\s*"?|"?\s*$"#, with: "", options: .regularExpression))
                continue
            }
            if !items.isEmpty, !line.trimmingCharacters(in: .whitespaces).isEmpty {
                break
            }
        }
        return items
    }

    private static func mediaSources(projectURL: URL) -> [ProjectEditorPacketMediaSource] {
        let fileManager = FileManager.default
        var sources: [ProjectEditorPacketMediaSource] = []
        var seen = Set<String>()

        func appendIfExists(kind: String, source: URL) {
            let standardized = source.standardizedFileURL
            guard fileManager.fileExists(atPath: standardized.path) else { return }
            guard isPacketMediaFile(standardized) else { return }
            guard seen.insert(standardized.path).inserted else { return }
            sources.append(ProjectEditorPacketMediaSource(
                kind: kind,
                sourceURL: standardized,
                packetRelativePath: "media/\(kind)-\(standardized.lastPathComponent)"
            ))
        }

        if let rawReview = try? String(contentsOf: projectURL.appendingPathComponent("06_review/review_report.yaml"), encoding: .utf8),
           let previewPath = firstMatch(in: rawReview, pattern: #"(?m)^\s*preview_path:\s*"?([^"\n]+)"?\s*$"#),
           previewPath.lowercased() != "null" {
            appendIfExists(kind: "preview_media", source: projectURL.appendingPathComponent(previewPath))
        }

        for relativePath in [
            "09_output/final.mp4",
            "07_package/video/final.mp4",
            "07_package/audio/final_mix.wav",
            "05_timeline/preview-first30s.mp4",
            "05_timeline/preview-full.mp4"
        ] {
            let url = projectURL.appendingPathComponent(relativePath)
            let kind: String
            if relativePath.contains("final_mix") {
                kind = "final_audio"
            } else if relativePath.contains("final") {
                kind = "final_media"
            } else {
                kind = "preview_media"
            }
            appendIfExists(kind: kind, source: url)
        }

        appendDirectoryMedia(projectURL.appendingPathComponent("09_output"), kind: "final_media", seen: &seen, sources: &sources)
        appendCaptionAssets(projectURL: projectURL, seen: &seen, sources: &sources)
        return sources
    }

    private static func receiptSources(
        projectURL: URL,
        projectID: String,
        premiereIdentitySource: URL? = nil
    ) -> [ProjectEditorPacketMediaSource] {
        let fileManager = FileManager.default
        var sources: [ProjectEditorPacketMediaSource] = []
        var seen = Set<String>()

        func appendIfExists(kind: String, source: URL) {
            let standardized = source.standardizedFileURL
            guard fileManager.fileExists(atPath: standardized.path) else { return }
            guard seen.insert(standardized.path).inserted else { return }
            sources.append(ProjectEditorPacketMediaSource(
                kind: kind,
                sourceURL: standardized,
                packetRelativePath: "receipts/\(kind)-\(standardized.lastPathComponent)"
            ))
        }

        appendIfExists(
            kind: "premiere_export_identity",
            source: premiereIdentitySource
                ?? projectURL.appendingPathComponent("09_output/\(projectID)_premiere.export-identity.json")
        )
        appendIfExists(
            kind: "render_route_receipt",
            source: projectURL.appendingPathComponent("07_package/logs/render-route.json")
        )
        appendIfExists(
            kind: "render_report",
            source: projectURL.appendingPathComponent("07_package/logs/render-report.json")
        )
        appendIfExists(
            kind: "package_manifest",
            source: projectURL.appendingPathComponent("07_package/package_manifest.json")
        )
        return sources
    }

    private static func appendCaptionAssets(
        projectURL: URL,
        seen: inout Set<String>,
        sources: inout [ProjectEditorPacketMediaSource]
    ) {
        let fileManager = FileManager.default
        let captionsDirectory = projectURL.appendingPathComponent("07_package/captions")
        if let urls = try? fileManager.contentsOfDirectory(
            at: captionsDirectory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) {
            for url in urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                guard ["srt", "vtt", "ass"].contains(url.pathExtension.lowercased()) else { continue }
                let standardized = url.standardizedFileURL
                guard seen.insert(standardized.path).inserted else { continue }
                sources.append(ProjectEditorPacketMediaSource(
                    kind: "caption_sidecar",
                    sourceURL: standardized,
                    packetRelativePath: "captions/\(standardized.lastPathComponent)"
                ))
            }
        }

        let approval = projectURL.appendingPathComponent("07_package/caption_approval.json").standardizedFileURL
        if fileManager.fileExists(atPath: approval.path), seen.insert(approval.path).inserted {
            sources.append(ProjectEditorPacketMediaSource(
                kind: "caption_approval",
                sourceURL: approval,
                packetRelativePath: "captions/caption_approval.json"
            ))
        }
    }

    private static func appendDirectoryMedia(
        _ directory: URL,
        kind: String,
        seen: inout Set<String>,
        sources: inout [ProjectEditorPacketMediaSource]
    ) {
        let fileManager = FileManager.default
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        for url in urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            guard isPacketMediaFile(url) else { continue }
            let standardized = url.standardizedFileURL
            guard seen.insert(standardized.path).inserted else { continue }
            sources.append(ProjectEditorPacketMediaSource(
                kind: kind,
                sourceURL: standardized,
                packetRelativePath: "media/\(kind)-\(standardized.lastPathComponent)"
            ))
        }
    }

    private static func isPacketMediaFile(_ url: URL) -> Bool {
        switch url.pathExtension.lowercased() {
        case "mp4", "mov", "m4v", "wav", "aif", "aiff", "mp3", "m4a":
            return true
        default:
            return false
        }
    }
}

public enum ProjectEditorPacketVerificationStatusReader {
    public static func status(projectURL: URL) -> ProjectEditorPacketVerificationStatus {
        let packetURL = projectURL
            .appendingPathComponent("09_output")
            .appendingPathComponent("editor_packet")
        let manifestURL = packetURL.appendingPathComponent("manifest.json")
        let fileManager = FileManager.default
        let packetExists = isDirectory(packetURL)
        let manifestExists = fileManager.fileExists(atPath: manifestURL.path)
        let manifest = decodeManifest(from: manifestURL)
        let files = manifest?.files ?? []
        let missingFiles = files
            .map(\.relativePath)
            .filter { relativePath in
                !fileManager.fileExists(atPath: packetURL.appendingPathComponent(relativePath).path)
            }
        let mediaEntries = files.filter { $0.kind.hasSuffix("_media") || $0.kind.hasSuffix("_audio") }
        let identityVerification = manifest.map {
            verifyIdentityChain(projectURL: projectURL, packetURL: packetURL, manifest: $0)
        } ?? (false, ["manifest unreadable"])

        return ProjectEditorPacketVerificationStatus(
            projectURL: projectURL,
            packetURL: packetURL,
            manifestURL: manifestURL,
            packetExists: packetExists,
            manifestExists: manifestExists,
            manifestReadable: manifestExists ? manifest != nil : false,
            manifestProjectID: manifest?.projectID,
            manifestFileCount: files.count,
            existingFileCount: files.count - missingFiles.count,
            missingFiles: missingFiles,
            mediaFileCount: mediaEntries.count,
            previewMediaIncluded: files.contains { $0.kind == "preview_media" },
            finalMediaIncluded: files.contains { $0.kind == "final_media" },
            finalAudioIncluded: files.contains { $0.kind == "final_audio" },
            captionSidecarIncluded: files.contains { $0.kind == "caption_sidecar" },
            captionApprovalIncluded: files.contains { $0.kind == "caption_approval" },
            identityChainValid: identityVerification.0,
            identityChainIssues: identityVerification.1
        )
    }

    private static func verifyIdentityChain(
        projectURL: URL,
        packetURL: URL,
        manifest: ProjectEditorPacketManifest
    ) -> (Bool, [String]) {
        var issues: [String] = []
        guard manifest.version == "editor-packet-v1" else {
            issues.append("manifest version invalid")
            return (false, issues)
        }
        let currentURL = projectURL
            .appendingPathComponent("09_output")
            .appendingPathComponent("premiere-exports")
            .appendingPathComponent("CURRENT.json")
        let xmlEntry = manifest.files.first(where: { $0.kind == "premiere_xml" && $0.relativePath == manifest.premiereXML })
        let identityEntry = manifest.files.first(where: { $0.kind == "premiere_export_identity" })
        func hasGenerationBinding(_ entry: ProjectEditorPacketManifest.FileEntry?) -> Bool {
            guard let entry,
                  entry.contentSHA256 != nil,
                  let sourcePath = entry.sourcePath else {
                return false
            }
            return sourcePath.replacingOccurrences(of: "\\", with: "/")
                .contains("/premiere-exports/generations/")
        }
        let xmlHasGenerationBinding = hasGenerationBinding(xmlEntry)
        let identityHasGenerationBinding = hasGenerationBinding(identityEntry)
        let hasNewFormatGenerationBindings = xmlHasGenerationBinding || identityHasGenerationBinding
        if hasNewFormatGenerationBindings && !(xmlHasGenerationBinding && identityHasGenerationBinding) {
            issues.append("new-format packet generation bindings are incomplete")
            return (false, issues)
        }
        if hasNewFormatGenerationBindings && !FileManager.default.fileExists(atPath: currentURL.path) {
            issues.append("new-format packet requires CURRENT.json")
            return (false, issues)
        }
        let publishedExportGraph: ValidatedPremiereExportGeneration?
        if FileManager.default.fileExists(atPath: currentURL.path) {
            do {
                publishedExportGraph = try PremiereExportGraphValidator.validate(
                    projectURL: projectURL,
                    projectID: manifest.projectID
                )
            } catch {
                issues.append(String(describing: error))
                return (false, issues)
            }
        } else {
            publishedExportGraph = nil
        }

        var seenPaths = Set<String>()
        let hasContentHashes = manifest.files.contains { $0.contentSHA256 != nil }
        if publishedExportGraph != nil && !hasContentHashes {
            issues.append("new export graph requires packet content hashes")
        }
        for entry in manifest.files {
            let components = entry.relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            let safe = !entry.relativePath.isEmpty
                && !entry.relativePath.hasPrefix("/")
                && !components.contains("..")
                && !components.contains("")
            guard safe else {
                issues.append("unsafe manifest path: \(entry.relativePath)")
                continue
            }
            guard seenPaths.insert(entry.relativePath).inserted else {
                issues.append("duplicate manifest path: \(entry.relativePath)")
                continue
            }
            let packetFile = packetURL.appendingPathComponent(entry.relativePath).standardizedFileURL
            guard packetFile.path.hasPrefix(packetURL.standardizedFileURL.path + "/") else {
                issues.append("manifest path escapes packet: \(entry.relativePath)")
                continue
            }
            guard FileManager.default.fileExists(atPath: packetFile.path) else {
                issues.append("missing manifest file: \(entry.relativePath)")
                continue
            }
            if hasContentHashes {
                guard let declared = entry.contentSHA256 else {
                    issues.append("content hash missing: \(entry.relativePath)")
                    continue
                }
                guard let actual = sha256File(packetFile) else {
                    issues.append("content hash unreadable: \(entry.relativePath)")
                    continue
                }
                if declared != actual {
                    issues.append("content hash mismatch: \(entry.relativePath)")
                }
            }
        }

        guard let xmlEntry else {
            issues.append("premiere XML is not bound by manifest")
            return (issues.isEmpty, issues)
        }
        let xmlURL = packetURL.appendingPathComponent(xmlEntry.relativePath).standardizedFileURL
        if let publishedExportGraph {
            if xmlEntry.sourcePath.map({ URL(fileURLWithPath: $0).standardizedFileURL.path }) != publishedExportGraph.xmlURL.standardizedFileURL.path {
                issues.append("packet XML source is not the validated export generation")
            }
            if xmlEntry.contentSHA256 != publishedExportGraph.xmlSHA256 {
                issues.append("packet XML content hash is not bound to the validated export generation")
            }
        }
        let marker: String?
        if let xml = try? String(contentsOf: xmlURL, encoding: .utf8) {
            marker = firstRegexCapture(pattern: #"<!-- Video OS v2 \| export_identity: (sha256:[0-9a-f]{64}) -->"#, in: xml)
        } else {
            marker = nil
        }
        guard let identityEntry else {
            if publishedExportGraph != nil {
                issues.append("new export graph packet is missing export identity sidecar")
            } else if marker != nil {
                issues.append("XML export identity marker has no sidecar")
            }
            return (issues.isEmpty, issues)
        }
        guard let identityPath = safePacketPath(packetURL, relativePath: identityEntry.relativePath) else {
            issues.append("export identity sidecar path is unsafe")
            return (false, issues)
        }
        guard FileManager.default.fileExists(atPath: identityPath.path) else {
            issues.append("export identity sidecar missing")
            return (false, issues)
        }
        guard let contentHash = identityEntry.contentSHA256,
              let actualContentHash = sha256File(identityPath),
              contentHash == actualContentHash else {
            issues.append("export identity sidecar content hash mismatch")
            return (false, issues)
        }
        if let publishedExportGraph {
            if identityEntry.sourcePath.map({ URL(fileURLWithPath: $0).standardizedFileURL.path }) != publishedExportGraph.identityURL.standardizedFileURL.path {
                issues.append("export identity source is not the validated export generation")
            }
            if contentHash != publishedExportGraph.identitySHA256 {
                issues.append("export identity content hash is not bound to the validated export generation")
            }
        }
        if let sourcePath = identityEntry.sourcePath {
            let sourceURL = URL(fileURLWithPath: sourcePath)
            guard FileManager.default.fileExists(atPath: sourceURL.path),
                  sha256File(sourceURL) == actualContentHash else {
                issues.append("export identity manifest source binding mismatch")
                return (false, issues)
            }
        }
        guard let data = try? Data(contentsOf: identityPath),
              let object = try? JSONSerialization.jsonObject(with: data),
              var identity = object as? [String: Any] else {
            issues.append("export identity sidecar is not JSON object")
            return (false, issues)
        }
        let required = ["version", "project_id", "export_kind", "timeline", "caption", "visual_treatment", "audio", "source_identity", "route_capability", "visual_effects", "human_approval", "export_identity_hash"]
        for key in required where identity[key] == nil {
            issues.append("export identity schema missing: \(key)")
        }
        issues.append(contentsOf: premiereIdentitySchemaIssues(identity))
        if !issues.isEmpty {
            return (false, issues)
        }
        guard let version = identity["version"] as? String, version == "premiere-export-identity/v1",
              let projectID = identity["project_id"] as? String, projectID == manifest.projectID,
              let exportKind = identity["export_kind"] as? String, exportKind == "fcp7_xml",
              let identityHash = identity["export_identity_hash"] as? String,
              isSHA256(identityHash) else {
            issues.append("export identity schema identity fields invalid")
            return (false, issues)
        }
        identity.removeValue(forKey: "export_identity_hash")
        if let normalized = try? JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]),
           sha256(data: normalized) != identityHash {
            issues.append("export identity self hash mismatch")
        }
        if marker != identityHash {
            issues.append("XML export identity marker mismatch")
        }
        return (issues.isEmpty, issues)
    }

    fileprivate static func premiereIdentitySchemaIssues(_ identity: [String: Any]) -> [String] {
        var issues: [String] = []
        func object(_ value: Any?, _ label: String, required: [String], allowed: Set<String>) -> [String: Any]? {
            guard let value = value as? [String: Any] else {
                issues.append("export identity schema \(label) must be object")
                return nil
            }
            for key in required where value[key] == nil {
                issues.append("export identity schema missing: \(label).\(key)")
            }
            for key in value.keys where !allowed.contains(key) {
                issues.append("export identity schema unexpected: \(label).\(key)")
            }
            return value
        }
        func string(_ value: Any?, _ label: String, nonempty: Bool = true) {
            guard let value = value as? String, !nonempty || !value.isEmpty else {
                issues.append("export identity schema \(label) must be string")
                return
            }
        }
        func hash(_ value: Any?, _ label: String) {
            guard let value = value as? String, isSHA256(value) else {
                issues.append("export identity schema \(label) must be sha256")
                return
            }
        }
        func artifact(_ value: Any?, _ label: String, nullable: Bool = true) {
            guard nullable && value is NSNull || value == nil else {
                guard let ref = object(value, label, required: ["path", "sha256"], allowed: ["path", "sha256"]) else { return }
                string(ref["path"], "\(label).path")
                hash(ref["sha256"], "\(label).sha256")
                return
            }
            if !nullable { issues.append("export identity schema \(label) must be artifact") }
        }
        func nullableHash(_ value: Any?, _ label: String) {
            if value is NSNull || value == nil { return }
            hash(value, label)
        }

        let topAllowed: Set<String> = ["version", "project_id", "export_kind", "timeline", "caption", "visual_treatment", "audio", "source_identity", "route_capability", "visual_effects", "human_approval", "export_identity_hash"]
        for key in identity.keys where !topAllowed.contains(key) {
            issues.append("export identity schema unexpected: \(key)")
        }

        if let timeline = object(identity["timeline"], "timeline", required: ["path", "sha256"], allowed: ["path", "sha256"]) {
            string(timeline["path"], "timeline.path")
            hash(timeline["sha256"], "timeline.sha256")
        }
        if let caption = object(identity["caption"], "caption", required: ["owner", "status", "approval", "approval_hash", "text_timing_hash"], allowed: ["owner", "status", "approval", "approval_hash", "text_timing_hash"]) {
            string(caption["owner"], "caption.owner")
            guard let status = caption["status"] as? String, ["approved", "not_applicable", "missing", "stale"].contains(status) else { issues.append("export identity schema caption.status invalid"); return issues }
            artifact(caption["approval"], "caption.approval")
            nullableHash(caption["approval_hash"], "caption.approval_hash")
            nullableHash(caption["text_timing_hash"], "caption.text_timing_hash")
            if status == "approved" && (!(caption["approval"] is [String: Any]) || !(caption["approval_hash"] is String) || !(caption["text_timing_hash"] is String)) {
                issues.append("export identity schema approved caption evidence missing")
            }
        }
        if let treatment = object(identity["visual_treatment"], "visual_treatment", required: ["owner", "status", "input_hash", "input", "typography_policy_hash", "visual_treatment_patch_hash", "capability_hash"], allowed: ["owner", "status", "input_hash", "input", "typography_policy_hash", "visual_treatment_patch_hash", "capability_hash"]) {
            if let owner = treatment["owner"] as? String {
                if !["ffmpeg-libass", "not_applicable"].contains(owner) { issues.append("export identity schema visual_treatment.owner invalid") }
            } else { issues.append("export identity schema visual_treatment.owner invalid") }
            guard let status = treatment["status"] as? String, ["resolved", "not_applicable", "blocked"].contains(status) else { issues.append("export identity schema visual_treatment.status invalid"); return issues }
            nullableHash(treatment["input_hash"], "visual_treatment.input_hash")
            artifact(treatment["input"], "visual_treatment.input")
            nullableHash(treatment["typography_policy_hash"], "visual_treatment.typography_policy_hash")
            nullableHash(treatment["visual_treatment_patch_hash"], "visual_treatment.visual_treatment_patch_hash")
            nullableHash(treatment["capability_hash"], "visual_treatment.capability_hash")
            if status == "resolved" && (!(treatment["input"] is [String: Any]) || !(treatment["input_hash"] is String)) {
                issues.append("export identity schema resolved visual treatment evidence missing")
            }
        }
        if let audio = object(identity["audio"], "audio", required: ["owner", "status", "plan", "plan_hash", "profile_id", "profile_hash"], allowed: ["owner", "status", "plan", "plan_hash", "profile_id", "profile_hash"]) {
            if let owner = audio["owner"] as? String {
                if !["shared_audio_render_plan", "legacy_dialogue_route", "not_applicable"].contains(owner) { issues.append("export identity schema audio.owner invalid") }
            } else { issues.append("export identity schema audio.owner invalid") }
            if let status = audio["status"] as? String {
                if !["resolved", "not_applicable", "missing"].contains(status) { issues.append("export identity schema audio.status invalid") }
            } else { issues.append("export identity schema audio.status invalid") }
            artifact(audio["plan"], "audio.plan")
            nullableHash(audio["plan_hash"], "audio.plan_hash")
            if let profileID = audio["profile_id"], !(profileID is NSNull) { string(profileID, "audio.profile_id") }
            nullableHash(audio["profile_hash"], "audio.profile_hash")
        }
        if let source = object(identity["source_identity"], "source_identity", required: ["status", "source_map", "source_inputs_hash", "assets"], allowed: ["status", "source_map", "source_inputs_hash", "assets"]) {
            if let status = source["status"] as? String {
                if !["verified", "declared_reference"].contains(status) { issues.append("export identity schema source_identity.status invalid") }
            } else { issues.append("export identity schema source_identity.status invalid") }
            artifact(source["source_map"], "source_identity.source_map")
            hash(source["source_inputs_hash"], "source_identity.source_inputs_hash")
            guard let assets = source["assets"] as? [[String: Any]] else { issues.append("export identity schema source_identity.assets must be array"); return issues }
            for (index, asset) in assets.enumerated() {
                let label = "source_identity.assets[\(index)]"
                for key in ["asset_id", "locator", "content_sha256"] where asset[key] == nil { issues.append("export identity schema missing: \(label).\(key)") }
                string(asset["asset_id"], "\(label).asset_id")
                string(asset["locator"], "\(label).locator")
                hash(asset["content_sha256"], "\(label).content_sha256")
            }
        }
        if let route = object(identity["route_capability"], "route_capability", required: ["id", "hash", "assembly_engine", "caption_renderer", "content_renderers"], allowed: ["id", "hash", "assembly_engine", "caption_renderer", "content_renderers"]) {
            string(route["id"], "route_capability.id")
            hash(route["hash"], "route_capability.hash")
            if let engine = route["assembly_engine"] as? String, !["ffmpeg", "remotion"].contains(engine) { issues.append("export identity schema route_capability.assembly_engine invalid") }
            if let renderer = route["caption_renderer"] as? String, !["ffmpeg-libass", "none"].contains(renderer) { issues.append("export identity schema route_capability.caption_renderer invalid") }
            guard let renderers = route["content_renderers"] as? [String] else { issues.append("export identity schema route_capability.content_renderers must be array"); return issues }
            _ = renderers
        }
        if let effects = object(identity["visual_effects"], "visual_effects", required: ["status", "unsupported", "baked_clip_ids"], allowed: ["status", "unsupported", "baked_clip_ids"]) {
            if let status = effects["status"] as? String, !["editable", "baked", "none", "blocked"].contains(status) { issues.append("export identity schema visual_effects.status invalid") }
            guard let unsupported = effects["unsupported"] as? [[String: Any]], let baked = effects["baked_clip_ids"] as? [String] else { issues.append("export identity schema visual_effects arrays invalid"); return issues }
            for (index, item) in unsupported.enumerated() {
                let label = "visual_effects.unsupported[\(index)]"
                for key in ["clip_id", "status", "reason"] where item[key] == nil { issues.append("export identity schema missing: \(label).\(key)") }
                string(item["clip_id"], "\(label).clip_id")
                string(item["status"], "\(label).status")
                string(item["reason"], "\(label).reason")
            }
            _ = baked
        }
        if let approval = object(identity["human_approval"], "human_approval", required: ["caption_status", "export_status"], allowed: ["caption_status", "export_status"]) {
            if let status = approval["caption_status"] as? String {
                if !["approved", "not_applicable", "missing", "stale"].contains(status) { issues.append("export identity schema human_approval.caption_status invalid") }
            } else { issues.append("export identity schema human_approval.caption_status invalid") }
            if approval["export_status"] as? String != "not_requested" { issues.append("export identity schema human_approval.export_status invalid") }
        }
        return issues
    }

    private static func safePacketPath(_ packetURL: URL, relativePath: String) -> URL? {
        let components = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !relativePath.isEmpty, !relativePath.hasPrefix("/"), !components.contains(".."), !components.contains("") else { return nil }
        let url = packetURL.appendingPathComponent(relativePath).standardizedFileURL
        return url.path.hasPrefix(packetURL.standardizedFileURL.path + "/") ? url : nil
    }

    private static func sha256File(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return sha256(data: data)
    }

    private static func sha256(data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil
    }

    private static func firstRegexCapture(pattern: String, in value: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range), match.numberOfRanges > 1,
              let capture = Range(match.range(at: 1), in: value) else { return nil }
        return String(value[capture])
    }

    private static func decodeManifest(from url: URL) -> ProjectEditorPacketManifest? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ProjectEditorPacketManifest.self, from: data)
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }
}

fileprivate struct ValidatedPremiereExportGeneration {
    let xmlURL: URL
    let identityURL: URL
    let xmlSHA256: String
    let identitySHA256: String
    let identityHash: String
}

fileprivate enum PremiereExportGraphValidator {
    private struct ArtifactRef: Equatable {
        let path: String
        let sha256: String
    }

    private struct IdentityRef: Equatable {
        let path: String
        let sha256: String
        let identityHash: String
    }

    static func validate(
        projectURL: URL,
        projectID: String
    ) throws -> ValidatedPremiereExportGeneration {
        let exportRootRelative = "09_output/premiere-exports"
        let exportRoot = projectURL.appendingPathComponent(exportRootRelative)
        let currentURL = exportRoot.appendingPathComponent("CURRENT.json")
        guard isDirectRegularSingleLinkFile(currentURL) else {
            throw invalid("CURRENT is missing or not a closed regular file")
        }
        let current = try readObject(currentURL, label: "CURRENT")
        try exactKeys(
            current,
            ["version", "project_id", "base_timeline_sha256", "roundtrip_id", "export_generation_id", "ready_path", "ready_sha256", "xml", "receipt", "bake_index", "export_identity", "published_at"],
            label: "CURRENT"
        )
        guard current["version"] as? String == "premiere-export-current/v1",
              current["project_id"] as? String == projectID,
              let baseTimelineHash = current["base_timeline_sha256"] as? String,
              isSHA256(baseTimelineHash),
              let roundtripID = current["roundtrip_id"] as? String,
              isSHA256(roundtripID),
              let generationID = current["export_generation_id"] as? String,
              isSHA256(generationID),
              let readyPath = current["ready_path"] as? String,
              let readySHA256 = current["ready_sha256"] as? String,
              isSHA256(readySHA256),
              let publishedAt = current["published_at"] as? String,
              ISO8601DateFormatter().date(from: publishedAt) != nil
        else {
            throw invalid("CURRENT identity fields are invalid")
        }

        let generationHex = String(generationID.dropFirst("sha256:".count))
        let generationRelative = "\(exportRootRelative)/generations/\(generationHex)"
        let generationURL = projectURL.appendingPathComponent(generationRelative)
        let readyRelative = "\(generationRelative)/READY.json"
        guard readyPath == readyRelative else {
            throw invalid("CURRENT READY path mismatch")
        }
        let readyURL = projectURL.appendingPathComponent(readyRelative)
        guard isDirectRegularSingleLinkFile(readyURL), sha256File(readyURL) == readySHA256 else {
            throw invalid("READY is missing or its CURRENT hash is stale")
        }

        let ready = try readObject(readyURL, label: "READY")
        try exactKeys(
            ready,
            ["version", "project_id", "base_timeline_sha256", "roundtrip_id", "export_generation_id", "xml", "receipt", "bake_index", "export_identity", "hardware_verified"],
            label: "READY"
        )
        guard ready["version"] as? String == "premiere-export-ready/v1",
              ready["project_id"] as? String == projectID,
              ready["base_timeline_sha256"] as? String == baseTimelineHash,
              ready["roundtrip_id"] as? String == roundtripID,
              ready["export_generation_id"] as? String == generationID,
              ready["hardware_verified"] as? Bool == false
        else {
            throw invalid("READY identity fields are invalid")
        }

        let xmlRelative = "\(generationRelative)/\(projectID)_premiere.xml"
        let receiptRelative = "\(generationRelative)/\(projectID)_premiere.roundtrip.json"
        let bakeIndexRelative = "\(generationRelative)/bake-index.json"
        let identityRelative = "\(generationRelative)/\(projectID)_premiere.export-identity.json"
        let currentXML = try artifact(current["xml"], label: "CURRENT.xml", expectedPath: xmlRelative)
        let currentReceipt = try artifact(current["receipt"], label: "CURRENT.receipt", expectedPath: receiptRelative)
        let currentIndex = try artifact(current["bake_index"], label: "CURRENT.bake_index", expectedPath: bakeIndexRelative)
        let readyXML = try artifact(ready["xml"], label: "READY.xml", expectedPath: xmlRelative)
        let readyReceipt = try artifact(ready["receipt"], label: "READY.receipt", expectedPath: receiptRelative)
        let readyIndex = try artifact(ready["bake_index"], label: "READY.bake_index", expectedPath: bakeIndexRelative)
        guard currentXML == readyXML, currentReceipt == readyReceipt, currentIndex == readyIndex else {
            throw invalid("CURRENT and READY artifact refs disagree")
        }
        let currentIdentity = try identityArtifact(current["export_identity"], expectedPath: identityRelative)
        let readyIdentity = try identityArtifact(ready["export_identity"], expectedPath: identityRelative)
        guard currentIdentity == readyIdentity else {
            throw invalid("CURRENT and READY identity refs disagree")
        }

        let expectedFiles: Set<String> = [
            "READY.json",
            "bake-index.json",
            "\(projectID)_premiere.roundtrip.json",
            "\(projectID)_premiere.xml",
            "\(projectID)_premiere.export-identity.json"
        ]
        guard isDirectDirectory(generationURL),
              let generationFiles = try? FileManager.default.contentsOfDirectory(atPath: generationURL.path),
              Set(generationFiles) == expectedFiles
        else {
            throw invalid("selected generation contents are not exact")
        }

        let xmlURL = projectURL.appendingPathComponent(xmlRelative)
        let receiptURL = projectURL.appendingPathComponent(receiptRelative)
        let bakeIndexURL = projectURL.appendingPathComponent(bakeIndexRelative)
        let identityURL = projectURL.appendingPathComponent(identityRelative)
        for (label, url, expectedHash) in [
            ("generation XML", xmlURL, readyXML.sha256),
            ("generation receipt", receiptURL, readyReceipt.sha256),
            ("generation bake index", bakeIndexURL, readyIndex.sha256),
            ("generation identity", identityURL, readyIdentity.sha256)
        ] {
            guard isDirectRegularSingleLinkFile(url), sha256File(url) == expectedHash else {
                throw invalid("\(label) hash or file type mismatch")
            }
        }

        let identity = try readObject(identityURL, label: "export identity")
        let schemaIssues = ProjectEditorPacketVerificationStatusReader.premiereIdentitySchemaIssues(identity)
        guard schemaIssues.isEmpty else {
            throw invalid("export identity schema invalid: \(schemaIssues.joined(separator: "; "))")
        }
        guard identity["version"] as? String == "premiere-export-identity/v1",
              identity["project_id"] as? String == projectID,
              let identityHash = identity["export_identity_hash"] as? String,
              isSHA256(identityHash),
              identityHash == readyIdentity.identityHash
        else {
            throw invalid("export identity project/hash mismatch")
        }
        var identityWithoutHash = identity
        identityWithoutHash.removeValue(forKey: "export_identity_hash")
        guard let normalizedIdentity = try? JSONSerialization.data(withJSONObject: identityWithoutHash, options: [.sortedKeys]),
              sha256(normalizedIdentity) == identityHash
        else {
            throw invalid("export identity self hash mismatch")
        }
        guard let xmlData = try? Data(contentsOf: xmlURL),
              let xml = String(data: xmlData, encoding: .utf8),
              firstRegexCapture(pattern: #"<!-- Video OS v2 \| export_identity: (sha256:[0-9a-f]{64}) -->"#, in: xml) == identityHash
        else {
            throw invalid("generation XML identity marker mismatch")
        }

        return ValidatedPremiereExportGeneration(
            xmlURL: xmlURL,
            identityURL: identityURL,
            xmlSHA256: readyXML.sha256,
            identitySHA256: readyIdentity.sha256,
            identityHash: identityHash
        )
    }

    private static func invalid(_ message: String) -> ProjectHandoffExportError {
        .notReady("Premiere export graph invalid: \(message)")
    }

    private static func readObject(_ url: URL, label: String) throws -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data),
              let value = object as? [String: Any]
        else {
            throw invalid("\(label) is not a JSON object")
        }
        return value
    }

    private static func exactKeys(_ object: [String: Any], _ keys: [String], label: String) throws {
        guard Set(object.keys) == Set(keys) else {
            throw invalid("\(label) has unexpected or missing fields")
        }
    }

    private static func artifact(_ value: Any?, label: String, expectedPath: String) throws -> ArtifactRef {
        guard let object = value as? [String: Any],
              Set(object.keys) == Set(["path", "sha256"]),
              let path = object["path"] as? String,
              path == expectedPath,
              let sha256 = object["sha256"] as? String,
              isSHA256(sha256)
        else {
            throw invalid("\(label) ref is invalid")
        }
        return ArtifactRef(path: path, sha256: sha256)
    }

    private static func identityArtifact(_ value: Any?, expectedPath: String) throws -> IdentityRef {
        guard let object = value as? [String: Any],
              Set(object.keys) == Set(["path", "sha256", "identity_hash"]),
              let path = object["path"] as? String,
              path == expectedPath,
              let sha256 = object["sha256"] as? String,
              isSHA256(sha256),
              let identityHash = object["identity_hash"] as? String,
              isSHA256(identityHash)
        else {
            throw invalid("export identity ref is invalid")
        }
        return IdentityRef(path: path, sha256: sha256, identityHash: identityHash)
    }

    private static func isDirectDirectory(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
              values.isDirectory == true,
              values.isSymbolicLink != true,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        else { return false }
        return attributes[.type] as? FileAttributeType == .typeDirectory
    }

    private static func isDirectRegularSingleLinkFile(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        else { return false }
        return attributes[.type] as? FileAttributeType == .typeRegular
            && (attributes[.referenceCount] as? NSNumber)?.intValue == 1
    }

    private static func sha256File(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return sha256(data)
    }

    private static func sha256(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil
    }

    private static func firstRegexCapture(pattern: String, in value: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range),
              match.numberOfRanges > 1,
              let capture = Range(match.range(at: 1), in: value)
        else { return nil }
        return String(value[capture])
    }
}

private struct MediaSourceMapSummary {
    let exists: Bool
    let entryCount: Int

    static func load(projectURL: URL) -> MediaSourceMapSummary {
        let url = projectURL.appendingPathComponent("02_media/source_map.json")
        guard let data = try? Data(contentsOf: url) else {
            return MediaSourceMapSummary(exists: false, entryCount: 0)
        }
        let decoded = try? JSONDecoder().decode(MediaSourceMapEntryList.self, from: data)
        return MediaSourceMapSummary(exists: true, entryCount: decoded?.items.count ?? 0)
    }
}

private struct MediaSourceMapEntryList: Decodable {
    let items: [MediaSourceMapEntry]
}

private struct MediaSourceMapEntry: Decodable {
    let assetID: String

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
    }
}
