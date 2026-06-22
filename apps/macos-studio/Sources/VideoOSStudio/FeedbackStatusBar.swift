import SwiftUI
import VideoOSStudioCore

struct FeedbackStatusBar: View {
    @ObservedObject var feedbackSession: StudioFeedbackSession
    var statusMessage: String
    var onApplyAndPreview: () -> Void
    var onPromote: () -> Void
    var onDiscard: () -> Void

    private var conflicts: [PatchConflict] {
        feedbackSession.detectConflicts()
    }

    var body: some View {
        HStack(spacing: 14) {
            Label("\(feedbackSession.pendingOps.count) changes pending", systemImage: "slider.horizontal.3")
                .foregroundStyle(feedbackSession.isDirty ? Color.primary : Color.secondary)
            Label("\(feedbackSession.approvedClipIDs.count) approved", systemImage: "checkmark.circle.fill")
                .foregroundStyle(feedbackSession.approvedClipIDs.isEmpty ? Color.secondary : Color.green)
            Label("\(feedbackSession.rejectedClipIDs.count) rejected", systemImage: "xmark.circle.fill")
                .foregroundStyle(feedbackSession.rejectedClipIDs.isEmpty ? Color.secondary : Color.red)
            Label("\(feedbackSession.pendingSwapCount) swapped", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(feedbackSession.pendingSwapCount == 0 ? Color.secondary : Color.blue)

            if !conflicts.isEmpty {
                Label("\(conflicts.count) conflict", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help(conflicts.map(\.message).joined(separator: "\n"))
            }

            if !statusMessage.isEmpty {
                Divider()
                    .frame(height: 18)
                Text(statusMessage)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 12)

            Button(action: onApplyAndPreview) {
                Label("Apply & Preview", systemImage: "play.rectangle")
            }
            .disabled(!feedbackSession.isDirty || !conflicts.isEmpty)

            Button(action: onPromote) {
                Label("Promote", systemImage: "arrow.up.doc")
            }
            .disabled(feedbackSession.patchHistory.isEmpty)

            Button(action: onDiscard) {
                Label("Discard", systemImage: "trash")
            }
            .disabled(!feedbackSession.isDirty)
        }
        .font(.caption)
        .controlSize(.small)
        .buttonStyle(.bordered)
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}
