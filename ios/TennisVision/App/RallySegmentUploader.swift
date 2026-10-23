// RallySegmentUploader.swift — uploads each trimmed `rally_{idx}.mov` to the Modal `tennis-rally` app in 32 MiB
// parts on a background URLSession, then deletes the local clip once Modal confirms receipt (commit 200).
//
// Clip = −1.5 s pre-roll (RAM ring) + active rally + 2.0 s tail, produced by CameraCaptureManager. One Modal job
// per clip (job_id = "{match_id}.r{rally_idx}"), all calls carry the device `X-Job-Token` ("any" scope):
//   POST /jobs                     {match_id, rally_idx, source:"ios", session_type, court, doubles, size_bytes,
//                                   content_type, start_s} → {job_id, part_size, parts_expected, received_parts}
//   PUT  /jobs/{job_id}/parts/{n}  raw bytes (0-based n, X-Part-Sha256) — one background upload task per part file
//   GET  /jobs/{job_id}            → {received_parts} (resume after relaunch, E5)
//   POST /jobs/{job_id}/commit     200 → assembled on the Modal volume → delete clip + parts; 409 {missing} → re-send
// Each request is retried 3× with exponential backoff (`earliestBeginDate`); state survives relaunch in uploads.json.
import CourtGeometry
import CryptoKit
import Foundation

final class RallySegmentUploader: NSObject, @unchecked Sendable {
    static let shared = RallySegmentUploader()
    static let defaultPartSize = 33_554_432                // 32 MiB
    static let maxAttempts = 3
    static let sessionIdentifier = "com.thelastmattapalli.tennisvision.rally-upload"

    /// Where and as what to upload. `ModalBaseURL` / `ModalJobToken` come from Info.plist via an untracked xcconfig.
    struct Config: Codable {
        var baseURL: URL
        var jobToken: String
        var matchId: UUID
        var sessionType: SessionMode
        var doubles: Bool
        var court: CourtJSON?

        /// Reads the Modal endpoint + device token from Info.plist; nil when not configured (clips stay local).
        static func fromBundle(matchId: UUID, sessionType: SessionMode, doubles: Bool, court: CourtJSON?) -> Config? {
            guard let base = (Bundle.main.object(forInfoDictionaryKey: "ModalBaseURL") as? String).flatMap(URL.init),
                  let token = Bundle.main.object(forInfoDictionaryKey: "ModalJobToken") as? String, !token.isEmpty
            else { return nil }
            return Config(baseURL: base, jobToken: token, matchId: matchId, sessionType: sessionType, doubles: doubles,
                          court: court)
        }
    }

    /// `court` input of `POST /jobs`: `{size:[w,h], court_px:[[u,v]×4 in COURT_M order 0..3], posts_px}`.
    struct CourtJSON: Codable {
        var size: [Int]
        var courtPx: [[Double]]
        var postsPx: [[Double]]?

        init(_ cal: CourtCalibration) {
            size = [Int(CameraCaptureManager.width), Int(CameraCaptureManager.height)]
            courtPx = cal.corners.map { [$0.x, $0.y] }
            postsPx = cal.netPosts?.map { [$0.x, $0.y] }
        }
    }

    /// Persistent per-clip upload state.
    private struct Upload: Codable {
        var rallyIdx: Int
        var clipPath: String
        var startS: Double
        var config: Config
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
    private var uploads: [Int: Upload] = [:]
    private var responses: [Int: Data] = [:]
    private static let manifestURL = CameraCaptureManager.clipsDirectory.appendingPathComponent("uploads.json")
    private static let partsDirectory: URL = {
        let dir = CameraCaptureManager.clipsDirectory.appendingPathComponent("parts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private override init() {
        super.init()
        delegateQueue.addOperation {
            if let data = try? Data(contentsOf: Self.manifestURL),
               let saved = try? JSONDecoder().decode([Int: Upload].self, from: data) { self.uploads = saved }
            _ = self.session                                // reconnect to tasks from a previous launch
        }
    }

    // MARK: Public API

    /// Queues a finished rally clip for upload.
    ///
    /// - Parameters:
    ///   - clip: `rally_{idx}.mov` in Application Support.
    ///   - rallyIdx: Rally index within the session.
    ///   - startS: Clip start relative to the session start (seconds).
    ///   - config: Endpoint, token and session metadata.
    func enqueue(clip: URL, rallyIdx: Int, startS: Double, config: Config) {
        delegateQueue.addOperation {
            self.uploads[rallyIdx] = Upload(rallyIdx: rallyIdx, clipPath: clip.path, startS: startS, config: config)
            self.save()
            self.createJob(rallyIdx)
        }
    }

    /// Re-drives uploads that exhausted their retries (call when the app returns to the foreground).
    func resumePending() {
        delegateQueue.addOperation {
            for (idx, u) in self.uploads where u.failed {
                self.uploads[idx]?.failed = false
                self.uploads[idx]?.attempts = [:]
                if let jobId = u.jobId { self.fetchReceivedParts(idx, jobId: jobId) } else { self.createJob(idx) }
            }
            self.save()
        }
    }

    // MARK: Steps

    private func createJob(_ idx: Int) {
        guard let u = uploads[idx] else { return }
        let size = (try? FileManager.default.attributesOfItem(atPath: u.clipPath)[.size] as? Int) ?? 0
        let court = u.config.court.flatMap { try? JSONSerialization.jsonObject(with: JSONEncoder.snake.encode($0)) }
        let body: [String: Any] = [
            "match_id": u.config.matchId.uuidString.lowercased(), "rally_idx": idx, "source": "ios",
            "session_type": u.config.sessionType.rawValue, "court": court ?? NSNull(), "doubles": u.config.doubles,
            "size_bytes": size, "content_type": "video/quicktime", "start_s": u.startS,
        ]
        send(request(u, path: "jobs", method: "POST"), json: body, tag: Tag(kind: .create, rallyIdx: idx))
    }

    private func didCreateJob(_ idx: Int, response: Data) {
        guard var u = uploads[idx], let json = Self.json(response), let jobId = json["job_id"] as? String else {
            return markFailed(idx)
        }
        u.jobId = jobId
        u.done = Set(json["received_parts"] as? [Int] ?? [])        // 200 on an identical repeat keeps progress
        u.partCount = splitParts(u.clipPath, rallyIdx: idx, partSize: json["part_size"] as? Int ?? Self.defaultPartSize)
        uploads[idx] = u
        save()
        guard u.partCount > 0 else { return markFailed(idx) }
        sendMissingOrCommit(idx)
    }

    /// Writes part files (background sessions can only upload from files).
    private func splitParts(_ path: String, rallyIdx: Int, partSize: Int) -> Int {
        guard let handle = FileHandle(forReadingAtPath: path) else { return 0 }
        defer { try? handle.close() }
        var n = 0
        while let chunk = try? handle.read(upToCount: partSize), !chunk.isEmpty {
            guard (try? chunk.write(to: partURL(rallyIdx, n))) != nil else { return 0 }
            n += 1
        }
        return n
    }

    private func sendMissingOrCommit(_ idx: Int) {
        guard let u = uploads[idx] else { return }
        let missing = (0..<u.partCount).filter { !u.done.contains($0) }
        if missing.isEmpty { return commit(idx) }
        missing.forEach { sendPart(idx, part: $0) }
    }

    private func sendPart(_ idx: Int, part: Int, delay: TimeInterval = 0) {
        guard let u = uploads[idx], let jobId = u.jobId, let data = try? Data(contentsOf: partURL(idx, part)) else {
            return markFailed(idx)
        }
        var req = request(u, path: "jobs/\(jobId)/parts/\(part)", method: "PUT")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), forHTTPHeaderField: "X-Part-Sha256")
        upload(req, file: partURL(idx, part), tag: Tag(kind: .part, rallyIdx: idx, part: part), delay: delay)
    }

    private func fetchReceivedParts(_ idx: Int, jobId: String) {
        guard let u = uploads[idx] else { return }
        URLSession.shared.dataTask(with: request(u, path: "jobs/\(jobId)", method: "GET")) { data, _, _ in
            self.delegateQueue.addOperation {
                guard self.uploads[idx] != nil else { return }
                if let received = data.flatMap(Self.json)?["received_parts"] as? [Int] {
                    self.uploads[idx]?.done = Set(received)
                }
                self.save()
                self.sendMissingOrCommit(idx)
            }
        }.resume()
    }

    private func commit(_ idx: Int, delay: TimeInterval = 0) {
        guard let u = uploads[idx], let jobId = u.jobId else { return }
        send(request(u, path: "jobs/\(jobId)/commit", method: "POST"), json: [:], tag: Tag(kind: .commit, rallyIdx: idx),
             delay: delay)
    }

    /// Modal confirmed the file is assembled on its volume: the phone keeps nothing.
    private func didCommit(_ idx: Int) {
        guard let u = uploads.removeValue(forKey: idx) else { return }
        try? FileManager.default.removeItem(atPath: u.clipPath)
        (0..<u.partCount).forEach { try? FileManager.default.removeItem(at: partURL(idx, $0)) }
        try? FileManager.default.removeItem(at: Self.partsDirectory.appendingPathComponent("create_\(idx).json"))
        try? FileManager.default.removeItem(at: Self.partsDirectory.appendingPathComponent("commit_\(idx).json"))
        save()
    }

    private func markFailed(_ idx: Int) {
        uploads[idx]?.failed = true
        save()
    }

    // MARK: Plumbing

    private struct Tag: Codable {
        enum Kind: String, Codable {
            case create
            case part
            case commit
        }

        var kind: Kind
        var rallyIdx: Int
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
        let file = Self.partsDirectory.appendingPathComponent("\(tag.kind.rawValue)_\(tag.rallyIdx).json")
        guard let body = try? JSONSerialization.data(withJSONObject: json), (try? body.write(to: file)) != nil else {
            return markFailed(tag.rallyIdx)
        }
        upload(req, file: file, tag: tag, delay: delay)
    }

    private func upload(_ req: URLRequest, file: URL, tag: Tag, delay: TimeInterval = 0) {
        let task = session.uploadTask(with: req, fromFile: file)
        task.taskDescription = (try? JSONEncoder().encode(tag)).flatMap { String(data: $0, encoding: .utf8) }
        if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
        task.resume()
    }

    private func partURL(_ idx: Int, _ part: Int) -> URL {
        Self.partsDirectory.appendingPathComponent("rally_\(idx)_part_\(part).bin")
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
              uploads[tag.rallyIdx] != nil else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let ok = error == nil && (200..<300).contains(status)
        switch (tag.kind, ok) {
        case (.create, true):
            didCreateJob(tag.rallyIdx, response: body)
        case (.part, true):
            uploads[tag.rallyIdx]?.done.insert(tag.part)
            save()
            if let u = uploads[tag.rallyIdx], u.done.count >= u.partCount { commit(tag.rallyIdx) }
        case (.commit, true):
            didCommit(tag.rallyIdx)
        case (.commit, false) where status == 409:
            // Parts missing on the server: mark them not-done and re-send.
            let missing = Self.json(body)?["missing"] as? [Int] ?? []
            missing.forEach { uploads[tag.rallyIdx]?.done.remove($0) }
            save()
            missing.isEmpty ? retry(tag) : sendMissingOrCommit(tag.rallyIdx)
        case (_, false) where status == 401 || status == 403:
            markFailed(tag.rallyIdx)                        // bad / expired device token: retrying won't help
        case (_, false):
            retry(tag)
        }
    }

    /// Exponential backoff (2 s, 4 s), then park as failed until `resumePending()`.
    private func retry(_ tag: Tag) {
        guard uploads[tag.rallyIdx] != nil else { return }
        let attempt = (uploads[tag.rallyIdx]?.attempts[tag.retryKey] ?? 0) + 1
        uploads[tag.rallyIdx]?.attempts[tag.retryKey] = attempt
        save()
        guard attempt < Self.maxAttempts else { return markFailed(tag.rallyIdx) }
        let delay = pow(2, Double(attempt))
        switch tag.kind {
        case .part: sendPart(tag.rallyIdx, part: tag.part, delay: delay)
        case .create: createJob(tag.rallyIdx)
        case .commit: commit(tag.rallyIdx, delay: delay)
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
