import XCTest
@testable import VideoOSStudioCore

final class PatchHistoryIndexTests: XCTestCase {
    func testLoadSaveRoundTrip() throws {
        let projectURL = temporaryHistoryProject()
        let record = patchHistoryRecord(index: 1)
        let index = PatchHistoryIndex(project_id: "demo", records: [record])

        try index.save(projectURL: projectURL)
        let loaded = PatchHistoryIndex.load(projectURL: projectURL)

        XCTAssertEqual(loaded, index)
    }

    func testAppendIncreasesRecords() {
        var index = PatchHistoryIndex(project_id: "demo")

        index.append(record: patchHistoryRecord(index: 1))
        index.append(record: patchHistoryRecord(index: 2))

        XCTAssertEqual(index.records.count, 2)
        XCTAssertEqual(index.records.map(\.patch_path), [
            "06_review/studio_patch_1.json",
            "06_review/studio_patch_2.json"
        ])
    }

    @MainActor
    func testPruneHistoryKeepsLatestBackupsAndMarksOlderRecordsPurged() throws {
        let projectURL = temporaryHistoryProject()
        let historyDir = PatchHistoryIndex.historyDirectory(projectURL: projectURL)
        try FileManager.default.createDirectory(at: historyDir, withIntermediateDirectories: true)

        var index = PatchHistoryIndex(project_id: "demo")
        for itemIndex in 1...5 {
            let backupURL = projectURL.appendingPathComponent("06_review/patch_history/timeline_backup_\(itemIndex).json")
            try #"{"version":"\#(itemIndex)"}"#.write(to: backupURL, atomically: true, encoding: .utf8)
            index.append(record: patchHistoryRecord(index: itemIndex))
        }
        try index.save(projectURL: projectURL)

        let session = StudioFeedbackSession()
        session.loadHistory(projectURL: projectURL)
        session.pruneHistory(projectURL: projectURL, maxBackups: 3)

        let pruned = PatchHistoryIndex.load(projectURL: projectURL)
        XCTAssertEqual(pruned.records.count, 5)
        XCTAssertEqual(pruned.records.prefix(2).map { $0.purged }, [true, true])
        XCTAssertEqual(pruned.records.suffix(3).map { $0.purged ?? false }, [false, false, false])

        XCTAssertFalse(FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("06_review/patch_history/timeline_backup_1.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("06_review/patch_history/timeline_backup_2.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("06_review/patch_history/timeline_backup_3.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("06_review/patch_history/timeline_backup_4.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("06_review/patch_history/timeline_backup_5.json").path))
        XCTAssertEqual(session.patchHistory, pruned.records)
    }
}

private func temporaryHistoryProject() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("videoos-patch-history-\(UUID().uuidString)")
}

private func patchHistoryRecord(index: Int) -> PatchHistoryRecord {
    PatchHistoryRecord(
        patch_path: "06_review/studio_patch_\(index).json",
        base_timeline_hash: "base-\(index)",
        result_timeline_hash: "result-\(index)",
        timeline_backup_path: "06_review/patch_history/timeline_backup_\(index).json",
        created_at: "2026-06-22T00:00:0\(index)Z",
        source: "studio_ui",
        changed_clip_ids: ["CLP_\(String(format: "%03d", index))"],
        op_count: index
    )
}
