// TennisVisionApp.swift — app entry point (`HomeView` root dashboard + full-screen `RecordView`), the session
// controller that wires capture → live caller → clip uploader → local/cloud `SessionStore` → Watch, live WASB
// ball-tracking reticle + trail overlay, explicit End Session flow, 6-second slow-mo challenge replay,
// local/cloud `SessionStore`, `PhotosPicker` Camera Roll uploader, and `SessionDetailSheet`.
import AVFoundation
import AVKit
import CoreImage
import CourtGeometry
import Photos
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
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

/// Lightweight tactile feedback helper for on-court button taps and `OUT` line-call alerts.
enum Haptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        DispatchQueue.main.async {
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.prepare()
            generator.impactOccurred()
        }
    }

    static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        DispatchQueue.main.async {
            let generator = UINotificationFeedbackGenerator()
            generator.prepare()
            generator.notificationOccurred(type)
        }
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
        let engine = self.engine, drift = self.drift
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
        Haptics.impact(.medium)
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
    }

    @MainActor
    func buildSessionRecord() -> LocalSessionRecord {
        let shots = max(totalSessionShots, shotCount)
        let best = max(sessionBest, inStreak)
        let syncedClips = sessionClips.map { clip -> RallyClipRecord in
            var c = clip
            if let live = RallySegmentUploader.shared.statusByKey[clip.id] {
                c.uploadStatus = live
            }
            return c
        }
        sessionClips = syncedClips
        let rallies = max(clipsSaved, syncedClips.count)
        let scoreStr = mode == .match ? score.formattedScore : nil
        let status: ClipUploadState = {
            guard RallySegmentUploader.hasValidCredentials else { return .needsToken }
            if syncedClips.isEmpty { return .localOnly }
            if syncedClips.allSatisfy({ $0.uploadStatus == .uploaded }) { return .uploaded }
            if syncedClips.contains(where: { $0.uploadStatus == .failed }) { return .failed }
            return .uploading
        }()
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
            clipFiles: syncedClips,
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
        Haptics.notify(.success)
    }

    private func apply(_ cal: CourtCalibration) {
        calibration = cal
        engine.setCalibration(cal)
    }

    // MARK: Watch & phone actions

    func bookmark() {
        Haptics.impact(.medium)
        engine.bookmark()
    }

    /// Exports the last 6 s from the RAM ring and opens the slow-mo replay.
    func challenge() {
        Haptics.impact(.heavy)
        let call = lastCall
        Task { @MainActor in
            guard let url = await camera.exportRecent(seconds: CameraCaptureManager.ringSeconds) else { return }
            replay = ReplayItem(url: url, call: call)
        }
    }

    func point(_ winner: Player) {
        Haptics.impact(.medium)
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
        Haptics.impact(.light)
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
                if (try? FileManager.default.moveItem(at: url, to: sessionClipURL)) != nil {
                    finalURL = sessionClipURL
                } else if (try? FileManager.default.copyItem(at: url, to: sessionClipURL)) != nil {
                    try? FileManager.default.removeItem(at: url)
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
            Haptics.notify(.warning)
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
            case .toggleRally:
                Haptics.impact(.medium)
                if self.engineState == .live {
                    self.engine.endCurrentRally()
                } else {
                    self.engine.forceStartRally()
                }
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
    @State private var showCourtLines = true
    @State private var pulseDot = false

    var body: some View {
        ZStack {
            CameraPreview(session: c.camera.session).ignoresSafeArea()
            if showCourtLines, let cal = c.calibration {
                LiveCourtWireframeOverlay(calibration: cal, doubles: c.doubles, callsPaused: c.callsPaused)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
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
        .task {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                pulseDot = true
            }
            await c.start()
        }
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

    private var stateDotColor: Color {
        switch c.engineState {
        case .live: return .green
        case .armed: return .yellow
        case .cooldown: return .cyan
        case .sleeping: return .gray
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            // Left Capsule Cluster: End Session + Rally/Match segmented pill
            HStack(spacing: 8) {
                Button(role: .destructive) {
                    Haptics.impact(.medium)
                    Task {
                        await c.endSession()
                        onEndSession?()
                        dismiss()
                    }
                } label: {
                    Label("End Session", systemImage: "stop.circle.fill")
                        .font(.caption.bold())
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)

                Picker("Mode", selection: $c.mode) {
                    Text("Rally").tag(SessionMode.rally)
                    Text("Match").tag(SessionMode.match)
                }
                .pickerStyle(.segmented)
                .frame(width: 140)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())

            Spacer(minLength: 4)

            // Center Capsule Cluster: Live Tracking & Calibration Status Pill + Court Lines Overlay toggle
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(stateDotColor)
                        .frame(width: 9, height: 9)
                        .scaleEffect(c.engineState != .sleeping && pulseDot ? 1.28 : 0.92)
                    Text(c.engineState.rawValue.uppercased())
                        .font(.caption.monospaced().bold())
                        .foregroundStyle(c.engineState == .live ? Color.green : Color.primary)
                    if c.currentBall != nil {
                        Text("· BALL")
                            .font(.caption2.monospaced().bold())
                            .foregroundStyle(.yellow)
                    }
                }

                Divider().frame(height: 16)

                if c.calibration != nil {
                    Button {
                        Haptics.impact(.light)
                        c.beginCalibration()
                    } label: {
                        Label("Calibrated ✓", systemImage: "checkmark.seal.fill")
                            .font(.caption.bold())
                            .foregroundStyle(.green)
                    }
                    .buttonStyle(.plain)

                    Button {
                        Haptics.impact(.light)
                        showCourtLines.toggle()
                    } label: {
                        Label(showCourtLines ? "Court Lines On" : "Court Lines",
                              systemImage: showCourtLines ? "squareshape.split.2x2" : "squareshape")
                            .font(.caption2.bold())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(showCourtLines ? Color.green.opacity(0.28) : Color.white.opacity(0.12),
                                        in: Capsule())
                            .foregroundStyle(showCourtLines ? Color.green : Color.secondary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        Haptics.impact(.medium)
                        c.beginCalibration()
                    } label: {
                        Label("Calibrate Court", systemImage: "viewfinder")
                            .font(.caption.bold())
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())

            Spacer(minLength: 4)

            // Right Capsule Cluster: Audio Mode menu, Clips Saved / Upload badge, and Manual Start/Finish Rally button
            HStack(spacing: 8) {
                Menu {
                    Picker("Audio", selection: $c.audioMode) {
                        ForEach(AudioCallMode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Toggle("Doubles lines", isOn: $c.doubles)
                } label: {
                    Label(c.audioMode == .mute ? "Muted" : "Audio",
                          systemImage: c.audioMode == .mute ? "speaker.slash.fill" : "speaker.wave.2.fill")
                        .font(.caption.bold())
                }
                .buttonStyle(.bordered)

                Button {
                    Haptics.impact(.light)
                    showClipsSheet = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: uploader.activeUploadsCount > 0 ? "icloud.and.arrow.up.fill" : "film.stack")
                            .foregroundStyle(uploader.activeUploadsCount > 0 ? Color.cyan : Color.primary)
                        Text("Clips (\(c.clipsSaved))")
                            .monospacedDigit()
                    }
                    .font(.caption.bold())
                }
                .buttonStyle(.bordered)

                Button {
                    c.toggleManualRally()
                } label: {
                    Label(c.engineState == .live || c.engineState == .armed ? "Finish Rally" : "Start Rally",
                          systemImage: c.engineState == .live || c.engineState == .armed ? "checkmark.circle.fill" : "record.circle")
                        .font(.caption.bold())
                }
                .buttonStyle(.borderedProminent)
                .tint(c.engineState == .live || c.engineState == .armed ? .green : .blue)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    @ViewBuilder private var banners: some View {
        if let error = c.setupError { Banner(text: error, color: .red) }
        if c.calibration == nil {
            Banner(text: "Ball tracking active — tap Calibrate Court (4 corners + 2 net posts) to enable metric IN/OUT line calls",
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
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
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
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// Draws the calibrated ITF court wireframe + net line directly over `CameraPreview` so the player can visually verify
/// tripod alignment on court at any time.
struct LiveCourtWireframeOverlay: View {
    let calibration: CourtCalibration
    let doubles: Bool
    let callsPaused: Bool

    private static let courtLinePairs = [
        (0, 1), (2, 3), (0, 2), (1, 3), // doubles outer rectangle
        (4, 5), (6, 7),                 // singles sidelines
        (8, 9), (10, 11),               // far & near service lines
        (12, 13),                       // centre service line
    ]

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
            func toView(_ p: Point2) -> CGPoint {
                CGPoint(x: originX + CGFloat(p.x) * scale, y: originY + CGFloat(p.y) * scale)
            }

            guard let courtToImage = calibration.h0.inverse
                ?? Homography.fit(from: Court.cornerIndices.map { Court.points[$0] }, to: calibration.corners) else {
                return
            }

            let lineColor: Color = callsPaused ? .orange : .green
            var courtPath = Path()
            for (a, b) in Self.courtLinePairs {
                guard let pa = courtToImage.apply(Court.points[a]),
                      let pb = courtToImage.apply(Court.points[b]) else { continue }
                courtPath.move(to: toView(pa))
                courtPath.addLine(to: toView(pb))
            }
            ctx.stroke(courtPath, with: .color(lineColor.opacity(0.85)),
                       style: StrokeStyle(lineWidth: 2.0, lineCap: .round, lineJoin: .round))

            if let posts = calibration.netPosts, posts.count == 2 {
                var netPath = Path()
                netPath.move(to: toView(posts[0]))
                netPath.addLine(to: toView(posts[1]))
                ctx.stroke(netPath, with: .color(.cyan.opacity(0.85)),
                           style: StrokeStyle(lineWidth: 2.0, lineCap: .round, dash: [6, 4]))
            }

            for corner in calibration.corners {
                let pt = toView(corner)
                let rect = CGRect(x: pt.x - 4, y: pt.y - 4, width: 8, height: 8)
                ctx.fill(Path(ellipseIn: rect), with: .color(.yellow))
                ctx.stroke(Path(ellipseIn: rect.insetBy(dx: -2, dy: -2)), with: .color(lineColor), lineWidth: 1.5)
            }
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

// MARK: - Models

/// Metadata for a single recorded or imported rally clip stored in `Application Support/Rallies/`.
struct RallyClipRecord: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var rallyIdx: Int
    var fileName: String
    var startS: Double
    var durationS: Double
    var shotCount: Int
    var inStreak: Int
    var bookmarked: Bool
    var liveCall: String?
    var source: String = "ios"
    var uploadStatus: ClipUploadState

    var fileURL: URL {
        CameraCaptureManager.clipsDirectory.appendingPathComponent(fileName)
    }

    var fileExistsOnDisk: Bool {
        FileManager.default.fileExists(atPath: fileURL.path)
    }
}

/// Completed or in-progress on-device session persisted in `Application Support/Rallies/sessions.json`.
struct LocalSessionRecord: Codable, Identifiable, Equatable, Sendable {
    var id: UUID
    var startedAt: Date
    var endedAt: Date
    var mode: SessionMode
    var doubles: Bool
    var totalShots: Int
    var bestStreak: Int
    var ralliesCount: Int
    var inCalls: Int
    var outCalls: Int
    var scoreFormatted: String?
    var clipFiles: [RallyClipRecord]
    var uploadStatus: ClipUploadState
    var court: RallySegmentUploader.CourtJSON?
    var source: String? = "ios"

    var inCallPct: Double? {
        let total = inCalls + outCalls
        guard total > 0 else { return nil }
        return (Double(inCalls) / Double(total) * 1000).rounded() / 10
    }
}

/// JSON schema returned by `GET <webBaseURL>/api/tennis/sessions`.
struct RemoteSessionsResponse: Codable, Sendable {
    struct Summary: Codable, Sendable {
        var totalSessions: Int
        var totalRallies: Int
        var totalShots: Int
        var bestInStreak: Int
        var inCallRate: Double
    }

    struct RemoteSession: Codable, Identifiable, Sendable {
        var id: String
        var matchId: String?
        var title: String?
        var playedOn: String?
        var sessionType: String?
        var source: String?
        var status: String?
        var doubles: Bool?
        var ralliesDone: Int?
        var ralliesExpected: Int?
        var totalRallies: Int?
        var totalShots: Int?
        var bestInStreak: Int?
        var longestRally: Int?
        var inPct: Double?
        var outCount: Int?
        var scoreFormatted: String?
        var createdAt: String?
        var updatedAt: String?

        var canonicalMatchId: String {
            (matchId ?? id).lowercased()
        }
    }

    var summary: Summary
    var sessions: [RemoteSession]
}

/// Unified session row displayed on `HomeView` after merging local and cloud sessions by `match_id`.
struct MergedSessionItem: Identifiable {
    let id: String                              // lowercased match UUID
    let title: String
    let date: Date
    let dateLabel: String
    let mode: SessionMode
    let doubles: Bool
    let sourceLabel: String
    let totalShots: Int
    let bestStreak: Int
    let ralliesCount: Int
    let inPct: Double?
    let scoreFormatted: String?
    let uploadStatus: ClipUploadState
    let remoteStatus: String?
    let localRecord: LocalSessionRecord?
    let remoteRecord: RemoteSessionsResponse.RemoteSession?
}

/// Aggregate metrics displayed in the 4+1 summary tiles at the top of `HomeView`.
struct AggregateSessionStats {
    var totalSessions: Int = 0
    var totalShots: Int = 0
    var bestInStreak: Int = 0
    var totalRallies: Int = 0
    var inCallRatePct: Double?
}

// MARK: - SessionStore

@MainActor
final class SessionStore: ObservableObject {
    static let shared = SessionStore()
    private static let sessionsFileURL = CameraCaptureManager.clipsDirectory.appendingPathComponent("sessions.json")

    @Published private(set) var localSessions: [LocalSessionRecord] = []
    @Published private(set) var remoteSessions: [RemoteSessionsResponse.RemoteSession] = []
    @Published private(set) var remoteSummary: RemoteSessionsResponse.Summary?
    @Published private(set) var isFetchingRemote = false
    @Published private(set) var remoteError: String?

    private init() {
        loadLocal()
        RallySegmentUploader.shared.onClipStatusChanged = { [weak self] matchId, rallyIdx, state in
            Task { @MainActor in
                self?.updateClipStatus(matchId: matchId, rallyIdx: rallyIdx, status: state)
            }
        }
    }

    // MARK: Persistence

    func loadLocal() {
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: Self.sessionsFileURL),
           let decoded = try? dec.decode([LocalSessionRecord].self, from: data) {
            localSessions = decoded.sorted { $0.startedAt > $1.startedAt }
        }
    }

    private func saveLocal() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted]
        if let data = try? enc.encode(localSessions) {
            try? data.write(to: Self.sessionsFileURL, options: .atomic)
        }
    }

    /// Inserts or updates a local session and persists `sessions.json`.
    func upsertLocalSession(_ record: LocalSessionRecord) {
        var updated = record
        if let idx = localSessions.firstIndex(where: { $0.id == updated.id }) {
            let existingById = Dictionary(localSessions[idx].clipFiles.map { ($0.id, $0.uploadStatus) },
                                          uniquingKeysWith: { a, _ in a })
            for cIdx in updated.clipFiles.indices {
                let cid = updated.clipFiles[cIdx].id
                if existingById[cid] == .uploaded {
                    updated.clipFiles[cIdx].uploadStatus = .uploaded
                } else if let live = RallySegmentUploader.shared.statusByKey[cid] {
                    updated.clipFiles[cIdx].uploadStatus = live
                }
            }
            updated.uploadStatus = Self.deriveSessionUploadStatus(for: updated)
            localSessions[idx] = updated
        } else {
            updated.uploadStatus = Self.deriveSessionUploadStatus(for: updated)
            localSessions.insert(updated, at: 0)
        }
        localSessions.sort { $0.startedAt > $1.startedAt }
        saveLocal()
    }

    /// Deletes a local session and its local clip files.
    func deleteLocalSession(_ id: UUID) {
        if let existing = localSessions.first(where: { $0.id == id }) {
            for clip in existing.clipFiles {
                try? FileManager.default.removeItem(at: clip.fileURL)
            }
        }
        localSessions.removeAll { $0.id == id }
        saveLocal()
    }

    /// Deletes a local session by UUID (`deleteSession(_:)` alias used by swipe-to-delete in `HomeView`).
    func deleteSession(_ id: UUID) {
        deleteLocalSession(id)
    }

    /// Deletes a merged session item's local record and on-disk clips.
    func deleteSession(_ item: MergedSessionItem) {
        if let local = item.localRecord {
            deleteLocalSession(local.id)
        } else if let uuid = UUID(uuidString: item.id) {
            deleteLocalSession(uuid)
        }
    }

    /// Updates the upload status of one clip when `RallySegmentUploader` reports progress.
    func updateClipStatus(matchId: UUID, rallyIdx: Int, status: ClipUploadState) {
        guard let sIdx = localSessions.firstIndex(where: { $0.id == matchId }) else { return }
        if let cIdx = localSessions[sIdx].clipFiles.firstIndex(where: { $0.rallyIdx == rallyIdx }) {
            localSessions[sIdx].clipFiles[cIdx].uploadStatus = status
        }
        localSessions[sIdx].uploadStatus = Self.deriveSessionUploadStatus(for: localSessions[sIdx])
        saveLocal()
    }

    private static func deriveSessionUploadStatus(for session: LocalSessionRecord) -> ClipUploadState {
        guard !session.clipFiles.isEmpty else {
            return RallySegmentUploader.hasValidCredentials ? .localOnly : .needsToken
        }
        let states = session.clipFiles.map(\.uploadStatus)
        if states.allSatisfy({ $0 == .uploaded }) { return .uploaded }
        if states.contains(.uploading) || states.contains(.queued) { return .uploading }
        if states.contains(.failed) { return .failed }
        if states.contains(.needsToken) { return .needsToken }
        return .localOnly
    }

    // MARK: Upload & Retry Actions

    /// Queues or re-queues all clips of a local session for background upload to Modal.
    @discardableResult
    func uploadSession(_ session: LocalSessionRecord, forceAll: Bool = false) -> Bool {
        let src = session.source ?? "ios"
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: session.id, sessionType: session.mode, doubles: session.doubles,
            court: session.court, source: src
        ) else {
            if let sIdx = localSessions.firstIndex(where: { $0.id == session.id }) {
                for cIdx in localSessions[sIdx].clipFiles.indices where localSessions[sIdx].clipFiles[cIdx].uploadStatus != .uploaded {
                    localSessions[sIdx].clipFiles[cIdx].uploadStatus = .needsToken
                }
                localSessions[sIdx].uploadStatus = .needsToken
                saveLocal()
            }
            return false
        }
        var enqueuedAny = false
        for clip in session.clipFiles where clip.fileExistsOnDisk && (forceAll || clip.uploadStatus != .uploaded) {
            if !forceAll,
               let activeState = RallySegmentUploader.shared.statusByKey[clip.id],
               activeState == .uploading || activeState == .queued {
                continue
            }
            updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .uploading)
            RallySegmentUploader.shared.enqueue(
                clip: clip.fileURL, rallyIdx: clip.rallyIdx, startS: clip.startS, config: config,
                bookmarked: clip.bookmarked, liveCall: clip.liveCall
            )
            enqueuedAny = true
        }
        if src != "ios_library" {
            RallySegmentUploader.shared.finalizeSession(config: config, score: nil, points: nil)
        }
        return enqueuedAny
    }

    /// Uploads a single clip from a local session.
    @discardableResult
    func uploadClip(_ clip: RallyClipRecord, in session: LocalSessionRecord) -> Bool {
        guard clip.fileExistsOnDisk else { return false }
        let src = clip.source.isEmpty ? (session.source ?? "ios") : clip.source
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: session.id, sessionType: session.mode, doubles: session.doubles,
            court: session.court, source: src
        ) else {
            updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .needsToken)
            return false
        }
        updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .uploading)
        RallySegmentUploader.shared.enqueue(
            clip: clip.fileURL, rallyIdx: clip.rallyIdx, startS: clip.startS, config: config,
            bookmarked: clip.bookmarked, liveCall: clip.liveCall
        )
        return true
    }

    /// Re-drives all failed/pending background tasks and queues any un-uploaded local session clips.
    func retryAllPendingUploads() {
        RallySegmentUploader.shared.resumePending()
        for session in localSessions where session.uploadStatus != .uploaded {
            _ = uploadSession(session)
        }
    }

    /// Imports a video picked from the iPhone Camera Roll into `Application Support/Rallies/`, saves a
    /// `LocalSessionRecord`, and queues it for upload to Modal (`source = "ios_library"` for full multi-rally
    /// segmentation or `"ios"` for a single rally clip).
    func importAndUploadLibraryVideo(
        importedURL: URL,
        durationS: Double,
        mode: SessionMode,
        doubles: Bool,
        calibration: CourtCalibration?,
        imageSize: CGSize,
        autoSegment: Bool
    ) -> LocalSessionRecord {
        let matchId = UUID()
        let ext = importedURL.pathExtension.isEmpty ? "mov" : importedURL.pathExtension.lowercased()
        let fileName = "library_\(matchId.uuidString.lowercased())_0.\(ext)"
        let destURL = CameraCaptureManager.clipsDirectory.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: destURL)
        if (try? FileManager.default.moveItem(at: importedURL, to: destURL)) == nil {
            try? FileManager.default.copyItem(at: importedURL, to: destURL)
        }
        let source = autoSegment ? "ios_library" : "ios"
        let courtJSON = calibration.map {
            RallySegmentUploader.CourtJSON($0, width: max(1, Int(imageSize.width)), height: max(1, Int(imageSize.height)))
        }
        let initialStatus: ClipUploadState = RallySegmentUploader.hasValidCredentials ? .uploading : .needsToken
        let clip = RallyClipRecord(
            id: RallySegmentUploader.uploadKey(matchId: matchId, rallyIdx: 0),
            rallyIdx: 0,
            fileName: fileName,
            startS: 0,
            durationS: max(0, durationS),
            shotCount: 0,
            inStreak: 0,
            bookmarked: false,
            liveCall: nil,
            source: source,
            uploadStatus: initialStatus
        )
        let now = Date()
        let session = LocalSessionRecord(
            id: matchId,
            startedAt: now,
            endedAt: now.addingTimeInterval(max(0, durationS)),
            mode: mode,
            doubles: doubles,
            totalShots: 0,
            bestStreak: 0,
            ralliesCount: 1,
            inCalls: 0,
            outCalls: 0,
            scoreFormatted: nil,
            clipFiles: [clip],
            uploadStatus: initialStatus,
            court: courtJSON,
            source: source
        )
        upsertLocalSession(session)
        _ = uploadSession(session, forceAll: true)
        return session
    }

    // MARK: Remote Cloud Sync (`GET <webBaseURL>/api/tennis/sessions`)

    func refreshRemote() async {
        isFetchingRemote = true
        remoteError = nil
        defer { isFetchingRemote = false }

        let endpoint = RallySegmentUploader.webBaseURL.appendingPathComponent("api/tennis/sessions")
        var req = URLRequest(url: endpoint)
        req.timeoutInterval = 12
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                remoteError = "Cloud sync returned HTTP \(code)"
                return
            }
            let decoded = try JSONDecoder().decode(RemoteSessionsResponse.self, from: data)
            remoteSummary = decoded.summary
            remoteSessions = decoded.sessions
            reconcileLocalWithRemote(decoded.sessions)
        } catch {
            remoteError = "Offline — showing on-device sessions"
        }
    }

    private func reconcileLocalWithRemote(_ remotes: [RemoteSessionsResponse.RemoteSession]) {
        var changed = false
        let remoteById = Dictionary(uniqueKeysWithValues: remotes.map { ($0.canonicalMatchId, $0) })
        for idx in localSessions.indices {
            let key = localSessions[idx].id.uuidString.lowercased()
            guard let r = remoteById[key] else { continue }
            if let shots = r.totalShots, shots > localSessions[idx].totalShots {
                localSessions[idx].totalShots = shots
                changed = true
            }
            if let streak = r.bestInStreak, streak > localSessions[idx].bestStreak {
                localSessions[idx].bestStreak = streak
                changed = true
            }
            let rCount = r.totalRallies ?? r.ralliesDone ?? 0
            if rCount > localSessions[idx].ralliesCount {
                localSessions[idx].ralliesCount = rCount
                changed = true
            }
            if r.status == "ready", rCount > 0, localSessions[idx].uploadStatus != .uploaded {
                for cIdx in localSessions[idx].clipFiles.indices {
                    let clipId = localSessions[idx].clipFiles[cIdx].id
                    let liveState = RallySegmentUploader.shared.statusByKey[clipId]
                    if liveState != .uploading && liveState != .queued && liveState != .failed {
                        localSessions[idx].clipFiles[cIdx].uploadStatus = .uploaded
                    }
                }
                if localSessions[idx].clipFiles.allSatisfy({ $0.uploadStatus == .uploaded }) {
                    localSessions[idx].uploadStatus = .uploaded
                }
                changed = true
            }
        }
        if changed { saveLocal() }
    }

    // MARK: Merged View Model & Aggregate Stats

    var mergedSessions: [MergedSessionItem] {
        var items: [MergedSessionItem] = []
        var seenIds = Set<String>()
        let remoteById = Dictionary(uniqueKeysWithValues: remoteSessions.map { ($0.canonicalMatchId, $0) })
        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso = ISO8601DateFormatter()
        let dayFmt = DateFormatter()
        dayFmt.dateFormat = "yyyy-MM-dd"
        let displayFmt = DateFormatter()
        displayFmt.dateStyle = .medium
        displayFmt.timeStyle = .short

        for local in localSessions {
            let id = local.id.uuidString.lowercased()
            seenIds.insert(id)
            let remote = remoteById[id]
            let shots = max(local.totalShots, remote?.totalShots ?? 0)
            let streak = max(local.bestStreak, remote?.bestInStreak ?? 0)
            let rallies = max(local.ralliesCount, local.clipFiles.count, remote?.totalRallies ?? remote?.ralliesDone ?? 0)
            let remoteValidInPct = remote.flatMap { ($0.inPct ?? 0) > 0 || ($0.outCount ?? 0) > 0 ? $0.inPct : nil }
            let inPct = remoteValidInPct ?? local.inCallPct
            let score = local.scoreFormatted ?? remote?.scoreFormatted
            let status: ClipUploadState = (remote?.status == "ready" && (remote?.totalRallies ?? remote?.ralliesDone ?? 0) > 0 && local.uploadStatus != .uploading && local.uploadStatus != .failed) ? .uploaded : local.uploadStatus
            let srcLabel = local.source == "ios_library" ? "CAMERA ROLL" : "ON-DEVICE"
            let defaultTitle = local.mode == .match ? "Match Session" : "Rally Session"
            items.append(MergedSessionItem(
                id: id,
                title: remote?.title ?? defaultTitle,
                date: local.startedAt,
                dateLabel: displayFmt.string(from: local.startedAt),
                mode: local.mode,
                doubles: local.doubles,
                sourceLabel: remote != nil ? "\(srcLabel) · CLOUD" : srcLabel,
                totalShots: shots,
                bestStreak: streak,
                ralliesCount: rallies,
                inPct: inPct,
                scoreFormatted: score,
                uploadStatus: status,
                remoteStatus: remote?.status,
                localRecord: local,
                remoteRecord: remote
            ))
        }

        for remote in remoteSessions {
            let id = remote.canonicalMatchId
            guard !seenIds.contains(id) else { continue }
            seenIds.insert(id)
            let parsedDate = remote.createdAt.flatMap { isoFrac.date(from: $0) ?? iso.date(from: $0) }
                ?? remote.playedOn.flatMap { dayFmt.date(from: $0) }
                ?? Date.distantPast
            let mode: SessionMode = remote.sessionType == "match" ? .match : .rally
            let defaultTitle = mode == .match ? "Match Session" : "Rally Session"
            let dateStr = remote.playedOn ?? displayFmt.string(from: parsedDate)
            let remoteValidInPct = (remote.inPct ?? 0) > 0 || (remote.outCount ?? 0) > 0 ? remote.inPct : nil
            items.append(MergedSessionItem(
                id: id,
                title: remote.title ?? defaultTitle,
                date: parsedDate,
                dateLabel: dateStr,
                mode: mode,
                doubles: remote.doubles ?? false,
                sourceLabel: (remote.source ?? "web").uppercased(),
                totalShots: remote.totalShots ?? 0,
                bestStreak: remote.bestInStreak ?? 0,
                ralliesCount: remote.totalRallies ?? remote.ralliesDone ?? 0,
                inPct: remoteValidInPct,
                scoreFormatted: remote.scoreFormatted,
                uploadStatus: .uploaded,
                remoteStatus: remote.status,
                localRecord: nil,
                remoteRecord: remote
            ))
        }

        return items.sorted { $0.date > $1.date }
    }

    var aggregateStats: AggregateSessionStats {
        let merged = mergedSessions
        let totalSessions = merged.count
        let totalShots = merged.reduce(0) { $0 + $1.totalShots }
        let bestStreak = max(merged.map(\.bestStreak).max() ?? 0, remoteSummary?.bestInStreak ?? 0)
        let totalRallies = merged.reduce(0) { $0 + $1.ralliesCount }
        let validInPcts = merged.compactMap { item -> Double? in
            guard let pct = item.inPct, pct > 0 || (item.localRecord.map { $0.inCalls + $0.outCalls > 0 } ?? false) else {
                return nil
            }
            return pct
        }
        let inRate: Double?
        if !validInPcts.isEmpty {
            let avg = validInPcts.reduce(0, +) / Double(validInPcts.count)
            inRate = (avg * 10).rounded() / 10
        } else if let remoteRate = remoteSummary?.inCallRate, remoteRate > 0 {
            inRate = remoteRate
        } else {
            inRate = nil
        }
        return AggregateSessionStats(
            totalSessions: totalSessions,
            totalShots: totalShots,
            bestInStreak: bestStreak,
            totalRallies: totalRallies,
            inCallRatePct: inRate
        )
    }

    var pendingLocalSessionsCount: Int {
        localSessions.filter { $0.uploadStatus != .uploaded && !$0.clipFiles.isEmpty }.count
    }
}

// MARK: - Transferable Video Wrapper for PhotosPicker

struct PickedVideoFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let dst = FileManager.default.temporaryDirectory
                .appendingPathComponent("picked_\(UUID().uuidString.lowercased()).\(ext)")
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.copyItem(at: received.file, to: dst)
            return Self(url: dst)
        }
    }
}

// MARK: - HomeView (Root Screen)

enum SessionModeFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case rally = "Rally"
    case match = "Match"

    var id: String { rawValue }
}

struct HomeView: View {
    @EnvironmentObject private var controller: SessionController
    @ObservedObject private var store = SessionStore.shared
    @ObservedObject private var uploader = RallySegmentUploader.shared

    @State private var isRecordingSession = false
    @State private var launchMode: SessionMode = .rally
    @State private var launchDoubles = false
    @State private var modeFilter: SessionModeFilter = .all
    @State private var showCloudSettings = false
    @State private var selectedSession: MergedSessionItem?
    @State private var pickedPhotoItem: PhotosPickerItem?
    @State private var isImportingVideo = false
    @State private var importError: String?
    @State private var pendingLibraryVideo: LibraryVideoDraft?

    struct LibraryVideoDraft: Identifiable {
        let id = UUID()
        let url: URL
        let firstFrame: CGImage?
        let imageSize: CGSize
        let durationS: Double
    }

    private var filteredSessions: [MergedSessionItem] {
        let all = store.mergedSessions
        switch modeFilter {
        case .all:
            return all
        case .rally:
            return all.filter { $0.mode == .rally }
        case .match:
            return all.filter { $0.mode == .match }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    headerSection
                    readinessPillBar
                    statsDashboard
                    primaryActionsSection
                    recentSessionsSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
            .background(Color(white: 0.07).ignoresSafeArea())
            .navigationBarHidden(true)
        }
        .preferredColorScheme(.dark)
        .task {
            await store.refreshRemote()
        }
        .onChange(of: pickedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task { await handlePickedVideo(newItem) }
        }
        .fullScreenCover(isPresented: $isRecordingSession) {
            RecordView(onEndSession: {
                isRecordingSession = false
                Task { await store.refreshRemote() }
            })
            .environmentObject(controller)
        }
        .sheet(item: $pendingLibraryVideo) { draft in
            VideoLibraryUploadSheet(draft: draft) {
                pendingLibraryVideo = nil
                Task { await store.refreshRemote() }
            }
        }
        .sheet(isPresented: $showCloudSettings) {
            CloudSettingsSheet()
        }
        .sheet(item: $selectedSession) { item in
            SessionDetailSheet(item: item)
        }
    }

    // MARK: Header & On-Court Readiness / Cloud Sync Pill Bar

    private var headerSection: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "tennisball.fill")
                        .foregroundStyle(.yellow)
                        .font(.title2)
                    Text("TennisVision")
                        .font(.title2.bold())
                }
                Text("Live On-Court Line Caller · Rally Streak Counter · Cloud Studio")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Haptics.impact(.light)
                Task { await store.refreshRemote() }
            } label: {
                Label(store.isFetchingRemote ? "Syncing…" : "Sync", systemImage: "arrow.clockwise")
                    .font(.caption.bold())
            }
            .buttonStyle(.bordered)
            .disabled(store.isFetchingRemote)

            Button {
                Haptics.impact(.light)
                showCloudSettings = true
            } label: {
                Label("Settings", systemImage: "gearshape.fill")
                    .font(.caption.bold())
            }
            .buttonStyle(.bordered)
        }
    }

    private var readinessPillBar: some View {
        let isCloudReady = RallySegmentUploader.hasValidCredentials
        let webDashboardURL = URL(string: "\(RallySegmentUploader.webBaseURLString)/tennis")
            ?? URL(string: "https://www.thelastmattapalli.com/tennis")!
        return HStack(spacing: 10) {
            Button {
                Haptics.impact(.light)
                showCloudSettings = true
            } label: {
                HStack(spacing: 7) {
                    Circle()
                        .fill(isCloudReady ? Color.green : Color.orange)
                        .frame(width: 8, height: 8)
                    Text(isCloudReady ? "Cloud Sync Ready" : "Local Only — Tap to Configure")
                        .font(.caption.bold())
                        .foregroundStyle(isCloudReady ? Color.green : Color.orange)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    (isCloudReady ? Color.green : Color.orange).opacity(0.16),
                    in: Capsule()
                )
            }
            .buttonStyle(.plain)

            if uploader.activeUploadsCount > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Uploading \(uploader.activeUploadsCount) clip\(uploader.activeUploadsCount == 1 ? "" : "s")…")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(.cyan)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.cyan.opacity(0.16), in: Capsule())
            } else if store.pendingLocalSessionsCount > 0 {
                Button {
                    Haptics.impact(.light)
                    if isCloudReady {
                        store.retryAllPendingUploads()
                    } else {
                        showCloudSettings = true
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.up.circle.fill")
                        Text("\(store.pendingLocalSessionsCount) Pending Upload\(store.pendingLocalSessionsCount == 1 ? "" : "s")")
                            .monospacedDigit()
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Color.orange.opacity(0.18), in: Capsule())
                    .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
            }

            Spacer()

            Link(destination: webDashboardURL) {
                HStack(spacing: 5) {
                    Image(systemName: "globe")
                    Text("Web Dashboard ↗")
                        .font(.caption.bold())
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.white.opacity(0.08), in: Capsule())
                .foregroundStyle(.primary)
            }
        }
    }

    // MARK: Stats Dashboard

    private var statsDashboard: some View {
        let stats = store.aggregateStats
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("RECENT SESSIONS OVERVIEW")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let inPct = stats.inCallRatePct {
                    Text(String(format: "Line Calls: %.1f%% IN", inPct))
                        .font(.caption.monospacedDigit().bold())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.green.opacity(0.22), in: Capsule())
                        .foregroundStyle(.green)
                }
            }
            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
            ], spacing: 12) {
                StatTile(title: "Sessions", value: "\(stats.totalSessions)", icon: "calendar", tint: .cyan)
                StatTile(title: "Total Shots", value: "\(stats.totalShots)", icon: "bolt.fill", tint: .yellow)
                StatTile(title: "Best In-Streak", value: "\(stats.bestInStreak)", icon: "flame.fill", tint: .orange)
                StatTile(title: "Rallies Recorded", value: "\(stats.totalRallies)", icon: "film.stack", tint: .green)
            }
        }
    }

    // MARK: Primary Actions (Start Court Session + Upload Video from Photos + Retry Pending)

    private var primaryActionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                // Start Court Session card
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Picker("Mode", selection: $launchMode) {
                            Text("Rally Mode").tag(SessionMode.rally)
                            Text("Match Mode").tag(SessionMode.match)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 220)

                        Toggle("Doubles", isOn: $launchDoubles)
                            .toggleStyle(.button)
                            .font(.caption.bold())
                        Spacer()
                    }
                    Button {
                        controller.prepareNewSession(mode: launchMode, doubles: launchDoubles)
                        isRecordingSession = true
                    } label: {
                        HStack {
                            Image(systemName: "video.fill")
                            Text("Start Court Session")
                                .font(.headline.bold())
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
                .padding(14)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))

                // Upload Video / Rally from Camera Roll card
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label("Camera Roll Upload", systemImage: "photo.on.rectangle.angled")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        Spacer()
                        if store.pendingLocalSessionsCount > 0 {
                            Button {
                                if RallySegmentUploader.hasValidCredentials {
                                    store.retryAllPendingUploads()
                                } else {
                                    showCloudSettings = true
                                }
                            } label: {
                                Label("Upload Pending (\(store.pendingLocalSessionsCount))",
                                      systemImage: "arrow.up.circle.fill")
                                    .font(.caption2.bold())
                            }
                            .buttonStyle(.bordered)
                            .tint(.orange)
                        }
                    }

                    PhotosPicker(selection: $pickedPhotoItem, matching: .videos) {
                        HStack {
                            if isImportingVideo {
                                ProgressView().controlSize(.small)
                                Text("Loading Video…")
                                    .font(.headline.bold())
                            } else {
                                Image(systemName: "square.and.arrow.up.fill")
                                Text("Upload Video / Rally from Photos")
                                    .font(.headline.bold())
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)
                    .disabled(isImportingVideo)
                }
                .padding(14)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            }

            if let importError = self.importError {
                Text(importError)
                    .font(.caption.bold())
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: Recent Sessions List

    private var recentSessionsSection: some View {
        let allSessions = store.mergedSessions
        let sessions = filteredSessions
        let rallyCount = allSessions.filter { $0.mode == .rally }.count
        let matchCount = allSessions.filter { $0.mode == .match }.count
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("RECENT SESSIONS & RALLY CLIPS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let err = store.remoteError {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                // Mode Filter Pills (All / Rally / Match)
                HStack(spacing: 6) {
                    ForEach(SessionModeFilter.allCases) { filter in
                        let isSelected = modeFilter == filter
                        let count: Int = {
                            switch filter {
                            case .all: return allSessions.count
                            case .rally: return rallyCount
                            case .match: return matchCount
                            }
                        }()
                        Button {
                            Haptics.impact(.light)
                            modeFilter = filter
                        } label: {
                            Text("\(filter.rawValue) (\(count))")
                                .font(.caption2.monospacedDigit().bold())
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(
                                    isSelected ? Color.green.opacity(0.28) : Color.white.opacity(0.08),
                                    in: Capsule()
                                )
                                .overlay(
                                    Capsule().stroke(isSelected ? Color.green : Color.clear, lineWidth: 1)
                                )
                                .foregroundStyle(isSelected ? Color.green : Color.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if sessions.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "tennis.racket")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text(modeFilter == .all ? "No sessions yet" : "No \(modeFilter.rawValue.lowercased()) sessions yet")
                        .font(.headline)
                    Text("Tap \"Start Court Session\" to record live rallies with on-device line calls, or tap \"Upload Video / Rally from Photos\" to analyze an existing video.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 480)
                }
                .frame(maxWidth: .infinity)
                .padding(28)
                .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14))
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(sessions) { item in
                        SessionRowCard(
                            item: item,
                            onSelect: {
                                Haptics.impact(.light)
                                selectedSession = item
                            },
                            onUploadTap: {
                                Haptics.impact(.medium)
                                if let local = item.localRecord {
                                    if !RallySegmentUploader.hasValidCredentials {
                                        showCloudSettings = true
                                    } else {
                                        _ = store.uploadSession(local, forceAll: true)
                                    }
                                }
                            },
                            onDeleteTap: item.localRecord != nil ? {
                                Haptics.notify(.warning)
                                store.deleteSession(item)
                            } : nil
                        )
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if item.localRecord != nil {
                                Button(role: .destructive) {
                                    Haptics.notify(.warning)
                                    store.deleteSession(item)
                                } label: {
                                    Label("Delete Session", systemImage: "trash.fill")
                                }
                            }
                        }
                        .contextMenu {
                            Button {
                                selectedSession = item
                            } label: {
                                Label("View Clips & Details", systemImage: "film.stack")
                            }
                            if let local = item.localRecord {
                                Button {
                                    if RallySegmentUploader.hasValidCredentials {
                                        _ = store.uploadSession(local, forceAll: true)
                                    } else {
                                        showCloudSettings = true
                                    }
                                } label: {
                                    Label("Upload Clips to Cloud", systemImage: "icloud.and.arrow.up")
                                }
                                Button(role: .destructive) {
                                    Haptics.notify(.warning)
                                    store.deleteSession(item)
                                } label: {
                                    Label("Delete Local Session", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Video Extraction Helper

    private func handlePickedVideo(_ item: PhotosPickerItem) async {
        isImportingVideo = true
        importError = nil
        defer {
            isImportingVideo = false
            pickedPhotoItem = nil
        }
        do {
            guard let picked = try await item.loadTransferable(type: PickedVideoFile.self) else {
                importError = "Could not read video from Photos library."
                return
            }
            let asset = AVURLAsset(url: picked.url)
            let durationCM = try? await asset.load(.duration)
            let durationS = durationCM.map { CMTimeGetSeconds($0) } ?? 0
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
            let cgImage = try? generator.copyCGImage(at: .zero, actualTime: nil)
            let size = cgImage.map { CGSize(width: $0.width, height: $0.height) }
                ?? CGSize(width: Int(CameraCaptureManager.width), height: Int(CameraCaptureManager.height))
            pendingLibraryVideo = LibraryVideoDraft(
                url: picked.url,
                firstFrame: cgImage,
                imageSize: size,
                durationS: durationS.isFinite ? max(0, durationS) : 0
            )
        } catch {
            importError = "Could not import video: \(error.localizedDescription)"
        }
    }
}

// MARK: - StatTile & SessionRowCard

private struct StatTile: View {
    let title: String
    let value: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            Text(value)
                .font(.system(size: 28, weight: .heavy, design: .rounded))
                .monospacedDigit()
        }
        .padding(12)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct SessionRowCard: View {
    let item: MergedSessionItem
    let onSelect: () -> Void
    let onUploadTap: () -> Void
    var onDeleteTap: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(item.mode.rawValue.uppercased())
                        .font(.caption2.bold())
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(item.mode == .match ? Color.purple.opacity(0.3) : Color.green.opacity(0.25),
                                    in: Capsule())
                        .foregroundStyle(item.mode == .match ? Color.purple : Color.green)

                    if item.doubles {
                        Text("DOUBLES")
                            .font(.caption2.bold())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.cyan.opacity(0.2), in: Capsule())
                    }

                    Text(item.dateLabel)
                        .font(.subheadline.bold())

                    Text(item.sourceLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 16) {
                    Label("\(item.totalShots) shots", systemImage: "bolt.fill")
                    Label("Best streak \(item.bestStreak)", systemImage: "flame.fill")
                    Label("\(item.ralliesCount) rallies", systemImage: "film.stack")
                    if let inPct = item.inPct {
                        Text(String(format: "%.0f%% IN", inPct))
                            .foregroundStyle(.green)
                    }
                    if let score = item.scoreFormatted, !score.isEmpty {
                        Text("Score: \(score)")
                            .foregroundStyle(.yellow)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }

            Spacer()

            if item.localRecord != nil && item.uploadStatus != .uploaded {
                Button(action: onUploadTap) {
                    Label(item.uploadStatus.label, systemImage: "icloud.and.arrow.up")
                        .font(.caption.bold())
                }
                .buttonStyle(.borderedProminent)
                .tint(statusColor(item.uploadStatus))
            } else {
                Text(item.uploadStatus.label)
                    .font(.caption2.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor(item.uploadStatus).opacity(0.22), in: Capsule())
                    .foregroundStyle(statusColor(item.uploadStatus))
            }

            Button(action: onSelect) {
                HStack(spacing: 4) {
                    Text("Clips & Details")
                        .font(.caption.bold())
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                }
            }
            .buttonStyle(.bordered)

            if let onDeleteTap = self.onDeleteTap {
                Button(role: .destructive, action: onDeleteTap) {
                    Image(systemName: "trash")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .help("Delete local session")
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    private func statusColor(_ status: ClipUploadState) -> Color {
        switch status {
        case .uploaded: return .green
        case .uploading, .queued: return .blue
        case .failed: return .red
        case .needsToken, .localOnly: return .orange
        }
    }
}

// MARK: - VideoLibraryUploadSheet (PhotosPicker -> Optional Calibration -> Upload)

struct VideoLibraryUploadSheet: View {
    let draft: HomeView.LibraryVideoDraft
    let onFinished: () -> Void

    @State private var mode: SessionMode = .rally
    @State private var doubles = false
    @State private var autoSegment = true
    @State private var calibration: CourtCalibration?
    @State private var showCalibrationOverlay = false

    private var intrinsics: Intrinsics {
        Intrinsics(horizontalFOVDegrees: 68.0, width: Double(draft.imageSize.width), height: Double(draft.imageSize.height))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let cgImage = draft.firstFrame {
                        ZStack(alignment: .bottomTrailing) {
                            Image(decorative: cgImage, scale: 1)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: 12))

                            Button {
                                showCalibrationOverlay = true
                            } label: {
                                Label(calibration == nil ? "Calibrate Court (4 Corners + 2 Posts)" : "Recalibrate Court ✓",
                                      systemImage: "viewfinder")
                                    .font(.caption.bold())
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(calibration == nil ? .blue : .green)
                            .padding(10)
                        }
                    }

                    HStack(spacing: 16) {
                        Picker("Session Mode", selection: $mode) {
                            Text("Rally Mode").tag(SessionMode.rally)
                            Text("Match Mode").tag(SessionMode.match)
                        }
                        .pickerStyle(.segmented)

                        Toggle("Doubles Court", isOn: $doubles)
                            .toggleStyle(.button)
                    }

                    Toggle(isOn: $autoSegment) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Auto-Segment Full Video into Rallies")
                                .font(.subheadline.bold())
                            Text(autoSegment
                                 ? "Modal GPU will run WASB across the entire video and split it into individual rally clips."
                                 : "Treat this video as a single pre-trimmed rally clip.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if !RallySegmentUploader.hasValidCredentials {
                        Text("Note: No Modal Job Token is configured yet. The video will be saved to your session list so you can upload it as soon as you set your token in Cloud Settings.")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }

                    HStack {
                        Button("Cancel", role: .cancel) {
                            try? FileManager.default.removeItem(at: draft.url)
                            onFinished()
                        }
                        .buttonStyle(.bordered)

                        Spacer()

                        Button {
                            _ = SessionStore.shared.importAndUploadLibraryVideo(
                                importedURL: draft.url,
                                durationS: draft.durationS,
                                mode: mode,
                                doubles: doubles,
                                calibration: calibration,
                                imageSize: draft.imageSize,
                                autoSegment: autoSegment
                            )
                            onFinished()
                        } label: {
                            Label(RallySegmentUploader.hasValidCredentials ? "Save & Upload to Cloud" : "Save to Sessions",
                                  systemImage: "icloud.and.arrow.up.fill")
                                .font(.headline.bold())
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Upload Video / Rally")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .fullScreenCover(isPresented: $showCalibrationOverlay) {
            if let cgImage = draft.firstFrame {
                CourtCalibrationOverlay(
                    image: cgImage,
                    intrinsics: intrinsics,
                    initial: calibration,
                    onDone: { cal in
                        calibration = cal
                        showCalibrationOverlay = false
                    },
                    onCancel: { showCalibrationOverlay = false }
                )
            }
        }
    }
}

// MARK: - SessionDetailSheet (Replay, Save Clip to Photos, ShareLink, Call & Shot Breakdown, Re-upload)

struct SessionDetailSheet: View {
    let item: MergedSessionItem
    @ObservedObject private var store = SessionStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var playingURL: IdentifiableURL?
    @State private var bookmarkedOnly = false
    @State private var savedClipIds: Set<String> = []
    @State private var photoSaveMessage: String?

    struct IdentifiableURL: Identifiable {
        let id = UUID()
        let url: URL
    }

    private var currentLocal: LocalSessionRecord? {
        guard let id = UUID(uuidString: item.id) else { return item.localRecord }
        return store.localSessions.first { $0.id == id } ?? item.localRecord
    }

    private var inCallsCount: Int {
        if let local = currentLocal, local.inCalls + local.outCalls > 0 {
            return local.inCalls
        }
        if let remote = item.remoteRecord {
            let outs = remote.outCount ?? 0
            let total = max(outs, item.totalShots)
            return max(0, total - outs)
        }
        return 0
    }

    private var outCallsCount: Int {
        if let local = currentLocal, local.inCalls + local.outCalls > 0 {
            return local.outCalls
        }
        return item.remoteRecord?.outCount ?? 0
    }

    private var effectiveInPct: Double {
        if let pct = currentLocal?.inCallPct ?? item.inPct {
            return max(0, min(100, pct))
        }
        let total = inCallsCount + outCallsCount
        guard total > 0 else { return 100.0 }
        return Double(inCallsCount) / Double(total) * 100.0
    }

    private func saveClipToPhotos(_ clip: RallyClipRecord) {
        guard clip.fileExistsOnDisk else { return }
        Haptics.impact(.medium)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    self.photoSaveMessage = "Photos permission is required to save clips to Camera Roll."
                }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: clip.fileURL)
            }) { success, error in
                DispatchQueue.main.async {
                    if success {
                        self.savedClipIds.insert(clip.id)
                        self.photoSaveMessage = "Saved Rally #\(clip.rallyIdx + 1) to Photos."
                        Haptics.notify(.success)
                    } else {
                        self.photoSaveMessage = "Could not save video: \(error?.localizedDescription ?? "Unknown error")"
                    }
                }
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Call & Shot Breakdown") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label(String(format: "%.1f%% IN", effectiveInPct), systemImage: "checkmark.circle.fill")
                                .font(.headline.monospacedDigit().bold())
                                .foregroundStyle(.green)
                            Spacer()
                            Text("\(inCallsCount) In-Calls · \(outCallsCount) Out-Calls")
                                .font(.caption.monospacedDigit().bold())
                                .foregroundStyle(.secondary)
                        }

                        GeometryReader { geo in
                            let w = max(1, geo.size.width)
                            let inW = w * CGFloat(effectiveInPct / 100.0)
                            HStack(spacing: 2) {
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(Color.green)
                                    .frame(width: max(6, inW))
                                if effectiveInPct < 99.9 {
                                    RoundedRectangle(cornerRadius: 5)
                                        .fill(Color.red)
                                        .frame(maxWidth: .infinity)
                                }
                            }
                        }
                        .frame(height: 10)

                        HStack(spacing: 16) {
                            Label("\(item.totalShots) Total Shots", systemImage: "bolt.fill")
                            Label("Best Streak: \(item.bestStreak)", systemImage: "flame.fill")
                            Label("\(item.ralliesCount) Rallies", systemImage: "film.stack")
                        }
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)

                    if let local = currentLocal, !local.clipFiles.isEmpty {
                        let bookmarkedCount = local.clipFiles.filter(\.bookmarked).count
                        Toggle(isOn: $bookmarkedOnly) {
                            Label("Bookmarked Rallies Only (\(bookmarkedCount))", systemImage: "star.fill")
                                .foregroundStyle(bookmarkedOnly ? Color.yellow : Color.primary)
                        }
                        .tint(.yellow)
                    }
                }

                Section("Session Summary") {
                    HStack {
                        Text("Mode")
                        Spacer()
                        Text("\(item.mode.rawValue.capitalized)\(item.doubles ? " (Doubles)" : " (Singles)")")
                            .foregroundStyle(.secondary)
                    }
                    if let score = item.scoreFormatted, !score.isEmpty {
                        HStack {
                            Text("Match Score")
                            Spacer()
                            Text(score).bold()
                        }
                    }
                    if let webURL = URL(string: "\(RallySegmentUploader.webBaseURLString)/tennis/\(item.id)") {
                        Link(destination: webURL) {
                            Label("Open Session in Web Dashboard ↗", systemImage: "safari")
                        }
                    }
                }

                if let local = currentLocal {
                    Section("Cloud Upload & Session Actions") {
                        HStack {
                            Text("Status")
                            Spacer()
                            Text(local.uploadStatus.label)
                                .bold()
                        }
                        Button {
                            Haptics.impact(.medium)
                            _ = store.uploadSession(local, forceAll: true)
                        } label: {
                            Label(local.uploadStatus == .uploaded ? "Re-Upload All Clips to Cloud" : "Upload Session Clips Now",
                                  systemImage: "icloud.and.arrow.up")
                        }
                        .disabled(!RallySegmentUploader.hasValidCredentials)

                        Button(role: .destructive) {
                            Haptics.notify(.warning)
                            store.deleteLocalSession(local.id)
                            dismiss()
                        } label: {
                            Label("Delete Local Session & Clips", systemImage: "trash")
                        }
                    }

                    let visibleClips = bookmarkedOnly ? local.clipFiles.filter(\.bookmarked) : local.clipFiles
                    Section("Saved On-Device Rally Clips (\(visibleClips.count))") {
                        if let photoSaveMessage = self.photoSaveMessage {
                            Text(photoSaveMessage)
                                .font(.caption.bold())
                                .foregroundStyle(.green)
                        }
                        if visibleClips.isEmpty {
                            Text(bookmarkedOnly ? "No bookmarked rally clips in this session." : "No local clip files recorded for this session.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(visibleClips) { clip in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(spacing: 8) {
                                        Text(clip.source == "ios_library" ? "Full Video" : "Rally #\(clip.rallyIdx + 1)")
                                            .font(.subheadline.bold())
                                        if clip.bookmarked {
                                            Label("Bookmarked", systemImage: "star.fill")
                                                .font(.caption2.bold())
                                                .foregroundStyle(.yellow)
                                        }
                                        if let call = clip.liveCall {
                                            Text(call.uppercased())
                                                .font(.caption2.bold())
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(call == "out" ? Color.red.opacity(0.3) : Color.green.opacity(0.3),
                                                            in: Capsule())
                                                .foregroundStyle(call == "out" ? Color.red : Color.green)
                                        }
                                        Spacer()
                                        Text("\(clip.shotCount) shots · streak \(clip.inStreak) · \(clip.uploadStatus.label)")
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }

                                    HStack(spacing: 10) {
                                        if clip.fileExistsOnDisk {
                                            Button {
                                                Haptics.impact(.light)
                                                playingURL = IdentifiableURL(url: clip.fileURL)
                                            } label: {
                                                Label("Play", systemImage: "play.fill")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.borderedProminent)
                                            .tint(.green)

                                            Button {
                                                saveClipToPhotos(clip)
                                            } label: {
                                                Label(savedClipIds.contains(clip.id) ? "Saved to Photos ✓" : "Save Clip to Photos",
                                                      systemImage: savedClipIds.contains(clip.id) ? "checkmark.circle.fill" : "photo.badge.arrow.down")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.bordered)
                                            .tint(savedClipIds.contains(clip.id) ? .green : .blue)

                                            ShareLink(item: clip.fileURL) {
                                                Label("Share", systemImage: "square.and.arrow.up")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.bordered)

                                            if clip.uploadStatus != .uploaded {
                                                Button {
                                                    Haptics.impact(.light)
                                                    _ = store.uploadClip(clip, in: local)
                                                } label: {
                                                    Label("Upload", systemImage: "icloud.and.arrow.up")
                                                        .font(.caption.bold())
                                                }
                                                .buttonStyle(.bordered)
                                                .tint(.orange)
                                            }
                                        } else if let remoteClipURL = URL(
                                            string: "\(RallySegmentUploader.modalBaseURLString)/clips/\(item.id)/\(clip.rallyIdx).mp4"
                                        ) {
                                            Button {
                                                playingURL = IdentifiableURL(url: remoteClipURL)
                                            } label: {
                                                Label("Stream from Cloud", systemImage: "play.circle")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.bordered)
                                        }
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
                if (currentLocal == nil || currentLocal?.source == "ios_library"), item.ralliesCount > 0 {
                    Section("Cloud Rally Clips (\(item.ralliesCount))") {
                        ForEach(0..<item.ralliesCount, id: \.self) { idx in
                            if let remoteClipURL = URL(
                                string: "\(RallySegmentUploader.modalBaseURLString)/clips/\(item.id)/\(idx).mp4"
                            ) {
                                HStack {
                                    Button {
                                        playingURL = IdentifiableURL(url: remoteClipURL)
                                    } label: {
                                        Label("Play Rally #\(idx + 1)", systemImage: "play.circle.fill")
                                            .font(.subheadline.bold())
                                    }
                                    .buttonStyle(.borderless)
                                    Spacer()
                                    ShareLink(item: remoteClipURL) {
                                        Label("Share Link", systemImage: "square.and.arrow.up")
                                            .font(.caption.bold())
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $playingURL) { item in
            VideoPlayer(player: AVPlayer(url: item.url))
                .ignoresSafeArea()
        }
    }
}

// MARK: - CloudSettingsSheet

struct CloudSettingsSheet: View {
    @ObservedObject private var uploader = RallySegmentUploader.shared
    @ObservedObject private var store = SessionStore.shared
    @Environment(\.dismiss) private var dismiss

    @State private var modalBaseURL = RallySegmentUploader.modalBaseURLString
    @State private var modalJobToken = RallySegmentUploader.modalJobToken
    @State private var webBaseURL = RallySegmentUploader.webBaseURLString
    @State private var statusMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Endpoints & Upload Credentials") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Modal Rally API URL")
                            .font(.caption).foregroundStyle(.secondary)
                        TextField("https://thelastmattapalli--tennis-rally-web.modal.run", text: $modalBaseURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Modal Device Job Token (X-Job-Token)")
                            .font(.caption).foregroundStyle(.secondary)
                        SecureField("any.<exp>.<hmac_sha256>", text: $modalJobToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Web Dashboard Base URL")
                            .font(.caption).foregroundStyle(.secondary)
                        TextField("https://www.thelastmattapalli.com", text: $webBaseURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    }
                }

                Section("Live Upload Queue Status") {
                    HStack {
                        Text("Active Background Uploads")
                        Spacer()
                        Text("\(uploader.activeUploadsCount)").monospacedDigit().bold()
                    }
                    HStack {
                        Text("Failed / Paused Uploads")
                        Spacer()
                        Text("\(uploader.failedUploadsCount)").monospacedDigit()
                            .foregroundStyle(uploader.failedUploadsCount > 0 ? Color.red : Color.secondary)
                    }
                    HStack {
                        Text("Pending Local Sessions")
                        Spacer()
                        Text("\(store.pendingLocalSessionsCount)").monospacedDigit()
                    }

                    Button {
                        saveSettings()
                        store.retryAllPendingUploads()
                        statusMessage = RallySegmentUploader.hasValidCredentials
                            ? "Queued pending clips for background upload."
                            : "Enter a valid Modal Device Job Token above to upload clips."
                    } label: {
                        Label("Retry / Upload All Pending Clips", systemImage: "arrow.triangle.2.circlepath.icloud.fill")
                            .font(.subheadline.bold())
                    }

                    if let statusMessage = self.statusMessage {
                        Text(statusMessage)
                            .font(.caption)
                            .foregroundStyle(RallySegmentUploader.hasValidCredentials ? Color.green : Color.orange)
                    }
                }
            }
            .navigationTitle("Cloud & Upload Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveSettings()
                        Task { await store.refreshRemote() }
                        dismiss()
                    }
                    .bold()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func saveSettings() {
        RallySegmentUploader.modalBaseURLString = modalBaseURL
        RallySegmentUploader.modalJobToken = modalJobToken
        RallySegmentUploader.webBaseURLString = webBaseURL
    }
}
