// TennisVisionWatchApp.swift — adaptive watchOS 10+ wrist companion.
//   Page 1 (Live Court HUD):
//     - Top Status & Line-Call Pill: connection dot (green reachable / orange queued), LIVE badge, and
//       high-contrast color-coded Last Call Pill (IN green, OUT red, CLOSE orange).
//     - Rally Mode: 46pt monospaced shot counter, side-by-side STREAK & BEST badges, ⭐ Bookmark, ⚑ Challenge,
//       and 1-tap Start / End Rally toggle.
//     - Match Mode: crisp Sets pill, giant Points readout, 🎾 Serve: Deuce/Ad badge, big + Me / + Opp buttons,
//       and explicit 1-tap ↩ Undo + ⚑ Challenge bottom bar (plus long-press undo on point buttons).
//   Page 2 (Workout & Session Controls):
//     - Available in both Rally Mode and Match Mode.
//     - Live Heart Rate (BPM), Active Calories (kcal), and Elapsed Workout Time via HKLiveWorkoutBuilder
//       during an outdoor tennis workout (HKWorkoutSession), plus Start / End Tennis Workout and Rally controls.
import CourtGeometry
import HealthKit
import SwiftUI
import WatchConnectivity
import WatchKit

@main
struct TennisVisionWatchApp: App {
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(model)
        }
    }
}

// MARK: - WatchModel (WatchConnectivity + HealthKit Live Workout)

/// Manages WatchConnectivity state sync with the iPhone and live outdoor tennis `HKWorkoutSession` metrics.
final class WatchModel: NSObject, ObservableObject {
    @Published private(set) var state = WatchState()
    @Published private(set) var reachable = false
    @Published private(set) var workoutRunning = false
    @Published private(set) var heartRateBPM: Int = 0
    @Published private(set) var activeCalories: Int = 0
    @Published private(set) var workoutElapsedSeconds: Int = 0

    private let health = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var elapsedTimer: Timer?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Sends a command to the phone with tailored wrist haptic feedback; queues via `transferUserInfo` if unreachable.
    func send(_ command: WatchCommand) {
        let haptic: WKHapticType
        switch command {
        case .undo:
            haptic = .directionDown
        case .bookmark:
            haptic = .success
        case .challenge:
            haptic = .notification
        case .toggleRally:
            haptic = state.isLive ? .stop : .start
        case .pointMe, .pointOpp:
            haptic = .click
        }
        WKInterfaceDevice.current().play(haptic)
        if WCSession.default.isReachable {
            WCSession.default.sendMessage(command.message, replyHandler: nil)
        } else {
            WCSession.default.transferUserInfo(command.message)
        }
    }

    /// Starts or ends an outdoor tennis `HKWorkoutSession` so the Watch stays frontmost on court and tracks BPM / kcal.
    func toggleWorkout() {
        if let workout = self.workout {
            workout.end()
            elapsedTimer?.invalidate()
            elapsedTimer = nil
            let activeBuilder = self.builder
            self.workout = nil
            self.builder = nil
            workoutRunning = false
            activeBuilder?.endCollection(withEnd: Date()) { _, _ in
                activeBuilder?.finishWorkout { _, _ in }
            }
            WKInterfaceDevice.current().play(.stop)
            return
        }
        let readTypes: Set<HKObjectType> = [
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
        ]
        health.requestAuthorization(toShare: [HKObjectType.workoutType()], read: readTypes) { [weak self] ok, _ in
            guard ok else { return }
            DispatchQueue.main.async { [weak self] in
                self?.startWorkout()
            }
        }
    }

    private func startWorkout() {
        let config = HKWorkoutConfiguration()
        config.activityType = .tennis
        config.locationType = .outdoor
        guard let session = try? HKWorkoutSession(healthStore: health, configuration: config) else { return }
        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: config)
        session.delegate = self
        builder.delegate = self

        let now = Date()
        heartRateBPM = 0
        activeCalories = 0
        workoutElapsedSeconds = 0
        session.startActivity(with: now)
        builder.beginCollection(withStart: now) { _, _ in }
        self.workout = session
        self.builder = builder
        self.workoutRunning = true
        WKInterfaceDevice.current().play(.start)

        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, self.workoutRunning, let builder = self.builder else { return }
            self.workoutElapsedSeconds = Int(builder.elapsedTime(at: Date()))
        }
    }

    /// Formats `workoutElapsedSeconds` as `MM:SS` (or `H:MM:SS` over an hour).
    var formattedElapsedTime: String {
        let total = max(0, workoutElapsedSeconds)
        let hrs = total / 3600
        let mins = (total % 3600) / 60
        let secs = total % 60
        if hrs > 0 {
            return String(format: "%d:%02d:%02d", hrs, mins, secs)
        }
        return String(format: "%02d:%02d", mins, secs)
    }

    private func updateWorkoutStatistics(_ statistics: HKStatistics?, for quantityType: HKQuantityType) {
        guard let statistics else { return }
        if quantityType == HKQuantityType(.heartRate) {
            let bpmUnit = HKUnit.count().unitDivided(by: .minute())
            if let value = statistics.mostRecentQuantity()?.doubleValue(for: bpmUnit) {
                self.heartRateBPM = Int(value.rounded())
            }
        } else if quantityType == HKQuantityType(.activeEnergyBurned) {
            let kcalUnit = HKUnit.kilocalorie()
            if let value = statistics.sumQuantity()?.doubleValue(for: kcalUnit) {
                self.activeCalories = Int(value.rounded())
            }
        }
        if let builder = self.builder, self.workoutRunning {
            self.workoutElapsedSeconds = Int(builder.elapsedTime(at: Date()))
        }
    }
}

// MARK: - WCSessionDelegate

extension WatchModel: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        let isReachable = session.isReachable
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.reachable = isReachable
            if let s = WatchState(message: context) {
                self.state = s
            }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        let isReachable = session.isReachable
        DispatchQueue.main.async { [weak self] in
            self?.reachable = isReachable
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        receive(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        receive(message)
    }

    private func receive(_ message: [String: Any]) {
        guard let s = WatchState(message: message) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if s.shotCount > 0, s.shotCount % RallyTracker.milestoneEvery == 0, s.shotCount != self.state.shotCount {
                WKInterfaceDevice.current().play(.success)          // 10 / 20 / 30-shot milestone tap
            }
            if s.lastCall == .out, self.state.lastCall != .out {
                WKInterfaceDevice.current().play(.failure)
            } else if s.lastCall == .close, self.state.lastCall != .close {
                WKInterfaceDevice.current().play(.retry)
            }
            self.state = s
        }
    }
}

// MARK: - HKLiveWorkoutBuilderDelegate & HKWorkoutSessionDelegate

extension WatchModel: HKLiveWorkoutBuilderDelegate, HKWorkoutSessionDelegate {
    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        for type in collectedTypes {
            guard let quantityType = type as? HKQuantityType else { continue }
            let statistics = workoutBuilder.statistics(for: quantityType)
            DispatchQueue.main.async { [weak self] in
                self?.updateWorkoutStatistics(statistics, for: quantityType)
            }
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession,
                        didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState,
                        date: Date) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.workoutRunning = (toState == .running)
            if toState != .running {
                self.elapsedTimer?.invalidate()
                self.elapsedTimer = nil
            }
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.workoutRunning = false
            self.elapsedTimer?.invalidate()
            self.elapsedTimer = nil
        }
    }
}

// MARK: - Root Two-Page TabView

struct WatchRootView: View {
    @EnvironmentObject private var model: WatchModel
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            LiveCourtHUDPage()
                .tag(0)
            WorkoutWatchView()
                .tag(1)
        }
        .tabViewStyle(.page)
    }
}

// MARK: - Page 1: Live Court HUD (Status Pill + Rally / Match Mode)

struct LiveCourtHUDPage: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 4) {
            WatchStatusHeader(
                reachable: model.reachable,
                isLive: model.state.isLive,
                mode: model.state.mode,
                lastCall: model.state.lastCall,
                workoutRunning: model.workoutRunning
            )
            switch model.state.mode {
            case .rally:
                RallyWatchView()
            case .match:
                MatchWatchView()
            }
        }
        .padding(.horizontal, 2)
    }
}

/// Top status bar with connection indicator (green reachable / orange queued), LIVE badge, and color-coded Last Call pill.
struct WatchStatusHeader: View {
    let reachable: Bool
    let isLive: Bool
    let mode: SessionMode
    let lastCall: LineCall?
    let workoutRunning: Bool

    var body: some View {
        HStack(spacing: 4) {
            // Connection status dot + label
            HStack(spacing: 3) {
                Circle()
                    .fill(reachable ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(reachable ? "Phone" : "Queued")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(reachable ? Color.secondary : Color.orange)
            }

            if isLive {
                HStack(spacing: 3) {
                    Circle().fill(Color.white).frame(width: 5, height: 5)
                    Text("LIVE")
                        .font(.system(size: 10, weight: .heavy, design: .rounded))
                }
                .padding(.horizontal, 5)
                .padding(.vertical, 1.5)
                .background(Color.green.opacity(0.85), in: Capsule())
            } else if workoutRunning {
                Image(systemName: "figure.tennis")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.green)
            }

            Spacer(minLength: 2)

            if let call = lastCall, call != .unknown {
                LastCallPill(call: call)
            } else {
                Text(mode == .rally ? "RALLY" : "MATCH")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(Color.white.opacity(0.12), in: Capsule())
            }
        }
    }
}

/// High-contrast color-coded line-call badge (`IN` green, `OUT` red, `CLOSE` orange).
struct LastCallPill: View {
    let call: LineCall

    var body: some View {
        Text(label)
            .font(.system(size: 11, weight: .black, design: .rounded))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color, in: Capsule())
    }

    private var label: String {
        switch call {
        case .in: return "IN"
        case .out: return "OUT"
        case .close: return "CLOSE"
        case .unknown: return "—"
        }
    }

    private var color: Color {
        switch call {
        case .in: return .green
        case .out: return .red
        case .close: return .orange
        case .unknown: return .gray
        }
    }
}

// MARK: - Rally Mode View

/// Rally Mode HUD: 46pt rounded monospaced shot counter, side-by-side STREAK & BEST badges,
/// ⭐ Bookmark, ⚑ Challenge, and 1-tap Start / End Rally button.
struct RallyWatchView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 4) {
            HStack(alignment: .center, spacing: 8) {
                Text("\(model.state.shotCount)")
                    .font(.system(size: 46, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(model.state.isLive ? Color.green : Color.primary)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text("STREAK")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundStyle(.secondary)
                        Text("\(model.state.inStreak)")
                            .font(.system(size: 13, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.green)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.green.opacity(0.16), in: Capsule())

                    HStack(spacing: 4) {
                        Text("BEST")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundStyle(.secondary)
                        Text("\(model.state.sessionBest)")
                            .font(.system(size: 13, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.yellow)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.yellow.opacity(0.16), in: Capsule())
                }
            }

            HStack(spacing: 5) {
                Button {
                    model.send(.bookmark)
                } label: {
                    Label("Bookmark", systemImage: "star.fill")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .tint(.yellow)

                Button {
                    model.send(.challenge)
                } label: {
                    Label("Challenge", systemImage: "flag.fill")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .tint(.red)
            }

            Button {
                model.send(.toggleRally)
            } label: {
                Label(
                    model.state.isLive ? "End Rally" : "Start Rally",
                    systemImage: model.state.isLive ? "stop.circle.fill" : "play.circle.fill"
                )
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .frame(maxWidth: .infinity, minHeight: 30)
            }
            .tint(model.state.isLive ? .green : .blue)
        }
        .buttonStyle(.borderedProminent)
    }
}

// MARK: - Match Mode View

/// Match Mode HUD: Sets pill + giant Points readout + 🎾 Serve: Deuce/Ad badge,
/// big + Me (green) and + Opp (blue) buttons (with long-press undo), and an explicit 1-tap ↩ Undo + ⚑ Challenge row.
struct MatchWatchView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 4) {
            // Crisp scoreboard header
            HStack(spacing: 5) {
                Text(model.state.setsLine.isEmpty ? "0-0" : model.state.setsLine)
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .monospacedDigit()
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1.5)
                    .background(Color.white.opacity(0.14), in: Capsule())

                if let side = model.state.serverSide {
                    Text("🎾 Serve: \(side.rawValue.capitalized)")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(.green)
                        .lineLimit(1)
                }
            }

            Text(model.state.pointsLine.isEmpty ? "0 - 0" : model.state.pointsLine)
                .font(.system(size: 24, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.75)
                .lineLimit(1)

            // Primary point scoring buttons (tap to score, 0.6s long-press to undo)
            HStack(spacing: 6) {
                pointButton("+ Me", .pointMe, .green)
                pointButton("+ Opp", .pointOpp, .blue)
            }

            // Explicit 1-tap Undo + Challenge bottom bar
            HStack(spacing: 6) {
                Button {
                    model.send(.undo)
                } label: {
                    Label("Undo", systemImage: "arrow.uturn.backward")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .frame(maxWidth: .infinity, minHeight: 28)
                }
                .tint(.gray)

                Button {
                    model.send(.challenge)
                } label: {
                    Label("Challenge", systemImage: "flag.fill")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .frame(maxWidth: .infinity, minHeight: 28)
                }
                .tint(.red)
            }
        }
        .buttonStyle(.borderedProminent)
    }

    /// Tap scores the point; a 0.6s long press undoes the last point as an extra shortcut alongside 1-tap Undo.
    private func pointButton(_ title: String, _ command: WatchCommand, _ color: Color) -> some View {
        Text(title)
            .font(.system(size: 15, weight: .heavy, design: .rounded))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 38)
            .background(color, in: RoundedRectangle(cornerRadius: 10))
            .gesture(
                LongPressGesture(minimumDuration: 0.6)
                    .onEnded { _ in model.send(.undo) }
                    .exclusively(before: TapGesture().onEnded { model.send(command) })
            )
    }
}

// MARK: - Page 2: Fitness & Session Controls (WorkoutWatchView)

/// Page 2 of the Watch app (available in both Rally and Match Mode):
/// displays live Heart Rate (BPM), Active Calories (kcal), Elapsed Workout Time, and Start / End Tennis Workout controls.
struct WorkoutWatchView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Label("Tennis Fitness", systemImage: "figure.tennis")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.green)
                Spacer()
                if model.workoutRunning {
                    Text("ACTIVE")
                        .font(.system(size: 9, weight: .heavy, design: .rounded))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Color.green.opacity(0.3), in: Capsule())
                }
            }

            // Live metrics grid: Heart Rate (BPM), Active Calories (kcal), Elapsed Time
            HStack(spacing: 4) {
                metricTile(
                    icon: "heart.fill",
                    iconColor: .red,
                    value: model.heartRateBPM > 0 ? "\(model.heartRateBPM)" : "--",
                    unit: "BPM"
                )
                metricTile(
                    icon: "flame.fill",
                    iconColor: .orange,
                    value: model.activeCalories > 0 || model.workoutRunning ? "\(model.activeCalories)" : "--",
                    unit: "KCAL"
                )
                metricTile(
                    icon: "timer",
                    iconColor: .cyan,
                    value: model.formattedElapsedTime,
                    unit: "TIME"
                )
            }

            Button {
                model.toggleWorkout()
            } label: {
                Label(
                    model.workoutRunning ? "End Tennis Workout" : "Start Tennis Workout",
                    systemImage: model.workoutRunning ? "stop.fill" : "figure.tennis"
                )
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.borderedProminent)
            .tint(model.workoutRunning ? .red : .green)

            Button {
                model.send(.toggleRally)
            } label: {
                Label(
                    model.state.isLive ? "End Active Rally" : "Start Manual Rally",
                    systemImage: model.state.isLive ? "stop.circle" : "play.circle"
                )
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity, minHeight: 28)
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 2)
    }

    private func metricTile(icon: String, iconColor: Color, value: String, unit: String) -> some View {
        VStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(iconColor)
            Text(value)
                .font(.system(size: 14, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(unit)
                .font(.system(size: 8, weight: .bold, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}
