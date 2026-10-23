// Scorekeeper.swift — Swift twin of `dsa.physics.scorekeeper`: Rally Mode streak stats (default) and Match Mode
// tennis scoring (points / games / sets / tiebreak, deuce-ad server side, no-ad, undo).
import Foundation

/// Session type (matches `tennis_matches.session_type`).
public enum SessionMode: String, Codable, Sendable, CaseIterable {
    /// Cooperative hitting / drills: any hit starts a rally, play continues after an out ball.
    case rally
    /// Scored match: points, games, sets.
    case match
}

/// One of the two players (from the phone owner's perspective).
public enum Player: String, Codable, Sendable, CaseIterable {
    case me
    case opp

    /// The other player.
    public var other: Player { self == .me ? .opp : .me }
}

/// Which side of the centre mark the server stands on.
public enum ServeSide: String, Codable, Sendable {
    case deuce
    case ad
}

// MARK: - Rally Mode

/// One shot in a rally: the hit time plus the call/zone of the bounce it produced.
public struct RallyShot: Equatable, Codable, Sendable {
    /// Hit time (PTS seconds).
    public var tHit: Double
    /// Line call of this shot's bounce (`unknown` until/unless judged, e.g. volleys).
    public var call: LineCall
    /// Depth zone of this shot's bounce.
    public var depthZone: DepthZone

    /// Creates a shot.
    public init(tHit: Double, call: LineCall = .unknown, depthZone: DepthZone = .unknown) {
        self.tHit = tHit
        self.call = call
        self.depthZone = depthZone
    }
}

/// Streak metrics of one rally (matches `tennis_rallies` + Python `summarize_rally_streak()`).
public struct RallySummary: Equatable, Codable, Sendable {
    public var rallyIdx: Int
    /// Total hits.
    public var shotCount: Int
    /// Shots before the first `out` (`in`, `close` and `unknown` all count, as in Python `IN_CALLS`).
    public var inStreak: Int
    /// An `out` ball was played back within `RallyTracker.maxRallyGap` and the rally continued (E1).
    public var playedOnAfterOut: Bool
    /// 100 · deep / judged-zone shots, 1 decimal (nil when no shot has a zone).
    public var deepPct: Double?
    /// First hit and last activity (PTS seconds).
    public var startS: Double
    public var endS: Double
    /// Starred from the Watch or the phone.
    public var bookmarked: Bool
}

/// Pure rally statistics, shared by the live tracker and the fixture tests.
public enum RallyStats {
    /// Zones that count towards the deep-percentage denominator.
    static let judgedZones: Set<DepthZone> = [.deep, .short, .outLong, .outWide]

    /// Summarises a rally's shots.
    ///
    /// - Parameters:
    ///   - shots: Shots in hit order.
    ///   - rallyIdx: Index of the rally in the session.
    ///   - endS: Last activity time (defaults to the last hit).
    ///   - bookmarked: Whether the rally was starred.
    public static func summarize(_ shots: [RallyShot], rallyIdx: Int = 0, endS: Double? = nil,
                                 bookmarked: Bool = false) -> RallySummary {
        let streak = shots.firstIndex { $0.call == .out } ?? shots.count
        let playedOn = zip(shots, shots.dropFirst()).contains {
            $0.call == .out && $1.tHit - $0.tHit <= RallyTracker.maxRallyGap
        }
        let judged = shots.filter { judgedZones.contains($0.depthZone) }
        let deep = judged.filter { $0.depthZone == .deep }.count
        let pct = judged.isEmpty ? nil : (1000 * Double(deep) / Double(judged.count)).rounded(.toNearestOrEven) / 10
        return RallySummary(rallyIdx: rallyIdx, shotCount: shots.count, inStreak: streak, playedOnAfterOut: playedOn,
                            deepPct: pct, startS: shots.first?.tHit ?? 0, endS: endS ?? shots.last?.tHit ?? 0,
                            bookmarked: bookmarked)
    }
}

/// Live Rally Mode state: segments hits into rallies by the 3.5 s gap rule and keeps going through out balls.
public struct RallyTracker: Sendable {
    /// No ball activity for this long ends the rally (`MAX_RALLY_GAP_S`).
    public static let maxRallyGap = 3.5
    /// A milestone chime plays every this many shots.
    public static let milestoneEvery = 10

    /// What a new hit did.
    public struct HitOutcome: Equatable, Sendable {
        /// The previous rally, if this hit came after the gap and closed it.
        public var endedRally: RallySummary?
        /// Shot count when a milestone (10, 20, 30…) was reached.
        public var milestone: Int?
    }

    /// Shots of the live rally (empty between rallies).
    public private(set) var shots: [RallyShot] = []
    /// Index the live (or next) rally gets.
    public private(set) var rallyIdx = 0
    /// Last hit or bounce time.
    public private(set) var lastActivity: Double?
    /// Longest rally of the session, in shots.
    public private(set) var sessionBestStreak = 0
    /// Finished rallies.
    public private(set) var completed: [RallySummary] = []
    private var bookmarkLive = false

    /// Creates an empty tracker.
    public init() {}

    /// True while a rally is in progress.
    public var isLive: Bool { !shots.isEmpty }

    /// Live shot count (0 between rallies).
    public var shotCount: Int { shots.count }

    /// Live in-streak.
    public var inStreak: Int { RallyStats.summarize(shots).inStreak }

    /// Registers a racket hit. Starts a new rally after the gap (closing the old one); otherwise continues —
    /// including right after an `out` bounce (play-on-after-out, E1).
    public mutating func registerHit(at t: Double) -> HitOutcome {
        var ended: RallySummary?
        if isLive, let last = lastActivity, t - last > Self.maxRallyGap { ended = endRally() }
        shots.append(RallyShot(tHit: t))
        lastActivity = t
        sessionBestStreak = max(sessionBestStreak, shots.count)
        let milestone = shots.count % Self.milestoneEvery == 0 ? shots.count : nil
        return HitOutcome(endedRally: ended, milestone: milestone)
    }

    /// Attaches a judged bounce to the latest shot. Ignored between rallies.
    public mutating func registerBounce(call: LineCall, depthZone: DepthZone, at t: Double) {
        guard isLive else { return }
        shots[shots.count - 1].call = call
        shots[shots.count - 1].depthZone = depthZone
        lastActivity = t
    }

    /// Ends the live rally if nothing has happened for `maxRallyGap`.
    public mutating func tick(now: Double) -> RallySummary? {
        guard isLive, let last = lastActivity, now - last > Self.maxRallyGap else { return nil }
        return endRally()
    }

    /// Ends the live rally now (e.g. a match-mode point ended).
    @discardableResult
    public mutating func endRally() -> RallySummary? {
        guard isLive else { return nil }
        let summary = RallyStats.summarize(shots, rallyIdx: rallyIdx, endS: lastActivity, bookmarked: bookmarkLive)
        completed.append(summary)
        shots = []
        bookmarkLive = false
        rallyIdx += 1
        return summary
    }

    /// Stars the live rally, or the last finished one between rallies. Returns the starred rally index.
    @discardableResult
    public mutating func bookmark() -> Int? {
        if isLive {
            bookmarkLive = true
            return rallyIdx
        }
        guard !completed.isEmpty else { return nil }
        completed[completed.count - 1].bookmarked = true
        return completed[completed.count - 1].rallyIdx
    }
}

// MARK: - Match Mode

/// A me/opp pair of counters.
public struct ScorePair: Equatable, Codable, Sendable {
    public var me: Int
    public var opp: Int

    /// Creates a pair.
    public init(me: Int = 0, opp: Int = 0) {
        self.me = me
        self.opp = opp
    }

    /// Counter for `p`.
    public subscript(p: Player) -> Int {
        get { p == .me ? me : opp }
        set { if p == .me { me = newValue } else { opp = newValue } }
    }
}

/// Match format.
public struct MatchConfig: Equatable, Codable, Sendable {
    public var bestOf: Int
    /// Deciding point at deuce.
    public var noAd: Bool
    /// A 10-point match tiebreak replaces the final set (recorded as a 1–0 set).
    public var matchTiebreak: Bool
    public var firstServer: Player

    /// Creates a format (defaults: best of 3, advantage scoring, full final set, I serve first).
    public init(bestOf: Int = 3, noAd: Bool = false, matchTiebreak: Bool = false, firstServer: Player = .me) {
        self.bestOf = bestOf
        self.noAd = noAd
        self.matchTiebreak = matchTiebreak
        self.firstServer = firstServer
    }
}

/// Full match state.
public struct MatchScore: Equatable, Codable, Sendable {
    /// Point winner log ("M" for me, "O" for opp), matching Python `state["log"]`.
    public var log = ""
    /// Finished sets, games per player.
    public var sets: [ScorePair] = []
    /// Games in the current set.
    public var games = ScorePair()
    /// Points in the current game (or tiebreak).
    public var points = ScorePair()
    public var inTiebreak = false
    /// Points needed to win the current tiebreak (7, or 10 for a match tiebreak).
    public var tiebreakTo = MatchScorekeeper.tiebreakPoints
    /// Server of the current game (or of the current tiebreak point).
    public var server: Player
    /// Who served the first tiebreak point (serves second in the next set's rotation).
    public var tiebreakFirstServer: Player?
    public var winner: Player?
}

/// Discrepancy kind returned by `MatchScorekeeper.reconcile(observedSide:observedServer:)`.
public enum ScoreDiscrepancy: String, Codable, Sendable, Equatable {
    case missedPoint = "missed_point"
    case wrongServer = "wrong_server"
}

/// Visual serve-side / server check against the scorekeeper state.
public struct ScoreReconciliation: Equatable, Codable, Sendable {
    public var ok: Bool
    public var expectedSide: ServeSide
    public var expectedServer: Player
    public var suggestion: ScoreDiscrepancy?

    /// Creates a reconciliation result.
    public init(ok: Bool, expectedSide: ServeSide, expectedServer: Player, suggestion: ScoreDiscrepancy? = nil) {
        self.ok = ok
        self.expectedSide = expectedSide
        self.expectedServer = expectedServer
        self.suggestion = suggestion
    }
}

/// Match Mode state machine with undo (Swift twin of `apply()` / `expected_server_side()` / `undo()`).
public struct MatchScorekeeper: Sendable {
    /// Games needed to win a set (tiebreak at 6–6).
    public static let gamesPerSet = 6
    /// Points needed to win a tiebreak.
    public static let tiebreakPoints = 7
    /// Points needed to win a match tiebreak.
    public static let matchTiebreakPoints = 10

    public let config: MatchConfig
    public private(set) var score: MatchScore
    private var history: [MatchScore] = []

    /// Starts a match.
    public init(config: MatchConfig = MatchConfig()) {
        self.config = config
        score = MatchScore(server: config.firstServer)
    }

    /// Points played in the current game or tiebreak.
    private var pointsPlayed: Int { score.points.me + score.points.opp }

    /// Server's side for the next point: deuce after an even number of points in the game/tiebreak, ad after odd.
    public var serverSide: ServeSide { pointsPlayed % 2 == 0 ? .deuce : .ad }

    /// Records a point. Ignored after the match is over.
    public mutating func pointWon(by p: Player) {
        guard score.winner == nil else { return }
        history.append(score)
        score.log.append(p == .me ? "M" : "O")
        score.points[p] += 1
        if score.inTiebreak {
            let pts = score.points
            if pts[p] >= score.tiebreakTo && pts[p] - pts[p.other] >= 2 {
                score.games[p] += 1
                finishSet(winner: p, nextServer: (score.tiebreakFirstServer ?? score.server).other)
            } else if let first = score.tiebreakFirstServer {
                // Tiebreak rotation: point 0 by `first`, then two each, starting with the other player.
                score.server = ((pointsPlayed - 1) / 2) % 2 == 0 ? first.other : first
            }
            return
        }
        let won = score.points[p], lost = score.points[p.other]
        let gameOver = config.noAd ? won >= 4 : (won >= 4 && won - lost >= 2)
        guard gameOver else { return }
        score.points = ScorePair()
        score.games[p] += 1
        let g = score.games
        if g[p] >= Self.gamesPerSet && g[p] - g[p.other] >= 2 {
            finishSet(winner: p, nextServer: score.server.other)
        } else if g.me == Self.gamesPerSet && g.opp == Self.gamesPerSet {
            score.inTiebreak = true
            score.tiebreakTo = Self.tiebreakPoints
            score.server = score.server.other
            score.tiebreakFirstServer = score.server
        } else {
            score.server = score.server.other
        }
    }

    private mutating func finishSet(winner p: Player, nextServer: Player) {
        score.sets.append(score.games)
        score.games = ScorePair()
        score.points = ScorePair()
        score.inTiebreak = false
        score.tiebreakFirstServer = nil
        score.server = nextServer
        let need = config.bestOf / 2 + 1
        let sets = score.sets
        func won(_ q: Player) -> Int { sets.filter { $0[q] > $0[q.other] }.count }
        if won(p) == need {
            score.winner = p
        } else if config.matchTiebreak && won(.me) == need - 1 && won(.opp) == need - 1 {
            score.inTiebreak = true                     // 10-point match tiebreak instead of the final set
            score.tiebreakTo = Self.matchTiebreakPoints
            score.tiebreakFirstServer = nextServer
        }
    }

    /// Reverts the last point (Watch long-press). Returns false when there is nothing to undo.
    @discardableResult
    public mutating func undo() -> Bool {
        guard let last = history.popLast() else { return false }
        score = last
        return true
    }

    /// Checks the score against what the camera saw at the next serve: the serving side (from the server's
    /// position) and/or who serves (Swift twin of Python `scorekeeper.reconcile`).
    ///
    /// - Parameters:
    ///   - observedSide: Visually observed serving side (`deuce` or `ad`), if available.
    ///   - observedServer: Visually observed server (`me` or `opp`), if available.
    /// - Returns: Reconciliation result (`ok = false` with `.wrongServer` or `.missedPoint` on mismatch).
    public func reconcile(observedSide: ServeSide? = nil, observedServer: Player? = nil) -> ScoreReconciliation {
        let expSide = serverSide
        let expServer = score.server
        if let observedServer, observedServer != expServer {
            return ScoreReconciliation(ok: false, expectedSide: expSide, expectedServer: expServer, suggestion: .wrongServer)
        }
        if let observedSide, observedSide != expSide {
            return ScoreReconciliation(ok: false, expectedSide: expSide, expectedServer: expServer, suggestion: .missedPoint)
        }
        return ScoreReconciliation(ok: true, expectedSide: expSide, expectedServer: expServer, suggestion: nil)
    }

    /// Current game points, me first: "30-15", "40-40", "AD-40", "40-AD"; tiebreak "6-5".
    public var pointsText: String {
        let p = score.points
        if score.inTiebreak { return "\(p.me)-\(p.opp)" }
        let names = ["0", "15", "30", "40"]
        if p.me >= 3 && p.opp >= 3 && !config.noAd {
            if p.me == p.opp { return "40-40" }
            return p.me > p.opp ? "AD-40" : "40-AD"
        }
        return "\(names[min(p.me, 3)])-\(names[min(p.opp, 3)])"
    }

    /// Full formatted score string ("6-4 3-2 30-15"), matching Python `scorekeeper.format_score`.
    public var formattedScore: String {
        var parts = score.sets.map { "\($0.me)-\($0.opp)" }
        if score.winner == nil {
            parts.append("\(score.games.me)-\(score.games.opp)")
            parts.append(pointsText)
        }
        return parts.joined(separator: " ")
    }

    /// Short human display: "Deuce", "Ad Me", "Ad Opp", "Deciding Point", "TB 6-5", or the points text.
    public var display: String {
        if let w = score.winner { return w == .me ? "Match: Me" : "Match: Opp" }
        let p = score.points
        if score.inTiebreak { return "TB \(pointsText)" }
        if p.me >= 3 && p.opp >= 3 {
            if p.me == p.opp { return config.noAd ? "Deciding Point" : "Deuce" }
            return p.me > p.opp ? "Ad Me" : "Ad Opp"
        }
        return pointsText
    }
}
