import Foundation

public enum CaptionAutosavePolicy {
    public static func shouldSchedule(
        isCompositionActive: Bool,
        isAutosaveEnabled: Bool,
        hasUnsavedChange: Bool,
        isBusy: Bool,
        hasConflict: Bool,
        requiresManualConflictSave: Bool,
        hasSelectedCaption: Bool
    ) -> Bool {
        !isCompositionActive &&
            isAutosaveEnabled &&
            hasUnsavedChange &&
            !isBusy &&
            !hasConflict &&
            !requiresManualConflictSave &&
            hasSelectedCaption
    }
}
