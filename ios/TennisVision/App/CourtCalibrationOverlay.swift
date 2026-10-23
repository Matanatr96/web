// CourtCalibrationOverlay.swift — 4-corner + 2 net-post tap calibration on a frozen live frame, with a 3× loupe,
// live court wireframe, convexity/order validation and the camera-height warning; plus the 2 Hz court drift
// tracker (E7) that re-registers 31×31 corner patches and updates Hr (>3 px) or pauses live calls (>15 px).
import AVFoundation
import CourtGeometry
import SwiftUI

/// The six handles, in `Court.cornerIndices` order followed by the left / right net posts.
private let handleNames = ["Far L", "Far R", "Near L", "Near R", "Post L", "Post R"]

/// Court lines as pairs of `Court.points` indices (same as `dsa.scene.court.LINES`).
private let courtLines = [(0, 1), (2, 3), (0, 2), (1, 3), (4, 5), (6, 7), (8, 9), (10, 11), (12, 13)]

struct CourtCalibrationOverlay: View {
    let image: CGImage
    let intrinsics: Intrinsics?
    let onDone: (CourtCalibration) -> Void
    let onCancel: () -> Void

    @State private var handles: [CGPoint]
    @State private var dragging: Int?

    init(image: CGImage, intrinsics: Intrinsics?, initial: CourtCalibration? = nil,
         onDone: @escaping (CourtCalibration) -> Void, onCancel: @escaping () -> Void) {
        self.image = image
        self.intrinsics = intrinsics
        self.onDone = onDone
        self.onCancel = onCancel
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let corners = initial?.corners.map { CGPoint(x: $0.x, y: $0.y) }
            ?? [CGPoint(x: 0.38 * w, y: 0.30 * h), CGPoint(x: 0.62 * w, y: 0.30 * h),
                CGPoint(x: 0.10 * w, y: 0.92 * h), CGPoint(x: 0.90 * w, y: 0.92 * h)]
        let posts = initial?.netPosts?.map { CGPoint(x: $0.x, y: $0.y) }
            ?? [CGPoint(x: 0.18 * w, y: 0.50 * h), CGPoint(x: 0.82 * w, y: 0.50 * h)]
        _handles = State(initialValue: corners + posts)
    }

    /// Current solve (or the validation error) for the taps.
    private var solve: Result<CourtCalibration, Error> {
        Result {
            try CourtCalibration.calibrate(corners: handles[0..<4].map { Point2($0.x, $0.y) },
                                           netPosts: handles[4..<6].map { Point2($0.x, $0.y) },
                                           intrinsics: intrinsics)
        }
    }

    var body: some View {
        GeometryReader { geo in
            let fit = AspectFit(image: CGSize(width: image.width, height: image.height), view: geo.size)
            ZStack(alignment: .top) {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .frame(width: fit.size.width, height: fit.size.height)
                    .position(x: fit.origin.x + fit.size.width / 2, y: fit.origin.y + fit.size.height / 2)
                wireframe(fit)
                ForEach(0..<6, id: \.self) { i in handle(i, fit: fit) }
                if let i = dragging { loupe(around: handles[i]).padding(.top, 8) }
                VStack {
                    Spacer()
                    statusBar
                }
            }
        }
        .background(Color.black)
        .ignoresSafeArea()
    }

    private func wireframe(_ fit: AspectFit) -> some View {
        Canvas { ctx, _ in
            let corners = handles[0..<4].map { Point2($0.x, $0.y) }
            guard let toImage = Homography.fit(from: Court.cornerIndices.map { Court.points[$0] }, to: corners) else { return }
            var path = Path()
            for (a, b) in courtLines {
                guard let pa = toImage.apply(Court.points[a]), let pb = toImage.apply(Court.points[b]) else { continue }
                path.move(to: fit.toView(CGPoint(x: pa.x, y: pa.y)))
                path.addLine(to: fit.toView(CGPoint(x: pb.x, y: pb.y)))
            }
            let ok = (try? solve.get()) != nil
            ctx.stroke(path, with: .color(ok ? .green : .red), lineWidth: 1.5)
        }
        .allowsHitTesting(false)
    }

    private func handle(_ i: Int, fit: AspectFit) -> some View {
        let p = fit.toView(handles[i])
        return ZStack {
            Circle().stroke(i < 4 ? Color.yellow : Color.cyan, lineWidth: 2).frame(width: 28, height: 28)
            Circle().fill(Color.white).frame(width: 3, height: 3)
            Text(handleNames[i]).font(.caption2.bold()).foregroundStyle(.white).offset(y: -24)
        }
        .contentShape(Circle().inset(by: -16))
        .position(p)
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { g in
                dragging = i
                handles[i] = fit.toImage(g.location, clampTo: CGSize(width: image.width, height: image.height))
            }
            .onEnded { _ in dragging = nil })
    }

    /// 3× magnified 80×80-pixel crop under the finger.
    private func loupe(around p: CGPoint) -> some View {
        let side: CGFloat = 80
        let rect = CGRect(x: p.x - side / 2, y: p.y - side / 2, width: side, height: side).integral
        return Group {
            if let crop = image.cropping(to: rect) {
                Image(decorative: crop, scale: 1)
                    .resizable()
                    .interpolation(.none)
                    .frame(width: side * 3, height: side * 3)
                    .overlay(Image(systemName: "plus").foregroundStyle(.red))
                    .clipShape(Circle())
                    .overlay(Circle().stroke(.white, lineWidth: 2))
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 12) {
            Button("Cancel", role: .cancel, action: onCancel)
            Spacer()
            switch solve {
            case .success(let cal):
                VStack(alignment: .trailing) {
                    if let h = cal.cameraHeight { Text(String(format: "Camera height %.1f m", h)).font(.caption) }
                    ForEach(cal.warnings.indices, id: \.self) { Text(Self.describe(cal.warnings[$0])).font(.caption).foregroundStyle(.orange) }
                }
                Button("Use Calibration") { onDone(cal) }.buttonStyle(.borderedProminent)
            case .failure(let error):
                Text(Self.describe(error)).font(.caption).foregroundStyle(.red)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }

    private static func describe(_ w: CalibrationWarning) -> String {
        switch w {
        case .cameraTooLow(let h): return String(format: "Camera only %.1f m high — raise it above 2.5 m for reliable far-court calls", h)
        case .highReprojectionError(let px): return String(format: "Net posts disagree by %.0f px — re-check the taps", px)
        case .noParallaxCorrection: return "No intrinsics / net posts: ball-radius parallax not corrected"
        }
    }

    private static func describe(_ e: Error) -> String {
        switch e as? CalibrationError {
        case .notConvex?: return "Corners must form a convex court outline"
        case .badOrder?: return "Far corners must be above near corners, left of right"
        case .degenerate?: return "Court outline is too small"
        case .wrongPointCount?: return "Tap 4 corners and 2 net posts"
        case .solveFailed?, nil: return "Could not solve the camera pose — adjust the taps"
        }
    }
}

/// Aspect-fit mapping between image pixels and view points.
private struct AspectFit {
    let scale: CGFloat
    let origin: CGPoint
    let size: CGSize

    init(image: CGSize, view: CGSize) {
        scale = min(view.width / image.width, view.height / image.height)
        size = CGSize(width: image.width * scale, height: image.height * scale)
        origin = CGPoint(x: (view.width - size.width) / 2, y: (view.height - size.height) / 2)
    }

    func toView(_ p: CGPoint) -> CGPoint { CGPoint(x: origin.x + p.x * scale, y: origin.y + p.y * scale) }

    func toImage(_ p: CGPoint, clampTo bounds: CGSize) -> CGPoint {
        CGPoint(x: min(max((p.x - origin.x) / scale, 0), bounds.width - 1),
                y: min(max((p.y - origin.y) / scale, 0), bounds.height - 1))
    }
}

// MARK: - Drift tracker (E7)

/// Re-registers 31×31 luma patches around the 4 tapped corners at 2 Hz (SAD search ±20 px, parabolic sub-pixel).
/// Median drift > 3 px re-solves the calibration (new H0 / Hr); > 15 px pauses live calls until recalibration.
final class CourtDriftTracker: @unchecked Sendable {
    static let interval = 0.5
    static let patchSize = 31
    static let search = 20
    static let updatePx = 3.0
    static let pausePx = 15.0

    /// Called on the main queue with a re-solved calibration (drift 3–15 px).
    var onRecalibrated: ((CourtCalibration) -> Void)?
    /// Called on the main queue when calls must pause (true) or may resume (false).
    var onPause: ((Bool) -> Void)?

    private let queue = DispatchQueue(label: "tennis.drift", qos: .utility)
    private var base: CourtCalibration?
    private var references: [[UInt8]?] = []
    private var lastRun = -Double.infinity
    private var lastApplied = Point2(0, 0)
    private var paused = false
    private var busy = false

    /// Captures reference patches from the calibration frame.
    func setReference(frame: CVPixelBuffer, calibration: CourtCalibration) {
        queue.async {
            self.base = calibration
            self.references = calibration.corners.map { Self.patch(in: frame, at: $0) }
            self.lastApplied = Point2(0, 0)
            self.paused = false
        }
    }

    /// Feeds a live frame (throttled to 2 Hz; drops frames while a registration is running).
    func process(_ frame: CVPixelBuffer, pts: CMTime) {
        let t = pts.seconds
        queue.async {
            guard !self.busy, t - self.lastRun >= Self.interval, let base = self.base else { return }
            self.lastRun = t
            self.busy = true
            defer { self.busy = false }
            let offsets = zip(base.corners, self.references).map { corner, ref in
                ref.flatMap { Self.register($0, in: frame, near: corner) }
            }
            let valid = offsets.compactMap { $0 }
            guard valid.count >= 2 else { return }
            let mx = Self.median(valid.map(\.x)), my = Self.median(valid.map(\.y))
            let drift = hypot(mx, my)
            if drift > Self.pausePx {
                if !self.paused {
                    self.paused = true
                    DispatchQueue.main.async { self.onPause?(true) }
                }
                return
            }
            if self.paused {
                self.paused = false
                DispatchQueue.main.async { self.onPause?(false) }
            }
            guard hypot(mx - self.lastApplied.x, my - self.lastApplied.y) > Self.updatePx else { return }
            let filled = offsets.map { $0 ?? Point2(mx, my) }
            guard let updated = try? base.shifted(by: filled) else { return }
            self.lastApplied = Point2(mx, my)
            DispatchQueue.main.async { self.onRecalibrated?(updated) }
        }
    }

    private static func median(_ v: [Double]) -> Double {
        let s = v.sorted()
        return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }

    /// 31×31 luma patch centred on `p`, or nil when it falls outside the frame (off-screen corner).
    private static func patch(in frame: CVPixelBuffer, at p: Point2) -> [UInt8]? {
        guard let plane = LumaPlane(frame) else { return nil }
        let r = patchSize / 2, cx = Int(p.x.rounded()), cy = Int(p.y.rounded())
        guard plane.contains(cx - r, cy - r), plane.contains(cx + r, cy + r) else { return nil }
        var out = [UInt8](repeating: 0, count: patchSize * patchSize)
        for y in 0..<patchSize {
            for x in 0..<patchSize { out[y * patchSize + x] = plane[cx - r + x, cy - r + y] }
        }
        return out
    }

    /// Best SAD offset of `ref` within ±search px of `p`, refined to sub-pixel with 1D parabolas.
    /// Clamps the search range at the frame borders so a corner within 15..35 px of the frame edge is still tracked.
    private static func register(_ ref: [UInt8], in frame: CVPixelBuffer, near p: Point2) -> Point2? {
        guard let plane = LumaPlane(frame) else { return nil }
        let r = patchSize / 2, cx = Int(p.x.rounded()), cy = Int(p.y.rounded())
        let minDx = max(-search, r - cx), maxDx = min(search, plane.width - 1 - r - cx)
        let minDy = max(-search, r - cy), maxDy = min(search, plane.height - 1 - r - cy)
        guard minDx <= maxDx, minDy <= maxDy else { return nil }
        let side = 2 * search + 1
        var sad = [Int](repeating: .max, count: side * side)
        var best = (cost: Int.max, dx: 0, dy: 0)
        for dy in minDy...maxDy {
            for dx in minDx...maxDx {
                var cost = 0
                for y in 0..<patchSize {
                    for x in 0..<patchSize {
                        cost += abs(Int(plane[cx - r + x + dx, cy - r + y + dy]) - Int(ref[y * patchSize + x]))
                    }
                    if cost >= best.cost { break }
                }
                sad[(dy + search) * side + dx + search] = cost
                if cost < best.cost { best = (cost, dx, dy) }
            }
        }
        guard best.cost < .max else { return nil }
        func sub(_ m: Int, _ c: Int, _ p: Int) -> Double {
            guard m != .max, p != .max else { return 0 }
            let denom = Double(m - 2 * c + p)
            return denom > 0 ? 0.5 * Double(m - p) / denom : 0
        }
        let i = (best.dy + search) * side + best.dx + search
        let fx = (best.dx > minDx && best.dx < maxDx) ? sub(sad[i - 1], best.cost, sad[i + 1]) : 0
        let fy = (best.dy > minDy && best.dy < maxDy) ? sub(sad[i - side], best.cost, sad[i + side]) : 0
        return Point2(Double(best.dx) + fx, Double(best.dy) + fy)
    }
}

/// Read-only view of plane 0 (luma) of a bi-planar 420 buffer; locks for its lifetime.
private final class LumaPlane {
    private let buffer: CVPixelBuffer
    private let base: UnsafePointer<UInt8>
    private let row: Int
    let width: Int
    let height: Int

    init?(_ buffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        guard let addr = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else {
            CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
            return nil
        }
        self.buffer = buffer
        base = UnsafePointer(addr.assumingMemoryBound(to: UInt8.self))
        row = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        width = CVPixelBufferGetWidthOfPlane(buffer, 0)
        height = CVPixelBufferGetHeightOfPlane(buffer, 0)
    }

    deinit { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

    func contains(_ x: Int, _ y: Int) -> Bool { x >= 0 && y >= 0 && x < width && y < height }

    subscript(x: Int, y: Int) -> UInt8 { base[y * row + x] }
}
