import Foundation

public enum CodexAppServerSessionError: Error, Equatable {
    case unexpectedMessage(String)
    case mismatchedResponseId(expected: Int, actual: Int)
}

public final class CodexAppServerSession: @unchecked Sendable {
    public let launchPlan: CodexAppServerLaunchPlan
    public let requestFactory: CodexAppServerRequestFactory
    public let process: CodexAppServerProcess

    public init(launchPlan: CodexAppServerLaunchPlan, requestFactory: CodexAppServerRequestFactory) {
        self.launchPlan = launchPlan
        self.requestFactory = requestFactory
        process = CodexAppServerProcess(launchPlan: launchPlan)
    }

    public convenience init(workspace: URL) {
        let launchPlan = CodexAppServerLaunchPlan(workspace: workspace)
        self.init(
            launchPlan: launchPlan,
            requestFactory: CodexAppServerRequestFactory(workspace: workspace)
        )
    }

    public func start() throws {
        try process.start()
    }

    public func initialize(timeout: TimeInterval = 10) throws -> CodexInitializeResponse {
        let request = requestFactory.initializeRequest(id: 1)
        try process.writeLine(CodexJSONEncoding.encodeLine(request))

        let response: CodexJSONRPCResponse<CodexInitializeResponse> = try readResponse(
            id: request.id,
            timeout: timeout
        )
        try process.writeLine(CodexJSONEncoding.encodeLine(requestFactory.initializedNotification()))
        return response.result
    }

    public func startThread(ephemeral: Bool = false, timeout: TimeInterval = 20) throws -> CodexThreadStartResponse {
        let request = requestFactory.threadStartRequest(id: 2, ephemeral: ephemeral)
        try process.writeLine(CodexJSONEncoding.encodeLine(request))

        let response: CodexJSONRPCResponse<CodexThreadStartResponse> = try readResponse(
            id: request.id,
            timeout: timeout
        )
        return response.result
    }

    public func readThread(threadID: String, includeTurns: Bool = true, timeout: TimeInterval = 20) throws -> CodexThreadReadResponse {
        let request = requestFactory.threadReadRequest(id: 3, threadID: threadID, includeTurns: includeTurns)
        try process.writeLine(CodexJSONEncoding.encodeLine(request))

        let response: CodexJSONRPCResponse<CodexThreadReadResponse> = try readResponse(
            id: request.id,
            timeout: timeout
        )
        return response.result
    }

    public func startTurn(
        threadID: String,
        text: String,
        readOnly: Bool = false,
        timeout: TimeInterval = 20
    ) throws -> CodexTurnStartResponse {
        let request = requestFactory.turnStartRequest(id: 4, threadID: threadID, text: text, readOnly: readOnly)
        try process.writeLine(CodexJSONEncoding.encodeLine(request))

        let response: CodexJSONRPCResponse<CodexTurnStartResponse> = try readResponse(
            id: request.id,
            timeout: timeout
        )
        return response.result
    }

    public func runTurnAndWait(
        threadID: String,
        text: String,
        readOnly: Bool = false,
        timeout: TimeInterval = 120
    ) throws -> CodexTurnRunSummary {
        let started = try startTurn(threadID: threadID, text: text, readOnly: readOnly, timeout: 20)
        let deadline = Date().addingTimeInterval(timeout)
        var eventMethods: [String] = []
        var events: [CodexTurnEventRecord] = []
        var assistantText = ""

        while Date() < deadline {
            let notification = try readNotification(timeout: max(0.1, deadline.timeIntervalSinceNow))
            eventMethods.append(notification.method)
            events.append(eventRecord(sequence: events.count + 1, notification: notification))
            if notification.method == "agent/message/delta" || notification.method == "item/agentMessage/delta" {
                assistantText += extractStringField("delta", from: notification.rawLine) ?? ""
            }
            if notification.method == "turn/completed" {
                let params = try decodeNotificationParams(CodexTurnCompletedParams.self, from: notification.rawLine)
                return CodexTurnRunSummary(
                    turnId: params.turn.id,
                    status: params.turn.status,
                    assistantText: assistantText.trimmingCharacters(in: .whitespacesAndNewlines),
                    eventMethods: eventMethods,
                    events: events,
                    durationMs: params.turn.durationMs
                )
            }
        }

        return CodexTurnRunSummary(
            turnId: started.turn.id,
            status: "timedOut",
            assistantText: assistantText.trimmingCharacters(in: .whitespacesAndNewlines),
            eventMethods: eventMethods,
            events: events,
            durationMs: nil
        )
    }

    public func stop() {
        process.stop()
    }

    private func readResponse<Result: Decodable & Sendable>(
        id expectedID: Int,
        timeout: TimeInterval
    ) throws -> CodexJSONRPCResponse<Result> {
        let decoder = JSONDecoder()
        let deadline = Date().addingTimeInterval(timeout)

        while Date() < deadline {
            let remaining = max(0.1, deadline.timeIntervalSinceNow)
            let line = try process.readLine(timeout: remaining)
            let data = Data(line.utf8)

            if let response = try? decoder.decode(CodexJSONRPCResponse<Result>.self, from: data) {
                guard response.id == expectedID else {
                    throw CodexAppServerSessionError.mismatchedResponseId(expected: expectedID, actual: response.id)
                }
                return response
            }

            if let error = try? decoder.decode(CodexJSONRPCErrorResponse.self, from: data) {
                throw error
            }

            if isNotification(line) {
                continue
            }

            throw CodexAppServerSessionError.unexpectedMessage(line)
        }

        throw CodexAppServerProcessError.timedOut
    }

    private func readNotification(timeout: TimeInterval) throws -> CodexServerNotification {
        let line = try process.readLine(timeout: timeout)
        guard let method = extractMethod(from: line) else {
            throw CodexAppServerSessionError.unexpectedMessage(line)
        }
        return CodexServerNotification(method: method, rawLine: line)
    }

    private func isNotification(_ line: String) -> Bool {
        extractMethod(from: line) != nil
    }

    private func extractMethod(from line: String) -> String? {
        guard let data = line.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard object["id"] == nil else { return nil }
        return object["method"] as? String
    }

    private func extractStringField(_ field: String, from line: String) -> String? {
        guard let data = line.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard let params = object["params"] as? [String: Any] else { return nil }
        return params[field] as? String
    }

    private func eventRecord(sequence: Int, notification: CodexServerNotification) -> CodexTurnEventRecord {
        CodexTurnEventRecord(
            sequence: sequence,
            method: notification.method,
            summary: eventSummary(method: notification.method, rawLine: notification.rawLine)
        )
    }

    private func eventSummary(method: String, rawLine: String) -> String {
        if method == "agent/message/delta" || method == "item/agentMessage/delta" {
            let delta = extractStringField("delta", from: rawLine) ?? ""
            if delta.isEmpty {
                return "Assistant text streamed."
            }
            return "Assistant delta: \(delta.trimmingCharacters(in: .whitespacesAndNewlines))"
        }

        if method == "turn/completed",
           let params = try? decodeNotificationParams(CodexTurnCompletedParams.self, from: rawLine) {
            let duration = params.turn.durationMs.map { " in \($0) ms" } ?? ""
            return "Turn \(params.turn.id) \(params.turn.status)\(duration)."
        }

        if let itemType = extractStringField("type", from: rawLine) {
            return "Item type: \(itemType)"
        }

        return "Received \(method)."
    }

    private func decodeNotificationParams<T: Decodable>(_ type: T.Type, from line: String) throws -> T {
        guard let data = line.data(using: .utf8) else {
            throw CodexAppServerSessionError.unexpectedMessage(line)
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let params = object["params"] else {
            throw CodexAppServerSessionError.unexpectedMessage(line)
        }
        let paramsData = try JSONSerialization.data(withJSONObject: params)
        return try JSONDecoder().decode(T.self, from: paramsData)
    }
}
