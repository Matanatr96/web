"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { commitTennisMatch, createTennisMatch } from "@/app/tennis/actions";
import {
  applyHomography,
  getUploadResumeKey,
  ITF_DOUBLES_HALF_WIDTH_M,
  ITF_HALF_LENGTH_M,
  ITF_SERVICE_LINE_M,
  ITF_SINGLES_HALF_WIDTH_M,
  MODAL_PART_SIZE_BYTES,
  type Point2D,
  scaleCalibrationPoints,
  type TennisSessionType,
  validateCourtCalibration,
} from "@/lib/tennis";

const TAP_STEPS = [
  "Near-Left outer corner",
  "Near-Right outer corner",
  "Far-Right outer corner",
  "Far-Left outer corner",
  "Left net-post top",
  "Right net-post top",
] as const;

const LOUPE_PX = 128;
const LOUPE_ZOOM = 4;

/** Court segments (metres) drawn as the live wireframe preview. */
const WIREFRAME: Array<[Point2D, Point2D]> = (() => {
  const w = ITF_DOUBLES_HALF_WIDTH_M;
  const s = ITF_SINGLES_HALF_WIDTH_M;
  const l = ITF_HALF_LENGTH_M;
  const sv = ITF_SERVICE_LINE_M;
  return [
    [[-w, -l], [w, -l]],
    [[w, -l], [w, l]],
    [[w, l], [-w, l]],
    [[-w, l], [-w, -l]],
    [[-s, -l], [-s, l]],
    [[s, -l], [s, l]],
    [[-s, -sv], [s, -sv]],
    [[-s, sv], [s, sv]],
    [[0, -sv], [0, sv]],
    [[-w, 0], [w, 0]],
  ];
})();

type JobState = { job_id: string; part_size: number; parts_expected: number; received_parts: number[] };

type StoredUploadSession = {
  matchId: string;
  jobId?: string;
  jobToken: string;
  modalEndpoint: string;
  createdAt: number;
};

const RESUME_MAX_AGE_MS = 11 * 60 * 60 * 1000;

function readStoredUpload(key: string): StoredUploadSession | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredUploadSession;
    if (!parsed.matchId || Date.now() - parsed.createdAt > RESUME_MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredUpload(key: string, session: StoredUploadSession): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(session));
  } catch {
    // Ignore storage quota errors in private-browsing modes.
  }
}

function clearStoredUpload(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

async function modalFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), "X-Job-Token": token } });
}

async function putPartWithRetry(url: string, token: string, body: Blob, attempts = 3): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await modalFetch(url, token, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) break; // retrying will not fix auth
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error(`Part upload failed (${lastError}): ${url}`);
}

/**
 * Admin uploader for `/tennis`: picks Rally (default) or Match mode, grabs Frame 0 from the selected
 * video (or from a PNG/JPG screenshot when the browser cannot decode HEVC `.mov`), lets the admin tap
 * the 4 outer corners + 2 net-post tops with a 4x loupe and a live green homography wireframe, then
 * uploads the video to the Modal `tennis-rally` API in resumable 32 MiB parts (3 retries each, resume
 * via `GET /jobs/{id}`, re-sends parts reported missing at commit).
 *
 * @returns The collapsed "Upload" button or the expanded calibration/upload panel.
 */
export default function TennisCalibUploader() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [sessionType, setSessionType] = useState<TennisSessionType>("rally");
  const [title, setTitle] = useState("");
  const [playedOn, setPlayedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [doubles, setDoubles] = useState(false);
  const [runBiomech, setRunBiomech] = useState(false);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSize, setVideoSize] = useState<[number, number] | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<[number, number]>([1920, 1080]);
  const [points, setPoints] = useState<Point2D[]>([]);
  const [hoverPx, setHoverPx] = useState<Point2D | null>(null);

  const [busy, setBusy] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const cornersPx = useMemo(() => points.slice(0, 4), [points]);
  // Pass netPostsPx whenever the user has tapped >4 points so a 5th tap validates and prompts for the 6th tap.
  const netPostsPx = useMemo(() => (points.length > 4 ? points.slice(4, 6) : undefined), [points]);
  const validation = useMemo(
    () =>
      cornersPx.length < 4
        ? { valid: false, errors: [] as string[], calibration: null }
        : validateCourtCalibration({ imageSize, cornersPx, netPostsPx, doubles }),
    [imageSize, cornersPx, netPostsPx, doubles],
  );
  const wireframeCalibration = useMemo(
    () =>
      validation.calibration ??
      (cornersPx.length === 4 ? validateCourtCalibration({ imageSize, cornersPx, doubles }).calibration : null),
    [validation.calibration, imageSize, cornersPx, doubles],
  );

  // Overlay: tapped points and, once the 4 corners are valid, the projected court wireframe.
  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    const ctx = overlay?.getContext("2d");
    if (!overlay || !ctx) return;
    overlay.width = imageSize[0];
    overlay.height = imageSize[1];
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (wireframeCalibration) {
      const Hinv = wireframeCalibration.homographyToImage;
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 3;
      for (const [a, b] of WIREFRAME) {
        try {
          const [u1, v1] = applyHomography(Hinv, a);
          const [u2, v2] = applyHomography(Hinv, b);
          ctx.beginPath();
          ctx.moveTo(u1, v1);
          ctx.lineTo(u2, v2);
          ctx.stroke();
        } catch {
          // Segment crosses the horizon; skip it in the preview.
        }
      }
    }

    points.forEach(([u, v], idx) => {
      ctx.fillStyle = idx >= 4 ? "#f59e0b" : "#22c55e";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(u, v, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(idx + 1), u, v);
    });
  }, [points, imageSize, wireframeCalibration]);

  // 4x loupe around the cursor, sampled from the Frame-0 canvas.
  useEffect(() => {
    const loupe = loupeCanvasRef.current;
    const base = baseCanvasRef.current;
    const ctx = loupe?.getContext("2d");
    if (!loupe || !base || !ctx || !hoverPx) return;
    const r = LOUPE_PX / (2 * LOUPE_ZOOM);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, LOUPE_PX, LOUPE_PX);
    ctx.drawImage(base, hoverPx[0] - r, hoverPx[1] - r, 2 * r, 2 * r, 0, 0, LOUPE_PX, LOUPE_PX);
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_PX / 2, 0);
    ctx.lineTo(LOUPE_PX / 2, LOUPE_PX);
    ctx.moveTo(0, LOUPE_PX / 2);
    ctx.lineTo(LOUPE_PX, LOUPE_PX / 2);
    ctx.stroke();
  }, [hoverPx]);

  const paintFrame = (source: CanvasImageSource, w: number, h: number) => {
    const canvas = baseCanvasRef.current;
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(source, 0, 0, w, h);
    setImageSize([w, h]);
    setPoints([]);
    setFrameLoaded(true);
    setDecodeError(null);
  };

  const handleVideoSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setVideoSize(null);
    setFrameLoaded(false);
    setError(null);

    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadedmetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize([video.videoWidth, video.videoHeight]);
      }
    };
    video.onloadeddata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize([video.videoWidth, video.videoHeight]);
      }
      video.currentTime = 0;
    };
    video.onseeked = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoSize([video.videoWidth, video.videoHeight]);
        paintFrame(video, video.videoWidth, video.videoHeight);
      }
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      setDecodeError(
        "This browser can't decode Frame 0 of the video (common for HEVC .mov). Upload a screenshot of the first frame instead; the video itself still uploads unchanged.",
      );
    };
    video.src = url;
  };

  const handleScreenshotSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      paintFrame(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const toFramePx = (e: MouseEvent<HTMLCanvasElement>): Point2D | null => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const u = Math.round(((e.clientX - rect.left) / rect.width) * imageSize[0]);
    const v = Math.round(((e.clientY - rect.top) / rect.height) * imageSize[1]);
    return [Math.max(0, Math.min(imageSize[0], u)), Math.max(0, Math.min(imageSize[1], v))];
  };

  const handleUpload = async () => {
    if (!videoFile || !validation.valid) return;
    setBusy(true);
    setError(null);
    setProgressPct(0);
    const resumeKey = getUploadResumeKey(videoFile);
    const cachedSession = readStoredUpload(resumeKey);
    const targetVideoSize = videoSize ?? imageSize;
    const scaledCorners = scaleCalibrationPoints(cornersPx, imageSize, targetVideoSize);
    const scaledNetPosts = netPostsPx ? scaleCalibrationPoints(netPostsPx, imageSize, targetVideoSize) : undefined;

    try {
      setStatus(cachedSession ? "Resuming session…" : "Creating session…");
      const { matchId, jobToken, modalEndpoint, court } = await createTennisMatch({
        id: cachedSession?.matchId,
        title,
        playedOn,
        sessionType,
        doubles,
        imageSize: targetVideoSize,
        cornersPx: scaledCorners,
        netPostsPx: scaledNetPosts,
      });

      writeStoredUpload(resumeKey, {
        matchId,
        jobId: cachedSession?.jobId,
        jobToken,
        modalEndpoint,
        createdAt: cachedSession?.createdAt ?? Date.now(),
      });

      let job: JobState | null = null;
      if (cachedSession?.jobId) {
        setStatus("Checking already-uploaded parts on Modal…");
        const statusRes = await modalFetch(
          `${modalEndpoint}/jobs/${encodeURIComponent(cachedSession.jobId)}`,
          jobToken,
          { method: "GET" },
        );
        if (statusRes.ok) {
          job = (await statusRes.json()) as JobState;
        }
      }

      if (!job) {
        setStatus("Registering upload with Modal…");
        const jobRes = await modalFetch(`${modalEndpoint}/jobs`, jobToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            match_id: matchId,
            rally_idx: null,
            source: "web",
            session_type: sessionType,
            court,
            doubles,
            size_bytes: videoFile.size,
            content_type: /\.mov$/i.test(videoFile.name) || videoFile.type === "video/quicktime" ? "video/quicktime" : "video/mp4",
            title: title.trim() || null,
            played_on: playedOn,
            biomech: runBiomech,
          }),
        });
        if (!jobRes.ok) throw new Error(`Modal POST /jobs failed: HTTP ${jobRes.status} ${await jobRes.text()}`);
        job = (await jobRes.json()) as JobState;
      }

      writeStoredUpload(resumeKey, {
        matchId,
        jobId: job.job_id,
        jobToken,
        modalEndpoint,
        createdAt: cachedSession?.createdAt ?? Date.now(),
      });

      const partSize = job.part_size || MODAL_PART_SIZE_BYTES;
      const jobUrl = `${modalEndpoint}/jobs/${encodeURIComponent(job.job_id)}`;

      const uploadParts = async (parts: number[]) => {
        let done = job.parts_expected - parts.length;
        for (const n of parts) {
          setStatus(`Uploading part ${n + 1} of ${job.parts_expected}…`);
          await putPartWithRetry(`${jobUrl}/parts/${n}`, jobToken, videoFile.slice(n * partSize, (n + 1) * partSize));
          done += 1;
          setProgressPct(Math.round((done / job.parts_expected) * 95));
        }
      };
      const received = new Set(job.received_parts ?? []);
      await uploadParts(Array.from({ length: job.parts_expected }, (_, n) => n).filter((n) => !received.has(n)));

      setStatus("Committing upload…");
      let commitRes = await modalFetch(`${jobUrl}/commit`, jobToken, { method: "POST" });
      if (commitRes.status === 409) {
        const { missing = [] } = (await commitRes.json()) as { missing?: number[] };
        await uploadParts(missing);
        commitRes = await modalFetch(`${jobUrl}/commit`, jobToken, { method: "POST" });
      }
      if (!commitRes.ok) throw new Error(`Modal commit failed: HTTP ${commitRes.status} ${await commitRes.text()}`);

      await commitTennisMatch(matchId);
      clearStoredUpload(resumeKey);
      setProgressPct(100);
      setStatus("Uploaded. Modal is processing the session…");
      router.push(`/tennis/${matchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setBusy(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition"
      >
        + Upload session
      </button>
    );
  }

  const modeCard = (mode: TennisSessionType, label: string, description: string) => (
    <button
      type="button"
      onClick={() => setSessionType(mode)}
      aria-pressed={sessionType === mode}
      className={`text-left rounded-md border p-3 transition ${
        sessionType === mode
          ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40"
          : "border-stone-200 dark:border-stone-800 hover:border-stone-400"
      }`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <p className="text-xs text-stone-500 mt-1">{description}</p>
    </button>
  );

  return (
    <section className="w-full rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 mb-8">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold tracking-tight">New session</h2>
        <button type="button" onClick={() => setIsOpen(false)} disabled={busy} className="text-xs text-stone-500 hover:underline">
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        {modeCard(
          "rally",
          "Rally Session (Default)",
          "Practice hitting. A rally starts on any feed and keeps going if you play on after an out ball. Tracks streaks, 10+ shot rallies and deep-zone %.",
        )}
        {modeCard("match", "Scored Match", "Serves judged against the service boxes, points end on an out, and a set/game/point scoreboard.")}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4 text-sm">
        <label className="block">
          <span className="block text-xs text-stone-500 mb-1">Title</span>
          <input
            type="text"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-stone-200 dark:border-stone-800 bg-transparent px-3 py-1.5"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-stone-500 mb-1">Date played</span>
          <input
            type="date"
            value={playedOn}
            onChange={(e) => setPlayedOn(e.target.value)}
            className="w-full rounded-md border border-stone-200 dark:border-stone-800 bg-transparent px-3 py-1.5"
          />
        </label>
        <div className="flex flex-col justify-end gap-1 text-xs">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={doubles} onChange={(e) => setDoubles(e.target.checked)} />
            Doubles lines
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={runBiomech} onChange={(e) => setRunBiomech(e.target.checked)} />
            Run biomechanics (Phase 3)
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3 text-xs">
        <label className="block">
          <span className="block text-stone-500 mb-1">Video (.mov / .mp4, 1080p60)</span>
          <input type="file" accept="video/mp4,video/quicktime" onChange={handleVideoSelect} disabled={busy} />
        </label>
        <label className="block">
          <span className="block text-stone-500 mb-1">First-frame screenshot (if the video won&apos;t preview)</span>
          <input type="file" accept="image/png,image/jpeg" onChange={handleScreenshotSelect} disabled={busy} />
        </label>
      </div>

      {decodeError && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {decodeError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs">
        <span>
          {points.length < 6 ? (
            <>
              Tap {points.length + 1}/6: <strong>{TAP_STEPS[points.length]}</strong>
              {points.length >= 4 && " (optional)"}
            </>
          ) : (
            "All 6 points placed."
          )}
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => setPoints((p) => p.slice(0, -1))}
            disabled={points.length === 0 || busy}
            className="rounded border border-stone-200 dark:border-stone-700 px-2 py-1 disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setPoints([])}
            disabled={points.length === 0 || busy}
            className="rounded border border-stone-200 dark:border-stone-700 px-2 py-1 disabled:opacity-40"
          >
            Reset
          </button>
        </span>
      </div>

      <div className="relative mb-3 overflow-hidden rounded-md border border-stone-300 dark:border-stone-700 bg-stone-950">
        <canvas ref={baseCanvasRef} className="block w-full h-auto" />
        <canvas
          ref={overlayCanvasRef}
          onClick={(e) => {
            if (!frameLoaded || points.length >= 6 || busy) return;
            const pt = toFramePx(e);
            if (pt) setPoints((p) => [...p, pt]);
          }}
          onMouseMove={(e) => setHoverPx(toFramePx(e))}
          onMouseLeave={() => setHoverPx(null)}
          className="absolute inset-0 h-full w-full cursor-crosshair"
        />
        {!frameLoaded && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-stone-400">
            Choose a video (or a first-frame screenshot) to calibrate the court.
          </div>
        )}
        {frameLoaded && hoverPx && (
          <div className="pointer-events-none absolute top-2 right-2 rounded border-2 border-emerald-400 bg-stone-950 p-1">
            <canvas ref={loupeCanvasRef} width={LOUPE_PX} height={LOUPE_PX} className="block" />
            <div className="text-[10px] text-center font-mono text-emerald-300">
              4× ({hoverPx[0]}, {hoverPx[1]})
            </div>
          </div>
        )}
      </div>

      {validation.errors.length > 0 && (
        <ul className="mb-3 rounded-md border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {validation.errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mb-3 rounded-md border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}
      {busy && (
        <div className="mb-3 text-xs text-stone-500">
          <div className="flex justify-between mb-1">
            <span>{status}</span>
            <span className="tabular-nums">{progressPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
            <div className="h-full bg-emerald-600 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleUpload}
          disabled={!videoFile || !validation.valid || busy}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 transition"
        >
          {busy ? "Uploading…" : "Upload & analyse"}
        </button>
      </div>
    </section>
  );
}
