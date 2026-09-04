import AVFoundation
import Foundation
import Vision

public struct InterviewFaceObservation: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let eyeX: Double?
    public let eyeY: Double?
    public let yawRadians: Double?
    public let confidence: Double

    public init(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        eyeX: Double? = nil,
        eyeY: Double? = nil,
        yawRadians: Double? = nil,
        confidence: Double
    ) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.eyeX = eyeX
        self.eyeY = eyeY
        self.yawRadians = yawRadians
        self.confidence = confidence
    }

    public var centerX: Double { x + width / 2 }
    public var estimatedEyeY: Double { eyeY ?? (y + height * 0.68) }
    public var estimatedEyeX: Double { eyeX ?? centerX }

    public func estimatedEyeY(headRatio: Double) -> Double {
        eyeY ?? (y + height * headRatio)
    }
}

public struct InterviewHandObservation: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let confidence: Double

    public init(x: Double, y: Double, confidence: Double) {
        self.x = x
        self.y = y
        self.confidence = confidence
    }
}

public struct InterviewFramingSample: Equatable, Sendable {
    public let timeSeconds: Double
    public let face: InterviewFaceObservation?
    public let hands: [InterviewHandObservation]

    public init(timeSeconds: Double, face: InterviewFaceObservation?, hands: [InterviewHandObservation]) {
        self.timeSeconds = timeSeconds
        self.face = face
        self.hands = hands
    }
}

public enum InterviewFramingMode: String, Codable, Sendable {
    case wide
    case punch
    case hold
}

/// Explicit values for the existing Studio framing contract. The TypeScript
/// compiler consumes the project framing-policy artifact; Studio keeps this
/// Codable contract so the same policy can be supplied without creating a
/// second transform or renderer contract.
public struct InterviewFramingPolicy: Codable, Equatable, Sendable {
    public let policyID: String
    public let version: String
    public let personMinConfidence: Double
    public let headMinConfidence: Double
    public let headEyeYRatio: Double
    public let handMinConfidence: Double
    public let handMaxZoom: Double
    public let handSafeLeft: Double
    public let handSafeTop: Double
    public let handSafeRight: Double
    public let handSafeBottom: Double
    public let lookRoomYawThresholdRadians: Double
    public let minimumZoomWhenLooking: Double
    public let positiveYawTargetX: Double
    public let negativeYawTargetX: Double
    public let neutralTargetX: Double
    public let lookRoomMinimumMargin: Double
    public let headroomMinimumTopMargin: Double
    public let targetEyeY: Double
    public let wideMaxZoom: Double
    public let punchMaxZoom: Double
    public let holdMaxZoom: Double
    public let wideTargetHeadHeight: Double
    public let punchTargetHeadHeight: Double
    public let holdTargetHeadHeight: Double
    public let maxPanFraction: Double
    public let coverageWeight: Double
    public let observationWeight: Double
    public let stabilityWeight: Double
    public let stabilityReferenceSpan: Double
    public let degradeZoomStep: Double

    public init(
        policyID: String,
        version: String,
        personMinConfidence: Double,
        headMinConfidence: Double,
        headEyeYRatio: Double,
        handMinConfidence: Double,
        handMaxZoom: Double,
        handSafeLeft: Double,
        handSafeTop: Double,
        handSafeRight: Double,
        handSafeBottom: Double,
        lookRoomYawThresholdRadians: Double,
        minimumZoomWhenLooking: Double,
        positiveYawTargetX: Double,
        negativeYawTargetX: Double,
        neutralTargetX: Double,
        lookRoomMinimumMargin: Double,
        headroomMinimumTopMargin: Double,
        targetEyeY: Double,
        wideMaxZoom: Double,
        punchMaxZoom: Double,
        holdMaxZoom: Double,
        wideTargetHeadHeight: Double,
        punchTargetHeadHeight: Double,
        holdTargetHeadHeight: Double,
        maxPanFraction: Double,
        coverageWeight: Double,
        observationWeight: Double,
        stabilityWeight: Double,
        stabilityReferenceSpan: Double,
        degradeZoomStep: Double
    ) {
        self.policyID = policyID
        self.version = version
        self.personMinConfidence = personMinConfidence
        self.headMinConfidence = headMinConfidence
        self.headEyeYRatio = headEyeYRatio
        self.handMinConfidence = handMinConfidence
        self.handMaxZoom = handMaxZoom
        self.handSafeLeft = handSafeLeft
        self.handSafeTop = handSafeTop
        self.handSafeRight = handSafeRight
        self.handSafeBottom = handSafeBottom
        self.lookRoomYawThresholdRadians = lookRoomYawThresholdRadians
        self.minimumZoomWhenLooking = minimumZoomWhenLooking
        self.positiveYawTargetX = positiveYawTargetX
        self.negativeYawTargetX = negativeYawTargetX
        self.neutralTargetX = neutralTargetX
        self.lookRoomMinimumMargin = lookRoomMinimumMargin
        self.headroomMinimumTopMargin = headroomMinimumTopMargin
        self.targetEyeY = targetEyeY
        self.wideMaxZoom = wideMaxZoom
        self.punchMaxZoom = punchMaxZoom
        self.holdMaxZoom = holdMaxZoom
        self.wideTargetHeadHeight = wideTargetHeadHeight
        self.punchTargetHeadHeight = punchTargetHeadHeight
        self.holdTargetHeadHeight = holdTargetHeadHeight
        self.maxPanFraction = maxPanFraction
        self.coverageWeight = coverageWeight
        self.observationWeight = observationWeight
        self.stabilityWeight = stabilityWeight
        self.stabilityReferenceSpan = stabilityReferenceSpan
        self.degradeZoomStep = degradeZoomStep
    }

    public static let studioContractV1 = InterviewFramingPolicy(
        policyID: "studio-interview-framing-v1",
        version: "framing-policy/v1",
        personMinConfidence: 0.45,
        headMinConfidence: 0.45,
        headEyeYRatio: 0.68,
        handMinConfidence: 0.35,
        handMaxZoom: 1.15,
        handSafeLeft: 0.05,
        handSafeTop: 0.06,
        handSafeRight: 0.95,
        handSafeBottom: 0.94,
        lookRoomYawThresholdRadians: 0.12,
        minimumZoomWhenLooking: 1.06,
        positiveYawTargetX: 0.42,
        negativeYawTargetX: 0.58,
        neutralTargetX: 0.50,
        lookRoomMinimumMargin: 0.08,
        headroomMinimumTopMargin: 0.04,
        targetEyeY: 0.64,
        wideMaxZoom: 1.0,
        punchMaxZoom: 1.18,
        holdMaxZoom: 1.18,
        wideTargetHeadHeight: 0.20,
        punchTargetHeadHeight: 0.34,
        holdTargetHeadHeight: 0.28,
        maxPanFraction: 0.96,
        coverageWeight: 0.5,
        observationWeight: 0.3,
        stabilityWeight: 0.2,
        stabilityReferenceSpan: 0.2,
        degradeZoomStep: 0.02
    )
}

public struct InterviewReframeProposal: Equatable, Sendable {
    public let zoom: Double
    public let positionX: Double
    public let positionY: Double
    public let confidence: Double
    public let analyzedSampleCount: Int
    public let faceSampleCount: Int
    public let gestureSampleCount: Int
    public let reason: String

    public init(
        zoom: Double,
        positionX: Double,
        positionY: Double,
        confidence: Double,
        analyzedSampleCount: Int,
        faceSampleCount: Int,
        gestureSampleCount: Int,
        reason: String
    ) {
        self.zoom = zoom
        self.positionX = positionX
        self.positionY = positionY
        self.confidence = confidence
        self.analyzedSampleCount = analyzedSampleCount
        self.faceSampleCount = faceSampleCount
        self.gestureSampleCount = gestureSampleCount
        self.reason = reason
    }

    public var visualTransform: ReviewVisualTransform {
        ReviewVisualTransform(
            zoom: zoom,
            position: .init(x: positionX, y: positionY)
        )
    }
}

public enum InterviewAutoReframePlanner {
    public static func propose(
        samples: [InterviewFramingSample],
        outputWidth: Int,
        outputHeight: Int,
        policy: InterviewFramingPolicy = .studioContractV1,
        mode: InterviewFramingMode = .punch
    ) -> InterviewReframeProposal? {
        guard outputWidth > 0, outputHeight > 0, !samples.isEmpty else { return nil }
        let faces = samples.compactMap(\.face).filter {
            $0.confidence >= max(policy.personMinConfidence, policy.headMinConfidence)
                && $0.width > 0
                && $0.height > 0
                && $0.centerX.isFinite
                && $0.estimatedEyeY(headRatio: policy.headEyeYRatio).isFinite
        }
        guard !faces.isEmpty else { return nil }

        let faceHeight = median(faces.map(\.height))
        let faceCenterX = median(faces.map(\.estimatedEyeX))
        let eyeY = median(faces.map { $0.estimatedEyeY(headRatio: policy.headEyeYRatio) })
        let yaw = median(faces.compactMap(\.yawRadians))
        let confidentHands = samples
            .flatMap(\.hands)
            .filter { $0.confidence >= policy.handMinConfidence && $0.x.isFinite && $0.y.isFinite }
        let gestureSampleCount = samples.filter { sample in
            sample.hands.contains { $0.confidence >= policy.handMinConfidence }
        }.count

        let modeMaxZoom: Double
        let targetHeadHeight: Double
        switch mode {
        case .wide:
            modeMaxZoom = policy.wideMaxZoom
            targetHeadHeight = policy.wideTargetHeadHeight
        case .punch:
            modeMaxZoom = policy.punchMaxZoom
            targetHeadHeight = policy.punchTargetHeadHeight
        case .hold:
            modeMaxZoom = policy.holdMaxZoom
            targetHeadHeight = policy.holdTargetHeadHeight
        }
        let maximumZoom = confidentHands.isEmpty ? modeMaxZoom : min(modeMaxZoom, policy.handMaxZoom)
        var zoom = min(maximumZoom, max(1, targetHeadHeight / max(0.01, faceHeight)))
        if abs(yaw) > policy.lookRoomYawThresholdRadians {
            // A small overscan reserve is required to create real look-room;
            // without it, a centered 1.0x frame has nowhere safe to pan.
            zoom = max(zoom, policy.minimumZoomWhenLooking)
        }
        let targetFaceX: Double
        if yaw > policy.lookRoomYawThresholdRadians {
            targetFaceX = policy.positiveYawTargetX
        } else if yaw < -policy.lookRoomYawThresholdRadians {
            targetFaceX = policy.negativeYawTargetX
        } else {
            targetFaceX = policy.neutralTargetX
        }
        let targetEyeY = policy.targetEyeY

        func position(for proposedZoom: Double) -> (x: Double, y: Double) {
            let zoomedFaceX = (faceCenterX - 0.5) * proposedZoom + 0.5
            let zoomedEyeY = (eyeY - 0.5) * proposedZoom + 0.5
            let rawX = (targetFaceX - zoomedFaceX) * Double(outputWidth)
            let rawY = (zoomedEyeY - targetEyeY) * Double(outputHeight)
            let maximumX = Double(outputWidth) * (proposedZoom - 1) / 2 * policy.maxPanFraction
            let maximumY = Double(outputHeight) * (proposedZoom - 1) / 2 * policy.maxPanFraction
            return (
                x: min(maximumX, max(-maximumX, rawX)),
                y: min(maximumY, max(-maximumY, rawY))
            )
        }

        // Keep detected wrists inside a conservative action-safe frame. Reduce
        // the punch-in before sacrificing a visible gesture.
        while zoom > 1.001 {
            let candidatePosition = position(for: zoom)
            let handsAreSafe = confidentHands.allSatisfy { hand in
                let x = (hand.x - 0.5) * zoom + 0.5 + candidatePosition.x / Double(outputWidth)
                let y = (hand.y - 0.5) * zoom + 0.5 - candidatePosition.y / Double(outputHeight)
                return (policy.handSafeLeft ... policy.handSafeRight).contains(x)
                    && (policy.handSafeTop ... policy.handSafeBottom).contains(y)
            }
            let headroomIsSafe = faces.allSatisfy { face in
                let top = (face.y - 0.5) * zoom + 0.5 - candidatePosition.y / Double(outputHeight)
                return top >= policy.headroomMinimumTopMargin
            }
            if handsAreSafe && headroomIsSafe { break }
            zoom = max(1, zoom - policy.degradeZoomStep)
        }

        let finalPosition = position(for: zoom)
        let coverage = Double(faces.count) / Double(samples.count)
        let averageFaceConfidence = faces.map(\.confidence).reduce(0, +) / Double(faces.count)
        let centerSpread = percentileSpread(faces.map(\.centerX))
        let stability = max(0, 1 - centerSpread / policy.stabilityReferenceSpan)
        let confidence = min(1, max(0,
            coverage * policy.coverageWeight
                + averageFaceConfidence * policy.observationWeight
                + stability * policy.stabilityWeight
        ))
        let reason = gestureSampleCount > 0
            ? "顔・目線方向を整え、検出した手振りを安全域に残す画角"
            : "顔・目線方向とアイラインを基準に整えた画角"

        return InterviewReframeProposal(
            zoom: rounded(zoom, places: 3),
            positionX: rounded(finalPosition.x, places: 1),
            positionY: rounded(finalPosition.y, places: 1),
            confidence: rounded(confidence, places: 3),
            analyzedSampleCount: samples.count,
            faceSampleCount: faces.count,
            gestureSampleCount: gestureSampleCount,
            reason: reason
        )
    }

    private static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let middle = sorted.count / 2
        if sorted.count.isMultiple(of: 2) {
            return (sorted[middle - 1] + sorted[middle]) / 2
        }
        return sorted[middle]
    }

    private static func percentileSpread(_ values: [Double]) -> Double {
        guard let first = values.min(), let last = values.max() else { return 1 }
        return last - first
    }

    private static func rounded(_ value: Double, places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (value * scale).rounded() / scale
    }
}

public enum InterviewAutoReframeAnalyzerError: LocalizedError {
    case missingVideo
    case noUsableFace

    public var errorDescription: String? {
        switch self {
        case .missingVideo:
            return "解析できる動画素材がありません。"
        case .noUsableFace:
            return "代表フレームから安定した顔を検出できませんでした。"
        }
    }
}

public enum InterviewAutoReframeAnalyzer {
    public static func analyze(
        url: URL,
        sourceInUS: Int?,
        sourceOutUS: Int?,
        outputWidth: Int,
        outputHeight: Int,
        sampleCount: Int = 9,
        policy: InterviewFramingPolicy = .studioContractV1,
        mode: InterviewFramingMode = .punch
    ) async throws -> InterviewReframeProposal {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else {
            throw InterviewAutoReframeAnalyzerError.missingVideo
        }
        let requestedStart = Double(max(0, sourceInUS ?? 0)) / 1_000_000
        let requestedEnd = Double(max(sourceInUS ?? 0, sourceOutUS ?? Int(duration * 1_000_000))) / 1_000_000
        let start = min(duration, requestedStart)
        let end = min(duration, max(start, requestedEnd))
        let boundedSampleCount = max(3, min(15, sampleCount))

        let samples = try await Task.detached(priority: .userInitiated) {
            try sampleFrames(
                asset: asset,
                startSeconds: start,
                endSeconds: end,
                sampleCount: boundedSampleCount
            )
        }.value
        guard let proposal = InterviewAutoReframePlanner.propose(
            samples: samples,
            outputWidth: outputWidth,
            outputHeight: outputHeight,
            policy: policy,
            mode: mode
        ) else {
            throw InterviewAutoReframeAnalyzerError.noUsableFace
        }
        return proposal
    }

    private static func sampleFrames(
        asset: AVAsset,
        startSeconds: Double,
        endSeconds: Double,
        sampleCount: Int
    ) throws -> [InterviewFramingSample] {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 960, height: 540)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.08, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.08, preferredTimescale: 600)
        let span = max(0, endSeconds - startSeconds)
        let times = (0 ..< sampleCount).map { index -> Double in
            guard sampleCount > 1 else { return startSeconds }
            let fraction = (Double(index) + 0.5) / Double(sampleCount)
            return startSeconds + span * fraction
        }

        return times.compactMap { timeSeconds in
            let time = CMTime(seconds: timeSeconds, preferredTimescale: 600)
            guard let image = try? generator.copyCGImage(at: time, actualTime: nil) else { return nil }
            return visionSample(image: image, timeSeconds: timeSeconds)
        }
    }

    private static func visionSample(image: CGImage, timeSeconds: Double) -> InterviewFramingSample {
        let faceRequest = VNDetectFaceLandmarksRequest()
        let handRequest = VNDetectHumanHandPoseRequest()
        handRequest.maximumHandCount = 2
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
        try? handler.perform([faceRequest, handRequest])

        let face = (faceRequest.results ?? [])
            .max { lhs, rhs in lhs.boundingBox.width * lhs.boundingBox.height < rhs.boundingBox.width * rhs.boundingBox.height }
            .map(faceObservation)
        let hands = (handRequest.results ?? []).compactMap { observation -> InterviewHandObservation? in
            guard let wrist = try? observation.recognizedPoint(.wrist), wrist.confidence >= 0.2 else { return nil }
            return InterviewHandObservation(
                x: wrist.location.x,
                y: wrist.location.y,
                confidence: Double(wrist.confidence)
            )
        }
        return InterviewFramingSample(timeSeconds: timeSeconds, face: face, hands: hands)
    }

    private static func faceObservation(_ observation: VNFaceObservation) -> InterviewFaceObservation {
        let eyePoints = [observation.landmarks?.leftEye, observation.landmarks?.rightEye]
            .compactMap { $0?.normalizedPoints }
            .flatMap { $0 }
        let eyeX: Double?
        let eyeY: Double?
        if eyePoints.isEmpty {
            eyeX = nil
            eyeY = nil
        } else {
            let averageX = eyePoints.map(\.x).reduce(0, +) / CGFloat(eyePoints.count)
            let averageY = eyePoints.map(\.y).reduce(0, +) / CGFloat(eyePoints.count)
            eyeX = observation.boundingBox.minX + Double(averageX) * observation.boundingBox.width
            eyeY = observation.boundingBox.minY + Double(averageY) * observation.boundingBox.height
        }
        return InterviewFaceObservation(
            x: observation.boundingBox.minX,
            y: observation.boundingBox.minY,
            width: observation.boundingBox.width,
            height: observation.boundingBox.height,
            eyeX: eyeX,
            eyeY: eyeY,
            yawRadians: observation.yaw?.doubleValue,
            confidence: Double(observation.confidence)
        )
    }
}
