import Foundation

public struct CaptionFontRuntimeStatus: Equatable, Sendable {
    public struct Asset: Equatable, Sendable {
        public enum State: String, Equatable, Sendable {
            case ready
            case blocked
        }

        public let role: String
        public let family: String
        public let resource: String
        public let state: State
        public let diagnostic: String?

        public init(
            role: String,
            family: String,
            resource: String,
            state: State,
            diagnostic: String? = nil
        ) {
            self.role = role
            self.family = family
            self.resource = resource
            self.state = state
            self.diagnostic = diagnostic
        }
    }

    public let assets: [Asset]

    public init(assets: [Asset]) {
        self.assets = assets
    }

    public func canRenderCustomFont(family: String) -> Bool {
        assets.contains { $0.family == family && $0.state == .ready }
    }

    public func blocker(requiredFamily: String) -> CaptionApprovalReadiness.Blocker? {
        guard !canRenderCustomFont(family: requiredFamily) else { return nil }
        let matching = assets.filter { $0.family == requiredFamily }
        let detail = matching.compactMap(\.diagnostic).joined(separator: "; ")
        let suffix = detail.isEmpty ? "登録済みfontがありません。" : detail
        return CaptionApprovalReadiness.Blocker(
            code: "font_contract_mismatch",
            message: "Studioで選択font \(requiredFamily) を保証できません: \(suffix)"
        )
    }
}
