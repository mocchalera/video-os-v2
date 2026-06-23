import Foundation

public enum CodexAppServerTransport: String, CaseIterable, Sendable {
    case stdio
    case websocket
    case unixSocket

    public var listenURL: String {
        switch self {
        case .stdio:
            return "stdio://"
        case .websocket:
            return "ws://127.0.0.1:8765"
        case .unixSocket:
            return "unix://"
        }
    }
}

public struct CodexAppServerTransportSettingsOption: Equatable, Identifiable, Sendable {
    public var id: String { rawValue }
    public let rawValue: String
    public let label: String

    public init(transport: CodexAppServerTransport) {
        rawValue = transport.rawValue
        label = transport.rawValue
    }
}

public struct CodexAppServerLaunchPlan: Equatable, Sendable {
    public var executable: String
    public var transport: CodexAppServerTransport
    public var workspace: URL
    public var port: Int?
    public var tokenFile: URL?

    public init(
        executable: String = "codex",
        transport: CodexAppServerTransport = .stdio,
        workspace: URL,
        port: Int? = nil,
        tokenFile: URL? = nil
    ) {
        self.executable = executable
        self.transport = transport
        self.workspace = workspace
        self.port = port
        self.tokenFile = tokenFile
    }

    public var displayName: String {
        switch transport {
        case .stdio:
            return "stdio"
        case .websocket:
            return "WebSocket"
        case .unixSocket:
            return "Unix socket"
        }
    }

    public var listenURL: String {
        switch transport {
        case .stdio:
            return "stdio://"
        case .websocket:
            let resolvedPort = port ?? 8765
            return "ws://127.0.0.1:\(resolvedPort)"
        case .unixSocket:
            return "unix://"
        }
    }

    public var arguments: [String] {
        var args = ["app-server", "--listen", listenURL]

        switch transport {
        case .stdio:
            break
        case .websocket:
            if let tokenFile {
                args.append(contentsOf: ["--ws-auth", "capability-token"])
                args.append(contentsOf: ["--ws-token-file", tokenFile.path])
            }
        case .unixSocket:
            break
        }

        return args
    }

    public var environmentDescription: String {
        "cwd=\(workspace.path) \(([executable] + arguments).joined(separator: " "))"
    }
}

public enum CodexAppServerTransportPreferences {
    public static let storageKey = "videoOSStudioPreferredTransport"
    public static let settingsDescription = "Initial builds use stdio. WebSocket and Unix socket modes are reserved for embedded runtime and packaged app flows."
    public static var settingsOptions: [CodexAppServerTransportSettingsOption] {
        CodexAppServerTransport.allCases.map(CodexAppServerTransportSettingsOption.init)
    }

    public static func preferredTransport(defaults: UserDefaults = .standard) -> CodexAppServerTransport {
        guard
            let rawValue = defaults.string(forKey: storageKey),
            let transport = CodexAppServerTransport(rawValue: rawValue)
        else {
            return .stdio
        }
        return transport
    }

    public static func launchPlan(
        workspace: URL,
        defaults: UserDefaults = .standard
    ) -> CodexAppServerLaunchPlan {
        CodexAppServerLaunchPlan(
            transport: preferredTransport(defaults: defaults),
            workspace: workspace
        )
    }
}

public enum StudioAgentSurface: String, CaseIterable, Identifiable, Sendable {
    case ingest = "素材解析"
    case intent = "意図整理"
    case triage = "候補抽出"
    case blueprint = "構成設計"
    case compile = "粗編集"
    case review = "自己レビュー"
    case package = "納品"

    public var id: String { rawValue }

    public var commandName: String {
        switch self {
        case .ingest:
            return "/analyze"
        case .intent:
            return "/intent"
        case .triage:
            return "/triage"
        case .blueprint:
            return "/blueprint"
        case .compile:
            return "/compile"
        case .review:
            return "/review"
        case .package:
            return "/render"
        }
    }
}
