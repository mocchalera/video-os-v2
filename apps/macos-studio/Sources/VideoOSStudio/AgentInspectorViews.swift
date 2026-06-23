import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct InspectorPanel: View {
    @ObservedObject var model: StudioViewModel
    @State private var selectedTab: InspectorPanelTab = .agent

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(InspectorPanelTab.allCases) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Label {
                            Text(tab.title)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        } icon: {
                            Image(systemName: tab.systemImage)
                        }
                            .font(.caption)
                            .frame(maxWidth: .infinity, minHeight: 30)
                            .contentShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selectedTab == tab ? .primary : .secondary)
                    .background {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(selectedTab == tab ? Color(nsColor: .selectedControlColor).opacity(0.18) : .clear)
                    }
                    .accessibilityLabel(tab.title)
                    .accessibilityValue(selectedTab == tab ? "selected" : "not selected")
                    .accessibilityIdentifier("InspectorTab.\(tab.rawValue)")
                    .help(tab.title)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 6)

            Divider()

            Group {
                switch selectedTab {
                case .agent:
                    AgentPanel(model: model)
                case .project:
                    ProjectPanel(model: model)
                case .clip:
                    ClipInspectorPanel(model: model)
                case .media:
                    MediaPanel(model: model)
                case .qa:
                    QADashboardPanel(model: model)
                }
            }
        }
    }
}

private enum InspectorPanelTab: String, CaseIterable, Identifiable {
    case agent = "Agent"
    case project = "Project"
    case clip = "Clip"
    case media = "Media"
    case qa = "QA"

    var id: String { rawValue }

    var title: String { rawValue }

    var systemImage: String {
        switch self {
        case .agent:
            return "sparkles"
        case .project:
            return "doc.text"
        case .clip:
            return "rectangle.on.rectangle"
        case .media:
            return "film.stack"
        case .qa:
            return "checkmark.diamond"
        }
    }
}

struct AgentPanel: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Form {
            Section("Codex App Server") {
                LabeledContent("Transport", value: model.appServerPlan.displayName)
                LabeledContent("Status", value: model.appServerStatus.rawValue)
                if let activeThreadID = model.activeThreadID {
                    LabeledContent("Thread", value: activeThreadID)
                }
                if let activeModel = model.activeModel {
                    LabeledContent("Model", value: activeModel)
                }
                LabeledContent("Workspace", value: model.repositoryRoot.path)
                LabeledContent("Command", value: model.appServerPlan.environmentDescription)
                Text(model.appServerDetail)
                    .font(.caption)
                    .foregroundStyle(model.appServerStatus == .failed ? .red : .secondary)
                Button {
                    model.checkAppServer()
                } label: {
                    Label("Check Connection", systemImage: "bolt.horizontal.circle")
                }
                .disabled(model.appServerStatus == .checking)
                Button {
                    model.startAgentSession()
                } label: {
                    Label("Start Agent Session", systemImage: "play.circle")
                }
                .disabled(model.appServerStatus == .checking || model.activeThreadID != nil)
                Button {
                    model.stopAgentSession()
                } label: {
                    Label("Stop Session", systemImage: "stop.circle")
                }
                .disabled(model.activeThreadID == nil)
            }

            Section("Current Surface") {
                LabeledContent("Role", value: model.selectedSurface.rawValue)
                LabeledContent("Command", value: model.selectedSurface.commandName)
                Text("Codex owns reasoning and artifact proposals. Engines keep deterministic writes for timeline, render, package, and validation.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Agent Turn") {
                Picker("Job", selection: $model.selectedJob) {
                    ForEach(VideoOSAgentJob.allCases) { job in
                        Label(job.title, systemImage: job.systemImage)
                            .tag(job)
                    }
                }
                .pickerStyle(.menu)

                Button {
                    model.runSelectedJob()
                } label: {
                    Label(model.selectedJob.requiresOperatorApproval ? "Review Write Plan" : "Run Job Turn", systemImage: model.selectedJob.systemImage)
                }
                .disabled(!model.selectedJobCanRun)

                LabeledContent("Sandbox", value: model.selectedJob.sandboxLabel)
                LabeledContent("RAG context", value: model.activeAgentRAGContextSummary)
                Text(model.selectedJobReadinessLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                AgentWriteContractSummary(
                    contract: model.selectedJob.writeContract(projectID: model.selectedProject?.id ?? "<id>"),
                    showForbidden: model.selectedJob.requiresOperatorApproval
                )

                if let approval = model.pendingApproval {
                    PendingApprovalCard(approval: approval, model: model)
                }

                TextEditor(text: $model.agentPrompt)
                    .font(.body)
                    .frame(minHeight: 72)
                Button {
                    model.runAgentTurn()
                } label: {
                    Label("Run Read-Only Turn", systemImage: "paperplane")
                }
                .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
                LabeledContent("Status", value: model.turnStatus)
            }

            Section("Turn Results") {
                if model.turnHistory.isEmpty {
                    Text(model.turnTranscript.isEmpty ? "No completed turns yet." : model.turnTranscript)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    ForEach(model.turnHistory.prefix(6)) { record in
                        Button {
                            model.selectedTurnID = record.id
                        } label: {
                            HStack {
                                Image(systemName: record.status == "completed" ? "checkmark.circle" : "exclamationmark.circle")
                                    .foregroundStyle(record.status == "completed" ? .green : .orange)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(record.title)
                                        .lineLimit(1)
                                    Text("\(record.projectName) / \(record.sandboxLabel) / \(record.events.count) events / \(record.artifactDiffs.count) diffs / \(record.writeViolations.count) contract warnings\(record.engineStatus == nil ? "" : " / engine")")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(record.status)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let record = model.selectedTurnRecord {
                TurnResultDetail(record: record)
            }
        }
        .formStyle(.grouped)
    }
}

struct TurnResultDetail: View {
    let record: AgentTurnRecord

    var body: some View {
        Section("Selected Turn") {
            LabeledContent("Turn", value: record.turnID)
            LabeledContent("Job", value: record.title)
            LabeledContent("Project", value: record.projectName)
            LabeledContent("Status", value: record.status)
            LabeledContent("Sandbox", value: record.sandboxLabel)
            LabeledContent("Approval", value: record.approvalLabel)
            LabeledContent("Duration", value: record.durationMs.map { "\($0) ms" } ?? "-")
            if let engineStatus = record.engineStatus {
                LabeledContent("Native engine", value: engineStatus)
            }

            if !record.plannedWriteScopes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Approved write scope")
                        .font(.caption.weight(.semibold))
                    ForEach(record.plannedWriteScopes, id: \.self) { scope in
                        Label(scope, systemImage: "doc.badge.gearshape")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !record.writeViolations.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Write contract warnings", systemImage: "exclamationmark.triangle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    ForEach(record.writeViolations) { violation in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(violation.relativePath)
                                .font(.caption)
                                .lineLimit(1)
                            Text("\(violation.kind.rawValue): \(violation.reason)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            if !record.artifactDiffs.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Artifact diff preview")
                        .font(.caption.weight(.semibold))
                    ForEach(record.artifactDiffs.prefix(12)) { diff in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(diff.kind.badge)
                                .font(.caption2.monospaced())
                                .foregroundStyle(diff.kind.tint)
                                .frame(width: 18, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(diff.relativePath)
                                    .font(.caption)
                                    .lineLimit(1)
                                Text("delta \(formatBytes(diff.byteDelta))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                ForEach(Array(diff.detailLines.prefix(4).enumerated()), id: \.offset) { _, line in
                                    Text(line)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                    if record.artifactDiffs.count > 12 {
                        Text("+\(record.artifactDiffs.count - 12) more artifact changes")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if !record.readOnly && record.approvedWrite {
                Text("No canonical artifact changes detected.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if record.assistantText.isEmpty {
                Text("No assistant text was streamed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(record.assistantText)
                    .font(.caption)
                    .textSelection(.enabled)
            }
        }

        Section("Event Timeline") {
            if record.events.isEmpty {
                Text(record.eventMethods.isEmpty ? "No events captured." : record.eventMethods.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else {
                ForEach(record.events) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("#\(event.sequence)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(event.method)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                        }
                        Text(event.summary)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func formatBytes(_ value: Int) -> String {
        if value == 0 { return "0 B" }
        let sign = value > 0 ? "+" : "-"
        let absValue = abs(value)
        if absValue < 1024 {
            return "\(sign)\(absValue) B"
        }
        let kb = Double(absValue) / 1024
        return "\(sign)\(kb.formatted(.number.precision(.fractionLength(1)))) KB"
    }
}

extension ProjectArtifactDiff.Kind {
    var badge: String {
        switch self {
        case .added: return "A"
        case .modified: return "M"
        case .removed: return "D"
        }
    }

    var tint: Color {
        switch self {
        case .added: return .green
        case .modified: return .orange
        case .removed: return .red
        }
    }
}

struct AgentWriteContractSummary: View {
    let contract: VideoOSAgentWriteContract
    var showForbidden: Bool = false

    var body: some View {
        DisclosureGroup("Write Contract") {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Mode", value: contract.modeLabel)
                LabeledContent("Entrypoint", value: contract.entrypoint)
                LabeledContent("Command", value: contract.commandContract ?? "-")

                artifactList("Allowed outputs", values: contract.allowedArtifactRoots, emptyValue: "none")
                artifactList("Expected artifacts", values: contract.expectedArtifacts, emptyValue: "none")

                if showForbidden {
                    artifactList("Forbidden writes", values: contract.forbiddenWrites, emptyValue: "none", systemImage: "xmark.octagon")
                }
            }
            .padding(.top, 4)
        }
        .font(.caption)
    }

    private func artifactList(
        _ title: String,
        values: [String],
        emptyValue: String,
        systemImage: String = "doc.badge.gearshape"
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
            if values.isEmpty {
                Text(emptyValue)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(values, id: \.self) { value in
                    Label(value, systemImage: systemImage)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }
}

struct PendingApprovalCard: View {
    let approval: AgentJobApproval
    @ObservedObject var model: StudioViewModel

    var body: some View {
        let contract = approval.job.writeContract(projectID: approval.projectID)

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Operator Approval", systemImage: "exclamationmark.shield")
                    .font(.headline)
                Spacer()
                Text(approval.projectName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            LabeledContent("Job", value: approval.job.title)
            LabeledContent("Sandbox", value: approval.job.sandboxLabel)
            LabeledContent("RAG context", value: approval.ragContextSummary)
            AgentWriteContractSummary(contract: contract, showForbidden: true)

            Text("Codex must still confirm gates and stop before any write outside these scopes.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button(role: .cancel) {
                    model.cancelPendingJob()
                } label: {
                    Label("Cancel", systemImage: "xmark.circle")
                }

                Button {
                    model.approvePendingJob()
                } label: {
                    Label("Approve and Run", systemImage: "checkmark.shield")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
            }
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}
