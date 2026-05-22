import XCTest
@testable import VideoOSStudioCore

final class CodexAppServerProtocolTests: XCTestCase {
    func testLaunchPlanUsesListenURLAndWorkspaceAsProcessCWD() {
        let root = URL(fileURLWithPath: "/tmp/video-os")
        let plan = CodexAppServerLaunchPlan(transport: .stdio, workspace: root)

        XCTAssertEqual(plan.arguments, ["app-server", "--listen", "stdio://"])
        XCTAssertTrue(plan.environmentDescription.contains("cwd=/tmp/video-os"))
    }

    func testWebSocketLaunchPlanUsesCapabilityTokenWhenProvided() {
        let root = URL(fileURLWithPath: "/tmp/video-os")
        let token = URL(fileURLWithPath: "/tmp/video-os/token.txt")
        let plan = CodexAppServerLaunchPlan(transport: .websocket, workspace: root, port: 8765, tokenFile: token)

        XCTAssertEqual(plan.listenURL, "ws://127.0.0.1:8765")
        XCTAssertEqual(plan.arguments, [
            "app-server",
            "--listen",
            "ws://127.0.0.1:8765",
            "--ws-auth",
            "capability-token",
            "--ws-token-file",
            "/tmp/video-os/token.txt"
        ])
    }

    func testThreadStartRequestUsesCodexNativeSafetyDefaults() throws {
        let root = URL(fileURLWithPath: "/tmp/video-os")
        let factory = CodexAppServerRequestFactory(workspace: root)
        let line = try CodexJSONEncoding.encodeLine(factory.threadStartRequest(id: 7))
        let object = try XCTUnwrap(parseJSONObject(line))
        let params = try XCTUnwrap(object["params"] as? [String: Any])

        XCTAssertEqual(object["id"] as? Int, 7)
        XCTAssertEqual(object["method"] as? String, "thread/start")
        XCTAssertEqual(params["cwd"] as? String, "/tmp/video-os")
        XCTAssertEqual(params["approvalPolicy"] as? String, "on-request")
        XCTAssertEqual(params["approvalsReviewer"] as? String, "user")
        XCTAssertEqual(params["sandbox"] as? String, "workspace-write")
        XCTAssertEqual(params["threadSource"] as? String, "user")
        XCTAssertEqual(params["serviceName"] as? String, "video_os_studio")
    }

    func testTurnStartRequestUsesWorkspaceWriteSandboxPolicy() throws {
        let root = URL(fileURLWithPath: "/tmp/video-os")
        let factory = CodexAppServerRequestFactory(workspace: root, reasoningEffort: .high)
        let line = try CodexJSONEncoding.encodeLine(
            factory.turnStartRequest(id: 8, threadID: "thread-1", text: "Run /status.")
        )
        let object = try XCTUnwrap(parseJSONObject(line))
        let params = try XCTUnwrap(object["params"] as? [String: Any])
        let input = try XCTUnwrap(params["input"] as? [[String: Any]])
        let firstInput = try XCTUnwrap(input.first)
        let sandboxPolicy = try XCTUnwrap(params["sandboxPolicy"] as? [String: Any])

        XCTAssertEqual(object["method"] as? String, "turn/start")
        XCTAssertEqual(params["threadId"] as? String, "thread-1")
        XCTAssertEqual(params["effort"] as? String, "high")
        XCTAssertEqual(firstInput["type"] as? String, "text")
        XCTAssertEqual(firstInput["text"] as? String, "Run /status.")
        XCTAssertEqual(sandboxPolicy["type"] as? String, "workspaceWrite")
        XCTAssertEqual(sandboxPolicy["networkAccess"] as? Bool, true)
    }

    func testTurnStartRequestCanUseReadOnlySandboxPolicy() throws {
        let root = URL(fileURLWithPath: "/tmp/video-os")
        let factory = CodexAppServerRequestFactory(workspace: root)
        let line = try CodexJSONEncoding.encodeLine(
            factory.turnStartRequest(id: 8, threadID: "thread-1", text: "No tools.", readOnly: true)
        )
        let object = try XCTUnwrap(parseJSONObject(line))
        let params = try XCTUnwrap(object["params"] as? [String: Any])
        let sandboxPolicy = try XCTUnwrap(params["sandboxPolicy"] as? [String: Any])

        XCTAssertEqual(sandboxPolicy["type"] as? String, "readOnly")
        XCTAssertEqual(sandboxPolicy["networkAccess"] as? Bool, false)
        XCTAssertNil(sandboxPolicy["writableRoots"])
    }

    func testThreadReadIncludesTurnsByDefault() throws {
        let root = URL(fileURLWithPath: "/tmp/video-os")
        let factory = CodexAppServerRequestFactory(workspace: root)
        let line = try CodexJSONEncoding.encodeLine(factory.threadReadRequest(id: 9, threadID: "thread-1"))
        let object = try XCTUnwrap(parseJSONObject(line))
        let params = try XCTUnwrap(object["params"] as? [String: Any])

        XCTAssertEqual(object["method"] as? String, "thread/read")
        XCTAssertEqual(params["threadId"] as? String, "thread-1")
        XCTAssertEqual(params["includeTurns"] as? Bool, true)
    }

    private func parseJSONObject(_ line: String) throws -> [String: Any]? {
        let data = Data(line.utf8)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
