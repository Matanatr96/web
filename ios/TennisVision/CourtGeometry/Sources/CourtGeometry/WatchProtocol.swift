// WatchProtocol.swift — the WatchConnectivity contract shared by the iPhone and Apple Watch apps, kept in the
// pure module so both targets (and the tests) agree on keys and payloads.
import Foundation

/// A command the Watch sends to the phone (`WCSession.sendMessage`).
public enum WatchCommand: String, Codable, Sendable, CaseIterable {
    /// Star / bookmark the current moment in the recording.
    case bookmark
    /// Match Mode: I won the point.
    case pointMe
    /// Match Mode: my opponent won the point.
    case pointOpp
    /// Match Mode: undo the last point (long press or 1-tap Undo button).
    case undo
    /// Start or stop session recording on the phone.
    case toggleRally

    /// Message dictionary key carrying the raw command.
    public static let key = "cmd"

    /// The `WCSession` message for this command.
    public var message: [String: Any] { [Self.key: rawValue] }

    /// Parses a received message.
    public init?(message: [String: Any]) {
        guard let raw = message[Self.key] as? String, let cmd = WatchCommand(rawValue: raw) else { return nil }
        self = cmd
    }
}

/// What the phone shows on the Watch (`WCSession.updateApplicationContext` + live `sendMessage`).
public struct WatchState: Equatable, Codable, Sendable {
    public var mode: SessionMode
    /// Rally Mode: elapsed recording seconds or shot counter.
    public var shotCount: Int
    /// Rally Mode: bookmarked moments count in the current recording.
    public var inStreak: Int
    /// Rally Mode: total recorded sessions or longest rally.
    public var sessionBest: Int
    /// Match Mode: e.g. "6-4 3-2".
    public var setsLine: String
    /// Match Mode: e.g. "Deuce" / "30-15".
    public var pointsLine: String
    /// Match Mode: server's side for the next point.
    public var serverSide: ServeSide?
    /// True while the phone is actively recording (`RECORDING` vs `READY`).
    public var isLive: Bool

    /// Creates a state snapshot.
    public init(mode: SessionMode = .rally, shotCount: Int = 0, inStreak: Int = 0, sessionBest: Int = 0,
                setsLine: String = "", pointsLine: String = "", serverSide: ServeSide? = nil,
                isLive: Bool = false) {
        self.mode = mode
        self.shotCount = shotCount
        self.inStreak = inStreak
        self.sessionBest = sessionBest
        self.setsLine = setsLine
        self.pointsLine = pointsLine
        self.serverSide = serverSide
        self.isLive = isLive
    }

    /// Dictionary key carrying the JSON-encoded state.
    public static let key = "state"

    /// Encodes for `WCSession` (property-list safe: a single `Data` value).
    public var message: [String: Any] {
        guard let data = try? JSONEncoder().encode(self) else { return [:] }
        return [Self.key: data]
    }

    /// Decodes a received message or application context.
    public init?(message: [String: Any]) {
        guard let data = message[Self.key] as? Data,
              let state = try? JSONDecoder().decode(WatchState.self, from: data) else { return nil }
        self = state
    }
}
