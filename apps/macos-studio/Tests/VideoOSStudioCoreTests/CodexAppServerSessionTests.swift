import XCTest
@testable import VideoOSStudioCore

final class CodexAppServerSessionTests: XCTestCase {
    func testJSONRPCResponseDecodesInitializeResult() throws {
        let json = """
        {"id":1,"result":{"userAgent":"Codex Desktop/0.131.0","codexHome":"/Users/operator/.codex","platformFamily":"unix","platformOs":"macos"}}
        """
        let response = try JSONDecoder().decode(CodexJSONRPCResponse<CodexInitializeResponse>.self, from: Data(json.utf8))

        XCTAssertEqual(response.id, 1)
        XCTAssertEqual(response.result.codexHome, "/Users/operator/.codex")
        XCTAssertEqual(response.result.platformOs, "macos")
    }

    func testJSONRPCErrorResponseDecodesMessage() throws {
        let json = #"{"id":1,"error":{"code":-32600,"message":"invalid request"}}"#
        let response = try JSONDecoder().decode(CodexJSONRPCErrorResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.id, 1)
        XCTAssertEqual(response.error.code, -32600)
        XCTAssertEqual(response.error.message, "invalid request")
    }

    func testThreadStartResponseDecodesMinimalFields() throws {
        let json = """
        {"id":2,"result":{"thread":{"id":"thread-1","sessionId":"thread-1","forkedFromId":null,"preview":"","ephemeral":true,"modelProvider":"openai","createdAt":1,"updatedAt":1,"status":{"type":"idle"},"path":null,"cwd":"/tmp/video-os","cliVersion":"0.131.0","source":"vscode","threadSource":"user","agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"gpt-5.5","modelProvider":"openai","serviceTier":null,"cwd":"/tmp/video-os","instructionSources":[],"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false},"reasoningEffort":"high"}}
        """
        let response = try JSONDecoder().decode(CodexJSONRPCResponse<CodexThreadStartResponse>.self, from: Data(json.utf8))

        XCTAssertEqual(response.result.thread.id, "thread-1")
        XCTAssertEqual(response.result.thread.ephemeral, true)
        XCTAssertEqual(response.result.thread.cwd, "/tmp/video-os")
        XCTAssertEqual(response.result.model, "gpt-5.5")
        XCTAssertEqual(response.result.approvalPolicy, "on-request")
    }

    func testThreadReadResponseDecodesThread() throws {
        let json = """
        {"id":3,"result":{"thread":{"id":"thread-1","sessionId":"thread-1","forkedFromId":null,"preview":"","ephemeral":false,"modelProvider":"openai","createdAt":1,"updatedAt":1,"status":{"type":"idle"},"path":null,"cwd":"/tmp/video-os","cliVersion":"0.131.0","source":"vscode","threadSource":"user","agentNickname":null,"agentRole":null,"gitInfo":null,"name":"Video OS","turns":[]}}}
        """
        let response = try JSONDecoder().decode(CodexJSONRPCResponse<CodexThreadReadResponse>.self, from: Data(json.utf8))

        XCTAssertEqual(response.result.thread.id, "thread-1")
        XCTAssertEqual(response.result.thread.name, "Video OS")
        XCTAssertEqual(response.result.thread.ephemeral, false)
    }

    func testTurnStartAndCompletionResponsesDecode() throws {
        let startJSON = """
        {"id":4,"result":{"turn":{"id":"turn-1","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
        """
        let completeJSON = """
        {"threadId":"thread-1","turn":{"id":"turn-1","items":[],"itemsView":"notLoaded","status":"completed","error":null,"startedAt":1,"completedAt":2,"durationMs":1000}}
        """

        let start = try JSONDecoder().decode(CodexJSONRPCResponse<CodexTurnStartResponse>.self, from: Data(startJSON.utf8))
        let completed = try JSONDecoder().decode(CodexTurnCompletedParams.self, from: Data(completeJSON.utf8))

        XCTAssertEqual(start.result.turn.id, "turn-1")
        XCTAssertEqual(start.result.turn.status, "inProgress")
        XCTAssertEqual(completed.turn.status, "completed")
        XCTAssertEqual(completed.threadId, "thread-1")
    }
}
