// The syllable explorer (dsa.pages.movement_report): every run of one of his keypoint-MoSeq syllables (a "piece") on a
// zoomable UMAP map, coloured by its syllable. Pick a syllable, or click a dot to circle it and those around it (the
// circle moves and sizes by dragging): the pieces play side by side in sync, cropped on him with his skeleton drawn
// on, next to them all drawn together as stick figures. Colour and filter by year, shot, speed and direction.
// One explorer per .explorer element: data-src names its data file, data-unit what a dot is.
const POSE_BUF = fetch("explorer/pose.bin").then(r => r.arrayBuffer());
document.querySelectorAll(".explorer[data-src]").forEach(root => (async () => {
  const [D, buf] = await Promise.all([fetch(`explorer/${root.dataset.src}`).then(r => r.json()), POSE_BUF]);
  const UNIT = root.dataset.unit, OFF = () => root.hidden || root.closest(".cat")?.hidden;
  const POSE = new Int16Array(buf), P = D.pieces, N = P.x.length, J = D.joints;
  const CL = new Map(D.clusters.map(c => [c.id, c]));
  const YEARS = [...new Set(P.year)].sort((a, b) => a - b), Y0 = YEARS[0], Y1 = YEARS[YEARS.length - 1];
  const HIT_NAMES = ["No shot", "Forehand", "Backhand", "Serve"], HIT_COL = ["#c4c4cc", "#f28e2b", "#4e79a7", "#59a14f"];
  const GREY = "#d0d0d6", PAD = 0.35, CROWD = 150, NEAR = 150, SLOW = 0.5, HOLD = 0.7;
  const $ = s => root.querySelector(s);
  const TOUCH = matchMedia("(pointer: coarse)").matches;
  let OW = 150;                                                // the overview's width
  const S = { colour: "cluster", y0: Y0, y1: Y1, pick: null, order: [], page: 0, hl: null };

  // ---- colours and filters
  const yearCol = d3.scaleSequential(d3.interpolateViridis).domain([Y0, Y1 + 3]);
  const speedCol = d3.scaleSequential(d3.interpolateInferno).domain([-0.3, 4.6]);
  const dirCol = i => {
    const ang = Math.atan2(-P.vd[i], P.vl[i]) * 180 / Math.PI, v = Math.hypot(P.vd[i], P.vl[i]);
    return d3.interpolateRgb(GREY, d3.hsl((ang + 360) % 360, 0.8, 0.45) + "")(Math.min(1, v / 2));
  };
  const colourOf = i => ({ cluster: () => CL.get(P.c[i])?.colour ?? GREY, year: () => yearCol(P.year[i]),
                           hit: () => HIT_COL[P.hit[i]], speed: () => speedCol(P.speed[i]), dir: () => dirCol(i) })[S.colour]();
  let COL = [], GROUPS = new Map();
  const VIS = new Uint8Array(N);
  function recolour() {
    COL = Array.from({ length: N }, (_, i) => colourOf(i));
    GROUPS = d3.group(d3.range(N), i => COL[i]);
  }
  // the filter is on whatever the map is coloured by: years, shots, speed or direction (a cluster is picked from the list)
  const SPD = Math.ceil(d3.quantile(P.speed, 0.99) * 2) / 2, DIRS = ["right", "forward", "left", "back", "still"];
  const DIR = Uint8Array.from({ length: N }, (_, i) => Math.hypot(P.vd[i], P.vl[i]) < 0.5 ? 4
    : Math.round(((Math.atan2(-P.vd[i], P.vl[i]) * 180 / Math.PI + 360) % 360) / 90) % 4);
  const FILTER0 = () => ({ year: [Y0, Y1], speed: [0, SPD], hit: new Set([0, 1, 2, 3]), dir: new Set([0, 1, 2, 3, 4]) });
  let F = FILTER0();
  function refilter() {
    const m = S.colour, [lo, hi] = F[m] instanceof Array ? F[m] : [];
    for (let i = 0; i < N; i++)
      VIS[i] = m === "year" ? P.year[i] >= lo && P.year[i] <= hi
        : m === "speed" ? P.speed[i] >= lo && (P.speed[i] <= hi || hi >= SPD)
        : m === "hit" ? F.hit.has(P.hit[i]) : m === "dir" ? F.dir.has(DIR[i]) : 1;
  }

  // ---- poses: his joints in image px at pose_hz through each point
  function frame(pt, f) {
    f = Math.max(0, Math.min(pt.n - 1, f));
    const a = (pt.off + f) * J * 2, out = new Array(J);
    for (let j = 0; j < J; j++) {
      const x = POSE[a + 2 * j], y = POSE[a + 2 * j + 1];
      out[j] = x === -32768 ? null : [x / D.scale, y / D.scale];
    }
    return out;
  }
  function poseAt(pt, t) {                                     // t: seconds into the point, interpolated
    const u = t * D.pose_hz, f = Math.floor(u), w = u - f, A = frame(pt, f), B = frame(pt, f + 1);
    return A.map((p, j) => p && B[j] ? [p[0] + (B[j][0] - p[0]) * w, p[1] + (B[j][1] - p[1]) * w] : p || B[j]);
  }
  function span(i) {                                           // seconds into its point: the piece, and shown around it
    const pt = D.points[P.point[i]], a = P.g0[i] / D.hz, b = P.g1[i] / D.hz;
    return { pt, a, b, A: Math.max(0, a - PAD), B: Math.min((pt.n - 1) / D.pose_hz, b + PAD) };
  }
  // a stick figure over the same window as its clip, placed from his hips where the piece starts, in his heights
  function figure(i) {
    const s = span(i);
    let hip = null;
    for (let t = s.a; t <= s.b + 1e-6 && !hip; t += 1 / D.pose_hz) {
      const f = poseAt(s.pt, t);
      if (f[7] && f[8]) hip = [(f[7][0] + f[8][0]) / 2, (f[7][1] + f[8][1]) / 2];
    }
    if (!hip) return null;
    const at = t => poseAt(s.pt, Math.min(Math.max(t, s.A), s.B)).map(p => p && [(p[0] - hip[0]) / P.h[i], (p[1] - hip[1]) / P.h[i]]);
    return { ...s, at };
  }
  function bonesPath(g, f, X, Y) {
    g.beginPath();
    for (const [p, q] of D.bones) if (f[p] && f[q]) { g.moveTo(X(f[p][0]), Y(f[p][1])); g.lineTo(X(f[q][0]), Y(f[q][1])); }
  }

  // ---- the map
  const canvas = $(".ex-map"), ctx = canvas.getContext("2d"), wrap = $(".ex-mapwrap");
  let W = 0, H = 0, T = d3.zoomIdentity, live = null, hover = -1;
  const base = { k: 1, x: 0, y: 0 }, XM = d3.max(P.x), YM = d3.max(P.y);
  const bx = x => base.x + x * base.k, by = y => base.y + y * base.k;
  const sx = i => T.applyX(bx(P.x[i])), sy = i => T.applyY(by(P.y[i]));
  const tip = document.createElement("div");
  tip.style.cssText = "position:absolute;pointer-events:none;font:12.5px Inter,sans-serif;background:#fff;border:1px solid #e6e5e1;border-radius:6px;padding:3px 8px;display:none;color:#17171a;white-space:nowrap";
  wrap.appendChild(tip);
  const overview = document.createElement("canvas");
  function resize() {
    const dpr = devicePixelRatio || 1;
    if (canvas.clientWidth < 80 || canvas.clientHeight < 80) return;      // its tab is hidden
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    base.k = Math.min((W - 60) / XM, (H - 60) / YM);
    base.x = (W - XM * base.k) / 2; base.y = (H - YM * base.k) / 2;
    OW = Math.min(150, W * 0.28);
    overview.width = OW * dpr; overview.height = OW * H / W * dpr;
    const o = overview.getContext("2d"), ok = overview.width / W;
    o.fillStyle = "#fff"; o.fillRect(0, 0, overview.width, overview.height);
    o.fillStyle = "#b9b9c2";
    for (let i = 0; i < N; i++) o.fillRect(bx(P.x[i]) * ok, by(P.y[i]) * ok, dpr, dpr);
    draw();
  }
  const dark = c => { const h = d3.hsl(c); h.l = Math.min(h.l, 0.36); return h + ""; };
  function draw() {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const r = Math.min(4.5, 1.7 * Math.sqrt(T.k)), sel = S.sel, hl = S.hl;
    const lit = i => hl !== null ? P.c[i] === hl : !sel || sel.has(i);   // hovering a syllable shows it, even over a selection
    const pass = (alpha, want) => {
      ctx.globalAlpha = alpha;
      for (const [c, idx] of GROUPS) {
        ctx.fillStyle = c; ctx.beginPath();
        for (const i of idx) {
          if (!VIS[i] || lit(i) !== want) continue;
          const x = sx(i), y = sy(i);
          if (x < -5 || y < -5 || x > W + 5 || y > H + 5) continue;
          ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832);
        }
        ctx.fill();
      }
    };
    if (sel || hl !== null) { pass(0.12, false); pass(0.9, true); } else pass(0.8, true);
    ctx.globalAlpha = 1;
    // names, on the map, nudged apart
    ctx.font = `600 ${W < 500 ? 11 : 12.5}px Inter, sans-serif`; ctx.textAlign = "center"; ctx.lineJoin = "round";
    const boxes = [];
    for (const c of D.clusters.filter(c => c.preset)) {
      const w = ctx.measureText(c.name).width + 6;
      const x = Math.min(Math.max(T.applyX(bx(c.label[0])), w / 2 + 4), W - w / 2 - 4), y = T.applyY(by(c.label[1])) - 8;
      for (const dy of [0, 15, -15, 30, -30]) {
        const b = [x - w / 2, y + dy - 11, x + w / 2, y + dy + 4];
        if (b[1] < 0 || b[3] > H || !boxes.every(o => b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3])) continue;
        boxes.push(b);
        const on = (hl === null || hl === c.id) && (S.pick?.type !== "cluster" || S.pick.id === c.id);
        ctx.globalAlpha = on ? 1 : 0.3;
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.strokeText(c.name, x, y + dy);
        ctx.fillStyle = S.colour === "cluster" ? dark(c.colour) : "#17171a"; ctx.fillText(c.name, x, y + dy);
        break;
      }
    }
    ctx.globalAlpha = 1;
    if (S.pick?.type === "circle") {                           // the circle: drag inside to move it, its edge to size it
      const c = live ?? S.pick, x = T.applyX(bx(c.x)), y = T.applyY(by(c.y)), R = c.r * base.k * T.k, [hx, hy] = handle();
      ctx.fillStyle = "rgba(23,23,26,.035)"; ctx.strokeStyle = "#17171a"; ctx.lineWidth = live ? 2.5 : 2;
      ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.fill(); ctx.stroke();
      if (live) {
        const t = `${inside(live).length.toLocaleString()} ${UNIT}`;
        ctx.font = "600 12.5px Inter, sans-serif"; ctx.textAlign = "left"; ctx.lineJoin = "round";
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.strokeText(t, hx + 14, hy + 4); ctx.fillStyle = "#17171a"; ctx.fillText(t, hx + 14, hy + 4);
      }
    }
    if (T.k > 1.15) {                                          // where you are, when zoomed in
      const ow = OW, oh = OW * H / W, ox = W - ow - 10, oy = H - oh - 10;   // bottom right: clear of the clips card
      ctx.drawImage(overview, ox, oy, ow, oh);
      ctx.strokeStyle = "#e6e5e1"; ctx.lineWidth = 1; ctx.strokeRect(ox, oy, ow, oh);
      const [x0, y0] = T.invert([0, 0]), [x1, y1] = T.invert([W, H]), k = ow / W;
      ctx.strokeStyle = "#17171a"; ctx.strokeRect(ox + x0 * k, oy + y0 * k, (x1 - x0) * k, (y1 - y0) * k);
    }
  }
  // the circle: drag inside it to move it, drag its edge to size it; a click elsewhere moves it there at the same size
  const toMap = (x, y) => { const [u, v] = T.invert([x, y]); return [(u - base.x) / base.k, (v - base.y) / base.k]; };
  function handle() {
    const c = live ?? S.pick, R = c.r * base.k * T.k;
    return [T.applyX(bx(c.x)) + R * Math.SQRT1_2, T.applyY(by(c.y)) + R * Math.SQRT1_2];
  }
  const at = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const isCircle = () => S.pick?.type === "circle";
  const rim = e => {                                         // where on the circle's edge the pointer is, if it is on it
    if (!isCircle()) return null;
    const [x, y] = at(e), cx = T.applyX(bx(S.pick.x)), cy = T.applyY(by(S.pick.y)), R = S.pick.r * base.k * T.k;
    return Math.abs(Math.hypot(x - cx, y - cy) - R) < (TOUCH ? 16 : 8) ? Math.atan2(y - cy, x - cx) : null;
  };
  const onHandle = e => rim(e) !== null;
  const RIM_CURSOR = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  const inCircle = e => {
    if (!isCircle()) return false;
    const [x, y] = toMap(...at(e)); return (x - S.pick.x) ** 2 + (y - S.pick.y) ** 2 < S.pick.r ** 2;
  };
  const zoom = d3.zoom().scaleExtent([1, 60]).filter(e => !e.button && !(e.type !== "wheel" && (onHandle(e) || inCircle(e))))
    .on("zoom", e => { T = e.transform; draw(); });
  d3.select(canvas).call(zoom).on("dblclick.zoom", null);
  function nearest(px, py, within) {
    let best = -1, bd = within * within;
    for (let i = 0; i < N; i++) {
      if (!VIS[i]) continue;
      const d = (sx(i) - px) ** 2 + (sy(i) - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function inside(c) {                                         // the pieces in a circle (map units), nearest the centre first
    const d = i => (P.x[i] - c.x) ** 2 + (P.y[i] - c.y) ** 2, out = [];
    for (let i = 0; i < N; i++) if (VIS[i] && d(i) <= c.r * c.r) out.push(i);
    return out.sort((a, b) => d(a) - d(b));
  }
  let mode = null, grab = null, dragged = false;
  canvas.addEventListener("pointerdown", e => {
    if (onHandle(e)) mode = "size";
    else if (inCircle(e)) { mode = "move"; const [x, y] = toMap(...at(e)); grab = [x - S.pick.x, y - S.pick.y, ...at(e)]; }
    else return;
    live = { ...S.pick }; e.preventDefault(); e.stopPropagation();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  });
  canvas.addEventListener("pointermove", e => {
    const [x, y] = at(e);
    if (mode === "size") {
      live.r = Math.max(6, Math.hypot(x - T.applyX(bx(live.x)), y - T.applyY(by(live.y)))) / (base.k * T.k);
      draw(); return;
    }
    if (mode === "move") {
      if (!live.moved && Math.hypot(x - grab[2], y - grab[3]) < 4) return;   // not a drag yet: may be a click
      const [u, v] = toMap(x, y);
      Object.assign(live, { x: u - grab[0], y: v - grab[1], i: -1, moved: true });
      draw(); return;
    }
    const a = rim(e);
    canvas.style.cursor = a !== null ? RIM_CURSOR[Math.round(((a + 2 * Math.PI) % Math.PI) / (Math.PI / 4)) % 4]
      : inCircle(e) ? "move" : "crosshair";
    const i = nearest(x, y, 8);
    if (i === hover) return;
    hover = i;
    if (i < 0) { tip.style.display = "none"; return; }
    const pt = D.points[P.point[i]];
    tip.textContent = `${CL.get(P.c[i])?.name ?? "Rare syllable"} · ${pt.year} vs ${pt.opp}`;
    tip.style.display = "block"; tip.style.left = Math.min(x + 14, W - 260) + "px"; tip.style.top = (y + 12) + "px";
  });
  canvas.addEventListener("pointerup", () => {
    if (!mode) return;
    const c = live, changed = mode === "size" || c.moved;
    mode = null; live = null;
    if (!changed) { draw(); return; }                          // a click inside the circle: handled as a click
    dragged = true;
    choose({ type: "circle", x: c.x, y: c.y, r: c.r, i: c.i });
  });
  canvas.addEventListener("pointerleave", () => { tip.style.display = "none"; hover = -1; });
  canvas.addEventListener("click", e => {
    if (dragged) { dragged = false; return; }
    const i = nearest(...at(e), 10);
    const [x, y] = i >= 0 ? [P.x[i], P.y[i]] : toMap(...at(e));
    if (i < 0 && !isCircle()) return;                          // empty space, nothing to move: nothing to do
    let r = S.r;
    if (!r) {                                                  // the first circle holds the NEAR pieces closest to it
      const all = inside({ x, y, r: Infinity }), j = all[Math.min(NEAR, all.length) - 1];
      r = Math.hypot(P.x[j] - x, P.y[j] - y);
    }
    choose({ type: "circle", x, y, r, i });
  });
  function zoomTo(x0, y0, x1, y1) {
    const [a0, b0, a1, b1] = [bx(x0), by(y0), bx(x1), by(y1)];
    const k = Math.max(1, Math.min(3.5, 0.45 * Math.min(W / (a1 - a0 || 1), H / (b1 - b0 || 1))));
    d3.select(canvas).transition().duration(700)
      .call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(a0 + a1) / 2, -(b0 + b1) / 2));
  }
  const unzoom = () => d3.select(canvas).transition().duration(600).call(zoom.transform, d3.zoomIdentity);

  // ---- what is chosen: a cluster, or one piece with those around it
  function choose(pick) {
    S.pick = pick; S.page = 0;
    let idx = [], cx = 0, cy = 0;
    const dist = i => (P.x[i] - cx) ** 2 + (P.y[i] - cy) ** 2;
    if (pick?.type === "cluster") {
      [cx, cy] = CL.get(pick.id).label;
      for (let i = 0; i < N; i++) if (VIS[i] && P.c[i] === pick.id) idx.push(i);
    } else if (pick?.type === "circle") {
      idx = inside(pick); S.r = pick.r;
    }
    S.sel = pick ? new Set(idx) : null;
    S.order = pick?.type === "circle" ? idx : idx.sort((i, j) => dist(i) - dist(j));
    side.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", pick?.type === "cluster" && +b.dataset.id === pick.id));
    draw(); view();
  }

  // ---- side list of clusters, by group
  const side = $(".ex-side");
  for (const g of D.groups) {
    const cs = D.clusters.filter(c => c.preset && c.group === g);
    if (!cs.length) continue;
    side.insertAdjacentHTML("beforeend", `<h5>${g}</h5>`);
    for (const c of cs) {
      const b = document.createElement("button");
      b.dataset.id = c.id; b.setAttribute("aria-pressed", "false");
      b.innerHTML = `<span class="sw" style="background:${c.colour}"></span><span class="nm">${c.name}</span>`;
      b.onclick = () => {
        if (S.pick?.type === "cluster" && S.pick.id === c.id) { choose(null); unzoom(); return; }
        choose({ type: "cluster", id: c.id }); zoomTo(...c.pocket);
      };
      b.onmouseenter = () => { S.hl = c.id; draw(); };
      b.onmouseleave = () => { S.hl = null; draw(); };
      side.appendChild(b);
    }
  }

  // ---- the viewer: clips in sync, stick figures together, years
  const clipsEl = $(".ex-clips"), crowdC = $(".ex-crowd");
  const CLIPS = () => document.fullscreenElement === root ? 7 : 3;    // full screen: one row of eight with the crowd
  let clips = [], cycle = 0;
  function stopClips() {
    for (const c of clips) { c.video.pause(); c.video.removeAttribute("src"); c.video.load(); }
    clips = []; clipsEl.innerHTML = ""; cycle++;
  }
  function addClip(i, me) {
    const { pt, a, b, A, B } = span(i), el = document.createElement("div");
    el.className = "ex-clip" + (me ? " me" : "");
    const video = document.createElement("video"), cv = document.createElement("canvas"), lab = document.createElement("span");
    video.muted = true; video.playsInline = true; video.preload = "auto";
    lab.textContent = `${pt.year} · vs ${pt.opp}`;
    el.append(video, cv, lab); clipsEl.appendChild(el);
    // a still crop around everywhere he goes in the clip, 4:3
    const xs = [], ys = [], talls = [];
    for (let t = A; t <= B; t += 1 / D.pose_hz) {
      const f = poseAt(pt, t).filter(Boolean);
      if (!f.length) continue;
      const fy = f.map(p => p[1]);
      xs.push(...f.map(p => p[0])); ys.push(...fy); talls.push(Math.max(...fy) - Math.min(...fy));
    }
    const tall = d3.median(talls) || 100, cw = el.clientWidth, ch = cw * 3 / 4;
    const [x0, x1, y0, y1] = [d3.min(xs), d3.max(xs), d3.min(ys), d3.max(ys)];
    const k = ch / Math.max(y1 - y0 + 0.5 * tall, (x1 - x0 + 0.6 * tall) * 3 / 4, 1.6 * tall);
    const ox = cw / 2 - (x0 + x1) / 2 * k, oy = ch / 2 - (y0 + y1) / 2 * k;
    Object.assign(video.style, { left: ox + "px", top: oy + "px" });     // recordings differ in size: scale each by its own
    video.addEventListener("loadedmetadata", () => Object.assign(video.style,
      { width: video.videoWidth * k + "px", height: video.videoHeight * k + "px" }), { once: true });
    const dpr = devicePixelRatio || 1;
    cv.width = cw * dpr; cv.height = ch * dpr;
    const c = { i, video, cv, pt, a, b, A, B, k, ox, oy, dpr, col: colourOf(i), done: false };
    // the skeleton is drawn for the frame actually on screen, so it can't run ahead of the picture
    // (setting the source drops callbacks asked for before it, so it is asked for after, and again before each run)
    const paint = (_, meta) => {
      c.cb = null; c.painted = performance.now();
      if (!c.video.src) return;
      if (!c.video.seeking) overlay(c, meta.mediaTime - pt.t0);
      if (meta.mediaTime - pt.t0 >= c.B && !c.video.paused) { c.video.pause(); c.done = true; }
      c.arm();
    };
    c.arm = () => { if (c.cb == null && c.video.src) c.cb = c.video.requestVideoFrameCallback(paint); };
    video.src = `explorer/video/${D.videos[pt.v]}.mp4`;
    c.arm();
    clips.push(c);
  }
  // the clip's picture and his skeleton are painted together onto one canvas, from the same frame, so the two can't
  // disagree; the video element plays underneath, covered
  function overlay(c, t) {
    const g = c.cv.getContext("2d"), v = c.video;
    if (v.readyState < 2) return;
    g.setTransform(c.dpr, 0, 0, c.dpr, 0, 0); g.fillStyle = "#111"; g.fillRect(0, 0, c.cv.width, c.cv.height);
    g.drawImage(v, c.ox, c.oy, v.videoWidth * c.k, v.videoHeight * c.k);
    if (t < 0 || t > (c.pt.n - 1) / D.pose_hz) return;        // a frame from another point (mid-seek): no skeleton
    const on = t >= c.a && t <= c.b;
    bonesPath(g, poseAt(c.pt, t), x => c.ox + x * c.k, y => c.oy + y * c.k);
    g.lineCap = "round"; g.lineJoin = "round";                // a dark edge so it reads on white kit and pale courts
    g.strokeStyle = "rgba(0,0,0,.55)"; g.lineWidth = on ? 5 : 3.4; g.stroke();
    g.strokeStyle = on ? c.col : "#fff"; g.lineWidth = on ? 3 : 1.6; g.stroke();
  }
  // one clock for all: every clip goes to the start of its window, they start together (each piece begins PAD
  // in), each holds its last frame when done, and all start again once the longest is done
  async function run() {
    const me = ++cycle;
    while (me === cycle) {
      if (OFF() || !clips.length) { await new Promise(r => setTimeout(r, 400)); continue; }
      await Promise.all(clips.map(c => new Promise(res => {
        const go = () => { c.video.pause(); c.done = false; c.video.playbackRate = SLOW;
                           c.video.addEventListener("seeked", () => { overlay(c, c.video.currentTime - c.pt.t0); res(); }, { once: true });
                           c.video.currentTime = c.pt.t0 + c.A; };
        c.video.readyState >= 1 ? go() : c.video.addEventListener("loadedmetadata", go, { once: true });
        setTimeout(res, 4000);
      })));
      if (me !== cycle) return;
      crowdStart();
      clips.forEach(c => {
        c.arm(); c.video.play().catch(() => {});
        setTimeout(() => { if (me === cycle) { c.video.pause(); c.done = true; } }, (c.B - c.A) / SLOW * 1000 + 120);
      });
      const t0 = performance.now(), longest = d3.max(clips, c => c.B - c.A) / SLOW;
      while (me === cycle && performance.now() - t0 < (longest + HOLD) * 1000 && !clips.every(c => c.done))
        await new Promise(r => setTimeout(r, 100));
      if (me !== cycle) return;
      await new Promise(r => setTimeout(r, HOLD * 1000));
    }
  }

  // frame callbacks don't come in every browser state, so a timer also keeps each playing clip's skeleton on the
  // frame showing whenever they have gone quiet
  setInterval(() => {
    for (const c of clips)
      if (!c.video.paused && !c.video.seeking && performance.now() - (c.painted || 0) > 150) {
        overlay(c, c.video.currentTime - c.pt.t0); c.arm();
      }
  }, 30);

  let crowdFigs = [], crowdBox = null, crowdT0 = 0;
  function setCrowd(idx) {
    crowdFigs = idx.map(i => ({ f: figure(i), col: colourOf(i) })).filter(x => x.f);
    const xs = [], ys = [];                                    // framed on where most of them go
    for (const { f } of crowdFigs)
      for (let t = f.A; t <= f.B; t += 2 / D.pose_hz) for (const p of f.at(t)) if (p) { xs.push(p[0]); ys.push(p[1]); }
    xs.sort(d3.ascending); ys.sort(d3.ascending);
    crowdBox = xs.length ? [d3.quantileSorted(xs, .1), d3.quantileSorted(ys, .03), d3.quantileSorted(xs, .9), d3.quantileSorted(ys, .97)] : null;
    crowdStart();
  }
  function crowdStart() { crowdT0 = performance.now(); }      // with the clips: each from the start of its window
  (function crowdLoop() {
    requestAnimationFrame(crowdLoop);
    if (OFF()) return;
    const dpr = devicePixelRatio || 1, cw = Math.round(crowdC.clientWidth * dpr), ch = Math.round(crowdC.clientHeight * dpr);
    if (crowdC.width !== cw || crowdC.height !== ch) { crowdC.width = cw; crowdC.height = ch; }
    const g = crowdC.getContext("2d"), w = crowdC.width, h = crowdC.height;
    g.clearRect(0, 0, w, h);
    if (!crowdFigs.length || !crowdBox) return;
    const [x0, y0, x1, y1] = crowdBox, k = Math.min((w - 40) / (x1 - x0 || 1), (h - 40) / (y1 - y0 || 1));
    const ox = (w - (x1 - x0) * k) / 2 - x0 * k, oy = (h - (y1 - y0) * k) / 2 - y0 * k;
    const e = Math.max(0, (performance.now() - crowdT0) / 1000 * SLOW);   // seconds of video played, as in the clips
    if (!clips.length && e > d3.max(crowdFigs, x => x.f.B - x.f.A) + HOLD * SLOW) crowdStart();   // nothing to follow
    g.lineCap = "round";
    const alpha = Math.max(0.1, Math.min(0.9, 6 / crowdFigs.length + 0.06));
    for (const pass of [false, true])                          // around the piece: thin and grey; in it: its colour
      for (const { f, col } of crowdFigs) {
        const t = f.A + e, on = t >= f.a && t <= f.b;
        if (on !== pass) continue;
        g.globalAlpha = on ? alpha : alpha * 0.6; g.strokeStyle = on ? col : "#9a9aa2"; g.lineWidth = (on ? 1.6 : 1) * dpr;
        bonesPath(g, f.at(t), v => ox + v * k, v => oy + v * k);
        g.stroke();
      }
    g.globalAlpha = 1;
  })();

  function view() {
    stopClips();
    const idx = S.order;
    const rowEl = $(".ex-row");                               // the clips only once something is picked
    if (rowEl.style.display !== (S.pick && idx.length ? "" : "none")) { rowEl.style.display = S.pick && idx.length ? "" : "none"; resize(); }
    $(".ex-more").style.display = "none";
    if (!S.pick || !idx.length) return;
    const n = CLIPS(), from = (S.page * n) % Math.max(idx.length, 1);
    idx.slice(from, from + n).forEach((i, n) => addClip(i, S.pick.type === "circle" && i === S.pick.i && from === 0 && n === 0));
    $(".ex-more").style.display = idx.length > n ? "" : "none";
    setCrowd(idx.slice(0, CROWD));
    run();
  }

  // ---- controls
  const segs = (sel, fn) => root.querySelectorAll(`${sel} button`).forEach(b => b.onclick = () => {
    root.querySelectorAll(`${sel} button`).forEach(x => x.setAttribute("aria-pressed", x === b)); fn(b.dataset.v);
  });
  const legend = $(".ex-legend");
  function setLegend() {
    const grad = (f, a, b, l, r) => `${l}<span class="grad" style="background:linear-gradient(90deg,${d3.range(0, 1.01, 0.1).map(t => f(a + (b - a) * t)).join(",")})"></span>${r}`;
    legend.innerHTML = {
      cluster: P.c.includes(-1) ? `<i style="background:${GREY};margin-left:0"></i>rare ${UNIT}` : "",
      year: grad(yearCol, Y0, Y1, Y0, Y1),
      hit: HIT_NAMES.map((n, k) => `<i style="background:${HIT_COL[k]}${k ? "" : ";margin-left:0"}"></i>${n}`).join(""),
      speed: grad(speedCol, 0, 4, "still", "4 m/s"),
      dir: ["right", "forward", "left", "back"].map((n, k) => `<i style="background:${d3.hsl(k * 90, 0.8, 0.45)}${k ? "" : ";margin-left:0"}"></i>${n}`).join("") + `<i style="background:${GREY}"></i>still`,
    }[S.colour];
  }
  segs(".ex-colour", v => { S.colour = v; recolour(); setLegend(); setFilter(); refilter(); choose(S.pick); });
  const y0 = $(".ex-y0"), y1 = $(".ex-y1"), yl = $(".ex-yl"), fill = root.querySelector(".dual .fill");
  const rangeEl = $(".ex-range"), chipsEl = $(".ex-chips"), filterEl = $(".ex-filter");
  const RANGES = { year: { lo: Y0, hi: Y1, step: 1, fmt: v => v, unit: "" },
                   speed: { lo: 0, hi: SPD, step: 0.1, fmt: v => (+v).toFixed(1), unit: " m/s" } };
  function range() {                                           // the two-handled slider, for years or speed
    const R = RANGES[S.colour];
    if (+y0.value > +y1.value) [y0.value, y1.value] = [y1.value, y0.value];
    F[S.colour] = [+y0.value, +y1.value];
    const [lo, hi] = F[S.colour];
    yl.textContent = (lo === hi ? R.fmt(lo) : `${R.fmt(lo)} – ${R.fmt(hi)}${S.colour === "speed" && hi >= SPD ? "+" : ""}`) + R.unit;
    fill.style.left = (lo - R.lo) / (R.hi - R.lo) * 100 + "%"; fill.style.right = (R.hi - hi) / (R.hi - R.lo) * 100 + "%";
  }
  function setFilter() {
    const m = S.colour;
    rangeEl.style.display = RANGES[m] ? "" : "none";
    chipsEl.style.display = m === "hit" || m === "dir" ? "" : "none";
    filterEl.style.display = m === "cluster" ? "none" : "";        // colour by syllable: nothing to filter
    if (RANGES[m]) {
      const R = RANGES[m];
      for (const el of [y0, y1]) { el.min = R.lo; el.max = R.hi; el.step = R.step; }
      [y0.value, y1.value] = F[m]; range();
    }
    if (m === "hit" || m === "dir") {
      const names = m === "hit" ? HIT_NAMES : DIRS.map(d => d[0].toUpperCase() + d.slice(1));
      const cols = m === "hit" ? HIT_COL : [0, 1, 2, 3].map(k => d3.hsl(k * 90, 0.8, 0.45) + "").concat(GREY);
      chipsEl.innerHTML = names.map((n, k) => `<button data-k="${k}" aria-pressed="${F[m].has(k)}"><i style="background:${cols[k]}"></i>${n}</button>`).join("");
      chipsEl.querySelectorAll("button").forEach(b => b.onclick = () => {
        const k = +b.dataset.k, on = F[m].has(k);
        if (on && F[m].size === 1) return;                     // always keep one
        on ? F[m].delete(k) : F[m].add(k);
        b.setAttribute("aria-pressed", !on); refilter(); choose(S.pick);
      });
    }
  }
  for (const el of [y0, y1]) { el.oninput = () => { range(); refilter(); draw(); }; el.onchange = () => choose(S.pick); }
  $(".ex-more").onclick = () => { S.page++; view(); };
  // ---- full screen: the explorer alone on the screen (where the browser allows it; not on iPhones)
  const fs = $(".ex-full");
  if (!root.requestFullscreen) fs.remove();
  else {
    fs.onclick = () => document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
    document.addEventListener("fullscreenchange", () => {
      const on = document.fullscreenElement === root;
      fs.setAttribute("aria-pressed", on); fs.lastChild.textContent = on ? "Exit full screen" : "Full screen";
      requestAnimationFrame(() => {                              // more clips, or fewer; the cluster back in the middle
        if (!S.pick) return;
        S.page = 0; view(); resize();
        if (S.pick.type === "cluster") zoomTo(...CL.get(S.pick.id).pocket);
      });
    });
  }

  $(".ex-reset").onclick = () => {
    F = FILTER0(); setFilter();
    refilter(); choose(null); unzoom();
  };

  if (TOUCH) $(".ex-hint").textContent = "Pinch to zoom · drag to pan · tap a dot to circle it · drag the circle to move it, its edge to size it";
  recolour(); setFilter(); refilter(); setLegend();
  resize(); new ResizeObserver(resize).observe(canvas);
  const first = D.clusters.find(c => c.name === D.first) || D.clusters.find(c => c.preset);
  if (first) setTimeout(() => side.querySelector(`button[data-id="${first.id}"]`).click(), 60);
  else view();
})());
