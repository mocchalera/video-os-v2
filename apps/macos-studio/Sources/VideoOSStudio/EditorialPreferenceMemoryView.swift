import SwiftUI
import VideoOSStudioCore

struct EditorialPreferenceMemoryView: View {
    @ObservedObject var model: StudioViewModel
    @ObservedObject private var session: EditorialPreferenceMemorySession
    @Binding var isPresented: Bool

    init(model: StudioViewModel, isPresented: Binding<Bool>) {
        self.model = model
        session = model.editorialPreferenceMemorySession
        _isPresented = isPresented
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("明示的な判断の記憶", systemImage: "brain.head.profile")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button("閉じる") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("EditorialPreferenceMemory.CloseButton")
            }
            .padding()

            Divider()

            TabView {
                rememberForm
                    .tabItem { Label("この判断を記憶", systemImage: "plus.circle") }
                redactForm
                    .tabItem { Label("記憶を取り消す", systemImage: "nosign") }
            }
            .padding([.horizontal, .bottom])

            Divider()
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if session.isRunning { ProgressView().controlSize(.small) }
                Text(session.statusMessage)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Status")
                Spacer()
            }
            .padding()
        }
        .frame(width: 640)
        .frame(minHeight: 620)
        .accessibilityIdentifier("EditorialPreferenceMemory.Sheet")
    }

    private var rememberForm: some View {
        Form {
            Section("人間が確認する内容") {
                TextField("actor", text: $session.rememberDraft.actorID)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Actor")

                Picker("source成果物", selection: $session.rememberDraft.sourceKind) {
                    ForEach(EditorialPreferenceSourceKind.allCases) { source in
                        Text(source.localizedTitle).tag(source)
                    }
                }
                .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Source")

                Picker("sourceの判断結果", selection: $session.rememberDraft.sourceEvent) {
                    ForEach(EditorialPreferenceMemorySourceEvent.allCases) { event in
                        Text(event.localizedTitle).tag(event)
                    }
                }
                .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Outcome")

                Picker("feature", selection: $session.rememberDraft.preferenceType) {
                    ForEach(EditorialPreferenceType.allCases) { feature in
                        Text(feature.rawValue).tag(feature)
                    }
                }
                .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Feature")

                Picker("valueの型", selection: $session.rememberDraft.primitiveKind) {
                    ForEach(EditorialPreferencePrimitiveKind.allCases) { kind in
                        Text(kind.rawValue).tag(kind)
                    }
                }
                .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Kind")

                TextField("value", text: $session.rememberDraft.primitiveValue)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Value")

                Picker("scope", selection: $session.rememberDraft.scope) {
                    ForEach(EditorialPreferenceScope.allCases) { scope in
                        Text(scope.rawValue).tag(scope)
                    }
                }
                .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Scope")

                TextField("scope参照", text: scopeRefBinding)
                    .disabled(session.rememberDraft.scope == .project)
                    .help(session.rememberDraft.scope == .project
                        ? "project scopeではproject IDへ自動固定されます。"
                        : "profileまたはseriesの識別子を明示入力してください。")
                    .accessibilityIdentifier("EditorialPreferenceMemory.Remember.ScopeRef")

                TextField("置き換えるentry ID（任意）", text: $session.rememberDraft.supersedesEntryID)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Remember.Supersedes")
            }

            Section("実行前の確認") {
                LabeledContent("actor", value: session.rememberDraft.actorID.isEmpty ? "未入力" : session.rememberDraft.actorID)
                LabeledContent("source / outcome", value: "\(session.rememberDraft.sourceKind.localizedTitle) / \(session.rememberDraft.sourceEvent.localizedTitle)")
                LabeledContent("feature / value", value: "\(session.rememberDraft.preferenceType.rawValue) / \(session.rememberDraft.primitiveKind.rawValue): \(session.rememberDraft.primitiveValue.isEmpty ? "未入力" : session.rememberDraft.primitiveValue)")
                LabeledContent("scope", value: "\(session.rememberDraft.scope.rawValue): \(effectiveScopeRef)")
                Text("承認・却下件数や未保存操作からfeature/valueを推測していません。上記を人間が確認した場合だけ追記します。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if session.rememberDraft.scope != .project {
                Section {
                    Label("profile/seriesのcontext適用は未実装です。この記憶は次のrunへ自動適用されません。", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("EditorialPreferenceMemory.ContextWarning")
                }
            }

            Section {
                Button {
                    model.rememberEditorialPreference()
                } label: {
                    Label(session.isRunning ? "記憶しています" : "確認した判断を記憶", systemImage: "brain.head.profile.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(rememberDisabledReason != nil)
                .help(rememberDisabledReason ?? "確認したfeature-levelの判断を明示writerで追記します。")
                .accessibilityIdentifier("EditorialPreferenceMemory.Remember.SubmitButton")

                if let rememberDisabledReason {
                    Text("実行できません: \(rememberDisabledReason)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("EditorialPreferenceMemory.Remember.DisabledReason")
                }
            }
        }
        .formStyle(.grouped)
    }

    private var redactForm: some View {
        Form {
            Section("取消を追記") {
                TextField("対象entry ID", text: $session.redactDraft.targetEntryID)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Redact.Target")
                TextField("理由", text: $session.redactDraft.reason)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Redact.Reason")
                TextField("actor", text: $session.redactDraft.actorID)
                    .accessibilityIdentifier("EditorialPreferenceMemory.Redact.Actor")
            }

            Section("実行前の確認") {
                Text("既存JSONL行は編集・削除しません。対象entry IDを指すredaction行だけをappendします。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                LabeledContent("target", value: session.redactDraft.targetEntryID.isEmpty ? "未入力" : session.redactDraft.targetEntryID)
                LabeledContent("reason", value: session.redactDraft.reason.isEmpty ? "未入力" : session.redactDraft.reason)
                LabeledContent("actor", value: session.redactDraft.actorID.isEmpty ? "未入力" : session.redactDraft.actorID)
            }

            Section {
                Button(role: .destructive) {
                    model.redactEditorialPreference()
                } label: {
                    Label(session.isRunning ? "取消を追記しています" : "記憶を取り消す", systemImage: "nosign")
                }
                .disabled(redactDisabledReason != nil)
                .help(redactDisabledReason ?? "指定したentryの取消をappend-onlyで追記します。")
                .accessibilityIdentifier("EditorialPreferenceMemory.Redact.SubmitButton")

                if let redactDisabledReason {
                    Text("実行できません: \(redactDisabledReason)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("EditorialPreferenceMemory.Redact.DisabledReason")
                }
            }
        }
        .formStyle(.grouped)
    }

    private var scopeRefBinding: Binding<String> {
        Binding(
            get: { effectiveScopeRef },
            set: { session.rememberDraft.scopeRef = $0 }
        )
    }

    private var effectiveScopeRef: String {
        guard let projectID = model.selectedProject?.id else { return "未選択" }
        return ProjectEditorialPreferenceMemoryPlanner.effectiveScopeRef(session.rememberDraft, projectID: projectID)
    }

    private var rememberDisabledReason: String? {
        if session.isRunning { return "処理中です。完了までお待ちください。" }
        guard let plan = model.editorialPreferenceRememberReadiness else { return "プロジェクトを選択してください。" }
        return plan.canRun ? nil : model.localizedPreferenceMemoryReadiness(plan.readinessLabel)
    }

    private var redactDisabledReason: String? {
        if session.isRunning { return "処理中です。完了までお待ちください。" }
        guard let plan = model.editorialPreferenceRedactReadiness else { return "プロジェクトを選択してください。" }
        return plan.canRun ? nil : model.localizedPreferenceMemoryReadiness(plan.readinessLabel)
    }
}

private extension EditorialPreferenceSourceKind {
    var localizedTitle: String {
        switch self {
        case .canonicalBlueprint: return "正準blueprint"
        case .canonicalReviewPatch: return "正準review patch"
        case .latestStudioPatch: return "最新の登録済みStudio patch"
        }
    }
}

private extension EditorialPreferenceMemorySourceEvent {
    var localizedTitle: String {
        switch self {
        case .blueprintAcceptance: return "blueprintを受理"
        case .reviewPatchAcceptance: return "review patchを受理"
        case .reviewPatchRejection: return "review patchを却下"
        }
    }
}
