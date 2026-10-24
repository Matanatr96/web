// TennisVisionApp.swift — app entry point (`HomeView` root dashboard + full-screen `RecordView`), the session
// controller that wires 1080p60 capture → offline SwingVision full-session recording (`session_<matchId>.mov`) →
// Modal GPU uploader (`source = "ios_library"`, `biomech = true`) → local/cloud `SessionStore` → Watch,
// optional 4-corner court calibration overlay, `PhotosPicker` Camera Roll uploader, and `SessionDetailSheet`.
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

/// Hands background-upload completion events to the uploader and locks the app to landscape orientations.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == RallySegmentUploader.sessionIdentifier else { return completionHandler() }
        RallySegmentUploader.shared.backgroundCompletionHandler = completionHandler
    }

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        .landscape
    }
}

/// Lightweight tactile feedback helper for on-court button taps.
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

/// Recorder state for the offline SwingVision session recorder.
enum RecorderState: String, Sendable {
    case idle
    case recording
}

/// Owns the 1080p60 camera preview, manual full-session recording (`session_<matchId>.mov`), uploader,
/// `SessionStore`, and WatchConnectivity plumbing. Does NOT run live on-device ball-tracking or audio onset detection.
final class SessionController: NSObject, ObservableObject {
    @Published var mode: SessionMode = .rally { didSet { pushWatch() } }
    @Published var doubles = false { didSet { pushWatch() } }
    @Published private(set) var recorderState: RecorderState = .idle
    @Published private(set) var isRecording = false
    @Published private(set) var recordingElapsedSeconds = 0
    @Published private(set) var bookmarkedTimestamps: [Double] = []
    @Published private(set) var calibration: CourtCalibration?
    @Published private(set) var score = MatchScorekeeper()
    @Published private(set) var clipsSaved = 0
    @Published private(set) var sessionClips: [RallyClipRecord] = []
    @Published private(set) var setupError: String?
    @Published var calibrationFrame: CalibrationFrame?

    let camera = CameraCaptureManager()
    private(set) var matchId = UUID()
    private var sessionStartedAt = Date()
    private var recordingStartDate: Date?
    private var recordingTimer: Timer?
    private var savedBrightness: CGFloat?
    private var pointsLog: [RallySegmentUploader.PointPayload] = []
    private var isEndingSession = false
    private var isStoppingRecording = false
    private var hasSavedCurrentRecording = false
    private var observersInstalled = false

    /// A frozen frame for the optional 4-corner + 2-post calibration overlay.
    struct CalibrationFrame: Identifiable {
        let id = UUID()
        let image: CGImage
        let buffer: CVPixelBuffer
    }

    /// Formats `recordingElapsedSeconds` as `MM:SS` (or `H:MM:SS` over an hour).
    var formattedRecordingTime: String {
        let total = max(0, recordingElapsedSeconds)
        let hrs = total / 3600
        let mins = (total % 3600) / 60
        let secs = total % 60
        if hrs > 0 {
            return String(format: "%d:%02d:%02d", hrs, mins, secs)
        }
        return String(format: "%02d:%02d", mins, secs)
    }

    // MARK: Lifecycle

    /// Resets per-session counters and mints a fresh `matchId` before presenting `RecordView`.
    @MainActor
    func prepareNewSession(mode: SessionMode, doubles: Bool) {
        matchId = UUID()
        sessionStartedAt = Date()
        recordingStartDate = nil
        recordingTimer?.invalidate()
        recordingTimer = nil
        recorderState = .idle
        isRecording = false
        recordingElapsedSeconds = 0
        bookmarkedTimestamps = []
        isEndingSession = false
        isStoppingRecording = false
        hasSavedCurrentRecording = false
        clipsSaved = 0
        sessionClips = []
        pointsLog = []
        score = MatchScorekeeper()
        setupError = nil
        self.mode = mode
        self.doubles = doubles
    }

    /// Requests camera access and starts the 1080p60 preview in `.idle` (ready) state without any live ball/audio detectors.
    @MainActor
    func start() async {
        isEndingSession = false
        recorderState = .idle
        isRecording = false
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            setupError = "Camera access is required to record tennis sessions."
            return
        }
        do {
            if camera.session.inputs.isEmpty {
                try camera.configure()
            }
        } catch {
            setupError = "Could not start camera preview: \(error)"
            return
        }
        objectWillChange.send()
        camera.onFrame = nil
        camera.start()
        pushWatch()
        UIApplication.shared.isIdleTimerDisabled = true
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
        if !observersInstalled {
            observersInstalled = true
            NotificationCenter.default.addObserver(self, selector: #selector(thermalChanged),
                                                   name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        }
    }

    /// Starts full-session 1080p60 HEVC recording to `Application Support/Rallies/session_<matchId>.mov`.
    @MainActor
    func startRecording() {
        guard !isRecording, !isStoppingRecording else { return }
        Haptics.impact(.medium)
        if hasSavedCurrentRecording {
            matchId = UUID()
            bookmarkedTimestamps = []
            hasSavedCurrentRecording = false
        }
        let now = Date()
        sessionStartedAt = now
        recordingStartDate = now
        recordingElapsedSeconds = 0
        recorderState = .recording
        isRecording = true
        camera.startRecordingSession(matchId: matchId)

        recordingTimer?.invalidate()
        recordingTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, self.isRecording, let start = self.recordingStartDate else { return }
            self.recordingElapsedSeconds = max(0, Int(Date().timeIntervalSince(start)))
            self.pushWatch()
        }
        pushWatch()
    }

    /// Stops the active session recording, saves the `LocalSessionRecord` in `SessionStore`, and queues the `.mov`
    /// file via `SessionStore.shared.importAndUploadLibraryVideo` with `source = "ios_library"` and `biomech = true`.
    @MainActor
    func finishAndUploadRecording() async {
        guard isRecording, !isStoppingRecording else { return }
        isStoppingRecording = true
        Haptics.notify(.success)
        recordingTimer?.invalidate()
        recordingTimer = nil
        let wallDuration = recordingStartDate.map { max(0, Date().timeIntervalSince($0)) } ?? Double(recordingElapsedSeconds)
        recordingStartDate = nil
        isRecording = false
        recorderState = .idle
        pushWatch()

        let (recordedURL, writerDurationS) = await withCheckedContinuation { (cont: CheckedContinuation<(URL?, Double), Never>) in
            camera.stopRecordingSession { url, durationS in
                cont.resume(returning: (url, durationS))
            }
        }
        isStoppingRecording = false

        let effectiveDuration = max(writerDurationS, wallDuration)
        let sessionURL = recordedURL ?? CameraCaptureManager.clipsDirectory.appendingPathComponent("session_\(matchId.uuidString.lowercased()).mov")
        let matchScore = mode == .match ? RallySegmentUploader.ScorePayload(score) : nil
        let matchPoints = mode == .match ? pointsLog : nil
        let formattedScore = mode == .match ? score.formattedScore : nil

        let savedRecord = SessionStore.shared.importAndUploadLibraryVideo(
            importedURL: sessionURL,
            durationS: effectiveDuration,
            mode: mode,
            doubles: doubles,
            calibration: calibration,
            imageSize: CGSize(width: Int(CameraCaptureManager.width), height: Int(CameraCaptureManager.height)),
            autoSegment: true,
            matchId: matchId,
            startedAt: sessionStartedAt,
            bookmarks: bookmarkedTimestamps,
            scoreFormatted: formattedScore,
            scorePayload: matchScore,
            pointsPayload: matchPoints
        )
        hasSavedCurrentRecording = true
        sessionClips = savedRecord.clipFiles
        clipsSaved = savedRecord.clipFiles.count
        pushWatch()
    }

    /// Toggles full-session recording (`Start Recording` <-> `Finish & Upload`).
    @MainActor
    func toggleRecording() {
        if isRecording {
            Task { await finishAndUploadRecording() }
        } else {
            startRecording()
        }
    }

    /// Ends the active court session: if recording, stops and uploads the session `.mov` first, then stops the camera.
    @MainActor
    func endSession() async {
        guard !isEndingSession else { return }
        isEndingSession = true
        if isRecording {
            await finishAndUploadRecording()
        }
        recordingTimer?.invalidate()
        recordingTimer = nil
        camera.stop()
        if let b = savedBrightness {
            UIScreen.main.brightness = b
            savedBrightness = nil
        }
        UIApplication.shared.isIdleTimerDisabled = false

        if !hasSavedCurrentRecording && (!sessionClips.isEmpty || !pointsLog.isEmpty) {
            let record = buildSessionRecord()
            SessionStore.shared.upsertLocalSession(record)
        }
    }

    @MainActor
    func buildSessionRecord() -> LocalSessionRecord {
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
            totalShots: 0,
            bestStreak: 0,
            ralliesCount: rallies,
            bookmarkedTimestamps: bookmarkedTimestamps.isEmpty ? nil : bookmarkedTimestamps,
            scoreFormatted: scoreStr,
            clipFiles: syncedClips,
            uploadStatus: status,
            court: calibration.map { RallySegmentUploader.CourtJSON($0) },
            source: "ios_library"
        )
    }

    // MARK: Calibration

    /// Freezes the current frame for the optional 4-corner + 2-post overlay.
    func beginCalibration() {
        guard let buffer = camera.latestPixelBuffer(), let image = CameraCaptureManager.image(from: buffer) else { return }
        calibrationFrame = CalibrationFrame(image: image, buffer: buffer)
    }

    /// Accepts a calibration from the overlay.
    func finishCalibration(_ cal: CourtCalibration) {
        calibrationFrame = nil
        calibration = cal
        Haptics.notify(.success)
    }

    // MARK: Watch & phone actions

    /// Records a bookmarked moment timestamp relative to the start of the active recording.
    func bookmark() {
        Haptics.impact(.medium)
        let elapsed = recordingStartDate.map { max(0, Date().timeIntervalSince($0)) } ?? Double(recordingElapsedSeconds)
        let rounded = (elapsed * 10).rounded() / 10
        bookmarkedTimestamps.append(rounded)
        pushWatch()
    }

    func point(_ winner: Player) {
        Haptics.impact(.medium)
        let before = score.formattedScore
        let srv = score.score.server.rawValue
        let side = score.serverSide.rawValue
        score.pointWon(by: winner)
        let after = score.formattedScore
        let elapsed = recordingStartDate.map { max(0, Date().timeIntervalSince($0)) } ?? Double(recordingElapsedSeconds)
        pointsLog.append(RallySegmentUploader.PointPayload(
            pointIdx: pointsLog.count, rallyIdx: nil, server: srv, serveSide: side,
            winner: winner.rawValue, endedBy: "winner", scoreBefore: before, scoreAfter: after,
            timestampS: elapsed))
        pushWatch()
    }

    func undoPoint() {
        Haptics.impact(.light)
        score.undo()
        if !pointsLog.isEmpty { pointsLog.removeLast() }
        pushWatch()
    }

    var setsLine: String {
        (score.score.sets + [score.score.games]).map { "\($0.me)-\($0.opp)" }.joined(separator: " ")
    }

    private func pushWatch() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        let state = WatchState(
            mode: mode,
            shotCount: recordingElapsedSeconds,
            inStreak: bookmarkedTimestamps.count,
            sessionBest: clipsSaved,
            setsLine: setsLine,
            pointsLine: score.display,
            serverSide: mode == .match ? score.serverSide : nil,
            isLive: isRecording
        )
        try? WCSession.default.updateApplicationContext(state.message)
        if WCSession.default.isReachable { WCSession.default.sendMessage(state.message, replyHandler: nil) }
    }

    // MARK: Environment

    /// Dim the screen to 0 at `.serious` / `.critical` thermal state to keep 1080p60 recording cool in direct sunlight.
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
        Task { @MainActor in
            switch command {
            case .bookmark:
                self.bookmark()
            case .pointMe:
                self.point(.me)
            case .pointOpp:
                self.point(.opp)
            case .undo:
                self.undoPoint()
            case .toggleRally:
                self.toggleRecording()
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
            CameraPreview(session: c.camera.session) { angle in
                c.camera.setLandscapeRotationAngle(angle)
            }
            .ignoresSafeArea()
            if showCourtLines, let cal = c.calibration {
                LiveCourtWireframeOverlay(calibration: cal, doubles: c.doubles)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
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
                longestRally: record.bestStreak,
                ralliesCount: record.ralliesCount,
                avgSpeedMph: nil,
                maxSpeedMph: nil,
                serveSpeedAvg: nil,
                serveSpeedMax: nil,
                fhSpeedAvg: nil,
                fhSpeedMax: nil,
                bhSpeedAvg: nil,
                bhSpeedMax: nil,
                netClearanceAvgM: nil,
                deepPct: nil,
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
            // Left Capsule Cluster: End Session + Rally/Match segmented pill + Doubles toggle
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

                Toggle("Doubles", isOn: $c.doubles)
                    .toggleStyle(.button)
                    .font(.caption.bold())
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())

            Spacer(minLength: 4)

            // Center Capsule Cluster: Recording Status Pill (`READY TO RECORD` vs `RECORDING · 00:42`) + Optional Court Calibration
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(c.isRecording ? Color.red : Color.gray)
                        .frame(width: 9, height: 9)
                        .scaleEffect(c.isRecording && pulseDot ? 1.28 : 0.92)
                    Text(c.isRecording ? "RECORDING · \(c.formattedRecordingTime)" : "READY TO RECORD")
                        .font(.caption.monospaced().bold())
                        .foregroundStyle(c.isRecording ? Color.red : Color.primary)
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

            // Right Capsule Cluster: Clips Saved / Upload badge + Start Recording / Finish & Upload button
            HStack(spacing: 8) {
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

                if c.isRecording {
                    Button {
                        Task { await c.finishAndUploadRecording() }
                    } label: {
                        Label("Finish & Upload", systemImage: "checkmark.circle.fill")
                            .font(.caption.bold())
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                } else {
                    Button {
                        c.startRecording()
                    } label: {
                        Label("Start Recording", systemImage: "record.circle")
                            .font(.caption.bold())
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    @ViewBuilder private var banners: some View {
        if let error = c.setupError { Banner(text: error, color: .red) }
        if c.calibration == nil {
            Banner(text: "Optional: Calibrate court corners now, or let cloud AI auto-calibrate & analyze speeds after recording",
                   color: .blue)
        }
    }

    @ViewBuilder private var hud: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch c.mode {
            case .rally:
                Text(c.isRecording ? c.formattedRecordingTime : "READY")
                    .font(.system(size: 56, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(c.isRecording ? Color.red : Color.primary)
                Text("Offline SwingVision AI · Serve & FH/BH Speed · Auto Rally Split")
                    .font(.subheadline.bold())
            case .match:
                Text(c.setsLine).font(.title2.monospacedDigit().bold())
                Text(c.score.display).font(.system(size: 48, weight: .heavy, design: .rounded))
                Text("Serve from \(c.score.serverSide.rawValue) side").font(.caption)
            }
            if !c.bookmarkedTimestamps.isEmpty {
                Text("★ \(c.bookmarkedTimestamps.count) bookmarked moment\(c.bookmarkedTimestamps.count == 1 ? "" : "s")")
                    .font(.caption.bold())
                    .foregroundStyle(.yellow)
            }
            HStack(spacing: 8) {
                Text("\(c.clipsSaved) session recording\(c.clipsSaved == 1 ? "" : "s") saved")
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
            if c.isRecording {
                Button {
                    Task { await c.finishAndUploadRecording() }
                } label: {
                    Label("Finish & Upload", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)

                Button {
                    c.bookmark()
                } label: {
                    Label("★ Bookmark Moment", systemImage: "star.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.yellow)
            } else {
                Button {
                    c.startRecording()
                } label: {
                    Label("Start Recording", systemImage: "record.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }

            if c.mode == .match {
                HStack {
                    Button("Me") { c.point(.me) }
                    Button("Opp") { c.point(.opp) }
                    Button { c.undoPoint() } label: { Image(systemName: "arrow.uturn.backward") }
                }
                .buttonStyle(.borderedProminent)
            }
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

            let lineColor: Color = .green
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

private struct Banner: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text).font(.callout.bold()).padding(8).frame(maxWidth: .infinity)
            .background(color.opacity(0.8), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// AVCaptureVideoPreviewLayer host locked to horizontal 16:9 landscape (`0°` for `.landscapeRight`, `180°` for `.landscapeLeft`).
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    var onLandscapeAngleChange: ((CGFloat) -> Void)? = nil

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        var onLandscapeAngleChange: ((CGFloat) -> Void)?
        private var observers: [NSObjectProtocol] = []

        override init(frame: CGRect) {
            super.init(frame: frame)
            installObservers()
        }

        required init?(coder: NSCoder) {
            super.init(coder: coder)
            installObservers()
        }

        deinit {
            for obs in observers {
                NotificationCenter.default.removeObserver(obs)
            }
        }

        private func installObservers() {
            let nc = NotificationCenter.default
            observers.append(nc.addObserver(forName: .AVCaptureSessionDidStartRunning, object: nil, queue: .main) { [weak self] _ in
                self?.syncLandscapeRotation()
            })
            observers.append(nc.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                self?.syncLandscapeRotation()
            })
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            syncLandscapeRotation()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            syncLandscapeRotation()
        }

        /// Forces `previewLayer.connection` out of its default `90°` (`.portrait`) into `0°` (`.landscapeRight`) or `180°` (`.landscapeLeft`).
        func syncLandscapeRotation() {
            let angle = Self.currentLandscapeRotationAngle(for: window)
            if let connection = previewLayer.connection, connection.isVideoRotationAngleSupported(angle) {
                if connection.videoRotationAngle != angle {
                    connection.videoRotationAngle = angle
                }
            }
            onLandscapeAngleChange?(angle)
        }

        private static func currentLandscapeRotationAngle(for window: UIWindow?) -> CGFloat {
            let sceneOrientation = window?.windowScene?.interfaceOrientation
                ?? UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .first?.interfaceOrientation
            if sceneOrientation == .landscapeLeft {
                return 180
            }
            if sceneOrientation == .landscapeRight {
                return 0
            }
            switch UIDevice.current.orientation {
            case .landscapeRight:
                return 180
            default:
                return 0
            }
        }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.onLandscapeAngleChange = onLandscapeAngleChange
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspect
        view.syncLandscapeRotation()
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.onLandscapeAngleChange = onLandscapeAngleChange
        if uiView.previewLayer.session !== session {
            uiView.previewLayer.session = session
        }
        uiView.syncLandscapeRotation()
    }
}

// MARK: - Models

/// Metadata for a single recorded or imported session video / rally clip stored in `Application Support/Rallies/`.
struct RallyClipRecord: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var rallyIdx: Int
    var fileName: String
    var startS: Double
    var durationS: Double
    var shotCount: Int
    var inStreak: Int
    var bookmarked: Bool
    var source: String = "ios_library"
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
    var bookmarkedTimestamps: [Double]? = nil
    var scoreFormatted: String?
    var clipFiles: [RallyClipRecord]
    var uploadStatus: ClipUploadState
    var court: RallySegmentUploader.CourtJSON?
    var source: String? = "ios_library"
}

/// JSON schema returned by `GET <webBaseURL>/api/tennis/sessions`.
struct RemoteSessionsResponse: Codable, Sendable {
    struct Summary: Codable, Sendable {
        var totalSessions: Int
        var totalRallies: Int
        var totalShots: Int
        var longestRally: Int
        var bestInStreak: Int
        var avgRallyLength: Double?
        var avgSpeedMph: Double?
        var maxSpeedMph: Double?
        var serveSpeedAvg: Double?
        var serveSpeedMax: Double?
        var fhSpeedAvg: Double?
        var fhSpeedMax: Double?
        var bhSpeedAvg: Double?
        var bhSpeedMax: Double?
        var netClearanceAvgM: Double?
        var deepPct: Double?

        init(
            totalSessions: Int = 0,
            totalRallies: Int = 0,
            totalShots: Int = 0,
            longestRally: Int = 0,
            bestInStreak: Int = 0,
            avgRallyLength: Double? = nil,
            avgSpeedMph: Double? = nil,
            maxSpeedMph: Double? = nil,
            serveSpeedAvg: Double? = nil,
            serveSpeedMax: Double? = nil,
            fhSpeedAvg: Double? = nil,
            fhSpeedMax: Double? = nil,
            bhSpeedAvg: Double? = nil,
            bhSpeedMax: Double? = nil,
            netClearanceAvgM: Double? = nil,
            deepPct: Double? = nil
        ) {
            self.totalSessions = totalSessions
            self.totalRallies = totalRallies
            self.totalShots = totalShots
            self.longestRally = longestRally
            self.bestInStreak = bestInStreak
            self.avgRallyLength = avgRallyLength
            self.avgSpeedMph = avgSpeedMph
            self.maxSpeedMph = maxSpeedMph
            self.serveSpeedAvg = serveSpeedAvg
            self.serveSpeedMax = serveSpeedMax
            self.fhSpeedAvg = fhSpeedAvg
            self.fhSpeedMax = fhSpeedMax
            self.bhSpeedAvg = bhSpeedAvg
            self.bhSpeedMax = bhSpeedMax
            self.netClearanceAvgM = netClearanceAvgM
            self.deepPct = deepPct
        }

        enum CodingKeys: String, CodingKey {
            case totalSessions
            case totalRallies
            case totalShots
            case longestRally
            case bestInStreak
            case avgRallyLength
            case avgSpeedMph
            case maxSpeedMph
            case serveSpeedAvg
            case serveSpeedMax
            case fhSpeedAvg
            case fhSpeedMax
            case bhSpeedAvg
            case bhSpeedMax
            case netClearanceAvgM
            case deepPct
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            totalSessions = try c.decodeIfPresent(Int.self, forKey: .totalSessions) ?? 0
            totalRallies = try c.decodeIfPresent(Int.self, forKey: .totalRallies) ?? 0
            totalShots = try c.decodeIfPresent(Int.self, forKey: .totalShots) ?? 0
            let best = try c.decodeIfPresent(Int.self, forKey: .bestInStreak) ?? 0
            let longest = try c.decodeIfPresent(Int.self, forKey: .longestRally) ?? best
            longestRally = max(longest, best)
            bestInStreak = max(best, longest)
            avgRallyLength = try c.decodeIfPresent(Double.self, forKey: .avgRallyLength)
            avgSpeedMph = try c.decodeIfPresent(Double.self, forKey: .avgSpeedMph)
            maxSpeedMph = try c.decodeIfPresent(Double.self, forKey: .maxSpeedMph)
            serveSpeedAvg = try c.decodeIfPresent(Double.self, forKey: .serveSpeedAvg)
            serveSpeedMax = try c.decodeIfPresent(Double.self, forKey: .serveSpeedMax)
            fhSpeedAvg = try c.decodeIfPresent(Double.self, forKey: .fhSpeedAvg)
            fhSpeedMax = try c.decodeIfPresent(Double.self, forKey: .fhSpeedMax)
            bhSpeedAvg = try c.decodeIfPresent(Double.self, forKey: .bhSpeedAvg)
            bhSpeedMax = try c.decodeIfPresent(Double.self, forKey: .bhSpeedMax)
            netClearanceAvgM = try c.decodeIfPresent(Double.self, forKey: .netClearanceAvgM)
            deepPct = try c.decodeIfPresent(Double.self, forKey: .deepPct)
        }
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
        var avgRallyLength: Double?
        var avgSpeedMph: Double?
        var maxSpeedMph: Double?
        var serveSpeedAvg: Double?
        var serveSpeedMax: Double?
        var fhSpeedAvg: Double?
        var fhSpeedMax: Double?
        var bhSpeedAvg: Double?
        var bhSpeedMax: Double?
        var netClearanceAvgM: Double?
        var deepPct: Double?
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
    let longestRally: Int
    let ralliesCount: Int
    let avgSpeedMph: Double?
    let maxSpeedMph: Double?
    let serveSpeedAvg: Double?
    let serveSpeedMax: Double?
    let fhSpeedAvg: Double?
    let fhSpeedMax: Double?
    let bhSpeedAvg: Double?
    let bhSpeedMax: Double?
    let netClearanceAvgM: Double?
    let deepPct: Double?
    let scoreFormatted: String?
    let uploadStatus: ClipUploadState
    let remoteStatus: String?
    let localRecord: LocalSessionRecord?
    let remoteRecord: RemoteSessionsResponse.RemoteSession?
}

/// Aggregate SwingVision speed & shot metrics displayed in the summary tiles at the top of `HomeView`.
struct AggregateSessionStats {
    var totalSessions: Int = 0
    var totalShots: Int = 0
    var longestRally: Int = 0
    var totalRallies: Int = 0
    var topSpeedMph: Double?
    var avgSpeedMph: Double?
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

    /// Queues or re-queues all clips of a local session for background upload to Modal (`biomech = true`).
    @discardableResult
    func uploadSession(
        _ session: LocalSessionRecord,
        forceAll: Bool = false,
        scorePayload: RallySegmentUploader.ScorePayload? = nil,
        pointsPayload: [RallySegmentUploader.PointPayload]? = nil
    ) -> Bool {
        let src = session.source ?? "ios_library"
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: session.id, sessionType: session.mode, doubles: session.doubles,
            court: session.court, source: src, biomech: true
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
                bookmarked: clip.bookmarked, score: scorePayload, points: pointsPayload
            )
            enqueuedAny = true
        }
        if src != "ios_library" {
            RallySegmentUploader.shared.finalizeSession(config: config, score: scorePayload, points: pointsPayload)
        }
        return enqueuedAny
    }

    /// Uploads a single clip from a local session.
    @discardableResult
    func uploadClip(_ clip: RallyClipRecord, in session: LocalSessionRecord) -> Bool {
        guard clip.fileExistsOnDisk else { return false }
        let src = clip.source.isEmpty ? (session.source ?? "ios_library") : clip.source
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: session.id, sessionType: session.mode, doubles: session.doubles,
            court: session.court, source: src, biomech: true
        ) else {
            updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .needsToken)
            return false
        }
        updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .uploading)
        RallySegmentUploader.shared.enqueue(
            clip: clip.fileURL, rallyIdx: clip.rallyIdx, startS: clip.startS, config: config,
            bookmarked: clip.bookmarked
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

    /// Imports a recorded session `.mov` or a video picked from the iPhone Camera Roll into `Application Support/Rallies/`,
    /// saves a `LocalSessionRecord`, and queues it for upload to Modal (`source = "ios_library"` and `biomech = true`
    /// so Modal's `segment_match` offline pipeline segments rallies and computes speeds, shots, depth zones, and biomechanics).
    func importAndUploadLibraryVideo(
        importedURL: URL,
        durationS: Double,
        mode: SessionMode,
        doubles: Bool,
        calibration: CourtCalibration?,
        imageSize: CGSize,
        autoSegment: Bool = true,
        matchId: UUID = UUID(),
        startedAt: Date? = nil,
        bookmarks: [Double] = [],
        scoreFormatted: String? = nil,
        scorePayload: RallySegmentUploader.ScorePayload? = nil,
        pointsPayload: [RallySegmentUploader.PointPayload]? = nil
    ) -> LocalSessionRecord {
        let ext = importedURL.pathExtension.isEmpty ? "mov" : importedURL.pathExtension.lowercased()
        let alreadyInClipsDir = importedURL.deletingLastPathComponent().standardizedFileURL == CameraCaptureManager.clipsDirectory.standardizedFileURL
        let fileName: String
        if alreadyInClipsDir {
            fileName = importedURL.lastPathComponent
        } else {
            fileName = "library_\(matchId.uuidString.lowercased())_0.\(ext)"
            let destURL = CameraCaptureManager.clipsDirectory.appendingPathComponent(fileName)
            try? FileManager.default.removeItem(at: destURL)
            if (try? FileManager.default.moveItem(at: importedURL, to: destURL)) == nil {
                try? FileManager.default.copyItem(at: importedURL, to: destURL)
            }
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
            bookmarked: !bookmarks.isEmpty,
            source: source,
            uploadStatus: initialStatus
        )
        let start = startedAt ?? Date()
        let session = LocalSessionRecord(
            id: matchId,
            startedAt: start,
            endedAt: start.addingTimeInterval(max(0, durationS)),
            mode: mode,
            doubles: doubles,
            totalShots: 0,
            bestStreak: 0,
            ralliesCount: 1,
            bookmarkedTimestamps: bookmarks.isEmpty ? nil : bookmarks,
            scoreFormatted: scoreFormatted,
            clipFiles: [clip],
            uploadStatus: initialStatus,
            court: courtJSON,
            source: source
        )
        upsertLocalSession(session)
        _ = uploadSession(session, forceAll: true, scorePayload: scorePayload, pointsPayload: pointsPayload)
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
            let longest = max(r.longestRally ?? 0, r.bestInStreak ?? 0)
            if longest > localSessions[idx].bestStreak {
                localSessions[idx].bestStreak = longest
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
            let longest = max(local.bestStreak, remote?.longestRally ?? 0, remote?.bestInStreak ?? 0)
            let rallies = max(local.ralliesCount, local.clipFiles.count, remote?.totalRallies ?? remote?.ralliesDone ?? 0)
            let score = local.scoreFormatted ?? remote?.scoreFormatted
            let status: ClipUploadState = (remote?.status == "ready" && (remote?.totalRallies ?? remote?.ralliesDone ?? 0) > 0 && local.uploadStatus != .uploading && local.uploadStatus != .failed) ? .uploaded : local.uploadStatus
            let isCameraRoll = local.clipFiles.first?.fileName.hasPrefix("library_") == true
            let srcLabel = isCameraRoll ? "CAMERA ROLL" : "ON-DEVICE"
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
                longestRally: longest,
                ralliesCount: rallies,
                avgSpeedMph: remote?.avgSpeedMph,
                maxSpeedMph: remote?.maxSpeedMph,
                serveSpeedAvg: remote?.serveSpeedAvg,
                serveSpeedMax: remote?.serveSpeedMax,
                fhSpeedAvg: remote?.fhSpeedAvg,
                fhSpeedMax: remote?.fhSpeedMax,
                bhSpeedAvg: remote?.bhSpeedAvg,
                bhSpeedMax: remote?.bhSpeedMax,
                netClearanceAvgM: remote?.netClearanceAvgM,
                deepPct: remote?.deepPct,
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
            let longest = max(remote.longestRally ?? 0, remote.bestInStreak ?? 0)
            items.append(MergedSessionItem(
                id: id,
                title: remote.title ?? defaultTitle,
                date: parsedDate,
                dateLabel: dateStr,
                mode: mode,
                doubles: remote.doubles ?? false,
                sourceLabel: (remote.source ?? "web").uppercased(),
                totalShots: remote.totalShots ?? 0,
                longestRally: longest,
                ralliesCount: remote.totalRallies ?? remote.ralliesDone ?? 0,
                avgSpeedMph: remote.avgSpeedMph,
                maxSpeedMph: remote.maxSpeedMph,
                serveSpeedAvg: remote.serveSpeedAvg,
                serveSpeedMax: remote.serveSpeedMax,
                fhSpeedAvg: remote.fhSpeedAvg,
                fhSpeedMax: remote.fhSpeedMax,
                bhSpeedAvg: remote.bhSpeedAvg,
                bhSpeedMax: remote.bhSpeedMax,
                netClearanceAvgM: remote.netClearanceAvgM,
                deepPct: remote.deepPct,
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
        let longestRally = max(
            merged.map(\.longestRally).max() ?? 0,
            remoteSummary?.longestRally ?? 0,
            remoteSummary?.bestInStreak ?? 0
        )
        let totalRallies = merged.reduce(0) { $0 + $1.ralliesCount }
        let maxSpeeds = merged.compactMap(\.maxSpeedMph).filter { $0 > 0 }
        let topSpeed = max(maxSpeeds.max() ?? 0, remoteSummary?.maxSpeedMph ?? 0)
        let avgSpeeds = merged.compactMap(\.avgSpeedMph).filter { $0 > 0 }
        let avgSpeed: Double? = {
            if let s = remoteSummary?.avgSpeedMph, s > 0 { return s }
            guard !avgSpeeds.isEmpty else { return nil }
            return (avgSpeeds.reduce(0, +) / Double(avgSpeeds.count) * 10).rounded() / 10
        }()
        return AggregateSessionStats(
            totalSessions: totalSessions,
            totalShots: totalShots,
            longestRally: longestRally,
            totalRallies: totalRallies,
            topSpeedMph: topSpeed > 0 ? topSpeed : nil,
            avgSpeedMph: avgSpeed
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
                Text("Offline Court Recorder · Ball Speed & Shot Analytics · Cloud Studio")
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
                if let avgSpeed = stats.avgSpeedMph, avgSpeed > 0 {
                    Text(String(format: "Avg Ball Speed: %.0f mph", avgSpeed))
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
                StatTile(title: "Longest Rally", value: "\(stats.longestRally)", icon: "flame.fill", tint: .orange)
                if let topSpeed = stats.topSpeedMph, topSpeed > 0 {
                    StatTile(title: "Top Speed", value: String(format: "%.0f mph", topSpeed), icon: "speedometer", tint: .green)
                } else {
                    StatTile(title: "Rallies", value: "\(stats.totalRallies)", icon: "film.stack", tint: .green)
                }
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
                    Text("Tap \"Start Court Session\" to record a 1080p60 court video, or tap \"Upload Video / Rally from Photos\" to analyze ball speed, rallies, and biomechanics in the cloud.")
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
                    Label("Longest rally \(item.longestRally)", systemImage: "flame.fill")
                    Label("\(item.ralliesCount) rallies", systemImage: "film.stack")
                    if let topSpeed = item.maxSpeedMph ?? item.avgSpeedMph, topSpeed > 0 {
                        Text(String(format: "%.0f mph max", topSpeed))
                            .foregroundStyle(.green)
                    }
                    if let deep = item.deepPct {
                        Text(String(format: "%.0f%% deep", deep))
                            .foregroundStyle(.cyan)
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

// MARK: - SessionDetailSheet (Replay, Save Clip to Photos, ShareLink, Ball Speed & Shot Breakdown, Re-upload)

private struct SpeedMetricRow: View {
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.monospacedDigit().bold())
                .foregroundStyle(value == "Pending" ? Color.secondary : tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}

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

    private func formatSpeedPair(avg: Double?, max: Double?) -> String {
        switch (avg, max) {
        case let (a?, m?) where a > 0 && m > 0:
            return String(format: "%.0f / %.0f mph", a, m)
        case let (a?, _) where a > 0:
            return String(format: "%.0f mph avg", a)
        case let (_, m?) where m > 0:
            return String(format: "%.0f mph max", m)
        default:
            return "Pending"
        }
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
                Section("Ball Speed & Shot Breakdown") {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            if let maxSpd = item.maxSpeedMph ?? item.avgSpeedMph, maxSpd > 0 {
                                Label(String(format: "Top Speed: %.0f mph", maxSpd), systemImage: "speedometer")
                                    .font(.headline.monospacedDigit().bold())
                                    .foregroundStyle(.green)
                            } else {
                                Label("Cloud AI Speed & Shot Breakdown", systemImage: "speedometer")
                                    .font(.headline.bold())
                                    .foregroundStyle(.cyan)
                            }
                            Spacer()
                            if let avgSpd = item.avgSpeedMph, avgSpd > 0 {
                                Text(String(format: "Avg %.0f mph", avgSpd))
                                    .font(.caption.monospacedDigit().bold())
                                    .foregroundStyle(.secondary)
                            }
                        }

                        LazyVGrid(columns: [
                            GridItem(.flexible(), spacing: 10),
                            GridItem(.flexible(), spacing: 10),
                        ], spacing: 10) {
                            SpeedMetricRow(
                                label: "Forehand (Avg / Max)",
                                value: formatSpeedPair(avg: item.fhSpeedAvg, max: item.fhSpeedMax),
                                tint: .green
                            )
                            SpeedMetricRow(
                                label: "Backhand (Avg / Max)",
                                value: formatSpeedPair(avg: item.bhSpeedAvg, max: item.bhSpeedMax),
                                tint: .cyan
                            )
                            SpeedMetricRow(
                                label: "Serve (Avg / Max)",
                                value: formatSpeedPair(avg: item.serveSpeedAvg, max: item.serveSpeedMax),
                                tint: .yellow
                            )
                            SpeedMetricRow(
                                label: "Deep Zone %",
                                value: item.deepPct.map { String(format: "%.0f%%", $0) } ?? "Pending",
                                tint: .orange
                            )
                        }

                        HStack(spacing: 16) {
                            Label("\(item.totalShots) Total Shots", systemImage: "bolt.fill")
                            Label("Longest Rally: \(item.longestRally) shots", systemImage: "flame.fill")
                            Label("\(item.ralliesCount) Rallies", systemImage: "film.stack")
                        }
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)

                    if let local = currentLocal, !local.clipFiles.isEmpty {
                        let bookmarkedCount = local.clipFiles.filter(\.bookmarked).count
                        Toggle(isOn: $bookmarkedOnly) {
                            Label("Bookmarked Clips Only (\(bookmarkedCount))", systemImage: "star.fill")
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
                                        Text(clip.source == "ios_library" ? "Full Session Video" : "Rally #\(clip.rallyIdx + 1)")
                                            .font(.subheadline.bold())
                                        if clip.bookmarked {
                                            Label("Bookmarked", systemImage: "star.fill")
                                                .font(.caption2.bold())
                                                .foregroundStyle(.yellow)
                                        }
                                        Spacer()
                                        Text(clip.durationS > 0
                                             ? String(format: "%.0fs · %@", clip.durationS, clip.uploadStatus.label)
                                             : "\(clip.shotCount) shots · \(clip.uploadStatus.label)")
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
