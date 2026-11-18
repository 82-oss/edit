# Edit.app's window off originals · measurement (Nov 18, 2026, kenobi)

Step 2 of `plan.md`: can the native window play straight off the original files, and which files need a local proxy?

## How it was measured

- kenobi (M1, 8 GB, macOS 26.3), candidate 841eaa03: release addon and window, the trial server on :7710. The window was
  driven by `EDIT_PREVIEW_JS` steps with `EDIT_PREVIEW_TRACE=1`, and its times were read from its own trace.
- Each file was laid whole on a local-only project in the trial home, so the window read the file itself (no cloud media,
  no pieces). Edit's own preview copy of a local file was marked done and pointed at the file. Without that, the server
  encodes one in the background (16 min for the 44-min file) and the window switches to it mid-run.
- For each file:
  - **First frame:** the first jump into the file, which opens its reader.
  - **Jumps:** 20 jumps far apart (2.5% to 93% of the file, in a scattered order), each timed from the page's seek to the
    window's frame.
  - **Drag:** a 5 s drag, 300 positions 16 ms apart, 4 frames each, counting positions the window drew.
  - **Play:** a 15 s play, from the window's "played" line.
- **Load:** "Loaded" means `nice -n 10 ffmpeg … libx264 -preset medium` encoding 1080p beside the window (load average
  17–25), which is heavier than a typical agent turn.
  - Loaded run 1: that encode alone. It ended about a minute early, so drive-moore and drive-release4 ran mostly
    unloaded.
  - Loaded run 2: that encode, plus the server's own background preview encode of one file (VideoToolbox).
- **Files:** 12 real originals from dev R2: nine YouTube downloads as Edit's import takes them (avc1 ≤1080p), the Drive
  redaction export (`Redact_…`), a bodycam BWC export and a Drive public release. No phone (HEVC/4K) footage was on
  kenobi, so none was measured.
- **Proxies:** four of them were compared against two proxies made locally with Edit's own settings
  (`proxy_pieces.ts videoCommand`, as one file rather than pieces):
  - **Proxy now:** today's proxy. Source size up to 1080p, 4 Mbit/s at 1080p, a keyframe every 0.5 s, no B-frames.
  - **720p / 1 s:** a viewer-sized candidate. 720p, about 1.8 Mbit/s, a keyframe every 1 s, no B-frames.

## Keyframes

Every YouTube download has keyframes 4–7 s apart (up to 13.5 s) and B-frames. Drive and bodycam exports vary from 0.4 s
to 8.3 s. Probing keyframes with `ffprobe -skip_frame nokey` took 17 s for six files (3.6 hours of video).

## Originals in the window

Each cell reads: first frame ms / jumps median (max) ms / drag positions shown of 300 / frames passed over in a 15 s play.

| File | Picture | Keyframe every, median (max) s | Idle | Loaded, run 1 | Loaded, run 2 |
|---|---|---|---|---|---|
| yt-priest | 1080p60, 1.67 Mbit/s, B-frames | 4.03 (7.0) | 84 / 269 (574) / 297 / 1 | 222 / 317 (991) / 201 / 0 | 281 / 372 (926) / 98 / 5 |
| yt-5yo | 1080p60, 2.75 Mbit/s, B-frames | 5.83 (7.0) | 2131 / 238 (584) / 236 / 0 | 2232 / 252 (790) / 17 / 0 | 185 / 270 (1186) / 30 / 8 |
| yt-fleer | 1080p30, 0.99 Mbit/s, B-frames | 5.34 (5.34) | 200 / 172 (263) / 299 / 0 | 2235 / 197 (473) / 283 / 0 | 246 / 250 (972) / 128 / 18 |
| yt-principal | 1080p24, 1.73 Mbit/s, B-frames | 5.26 (8.8) | 85 / 128 (214) / 300 / 0 | 2128 / 138 (404) / 231 / 0 | 490 / 571 (1230) / 11 / 29 |
| yt-kenny | 1080p24, 1.28 Mbit/s, B-frames | 5.55 (13.47) | 184 / 99 (195) / 291 / 0 | 2291 / 212 (578) / 102 / 0 | 517 / 265 (576) / 30 / 0 |
| yt-copwife | 720p24, 0.21 Mbit/s, B-frames | 7.0 (12.0) | 64 / 80 (125) / 294 / 0 | 2389 / 213 (543) / 175 / 0 | 119 / 336 (837) / 29 / 1 |
| yt-momwelfare | 1080p30, 3.28 Mbit/s, B-frames | 5.66 (10.84) | 211 / 135 (285) / 278 / 0 | 2415 / 219 (596) / 43 / 2 | 517 / 300 (831) / 12 / 1 |
| yt-3women | 1080p30, 4.09 Mbit/s, B-frames | 4.83 (12.13) | 100 / 106 (236) / 298 / 0 | 2109 / 208 (450) / 33 / 2 | 285 / 394 (888) / 14 / 8 |
| yt-manipulator | 720p30, 0.31 Mbit/s, B-frames | 6.0 (8.23) | 142 / 96 (146) / 297 / 0 | 2393 / 292 (579) / 37 / 3 | 1107 / 514 (1485) / 14 / 3 |
| drive-redact | 720p30, 10.3 Mbit/s | 8.33 (8.33) | 194 / 130 (217) / 287 / 0 | 550 / 564 (964) / 14 / 7 | 771 / 602 (1440) / 15 / 0 |
| drive-moore | 720p30, 4.21 Mbit/s | 1.67 (1.67) | 38 / 41 (56) / 300 / 0 | 2313 / 54 (528) / 299 / 0 | 432 / 186 (479) / 21 / 0 |
| drive-release4 | 720p30, 6.35 Mbit/s, B-frames | 0.4 (0.5) | 39 / 33 (42) / 300 / 0 | 76 / 32 (52) / 300 / 0 | 102 / 214 (405) / 20 / 0 |

- **Plain play holds on every original.** No 15 s play idle passed over more than one frame, and the sound never ran
  short. Loaded, 0–29 frames were passed over in 15 s, the worst on 1080p files with long gaps between keyframes.
- **Jumps follow keyframe spacing.**
  - Idle: 33–41 ms where keyframes are ≤1.7 s apart; 80–270 ms median and up to 584 ms where they're 4–8 s apart.
    1080p60 is the slowest, at 238–269 ms.
  - Loaded: the long-gap files go to 138–602 ms median and up to 1.5 s.
- **Drags collapse under load on long-gap files**, which drew 11–283 of 300 positions. The short-gap files did better:
  drive-moore drew 299 in loaded run 1 but only 21 in run 2.
- **A first jump into a file sometimes took 2.1–2.4 s.** The trace shows a single seek, for example "open 1×13.2 seek
  1×2111.3". It happened on nearly every file in loaded run 1 and once idle (yt-5yo), so it isn't only load. The other
  first jumps took 38–517 ms (one 1107 ms). The cause is unknown; it may be a reader waiting for a hardware decoder
  while others are open. Worth a look before step 3.

## Originals against proxies

Each cell reads: jumps median (max) ms, drag positions shown of 300. Plays were clean on every form (0–2 frames passed
over).

| File | Original idle | Proxy now idle | 720p / 1 s idle | Original loaded (runs 1 / 2) | Proxy now loaded | 720p / 1 s loaded |
|---|---|---|---|---|---|---|
| yt-5yo | 238 (584), 236 | 40 (59), 296 | 46 (71), 291 | 252 (790), 17 / 270 (1186), 30 | 70 (198), 27 | 80 (136), 159 |
| yt-principal | 128 (214), 300 | 31 (59), 300 | 36 (78), 299 | 138 (404), 231 / 571 (1230), 11 | 92 (396), 56 | 60 (110), 80 |
| yt-copwife | 80 (125), 294 | 30 (41), 299 | 30 (43), 299 | 213 (543), 175 / 336 (837), 29 | 136 (345), 43 | 94 (839), 105 |
| drive-redact | 130 (217), 287 | 24 (34), 299 | 35 (47), 300 | 564 (964), 14 / 602 (1440), 15 | 129 (314), 25 | 112 (662), 57 |

- **First frames on the proxies:** 23–126 ms idle and 99–463 ms loaded.
- **Today's proxy and the 720p / 1 s one are equal idle** (24–46 ms jumps).
- **Under load the 720p / 1 s proxy is as good or better.** Its jumps were 60–112 ms median against 70–136 ms, and it
  drew 57–159 of 300 drag positions against 25–56.

## Making the proxy locally (VideoToolbox, M1, from a local original)

| Source | Proxy now (source size, 0.5 s keyframes) | 720p, 1 s keyframes, 1.8 Mbit/s |
|---|---|---|
| yt-5yo 1080p60, 24.8 min | 435 s (3.4× real time)*, 26.2 MB/min | 279 s (5.3×), 11.6 MB/min |
| yt-fleer 1080p30, 43 min | – | 237 s (10.9×), 5.8 MB/min |
| yt-principal 1080p24, 23.5 min | 165 s (8.5×), 21.7 MB/min | 101 s (14.0×), 9.4 MB/min |
| yt-copwife 720p24, 53 min | 191 s (16.6×), 4.4 MB/min | 191 s (16.7×), 3.3 MB/min |
| drive-redact 720p30, 27.7 min | 125 s (13.3×), 12.6 MB/min | 125 s (13.3×), 12.8 MB/min |

\* Measured while the originals were downloading beside it.

- **Speed:** a 720p proxy at a source's own fps takes about a tenth of the video's length for 24–30 fps sources, and a
  fifth for 60 fps.
- **Size:** 3–13 MB a minute, about 0.2–0.8 GB an hour. Today's proxy is 4–26 MB a minute, and the plan measured
  today's pieces at ~26 MB a minute.
- **VideoToolbox undershoots its rate on quiet footage:** yt-copwife came out at 0.4 Mbit/s against a 1.8 Mbit/s cap.

## Recommendation

1. **Decide per file at import, by keyframe spacing.** A file whose keyframes are at most about 2 s apart plays as the
   original: jumps were as fast as a proxy's (33–54 ms), drags full and plays clean. Here that is the bodycam BWC export
   (1.67 s) and the Drive release (0.4 s). Probe with `ffprobe -skip_frame nokey` (seconds a file).
2. **Everything else gets one local proxy**, made at import and never uploaded. That covers every YouTube download
   (4–7 s, up to 13.5 s) and long-GOP Drive exports like the redaction tool's (8.3 s). Played straight, these are fine
   idle but jump at 140–600 ms median (up to 1.5 s) under an agent's load. Their first jump sometimes takes 2 s, and a
   drag shows a fraction of its positions.
3. **Proxy settings:**
   - 720p, with smaller sources kept as they are.
   - A keyframe every 1 s, no B-frames, H.264 on VideoToolbox, capped at about 1.8 Mbit/s.
   - It plays as well as today's proxy (better under load) at under half the size, and is made at 5–17× real time.
4. **Not measured, check before step 3:**
   - Capping a 60 fps source's proxy at the timeline's 30 fps. This should about halve its encode time and size, and
     60 fps sources were the slowest originals.
   - Phone HEVC/4K footage.
   - Why a first seek sometimes takes 2.1 s.
   - Drags under heavy load were weak for every form, proxies included, so the drag path itself may need a look.
