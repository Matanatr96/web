// CameraCaptureManager.swift — 1080p60 capture with a locked 1/1000 s shutter, stabilization off, a 6-second
// HEVC pre-roll ring buffer in RAM (~9 MB at 12 Mbps), and an active-rally-only AVAssetWriter scratch file.
//
// Storage invariant: nothing is written to disk unless a rally is live. `beginRally` opens `current_rally.mov`,
// seeds it with the ring buffer from the last keyframe ≤ (start − 1.5 s), then streams every newly encoded sample
// straight to disk (so a 60-second, 45-shot rally never grows RAM, E15). `endRally` trims at last activity + 2.0 s
// and renames the file to `rally_{idx}.mov`; `discardRally` deletes it. There is never a full-match file.
import AVFoundation
import CoreImage
import CourtGeometry
import Foundation
import simd
import VideoToolbox

/// Owns the AVCaptureSession, the HEVC encoder, the RAM pre-roll ring and the per-rally writer.
final class CameraCaptureManager: NSObject, @unchecked Sendable {
    static let fps: Int32 = 60
    static let width: Int32 = 1920
    static let height: Int32 = 1080
    static let shutter = CMTime(value: 1, timescale: 1000)
    static let bitRate = 12_000_000            // 12 Mbps × 6 s ≈ 9 MB of ring buffer
    static let keyframeInterval = 30           // 0.5 s GOP keeps the pre-roll trim tight
    static let ringSeconds = 6.0
    static let preRollSeconds = 1.5
    static let tailSeconds = 2.0
    /// Exposure re-metering cadence and dead-band while no rally is live.
    static let exposureMinInterval = 0.25
    static let exposureDeadbandEV: Float = 0.25

    enum CaptureError: Error {
        case noCamera
        case no1080p60Format
        case cannotAddIO
        case encoderFailed(OSStatus)
    }

    let session = AVCaptureSession()
    /// Raw 1080p frames for the line caller and drift tracker (called on the capture queue — keep it fast).
    var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    /// Camera intrinsics K for the 1920×1080 output (sample-buffer attachment, else derived from the FOV).
    private(set) var intrinsics: Intrinsics?
    private let exposureLock = NSLock()
    private var _exposureFrozen = false
    /// While true (rally `.live`), exposure stays frozen so the ball's brightness doesn't pump mid-rally.
    var exposureFrozen: Bool {
        get { exposureLock.withLock { _exposureFrozen } }
        set { exposureLock.withLock { _exposureFrozen = newValue } }
    }

    private let videoOutput = AVCaptureVideoDataOutput()
    private let captureQueue = DispatchQueue(label: "tennis.capture", qos: .userInteractive)
    private let writerQueue = DispatchQueue(label: "tennis.writer", qos: .userInitiated)
    private var device: AVCaptureDevice?
    private var encoder: VTCompressionSession?
    private var exposureObservation: NSKeyValueObservation?
    private var lastExposureChange = Date.distantPast
    private var latestFrame: CVPixelBuffer?

    // writerQueue-only state.
    private var ring: [CMSampleBuffer] = []
    private var formatHint: CMFormatDescription?
    private var rally: RallyWriter?

    // MARK: Configuration

    /// Configures the back wide camera for 1080p60, locked 1/1000 s shutter, HDR and stabilization off.
    func configure() throws {
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CaptureError.noCamera
        }
        device = cam
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .inputPriority       // keep our activeFormat

        let input = try AVCaptureDeviceInput(device: cam)
        guard session.canAddInput(input), session.canAddOutput(videoOutput) else { throw CaptureError.cannotAddIO }
        session.addInput(input)

        let format = try Self.best1080p60Format(cam)
        try cam.lockForConfiguration()
        cam.activeFormat = format
        let frame = CMTime(value: 1, timescale: Self.fps)
        cam.activeVideoMinFrameDuration = frame
        cam.activeVideoMaxFrameDuration = frame
        if format.isVideoHDRSupported {
            cam.automaticallyAdjustsVideoHDREnabled = false
            cam.isVideoHDREnabled = false
        }
        if cam.isFocusModeSupported(.continuousAutoFocus) { cam.focusMode = .continuousAutoFocus }
        let initialExp = Self.exposureSettings(for: cam, evAdjustment: -cam.exposureTargetOffset)
        cam.setExposureModeCustom(duration: initialExp.duration, iso: initialExp.iso, completionHandler: nil)
        cam.unlockForConfiguration()
        intrinsics = Intrinsics(horizontalFOVDegrees: Double(format.videoFieldOfView),
                                width: Double(Self.width), height: Double(Self.height))

        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: captureQueue)
        session.addOutput(videoOutput)
        if let connection = videoOutput.connection(with: .video) {
            if connection.isVideoStabilizationSupported { connection.preferredVideoStabilizationMode = .off }
            if connection.isCameraIntrinsicMatrixDeliverySupported { connection.isCameraIntrinsicMatrixDeliveryEnabled = true }
            if connection.isVideoRotationAngleSupported(0) { connection.videoRotationAngle = 0 }   // sensor-native landscape
        }
        try makeEncoder()
        observeExposure(cam)
    }

    /// Picks a 1920×1080 full-range format that supports 60 fps (prefers non-binned, highest max ISO).
    private static func best1080p60Format(_ cam: AVCaptureDevice) throws -> AVCaptureDevice.Format {
        let candidates = cam.formats.filter { f in
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return d.width == width && d.height == height
                && CMFormatDescriptionGetMediaSubType(f.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                && f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(fps) }
        }
        guard let best = candidates.max(by: { ($0.isVideoBinned ? 0 : 1, $0.maxISO) < ($1.isVideoBinned ? 0 : 1, $1.maxISO) })
        else { throw CaptureError.no1080p60Format }
        return best
    }

    /// Computes custom `(duration, iso)` to achieve the target EV: prefers locked 1/1000 s shutter in daylight, and
    /// smoothly lengthens shutter up to 1/60 s indoors or under dim night lights when `maxISO` alone would underexpose.
    private static func exposureSettings(for cam: AVCaptureDevice, evAdjustment: Float = 0) -> (duration: CMTime, iso: Float) {
        let currentDuration = max(CMTimeGetSeconds(cam.exposureDuration), 0.0001)
        let targetExposure = currentDuration * Double(cam.iso) * Double(powf(2, evAdjustment))
        let minShutterS = CMTimeGetSeconds(shutter)
        let maxShutterS = min(1.0 / Double(fps), CMTimeGetSeconds(cam.activeFormat.maxExposureDuration))
        let minISO = cam.activeFormat.minISO
        let maxISO = cam.activeFormat.maxISO
        let isoAtFastShutter = Float(targetExposure / minShutterS)
        if isoAtFastShutter <= maxISO {
            return (shutter, min(max(isoAtFastShutter, minISO), maxISO))
        }
        let relaxedDurationS = min(max(targetExposure / Double(maxISO), minShutterS), maxShutterS)
        return (CMTime(seconds: relaxedDurationS, preferredTimescale: 1_000_000), maxISO)
    }

    /// KVO on `exposureTargetOffset`: between rallies, nudge ISO (and shutter when ISO saturates indoors) towards 0 EV; frozen while live.
    private func observeExposure(_ cam: AVCaptureDevice) {
        exposureObservation = cam.observe(\.exposureTargetOffset, options: [.initial, .new]) { [weak self] cam, _ in
            guard let self else { return }
            let offset = cam.exposureTargetOffset
            let now = Date()
            let shouldUpdate = self.exposureLock.withLock { () -> Bool in
                guard !self._exposureFrozen,
                      abs(offset) > Self.exposureDeadbandEV,
                      now.timeIntervalSince(self.lastExposureChange) > Self.exposureMinInterval else { return false }
                self.lastExposureChange = now
                return true
            }
            guard shouldUpdate else { return }
            let exp = Self.exposureSettings(for: cam, evAdjustment: -offset)
            guard (try? cam.lockForConfiguration()) != nil else { return }
            cam.setExposureModeCustom(duration: exp.duration, iso: exp.iso, completionHandler: nil)
            cam.unlockForConfiguration()
        }
    }

    /// Real-time HEVC encoder feeding the ring buffer and, during rallies, the scratch writer.
    private func makeEncoder() throws {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Self.width, height: Self.height,
                                                codecType: kCMVideoCodecType_HEVC, encoderSpecification: nil,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &session)
        guard status == noErr, let session else { throw CaptureError.encoderFailed(status) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_HEVC_Main_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: Self.fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                             value: Self.keyframeInterval as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: Self.bitRate as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        encoder = session
    }

    // MARK: Lifecycle

    /// Starts capture (off the main thread, as AVFoundation requires).
    func start() { captureQueue.async { self.session.startRunning() } }

    /// Stops capture, flushes any rally clip that has already been marked for ending (`stopAt != nil`), and discards unended scratch clips.
    func stop() {
        captureQueue.async { self.session.stopRunning() }
        writerQueue.async {
            if let writer = self.rally {
                self.rally = nil
                if let stop = writer.stopAt {
                    let endPTS = self.ring.last.map { CMTimeMinimum($0.presentationTimeStamp, stop) } ?? stop
                    writer.finish(at: endPTS)
                } else {
                    writer.cancel()
                }
            }
        }
    }

    /// Latest full-resolution frame (calibration snapshot + drift-tracker reference).
    func latestPixelBuffer() -> CVPixelBuffer? { captureQueue.sync { latestFrame } }

    /// Renders a frame as an image for the calibration overlay.
    static func image(from frame: CVPixelBuffer) -> CGImage? {
        CIContext().createCGImage(CIImage(cvPixelBuffer: frame), from: CGRect(x: 0, y: 0, width: Int(width), height: Int(height)))
    }

    // MARK: Rally clips

    /// Opens `current_rally.mov` and seeds it from the ring buffer starting 1.5 s before `start`.
    func beginRally(at start: CMTime) {
        writerQueue.async {
            self.rally?.cancel()
            self.rally = nil
            guard let hint = self.formatHint else { return }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("current_rally.mov")
            try? FileManager.default.removeItem(at: url)
            guard let writer = try? RallyWriter(url: url, formatHint: hint) else { return }
            let from = CMTimeSubtract(start, CMTime(seconds: Self.preRollSeconds, preferredTimescale: 600))
            // Latest keyframe at or before the pre-roll point, so the clip decodes from its first frame.
            let firstIdx = self.ring.lastIndex { Self.isKeyframe($0) && CMTimeCompare($0.presentationTimeStamp, from) <= 0 }
                ?? self.ring.firstIndex(where: Self.isKeyframe)
            if let firstIdx { self.ring[firstIdx...].forEach(writer.append) }
            self.rally = writer
        }
    }

    /// Stops the live clip at `lastActivity + 2.0 s` (waiting for the tail if it's still in the future) and hands
    /// back `rally_{idx}.mov` in Application Support (survives tmp purges during background upload).
    func endRally(lastActivity: CMTime, rallyIdx: Int, completion: @escaping (URL?) -> Void) {
        writerQueue.async {
            guard let writer = self.rally else { return completion(nil) }
            writer.stopAt = CMTimeAdd(lastActivity, CMTime(seconds: Self.tailSeconds, preferredTimescale: 600))
            writer.onFinish = { url in
                guard let url else { return completion(nil) }
                let dest = Self.clipsDirectory.appendingPathComponent("rally_\(rallyIdx).mov")
                try? FileManager.default.removeItem(at: dest)
                do {
                    try FileManager.default.moveItem(at: url, to: dest)
                    completion(dest)
                } catch {
                    completion(nil)
                }
            }
            if let newest = self.ring.last { self.finishIfPastTail(writer, newest: newest.presentationTimeStamp) }
        }
    }

    /// Abandons the live clip (false wake-up) and deletes the scratch file.
    func discardRally() {
        writerQueue.async {
            self.rally?.cancel()
            self.rally = nil
        }
    }

    /// Writes the last `seconds` of the RAM ring to a temporary file for the slow-mo challenge replay.
    func exportRecent(seconds: Double = ringSeconds) async -> URL? {
        let (samples, hint): ([CMSampleBuffer], CMFormatDescription?) = writerQueue.sync {
            guard let newest = ring.last else { return ([], formatHint) }
            let from = CMTimeSubtract(newest.presentationTimeStamp, CMTime(seconds: seconds, preferredTimescale: 600))
            let start = ring.firstIndex { Self.isKeyframe($0) && CMTimeCompare($0.presentationTimeStamp, from) >= 0 }
                ?? ring.firstIndex(where: Self.isKeyframe)
            return (start.map { Array(ring[$0...]) } ?? [], formatHint)
        }
        guard let hint, !samples.isEmpty else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("challenge_\(UUID().uuidString).mov")
        guard let writer = try? RallyWriter(url: url, formatHint: hint) else { return nil }
        samples.forEach(writer.append)
        return await withCheckedContinuation { cont in
            writer.onFinish = { cont.resume(returning: $0) }
            writer.finish(at: nil)
        }
    }

    static let clipsDirectory: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Rallies", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // MARK: Encoded-sample plumbing (writerQueue)

    private func handleEncoded(_ sample: CMSampleBuffer) {
        if formatHint == nil { formatHint = sample.formatDescription }
        ring.append(sample)
        let newest = sample.presentationTimeStamp
        // Trim to 6 s, then drop leading non-keyframes (an orphaned P-frame can't decode).
        while let first = ring.first, CMTimeGetSeconds(CMTimeSubtract(newest, first.presentationTimeStamp)) > Self.ringSeconds {
            ring.removeFirst()
        }
        while let first = ring.first, !Self.isKeyframe(first), ring.count > 1 { ring.removeFirst() }
        if let writer = rally {
            writer.append(sample)
            finishIfPastTail(writer, newest: newest)
        }
    }

    private func finishIfPastTail(_ writer: RallyWriter, newest: CMTime) {
        guard let stop = writer.stopAt, CMTimeCompare(newest, stop) >= 0 else { return }
        rally = nil
        writer.finish(at: stop)
    }

    private static func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]],
              let first = attachments.first else { return true }
        return !(first[kCMSampleAttachmentKey_NotSync as String] as? Bool ?? false)
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension CameraCaptureManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = sampleBuffer.presentationTimeStamp
        latestFrame = pixelBuffer
        if let data = CMGetAttachment(sampleBuffer, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
                                      attachmentModeOut: nil) as? Data, data.count >= MemoryLayout<matrix_float3x3>.size {
            let k = data.withUnsafeBytes { $0.loadUnaligned(as: matrix_float3x3.self) }
            intrinsics = Intrinsics(fx: Double(k.columns.0.x), fy: Double(k.columns.1.y),
                                    cx: Double(k.columns.2.x), cy: Double(k.columns.2.y))
        }
        if let encoder = self.encoder {
            VTCompressionSessionEncodeFrame(encoder, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
                                            duration: CMTime(value: 1, timescale: Self.fps), frameProperties: nil,
                                            infoFlagsOut: nil) { [weak self] status, _, encoded in
                guard status == noErr, let encoded, let self else { return }
                self.writerQueue.async { self.handleEncoded(encoded) }
            }
        }
        onFrame?(pixelBuffer, pts)
    }
}

// MARK: - RallyWriter

/// Pass-through (no re-encode) HEVC writer for one clip.
/// Holds a bounded 1.75 s sliding tail in RAM while `stopAt` is unset so that when Rally Mode closes a rally after
/// `maxRallyGap` (3.5 s of silence), frames after `lastActivity + 2.0 s` have not yet been committed to `AVAssetWriterInput`.
private final class RallyWriter {
    static let holdSeconds = max(0, RallyTracker.maxRallyGap - CameraCaptureManager.tailSeconds + 0.25)

    let url: URL
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var started = false
    private var pending: [CMSampleBuffer] = []
    /// Clip end (last activity + tail); nil while the rally is still live.
    var stopAt: CMTime?
    var onFinish: ((URL?) -> Void)?

    init(url: URL, formatHint: CMFormatDescription) throws {
        self.url = url
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: formatHint)
        input.expectsMediaDataInRealTime = true
        writer.add(input)
    }

    func append(_ sample: CMSampleBuffer) {
        let pts = sample.presentationTimeStamp
        if let stop = stopAt, CMTimeCompare(pts, stop) > 0 { return }
        pending.append(sample)
        if stopAt != nil {
            while !pending.isEmpty {
                writeSample(pending.removeFirst())
            }
        } else {
            while let first = pending.first,
                  CMTimeGetSeconds(CMTimeSubtract(pts, first.presentationTimeStamp)) > Self.holdSeconds {
                writeSample(pending.removeFirst())
            }
        }
    }

    private func writeSample(_ sample: CMSampleBuffer) {
        if !started {
            guard writer.startWriting() else { return }
            writer.startSession(atSourceTime: sample.presentationTimeStamp)
            started = true
        }
        // Seeding from the ring appends ~360 samples at once; wait briefly rather than drop (a gap breaks decoding).
        var spins = 0
        while !input.isReadyForMoreMediaData && spins < 100 {
            usleep(500)
            spins += 1
        }
        if input.isReadyForMoreMediaData { input.append(sample) }
    }

    /// Finishes the file, trimming media after `end` when given.
    func finish(at end: CMTime?) {
        for sample in pending {
            if let end, CMTimeCompare(sample.presentationTimeStamp, end) > 0 { continue }
            writeSample(sample)
        }
        pending.removeAll()
        guard started else {
            onFinish?(nil)
            return
        }
        if let end { writer.endSession(atSourceTime: end) }
        input.markAsFinished()
        writer.finishWriting { [self] in onFinish?(writer.status == .completed ? url : nil) }
    }

    func cancel() {
        pending.removeAll()
        if started { writer.cancelWriting() }
        try? FileManager.default.removeItem(at: url)
    }
}
