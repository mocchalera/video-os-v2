import Foundation

public struct PatchHistoryIndex: Codable, Equatable, Sendable {
    public let version: String
    public let project_id: String
    public private(set) var records: [PatchHistoryRecord]

    public init(version: String = "1", project_id: String, records: [PatchHistoryRecord] = []) {
        self.version = version
        self.project_id = project_id
        self.records = records
    }

    public static func load(projectURL: URL) -> PatchHistoryIndex {
        let url = indexURL(projectURL: projectURL)
        guard
            let data = try? Data(contentsOf: url),
            let index = try? JSONDecoder().decode(PatchHistoryIndex.self, from: data)
        else {
            return PatchHistoryIndex(project_id: projectURL.lastPathComponent)
        }
        return index
    }

    public mutating func append(record: PatchHistoryRecord) {
        records.append(record)
    }

    @discardableResult
    public mutating func removeLast() -> PatchHistoryRecord? {
        guard !records.isEmpty else { return nil }
        return records.removeLast()
    }

    public mutating func pruneBackups(projectURL: URL, maxBackups: Int = 20) throws {
        let retainedCount = max(0, maxBackups)
        let activeBackupIndices = records.indices
            .filter { records[$0].purged != true && !records[$0].timeline_backup_path.isEmpty }

        let purgeCount = max(0, activeBackupIndices.count - retainedCount)
        guard purgeCount > 0 else { return }

        let indicesToPurge = activeBackupIndices.prefix(purgeCount)
        let fileManager = FileManager.default
        for index in indicesToPurge {
            let backupURL = projectURL.appendingPathComponent(records[index].timeline_backup_path)
            if fileManager.fileExists(atPath: backupURL.path) {
                try fileManager.removeItem(at: backupURL)
            }
            records[index].purged = true
        }
    }

    public func save(projectURL: URL) throws {
        let url = Self.indexURL(projectURL: projectURL)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)
        try data.write(to: url, options: .atomic)
    }

    public static func historyDirectory(projectURL: URL) -> URL {
        projectURL.appendingPathComponent("06_review/patch_history")
    }

    public static func indexURL(projectURL: URL) -> URL {
        historyDirectory(projectURL: projectURL).appendingPathComponent("index.json")
    }
}

public struct PatchHistoryRecord: Codable, Equatable, Identifiable, Sendable {
    public var id: String { patch_path }

    public let patch_path: String
    public let base_timeline_hash: String
    public let result_timeline_hash: String
    public let timeline_backup_path: String
    public let created_at: String
    public let source: String
    public let changed_clip_ids: [String]
    public let op_count: Int
    public var purged: Bool?

    public init(
        patch_path: String,
        base_timeline_hash: String,
        result_timeline_hash: String,
        timeline_backup_path: String,
        created_at: String,
        source: String,
        changed_clip_ids: [String],
        op_count: Int,
        purged: Bool? = nil
    ) {
        self.patch_path = patch_path
        self.base_timeline_hash = base_timeline_hash
        self.result_timeline_hash = result_timeline_hash
        self.timeline_backup_path = timeline_backup_path
        self.created_at = created_at
        self.source = source
        self.changed_clip_ids = changed_clip_ids
        self.op_count = op_count
        self.purged = purged
    }
}
