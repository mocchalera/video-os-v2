public enum TimelineClipSelectionPublishing {
    public static func clearedSelectionIDs() -> Set<TimelineClip.ID> {
        []
    }

    public static func singleSelectionIDs(primaryID: TimelineClip.ID?) -> Set<TimelineClip.ID> {
        primaryID.map { [$0] } ?? []
    }

    public static func shouldPublish(
        currentPrimaryID: TimelineClip.ID?,
        currentSelectedIDs: Set<TimelineClip.ID>,
        nextPrimaryID: TimelineClip.ID?,
        nextSelectedIDs: Set<TimelineClip.ID>
    ) -> Bool {
        currentPrimaryID != nextPrimaryID || currentSelectedIDs != nextSelectedIDs
    }
}
