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
}

final class LiveLineCallerEngine: @unchecked Sendable {
    static let armedTimeout = 2.0
    static let goLiveDetections = 6
    static let goLiveDisplacementPx = 40.0
    static let maxGateJumpPx = 225.0          // 60 px at the 512×288 model scale (E12)
    static let stationaryFrames = 10          // a blob still for ≥10 frames is a spare ball (E12)
    static let postSamplesTimeout = 0.12      // decide with 3 post samples if the 4th hasn't come in 120 ms
    static let trackWindow = 3.0

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
    private var lastHitterHalf: CourtHalf?
    private var bouncesThisRally = 0
    private var armedAt = 0.0
    private var cooldownUntil = 0.0
    private var pending: [(CVPixelBuffer, Double)] = []
    private var frameIndex = 0
    private var inferenceBusy = false
    private var stationary: (p: Point2, count: Int)?

    init() {
        announcer = CallAnnouncer(engine: audioEngine)
        onsets.onOnset = { [weak self] t in self?.queue.async { self?.handleOnset(at: t) } }
    }

    // MARK: Configuration (thread-safe setters)

    /// Starts the audio engine (onset detection + preloaded call buffers).
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement,
                                options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
        try session.setPreferredIOBufferDuration(0.005)
        try session.setActive(true)
        onsets.install(on: audioEngine)
        try audioEngine.start()
        Task { await announcer.prerenderSpeech() }
    }

    func stop() {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
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

    // MARK: Frames

    /// Feeds a captured 1080p frame (called on the capture queue).
    func ingest(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        queue.async { [self] in
            let t = pts.seconds
            advanceClock(to: t)
            let thermal = ProcessInfo.processInfo.thermalState
            guard state == .armed || state == .live, thermal != .critical, let detector else { return }
            frameIndex += 1
            if thermal == .serious && frameIndex % 2 == 1 { return }       // 30 fps triplets
            pending.append((pixelBuffer, t))
            guard pending.count == 3 else { return }
            let triplet = pending
            pending.removeAll()
            guard !inferenceBusy else { return }                            // never queue up stale triplets
            inferenceBusy = true
            let recentV = track.suffix(3).map(\.v)
            mlQueue.async { [self] in
                var samples = detector.detect(triplet)
                let refineAll = thermal == .nominal
                if refineAll || Self.hasReversal(recentV + samples.compactMap { $0?.v }) {
                    for k in samples.indices {
                        guard let s = samples[k] else { continue }
                        let p = WASBDetector.refine(triplet[k].0, around: Point2(s.u, s.v))
                        samples[k] = BallSample(t: s.t, u: p.x, v: p.y)
                    }
                }
                queue.async { [self] in
                    inferenceBusy = false
                    handle(samples.compactMap { $0 }, sigmaPx: thermal == .serious ? 3.0 : BallKinematics.defaultSigmaPx)
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

    private func handleOnset(at t: Double) {
        recentOnsets.append(t)
        recentOnsets.removeAll { t - $0 > Self.trackWindow }
        let audioOnly = ProcessInfo.processInfo.thermalState == .critical || detector == nil || calibration == nil
        switch state {
        case .sleeping:
            armedAt = t
            track.removeAll()
            stationary = nil
            bouncesThisRally = 0
            set(.armed)
            DispatchQueue.main.async { self.delegate?.engine(self, rallyStartedAt: CMTime(seconds: t, preferredTimescale: 600)) }
            if audioOnly { goLive() }
        case .live where audioOnly:
            registerHit(at: t)                                             // no vision: onsets are the hits
        case .armed, .live, .cooldown:
            break
        }
    }

    private func goLive() {
        set(.live)
        registerHit(at: armedAt)                                           // the feed / first hit that woke us
    }

    private func advanceClock(to t: Double) {
        switch state {
        case .armed where t - armedAt > Self.armedTimeout:
            set(.sleeping)
            pending.removeAll()
            DispatchQueue.main.async { self.delegate?.engine(self, rallyEnded: nil, lastActivity: .zero) }
        case .live:
            if let summary = tracker.tick(now: t) { finishRally(summary) }
        case .cooldown where t >= cooldownUntil:
            set(.sleeping)
        default:
            break
        }
    }

    private func finishRally(_ summary: RallySummary) {
        set(.cooldown)
        pending.removeAll()
        track.removeAll()
        cooldownUntil = summary.endS + CameraCaptureManager.tailSeconds + 0.1
        let last = CMTime(seconds: summary.endS, preferredTimescale: 600)
        DispatchQueue.main.async { self.delegate?.engine(self, rallyEnded: summary, lastActivity: last) }
    }

    private func registerHit(at t: Double) {
        let outcome = tracker.registerHit(at: t)
        if outcome.milestone != nil, audioMode == .milestones, !callsPaused { announcer.play(.milestone) }
        publishShots()
    }

    private func publishShots() {
        let (n, streak, best) = (tracker.shotCount, tracker.inStreak, tracker.sessionBestStreak)
        DispatchQueue.main.async { self.delegate?.engine(self, didUpdateShots: n, inStreak: streak, sessionBest: best) }
    }

    // MARK: Detections → events

    private func handle(_ samples: [BallSample], sigmaPx: Double) {
        for s in samples where accept(s) { track.append(s) }
        if let newest = track.last?.t { track.removeAll { newest - $0.t > Self.trackWindow } }
        switch state {
        case .armed:
            let recent = track.filter { $0.t - armedAt >= -0.5 }
            if recent.count >= Self.goLiveDetections, let a = recent.first, let b = recent.last,
               hypot(b.u - a.u, b.v - a.v) > Self.goLiveDisplacementPx { goLive() }
        case .live:
            processEvents(sigmaPx: sigmaPx)
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
        var predicted = Point2(last.u, last.v)
        if track.count >= 2 {
            let prev = track[track.count - 2]
            let dt = last.t - prev.t
            if dt > 0, dt < 0.1 {
                predicted.x += (last.u - prev.u) / dt * (s.t - last.t)
                predicted.y += (last.v - prev.v) / dt * (s.t - last.t)
            }
        }
        return hypot(predicted.x - p.x, predicted.y - p.y) <= Self.maxGateJumpPx
    }

    /// Finds v extrema with enough post samples, classifies hit vs bounce, judges bounces.
    private func processEvents(sigmaPx: Double) {
        guard let cal = calibration, track.count >= 3, let newestT = track.last?.t else { return }
        for i in 1..<(track.count - 1) where track[i].t > lastEventT {
            let (a, b, c) = (track[i - 1].v, track[i].v, track[i + 1].v)
            let isExtremum = (b >= a && b > c) || (b <= a && b < c)
            guard isExtremum else { continue }
            let post = track.count - 1 - i
            guard post >= BallKinematics.fitSamples
                    || (post >= BallKinematics.minSamples && newestT - track[i].t > Self.postSamplesTimeout) else { return }
            lastEventT = track[i].t
            let pre = Array(track[...i]), after = Array(track[(i + 1)...])
            let eventT = track[i].t
            let heard = recentOnsets.contains { (-0.05...0.25).contains($0 - eventT) }
            switch BallKinematics.classifyEvent(pre: pre, post: after, h0: cal.h0, racketSound: heard) {
            case .hit:
                lastHitterHalf = cal.h0.apply(Point2(track[i].u, track[i].v)).map { $0.y > 0 ? .far : .near }
                registerHit(at: track[i].t)
            case .bounce:
                judgeBounce(at: i, cal: cal, sigmaPx: sigmaPx)
                if state != .live { return }                               // match point ended: track was cleared
            case .unknown:
                continue
            }
        }
    }

    private func judgeBounce(at i: Int, cal: CourtCalibration, sigmaPx: Double) {
        let lo = max(0, i - BallKinematics.fitSamples - 1), hi = min(track.count - 1, i + BallKinematics.fitSamples + 1)
        let window = Array(track[lo...hi])
        let estimate = BallKinematics.contactPoint(around: i - lo, in: window, hr: cal.hr, sigmaPx: sigmaPx)
        let isServe = mode == .match && bouncesThisRally == 0
        let region = isServe ? (serveRegion ?? .singles) : (doubles ? .doubles : .singles)
        let result = LineCaller.judge(estimate, region: region, hitter: lastHitterHalf)
        bouncesThisRally += 1
        let t = estimate?.tStar ?? track[i].t
        tracker.registerBounce(call: result.call, depthZone: result.depthZone, at: t)
        let latencyMs = (CMClockGetTime(CMClockGetHostTimeClock()).seconds - t) * 1000
        if !callsPaused { announce(result.call) }
        DispatchQueue.main.async { self.delegate?.engine(self, didCall: result, latencyMs: latencyMs) }
        publishShots()
        if mode == .match && (result.call == .out || result.depthZone == .net), let summary = tracker.endRally() {
            finishRally(summary)                                           // point over: clip ends at bounce + tail
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
/// (1, 3, 288, 512) Float16 sigmoid probabilities; channel k belongs to frame_tk; blob threshold 0.5.
final class WASBDetector {
    static let inputWidth = 512
    static let inputHeight = 288
    static let threshold: Float = 0.5
    static let roiSize = 64
    private static let scaleX = Double(CameraCaptureManager.width) / Double(inputWidth)
    private static let scaleY = Double(CameraCaptureManager.height) / Double(inputHeight)

    private let model: MLModel
    private let transfer: VTPixelTransferSession
    private let pool: CVPixelBufferPool

    /// Loads the compiled model on CPU + ANE; nil when the model isn't bundled (audio-only fallback).
    init?() {
        guard let url = Bundle.main.url(forResource: "wasb_fp16", withExtension: "mlmodelc") else { return nil }
        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndNeuralEngine
        var session: VTPixelTransferSession?
        var pool: CVPixelBufferPool?
        let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                    kCVPixelBufferWidthKey as String: Self.inputWidth,
                                    kCVPixelBufferHeightKey as String: Self.inputHeight,
                                    kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard let model = try? MLModel(contentsOf: url, configuration: config),
              VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session) == noErr, let session,
              CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool) == kCVReturnSuccess, let pool else { return nil }
        self.model = model
        self.transfer = session
        self.pool = pool
    }

    /// One step=3 pass: 3 consecutive frames in, one (coarse, native-pixel) detection per frame out.
    func detect(_ frames: [(CVPixelBuffer, Double)]) -> [BallSample?] {
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
        return (0..<3).map { c in Self.peak(heat, channel: c).map { BallSample(t: frames[c].1, u: $0.x, v: $0.y) } }
    }

    /// Heaviest 4-connected blob above threshold (largest summed probability), probability-weighted centroid —
    /// the same post-processing as `bounce_and_linecall.ball_track()` / MODEL_CARD.md.
    private static func peak(_ heat: MLMultiArray, channel c: Int) -> Point2? {
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
        func at(_ y: Int, _ x: Int) -> Float { read(c * s[1] + y * s[2] + x * s[3]) }
        var visited = [Bool](repeating: false, count: inputWidth * inputHeight)
        var best: (w: Float, x: Float, y: Float) = (0, 0, 0)
        for y0 in 0..<inputHeight {
            for x0 in 0..<inputWidth where !visited[y0 * inputWidth + x0] && at(y0, x0) >= threshold {
                var blob: (w: Float, x: Float, y: Float) = (0, 0, 0)
                var stack = [(x0, y0)]
                visited[y0 * inputWidth + x0] = true
                while let (x, y) = stack.popLast() {
                    let w = at(y, x)
                    blob = (blob.w + w, blob.x + w * Float(x), blob.y + w * Float(y))
                    for (nx, ny) in [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
                    where nx >= 0 && ny >= 0 && nx < inputWidth && ny < inputHeight
                        && !visited[ny * inputWidth + nx] && at(ny, nx) >= threshold {
                        visited[ny * inputWidth + nx] = true
                        stack.append((nx, ny))
                    }
                }
                if blob.w > best.w { best = blob }
            }
        }
        guard best.w > 0 else { return nil }
        return Point2((Double(best.x / best.w) + 0.5) * scaleX - 0.5, (Double(best.y / best.w) + 0.5) * scaleY - 0.5)
    }

    /// 64×64 native-1080p luma ROI: centroid of pixels brighter than mean + 2σ (the ball is the bright compact blob).
    /// Falls back to the coarse point when the ROI is flat or the centroid jumps >12 px.
    static func refine(_ frame: CVPixelBuffer, around p: Point2) -> Point2 {
        CVPixelBufferLockBaseAddress(frame, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(frame, 0)?.assumingMemoryBound(to: UInt8.self) else { return p }
        let w = CVPixelBufferGetWidthOfPlane(frame, 0), h = CVPixelBufferGetHeightOfPlane(frame, 0)
        let row = CVPixelBufferGetBytesPerRowOfPlane(frame, 0)
        let x0 = min(max(Int(p.x) - roiSize / 2, 0), w - roiSize), y0 = min(max(Int(p.y) - roiSize / 2, 0), h - roiSize)
        var sum = 0.0, sumSq = 0.0
        for y in y0..<(y0 + roiSize) {
            for x in x0..<(x0 + roiSize) {
                let v = Double(base[y * row + x])
                sum += v
                sumSq += v * v
            }
        }
        let n = Double(roiSize * roiSize), mean = sum / n
        let threshold = mean + 2 * max((sumSq / n - mean * mean), 0).squareRoot()
        var sw = 0.0, sx = 0.0, sy = 0.0
        for y in y0..<(y0 + roiSize) {
            for x in x0..<(x0 + roiSize) {
                let wgt = Double(base[y * row + x]) - threshold
                guard wgt > 0 else { continue }
                sw += wgt
                sx += wgt * Double(x)
                sy += wgt * Double(y)
            }
        }
        guard sw > 1 else { return p }
        let c = Point2(sx / sw, sy / sw)
        return hypot(c.x - p.x, c.y - p.y) <= 12 ? c : p
    }
}

// MARK: - Racket-hit onset detector

/// 2–6 kHz band-pass energy onsets from the microphone (RBJ biquad, ~5 ms hops, 150 ms refractory).
final class HitOnsetDetector {
    static let lowHz = 2000.0
    static let highHz = 6000.0
    static let hop = 256
    static let ratio: Float = 8
    static let floor: Float = 1e-5
    static let refractory = 0.15

    /// Called with the onset time on the host clock (same clock as capture PTS).
    var onOnset: ((Double) -> Void)?
    private var b0: Float = 0, b2: Float = 0, a1: Float = 0, a2: Float = 0
    private var z1: Float = 0, z2: Float = 0
    private var slowEnergy: Float = 1e-6
    private var lastOnset = 0.0

    func install(on engine: AVAudioEngine) {
        let input = engine.inputNode
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
            if energy > max(Self.floor, slowEnergy * Self.ratio), t - lastOnset > Self.refractory {
                lastOnset = t
                onOnset?(t)
            }
            slowEnergy = 0.995 * slowEnergy + 0.005 * energy
            i = end
        }
    }
}

// MARK: - Call announcer

/// Preloaded PCM buffers on one AVAudioPlayerNode so a call starts within one IO buffer (~5 ms).
final class CallAnnouncer {
    enum Sound: CaseIterable {
        case outVoice
        case closeVoice
        case chime
        case milestone
    }

    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
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
        guard let buffer = buffers[sound] else { return }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !player.isPlaying { player.play() }
    }

    /// Renders "Out!" and "Close" once with AVSpeechSynthesizer so calls never wait on TTS.
    func prerenderSpeech() async {
        if let out = await Self.speak("Out!", format: format) { buffers[.outVoice] = out }
        if let close = await Self.speak("Close", format: format) { buffers[.closeVoice] = close }
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
