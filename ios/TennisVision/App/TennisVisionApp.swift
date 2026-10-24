// TennisVisionApp.swift — app entry point (`HomeView` root dashboard + full-screen `RecordView`), the session
// controller that wires capture → live caller → clip uploader → local/cloud `SessionStore` → Watch, live WASB
// ball-tracking reticle + trail overlay, explicit End Session flow, and 6-second slow-mo challenge replay.
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
            HomeView()
                .environmentObject(controller)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        RallySegmentUploader.shared.resumePending()
                        Task { await SessionStore.shared.refreshRemote() }
                    }
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

/// Owns the capture, live-caller, drift-tracker, uploader, SessionStore and Watch plumbing. All @Published state changes on main.
final class SessionController: NSObject, ObservableObject {
    @Published var mode: SessionMode = .rally { didSet { reconfigure() } }
    @Published var audioMode: AudioCallMode = .softChime { didSet { reconfigure() } }
    @Published var doubles = false { didSet { reconfigure() } }
    @Published private(set) var engineState: EngineState = .sleeping
    @Published private(set) var shotCount = 0
    @Published private(set) var inStreak = 0
    @Published private(set) var sessionBest = 0
    @Published private(set) var totalSessionShots = 0
    @Published private(set) var inCalls = 0
    @Published private(set) var outCalls = 0
    @Published private(set) var lastCall: LineCallResult?
    @Published private(set) var lastLatencyMs: Double?
    @Published private(set) var calibration: CourtCalibration?
    @Published private(set) var callsPaused = false
    @Published private(set) var audioLatencyWarning: String?
    @Published private(set) var score = MatchScorekeeper()
    @Published private(set) var clipsSaved = 0
    @Published private(set) var sessionClips: [RallyClipRecord] = []
    @Published private(set) var currentBall: BallSample?
    @Published private(set) var ballTrail: [BallSample] = []
    @Published private(set) var setupError: String?
    @Published var calibrationFrame: CalibrationFrame?
    @Published var replay: ReplayItem?

    let camera = CameraCaptureManager()
    private let engine = LiveLineCallerEngine()
    private let drift = CourtDriftTracker()
    private(set) var matchId = UUID()
    private var sessionStartedAt = Date()
    private var sessionStartS: Double?
    private var savedBrightness: CGFloat?
    private var pointsLog: [RallySegmentUploader.PointPayload] = []
    private var lastCompletedRallyIdx: Int?
    private var lastCompletedEndS: Double?
    private var isEndingSession = false
    private var observersInstalled = false

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

    /// Resets per-session counters and mints a fresh `matchId` before presenting `RecordView`.
    @MainActor
    func prepareNewSession(mode: SessionMode, doubles: Bool) {
        matchId = UUID()
        sessionStartedAt = Date()
        sessionStartS = nil
        isEndingSession = false
        shotCount = 0
        inStreak = 0
        sessionBest = 0
        totalSessionShots = 0
        inCalls = 0
        outCalls = 0
        clipsSaved = 0
        sessionClips = []
        pointsLog = []
        lastCompletedRallyIdx = nil
        lastCompletedEndS = nil
        lastCall = nil
        lastLatencyMs = nil
        currentBall = nil
        ballTrail = []
        score = MatchScorekeeper()
        setupError = nil
        self.mode = mode
        self.doubles = doubles
    }

    /// Requests permissions, configures capture + audio, and starts everything.
    @MainActor
    func start() async {
        isEndingSession = false
        guard await AVCaptureDevice.requestAccess(for: .video), await AVAudioApplication.requestRecordPermission() else {
            setupError = "Camera and microphone access are required."
            return
        }
        do {
            if camera.session.inputs.isEmpty {
                try camera.configure()
            }
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
        if !observersInstalled {
            observersInstalled = true
            NotificationCenter.default.addObserver(self, selector: #selector(routeChanged),
                                                   name: AVAudioSession.routeChangeNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(thermalChanged),
                                                   name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        }
        routeChanged()
    }

    /// Manually starts a rally clip or finishes the active rally clip.
    func toggleManualRally() {
        if engineState == .live || engineState == .armed {
            engine.endCurrentRally()
        } else {
            engine.forceStartRally()
        }
    }

    /// Ends the active court session: flushes any live rally clip, saves the session to `SessionStore`,
    /// queues pending clip uploads, finalizes with Modal, and stops the camera + audio engines cleanly.
    @MainActor
    func endSession() async {
        guard !isEndingSession else { return }
        isEndingSession = true
        let wasActiveRally = (engineState == .live || engineState == .armed)
        engine.endCurrentRally()
        if wasActiveRally {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        engine.stop()
        camera.stop()
        currentBall = nil
        ballTrail = []
        if let b = savedBrightness {
            UIScreen.main.brightness = b
            savedBrightness = nil
        }
        UIApplication.shared.isIdleTimerDisabled = false

        let record = buildSessionRecord()
        SessionStore.shared.upsertLocalSession(record)
        finishSession()
        _ = SessionStore.shared.uploadSession(record)
    }

    @MainActor
    func buildSessionRecord() -> LocalSessionRecord {
        let shots = max(totalSessionShots, shotCount)
        let best = max(sessionBest, inStreak)
        let rallies = max(clipsSaved, sessionClips.count)
        let scoreStr = mode == .match ? score.formattedScore : nil
        let status: ClipUploadState = RallySegmentUploader.hasValidCredentials
            ? (sessionClips.isEmpty ? .localOnly : .uploading)
            : .needsToken
        return LocalSessionRecord(
            id: matchId,
            startedAt: sessionStartedAt,
            endedAt: Date(),
            mode: mode,
            doubles: doubles,
            totalShots: shots,
            bestStreak: best,
            ralliesCount: rallies,
            inCalls: inCalls,
            outCalls: outCalls,
            scoreFormatted: scoreStr,
            clipFiles: sessionClips,
            uploadStatus: status,
            court: calibration.map { RallySegmentUploader.CourtJSON($0) },
            source: "ios"
        )
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
        let before = score.formattedScore
        let srv = score.score.server.rawValue
        let side = score.serverSide.rawValue
        score.pointWon(by: winner)
        let after = score.formattedScore
        let endedBy = lastCall?.call == .out ? "out" : "winner"
        pointsLog.append(RallySegmentUploader.PointPayload(
            pointIdx: pointsLog.count, rallyIdx: lastCompletedRallyIdx, server: srv, serveSide: side,
            winner: winner.rawValue, endedBy: endedBy, scoreBefore: before, scoreAfter: after,
            timestampS: lastCompletedEndS))
        updateServeRegion()
        pushWatch()
        finishSession()
    }

    func undoPoint() {
        score.undo()
        if !pointsLog.isEmpty { pointsLog.removeLast() }
        updateServeRegion()
        pushWatch()
        finishSession()
    }

    /// Sends current session/score/points state to Modal so the session can be finalized or updated in Match Mode.
    func finishSession() {
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: matchId, sessionType: mode, doubles: doubles,
            court: calibration.map { RallySegmentUploader.CourtJSON($0) }) else { return }
        let matchScore = mode == .match ? RallySegmentUploader.ScorePayload(score) : nil
        let matchPoints = mode == .match ? pointsLog : nil
        RallySegmentUploader.shared.finalizeSession(config: config, score: matchScore, points: matchPoints)
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

    func engine(_ engine: LiveLineCallerEngine, didUpdateBall current: BallSample?, trail: [BallSample]) {
        currentBall = current
        ballTrail = trail
    }

    func engine(_ engine: LiveLineCallerEngine, rallyStartedAt pts: CMTime) {
        if sessionStartS == nil { sessionStartS = pts.seconds - CameraCaptureManager.preRollSeconds }
        lastCall = nil
        camera.beginRally(at: pts)
    }

    func engine(_ engine: LiveLineCallerEngine, rallyEnded summary: RallySummary?, lastActivity: CMTime) {
        guard let summary else { return camera.discardRally() }
        totalSessionShots += summary.shotCount
        sessionBest = max(sessionBest, summary.inStreak, summary.shotCount)
        let startS = max(0, summary.startS - CameraCaptureManager.preRollSeconds - (sessionStartS ?? 0))
        let endS = max(0, summary.endS - (sessionStartS ?? 0))
        let durationS = max(0, summary.endS - summary.startS + CameraCaptureManager.preRollSeconds + CameraCaptureManager.tailSeconds)
        lastCompletedRallyIdx = summary.rallyIdx
        lastCompletedEndS = endS
        let rallyCall = lastCall?.call.rawValue
        let matchScore = mode == .match ? RallySegmentUploader.ScorePayload(score) : nil
        let matchPoints = mode == .match ? pointsLog : nil
        let sessionMatchId = matchId
        let config = RallySegmentUploader.Config.fromBundle(
            matchId: sessionMatchId, sessionType: mode, doubles: doubles,
            court: calibration.map { RallySegmentUploader.CourtJSON($0) })
        // When flushing on "End Session", commit immediately without waiting 2.0 s for future frames.
        let effectiveLast = isEndingSession
            ? CMTimeSubtract(lastActivity, CMTime(seconds: CameraCaptureManager.tailSeconds, preferredTimescale: 600))
            : lastActivity
        camera.endRally(lastActivity: effectiveLast, rallyIdx: summary.rallyIdx) { [weak self] url in
            guard let url else { return }
            let uniqueFileName = "rally_\(sessionMatchId.uuidString.lowercased())_\(summary.rallyIdx).mov"
            let sessionClipURL = CameraCaptureManager.clipsDirectory.appendingPathComponent(uniqueFileName)
            let finalURL: URL
            if url.path != sessionClipURL.path {
                try? FileManager.default.removeItem(at: sessionClipURL)
                if (try? FileManager.default.copyItem(at: url, to: sessionClipURL)) != nil {
                    finalURL = sessionClipURL
                } else {
                    finalURL = url
                }
            } else {
                finalURL = url
            }
            let clipRecord = RallyClipRecord(
                id: RallySegmentUploader.uploadKey(matchId: sessionMatchId, rallyIdx: summary.rallyIdx),
                rallyIdx: summary.rallyIdx,
                fileName: finalURL.lastPathComponent,
                startS: startS,
                durationS: durationS,
                shotCount: summary.shotCount,
                inStreak: summary.inStreak,
                bookmarked: summary.bookmarked,
                liveCall: rallyCall,
                source: "ios",
                uploadStatus: config != nil ? .uploading : .needsToken
            )
            DispatchQueue.main.async {
                guard let self else { return }
                self.clipsSaved += 1
                if let idx = self.sessionClips.firstIndex(where: { $0.rallyIdx == summary.rallyIdx }) {
                    self.sessionClips[idx] = clipRecord
                } else {
                    self.sessionClips.append(clipRecord)
                }
                let record = self.buildSessionRecord()
                SessionStore.shared.upsertLocalSession(record)
            }
            if let config {
                RallySegmentUploader.shared.enqueue(
                    clip: finalURL, rallyIdx: summary.rallyIdx, startS: startS, config: config,
                    bookmarked: summary.bookmarked, liveCall: rallyCall,
                    score: matchScore, points: matchPoints)
            }
        }
        updateServeRegion()
    }

    func engine(_ engine: LiveLineCallerEngine, didUpdateShots shotCount: Int, inStreak: Int, sessionBest: Int) {
        (self.shotCount, self.inStreak, self.sessionBest) = (shotCount, inStreak, max(self.sessionBest, sessionBest))
        pushWatch()
    }

    func engine(_ engine: LiveLineCallerEngine, didCall result: LineCallResult, latencyMs: Double) {
        lastCall = result
        lastLatencyMs = latencyMs
        if result.call == .in || result.call == .close {
            inCalls += 1
        } else if result.call == .out {
            outCalls += 1
        }
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
    @ObservedObject private var uploader = RallySegmentUploader.shared
    @Environment(\.dismiss) private var dismiss
    var onEndSession: (() -> Void)? = nil

    @State private var showClipsSheet = false

    var body: some View {
        ZStack {
            CameraPreview(session: c.camera.session).ignoresSafeArea()
            BallTrackingOverlay(current: c.currentBall, trail: c.ballTrail)
                .ignoresSafeArea()
                .allowsHitTesting(false)
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
        .task { await c.start() }
        .fullScreenCover(item: $c.calibrationFrame) { frame in
            CourtCalibrationOverlay(image: frame.image, intrinsics: c.camera.intrinsics, initial: c.calibration,
                                    onDone: c.finishCalibration, onCancel: { c.calibrationFrame = nil })
        }
        .sheet(item: $c.replay) { ReplayView(item: $0) }
        .sheet(isPresented: $showClipsSheet) {
            let record = c.buildSessionRecord()
            let merged = MergedSessionItem(
                id: record.id.uuidString.lowercased(),
                title: record.mode == .match ? "Current Match Session" : "Current Rally Session",
                date: record.startedAt,
                dateLabel: "Active Session",
                mode: record.mode,
                doubles: record.doubles,
                sourceLabel: "ON-DEVICE",
                totalShots: record.totalShots,
                bestStreak: record.bestStreak,
                ralliesCount: record.ralliesCount,
                inPct: record.inCallPct,
                scoreFormatted: record.scoreFormatted,
                uploadStatus: record.uploadStatus,
                remoteStatus: nil,
                localRecord: record,
                remoteRecord: nil
            )
            SessionDetailSheet(item: merged)
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button(role: .destructive) {
                Task {
                    await c.endSession()
                    onEndSession?()
                    dismiss()
                }
            } label: {
                Label("End Session", systemImage: "stop.circle.fill")
                    .font(.callout.bold())
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)

            Picker("Mode", selection: $c.mode) {
                Text("Rally").tag(SessionMode.rally)
                Text("Match").tag(SessionMode.match)
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 180)

            Menu {
                Picker("Audio", selection: $c.audioMode) {
                    ForEach(AudioCallMode.allCases) { Text($0.rawValue).tag($0) }
                }
                Toggle("Doubles lines", isOn: $c.doubles)
            } label: {
                Label(c.audioMode == .mute ? "Muted" : "Audio",
                      systemImage: c.audioMode == .mute ? "speaker.slash" : "speaker.wave.2")
            }

            Button { c.beginCalibration() } label: {
                Label(c.calibration == nil ? "Calibrate" : "Recalibrate", systemImage: "viewfinder")
            }

            Button {
                showClipsSheet = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: uploader.activeUploadsCount > 0 ? "icloud.and.arrow.up.fill" : "film.stack")
                    Text("Clips (\(c.clipsSaved))")
                        .monospacedDigit()
                }
                .font(.caption.bold())
            }

            Spacer()

            if c.currentBall != nil {
                HStack(spacing: 4) {
                    Circle().fill(Color.yellow).frame(width: 7, height: 7)
                    Text("BALL")
                        .font(.caption2.monospaced().bold())
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(Color.yellow.opacity(0.25), in: Capsule())
            }

            Text(c.engineState.rawValue.uppercased())
                .font(.caption.monospaced().bold())
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(c.engineState == .live ? Color.green : Color.gray.opacity(0.6), in: Capsule())
        }
        .buttonStyle(.bordered)
    }

    @ViewBuilder private var banners: some View {
        if let error = c.setupError { Banner(text: error, color: .red) }
        if c.calibration == nil {
            Banner(text: "Ball tracking active — tap Calibrate (4 corners + 2 net posts) to enable metric IN/OUT line calls",
                   color: .blue)
        }
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
            HStack(spacing: 8) {
                Text("\(c.clipsSaved) rally clips saved")
                if uploader.activeUploadsCount > 0 {
                    Text("· uploading \(uploader.activeUploadsCount)")
                        .foregroundStyle(.cyan)
                } else if !RallySegmentUploader.hasValidCredentials && c.clipsSaved > 0 {
                    Text("· local (tap Clips to upload/share)")
                        .foregroundStyle(.orange)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var actionButtons: some View {
        VStack(spacing: 10) {
            Button {
                c.toggleManualRally()
            } label: {
                Label(c.engineState == .live || c.engineState == .armed ? "Finish Rally Clip" : "Start Rally",
                      systemImage: c.engineState == .live || c.engineState == .armed ? "checkmark.circle.fill" : "record.circle")
            }
            .buttonStyle(.borderedProminent)
            .tint(c.engineState == .live || c.engineState == .armed ? .green : .blue)

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

/// Renders the live WASB ball detection reticle and recent 15-sample trajectory trail over `CameraPreview`,
/// mapping 1920×1080 native pixel coordinates into the `.resizeAspect` preview rectangle.
struct BallTrackingOverlay: View {
    let current: BallSample?
    let trail: [BallSample]

    var body: some View {
        Canvas { ctx, size in
            let imageW = CGFloat(CameraCaptureManager.width)
            let imageH = CGFloat(CameraCaptureManager.height)
            guard imageW > 0, imageH > 0, size.width > 0, size.height > 0 else { return }
            let scale = min(size.width / imageW, size.height / imageH)
            let fitW = imageW * scale
            let fitH = imageH * scale
            let originX = (size.width - fitW) / 2
            let originY = (size.height - fitH) / 2
            func toView(_ u: Double, _ v: Double) -> CGPoint {
                CGPoint(x: originX + CGFloat(u) * scale, y: originY + CGFloat(v) * scale)
            }

            if trail.count >= 2 {
                for i in 1..<trail.count {
                    let prev = trail[i - 1], cur = trail[i]
                    guard cur.t - prev.t < 0.25 else { continue }
                    let alpha = Double(i) / Double(trail.count)
                    var segment = Path()
                    segment.move(to: toView(prev.u, prev.v))
                    segment.addLine(to: toView(cur.u, cur.v))
                    ctx.stroke(segment, with: .color(.yellow.opacity(0.25 + 0.65 * alpha)),
                               style: StrokeStyle(lineWidth: CGFloat(1.5 + 2.5 * alpha), lineCap: .round))
                }
                for (i, sample) in trail.enumerated() {
                    let alpha = Double(i + 1) / Double(trail.count)
                    let pt = toView(sample.u, sample.v)
                    let r = CGFloat(2.0 + 2.0 * alpha)
                    ctx.fill(Path(ellipseIn: CGRect(x: pt.x - r, y: pt.y - r, width: 2 * r, height: 2 * r)),
                             with: .color(.yellow.opacity(0.35 + 0.55 * alpha)))
                }
            }

            if let ball = current {
                let p = toView(ball.u, ball.v)
                let ringRadius: CGFloat = 16
                let outerRect = CGRect(x: p.x - ringRadius, y: p.y - ringRadius,
                                       width: ringRadius * 2, height: ringRadius * 2)
                ctx.stroke(Path(ellipseIn: outerRect), with: .color(.yellow), lineWidth: 2.5)
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)),
                         with: .color(.green))

                var crosshair = Path()
                crosshair.move(to: CGPoint(x: p.x - 22, y: p.y))
                crosshair.addLine(to: CGPoint(x: p.x - 10, y: p.y))
                crosshair.move(to: CGPoint(x: p.x + 10, y: p.y))
                crosshair.addLine(to: CGPoint(x: p.x + 22, y: p.y))
                crosshair.move(to: CGPoint(x: p.x, y: p.y - 22))
                crosshair.addLine(to: CGPoint(x: p.x, y: p.y - 10))
                crosshair.move(to: CGPoint(x: p.x, y: p.y + 10))
                crosshair.addLine(to: CGPoint(x: p.x, y: p.y + 22))
                ctx.stroke(crosshair, with: .color(.yellow.opacity(0.9)), lineWidth: 1.5)
            }
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
