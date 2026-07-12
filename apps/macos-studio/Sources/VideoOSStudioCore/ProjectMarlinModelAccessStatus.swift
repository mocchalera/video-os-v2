import Foundation

public struct ProjectMarlinModelAccessStatus: Equatable, Sendable {
    public let repositoryRoot: URL
    public let pythonBinary: String
    public let repoID: String
    public let hasToken: Bool
    public let checkedAccess: Bool
    public let accessAllowed: Bool
    public let error: String?
    public let stderr: String

    public var isReadyForLiveMarlin: Bool {
        hasToken && checkedAccess && accessAllowed
    }

    public var readinessLabel: String {
        if !hasToken { return "HF_TOKEN missing" }
        if !checkedAccess { return "model access unchecked" }
        if accessAllowed { return "model access ready" }
        return "model access denied"
    }

    public var recommendation: String {
        if isReadyForLiveMarlin {
            return "Run live Marlin evaluation on the representative queue."
        }
        if !hasToken {
            return "Accept NemoStation/Marlin-2B access on Hugging Face, then set HF_TOKEN in .env.local."
        }
        return "Verify the HF_TOKEN belongs to an account with accepted NemoStation/Marlin-2B gated model access."
    }
}

public enum ProjectMarlinModelAccessStatusReader {
    public static let defaultRepoID = "NemoStation/Marlin-2B"

    public static func uncheckedStatus(
        repositoryRoot: URL,
        pythonBinary: String? = nil,
        repoID: String = defaultRepoID
    ) -> ProjectMarlinModelAccessStatus {
        ProjectMarlinModelAccessStatus(
            repositoryRoot: repositoryRoot,
            pythonBinary: pythonBinary ?? ProjectMarlinRuntimeStatusReader.defaultPythonBinary(repositoryRoot: repositoryRoot),
            repoID: repoID,
            hasToken: huggingFaceToken(repositoryRoot: repositoryRoot) != nil,
            checkedAccess: false,
            accessAllowed: false,
            error: nil,
            stderr: ""
        )
    }

    public static func status(
        repositoryRoot: URL,
        pythonBinary: String? = nil,
        repoID: String = defaultRepoID
    ) -> ProjectMarlinModelAccessStatus {
        let resolvedPython = pythonBinary ?? ProjectMarlinRuntimeStatusReader.defaultPythonBinary(repositoryRoot: repositoryRoot)
        guard let token = huggingFaceToken(repositoryRoot: repositoryRoot), !token.isEmpty else {
            return ProjectMarlinModelAccessStatus(
                repositoryRoot: repositoryRoot,
                pythonBinary: resolvedPython,
                repoID: repoID,
                hasToken: false,
                checkedAccess: false,
                accessAllowed: false,
                error: nil,
                stderr: ""
            )
        }

        let result = runProcess(
            executable: URL(fileURLWithPath: "/usr/bin/env"),
            arguments: [resolvedPython, "-c", pythonProbeScript(repoID: repoID)],
            currentDirectory: repositoryRoot,
            environment: ["HF_TOKEN": token]
        )
        return status(
            repositoryRoot: repositoryRoot,
            pythonBinary: resolvedPython,
            repoID: repoID,
            hasToken: true,
            probeOutput: result.stdout,
            stderr: result.stderr
        )
    }

    public static func status(
        repositoryRoot: URL,
        pythonBinary: String,
        repoID: String = defaultRepoID,
        hasToken: Bool,
        probeOutput: String,
        stderr: String = ""
    ) -> ProjectMarlinModelAccessStatus {
        var checkedAccess = false
        var accessAllowed = false
        var error: String?
        for line in probeOutput.components(separatedBy: .newlines) {
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 2, parts[0] == "access" else { continue }
            checkedAccess = true
            accessAllowed = parts[1] == "ok"
            if !accessAllowed {
                error = parts.dropFirst(2).joined(separator: "\t")
            }
        }
        if hasToken && !checkedAccess && !stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ProjectMarlinModelAccessStatus(
            repositoryRoot: repositoryRoot,
            pythonBinary: pythonBinary,
            repoID: repoID,
            hasToken: hasToken,
            checkedAccess: checkedAccess,
            accessAllowed: accessAllowed,
            error: error,
            stderr: stderr
        )
    }

    public static func huggingFaceToken(repositoryRoot: URL) -> String? {
        if let token = ProcessInfo.processInfo.environment["HF_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            return token
        }
        let envURL = repositoryRoot.appendingPathComponent(".env.local")
        guard let env = try? String(contentsOf: envURL, encoding: .utf8) else {
            return nil
        }
        for rawLine in env.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.hasPrefix("#"), line.hasPrefix("HF_TOKEN=") else {
                continue
            }
            let value = String(line.dropFirst("HF_TOKEN=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
        return nil
    }

    private static func pythonProbeScript(repoID: String) -> String {
        """
        import os
        from huggingface_hub import get_hf_file_metadata, hf_hub_url
        repo_id = \(pythonStringLiteral(repoID))
        token = os.environ.get("HF_TOKEN", "")
        try:
            url = hf_hub_url(repo_id=repo_id, filename="config.json")
            get_hf_file_metadata(url, token=token)
            print(f"access\\tok\\t{repo_id}")
        except Exception as exc:
            message = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
            print(f"access\\tfailed\\t{type(exc).__name__}: {message}")
        """
    }

    private static func pythonStringLiteral(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }

    private struct ProcessResult {
        let stdout: String
        let stderr: String
    }

    private static func runProcess(
        executable: URL,
        arguments: [String],
        currentDirectory: URL,
        environment: [String: String]
    ) -> ProcessResult {
        do {
            let output = try SubprocessRunner.run(
                executablePath: executable.path,
                arguments: arguments,
                currentDirectoryURL: currentDirectory,
                environment: ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
            )
            return ProcessResult(stdout: output.stdout, stderr: output.stderr)
        } catch {
            return ProcessResult(stdout: "", stderr: String(describing: error))
        }
    }
}
