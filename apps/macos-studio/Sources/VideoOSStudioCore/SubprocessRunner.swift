import Foundation

/// Shared subprocess execution with concurrent pipe draining.
///
/// The previous per-runner pattern — `waitUntilExit()` followed by
/// `readDataToEndOfFile()` — deadlocks as soon as a child writes more than
/// the ~64KB pipe buffer before exiting: the child blocks on write, the
/// parent blocks on exit, and nothing ever completes. Live Marlin
/// evaluation hit exactly this (transformers progress bars alone overflow
/// the buffer). Every runner must drain stdout/stderr WHILE the child is
/// running, which this helper does on background readability handlers.
public enum SubprocessRunner {
    public struct Output: Equatable, Sendable {
        public let exitCode: Int32
        public let stdout: String
        public let stderr: String
    }

    public static func run(
        executablePath: String = "/usr/bin/env",
        arguments: [String],
        currentDirectoryURL: URL? = nil,
        environment: [String: String]? = nil,
    ) throws -> Output {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        if let currentDirectoryURL {
            process.currentDirectoryURL = currentDirectoryURL
        }
        if let environment {
            process.environment = environment
        }

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        // Drain both pipes concurrently while the child runs.
        let lock = NSLock()
        var stdoutData = Data()
        var stderrData = Data()

        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            lock.lock()
            stdoutData.append(chunk)
            lock.unlock()
        }
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            lock.lock()
            stderrData.append(chunk)
            lock.unlock()
        }

        try process.run()
        process.waitUntilExit()

        // Stop the handlers, then collect any bytes still buffered in the
        // pipes after exit.
        outputPipe.fileHandleForReading.readabilityHandler = nil
        errorPipe.fileHandleForReading.readabilityHandler = nil
        let stdoutTail = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrTail = errorPipe.fileHandleForReading.readDataToEndOfFile()

        lock.lock()
        if !stdoutTail.isEmpty { stdoutData.append(stdoutTail) }
        if !stderrTail.isEmpty { stderrData.append(stderrTail) }
        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""
        lock.unlock()

        return Output(
            exitCode: process.terminationStatus,
            stdout: stdout,
            stderr: stderr,
        )
    }
}
