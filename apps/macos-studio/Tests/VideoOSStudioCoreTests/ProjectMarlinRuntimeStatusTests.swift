import XCTest
@testable import VideoOSStudioCore

final class ProjectMarlinRuntimeStatusTests: XCTestCase {
    func testDefaultPythonPrefersRepositoryMarlinVenv() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marlin-runtime-\(UUID().uuidString)")
        let python = root.appendingPathComponent("python/.venv-marlin/bin/python3")
        try FileManager.default.createDirectory(at: python.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: python.path, contents: Data("#!/bin/sh\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: python.path)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(ProjectMarlinRuntimeStatusReader.defaultPythonBinary(repositoryRoot: root), python.path)
    }

    func testUncheckedStatusDoesNotReportLiveRuntimeReady() {
        let status = ProjectMarlinRuntimeStatusReader.uncheckedStatus(repositoryRoot: URL(fileURLWithPath: "/tmp"))

        XCTAssertEqual(status.readinessLabel, "missing dependencies")
        XCTAssertFalse(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.stderr, "Runtime probe has not run yet.")
        XCTAssertEqual(status.missingRequirements.map(\.id), [
            "torch",
            "transformers",
            "torchcodec",
            "qwen-vl-utils",
            "av",
            "pillow",
            "accelerate",
        ])
    }

    func testStatusReportsReadyWhenRequiredModulesMeetMinimums() {
        let status = ProjectMarlinRuntimeStatusReader.status(
            repositoryRoot: URL(fileURLWithPath: "/tmp"),
            pythonBinary: "python3",
            probeOutput: """
            torch	ok	2.11.0
            transformers	ok	5.7.1
            torchcodec	ok	0.10.0
            qwen_vl_utils	ok	0.0.14
            av	ok	16.1.0
            PIL	ok	12.1.1
            accelerate	ok	1.12.0
            __device__	ok	cuda=false	mps=true
            """
        )

        XCTAssertEqual(status.readinessLabel, "live runtime ready")
        XCTAssertTrue(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.requestedDevice, "auto")
        XCTAssertEqual(status.resolvedDeviceLabel, "mps")
        XCTAssertEqual(status.deviceStatusLabel, "ready")
        XCTAssertTrue(status.missingRequirements.isEmpty)
        XCTAssertTrue(status.outdatedRequirements.isEmpty)
    }

    func testStatusSeparatesMissingAndOutdatedDependencies() {
        let status = ProjectMarlinRuntimeStatusReader.status(
            repositoryRoot: URL(fileURLWithPath: "/tmp"),
            pythonBinary: "python3",
            probeOutput: """
            torch	ok	2.10.0
            transformers	ok	5.3.0
            torchcodec	ok	0.10.0
            qwen_vl_utils	missing	ModuleNotFoundError
            av	ok	16.1.0
            PIL	ok	12.1.1
            accelerate	missing	ModuleNotFoundError
            __device__	ok	cuda=false	mps=true
            """
        )

        XCTAssertEqual(status.readinessLabel, "missing dependencies")
        XCTAssertFalse(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.missingRequirements.map(\.id), ["qwen-vl-utils", "accelerate"])
        XCTAssertEqual(status.outdatedRequirements.map(\.id), ["torch", "transformers"])
        XCTAssertTrue(status.recommendation.contains("python/requirements-marlin.txt"))
    }

    func testStatusReportsUnavailableExplicitDevice() {
        let status = ProjectMarlinRuntimeStatusReader.status(
            repositoryRoot: URL(fileURLWithPath: "/tmp"),
            pythonBinary: "python3",
            requestedDevice: "cuda",
            probeOutput: """
            torch	ok	2.11.0
            transformers	ok	5.7.1
            torchcodec	ok	0.10.0
            qwen_vl_utils	ok	0.0.14
            av	ok	16.1.0
            PIL	ok	12.1.1
            accelerate	ok	1.12.0
            __device__	ok	cuda=false	mps=true
            """
        )

        XCTAssertEqual(status.readinessLabel, "device unavailable")
        XCTAssertFalse(status.isReadyForLiveMarlin)
        XCTAssertEqual(status.requestedDevice, "cuda")
        XCTAssertEqual(status.resolvedDeviceLabel, "cuda")
        XCTAssertEqual(status.deviceStatusLabel, "unavailable")
        XCTAssertTrue(status.recommendation.contains("device unavailable: cuda"))
    }
}
