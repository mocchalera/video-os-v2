import Foundation

public struct TimelineDocument: Decodable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let sequence: TimelineSequence
    public let tracks: TimelineTrackCollection
    public let markers: [TimelineMarker]
    public let transitions: [TimelineTransition]
    public let sourceHash: String?

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case sequence
        case tracks
        case markers
        case transitions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        projectID = try container.decode(String.self, forKey: .projectID)
        sequence = try container.decode(TimelineSequence.self, forKey: .sequence)
        tracks = try container.decode(TimelineTrackCollection.self, forKey: .tracks)
        markers = try container.decodeIfPresent([TimelineMarker].self, forKey: .markers) ?? []
        transitions = try container.decodeIfPresent([TimelineTransition].self, forKey: .transitions) ?? []
        sourceHash = nil
    }

    public init(
        version: String,
        projectID: String,
        sequence: TimelineSequence,
        tracks: TimelineTrackCollection,
        markers: [TimelineMarker],
        transitions: [TimelineTransition] = [],
        sourceHash: String? = nil
    ) {
        self.version = version
        self.projectID = projectID
        self.sequence = sequence
        self.tracks = tracks
        self.markers = markers
        self.transitions = transitions
        self.sourceHash = sourceHash
    }

    public var displayTracks: [TimelineTrack] {
        tracks.video + tracks.overlay + tracks.resolvedCaptionTracks + tracks.audio
    }

    public var totalFrames: Int {
        let clipMax = displayTracks
            .flatMap(\.clips)
            .map { $0.timelineInFrame + $0.timelineDurationFrames }
            .max() ?? 0
        let markerMax = markers.map(\.frame).max() ?? 0
        return max(clipMax, markerMax, 1)
    }

    public var totalSeconds: Double {
        sequence.framesToSeconds(totalFrames)
    }

    public func movingClip(
        _ clipID: TimelineClip.ID,
        toTimelineInFrame timelineInFrame: Int,
        durationFrames: Int? = nil,
        targetTrackID: TimelineTrack.ID? = nil
    ) -> TimelineDocument? {
        guard timelineInFrame >= 0 else { return nil }
        let sourceTrackID = displayTracks.first { track in
            track.clips.contains(where: { $0.id == clipID })
        }?.id
        guard let updatedTracks = tracks.movingClip(clipID, toTrackID: targetTrackID, update: { clip in
            clip.moving(toTimelineInFrame: timelineInFrame, durationFrames: durationFrames)
        }) else {
            return nil
        }
        let resolvedTargetTrackID = targetTrackID ?? sourceTrackID
        let updatedTransitions = resolvedTargetTrackID != sourceTrackID
            ? transitions.filter { $0.fromClipID != clipID && $0.toClipID != clipID }
            : transitions

        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: updatedTracks,
            markers: markers,
            transitions: updatedTransitions,
            sourceHash: sourceHash
        )
    }

    public func applyingTimelineMoveOperations(_ operations: [ReviewPatchOperation]) -> TimelineDocument {
        var document = self
        for operation in operations {
            guard case let .moveSegment(clipID, timelineInFrame, durationFrames, targetTrackID, _) = operation,
                  let updatedDocument = document.movingClip(
                    clipID,
                    toTimelineInFrame: timelineInFrame,
                    durationFrames: durationFrames,
                    targetTrackID: targetTrackID
                  )
            else {
                continue
            }
            document = updatedDocument
        }
        return document
    }

    public func applyingRippleDelete(_ plan: TimelineRippleDeletePlan) -> TimelineDocument? {
        guard let removedDocument = removingClips([plan.deletedClipID]) else {
            return nil
        }
        return removedDocument.applyingTimelineMoveOperations(plan.operations)
    }

    public func applyingRippleDelete(_ plan: TimelineRippleDeleteGroupPlan) -> TimelineDocument? {
        guard let removedDocument = removingClips(Set(plan.deletedClipIDs)) else {
            return nil
        }
        return removedDocument.applyingTimelineMoveOperations(plan.operations)
    }

    public func applyingLiftDelete(_ plan: TimelineLiftDeletePlan) -> TimelineDocument? {
        removingClips(Set(plan.deletedClipIDs))
    }

    public func trimmingClip(
        _ clipID: TimelineClip.ID,
        sourceInUS: Int,
        sourceOutUS: Int
    ) -> TimelineDocument? {
        guard sourceInUS >= 0, sourceOutUS > sourceInUS else { return nil }
        guard let updatedTracks = tracks.updatingClip(clipID, update: { clip in
            clip.trimming(sourceInUS: sourceInUS, sourceOutUS: sourceOutUS)
        }) else {
            return nil
        }
        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: updatedTracks,
            markers: markers,
            transitions: transitions,
            sourceHash: sourceHash
        )
    }

    public func applyingTimelineTrimOperations(_ operations: [ReviewPatchOperation]) -> TimelineDocument {
        var document = self
        for operation in operations {
            switch operation {
            case let .trimSegment(clipID, sourceInUS, sourceOutUS, _):
                if let updatedDocument = document.trimmingClip(
                    clipID,
                    sourceInUS: sourceInUS,
                    sourceOutUS: sourceOutUS
                ) {
                    document = updatedDocument
                }
            case let .moveSegment(clipID, timelineInFrame, durationFrames, targetTrackID, _):
                if let updatedDocument = document.movingClip(
                    clipID,
                    toTimelineInFrame: timelineInFrame,
                    durationFrames: durationFrames,
                    targetTrackID: targetTrackID
                ) {
                    document = updatedDocument
                }
            default:
                continue
            }
        }
        return document
    }

    public func splittingClip(
        _ clipID: TimelineClip.ID,
        atTimelineFrame splitFrame: Int,
        rightClipID: TimelineClip.ID,
        reason: String
    ) -> TimelineDocument? {
        guard !clipID.isEmpty, !rightClipID.isEmpty, clipID != rightClipID else { return nil }
        let existingClipIDs = Set(displayTracks.flatMap(\.clips).map(\.id))
        guard existingClipIDs.contains(clipID), !existingClipIDs.contains(rightClipID) else { return nil }
        guard let updatedTracks = tracks.splittingClip(
            clipID,
            atTimelineFrame: splitFrame,
            rightClipID: rightClipID,
            reason: reason
        ) else {
            return nil
        }

        let updatedTransitions = transitions.map { transition in
            guard transition.fromClipID == clipID else { return transition }
            return TimelineTransition(
                id: transition.id,
                fromClipID: rightClipID,
                toClipID: transition.toClipID,
                trackID: transition.trackID,
                transitionType: transition.transitionType,
                transitionFrames: transition.transitionFrames,
                appliedSkillID: transition.appliedSkillID
            )
        }

        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: updatedTracks,
            markers: markers,
            transitions: updatedTransitions,
            sourceHash: sourceHash
        )
    }

    public func settingTransition(
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        trackID: TimelineTrack.ID,
        transitionType: String,
        transitionFrames: Int,
        appliedSkillID: String?
    ) -> TimelineDocument? {
        guard transitionFrames > 0 else { return nil }
        if transitionType.lowercased() == "cut" {
            let updatedTransitions = transitions.filter {
                !($0.trackID == trackID && $0.fromClipID == fromClipID && $0.toClipID == toClipID)
            }
            return TimelineDocument(
                version: version,
                projectID: projectID,
                sequence: sequence,
                tracks: tracks,
                markers: markers,
                transitions: updatedTransitions,
                sourceHash: sourceHash
            )
        }
        let transition = TimelineTransition(
            id: TimelineTransition.stableID(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID),
            fromClipID: fromClipID,
            toClipID: toClipID,
            trackID: trackID,
            transitionType: transitionType,
            transitionFrames: transitionFrames,
            appliedSkillID: appliedSkillID
        )
        var updatedTransitions = transitions
        if let index = updatedTransitions.firstIndex(where: {
            $0.trackID == trackID && $0.fromClipID == fromClipID && $0.toClipID == toClipID
        }) {
            updatedTransitions[index] = transition
        } else {
            updatedTransitions.append(transition)
        }
        updatedTransitions.sort {
            if $0.trackID != $1.trackID { return $0.trackID < $1.trackID }
            if $0.fromClipID != $1.fromClipID { return $0.fromClipID < $1.fromClipID }
            return $0.toClipID < $1.toClipID
        }

        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: tracks,
            markers: markers,
            transitions: updatedTransitions,
            sourceHash: sourceHash
        )
    }

    public func insertingClip(
        _ clip: TimelineClip,
        targetTrackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind
    ) -> TimelineDocument? {
        guard clip.timelineInFrame >= 0,
              clip.timelineDurationFrames > 0,
              !targetTrackID.isEmpty,
              let updatedTracks = tracks.insertingClip(
                clip,
                targetTrackID: targetTrackID,
                targetKind: targetKind
              )
        else {
            return nil
        }
        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: updatedTracks,
            markers: markers,
            transitions: transitions,
            sourceHash: sourceHash
        )
    }

    public func removingClips(_ clipIDs: Set<TimelineClip.ID>) -> TimelineDocument? {
        guard !clipIDs.isEmpty else { return self }
        let existingClipIDs = Set(displayTracks.flatMap(\.clips).map(\.id))
        guard clipIDs.isSubset(of: existingClipIDs) else { return nil }

        func filteredTracks(_ tracks: [TimelineTrack]) -> [TimelineTrack] {
            tracks.map { track in
                TimelineTrack(
                    id: track.id,
                    kind: track.kind,
                    clips: track.clips.filter { !clipIDs.contains($0.id) }
                )
            }
        }

        let updatedTransitions = transitions.filter {
            !clipIDs.contains($0.fromClipID) && !clipIDs.contains($0.toClipID)
        }

        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: TimelineTrackCollection(
                video: filteredTracks(tracks.video),
                audio: filteredTracks(tracks.audio),
                overlay: filteredTracks(tracks.overlay),
                caption: filteredTracks(tracks.caption)
            ),
            markers: markers,
            transitions: updatedTransitions,
            sourceHash: sourceHash
        )
    }

    public func replacingClip(
        _ clipID: TimelineClip.ID,
        with candidate: BrowserCandidate,
        reason: String,
        sourceRangeOverride: TimelineSourceRangeOverride? = nil
    ) -> TimelineDocument? {
        guard let updatedTracks = tracks.updatingClip(clipID, update: { clip in
            clip.replacing(with: candidate, reason: reason, sourceRangeOverride: sourceRangeOverride)
        }) else {
            return nil
        }
        return TimelineDocument(
            version: version,
            projectID: projectID,
            sequence: sequence,
            tracks: updatedTracks,
            markers: markers,
            transitions: transitions,
            sourceHash: sourceHash
        )
    }

    public func transitionHandles(
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID
    ) -> Int? {
        guard let track = displayTracks.first(where: { $0.id == trackID }),
              let fromClip = track.clips.first(where: { $0.id == fromClipID }),
              let toClip = track.clips.first(where: { $0.id == toClipID }),
              fromClip.timelineOutFrame == toClip.timelineInFrame else {
            return nil
        }
        return min(fromClip.timelineDurationFrames, toClip.timelineDurationFrames)
    }

    public func activeVisualTransitionPreview(atFrame frame: Int) -> TimelineActiveTransitionPreview? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        let visualTracks = Array((tracks.overlay + tracks.video).reversed())
        for track in visualTracks {
            for transition in transitions where transition.trackID == track.id && transition.isVisibleTimelineTransition {
                guard let fromClip = track.clips.first(where: { $0.id == transition.fromClipID }),
                      let toClip = track.clips.first(where: { $0.id == transition.toClipID }),
                      fromClip.timelineOutFrame == toClip.timelineInFrame,
                      let transitionFrames = transition.transitionFrames,
                      transitionFrames > 0
                else {
                    continue
                }

                let boundaryFrame = fromClip.timelineOutFrame
                let leadingFrames = transitionFrames / 2
                let trailingFrames = transitionFrames - leadingFrames
                let startFrame = max(fromClip.timelineInFrame, boundaryFrame - leadingFrames)
                let endFrame = min(toClip.timelineOutFrame, boundaryFrame + trailingFrames)
                guard startFrame < endFrame,
                      normalizedFrame >= startFrame,
                      normalizedFrame < endFrame
                else {
                    continue
                }

                let durationFrames = max(1, endFrame - startFrame)
                let progress = min(1, max(0, Double(normalizedFrame - startFrame) / Double(durationFrames)))
                let overlayClip: TimelineClip
                let overlayTimelineFrame: Int
                let overlayOpacity: Double
                if normalizedFrame < boundaryFrame {
                    overlayClip = toClip
                    overlayTimelineFrame = min(
                        toClip.timelineOutFrame,
                        toClip.timelineInFrame + max(0, normalizedFrame - startFrame)
                    )
                    overlayOpacity = progress
                } else {
                    overlayClip = fromClip
                    overlayTimelineFrame = max(
                        fromClip.timelineInFrame,
                        fromClip.timelineOutFrame - max(0, endFrame - normalizedFrame)
                    )
                    overlayOpacity = 1 - progress
                }

                return TimelineActiveTransitionPreview(
                    transition: transition,
                    trackID: track.id,
                    boundaryFrame: boundaryFrame,
                    startFrame: startFrame,
                    endFrame: endFrame,
                    progress: progress,
                    overlaySelection: TimelineClipSelection(
                        trackID: track.id,
                        trackKind: track.kind,
                        clip: overlayClip
                    ),
                    overlayTimelineFrame: overlayTimelineFrame,
                    overlayOpacity: min(1, max(0, overlayOpacity))
                )
            }
        }
        return nil
    }

    public func clipSelection(for clipID: TimelineClip.ID?) -> TimelineClipSelection? {
        guard let clipID else { return nil }
        for track in displayTracks {
            if let clip = track.clips.first(where: { $0.id == clipID }) {
                return TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip)
            }
        }
        return nil
    }

    public func clipIDs(
        inTrack trackID: TimelineTrack.ID,
        intersectingFrameRange frameRange: ClosedRange<Int>
    ) -> [TimelineClip.ID] {
        let lowerFrame = max(0, min(frameRange.lowerBound, frameRange.upperBound))
        let upperFrame = max(lowerFrame, max(frameRange.lowerBound, frameRange.upperBound))
        guard let track = displayTracks.first(where: { $0.id == trackID }) else { return [] }

        return track.clips
            .sorted {
                if $0.timelineInFrame == $1.timelineInFrame { return $0.id < $1.id }
                return $0.timelineInFrame < $1.timelineInFrame
            }
            .filter { clip in
                clip.timelineInFrame <= upperFrame && clip.timelineOutFrame > lowerFrame
            }
            .map(\.id)
    }

    public func programSelection(atFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        if let visualSelection = visualProgramSelection(atFrame: normalizedFrame) {
            return visualSelection
        }
        return audioProgramSelection(atFrame: normalizedFrame)
    }

    public func visualProgramSelection(atFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        let visualTracks = Array((tracks.overlay + tracks.video).reversed())
        return selection(in: visualTracks, atFrame: normalizedFrame)
    }

    public func audioProgramSelection(atFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        return audioSelection(in: Array(tracks.audio.reversed()), atFrame: normalizedFrame)
    }

    private func selection(in orderedTracks: [TimelineTrack], atFrame frame: Int) -> TimelineClipSelection? {
        for track in orderedTracks {
            if let clip = track.clips
                .sorted(by: { $0.timelineInFrame < $1.timelineInFrame })
                .first(where: { $0.containsTimelineFrame(frame) }) {
                return TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip)
            }
        }
        return nil
    }

    private func audioSelection(in orderedTracks: [TimelineTrack], atFrame frame: Int) -> TimelineClipSelection? {
        for track in orderedTracks {
            if let clip = track.clips
                .sorted(by: audioClipSort)
                .first(where: { $0.containsTimelineFrame(frame) }) {
                return TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip)
            }
        }
        return nil
    }

    private func audioClipSort(_ lhs: TimelineClip, _ rhs: TimelineClip) -> Bool {
        if lhs.timelineInFrame != rhs.timelineInFrame {
            return lhs.timelineInFrame < rhs.timelineInFrame
        }
        let lhsPriority = audioRolePriority(lhs.role)
        let rhsPriority = audioRolePriority(rhs.role)
        if lhsPriority != rhsPriority {
            return lhsPriority < rhsPriority
        }
        return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
    }

    private func audioRolePriority(_ role: String) -> Int {
        switch role {
        case "dialogue", "A1":
            return 0
        case "voiceover":
            return 1
        case "nat_sound":
            return 2
        case "music", "bgm":
            return 3
        default:
            return 4
        }
    }

    public func programSelection(afterFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        let currentClipID = programSelection(atFrame: normalizedFrame)?.clip.id
        let boundaries = Set(displayTracks.flatMap { track in
            track.clips.flatMap { clip in
                [clip.timelineInFrame, clip.timelineOutFrame]
            }
        })
        .filter { $0 > normalizedFrame && $0 <= totalFrames }
        .sorted()

        for boundary in boundaries {
            guard let selection = programSelection(atFrame: boundary) else { continue }
            if selection.clip.id != currentClipID {
                return selection
            }
        }

        return nil
    }

    public func monitorSnapshot(atFrame frame: Int) -> TimelineMonitorSnapshot {
        let normalizedFrame = max(0, min(frame, totalFrames))
        return TimelineMonitorSnapshot(
            frame: normalizedFrame,
            timecode: sequence.framesToTimecode(normalizedFrame),
            visual: visualProgramSelection(atFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: normalizedFrame))
            },
            audio: audioProgramSelection(atFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: normalizedFrame))
            },
            program: programSelection(atFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: normalizedFrame))
            },
            nextProgram: programSelection(afterFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: $0.clip.timelineInFrame))
            }
        )
    }

    public func qaTimestampJumpTarget(for timestampSec: Double) -> QATimestampJumpTarget {
        let safeSeconds = timestampSec.isFinite ? max(0, timestampSec) : 0
        let rawFrame = (safeSeconds * sequence.fps).rounded()
        let frame: Int
        if rawFrame <= 0 {
            frame = 0
        } else if !rawFrame.isFinite || rawFrame >= Double(totalFrames) {
            frame = totalFrames
        } else {
            frame = Int(rawFrame)
        }
        return QATimestampJumpTarget(frame: frame, clipID: programSelection(atFrame: frame)?.clip.id)
    }

    public static func timelineURL(for projectURL: URL) -> URL {
        projectURL.appendingPathComponent("05_timeline/timeline.json")
    }

    public static func load(projectURL: URL) throws -> TimelineDocument {
        try load(from: timelineURL(for: projectURL))
    }

    public static func load(from url: URL) throws -> TimelineDocument {
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        let document = try decoder.decode(TimelineDocument.self, from: data)
        return TimelineDocument(
            version: document.version,
            projectID: document.projectID,
            sequence: document.sequence,
            tracks: document.tracks,
            markers: document.markers,
            transitions: document.transitions,
            sourceHash: ProjectPlaybackContractStatusReader.fileHash16(data)
        )
    }
}

public struct TimelineSequence: Decodable, Equatable, Sendable {
    public let name: String
    public let fpsNum: Int
    public let fpsDen: Int
    public let width: Int
    public let height: Int
    public let startFrame: Int
    public let outputAspectRatio: String?

    enum CodingKeys: String, CodingKey {
        case name
        case fpsNum = "fps_num"
        case fpsDen = "fps_den"
        case width
        case height
        case startFrame = "start_frame"
        case outputAspectRatio = "output_aspect_ratio"
    }

    public var fps: Double {
        guard fpsDen > 0 else { return 30 }
        return Double(fpsNum) / Double(fpsDen)
    }

    public func framesToSeconds(_ frames: Int) -> Double {
        guard fps > 0 else { return 0 }
        return Double(frames) / fps
    }

    public func framesToTimecode(_ frames: Int) -> String {
        let fpsInt = max(1, Int(fps.rounded()))
        let normalized = max(0, frames + startFrame)
        let framePart = normalized % fpsInt
        let totalSeconds = normalized / fpsInt
        let seconds = totalSeconds % 60
        let minutes = (totalSeconds / 60) % 60
        let hours = totalSeconds / 3600
        return String(format: "%02d:%02d:%02d:%02d", hours, minutes, seconds, framePart)
    }
}

public struct TimelineTrackCollection: Decodable, Equatable, Sendable {
    public let video: [TimelineTrack]
    public let audio: [TimelineTrack]
    public let overlay: [TimelineTrack]
    public let caption: [TimelineTrack]

    enum CodingKeys: String, CodingKey {
        case video
        case audio
        case overlay
        case caption
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        video = try container.decodeIfPresent([TimelineTrack].self, forKey: .video) ?? []
        audio = try container.decodeIfPresent([TimelineTrack].self, forKey: .audio) ?? []
        overlay = try container.decodeIfPresent([TimelineTrack].self, forKey: .overlay) ?? []
        caption = try container.decodeIfPresent([TimelineTrack].self, forKey: .caption) ?? []
    }

    public init(
        video: [TimelineTrack],
        audio: [TimelineTrack],
        overlay: [TimelineTrack],
        caption: [TimelineTrack]
    ) {
        self.video = video
        self.audio = audio
        self.overlay = overlay
        self.caption = caption
    }

    public var resolvedCaptionTracks: [TimelineTrack] {
        if !caption.isEmpty {
            return caption
        }

        let captionClips = video
            .flatMap { track in
                track.clips.flatMap { clip in
                    clip.generatedCaptionTrackClips(sourceTrackID: track.id)
                }
            }
            .sorted { lhs, rhs in
                if lhs.timelineInFrame == rhs.timelineInFrame {
                    return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
                }
                return lhs.timelineInFrame < rhs.timelineInFrame
            }

        guard !captionClips.isEmpty else { return [] }
        return [
            TimelineTrack(
                id: "C1",
                kind: .caption,
                clips: captionClips
            )
        ]
    }

    public func updatingClip(
        _ clipID: TimelineClip.ID,
        update: (TimelineClip) -> TimelineClip
    ) -> TimelineTrackCollection? {
        movingClip(clipID, toTrackID: nil, update: update)
    }

    public func insertingClip(
        _ clip: TimelineClip,
        targetTrackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind
    ) -> TimelineTrackCollection? {
        switch targetKind {
        case .video:
            guard let result = Self.insertingClip(clip, targetTrackID: targetTrackID, targetKind: targetKind, in: video) else {
                return nil
            }
            return TimelineTrackCollection(video: result, audio: audio, overlay: overlay, caption: caption)
        case .audio:
            guard let result = Self.insertingClip(clip, targetTrackID: targetTrackID, targetKind: targetKind, in: audio) else {
                return nil
            }
            return TimelineTrackCollection(video: video, audio: result, overlay: overlay, caption: caption)
        case .overlay:
            guard let result = Self.insertingClip(clip, targetTrackID: targetTrackID, targetKind: targetKind, in: overlay) else {
                return nil
            }
            return TimelineTrackCollection(video: video, audio: audio, overlay: result, caption: caption)
        case .caption:
            guard let result = Self.insertingClip(clip, targetTrackID: targetTrackID, targetKind: targetKind, in: caption) else {
                return nil
            }
            return TimelineTrackCollection(video: video, audio: audio, overlay: overlay, caption: result)
        }
    }

    public func movingClip(
        _ clipID: TimelineClip.ID,
        toTrackID targetTrackID: TimelineTrack.ID?,
        update: (TimelineClip) -> TimelineClip
    ) -> TimelineTrackCollection? {
        if let result = Self.movingClip(clipID, toTrackID: targetTrackID, in: video, update: update) {
            return TimelineTrackCollection(video: result, audio: audio, overlay: overlay, caption: caption)
        }
        if let result = Self.movingClip(clipID, toTrackID: targetTrackID, in: audio, update: update) {
            return TimelineTrackCollection(video: video, audio: result, overlay: overlay, caption: caption)
        }
        if let result = Self.movingClip(clipID, toTrackID: targetTrackID, in: overlay, update: update) {
            return TimelineTrackCollection(video: video, audio: audio, overlay: result, caption: caption)
        }
        if let result = Self.movingClip(clipID, toTrackID: targetTrackID, in: caption, update: update) {
            return TimelineTrackCollection(video: video, audio: audio, overlay: overlay, caption: result)
        }
        return nil
    }

    public func splittingClip(
        _ clipID: TimelineClip.ID,
        atTimelineFrame splitFrame: Int,
        rightClipID: TimelineClip.ID,
        reason: String
    ) -> TimelineTrackCollection? {
        if let result = Self.splittingClip(
            clipID,
            atTimelineFrame: splitFrame,
            rightClipID: rightClipID,
            reason: reason,
            in: video
        ) {
            return TimelineTrackCollection(video: result, audio: audio, overlay: overlay, caption: caption)
        }
        if let result = Self.splittingClip(
            clipID,
            atTimelineFrame: splitFrame,
            rightClipID: rightClipID,
            reason: reason,
            in: audio
        ) {
            return TimelineTrackCollection(video: video, audio: result, overlay: overlay, caption: caption)
        }
        if let result = Self.splittingClip(
            clipID,
            atTimelineFrame: splitFrame,
            rightClipID: rightClipID,
            reason: reason,
            in: overlay
        ) {
            return TimelineTrackCollection(video: video, audio: audio, overlay: result, caption: caption)
        }
        if let result = Self.splittingClip(
            clipID,
            atTimelineFrame: splitFrame,
            rightClipID: rightClipID,
            reason: reason,
            in: caption
        ) {
            return TimelineTrackCollection(video: video, audio: audio, overlay: overlay, caption: result)
        }
        return nil
    }

    private static func movingClip(
        _ clipID: TimelineClip.ID,
        toTrackID targetTrackID: TimelineTrack.ID?,
        in tracks: [TimelineTrack],
        update: (TimelineClip) -> TimelineClip
    ) -> [TimelineTrack]? {
        guard let sourceTrackIndex = tracks.firstIndex(where: { track in
            track.clips.contains(where: { $0.id == clipID })
        }) else {
            return nil
        }
        let sourceTrack = tracks[sourceTrackIndex]
        guard let sourceClipIndex = sourceTrack.clips.firstIndex(where: { $0.id == clipID }) else {
            return nil
        }
        let resolvedTargetTrackID = targetTrackID ?? sourceTrack.id
        guard !resolvedTargetTrackID.isEmpty else { return nil }
        if resolvedTargetTrackID == sourceTrack.id {
            return updatingClip(clipID, in: tracks, update: update)
        }

        var updatedTracks = tracks
        let movedClip = update(sourceTrack.clips[sourceClipIndex])
        var sourceClips = sourceTrack.clips
        sourceClips.remove(at: sourceClipIndex)
        updatedTracks[sourceTrackIndex] = TimelineTrack(
            id: sourceTrack.id,
            kind: sourceTrack.kind,
            clips: sortedClips(sourceClips)
        )

        let targetTrackIndex: Int
        if let existingTargetIndex = updatedTracks.firstIndex(where: { $0.id == resolvedTargetTrackID }) {
            guard updatedTracks[existingTargetIndex].kind == sourceTrack.kind else { return nil }
            targetTrackIndex = existingTargetIndex
        } else {
            updatedTracks.append(TimelineTrack(id: resolvedTargetTrackID, kind: sourceTrack.kind, clips: []))
            targetTrackIndex = updatedTracks.count - 1
        }

        let targetTrack = updatedTracks[targetTrackIndex]
        updatedTracks[targetTrackIndex] = TimelineTrack(
            id: targetTrack.id,
            kind: targetTrack.kind,
            clips: sortedClips(targetTrack.clips + [movedClip])
        )
        return updatedTracks
    }

    private static func insertingClip(
        _ clip: TimelineClip,
        targetTrackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind,
        in tracks: [TimelineTrack]
    ) -> [TimelineTrack]? {
        guard !targetTrackID.isEmpty else { return nil }
        var updatedTracks = tracks
        if let targetTrackIndex = updatedTracks.firstIndex(where: { $0.id == targetTrackID }) {
            let targetTrack = updatedTracks[targetTrackIndex]
            guard targetTrack.kind == targetKind else { return nil }
            updatedTracks[targetTrackIndex] = TimelineTrack(
                id: targetTrack.id,
                kind: targetTrack.kind,
                clips: sortedClips(targetTrack.clips + [clip])
            )
        } else {
            updatedTracks.append(TimelineTrack(
                id: targetTrackID,
                kind: targetKind,
                clips: [clip]
            ))
        }
        return updatedTracks.sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
    }

    private static func sortedClips(_ clips: [TimelineClip]) -> [TimelineClip] {
        clips.sorted {
            if $0.timelineInFrame == $1.timelineInFrame {
                return $0.id < $1.id
            }
            return $0.timelineInFrame < $1.timelineInFrame
        }
    }

    private static func updatingClip(
        _ clipID: TimelineClip.ID,
        in tracks: [TimelineTrack],
        update: (TimelineClip) -> TimelineClip
    ) -> [TimelineTrack]? {
        guard let trackIndex = tracks.firstIndex(where: { track in
            track.clips.contains(where: { $0.id == clipID })
        }) else {
            return nil
        }
        var updatedTracks = tracks
        updatedTracks[trackIndex] = updatedTracks[trackIndex].updatingClip(clipID, update: update)
        return updatedTracks
    }

    private static func splittingClip(
        _ clipID: TimelineClip.ID,
        atTimelineFrame splitFrame: Int,
        rightClipID: TimelineClip.ID,
        reason: String,
        in tracks: [TimelineTrack]
    ) -> [TimelineTrack]? {
        guard let trackIndex = tracks.firstIndex(where: { track in
            track.clips.contains(where: { $0.id == clipID })
        }) else {
            return nil
        }
        let track = tracks[trackIndex]
        guard let clipIndex = track.clips.firstIndex(where: { $0.id == clipID }),
              let split = track.clips[clipIndex].splitting(
                atTimelineFrame: splitFrame,
                rightClipID: rightClipID,
                reason: reason
              )
        else {
            return nil
        }
        var updatedClips = track.clips
        updatedClips.remove(at: clipIndex)
        updatedClips.insert(contentsOf: [split.left, split.right], at: clipIndex)

        var updatedTracks = tracks
        updatedTracks[trackIndex] = TimelineTrack(
            id: track.id,
            kind: track.kind,
            clips: sortedClips(updatedClips)
        )
        return updatedTracks
    }
}

public struct TimelineTrack: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: TimelineTrackKind
    public let clips: [TimelineClip]

    enum CodingKeys: String, CodingKey {
        case id = "track_id"
        case kind
        case clips
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decodeIfPresent(TimelineTrackKind.self, forKey: .kind) ?? TimelineTrackKind(inferredFromTrackID: id)
        clips = try container.decodeIfPresent([TimelineClip].self, forKey: .clips) ?? []
    }

    public init(id: String, kind: TimelineTrackKind, clips: [TimelineClip]) {
        self.id = id
        self.kind = kind
        self.clips = clips
    }

    public func updatingClip(
        _ clipID: TimelineClip.ID,
        update: (TimelineClip) -> TimelineClip
    ) -> TimelineTrack {
        TimelineTrack(
            id: id,
            kind: kind,
            clips: clips.map { $0.id == clipID ? update($0) : $0 }
        )
    }
}

public enum TimelineTrackKind: String, Decodable, Equatable, Sendable {
    case video
    case audio
    case overlay
    case caption

    init(inferredFromTrackID trackID: String) {
        switch trackID.uppercased().first {
        case "A": self = .audio
        case "O": self = .overlay
        case "C": self = .caption
        default: self = .video
        }
    }
}

public struct TimelineCaptionOverlay: Decodable, Equatable, Sendable {
    public let text: String
    public let inFrame: Int
    public let outFrame: Int
    public let style: String

    enum CodingKeys: String, CodingKey {
        case text
        case inFrame = "in_frame"
        case outFrame = "out_frame"
        case style
    }

    public init(text: String, inFrame: Int, outFrame: Int, style: String) {
        self.text = text
        self.inFrame = inFrame
        self.outFrame = outFrame
        self.style = style
    }

    public var durationFrames: Int {
        max(0, outFrame - inFrame)
    }

    public func moving(by frameDelta: Int) -> TimelineCaptionOverlay {
        TimelineCaptionOverlay(
            text: text,
            inFrame: inFrame + frameDelta,
            outFrame: outFrame + frameDelta,
            style: style
        )
    }

    public func clipped(toTimelineInFrame timelineInFrame: Int, timelineOutFrame: Int) -> TimelineCaptionOverlay? {
        let clippedInFrame = max(inFrame, timelineInFrame)
        let clippedOutFrame = min(outFrame, timelineOutFrame)
        guard clippedOutFrame > clippedInFrame else { return nil }
        return TimelineCaptionOverlay(
            text: text,
            inFrame: clippedInFrame,
            outFrame: clippedOutFrame,
            style: style
        )
    }
}

public struct TimelineClip: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let segmentID: String
    public let assetID: String
    public let sourceInUS: Int?
    public let sourceOutUS: Int?
    public let timelineInFrame: Int
    public let timelineDurationFrames: Int
    public let role: String
    public let motivation: String
    public let confidence: Double?
    public let beatID: String?
    public let fallbackSegmentIDs: [String]
    public let qualityFlags: [String]
    public let candidateRef: String?
    public let captions: [TimelineCaptionOverlay]

    enum CodingKeys: String, CodingKey {
        case id = "clip_id"
        case segmentID = "segment_id"
        case assetID = "asset_id"
        case sourceInUS = "src_in_us"
        case sourceOutUS = "src_out_us"
        case timelineInFrame = "timeline_in_frame"
        case timelineDurationFrames = "timeline_duration_frames"
        case role
        case motivation
        case confidence
        case beatID = "beat_id"
        case fallbackSegmentIDs = "fallback_segment_ids"
        case qualityFlags = "quality_flags"
        case candidateRef = "candidate_ref"
        case captions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        segmentID = try container.decode(String.self, forKey: .segmentID)
        assetID = try container.decode(String.self, forKey: .assetID)
        sourceInUS = try container.decodeIfPresent(Int.self, forKey: .sourceInUS)
        sourceOutUS = try container.decodeIfPresent(Int.self, forKey: .sourceOutUS)
        timelineInFrame = try container.decode(Int.self, forKey: .timelineInFrame)
        timelineDurationFrames = try container.decode(Int.self, forKey: .timelineDurationFrames)
        role = try container.decode(String.self, forKey: .role)
        motivation = try container.decode(String.self, forKey: .motivation)
        confidence = try container.decodeIfPresent(Double.self, forKey: .confidence)
        beatID = try container.decodeIfPresent(String.self, forKey: .beatID)
        fallbackSegmentIDs = try container.decodeIfPresent([String].self, forKey: .fallbackSegmentIDs) ?? []
        qualityFlags = try container.decodeIfPresent([String].self, forKey: .qualityFlags) ?? []
        candidateRef = try container.decodeIfPresent(String.self, forKey: .candidateRef)
        captions = try container.decodeIfPresent([TimelineCaptionOverlay].self, forKey: .captions) ?? []
    }

    public init(
        id: String,
        segmentID: String,
        assetID: String,
        sourceInUS: Int?,
        sourceOutUS: Int?,
        timelineInFrame: Int,
        timelineDurationFrames: Int,
        role: String,
        motivation: String,
        confidence: Double?,
        beatID: String?,
        fallbackSegmentIDs: [String],
        qualityFlags: [String],
        candidateRef: String?,
        captions: [TimelineCaptionOverlay] = []
    ) {
        self.id = id
        self.segmentID = segmentID
        self.assetID = assetID
        self.sourceInUS = sourceInUS
        self.sourceOutUS = sourceOutUS
        self.timelineInFrame = timelineInFrame
        self.timelineDurationFrames = timelineDurationFrames
        self.role = role
        self.motivation = motivation
        self.confidence = confidence
        self.beatID = beatID
        self.fallbackSegmentIDs = fallbackSegmentIDs
        self.qualityFlags = qualityFlags
        self.candidateRef = candidateRef
        self.captions = captions
    }

    public var timelineOutFrame: Int {
        timelineInFrame + timelineDurationFrames
    }

    public var sourceDurationSeconds: Double? {
        guard let sourceInUS, let sourceOutUS, sourceOutUS >= sourceInUS else { return nil }
        return Double(sourceOutUS - sourceInUS) / 1_000_000
    }

    public func containsTimelineFrame(_ frame: Int) -> Bool {
        timelineInFrame <= frame && frame < timelineOutFrame
    }

    public func sourceTimeUS(atTimelineFrame frame: Int) -> Int? {
        guard let sourceInUS, let sourceOutUS else { return sourceInUS }
        let sourceDurationUS = max(0, sourceOutUS - sourceInUS)
        guard sourceDurationUS > 0, timelineDurationFrames > 0 else { return sourceInUS }
        let frameOffset = max(0, min(frame - timelineInFrame, timelineDurationFrames))
        let ratio = Double(frameOffset) / Double(timelineDurationFrames)
        return sourceInUS + Int((Double(sourceDurationUS) * ratio).rounded())
    }

    public func moving(toTimelineInFrame timelineInFrame: Int, durationFrames: Int? = nil) -> TimelineClip {
        let frameDelta = timelineInFrame - self.timelineInFrame
        let resolvedDurationFrames = durationFrames ?? timelineDurationFrames
        return TimelineClip(
            id: id,
            segmentID: segmentID,
            assetID: assetID,
            sourceInUS: sourceInUS,
            sourceOutUS: sourceOutUS,
            timelineInFrame: timelineInFrame,
            timelineDurationFrames: resolvedDurationFrames,
            role: role,
            motivation: motivation,
            confidence: confidence,
            beatID: beatID,
            fallbackSegmentIDs: fallbackSegmentIDs,
            qualityFlags: qualityFlags,
            candidateRef: candidateRef,
            captions: captions.compactMap {
                $0.moving(by: frameDelta).clipped(
                    toTimelineInFrame: timelineInFrame,
                    timelineOutFrame: timelineInFrame + resolvedDurationFrames
                )
            }
        )
    }

    public func trimming(sourceInUS: Int, sourceOutUS: Int) -> TimelineClip {
        TimelineClip(
            id: id,
            segmentID: segmentID,
            assetID: assetID,
            sourceInUS: sourceInUS,
            sourceOutUS: sourceOutUS,
            timelineInFrame: timelineInFrame,
            timelineDurationFrames: timelineDurationFrames,
            role: role,
            motivation: motivation,
            confidence: confidence,
            beatID: beatID,
            fallbackSegmentIDs: fallbackSegmentIDs,
            qualityFlags: qualityFlags,
            candidateRef: candidateRef,
            captions: captions
        )
    }

    public func splitting(
        atTimelineFrame splitFrame: Int,
        rightClipID: TimelineClip.ID,
        reason: String
    ) -> (left: TimelineClip, right: TimelineClip)? {
        guard !rightClipID.isEmpty, rightClipID != id else { return nil }
        guard timelineInFrame < splitFrame, splitFrame < timelineOutFrame else { return nil }
        guard let sourceInUS, let sourceOutUS,
              sourceOutUS > sourceInUS,
              let splitSourceUS = sourceTimeUS(atTimelineFrame: splitFrame),
              sourceInUS < splitSourceUS,
              splitSourceUS < sourceOutUS else {
            return nil
        }

        let leftDurationFrames = splitFrame - timelineInFrame
        let rightDurationFrames = timelineOutFrame - splitFrame
        guard leftDurationFrames > 0, rightDurationFrames > 0 else { return nil }

        let left = TimelineClip(
            id: id,
            segmentID: segmentID,
            assetID: assetID,
            sourceInUS: sourceInUS,
            sourceOutUS: splitSourceUS,
            timelineInFrame: timelineInFrame,
            timelineDurationFrames: leftDurationFrames,
            role: role,
            motivation: "[patch:split:left] \(reason)",
            confidence: confidence,
            beatID: beatID,
            fallbackSegmentIDs: fallbackSegmentIDs,
            qualityFlags: qualityFlags,
            candidateRef: candidateRef,
            captions: captions.compactMap {
                $0.clipped(toTimelineInFrame: timelineInFrame, timelineOutFrame: splitFrame)
            }
        )
        let right = TimelineClip(
            id: rightClipID,
            segmentID: segmentID,
            assetID: assetID,
            sourceInUS: splitSourceUS,
            sourceOutUS: sourceOutUS,
            timelineInFrame: splitFrame,
            timelineDurationFrames: rightDurationFrames,
            role: role,
            motivation: "[patch:split:right] \(reason)",
            confidence: confidence,
            beatID: beatID,
            fallbackSegmentIDs: fallbackSegmentIDs,
            qualityFlags: qualityFlags,
            candidateRef: candidateRef,
            captions: captions.compactMap {
                $0.clipped(toTimelineInFrame: splitFrame, timelineOutFrame: timelineOutFrame)
            }
        )
        return (left, right)
    }

    public func replacing(
        with candidate: BrowserCandidate,
        reason: String,
        sourceRangeOverride: TimelineSourceRangeOverride? = nil
    ) -> TimelineClip {
        let sourceInUS = sourceRangeOverride?.sourceInUS ?? candidate.src_in_us
        let sourceOutUS = sourceRangeOverride?.sourceOutUS ?? candidate.src_out_us
        return TimelineClip(
            id: id,
            segmentID: candidate.segment_id,
            assetID: candidate.asset_id,
            sourceInUS: sourceInUS,
            sourceOutUS: sourceOutUS,
            timelineInFrame: timelineInFrame,
            timelineDurationFrames: timelineDurationFrames,
            role: candidate.role == "reject" ? role : candidate.role,
            motivation: "[studio:replace] \(reason)",
            confidence: candidate.confidence,
            beatID: beatID,
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: candidate.id
        )
    }

    public var captionText: String? {
        captions.first?.text
    }

    func generatedCaptionTrackClips(sourceTrackID: TimelineTrack.ID) -> [TimelineClip] {
        captions.enumerated().compactMap { index, caption in
            guard let clipped = caption.clipped(
                toTimelineInFrame: timelineInFrame,
                timelineOutFrame: timelineOutFrame
            ) else {
                return nil
            }

            return TimelineClip(
                id: "\(id)__caption_\(index + 1)",
                segmentID: clipped.text,
                assetID: assetID,
                sourceInUS: nil,
                sourceOutUS: nil,
                timelineInFrame: clipped.inFrame,
                timelineDurationFrames: clipped.durationFrames,
                role: "caption",
                motivation: "[studio:caption-track] \(sourceTrackID) / \(id)",
                confidence: confidence,
                beatID: beatID,
                fallbackSegmentIDs: [],
                qualityFlags: qualityFlags,
                candidateRef: candidateRef,
                captions: [clipped]
            )
        }
    }
}

public struct TimelineClipSelection: Equatable, Sendable {
    public let trackID: String
    public let trackKind: TimelineTrackKind
    public let clip: TimelineClip

    public init(trackID: String, trackKind: TimelineTrackKind, clip: TimelineClip) {
        self.trackID = trackID
        self.trackKind = trackKind
        self.clip = clip
    }
}

public struct TimelineActiveTransitionPreview: Equatable, Sendable {
    public let transition: TimelineTransition
    public let trackID: TimelineTrack.ID
    public let boundaryFrame: Int
    public let startFrame: Int
    public let endFrame: Int
    public let progress: Double
    public let overlaySelection: TimelineClipSelection
    public let overlayTimelineFrame: Int
    public let overlayOpacity: Double
}

public struct TimelineTransition: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let fromClipID: String
    public let toClipID: String
    public let trackID: String
    public let transitionType: String
    public let transitionFrames: Int?
    public let appliedSkillID: String?

    enum CodingKeys: String, CodingKey {
        case id = "transition_id"
        case fromClipID = "from_clip_id"
        case toClipID = "to_clip_id"
        case trackID = "track_id"
        case transitionType = "transition_type"
        case transitionFrames = "transition_frames"
        case appliedSkillID = "applied_skill_id"
    }

    public init(
        id: String,
        fromClipID: String,
        toClipID: String,
        trackID: String,
        transitionType: String,
        transitionFrames: Int?,
        appliedSkillID: String?
    ) {
        self.id = id
        self.fromClipID = fromClipID
        self.toClipID = toClipID
        self.trackID = trackID
        self.transitionType = transitionType
        self.transitionFrames = transitionFrames
        self.appliedSkillID = appliedSkillID
    }

    public static func stableID(trackID: String, fromClipID: String, toClipID: String) -> String {
        "TRN_\(trackID)_\(fromClipID)_\(toClipID)"
    }

    public var isVisibleTimelineTransition: Bool {
        guard let transitionFrames, transitionFrames > 0 else { return false }
        return transitionType.lowercased() != "cut"
    }
}

public struct TimelineMonitorSnapshot: Equatable, Sendable {
    public let frame: Int
    public let timecode: String
    public let visual: TimelineMonitorClip?
    public let audio: TimelineMonitorClip?
    public let program: TimelineMonitorClip?
    public let nextProgram: TimelineMonitorClip?
}

public struct QATimestampJumpTarget: Equatable, Sendable {
    public let frame: Int
    public let clipID: TimelineClip.ID?
}

public struct TimelineMonitorClip: Equatable, Sendable {
    public let trackID: String
    public let trackKind: TimelineTrackKind
    public let clipID: String
    public let assetID: String
    public let sourceTimeUS: Int?

    public init(selection: TimelineClipSelection, sourceTimeUS: Int?) {
        trackID = selection.trackID
        trackKind = selection.trackKind
        clipID = selection.clip.id
        assetID = selection.clip.assetID
        self.sourceTimeUS = sourceTimeUS
    }
}

public struct TimelinePlaybackSyncState: Equatable, Sendable {
    public private(set) var generation: Int
    public private(set) var lastProgramClipID: TimelineClip.ID?

    public init(generation: Int = 0, lastProgramClipID: TimelineClip.ID? = nil) {
        self.generation = generation
        self.lastProgramClipID = lastProgramClipID
    }

    @discardableResult
    public mutating func update(timeline: TimelineDocument?, frame: Int, forceSeek: Bool) -> Int {
        let currentClipID = timeline?.programSelection(atFrame: frame)?.clip.id
        return update(currentClipID: currentClipID, forceSeek: forceSeek)
    }

    @discardableResult
    public mutating func update(currentClipID: TimelineClip.ID?, forceSeek: Bool) -> Int {
        if forceSeek || currentClipID != lastProgramClipID {
            generation &+= 1
        }
        lastProgramClipID = currentClipID
        return generation
    }
}

public struct TimelineMarker: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let frame: Int
    public let label: String
    public let kind: String?

    enum CodingKeys: String, CodingKey {
        case id = "marker_id"
        case frame
        case label
        case kind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        frame = try container.decode(Int.self, forKey: .frame)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? "\(kind ?? "marker")-\(frame)-\(label)"
    }
}
