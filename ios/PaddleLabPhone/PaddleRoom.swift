import Foundation

final class PaddleRoom {
    var onState: ((Bool, String) -> Void)?
    var onHaptic: (() -> Void)?

    private let url: URL
    private let roomCode: String
    private var socket: URLSessionWebSocketTask?
    private lazy var session = URLSession(configuration: .default)

    init(url: URL, roomCode: String) {
        self.url = url
        self.roomCode = roomCode
    }

    func connect() {
        socket = session.webSocketTask(with: url)
        socket?.resume()
        send(type: "__join", data: ["code": roomCode, "role": "phone"])
        receive()
        onState?(true, "Connected — waiting for calibration")
    }

    func sendPose(x: Double, y: Double, flick: Bool) {
        send(type: "phone-pose", data: ["x": x, "y": y, "flick": flick, "at": Date().timeIntervalSince1970])
    }

    func sendCalibration(pitch: Double, roll: Double) {
        send(type: "phone-calibrate", data: ["pitch": pitch, "roll": roll])
    }

    func close() {
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
    }

    private func send(type: String, data: [String: Any]) {
        let payload: [String: Any] = ["protocol": "flyball-multiplayer-v1", "type": type, "data": data]
        guard let encoded = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: encoded, encoding: .utf8) else { return }
        socket?.send(.string(text)) { _ in }
    }

    private func receive() {
        socket?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let text)):
                self.handle(text)
                self.receive()
            case .failure:
                self.onState?(false, "Connection lost")
            default:
                self.receive()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else { return }
        if type == "__joined" { onState?(true, "Connected — calibrate your neutral pose") }
        if type == "phone-haptic" { onHaptic?() }
    }
}
