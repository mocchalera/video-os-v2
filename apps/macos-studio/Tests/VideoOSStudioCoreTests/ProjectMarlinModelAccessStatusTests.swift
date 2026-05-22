import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinModelAccessStatusTests: XCTestCase {
    func testStatusReportsMissingTokenFromEmptyRepository() throws {
        let root = temporaryRoot("marlin-model-access-missing")

        let status = ProjectMarlinModelAccessStatusReader.status(repositoryRoot: root, pythonBinary: "python3")

        XCTAssertFalse(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.readinessLabel, "HF_TOKEN missing")
        XCTAssertFalse(status.hasToken)
        XCTAssertTrue(status.recommendation.contains("HF_TOKEN"))
    }

    func testStatusParsesAllowedAccessProbe() {
        let status = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: URL(fileURLWithPath: "/tmp"),
            pythonBinary: "python3",
            hasToken: true,
            probeOutput: "access\tok\tNemoStation/Marlin-2B\n"
        )

        XCTAssertTrue(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.readinessLabel, "model access ready")
        XCTAssertTrue(status.checkedAccess)
        XCTAssertTrue(status.accessAllowed)
    }

    func testStatusParsesDeniedAccessProbe() {
        let status = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: URL(fileURLWithPath: "/tmp"),
            pythonBinary: "python3",
            hasToken: true,
            probeOutput: "access\tfailed\tGatedRepoError: 401 Client Error\n"
        )

        XCTAssertFalse(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.readinessLabel, "model access denied")
        XCTAssertEqual(status.error, "GatedRepoError: 401 Client Error")
    }

    private func temporaryRoot(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }
}
