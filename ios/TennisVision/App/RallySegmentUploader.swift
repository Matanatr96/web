// RallySegmentUploader.swift — uploads each trimmed `rally_{idx}.mov` (or imported Camera Roll video) to the Modal
// `tennis-rally` app in 32 MiB parts on a background URLSession, while retaining local clips in
// `Application Support/Rallies/` (up to a 2 GiB cap) so players can replay, ShareLink-export, or re-upload clips
// from the Home Screen.
//
// Clip = −1.5 s pre-roll (RAM ring) + active rally + 2.0 s tail, produced by CameraCaptureManager. One Modal job
// per clip (job_id = "{match_id}.r{rally_idx}"), all calls carry the device `X-Job-Token` ("any" scope):
//   POST /jobs                     {match_id, rally_idx, source:"ios"|"ios_library", session_type, court, doubles,
//                                   size_bytes, content_type, start_s} → {job_id, part_size, parts_expected, received_parts}
//   PUT  /jobs/{job_id}/parts/{n}  raw bytes (0-based n, X-Part-Sha256) — one background upload task per part file
//   GET  /jobs/{job_id}            → {received_parts} (resume after relaunch, E5)
//   POST /jobs/{job_id}/commit     200 → assembled on the Modal volume → delete temporary part chunks; 409 {missing} → re-send
// Each request is retried 3× with exponential backoff (`earliestBeginDate`); state survives relaunch in uploads.json.
import CourtGeometry
import CryptoKit
import Foundation

/// Per-clip or per-session upload lifecycle state surfaced in `HomeView` and `RecordView`.
enum ClipUploadState: String, Codable, Sendable {
    case localOnly = "local_only"
    case queued = "queued"
    case uploading = "uploading"
    case uploaded = "uploaded"
    case failed = "failed"
    case needsToken = "needs_token"

    var label: String {
        switch self {
        case .localOnly: return "Local Only"
        case .queued: return "Queued"
        case .uploading: return "Uploading…"
        case .uploaded: return "Uploaded"
        case .failed: return "Retry Upload"
        case .needsToken: return "Needs Token"
        }
    }
}

final class RallySegmentUploader: NSObject, ObservableObject, @unchecked Sendable {
    static let shared = RallySegmentUploader()
    static let defaultPartSize = 33_554_432                // 32 MiB
    static let maxAttempts = 3
    static let maxRetainedClipsBytes: Int64 = 2 * 1024 * 1024 * 1024 // 2 GiB local clip retention cap
    static let sessionIdentifier = "com.thelastmattapalli.tennisvision.rally-upload"

    static let defaultModalBaseURL = "https://thelastmattapalli--tennis-rally-web.modal.run"
    static let defaultWebBaseURL = "https://www.thelastmattapalli.com"
    private static let modalBaseURLDefaultsKey = "tennis.modalBaseURL"
    private static let modalJobTokenDefaultsKey = "tennis.modalJobToken"
    private static let webBaseURLDefaultsKey = "tennis.webBaseURL"

    // MARK: Cloud endpoint & token configuration (UserDefaults + Info.plist fallback)

    private static func cleanedSetting(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty, !trimmed.hasPrefix("$(") else { return nil }
        return trimmed
    }

    static var modalBaseURLString: String {
        get {
            cleanedSetting(UserDefaults.standard.string(forKey: modalBaseURLDefaultsKey))
                ?? cleanedSetting(Bundle.main.object(forInfoDictionaryKey: "ModalBaseURL") as? String)
                ?? defaultModalBaseURL
        }
        set {
            let clean = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            UserDefaults.standard.set(clean.isEmpty ? defaultModalBaseURL : clean, forKey: modalBaseURLDefaultsKey)
        }
    }

    static var modalJobToken: String {
        get {
            cleanedSetting(UserDefaults.standard.string(forKey: modalJobTokenDefaultsKey))
                ?? cleanedSetting(Bundle.main.object(forInfoDictionaryKey: "ModalJobToken") as? String)
                ?? ""
        }
        set {
            UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines),
                                      forKey: modalJobTokenDefaultsKey)
        }
    }

    static var webBaseURLString: String {
        get {
            cleanedSetting(UserDefaults.standard.string(forKey: webBaseURLDefaultsKey))
                ?? cleanedSetting(Bundle.main.object(forInfoDictionaryKey: "WebBaseURL") as? String)
                ?? defaultWebBaseURL
        }
        set {
            let clean = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            UserDefaults.standard.set(clean.isEmpty ? defaultWebBaseURL : clean, forKey: webBaseURLDefaultsKey)
        }
    }

    static var webBaseURL: URL {
        URL(string: webBaseURLString) ?? URL(string: defaultWebBaseURL)!
    }

    static var hasValidCredentials: Bool {
        URL(string: modalBaseURLString) != nil && !modalJobToken.isEmpty
    }

    /// Published upload counters for live SwiftUI badges in `HomeView`, `RecordView`, and `CloudSettingsSheet`.
    @Published private(set) var activeUploadsCount = 0
    @Published private(set) var failedUploadsCount = 0
    @Published private(set) var completedUploadsCount = 0
    @Published private(set) var statusByKey: [String: ClipUploadState] = [:]

    /// Invoked on the main thread whenever a clip's upload state changes: `(matchId, rallyIdx, newState)`.
    var onClipStatusChanged: ((UUID, Int, ClipUploadState) -> Void)?

    /// Where and as what to upload. `ModalBaseURL` / `ModalJobToken` come from `UserDefaults` or `Info.plist`.
    struct Config: Codable {
        var baseURL: URL
        var jobToken: String
        var matchId: UUID
        var sessionType: SessionMode
        var doubles: Bool
        var court: CourtJSON?
        var source: String? = "ios"

        /// Reads the Modal endpoint + device token from `UserDefaults` or `Info.plist`; nil when token is empty.
        static func fromBundle(matchId: UUID, sessionType: SessionMode, doubles: Bool, court: CourtJSON?,
                               source: String = "ios") -> Config? {
            guard let base = URL(string: RallySegmentUploader.modalBaseURLString) else { return nil }
            let token = RallySegmentUploader.modalJobToken
            guard !token.isEmpty else { return nil }
            return Config(baseURL: base, jobToken: token, matchId: matchId, sessionType: sessionType,
                          doubles: doubles, court: court, source: source)
        }
    }

    /// `court` input of `POST /jobs`: `{size:[w,h], court_px:[[u,v]×4 in COURT_M order 0..3], posts_px}`.
    struct CourtJSON: Codable, Equatable {
        var size: [Int]
        var courtPx: [[Double]]
        var postsPx: [[Double]]?

        init(_ cal: CourtCalibration,
             width: Int = Int(CameraCaptureManager.width),
             height: Int = Int(CameraCaptureManager.height)) {
            size = [width, height]
            courtPx = cal.corners.map { [$0.x, $0.y] }
            postsPx = cal.netPosts?.map { [$0.x, $0.y] }
        }
    }

    /// Match-mode score snapshot sent alongside a rally upload (`POST /jobs`) or session finalization.
    struct ScorePayload: Codable {
        var log: String
        var sets: [[Int]]
        var games: [Int]
        var points: [Int]
        var tiebreak: Bool
        var tiebreakTo: Int
        var server: String
        var winner: String?
        var formatted: String

        init(_ sk: MatchScorekeeper) {
            let s = sk.score
            log = s.log
            sets = s.sets.map { [$0.me, $0.opp] }
            games = [s.games.me, s.games.opp]
            points = [s.points.me, s.points.opp]
            tiebreak = s.inTiebreak
            tiebreakTo = s.tiebreakTo
            server = s.server.rawValue
            winner = s.winner?.rawValue
            formatted = sk.formattedScore
        }
    }

    /// Match-mode point record (`tennis_points` row).
    struct PointPayload: Codable {
        var pointIdx: Int
        var rallyIdx: Int?
        var server: String
        var serveSide: String
        var winner: String
        var endedBy: String?
        var scoreBefore: String
        var scoreAfter: String
        var timestampS: Double?
    }

    /// Persistent per-clip upload state, keyed by `"{matchId}_{rallyIdx}"`.
    private struct Upload: Codable {
        var key: String
        var rallyIdx: Int
        var clipPath: String
        var startS: Double
        var config: Config
        var bookmarked = false
        var liveCall: String?
        var score: ScorePayload?
        var points: [PointPayload]?
        var jobId: String?
        var partCount = 0
        var done: Set<Int> = []
        var attempts: [String: Int] = [:]
        var failed = false
    }

    /// AppDelegate hands this over from `handleEventsForBackgroundURLSession`.
    var backgroundCompletionHandler: (() -> Void)?

    private let delegateQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1                  // all state below is touched only on this queue
        return q
    }()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }()
    private var uploads: [String: Upload] = [:]
    private var responses: [Int: Data] = [:]
    private static let manifestURL = CameraCaptureManager.clipsDirectory.appendingPathComponent("uploads.json")
    private static let partsDirectory: URL = {
        let dir = CameraCaptureManager.clipsDirectory.appendingPathComponent("parts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    static func uploadKey(matchId: UUID, rallyIdx: Int) -> String {
        "\(matchId.uuidString.lowercased())_\(rallyIdx)"
    }

    private override init() {
        super.init()
        delegateQueue.addOperation {
            if let data = try? Data(contentsOf: Self.manifestURL),
               let saved = try? JSONDecoder().decode([String: Upload].self, from: data) {
                self.uploads = saved
            }
            self.syncPublishedCounts()
            _ = self.session                                // reconnect to tasks from a previous launch
        }
    }

    // MARK: Public API

    /// Queues a finished rally clip (or Camera Roll video) for upload.
    ///
    /// - Parameters:
    ///   - clip: `.mov` or `.mp4` file in Application Support/Rallies.
    ///   - rallyIdx: Rally index within the session.
    ///   - startS: Clip start relative to the session start (seconds).
    ///   - config: Endpoint, token and session metadata.
    ///   - bookmarked: Whether the player bookmarked this rally during play.
    ///   - liveCall: Last on-device line call during this rally (`"in"`, `"out"`, `"close"`), if any.
    ///   - score: Match-mode score state snapshot, if in `.match` mode.
    ///   - points: Match-mode point history (`tennis_points`), if in `.match` mode.
    func enqueue(clip: URL, rallyIdx: Int, startS: Double, config: Config,
                 bookmarked: Bool = false, liveCall: String? = nil,
                 score: ScorePayload? = nil, points: [PointPayload]? = nil) {
        delegateQueue.addOperation {
            let key = Self.uploadKey(matchId: config.matchId, rallyIdx: rallyIdx)
            self.uploads[key] = Upload(key: key, rallyIdx: rallyIdx, clipPath: clip.path, startS: startS,
                                       config: config, bookmarked: bookmarked, liveCall: liveCall,
                                       score: score, points: points)
            self.save()
            self.notifyStatus(matchId: config.matchId, rallyIdx: rallyIdx, state: .uploading)
            self.createJob(key)
        }
    }

    /// Updates Match Mode score/point metadata on any queued uploads for `config.matchId` and notifies the backend
    /// when finalizing or updating a session.
    func finalizeSession(config: Config, score: ScorePayload?, points: [PointPayload]?) {
        delegateQueue.addOperation {
            let prefix = config.matchId.uuidString.lowercased() + "_"
            for k in self.uploads.keys where k.hasPrefix(prefix) {
                self.uploads[k]?.score = score
                self.uploads[k]?.points = points
            }
            self.save()
            let mid = config.matchId.uuidString.lowercased()
            var req = URLRequest(url: config.baseURL.appendingPathComponent("sessions/\(mid)/finalize"))
            req.httpMethod = "POST"
            req.setValue(config.jobToken, forHTTPHeaderField: "X-Job-Token")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let court = config.court.flatMap { try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode($0)) }
            var body: [String: Any] = [
                "match_id": mid,
                "source": config.source ?? "ios",
                "session_type": config.sessionType.rawValue,
                "doubles": config.doubles,
                "court": court ?? NSNull(),
            ]
            if let score, let obj = try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode(score)) {
                body["score"] = obj
            }
            if let points, let obj = try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode(points)) {
                body["points"] = obj
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req).resume()
        }
    }

    /// Re-drives uploads that exhausted their retries (call when the app returns to the foreground or after
    /// updating credentials in Cloud Settings).
    func resumePending() {
        let latestURL = URL(string: Self.modalBaseURLString)
        let latestToken = Self.modalJobToken
        delegateQueue.addOperation {
            for (key, u) in self.uploads where u.failed {
                self.uploads[key]?.failed = false
                self.uploads[key]?.attempts = [:]
                if let latestURL { self.uploads[key]?.config.baseURL = latestURL }
                if !latestToken.isEmpty { self.uploads[key]?.config.jobToken = latestToken }
                self.notifyStatus(matchId: u.config.matchId, rallyIdx: u.rallyIdx, state: .uploading)
                if let jobId = u.jobId { self.fetchReceivedParts(key, jobId: jobId) } else { self.createJob(key) }
            }
            self.save()
            self.syncPublishedCounts()
        }
    }

    // MARK: Steps

    private func createJob(_ key: String, delay: TimeInterval = 0) {
        guard let u = uploads[key] else { return }
        let size = (try? FileManager.default.attributesOfItem(atPath: u.clipPath)[.size] as? Int) ?? 0
        guard size > 0 else { return markFailed(key) }
        let contentType = u.clipPath.lowercased().hasSuffix(".mp4") ? "video/mp4" : "video/quicktime"
        let court = u.config.court.flatMap { try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode($0)) }
        var body: [String: Any] = [
            "match_id": u.config.matchId.uuidString.lowercased(),
            "rally_idx": u.rallyIdx,
            "source": u.config.source ?? "ios",
            "session_type": u.config.sessionType.rawValue,
            "court": court ?? NSNull(),
            "doubles": u.config.doubles,
            "size_bytes": size,
            "content_type": contentType,
            "start_s": u.startS,
            "bookmarked": u.bookmarked,
            "live_call": u.liveCall ?? NSNull(),
        ]
        if let score = u.score, let obj = try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode(score)) {
            body["score"] = obj
        }
        if let points = u.points, let obj = try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode(points)) {
            body["points"] = obj
        }
        send(request(u, path: "jobs", method: "POST"), json: body, tag: Tag(kind: .create, key: key), delay: delay)
    }

    private func didCreateJob(_ key: String, response: Data) {
        guard var u = uploads[key], let json = Self.json(response), let jobId = json["job_id"] as? String else {
            return markFailed(key)
        }
        u.jobId = jobId
        u.done = Set(json["received_parts"] as? [Int] ?? [])        // 200 on an identical repeat keeps progress
        u.partCount = splitParts(u.clipPath, key: key, partSize: json["part_size"] as? Int ?? Self.defaultPartSize)
        uploads[key] = u
        save()
        guard u.partCount > 0 else { return markFailed(key) }
        sendMissingOrCommit(key)
    }

    /// Writes part files (background sessions can only upload from files).
    private func splitParts(_ path: String, key: String, partSize: Int) -> Int {
        guard let handle = FileHandle(forReadingAtPath: path) else { return 0 }
        defer { try? handle.close() }
        var n = 0
        while let chunk = try? handle.read(upToCount: partSize), !chunk.isEmpty {
            guard (try? chunk.write(to: partURL(key, n))) != nil else { return 0 }
            n += 1
        }
        return n
    }

    private func sendMissingOrCommit(_ key: String) {
        guard let u = uploads[key], u.partCount > 0 else { return markFailed(key) }
        let missing = (0..<u.partCount).filter { !u.done.contains($0) }
        if missing.isEmpty { return commit(key) }
        missing.forEach { sendPart(key, part: $0) }
    }

    private func sendPart(_ key: String, part: Int, delay: TimeInterval = 0) {
        guard let u = uploads[key], let jobId = u.jobId, let data = try? Data(contentsOf: partURL(key, part)) else {
            return markFailed(key)
        }
        var req = request(u, path: "jobs/\(jobId)/parts/\(part)", method: "PUT")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), forHTTPHeaderField: "X-Part-Sha256")
        upload(req, file: partURL(key, part), tag: Tag(kind: .part, key: key, part: part), delay: delay)
    }

    private func fetchReceivedParts(_ key: String, jobId: String) {
        guard let u = uploads[key] else { return }
        URLSession.shared.dataTask(with: request(u, path: "jobs/\(jobId)", method: "GET")) { data, resp, error in
            self.delegateQueue.addOperation {
                guard let current = self.uploads[key] else { return }
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard error == nil, (200..<300).contains(status),
                      let received = data.flatMap(Self.json)?["received_parts"] as? [Int] else {
                    if status == 401 || status == 403 {
                        self.markFailed(key)
                    } else if status == 404 {
                        self.createJob(key)
                    } else {
                        self.retry(Tag(kind: .create, key: key))
                    }
                    return
                }
                self.uploads[key]?.done = Set(received)
                if current.partCount == 0 {
                    let count = self.splitParts(current.clipPath, key: key, partSize: Self.defaultPartSize)
                    self.uploads[key]?.partCount = count
                }
                self.save()
                self.sendMissingOrCommit(key)
            }
        }.resume()
    }

    private func commit(_ key: String, delay: TimeInterval = 0) {
        guard let u = uploads[key], let jobId = u.jobId else { return }
        send(request(u, path: "jobs/\(jobId)/commit", method: "POST"), json: [:], tag: Tag(kind: .commit, key: key),
             delay: delay)
    }

    /// Modal confirmed the file is assembled on its volume: clean up temporary upload part chunks,
    /// while retaining the `.mov` clip in `Application Support/Rallies/` (up to `maxRetainedClipsBytes`)
    /// so the user can replay, ShareLink-export, or inspect clips from `HomeView`.
    private func didCommit(_ key: String) {
        guard let u = uploads.removeValue(forKey: key) else { return }
        (0..<u.partCount).forEach { try? FileManager.default.removeItem(at: partURL(key, $0)) }
        try? FileManager.default.removeItem(at: Self.partsDirectory.appendingPathComponent("create_\(key).json"))
        try? FileManager.default.removeItem(at: Self.partsDirectory.appendingPathComponent("commit_\(key).json"))
        save()
        pruneOldClipsIfNeeded()
        DispatchQueue.main.async { self.completedUploadsCount += 1 }
        notifyStatus(matchId: u.config.matchId, rallyIdx: u.rallyIdx, state: .uploaded)
    }

    private func markFailed(_ key: String) {
        guard var u = uploads[key] else { return }
        u.failed = true
        uploads[key] = u
        save()
        notifyStatus(matchId: u.config.matchId, rallyIdx: u.rallyIdx, state: .failed)
    }

    private func notifyStatus(matchId: UUID, rallyIdx: Int, state: ClipUploadState) {
        let key = Self.uploadKey(matchId: matchId, rallyIdx: rallyIdx)
        syncPublishedCounts(updatingKey: key, state: state)
        DispatchQueue.main.async {
            self.onClipStatusChanged?(matchId, rallyIdx, state)
        }
    }

    private func syncPublishedCounts(updatingKey: String? = nil, state: ClipUploadState? = nil) {
        let active = uploads.values.filter { !$0.failed }.count
        let failed = uploads.values.filter(\.failed).count
        var snapshot: [String: ClipUploadState] = [:]
        for (k, u) in uploads {
            snapshot[k] = u.failed ? .failed : .uploading
        }
        DispatchQueue.main.async {
            self.activeUploadsCount = active
            self.failedUploadsCount = failed
            for (k, v) in snapshot { self.statusByKey[k] = v }
            if let updatingKey, let state {
                self.statusByKey[updatingKey] = state
            }
        }
    }

    /// Bounds local clip storage in `Application Support/Rallies/` to `maxRetainedClipsBytes` (2 GiB),
    /// evicting oldest non-queued clip files first.
    private func pruneOldClipsIfNeeded() {
        let fm = FileManager.default
        let activePaths = Set(uploads.values.map(\.clipPath))
        guard let urls = try? fm.contentsOfDirectory(
            at: CameraCaptureManager.clipsDirectory,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        let clips = urls.filter {
            let ext = $0.pathExtension.lowercased()
            return (ext == "mov" || ext == "mp4") && !activePaths.contains($0.path)
        }
        var entries: [(url: URL, size: Int64, date: Date)] = []
        var totalBytes: Int64 = 0
        for url in clips {
            let vals = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let sz = Int64(vals?.fileSize ?? 0)
            let dt = vals?.contentModificationDate ?? .distantPast
            totalBytes += sz
            entries.append((url, sz, dt))
        }
        guard totalBytes > Self.maxRetainedClipsBytes else { return }
        for entry in entries.sorted(by: { $0.date < $1.date }) {
            guard totalBytes > Self.maxRetainedClipsBytes else { break }
            if (try? fm.removeItem(at: entry.url)) != nil {
                totalBytes -= entry.size
            }
        }
    }

    // MARK: Plumbing

    private struct Tag: Codable {
        enum Kind: String, Codable {
            case create
            case part
            case commit
        }

        var kind: Kind
        var key: String
        var part = 0

        var retryKey: String { kind == .part ? "part\(part)" : kind.rawValue }
    }

    private func request(_ u: Upload, path: String, method: String) -> URLRequest {
        var req = URLRequest(url: u.config.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue(u.config.jobToken, forHTTPHeaderField: "X-Job-Token")
        return req
    }

    /// JSON bodies are written to small files too (background upload tasks need a file).
    private func send(_ req: URLRequest, json: [String: Any], tag: Tag, delay: TimeInterval = 0) {
        var req = req
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let file = Self.partsDirectory.appendingPathComponent("\(tag.kind.rawValue)_\(tag.key).json")
        guard let body = try? JSONSerialization.data(withJSONObject: json), (try? body.write(to: file)) != nil else {
            return markFailed(tag.key)
        }
        upload(req, file: file, tag: tag, delay: delay)
    }

    private func upload(_ req: URLRequest, file: URL, tag: Tag, delay: TimeInterval = 0) {
        let task = session.uploadTask(with: req, fromFile: file)
        task.taskDescription = (try? JSONEncoder().encode(tag)).flatMap { String(data: $0, encoding: .utf8) }
        if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
        task.resume()
    }

    private func partURL(_ key: String, _ part: Int) -> URL {
        Self.partsDirectory.appendingPathComponent("rally_\(key)_part_\(part).bin")
    }

    private static func json(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func save() {
        try? JSONEncoder().encode(uploads).write(to: Self.manifestURL, options: .atomic)
    }
}

// MARK: - URLSession delegate (delegateQueue)

extension RallySegmentUploader: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responses[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = responses.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard let raw = task.taskDescription?.data(using: .utf8), let tag = try? JSONDecoder().decode(Tag.self, from: raw),
              uploads[tag.key] != nil else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let ok = error == nil && (200..<300).contains(status)
        switch (tag.kind, ok) {
        case (.create, true):
            didCreateJob(tag.key, response: body)
        case (.part, true):
            uploads[tag.key]?.done.insert(tag.part)
            save()
            if let u = uploads[tag.key], u.done.count >= u.partCount { commit(tag.key) }
        case (.commit, true):
            didCommit(tag.key)
        case (.commit, false) where status == 409:
            // Parts missing on the server: mark them not-done and re-send.
            let missing = Self.json(body)?["missing"] as? [Int] ?? []
            missing.forEach { uploads[tag.key]?.done.remove($0) }
            save()
            missing.isEmpty ? retry(tag) : sendMissingOrCommit(tag.key)
        case (_, false) where status == 401 || status == 403:
            markFailed(tag.key)                            // bad / expired device token: retrying won't help
        case (_, false):
            retry(tag)
        }
    }

    /// Exponential backoff (2 s, 4 s), then park as failed until `resumePending()`.
    private func retry(_ tag: Tag) {
        guard uploads[tag.key] != nil else { return }
        let attempt = (uploads[tag.key]?.attempts[tag.retryKey] ?? 0) + 1
        uploads[tag.key]?.attempts[tag.retryKey] = attempt
        save()
        guard attempt < Self.maxAttempts else { return markFailed(tag.key) }
        let delay = pow(2, Double(attempt))
        switch tag.kind {
        case .part: sendPart(tag.key, part: tag.part, delay: delay)
        case .create: createJob(tag.key, delay: delay)
        case .commit: commit(tag.key, delay: delay)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletionHandler?()
            self.backgroundCompletionHandler = nil
        }
    }
}

private extension JSONEncoder {
    static let snake: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()
}
