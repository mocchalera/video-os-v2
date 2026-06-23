import SwiftUI
import VideoOSStudioCore

struct FeedbackStatusBar: View {
    @ObservedObject var feedbackSession: StudioFeedbackSession
    var statusMessage: String
    var canPromote: Bool
    var canUndo: Bool
    var onApplyAndPreview: () -> Void
    var onPromote: () -> Void
    var onUndo: () -> Void
    var onDiscard: () -> Void

    private var conflicts: [PatchConflict] {
        feedbackSession.detectConflicts()
    }

    var body: some View {
        HStack(spacing: 14) {
            Label("\(feedbackSession.pendingOps.count) changes pending", systemImage: "slider.horizontal.3")
                .foregroundStyle(feedbackSession.isDirty ? Color.primary : Color.secondary)
                .accessibilityIdentifier("FeedbackStatus.PendingCount")
            Label("\(feedbackSession.approvedClipIDs.count) approved", systemImage: "checkmark.circle.fill")
                .foregroundStyle(feedbackSession.approvedClipIDs.isEmpty ? Color.secondary : Color.green)
                .accessibilityIdentifier("FeedbackStatus.ApprovedCount")
            Label("\(feedbackSession.rejectedClipIDs.count) rejected", systemImage: "xmark.circle.fill")
                .foregroundStyle(feedbackSession.rejectedClipIDs.isEmpty ? Color.secondary : Color.red)
                .accessibilityIdentifier("FeedbackStatus.RejectedCount")
            Label("\(feedbackSession.pendingSwapCount) swapped", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(feedbackSession.pendingSwapCount == 0 ? Color.secondary : Color.blue)
                .accessibilityIdentifier("FeedbackStatus.SwappedCount")

            if !conflicts.isEmpty {
                Label("\(conflicts.count) conflict", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help(conflicts.map(\.message).joined(separator: "\n"))
                    .accessibilityIdentifier("FeedbackStatus.ConflictCount")
            }

            if !statusMessage.isEmpty {
                Divider()
                    .frame(height: 18)
                Text(statusMessage)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("FeedbackStatus.Message")
            }

            Spacer(minLength: 12)

            Button(action: onApplyAndPreview) {
                Label("Apply & Preview", systemImage: "play.rectangle")
            }
            .disabled(!feedbackSession.isDirty || !conflicts.isEmpty)
            .accessibilityIdentifier("FeedbackStatus.ApplyAndPreviewButton")

            Button(action: onPromote) {
                Label("Promote", systemImage: "arrow.up.doc")
            }
            .disabled(!canPromote)
            .help(canPromote ? "Promote the latest applied Studio patch to planning artifacts." : "Promote is available after a replace/remove Studio patch has been applied.")
            .accessibilityIdentifier("FeedbackStatus.PromoteButton")

            Button(action: onUndo) {
                Label("Undo", systemImage: "arrow.uturn.backward")
            }
            .disabled(!canUndo)
            .help(canUndo ? "Restore the timeline backup from the latest Studio patch." : "Undo is available after a Studio patch has been applied.")
            .accessibilityIdentifier("FeedbackStatus.UndoButton")

            Button(action: onDiscard) {
                Label("Discard", systemImage: "trash")
            }
            .disabled(!feedbackSession.isDirty)
            .accessibilityIdentifier("FeedbackStatus.DiscardButton")
        }
        .font(.caption)
        .controlSize(.small)
        .buttonStyle(.bordered)
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}
