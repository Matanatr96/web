# Skeleton quiz: provenance

The game: https://offpolicyinc.com/work/skeleton-tennis/. The page lives in offpolicysite
(`content/pages/skeleton-tennis/`: `index.html`, `manifest.json`); its clips are in the site's R2 bucket
(`media/skeleton-tennis/clips/`).
Opens straight into level 1. Each of 10 levels (harder each time) is one match, shown as two short rallies
drawn as skeletons + ball + court on black, playing in turn, each stroke named top left: one served by each
player from the near end. Pick the blue player, then the orange one, from five names (the two players and
three decoys from the same or the nearest levels); 1 point each, 20 max. The game goes straight to the next
level and adds one line below (the right names, and your pick where wrong); the end screen lists those lines,
latest first. No typing, no leaderboard.

Play it locally from offpolicysite: `python3 build.py --local && node serve.js`, then
http://localhost:8917/work/skeleton-tennis/.

## Where things are

| What | Laptop (SSD, `data/` = `/Volumes/PW_SSD/deep-sports-analysis/data`) | Modal volume `deep-sports` |
|---|---|---|
| Whole YouTube uploads (720p, no audio) | `raw/quiz/<YouTube id>.mp4` | – |
| Recording analysed (first 30 min, or all) | `projects/quiz/<video>/source.mp4` | – |
| Step 0 (live play only) | `projects/quiz/<video>/kept.mp4`, `kept.json`, `cuts/` | `kept.mp4` |
| Step 2 (models) | `projects/quiz/<video>/raw.npz`, `strokes/` | `raw.npz`, `strokes/scores.npz` |
| Steps 3, 4 | `projects/quiz/<video>/players.json`, `names.json` | – |
| Usable rallies, chosen pairs, drawn clips | `projects/quiz/<video>/points/points.json`, `pairs.json`, `<first frame>.mp4`, `serve/` (scoreboard frames) | – (the game's are in git) |
| The game (page, manifest, chosen clips) | offpolicysite: `content/pages/skeleton-tennis/` (page, `manifest.json`), `media/skeleton-tennis/clips/` | – |

The video list (YouTube ids, matches, levels, players) is `PROJECTS["quiz"]` in `src/dsa/ingest/projects.py`.

## Levels and sources

| Level | Video (`projects/quiz/…`; l<n> is the level first planned) | Match | YouTube | Used | Kept play | Usable rallies | Rounds |
|---|---|---|---|---|---|---|---|
| **1** | `l1_federer_nadal` | Roger Federer v Rafael Nadal, Australian Open 2017 final | [KTCDxjJvs2U](https://youtu.be/KTCDxjJvs2U) | first 30 min | 9.0 min | 7 | 1 |
| | `l1_djokovic_federer` | Novak Djokovic v Roger Federer, Wimbledon 2019 final | [TUikJi0Qhhw](https://youtu.be/TUikJi0Qhhw) | first 30 min | 12.8 min | 17 | 5 |
| | `l1_djokovic_nadal` | Novak Djokovic v Rafael Nadal, US Open 2013 final | [qg4wqo02gfc](https://youtu.be/qg4wqo02gfc) | first 30 min | 15.8 min | 7 | 3 |
| **2** | `l2_alcaraz_sinner` | Carlos Alcaraz v Jannik Sinner, Roland-Garros 2025 final | [ckbX699wngs](https://youtu.be/ckbX699wngs) | first 30 min | 7.2 min | 0 | 0 |
| | `l2_alcaraz_zverev` | Carlos Alcaraz v Alexander Zverev, Australian Open 2026 semifinal | [gkhOwQ3eM88](https://youtu.be/gkhOwQ3eM88) | first 30 min | 5.4 min | 6 | 1 |
| | `l2_sinner_zverev` | Jannik Sinner v Alexander Zverev, Australian Open 2025 final | [9_3APf0X_-8](https://youtu.be/9_3APf0X_-8) | first 30 min | 8.1 min | 12 | 2 |
| | `l4_medvedev_tsitsipas` | Daniil Medvedev v Stefanos Tsitsipas, Australian Open 2022 semifinal | [pFIP6kY8yoA](https://youtu.be/pFIP6kY8yoA) | first 30 min | 9.4 min | 15 | 3 |
| **3** | `l4_kyrgios_medvedev` | Nick Kyrgios v Daniil Medvedev, US Open 2022 round 4 | [XdKQEuP0r5o](https://youtu.be/XdKQEuP0r5o) | first 30 min | 10.2 min | 4 | 1 |
| | `l4_kyrgios_tsitsipas` | Nick Kyrgios v Stefanos Tsitsipas, Wimbledon 2022 round 3, highlights | [6dzIBWFGYTQ](https://youtu.be/6dzIBWFGYTQ) | all | 13.1 min | 18 | 5 |
| **4** | `l5_fritz_shelton` | Taylor Fritz v Ben Shelton, Indian Wells 2023, highlights | [0EQ52HULPbw](https://youtu.be/0EQ52HULPbw) | all | 9.0 min | 9 | 2 |
| | `l5_fritz_tiafoe` | Taylor Fritz v Frances Tiafoe, US Open 2024 semifinal | [4AV40TOmfe0](https://youtu.be/4AV40TOmfe0) | first 30 min | 11.6 min | 5 | 2 |
| | `l5_shelton_tiafoe` | Ben Shelton v Frances Tiafoe, US Open 2024 round 3 | [8MOWcvOKwlA](https://youtu.be/8MOWcvOKwlA) | first 30 min | 7.1 min | 7 | 2 |
| **5** | `l6_dimitrov_rublev` | Grigor Dimitrov v Andrey Rublev, US Open 2024 round 4 | [IDRsM8sDdTc](https://youtu.be/IDRsM8sDdTc) | first 30 min | 8.3 min | 3 | 1 |
| | `l6_deminaur_dimitrov` | Alex de Minaur v Grigor Dimitrov, US Open 2019 round 4, highlights | [4USAx07Ypq4](https://youtu.be/4USAx07Ypq4) | all | 9.5 min | 8 | 2 |
| | `l6_deminaur_rublev` | Alex de Minaur v Andrey Rublev, Australian Open 2024 round 4 | [oWi78iQGPi8](https://youtu.be/oWi78iQGPi8) | first 30 min | 9.5 min | 19 | 5 |
| **6** | `l7_berrettini_rune` | Matteo Berrettini v Holger Rune, Australian Open 2025 round 2 | [uJyijHso1_Y](https://youtu.be/uJyijHso1_Y) | first 30 min | 8.8 min | 8 | 3 |
| | `l7_berrettini_ruud` | Matteo Berrettini v Casper Ruud, US Open 2022 quarterfinal | [G7T5Z3WwE1M](https://youtu.be/G7T5Z3WwE1M) | first 30 min | 9.7 min | 11 | 3 |
| | `l7_rune_ruud` | Holger Rune v Casper Ruud, Red Bull Bassline exhibition, Australian Open 2025 | [tJ2_uu8HkS8](https://youtu.be/tJ2_uu8HkS8) | all | 2.9 min | 4 | 1 |
| **7** | `l8_korda_paul` | Sebastian Korda v Tommy Paul, US Open 2022 round 2 | [tQd0KIzHFPE](https://youtu.be/tQd0KIzHFPE) | first 30 min | 11.7 min | 8 | 2 |
| | `l8_hurkacz_korda` | Hubert Hurkacz v Sebastian Korda, Australian Open 2023 round 4 | [zVIG57uwLEE](https://youtu.be/zVIG57uwLEE) | first 30 min | 10.1 min | 9 | 3 |
| **8** | `l8_hurkacz_mensik` | Hubert Hurkacz v Jakub Mensik, Australian Open 2024 round 2, highlights | [Pcn-Su3IU5I](https://youtu.be/Pcn-Su3IU5I) | all | 5.0 min | 10 | 4 |
| | `l9_augeraliassime_lehecka` | Felix Auger-Aliassime v Jiri Lehecka, Australian Open 2023 round 4, condensed | [kCAJdZRzEsM](https://youtu.be/kCAJdZRzEsM) | all | 9.3 min | 5 | 1 |
| **9** | `l9_fonseca_mensik` | Joao Fonseca v Jakub Mensik, Next Gen ATP Finals 2024, highlights | [beh_Kwo6UoI](https://youtu.be/beh_Kwo6UoI) | all | 7.6 min | 0 | 0 |
| | `l9_draper_giron` | Jack Draper v Marcos Giron, Australian Open 2024 round 1, condensed | [Gb5blpgTiqA](https://youtu.be/Gb5blpgTiqA) | all | 16.3 min | 4 | 1 |
| | `l10_brooksby_fonseca` | Jenson Brooksby v Joao Fonseca, Wimbledon 2025 round 1, highlights | [V5TzhUetgm4](https://youtu.be/V5TzhUetgm4) | all | 6.8 min | 11 | 3 |
| **10** | `l10_michelsen_nakashima` | Alex Michelsen v Brandon Nakashima, US Open 2026 round 2, condensed | [9C0u0R3Zj2w](https://youtu.be/9C0u0R3Zj2w) | all | 17.9 min | 32 | 5 |
| | `l10_giron_tien` | Marcos Giron v Learner Tien, Australian Open 2026 round 1 | [4NrbPy_MKrE](https://youtu.be/4NrbPy_MKrE) | first 30 min | 11.3 min | 0 | 0 |
| out | `l3_agassi_sampras` | Andre Agassi v Pete Sampras, US Open 1995 final | [wTNvz2F682k](https://youtu.be/wTNvz2F682k) | first 30 min | 13.0 min | – | – |
| | `l3_roddick_sampras` | Andy Roddick v Pete Sampras, US Open 2002 quarterfinal | [nq94E9eDia0](https://youtu.be/nq94E9eDia0) | first 30 min | 6.4 min | – | – |
| | `l3_agassi_roddick` | Andre Agassi v Andy Roddick, Cincinnati 2004 semifinal | [86Db0SUSXU0](https://youtu.be/86Db0SUSXU0) | first 30 min | 7.3 min | – | – |

Rounds in the game per level: L1 9, L2 6, L3 6, L4 6, L5 8, L6 7, L7 5, L8 5, L9 4, L10 5 (61 rounds, 122 clips).

## What was done, per stage

1. **Choose matches.** Three players per level, one match per pair. Found with `yt-dlp ytsearch`; kept
   single-match uploads from official channels where possible (Australian Open, Wimbledon, US Open / USTA,
   Roland-Garros, Tennis TV), preferring full matches, then condensed, then extended highlights.
2. **Download** (`python -m dsa.ingest.download get quiz/<video>`): best video ≤720p mp4, whole upload kept in
   `raw/quiz/`. `source.mp4` = first 30 min of a full match, or all of a highlights/condensed upload;
   50/60 fps uploads halved to 25/30 fps.
3. **Step 0** (`dsa.gpu.cuts run`, laptop): keep main-camera shots only → `kept.mp4`. Draper–Giron and
   Giron–Tien (outer courts) use a lower main-camera depth (`min_depth` in the project).
4. **Step 2** (`dsa.gpu.app`, Modal, L40S, ≤9 at once): F3ED hits and strokes, RF-DETR people, WASB ball,
   court every 5 frames, ByteTrack, RTMW skeletons.
5. **Step 3** (`dsa.scene.run`): near/far player per frame, Player 1/2 by clothing colour. Rerun 1 Oct after a
   fix: it took whoever stood nearest the singles court, so a line judge sitting 2 m beside the far
   sideline beat a player standing 5 m behind the baseline (seen in ~20 rallies); metres behind a baseline
   now count 0.3×.
6. **Step 4** (`dsa.scene.names`, Opus): both names are known, so Opus only says which is Player 1. Unsure in
   18 of 30 videos and, checked against the scoreboard, wrong in 3 and mixed in ~8, so the game does not
   rely on it where a scoreboard exists (stage 7).
7. **Points** (`python -m dsa.pages.quiz points quiz/<video>`): every point = a serve plus the hits after it until
   the next serve, a camera cut or a 4 s pause. Usable when it has ≥4 hits, is served from the near end,
   its court holds still (filtered first: a court check off the median of the 9 around it is replaced;
   then the baselines may turn against each other by ≤3° and the court may move ≤2% of its width in a
   frame), and both players are tracked (missing or under half their usual height in ≤5% of frames, ≤2 box jumps or size flickers from where last seen, the near player the taller: else step 3 may have a spectator's head at the bottom of the picture). Within a
   point each end keeps the player it has most often. Names per point: Opus (low effort) reads the
   scoreboard's serve marker 1 s (else 2.5 s) before the serve (`points/serve/<frame>.jpg`), and the
   serving end gets that name; no marker: step 4's names. Then up to 5 pairs per
   video, shortest first: one point served by each player, between them a forehand and a backhand by each.
   Only those are drawn, plain (black background, the first listed player blue, ball, court lines, net,
   each stroke in words top left in the hitter's colour). Joints are cleaned by `dsa.scene.clean.joints`:
   left/right fixed per side of the body and only for flips of ≤8 frames (leg criss-crossing 45k → 9k
   frames over the 30 videos).
8. **Export** (`python -m dsa.pages.quiz export ../offpolicysite/media/skeleton-tennis`): every pair → `clips/` + `manifest.json`
   (per level, rounds of two clips, match, players blue first). Then in offpolicysite: move `manifest.json` to
   `content/pages/skeleton-tennis/`, upload the clips (`tools/upload_media.sh skeleton-tennis`), commit, push.

## Key decisions

- **Multiple choice, blue and orange separately** (your call, 1 Oct, after typing proved too hard): five names, decoys from the same or nearest levels so they are as famous and mostly of the same era.
- **Ladder**: by how recognisable a player is to a fan from movement alone; biased to Americans and the
  current tour; hardest level about Youzhny/Coria obscurity (your call).
- **30 min, not 15, of full matches**: uploads open with walk-ons and warm-ups, so 15 min held only 2–8
  min of play and 1–9 rallies per match, below the 10–20 clips per level asked for.
- **A level = two short rallies of one match, each player serving once from the near end** (your call, 1 Oct):
  the far player is small and tracked worse. Near-end serves cost Alcaraz–Sinner all its rallies (1 of 15).
- **Clips are dropped, not fixed, when the court or tracking is bad** (your call): Alcaraz–Sinner,
  Fonseca–Mensik and Giron–Tien give no rounds.
- **The 1995–2004 broadcasts are out** (your call, 1 Oct): poor court and tracking, and no scoreboard serve
  marker. The other matches were regrouped, in the same order, into 10 levels of 4–9 rounds (up to 5 pairs
  per match); Medvedev–Tsitsipas moved up to level 2 to fill it.
- **Blue/orange from the scoreboard, per rally**: step 3's split by clothing and step 4's naming were wrong
  or mixed in about a third of the videos.
- **50/60 fps halved**: F3ED found almost no rallies at 60 fps (Korda–Paul: 0 rallies; 17 at 30 fps).
  Six US Open uploads and Alcaraz–Sinner (50 fps) were redone.
- **Outer courts**: their main camera sits lower, so step 0 kept nothing until `min_depth` was lowered
  from 0.4 to 0.3 for those two videos (0.4 keeps out the low serve-replay camera on show courts).
- **F3ED assumes right-handers**; its forehand/backhand labels are wrong for lefties (Nadal, Shelton,
  Draper), both in the captions and in the "a forehand and a backhand each" rule.
- **Clips are not checked one by one**; the filters are measured, and a clip can still show a missed ball
  or a brief pose glitch.
- **Copyright**: clips are derived skeleton renders of broadcast footage; you said it doesn't matter.

## Cost

Modal, deep-sports app, 1 Oct 2026: **$76** (`modal billing report --for today`), nearly all of it the
quiz. Roughly $30 of that was waste: the first pass at 15 min (redone at 30), seven runs that read the
wrong file (my scheduling race, stopped and redone), and the 60 fps runs (redone at 30 fps).
