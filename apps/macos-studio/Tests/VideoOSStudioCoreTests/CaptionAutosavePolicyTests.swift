import AppKit
import XCTest
@testable import VideoOSStudioCore

final class CaptionAutosavePolicyTests: XCTestCase {
    func testJapaneseIMECompositionAlwaysSuppressesAutosave() {
        XCTAssertFalse(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: true,
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: false,
            hasConflict: false,
            requiresManualConflictSave: false,
            hasSelectedCaption: true
        ))
    }

    func testAppKitMarkedTextFeedsTheCompositionGate() {
        let textView = NSTextView()
        textView.setMarkedText(
            "にほんご",
            selectedRange: NSRange(location: 4, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0)
        )

        XCTAssertTrue(textView.hasMarkedText())
        XCTAssertFalse(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: textView.hasMarkedText(),
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: false,
            hasConflict: false,
            requiresManualConflictSave: false,
            hasSelectedCaption: true
        ))

        textView.unmarkText()
        XCTAssertFalse(textView.hasMarkedText())
        XCTAssertTrue(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: textView.hasMarkedText(),
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: false,
            hasConflict: false,
            requiresManualConflictSave: false,
            hasSelectedCaption: true
        ))
    }

    func testCommittedTextSchedulesAutosaveWhenOtherGatesAreOpen() {
        XCTAssertTrue(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: false,
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: false,
            hasConflict: false,
            requiresManualConflictSave: false,
            hasSelectedCaption: true
        ))
    }

    func testConflictManualSaveAndBusyStatesRemainSuppressed() {
        XCTAssertFalse(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: false,
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: true,
            hasConflict: false,
            requiresManualConflictSave: false,
            hasSelectedCaption: true
        ))
        XCTAssertFalse(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: false,
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: false,
            hasConflict: true,
            requiresManualConflictSave: false,
            hasSelectedCaption: true
        ))
        XCTAssertFalse(CaptionAutosavePolicy.shouldSchedule(
            isCompositionActive: false,
            isAutosaveEnabled: true,
            hasUnsavedChange: true,
            isBusy: false,
            hasConflict: false,
            requiresManualConflictSave: true,
            hasSelectedCaption: true
        ))
    }
}
