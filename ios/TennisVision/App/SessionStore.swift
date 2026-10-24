// SessionStore.swift — persists completed local sessions in `Application Support/Rallies/sessions.json`, fetches
// remote sessions & aggregate statistics from `GET <webBaseURL>/api/tennis/sessions`, merges/deduplicates by
// `match_id`, and provides the `HomeView` dashboard, Camera Roll video uploader (`PhotosPicker` + Frame-0
// `CourtCalibrationOverlay`), session clip browser (`ShareLink` + `AVPlayer`), and Cloud & Upload Settings sheet.
import AVFoundation
import AVKit
import CoreImage
import CourtGeometry
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Models

/// Metadata for a single recorded or imported rally clip stored in `Application Support/Rallies/`.
struct RallyClipRecord: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var rallyIdx: Int
    var fileName: String
    var startS: Double
    var durationS: Double
    var shotCount: Int
    var inStreak: Int
    var bookmarked: Bool
    var liveCall: String?
    var source: String = "ios"
    var uploadStatus: ClipUploadState

    var fileURL: URL {
        CameraCaptureManager.clipsDirectory.appendingPathComponent(fileName)
    }

    var fileExistsOnDisk: Bool {
        FileManager.default.fileExists(atPath: fileURL.path)
    }
}

/// Completed or in-progress on-device session persisted in `Application Support/Rallies/sessions.json`.
struct LocalSessionRecord: Codable, Identifiable, Equatable, Sendable {
    var id: UUID
    var startedAt: Date
    var endedAt: Date
    var mode: SessionMode
    var doubles: Bool
    var totalShots: Int
    var bestStreak: Int
    var ralliesCount: Int
    var inCalls: Int
    var outCalls: Int
    var scoreFormatted: String?
    var clipFiles: [RallyClipRecord]
    var uploadStatus: ClipUploadState
    var court: RallySegmentUploader.CourtJSON?
    var source: String? = "ios"

    var inCallPct: Double? {
        let total = inCalls + outCalls
        guard total > 0 else { return nil }
        return (Double(inCalls) / Double(total) * 1000).rounded() / 10
    }
}

/// JSON schema returned by `GET <webBaseURL>/api/tennis/sessions`.
struct RemoteSessionsResponse: Codable, Sendable {
    struct Summary: Codable, Sendable {
        var totalSessions: Int
        var totalRallies: Int
        var totalShots: Int
        var bestInStreak: Int
        var inCallRate: Double
    }

    struct RemoteSession: Codable, Identifiable, Sendable {
        var id: String
        var matchId: String?
        var title: String?
        var playedOn: String?
        var sessionType: String?
        var source: String?
        var status: String?
        var doubles: Bool?
        var ralliesDone: Int?
        var ralliesExpected: Int?
        var totalRallies: Int?
        var totalShots: Int?
        var bestInStreak: Int?
        var longestRally: Int?
        var inPct: Double?
        var outCount: Int?
        var scoreFormatted: String?
        var createdAt: String?
        var updatedAt: String?

        var canonicalMatchId: String {
            (matchId ?? id).lowercased()
        }
    }

    var summary: Summary
    var sessions: [RemoteSession]
}

/// Unified session row displayed on `HomeView` after merging local and cloud sessions by `match_id`.
struct MergedSessionItem: Identifiable {
    let id: String                              // lowercased match UUID
    let title: String
    let date: Date
    let dateLabel: String
    let mode: SessionMode
    let doubles: Bool
    let sourceLabel: String
    let totalShots: Int
    let bestStreak: Int
    let ralliesCount: Int
    let inPct: Double?
    let scoreFormatted: String?
    let uploadStatus: ClipUploadState
    let remoteStatus: String?
    let localRecord: LocalSessionRecord?
    let remoteRecord: RemoteSessionsResponse.RemoteSession?
}

/// Aggregate metrics displayed in the 4+1 summary tiles at the top of `HomeView`.
struct AggregateSessionStats {
    var totalSessions: Int = 0
    var totalShots: Int = 0
    var bestInStreak: Int = 0
    var totalRallies: Int = 0
    var inCallRatePct: Double?
}

// MARK: - SessionStore

@MainActor
final class SessionStore: ObservableObject {
    static let shared = SessionStore()
    private static let sessionsFileURL = CameraCaptureManager.clipsDirectory.appendingPathComponent("sessions.json")

    @Published private(set) var localSessions: [LocalSessionRecord] = []
    @Published private(set) var remoteSessions: [RemoteSessionsResponse.RemoteSession] = []
    @Published private(set) var remoteSummary: RemoteSessionsResponse.Summary?
    @Published private(set) var isFetchingRemote = false
    @Published private(set) var remoteError: String?

    private init() {
        loadLocal()
        RallySegmentUploader.shared.onClipStatusChanged = { [weak self] matchId, rallyIdx, state in
            Task { @MainActor in
                self?.updateClipStatus(matchId: matchId, rallyIdx: rallyIdx, status: state)
            }
        }
    }

    // MARK: Persistence

    func loadLocal() {
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: Self.sessionsFileURL),
           let decoded = try? dec.decode([LocalSessionRecord].self, from: data) {
            localSessions = decoded.sorted { $0.startedAt > $1.startedAt }
        }
    }

    private func saveLocal() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted]
        if let data = try? enc.encode(localSessions) {
            try? data.write(to: Self.sessionsFileURL, options: .atomic)
        }
    }

    /// Inserts or updates a local session and persists `sessions.json`.
    func upsertLocalSession(_ record: LocalSessionRecord) {
        var updated = record
        updated.uploadStatus = Self.deriveSessionUploadStatus(for: updated)
        if let idx = localSessions.firstIndex(where: { $0.id == updated.id }) {
            localSessions[idx] = updated
        } else {
            localSessions.insert(updated, at: 0)
        }
        localSessions.sort { $0.startedAt > $1.startedAt }
        saveLocal()
    }

    /// Deletes a local session and its local clip files.
    func deleteLocalSession(_ id: UUID) {
        if let existing = localSessions.first(where: { $0.id == id }) {
            for clip in existing.clipFiles {
                try? FileManager.default.removeItem(at: clip.fileURL)
            }
        }
        localSessions.removeAll { $0.id == id }
        saveLocal()
    }

    /// Updates the upload status of one clip when `RallySegmentUploader` reports progress.
    func updateClipStatus(matchId: UUID, rallyIdx: Int, status: ClipUploadState) {
        guard let sIdx = localSessions.firstIndex(where: { $0.id == matchId }) else { return }
        if let cIdx = localSessions[sIdx].clipFiles.firstIndex(where: { $0.rallyIdx == rallyIdx }) {
            localSessions[sIdx].clipFiles[cIdx].uploadStatus = status
        }
        localSessions[sIdx].uploadStatus = Self.deriveSessionUploadStatus(for: localSessions[sIdx])
        saveLocal()
    }

    private static func deriveSessionUploadStatus(for session: LocalSessionRecord) -> ClipUploadState {
        guard !session.clipFiles.isEmpty else {
            return RallySegmentUploader.hasValidCredentials ? .localOnly : .needsToken
        }
        let states = session.clipFiles.map(\.uploadStatus)
        if states.allSatisfy({ $0 == .uploaded }) { return .uploaded }
        if states.contains(.uploading) || states.contains(.queued) { return .uploading }
        if states.contains(.failed) { return .failed }
        if states.contains(.needsToken) { return .needsToken }
        return .localOnly
    }

    // MARK: Upload & Retry Actions

    /// Queues or re-queues all clips of a local session for background upload to Modal.
    @discardableResult
    func uploadSession(_ session: LocalSessionRecord, forceAll: Bool = false) -> Bool {
        let src = session.source ?? "ios"
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: session.id, sessionType: session.mode, doubles: session.doubles,
            court: session.court, source: src
        ) else {
            if let sIdx = localSessions.firstIndex(where: { $0.id == session.id }) {
                for cIdx in localSessions[sIdx].clipFiles.indices where localSessions[sIdx].clipFiles[cIdx].uploadStatus != .uploaded {
                    localSessions[sIdx].clipFiles[cIdx].uploadStatus = .needsToken
                }
                localSessions[sIdx].uploadStatus = .needsToken
                saveLocal()
            }
            return false
        }
        var enqueuedAny = false
        for clip in session.clipFiles where clip.fileExistsOnDisk && (forceAll || clip.uploadStatus != .uploaded) {
            updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .uploading)
            RallySegmentUploader.shared.enqueue(
                clip: clip.fileURL, rallyIdx: clip.rallyIdx, startS: clip.startS, config: config,
                bookmarked: clip.bookmarked, liveCall: clip.liveCall
            )
            enqueuedAny = true
        }
        RallySegmentUploader.shared.finalizeSession(config: config, score: nil, points: nil)
        return enqueuedAny
    }

    /// Uploads a single clip from a local session.
    @discardableResult
    func uploadClip(_ clip: RallyClipRecord, in session: LocalSessionRecord) -> Bool {
        guard clip.fileExistsOnDisk else { return false }
        let src = clip.source.isEmpty ? (session.source ?? "ios") : clip.source
        guard let config = RallySegmentUploader.Config.fromBundle(
            matchId: session.id, sessionType: session.mode, doubles: session.doubles,
            court: session.court, source: src
        ) else {
            updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .needsToken)
            return false
        }
        updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .uploading)
        RallySegmentUploader.shared.enqueue(
            clip: clip.fileURL, rallyIdx: clip.rallyIdx, startS: clip.startS, config: config,
            bookmarked: clip.bookmarked, liveCall: clip.liveCall
        )
        return true
    }

    /// Re-drives all failed/pending background tasks and queues any un-uploaded local session clips.
    func retryAllPendingUploads() {
        RallySegmentUploader.shared.resumePending()
        for session in localSessions where session.uploadStatus != .uploaded {
            _ = uploadSession(session)
        }
    }

    /// Imports a video picked from the iPhone Camera Roll into `Application Support/Rallies/`, saves a
    /// `LocalSessionRecord`, and queues it for upload to Modal (`source = "ios_library"` for full multi-rally
    /// segmentation or `"ios"` for a single rally clip).
    func importAndUploadLibraryVideo(
        importedURL: URL,
        durationS: Double,
        mode: SessionMode,
        doubles: Bool,
        calibration: CourtCalibration?,
        imageSize: CGSize,
        autoSegment: Bool
    ) -> LocalSessionRecord {
        let matchId = UUID()
        let ext = importedURL.pathExtension.isEmpty ? "mov" : importedURL.pathExtension.lowercased()
        let fileName = "library_\(matchId.uuidString.lowercased())_0.\(ext)"
        let destURL = CameraCaptureManager.clipsDirectory.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: destURL)
        if (try? FileManager.default.moveItem(at: importedURL, to: destURL)) == nil {
            try? FileManager.default.copyItem(at: importedURL, to: destURL)
        }
        let source = autoSegment ? "ios_library" : "ios"
        let courtJSON = calibration.map {
            RallySegmentUploader.CourtJSON($0, width: max(1, Int(imageSize.width)), height: max(1, Int(imageSize.height)))
        }
        let initialStatus: ClipUploadState = RallySegmentUploader.hasValidCredentials ? .uploading : .needsToken
        let clip = RallyClipRecord(
            id: RallySegmentUploader.uploadKey(matchId: matchId, rallyIdx: 0),
            rallyIdx: 0,
            fileName: fileName,
            startS: 0,
            durationS: max(0, durationS),
            shotCount: 0,
            inStreak: 0,
            bookmarked: false,
            liveCall: nil,
            source: source,
            uploadStatus: initialStatus
        )
        let now = Date()
        let session = LocalSessionRecord(
            id: matchId,
            startedAt: now,
            endedAt: now.addingTimeInterval(max(0, durationS)),
            mode: mode,
            doubles: doubles,
            totalShots: 0,
            bestStreak: 0,
            ralliesCount: 1,
            inCalls: 0,
            outCalls: 0,
            scoreFormatted: nil,
            clipFiles: [clip],
            uploadStatus: initialStatus,
            court: courtJSON,
            source: source
        )
        upsertLocalSession(session)
        _ = uploadSession(session, forceAll: true)
        return session
    }

    // MARK: Remote Cloud Sync (`GET <webBaseURL>/api/tennis/sessions`)

    func refreshRemote() async {
        isFetchingRemote = true
        remoteError = nil
        defer { isFetchingRemote = false }

        let endpoint = RallySegmentUploader.webBaseURL.appendingPathComponent("api/tennis/sessions")
        var req = URLRequest(url: endpoint)
        req.timeoutInterval = 12
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                remoteError = "Cloud sync returned HTTP \(code)"
                return
            }
            let decoded = try JSONDecoder().decode(RemoteSessionsResponse.self, from: data)
            remoteSummary = decoded.summary
            remoteSessions = decoded.sessions
            reconcileLocalWithRemote(decoded.sessions)
        } catch {
            remoteError = "Offline — showing on-device sessions"
        }
    }

    private func reconcileLocalWithRemote(_ remotes: [RemoteSessionsResponse.RemoteSession]) {
        var changed = false
        let remoteById = Dictionary(uniqueKeysWithValues: remotes.map { ($0.canonicalMatchId, $0) })
        for idx in localSessions.indices {
            let key = localSessions[idx].id.uuidString.lowercased()
            guard let r = remoteById[key] else { continue }
            if let shots = r.totalShots, shots > localSessions[idx].totalShots {
                localSessions[idx].totalShots = shots
                changed = true
            }
            if let streak = r.bestInStreak, streak > localSessions[idx].bestStreak {
                localSessions[idx].bestStreak = streak
                changed = true
            }
            let rCount = r.totalRallies ?? r.ralliesDone ?? 0
            if rCount > localSessions[idx].ralliesCount {
                localSessions[idx].ralliesCount = rCount
                changed = true
            }
            if r.status == "ready", localSessions[idx].uploadStatus != .uploaded {
                for cIdx in localSessions[idx].clipFiles.indices {
                    localSessions[idx].clipFiles[cIdx].uploadStatus = .uploaded
                }
                localSessions[idx].uploadStatus = .uploaded
                changed = true
            }
        }
        if changed { saveLocal() }
    }

    // MARK: Merged View Model & Aggregate Stats

    var mergedSessions: [MergedSessionItem] {
        var items: [MergedSessionItem] = []
        var seenIds = Set<String>()
        let remoteById = Dictionary(uniqueKeysWithValues: remoteSessions.map { ($0.canonicalMatchId, $0) })
        let iso = ISO8601DateFormatter()
        let dayFmt = DateFormatter()
        dayFmt.dateFormat = "yyyy-MM-dd"
        let displayFmt = DateFormatter()
        displayFmt.dateStyle = .medium
        displayFmt.timeStyle = .short

        for local in localSessions {
            let id = local.id.uuidString.lowercased()
            seenIds.insert(id)
            let remote = remoteById[id]
            let shots = max(local.totalShots, remote?.totalShots ?? 0)
            let streak = max(local.bestStreak, remote?.bestInStreak ?? 0)
            let rallies = max(local.ralliesCount, local.clipFiles.count, remote?.totalRallies ?? remote?.ralliesDone ?? 0)
            let inPct = remote?.inPct ?? local.inCallPct
            let score = local.scoreFormatted ?? remote?.scoreFormatted
            let status: ClipUploadState = (remote?.status == "ready") ? .uploaded : local.uploadStatus
            let srcLabel = local.source == "ios_library" ? "CAMERA ROLL" : "ON-DEVICE"
            let defaultTitle = local.mode == .match ? "Match Session" : "Rally Session"
            items.append(MergedSessionItem(
                id: id,
                title: remote?.title ?? defaultTitle,
                date: local.startedAt,
                dateLabel: displayFmt.string(from: local.startedAt),
                mode: local.mode,
                doubles: local.doubles,
                sourceLabel: remote != nil ? "\(srcLabel) · CLOUD" : srcLabel,
                totalShots: shots,
                bestStreak: streak,
                ralliesCount: rallies,
                inPct: inPct,
                scoreFormatted: score,
                uploadStatus: status,
                remoteStatus: remote?.status,
                localRecord: local,
                remoteRecord: remote
            ))
        }

        for remote in remoteSessions {
            let id = remote.canonicalMatchId
            guard !seenIds.contains(id) else { continue }
            seenIds.insert(id)
            let parsedDate = remote.createdAt.flatMap { iso.date(from: $0) }
                ?? remote.playedOn.flatMap { dayFmt.date(from: $0) }
                ?? Date.distantPast
            let mode: SessionMode = remote.sessionType == "match" ? .match : .rally
            let defaultTitle = mode == .match ? "Match Session" : "Rally Session"
            let dateStr = remote.playedOn ?? displayFmt.string(from: parsedDate)
            items.append(MergedSessionItem(
                id: id,
                title: remote.title ?? defaultTitle,
                date: parsedDate,
                dateLabel: dateStr,
                mode: mode,
                doubles: remote.doubles ?? false,
                sourceLabel: (remote.source ?? "web").uppercased(),
                totalShots: remote.totalShots ?? 0,
                bestStreak: remote.bestInStreak ?? 0,
                ralliesCount: remote.totalRallies ?? remote.ralliesDone ?? 0,
                inPct: remote.inPct,
                scoreFormatted: remote.scoreFormatted,
                uploadStatus: .uploaded,
                remoteStatus: remote.status,
                localRecord: nil,
                remoteRecord: remote
            ))
        }

        return items.sorted { $0.date > $1.date }
    }

    var aggregateStats: AggregateSessionStats {
        let merged = mergedSessions
        let totalSessions = merged.count
        let totalShots = merged.reduce(0) { $0 + $1.totalShots }
        let bestStreak = max(merged.map(\.bestStreak).max() ?? 0, remoteSummary?.bestInStreak ?? 0)
        let totalRallies = merged.reduce(0) { $0 + $1.ralliesCount }
        let validInPcts = merged.compactMap { item -> Double? in
            guard let pct = item.inPct, pct > 0 || (item.localRecord.map { $0.inCalls + $0.outCalls > 0 } ?? false) else {
                return nil
            }
            return pct
        }
        let inRate: Double?
        if !validInPcts.isEmpty {
            let avg = validInPcts.reduce(0, +) / Double(validInPcts.count)
            inRate = (avg * 10).rounded() / 10
        } else if let remoteRate = remoteSummary?.inCallRate, remoteRate > 0 {
            inRate = remoteRate
        } else {
            inRate = nil
        }
        return AggregateSessionStats(
            totalSessions: totalSessions,
            totalShots: totalShots,
            bestInStreak: bestStreak,
            totalRallies: totalRallies,
            inCallRatePct: inRate
        )
    }

    var pendingLocalSessionsCount: Int {
        localSessions.filter { $0.uploadStatus != .uploaded && !$0.clipFiles.isEmpty }.count
    }
}

// MARK: - Transferable Video Wrapper for PhotosPicker

struct PickedVideoFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let dst = FileManager.default.temporaryDirectory
                .appendingPathComponent("picked_\(UUID().uuidString.lowercased()).\(ext)")
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.copyItem(at: received.file, to: dst)
            return Self(url: dst)
        }
    }
}

// MARK: - HomeView (Root Screen)

struct HomeView: View {
    @EnvironmentObject private var controller: SessionController
    @ObservedObject private var store = SessionStore.shared
    @ObservedObject private var uploader = RallySegmentUploader.shared

    @State private var isRecordingSession = false
    @State private var launchMode: SessionMode = .rally
    @State private var launchDoubles = false
    @State private var showCloudSettings = false
    @State private var selectedSession: MergedSessionItem?
    @State private var pickedPhotoItem: PhotosPickerItem?
    @State private var isImportingVideo = false
    @State private var importError: String?
    @State private var pendingLibraryVideo: LibraryVideoDraft?

    struct LibraryVideoDraft: Identifiable {
        let id = UUID()
        let url: URL
        let firstFrame: CGImage?
        let imageSize: CGSize
        let durationS: Double
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    headerSection
                    statsDashboard
                    primaryActionsSection
                    recentSessionsSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
            .background(Color(white: 0.07).ignoresSafeArea())
            .navigationBarHidden(true)
        }
        .preferredColorScheme(.dark)
        .task {
            await store.refreshRemote()
        }
        .onChange(of: pickedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task { await handlePickedVideo(newItem) }
        }
        .fullScreenCover(isPresented: $isRecordingSession) {
            RecordView(onEndSession: {
                isRecordingSession = false
                Task { await store.refreshRemote() }
            })
            .environmentObject(controller)
        }
        .sheet(item: $pendingLibraryVideo) { draft in
            VideoLibraryUploadSheet(draft: draft) {
                pendingLibraryVideo = nil
                Task { await store.refreshRemote() }
            }
        }
        .sheet(isPresented: $showCloudSettings) {
            CloudSettingsSheet()
        }
        .sheet(item: $selectedSession) { item in
            SessionDetailSheet(item: item)
        }
    }

    // MARK: Header

    private var headerSection: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "tennisball.fill")
                        .foregroundStyle(.yellow)
                        .font(.title2)
                    Text("TennisVision")
                        .font(.title2.bold())
                }
                Text("Live WASB Line Caller · Rally Streak Counter · Cloud Studio")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if uploader.activeUploadsCount > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Uploading \(uploader.activeUploadsCount)")
                        .font(.caption.bold())
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.blue.opacity(0.25), in: Capsule())
            }
            Button {
                Task { await store.refreshRemote() }
            } label: {
                Label(store.isFetchingRemote ? "Syncing…" : "Sync", systemImage: "arrow.clockwise")
                    .font(.caption.bold())
            }
            .buttonStyle(.bordered)
            .disabled(store.isFetchingRemote)

            Button {
                showCloudSettings = true
            } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(RallySegmentUploader.hasValidCredentials ? Color.green : Color.orange)
                        .frame(width: 8, height: 8)
                    Text(RallySegmentUploader.hasValidCredentials ? "Cloud Settings" : "Set Upload Token")
                        .font(.caption.bold())
                }
            }
            .buttonStyle(.bordered)
        }
    }

    // MARK: Stats Dashboard

    private var statsDashboard: some View {
        let stats = store.aggregateStats
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("RECENT SESSIONS OVERVIEW")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let inPct = stats.inCallRatePct {
                    Text(String(format: "Line Calls: %.1f%% IN", inPct))
                        .font(.caption.monospacedDigit().bold())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.green.opacity(0.22), in: Capsule())
                        .foregroundStyle(.green)
                }
            }
            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
            ], spacing: 12) {
                StatTile(title: "Sessions", value: "\(stats.totalSessions)", icon: "calendar", tint: .cyan)
                StatTile(title: "Total Shots", value: "\(stats.totalShots)", icon: "bolt.fill", tint: .yellow)
                StatTile(title: "Best In-Streak", value: "\(stats.bestInStreak)", icon: "flame.fill", tint: .orange)
                StatTile(title: "Rallies Recorded", value: "\(stats.totalRallies)", icon: "film.stack", tint: .green)
            }
        }
    }

    // MARK: Primary Actions (Start Court Session + Upload Video from Photos + Retry Pending)

    private var primaryActionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                // Start Court Session card
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Picker("Mode", selection: $launchMode) {
                            Text("Rally Mode").tag(SessionMode.rally)
                            Text("Match Mode").tag(SessionMode.match)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 220)

                        Toggle("Doubles", isOn: $launchDoubles)
                            .toggleStyle(.button)
                            .font(.caption.bold())
                        Spacer()
                    }
                    Button {
                        controller.prepareNewSession(mode: launchMode, doubles: launchDoubles)
                        isRecordingSession = true
                    } label: {
                        HStack {
                            Image(systemName: "video.fill")
                            Text("Start Court Session")
                                .font(.headline.bold())
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
                .padding(14)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))

                // Upload Video / Rally from Camera Roll card
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label("Camera Roll Upload", systemImage: "photo.on.rectangle.angled")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        Spacer()
                        if store.pendingLocalSessionsCount > 0 {
                            Button {
                                if RallySegmentUploader.hasValidCredentials {
                                    store.retryAllPendingUploads()
                                } else {
                                    showCloudSettings = true
                                }
                            } label: {
                                Label("Upload Pending (\(store.pendingLocalSessionsCount))",
                                      systemImage: "arrow.up.circle.fill")
                                    .font(.caption2.bold())
                            }
                            .buttonStyle(.bordered)
                            .tint(.orange)
                        }
                    }

                    PhotosPicker(selection: $pickedPhotoItem, matching: .videos) {
                        HStack {
                            if isImportingVideo {
                                ProgressView().controlSize(.small)
                                Text("Loading Video…")
                                    .font(.headline.bold())
                            } else {
                                Image(systemName: "square.and.arrow.up.fill")
                                Text("Upload Video / Rally from Photos")
                                    .font(.headline.bold())
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)
                    .disabled(isImportingVideo)
                }
                .padding(14)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            }

            if let importError {
                Text(importError)
                    .font(.caption.bold())
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: Recent Sessions List

    private var recentSessionsSection: some View {
        let sessions = store.mergedSessions
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("RECENT SESSIONS & RALLY CLIPS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let err = store.remoteError {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if sessions.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "tennis.racket")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("No sessions yet")
                        .font(.headline)
                    Text("Tap \"Start Court Session\" to record live rallies with on-device line calls, or tap \"Upload Video / Rally from Photos\" to analyze an existing video.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 480)
                }
                .frame(maxWidth: .infinity)
                .padding(28)
                .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14))
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(sessions) { item in
                        SessionRowCard(
                            item: item,
                            onSelect: { selectedSession = item },
                            onUploadTap: {
                                if let local = item.localRecord {
                                    if !RallySegmentUploader.hasValidCredentials {
                                        showCloudSettings = true
                                    } else {
                                        _ = store.uploadSession(local, forceAll: true)
                                    }
                                }
                            }
                        )
                    }
                }
            }
        }
    }

    // MARK: Video Extraction Helper

    private func handlePickedVideo(_ item: PhotosPickerItem) async {
        isImportingVideo = true
        importError = nil
        defer {
            isImportingVideo = false
            pickedPhotoItem = nil
        }
        do {
            guard let picked = try await item.loadTransferable(type: PickedVideoFile.self) else {
                importError = "Could not read video from Photos library."
                return
            }
            let asset = AVURLAsset(url: picked.url)
            let durationCM = try? await asset.load(.duration)
            let durationS = durationCM.map { CMTimeGetSeconds($0) } ?? 0
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
            let cgImage = try? generator.copyCGImage(at: .zero, actualTime: nil)
            let size = cgImage.map { CGSize(width: $0.width, height: $0.height) }
                ?? CGSize(width: Int(CameraCaptureManager.width), height: Int(CameraCaptureManager.height))
            pendingLibraryVideo = LibraryVideoDraft(
                url: picked.url,
                firstFrame: cgImage,
                imageSize: size,
                durationS: durationS.isFinite ? max(0, durationS) : 0
            )
        } catch {
            importError = "Could not import video: \(error.localizedDescription)"
        }
    }
}

// MARK: - StatTile & SessionRowCard

private struct StatTile: View {
    let title: String
    let value: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            Text(value)
                .font(.system(size: 28, weight: .heavy, design: .rounded))
                .monospacedDigit()
        }
        .padding(12)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct SessionRowCard: View {
    let item: MergedSessionItem
    let onSelect: () -> Void
    let onUploadTap: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(item.mode.rawValue.uppercased())
                        .font(.caption2.bold())
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(item.mode == .match ? Color.purple.opacity(0.3) : Color.green.opacity(0.25),
                                    in: Capsule())
                        .foregroundStyle(item.mode == .match ? .purple : .green)

                    if item.doubles {
                        Text("DOUBLES")
                            .font(.caption2.bold())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.cyan.opacity(0.2), in: Capsule())
                    }

                    Text(item.dateLabel)
                        .font(.subheadline.bold())

                    Text(item.sourceLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 16) {
                    Label("\(item.totalShots) shots", systemImage: "bolt.fill")
                    Label("Best streak \(item.bestStreak)", systemImage: "flame.fill")
                    Label("\(item.ralliesCount) rallies", systemImage: "film.stack")
                    if let inPct = item.inPct {
                        Text(String(format: "%.0f%% IN", inPct))
                            .foregroundStyle(.green)
                    }
                    if let score = item.scoreFormatted, !score.isEmpty {
                        Text("Score: \(score)")
                            .foregroundStyle(.yellow)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }

            Spacer()

            if item.localRecord != nil && item.uploadStatus != .uploaded {
                Button(action: onUploadTap) {
                    Label(item.uploadStatus.label, systemImage: "icloud.and.arrow.up")
                        .font(.caption.bold())
                }
                .buttonStyle(.borderedProminent)
                .tint(statusColor(item.uploadStatus))
            } else {
                Text(item.uploadStatus.label)
                    .font(.caption2.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor(item.uploadStatus).opacity(0.22), in: Capsule())
                    .foregroundStyle(statusColor(item.uploadStatus))
            }

            Button(action: onSelect) {
                HStack(spacing: 4) {
                    Text("Clips & Details")
                        .font(.caption.bold())
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                }
            }
            .buttonStyle(.bordered)
        }
        .padding(14)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    private func statusColor(_ status: ClipUploadState) -> Color {
        switch status {
        case .uploaded: return .green
        case .uploading, .queued: return .blue
        case .failed: return .red
        case .needsToken, .localOnly: return .orange
        }
    }
}

// MARK: - VideoLibraryUploadSheet (PhotosPicker -> Optional Calibration -> Upload)

struct VideoLibraryUploadSheet: View {
    let draft: HomeView.LibraryVideoDraft
    let onFinished: () -> Void

    @State private var mode: SessionMode = .rally
    @State private var doubles = false
    @State private var autoSegment = true
    @State private var calibration: CourtCalibration?
    @State private var showCalibrationOverlay = false

    private var intrinsics: Intrinsics {
        Intrinsics(horizontalFOVDegrees: 68.0, width: Double(draft.imageSize.width), height: Double(draft.imageSize.height))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let cgImage = draft.firstFrame {
                        ZStack(alignment: .bottomTrailing) {
                            Image(decorative: cgImage, scale: 1)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: 12))

                            Button {
                                showCalibrationOverlay = true
                            } label: {
                                Label(calibration == nil ? "Calibrate Court (4 Corners + 2 Posts)" : "Recalibrate Court ✓",
                                      systemImage: "viewfinder")
                                    .font(.caption.bold())
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(calibration == nil ? .blue : .green)
                            .padding(10)
                        }
                    }

                    HStack(spacing: 16) {
                        Picker("Session Mode", selection: $mode) {
                            Text("Rally Mode").tag(SessionMode.rally)
                            Text("Match Mode").tag(SessionMode.match)
                        }
                        .pickerStyle(.segmented)

                        Toggle("Doubles Court", isOn: $doubles)
                            .toggleStyle(.button)
                    }

                    Toggle(isOn: $autoSegment) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Auto-Segment Full Video into Rallies")
                                .font(.subheadline.bold())
                            Text(autoSegment
                                 ? "Modal GPU will run WASB across the entire video and split it into individual rally clips."
                                 : "Treat this video as a single pre-trimmed rally clip.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if !RallySegmentUploader.hasValidCredentials {
                        Text("Note: No Modal Job Token is configured yet. The video will be saved to your session list so you can upload it as soon as you set your token in Cloud Settings.")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }

                    HStack {
                        Button("Cancel", role: .cancel) {
                            try? FileManager.default.removeItem(at: draft.url)
                            onFinished()
                        }
                        .buttonStyle(.bordered)

                        Spacer()

                        Button {
                            _ = SessionStore.shared.importAndUploadLibraryVideo(
                                importedURL: draft.url,
                                durationS: draft.durationS,
                                mode: mode,
                                doubles: doubles,
                                calibration: calibration,
                                imageSize: draft.imageSize,
                                autoSegment: autoSegment
                            )
                            onFinished()
                        } label: {
                            Label(RallySegmentUploader.hasValidCredentials ? "Save & Upload to Cloud" : "Save to Sessions",
                                  systemImage: "icloud.and.arrow.up.fill")
                                .font(.headline.bold())
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Upload Video / Rally")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .fullScreenCover(isPresented: $showCalibrationOverlay) {
            if let cgImage = draft.firstFrame {
                CourtCalibrationOverlay(
                    image: cgImage,
                    intrinsics: intrinsics,
                    initial: calibration,
                    onDone: { cal in
                        calibration = cal
                        showCalibrationOverlay = false
                    },
                    onCancel: { showCalibrationOverlay = false }
                )
            }
        }
    }
}

// MARK: - SessionDetailSheet (Replay, ShareLink to Camera Roll, Re-upload)

struct SessionDetailSheet: View {
    let item: MergedSessionItem
    @ObservedObject private var store = SessionStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var playingURL: IdentifiableURL?

    struct IdentifiableURL: Identifiable {
        let id = UUID()
        let url: URL
    }

    private var currentLocal: LocalSessionRecord? {
        guard let id = UUID(uuidString: item.id) else { return item.localRecord }
        return store.localSessions.first { $0.id == id } ?? item.localRecord
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Session Summary") {
                    HStack {
                        Text("Mode")
                        Spacer()
                        Text("\(item.mode.rawValue.capitalized)\(item.doubles ? " (Doubles)" : " (Singles)")")
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Total Shots / Best Streak")
                        Spacer()
                        Text("\(item.totalShots) shots · \(item.bestStreak) best in-streak")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Rallies")
                        Spacer()
                        Text("\(item.ralliesCount)")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    if let score = item.scoreFormatted, !score.isEmpty {
                        HStack {
                            Text("Match Score")
                            Spacer()
                            Text(score).bold()
                        }
                    }
                    if let webURL = URL(string: "\(RallySegmentUploader.webBaseURLString)/tennis/\(item.id)") {
                        Link(destination: webURL) {
                            Label("Open Session in Web Dashboard", systemImage: "safari")
                        }
                    }
                }

                if let local = currentLocal {
                    Section("Cloud Upload") {
                        HStack {
                            Text("Status")
                            Spacer()
                            Text(local.uploadStatus.label)
                                .bold()
                        }
                        Button {
                            _ = store.uploadSession(local, forceAll: true)
                        } label: {
                            Label(local.uploadStatus == .uploaded ? "Re-Upload All Clips to Cloud" : "Upload Session Clips Now",
                                  systemImage: "icloud.and.arrow.up")
                        }
                        .disabled(!RallySegmentUploader.hasValidCredentials)
                    }

                    Section("Saved On-Device Rally Clips (\(local.clipFiles.count))") {
                        if local.clipFiles.isEmpty {
                            Text("No local clip files recorded for this session.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(local.clipFiles) { clip in
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 6) {
                                            Text(clip.source == "ios_library" ? "Full Video" : "Rally #\(clip.rallyIdx + 1)")
                                                .font(.subheadline.bold())
                                            if clip.bookmarked {
                                                Image(systemName: "star.fill").foregroundStyle(.yellow).font(.caption)
                                            }
                                            if let call = clip.liveCall {
                                                Text(call.uppercased())
                                                    .font(.caption2.bold())
                                                    .padding(.horizontal, 5)
                                                    .padding(.vertical, 1)
                                                    .background(call == "out" ? Color.red.opacity(0.3) : Color.green.opacity(0.3),
                                                                in: Capsule())
                                            }
                                        }
                                        Text("\(clip.shotCount) shots · in-streak \(clip.inStreak) · \(clip.uploadStatus.label)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if clip.fileExistsOnDisk {
                                        Button {
                                            playingURL = IdentifiableURL(url: clip.fileURL)
                                        } label: {
                                            Image(systemName: "play.circle.fill")
                                                .font(.title3)
                                        }
                                        .buttonStyle(.borderless)

                                        ShareLink(item: clip.fileURL) {
                                            Image(systemName: "square.and.arrow.up")
                                                .font(.title3)
                                        }
                                        .buttonStyle(.borderless)

                                        if clip.uploadStatus != .uploaded {
                                            Button {
                                                _ = store.uploadClip(clip, in: local)
                                            } label: {
                                                Image(systemName: "icloud.and.arrow.up")
                                                    .font(.title3)
                                            }
                                            .buttonStyle(.borderless)
                                        }
                                    } else if let remoteClipURL = URL(
                                        string: "\(RallySegmentUploader.modalBaseURLString)/clips/\(item.id)/\(clip.rallyIdx).mp4"
                                    ) {
                                        Button {
                                            playingURL = IdentifiableURL(url: remoteClipURL)
                                        } label: {
                                            Label("Stream", systemImage: "play.circle")
                                                .font(.caption)
                                        }
                                        .buttonStyle(.bordered)
                                    }
                                }
                            }
                        }
                    }
                } else if item.ralliesCount > 0 {
                    Section("Cloud Rally Clips (\(item.ralliesCount))") {
                        ForEach(0..<item.ralliesCount, id: \.self) { idx in
                            if let remoteClipURL = URL(
                                string: "\(RallySegmentUploader.modalBaseURLString)/clips/\(item.id)/\(idx).mp4"
                            ) {
                                Button {
                                    playingURL = IdentifiableURL(url: remoteClipURL)
                                } label: {
                                    HStack {
                                        Label("Rally #\(idx + 1)", systemImage: "play.circle.fill")
                                        Spacer()
                                        Text("Stream from Cloud")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $playingURL) { item in
            VideoPlayer(player: AVPlayer(url: item.url))
                .ignoresSafeArea()
        }
    }
}

// MARK: - CloudSettingsSheet

struct CloudSettingsSheet: View {
    @ObservedObject private var uploader = RallySegmentUploader.shared
    @ObservedObject private var store = SessionStore.shared
    @Environment(\.dismiss) private var dismiss

    @State private var modalBaseURL = RallySegmentUploader.modalBaseURLString
    @State private var modalJobToken = RallySegmentUploader.modalJobToken
    @State private var webBaseURL = RallySegmentUploader.webBaseURLString
    @State private var statusMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Endpoints & Upload Credentials") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Modal Rally API URL")
                            .font(.caption).foregroundStyle(.secondary)
                        TextField("https://thelastmattapalli--tennis-rally-web.modal.run", text: $modalBaseURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Modal Device Job Token (X-Job-Token)")
                            .font(.caption).foregroundStyle(.secondary)
                        SecureField("any.<exp>.<hmac_sha256>", text: $modalJobToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Web Dashboard Base URL")
                            .font(.caption).foregroundStyle(.secondary)
                        TextField("https://www.thelastmattapalli.com", text: $webBaseURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    }
                }

                Section("Live Upload Queue Status") {
                    HStack {
                        Text("Active Background Uploads")
                        Spacer()
                        Text("\(uploader.activeUploadsCount)").monospacedDigit().bold()
                    }
                    HStack {
                        Text("Failed / Paused Uploads")
                        Spacer()
                        Text("\(uploader.failedUploadsCount)").monospacedDigit()
                            .foregroundStyle(uploader.failedUploadsCount > 0 ? .red : .secondary)
                    }
                    HStack {
                        Text("Pending Local Sessions")
                        Spacer()
                        Text("\(store.pendingLocalSessionsCount)").monospacedDigit()
                    }

                    Button {
                        saveSettings()
                        store.retryAllPendingUploads()
                        statusMessage = RallySegmentUploader.hasValidCredentials
                            ? "Queued pending clips for background upload."
                            : "Enter a valid Modal Device Job Token above to upload clips."
                    } label: {
                        Label("Retry / Upload All Pending Clips", systemImage: "arrow.triangle.2.circlepath.icloud.fill")
                            .font(.subheadline.bold())
                    }

                    if let statusMessage {
                        Text(statusMessage)
                            .font(.caption)
                            .foregroundStyle(RallySegmentUploader.hasValidCredentials ? .green : .orange)
                    }
                }
            }
            .navigationTitle("Cloud & Upload Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveSettings()
                        Task { await store.refreshRemote() }
                        dismiss()
                    }
                    .bold()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func saveSettings() {
        RallySegmentUploader.modalBaseURLString = modalBaseURL
        RallySegmentUploader.modalJobToken = modalJobToken
        RallySegmentUploader.webBaseURLString = webBaseURL
    }
}
