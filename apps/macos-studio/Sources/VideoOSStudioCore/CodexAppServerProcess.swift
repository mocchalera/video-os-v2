import Foundation

public enum CodexAppServerProcessError: Error, Equatable {
    case alreadyRunning
    case notRunning
    case timedOut
    case outputClosed
}

public final class CodexAppServerProcess: @unchecked Sendable {
    public let launchPlan: CodexAppServerLaunchPlan
    private var process: Process?
    private var standardInput: Pipe?
    private var standardOutput: Pipe?
    private var standardError: Pipe?
    private let outputLock = NSLock()
    private let outputSemaphore = DispatchSemaphore(value: 0)
    private var outputBuffer = Data()
    private var outputLines: [String] = []
    private var outputClosed = false
    private let diagnosticsLock = NSLock()
    private var diagnostics: [String] = []

    public init(launchPlan: CodexAppServerLaunchPlan) {
        self.launchPlan = launchPlan
    }

    public var isRunning: Bool {
        process?.isRunning == true
    }

    public func start() throws {
        guard process == nil else {
            throw CodexAppServerProcessError.alreadyRunning
        }

        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [launchPlan.executable] + launchPlan.arguments
        process.currentDirectoryURL = launchPlan.workspace
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        try process.run()

        self.process = process
        standardInput = inputPipe
        standardOutput = outputPipe
        standardError = errorPipe
        attachOutputHandler(to: outputPipe)
        attachDiagnosticHandler(to: errorPipe)
    }

    public func writeLine(_ line: String) throws {
        guard let standardInput else {
            throw CodexAppServerProcessError.notRunning
        }

        let data = Data(line.utf8)
        try standardInput.fileHandleForWriting.write(contentsOf: data)
    }

    public func readLine(timeout: TimeInterval) throws -> String {
        outputLock.lock()
        if !outputLines.isEmpty {
            let line = outputLines.removeFirst()
            _ = outputSemaphore.wait(timeout: .now())
            outputLock.unlock()
            return line
        }
        let closed = outputClosed
        outputLock.unlock()

        if closed {
            throw CodexAppServerProcessError.outputClosed
        }

        let deadline = DispatchTime.now() + timeout
        guard outputSemaphore.wait(timeout: deadline) == .success else {
            throw CodexAppServerProcessError.timedOut
        }

        outputLock.lock()
        defer { outputLock.unlock() }
        if !outputLines.isEmpty {
            return outputLines.removeFirst()
        }
        if outputClosed {
            throw CodexAppServerProcessError.outputClosed
        }
        throw CodexAppServerProcessError.timedOut
    }

    public func recentDiagnostics() -> [String] {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return diagnostics
    }

    public func stop() {
        standardOutput?.fileHandleForReading.readabilityHandler = nil
        standardError?.fileHandleForReading.readabilityHandler = nil
        process?.terminate()
        process = nil
        standardInput = nil
        standardOutput = nil
        standardError = nil
    }

    private func attachOutputHandler(to pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            guard !data.isEmpty else {
                self.outputLock.lock()
                self.outputClosed = true
                self.outputLock.unlock()
                self.outputSemaphore.signal()
                return
            }

            self.outputLock.lock()
            self.outputBuffer.append(data)
            while let newline = self.outputBuffer.firstIndex(of: 0x0A) {
                let lineData = self.outputBuffer[..<newline]
                self.outputBuffer.removeSubrange(...newline)
                if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                    self.outputLines.append(line)
                    self.outputSemaphore.signal()
                }
            }
            self.outputLock.unlock()
        }
    }

    private func attachDiagnosticHandler(to pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            guard !data.isEmpty else { return }
            guard let text = String(data: data, encoding: .utf8) else { return }
            self.diagnosticsLock.lock()
            self.diagnostics.append(contentsOf: text.split(separator: "\n").map(String.init))
            if self.diagnostics.count > 50 {
                self.diagnostics.removeFirst(self.diagnostics.count - 50)
            }
            self.diagnosticsLock.unlock()
        }
    }
}
