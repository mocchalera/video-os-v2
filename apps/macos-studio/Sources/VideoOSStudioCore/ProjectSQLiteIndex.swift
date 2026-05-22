import Foundation
import SQLite3

public enum ProjectSQLiteIndex {
    public static let relativePath = "03_analysis/search/project_index.sqlite"

    public static func indexURL(for projectURL: URL) -> URL {
        projectURL.appendingPathComponent(relativePath)
    }

    @discardableResult
    public static func rebuild(projectURL: URL) throws -> ProjectIndexSummary {
        let indexURL = indexURL(for: projectURL)
        try FileManager.default.createDirectory(
            at: indexURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let evidence = ProjectEvidenceStore.load(projectURL: projectURL)
        let database = try SQLiteDatabase.open(url: indexURL)
        defer { database.close() }

        try database.exec("PRAGMA journal_mode = WAL")
        try database.exec("PRAGMA synchronous = NORMAL")
        try database.exec("BEGIN IMMEDIATE")
        do {
            try migrate(database)
            try database.exec("DELETE FROM metadata")
            try database.exec("DELETE FROM assets")
            try database.exec("DELETE FROM segments")
            try database.exec("DELETE FROM transcript_items")
            try database.exec("DELETE FROM marlin_events")
            try database.exec("DELETE FROM marlin_find_results")
            try database.exec("DELETE FROM audio_events")
            try database.exec("DELETE FROM audio_story_nodes")
            try database.exec("DELETE FROM bgm_sections")
            try database.exec("DELETE FROM bgm_beats")
            try database.exec("DELETE FROM continuity_entities")
            try database.exec("DELETE FROM continuity_segment_refs")
            try database.exec("DELETE FROM editorial_preferences")
            try database.exec("DELETE FROM search_documents")

            let counts = try insertEvidence(evidence, projectURL: projectURL, database: database)
            try insertMetadata(counts, projectURL: projectURL, database: database)
            try database.exec("COMMIT")
            return counts
        } catch {
            try? database.exec("ROLLBACK")
            throw error
        }
    }

    public static func status(projectURL: URL) -> ProjectIndexStatus {
        let url = indexURL(for: projectURL)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return ProjectIndexStatus(indexURL: url, exists: false, documentCount: 0, updatedAt: nil)
        }

        do {
            let database = try SQLiteDatabase.open(url: url)
            defer { database.close() }
            let documentCount = try database.scalarInt("SELECT COUNT(*) FROM search_documents") ?? 0
            let updatedAt = try database.scalarString("SELECT value FROM metadata WHERE key = 'updated_at'")
            return ProjectIndexStatus(indexURL: url, exists: true, documentCount: documentCount, updatedAt: updatedAt)
        } catch {
            return ProjectIndexStatus(indexURL: url, exists: true, documentCount: 0, updatedAt: nil)
        }
    }

    public static func search(projectURL: URL, query: String, limit: Int = 20) throws -> [ProjectSearchResult] {
        let database = try SQLiteDatabase.open(url: indexURL(for: projectURL))
        defer { database.close() }

        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return [] }
        let pattern = "%\(normalized.lowercased())%"
        let cappedLimit = max(1, min(limit, 100))

        let sql = """
        SELECT doc_id, kind, asset_id, segment_id, start_us, end_us, title, text, tags
        FROM search_documents
        WHERE lower(title) LIKE ? OR lower(text) LIKE ? OR lower(tags) LIKE ?
        ORDER BY
          CASE
            WHEN lower(title) LIKE ? THEN 0
            WHEN lower(tags) LIKE ? THEN 1
            ELSE 2
          END,
          kind,
          doc_id
        LIMIT ?
        """

        return try database.query(sql, bindings: [.text(pattern), .text(pattern), .text(pattern), .text(pattern), .text(pattern), .int(cappedLimit)]) { statement in
            ProjectSearchResult(
                documentID: statement.columnText(0),
                kind: statement.columnText(1),
                assetID: statement.columnText(2),
                segmentID: statement.columnText(3),
                startUS: statement.columnIntOptional(4),
                endUS: statement.columnIntOptional(5),
                title: statement.columnText(6),
                text: statement.columnText(7),
                tags: statement.columnText(8)
            )
        }
    }

    private static func migrate(_ database: SQLiteDatabase) throws {
        try database.exec("""
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assets (
          asset_id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          role_guess TEXT,
          duration_us INTEGER,
          tags TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS segments (
          segment_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          src_in_us INTEGER NOT NULL,
          src_out_us INTEGER NOT NULL,
          summary TEXT NOT NULL,
          transcript_excerpt TEXT NOT NULL,
          tags TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transcript_items (
          item_id TEXT PRIMARY KEY,
          transcript_ref TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          speaker TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          text TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS marlin_events (
          event_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          description TEXT NOT NULL,
          source_pass TEXT,
          confidence REAL
        );
        CREATE TABLE IF NOT EXISTS marlin_find_results (
          result_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          query TEXT NOT NULL,
          span_start_us INTEGER,
          span_end_us INTEGER,
          confidence REAL,
          raw TEXT
        );
        CREATE TABLE IF NOT EXISTS audio_events (
          event_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          type TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          label TEXT,
          confidence REAL
        );
        CREATE TABLE IF NOT EXISTS audio_story_nodes (
          node_id TEXT PRIMARY KEY,
          node_type TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          text TEXT,
          story_role TEXT,
          transcript_ref TEXT,
          speaker_ref TEXT,
          audio_event_ref TEXT,
          bgm_ref TEXT,
          confidence REAL
        );
        CREATE TABLE IF NOT EXISTS bgm_sections (
          section_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          label TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          end_us INTEGER NOT NULL,
          energy REAL
        );
        CREATE TABLE IF NOT EXISTS bgm_beats (
          beat_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          time_us INTEGER NOT NULL,
          strength REAL,
          downbeat INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS continuity_entities (
          entity_id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          status TEXT NOT NULL,
          label TEXT,
          evidence_segment_ids TEXT NOT NULL,
          confidence REAL
        );
        CREATE TABLE IF NOT EXISTS continuity_segment_refs (
          segment_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          src_in_us INTEGER NOT NULL,
          src_out_us INTEGER NOT NULL,
          entity_ids TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS editorial_preferences (
          entry_id TEXT PRIMARY KEY,
          preference_type TEXT NOT NULL,
          scope TEXT NOT NULL,
          status TEXT NOT NULL,
          value TEXT NOT NULL,
          source_event TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS search_documents (
          doc_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          asset_id TEXT,
          segment_id TEXT,
          start_us INTEGER,
          end_us INTEGER,
          title TEXT NOT NULL,
          text TEXT NOT NULL,
          tags TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_documents_kind ON search_documents(kind);
        CREATE INDEX IF NOT EXISTS idx_search_documents_asset ON search_documents(asset_id);
        CREATE INDEX IF NOT EXISTS idx_search_documents_segment ON search_documents(segment_id);
        """)
    }

    private static func insertEvidence(_ evidence: ProjectEvidenceStore, projectURL: URL, database: SQLiteDatabase) throws -> ProjectIndexSummary {
        var summary = ProjectIndexSummary(
            indexURL: database.url,
            assetCount: 0,
            segmentCount: 0,
            transcriptItemCount: 0,
            marlinEventCount: 0,
            marlinFindResultCount: 0,
            audioEventCount: 0,
            audioStoryNodeCount: 0,
            bgmSectionCount: 0,
            bgmBeatCount: 0,
            continuityEntityCount: 0,
            continuitySegmentRefCount: 0,
            editorialPreferenceCount: 0,
            searchDocumentCount: 0
        )

        for asset in evidence.assets?.items ?? [] {
            try database.run(
                "INSERT INTO assets(asset_id, filename, role_guess, duration_us, tags) VALUES (?, ?, ?, ?, ?)",
                [.text(asset.id), .text(asset.filename), .optionalText(asset.roleGuess), .optionalInt(asset.durationUS), .text(asset.tags.joined(separator: ","))]
            )
            try insertSearchDocument(
                database,
                id: "asset:\(asset.id)",
                kind: "asset",
                assetID: asset.id,
                segmentID: nil,
                startUS: nil,
                endUS: asset.durationUS,
                title: asset.filename,
                text: [asset.roleGuess, asset.tags.joined(separator: " "), asset.qualityFlags.joined(separator: " ")]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n"),
                tags: asset.tags.joined(separator: ",")
            )
            summary.assetCount += 1
            summary.searchDocumentCount += 1
        }

        for segment in evidence.segments?.items ?? [] {
            try database.run(
                "INSERT INTO segments(segment_id, asset_id, src_in_us, src_out_us, summary, transcript_excerpt, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [.text(segment.id), .text(segment.assetID), .int(segment.sourceInUS), .int(segment.sourceOutUS), .text(segment.summary), .text(segment.transcriptExcerpt), .text(segment.tags.joined(separator: ","))]
            )
            let interestText = segment.interestPoints.map(\.label).joined(separator: " ")
            try insertSearchDocument(
                database,
                id: "segment:\(segment.id)",
                kind: "segment",
                assetID: segment.assetID,
                segmentID: segment.id,
                startUS: segment.sourceInUS,
                endUS: segment.sourceOutUS,
                title: segment.summary.isEmpty ? segment.id : segment.summary,
                text: [segment.transcriptExcerpt, interestText, segment.qualityFlags.joined(separator: " ")]
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n"),
                tags: segment.tags.joined(separator: ",")
            )
            summary.segmentCount += 1
            summary.searchDocumentCount += 1
        }

        for transcript in evidence.transcripts.values {
            for item in transcript.items {
                try database.run(
                    "INSERT INTO transcript_items(item_id, transcript_ref, asset_id, speaker, start_us, end_us, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [.text(item.id), .text(transcript.transcriptRef), .text(transcript.assetID), .text(item.speaker), .int(item.startUS), .int(item.endUS), .text(item.text)]
                )
                try insertSearchDocument(
                    database,
                    id: "transcript:\(transcript.transcriptRef):\(item.id)",
                    kind: "transcript",
                    assetID: transcript.assetID,
                    segmentID: nil,
                    startUS: item.startUS,
                    endUS: item.endUS,
                    title: "\(item.speaker) transcript",
                    text: item.text,
                    tags: "speech,\(item.speaker)"
                )
                summary.transcriptItemCount += 1
                summary.searchDocumentCount += 1
            }
        }

        for assetEvents in evidence.marlinEvents?.items ?? [] {
            for event in assetEvents.events {
                try database.run(
                    "INSERT INTO marlin_events(event_id, asset_id, start_us, end_us, description, source_pass, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [.text(event.id), .text(assetEvents.assetID), .int(event.startUS), .int(event.endUS), .text(event.description), .optionalText(event.sourcePass), .optionalDouble(event.confidence)]
                )
                try insertSearchDocument(
                    database,
                    id: "marlin-event:\(event.id)",
                    kind: "marlin_event",
                    assetID: assetEvents.assetID,
                    segmentID: nil,
                    startUS: event.startUS,
                    endUS: event.endUS,
                    title: event.description,
                    text: [assetEvents.scene, assetEvents.caption, event.sourcePass].compactMap { $0 }.joined(separator: "\n"),
                    tags: "marlin,\(event.sourcePass ?? "event")"
                )
                summary.marlinEventCount += 1
                summary.searchDocumentCount += 1
            }

            for result in assetEvents.findResults {
                try database.run(
                    "INSERT INTO marlin_find_results(result_id, asset_id, query, span_start_us, span_end_us, confidence, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [.text(result.id), .text(assetEvents.assetID), .text(result.query), .optionalInt(result.spanStartUS), .optionalInt(result.spanEndUS), .optionalDouble(result.confidence), .optionalText(result.raw)]
                )
                try insertSearchDocument(
                    database,
                    id: "marlin-find:\(assetEvents.assetID):\(result.id)",
                    kind: "marlin_find",
                    assetID: assetEvents.assetID,
                    segmentID: nil,
                    startUS: result.spanStartUS,
                    endUS: result.spanEndUS,
                    title: result.query,
                    text: [assetEvents.scene, result.raw].compactMap { $0 }.joined(separator: "\n"),
                    tags: "marlin,find"
                )
                summary.marlinFindResultCount += 1
                summary.searchDocumentCount += 1
            }
        }

        for event in evidence.audioEvents?.items ?? [] {
            try database.run(
                "INSERT INTO audio_events(event_id, asset_id, type, start_us, end_us, label, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [.text(event.id), .text(event.assetID), .text(event.type), .int(event.startUS), .int(event.endUS), .optionalText(event.label), .optionalDouble(event.confidence?.score)]
            )
            let title = event.label?.isEmpty == false ? event.label ?? event.type : event.type
            let text = [
                event.type,
                event.confidence?.source,
                event.confidence?.status,
                event.confidence?.label
            ]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: "\n")
            try insertSearchDocument(
                database,
                id: "audio-event:\(event.id)",
                kind: "audio_event",
                assetID: event.assetID,
                segmentID: nil,
                startUS: event.startUS,
                endUS: event.endUS,
                title: title,
                text: text,
                tags: "audio,\(event.type)"
            )
            summary.audioEventCount += 1
            summary.searchDocumentCount += 1
        }

        for node in evidence.audioStoryGraph?.nodes ?? [] {
            try database.run(
                """
                INSERT INTO audio_story_nodes(
                  node_id, node_type, asset_id, start_us, end_us, text, story_role,
                  transcript_ref, speaker_ref, audio_event_ref, bgm_ref, confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    .text(node.id),
                    .text(node.type),
                    .text(node.assetID),
                    .int(node.startUS),
                    .int(node.endUS),
                    .optionalText(node.text),
                    .optionalText(node.storyRole),
                    .optionalText(node.refs.transcriptRef),
                    .optionalText(node.refs.speakerRef),
                    .optionalText(node.refs.audioEventRef),
                    .optionalText(node.refs.bgmRef),
                    .optionalDouble(node.confidence.score)
                ]
            )
            let title = node.text?.isEmpty == false ? node.text ?? node.id : node.id
            let text = [
                node.type,
                node.storyRole,
                node.refs.transcriptRef,
                node.refs.speakerRef,
                node.refs.audioEventRef,
                node.refs.bgmRef,
                node.confidence.source,
                node.confidence.status
            ]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: "\n")
            try insertSearchDocument(
                database,
                id: "audio-story-node:\(node.id)",
                kind: "audio_story_node",
                assetID: node.assetID,
                segmentID: nil,
                startUS: node.startUS,
                endUS: node.endUS,
                title: title,
                text: text,
                tags: ["audio_story", node.type, node.storyRole, node.refs.speakerRef].compactMap { $0 }.joined(separator: ",")
            )
            summary.audioStoryNodeCount += 1
            summary.searchDocumentCount += 1
        }

        if let bgm = evidence.bgmAnalysis {
            let assetID = bgm.musicAsset.assetID
            for section in bgm.sections {
                let startUS = microseconds(fromSeconds: section.startSec)
                let endUS = microseconds(fromSeconds: section.endSec)
                try database.run(
                    "INSERT INTO bgm_sections(section_id, asset_id, label, start_us, end_us, energy) VALUES (?, ?, ?, ?, ?, ?)",
                    [.text(section.id), .text(assetID), .text(section.label), .int(startUS), .int(endUS), .optionalDouble(section.energy)]
                )
                try insertSearchDocument(
                    database,
                    id: "bgm-section:\(section.id)",
                    kind: "bgm_section",
                    assetID: assetID,
                    segmentID: nil,
                    startUS: startUS,
                    endUS: endUS,
                    title: "BGM \(section.label)",
                    text: "bpm \(bgm.bpm)\nmeter \(bgm.meter)\nenergy \(section.energy)",
                    tags: "bgm,section,\(section.label)"
                )
                summary.bgmSectionCount += 1
                summary.searchDocumentCount += 1
            }

            let downbeatUS = Set(bgm.downbeatsSec.map(microseconds(fromSeconds:)))
            for (index, beat) in bgm.beats.enumerated() {
                let timeUS = microseconds(fromSeconds: beat.timeSec)
                let isDownbeat = downbeatUS.contains(timeUS)
                try database.run(
                    "INSERT INTO bgm_beats(beat_id, asset_id, time_us, strength, downbeat) VALUES (?, ?, ?, ?, ?)",
                    [.text("BGM_BEAT_\(index + 1)"), .text(assetID), .int(timeUS), .optionalDouble(beat.strength), .int(isDownbeat ? 1 : 0)]
                )
                try insertSearchDocument(
                    database,
                    id: "bgm-beat:\(index + 1)",
                    kind: "bgm_beat",
                    assetID: assetID,
                    segmentID: nil,
                    startUS: timeUS,
                    endUS: timeUS,
                    title: isDownbeat ? "BGM downbeat \(index + 1)" : "BGM beat \(index + 1)",
                    text: [
                        beat.strength.map { "strength \($0)" },
                        isDownbeat ? "downbeat" : "beat"
                    ].compactMap { $0 }.joined(separator: "\n"),
                    tags: isDownbeat ? "bgm,beat,downbeat" : "bgm,beat"
                )
                summary.bgmBeatCount += 1
                summary.searchDocumentCount += 1
            }
        }

        if let continuity = loadContinuityGraph(projectURL: projectURL) {
            let entityLabels = Dictionary(uniqueKeysWithValues: continuity.entities.map { entity in
                (entity.id, entity.label?.isEmpty == false ? entity.label ?? entity.id : entity.id)
            })
            for entity in continuity.entities {
                try database.run(
                    "INSERT INTO continuity_entities(entity_id, entity_type, status, label, evidence_segment_ids, confidence) VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        .text(entity.id),
                        .text(entity.type),
                        .text(entity.status),
                        .optionalText(entity.label),
                        .text(entity.evidenceSegmentIDs.joined(separator: ",")),
                        .optionalDouble(entity.confidence?.score)
                    ]
                )
                try insertSearchDocument(
                    database,
                    id: "continuity-entity:\(entity.id)",
                    kind: "continuity_entity",
                    assetID: nil,
                    segmentID: nil,
                    startUS: nil,
                    endUS: nil,
                    title: entity.label?.isEmpty == false ? entity.label ?? entity.id : entity.id,
                    text: [
                        entity.type,
                        entity.status,
                        entity.evidenceSegmentIDs.joined(separator: " "),
                        entity.confidence?.source,
                        entity.confidence?.status
                    ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n"),
                    tags: ["continuity", entity.type, entity.status].joined(separator: ",")
                )
                summary.continuityEntityCount += 1
                summary.searchDocumentCount += 1
            }

            for segment in continuity.segments {
                try database.run(
                    "INSERT INTO continuity_segment_refs(segment_id, asset_id, src_in_us, src_out_us, entity_ids) VALUES (?, ?, ?, ?, ?)",
                    [
                        .text(segment.id),
                        .text(segment.assetID),
                        .int(segment.sourceInUS),
                        .int(segment.sourceOutUS),
                        .text(segment.entityIDs.joined(separator: ","))
                    ]
                )
                try insertSearchDocument(
                    database,
                    id: "continuity-segment:\(segment.id)",
                    kind: "continuity_segment",
                    assetID: segment.assetID,
                    segmentID: segment.id,
                    startUS: segment.sourceInUS,
                    endUS: segment.sourceOutUS,
                    title: segment.id,
                    text: segment.entityIDs.map { entityID in
                        [entityID, entityLabels[entityID]].compactMap { $0 }.joined(separator: " ")
                    }.joined(separator: "\n"),
                    tags: "continuity,segment"
                )
                summary.continuitySegmentRefCount += 1
                summary.searchDocumentCount += 1
            }
        }

        for preference in loadEditorialPreferences(projectURL: projectURL) {
            let sourceEvent = "\(preference.sourceEvent.type):\(preference.sourceEvent.ref)"
            try database.run(
                "INSERT INTO editorial_preferences(entry_id, preference_type, scope, status, value, source_event, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    .text(preference.id),
                    .text(preference.preferenceType),
                    .text(preference.scope),
                    .text(preference.status),
                    .text(preference.value.description),
                    .text(sourceEvent),
                    .text(preference.createdAt)
                ]
            )
            try insertSearchDocument(
                database,
                id: "editorial-preference:\(preference.id)",
                kind: "editorial_preference",
                assetID: nil,
                segmentID: nil,
                startUS: nil,
                endUS: nil,
                title: preference.preferenceType,
                text: [
                    preference.value.description,
                    preference.scope,
                    preference.status,
                    sourceEvent,
                    preference.confidence?.source,
                    preference.confidence?.status
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n"),
                tags: ["preference", preference.preferenceType, preference.scope, preference.status].joined(separator: ",")
            )
            summary.editorialPreferenceCount += 1
            summary.searchDocumentCount += 1
        }

        return summary
    }

    private static func insertMetadata(_ summary: ProjectIndexSummary, projectURL: URL, database: SQLiteDatabase) throws {
        let rows = [
            ("schema_version", "project-index-v1"),
            ("project_path", projectURL.path),
            ("updated_at", ISO8601DateFormatter().string(from: Date())),
            ("assets", "\(summary.assetCount)"),
            ("segments", "\(summary.segmentCount)"),
            ("transcript_items", "\(summary.transcriptItemCount)"),
            ("marlin_events", "\(summary.marlinEventCount)"),
            ("marlin_find_results", "\(summary.marlinFindResultCount)"),
            ("audio_events", "\(summary.audioEventCount)"),
            ("audio_story_nodes", "\(summary.audioStoryNodeCount)"),
            ("bgm_sections", "\(summary.bgmSectionCount)"),
            ("bgm_beats", "\(summary.bgmBeatCount)"),
            ("continuity_entities", "\(summary.continuityEntityCount)"),
            ("continuity_segment_refs", "\(summary.continuitySegmentRefCount)"),
            ("editorial_preferences", "\(summary.editorialPreferenceCount)"),
            ("search_documents", "\(summary.searchDocumentCount)")
        ]
        for row in rows {
            try database.run("INSERT INTO metadata(key, value) VALUES (?, ?)", [.text(row.0), .text(row.1)])
        }
    }

    private static func insertSearchDocument(
        _ database: SQLiteDatabase,
        id: String,
        kind: String,
        assetID: String?,
        segmentID: String?,
        startUS: Int?,
        endUS: Int?,
        title: String,
        text: String,
        tags: String
    ) throws {
        try database.run(
            "INSERT INTO search_documents(doc_id, kind, asset_id, segment_id, start_us, end_us, title, text, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [.text(id), .text(kind), .optionalText(assetID), .optionalText(segmentID), .optionalInt(startUS), .optionalInt(endUS), .text(title), .text(text), .text(tags)]
        )
    }

    private static func microseconds(fromSeconds seconds: Double) -> Int {
        Int((seconds * 1_000_000).rounded())
    }

    private static func loadContinuityGraph(projectURL: URL) -> ContinuityGraphDocument? {
        let url = projectURL.appendingPathComponent("03_analysis/continuity_graph.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ContinuityGraphDocument.self, from: data)
    }

    private static func loadEditorialPreferences(projectURL: URL) -> [EditorialPreferenceEntry] {
        let url = projectURL.appendingPathComponent("03_analysis/editorial_preference_memory.jsonl")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text
            .split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap { line in
                try? JSONDecoder().decode(EditorialPreferenceEntry.self, from: Data(line.utf8))
            }
    }
}

public struct ProjectIndexSummary: Equatable, Sendable {
    public let indexURL: URL
    public var assetCount: Int
    public var segmentCount: Int
    public var transcriptItemCount: Int
    public var marlinEventCount: Int
    public var marlinFindResultCount: Int
    public var audioEventCount: Int
    public var audioStoryNodeCount: Int
    public var bgmSectionCount: Int
    public var bgmBeatCount: Int
    public var continuityEntityCount: Int
    public var continuitySegmentRefCount: Int
    public var editorialPreferenceCount: Int
    public var searchDocumentCount: Int
}

private struct ContinuityGraphDocument: Decodable {
    let entities: [ContinuityEntity]
    let segments: [ContinuitySegmentRef]
}

private struct ContinuityEntity: Decodable {
    let id: String
    let type: String
    let status: String
    let label: String?
    let evidenceSegmentIDs: [String]
    let confidence: SearchConfidence?

    enum CodingKeys: String, CodingKey {
        case id = "entity_id"
        case type = "entity_type"
        case status
        case label
        case evidenceSegmentIDs = "evidence_segment_ids"
        case confidence
    }
}

private struct ContinuitySegmentRef: Decodable {
    let id: String
    let assetID: String
    let sourceInUS: Int
    let sourceOutUS: Int
    let entityIDs: [String]

    enum CodingKeys: String, CodingKey {
        case id = "segment_id"
        case assetID = "asset_id"
        case sourceInUS = "src_in_us"
        case sourceOutUS = "src_out_us"
        case entityIDs = "entity_ids"
    }
}

private struct EditorialPreferenceEntry: Decodable {
    let id: String
    let createdAt: String
    let preferenceType: String
    let value: EditorialPreferenceValue
    let scope: String
    let status: String
    let sourceEvent: EditorialPreferenceSourceEvent
    let confidence: SearchConfidence?

    enum CodingKeys: String, CodingKey {
        case id = "entry_id"
        case createdAt = "created_at"
        case preferenceType = "preference_type"
        case value
        case scope
        case status
        case sourceEvent = "source_event"
        case confidence
    }
}

private struct EditorialPreferenceValue: Decodable {
    let kind: String
    let data: SearchJSONValue

    var description: String {
        "\(kind): \(data.description)"
    }
}

private struct EditorialPreferenceSourceEvent: Decodable {
    let type: String
    let ref: String

    enum CodingKeys: String, CodingKey {
        case type = "event_type"
        case ref = "event_ref"
    }
}

private struct SearchConfidence: Decodable {
    let score: Double?
    let source: String?
    let status: String?
}

private indirect enum SearchJSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: SearchJSONValue])
    case array([SearchJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([SearchJSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try container.decode([String: SearchJSONValue].self))
        }
    }

    var description: String {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .array(let values):
            return values.map(\.description).joined(separator: ", ")
        case .object(let object):
            return object.keys.sorted().map { key in
                "\(key)=\(object[key]?.description ?? "")"
            }.joined(separator: ", ")
        case .null:
            return "null"
        }
    }
}

public struct ProjectIndexStatus: Equatable, Sendable {
    public let indexURL: URL
    public let exists: Bool
    public let documentCount: Int
    public let updatedAt: String?

    public init(indexURL: URL, exists: Bool, documentCount: Int, updatedAt: String?) {
        self.indexURL = indexURL
        self.exists = exists
        self.documentCount = documentCount
        self.updatedAt = updatedAt
    }
}

public struct ProjectSearchResult: Identifiable, Equatable, Sendable {
    public var id: String { documentID }
    public let documentID: String
    public let kind: String
    public let assetID: String?
    public let segmentID: String?
    public let startUS: Int?
    public let endUS: Int?
    public let title: String
    public let text: String
    public let tags: String
}

private enum SQLiteBinding {
    case text(String)
    case optionalText(String?)
    case int(Int)
    case optionalInt(Int?)
    case optionalDouble(Double?)
}

private final class SQLiteDatabase {
    let url: URL
    private var handle: OpaquePointer?

    private init(url: URL, handle: OpaquePointer?) {
        self.url = url
        self.handle = handle
    }

    static func open(url: URL) throws -> SQLiteDatabase {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK else {
            let message = handle.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) } ?? "unknown sqlite open error"
            if let handle {
                sqlite3_close(handle)
            }
            throw SQLiteIndexError.sqlite(message)
        }
        return SQLiteDatabase(url: url, handle: handle)
    }

    func close() {
        if let handle {
            sqlite3_close(handle)
            self.handle = nil
        }
    }

    func exec(_ sql: String) throws {
        guard let handle else { throw SQLiteIndexError.sqlite("database is closed") }
        var errorMessage: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(handle, sql, nil, nil, &errorMessage) != SQLITE_OK {
            let message = errorMessage.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(handle))
            sqlite3_free(errorMessage)
            throw SQLiteIndexError.sqlite(message)
        }
    }

    func run(_ sql: String, _ bindings: [SQLiteBinding] = []) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw SQLiteIndexError.sqlite(errorMessage)
        }
    }

    func query<T>(_ sql: String, bindings: [SQLiteBinding] = [], map: (SQLiteStatement) throws -> T) throws -> [T] {
        let rawStatement = try prepare(sql)
        defer { sqlite3_finalize(rawStatement) }
        try bind(bindings, to: rawStatement)
        var rows: [T] = []
        let statement = SQLiteStatement(raw: rawStatement)
        while true {
            let result = sqlite3_step(rawStatement)
            if result == SQLITE_ROW {
                rows.append(try map(statement))
            } else if result == SQLITE_DONE {
                return rows
            } else {
                throw SQLiteIndexError.sqlite(errorMessage)
            }
        }
    }

    func scalarInt(_ sql: String) throws -> Int? {
        try query(sql) { $0.columnIntOptional(0) }.first ?? nil
    }

    func scalarString(_ sql: String) throws -> String? {
        try query(sql) { $0.columnTextOptional(0) }.first ?? nil
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        guard let handle else { throw SQLiteIndexError.sqlite("database is closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw SQLiteIndexError.sqlite(errorMessage)
        }
        return statement
    }

    private func bind(_ bindings: [SQLiteBinding], to statement: OpaquePointer?) throws {
        for (index, binding) in bindings.enumerated() {
            let position = Int32(index + 1)
            let result: Int32
            switch binding {
            case .text(let value):
                result = sqlite3_bind_text(statement, position, value, -1, SQLITE_TRANSIENT)
            case .optionalText(let value):
                if let value {
                    result = sqlite3_bind_text(statement, position, value, -1, SQLITE_TRANSIENT)
                } else {
                    result = sqlite3_bind_null(statement, position)
                }
            case .int(let value):
                result = sqlite3_bind_int64(statement, position, sqlite3_int64(value))
            case .optionalInt(let value):
                if let value {
                    result = sqlite3_bind_int64(statement, position, sqlite3_int64(value))
                } else {
                    result = sqlite3_bind_null(statement, position)
                }
            case .optionalDouble(let value):
                if let value {
                    result = sqlite3_bind_double(statement, position, value)
                } else {
                    result = sqlite3_bind_null(statement, position)
                }
            }
            guard result == SQLITE_OK else {
                throw SQLiteIndexError.sqlite(errorMessage)
            }
        }
    }

    private var errorMessage: String {
        handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown sqlite error"
    }
}

private struct SQLiteStatement {
    let raw: OpaquePointer?

    func columnText(_ index: Int32) -> String {
        columnTextOptional(index) ?? ""
    }

    func columnTextOptional(_ index: Int32) -> String? {
        guard sqlite3_column_type(raw, index) != SQLITE_NULL, let text = sqlite3_column_text(raw, index) else {
            return nil
        }
        return String(cString: text)
    }

    func columnIntOptional(_ index: Int32) -> Int? {
        guard sqlite3_column_type(raw, index) != SQLITE_NULL else {
            return nil
        }
        return Int(sqlite3_column_int64(raw, index))
    }
}

private enum SQLiteIndexError: Error, CustomStringConvertible {
    case sqlite(String)

    var description: String {
        switch self {
        case .sqlite(let message):
            return message
        }
    }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
