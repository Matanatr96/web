// TennisVisionApp.swift — app entry point, the session controller that wires capture → live caller → clip
// uploader → Watch, and the landscape RecordView (Rally Mode default / Match Mode, streak HUD, 6-second slow-mo
// challenge replay, Bluetooth audio-latency warning).
import AVFoundation
import AVKit
import CourtGeometry
import SwiftUI
import UIKit
import WatchConnectivity

@main
struct TennisVisionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var controller = SessionController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RecordView()
                .environmentObject(controller)
                .task { await controller.start() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { RallySegmentUploader.shared.resumePending() }
                }
        }
    }
}

/// Hands background-upload completion events to the uploader.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == RallySegmentUploader.sessionIdentifier else { return completionHandler() }
        RallySegmentUploader.shared.backgroundCompletionHandler = completionHandler
    }
}

// MARK: - Session controller

/// Owns the capture, live-caller, drift-tracker, uploader and Watch plumbing. All @Published state changes on main.
final class SessionController: NSObject, ObservableObject {
    @Published var mode: SessionMode = .rally { didSet { reconfigure() } }
    @Published var audioMode: AudioCallMode = .softChime { didSet { reconfigure() } }
    @Published var doubles = false { didSet { reconfigure() } }
    @Published private(set) var engineState: EngineState = .sleeping
    @Published private(set) var shotCount = 0
    @Published private(set) var inStreak = 0
    @Published private(set) var sessionBest = 0
    @Published private(set) var lastCall: LineCallResult?
    @Published private(set) var lastLatencyMs: Double?
    @Published private(set) var calibration: CourtCalibration?
    @Published private(set) var callsPaused = false
    @Published private(set) var audioLatencyWarning: String?
    @Published private(set) var score = MatchScorekeeper()
    @Published private(set) var clipsSaved = 0
    @Published private(set) var setupError: String?
    @Published var calibrationFrame: CalibrationFrame?
    @Published var replay: ReplayItem?

    let camera = CameraCaptureManager()
    private let engine = LiveLineCallerEngine()
    private let drift = CourtDriftTracker()
    private let matchId = UUID()
    private var sessionStartS: Double?
    private var savedBrightness: CGFloat?

    /// A frozen frame for the calibration overlay.
    struct CalibrationFrame: Identifiable {
        let id = UUID()
        let image: CGImage
        let buffer: CVPixelBuffer
    }

    /// A slow-mo challenge replay of the last 6 seconds.
    struct ReplayItem: Identifiable {
        let id = UUID()
        let url: URL
        let call: LineCallResult?
    }

    // MARK: Lifecycle

    /// Requests permissions, configures capture + audio, and starts everything.
    @MainActor
    func start() async {
        guard await AVCaptureDevice.requestAccess(for: .video), await AVAudioApplication.requestRecordPermission() else {
            setupError = "Camera and microphone access are required."
            return
        }
        do {
            try camera.configure()
            try engine.start()
        } catch {
            setupError = "Could not start capture: \(error)"
            return
        }
        engine.delegate = self
        let engine = engine, drift = drift
        camera.onFrame = { buffer, pts in
            engine.ingest(buffer, pts: pts)
            drift.process(buffer, pts: pts)
        }
        drift.onRecalibrated = { [weak self] cal in self?.apply(cal) }
        drift.onPause = { [weak self] paused in
            self?.callsPaused = paused
            self?.engine.setCallsPaused(paused)
        }
        camera.start()
        reconfigure()
        UIApplication.shared.isIdleTimerDisabled = true
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged),
                                               name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(thermalChanged),
                                               name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        routeChanged()
    }

    private func reconfigure() {
        engine.configure(mode: mode, audioMode: audioMode, doubles: doubles)
        updateServeRegion()
        pushWatch()
    }

    // MARK: Calibration

    /// Freezes the current frame for the 4-corner + 2-post overlay.
    func beginCalibration() {
        guard let buffer = camera.latestPixelBuffer(), let image = CameraCaptureManager.image(from: buffer) else { return }
        calibrationFrame = CalibrationFrame(image: image, buffer: buffer)
    }

    /// Accepts a calibration from the overlay and seeds the drift tracker with its frame.
    func finishCalibration(_ cal: CourtCalibration) {
        if let frame = calibrationFrame { drift.setReference(frame: frame.buffer, calibration: cal) }
        calibrationFrame = nil
        callsPaused = false
        engine.setCallsPaused(false)
        apply(cal)
    }

    private func apply(_ cal: CourtCalibration) {
        calibration = cal
        engine.setCalibration(cal)
    }

    // MARK: Watch & phone actions

    func bookmark() { engine.bookmark() }

    /// Exports the last 6 s from the RAM ring and opens the slow-mo replay.
    func challenge() {
        let call = lastCall
        Task { @MainActor in
            guard let url = await camera.exportRecent(seconds: CameraCaptureManager.ringSeconds) else { return }
            replay = ReplayItem(url: url, call: call)
        }
    }

    func point(_ winner: Player) {
        score.pointWon(by: winner)
        updateServeRegion()
        pushWatch()
    }

    func undoPoint() {
        score.undo()
        updateServeRegion()
        pushWatch()
    }

    /// Match Mode: the next serve must land in the box diagonally opposite the server (I'm on the near half).
    private func updateServeRegion() {
        guard mode == .match else { return engine.setServeRegion(nil) }
        let half: CourtHalf = score.score.server == .me ? .near : .far
        engine.setServeRegion(CallRegion.serviceBox(serverHalf: half, side: score.serverSide))
    }

    var setsLine: String {
        (score.score.sets + [score.score.games]).map { "\($0.me)-\($0.opp)" }.joined(separator: " ")
    }

    private func pushWatch() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        let state = WatchState(mode: mode, shotCount: shotCount, inStreak: inStreak, sessionBest: sessionBest,
                               setsLine: setsLine, pointsLine: score.display,
                               serverSide: mode == .match ? score.serverSide : nil, lastCall: lastCall?.call,
                               isLive: engineState == .live)
        try? WCSession.default.updateApplicationContext(state.message)
        if WCSession.default.isReachable { WCSession.default.sendMessage(state.message, replyHandler: nil) }
    }

    // MARK: Environment

    /// Bluetooth / AirPlay outputs add 150–300 ms, which defeats a <150 ms line call.
    @objc private func routeChanged() {
        let session = AVAudioSession.sharedInstance()
        let slow: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothLE, .bluetoothHFP, .airPlay]
        let wireless = session.currentRoute.outputs.contains { slow.contains($0.portType) }
        let warning = wireless || session.outputLatency > 0.05
            ? String(format: "Audio output adds ~%.0f ms — use the speaker or wired headphones for live calls",
                     max(session.outputLatency * 1000, wireless ? 150 : 0))
            : nil
        DispatchQueue.main.async { self.audioLatencyWarning = warning }
    }

    /// E10: dim the screen to 0 at `.serious` / `.critical` (the engine itself drops passes / pauses the ANE).
    @objc private func thermalChanged() {
        let hot = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
        DispatchQueue.main.async {
            if hot, self.savedBrightness == nil {
                self.savedBrightness = UIScreen.main.brightness
                UIScreen.main.brightness = 0
            } else if !hot, let b = self.savedBrightness {
                UIScreen.main.brightness = b
                self.savedBrightness = nil
            }
        }
    }
}

// MARK: Engine delegate (main queue)

extension SessionController: LiveLineCallerEngineDelegate {
    func engine(_ engine: LiveLineCallerEngine, didChange state: EngineState) {
        engineState = state
        camera.exposureFrozen = state == .armed || state == .live
        pushWatch()
    }

    func engine(_ engine: LiveLineCallerEngine, rallyStartedAt pts: CMTime) {
        if sessionStartS == nil { sessionStartS = pts.seconds - CameraCaptureManager.preRollSeconds }
        camera.beginRally(at: pts)
    }

    func engine(_ engine: LiveLineCallerEngine, rallyEnded summary: RallySummary?, lastActivity: CMTime) {
        guard let summary else { return camera.discardRally() }
        let startS = max(0, summary.startS - CameraCaptureManager.preRollSeconds - (sessionStartS ?? 0))
        let config = RallySegmentUploader.Config.fromBundle(
            matchId: matchId, sessionType: mode, doubles: doubles,
            court: calibration.map(RallySegmentUploader.CourtJSON.init))
        camera.endRally(lastActivity: lastActivity, rallyIdx: summary.rallyIdx) { [weak self] url in
            guard let url else { return }
            DispatchQueue.main.async { self?.clipsSaved += 1 }
            if let config { RallySegmentUploader.shared.enqueue(clip: url, rallyIdx: summary.rallyIdx, startS: startS, config: config) }
        }
        updateServeRegion()
    }

    func engine(_ engine: LiveLineCallerEngine, didUpdateShots shotCount: Int, inStreak: Int, sessionBest: Int) {
        (self.shotCount, self.inStreak, self.sessionBest) = (shotCount, inStreak, sessionBest)
        pushWatch()
    }

    func engine(_ engine: LiveLineCallerEngine, didCall result: LineCallResult, latencyMs: Double) {
        lastCall = result
        lastLatencyMs = latencyMs
        pushWatch()
    }
}

// MARK: WCSessionDelegate (background queue → main)

extension SessionController: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { self.pushWatch() }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handle(message)
    }

    /// Commands queued with `transferUserInfo` while the phone was unreachable.
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        handle(userInfo)
    }

    private func handle(_ message: [String: Any]) {
        guard let command = WatchCommand(message: message) else { return }
        DispatchQueue.main.async {
            switch command {
            case .bookmark: self.bookmark()
            case .challenge: self.challenge()
            case .pointMe: self.point(.me)
            case .pointOpp: self.point(.opp)
            case .undo: self.undoPoint()
            }
        }
    }
}

// MARK: - Views

struct RecordView: View {
    @EnvironmentObject private var c: SessionController

    var body: some View {
        ZStack {
            CameraPreview(session: c.camera.session).ignoresSafeArea()
            VStack(spacing: 8) {
                topBar
                banners
                Spacer()
                HStack(alignment: .bottom) {
                    hud
                    Spacer()
                    actionButtons
                }
            }
            .padding()
        }
        .preferredColorScheme(.dark)
        .fullScreenCover(item: $c.calibrationFrame) { frame in
            CourtCalibrationOverlay(image: frame.image, intrinsics: c.camera.intrinsics, initial: c.calibration,
                                    onDone: c.finishCalibration, onCancel: { c.calibrationFrame = nil })
        }
        .sheet(item: $c.replay) { ReplayView(item: $0) }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Picker("Mode", selection: $c.mode) {
                Text("Rally (Default)").tag(SessionMode.rally)
                Text("Match").tag(SessionMode.match)
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 260)
            Menu {
                Picker("Audio", selection: $c.audioMode) {
                    ForEach(AudioCallMode.allCases) { Text($0.rawValue).tag($0) }
                }
                Toggle("Doubles lines", isOn: $c.doubles)
            } label: {
                Label(c.audioMode.rawValue, systemImage: c.audioMode == .mute ? "speaker.slash" : "speaker.wave.2")
            }
            Button { c.beginCalibration() } label: {
                Label(c.calibration == nil ? "Calibrate" : "Recalibrate", systemImage: "viewfinder")
            }
            Spacer()
            Text(c.engineState.rawValue.uppercased())
                .font(.caption.monospaced().bold())
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(c.engineState == .live ? Color.green : Color.gray.opacity(0.6), in: Capsule())
        }
        .buttonStyle(.bordered)
    }

    @ViewBuilder private var banners: some View {
        if let error = c.setupError { Banner(text: error, color: .red) }
        if c.calibration == nil { Banner(text: "Tap Calibrate: 4 outer corners + 2 net posts enable line calls", color: .blue) }
        if c.callsPaused { Banner(text: "Camera moved more than 15 px — live calls paused. Recalibrate.", color: .orange) }
        if let w = c.audioLatencyWarning { Banner(text: w, color: .yellow) }
    }

    @ViewBuilder private var hud: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch c.mode {
            case .rally:
                Text("\(c.shotCount)").font(.system(size: 72, weight: .heavy, design: .rounded)).monospacedDigit()
                Text("shots · in-streak \(c.inStreak) · best \(c.sessionBest)").font(.headline)
            case .match:
                Text(c.setsLine).font(.title2.monospacedDigit().bold())
                Text(c.score.display).font(.system(size: 48, weight: .heavy, design: .rounded))
                Text("Serve from \(c.score.serverSide.rawValue) side").font(.caption)
            }
            if let call = c.lastCall { CallChip(result: call, latencyMs: c.lastLatencyMs) }
            Text("\(c.clipsSaved) rally clips saved").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var actionButtons: some View {
        VStack(spacing: 12) {
            if c.mode == .match {
                HStack {
                    Button("Me") { c.point(.me) }
                    Button("Opp") { c.point(.opp) }
                    Button { c.undoPoint() } label: { Image(systemName: "arrow.uturn.backward") }
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button { c.bookmark() } label: { Label("Bookmark", systemImage: "star.fill") }
                    .buttonStyle(.borderedProminent).tint(.yellow)
            }
            Button { c.challenge() } label: { Label("Challenge", systemImage: "flag.fill") }
                .buttonStyle(.borderedProminent).tint(.red)
        }
    }
}

private struct Banner: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text).font(.callout.bold()).padding(8).frame(maxWidth: .infinity)
            .background(color.opacity(0.8), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// "OUT +4.1 cm ± 1.2" with the colour of the call.
private struct CallChip: View {
    let result: LineCallResult
    let latencyMs: Double?

    var body: some View {
        HStack {
            Text(result.call.rawValue.uppercased()).bold()
            if result.marginM.isFinite {
                Text(String(format: "%+.1f cm ±%.1f", result.marginM * 100, 2 * result.sigmaM * 100))
            }
            Text(result.depthZone.rawValue)
            if let ms = latencyMs { Text(String(format: "%.0f ms", ms)).foregroundStyle(.secondary) }
        }
        .font(.callout.monospacedDigit())
        .padding(6)
        .background(color.opacity(0.85), in: Capsule())
    }

    private var color: Color {
        switch result.call {
        case .in: return .green
        case .out: return .red
        case .close: return .orange
        case .unknown: return .gray
        }
    }
}

/// 6-second slow-mo Hawk-Eye replay (0.25×, looping) with the call and the bounce on a top-down court.
struct ReplayView: View {
    let item: SessionController.ReplayItem
    @State private var player: AVQueuePlayer?
    @State private var looper: AVPlayerLooper?

    var body: some View {
        HStack(spacing: 16) {
            VideoPlayer(player: player).aspectRatio(16 / 9, contentMode: .fit)
            if let call = item.call {
                VStack(alignment: .leading) {
                    CallChip(result: call, latencyMs: nil)
                    MiniCourt(bounce: call.court).frame(width: 140, height: 280)
                }
            }
        }
        .padding()
        .onAppear {
            let p = AVQueuePlayer()
            looper = AVPlayerLooper(player: p, templateItem: AVPlayerItem(url: item.url))
            p.defaultRate = 0.25
            p.rate = 0.25
            player = p
        }
        .onDisappear {
            player?.pause()
            try? FileManager.default.removeItem(at: item.url)
        }
    }
}

/// Top-down singles court in metres with the bounce dot (far baseline at the top).
private struct MiniCourt: View {
    let bounce: Point2

    var body: some View {
        Canvas { ctx, size in
            let sx = size.width / (2 * Court.doublesHalfWidth + 1), sy = size.height / (2 * Court.halfLength + 2)
            func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: size.width / 2 + x * sx, y: size.height / 2 - y * sy) }
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.green.opacity(0.5)))
            var lines = Path()
            for (a, b) in [(0, 1), (2, 3), (0, 2), (1, 3), (4, 5), (6, 7), (8, 9), (10, 11), (12, 13)] {
                let pa = Court.points[a], pb = Court.points[b]
                lines.move(to: p(pa.x, pa.y))
                lines.addLine(to: p(pb.x, pb.y))
            }
            lines.move(to: p(-Court.netPostX, 0))
            lines.addLine(to: p(Court.netPostX, 0))
            ctx.stroke(lines, with: .color(.white), lineWidth: 1)
            if bounce.x.isFinite, bounce.y.isFinite {
                let c = p(bounce.x, bounce.y)
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)), with: .color(.yellow))
            }
        }
    }
}

/// AVCaptureVideoPreviewLayer host.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
