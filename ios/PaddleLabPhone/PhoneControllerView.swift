import SwiftUI

struct PhoneControllerView: View {
    @ObservedObject var controller: PhoneMotionController
    @State private var room = ""
    @State private var relay = "wss://localhost:5173/__flyball_ws"

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.28, green: 0.10, blue: 0.18), .black], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(alignment: .leading, spacing: 20) {
                Text("🏓 PaddleLab").font(.title2.bold())
                Spacer()
                Text("PHONE PADDLE").font(.caption.bold()).foregroundStyle(.red)
                Text("Hold your iPhone like a racket.").font(.system(size: 42, weight: .black, design: .rounded)).minimumScaleFactor(0.65)
                Text("Tilt to aim. Flick forward to swing. Your desktop runs the table and physics.").foregroundStyle(.secondary)
                TextField("Room code", text: $room).textInputAutocapitalization(.characters).textFieldStyle(.roundedBorder)
                TextField("Relay WebSocket URL", text: $relay).textFieldStyle(.roundedBorder).font(.caption)
                Text(controller.status).font(.footnote).foregroundStyle(controller.isConnected ? .green : .orange)
                Button("Connect phone") {
                    guard let url = URL(string: relay) else { return }
                    controller.connect(roomCode: room, relayURL: url)
                }.buttonStyle(.borderedProminent)
                Button(controller.isRunning ? "Motion enabled" : "Enable motion") { controller.start() }.buttonStyle(.bordered)
                Button(controller.isCalibrated ? "Recalibrate neutral pose" : "Calibrate neutral pose") { controller.calibrate() }.buttonStyle(.bordered)
                HStack {
                    Text("Aim"); ProgressView(value: abs(controller.horizontal), total: 1).tint(.red)
                    Text("\(Int(controller.horizontal * 100))%")
                }
                Spacer()
                Text("Keep the phone secure. Haptics confirm contact.").font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }
    }
}
