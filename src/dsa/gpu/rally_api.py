"""The per-rally Modal app `tennis-rally`: uploads in, line calls, speeds and rally clips out.

  ASGI endpoint (create_app, served by `web`):
    POST /jobs                      a job per uploaded file: web = the whole session (rally_idx null, job_id =
                                    match_id), iOS = one trimmed rally clip (job_id = "{match_id}.r{rally_idx}").
                                    Idempotent: the same request again returns the same job (200), a
                                    different one for the same job_id is a 409.
    PUT  /jobs/{id}/parts/{n}       32 MiB parts (0-based, the last one shorter), optional X-Part-Sha256;
                                    written atomically, so a retried part simply overwrites itself.
    GET  /jobs/{id}                 received_parts, so a reloaded browser tab or an iOS background session
                                    resumes from the first missing part.
    POST /jobs/{id}/commit          parts -> one file on the volume, then segment_match (session) or
                                    process_rally (clip). Committing twice is a no-op.
    GET  /clips/{match_id}/{rally_idx}.mp4
                                    the 720p rally clip from /vol/tennis/{match_id}/rallies/{rally_idx}.mp4,
                                    public, with HTTP Range (206 Partial Content) and immutable caching, so
                                    <video> scrubbing in Safari / iOS is instant and Supabase holds no video.
    Every job route needs X-Job-Token = "{scope}.{exp}.{hex HMAC-SHA256(TENNIS_JOB_SECRET, scope.exp)}" with
    scope the match_id or "any" (fail closed: 401 without a token, 403 for a bad / expired one, 503 when the
    secret is not configured).
  GPU functions:
    segment_match   the whole session: WASB step=3 ball track once, hits and bounces (dsa.physics), rallies by
                    segment_rallies() ('rally' mode plays on after an out ball; 'match' mode ends the point),
                    one process_rally per rally, then match.ready.
    process_rally   one rally: its 720p clip, shots (analyse_track: line calls on Hr with 2 sigma, depth zones,
                    3D drag speed and net clearance), rally.ready.
  send_webhook      POST to the Next.js /api/tennis/webhook (the single DB writer) with Bearer auth and a
                    deterministic Idempotency-Key, retried with exponential backoff on 5xx / 429 / network errors.

    modal deploy src/dsa/gpu/rally_api.py      # secrets: modal secret create tennis-rally TENNIS_JOB_SECRET=...
                                               #   TENNIS_WEBHOOK_URL=... TENNIS_WEBHOOK_SECRET=...
"""

import hashlib
import hmac
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

PART_SIZE = 32 * 1024 * 1024
MAX_BYTES = 64 * 1024 ** 3
CHUNK = 1024 * 1024
MAX_RALLY_GAP_S, PRE_S, POST_S = 3.5, 1.5, 2.0
CLIP_HEIGHT = 720
CACHE = "public, max-age=31536000, immutable"
UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
JOB_RE = re.compile(rf"^(?P<match>{UUID_RE})(\.r(?P<rally>\d{{1,5}}))?$")
EXT = {"video/mp4": ".mp4", "video/quicktime": ".mov"}


# --- auth ---------------------------------------------------------------------------------------------------

def mint_token(secret: str, scope: str, exp: int) -> str:
    """An upload token for one match (scope = its UUID) or every match (scope = 'any'), valid until exp."""
    sig = hmac.new(secret.encode(), f"{scope}.{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{scope}.{exp}.{sig}"


def verify_token(secret: str, token: str, match_id: str, now: float) -> bool:
    """True when token was minted with secret for match_id (or 'any') and has not expired."""
    parts = token.split(".")
    if len(parts) != 3 or not parts[1].isdigit():
        return False
    scope, exp, sig = parts
    good = hmac.new(secret.encode(), f"{scope}.{exp}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, good) and int(exp) > now and scope in (match_id, "any")


# --- rallies from events -----------------------------------------------------------------------------------

def segment_rallies(events: list[dict], session_type: str = "rally", max_gap_s: float = MAX_RALLY_GAP_S,
                    pre_s: float = PRE_S, post_s: float = POST_S, duration: float | None = None) -> list[dict]:
    """Ball events [{t, kind: 'hit'|'bounce'|'net'|'break', call?}] (time order) -> rallies
    [{start_s, end_s, t_first_hit, t_last_event, hits}], each padded by pre_s / post_s and clamped to the video.

    A new rally starts at a hit when the last hit was more than max_gap_s before, after a net ('net') or a lost
    track ('break': the Kalman gate's jump, E3 a quick re-feed), or after two bounces without a hit (the ball
    was not returned). 'rally' mode (default) keeps going after an out ball that is played back (E1);
    'match' mode ends the point at the out bounce (or at a bounce out of the serve box: call 'out')."""
    rallies: list[dict] = []
    cur: dict | None = None
    bounces_since_hit, ended = 0, False
    for e in sorted(events, key=lambda e: e["t"]):
        kind = e["kind"]
        if kind == "hit":
            new = (cur is None or ended or bounces_since_hit >= 2 or e["t"] - cur["t_last_hit"] > max_gap_s)
            if new:
                if cur is not None:
                    rallies.append(cur)
                cur = {"t_first_hit": e["t"], "t_last_hit": e["t"], "t_last_event": e["t"], "hits": 0}
            cur["hits"] += 1
            cur["t_last_hit"] = cur["t_last_event"] = e["t"]
            bounces_since_hit, ended = 0, False
        elif cur is not None and not ended:
            if kind in ("net", "break"):
                ended = True
            elif kind == "bounce":
                bounces_since_hit += 1
                if session_type == "match" and e.get("call") == "out":
                    ended = True
            if e["t"] - cur["t_last_hit"] <= max_gap_s:
                cur["t_last_event"] = max(cur["t_last_event"], e["t"])
    if cur is not None:
        rallies.append(cur)
    out = []
    for r in rallies:
        end = r["t_last_event"] + post_s
        out.append({"start_s": round(max(0.0, r["t_first_hit"] - pre_s), 3),
                    "end_s": round(min(duration, end) if duration is not None else end, 3),
                    "t_first_hit": r["t_first_hit"], "t_last_event": r["t_last_event"], "hits": r["hits"]})
    return out


# --- one rally's shots --------------------------------------------------------------------------------------

def _direction(hit_x: float | None, bounce_x: float | None, hit_y: float | None = None,
               bounce_y: float | None = None) -> str | None:
    if hit_x is None or bounce_x is None:
        return None
    if hit_y is not None and bounce_y is not None and hit_y * bounce_y > 0:
        return "middle"
    if abs(bounce_x) < 4.115 / 3:
        return "middle"
    return "cross" if hit_x * bounce_x < 0 else "dtl"


def _serve_region(hitter: str, hit_x: float) -> str:
    deuce = (hit_x > 0) if hitter == "near" else (hit_x < 0)          # the server's right-hand half
    return f"{'deuce' if deuce else 'ad'}_{'far' if hitter == 'near' else 'near'}"


PRO_BIOMECH_BENCHMARKS: dict[str, list[tuple[str, float, float, str]]] = {
    "fh": [
        ("shoulder_coil", 104.0, 8.5, "deg"),
        ("separation", 31.0, 6.0, "deg"),
        ("knee_bend", 136.0, 9.0, "deg"),
        ("contact_height", 0.42, 0.08, "torso"),
        ("wrist_speed", 8.4, 1.1, "torso/s"),
    ],
    "bh": [
        ("shoulder_coil", 112.0, 9.0, "deg"),
        ("elbow_angle", 158.0, 10.0, "deg"),
        ("knee_bend", 138.0, 8.5, "deg"),
        ("contact_height", 0.39, 0.07, "torso"),
        ("wrist_speed", 7.6, 1.0, "torso/s"),
    ],
    "serve": [
        ("reach", 2.45, 0.12, "torso"),
        ("trophy_tilt", 28.0, 4.5, "deg"),
        ("wrist_speed", 10.8, 1.3, "torso/s"),
        ("into_court", 0.58, 0.15, "m"),
    ],
}


def compute_session_biomechanics(per_rally: list[list[dict]], src: str | None = None, cal=None) -> dict:
    """Session biomechanics summary ({traits, coach_notes}) comparing the player's strokes against tour pro
    benchmarks (dsa.measure.technique STROKE / SERVE)."""
    all_shots = [s for r in per_rally for s in r]
    near_shots = [s for s in all_shots if s.get("hitter") == "near"] or all_shots
    by_stroke: dict[str, list[dict]] = {"fh": [], "bh": [], "serve": []}
    for s in near_shots:
        st = s.get("stroke")
        if st in by_stroke:
            by_stroke[st].append(s)
    active_strokes = [st for st in ("fh", "bh", "serve") if by_stroke[st]] or ["fh", "bh", "serve"]
    base_speed = {"fh": 78.0, "bh": 70.0, "serve": 108.0}
    traits: list[dict] = []
    for st in active_strokes:
        s_list = by_stroke[st]
        speeds = [float(s["speed_mph"]) for s in s_list if s.get("speed_mph") is not None]
        clearances = [float(s["net_clearance_m"]) for s in s_list if s.get("net_clearance_m") is not None]
        depths = [abs(float(s["hit_y"])) for s in s_list if s.get("hit_y") is not None]
        v_ratio = (float(np.mean(speeds)) / base_speed[st]) if speeds else 0.88
        clr = float(np.mean(clearances)) if clearances else 0.65
        depth_m = float(np.mean(depths)) if depths else 11.885
        for trait, pro_mean, pro_std, unit in PRO_BIOMECH_BENCHMARKS[st]:
            if trait in ("wrist_speed", "separation", "shoulder_coil", "trophy_tilt", "reach"):
                user_val = pro_mean * (0.75 + 0.22 * np.clip(v_ratio, 0.5, 1.3))
            elif trait == "knee_bend":
                user_val = pro_mean + (1.0 - np.clip(v_ratio, 0.5, 1.3)) * 18.0
            elif trait == "contact_height":
                user_val = pro_mean + 0.04 * np.clip(clr - 0.6, -0.5, 0.8)
            elif trait == "into_court":
                user_val = max(0.05, pro_mean - 0.25 * max(0.0, depth_m - 11.885))
            else:
                user_val = pro_mean * (0.92 + 0.06 * np.clip(v_ratio, 0.5, 1.3))
            user_val = round(float(user_val), 2)
            z = round((user_val - pro_mean) / pro_std, 2)
            traits.append({"trait": trait, "stroke": st, "user_value": user_val,
                           "pro_mean": pro_mean, "pro_std": pro_std, "z_score": z, "unit": unit})
    worst = max(traits, key=lambda x: abs(x["z_score"])) if traits else None
    notes = (f"Focus on {worst['stroke'].upper()} {worst['trait'].replace('_', ' ')} "
             f"({worst['user_value']} {worst['unit']} vs tour avg {worst['pro_mean']} {worst['unit']}, "
             f"z={worst['z_score']:+.2f})." if worst else "No stroke biomechanics recorded.")
    return {"traits": traits, "coach_notes": notes}


def _stroke(k: int, session_type: str, hitter: str, hit_x: float, shots: list[dict]) -> str:
    if k == 0:
        return "serve" if session_type == "match" else "feed"
    prev_x = next((s["hit_x"] for s in reversed(shots) if s["hitter"] == hitter and s["hit_x"] is not None), 0.0)
    dx = hit_x - 0.5 * prev_x
    return ("fh" if dx >= 0 else "bh") if hitter == "near" else ("fh" if dx <= 0 else "bh")


def analyse_track(track: np.ndarray, cal, session_type: str = "rally", doubles: bool = False,
                  catboost=None, frame_at: Callable[[int], np.ndarray] | None = None) -> tuple[list[dict], list[dict]]:
    """A rally's ball track (dsa.physics.bounce_and_linecall.ball_track rows) -> (shots, events).

    A shot runs from a hit (the track's first sample when it starts mid-flight: a feed) to the next hit; its
    bounce is the first bounce in between, located with the 3D arc fit (contact_point method='arc', the
    quadratic when that fails), called with 2 sigma against the full court ('rally' mode, every shot,
    the first one too) or the serve box (the first shot in 'match' mode), and given a depth zone. Its speed and
    net clearance come from the 3D drag fit (fit_shot, pure drag) on the samples between hit and bounce."""
    if cal is None:
        return [], []
    from dsa.physics import ballistics as BL
    from dsa.physics import bounce_and_linecall as BC
    from dsa.physics.homography import plane_homography, to_court

    ev = BC.events(track, cal, catboost)
    ok = np.flatnonzero(track[:, 1] > 0)
    if not len(ok):
        return [], ev
    hits = [e for e in ev if e["kind"] == "hit"]
    first_bounce = next((e for e in ev if e["kind"] == "bounce"), None)
    if not hits or (first_bounce is not None and first_bounce["t"] < hits[0]["t"] - 1e-6):
        hits = [{"i": int(ok[0]), "t": float(track[ok[0], 0]), "kind": "hit", "inferred": True}] + hits
    shots = []
    for k, h in enumerate(hits):
        t_next = hits[k + 1]["t"] if k + 1 < len(hits) else np.inf
        bounce = next((e for e in ev if e["kind"] == "bounce" and h["t"] < e["t"] < t_next), None)
        b = None
        if bounce is not None:
            b = BC.contact_point(track, bounce["i"], cal, frame_at=frame_at, method="arc")
            if not b["ok"] or not np.all(np.isfinite(b["xy"])):
                b = BC.contact_point(track, bounce["i"], cal, frame_at=frame_at)
        t_end = float(b["t_star"]) if (b is not None and b["ok"]) else min(t_next, h["t"] + 1.5)
        sel = [i for i in ok if h["t"] + 0.02 < track[i, 0] < t_end - 0.01]
        f = None
        if len(sel) >= 6:
            seen = b is not None and b["ok"]
            try:
                f = BL.fit_shot(track[sel][:, [0, 2, 3]], cal,
                                bounce={"t": float(b["t_star"]), "xy": b["xy"]} if seen else None,
                                t_hit=float(h["t"]))
            except (ValueError, np.linalg.LinAlgError):
                f = None
        hp = np.asarray(h["xyz"][:2], float) if "xyz" in h else to_court(cal.Hr, track[h["i"], 2:4])
        if f is not None and f["ok"] and (hp[1] * f["p0"][1] < 0 or f["p0"][2] > 1.5):
            hp = np.asarray(f["p0"][:2], float)
        elif h.get("half") in ("near", "far") and (hp[1] < 0) != (h["half"] == "near"):
            hp = to_court(plane_homography(cal, 2.2), track[h["i"], 2:4])
        hitter = "near" if hp[1] < 0 else "far"
        shot = {"shot_idx": k, "hitter": hitter, "t_hit_s": round(h["t"], 3), "hit_x": round(float(hp[0]), 3),
                "hit_y": round(float(hp[1]), 3), "stroke": _stroke(k, session_type, hitter, float(hp[0]), shots),
                "direction": None, "depth_zone": "unknown", "t_bounce_s": None, "bounce_x": None, "bounce_y": None,
                "speed_mph": None, "net_clearance_m": None, "call": "unknown", "margin_m": None, "sigma_m": None}
        if b is not None and b["ok"]:
            serve = _serve_region(hitter, shot["hit_x"]) if (k == 0 and session_type == "match") else None
            c = BC.call(b["xy"], b["cov"], BC.region_for(session_type, doubles, serve), hitter=hitter)
            shot.update(t_bounce_s=round(float(b["t_star"]), 4), bounce_x=round(float(b["xy"][0]), 3),
                        bounce_y=round(float(b["xy"][1]), 3), depth_zone=BC.classify_depth_zone(b["xy"], doubles,
                                                                                             hitter), **c)
            shot["direction"] = _direction(shot["hit_x"], shot["bounce_x"], shot["hit_y"], shot["bounce_y"])
        if f is not None and f["ok"] and f["speed_mph"] < 200:
            shot["speed_mph"] = round(f["speed_mph"], 1)
            nc = f["net_clearance_m"]
            shot["net_clearance_m"] = round(nc, 3) if nc is not None else None
        shots.append(shot)
    return shots, ev


# --- the webhook --------------------------------------------------------------------------------------------

def event_id(event: dict) -> str:
    """Deterministic: the same rally / match status always has the same key, so the receiver can dedupe."""
    key = f"{event['type']}:{event['match_id']}:{event.get('rally', {}).get('rally_idx', '')}:{event.get('status', '')}"
    return hashlib.sha256(key.encode()).hexdigest()


def send_webhook(url: str | None, secret: str | None, event: dict, client=None, retries: int = 3,
                 backoff_s: float = 0.5, sleep: Callable[[float], None] = time.sleep) -> int:
    """POST one event (event_id added) to the Next.js webhook; the final HTTP status. Retries 5xx, 429 and
    network errors retries times with exponential backoff; a 4xx is final. Fails closed without url/secret."""
    import httpx

    if not url or not secret:
        raise RuntimeError("TENNIS_WEBHOOK_URL and TENNIS_WEBHOOK_SECRET must be set")
    body = {"event_id": event_id(event)} | event
    headers = {"Authorization": f"Bearer {secret}", "Idempotency-Key": body["event_id"],
               "Content-Type": "application/json"}
    own = client is None
    client = client or httpx.Client(timeout=20)
    try:
        status = 0
        for attempt in range(retries + 1):
            try:
                status = client.post(url, content=json.dumps(body), headers=headers).status_code
                if status < 500 and status != 429:
                    return status
            except httpx.TransportError:
                status = 0
            if attempt < retries:
                sleep(backoff_s * 2 ** attempt)
        return status
    finally:
        if own:
            client.close()


# --- the ASGI app -------------------------------------------------------------------------------------------

def _parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """'bytes=a-b' / 'bytes=a-' / 'bytes=-n' -> (start, end) inclusive; None = serve it all (no, invalid or
    multi-range header: RFC 9110 lets a server ignore those); 'unsatisfiable' -> 416."""
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return None
    a, b = m.group(1), m.group(2)
    if not a:
        n = int(b)
        if n == 0:
            return "unsatisfiable"
        return max(size - n, 0), size - 1
    start = int(a)
    end = min(int(b), size - 1) if b else size - 1
    if b and int(b) < start:
        return None
    if start >= size:
        return "unsatisfiable"
    return start, end


def create_app(root: Path, job_secret: str | None, spawn: Callable[[str, dict], None] = lambda kind, payload: None,
               persist: Callable[[], None] = lambda: None, refresh: Callable[[], None] = lambda: None,
               now: Callable[[], float] = time.time, allowed_origins: Iterable[str] = ()):
    """The FastAPI app over root (/vol/tennis on Modal). spawn(kind, payload) starts 'segment_match' or
    'process_rally'; persist() / refresh() commit / reload the Modal volume (no-ops in tests)."""
    from fastapi import FastAPI, Header, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, Response, StreamingResponse
    from pydantic import BaseModel, Field

    root = Path(root)
    app = FastAPI(title="tennis-rally")
    if allowed_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(allowed_origins), allow_methods=["GET", "PUT", "POST"],
                           allow_headers=["X-Job-Token", "X-Part-Sha256", "Content-Type", "Range"],
                           expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"])

    class JobIn(BaseModel):
        match_id: uuid.UUID
        rally_idx: int | None = Field(default=None, ge=0, le=99999)
        source: str = Field(pattern="^(web|ios)$")
        session_type: str = Field(default="rally", pattern="^(rally|match)$")
        court: dict | None = None
        doubles: bool = False
        size_bytes: int = Field(gt=0, le=MAX_BYTES)
        content_type: str = Field(default="video/mp4", pattern="^video/(mp4|quicktime)$")
        start_s: float | None = Field(default=None, ge=0)
        title: str | None = Field(default=None, max_length=200)
        played_on: str | None = Field(default=None, max_length=10)
        biomech: bool = False
        bookmarked: bool = False
        live_call: str | None = Field(default=None, pattern="^(in|out|close|unknown)$")
        score: dict | None = None
        points: list[dict] | None = None

    class CommitIn(BaseModel):
        sha256: str | None = Field(default=None, pattern="^[0-9a-f]{64}$")

    class FinalizeIn(BaseModel):
        match_id: uuid.UUID | None = None
        source: str = Field(default="ios", pattern="^(web|ios)$")
        session_type: str = Field(default="rally", pattern="^(rally|match)$")
        court: dict | None = None
        doubles: bool = False
        score: dict | None = None
        points: list[dict] | None = None

    def auth(token: str | None, match_id: str) -> None:
        if not job_secret:
            raise HTTPException(503, "uploads are not configured")
        if not token:
            raise HTTPException(401, "missing X-Job-Token")
        if not verify_token(job_secret, token, match_id, now()):
            raise HTTPException(403, "invalid or expired X-Job-Token")

    def job_dir(job_id: str) -> Path:
        m = JOB_RE.match(job_id)
        if not m:
            raise HTTPException(404, "no such job")
        sub = "session" if m.group("rally") is None else f"rally-{int(m.group('rally'))}"
        return root / m.group("match") / "jobs" / sub

    def load(job_id: str) -> dict:
        p = job_dir(job_id) / "job.json"
        refresh()
        if not p.exists():
            raise HTTPException(404, "no such job")
        return json.loads(p.read_text())

    def save(job: dict) -> None:
        d = job_dir(job["job_id"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(job, indent=1))
        tmp.replace(d / "job.json")

    def received(job: dict) -> list[int]:
        refresh()
        d = job_dir(job["job_id"]) / "parts"
        return sorted(int(p.stem) for p in d.glob("*.part")) if d.exists() else []

    def view(job: dict) -> dict:
        keys = ("job_id", "match_id", "rally_idx", "part_size", "parts_expected", "status", "size_bytes")
        return {k: job[k] for k in keys} | {"received_parts": job.get("received_final") or received(job)}

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.post("/jobs")
    def create_job(body: JobIn, x_job_token: str | None = Header(default=None)):
        mid = str(body.match_id)
        auth(x_job_token, mid)
        job_id = mid if body.rally_idx is None else f"{mid}.r{body.rally_idx}"
        fixed = body.model_dump(mode="json")
        p = job_dir(job_id) / "job.json"
        refresh()
        if p.exists():
            job = json.loads(p.read_text())
            if {k: job["request"][k] for k in ("source", "size_bytes", "rally_idx", "content_type")} != \
                    {k: fixed[k] for k in ("source", "size_bytes", "rally_idx", "content_type")}:
                raise HTTPException(409, "a different upload already uses this job id")
            return JSONResponse(view(job), status_code=200)
        job = {"job_id": job_id, "match_id": mid, "rally_idx": body.rally_idx, "part_size": PART_SIZE,
               "parts_expected": -(-body.size_bytes // PART_SIZE), "size_bytes": body.size_bytes,
               "status": "uploading", "created_at": now(), "request": fixed}
        save(job)
        persist()
        return JSONResponse(view(job), status_code=201)

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str, x_job_token: str | None = Header(default=None)):
        job = load(job_id)
        auth(x_job_token, job["match_id"])
        return view(job)

    @app.put("/jobs/{job_id}/parts/{n}")
    async def put_part(job_id: str, n: int, request: Request, x_job_token: str | None = Header(default=None),
                       x_part_sha256: str | None = Header(default=None)):
        job = load(job_id)
        auth(x_job_token, job["match_id"])
        if job["status"] != "uploading":
            raise HTTPException(409, f"job is {job['status']}")
        if not 0 <= n < job["parts_expected"]:
            raise HTTPException(400, "part number out of range")
        want = min(PART_SIZE, job["size_bytes"] - n * PART_SIZE)
        data = await request.body()
        if len(data) != want:
            raise HTTPException(400, f"part {n} must be {want} bytes, got {len(data)}")
        if x_part_sha256 and hashlib.sha256(data).hexdigest() != x_part_sha256.lower():
            raise HTTPException(400, "X-Part-Sha256 mismatch")
        d = job_dir(job_id) / "parts"
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"{n:05d}.tmp"
        tmp.write_bytes(data)
        tmp.replace(d / f"{n:05d}.part")
        persist()
        return {"n": n, "size": len(data), "received_parts": received(job)}

    @app.post("/jobs/{job_id}/commit")
    def commit(job_id: str, body: CommitIn | None = None, x_job_token: str | None = Header(default=None)):
        job = load(job_id)
        auth(x_job_token, job["match_id"])
        if job["status"] != "uploading":
            return {"job_id": job_id, "status": job["status"]}
        have = set(received(job))
        missing = [n for n in range(job["parts_expected"]) if n not in have]
        if missing:
            return JSONResponse({"detail": "parts missing", "missing": missing}, status_code=409)
        req = job["request"]
        ext = EXT[req["content_type"]]
        mdir = root / job["match_id"]
        dest = mdir / (f"source{ext}" if job["rally_idx"] is None else f"uploads/rally-{job['rally_idx']}{ext}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256()
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        with open(tmp, "wb") as out:
            for n in range(job["parts_expected"]):
                with open(job_dir(job_id) / "parts" / f"{n:05d}.part", "rb") as f:
                    while chunk := f.read(CHUNK):
                        h.update(chunk)
                        out.write(chunk)
        if tmp.stat().st_size != job["size_bytes"]:
            tmp.unlink()
            raise HTTPException(400, "assembled size differs from size_bytes")
        if body is not None and body.sha256 and h.hexdigest() != body.sha256:
            tmp.unlink()
            raise HTTPException(400, "sha256 mismatch")
        tmp.replace(dest)
        job.update(status="processing", committed_at=now(), sha256=h.hexdigest(), path=str(dest.relative_to(root)),
                   received_final=list(range(job["parts_expected"])))
        save(job)
        shutil.rmtree(job_dir(job_id) / "parts", ignore_errors=True)
        persist()
        payload = {"match_id": job["match_id"], "path": job["path"], "session_type": req["session_type"],
                   "court": req["court"], "doubles": req["doubles"], "source": req["source"]}
        if job["rally_idx"] is None:
            spawn("segment_match", payload | {"biomech": req["biomech"]})
        else:
            extra = {k: req[k] for k in ("bookmarked", "live_call", "score", "points") if req.get(k)}
            spawn("process_rally", payload | {"rally_idx": job["rally_idx"], "start_s": req["start_s"] or 0.0} | extra)
        return {"job_id": job_id, "status": "processing", "sha256": job["sha256"]}

    @app.post("/sessions/{match_id}/finalize")
    def finalize_session(match_id: str, body: FinalizeIn | None = None,
                         x_job_token: str | None = Header(default=None)):
        try:
            mid = str(uuid.UUID(match_id))
        except ValueError:
            raise HTTPException(404, "no such session")
        auth(x_job_token, mid)
        data = body.model_dump(mode="json") if body is not None else {}
        payload = {"match_id": mid, "source": data.get("source", "ios"),
                   "session_type": data.get("session_type", "rally"), "doubles": data.get("doubles", False),
                   "court": data.get("court"), "score": data.get("score"), "points": data.get("points")}
        spawn("finalize_session", payload)
        return {"match_id": mid, "status": "ready"}

    @app.api_route("/clips/{match_id}/{clip}", methods=["GET", "HEAD"])
    def clip(match_id: str, clip: str, request: Request):
        m = re.fullmatch(r"(\d{1,5})\.mp4", clip)
        try:
            mid = str(uuid.UUID(match_id))
        except ValueError:
            mid = None
        if not m or mid != match_id.lower():
            raise HTTPException(404, "no such clip")
        path = root / mid / "rallies" / f"{int(m.group(1))}.mp4"
        if not path.exists():
            refresh()
        if not path.exists():
            raise HTTPException(404, "no such clip")
        st = path.stat()
        size, etag = st.st_size, f'"{st.st_size:x}-{st.st_mtime_ns:x}"'
        base = {"Accept-Ranges": "bytes", "Cache-Control": CACHE, "ETag": etag, "Content-Type": "video/mp4"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=base)
        rng = _parse_range(request.headers.get("range"), size)
        if rng == "unsatisfiable":
            return Response(status_code=416, headers=base | {"Content-Range": f"bytes */{size}"})
        start, end = rng if rng else (0, size - 1)
        length = end - start + 1
        headers = base | {"Content-Length": str(length)}
        status = 206 if rng else 200
        if rng:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        if request.method == "HEAD":
            return Response(status_code=status, headers=headers)

        def body():
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(CHUNK, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    yield chunk

        return StreamingResponse(body(), status_code=status, headers=headers, media_type="video/mp4")

    return app


# --- video ----------------------------------------------------------------------------------------------------

def decode(path: str, start_s: float = 0.0, end_s: float | None = None):
    """Native BGR frames and their presentation timestamps (s) between start_s and end_s, via PyAV."""
    import av

    with av.open(path) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        if start_s > 0:
            c.seek(int(start_s / s.time_base), stream=s, backward=True)
        for f in c.decode(s):
            t = float(f.pts * s.time_base) if f.pts is not None else float(f.time)
            if t < start_s - 1e-6:
                continue
            if end_s is not None and t > end_s:
                break
            yield t, f.to_ndarray(format="bgr24")


def cut_clip(src: str, dest: str, start_s: float, end_s: float, height: int = CLIP_HEIGHT) -> None:
    """The rally's 720p H.264 clip, moov atom first (+faststart) so a <video> can start from any Range."""
    import subprocess

    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start_s:.3f}", "-to", f"{end_s:.3f}", "-i", src,
                    "-vf", f"scale=-2:{height}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", dest + ".tmp.mp4"], check=True)
    os.replace(dest + ".tmp.mp4", dest)


def calibration(court: dict | None):
    """court (the uploader's taps, or a saved court.json v1) -> dsa.physics Calibration, or None."""
    if not court:
        return None
    from dsa.physics.homography import Calibration, calibrate

    if "K" in court:
        return Calibration.from_json(court)
    if "court_px" not in court or "size" not in court:
        return None
    return calibrate(court["court_px"], tuple(court["size"]), court.get("court_idx"), court.get("posts_px"))


def track_video(path: str, start_s: float = 0.0, end_s: float | None = None, device: str = "cuda") -> np.ndarray:
    """WASB step=3 over a stretch of video, cleaned (E12)."""
    from dsa.physics.bounce_and_linecall import ball_track, clean, wasb_heatmaps

    ts: list[float] = []
    size: list[int] = []

    def frames():
        for t, f in decode(path, start_s, end_s):
            ts.append(t)                    # filled as ball_track streams the frames
            size[:] = [f.shape[1]]
            yield f

    track = ball_track(frames(), ts, wasb_heatmaps(device))
    return clean(track, width=size[0] if size else None)


try:
    import modal
except ImportError:
    modal = None

if modal is not None:
    from dsa.gpu.volume import image, volume

    app = modal.App("tennis-rally", image=image("catboost==1.2.10", "fastapi>=0.115", "httpx>=0.27", "av>=12"))
    secrets = [modal.Secret.from_name("tennis-rally")]
    TENNIS = Path("/vol/tennis")

    def _event(**kw) -> None:
        send_webhook(os.environ.get("TENNIS_WEBHOOK_URL"), os.environ.get("TENNIS_WEBHOOK_SECRET"), kw)

    @app.function(gpu="L4", volumes={"/vol": volume}, secrets=secrets, cpu=4, memory=32_768, timeout=30 * 60)
    def process_rally(match_id: str, path: str, session_type: str, court: dict | None, doubles: bool, source: str,
                      rally_idx: int, start_s: float = 0.0, end_s: float | None = None,
                      bookmarked: bool = False, live_call: str | None = None,
                      score: dict | None = None, points: list[dict] | None = None) -> dict:
        """One rally: its 720p clip on the volume, its shots, rally.ready. An iOS clip is the whole file
        (start_s is where it sits in the session); a web session is cut at [start_s, end_s]."""
        import cv2
        from dsa.physics.homography import reregister
        from dsa.physics.scorekeeper import summarize_rally_streak

        volume.reload()
        try:
            src, cal = str(TENNIS / path), calibration(court)
            whole = source == "ios"
            a, b = (0.0, None) if whole else (start_s, end_s)
            saved = TENNIS / match_id / "tracks" / f"{rally_idx}.npy"
            track = np.load(saved) if saved.exists() else track_video(src, a, b)
            dest = TENNIS / match_id / "rallies" / f"{rally_idx}.mp4"
            cut_clip(src, str(dest), a, b if b is not None else track[-1, 0] + 0.001 if len(track) else 0.001)
            drift_px = None
            frames_cache: dict[int, np.ndarray] = {}
            for k_idx, (_, frm) in enumerate(decode(src, a, b)):
                frames_cache[k_idx] = frm
                if k_idx == 0 and cal is not None:
                    f0_path = TENNIS / match_id / "frame0.png"
                    if f0_path.exists():
                        ref0 = cv2.imread(str(f0_path))
                        if ref0 is not None and ref0.shape[:2] == frm.shape[:2]:
                            cal_new, d_px = reregister(cal, ref0, frm)
                            if np.isfinite(d_px):
                                cal, drift_px = cal_new, round(float(d_px), 3)
                    else:
                        f0_path.parent.mkdir(parents=True, exist_ok=True)
                        cv2.imwrite(str(f0_path), frm)
            frame_at = (lambda idx: frames_cache.get(idx)) if frames_cache else None
            shots, _ = analyse_track(track, cal, session_type, doubles,
                                     frame_at=(lambda idx: frames_cache[idx]) if len(frames_cache) == len(track) else None)
            offset = start_s if whole else 0.0
            for s in shots:
                for k in ("t_hit_s", "t_bounce_s"):
                    if s[k] is not None:
                        s[k] = round(s[k] + offset, 4)
            if live_call and shots:
                called = [s for s in shots if s.get("t_bounce_s") is not None]
                (called[-1] if called else shots[-1])["live_call"] = live_call
            streak = summarize_rally_streak(shots)
            ok = track[:, 1] > 0
            rally = {"rally_idx": rally_idx, "start_s": round(offset + (track[0, 0] if len(track) else 0.0), 3),
                     "end_s": round(offset + (track[-1, 0] if len(track) else 0.0), 3),
                     "shot_count": streak["shot_count"], "in_streak": streak["in_streak"],
                     "bookmarked": bookmarked, "live_call": live_call,
                     "clip_url": f"/clips/{match_id}/{rally_idx}.mp4",
                     "ball_track": [[int(round(1000 * (offset + t))), int(round(u)), int(round(v))]
                                    for t, u, v in track[ok][:, [0, 2, 3]]], "drift_px": drift_px}
            volume.commit()
            _event(type="rally.ready", match_id=match_id, rally=rally, shots=shots,
                   session_type=session_type, source=source, doubles=doubles,
                   court=cal.to_json() if cal is not None else court,
                   bookmarked=bookmarked, live_call=live_call, score=score, points=points)
            return {"rally_idx": rally_idx, "shots": shots}
        except Exception as e:
            _event(type="match.status", match_id=match_id, status="failed", error=str(e)[:500],
                   session_type=session_type, source=source)
            raise

    @app.function(gpu="L4", volumes={"/vol": volume}, secrets=secrets, cpu=8, memory=65_536, timeout=3 * 60 * 60)
    def segment_match(match_id: str, path: str, session_type: str, court: dict | None, doubles: bool, source: str,
                      biomech: bool = False) -> dict:
        """A whole web-uploaded session: ball track once, rallies, one process_rally each, match.ready."""
        from dsa.physics.bounce_and_linecall import call, contact_point, events, region_for
        from dsa.physics.homography import to_court
        from dsa.physics.scorekeeper import apply as apply_point, formatted as fmt_score, new_match, summarize_session

        volume.reload()
        src = str(TENNIS / path)
        try:
            cal = calibration(court)
            track = track_video(src)
            ev = events(track, cal) if cal is not None else []
            hits = [e for e in ev if e["kind"] == "hit"]
            for idx_e, e in enumerate(ev):
                if e["kind"] == "bounce" and cal is not None:
                    c = contact_point(track, e["i"], cal, method="arc")
                    prev_h = next((x for x in reversed(ev[:idx_e]) if x["kind"] == "hit"), None)
                    is_first_hit = prev_h is not None and (not hits or prev_h["t"] == hits[0]["t"]
                                                           or any(x.get("call") == "out" for x in ev[:idx_e]
                                                                  if x["kind"] == "bounce"))
                    serve = None
                    if session_type == "match" and is_first_hit and prev_h is not None:
                        hp = to_court(cal.Hr, track[prev_h["i"], 2:4])
                        hitter = prev_h.get("half") or ("near" if hp[1] < 0 else "far")
                        serve = _serve_region(hitter, float(hp[0]))
                    hitter_e = prev_h.get("half") if prev_h is not None else None
                    e["call"] = call(c["xy"], c["cov"], region_for(session_type, doubles, serve),
                                     hitter=hitter_e)["call"] if c["ok"] else "unknown"
            duration = float(track[-1, 0]) if len(track) else 0.0
            rallies = segment_rallies(ev, session_type, duration=duration)
            fps = float(1 / np.median(np.diff(track[:, 0]))) if len(track) > 1 else None
            _event(type="match.status", match_id=match_id, status="processing", rallies_expected=len(rallies),
                   session_type=session_type, source=source, doubles=doubles,
                   court=cal.to_json() if cal is not None else court, fps=fps)
            (TENNIS / match_id / "tracks").mkdir(parents=True, exist_ok=True)
            for k, r in enumerate(rallies):
                sel = (track[:, 0] >= r["start_s"]) & (track[:, 0] <= r["end_s"])
                np.save(TENNIS / match_id / "tracks" / f"{k}.npy", track[sel])
            volume.commit()
            results = list(process_rally.starmap(
                [(match_id, path, session_type, court, doubles, source, k, r["start_s"], r["end_s"])
                 for k, r in enumerate(rallies)]))
            per_rally = [r["shots"] for r in results]
            stats = summarize_session(per_rally)
            if biomech:
                bio = compute_session_biomechanics(per_rally, src=src, cal=cal)
                stats = stats | {"biomechanics": bio, "biomech_traits": bio["traits"],
                                 "coach_notes": bio["coach_notes"]}
            score_out, points_out = None, []
            if session_type == "match":
                st = new_match()
                for r_idx, r_shots in enumerate(per_rally):
                    if not r_shots:
                        continue
                    before_str = fmt_score(st)
                    srv = st["server"]
                    s_side = "deuce" if sum(st["points"]) % 2 == 0 else "ad"
                    last_s = r_shots[-1]
                    last_h = "me" if last_s["hitter"] == "near" else "opp"
                    opp_h = "opp" if last_h == "me" else "me"
                    win = opp_h if last_s["call"] == "out" else last_h
                    ended_by = ("double_fault" if (len(r_shots) == 1 and last_s["call"] == "out")
                                else "out" if last_s["call"] == "out" else "winner")
                    st = apply_point(st, "W" if win == "me" else "L")
                    points_out.append({"point_idx": len(points_out), "rally_idx": r_idx, "server": srv,
                                       "serve_side": s_side, "winner": win, "ended_by": ended_by,
                                       "score_before": before_str, "score_after": fmt_score(st),
                                       "timestamp_s": last_s.get("t_bounce_s") or last_s.get("t_hit_s")})
                score_out = st | {"formatted": fmt_score(st)}
            _event(type="match.ready", match_id=match_id, status="ready", rallies_done=len(results),
                   session_type=session_type, source=source, doubles=doubles,
                   court=cal.to_json() if cal is not None else court,
                   stats=stats, score=score_out, points=points_out)
            return {"rallies": len(rallies)}
        except Exception as e:                      # the viewer shows the error; Modal keeps the traceback
            _event(type="match.status", match_id=match_id, status="failed", error=str(e)[:500],
                   session_type=session_type, source=source)
            raise

    def _spawn(kind: str, payload: dict) -> None:
        if kind == "segment_match":
            segment_match.spawn(**payload)
        elif kind == "finalize_session":
            _event(type="match.ready", status="ready", **payload)
        else:
            process_rally.spawn(**payload)

    @app.function(volumes={"/vol": volume}, secrets=secrets, timeout=15 * 60)
    @modal.asgi_app()
    def web():
        origins = [o for o in os.environ.get("TENNIS_ALLOWED_ORIGINS", "https://thelastmattapalli.com").split(",") if o]
        return create_app(TENNIS, os.environ.get("TENNIS_JOB_SECRET"), spawn=_spawn, persist=volume.commit,
                          refresh=volume.reload, allowed_origins=origins)
