// TennisVisionWatchApp.swift — adaptive watchOS 10+ companion.
//   Rally Mode: live shot streak + session best + a giant ⭐ Bookmark Rally button and ⚑ Challenge.
//   Match Mode: Me / Opp point buttons (long-press either to undo the last point), ⚑ Challenge, and an
//               HKWorkoutSession(.tennis) so the app stays frontmost and logs the workout.
// The phone is the source of truth: the Watch sends `WatchCommand`s and renders the `WatchState` it gets back.
import CourtGeometry
import HealthKit
import SwiftUI
import WatchConnectivity
import WatchKit

@main
struct TennisVisionWatchApp: App {
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup { WatchRootView().environmentObject(model) }
    }
}

/// WatchConnectivity + HealthKit workout state.
final class WatchModel: NSObject, ObservableObject {
    @Published private(set) var state = WatchState()
    @Published private(set) var reachable = false
    @Published private(set) var workoutRunning = false

    private let health = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Sends a command to the phone with a haptic; falls back to a queued transfer when the phone isn't reachable.
    func send(_ command: WatchCommand) {
        WKInterfaceDevice.current().play(command == .undo ? .directionDown : .click)
        if WCSession.default.isReachable {
            WCSession.default.sendMessage(command.message, replyHandler: nil)
        } else {
            WCSession.default.transferUserInfo(command.message)
        }
    }

    /// Starts / ends an outdoor tennis workout (Match Mode keeps the app frontmost during play).
    func toggleWorkout() {
        if let workout {
            workout.end()
            builder?.endCollection(withEnd: Date()) { [weak self] _, _ in
                self?.builder?.finishWorkout { _, _ in }
            }
            self.workout = nil
            workoutRunning = false
            return
        }
        let types: Set<HKObjectType> = [HKQuantityType(.heartRate), HKQuantityType(.activeEnergyBurned)]
        health.requestAuthorization(toShare: [HKObjectType.workoutType()], read: types) { [weak self] ok, _ in
            guard ok else { return }
            DispatchQueue.main.async { self?.startWorkout() }
        }
    }

    private func startWorkout() {
        let config = HKWorkoutConfiguration()
        config.activityType = .tennis
        config.locationType = .outdoor
        guard let session = try? HKWorkoutSession(healthStore: health, configuration: config) else { return }
        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: config)
        session.startActivity(with: Date())
        builder.beginCollection(withStart: Date()) { _, _ in }
        workout = session
        self.builder = builder
        workoutRunning = true
    }
}

extension WatchModel: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if let s = WatchState(message: context) { self.state = s }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.reachable = session.isReachable }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        receive(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        receive(message)
    }

    private func receive(_ message: [String: Any]) {
        guard let s = WatchState(message: message) else { return }
        DispatchQueue.main.async {
            if s.shotCount > 0, s.shotCount % RallyTracker.milestoneEvery == 0, s.shotCount != self.state.shotCount {
                WKInterfaceDevice.current().play(.success)          // 10 / 20 / 30-shot milestone tap
            }
            if s.lastCall == .out, self.state.lastCall != .out { WKInterfaceDevice.current().play(.failure) }
            self.state = s
        }
    }
}

// MARK: - Views

struct WatchRootView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        Group {
            switch model.state.mode {
            case .rally: RallyWatchView()
            case .match: MatchWatchView()
            }
        }
        .overlay(alignment: .topTrailing) {
            Circle().fill(model.reachable ? Color.green : Color.red).frame(width: 6, height: 6)
        }
    }
}

/// Rally Mode: live streak, session best, giant Bookmark, Challenge.
struct RallyWatchView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(model.state.shotCount)")
                    .font(.system(size: 44, weight: .heavy, design: .rounded)).monospacedDigit()
                    .foregroundStyle(model.state.isLive ? .green : .primary)
                VStack(alignment: .leading) {
                    Text("streak \(model.state.inStreak)").font(.caption2)
                    Text("best \(model.state.sessionBest)").font(.caption2.bold()).foregroundStyle(.yellow)
                }
            }
            Button { model.send(.bookmark) } label: {
                Label("Bookmark Rally", systemImage: "star.fill").frame(maxWidth: .infinity, minHeight: 56)
            }
            .tint(.yellow)
            Button { model.send(.challenge) } label: {
                Label("Challenge", systemImage: "flag.fill").frame(maxWidth: .infinity)
            }
            .tint(.red)
        }
        .buttonStyle(.borderedProminent)
    }
}

/// Match Mode: score, Me / Opp (long-press = undo), Challenge, workout toggle.
struct MatchWatchView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 4) {
            Text(model.state.setsLine).font(.caption.monospacedDigit())
            Text(model.state.pointsLine).font(.title3.bold())
            if let side = model.state.serverSide { Text("serve: \(side.rawValue)").font(.caption2).foregroundStyle(.secondary) }
            HStack {
                pointButton("Me", .pointMe, .green)
                pointButton("Opp", .pointOpp, .blue)
            }
            HStack {
                Button { model.send(.challenge) } label: { Image(systemName: "flag.fill") }.tint(.red)
                Button { model.toggleWorkout() } label: {
                    Image(systemName: model.workoutRunning ? "stop.fill" : "figure.tennis")
                }
            }
        }
        .buttonStyle(.borderedProminent)
    }

    /// Tap scores the point; a long press undoes the last point instead.
    private func pointButton(_ title: String, _ command: WatchCommand, _ color: Color) -> some View {
        Text(title)
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(color, in: RoundedRectangle(cornerRadius: 10))
            .gesture(LongPressGesture(minimumDuration: 0.6).onEnded { _ in model.send(.undo) }
                .exclusively(before: TapGesture().onEnded { model.send(command) }))
    }
}
