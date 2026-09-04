import XCTest
@testable import VideoOSStudioCore

final class InterviewAutoReframeTests: XCTestCase {
    func testPlannerCreatesRestrainedPortraitPunchIn() throws {
        let samples = (0 ..< 9).map { index in
            InterviewFramingSample(
                timeSeconds: Double(index),
                face: InterviewFaceObservation(
                    x: 0.35,
                    y: 0.30,
                    width: 0.24,
                    height: 0.28,
                    eyeX: 0.47,
                    eyeY: 0.55,
                    confidence: 0.96
                ),
                hands: []
            )
        }

        let proposal = try XCTUnwrap(InterviewAutoReframePlanner.propose(
            samples: samples,
            outputWidth: 1_920,
            outputHeight: 1_080
        ))

        XCTAssertEqual(proposal.zoom, 1.18, accuracy: 0.001)
        XCTAssertGreaterThan(proposal.confidence, 0.9)
        XCTAssertEqual(proposal.faceSampleCount, 9)
        XCTAssertEqual(proposal.gestureSampleCount, 0)
    }

    func testPlannerUsesYawToPreserveLookRoom() throws {
        let samples = [InterviewFramingSample(
            timeSeconds: 0,
            face: InterviewFaceObservation(
                x: 0.38,
                y: 0.30,
                width: 0.24,
                height: 0.36,
                eyeX: 0.50,
                eyeY: 0.58,
                yawRadians: 0.35,
                confidence: 0.95
            ),
            hands: []
        )]

        let proposal = try XCTUnwrap(InterviewAutoReframePlanner.propose(
            samples: samples,
            outputWidth: 1_920,
            outputHeight: 1_080
        ))

        XCTAssertLessThan(proposal.positionX, 0)
        XCTAssertTrue(proposal.reason.contains("目線方向"))
    }

    func testPlannerProtectsDetectedGestures() throws {
        let samples = (0 ..< 5).map { index in
            InterviewFramingSample(
                timeSeconds: Double(index),
                face: InterviewFaceObservation(
                    x: 0.40,
                    y: 0.42,
                    width: 0.20,
                    height: 0.24,
                    eyeX: 0.50,
                    eyeY: 0.59,
                    confidence: 0.94
                ),
                hands: [InterviewHandObservation(x: 0.12, y: 0.18, confidence: 0.8)]
            )
        }

        let proposal = try XCTUnwrap(InterviewAutoReframePlanner.propose(
            samples: samples,
            outputWidth: 1_920,
            outputHeight: 1_080
        ))

        XCTAssertLessThanOrEqual(proposal.zoom, 1.15)
        XCTAssertEqual(proposal.gestureSampleCount, 5)
        XCTAssertTrue(proposal.reason.contains("手振り"))
    }

    func testPlannerRefusesSamplesWithoutFaceEvidence() {
        let proposal = InterviewAutoReframePlanner.propose(
            samples: [InterviewFramingSample(timeSeconds: 0, face: nil, hands: [])],
            outputWidth: 1_920,
            outputHeight: 1_080
        )

        XCTAssertNil(proposal)
    }

    func testPlannerUsesRegisteredPolicyForWidePunchAndHoldModes() throws {
        let samples = [InterviewFramingSample(
            timeSeconds: 0,
            face: InterviewFaceObservation(
                x: 0.38,
                y: 0.20,
                width: 0.24,
                height: 0.24,
                eyeX: 0.50,
                eyeY: 0.45,
                confidence: 0.96
            ),
            hands: []
        )]
        let policy = InterviewFramingPolicy.studioContractV1

        XCTAssertEqual(policy.version, "framing-policy/v1")
        XCTAssertEqual(policy.policyID, "studio-interview-framing-v1")
        XCTAssertEqual(
            try XCTUnwrap(InterviewAutoReframePlanner.propose(
                samples: samples,
                outputWidth: 1_920,
                outputHeight: 1_080,
                policy: policy,
                mode: .wide
            )).zoom,
            1.0,
            accuracy: 0.001
        )
        XCTAssertEqual(
            try XCTUnwrap(InterviewAutoReframePlanner.propose(
                samples: samples,
                outputWidth: 1_920,
                outputHeight: 1_080,
                policy: policy,
                mode: .punch
            )).zoom,
            1.18,
            accuracy: 0.001
        )
        XCTAssertEqual(
            try XCTUnwrap(InterviewAutoReframePlanner.propose(
                samples: samples,
                outputWidth: 1_920,
                outputHeight: 1_080,
                policy: policy,
                mode: .hold
            )).zoom,
            1.167,
            accuracy: 0.001
        )
    }
}
