import SwiftUI
import VideoOSStudioCore

struct QADashboardPanel: View {
    @ObservedObject var model: StudioViewModel

    private var dashboard: QADashboardDocument? {
        model.qaDashboard
    }

    private var latestReport: QAIterationReport? {
        dashboard?.iterations.last
    }

    var body: some View {
        Form {
            if let dashboard, !dashboard.iterations.isEmpty {
                Section("Overall") {
                    QAScoreSummaryView(dashboard: dashboard, latestReport: latestReport)
                    if let convergenceReason = dashboard.convergenceReason {
                        LabeledContent("Convergence", value: convergenceReason)
                    }
                }

                Section("Brief Alignment") {
                    if let scores = latestReport?.brief_alignment_scores {
                        BriefAlignmentRadarChart(scores: scores)
                            .frame(height: 230)
                        QABriefAlignmentLegend(scores: scores)
                    } else {
                        Label("No brief alignment scores found in QA reports.", systemImage: "chart.line.uptrend.xyaxis")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Issues") {
                    QAIssueListView(
                        reports: dashboard.iterations,
                        onJumpToTimestamp: { model.jumpToQATimestamp($0) }
                    )
                }

                Section("Iteration History") {
                    QAScoreTrendView(reports: dashboard.iterations)
                        .frame(height: 90)
                    ForEach(dashboard.iterations, id: \.iteration) { report in
                        QAIterationHistoryRow(report: report)
                    }
                }
            } else {
                Section("QA") {
                    ContentUnavailableView(
                        "No QA Dashboard",
                        systemImage: "checkmark.diamond",
                        description: Text("Run the QA loop to create 06_review/qa-improvement-index.json or qa-improvement-report-iter*.json.")
                    )
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct QAScoreSummaryView: View {
    let dashboard: QADashboardDocument
    let latestReport: QAIterationReport?

    var body: some View {
        let composite = latestReport?.brief_alignment_scores?["composite"]
        Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 8) {
            GridRow {
                QAMetricTile(title: "QA Score", value: dashboard.latestScore.map { "\($0)/100" } ?? "-")
                QAMetricTile(title: "Delta", value: scoreDeltaLabel(dashboard.scoreImprovement))
            }
            GridRow {
                QAMetricTile(title: "Brief Alignment", value: composite.map(formatDecimal) ?? "-")
                QAMetricTile(title: "Iterations", value: "\(dashboard.iterations.count)")
            }
            GridRow {
                QAMetricTile(title: "Fixes", value: "\(dashboard.totalFixesApplied)")
                QAMetricTile(title: "Baseline", value: dashboard.baselineScore.map { "\($0)/100" } ?? "-")
            }
        }
    }

    private func scoreDeltaLabel(_ delta: Int?) -> String {
        guard let delta else { return "-" }
        if delta > 0 { return "+\(delta)" }
        return "\(delta)"
    }

    private func formatDecimal(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(3)))
    }
}

private struct QAMetricTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout.monospacedDigit().weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct BriefAlignmentRadarChart: View {
    let scores: [String: Double]

    private let axes: [(key: String, label: String)] = [
        ("intent_message_alignment", "Intent"),
        ("must_have_coverage", "Must-have"),
        ("emotion_curve_alignment", "Emotion"),
        ("narrative_structure", "Narrative"),
        ("pacing_coherence", "Pacing"),
        ("visual_variety_and_focus", "Variety")
    ]

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) * 0.34

            for level in [0.25, 0.5, 0.75, 1.0] {
                let path = polygonPath(center: center, radius: radius * level)
                context.stroke(path, with: .color(.secondary.opacity(level == 1 ? 0.35 : 0.18)), lineWidth: level == 1 ? 1.2 : 0.8)
            }

            for index in axes.indices {
                let outer = point(index: index, value: 1, center: center, radius: radius)
                var axisPath = Path()
                axisPath.move(to: center)
                axisPath.addLine(to: outer)
                context.stroke(axisPath, with: .color(.secondary.opacity(0.22)), lineWidth: 0.8)

                let labelPoint = point(index: index, value: 1.22, center: center, radius: radius)
                context.draw(
                    Text(axes[index].label)
                        .font(.caption2),
                    at: labelPoint,
                    anchor: .center
                )
            }

            drawSeries(stage: "selects", color: .blue, context: &context, center: center, radius: radius)
            drawSeries(stage: "blueprint", color: .green, context: &context, center: center, radius: radius)
        }
        .accessibilityLabel("Brief alignment radar chart")
    }

    private func drawSeries(
        stage: String,
        color: Color,
        context: inout GraphicsContext,
        center: CGPoint,
        radius: CGFloat
    ) {
        var path = Path()
        for index in axes.indices {
            let value = clamped(scores["\(stage).\(axes[index].key)"] ?? 0)
            let point = point(index: index, value: value, center: center, radius: radius)
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        context.fill(path, with: .color(color.opacity(0.14)))
        context.stroke(path, with: .color(color.opacity(0.85)), lineWidth: 2)
    }

    private func polygonPath(center: CGPoint, radius: CGFloat) -> Path {
        var path = Path()
        for index in axes.indices {
            let point = point(index: index, value: 1, center: center, radius: radius)
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        return path
    }

    private func point(index: Int, value: Double, center: CGPoint, radius: CGFloat) -> CGPoint {
        let angle = (-Double.pi / 2) + (2 * Double.pi * Double(index) / Double(axes.count))
        let scaled = radius * CGFloat(clamped(value))
        return CGPoint(
            x: center.x + CGFloat(cos(angle)) * scaled,
            y: center.y + CGFloat(sin(angle)) * scaled
        )
    }

    private func clamped(_ value: Double) -> Double {
        min(1, max(0, value.isFinite ? value : 0))
    }
}

private struct QABriefAlignmentLegend: View {
    let scores: [String: Double]

    var body: some View {
        HStack(spacing: 12) {
            legendItem("Selects", color: .blue, score: scores["selects.score"])
            legendItem("Blueprint", color: .green, score: scores["blueprint.score"])
            Spacer(minLength: 0)
        }
        .font(.caption)
    }

    private func legendItem(_ title: String, color: Color, score: Double?) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(title)
            Text(score.map { $0.formatted(.number.precision(.fractionLength(3))) } ?? "-")
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }
}

private struct QAIssueListView: View {
    let reports: [QAIterationReport]
    let onJumpToTimestamp: (Double) -> Void

    var body: some View {
        let total = reports.reduce(0) { $0 + visibleIssues(for: $1).count }
        if total == 0 {
            Label("No issue details found in QA reports.", systemImage: "checkmark.circle")
                .foregroundStyle(.secondary)
        } else {
            ForEach(reports, id: \.iteration) { report in
                let issues = visibleIssues(for: report)
                if !issues.isEmpty {
                    DisclosureGroup("Iteration \(report.iteration)  \(issues.count) issues") {
                        ForEach(issues) { issue in
                            QAIssueRow(
                                issue: issue,
                                fix: report.fixes?.first { $0.issue_id == issue.issue_id },
                                onJump: { onJumpToTimestamp(issue.timestamp_sec) }
                            )
                        }
                    }
                }
            }
        }
    }

    private func visibleIssues(for report: QAIterationReport) -> [QAIssueItem] {
        if let issues = report.issues {
            return issues
        }
        return report.fixes?.compactMap(\.issue) ?? []
    }
}

private struct QAIssueRow: View {
    let issue: QAIssueItem
    let fix: QAFixItem?
    let onJump: () -> Void

    var body: some View {
        Button(action: onJump) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: statusIcon)
                        .foregroundStyle(statusColor)
                        .frame(width: 14)
                    Text(issue.description)
                        .font(.caption)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(formatSeconds(issue.timestamp_sec))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 8) {
                    Text(issue.type)
                    Text("severity \(issue.severity.formatted(.number.precision(.fractionLength(2))))")
                    if let beat = issue.beat_id {
                        Text(beat)
                    }
                    if let clip = issue.clip_id {
                        Text(clip)
                    }
                    Text(statusLabel)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)

                if let fix {
                    Text(fixSummary(fix))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 3)
    }

    private var statusLabel: String {
        if fix != nil { return "fix proposed" }
        if issue.fixable == false { return "not fixable" }
        return "open"
    }

    private var statusIcon: String {
        if fix != nil { return "wrench.and.screwdriver.fill" }
        if issue.fixable == false { return "lock" }
        return "exclamationmark.circle"
    }

    private var statusColor: Color {
        if fix != nil { return .green }
        if issue.fixable == false { return .secondary }
        return .orange
    }

    private func fixSummary(_ fix: QAFixItem) -> String {
        if let replacement = fix.replacement?.segment_id {
            return "\(fix.fix_type) \(fix.target_clip_id) -> \(replacement)"
        }
        return "\(fix.fix_type) \(fix.target_clip_id)"
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let safeSeconds = max(0, seconds)
        let minutes = Int(safeSeconds) / 60
        let remainder = safeSeconds - Double(minutes * 60)
        return "\(minutes):\(String(format: "%04.1f", remainder))"
    }
}

private struct QAScoreTrendView: View {
    let reports: [QAIterationReport]

    var body: some View {
        Canvas { context, size in
            let scores = reports.compactMap { report -> (Int, Int)? in
                guard let score = report.overall_qa_score else { return nil }
                return (report.iteration, score)
            }
            guard !scores.isEmpty else { return }

            let padding = CGSize(width: 12, height: 10)
            let width = max(1, size.width - padding.width * 2)
            let height = max(1, size.height - padding.height * 2)

            var axis = Path()
            axis.move(to: CGPoint(x: padding.width, y: padding.height))
            axis.addLine(to: CGPoint(x: padding.width, y: padding.height + height))
            axis.addLine(to: CGPoint(x: padding.width + width, y: padding.height + height))
            context.stroke(axis, with: .color(.secondary.opacity(0.25)), lineWidth: 1)

            let points = scores.enumerated().map { index, item in
                let x = scores.count == 1
                    ? padding.width + width / 2
                    : padding.width + width * CGFloat(index) / CGFloat(scores.count - 1)
                let normalized = CGFloat(Double(min(100, max(0, item.1))) / 100.0)
                let y = padding.height + height * (1 - normalized)
                return CGPoint(x: x, y: y)
            }

            var line = Path()
            for (index, point) in points.enumerated() {
                if index == 0 {
                    line.move(to: point)
                } else {
                    line.addLine(to: point)
                }
            }
            context.stroke(line, with: .color(.accentColor), lineWidth: 2)

            for (index, point) in points.enumerated() {
                context.fill(Path(ellipseIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)), with: .color(.accentColor))
                context.draw(
                    Text("\(scores[index].1)")
                        .font(.caption2),
                    at: CGPoint(x: point.x, y: max(8, point.y - 12)),
                    anchor: .center
                )
            }
        }
        .accessibilityLabel("QA score trend")
    }
}

private struct QAIterationHistoryRow: View {
    let report: QAIterationReport

    var body: some View {
        HStack {
            Text("Iter \(report.iteration)")
                .font(.caption.weight(.semibold))
            Spacer()
            Text(report.overall_qa_score.map { "\($0)/100" } ?? "-")
                .font(.caption.monospacedDigit())
            Text("\(report.total_issues) issues")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("\(report.fixes?.count ?? 0) fixes")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
