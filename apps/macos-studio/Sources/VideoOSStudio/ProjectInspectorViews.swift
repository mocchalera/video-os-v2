import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct ProjectPanel: View {
    @ObservedObject var model: StudioViewModel

    private var project: ProjectSummary? {
        model.selectedProject
    }

    var body: some View {
        Form {
            Section("State") {
                LabeledContent("Project", value: project?.name ?? "-")
                LabeledContent("Gate", value: project?.stateLabel ?? "-")
                LabeledContent("Timeline", value: project?.hasTimeline == true ? "available" : "missing")
                LabeledContent("Review", value: project?.hasReview == true ? "available" : "missing")
                Text("Project creation: \(model.projectInitializationStatus)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ProjectPanel.ProjectInitializationStatus")
            }

            Section("Goal Coverage") {
                LabeledContent("Status", value: model.studioGoalStatus.readinessLabel)
                LabeledContent("Score", value: model.studioGoalStatus.scoreLabel)
                Text(model.studioGoalStatus.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let command = model.studioGoalStatus.nextCommand {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                ForEach(model.studioGoalStatus.requirements) { requirement in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: requirement.isSatisfied ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(requirement.isSatisfied ? .green : .secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(requirement.title)
                                .font(.caption)
                            Text(requirement.statusLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Text(requirement.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 8)
                    }
                }
            }

            Section("Studio Readiness") {
                LabeledContent("Status", value: model.studioReadinessStatus.readinessLabel)
                LabeledContent("Score", value: model.studioReadinessStatus.scoreLabel)
                LabeledContent("Marlin default gate", value: model.studioReadinessStatus.marlinDefaultLabel)
                Text(model.studioReadinessStatus.marlinDefaultDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.studioReadinessStatus.marlinDefaultNextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.studioReadinessStatus.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let command = model.studioReadinessStatus.nextCommand {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                ForEach(model.studioReadinessStatus.capabilities, id: \.id) { capability in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: capability.isReady ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(capability.isReady ? .green : .secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(capability.title)
                                .font(.caption)
                            Text(capability.readinessLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if let command = capability.nextCommand {
                                Text(command)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 8)
                    }
                }
                if !model.studioReadinessStatus.actionQueue.isEmpty {
                    Divider()
                    Text("Action Queue")
                        .font(.caption.weight(.semibold))
                    Text(model.studioReadinessActionStatus)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    ForEach(model.studioReadinessStatus.actionQueue) { action in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(action.title)
                                    .font(.caption)
                                Spacer()
                                Text(action.isBlocking ? "blocking" : "advisory")
                                    .font(.caption2)
                                    .foregroundStyle(action.isBlocking ? .orange : .secondary)
                            }
                            Text(action.action)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            if let command = action.command {
                                Text(command)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if command.contains("agent-prompt") {
                                    Text("Codex context: \(model.activeAgentRAGContextSummary)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            HStack(spacing: 8) {
                                Button {
                                    model.performStudioReadinessAction(action)
                                } label: {
                                    Label(model.studioReadinessActionButtonTitle(action), systemImage: action.isBlocking ? "play.circle" : "arrow.right.circle")
                                }
                                .controlSize(.small)
                                .disabled(!model.canPerformStudioReadinessAction(action))

                                Button {
                                    model.copyStudioReadinessActionCommand(action)
                                } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                                .controlSize(.small)
                                .disabled(action.command == nil)

                                if let reason = model.studioReadinessActionDisabledReason(action) {
                                    Text(reason)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            Section("Pipeline Gates") {
                LabeledContent("Status", value: model.pipelineGateStatus.readinessLabel)
                LabeledContent("State", value: model.pipelineGateStatus.currentState ?? "-")
                LabeledContent("Render", value: model.pipelineGateStatus.renderReadinessLabel)
                if !model.pipelineGateStatus.gateSummaryLabel.isEmpty {
                    Text(model.pipelineGateStatus.gateSummaryLabel)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(model.pipelineGateStatus.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Library Readiness") {
                LabeledContent("Status", value: model.libraryReadinessStatus.readinessLabel)
                LabeledContent("Media", value: model.libraryReadinessStatus.mediaReady ? "ready" : "\(model.libraryReadinessStatus.mediaMissingCount) missing / \(model.libraryReadinessStatus.mediaProxyNeededCount) proxy")
                LabeledContent("RAG", value: model.libraryReadinessStatus.ragCoverageLabel)
                LabeledContent("Analysis", value: model.libraryReadinessStatus.analysisReady ? "\(model.libraryReadinessStatus.segmentCount) segments" : "incomplete")
                LabeledContent("Marlin", value: model.libraryReadinessStatus.marlinReady ? "\(model.libraryReadinessStatus.marlinEventCount + model.libraryReadinessStatus.marlinFindResultCount) signals" : "not evaluated")
                LabeledContent("Audio", value: model.libraryReadinessStatus.audioReady ? "\(model.libraryReadinessStatus.audioEventCount + model.libraryReadinessStatus.audioStoryNodeCount + model.libraryReadinessStatus.bgmBeatCount) signals" : "not mapped")
                LabeledContent("Handoff notes", value: model.libraryReadinessStatus.handoffAnnotationsExist ? "available" : "missing")
                Text(model.libraryReadinessStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Planning") {
                LabeledContent("Status", value: model.planningStatus.readinessLabel)
                LabeledContent("Intent", value: model.planningStatus.hasCreativeBrief ? "available" : "missing")
                LabeledContent("Analysis", value: model.planningStatus.analysisReady ? "\(model.planningStatus.assetCount) assets / \(model.planningStatus.segmentCount) segments" : "incomplete")
                LabeledContent("Selects", value: model.planningStatus.hasSelects ? "available" : "missing")
                LabeledContent("Blueprint", value: model.planningStatus.hasBlueprint ? "available" : "missing")
                Text(model.planningStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let nextJob = model.planningStatus.nextAgentJob {
                    Button {
                        model.selectedJob = nextJob
                    } label: {
                        Label("Select \(nextJob.title) Job", systemImage: nextJob.systemImage)
                    }
                }
            }

            Section("Intent Brief") {
                LabeledContent("Status", value: model.intentSummary.readinessLabel)
                LabeledContent("Title", value: model.intentSummary.displayTitle)
                LabeledContent("Strategy", value: model.intentSummary.strategy ?? "-")
                LabeledContent("Format", value: model.intentSummary.format ?? "-")
                LabeledContent("Runtime", value: model.intentSummary.runtimeTargetSeconds.map { "\($0)s" } ?? "-")
                LabeledContent("Autonomy", value: model.intentSummary.autonomyLabel)
                if let message = model.intentSummary.primaryMessage {
                    LabeledContent("Message", value: message)
                }
                if let audience = model.intentSummary.primaryAudience {
                    LabeledContent("Audience", value: audience)
                }
                LabeledContent("Must have", value: model.intentSummary.mustHave.prefix(3).joined(separator: ", "))
                LabeledContent("Must avoid", value: model.intentSummary.mustAvoid.prefix(3).joined(separator: ", "))
                LabeledContent("Blockers", value: "\(model.intentSummary.blockerCount) blocker / \(model.intentSummary.softBlockerCount) soft")
                if !model.intentSummary.openBlockerQuestions.isEmpty {
                    Text(model.intentSummary.openBlockerQuestions.prefix(2).joined(separator: "\n"))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text(model.intentSummary.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Intent Alignment") {
                LabeledContent("Status", value: model.intentAlignmentStatus.readinessLabel)
                LabeledContent("Coverage", value: model.intentAlignmentStatus.coverageLabel)
                LabeledContent("Review", value: model.intentAlignmentStatus.reviewStatus ?? "-")
                LabeledContent("Brief mismatches", value: "\(model.intentAlignmentStatus.briefMismatchCount)")
                if !model.intentAlignmentStatus.mustHaveMissing.isEmpty {
                    LabeledContent("Missing", value: model.intentAlignmentStatus.mustHaveMissing.prefix(3).joined(separator: ", "))
                }
                if !model.intentAlignmentStatus.mustAvoidAcknowledged.isEmpty {
                    LabeledContent("Avoids handled", value: model.intentAlignmentStatus.mustAvoidAcknowledged.prefix(3).joined(separator: ", "))
                }
                Text(model.intentAlignmentStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Review") {
                LabeledContent("Status", value: model.reviewArtifactStatus.readinessLabel)
                LabeledContent("Judgment", value: model.reviewArtifactStatus.judgmentStatus ?? "-")
                LabeledContent("Issues", value: model.reviewArtifactStatus.issueLabel)
                LabeledContent("Mismatches", value: model.reviewArtifactStatus.mismatchLabel)
                LabeledContent("Patch", value: model.reviewArtifactStatus.patchLabel)
                if let goal = model.reviewArtifactStatus.recommendedGoal {
                    LabeledContent("Next pass", value: goal)
                }
                Text(model.reviewArtifactStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runReviewAgentJob()
                } label: {
                    Label("Run Review with Codex", systemImage: "checklist.checked")
                }
                .disabled(project == nil || model.appServerStatus == .checking)
                Button {
                    model.compileSelectedProjectWithReviewPatch()
                } label: {
                    if model.isApplyingReviewPatch {
                        Label("Applying Review Patch", systemImage: "hourglass")
                    } else {
                        Label("Apply Review Patch", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .disabled(project == nil || model.isCompilingRoughCut || !model.reviewArtifactStatus.patchReadable || !model.roughCutCompilePlan.canRun)
                .accessibilityIdentifier("ProjectPanel.ApplyReviewPatchButton")
            }

            Section("Source Analysis") {
                LabeledContent("Status", value: model.analysisRunPlan.readinessLabel)
                LabeledContent("Sources", value: "\(model.analysisRunPlan.sourceCount)")
                LabeledContent("Skipped files", value: "\(model.analysisRunPlan.skippedSourceCount)")
                Text(model.analysisRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runSelectedProjectAnalysis()
                } label: {
                    if model.isRunningAnalysis {
                        Label("Analyzing Sources", systemImage: "hourglass")
                    } else {
                        Label("Run Source Analysis", systemImage: "waveform.and.magnifyingglass")
                    }
                }
                .disabled(project == nil || model.isRunningAnalysis || !model.analysisRunPlan.canRun)
                .accessibilityIdentifier("ProjectPanel.RunSourceAnalysisButton")
                Text(model.analysisRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("ProjectPanel.SourceAnalysisCommandLine")
            }

            Section("Rough Cut Compile") {
                LabeledContent("Status", value: model.roughCutCompilePlan.readinessLabel)
                LabeledContent("Timeline", value: project?.hasTimeline == true ? "available" : "not compiled")
                Text(model.roughCutCompileStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ProjectPanel.RoughCutCompileStatus")
                Button {
                    model.compileSelectedProjectRoughCut()
                } label: {
                    if model.isCompilingPlainRoughCut {
                        Label("Compiling Rough Cut", systemImage: "hourglass")
                    } else {
                        Label("Compile Rough Cut", systemImage: "timeline.selection")
                    }
                }
                .disabled(project == nil || model.isCompilingRoughCut || !model.roughCutCompilePlan.canRun)
                .accessibilityIdentifier("ProjectPanel.CompileRoughCutButton")
                Text(model.roughCutCompilePlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("ProjectPanel.RoughCutCompileCommandLine")
            }
        }
        .formStyle(.grouped)
    }
}
