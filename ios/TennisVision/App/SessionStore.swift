// SessionStore.swift — persists completed local sessions in `Application Support/Rallies/sessions.json`, fetches
// remote sessions & aggregate statistics from `GET <webBaseURL>/api/tennis/sessions`, merges/deduplicates by
// `match_id`, and provides the `HomeView` dashboard, Camera Roll video uploader (`PhotosPicker` + Frame-0
// `CourtCalibrationOverlay`), session clip browser (`ShareLink` + `AVPlayer`), and Cloud & Upload Settings sheet.
import AVFoundation
import AVKit
import CoreImage
import CourtGeometry
import Photos
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
        if let idx = localSessions.firstIndex(where: { $0.id == updated.id }) {
            let existingById = Dictionary(localSessions[idx].clipFiles.map { ($0.id, $0.uploadStatus) },
                                          uniquingKeysWith: { a, _ in a })
            for cIdx in updated.clipFiles.indices {
                let cid = updated.clipFiles[cIdx].id
                if existingById[cid] == .uploaded {
                    updated.clipFiles[cIdx].uploadStatus = .uploaded
                } else if let live = RallySegmentUploader.shared.statusByKey[cid] {
                    updated.clipFiles[cIdx].uploadStatus = live
                }
            }
            updated.uploadStatus = Self.deriveSessionUploadStatus(for: updated)
            localSessions[idx] = updated
        } else {
            updated.uploadStatus = Self.deriveSessionUploadStatus(for: updated)
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

    /// Deletes a local session by UUID (`deleteSession(_:)` alias used by swipe-to-delete in `HomeView`).
    func deleteSession(_ id: UUID) {
        deleteLocalSession(id)
    }

    /// Deletes a merged session item's local record and on-disk clips.
    func deleteSession(_ item: MergedSessionItem) {
        if let local = item.localRecord {
            deleteLocalSession(local.id)
        } else if let uuid = UUID(uuidString: item.id) {
            deleteLocalSession(uuid)
        }
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
            if !forceAll,
               let activeState = RallySegmentUploader.shared.statusByKey[clip.id],
               activeState == .uploading || activeState == .queued {
                continue
            }
            updateClipStatus(matchId: session.id, rallyIdx: clip.rallyIdx, status: .uploading)
            RallySegmentUploader.shared.enqueue(
                clip: clip.fileURL, rallyIdx: clip.rallyIdx, startS: clip.startS, config: config,
                bookmarked: clip.bookmarked, liveCall: clip.liveCall
            )
            enqueuedAny = true
        }
        if src != "ios_library" {
            RallySegmentUploader.shared.finalizeSession(config: config, score: nil, points: nil)
        }
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
            if r.status == "ready", rCount > 0, localSessions[idx].uploadStatus != .uploaded {
                for cIdx in localSessions[idx].clipFiles.indices {
                    let clipId = localSessions[idx].clipFiles[cIdx].id
                    let liveState = RallySegmentUploader.shared.statusByKey[clipId]
                    if liveState != .uploading && liveState != .queued && liveState != .failed {
                        localSessions[idx].clipFiles[cIdx].uploadStatus = .uploaded
                    }
                }
                if localSessions[idx].clipFiles.allSatisfy({ $0.uploadStatus == .uploaded }) {
                    localSessions[idx].uploadStatus = .uploaded
                }
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
        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
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
            let remoteValidInPct = remote.flatMap { ($0.inPct ?? 0) > 0 || ($0.outCount ?? 0) > 0 ? $0.inPct : nil }
            let inPct = remoteValidInPct ?? local.inCallPct
            let score = local.scoreFormatted ?? remote?.scoreFormatted
            let status: ClipUploadState = (remote?.status == "ready" && (remote?.totalRallies ?? remote?.ralliesDone ?? 0) > 0 && local.uploadStatus != .uploading && local.uploadStatus != .failed) ? .uploaded : local.uploadStatus
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
            let parsedDate = remote.createdAt.flatMap { isoFrac.date(from: $0) ?? iso.date(from: $0) }
                ?? remote.playedOn.flatMap { dayFmt.date(from: $0) }
                ?? Date.distantPast
            let mode: SessionMode = remote.sessionType == "match" ? .match : .rally
            let defaultTitle = mode == .match ? "Match Session" : "Rally Session"
            let dateStr = remote.playedOn ?? displayFmt.string(from: parsedDate)
            let remoteValidInPct = (remote.inPct ?? 0) > 0 || (remote.outCount ?? 0) > 0 ? remote.inPct : nil
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
                inPct: remoteValidInPct,
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

enum SessionModeFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case rally = "Rally"
    case match = "Match"

    var id: String { rawValue }
}

struct HomeView: View {
    @EnvironmentObject private var controller: SessionController
    @ObservedObject private var store = SessionStore.shared
    @ObservedObject private var uploader = RallySegmentUploader.shared

    @State private var isRecordingSession = false
    @State private var launchMode: SessionMode = .rally
    @State private var launchDoubles = false
    @State private var modeFilter: SessionModeFilter = .all
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

    private var filteredSessions: [MergedSessionItem] {
        let all = store.mergedSessions
        switch modeFilter {
        case .all:
            return all
        case .rally:
            return all.filter { $0.mode == .rally }
        case .match:
            return all.filter { $0.mode == .match }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    headerSection
                    readinessPillBar
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

    // MARK: Header & On-Court Readiness / Cloud Sync Pill Bar

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
                Text("Live On-Court Line Caller · Rally Streak Counter · Cloud Studio")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Haptics.impact(.light)
                Task { await store.refreshRemote() }
            } label: {
                Label(store.isFetchingRemote ? "Syncing…" : "Sync", systemImage: "arrow.clockwise")
                    .font(.caption.bold())
            }
            .buttonStyle(.bordered)
            .disabled(store.isFetchingRemote)

            Button {
                Haptics.impact(.light)
                showCloudSettings = true
            } label: {
                Label("Settings", systemImage: "gearshape.fill")
                    .font(.caption.bold())
            }
            .buttonStyle(.bordered)
        }
    }

    private var readinessPillBar: some View {
        let isCloudReady = RallySegmentUploader.hasValidCredentials
        let webDashboardURL = URL(string: "\(RallySegmentUploader.webBaseURLString)/tennis")
            ?? URL(string: "https://www.thelastmattapalli.com/tennis")!
        return HStack(spacing: 10) {
            Button {
                Haptics.impact(.light)
                showCloudSettings = true
            } label: {
                HStack(spacing: 7) {
                    Circle()
                        .fill(isCloudReady ? Color.green : Color.orange)
                        .frame(width: 8, height: 8)
                    Text(isCloudReady ? "Cloud Sync Ready" : "Local Only — Tap to Configure")
                        .font(.caption.bold())
                        .foregroundStyle(isCloudReady ? .green : .orange)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    (isCloudReady ? Color.green : Color.orange).opacity(0.16),
                    in: Capsule()
                )
            }
            .buttonStyle(.plain)

            if uploader.activeUploadsCount > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Uploading \(uploader.activeUploadsCount) clip\(uploader.activeUploadsCount == 1 ? "" : "s")…")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(.cyan)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.cyan.opacity(0.16), in: Capsule())
            } else if store.pendingLocalSessionsCount > 0 {
                Button {
                    Haptics.impact(.light)
                    if isCloudReady {
                        store.retryAllPendingUploads()
                    } else {
                        showCloudSettings = true
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.up.circle.fill")
                        Text("\(store.pendingLocalSessionsCount) Pending Upload\(store.pendingLocalSessionsCount == 1 ? "" : "s")")
                            .monospacedDigit()
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Color.orange.opacity(0.18), in: Capsule())
                    .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
            }

            Spacer()

            Link(destination: webDashboardURL) {
                HStack(spacing: 5) {
                    Image(systemName: "globe")
                    Text("Web Dashboard ↗")
                        .font(.caption.bold())
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.white.opacity(0.08), in: Capsule())
                .foregroundStyle(.primary)
            }
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
        let allSessions = store.mergedSessions
        let sessions = filteredSessions
        let rallyCount = allSessions.filter { $0.mode == .rally }.count
        let matchCount = allSessions.filter { $0.mode == .match }.count
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text("RECENT SESSIONS & RALLY CLIPS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let err = store.remoteError {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                // Mode Filter Pills (All / Rally / Match)
                HStack(spacing: 6) {
                    ForEach(SessionModeFilter.allCases) { filter in
                        let isSelected = modeFilter == filter
                        let count: Int = {
                            switch filter {
                            case .all: return allSessions.count
                            case .rally: return rallyCount
                            case .match: return matchCount
                            }
                        }()
                        Button {
                            Haptics.impact(.light)
                            modeFilter = filter
                        } label: {
                            Text("\(filter.rawValue) (\(count))")
                                .font(.caption2.monospacedDigit().bold())
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(
                                    isSelected ? Color.green.opacity(0.28) : Color.white.opacity(0.08),
                                    in: Capsule()
                                )
                                .overlay(
                                    Capsule().stroke(isSelected ? Color.green : Color.clear, lineWidth: 1)
                                )
                                .foregroundStyle(isSelected ? Color.green : Color.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if sessions.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "tennis.racket")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text(modeFilter == .all ? "No sessions yet" : "No \(modeFilter.rawValue.lowercased()) sessions yet")
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
                            onSelect: {
                                Haptics.impact(.light)
                                selectedSession = item
                            },
                            onUploadTap: {
                                Haptics.impact(.medium)
                                if let local = item.localRecord {
                                    if !RallySegmentUploader.hasValidCredentials {
                                        showCloudSettings = true
                                    } else {
                                        _ = store.uploadSession(local, forceAll: true)
                                    }
                                }
                            },
                            onDeleteTap: item.localRecord != nil ? {
                                Haptics.notify(.warning)
                                store.deleteSession(item)
                            } : nil
                        )
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if item.localRecord != nil {
                                Button(role: .destructive) {
                                    Haptics.notify(.warning)
                                    store.deleteSession(item)
                                } label: {
                                    Label("Delete Session", systemImage: "trash.fill")
                                }
                            }
                        }
                        .contextMenu {
                            Button {
                                selectedSession = item
                            } label: {
                                Label("View Clips & Details", systemImage: "film.stack")
                            }
                            if let local = item.localRecord {
                                Button {
                                    if RallySegmentUploader.hasValidCredentials {
                                        _ = store.uploadSession(local, forceAll: true)
                                    } else {
                                        showCloudSettings = true
                                    }
                                } label: {
                                    Label("Upload Clips to Cloud", systemImage: "icloud.and.arrow.up")
                                }
                                Button(role: .destructive) {
                                    Haptics.notify(.warning)
                                    store.deleteSession(item)
                                } label: {
                                    Label("Delete Local Session", systemImage: "trash")
                                }
                            }
                        }
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
    var onDeleteTap: (() -> Void)? = nil

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

            if let onDeleteTap {
                Button(role: .destructive, action: onDeleteTap) {
                    Image(systemName: "trash")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .help("Delete local session")
            }
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

// MARK: - SessionDetailSheet (Replay, Save Clip to Photos, ShareLink, Call & Shot Breakdown, Re-upload)

struct SessionDetailSheet: View {
    let item: MergedSessionItem
    @ObservedObject private var store = SessionStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var playingURL: IdentifiableURL?
    @State private var bookmarkedOnly = false
    @State private var savedClipIds: Set<String> = []
    @State private var photoSaveMessage: String?

    struct IdentifiableURL: Identifiable {
        let id = UUID()
        let url: URL
    }

    private var currentLocal: LocalSessionRecord? {
        guard let id = UUID(uuidString: item.id) else { return item.localRecord }
        return store.localSessions.first { $0.id == id } ?? item.localRecord
    }

    private var inCallsCount: Int {
        if let local = currentLocal, local.inCalls + local.outCalls > 0 {
            return local.inCalls
        }
        if let remote = item.remoteRecord {
            let outs = remote.outCount ?? 0
            let total = max(outs, item.totalShots)
            return max(0, total - outs)
        }
        return 0
    }

    private var outCallsCount: Int {
        if let local = currentLocal, local.inCalls + local.outCalls > 0 {
            return local.outCalls
        }
        return item.remoteRecord?.outCount ?? 0
    }

    private var effectiveInPct: Double {
        if let pct = currentLocal?.inCallPct ?? item.inPct {
            return max(0, min(100, pct))
        }
        let total = inCallsCount + outCallsCount
        guard total > 0 else { return 100.0 }
        return Double(inCallsCount) / Double(total) * 100.0
    }

    private func saveClipToPhotos(_ clip: RallyClipRecord) {
        guard clip.fileExistsOnDisk else { return }
        Haptics.impact(.medium)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    self.photoSaveMessage = "Photos permission is required to save clips to Camera Roll."
                }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: clip.fileURL)
            }) { success, error in
                DispatchQueue.main.async {
                    if success {
                        self.savedClipIds.insert(clip.id)
                        self.photoSaveMessage = "Saved Rally #\(clip.rallyIdx + 1) to Photos."
                        Haptics.notify(.success)
                    } else {
                        self.photoSaveMessage = "Could not save video: \(error?.localizedDescription ?? "Unknown error")"
                    }
                }
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Call & Shot Breakdown") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label(String(format: "%.1f%% IN", effectiveInPct), systemImage: "checkmark.circle.fill")
                                .font(.headline.monospacedDigit().bold())
                                .foregroundStyle(.green)
                            Spacer()
                            Text("\(inCallsCount) In-Calls · \(outCallsCount) Out-Calls")
                                .font(.caption.monospacedDigit().bold())
                                .foregroundStyle(.secondary)
                        }

                        GeometryReader { geo in
                            let w = max(1, geo.size.width)
                            let inW = w * CGFloat(effectiveInPct / 100.0)
                            HStack(spacing: 2) {
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(Color.green)
                                    .frame(width: max(6, inW))
                                if effectiveInPct < 99.9 {
                                    RoundedRectangle(cornerRadius: 5)
                                        .fill(Color.red)
                                        .frame(maxWidth: .infinity)
                                }
                            }
                        }
                        .frame(height: 10)

                        HStack(spacing: 16) {
                            Label("\(item.totalShots) Total Shots", systemImage: "bolt.fill")
                            Label("Best Streak: \(item.bestStreak)", systemImage: "flame.fill")
                            Label("\(item.ralliesCount) Rallies", systemImage: "film.stack")
                        }
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)

                    if let local = currentLocal, !local.clipFiles.isEmpty {
                        let bookmarkedCount = local.clipFiles.filter(\.bookmarked).count
                        Toggle(isOn: $bookmarkedOnly) {
                            Label("Bookmarked Rallies Only (\(bookmarkedCount))", systemImage: "star.fill")
                                .foregroundStyle(bookmarkedOnly ? Color.yellow : Color.primary)
                        }
                        .tint(.yellow)
                    }
                }

                Section("Session Summary") {
                    HStack {
                        Text("Mode")
                        Spacer()
                        Text("\(item.mode.rawValue.capitalized)\(item.doubles ? " (Doubles)" : " (Singles)")")
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
                            Label("Open Session in Web Dashboard ↗", systemImage: "safari")
                        }
                    }
                }

                if let local = currentLocal {
                    Section("Cloud Upload & Session Actions") {
                        HStack {
                            Text("Status")
                            Spacer()
                            Text(local.uploadStatus.label)
                                .bold()
                        }
                        Button {
                            Haptics.impact(.medium)
                            _ = store.uploadSession(local, forceAll: true)
                        } label: {
                            Label(local.uploadStatus == .uploaded ? "Re-Upload All Clips to Cloud" : "Upload Session Clips Now",
                                  systemImage: "icloud.and.arrow.up")
                        }
                        .disabled(!RallySegmentUploader.hasValidCredentials)

                        Button(role: .destructive) {
                            Haptics.notify(.warning)
                            store.deleteLocalSession(local.id)
                            dismiss()
                        } label: {
                            Label("Delete Local Session & Clips", systemImage: "trash")
                        }
                    }

                    let visibleClips = bookmarkedOnly ? local.clipFiles.filter(\.bookmarked) : local.clipFiles
                    Section("Saved On-Device Rally Clips (\(visibleClips.count))") {
                        if let photoSaveMessage {
                            Text(photoSaveMessage)
                                .font(.caption.bold())
                                .foregroundStyle(.green)
                        }
                        if visibleClips.isEmpty {
                            Text(bookmarkedOnly ? "No bookmarked rally clips in this session." : "No local clip files recorded for this session.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(visibleClips) { clip in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(spacing: 8) {
                                        Text(clip.source == "ios_library" ? "Full Video" : "Rally #\(clip.rallyIdx + 1)")
                                            .font(.subheadline.bold())
                                        if clip.bookmarked {
                                            Label("Bookmarked", systemImage: "star.fill")
                                                .font(.caption2.bold())
                                                .foregroundStyle(.yellow)
                                        }
                                        if let call = clip.liveCall {
                                            Text(call.uppercased())
                                                .font(.caption2.bold())
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(call == "out" ? Color.red.opacity(0.3) : Color.green.opacity(0.3),
                                                            in: Capsule())
                                                .foregroundStyle(call == "out" ? .red : .green)
                                        }
                                        Spacer()
                                        Text("\(clip.shotCount) shots · streak \(clip.inStreak) · \(clip.uploadStatus.label)")
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }

                                    HStack(spacing: 10) {
                                        if clip.fileExistsOnDisk {
                                            Button {
                                                Haptics.impact(.light)
                                                playingURL = IdentifiableURL(url: clip.fileURL)
                                            } label: {
                                                Label("Play", systemImage: "play.fill")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.borderedProminent)
                                            .tint(.green)

                                            Button {
                                                saveClipToPhotos(clip)
                                            } label: {
                                                Label(savedClipIds.contains(clip.id) ? "Saved to Photos ✓" : "Save Clip to Photos",
                                                      systemImage: savedClipIds.contains(clip.id) ? "checkmark.circle.fill" : "photo.badge.arrow.down")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.bordered)
                                            .tint(savedClipIds.contains(clip.id) ? .green : .blue)

                                            ShareLink(item: clip.fileURL) {
                                                Label("Share", systemImage: "square.and.arrow.up")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.bordered)

                                            if clip.uploadStatus != .uploaded {
                                                Button {
                                                    Haptics.impact(.light)
                                                    _ = store.uploadClip(clip, in: local)
                                                } label: {
                                                    Label("Upload", systemImage: "icloud.and.arrow.up")
                                                        .font(.caption.bold())
                                                }
                                                .buttonStyle(.bordered)
                                                .tint(.orange)
                                            }
                                        } else if let remoteClipURL = URL(
                                            string: "\(RallySegmentUploader.modalBaseURLString)/clips/\(item.id)/\(clip.rallyIdx).mp4"
                                        ) {
                                            Button {
                                                playingURL = IdentifiableURL(url: remoteClipURL)
                                            } label: {
                                                Label("Stream from Cloud", systemImage: "play.circle")
                                                    .font(.caption.bold())
                                            }
                                            .buttonStyle(.bordered)
                                        }
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
                if (currentLocal == nil || currentLocal?.source == "ios_library"), item.ralliesCount > 0 {
                    Section("Cloud Rally Clips (\(item.ralliesCount))") {
                        ForEach(0..<item.ralliesCount, id: \.self) { idx in
                            if let remoteClipURL = URL(
                                string: "\(RallySegmentUploader.modalBaseURLString)/clips/\(item.id)/\(idx).mp4"
                            ) {
                                HStack {
                                    Button {
                                        playingURL = IdentifiableURL(url: remoteClipURL)
                                    } label: {
                                        Label("Play Rally #\(idx + 1)", systemImage: "play.circle.fill")
                                            .font(.subheadline.bold())
                                    }
                                    .buttonStyle(.borderless)
                                    Spacer()
                                    ShareLink(item: remoteClipURL) {
                                        Label("Share Link", systemImage: "square.and.arrow.up")
                                            .font(.caption.bold())
                                    }
                                    .buttonStyle(.bordered)
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
                            .foregroundStyle(uploader.failedUploadsCount > 0 ? Color.red : Color.secondary)
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
