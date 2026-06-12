import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct SettingsView: View {
    @AppStorage("videoOSStudioPreferredTransport") private var preferredTransport = CodexAppServerTransport.stdio.rawValue
    private let policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: ProjectScanner.locateRepositoryRoot())
    private let marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: ProjectScanner.locateRepositoryRoot())

    var body: some View {
        Form {
            Section("Codex App Server") {
                Picker("Transport", selection: $preferredTransport) {
                    ForEach(CodexAppServerTransport.allCases, id: \.rawValue) { transport in
                        Text(transport.rawValue).tag(transport.rawValue)
                    }
                }
                Text("Initial builds use stdio. WebSocket and Unix socket modes are reserved for embedded runtime and packaged app flows.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Analysis Policy") {
                LabeledContent("Status", value: policyStatus.readinessLabel)
                LabeledContent("Policy file", value: policyStatus.policyURL.path)
                LabeledContent("VLM", value: policyStatus.vlmPolicyLabel)
            }

            Section("Marlin-2B") {
                LabeledContent("Policy", value: policyStatus.marlinPolicyLabel)
                LabeledContent("Runtime", value: marlinRuntimeStatus.readinessLabel)
                LabeledContent("Device", value: "\(marlinRuntimeStatus.resolvedDeviceLabel) / \(marlinRuntimeStatus.deviceStatusLabel)")
                LabeledContent("Accelerators", value: "CUDA \(marlinRuntimeStatus.cudaAvailable ? "yes" : "no") / MPS \(marlinRuntimeStatus.mpsAvailable ? "yes" : "no")")
                LabeledContent("Role", value: policyStatus.marlinRole ?? "-")
                LabeledContent("Model", value: policyStatus.marlinModelAlias ?? "-")
                LabeledContent("Connector", value: policyStatus.marlinConnectorVersion ?? "-")
                LabeledContent("Worker", value: policyStatus.marlinWorkerPath ?? "-")
                LabeledContent("Output", value: policyStatus.marlinOutputArtifact ?? "-")
                ForEach(marlinRuntimeStatus.requirements) { requirement in
                    LabeledContent(requirement.id, value: "\(requirement.statusLabel) / \(requirement.detail)")
                }
                Text(policyStatus.preferredVLMRule)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(marlinRuntimeStatus.recommendation)
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
