import Foundation

public enum CodexApprovalPolicy: String, Sendable {
    case untrusted
    case onFailure = "on-failure"
    case onRequest = "on-request"
    case never
}

public enum CodexApprovalsReviewer: String, Sendable {
    case user
    case autoReview = "auto_review"
}

public enum CodexSandboxMode: String, Sendable {
    case readOnly = "read-only"
    case workspaceWrite = "workspace-write"
    case dangerFullAccess = "danger-full-access"
}

public enum CodexPersonality: String, Sendable {
    case none
    case friendly
    case pragmatic
}

public enum CodexReasoningEffort: String, Sendable {
    case none
    case minimal
    case low
    case medium
    case high
    case xhigh
}

public struct CodexClientInfo: Equatable, Sendable {
    public var name: String
    public var title: String?
    public var version: String

    public init(name: String, title: String? = nil, version: String) {
        self.name = name
        self.title = title
        self.version = version
    }

    var jsonValue: CodexJSONValue {
        var object: [String: CodexJSONValue] = [
            "name": .string(name),
            "version": .string(version)
        ]
        if let title {
            object["title"] = .string(title)
        }
        return .object(object)
    }
}

public struct CodexJSONRPCRequest: Encodable, Equatable, Sendable {
    public var id: Int
    public var method: String
    public var params: CodexJSONValue?

    public init(id: Int, method: String, params: CodexJSONValue? = nil) {
        self.id = id
        self.method = method
        self.params = params
    }
}

public struct CodexJSONRPCNotification: Encodable, Equatable, Sendable {
    public var method: String
    public var params: CodexJSONValue?

    public init(method: String, params: CodexJSONValue? = nil) {
        self.method = method
        self.params = params
    }
}

public struct CodexJSONRPCResponse<Result: Decodable & Sendable>: Decodable, Sendable {
    public var id: Int
    public var result: Result
}

public struct CodexJSONRPCErrorResponse: Decodable, Error, Sendable {
    public struct ErrorBody: Decodable, Sendable {
        public var code: Int
        public var message: String
    }

    public var id: Int?
    public var error: ErrorBody
}

public struct CodexInitializeResponse: Decodable, Equatable, Sendable {
    public var codexHome: String
    public var platformFamily: String
    public var platformOs: String
    public var userAgent: String
}

public struct CodexThread: Decodable, Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var preview: String
    public var ephemeral: Bool
    public var modelProvider: String
    public var cwd: String
    public var threadSource: String?
    public var name: String?
}

public struct CodexThreadStartResponse: Decodable, Equatable, Sendable {
    public var thread: CodexThread
    public var model: String
    public var modelProvider: String
    public var cwd: String
    public var approvalPolicy: String
    public var approvalsReviewer: String
    public var reasoningEffort: String?
}

public struct CodexThreadReadResponse: Decodable, Equatable, Sendable {
    public var thread: CodexThread
}

public struct CodexTurn: Decodable, Equatable, Sendable {
    public var id: String
    public var status: String
    public var startedAt: Int?
    public var completedAt: Int?
    public var durationMs: Int?
}

public struct CodexTurnStartResponse: Decodable, Equatable, Sendable {
    public var turn: CodexTurn
}

public struct CodexTurnCompletedParams: Decodable, Equatable, Sendable {
    public var threadId: String
    public var turn: CodexTurn
}

public struct CodexServerNotification: Equatable, Sendable {
    public var method: String
    public var rawLine: String
}

public struct CodexTurnEventRecord: Identifiable, Equatable, Sendable {
    public var id: Int { sequence }
    public var sequence: Int
    public var method: String
    public var summary: String
}

public struct CodexTurnRunSummary: Equatable, Sendable {
    public var turnId: String
    public var status: String
    public var assistantText: String
    public var eventMethods: [String]
    public var events: [CodexTurnEventRecord]
    public var durationMs: Int?
}

public struct CodexAppServerRequestFactory: Sendable {
    public var clientInfo: CodexClientInfo
    public var workspace: URL
    public var serviceName: String
    public var model: String?
    public var reasoningEffort: CodexReasoningEffort

    public init(
        clientInfo: CodexClientInfo = CodexClientInfo(name: "video-os-studio", title: "Video OS Studio", version: "0.1.0"),
        workspace: URL,
        serviceName: String = "video_os_studio",
        model: String? = nil,
        reasoningEffort: CodexReasoningEffort = .medium
    ) {
        self.clientInfo = clientInfo
        self.workspace = workspace
        self.serviceName = serviceName
        self.model = model
        self.reasoningEffort = reasoningEffort
    }

    public func initializeRequest(id: Int = 1) -> CodexJSONRPCRequest {
        return CodexJSONRPCRequest(
            id: id,
            method: "initialize",
            params: .object([
                "clientInfo": clientInfo.jsonValue,
                "capabilities": .object([
                    "experimentalApi": .bool(true)
                ])
            ])
        )
    }

    public func initializedNotification() -> CodexJSONRPCNotification {
        CodexJSONRPCNotification(method: "initialized", params: .object([:]))
    }

    public func threadStartRequest(
        id: Int,
        ephemeral: Bool = false,
        developerInstructions: String? = nil
    ) -> CodexJSONRPCRequest {
        var params: [String: CodexJSONValue] = [
            "approvalPolicy": .string(CodexApprovalPolicy.onRequest.rawValue),
            "approvalsReviewer": .string(CodexApprovalsReviewer.user.rawValue),
            "cwd": .string(workspace.path),
            "ephemeral": .bool(ephemeral),
            "personality": .string(CodexPersonality.pragmatic.rawValue),
            "sandbox": .string(CodexSandboxMode.workspaceWrite.rawValue),
            "serviceName": .string(serviceName),
            "threadSource": .string("user")
        ]

        if let model {
            params["model"] = .string(model)
        }
        if let developerInstructions {
            params["developerInstructions"] = .string(developerInstructions)
        }

        return CodexJSONRPCRequest(id: id, method: "thread/start", params: .object(params))
    }

    public func turnStartRequest(
        id: Int,
        threadID: String,
        text: String,
        readOnly: Bool = false
    ) -> CodexJSONRPCRequest {
        let sandboxPolicy: CodexJSONValue = readOnly
            ? .object([
                "type": .string("readOnly"),
                "networkAccess": .bool(false)
            ])
            : .object([
                "type": .string("workspaceWrite"),
                "networkAccess": .bool(true),
                "writableRoots": .array([.string(workspace.path)])
            ])

        return CodexJSONRPCRequest(
            id: id,
            method: "turn/start",
            params: .object([
                "approvalPolicy": .string(CodexApprovalPolicy.onRequest.rawValue),
                "approvalsReviewer": .string(CodexApprovalsReviewer.user.rawValue),
                "cwd": .string(workspace.path),
                "effort": .string(reasoningEffort.rawValue),
                "input": .array([
                    .object([
                        "type": .string("text"),
                        "text": .string(text)
                    ])
                ]),
                "sandboxPolicy": sandboxPolicy,
                "threadId": .string(threadID)
            ])
        )
    }

    public func threadReadRequest(id: Int, threadID: String, includeTurns: Bool = true) -> CodexJSONRPCRequest {
        CodexJSONRPCRequest(
            id: id,
            method: "thread/read",
            params: .object([
                "threadId": .string(threadID),
                "includeTurns": .bool(includeTurns)
            ])
        )
    }
}

public enum CodexJSONEncoding {
    public static func encodeLine<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard let json = String(data: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(value, EncodingError.Context(codingPath: [], debugDescription: "Unable to encode UTF-8 JSON"))
        }
        return json + "\n"
    }
}
