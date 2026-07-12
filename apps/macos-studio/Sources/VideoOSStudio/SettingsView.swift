import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct SettingsView: View {
    @AppStorage(CodexAppServerTransportPreferences.storageKey) private var preferredTransport = CodexAppServerTransport.stdio.rawValue
    private let policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: ProjectScanner.locateRepositoryRoot())
    private let marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: ProjectScanner.locateRepositoryRoot())

    var body: some View {
        Form {
            Section("Codex App Server") {
                Picker("接続方式", selection: $preferredTransport) {
                    ForEach(CodexAppServerTransportPreferences.settingsOptions) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                }
                .accessibilityIdentifier("Settings.TransportPicker")
                Text(CodexAppServerTransportPreferences.settingsDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("Settings.TransportDescription")
            }

            Section("解析ポリシー") {
                LabeledContent("状態", value: localizedStudioLabel(policyStatus.readinessLabel))
                    .help(policyStatus.readinessLabel)
                LabeledContent("ポリシーファイル", value: policyStatus.policyURL.lastPathComponent)
                Text(policyStatus.policyURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                LabeledContent("VLM", value: policyStatus.vlmPolicyLabel)
            }

            Section("Marlin-2B") {
                LabeledContent("ポリシー", value: policyStatus.marlinPolicyLabel)
                LabeledContent("実行環境", value: localizedStudioLabel(marlinRuntimeStatus.readinessLabel))
                    .help(marlinRuntimeStatus.readinessLabel)
                LabeledContent("デバイス", value: "\(marlinRuntimeStatus.resolvedDeviceLabel) / \(marlinRuntimeStatus.deviceStatusLabel)")
                LabeledContent("アクセラレーター", value: "CUDA \(marlinRuntimeStatus.cudaAvailable ? "あり" : "なし") / MPS \(marlinRuntimeStatus.mpsAvailable ? "あり" : "なし")")
                LabeledContent("役割", value: policyStatus.marlinRole ?? "-")
                LabeledContent("モデル", value: policyStatus.marlinModelAlias ?? "-")
                LabeledContent("コネクタ", value: policyStatus.marlinConnectorVersion ?? "-")
                LabeledContent("ワーカー", value: policyStatus.marlinWorkerPath ?? "-")
                LabeledContent("出力", value: policyStatus.marlinOutputArtifact ?? "-")
                ForEach(marlinRuntimeStatus.requirements) { requirement in
                    LabeledContent(requirement.id, value: "\(localizedStudioLabel(requirement.statusLabel)) / \(requirement.detail)")
                        .help(requirement.statusLabel)
                }
                Text(policyStatus.preferredVLMRule)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(localizedStudioText(marlinRuntimeStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(marlinRuntimeStatus.setupCommand)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .formStyle(.grouped)
    }
}
