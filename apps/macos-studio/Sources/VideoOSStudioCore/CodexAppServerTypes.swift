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

public enum StudioProductStage: String, CaseIterable, Identifiable, Sendable {
    case brief = "Brief"
    case sources = "Sources"
    case story = "Story"
    case cut = "Cut"
    case review = "Review"
    case export = "Export"

    public var id: String { rawValue }

    public var localizedTitle: String {
        switch self {
        case .brief: return "目的"
        case .sources: return "素材"
        case .story: return "構成"
        case .cut: return "編集"
        case .review: return "確認"
        case .export: return "出力"
        }
    }

    public var systemImage: String {
        switch self {
        case .brief: return "doc.text"
        case .sources: return "film.stack"
        case .story: return "rectangle.connected.to.line.below"
        case .cut: return "timeline.selection"
        case .review: return "checkmark.bubble"
        case .export: return "square.and.arrow.up"
        }
    }

    public static func stage(for surface: StudioAgentSurface) -> StudioProductStage {
        switch surface {
        case .intent: return .brief
        case .ingest, .triage: return .sources
        case .blueprint: return .story
        case .compile: return .cut
        case .review: return .review
        case .package: return .export
        }
    }

    public func preferredSurface(analysisReady: Bool) -> StudioAgentSurface {
        switch self {
        case .brief: return .intent
        case .sources: return analysisReady ? .triage : .ingest
        case .story: return .blueprint
        case .cut: return .compile
        case .review: return .review
        case .export: return .package
        }
    }

    public static func preferredSurface(
        projectState: String,
        hasTimeline: Bool,
        hasReview: Bool
    ) -> StudioAgentSurface {
        switch projectState {
        case "packaged":
            return .package
        case "approved", "critique_ready":
            return .review
        case "timeline_drafted":
            return .compile
        case "blueprint_ready", "selects_ready":
            return .blueprint
        case "media_analyzed", "intent_locked":
            return .ingest
        case "intent_pending":
            return .intent
        default:
            if hasReview { return .review }
            if hasTimeline { return .compile }
            return .intent
        }
    }
}

public enum StudioAgentSurfacePublishing {
    public static func shouldPublish(
        previous: StudioAgentSurface,
        next: StudioAgentSurface
    ) -> Bool {
        previous != next
    }
}
