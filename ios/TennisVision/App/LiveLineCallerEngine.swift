// LiveLineCallerEngine.swift — on-device live rally & line caller.
//
// State machine: sleeping → armed → live → cooldown → sleeping.
//   sleeping  ANE idle; only the 2–6 kHz racket-hit onset detector (AVAudioEngine) runs.
//   armed     an onset opened the rally clip (with 1.5 s pre-roll) and started WASB; ≥6 moving detections within
//             1 s go live, otherwise after 2 s the clip is discarded (a false wake-up costs no storage).
//   live      WASB-SBDT `wasb_fp16.mlpackage` at step=3: each pass reads 3 consecutive frames (frame_t0..2) and
//             all 3 heatmap heads, one per frame (20 passes/s at 60 fps). Detections get a 64×64 native-1080p ROI
//             centroid refinement, then candidate events (v extrema) are split into hits vs bounces by
//             `BallKinematics.classifyEvent` (image cusp or coincident racket onset, far-half position prior,
//             near-half court-Y velocity sign) and bounces are judged sub-frame on Hr (`contactPoint` + `LineCaller`).
//             Rally Mode keeps the rally live through `out` bounces while hits keep coming within 3.5 s (E1);
//             Match Mode ends the point clip on an `out`.
//   cooldown  the 2.0 s clip tail is being written; onsets are ignored.
// Thermal ladder (E10): .fair → ROI refinement only around v reversals; .serious → 30 fps triplets (10 passes/s);
// .critical → ANE paused, rallies segmented from audio onsets only (clips still saved for Modal).
import AVFoundation
import CoreML
import CourtGeometry
import Foundation
import VideoToolbox

/// Live-engine state.
enum EngineState: String {
    case sleeping
    case armed
    case live
    case cooldown
}

/// Spoken / chimed feedback options (the RecordView picker).
enum AudioCallMode: String, CaseIterable, Identifiable {
    case softChime = "Soft Chime on Out"
    case loudOut = "Loud \"OUT!\""
    case milestones = "Line Calls + Milestone Beeps"
    case mute = "Mute"

    var id: String { rawValue }
}

/// Engine → UI callbacks, always delivered on the main queue.
protocol LiveLineCallerEngineDelegate: AnyObject {
    func engine(_ engine: LiveLineCallerEngine, didChange state: EngineState)
    /// Open the rally clip (pre-roll is applied by the capture manager).
    func engine(_ engine: LiveLineCallerEngine, rallyStartedAt pts: CMTime)
    /// Close the clip at `lastActivity + tail`; a nil summary means "discard" (false wake-up).
    func engine(_ engine: LiveLineCallerEngine, rallyEnded summary: RallySummary?, lastActivity: CMTime)
    func engine(_ engine: LiveLineCallerEngine, didUpdateShots shotCount: Int, inStreak: Int, sessionBest: Int)
    func engine(_ engine: LiveLineCallerEngine, didCall result: LineCallResult, latencyMs: Double)
    /// Live ball detection (1920×1080 image pixel coordinates) and recent trajectory trail (~15 samples).
    func engine(_ engine: LiveLineCallerEngine, didUpdateBall current: BallSample?, trail: [BallSample])
}

extension LiveLineCallerEngineDelegate {
    func engine(_ engine: LiveLineCallerEngine, didUpdateBall current: BallSample?, trail: [BallSample]) {}
}

final class LiveLineCallerEngine: @unchecked Sendable {
    static let armedTimeout = 2.0
    static let goLiveDetections = 4
    static let goLiveDisplacementPx = 30.0
    static let maxGateJumpPx = 225.0          // 60 px at the 512×288 model scale (E12)
    static let stationaryFrames = 10          // a blob still for ≥10 frames is a spare ball (E12)
    static let postSamplesTimeout = 0.12      // decide with 3 post samples if the 4th hasn't come in 120 ms
    static let trackWindow = 3.0
    static let minHitGap = 0.30
    private static let queueKey = DispatchSpecificKey<Bool>()

    weak var delegate: LiveLineCallerEngineDelegate?

    private let queue = DispatchQueue(label: "tennis.engine", qos: .userInteractive)
    private let mlQueue = DispatchQueue(label: "tennis.wasb", qos: .userInteractive)
    private let audioEngine = AVAudioEngine()
    private let onsets = HitOnsetDetector()
    private let announcer: CallAnnouncer
    private let detector = WASBDetector()

    // queue-only state
    private var mode: SessionMode = .rally
    private var audioMode: AudioCallMode = .softChime
    private var calibration: CourtCalibration?
    private var callsPaused = false
    private var doubles = false
    private var serveRegion: CallRegion?
    private var state: EngineState = .sleeping
    private var tracker = RallyTracker()
    private var track: [BallSample] = []
    private var recentOnsets: [Double] = []
    private var lastEventT = -Double.infinity
    private var lastCheckedT = -Double.infinity
    private var lastHitterHalf: CourtHalf?
    private var bouncesThisRally = 0
    private var armedAt = 0.0
    private var cooldownUntil = 0.0
    private var lastFramePTS = 0.0
    private var pending: [(CVPixelBuffer, Double)] = []
    private var frameIndex = 0
    private var tripletIndex = 0
    private var inferenceBusy = false
    private var stationary: (p: Point2, count: Int)?
    private var interruptionObserver: NSObjectProtocol?

    init() {
        queue.setSpecific(key: Self.queueKey, value: true)
        announcer = CallAnnouncer(engine: audioEngine)
        announcer.onPlayDuration = { [weak self] duration in
            let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
            self?.onsets.suppress(until: now + duration + 0.15)
        }
        onsets.onOnset = { [weak self] t in self?.queue.async { self?.handleOnset(at: t) } }
    }

    // MARK: Configuration (thread-safe setters)

    private func resetSessionState() {
        state = .sleeping
        tracker = RallyTracker()
        track.removeAll()
        recentOnsets.removeAll()
        lastEventT = -Double.infinity
        lastCheckedT = -Double.infinity
        lastHitterHalf = nil
        bouncesThisRally = 0
        armedAt = 0.0
        cooldownUntil = 0.0
        lastFramePTS = 0.0
        pending.removeAll()
        frameIndex = 0
        tripletIndex = 0
        stationary = nil
    }

    /// Starts the audio engine (onset detection + preloaded call buffers).
    func start() throws {
        queue.async { self.resetSessionState() }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement,
                                options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
        try session.setPreferredIOBufferDuration(0.005)
        try session.setActive(true)
        onsets.install(on: audioEngine)
        try audioEngine.start()
        if let obs = interruptionObserver {
            NotificationCenter.default.removeObserver(obs)
        }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            if !self.audioEngine.isRunning {
                try? self.audioEngine.start()
            }
        }
        Task { await announcer.prerenderSpeech() }
    }

    func stop() {
        if let obs = interruptionObserver {
            NotificationCenter.default.removeObserver(obs)
            interruptionObserver = nil
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        queue.async { self.resetSessionState() }
    }

    func configure(mode: SessionMode, audioMode: AudioCallMode, doubles: Bool) {
        queue.async {
            self.mode = mode
            self.audioMode = audioMode
            self.doubles = doubles
        }
    }

    func setCalibration(_ calibration: CourtCalibration?) { queue.async { self.calibration = calibration } }

    /// Drift tracker: >15 px pauses audible calls until recalibrated (E7).
    func setCallsPaused(_ paused: Bool) { queue.async { self.callsPaused = paused } }

    /// Match Mode: the service box the next serve must land in (first bounce of the point).
    func setServeRegion(_ region: CallRegion?) { queue.async { self.serveRegion = region } }

    /// Watch / phone star.
    func bookmark() { queue.async { self.tracker.bookmark() } }

    /// Manually starts a live rally immediately (from RecordView's manual start action).
    func forceStartRally() {
        queue.async {
            let now = self.lastFramePTS > 0 ? self.lastFramePTS : CMClockGetTime(CMClockGetHostTimeClock()).seconds
            switch self.state {
            case .sleeping, .cooldown:
                self.arm(at: now)
                self.goLive()
            case .armed:
                self.goLive()
            case .live:
                if self.tracker.shotCount == 0 { self.registerHit(at: now) }
            }
        }
    }

    /// Immediately ends and flushes any active `.live` or `.armed` rally (e.g. when tapping "End Session").
    func endCurrentRally() {
        let work: () -> (didEnd: Bool, summary: RallySummary?, lastActivity: CMTime) = {
            let now = self.lastFramePTS > 0 ? self.lastFramePTS : CMClockGetTime(CMClockGetHostTimeClock()).seconds
            switch self.state {
            case .live:
                let summary = self.tracker.endRally()
                self.state = .sleeping
                self.pending.removeAll()
                self.track.removeAll()
                self.lastHitterHalf = nil
                let last = CMTime(seconds: summary?.endS ?? now, preferredTimescale: 600)
                return (true, summary, last)
            case .armed:
                self.state = .sleeping
                self.pending.removeAll()
                self.track.removeAll()
                self.lastHitterHalf = nil
                return (true, nil, .zero)
            case .sleeping, .cooldown:
                return (false, nil, .zero)
            }
        }
        let outcome = DispatchQueue.getSpecific(key: Self.queueKey) == true ? work() : queue.sync(execute: work)
        guard outcome.didEnd else { return }
        let notify = {
            self.delegate?.engine(self, didUpdateBall: nil, trail: [])
            self.delegate?.engine(self, didChange: .sleeping)
            self.delegate?.engine(self, rallyEnded: outcome.summary, lastActivity: outcome.lastActivity)
        }
        if Thread.isMainThread {
            notify()
        } else {
            DispatchQueue.main.async(execute: notify)
        }
    }

    // MARK: Frames

    /// Feeds a captured 1080p frame (called on the capture queue).
    func ingest(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        queue.async { [self] in
            let t = pts.seconds
            lastFramePTS = t
            let thermal = ProcessInfo.processInfo.thermalState
            if state == .cooldown || state == .armed || thermal == .critical || detector == nil {
                advanceClock(to: t)
            } else if state == .live, let last = tracker.lastActivity,
                      t - last > RallyTracker.maxRallyGap + Self.postSamplesTimeout + 0.15 {
                // Only expire an idle rally before triplet inference once the post-sample buffer window has also elapsed.
                advanceClock(to: t)
            }
            guard state != .cooldown, thermal != .critical, let detector = self.detector else { return }
            frameIndex += 1
            if thermal == .serious && frameIndex % 2 == 1 { return }       // 30 fps triplets
            pending.append((pixelBuffer, t))
            guard pending.count == 3 else { return }
            let triplet = pending
            pending.removeAll()
            tripletIndex += 1
            if state == .sleeping {
                let hasRecentCandidate = track.last.map { t - $0.t <= 0.35 } ?? false
                if !hasRecentCandidate {
                    let probeStride = thermal == .nominal ? 2 : 3
                    if tripletIndex % probeStride != 0 { return }
                }
            }
            guard !inferenceBusy else { return }                            // never queue up stale triplets
            inferenceBusy = true
            let recentV = track.suffix(3).map(\.v)
            let hint: Point2? = track.last.flatMap { t - $0.t <= 0.15 ? Point2($0.u, $0.v) : nil }
            mlQueue.async { [self] in
                var samples = detector.detect(triplet, hint: hint)
                let refineAll = thermal == .nominal || thermal == .fair
                if refineAll || Self.hasReversal(recentV + samples.compactMap { $0?.v }) {
                    for k in samples.indices {
                        guard let s = samples[k] else { continue }
                        let p = WASBDetector.refine(triplet[k].0, around: Point2(s.u, s.v))
                        samples[k] = BallSample(t: s.t, u: p.x, v: p.y)
                    }
                }
                queue.async { [self] in
                    inferenceBusy = false
                    handle(samples.compactMap { $0 }, upTo: triplet.last?.1 ?? t,
                           sigmaPx: thermal == .serious ? 3.0 : BallKinematics.defaultSigmaPx)
                }
            }
        }
    }

    private static func hasReversal(_ v: [Double]) -> Bool {
        guard v.count >= 3 else { return false }
        return (1..<(v.count - 1)).contains { (v[$0] - v[$0 - 1]) * (v[$0 + 1] - v[$0]) < 0 }
    }

    // MARK: State machine

    private func set(_ new: EngineState) {
        guard new != state else { return }
        state = new
        DispatchQueue.main.async { self.delegate?.engine(self, didChange: new) }
    }

    private func arm(at t: Double) {
        armedAt = t
        track.removeAll { t - $0.t > 0.5 }
        bouncesThisRally = 0
        lastHitterHalf = nil
        lastEventT = -Double.infinity
        lastCheckedT = -Double.infinity
        set(.armed)
        DispatchQueue.main.async { self.delegate?.engine(self, rallyStartedAt: CMTime(seconds: t, preferredTimescale: 600)) }
    }

    private func handleOnset(at t: Double) {
        recentOnsets.append(t)
        recentOnsets.removeAll { t - $0 > Self.trackWindow }
        let audioOnly = ProcessInfo.processInfo.thermalState == .critical || detector == nil
        switch state {
        case .sleeping:
            arm(at: t)
            let recent = track.filter { $0.t - armedAt >= -0.5 }
            if audioOnly {
                goLive()
            } else if recent.count >= Self.goLiveDetections, let a = recent.first, let b = recent.last,
                      hypot(b.u - a.u, b.v - a.v) > Self.goLiveDisplacementPx {
                goLive()
            }
        case .live:
            // When audio-only or when the player strikes the ball outside/at the edge of the camera frame (<2 recent samples),
            // register the hit directly from the onset (debounced against vision hits).
            if audioOnly || track.filter({ t - $0.t <= 0.15 }).count < 2 {
                lastEventT = max(lastEventT, t)
                bouncesThisRally = 0
                registerHit(at: t)
            }
        case .armed, .cooldown:
            break
        }
    }

    private func goLive() {
        set(.live)
        if mode == .match, let region = serveRegion {
            // The service box is on the receiver's half, so the server stands on the opposite half.
            switch region {
            case .serveDeuceFar, .serveAdFar: lastHitterHalf = .near
            case .serveDeuceNear, .serveAdNear: lastHitterHalf = .far
            case .singles, .doubles: break
            }
        } else if let cal = calibration, let first = track.first, track.count >= 2 {
            lastHitterHalf = BallKinematics.inferHitterHalf(at: Point2(first.u, first.v),
                                                            post: Array(track.dropFirst()), calibration: cal)
        }
        let firstT = track.first?.t ?? armedAt
        lastEventT = firstT
        lastCheckedT = firstT
        bouncesThisRally = 0
        registerHit(at: firstT)                                           // the feed / first hit that woke us
    }

    private func advanceClock(to t: Double) {
        switch state {
        case .armed where t - armedAt > Self.armedTimeout:
            set(.sleeping)
            pending.removeAll()
            track.removeAll()
            DispatchQueue.main.async {
                self.delegate?.engine(self, didUpdateBall: nil, trail: [])
                self.delegate?.engine(self, rallyEnded: nil, lastActivity: .zero)
            }
        case .live:
            if let summary = tracker.tick(now: t) { finishRally(summary, now: t) }
        case .cooldown where t >= cooldownUntil:
            set(.sleeping)
        default:
            break
        }
    }

    private func finishRally(_ summary: RallySummary, now: Double? = nil) {
        set(.cooldown)
        pending.removeAll()
        track.removeAll()
        lastHitterHalf = nil
        let ref = max(now ?? lastFramePTS, summary.endS)
        cooldownUntil = ref + CameraCaptureManager.tailSeconds + 0.1
        let last = CMTime(seconds: summary.endS, preferredTimescale: 600)
        DispatchQueue.main.async {
            self.delegate?.engine(self, didUpdateBall: nil, trail: [])
            self.delegate?.engine(self, rallyEnded: summary, lastActivity: last)
        }
    }

    private func registerHit(at t: Double) {
        if tracker.isLive, let lastHit = tracker.shots.last?.tHit, abs(t - lastHit) < Self.minHitGap { return }
        let outcome = tracker.registerHit(at: t)
        if let ended = outcome.endedRally {
            let last = CMTime(seconds: ended.endS, preferredTimescale: 600)
            let nextStart = CMTime(seconds: t, preferredTimescale: 600)
            DispatchQueue.main.async {
                self.delegate?.engine(self, rallyEnded: ended, lastActivity: last)
                self.delegate?.engine(self, rallyStartedAt: nextStart)
            }
        }
        if outcome.milestone != nil, audioMode == .milestones, !callsPaused { announcer.play(.milestone) }
        publishShots()
    }

    private func publishShots() {
        let (n, streak, best) = (tracker.shotCount, tracker.inStreak, tracker.sessionBestStreak)
        DispatchQueue.main.async { self.delegate?.engine(self, didUpdateShots: n, inStreak: streak, sessionBest: best) }
    }

    private func publishBall(upTo currentT: Double) {
        let current = track.last.flatMap { currentT - $0.t <= 0.20 ? $0 : nil }
        let trail = Array(track.filter { currentT - $0.t <= 0.80 }.suffix(15))
        DispatchQueue.main.async { self.delegate?.engine(self, didUpdateBall: current, trail: trail) }
    }

    // MARK: Detections → events

    private func handle(_ samples: [BallSample], upTo currentT: Double, sigmaPx: Double) {
        for s in samples where accept(s) { track.append(s) }
        track.removeAll { currentT - $0.t > Self.trackWindow }
        publishBall(upTo: currentT)
        switch state {
        case .sleeping:
            let recent = track.filter { currentT - $0.t <= 1.0 }
            if let a = recent.first, let b = recent.last {
                let disp = hypot(b.u - a.u, b.v - a.v)
                if recent.count >= Self.goLiveDetections && disp > Self.goLiveDisplacementPx {
                    arm(at: a.t)
                    goLive()
                } else if recent.count >= 2 && disp > 15.0 {
                    arm(at: a.t)
                }
            }
        case .armed:
            let recent = track.filter { $0.t - armedAt >= -0.5 }
            if recent.count >= Self.goLiveDetections, let a = recent.first, let b = recent.last,
               hypot(b.u - a.u, b.v - a.v) > Self.goLiveDisplacementPx { goLive() }
            advanceClock(to: currentT)
        case .live:
            processEvents(sigmaPx: sigmaPx)
            if state == .live { advanceClock(to: currentT) }
        default:
            break
        }
    }

    /// Constant-velocity gate (>60 px at 512×288 from the prediction is another ball) + stationary-blob filter.
    private func accept(_ s: BallSample) -> Bool {
        let p = Point2(s.u, s.v)
        if let st = stationary, hypot(st.p.x - p.x, st.p.y - p.y) < 4 {
            stationary = (st.p, st.count + 1)
            if st.count + 1 >= Self.stationaryFrames { return false }
        } else {
            stationary = (p, 1)
        }
        guard let last = track.last, s.t - last.t < 0.25 else { return true }
        let dtGap = max(0, s.t - last.t)
        let dynamicGate = Self.maxGateJumpPx * max(1.0, dtGap / 0.05)
        var predicted = Point2(last.u, last.v)
        if track.count >= 2 {
            let prev = track[track.count - 2]
            let dt = last.t - prev.t
            if dt > 0, dt < 0.12 {
                predicted.x += (last.u - prev.u) / dt * dtGap
                predicted.y += (last.v - prev.v) / dt * dtGap
            }
        }
        let distPred = hypot(predicted.x - p.x, predicted.y - p.y)
        let distLast = hypot(last.u - p.x, last.v - p.y)
        return min(distPred, distLast) <= dynamicGate
    }

    /// Finds candidate events (v extrema or 2D velocity kinks) with enough post samples, classifies hit vs bounce,
    /// enforces `BallKinematics.minEventGap` debounce, and judges bounces (or counts uncalibrated shots when `calibration == nil`).
    private func processEvents(sigmaPx: Double) {
        guard track.count >= 3, let newestT = track.last?.t else { return }
        for i in 1..<(track.count - 1) where track[i].t > max(lastCheckedT, lastEventT) {
            guard track[i].t - lastEventT >= BallKinematics.minEventGap else { continue }
            guard BallKinematics.isEventCandidate(in: track, at: i) else { continue }
            let eventT = track[i].t
            let pre = track[...i].filter { eventT - $0.t <= 0.35 }
            let after = track[(i + 1)...].filter { $0.t - eventT <= 0.35 }
            let post = after.count
            if newestT - eventT <= Self.postSamplesTimeout && post < BallKinematics.fitSamples {
                return
            }
            guard pre.count >= 2, post >= 2 else {
                lastCheckedT = eventT
                continue
            }
            let heard = recentOnsets.contains { (-0.08...0.28).contains($0 - eventT) }
            if let cal = calibration {
                guard post >= BallKinematics.minSamples || heard else {
                    lastCheckedT = eventT
                    continue
                }
                switch BallKinematics.classifyEvent(pre: pre, post: after, h0: cal.h0, racketSound: heard) {
                case .hit:
                    lastEventT = eventT
                    lastCheckedT = eventT
                    bouncesThisRally = 0
                    lastHitterHalf = BallKinematics.inferHitterHalf(at: Point2(track[i].u, track[i].v), post: after, calibration: cal)
                    registerHit(at: eventT)
                case .bounce:
                    lastEventT = eventT
                    lastCheckedT = eventT
                    judgeBounce(at: i, cal: cal, sigmaPx: sigmaPx)
                    if state != .live { return }                               // match point ended: track was cleared
                case .unknown:
                    lastCheckedT = eventT
                    continue
                }
            } else {
                switch BallKinematics.classifyImageEvent(pre: pre, post: after, racketSound: heard, bouncesSinceHit: bouncesThisRally) {
                case .hit:
                    lastEventT = eventT
                    lastCheckedT = eventT
                    bouncesThisRally = 0
                    registerHit(at: eventT)
                case .bounce:
                    lastEventT = eventT
                    lastCheckedT = eventT
                    bouncesThisRally += 1
                    tracker.registerBounce(call: .unknown, depthZone: .unknown, at: eventT)
                    publishShots()
                case .unknown:
                    lastCheckedT = eventT
                    continue
                }
            }
        }
    }

    private func judgeBounce(at i: Int, cal: CourtCalibration, sigmaPx: Double) {
        let lo = max(0, i - BallKinematics.fitSamples - 1), hi = min(track.count - 1, i + BallKinematics.fitSamples + 1)
        let window = Array(track[lo...hi])
        let estimate = BallKinematics.contactPoint(around: i - lo, in: window, hr: cal.hr, sigmaPx: sigmaPx)
        let isServe = mode == .match && tracker.shotCount <= 1 && bouncesThisRally == 0
        let region = isServe ? (serveRegion ?? .singles) : (doubles ? .doubles : .singles)
        var hitter = lastHitterHalf
        if hitter == nil, let first = track.first, i > 0 {
            hitter = BallKinematics.inferHitterHalf(at: Point2(first.u, first.v), post: Array(track[0...i]), calibration: cal)
        }
        let result = LineCaller.judge(estimate, region: region, hitter: hitter)
        bouncesThisRally += 1
        let t = estimate?.tStar ?? track[i].t
        tracker.registerBounce(call: result.call, depthZone: result.depthZone, at: t)
        let latencyMs = (CMClockGetTime(CMClockGetHostTimeClock()).seconds - t) * 1000
        if !callsPaused { announce(result.call) }
        DispatchQueue.main.async { self.delegate?.engine(self, didCall: result, latencyMs: latencyMs) }
        publishShots()
        if mode == .match && (result.call == .out || result.depthZone == .net), let summary = tracker.endRally() {
            finishRally(summary, now: track.last?.t ?? t)                  // point over: clip ends at bounce + tail
        }
    }

    private func announce(_ call: LineCall) {
        switch (audioMode, call) {
        case (.mute, _), (_, .in), (_, .unknown): return
        case (.softChime, .out): announcer.play(.chime)
        case (.softChime, .close): return
        case (_, .out): announcer.play(.outVoice)
        case (_, .close): announcer.play(.closeVoice)
        }
    }
}

// MARK: - WASB-SBDT CoreML detector

/// `wasb_fp16.mlpackage`: inputs `frame_t0..2` (RGB 512×288, ImageNet normalisation baked in), output `heatmaps`
/// (1, 3, 288, 512) Float16 sigmoid probabilities; channel k belongs to frame_tk; primary blob threshold 0.35
/// with trajectory-gated 0.25 hysteresis recovery.
final class WASBDetector {
    static let inputWidth = 512
    static let inputHeight = 288
    static let threshold: Float = 0.35
    static let lowThreshold: Float = 0.25
    static let roiSize = 64
    private static let scaleX = Double(CameraCaptureManager.width) / Double(inputWidth)
    private static let scaleY = Double(CameraCaptureManager.height) / Double(inputHeight)

    private let model: MLModel
    private let transfer: VTPixelTransferSession
    private let pool: CVPixelBufferPool

    /// Loads the compiled model on CPU + ANE; nil when the model isn't bundled (audio-only fallback).
    init?() {
        let modelURL = Bundle.main.url(forResource: "wasb_fp16", withExtension: "mlmodelc")
            ?? Bundle.main.url(forResource: "wasb_fp16", withExtension: "mlpackage").flatMap { try? MLModel.compileModel(at: $0) }
        guard let url = modelURL else { return nil }
        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndNeuralEngine
        var session: VTPixelTransferSession?
        var pool: CVPixelBufferPool?
        let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                    kCVPixelBufferWidthKey as String: Self.inputWidth,
                                    kCVPixelBufferHeightKey as String: Self.inputHeight,
                                    kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        let loadedModel = (try? MLModel(contentsOf: url, configuration: config)) ?? (try? MLModel(contentsOf: url))
        guard let model = loadedModel,
              VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session) == noErr, let session,
              CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool) == kCVReturnSuccess, let pool else { return nil }
        self.model = model
        self.transfer = session
        self.pool = pool
    }

    /// One step=3 pass: 3 consecutive frames in, one (coarse, native-pixel) detection per frame out.
    func detect(_ frames: [(CVPixelBuffer, Double)], hint: Point2? = nil) -> [BallSample?] {
        guard frames.count == 3 else { return [] }
        var inputs: [String: MLFeatureValue] = [:]
        for (k, frame) in frames.enumerated() {
            var small: CVPixelBuffer?
            guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &small) == kCVReturnSuccess, let small,
                  VTPixelTransferSessionTransferImage(transfer, from: frame.0, to: small) == noErr else { return [nil, nil, nil] }
            inputs["frame_t\(k)"] = MLFeatureValue(pixelBuffer: small)
        }
        guard let provider = try? MLDictionaryFeatureProvider(dictionary: inputs),
              let out = try? model.prediction(from: provider),
              let heat = out.featureValue(for: "heatmaps")?.multiArrayValue else { return [nil, nil, nil] }
        var nearPoint = hint
        var results: [BallSample?] = []
        for c in 0..<3 {
            let pt = Self.peak(heat, channel: c, threshold: Self.threshold)
                ?? nearPoint.flatMap { Self.peak(heat, channel: c, threshold: Self.lowThreshold, near: $0, maxDistPx: LiveLineCallerEngine.maxGateJumpPx) }
            if let pt {
                nearPoint = pt
                results.append(BallSample(t: frames[c].1, u: pt.x, v: pt.y))
            } else {
                results.append(nil)
            }
        }
        return results
    }

    /// Heaviest 4-connected blob above threshold (largest summed probability), probability-weighted centroid —
    /// with optional local search window around `near` for trajectory-gated recovery of fast motion-blurred balls.
    private static func peak(_ heat: MLMultiArray, channel c: Int, threshold: Float = WASBDetector.threshold,
                             near: Point2? = nil, maxDistPx: Double = LiveLineCallerEngine.maxGateJumpPx) -> Point2? {
        let s = heat.strides.map(\.intValue)
        let read: (Int) -> Float
        switch heat.dataType {
        case .float16:
            let p = heat.dataPointer.assumingMemoryBound(to: Float16.self)
            read = { Float(p[$0]) }
        default:
            let p = heat.dataPointer.assumingMemoryBound(to: Float.self)
            read = { p[$0] }
        }
        let chOffset = c * s[1], yStride = s[2], xStride = s[3]
        func at(_ y: Int, _ x: Int) -> Float { read(chOffset + y * yStride + x * xStride) }
        let xMin: Int
        let xMax: Int
        let yMin: Int
        let yMax: Int
        if let near {
            let cx = near.x / scaleX, cy = near.y / scaleY
            let rx = Int((maxDistPx / scaleX).rounded(.up)), ry = Int((maxDistPx / scaleY).rounded(.up))
            xMin = max(0, Int(cx.rounded()) - rx)
            xMax = min(inputWidth - 1, Int(cx.rounded()) + rx)
            yMin = max(0, Int(cy.rounded()) - ry)
            yMax = min(inputHeight - 1, Int(cy.rounded()) + ry)
            guard xMin <= xMax, yMin <= yMax else { return nil }
        } else {
            xMin = 0
            xMax = inputWidth - 1
            yMin = 0
            yMax = inputHeight - 1
        }
        var visited = [Bool](repeating: false, count: inputWidth * inputHeight)
        var best: (w: Float, x: Float, y: Float) = (0, 0, 0)
        for y0 in yMin...yMax {
            for x0 in xMin...xMax where !visited[y0 * inputWidth + x0] && at(y0, x0) >= threshold {
                var blob: (w: Float, x: Float, y: Float) = (0, 0, 0)
                var stack = [(x0, y0)]
                visited[y0 * inputWidth + x0] = true
                while let (x, y) = stack.popLast() {
                    let w = at(y, x)
                    blob = (blob.w + w, blob.x + w * Float(x), blob.y + w * Float(y))
                    for (nx, ny) in [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
                    where nx >= xMin && ny >= yMin && nx <= xMax && ny <= yMax
                        && !visited[ny * inputWidth + nx] && at(ny, nx) >= threshold {
                        visited[ny * inputWidth + nx] = true
                        stack.append((nx, ny))
                    }
                }
                let pt = Point2(Double(blob.x / blob.w) * scaleX, Double(blob.y / blob.w) * scaleY)
                if let near, hypot(pt.x - near.x, pt.y - near.y) > maxDistPx { continue }
                if blob.w > best.w { best = blob }
            }
        }
        guard best.w > 0 else { return nil }
        return Point2(Double(best.x / best.w) * scaleX, Double(best.y / best.w) * scaleY)
    }

    /// 64×64 native-1080p optic-yellow chroma ROI: connected component of yellow pixels (`(128 − Cb) + 0.5·(Cr − 128)`)
    /// closest to the coarse ball point `p` (white court lines have `Cb ≈ 128, Cr ≈ 128` and cancel out, matching
    /// Python `bounce_and_linecall.refine_roi`). Falls back to luma if Plane 1 is absent, or `p` if shift > 16 px.
    static func refine(_ frame: CVPixelBuffer, around p: Point2) -> Point2 {
        CVPixelBufferLockBaseAddress(frame, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(frame, 0)?.assumingMemoryBound(to: UInt8.self) else { return p }
        let w = CVPixelBufferGetWidthOfPlane(frame, 0), h = CVPixelBufferGetHeightOfPlane(frame, 0)
        guard w >= roiSize, h >= roiSize else { return p }
        let yRow = CVPixelBufferGetBytesPerRowOfPlane(frame, 0)
        let uvBase = CVPixelBufferGetPlaneCount(frame) >= 2
            ? CVPixelBufferGetBaseAddressOfPlane(frame, 1)?.assumingMemoryBound(to: UInt8.self)
            : nil
        let uvRow = CVPixelBufferGetPlaneCount(frame) >= 2 ? CVPixelBufferGetBytesPerRowOfPlane(frame, 1) : 0
        let x0 = min(max(Int(p.x.rounded()) - roiSize / 2, 0), w - roiSize)
        let y0 = min(max(Int(p.y.rounded()) - roiSize / 2, 0), h - roiSize)
        let n = roiSize * roiSize
        var scores = [Double](repeating: 0, count: n)
        var sum = 0.0, sumSq = 0.0
        for dy in 0..<roiSize {
            let y = y0 + dy
            for dx in 0..<roiSize {
                let x = x0 + dx
                let luma = Double(yBase[y * yRow + x])
                let v: Double
                if let uvBase {
                    let uvIdx = (y / 2) * uvRow + (x / 2) * 2
                    let cb = Double(uvBase[uvIdx])
                    let cr = Double(uvBase[uvIdx + 1])
                    v = luma > 40 ? max(0, (128.0 - cb) + 0.5 * (cr - 128.0)) : 0
                } else {
                    v = luma
                }
                scores[dy * roiSize + dx] = v
                sum += v
                sumSq += v * v
            }
        }
        let count = Double(n), mean = sum / count
        let std = max(sumSq / count - mean * mean, 0).squareRoot()
        let minGate = uvBase != nil ? 10.0 : 140.0
        let threshold = max(mean + 2.0 * std, minGate)
        var visited = [Bool](repeating: false, count: n)
        var best: (score: Double, cx: Double, cy: Double)?
        for dy0 in 0..<roiSize {
            for dx0 in 0..<roiSize {
                let startIdx = dy0 * roiSize + dx0
                guard !visited[startIdx], scores[startIdx] > threshold else { continue }
                var stack = [(dx0, dy0)]
                visited[startIdx] = true
                var pixels = 0
                var sw = 0.0, sx = 0.0, sy = 0.0
                while let (dx, dy) = stack.popLast() {
                    let wgt = scores[dy * roiSize + dx]
                    pixels += 1
                    sw += wgt
                    sx += wgt * Double(x0 + dx)
                    sy += wgt * Double(y0 + dy)
                    for (nx, ny) in [(dx + 1, dy), (dx - 1, dy), (dx, dy + 1), (dx, dy - 1)]
                    where nx >= 0 && ny >= 0 && nx < roiSize && ny < roiSize {
                        let nIdx = ny * roiSize + nx
                        if !visited[nIdx] && scores[nIdx] > threshold {
                            visited[nIdx] = true
                            stack.append((nx, ny))
                        }
                    }
                }
                guard (2...450).contains(pixels), sw > 0 else { continue }
                let cx = sx / sw, cy = sy / sw
                let dist = hypot(cx - p.x, cy - p.y)
                let candidateScore = sw / max(dist, 3.0)
                if dist <= 16.0, best == nil || candidateScore > best!.score {
                    best = (candidateScore, cx, cy)
                }
            }
        }
        if let best { return Point2(best.cx, best.cy) }
        return p
    }
}

// MARK: - Racket-hit onset detector

/// 2–6 kHz band-pass energy onsets from the microphone (RBJ biquad, ~5 ms hops, 150 ms refractory).
final class HitOnsetDetector {
    static let lowHz = 2000.0
    static let highHz = 6000.0
    static let hop = 256
    static let ratio: Float = 5.0
    static let floor: Float = 1e-5
    static let refractory = 0.15

    /// Called with the onset time on the host clock (same clock as capture PTS).
    var onOnset: ((Double) -> Void)?
    private let lock = NSLock()
    private var suppressUntil = 0.0
    private var b0: Float = 0, b2: Float = 0, a1: Float = 0, a2: Float = 0
    private var z1: Float = 0, z2: Float = 0
    private var slowEnergy: Float = 1e-6
    private var lastOnset = 0.0

    /// Blanks onset detection until `hostTimeS` so speaker announcements don't self-trigger racket onsets.
    func suppress(until hostTimeS: Double) {
        lock.lock()
        suppressUntil = max(suppressUntil, hostTimeS)
        lock.unlock()
    }

    func install(on engine: AVAudioEngine) {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        design(sampleRate: format.sampleRate)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
            self?.process(buffer, time)
        }
    }

    private func design(sampleRate fs: Double) {
        let f0 = (Self.lowHz * Self.highHz).squareRoot(), octaves = log2(Self.highHz / Self.lowHz)
        let w0 = 2 * Double.pi * f0 / fs
        let alpha = sin(w0) * sinh(log(2) / 2 * octaves * w0 / sin(w0))
        let a0 = 1 + alpha
        b0 = Float(alpha / a0)
        b2 = Float(-alpha / a0)
        a1 = Float(-2 * cos(w0) / a0)
        a2 = Float((1 - alpha) / a0)
    }

    private func process(_ buffer: AVAudioPCMBuffer, _ time: AVAudioTime) {
        guard let x = buffer.floatChannelData?[0], time.isHostTimeValid else { return }
        let n = Int(buffer.frameLength), fs = buffer.format.sampleRate
        let start = CMClockMakeHostTimeFromSystemUnits(time.hostTime).seconds
        lock.lock()
        let blankedUntil = suppressUntil
        lock.unlock()
        var i = 0
        while i < n {
            let end = min(i + Self.hop, n)
            var energy: Float = 0
            for k in i..<end {
                let y = b0 * x[k] + z1                    // transposed direct form II, b1 = 0
                z1 = -a1 * y + z2
                z2 = b2 * x[k] - a2 * y
                energy += y * y
            }
            energy /= Float(end - i)
            let t = start + Double(i) / fs
            if t >= blankedUntil {
                let gate = max(Self.floor, slowEnergy * Self.ratio)
                if energy > gate, t - lastOnset > Self.refractory {
                    lastOnset = t
                    onOnset?(t)
                }
                // Cap spike adaptation so a loud near-baseline hit does not deafen the detector for the far return.
                slowEnergy = 0.995 * slowEnergy + 0.005 * min(energy, gate)
            }
            i = end
        }
    }
}

// MARK: - Call announcer

/// Preloaded PCM buffers on one AVAudioPlayerNode so a call starts within one IO buffer (~5 ms).
final class CallAnnouncer: @unchecked Sendable {
    enum Sound: CaseIterable {
        case outVoice
        case closeVoice
        case chime
        case milestone
    }

    /// Invoked with the played buffer's duration (seconds) so the microphone onset detector can blank itself.
    var onPlayDuration: ((Double) -> Void)?
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private let lock = NSLock()
    private var buffers: [Sound: AVAudioPCMBuffer] = [:]

    init(engine: AVAudioEngine) {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        buffers[.chime] = tones([(880, 0.12), (660, 0.18)])
        buffers[.milestone] = tones([(1047, 0.09), (1319, 0.09), (1568, 0.16)])
        buffers[.outVoice] = tones([(440, 0.25)])            // replaced by speech once prerendered
        buffers[.closeVoice] = tones([(1320, 0.08), (0, 0.05), (1320, 0.08)])
    }

    func play(_ sound: Sound) {
        lock.lock()
        let buffer = buffers[sound]
        lock.unlock()
        guard let buffer, let engine = player.engine else { return }
        if !engine.isRunning {
            try? engine.start()
        }
        guard engine.isRunning else { return }
        let duration = Double(buffer.frameLength) / format.sampleRate
        onPlayDuration?(duration)
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !player.isPlaying { player.play() }
    }

    /// Renders "Out!" and "Close" once with AVSpeechSynthesizer so calls never wait on TTS.
    func prerenderSpeech() async {
        let out = await Self.speak("Out!", format: format)
        let close = await Self.speak("Close", format: format)
        lock.lock()
        if let out { buffers[.outVoice] = out }
        if let close { buffers[.closeVoice] = close }
        lock.unlock()
    }

    private func tones(_ parts: [(hz: Double, seconds: Double)]) -> AVAudioPCMBuffer? {
        let total = parts.reduce(0) { $0 + Int($1.seconds * format.sampleRate) }
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)),
              let ch = buf.floatChannelData?[0] else { return nil }
        var idx = 0
        for part in parts {
            let n = Int(part.seconds * format.sampleRate)
            for k in 0..<n {
                let env = min(1, Double(k) / 240, Double(n - k) / 240)   // 5 ms attack / release
                ch[idx + k] = Float(0.8 * env * sin(2 * .pi * part.hz * Double(k) / format.sampleRate))
            }
            idx += n
        }
        buf.frameLength = AVAudioFrameCount(total)
        return buf
    }

    private static func speak(_ text: String, format: AVAudioFormat) async -> AVAudioPCMBuffer? {
        let synth = AVSpeechSynthesizer()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.55
        let chunks: [AVAudioPCMBuffer] = await withCheckedContinuation { cont in
            var collected: [AVAudioPCMBuffer] = []
            var finished = false
            synth.write(utterance) { buffer in
                guard !finished, let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 {
                    finished = true
                    cont.resume(returning: collected)
                } else if let converted = CallAnnouncer.convert(pcm, to: format) {
                    collected.append(converted)
                }
            }
        }
        _ = synth                                                   // keep the synthesizer alive until done
        let total = chunks.reduce(0) { $0 + Int($1.frameLength) }
        guard total > 0, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)),
              let dst = out.floatChannelData?[0] else { return nil }
        var idx = 0
        for c in chunks {
            guard let src = c.floatChannelData?[0] else { continue }
            dst.advanced(by: idx).update(from: src, count: Int(c.frameLength))
            idx += Int(c.frameLength)
        }
        out.frameLength = AVAudioFrameCount(idx)
        return out
    }

    private static func convert(_ input: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let converter = AVAudioConverter(from: input.format, to: format) else { return nil }
        let capacity = AVAudioFrameCount(Double(input.frameLength) * format.sampleRate / input.format.sampleRate) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .endOfStream
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return input
        }
        return status == .error ? nil : out
    }
}
