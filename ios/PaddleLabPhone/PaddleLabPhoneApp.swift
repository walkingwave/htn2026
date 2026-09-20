import SwiftUI

@main
struct PaddleLabPhoneApp: App {
    @StateObject private var controller = PhoneMotionController()

    var body: some Scene {
        WindowGroup {
            PhoneControllerView(controller: controller)
        }
    }
}
