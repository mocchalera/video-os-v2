import Foundation

public struct StudioPatchEnvelope: Codable, Equatable, Sendable {
    public let studio_version: String
    public let project_id: String
    public let created_at: String
    public let source: String
    public let base_timeline_hash: String
    public let base_timeline_version: String
    public let patch: ReviewPatchDocument
    public let ui_state: StudioUIState

    public init(
        studio_version: String = "1",
        project_id: String,
        created_at: String,
        source: String = "studio_ui",
        base_timeline_hash: String,
        base_timeline_version: String,
        patch: ReviewPatchDocument,
        ui_state: StudioUIState
    ) {
        self.studio_version = studio_version
        self.project_id = project_id
        self.created_at = created_at
        self.source = source
        self.base_timeline_hash = base_timeline_hash
        self.base_timeline_version = base_timeline_version
        self.patch = patch
        self.ui_state = ui_state
    }
}

public struct StudioUIState: Codable, Equatable, Sendable {
    public let approved_clip_ids: [String]
    public let rejected_clip_ids: [String]

    public init(approved_clip_ids: [String], rejected_clip_ids: [String]) {
        self.approved_clip_ids = approved_clip_ids
        self.rejected_clip_ids = rejected_clip_ids
    }
}
