// CourtGeometryTests.swift — geometry, parabola, line-call and scorekeeper tests for the pure CourtGeometry module.
// Synthetic camera matches Python `test_homography.py`: lens at (0, −15.5, 3.5) m looking at the net centre.
// Golden vectors shared with Python are read from `tennis-vision/tests/fixtures/*.json` when present.
import Foundation
import XCTest
@testable import CourtGeometry

final class CourtGeometryTests: XCTestCase {
    private let k = Intrinsics(fx: 1400, fy: 1400, cx: 960, cy: 540)
    private let pose = CameraPose.lookAt(eye: Point3(0, -15.5, 3.5), target: Point3(0, 0, 0))

    private func project(_ p: Point3) -> Point2 {
        guard let q = pose.project(p, intrinsics: k) else {
            XCTFail("point behind camera")
            return Point2(0, 0)
        }
        return q
    }

    private func calibration(netPosts: Bool = true) throws -> CourtCalibration {
        let corners = Court.cornerIndices.map { project(Point3(Court.points[$0].x, Court.points[$0].y, 0)) }
        let posts = netPosts ? Court.netPosts.map(project) : nil
        return try CourtCalibration.calibrate(corners: corners, netPosts: posts, intrinsics: k)
    }

    private func distance(_ a: Point2, _ b: Point2) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }

    // MARK: Homography & calibration

    func testDLTIsExactOnFourPointsAndLeastSquaresOnFourteen() throws {
        let image = Court.points.map { project(Point3($0.x, $0.y, 0)) }
        let h4 = try XCTUnwrap(Homography.fit(from: Array(image.prefix(4)), to: Array(Court.points.prefix(4))))
        let h14 = try XCTUnwrap(Homography.fit(from: image, to: Court.points))
        for (px, xy) in zip(image, Court.points) {
            XCTAssertLessThan(distance(try XCTUnwrap(h4.apply(px)), xy), 1e-6)
            XCTAssertLessThan(distance(try XCTUnwrap(h14.apply(px)), xy), 1e-6)
        }
        let inv = try XCTUnwrap(h14.inverse)
        XCTAssertLessThan(distance(try XCTUnwrap(inv.apply(Court.points[12])), image[12]), 1e-6)
    }

    func testHomographyRejectsPointsAboveTheHorizon() throws {
        let cal = try calibration()
        // A pixel near the top of the frame sees the sky (above the vanishing line of the court plane).
        XCTAssertNil(cal.h0.apply(Point2(960, 0)))
        XCTAssertNotNil(cal.h0.apply(project(Point3(0, 0, 0))))
    }

    func testPoseRecoveryAndCameraHeight() throws {
        let cal = try calibration()
        XCTAssertLessThan(cal.reprojectionRMS, 1e-3)
        XCTAssertEqual(try XCTUnwrap(cal.cameraHeight), 3.5, accuracy: 1e-3)
        let c = try XCTUnwrap(cal.pose).center
        XCTAssertEqual(c.y, -15.5, accuracy: 1e-3)
        XCTAssertEqual(cal.warnings, [])
    }

    func testBallRadiusPlaneRemovesFarBaselineParallax() throws {
        let cal = try calibration()
        let truth = Point2(4.0, 11.8)
        let pixel = project(Point3(truth.x, truth.y, Court.ballRadius))
        let viaHr = try XCTUnwrap(cal.hr.apply(pixel))
        let viaH0 = try XCTUnwrap(cal.h0.apply(pixel))
        XCTAssertLessThan(distance(viaHr, truth), 0.01, "Hr must land within 1 cm")
        XCTAssertGreaterThan(distance(viaH0, truth), 0.15, "H0 shows the ~25 cm ball-radius parallax")
    }

    func testCalibrationValidation() {
        let good = [Point2(700, 300), Point2(1200, 300), Point2(200, 900), Point2(1700, 900)]
        XCTAssertNoThrow(try CourtCalibration.validate(corners: good))
        XCTAssertThrowsError(try CourtCalibration.validate(corners: Array(good.prefix(3)))) {
            XCTAssertEqual($0 as? CalibrationError, .wrongPointCount)
        }
        let swapped = [good[1], good[0], good[2], good[3]]
        XCTAssertThrowsError(try CourtCalibration.validate(corners: swapped)) {
            XCTAssertEqual($0 as? CalibrationError, .badOrder)
        }
        let concave = [Point2(700, 300), Point2(1200, 300), Point2(200, 900), Point2(800, 320)]
        XCTAssertThrowsError(try CourtCalibration.validate(corners: concave))
        let tiny = [Point2(100, 100), Point2(110, 100), Point2(100, 110), Point2(110, 110)]
        XCTAssertThrowsError(try CourtCalibration.validate(corners: tiny)) {
            XCTAssertEqual($0 as? CalibrationError, .degenerate)
        }
    }

    func testLowCameraAndMissingIntrinsicsWarn() throws {
        let lowPose = CameraPose.lookAt(eye: Point3(0, -14, 1.6), target: Point3(0, 0, 0))
        let corners = Court.cornerIndices.map { lowPose.project(Point3(Court.points[$0].x, Court.points[$0].y, 0), intrinsics: k)! }
        let posts = Court.netPosts.map { lowPose.project($0, intrinsics: k)! }
        let low = try CourtCalibration.calibrate(corners: corners, netPosts: posts, intrinsics: k)
        guard case .cameraTooLow(let h)? = low.warnings.first else { return XCTFail("expected low-camera warning") }
        XCTAssertEqual(h, 1.6, accuracy: 1e-3)

        let noK = try CourtCalibration.calibrate(corners: corners, intrinsics: nil)
        XCTAssertEqual(noK.warnings, [.noParallaxCorrection])
        XCTAssertEqual(noK.hr, noK.h0)
    }

    func testDriftShiftRecalibrates() throws {
        let cal = try calibration()
        let offsets = Array(repeating: Point2(4, -2), count: 4)
        let moved = try cal.shifted(by: offsets)
        let p = project(Point3(1, 5, Court.ballRadius))
        let shiftedPixel = Point2(p.x + 4, p.y - 2)
        XCTAssertLessThan(distance(try XCTUnwrap(moved.hr.apply(shiftedPixel)), Point2(1, 5)), 0.03)
    }

    // MARK: Ball kinematics

    /// A drag-free bounce at `b` and `tb`, sampled at 60 fps PTS.
    private func bounceTrack(b: Point3 = Point3(1.0, 9.0, Court.ballRadius), tb: Double = 0.5123,
                             vIn: Point3 = Point3(0.5, 20, -6), vOut: Point3 = Point3(0.45, 14, 4))
        -> (pre: [BallSample], post: [BallSample]) {
        func at(_ t: Double) -> BallSample {
            let d = t - tb
            let v = d < 0 ? vIn : vOut
            let p = Point3(b.x + v.x * d, b.y + v.y * d, b.z + v.z * d - 0.5 * 9.81 * d * d)
            let px = project(p)
            return BallSample(t: t, u: px.x, v: px.y)
        }
        let frames = (24...37).map { Double($0) / 60 }
        return (frames.filter { $0 < tb }.map(at), frames.filter { $0 > tb }.map(at))
    }

    func testSubFrameBounceTimeAndContactPoint() throws {
        let cal = try calibration()
        let track = bounceTrack()
        let c = try XCTUnwrap(BallKinematics.contactPoint(pre: track.pre, post: track.post, hr: cal.hr))
        XCTAssertEqual(c.tStar, 0.5123, accuracy: 0.002)
        XCTAssertLessThan(distance(c.court, Point2(1.0, 9.0)), 0.05)
        XCTAssertEqual(c.samplesPre, 4)
        XCTAssertEqual(c.samplesPost, 4)
        XCTAssertGreaterThan(c.sigmaY, c.sigmaX, "depth is less certain than width from behind the baseline")
    }

    func testOcclusionDoublesSigmaThenGivesUnknown() throws {
        let cal = try calibration()
        let track = bounceTrack()
        let full = try XCTUnwrap(BallKinematics.contactPoint(pre: track.pre, post: track.post, hr: cal.hr))
        let three = try XCTUnwrap(BallKinematics.contactPoint(pre: track.pre, post: Array(track.post.prefix(3)), hr: cal.hr))
        XCTAssertGreaterThan(three.sigmaY, 1.9 * full.sigmaY)
        XCTAssertNil(BallKinematics.contactPoint(pre: track.pre, post: Array(track.post.prefix(2)), hr: cal.hr))
        XCTAssertEqual(LineCaller.judge(nil).call, .unknown)
        XCTAssertEqual(LineCaller.judge(nil).depthZone, .unknown)
    }

    func testCourtYVelocitySignSeparatesHitsFromBounces() throws {
        let cal = try calibration()
        let bounce = bounceTrack()
        XCTAssertEqual(BallKinematics.classifyEvent(pre: bounce.pre, post: bounce.post, h0: cal.h0), .bounce)
        // Near-player groundstroke at 0.9 m: court-Y velocity flips from −22 to +25 m/s.
        let hit = bounceTrack(b: Point3(0.5, -11.0, 0.9), vIn: Point3(0, -22, -2), vOut: Point3(0.3, 25, 3))
        XCTAssertEqual(BallKinematics.classifyEvent(pre: hit.pre, post: hit.post, h0: cal.h0), .hit)
        // Far-player groundstroke at 0.9 m: the reversal is mostly along the camera ray (weak image cusp), so the
        // racket sound confirms it; the ground projection lands ~9 m beyond the baseline → hit.
        let farHit = bounceTrack(b: Point3(0.5, 11.5, 0.9), vIn: Point3(0, 22, -2), vOut: Point3(0.3, -25, 3))
        XCTAssertFalse(BallKinematics.isCusp(pre: farHit.pre, post: farHit.post))
        XCTAssertEqual(BallKinematics.classifyEvent(pre: farHit.pre, post: farHit.post, h0: cal.h0, racketSound: true), .hit)
        XCTAssertEqual(BallKinematics.classifyEvent(pre: farHit.pre, post: farHit.post, h0: cal.h0), .unknown)
        let still = (0..<8).map { BallSample(t: Double($0) / 60, u: 900, v: 700) }
        XCTAssertEqual(BallKinematics.classifyEvent(pre: Array(still.prefix(4)), post: Array(still.suffix(4)), h0: cal.h0),
                       .unknown)
        // A smooth far-court flight apex is a v extremum too, but no velocity discontinuity: not an event.
        let apex = bounceTrack(b: Point3(1, 6, 2.5), vIn: Point3(0.5, 15, 0), vOut: Point3(0.5, 15, 0))
        XCTAssertEqual(BallKinematics.classifyEvent(pre: apex.pre, post: apex.post, h0: cal.h0), .unknown)
        XCTAssertEqual(BallKinematics.classifyEvent(pre: apex.pre, post: apex.post, h0: cal.h0, racketSound: true), .unknown)
        // Far-court out-long bounce (>2 m past baseline) still has a bounce v-turn and is classified as .bounce.
        let outLongBounce = bounceTrack(b: Point3(0.5, 14.5, Court.ballRadius), vIn: Point3(0.2, 22, -7), vOut: Point3(0.2, 15, 4.5))
        XCTAssertEqual(BallKinematics.classifyEvent(pre: outLongBounce.pre, post: outLongBounce.post, h0: cal.h0), .bounce)
        // Far-court inside-baseline hit / volley returning toward the near court is classified as .hit.
        let farInCourtHit = bounceTrack(b: Point3(0.5, 7.0, 1.0), vIn: Point3(0, 16, -1), vOut: Point3(0, -22, 1.5))
        XCTAssertEqual(BallKinematics.classifyEvent(pre: farInCourtHit.pre, post: farInCourtHit.post, h0: cal.h0, racketSound: true), .hit)
        // Elevated near-baseline serve (Z = 2.7 m, downward vOut.z < 0) is classified as .hit and attributed to .near.
        let nearServe = bounceTrack(b: Point3(0.5, -11.8, 2.7), vIn: Point3(0, 0.2, -1.5), vOut: Point3(0.4, 28, -3.5))
        XCTAssertEqual(BallKinematics.classifyEvent(pre: nearServe.pre, post: nearServe.post, h0: cal.h0, racketSound: true), .hit)
        let servePx = Point2(nearServe.pre.last!.u, nearServe.pre.last!.v)
        XCTAssertEqual(BallKinematics.inferHitterHalf(at: servePx, post: nearServe.post, calibration: cal), .near)
        // Uncalibrated image-space event classification distinguishes bounces from hits and rejects smooth arcs / still blobs.
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: bounce.pre, post: bounce.post, bouncesSinceHit: 0), .bounce)
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: bounce.pre, post: bounce.post, bouncesSinceHit: 1), .hit)
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: hit.pre, post: hit.post, bouncesSinceHit: 0), .hit)
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: farHit.pre, post: farHit.post, racketSound: true), .hit)
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: Array(still.prefix(4)), post: Array(still.suffix(4))), .unknown)
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: apex.pre, post: apex.post), .unknown)
        // A downward-to-upward image turn that fails the 0.6 bounce restitution threshold returns .unknown on first bounce,
        // while after a bounce (bouncesSinceHit >= 1) it is classified as a near-player .hit.
        let lowRestitutionPre = (0..<4).map { BallSample(t: Double($0) / 60.0, u: 960.0, v: 400.0 + Double($0) * 5.0) }
        let lowRestitutionPost = (4..<8).map { BallSample(t: Double($0) / 60.0, u: 960.0, v: 415.0 - Double($0 - 3) * 1.5) }
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: lowRestitutionPre, post: lowRestitutionPost, bouncesSinceHit: 0), .unknown)
        XCTAssertEqual(BallKinematics.classifyImageEvent(pre: lowRestitutionPre, post: lowRestitutionPost, bouncesSinceHit: 1), .hit)
    }

    func testCandidateSampleIsAssignedToTheBetterFittingArc() throws {
        let cal = try calibration()
        let track = bounceTrack()
        let all = track.pre + track.post
        let lowest = try XCTUnwrap(all.indices.max { all[$0].v < all[$1].v })
        let c = try XCTUnwrap(BallKinematics.contactPoint(around: lowest, in: all, hr: cal.hr))
        XCTAssertEqual(c.tStar, 0.5123, accuracy: 0.002)
        XCTAssertLessThan(distance(c.court, Point2(1.0, 9.0)), 0.05)
        // With only 3 post-samples after `lowest`, E8 doubles sigma even via contactPoint(around:).
        let shortWindow = Array(all[...(lowest + 3)])
        let shortC = try XCTUnwrap(BallKinematics.contactPoint(around: lowest, in: shortWindow, hr: cal.hr))
        XCTAssertGreaterThan(shortC.sigmaY, 1.9 * c.sigmaY)
    }

    func testQuadraticFitIsExact() throws {
        let t = [0.0, 0.1, 0.2, 0.3]
        let fit = try XCTUnwrap(Polynomial2.fit(t: t, y: t.map { 3 * $0 * $0 - 2 * $0 + 1 }, t0: 0))
        XCTAssertEqual(fit.a, 3, accuracy: 1e-9)
        XCTAssertEqual(fit.b, -2, accuracy: 1e-9)
        XCTAssertEqual(fit.c, 1, accuracy: 1e-9)
        XCTAssertEqual(fit.rms, 0, accuracy: 1e-9)
    }

    // MARK: Line calls & depth zones

    func testTwoSigmaCallGate() {
        XCTAssertEqual(LineCaller.call(marginM: 0.05, sigmaM: 0.02), .out)
        XCTAssertEqual(LineCaller.call(marginM: 0.03, sigmaM: 0.02), .close)
        XCTAssertEqual(LineCaller.call(marginM: -0.03, sigmaM: 0.02), .close)
        XCTAssertEqual(LineCaller.call(marginM: -0.05, sigmaM: 0.02), .in)
        XCTAssertEqual(LineCaller.call(marginM: .nan, sigmaM: 0.02), .unknown)
    }

    func testMarginsAndRegions() {
        let long = LineCaller.margin(Point2(1, 12.0))
        XCTAssertEqual(long.marginM, 0.115, accuracy: 1e-9)
        XCTAssertFalse(long.xEdge)
        let wide = LineCaller.margin(Point2(-4.3, 3))
        XCTAssertEqual(wide.marginM, 0.185, accuracy: 1e-9)
        XCTAssertTrue(wide.xEdge)
        XCTAssertEqual(LineCaller.margin(Point2(-4.3, 3), region: .doubles).marginM, -1.185, accuracy: 1e-9)
        // Serve into the far deuce box: crossing the 2.5 cm centre-line outer edge at X = 0.2 m is out by 0.175 m.
        XCTAssertEqual(LineCaller.margin(Point2(0.2, 3), region: .serveDeuceFar).marginM, 0.175, accuracy: 1e-9)
        XCTAssertEqual(CallRegion.serviceBox(serverHalf: .near, side: .deuce), .serveDeuceFar)
        XCTAssertEqual(CallRegion.serviceBox(serverHalf: .far, side: .ad), .serveAdNear)
        // Netted bounce (same side as hitter) is always judged .out with .net depthZone.
        let netted = ContactEstimate(tStar: 1, pixel: Point2(0, 0), court: Point2(0, -3), sigmaX: 0.02, sigmaY: 0.02,
                                     samplesPre: 4, samplesPost: 4)
        let nettedRes = LineCaller.judge(netted, region: .singles, hitter: .near)
        XCTAssertEqual(nettedRes.call, .out)
        XCTAssertEqual(nettedRes.depthZone, .net)
        XCTAssertEqual(nettedRes.marginM, 3.0, accuracy: 1e-9)
    }

    func testDepthZones() {
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(0, 9)), .deep)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(0, -9)), .deep)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(2, 6.4)), .short)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(2, -3)), .short)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(0, 12.3)), .outLong)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(4.6, 8)), .outWide)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(4.6, 8), doubles: true), .deep)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(0, -3), hitter: .near), .net)
        XCTAssertEqual(LineCaller.classifyDepthZone(Point2(0, 3), hitter: .near), .short)
        XCTAssertEqual(LineCaller.classifyDepthZone(nil), .unknown)
    }

    func testJudgeUsesSigmaAlongTheGoverningEdge() {
        let c = ContactEstimate(tStar: 1, pixel: Point2(0, 0), court: Point2(1, 11.95), sigmaX: 0.001, sigmaY: 0.05,
                                samplesPre: 4, samplesPost: 4)
        let r = LineCaller.judge(c)
        XCTAssertEqual(r.call, .close)
        XCTAssertEqual(r.sigmaM, 0.05)
        XCTAssertEqual(r.depthZone, .outLong)
        XCTAssertEqual(r.marginM, 0.065, accuracy: 1e-9)
    }

    // MARK: Rally Mode

    func testRallyPlaysOnAfterOutAndTracksStreaks() {
        var r = RallyTracker()
        _ = r.registerHit(at: 0)
        r.registerBounce(call: .in, depthZone: .deep, at: 0.8)
        _ = r.registerHit(at: 1.6)
        r.registerBounce(call: .close, depthZone: .short, at: 2.3)
        _ = r.registerHit(at: 3.0)
        r.registerBounce(call: .out, depthZone: .outLong, at: 3.7)
        let next = r.registerHit(at: 4.4)                    // played back on the bounce: rally continues (E1)
        XCTAssertNil(next.endedRally)
        r.registerBounce(call: .in, depthZone: .deep, at: 5.0)
        XCTAssertEqual(r.shotCount, 4)
        XCTAssertEqual(r.inStreak, 2)
        XCTAssertNil(r.tick(now: 7.0))
        let ended = r.tick(now: 9.0)
        XCTAssertEqual(ended, RallySummary(rallyIdx: 0, shotCount: 4, inStreak: 2, playedOnAfterOut: true,
                                           deepPct: 50.0, startS: 0, endS: 5.0, bookmarked: false))
        XCTAssertFalse(r.isLive)
        XCTAssertEqual(r.sessionBestStreak, 4)
    }

    func testRallyGapStartsNewRallyAndMilestones() {
        var r = RallyTracker()
        var milestones: [Int] = []
        for i in 0..<20 {
            if let m = r.registerHit(at: Double(i) * 1.2).milestone { milestones.append(m) }
        }
        XCTAssertEqual(milestones, [10, 20])
        XCTAssertEqual(r.bookmark(), 0)
        let outcome = r.registerHit(at: 30)
        XCTAssertEqual(outcome.endedRally?.shotCount, 20)
        XCTAssertEqual(outcome.endedRally?.bookmarked, true)
        XCTAssertEqual(r.rallyIdx, 1)
        XCTAssertEqual(r.shotCount, 1)
        XCTAssertEqual(r.sessionBestStreak, 20)
    }

    func testRallyStatsUnknownKeepsStreakAndDeepPctRounds() {
        let shots = [RallyShot(tHit: 0, call: .in, depthZone: .deep), RallyShot(tHit: 1, call: .unknown),
                     RallyShot(tHit: 2, call: .in, depthZone: .short), RallyShot(tHit: 3, call: .in, depthZone: .short),
                     RallyShot(tHit: 4, call: .out, depthZone: .outWide)]
        let s = RallyStats.summarize(shots)
        XCTAssertEqual(s.inStreak, 4)
        XCTAssertFalse(s.playedOnAfterOut)
        let late = RallyStats.summarize([RallyShot(tHit: 0, call: .out), RallyShot(tHit: 4.0, call: .in)])
        XCTAssertFalse(late.playedOnAfterOut, "an out returned after more than 3.5 s is not played on")
        XCTAssertEqual(s.deepPct, 25.0)
        XCTAssertNil(RallyStats.summarize([RallyShot(tHit: 0)]).deepPct)
        XCTAssertEqual(RallyStats.summarize((0..<3).map { RallyShot(tHit: Double($0), call: .in, depthZone: $0 == 0 ? .deep : .short) }).deepPct, 33.3)
    }

    // MARK: Match Mode

    private func play(_ k: inout MatchScorekeeper, _ points: String) {
        for c in points { k.pointWon(by: c == "M" ? .me : .opp) }
    }

    func testGameDeuceAdvantageAndServerSide() {
        var k = MatchScorekeeper()
        XCTAssertEqual(k.serverSide, .deuce)
        play(&k, "MO")
        XCTAssertEqual(k.pointsText, "15-15")
        XCTAssertEqual(k.serverSide, .deuce)
        play(&k, "M")
        XCTAssertEqual(k.serverSide, .ad)
        play(&k, "OMO")
        XCTAssertEqual(k.pointsText, "40-40")
        XCTAssertEqual(k.display, "Deuce")
        play(&k, "M")
        XCTAssertEqual(k.pointsText, "AD-40")
        XCTAssertEqual(k.display, "Ad Me")
        XCTAssertEqual(k.serverSide, .ad)
        play(&k, "O")
        play(&k, "O")
        XCTAssertEqual(k.pointsText, "40-AD")
        play(&k, "O")
        XCTAssertEqual(k.score.games, ScorePair(me: 0, opp: 1))
        XCTAssertEqual(k.score.server, .opp)
        XCTAssertEqual(k.pointsText, "0-0")
    }

    func testNoAdDecidingPoint() {
        var k = MatchScorekeeper(config: MatchConfig(noAd: true))
        play(&k, "MMMOOO")
        XCTAssertEqual(k.display, "Deciding Point")
        play(&k, "O")
        XCTAssertEqual(k.score.games, ScorePair(me: 0, opp: 1))
    }

    func testSetTiebreakRotationAndMatch() {
        var k = MatchScorekeeper(config: MatchConfig(bestOf: 3, firstServer: .me))
        play(&k, String(repeating: "MMMM", count: 6))          // 6-0
        XCTAssertEqual(k.score.sets, [ScorePair(me: 6, opp: 0)])
        XCTAssertEqual(k.score.server, .me, "6 games alternate me/opp, so I serve set 2's first game")
        for _ in 0..<6 { play(&k, "MMMM"); play(&k, "OOOO") }  // 6-6
        XCTAssertTrue(k.score.inTiebreak)
        let first = k.score.server
        var servers: [Player] = []
        for c in "MOMOMOMOMO" {                                // 5-5 in the tiebreak
            servers.append(k.score.server)
            k.pointWon(by: c == "M" ? .me : .opp)
        }
        XCTAssertEqual(servers, [first, first.other, first.other, first, first, first.other, first.other, first, first,
                                 first.other])
        XCTAssertEqual(k.pointsText, "5-5")
        XCTAssertEqual(k.display, "TB 5-5")
        play(&k, "MM")
        XCTAssertEqual(k.score.winner, .me)
        XCTAssertEqual(k.score.sets, [ScorePair(me: 6, opp: 0), ScorePair(me: 7, opp: 6)])
        k.pointWon(by: .opp)
        XCTAssertEqual(k.score.sets.count, 2, "points after the match are ignored")
    }

    func testTiebreakWinnerHandsServeToTheReceiverOfTheFirstTiebreakPoint() {
        var k = MatchScorekeeper()
        for _ in 0..<6 { play(&k, "MMMM"); play(&k, "OOOO") }
        let first = k.score.server
        play(&k, "MMMMMMM")
        XCTAssertEqual(k.score.sets, [ScorePair(me: 7, opp: 6)])
        XCTAssertEqual(k.score.server, first.other)
        XCTAssertNil(k.score.winner)
    }

    func testMatchTiebreakReplacesFinalSet() {
        var k = MatchScorekeeper(config: MatchConfig(matchTiebreak: true))
        play(&k, String(repeating: "M", count: 24) + String(repeating: "O", count: 24))
        XCTAssertTrue(k.score.inTiebreak)
        XCTAssertEqual(k.score.tiebreakTo, 10)
        play(&k, String(repeating: "MO", count: 6) + "MM")     // 6-6 → 8-6 is not enough at 10
        XCTAssertNil(k.score.winner)
        play(&k, "MM")
        XCTAssertEqual(k.score.winner, .me)
        XCTAssertEqual(k.score.sets.last, ScorePair(me: 1, opp: 0))
    }

    func testUndo() {
        var k = MatchScorekeeper()
        XCTAssertFalse(k.undo())
        play(&k, "MMMM")
        XCTAssertEqual(k.score.games.me, 1)
        XCTAssertTrue(k.undo())
        XCTAssertEqual(k.score.games.me, 0)
        XCTAssertEqual(k.pointsText, "40-0")
        XCTAssertEqual(k.score.server, .me)
        XCTAssertEqual(k.reconcile(observedSide: .ad, observedServer: .me),
                       ScoreReconciliation(ok: true, expectedSide: .ad, expectedServer: .me, suggestion: nil))
        XCTAssertEqual(k.reconcile(observedSide: .deuce, observedServer: .me).suggestion, .missedPoint)
        XCTAssertEqual(k.reconcile(observedSide: .ad, observedServer: .opp).suggestion, .wrongServer)
    }

    // MARK: Watch protocol

    func testWatchMessagesRoundTrip() {
        let s = WatchState(mode: .match, shotCount: 3, inStreak: 2, sessionBest: 17, setsLine: "6-4", pointsLine: "Deuce",
                           serverSide: .ad, isLive: true)
        XCTAssertEqual(WatchState(message: s.message), s)
        XCTAssertEqual(WatchCommand(message: WatchCommand.undo.message), .undo)
        XCTAssertEqual(WatchCommand(message: WatchCommand.toggleRally.message), .toggleRally)
        for cmd in WatchCommand.allCases {
            XCTAssertEqual(WatchCommand(message: cmd.message), cmd)
        }
        XCTAssertNil(WatchCommand(message: ["cmd": "nope"]))
    }

    // MARK: Shared golden fixtures (written by physics-backend)

    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("tests/fixtures")

    private func fixture(_ name: String) throws -> [String: Any] {
        let url = Self.fixtures.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("\(name) not generated yet") }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func num(_ any: Any?) -> Double? { (any as? NSNumber)?.doubleValue }

    func testLinecallFixtureCases() throws {
        let root = try fixture("linecall_vectors.json")
        for case let c as [String: Any] in root["cases"] as? [Any] ?? [] {
            let name = c["name"] as? String ?? "?"
            let xy = (c["xy"] as? [Any])?.compactMap(num)
            let sigma = num(c["sigma_m"]) ?? 0
            let region = try XCTUnwrap(CallRegion(rawValue: c["region"] as? String ?? ""), name)
            let expect = try XCTUnwrap(c["expect"] as? [String: Any], name)
            let doubles = c["doubles"] as? Bool ?? (region == .doubles)
            let hitter = CourtHalf(rawValue: c["hitter"] as? String ?? "")
            guard let xy, xy.count == 2 else {
                XCTAssertEqual(LineCaller.judge(nil).call.rawValue, expect["call"] as? String, name)
                XCTAssertEqual(LineCaller.classifyDepthZone(nil).rawValue, expect["depth_zone"] as? String, name)
                continue
            }
            let p = Point2(xy[0], xy[1])
            let m = LineCaller.margin(p, region: region, hitter: hitter).marginM
            let zone = LineCaller.classifyDepthZone(p, doubles: doubles, hitter: hitter)
            let verdict = zone == .net ? LineCall.out : LineCaller.call(marginM: m, sigmaM: sigma)
            XCTAssertEqual(verdict.rawValue, expect["call"] as? String, name)
            if let em = num(expect["margin_m"]) { XCTAssertEqual(m, em, accuracy: 1e-6, name) }
            if let expectedZone = expect["depth_zone"] as? String {
                XCTAssertEqual(zone.rawValue, expectedZone, name)
            }
        }
        for case let h as [String: Any] in root["homography"] as? [Any] ?? [] {
            let name = h["name"] as? String ?? "?"
            let flat: [Double] = ((h["H"] as? [Any]) ?? []).flatMap { ($0 as? [Any])?.compactMap(num) ?? [num($0)].compactMap { $0 } }
            let uv = try XCTUnwrap((h["uv"] as? [Any])?.compactMap(num), name)
            let xy = try XCTUnwrap((h["xy"] as? [Any])?.compactMap(num), name)
            let out = try XCTUnwrap(Homography(matrix: Mat3(flat)).apply(Point2(uv[0], uv[1])) ??
                                    Homography(matrix: Mat3(flat), wSign: -1).apply(Point2(uv[0], uv[1])), name)
            XCTAssertEqual(out.x, xy[0], accuracy: 1e-6, name)
            XCTAssertEqual(out.y, xy[1], accuracy: 1e-6, name)
        }
        for case let s as [String: Any] in root["subframe"] as? [Any] ?? [] {
            let name = s["name"] as? String ?? "?"
            func samples(_ key: String) -> [BallSample] {
                ((s[key] as? [Any]) ?? []).compactMap { ($0 as? [Any])?.compactMap(num) }
                    .filter { $0.count == 3 }.map { BallSample(t: $0[0], u: $0[1], v: $0[2]) }
            }
            let identity = Homography(matrix: .identity)
            let c = try XCTUnwrap(BallKinematics.contactPoint(pre: samples("pre"), post: samples("post"), hr: identity), name)
            XCTAssertEqual(c.tStar, try XCTUnwrap(num(s["t_star"]), name), accuracy: 1e-4, name)
            let uv = try XCTUnwrap((s["uv_star"] as? [Any])?.compactMap(num), name)
            XCTAssertEqual(c.pixel.x, uv[0], accuracy: 0.05, name)
            XCTAssertEqual(c.pixel.y, uv[1], accuracy: 0.05, name)
        }
    }

    func testScoreFixtureCases() throws {
        let root = try fixture("score_vectors.json")
        for case let c as [String: Any] in root["cases"] as? [Any] ?? [] {
            let name = c["name"] as? String ?? "?"
            let cfg = c["config"] as? [String: Any] ?? [:]
            var k = MatchScorekeeper(config: MatchConfig(
                bestOf: (cfg["best_of"] as? NSNumber)?.intValue ?? 3, noAd: cfg["no_ad"] as? Bool ?? false,
                matchTiebreak: cfg["match_tiebreak"] as? Bool ?? false,
                firstServer: Player(rawValue: cfg["first_server"] as? String ?? "me") ?? .me))
            play(&k, c["points"] as? String ?? "")
            let e = try XCTUnwrap(c["expect"] as? [String: Any], name)
            let sets = ((e["sets"] as? [Any]) ?? []).compactMap { ($0 as? [Any])?.compactMap(num) }
            XCTAssertEqual(k.score.sets.map { [Double($0.me), Double($0.opp)] }, sets, name)
            if let g = (e["games"] as? [Any])?.compactMap(num) {
                XCTAssertEqual([Double(k.score.games.me), Double(k.score.games.opp)], g, name)
            }
            if let p = e["points"] as? String { XCTAssertEqual(k.pointsText, p, name) }
            if let s = e["server"] as? String { XCTAssertEqual(k.score.server.rawValue, s, name) }
            if let side = e["side"] as? String { XCTAssertEqual(k.serverSide.rawValue, side, name) }
            XCTAssertEqual(k.score.winner?.rawValue, e["winner"] as? String, name)
        }
        for case let r as [String: Any] in root["rally"] as? [Any] ?? [] {
            let name = r["name"] as? String ?? "?"
            let shots = ((r["shots"] as? [Any]) ?? []).compactMap { $0 as? [String: Any] }.map {
                RallyShot(tHit: num($0["t_hit_s"]) ?? 0, call: LineCall(rawValue: $0["call"] as? String ?? "") ?? .unknown,
                          depthZone: DepthZone(rawValue: $0["depth_zone"] as? String ?? "") ?? .unknown)
            }
            let s = RallyStats.summarize(shots)
            let e = try XCTUnwrap(r["expect"] as? [String: Any], name)
            XCTAssertEqual(Double(s.shotCount), num(e["shot_count"]), name)
            XCTAssertEqual(Double(s.inStreak), num(e["in_streak"]), name)
            XCTAssertEqual(s.playedOnAfterOut, e["played_on_after_out"] as? Bool, name)
            XCTAssertEqual(s.deepPct ?? 0, num(e["deep_pct"]) ?? 0, accuracy: 1e-9, name)
        }
    }
}
