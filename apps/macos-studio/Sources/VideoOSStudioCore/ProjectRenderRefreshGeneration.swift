import Foundation

public struct ProjectRenderRefreshToken: Equatable, Sendable {
    public let projectID: String
    public let generation: UInt64

    public init(projectID: String, generation: UInt64) {
        self.projectID = projectID
        self.generation = generation
    }
}

public struct ProjectRenderRefreshGeneration: Equatable, Sendable {
    private var generation: UInt64 = 0

    public init() {}

    public mutating func issue(projectID: String) -> ProjectRenderRefreshToken {
        generation &+= 1
        return ProjectRenderRefreshToken(projectID: projectID, generation: generation)
    }

    public func isCurrent(
        _ token: ProjectRenderRefreshToken,
        selectedProjectID: String?
    ) -> Bool {
        token.generation == generation && token.projectID == selectedProjectID
    }
}
