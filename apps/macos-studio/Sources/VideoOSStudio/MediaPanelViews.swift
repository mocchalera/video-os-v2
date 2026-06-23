import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct MediaPanel: View {
    @ObservedObject var model: StudioViewModel

    private var project: ProjectSummary? {
        model.selectedProject
    }

    var body: some View {
        Form {
            Section("Library") {
                LabeledContent("Status", value: model.libraryReadinessStatus.readinessLabel)
                LabeledContent("Source files", value: "\(project?.mediaFileCount ?? 0)")
                LabeledContent("Analyzed assets", value: "\(model.libraryReadinessStatus.assetCount)")
                LabeledContent("Segments", value: "\(model.libraryReadinessStatus.segmentCount)")
                LabeledContent("Search/RAG", value: model.libraryReadinessStatus.ragCoverageLabel)
                LabeledContent("Timeline", value: model.libraryReadinessStatus.timelineExists ? "available" : "missing")
                LabeledContent("VLM priority", value: "Marlin-2B temporal semantics + existing VLM")
                LabeledContent("Audio priority", value: "STT, diarization, BGM, beats")
                Text(model.libraryReadinessStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Audio Story Graph") {
                LabeledContent("Audio signals", value: "\(model.libraryReadinessStatus.audioEventCount + model.libraryReadinessStatus.audioStoryNodeCount + model.libraryReadinessStatus.bgmBeatCount)")
                LabeledContent("Story nodes", value: "\(model.libraryReadinessStatus.audioStoryNodeCount)")
                LabeledContent("Run", value: model.audioStoryGraphRunPlan.readinessLabel)
                Text(model.audioStoryGraphRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.buildSelectedProjectAudioStoryGraph()
                } label: {
                    if model.isBuildingAudioStoryGraph {
                        Label("Building Audio Graph", systemImage: "hourglass")
                    } else {
                        Label("Build Audio Story Graph", systemImage: "waveform.path.ecg")
                    }
                }
                .disabled(project == nil || model.isBuildingAudioStoryGraph || !model.audioStoryGraphRunPlan.canRun)
                .accessibilityIdentifier("MediaPanel.BuildAudioStoryGraphButton")
                .help("Build Audio Story Graph")
                Text(model.audioStoryGraphRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.AudioStoryGraphCommandLine")
            }

            Section("Marlin Evaluation") {
                LabeledContent("Status", value: model.marlinEvaluationStatus.readinessLabel)
                LabeledContent("Model", value: model.marlinEvaluationStatus.modelLabel)
                LabeledContent("Policy", value: marlinPolicyValue(model.marlinEvaluationStatus))
                LabeledContent("Events", value: "\(model.marlinEvaluationStatus.eventCount) events / \(model.marlinEvaluationStatus.findResultCount) finds")
                LabeledContent("Coverage", value: marlinCoverageValue(model.marlinEvaluationStatus))
                LabeledContent("Preferred VLM", value: model.marlinEvaluationStatus.canPreferMarlin ? "candidate" : "not yet")
                LabeledContent("Runtime", value: "\(model.marlinRuntimeStatus.readinessLabel) / \(model.marlinRuntimeStatus.resolvedDeviceLabel)")
                LabeledContent("HF auth", value: model.marlinAuthReadinessLabel)
                LabeledContent("Model access", value: model.marlinModelAccessStatus.isReadyForLiveMarlin ? "ready" : "blocked")
                LabeledContent("Preference gate", value: model.marlinPreferenceDecision.decisionLabel)
                LabeledContent("Repo evidence", value: marlinPreferenceValue(model.marlinPreferenceDecision))
                LabeledContent("Representative plan", value: model.marlinRepresentativePlan.readinessLabel)
                LabeledContent("Representative buckets", value: "\(model.marlinRepresentativePlan.coveredBucketCount) / \(model.marlinRepresentativePlan.targetBucketCount)")
                LabeledContent("Evaluation queue", value: model.marlinEvaluationQueue.readinessLabel)
                LabeledContent("Runnable projects", value: "\(model.marlinEvaluationQueue.runnableProjectCount) / \(model.marlinEvaluationQueue.projectCount)")
                LabeledContent("Run plan", value: "\(model.marlinEvaluationRunPlan.sourceCount) sources / \(model.marlinEvaluationRunPlan.skippedSourceCount) skipped")
                Text(model.marlinEvaluationStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationRecommendation")
                Text(model.marlinPreferenceDecision.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinPreferenceRecommendation")
                Text(model.marlinEvaluationQueue.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinQueueNextAction")
                Text(model.marlinRepresentativePlan.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinRepresentativeNextAction")
                ForEach(model.marlinRepresentativePlan.buckets) { bucket in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bucket.label)
                                .font(.caption.weight(.semibold))
                            Text(bucket.rationale)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(bucket.readinessLabel)
                            .font(.caption2)
                            .foregroundStyle(bucket.isCovered ? Color.green : Color.secondary)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("MediaPanel.MarlinRepresentativeBucket.\(bucket.id)")
                }
                ForEach(model.marlinEvaluationQueue.items.prefix(4)) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(item.id)
                                .font(.caption.weight(.semibold))
                            Spacer()
                            Text(item.priorityLabel)
                                .font(.caption2)
                                .foregroundStyle(item.canRunEvaluation ? Color.green : Color.secondary)
                        }
                        Text("sources \(item.sourceCount), missing \(item.mediaMissingCount), coverage \(item.coveredSegmentCount)/\(item.segmentCount)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(item.recommendation)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("MediaPanel.MarlinQueueItem.\(item.id)")
                }
                Text(model.marlinEvaluationRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationRunStatus")
                HStack {
                    Button {
                        model.runSelectedProjectMarlinEvaluation()
                    } label: {
                        if model.isRunningMarlinEvaluation {
                            Label("Running Marlin", systemImage: "hourglass")
                        } else {
                            Label("Run Marlin Evaluation", systemImage: "sparkles.tv")
                        }
                    }
                    .disabled(project == nil || model.isRunningMarlinEvaluation || !model.marlinEvaluationRunPlan.canRun || !model.marlinRuntimeStatus.isReadyForLiveMarlin)
                    .accessibilityIdentifier("MediaPanel.RunMarlinEvaluationButton")
                    .help("Run Marlin Evaluation")

                    Button {
                        model.applyMarlinPreferencePolicy()
                    } label: {
                        Label("Apply Marlin Preference", systemImage: "checkmark.seal")
                    }
                    .disabled(!model.marlinPreferenceDecision.canPreferMarlinAsDefault)
                    .accessibilityIdentifier("MediaPanel.ApplyMarlinPreferenceButton")
                    .help("Apply Marlin Preference")
                }
                Text(model.marlinEvaluationRunPlan.commandLine())
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationCommandLine")
                Text(model.marlinEvaluationStatus.artifactURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationArtifactPath")
            }

            Section("Preview Readiness") {
                LabeledContent("Ready", value: "\(model.mediaPreviewSummary.readyCount)")
                LabeledContent("Missing", value: "\(model.mediaPreviewSummary.missingCount)")
                LabeledContent("Proxy needed", value: "\(model.mediaPreviewSummary.proxyNeededCount)")
                LabeledContent("Synthetic previews", value: "\(model.mediaPreviewSummary.syntheticPreviewCount)")
                LabeledContent("Proxy plans", value: "\(model.mediaProxyPlan.pendingCount)")

                if model.mediaPreviewSummary.items.isEmpty {
                    Text("Run analysis or load assets.json to inspect source preview readiness.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.mediaPreviewSummary.items) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Label(item.assetID, systemImage: icon(for: item.playbackStatus))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(color(for: item.playbackStatus))
                                Spacer()
                                Text(item.playbackStatus.rawValue)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                                .lineLimit(1)
                            Text(item.recommendation)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            if let url = item.url {
                                Text(url.path)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            Section("Source Map") {
                let suggestedRoots = project.map { ProjectMediaRelinker.suggestedSearchRoots(projectURL: $0.path) } ?? []
                LabeledContent("Status", value: model.mediaSourceMapStatus.readinessLabel)
                LabeledContent("Coverage", value: model.mediaSourceMapStatus.coverageLabel)
                LabeledContent("Entries", value: "\(model.mediaSourceMapStatus.entryCount)")
                LabeledContent("Ready paths", value: "\(model.mediaSourceMapStatus.readyAssetCount)")
                LabeledContent("Broken", value: "\(model.mediaSourceMapStatus.brokenEntries.count)")
                LabeledContent("Relinked symlinks", value: "\(model.mediaSourceMapStatus.relinkedSymlinkCount)")
                if let generatedAt = model.mediaSourceMapStatus.generatedAt {
                    LabeledContent("Generated", value: generatedAt)
                }
                Text(model.mediaSourceMapStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.mediaSourceMapStatus.sourceMapURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if !suggestedRoots.isEmpty {
                    LabeledContent("Suggested roots", value: "\(suggestedRoots.count)")
                    ForEach(suggestedRoots.prefix(4)) { root in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Label(root.exists ? "Available" : "Missing", systemImage: root.exists ? "externaldrive.fill" : "externaldrive.badge.xmark")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(root.exists ? .green : .secondary)
                                Spacer()
                                Text("\(root.referencedAssetCount) refs")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(root.url.path)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                ForEach(model.mediaSourceMapStatus.brokenEntries.prefix(5)) { entry in
                    VStack(alignment: .leading, spacing: 3) {
                        Label(entry.assetID, systemImage: "exclamationmark.triangle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text(entry.filename ?? "-")
                            .font(.caption)
                            .lineLimit(1)
                        Text(entry.checkedPaths.joined(separator: ", "))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }

            Section("Media Relink") {
                let suggestedRoots = project.map { ProjectMediaRelinker.suggestedSearchRoots(projectURL: $0.path) } ?? []
                Text(model.mediaRelinkStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Button {
                            model.chooseAndRelinkSelectedProjectMedia()
                        } label: {
                            if model.isRelinkingMedia {
                                Label("Relinking Media", systemImage: "hourglass")
                            } else {
                                Label("Relink Missing Media", systemImage: "link")
                            }
                        }
                        .disabled(project == nil || model.mediaPreviewSummary.missingCount == 0 || model.isRelinkingMedia)

                        Button {
                            model.relinkSelectedProjectMediaFromSourceMap()
                        } label: {
                            Label("Use Source Map Roots", systemImage: "externaldrive.connected.to.line.below")
                        }
                        .disabled(project == nil || model.mediaPreviewSummary.missingCount == 0 || model.isRelinkingMedia || suggestedRoots.allSatisfy { !$0.exists })
                    }

                    Button {
                        model.chooseAndRelinkSelectedProjectMedia(includeSynthetic: true)
                    } label: {
                        Label("Replace Synthetic Media", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(project == nil || model.mediaPreviewSummary.syntheticPreviewCount == 0 || model.isRelinkingMedia)
                }

                if let plan = model.mediaRelinkPlan {
                    LabeledContent("Matches", value: "\(plan.matchedCount) / \(plan.missingAssetCount)")
                    LabeledContent("Source map", value: plan.sourceMapURL.lastPathComponent)
                    ForEach(plan.items.prefix(8)) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Label(item.assetID, systemImage: item.candidateURL == nil ? "exclamationmark.circle" : "checkmark.circle")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.candidateURL == nil ? .orange : .green)
                                Spacer()
                                Text(item.matchedBy ?? "unmatched")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                                .lineLimit(1)
                            Text(item.candidateURL?.path ?? "No matching file found in selected roots.")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    if plan.items.count > 8 {
                        Text("+\(plan.items.count - 8) more relink items")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Synthetic Demo Media") {
                Text(model.syntheticMediaStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.buildSelectedProjectSyntheticMedia()
                } label: {
                    if model.isBuildingSyntheticMedia {
                        Label("Building Demo Media", systemImage: "hourglass")
                    } else {
                        Label("Build Demo Media", systemImage: "wand.and.stars")
                    }
                }
                .disabled(project == nil || model.mediaSourceMapStatus.assetCount == 0 || model.isBuildingSyntheticMedia)

                Text("Creates short local test videos under 02_media/synthetic and maps analyzed assets for preview and handoff QA.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Divider()

                Text(model.studioSyntheticSmokeStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.runStudioSyntheticSmoke()
                } label: {
                    if model.isRunningStudioSyntheticSmoke {
                        Label("Running Studio Smoke", systemImage: "hourglass")
                    } else {
                        Label("Run Studio Smoke", systemImage: "checkmark.seal")
                    }
                }
                .disabled(model.isRunningStudioSyntheticSmoke)

                Text("Builds a temporary approved project, packages final media, and verifies editor packet media without changing the selected project.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Divider()

                Text(model.studioAcceptanceSmokeStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.runStudioAcceptanceSmoke()
                } label: {
                    if model.isRunningStudioAcceptanceSmoke {
                        Label("Running Acceptance Smoke", systemImage: "hourglass")
                    } else {
                        Label("Run Acceptance Smoke", systemImage: "checkmark.shield")
                    }
                }
                .disabled(model.isRunningStudioAcceptanceSmoke)

                Text("Checks the Codex App Server handshake and the temporary render/package/editor-packet loop as one runtime acceptance gate.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Section("Proxy Transcode Plan") {
                Text(model.mediaProxyOperationStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.buildSelectedProjectMediaProxies()
                } label: {
                    if model.isBuildingMediaProxies {
                        Label("Building Proxies", systemImage: "hourglass")
                    } else {
                        Label("Build Proxies", systemImage: "film.stack")
                    }
                }
                .disabled(project == nil || model.mediaProxyPlan.pendingCount == 0 || model.isBuildingMediaProxies)

                if model.mediaProxyPlan.items.isEmpty {
                    Text("No unsupported source media needs a preview proxy.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.mediaProxyPlan.items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Label(item.assetID, systemImage: item.outputExists ? "checkmark.circle" : "film.stack")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.outputExists ? .green : .orange)
                                Spacer()
                                Text(item.outputExists ? "exists" : "pending")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                            Text(item.outputPath)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Text(item.commandLine)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            Section("Render Package") {
                LabeledContent("Status", value: model.renderPackageStatus.readinessLabel)
                LabeledContent("Run", value: model.renderRunPlan.readinessLabel)
                LabeledContent("QA", value: renderQAValue(model.renderPackageStatus))
                LabeledContent("Source", value: model.renderPackageStatus.manifestSourceOfTruth ?? model.renderPackageStatus.qaSourceOfTruth ?? "-")
                LabeledContent("Checks", value: "\(model.renderPackageStatus.qaCheckCount) total / \(model.renderPackageStatus.qaFailedCheckCount) failed")
                if let createdAt = model.renderPackageStatus.manifestCreatedAt {
                    LabeledContent("Packaged", value: createdAt)
                }

                renderArtifactRow("Final video", url: model.renderPackageStatus.publishedFinalVideoURL, exists: model.renderPackageStatus.publishedFinalVideoExists)
                renderArtifactRow("QA report", url: model.renderPackageStatus.qaReportURL, exists: model.renderPackageStatus.qaReportExists)
                renderArtifactRow("Manifest", url: model.renderPackageStatus.packageManifestURL, exists: model.renderPackageStatus.packageManifestExists)
                renderArtifactRow("Final mix", url: model.renderPackageStatus.finalMixURL, exists: model.renderPackageStatus.finalMixExists)

                if !model.renderPackageStatus.missingRequiredArtifacts.isEmpty {
                    Text("Missing: \(model.renderPackageStatus.missingRequiredArtifacts.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(model.renderRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runSelectedProjectRender()
                } label: {
                    if model.isRunningRender {
                        Label("Rendering Final", systemImage: "hourglass")
                    } else {
                        Label("Render Final Package", systemImage: "film.stack")
                    }
                }
                .disabled(project == nil || model.isRunningRender || !model.renderRunPlan.canRun)
                .accessibilityIdentifier("MediaPanel.RenderFinalPackageButton")
                Text(model.renderRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.RenderFinalPackageCommandLine")
            }

            Section("Editor Handoff") {
                LabeledContent("Status", value: model.handoffExportPlan?.readinessLabel ?? "not checked")
                LabeledContent("Clip notes", value: "\(model.handoffExportPlan?.editorAnnotationNoteCount ?? 0)")
                LabeledContent("Source map", value: "\(model.handoffExportPlan?.sourceMapEntryCount ?? 0) entries")
                LabeledContent("Map status", value: model.handoffExportPlan?.sourceMapReadinessLabel ?? "not checked")
                LabeledContent("Map coverage", value: model.handoffExportPlan?.sourceMapCoverageLabel ?? "-")
                LabeledContent("Temporary map", value: model.handoffExportPlan?.usesTemporarySourceMap == true ? "yes" : "no")
                LabeledContent("Generated map", value: "\(model.handoffExportPlan?.generatedSourceMapEntryCount ?? 0) entries")
                LabeledContent("Relinks", value: "\(model.handoffExportPlan?.mediaMissingCount ?? 0)")
                if let annotationURL = model.editorAnnotationSummary?.url {
                    LabeledContent("Annotations", value: annotationURL.lastPathComponent)
                    Text(annotationURL.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let output = model.handoffExportPlan?.outputURL {
                    LabeledContent("Premiere XML", value: output.lastPathComponent)
                    Text(output.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(model.handoffExportStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.exportSelectedProjectPremiereXML()
                } label: {
                    if model.isExportingPremiereXML {
                        Label("Exporting XML", systemImage: "hourglass")
                    } else {
                        Label("Export Premiere XML", systemImage: "square.and.arrow.up")
                    }
                }
                .disabled(project == nil || model.isExportingPremiereXML || model.handoffExportPlan?.canExportPremiereXML != true)
                .accessibilityIdentifier("MediaPanel.ExportPremiereXMLButton")

                Divider()

                LabeledContent("Editor packet", value: model.editorPacketPlan?.readinessLabel ?? "not checked")
                LabeledContent("Review report", value: model.editorPacketPlan?.reviewReportIncluded == true ? "included" : "not included")
                LabeledContent("Review patch", value: model.editorPacketPlan?.reviewPatchIncluded == true ? "included" : "not included")
                LabeledContent("Preview/final media", value: "\(model.editorPacketPlan?.mediaIncludedCount ?? 0) files")
                LabeledContent("Packet verify", value: model.editorPacketVerificationStatus.readinessLabel)
                LabeledContent("Packet files", value: "\(model.editorPacketVerificationStatus.existingFileCount)/\(model.editorPacketVerificationStatus.manifestFileCount)")
                LabeledContent("Final media", value: model.editorPacketVerificationStatus.finalMediaIncluded ? "included" : "missing")
                LabeledContent("Final audio", value: model.editorPacketVerificationStatus.finalAudioIncluded ? "included" : "missing")
                if let packet = model.editorPacketPlan?.packetURL {
                    Text(packet.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(model.editorPacketVerificationStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.editorPacketStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.exportSelectedProjectEditorPacket()
                } label: {
                    if model.isExportingEditorPacket {
                        Label("Exporting Packet", systemImage: "hourglass")
                    } else {
                        Label("Export Editor Packet", systemImage: "shippingbox.and.arrow.backward")
                    }
                }
                .disabled(project == nil || model.isExportingEditorPacket || model.editorPacketPlan?.canExportPacket != true)
                .accessibilityIdentifier("MediaPanel.ExportEditorPacketButton")

                Button {
                    model.revealEditorPacketInFinder()
                } label: {
                    Label("Reveal Packet", systemImage: "folder")
                }
                .disabled(model.editorPacketPlan == nil)
                .accessibilityIdentifier("MediaPanel.RevealEditorPacketButton")

                if let command = model.handoffExportPlan?.commandLine {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityIdentifier("MediaPanel.HandoffCommandLine")
                }
            }

            Section("SQLite Index") {
                LabeledContent("Status", value: model.indexStatus.exists ? "available" : "missing")
                LabeledContent("Documents", value: "\(model.indexStatus.documentCount)")
                LabeledContent("Updated", value: model.indexStatus.updatedAt ?? "-")
                Text(model.indexOperationStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.IndexOperationStatus")
                Button {
                    model.rebuildSelectedProjectIndex()
                } label: {
                    Label("Rebuild Index", systemImage: "externaldrive.badge.plus")
                }
                .disabled(project == nil)
                .accessibilityIdentifier("MediaPanel.RebuildIndexButton")
            }

            Section("Search") {
                HStack {
                    TextField("Search transcript, tags, Marlin events", text: $model.indexSearchQuery)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("MediaPanel.IndexSearchField")
                        .onSubmit {
                            model.searchSelectedProjectIndex()
                        }
                    Button {
                        model.searchSelectedProjectIndex()
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .disabled(model.indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("MediaPanel.IndexSearchButton")
                }

                Button {
                    model.appendIndexContextToAgentPrompt()
                } label: {
                    Label("Add RAG Context to Agent", systemImage: "text.badge.plus")
                }
                .disabled(model.indexContextPack.isEmpty)
                .accessibilityIdentifier("MediaPanel.AddRAGContextButton")

                if model.indexSearchResults.isEmpty {
                    Text("Build the index, then search by dialogue, visual tags, audio cues, or Marlin descriptions.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("MediaPanel.IndexSearchEmptyState")
                } else {
                    Text("\(model.indexContextPack.items.count) cited items ready for Codex prompt context.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("MediaPanel.IndexContextSummary")
                    ForEach(model.indexSearchResults) { result in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(result.kind)
                                    .font(.caption2.weight(.semibold))
                                Spacer()
                                Text([result.assetID, result.segmentID].compactMap { $0 }.joined(separator: " / "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(result.title)
                                .font(.caption)
                                .lineLimit(2)
                            if !result.text.isEmpty {
                                Text(result.text)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("MediaPanel.IndexSearchResult.\(result.id)")
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func renderQAValue(_ status: ProjectRenderPackageStatus) -> String {
        guard status.qaReportExists else { return "missing" }
        guard status.qaReportReadable else { return "unreadable" }
        if status.qaPassed == true { return "passed" }
        if status.qaPassed == false { return "failed" }
        return "unknown"
    }

    private func marlinPolicyValue(_ status: ProjectMarlinEvaluationStatus) -> String {
        let enabled = status.policyEnabled.map { $0 ? "enabled" : "disabled" } ?? "unknown"
        let mode = status.policyMode ?? "unknown"
        let mock = status.policyMock == true ? "mock" : "live"
        return "\(enabled) / \(mode) / \(mock)"
    }

    private func marlinCoverageValue(_ status: ProjectMarlinEvaluationStatus) -> String {
        guard status.segmentCount > 0 else { return "0/0 segments" }
        let percent = Int((status.coverageRatio * 100).rounded())
        return "\(status.segmentsWithMarlinPeakCount)/\(status.segmentCount) peak segments (\(percent)%)"
    }

    private func marlinPreferenceValue(_ decision: ProjectMarlinPreferenceDecision) -> String {
        let percent = Int((decision.aggregateCoverageRatio * 100).rounded())
        return "\(decision.candidateProjectCount)/\(decision.evaluatedProjectCount) projects, \(decision.representativeCandidateBucketCount)/\(decision.representativeTargetBucketCount) buckets, \(percent)% peak coverage"
    }

    private func renderArtifactRow(_ title: String, url: URL, exists: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Label(title, systemImage: exists ? "checkmark.circle" : "circle.dashed")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(exists ? .green : .secondary)
                Spacer()
                Text(exists ? "exists" : "missing")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(url.path)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private func icon(for status: ProjectMediaPreviewStatus.PlaybackStatus) -> String {
        switch status {
        case .directVideo: return "play.rectangle"
        case .proxyVideo: return "rectangle.on.rectangle"
        case .directAudio: return "waveform"
        case .needsProxy: return "arrow.triangle.2.circlepath"
        case .missing: return "questionmark.video"
        }
    }

    private func color(for status: ProjectMediaPreviewStatus.PlaybackStatus) -> Color {
        switch status {
        case .directVideo, .proxyVideo, .directAudio: return .green
        case .needsProxy: return .orange
        case .missing: return .red
        }
    }
}
