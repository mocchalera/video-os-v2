import Foundation

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

    public var missingFileCount: Int {
        missingFiles.count
    }

    public var readinessLabel: String {
        guard packetExists else { return "packet missing" }
        guard manifestExists else { return "manifest missing" }
        guard manifestReadable else { return "manifest unreadable" }
        guard missingFiles.isEmpty else { return "packet incomplete" }
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

        enum CodingKeys: String, CodingKey {
            case kind
            case relativePath = "relative_path"
            case sourcePath = "source_path"
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
            mediaSources: mediaSources(projectURL: projectURL)
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
        guard FileManager.default.fileExists(atPath: plan.handoffPlan.outputURL.path) else {
            throw ProjectHandoffExportError.packetMissingPremiereXML(plan.handoffPlan.outputURL)
        }

        let fileManager = FileManager.default
        try fileManager.createDirectory(at: plan.packetURL, withIntermediateDirectories: true)
        let mediaPacketDirectory = plan.packetURL.appendingPathComponent("media")
        if fileManager.fileExists(atPath: mediaPacketDirectory.path) {
            try fileManager.removeItem(at: mediaPacketDirectory)
        }
        if fileManager.fileExists(atPath: plan.premiereXMLURL.path) {
            try fileManager.removeItem(at: plan.premiereXMLURL)
        }
        try fileManager.copyItem(at: plan.handoffPlan.outputURL, to: plan.premiereXMLURL)

        var files = [
            ProjectEditorPacketManifest.FileEntry(
                kind: "premiere_xml",
                relativePath: plan.premiereXMLURL.lastPathComponent,
                sourcePath: plan.handoffPlan.outputURL.path
            )
        ]
        var outputFiles = [plan.premiereXMLURL]

        let annotations = ProjectEditorAnnotationStore.load(projectURL: projectURL)
        let editorNotes = makeEditorNotesMarkdown(plan: plan, annotations: annotations)
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
        annotations: ProjectEditorAnnotationsDocument?
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
            captionApprovalIncluded: files.contains { $0.kind == "caption_approval" }
        )
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
