# PaddleLab Phone — native iOS companion

This folder contains the native Core Motion companion for the phone-paddle mode.

## What it provides

- `CMMotionManager` at 60 Hz
- Device-attitude calibration
- Roll/pitch aim mapping
- User-acceleration swing detection
- `UIImpactFeedbackGenerator` haptics
- `URLSessionWebSocketTask` using the same `flyball-multiplayer-v1` room protocol as the browser controller

## Build

Open `PaddleLabPhoneApp.swift`, `PhoneControllerView.swift`,
`PhoneMotionController.swift`, and `PaddleRoom.swift` in a new iOS SwiftUI app
in Xcode. Add the following `Info.plist` key:

```xml
<key>NSMotionUsageDescription</key>
<string>PaddleLab uses motion to turn your iPhone into a paddle.</string>
```

The native client requires a `wss://` relay URL for a production deployment.
The browser controller remains the zero-install path and is the one that can be
used immediately from the QR code.

## Validation status

The Swift source is included, but it has not been compiled or tested against a
physical iPhone in this Windows environment. That device gate must be run in
Xcode before calling native iOS support production-ready.
