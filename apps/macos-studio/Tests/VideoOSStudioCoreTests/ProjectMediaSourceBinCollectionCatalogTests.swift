import XCTest
@testable import VideoOSStudioCore

final class ProjectMediaSourceBinCollectionCatalogTests: XCTestCase {
    func testNamesIncludeActiveCollectionAndNormalizeWhitespace() {
        let names = ProjectMediaSourceBinCollectionCatalog.names(
            storedNames: [" 差し替え候補 ", "B-roll確認"],
            activeName: " 使うかも "
        )

        XCTAssertEqual(names, ["B-roll確認", "差し替え候補", "使うかも"])
    }

    func testNamesUsePreferredOrderAndAppendMissingNames() {
        let names = ProjectMediaSourceBinCollectionCatalog.names(
            storedNames: ["C", "A"],
            activeName: "B",
            preferredOrder: [" C ", "C", "削除済み"]
        )

        XCTAssertEqual(names, ["C", "A", "B"])
    }

    func testMovingCollectionOrderClampsAndDeduplicatesNames() {
        let movedEarlier = ProjectMediaSourceBinCollectionCatalog.moving(
            "保留",
            by: -1,
            in: ["B-roll確認", "差し替え候補", "保留", "差し替え候補"]
        )
        let movedLater = ProjectMediaSourceBinCollectionCatalog.moving(
            "B-roll確認",
            by: 2,
            in: movedEarlier
        )

        XCTAssertEqual(movedEarlier, ["B-roll確認", "保留", "差し替え候補"])
        XCTAssertEqual(movedLater, ["保留", "差し替え候補", "B-roll確認"])
    }

    func testRenamingCollectionOrderPreservesPositionOrExistingDestination() {
        let renamedToNewName = ProjectMediaSourceBinCollectionCatalog.renamingOrder(
            "選別A",
            to: "使うかも",
            in: ["B-roll確認", "選別A", "差し替え候補"]
        )
        let renamedIntoExisting = ProjectMediaSourceBinCollectionCatalog.renamingOrder(
            "選別A",
            to: "差し替え候補",
            in: ["B-roll確認", "選別A", "差し替え候補"]
        )

        XCTAssertEqual(renamedToNewName, ["B-roll確認", "使うかも", "差し替え候補"])
        XCTAssertEqual(renamedIntoExisting, ["B-roll確認", "差し替え候補"])
    }

    func testDeletingCollectionOrderRemovesOnlyTargetName() {
        let deleted = ProjectMediaSourceBinCollectionCatalog.deletingOrder(
            "選別A",
            in: ["B-roll確認", "選別A", "差し替え候補", "選別A"]
        )

        XCTAssertEqual(deleted, ["B-roll確認", "差し替え候補"])
    }

    func testNextNameUsesDefaultThenAlphabeticNames() {
        XCTAssertEqual(
            ProjectMediaSourceBinCollectionCatalog.nextName(existingNames: ["差し替え候補"]),
            "選別A"
        )
        XCTAssertEqual(
            ProjectMediaSourceBinCollectionCatalog.nextName(existingNames: ["選別A", "選別B"]),
            "選別C"
        )
    }

    func testRenamingMovesMembershipToNewName() {
        let renamed = ProjectMediaSourceBinCollectionCatalog.renaming(
            "選別A",
            to: "差し替え候補",
            in: ["選別A": ["AST_001", "AST_002"]]
        )

        XCTAssertNil(renamed["選別A"])
        XCTAssertEqual(renamed["差し替え候補"], ["AST_001", "AST_002"])
    }

    func testRenamingPreservesEmptyCollection() {
        let renamed = ProjectMediaSourceBinCollectionCatalog.renaming(
            "選別A",
            to: "差し替え候補",
            in: ["選別A": []]
        )

        XCTAssertNil(renamed["選別A"])
        XCTAssertEqual(renamed["差し替え候補"], [])
    }

    func testRenamingIntoExistingCollectionMergesMembership() {
        let renamed = ProjectMediaSourceBinCollectionCatalog.renaming(
            "選別A",
            to: "差し替え候補",
            in: [
                "選別A": ["AST_001", "AST_002"],
                "差し替え候補": ["AST_002", "AST_003"],
            ]
        )

        XCTAssertNil(renamed["選別A"])
        XCTAssertEqual(renamed["差し替え候補"], ["AST_001", "AST_002", "AST_003"])
    }

    func testBulkAddingAndRemovingPreservesCollection() {
        let added = ProjectMediaSourceBinCollectionCatalog.adding(
            [" AST_001 ", "AST_002", "", "AST_001"],
            to: " 選別A ",
            in: ["選別A": ["AST_000"]]
        )

        XCTAssertEqual(added["選別A"], ["AST_000", "AST_001", "AST_002"])

        let removed = ProjectMediaSourceBinCollectionCatalog.removing(
            ["AST_000", "AST_001", "MISSING"],
            from: "選別A",
            in: added
        )

        XCTAssertEqual(removed["選別A"], ["AST_002"])

        let emptied = ProjectMediaSourceBinCollectionCatalog.removing(
            ["AST_002"],
            from: "選別A",
            in: removed
        )

        XCTAssertEqual(emptied["選別A"], [])
    }

    func testCollectionMetadataNormalizesNoteAndStatus() {
        let longNote = String(repeating: "a", count: ProjectMediaSourceBinCollectionMetadata.maxNoteLength + 5)
        let metadata = ProjectMediaSourceBinCollectionMetadata(
            statusRawValue: "missing",
            note: " \(longNote) "
        )

        XCTAssertEqual(metadata.status, .candidate)
        XCTAssertEqual(metadata.note.count, ProjectMediaSourceBinCollectionMetadata.maxNoteLength)
    }

    func testCollectionMetadataStoringNormalizesNameAndRemovesDefaultValues() {
        let stored = ProjectMediaSourceBinCollectionMetadataCatalog.storing(
            ProjectMediaSourceBinCollectionMetadata(status: .reviewing, note: " B-roll確認 "),
            for: " 選別A ",
            in: [:]
        )

        XCTAssertEqual(
            stored["選別A"],
            ProjectMediaSourceBinCollectionMetadata(status: .reviewing, note: "B-roll確認")
        )

        let removed = ProjectMediaSourceBinCollectionMetadataCatalog.storing(
            .empty,
            for: "選別A",
            in: stored
        )

        XCTAssertNil(removed["選別A"])
    }

    func testCollectionMetadataRenamingMovesMetadataToNewName() {
        let renamed = ProjectMediaSourceBinCollectionMetadataCatalog.renaming(
            "選別A",
            to: "差し替え候補",
            in: [
                "選別A": ProjectMediaSourceBinCollectionMetadata(status: .selected, note: "OK素材")
            ]
        )

        XCTAssertNil(renamed["選別A"])
        XCTAssertEqual(
            renamed["差し替え候補"],
            ProjectMediaSourceBinCollectionMetadata(status: .selected, note: "OK素材")
        )
    }

    func testCollectionMetadataRenamingIntoExistingPreservesDestinationIntent() {
        let renamed = ProjectMediaSourceBinCollectionMetadataCatalog.renaming(
            "選別A",
            to: "差し替え候補",
            in: [
                "選別A": ProjectMediaSourceBinCollectionMetadata(status: .reviewing, note: "B-roll確認"),
                "差し替え候補": ProjectMediaSourceBinCollectionMetadata(status: .hold, note: "差し替え待ち"),
            ]
        )

        XCTAssertNil(renamed["選別A"])
        XCTAssertEqual(
            renamed["差し替え候補"],
            ProjectMediaSourceBinCollectionMetadata(status: .hold, note: "差し替え待ち")
        )
    }

    func testCollectionMetadataRenamingIntoEmptyExistingFillsMissingFields() {
        let renamed = ProjectMediaSourceBinCollectionMetadataCatalog.renaming(
            "選別A",
            to: "差し替え候補",
            in: [
                "選別A": ProjectMediaSourceBinCollectionMetadata(status: .reviewing, note: "B-roll確認"),
                "差し替え候補": ProjectMediaSourceBinCollectionMetadata(status: .candidate, note: ""),
            ]
        )

        XCTAssertEqual(
            renamed["差し替え候補"],
            ProjectMediaSourceBinCollectionMetadata(status: .reviewing, note: "B-roll確認")
        )
    }

    func testCollectionMetadataDeletingRemovesOnlyTargetName() {
        let deleted = ProjectMediaSourceBinCollectionMetadataCatalog.deleting(
            " 選別A ",
            in: [
                "選別A": ProjectMediaSourceBinCollectionMetadata(status: .reviewing, note: "確認中"),
                "差し替え候補": ProjectMediaSourceBinCollectionMetadata(status: .selected, note: "採用候補"),
            ]
        )

        XCTAssertNil(deleted["選別A"])
        XCTAssertEqual(
            deleted["差し替え候補"],
            ProjectMediaSourceBinCollectionMetadata(status: .selected, note: "採用候補")
        )
    }
}
