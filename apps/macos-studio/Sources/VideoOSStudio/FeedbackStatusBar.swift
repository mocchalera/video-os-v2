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
            Label("未保存 \(feedbackSession.pendingOps.count)", systemImage: "square.and.pencil")
                .foregroundStyle(feedbackSession.isDirty ? Color.primary : Color.secondary)
                .accessibilityIdentifier("FeedbackStatus.PendingCount")
            Label("承認 \(feedbackSession.approvedClipIDs.count)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(feedbackSession.approvedClipIDs.isEmpty ? Color.secondary : Color.green)
                .accessibilityIdentifier("FeedbackStatus.ApprovedCount")
            Label("却下 \(feedbackSession.rejectedClipIDs.count)", systemImage: "xmark.circle.fill")
                .foregroundStyle(feedbackSession.rejectedClipIDs.isEmpty ? Color.secondary : Color.red)
                .accessibilityIdentifier("FeedbackStatus.RejectedCount")
            Label("差替え \(feedbackSession.pendingSwapCount)", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(feedbackSession.pendingSwapCount == 0 ? Color.secondary : Color.blue)
                .accessibilityIdentifier("FeedbackStatus.SwappedCount")

            if !conflicts.isEmpty {
                Label("競合 \(conflicts.count)", systemImage: "exclamationmark.triangle.fill")
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
                Label("保存", systemImage: "square.and.arrow.down")
            }
            .disabled(!feedbackSession.isDirty || !conflicts.isEmpty)
            .help("表示済みのStudio編集をtimeline.jsonへ保存し、プレビューを更新します。")
            .accessibilityIdentifier("FeedbackStatus.ApplyAndPreviewButton")

            Button(action: onPromote) {
                Label("採用", systemImage: "arrow.up.doc")
            }
            .disabled(!canPromote)
            .help(canPromote ? "直近に保存したStudio編集を計画成果物へ採用します。" : "差し替えまたは削除のStudio編集を保存すると採用できます。")
            .accessibilityIdentifier("FeedbackStatus.PromoteButton")

            Button(action: onUndo) {
                Label("戻す", systemImage: "arrow.uturn.backward")
            }
            .disabled(!canUndo)
            .help(canUndo ? "直近に保存したStudio編集前のタイムラインへ戻します。" : "Studio編集を保存すると戻せます。")
            .accessibilityIdentifier("FeedbackStatus.UndoButton")

            Button(action: onDiscard) {
                Label("破棄", systemImage: "trash")
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
