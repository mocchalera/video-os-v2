import Foundation

public struct ProjectEditorAnnotationsDocument: Codable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public var updatedAt: String
    public var notes: [ProjectEditorClipNote]

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case updatedAt = "updated_at"
        case notes
    }

    public init(
        version: String = "editor-annotations-v1",
        projectID: String,
        updatedAt: String,
        notes: [ProjectEditorClipNote] = []
    ) {
        self.version = version
        self.projectID = projectID
        self.updatedAt = updatedAt
        self.notes = notes
    }

    public func note(for clipID: TimelineClip.ID) -> ProjectEditorClipNote? {
        notes.first { $0.clipID == clipID }
    }
}

public struct ProjectEditorClipNote: Codable, Identifiable, Equatable, Sendable {
    public var id: String { clipID }
    public let clipID: String
    public let trackID: String
    public let trackKind: String
    public let assetID: String
    public let segmentID: String
    public let timelineInFrame: Int
    public let timelineOutFrame: Int
    public let timecodeIn: String
    public let timecodeOut: String
    public var note: String
    public var handoffInstruction: String
    public var author: String
    public var updatedAt: String

    enum CodingKeys: String, CodingKey {
        case clipID = "clip_id"
        case trackID = "track_id"
        case trackKind = "track_kind"
        case assetID = "asset_id"
        case segmentID = "segment_id"
        case timelineInFrame = "timeline_in_frame"
        case timelineOutFrame = "timeline_out_frame"
        case timecodeIn = "timecode_in"
        case timecodeOut = "timecode_out"
        case note
        case handoffInstruction = "handoff_instruction"
        case author
        case updatedAt = "updated_at"
    }
}

public struct ProjectEditorAnnotationSummary: Equatable, Sendable {
    public let url: URL
    public let exists: Bool
    public let noteCount: Int
    public let unresolvedClipIDs: [String]

    public var statusLabel: String {
        if !exists {
            return "no editor annotations"
        }
        if unresolvedClipIDs.isEmpty {
            return "\(noteCount) clip notes"
        }
        return "\(noteCount) clip notes, \(unresolvedClipIDs.count) unresolved"
    }
}

public enum ProjectEditorAnnotationError: Error, Equatable, CustomStringConvertible {
    case timelineMissing
    case clipNotFound(String)
    case emptyNote

    public var description: String {
        switch self {
        case .timelineMissing:
            return "timeline.json is required before adding editor annotations"
        case .clipNotFound(let clipID):
            return "clip not found in timeline: \(clipID)"
        case .emptyNote:
            return "clip note cannot be empty"
        }
    }
}

public enum ProjectEditorAnnotationStore {
    public static func annotationsURL(for projectURL: URL) -> URL {
        projectURL.appendingPathComponent("07_handoff/editor_annotations.json")
    }

    public static func load(projectURL: URL) -> ProjectEditorAnnotationsDocument? {
        let url = annotationsURL(for: projectURL)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ProjectEditorAnnotationsDocument.self, from: data)
    }

    public static func summary(projectURL: URL, timeline: TimelineDocument? = nil) -> ProjectEditorAnnotationSummary {
        let url = annotationsURL(for: projectURL)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return ProjectEditorAnnotationSummary(url: url, exists: false, noteCount: 0, unresolvedClipIDs: [])
        }
        let document = load(projectURL: projectURL)
        let knownClipIDs = Set(timeline?.displayTracks.flatMap { $0.clips.map(\.id) } ?? [])
        let unresolved = document?.notes
            .map(\.clipID)
            .filter { !knownClipIDs.isEmpty && !knownClipIDs.contains($0) } ?? []
        return ProjectEditorAnnotationSummary(
            url: url,
            exists: true,
            noteCount: document?.notes.count ?? 0,
            unresolvedClipIDs: unresolved.sorted()
        )
    }

    @discardableResult
    public static func upsertNote(
        projectURL: URL,
        clipID: TimelineClip.ID,
        note: String,
        handoffInstruction: String? = nil,
        author: String = "operator",
        updatedAt: Date = Date()
    ) throws -> ProjectEditorAnnotationsDocument {
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedNote.isEmpty else { throw ProjectEditorAnnotationError.emptyNote }

        let timeline = try TimelineDocument.load(projectURL: projectURL)
        guard let selection = timeline.clipSelection(for: clipID) else {
            throw ProjectEditorAnnotationError.clipNotFound(clipID)
        }
        var document = load(projectURL: projectURL) ?? ProjectEditorAnnotationsDocument(
            projectID: timeline.projectID,
            updatedAt: isoString(updatedAt)
        )
        let timestamp = isoString(updatedAt)
        let trimmedInstruction = (handoffInstruction ?? trimmedNote).trimmingCharacters(in: .whitespacesAndNewlines)
        let clip = selection.clip
        let nextNote = ProjectEditorClipNote(
            clipID: clip.id,
            trackID: selection.trackID,
            trackKind: selection.trackKind.rawValue,
            assetID: clip.assetID,
            segmentID: clip.segmentID,
            timelineInFrame: clip.timelineInFrame,
            timelineOutFrame: clip.timelineOutFrame,
            timecodeIn: timeline.sequence.framesToTimecode(clip.timelineInFrame),
            timecodeOut: timeline.sequence.framesToTimecode(clip.timelineOutFrame),
            note: trimmedNote,
            handoffInstruction: trimmedInstruction.isEmpty ? trimmedNote : trimmedInstruction,
            author: author,
            updatedAt: timestamp
        )
        if let index = document.notes.firstIndex(where: { $0.clipID == clipID }) {
            document.notes[index] = nextNote
        } else {
            document.notes.append(nextNote)
            document.notes.sort { $0.timelineInFrame < $1.timelineInFrame }
        }
        document.updatedAt = timestamp
        try save(document, projectURL: projectURL)
        return document
    }

    @discardableResult
    public static func removeNote(projectURL: URL, clipID: TimelineClip.ID, updatedAt: Date = Date()) throws -> ProjectEditorAnnotationsDocument {
        let timeline = try? TimelineDocument.load(projectURL: projectURL)
        var document = load(projectURL: projectURL) ?? ProjectEditorAnnotationsDocument(
            projectID: timeline?.projectID ?? projectURL.lastPathComponent,
            updatedAt: isoString(updatedAt)
        )
        document.notes.removeAll { $0.clipID == clipID }
        document.updatedAt = isoString(updatedAt)
        try save(document, projectURL: projectURL)
        return document
    }

    private static func save(_ document: ProjectEditorAnnotationsDocument, projectURL: URL) throws {
        let url = annotationsURL(for: projectURL)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(document).write(to: url, options: .atomic)
    }

    private static func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
