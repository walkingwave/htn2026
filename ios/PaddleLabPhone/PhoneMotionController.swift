import CoreMotion
import Foundation
import UIKit

@MainActor
final class PhoneMotionController: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var isConnected = false
    @Published private(set) var isCalibrated = false
    @Published private(set) var horizontal: Double = 0
    @Published private(set) var vertical: Double = 0
    @Published private(set) var status = "Enter a room code to connect"

    private let motion = CMMotionManager()
    private let haptics = UIImpactFeedbackGenerator(style: .light)
    private var zeroPitch = 0.0
    private var zeroRoll = 0.0
    private var lastSwing = Date.distantPast
    private var roomCode = ""
    private var transport: PaddleRoom?

    func connect(roomCode: String, relayURL: URL) {
        self.roomCode = roomCode.uppercased()
        transport = PaddleRoom(url: relayURL, roomCode: self.roomCode)
        transport?.onState = { [weak self] connected, text in
            Task { @MainActor in
                self?.isConnected = connected
                self?.status = text
            }
        }
        transport?.onHaptic = { [weak self] in self?.haptics.impactOccurred() }
        transport?.connect()
    }

    func start() {
        guard motion.isDeviceMotionAvailable else {
            status = "Device Motion is unavailable on this iPhone"
            return
        }
        motion.deviceMotionUpdateInterval = 1.0 / 60.0
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] sample, _ in
            guard let sample else { return }
            Task { @MainActor in self?.consume(sample) }
        }
        isRunning = true
        status = "Hold still, then calibrate"
    }

    func calibrate() {
        guard let sample = motion.deviceMotion else { return }
        zeroPitch = sample.attitude.pitch
        zeroRoll = sample.attitude.roll
        isCalibrated = true
        status = "Ready — tilt to aim, flick to swing"
        transport?.sendCalibration(pitch: zeroPitch, roll: zeroRoll)
        haptics.impactOccurred(intensity: 0.45)
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        transport?.close()
        isRunning = false
        isConnected = false
    }

    private func consume(_ sample: CMDeviceMotion) {
        guard isCalibrated else { return }
        horizontal = max(-1, min(1, (sample.attitude.roll - zeroRoll) / 0.65))
        vertical = max(-1, min(1, -(sample.attitude.pitch - zeroPitch) / 0.55))
        let acceleration = sample.userAcceleration
        let magnitude = sqrt(acceleration.x * acceleration.x + acceleration.y * acceleration.y + acceleration.z * acceleration.z)
        let now = Date()
        let swing = magnitude > 1.4 && now.timeIntervalSince(lastSwing) > 0.3
        if swing { lastSwing = now; haptics.impactOccurred(intensity: 0.25) }
        transport?.sendPose(x: horizontal, y: vertical, flick: swing)
    }
}
