import Foundation

public struct ProjectMarlinRuntimeRequirement: Identifiable, Equatable, Sendable {
    public let id: String
    public let importName: String
    public let minimumVersion: String?
    public let installedVersion: String?
    public let isInstalled: Bool
    public let isVersionSatisfied: Bool
    public let error: String?

    public var statusLabel: String {
        if !isInstalled { return "missing" }
        if !isVersionSatisfied { return "outdated" }
        return "ready"
    }

    public var detail: String {
        if let installedVersion, !installedVersion.isEmpty {
            if let minimumVersion {
                return "\(installedVersion) / requires \(minimumVersion)+"
            }
            return installedVersion
        }
        return error ?? "-"
    }
}

public struct ProjectMarlinRuntimeStatus: Equatable, Sendable {
    public let repositoryRoot: URL
    public let pythonBinary: String
    public let requestedDevice: String
    public let cudaAvailable: Bool
    public let mpsAvailable: Bool
    public let requirements: [ProjectMarlinRuntimeRequirement]
    public let stderr: String

    public var missingRequirements: [ProjectMarlinRuntimeRequirement] {
        requirements.filter { !$0.isInstalled }
    }

    public var outdatedRequirements: [ProjectMarlinRuntimeRequirement] {
        requirements.filter { $0.isInstalled && !$0.isVersionSatisfied }
    }

    public var isReadyForLiveMarlin: Bool {
        missingRequirements.isEmpty && outdatedRequirements.isEmpty && isRequestedDeviceAvailable
    }

    public var resolvedDeviceLabel: String {
        switch requestedDevice {
        case "auto":
            if cudaAvailable { return "cuda" }
            if mpsAvailable { return "mps" }
            return "cpu"
        default:
            return requestedDevice
        }
    }

    public var isRequestedDeviceAvailable: Bool {
        switch requestedDevice {
        case "auto":
            return cudaAvailable || mpsAvailable
        case "cuda":
            return cudaAvailable
        case "mps":
            return mpsAvailable
        case "cpu":
            return true
        default:
            return true
        }
    }

    public var deviceStatusLabel: String {
        if isRequestedDeviceAvailable { return "ready" }
        return "unavailable"
    }

    public var readinessLabel: String {
        if isReadyForLiveMarlin { return "live runtime ready" }
        if !missingRequirements.isEmpty { return "missing dependencies" }
        if !isRequestedDeviceAvailable { return "device unavailable" }
        return "outdated dependencies"
    }

    public var recommendation: String {
        if isReadyForLiveMarlin {
            return "Run a live Marlin evaluation on the next representative project."
        }
        let missing = missingRequirements.map(\.id).joined(separator: ", ")
        let outdated = outdatedRequirements.map { requirement in
            "\(requirement.id) \(requirement.installedVersion ?? "?") < \(requirement.minimumVersion ?? "?")"
        }.joined(separator: ", ")
        let blockers = [missing.isEmpty ? nil : "missing: \(missing)", outdated.isEmpty ? nil : "outdated: \(outdated)"]
            .compactMap { $0 }
            .joined(separator: "; ")
        let deviceBlocker = isRequestedDeviceAvailable ? nil : "device unavailable: \(requestedDevice)"
        let allBlockers = [blockers.isEmpty ? nil : blockers, deviceBlocker]
            .compactMap { $0 }
            .joined(separator: "; ")
        return "Install or update python/requirements-marlin.txt before counting Marlin output as live preference evidence. \(allBlockers)"
    }

    public var setupCommand: String {
        "\(pythonBinary) -m pip install --upgrade -r python/requirements-marlin.txt"
    }
}

public enum ProjectMarlinRuntimeStatusReader {
    private static let expectedModules: [(id: String, importName: String, minimumVersion: String?)] = [
        ("torch", "torch", "2.11.0"),
        ("transformers", "transformers", "5.7.0"),
        ("torchcodec", "torchcodec", nil),
        ("qwen-vl-utils", "qwen_vl_utils", "0.0.14"),
        ("av", "av", nil),
        ("pillow", "PIL", nil),
        ("accelerate", "accelerate", nil),
    ]

    public static func uncheckedStatus(
        repositoryRoot: URL,
        pythonBinary: String? = nil,
        requestedDevice: String = ProcessInfo.processInfo.environment["VOS_MARLIN_DEVICE"] ?? "auto"
    ) -> ProjectMarlinRuntimeStatus {
        let resolvedPython = pythonBinary ?? defaultPythonBinary(repositoryRoot: repositoryRoot)
        return status(
            repositoryRoot: repositoryRoot,
            pythonBinary: resolvedPython,
            requestedDevice: requestedDevice,
            probeOutput: "",
            stderr: "Runtime probe has not run yet."
        )
    }

    public static func status(
        repositoryRoot: URL,
        pythonBinary: String? = nil,
        requestedDevice: String = ProcessInfo.processInfo.environment["VOS_MARLIN_DEVICE"] ?? "auto"
    ) -> ProjectMarlinRuntimeStatus {
        let resolvedPython = pythonBinary ?? defaultPythonBinary(repositoryRoot: repositoryRoot)
        let script = pythonProbeScript()
        let result = runProcess(
            executable: URL(fileURLWithPath: "/usr/bin/env"),
            arguments: [resolvedPython, "-c", script],
            currentDirectory: repositoryRoot
        )
        return status(
            repositoryRoot: repositoryRoot,
            pythonBinary: resolvedPython,
            requestedDevice: requestedDevice,
            probeOutput: result.stdout,
            stderr: result.stderr
        )
    }

    public static func defaultPythonBinary(repositoryRoot: URL) -> String {
        if let override = ProcessInfo.processInfo.environment["VOS_MARLIN_PYTHON"], !override.isEmpty {
            return override
        }
        let candidates = [
            repositoryRoot.appendingPathComponent("python/.venv-marlin/bin/python3"),
            repositoryRoot.appendingPathComponent(".venv-marlin/bin/python3"),
            repositoryRoot.appendingPathComponent(".venv/bin/python3"),
        ]
        if let candidate = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) {
            return candidate.path
        }
        return "python3"
    }

    public static func status(
        repositoryRoot: URL,
        pythonBinary: String,
        requestedDevice: String = "auto",
        probeOutput: String,
        stderr: String = ""
    ) -> ProjectMarlinRuntimeStatus {
        let parsed = parseProbeOutput(probeOutput)
        let rows = parsed.rows
        let requirements = expectedModules.map { module in
            let row = rows[module.importName] ?? rows[module.id]
            let installed = row?.installed ?? false
            let version = row?.version
            return ProjectMarlinRuntimeRequirement(
                id: module.id,
                importName: module.importName,
                minimumVersion: module.minimumVersion,
                installedVersion: version,
                isInstalled: installed,
                isVersionSatisfied: installed && isVersion(version, atLeast: module.minimumVersion),
                error: row?.error
            )
        }

        return ProjectMarlinRuntimeStatus(
            repositoryRoot: repositoryRoot,
            pythonBinary: pythonBinary,
            requestedDevice: requestedDevice,
            cudaAvailable: parsed.cudaAvailable,
            mpsAvailable: parsed.mpsAvailable,
            requirements: requirements,
            stderr: stderr
        )
    }

    private static func pythonProbeScript() -> String {
        let modules = expectedModules
            .map { "(\(pythonStringLiteral($0.importName)), \(pythonStringLiteral($0.id)))" }
            .joined(separator: ", ")
        return """
        import importlib
        import importlib.metadata
        modules = [\(modules)]
        for name, dist_name in modules:
            try:
                module = importlib.import_module(name)
                version = getattr(module, '__version__', '')
                if not version:
                    try:
                        version = importlib.metadata.version(dist_name)
                    except Exception:
                        version = ''
                print(f"{name}\\tok\\t{version}")
            except Exception as exc:
                print(f"{name}\\tmissing\\t{type(exc).__name__}: {exc}")
        try:
            import torch
            cuda = bool(torch.cuda.is_available()) if hasattr(torch, "cuda") else False
            mps = bool(torch.backends.mps.is_available()) if hasattr(torch, "backends") and hasattr(torch.backends, "mps") else False
            print(f"__device__\\tok\\tcuda={str(cuda).lower()}\\tmps={str(mps).lower()}")
        except Exception as exc:
            print(f"__device__\\tmissing\\t{type(exc).__name__}: {exc}")
        """
    }

    private static func pythonStringLiteral(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }

    private struct ProbeRow {
        let installed: Bool
        let version: String?
        let error: String?
    }

    private static func parseProbeOutput(_ output: String) -> (
        rows: [String: ProbeRow],
        cudaAvailable: Bool,
        mpsAvailable: Bool
    ) {
        var rows: [String: ProbeRow] = [:]
        var cudaAvailable = false
        var mpsAvailable = false
        for line in output.components(separatedBy: .newlines) {
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 2 else { continue }
            let name = parts[0]
            let status = parts[1]
            let detail = parts.dropFirst(2).joined(separator: "\t")
            if name == "__device__" {
                cudaAvailable = parts.contains("cuda=true")
                mpsAvailable = parts.contains("mps=true")
                continue
            }
            rows[name] = ProbeRow(
                installed: status == "ok",
                version: status == "ok" ? detail : nil,
                error: status == "ok" ? nil : detail
            )
        }
        return (rows, cudaAvailable, mpsAvailable)
    }

    private static func isVersion(_ version: String?, atLeast minimum: String?) -> Bool {
        guard let minimum else { return true }
        guard let version, !version.isEmpty else { return false }
        return compareVersion(version, minimum) != .orderedAscending
    }

    private static func compareVersion(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = versionComponents(lhs)
        let right = versionComponents(rhs)
        let count = max(left.count, right.count)
        for index in 0..<count {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l < r { return .orderedAscending }
            if l > r { return .orderedDescending }
        }
        return .orderedSame
    }

    private static func versionComponents(_ value: String) -> [Int] {
        value
            .split { !$0.isNumber }
            .map { Int($0) ?? 0 }
    }

    private static func runProcess(
        executable: URL,
        arguments: [String],
        currentDirectory: URL
    ) -> (stdout: String, stderr: String) {
        do {
            let output = try SubprocessRunner.run(
                executablePath: executable.path,
                arguments: arguments,
                currentDirectoryURL: currentDirectory
            )
            return (output.stdout, output.stderr)
        } catch {
            return ("", String(describing: error))
        }
    }
}
