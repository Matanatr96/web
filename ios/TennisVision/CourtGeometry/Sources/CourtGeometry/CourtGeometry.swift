// CourtGeometry.swift — pure-Swift port of `dsa.physics.homography` + `dsa.physics.bounce_and_linecall`.
//
// Court frame (metres, identical to Python `COURT_M`): origin at the centre of the net, +X to the right as seen
// from the near baseline, +Y towards the far baseline, +Z up. Point indices follow `dsa.scene.court.POINTS`.
//
// Pipeline for one bounce:
//   1. `CourtCalibration.calibrate` — 4 tapped doubles corners (+ 2 net posts) → H0 (image → Z=0 plane), camera
//      pose (K, R, t) and Hr (image → Z = 0.033 m ball-centre plane; removes ~25 cm far-baseline parallax).
//   2. `BallKinematics.classifyEvent` — sign(dY_court/dt) unchanged across the event → bounce, flipped → hit.
//   3. `BallKinematics.contactPoint` — ≥4 + ≥4 PTS-timed samples, quadratic v(t) fits each side, intersection t*,
//      pixel σ propagated through the Jacobian of Hr into σ_X / σ_Y on the court.
//   4. `LineCaller.judge` — signed margin to the nearest boundary (positive = out), 2σ_m in/out/close verdict and
//      depth zone (`short` / `deep` / `out_long` / `out_wide` / `net`).
import Foundation

// MARK: - Basic types

/// A 2D point: image pixels (x right, y down) or court metres (X, Y) depending on context.
public struct Point2: Equatable, Codable, Sendable {
    public var x: Double
    public var y: Double

    /// Creates a 2D point.
    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

/// A 3D point or vector in metres (court frame) or camera coordinates.
public struct Point3: Equatable, Codable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double

    /// Creates a 3D point.
    public init(_ x: Double, _ y: Double, _ z: Double) {
        self.x = x
        self.y = y
        self.z = z
    }

    static func + (a: Point3, b: Point3) -> Point3 { Point3(a.x + b.x, a.y + b.y, a.z + b.z) }
    static func - (a: Point3, b: Point3) -> Point3 { Point3(a.x - b.x, a.y - b.y, a.z - b.z) }
    static func * (s: Double, a: Point3) -> Point3 { Point3(s * a.x, s * a.y, s * a.z) }
    func dot(_ o: Point3) -> Double { x * o.x + y * o.y + z * o.z }
    func cross(_ o: Point3) -> Point3 { Point3(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x) }
    var norm: Double { dot(self).squareRoot() }
}

/// A row-major 3×3 matrix of doubles (`simd` is unavailable on Linux, so this stays dependency-free).
public struct Mat3: Equatable, Codable, Sendable {
    /// Row-major entries `m[3 * row + col]`.
    public var m: [Double]

    /// Creates a matrix from 9 row-major entries.
    public init(_ m: [Double]) {
        precondition(m.count == 9, "Mat3 needs 9 entries")
        self.m = m
    }

    /// The 3×3 identity.
    public static let identity = Mat3([1, 0, 0, 0, 1, 0, 0, 0, 1])

    /// Builds a matrix from three column vectors.
    public init(columns c0: Point3, _ c1: Point3, _ c2: Point3) {
        self.init([c0.x, c1.x, c2.x, c0.y, c1.y, c2.y, c0.z, c1.z, c2.z])
    }

    /// Entry at (row, col).
    public subscript(r: Int, c: Int) -> Double {
        get { m[3 * r + c] }
        set { m[3 * r + c] = newValue }
    }

    /// Column `c` as a vector.
    public func column(_ c: Int) -> Point3 { Point3(self[0, c], self[1, c], self[2, c]) }

    /// Matrix product `self * o`.
    public static func * (a: Mat3, o: Mat3) -> Mat3 {
        var r = [Double](repeating: 0, count: 9)
        for i in 0..<3 {
            for j in 0..<3 {
                r[3 * i + j] = a[i, 0] * o[0, j] + a[i, 1] * o[1, j] + a[i, 2] * o[2, j]
            }
        }
        return Mat3(r)
    }

    /// Matrix-vector product.
    public static func * (a: Mat3, v: Point3) -> Point3 {
        Point3(a[0, 0] * v.x + a[0, 1] * v.y + a[0, 2] * v.z,
               a[1, 0] * v.x + a[1, 1] * v.y + a[1, 2] * v.z,
               a[2, 0] * v.x + a[2, 1] * v.y + a[2, 2] * v.z)
    }

    /// Transpose.
    public var transposed: Mat3 { Mat3([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]) }

    /// Determinant.
    public var determinant: Double {
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    /// Inverse, or nil when (numerically) singular.
    public var inverse: Mat3? {
        let d = determinant
        guard abs(d) > 1e-15 else { return nil }
        let c = [
            m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
            m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
            m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
        ]
        return Mat3(c.map { $0 / d })
    }
}

// MARK: - ITF court model

/// Exact ITF court dimensions in metres (Swift twin of Python `COURT_M` / `NET_POSTS_M`).
public enum Court {
    /// Net to baseline (23.77 m / 2).
    public static let halfLength = 11.885
    /// Centre mark to singles sideline (8.23 m / 2).
    public static let singlesHalfWidth = 4.115
    /// Centre mark to doubles sideline (10.97 m / 2).
    public static let doublesHalfWidth = 5.485
    /// Net to service line.
    public static let serviceLineY = 6.40
    /// Tennis-ball radius: the ball centre sits this far above the court at impact.
    public static let ballRadius = 0.033
    /// Net post height.
    public static let netPostHeight = 1.07
    /// Net posts stand 0.914 m outside the doubles sidelines.
    public static let netPostX = 6.40

    /// The 14 line intersections in `dsa.scene.court.POINTS` order (court metres, Z = 0).
    public static let points: [Point2] = [
        Point2(-doublesHalfWidth, halfLength), Point2(doublesHalfWidth, halfLength),     // 0, 1 far doubles corners
        Point2(-doublesHalfWidth, -halfLength), Point2(doublesHalfWidth, -halfLength),   // 2, 3 near doubles corners
        Point2(-singlesHalfWidth, halfLength), Point2(-singlesHalfWidth, -halfLength),   // 4, 5 left singles sideline
        Point2(singlesHalfWidth, halfLength), Point2(singlesHalfWidth, -halfLength),     // 6, 7 right singles sideline
        Point2(-singlesHalfWidth, serviceLineY), Point2(singlesHalfWidth, serviceLineY), // 8, 9 far service line
        Point2(-singlesHalfWidth, -serviceLineY), Point2(singlesHalfWidth, -serviceLineY), // 10, 11 near service line
        Point2(0, serviceLineY), Point2(0, -serviceLineY),                               // 12, 13 far / near T
    ]

    /// Indices of the 4 outer (doubles) corners the user taps, in tap order: far-left, far-right, near-left, near-right.
    public static let cornerIndices = [0, 1, 2, 3]

    /// Left and right net-post tops (court metres).
    public static let netPosts: [Point3] = [
        Point3(-netPostX, 0, netPostHeight), Point3(netPostX, 0, netPostHeight),
    ]
}

// MARK: - Homography

/// A planar projective map `p' ~ H p` with a horizon guard: points on the wrong side of the vanishing line
/// (e.g. a lob projected above the horizon, edge case E11) map to `nil` instead of a mirrored court position.
public struct Homography: Equatable, Codable, Sendable {
    /// The 3×3 matrix (normalised so `|H| = 1` up to sign).
    public let matrix: Mat3
    /// Sign of the homogeneous `w` for points on the valid side (set from the fitting correspondences).
    public let wSign: Double

    /// Wraps an existing matrix. `wSign` = +1 when every valid point maps with positive `w`.
    public init(matrix: Mat3, wSign: Double = 1) {
        self.matrix = matrix
        self.wSign = wSign >= 0 ? 1 : -1
    }

    /// Maps a point, or returns nil when it lies on/behind the horizon.
    public func apply(_ p: Point2) -> Point2? {
        let r = matrix * Point3(p.x, p.y, 1)
        guard r.z * wSign > 1e-12 else { return nil }
        return Point2(r.x / r.z, r.y / r.z)
    }

    /// The inverse map (keeps the horizon guard consistent on the other side).
    public var inverse: Homography? {
        guard let inv = matrix.inverse else { return nil }
        // For p' = H p with w = h3·p, the inverse applied to (w x', w y', w) returns p scaled by w; a valid point
        // has w·wSign > 0, so the inverse's w carries the same sign as wSign.
        return Homography(matrix: inv, wSign: wSign)
    }

    /// 2×2 Jacobian `∂(X, Y)/∂(x, y)` at `p`, row-major `[dX/dx, dX/dy, dY/dx, dY/dy]`.
    public func jacobian(at p: Point2) -> [Double]? {
        let h = matrix
        let w = h[2, 0] * p.x + h[2, 1] * p.y + h[2, 2]
        guard abs(w) > 1e-12, let q = apply(p) else { return nil }
        return [
            (h[0, 0] - q.x * h[2, 0]) / w, (h[0, 1] - q.x * h[2, 1]) / w,
            (h[1, 0] - q.y * h[2, 0]) / w, (h[1, 1] - q.y * h[2, 1]) / w,
        ]
    }

    /// Normalised DLT with h33 = 1 (exact for 4 points, least squares for more). Returns nil for degenerate input.
    ///
    /// - Parameters:
    ///   - src: Source points (e.g. image pixels).
    ///   - dst: Matching destination points (e.g. court metres), same count, ≥ 4.
    public static func fit(from src: [Point2], to dst: [Point2]) -> Homography? {
        guard src.count == dst.count, src.count >= 4 else { return nil }
        guard let (ts, ns) = hartley(src), let (td, nd) = hartley(dst) else { return nil }
        // Accumulate normal equations AᵀA h = Aᵀb for the 8 unknowns (h33 = 1).
        var ata = [Double](repeating: 0, count: 64)
        var atb = [Double](repeating: 0, count: 8)
        func add(_ row: [Double], _ b: Double) {
            for i in 0..<8 {
                atb[i] += row[i] * b
                for j in 0..<8 { ata[8 * i + j] += row[i] * row[j] }
            }
        }
        for (s, d) in zip(ns, nd) {
            add([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x], d.x)
            add([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y], d.y)
        }
        guard let h = LinearAlgebra.solve(ata, atb, n: 8) else { return nil }
        let hn = Mat3([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1])
        guard let tdInv = td.inverse else { return nil }
        var full = tdInv * hn * ts
        let scale = abs(full.determinant)
        guard scale > 1e-18 else { return nil }
        let k = 1 / pow(scale, 1.0 / 3.0)
        full = Mat3(full.m.map { $0 * k })
        // Horizon guard: the sign of w at the source centroid (inside the fitted region) marks the valid side.
        let c = Point2(src.map(\.x).reduce(0, +) / Double(src.count), src.map(\.y).reduce(0, +) / Double(src.count))
        let w = full[2, 0] * c.x + full[2, 1] * c.y + full[2, 2]
        return Homography(matrix: full, wSign: w)
    }

    /// Hartley normalisation: centroid to origin, mean distance √2.
    private static func hartley(_ pts: [Point2]) -> (Mat3, [Point2])? {
        let n = Double(pts.count)
        let cx = pts.map(\.x).reduce(0, +) / n
        let cy = pts.map(\.y).reduce(0, +) / n
        let meanDist = pts.map { ((($0.x - cx) * ($0.x - cx)) + (($0.y - cy) * ($0.y - cy))).squareRoot() }
            .reduce(0, +) / n
        guard meanDist > 1e-12 else { return nil }
        let s = 2.0.squareRoot() / meanDist
        let t = Mat3([s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1])
        return (t, pts.map { Point2(s * ($0.x - cx), s * ($0.y - cy)) })
    }
}

// MARK: - Camera model & pose

/// Pinhole intrinsics (pixels) for the capture resolution, e.g. from `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix`.
public struct Intrinsics: Equatable, Codable, Sendable {
    public var fx: Double
    public var fy: Double
    public var cx: Double
    public var cy: Double

    /// Creates intrinsics from focal lengths and principal point.
    public init(fx: Double, fy: Double, cx: Double, cy: Double) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
    }

    /// Fallback when the intrinsic-matrix attachment is unavailable: square pixels, centred principal point,
    /// focal length from the format's horizontal field of view (`AVCaptureDevice.Format.videoFieldOfView`).
    public init(horizontalFOVDegrees fov: Double, width: Double, height: Double) {
        let f = (width / 2) / tan(fov * .pi / 360)
        self.init(fx: f, fy: f, cx: width / 2, cy: height / 2)
    }

    /// The camera matrix K.
    public var matrix: Mat3 { Mat3([fx, 0, cx, 0, fy, cy, 0, 0, 1]) }
}

/// World→camera extrinsics: `X_cam = R · X_court + t`.
public struct CameraPose: Equatable, Codable, Sendable {
    public var rotation: Mat3
    public var translation: Point3

    /// Creates a pose from a rotation and translation.
    public init(rotation: Mat3, translation: Point3) {
        self.rotation = rotation
        self.translation = translation
    }

    /// A camera at `eye` looking at `target` with world +Z as up (used by tests and synthetic checks).
    public static func lookAt(eye: Point3, target: Point3) -> CameraPose {
        let fwd = target - eye
        let z = (1 / fwd.norm) * fwd
        let xRaw = z.cross(Point3(0, 0, 1))
        let x = (1 / xRaw.norm) * xRaw                     // image right
        let y = z.cross(x)                                 // image down
        let r = Mat3([x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z])
        return CameraPose(rotation: r, translation: -1 * (r * eye))
    }

    /// Camera centre in court coordinates (`-Rᵀ t`).
    public var center: Point3 { -1 * (rotation.transposed * translation) }

    /// Height of the lens above the court surface, metres.
    public var height: Double { center.z }

    /// Projects a court-frame point into pixels, or nil when it is behind the camera.
    public func project(_ p: Point3, intrinsics k: Intrinsics) -> Point2? {
        let c = rotation * p + translation
        guard c.z > 1e-9 else { return nil }
        return Point2(k.fx * c.x / c.z + k.cx, k.fy * c.y / c.z + k.cy)
    }

    /// Image → court homography of the horizontal plane `Z = z`: `H_z = (K [r1  r2  z·r3 + t])⁻¹`.
    public func planeHomography(z: Double, intrinsics k: Intrinsics) -> Homography? {
        let g = k.matrix * Mat3(columns: rotation.column(0), rotation.column(1),
                                z * rotation.column(2) + translation)
        guard let inv = g.inverse else { return nil }
        // Points in front of the camera have positive depth, i.e. positive w in court→image; the inverse
        // then yields positive w for valid pixels.
        return Homography(matrix: inv, wSign: 1)
    }

    /// Initial pose from a Z = 0 image→court homography and K (Zhang's planar decomposition).
    public static func fromGroundHomography(_ h0: Homography, intrinsics k: Intrinsics) -> CameraPose? {
        guard let g = h0.matrix.inverse, let kInv = k.matrix.inverse else { return nil }
        let b = kInv * g
        let b1 = b.column(0), b2 = b.column(1), b3 = b.column(2)
        var lambda = 2 / (b1.norm + b2.norm)
        if (lambda * b3).z < 0 { lambda = -lambda }        // the court must be in front of the camera
        let r1 = (lambda * b1), r2raw = (lambda * b2)
        let e1 = (1 / r1.norm) * r1
        let r2o = r2raw - r2raw.dot(e1) * e1
        let e2 = (1 / r2o.norm) * r2o
        let e3 = e1.cross(e2)
        return CameraPose(rotation: Mat3(columns: e1, e2, e3), translation: lambda * b3)
    }

    /// Levenberg–Marquardt refinement of the pose on all 3D↔2D correspondences (Swift `cv2.solvePnP` stand-in).
    ///
    /// - Returns: The refined pose and its reprojection RMS in pixels.
    public func refined(world: [Point3], image: [Point2], intrinsics k: Intrinsics,
                        iterations: Int = 50) -> (pose: CameraPose, rms: Double) {
        func residuals(_ p: CameraPose) -> [Double]? {
            var r: [Double] = []
            for (w, i) in zip(world, image) {
                guard let q = p.project(w, intrinsics: k) else { return nil }
                r.append(q.x - i.x)
                r.append(q.y - i.y)
            }
            return r
        }
        func cost(_ r: [Double]) -> Double { r.reduce(0) { $0 + $1 * $1 } }
        func perturbed(_ base: CameraPose, _ d: [Double]) -> CameraPose {
            CameraPose(rotation: Rotation.rodrigues(Point3(d[0], d[1], d[2])) * base.rotation,
                       translation: base.translation + Point3(d[3], d[4], d[5]))
        }
        var pose = self
        guard var r = residuals(pose) else { return (self, .infinity) }
        var damping = 1e-3
        for _ in 0..<iterations {
            // Numeric Jacobian (central differences) of residuals w.r.t. [δω, δt].
            var jac = [[Double]](repeating: [], count: 6)
            let eps = 1e-6
            var ok = true
            for j in 0..<6 {
                var dp = [Double](repeating: 0, count: 6), dm = dp
                dp[j] = eps
                dm[j] = -eps
                guard let rp = residuals(perturbed(pose, dp)), let rm = residuals(perturbed(pose, dm)) else {
                    ok = false
                    break
                }
                jac[j] = zip(rp, rm).map { ($0 - $1) / (2 * eps) }
            }
            guard ok else { break }
            var jtj = [Double](repeating: 0, count: 36)
            var jtr = [Double](repeating: 0, count: 6)
            for a in 0..<6 {
                for i in 0..<r.count { jtr[a] -= jac[a][i] * r[i] }
                for b in 0..<6 {
                    var s = 0.0
                    for i in 0..<r.count { s += jac[a][i] * jac[b][i] }
                    jtj[6 * a + b] = s
                }
            }
            var improved = false
            for _ in 0..<10 {
                var lhs = jtj
                for a in 0..<6 { lhs[7 * a] *= 1 + damping }
                guard let delta = LinearAlgebra.solve(lhs, jtr, n: 6) else { break }
                let candidate = perturbed(pose, delta)
                if let rc = residuals(candidate), cost(rc) < cost(r) {
                    pose = candidate
                    r = rc
                    damping = max(damping / 10, 1e-9)
                    improved = true
                    break
                }
                damping *= 10
            }
            if !improved || cost(r) < 1e-18 { break }
        }
        return (pose, (cost(r) / Double(max(world.count, 1))).squareRoot())
    }
}

/// Rotation helpers.
public enum Rotation {
    /// Rodrigues' formula: axis-angle vector → rotation matrix.
    public static func rodrigues(_ w: Point3) -> Mat3 {
        let theta = w.norm
        let kx: Mat3
        if theta < 1e-12 {
            kx = Mat3([0, -w.z, w.y, w.z, 0, -w.x, -w.y, w.x, 0])
            return Mat3(zip(Mat3.identity.m, kx.m).map { $0 + $1 })
        }
        let k = (1 / theta) * w
        kx = Mat3([0, -k.z, k.y, k.z, 0, -k.x, -k.y, k.x, 0])
        let kk = kx * kx
        let s = sin(theta), c = 1 - cos(theta)
        return Mat3((0..<9).map { Mat3.identity.m[$0] + s * kx.m[$0] + c * kk.m[$0] })
    }
}

// MARK: - Calibration

/// Why a set of calibration taps was rejected.
public enum CalibrationError: Error, Equatable {
    /// Expected exactly 4 corners (and 0 or 2 net posts).
    case wrongPointCount
    /// The corners do not form a convex quadrilateral in far-left, far-right, near-right, near-left order.
    case notConvex
    /// Far corners must be above the near corners and left corners left of right corners.
    case badOrder
    /// The quadrilateral is too small to calibrate reliably.
    case degenerate
    /// The homography or pose solve failed numerically.
    case solveFailed
}

/// Non-fatal calibration warnings surfaced in the overlay.
public enum CalibrationWarning: Equatable, Sendable {
    /// Lens below 2.5 m: far-court bounces compress and calls get less certain.
    case cameraTooLow(heightM: Double)
    /// Net-post taps disagree with the corner-derived pose by more than this many pixels.
    case highReprojectionError(px: Double)
    /// No intrinsics / net posts: Hr falls back to H0 (no ball-radius parallax correction).
    case noParallaxCorrection
}

/// A solved court calibration (Swift twin of Python `homography.calibrate()`'s court.json v1).
public struct CourtCalibration: Equatable, Sendable {
    /// Minimum recommended camera height (metres).
    public static let minCameraHeight = 2.5
    /// Reprojection error above which the taps are flagged.
    public static let maxReprojectionPx = 4.0

    /// The 4 tapped corners in `Court.cornerIndices` order (pixels).
    public let corners: [Point2]
    /// The 2 tapped net posts (left, right) in pixels, if provided.
    public let netPosts: [Point2]?
    /// Image → court homography of the Z = 0 plane.
    public let h0: Homography
    /// Image → court homography of the Z = 0.033 m ball-centre plane (use for line calls).
    public let hr: Homography
    /// Camera pose, when intrinsics were available.
    public let pose: CameraPose?
    /// Intrinsics used for the pose.
    public let intrinsics: Intrinsics?
    /// Reprojection RMS (px) of all taps under the refined pose (0 without a pose).
    public let reprojectionRMS: Double
    /// Warnings to show the user.
    public let warnings: [CalibrationWarning]

    /// Camera height above the court, metres.
    public var cameraHeight: Double? { pose?.height }

    /// Validates the 4 corner taps (convex, correctly ordered, non-degenerate).
    ///
    /// - Parameter corners: far-left, far-right, near-left, near-right (pixels, y down).
    public static func validate(corners: [Point2]) throws {
        guard corners.count == 4 else { throw CalibrationError.wrongPointCount }
        let fl = corners[0], fr = corners[1], nl = corners[2], nr = corners[3]
        guard fl.x < fr.x, nl.x < nr.x, max(fl.y, fr.y) < min(nl.y, nr.y) else { throw CalibrationError.badOrder }
        let ring = [fl, fr, nr, nl]
        var sign = 0.0
        var area = 0.0
        for i in 0..<4 {
            let a = ring[i], b = ring[(i + 1) % 4], c = ring[(i + 2) % 4]
            let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if cross == 0 { throw CalibrationError.notConvex }
            if sign == 0 { sign = cross } else if (cross > 0) != (sign > 0) { throw CalibrationError.notConvex }
            area += a.x * b.y - b.x * a.y
        }
        guard abs(area) / 2 > 400 else { throw CalibrationError.degenerate }
    }

    /// Solves H0, the camera pose (when `intrinsics` are given) and Hr from the taps.
    ///
    /// - Parameters:
    ///   - corners: 4 doubles corners in `Court.cornerIndices` order (pixels).
    ///   - netPosts: Optional left/right net-post tops (pixels) — constrain the pose out of the ground plane.
    ///   - intrinsics: Camera matrix for the capture resolution; without it Hr = H0 and a warning is emitted.
    public static func calibrate(corners: [Point2], netPosts: [Point2]? = nil,
                                 intrinsics: Intrinsics?) throws -> CourtCalibration {
        try validate(corners: corners)
        if let posts = netPosts, posts.count != 2 { throw CalibrationError.wrongPointCount }
        let courtCorners = Court.cornerIndices.map { Court.points[$0] }
        guard let h0 = Homography.fit(from: corners, to: courtCorners) else { throw CalibrationError.solveFailed }
        guard let k = intrinsics, let initial = CameraPose.fromGroundHomography(h0, intrinsics: k) else {
            return CourtCalibration(corners: corners, netPosts: netPosts, h0: h0, hr: h0, pose: nil,
                                    intrinsics: intrinsics, reprojectionRMS: 0, warnings: [.noParallaxCorrection])
        }
        var world = courtCorners.map { Point3($0.x, $0.y, 0) }
        var image = corners
        if let posts = netPosts {
            world += Court.netPosts
            image += posts
        }
        let (pose, rms) = initial.refined(world: world, image: image, intrinsics: k)
        guard rms.isFinite, let hr = pose.planeHomography(z: Court.ballRadius, intrinsics: k) else {
            throw CalibrationError.solveFailed
        }
        var warnings: [CalibrationWarning] = []
        if pose.height < minCameraHeight { warnings.append(.cameraTooLow(heightM: pose.height)) }
        if rms > maxReprojectionPx { warnings.append(.highReprojectionError(px: rms)) }
        if netPosts == nil { warnings.append(.noParallaxCorrection) }
        return CourtCalibration(corners: corners, netPosts: netPosts, h0: h0, hr: hr, pose: pose, intrinsics: k,
                                reprojectionRMS: rms, warnings: warnings)
    }

    /// Re-solves the calibration after the camera drifted by per-corner pixel offsets (E7 drift tracker).
    public func shifted(by offsets: [Point2]) throws -> CourtCalibration {
        precondition(offsets.count == 4, "one offset per corner")
        let moved = zip(corners, offsets).map { Point2($0.x + $1.x, $0.y + $1.y) }
        let mean = Point2(offsets.map(\.x).reduce(0, +) / 4, offsets.map(\.y).reduce(0, +) / 4)
        let posts = netPosts?.map { Point2($0.x + mean.x, $0.y + mean.y) }
        return try CourtCalibration.calibrate(corners: moved, netPosts: posts, intrinsics: intrinsics)
    }
}

// MARK: - Ball kinematics (hit vs bounce, sub-frame contact)

/// One ball detection at native resolution, timed by presentation timestamp (never frame index, E13).
public struct BallSample: Equatable, Codable, Sendable {
    /// Presentation timestamp, seconds.
    public var t: Double
    /// Pixel x (native 1920×1080).
    public var u: Double
    /// Pixel y (native 1920×1080, down).
    public var v: Double

    /// Creates a sample.
    public init(t: Double, u: Double, v: Double) {
        self.t = t
        self.u = u
        self.v = v
    }
}

/// `y(t) = a (t - t0)² + b (t - t0) + c`, fitted by least squares.
public struct Polynomial2: Equatable, Sendable {
    public var a: Double
    public var b: Double
    public var c: Double
    /// Reference time (improves conditioning with large PTS values).
    public var t0: Double
    /// Root-mean-square residual of the fit.
    public var rms: Double

    /// Evaluates the polynomial.
    public func callAsFunction(_ t: Double) -> Double {
        let d = t - t0
        return a * d * d + b * d + c
    }

    /// Least-squares fit; `degree` 1 forces `a = 0`. Needs ≥ degree + 1 samples.
    public static func fit(t: [Double], y: [Double], t0: Double, degree: Int = 2) -> Polynomial2? {
        let n = degree + 1
        guard t.count == y.count, t.count >= n, degree == 1 || degree == 2 else { return nil }
        var ata = [Double](repeating: 0, count: n * n)
        var atb = [Double](repeating: 0, count: n)
        for (ti, yi) in zip(t, y) {
            let d = ti - t0
            let row = degree == 2 ? [d * d, d, 1] : [d, 1]
            for i in 0..<n {
                atb[i] += row[i] * yi
                for j in 0..<n { ata[n * i + j] += row[i] * row[j] }
            }
        }
        guard let s = LinearAlgebra.solve(ata, atb, n: n) else { return nil }
        var p = degree == 2 ? Polynomial2(a: s[0], b: s[1], c: s[2], t0: t0, rms: 0)
                            : Polynomial2(a: 0, b: s[0], c: s[1], t0: t0, rms: 0)
        let sse = zip(t, y).reduce(0.0) { $0 + pow(p($1.0) - $1.1, 2) }
        p.rms = (sse / Double(t.count)).squareRoot()
        return p
    }
}

/// What happened between two ball-track segments.
public enum TrackEvent: String, Codable, Sendable {
    /// Court-Y velocity keeps its sign: the ball bounced and carried on.
    case bounce
    /// Court-Y velocity flipped sign: a racket sent the ball back.
    case hit
    /// Too few valid (below-horizon) samples or too little motion to tell.
    case unknown
}

/// Sub-frame contact estimate on the Hr plane.
public struct ContactEstimate: Equatable, Sendable {
    /// Sub-frame bounce time t* (PTS seconds).
    public var tStar: Double
    /// Ball-centre pixel at t*.
    public var pixel: Point2
    /// Court position (metres) of the ball centre on the Z = 0.033 m plane, i.e. directly above the contact.
    public var court: Point2
    /// 1σ court uncertainty along X (metres).
    public var sigmaX: Double
    /// 1σ court uncertainty along Y (metres).
    public var sigmaY: Double
    /// Samples used before / after the bounce.
    public var samplesPre: Int
    public var samplesPost: Int
}

/// Hit-vs-bounce separation and sub-frame contact point (Swift twin of `is_bounce()` / `contact_point()`).
public enum BallKinematics {
    /// Samples used on each side of the event for the parabola fits.
    public static let fitSamples = 4
    /// Minimum samples per side; with fewer the call is `unknown` (E8).
    public static let minSamples = 3
    /// Default detector pixel σ at native resolution after 64×64 ROI centroid refinement.
    public static let defaultSigmaPx = 1.5
    /// Minimum |dY_court/dt| (m/s) for a confident velocity-sign decision.
    public static let minCourtSpeed = 1.0
    /// Far-half events projecting more than this beyond the baseline / doubles sideline are airborne (hits).
    public static let farHitMarginM = 2.0
    /// Minimum jump in image velocity (px/s) across an event: hits and bounces are velocity discontinuities, while a
    /// smooth flight apex (also a v extremum) only bends by gravity (~40 px/s across the gap at the far baseline).
    public static let minCuspPxPerS = 150.0

    /// True when the linear image-velocity fits before and after differ by at least `minCuspPxPerS`.
    public static func isCusp(pre: [BallSample], post: [BallSample]) -> Bool {
        func velocity(_ s: [BallSample]) -> (Double, Double)? {
            guard let t0 = s.first?.t,
                  let u = Polynomial2.fit(t: s.map(\.t), y: s.map(\.u), t0: t0, degree: 1),
                  let v = Polynomial2.fit(t: s.map(\.t), y: s.map(\.v), t0: t0, degree: 1) else { return nil }
            return (u.b, v.b)
        }
        guard let a = velocity(pre), let b = velocity(post) else { return false }
        return hypot(b.0 - a.0, b.1 - a.1) >= minCuspPxPerS
    }

    /// Classifies an event by the sign of the court-Y velocity before vs after it, with a far-half position prior.
    ///
    /// The Z = 0 projection of an airborne ball mixes vertical speed into court Y with leverage
    /// `(Y − Y_cam)·h / (h − Z)²` (≈ 7 at the far baseline for a 3.5 m lens), so a fast-descending far-court bounce
    /// can look like a direction flip. On the far half the event's ground projection decides instead: a bounce
    /// projects onto the court, whereas a ball ≥ ~0.3 m up (a hit or volley) projects ≥ 2 m beyond the baseline.
    /// The near half (small leverage) uses the velocity sign. Samples above the horizon are excluded (E11 lobs).
    ///
    /// Events must be image-velocity cusps (`isCusp`) unless a racket sound was heard: a far-player hit reverses
    /// the ball mostly along the camera ray, so its image cusp can be as weak as a smooth flight apex (~25 px/s);
    /// the 2–6 kHz onset is what tells them apart.
    /// - Parameters:
    ///   - pre: Samples before the candidate event (time-ordered).
    ///   - post: Samples after the candidate event (time-ordered).
    ///   - h0: Image → court Z = 0 homography.
    ///   - racketSound: A racket-hit audio onset coincides with the event (≈ −50…+250 ms, sound travels ~80 ms).
    public static func classifyEvent(pre: [BallSample], post: [BallSample], h0: Homography,
                                     racketSound: Bool = false) -> TrackEvent {
        func courtYVelocity(_ s: [BallSample]) -> Double? {
            let valid = s.compactMap { b in h0.apply(Point2(b.u, b.v)).map { (b.t, $0.y) } }
            guard valid.count >= 2 else { return nil }
            return Polynomial2.fit(t: valid.map(\.0), y: valid.map(\.1), t0: valid[0].0, degree: 1)?.b
        }
        guard let lastPre = pre.last, let firstPost = post.first,
              racketSound || isCusp(pre: Array(pre.suffix(fitSamples)), post: Array(post.prefix(fitSamples))),
              let before = courtYVelocity(Array(pre.suffix(fitSamples))),
              let after = courtYVelocity(Array(post.prefix(fitSamples))),
              max(abs(before), abs(after)) >= minCourtSpeed else { return .unknown }
        guard let ground = h0.apply(Point2((lastPre.u + firstPost.u) / 2, (lastPre.v + firstPost.v) / 2)) else {
            return .hit                                    // above the horizon: certainly airborne
        }
        if ground.y > 0 {
            let onCourt = ground.y <= Court.halfLength + farHitMarginM && abs(ground.x) <= Court.doublesHalfWidth + farHitMarginM
            return onCourt ? .bounce : .hit
        }
        guard abs(before) >= minCourtSpeed, abs(after) >= minCourtSpeed else { return .unknown }
        return (before > 0) == (after > 0) ? .bounce : .hit
    }

    /// Sub-frame bounce from up to 4 pre + 4 post PTS samples: intersects quadratic fits of v(t), evaluates the
    /// quadratic u(t)/v(t) fits of both sides at t* (mean of pre and post), maps through Hr and propagates pixel σ
    /// via the Hr Jacobian.
    ///
    /// σ is doubled when either side has only 3 samples; nil (→ `call: unknown`) below 3 on either side.
    /// - Parameters:
    ///   - pre: Samples before the bounce (time-ordered).
    ///   - post: Samples after the bounce (time-ordered).
    ///   - hr: Image → court homography of the Z = 0.033 m plane.
    ///   - sigmaPx: Per-sample detector σ in native pixels.
    public static func contactPoint(pre: [BallSample], post: [BallSample], hr: Homography,
                                    sigmaPx: Double = defaultSigmaPx) -> ContactEstimate? {
        let a = Array(pre.suffix(fitSamples)), b = Array(post.prefix(fitSamples))
        guard a.count >= minSamples, b.count >= minSamples, let lastPre = a.last, let firstPost = b.first,
              firstPost.t > lastPre.t else { return nil }
        let t0 = (lastPre.t + firstPost.t) / 2
        guard let vPre = Polynomial2.fit(t: a.map(\.t), y: a.map(\.v), t0: t0),
              let vPost = Polynomial2.fit(t: b.map(\.t), y: b.map(\.v), t0: t0),
              let uPre = Polynomial2.fit(t: a.map(\.t), y: a.map(\.u), t0: t0),
              let uPost = Polynomial2.fit(t: b.map(\.t), y: b.map(\.u), t0: t0) else { return nil }

        let gap = firstPost.t - lastPre.t
        let tStar = intersection(vPre, vPost, t0: t0, lo: lastPre.t - gap, hi: firstPost.t + gap) ?? t0
        let pixel = Point2((uPre(tStar) + uPost(tStar)) / 2, (vPre(tStar) + vPost(tStar)) / 2)
        guard let court = hr.apply(pixel), let j = hr.jacobian(at: pixel) else { return nil }

        let fitNoise = (vPre.rms * vPre.rms + vPost.rms * vPost.rms + uPre.rms * uPre.rms + uPost.rms * uPost.rms) / 2
        var sigma = (sigmaPx * sigmaPx + fitNoise).squareRoot()
        if a.count < fitSamples || b.count < fitSamples { sigma *= 2 }
        return ContactEstimate(tStar: tStar, pixel: pixel, court: court,
                               sigmaX: sigma * (j[0] * j[0] + j[1] * j[1]).squareRoot(),
                               sigmaY: sigma * (j[2] * j[2] + j[3] * j[3]).squareRoot(),
                               samplesPre: a.count, samplesPost: b.count)
    }

    /// Contact point around a candidate sample `i` (the lowest-in-image detection): that sample may belong to
    /// either arc, so both assignments are tried and the one with the smaller σ (fit residual) wins.
    ///
    /// - Parameters:
    ///   - track: Time-ordered samples.
    ///   - i: Index of the candidate bounce sample (local maximum of v).
    ///   - hr: Image → court homography of the Z = 0.033 m plane.
    ///   - sigmaPx: Per-sample detector σ in native pixels.
    public static func contactPoint(around i: Int, in track: [BallSample], hr: Homography,
                                    sigmaPx: Double = defaultSigmaPx) -> ContactEstimate? {
        guard track.indices.contains(i) else { return nil }
        let withPre = contactPoint(pre: Array(track[...i]), post: Array(track[(i + 1)...]), hr: hr, sigmaPx: sigmaPx)
        let withPost = contactPoint(pre: Array(track[..<i]), post: Array(track[i...]), hr: hr, sigmaPx: sigmaPx)
        switch (withPre, withPost) {
        case let (a?, b?): return (a.sigmaX + a.sigmaY) <= (b.sigmaX + b.sigmaY) ? a : b
        case let (a, b): return a ?? b
        }
    }

    /// Root of `p - q` inside `[lo, hi]` closest to `t0`.
    static func intersection(_ p: Polynomial2, _ q: Polynomial2, t0: Double, lo: Double, hi: Double) -> Double? {
        // Both share t0, so subtract coefficients directly: A d² + B d + C = 0 with d = t - t0.
        let qa = p.a - q.a, qb = p.b - q.b, qc = p.c - q.c
        var roots: [Double] = []
        if abs(qa) < 1e-12 {
            if abs(qb) > 1e-12 { roots = [-qc / qb] }
        } else {
            let disc = qb * qb - 4 * qa * qc
            guard disc >= 0 else { return nil }
            let s = disc.squareRoot()
            roots = [(-qb + s) / (2 * qa), (-qb - s) / (2 * qa)]
        }
        return roots.map { $0 + t0 }.filter { $0 >= lo && $0 <= hi }.min { abs($0 - t0) < abs($1 - t0) }
    }
}

// MARK: - Line calls & depth zones

/// The verdict for one bounce.
public enum LineCall: String, Codable, Sendable {
    case `in`
    case out
    case close
    case unknown
}

/// Where a bounce landed (matches `tennis_shots.depth_zone`).
public enum DepthZone: String, Codable, Sendable, CaseIterable {
    /// Between the service line and the baseline (6.4–11.885 m from the net) — the target zone.
    case deep
    /// Inside the service line (0–6.4 m from the net).
    case short
    /// Beyond the baseline.
    case outLong = "out_long"
    /// Beyond a sideline.
    case outWide = "out_wide"
    /// Never crossed the net.
    case net
    /// No usable contact point.
    case unknown
}

/// A complete judged bounce.
public struct LineCallResult: Equatable, Sendable {
    public var call: LineCall
    /// Signed distance (m) to the governing boundary: positive = out, negative = in.
    public var marginM: Double
    /// 1σ uncertainty (m) along the governing boundary's normal.
    public var sigmaM: Double
    public var depthZone: DepthZone
    public var court: Point2
    public var tStar: Double
}

/// Which half of the court a player stands on.
public enum CourtHalf: String, Codable, Sendable {
    /// Y < 0 (camera side).
    case near
    /// Y > 0.
    case far
}

/// The rectangle a bounce is judged against (matches Python `region`).
public enum CallRegion: String, Codable, Sendable, CaseIterable {
    /// Full singles court — every rally-mode shot (E2) and every match-mode rally ball.
    case singles
    /// Full doubles court.
    case doubles
    /// Service boxes, used only for match-mode serves.
    case serveDeuceFar = "serve_deuce_far"
    case serveAdFar = "serve_ad_far"
    case serveDeuceNear = "serve_deuce_near"
    case serveAdNear = "serve_ad_near"

    /// `[x0, x1] × [y0, y1]` in court metres.
    public var bounds: (x0: Double, x1: Double, y0: Double, y1: Double) {
        let w = Court.singlesHalfWidth, l = Court.halfLength, s = Court.serviceLineY
        switch self {
        case .singles: return (-w, w, -l, l)
        case .doubles: return (-Court.doublesHalfWidth, Court.doublesHalfWidth, -l, l)
        case .serveDeuceFar: return (-w, 0, 0, s)
        case .serveAdFar: return (0, w, 0, s)
        case .serveDeuceNear: return (0, w, -s, 0)
        case .serveAdNear: return (-w, 0, -s, 0)
        }
    }

    /// The service box a server on `half` must hit from `side`.
    public static func serviceBox(serverHalf half: CourtHalf, side: ServeSide) -> CallRegion {
        switch (half, side) {
        case (.near, .deuce): return .serveDeuceFar
        case (.near, .ad): return .serveAdFar
        case (.far, .deuce): return .serveDeuceNear
        case (.far, .ad): return .serveAdNear
        }
    }
}

/// Line-call rules (Swift twin of `call()` / `classify_depth_zone()`).
public enum LineCaller {
    /// Confidence gate: calls are only confident outside ±2σ_m (E9).
    public static let sigmaGate = 2.0

    /// Signed margin of a court point (positive = out): `max(x0 − X, X − x1, y0 − Y, Y − y1)`, plus whether an
    /// X edge (sideline / centre line, normal along X) governs.
    public static func margin(_ p: Point2, region: CallRegion = .singles) -> (marginM: Double, xEdge: Bool) {
        let b = region.bounds
        let wide = max(b.x0 - p.x, p.x - b.x1)
        let long = max(b.y0 - p.y, p.y - b.y1)
        return wide > long ? (wide, true) : (long, false)
    }

    /// `out` when margin > +2σ, `in` when margin < −2σ, otherwise `close`.
    public static func call(marginM: Double, sigmaM: Double) -> LineCall {
        guard marginM.isFinite, sigmaM.isFinite else { return .unknown }
        if marginM > sigmaGate * sigmaM { return .out }
        if marginM < -sigmaGate * sigmaM { return .in }
        return .close
    }

    /// Depth zone of a bounce on the full singles/doubles rectangle (never the service boxes, E2).
    ///
    /// - Parameters:
    ///   - p: Court position (metres), nil when there is no contact point.
    ///   - doubles: Use doubles sidelines.
    ///   - hitter: The hitter's half, if known; a bounce on the hitter's own half is `net`.
    public static func classifyDepthZone(_ p: Point2?, doubles: Bool = false, hitter: CourtHalf? = nil) -> DepthZone {
        guard let p, p.x.isFinite, p.y.isFinite else { return .unknown }
        if let hitter, (hitter == .near && p.y < 0) || (hitter == .far && p.y > 0) { return .net }
        let (m, xEdge) = margin(p, region: doubles ? .doubles : .singles)
        if m > 0 { return xEdge ? .outWide : .outLong }
        return abs(p.y) <= Court.serviceLineY ? .short : .deep
    }

    /// Judges a contact estimate: margin, σ along the governing edge normal, verdict and depth zone.
    ///
    /// - Parameters:
    ///   - c: Sub-frame contact, or nil (occluded / too few samples) → `unknown`.
    ///   - region: Rectangle to judge against (`singles` for every rally-mode shot).
    ///   - hitter: The hitter's half, if known.
    public static func judge(_ c: ContactEstimate?, region: CallRegion = .singles,
                             hitter: CourtHalf? = nil) -> LineCallResult {
        guard let c else {
            return LineCallResult(call: .unknown, marginM: .nan, sigmaM: .nan, depthZone: .unknown,
                                  court: Point2(.nan, .nan), tStar: .nan)
        }
        let (m, xEdge) = margin(c.court, region: region)
        let sigma = xEdge ? c.sigmaX : c.sigmaY
        let zone = classifyDepthZone(c.court, doubles: region == .doubles, hitter: hitter)
        return LineCallResult(call: call(marginM: m, sigmaM: sigma), marginM: m, sigmaM: sigma,
                              depthZone: zone, court: c.court, tStar: c.tStar)
    }
}

// MARK: - Linear algebra

enum LinearAlgebra {
    /// Solves the n×n system `A x = b` (row-major) by Gaussian elimination with partial pivoting.
    static func solve(_ a: [Double], _ b: [Double], n: Int) -> [Double]? {
        var m = a, r = b
        for col in 0..<n {
            var pivot = col
            for row in (col + 1)..<max(n, col + 1) where abs(m[n * row + col]) > abs(m[n * pivot + col]) { pivot = row }
            guard abs(m[n * pivot + col]) > 1e-14 else { return nil }
            if pivot != col {
                for k in 0..<n { m.swapAt(n * col + k, n * pivot + k) }
                r.swapAt(col, pivot)
            }
            for row in (col + 1)..<max(n, col + 1) {
                let f = m[n * row + col] / m[n * col + col]
                if f == 0 { continue }
                for k in col..<n { m[n * row + k] -= f * m[n * col + k] }
                r[row] -= f * r[col]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for row in stride(from: n - 1, through: 0, by: -1) {
            var s = r[row]
            for k in (row + 1)..<max(n, row + 1) { s -= m[n * row + k] * x[k] }
            x[row] = s / m[n * row + row]
        }
        return x
    }
}
