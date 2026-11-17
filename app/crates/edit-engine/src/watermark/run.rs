//! Taking the mark out of one stretch of footage, streaming: FFmpeg reads
//! the stretch twice (its brightness whole, to find the mark in every frame;
//! then only the box the mark moves in, in colour, to restore it), blocks of
//! frames are restored side by side, and the strip (the restored box over
//! its alpha, premultiplied, as Edit's stacked videos are) goes to x264 as
//! it's made. Frames are held only as long as a neighbour needs them.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Stdio};
use std::time::Instant;

use super::find::{opacity, placed, Frame, Spot, Template};
use super::plane::{Mask, Plane};
use super::restore::{
    paste, prep, restore, Flows, Neighbour, Picture, Prep, Rect, Restored, Work, FLOW_MARGIN, PAD,
    STEPS,
};
use super::{Curve, Model, Shares};

/// A search score that says the mark is there.
const PRESENT: f32 = 0.1;
/// What a spot elsewhere must score to move the track there (a mark rarely jumps; over brights a faint one can lose to noise).
const JUMP: f32 = 0.3;
/// Frames between looks over the whole frame.
const GLOBAL_EVERY: usize = 8;
/// Frames restored at once.
const BLOCK: usize = 32;

/// What a stretch's removal did.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Removed {
    /// The strip's box on the footage's picture (shares).
    pub region: Shares,
    /// Its frames, and those with the mark in them.
    pub frames: u32,
    pub marked: u32,
    /// Of the mark's pixels: the share taken from neighbouring frames (the rest are the inverse alone).
    pub filled: f32,
    /// How much of the mark is still found in what came out (its search's score after over before, every sixth
    /// frame with it): near 0 when it's gone, 1 when nothing was done. What a check of the piece reads first.
    pub left: f32,
    /// Seconds it took.
    pub took: f64,
}

/// The footage's picture.
#[derive(Clone, Copy, Debug)]
pub struct Footage {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// An FFmpeg reading raw frames of a stretch.
pub(crate) struct Decoder {
    child: crate::util::Watched,
    stdout: ChildStdout,
    errors: Option<std::thread::JoinHandle<Vec<u8>>>,
}

impl Decoder {
    /// Frames of `source` from `from` (for `seconds`, or to its end) through `filters`, as `pix_fmt`; `fast` skips frames nothing refers to (sampling).
    pub fn open(
        source: &Path,
        from: f64,
        seconds: Option<f64>,
        filters: &str,
        pix_fmt: &str,
        _frame_bytes: usize,
        fast: bool,
    ) -> Result<Self, String> {
        let mut command = crate::util::ffmpeg_command();
        crate::util::background_command(&mut command);
        command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        if fast {
            command.args(["-skip_frame", "noref"]);
        }
        command.args(crate::util::url_args(source));
        if from > 0.0 {
            command.args(["-ss", &format!("{from:.6}")]);
        }
        command.arg("-i").arg(source);
        if let Some(seconds) = seconds {
            command.args(["-t", &format!("{seconds:.6}")]);
        }
        command.args([
            "-map", "0:v:0", "-vf", filters, "-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1",
        ]);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("ffmpeg is not available ({error}); install FFmpeg"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg gave no output")?;
        let errors = child.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = pipe.read_to_end(&mut bytes);
                bytes
            })
        });
        Ok(Self {
            child: crate::util::Watched::new(child),
            stdout,
            errors,
        })
    }

    /// The next frame into `buffer` (its size a frame's); false at the end.
    pub fn next(&mut self, buffer: &mut [u8]) -> Result<bool, String> {
        match self.stdout.read_exact(buffer) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
            Err(error) => Err(format!("reading the footage: {error}")),
        }
    }

    /// Waits for FFmpeg; its last error line when it failed.
    pub fn finish(mut self) -> Result<(), String> {
        let status = self.child.wait().map_err(|error| error.to_string())?;
        let errors = self
            .errors
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default();
        if status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&errors);
        Err(text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("ffmpeg failed")
            .trim()
            .to_owned())
    }
}

/// x264 writing the strip.
struct Encoder {
    child: std::process::Child,
    stdin: Option<ChildStdin>,
    errors: Option<std::thread::JoinHandle<Vec<u8>>>,
}

/// A frame rate as FFmpeg reads it (NTSC's exactly).
fn rate(fps: f64) -> String {
    for (num, den) in [(24000, 1001), (30000, 1001), (60000, 1001)] {
        if (fps - num as f64 / den as f64).abs() < 1e-3 {
            return format!("{num}/{den}");
        }
    }
    format!("{fps:.6}")
}

impl Encoder {
    fn open(out: &Path, w: usize, h: usize, fps: f64) -> Result<Self, String> {
        let gop = ((fps / 2.0).round() as u32).max(1).to_string();
        let mut command = crate::util::ffmpeg_command();
        crate::util::background_command(&mut command);
        command.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "-s",
            &format!("{w}x{h}"),
            "-r",
            &rate(fps),
            "-i",
            "pipe:0",
        ]);
        command.args([
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "14",
            "-g",
            &gop,
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            "-movflags",
            "+faststart",
        ]);
        command.arg(out);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("ffmpeg is not available ({error}); install FFmpeg"))?;
        let stdin = child.stdin.take();
        let errors = child.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = pipe.read_to_end(&mut bytes);
                bytes
            })
        });
        Ok(Self {
            child,
            stdin,
            errors,
        })
    }

    fn write(&mut self, frame: &[u8]) -> Result<(), String> {
        self.stdin
            .as_mut()
            .ok_or("the encoder is closed")?
            .write_all(frame)
            .map_err(|error| format!("writing the strip: {error}"))
    }

    fn finish(mut self) -> Result<(), String> {
        drop(self.stdin.take());
        let status = self.child.wait().map_err(|error| error.to_string())?;
        let errors = self
            .errors
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default();
        if status.success() {
            Ok(())
        } else {
            let text = String::from_utf8_lossy(&errors);
            Err(text
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("ffmpeg failed")
                .trim()
                .to_owned())
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        if self.stdin.is_some() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Where the mark is in each frame, and how strong (0: not there).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Place {
    pub x: f32,
    pub y: f32,
    pub c: f32,
}

/// Finds the mark in every frame of a stretch's brightness, `frames` given one at a time.
pub(crate) struct Tracker<'a> {
    template: Template,
    matte: &'a Plane,
    curve: Curve,
    w: usize,
    h: usize,
    current: (f32, f32),
    challenger: Option<((f32, f32), usize)>,
    spots: Vec<Spot>,
    opacities: Vec<Option<f32>>,
    recent: std::collections::VecDeque<(usize, Vec<u8>)>,
    since_global: usize,
}

impl<'a> Tracker<'a> {
    pub fn new(matte: &'a Plane, at: [f32; 2], curve: Curve, w: usize, h: usize) -> Self {
        Self {
            template: Template::new(matte),
            matte,
            curve,
            w,
            h,
            current: (at[0], at[1]),
            challenger: None,
            spots: Vec::new(),
            opacities: Vec::new(),
            recent: std::collections::VecDeque::new(),
            since_global: GLOBAL_EVERY,
        }
    }

    /// Where the mark is believed to be now (its matte's top left).
    pub fn current(&self) -> (f32, f32) {
        self.current
    }

    pub fn add(&mut self, y: &[u8]) {
        let index = self.spots.len();
        let frame = Frame {
            y,
            w: self.w,
            h: self.h,
        };
        // Where it was plain in the last frames, it's looked for a few pixels round where its motion puts it; else wider.
        let last_two = (self.spots.len() >= 2).then(|| {
            (
                self.spots.last().copied(),
                self.spots.get(self.spots.len() - 2).copied(),
            )
        });
        let local = match last_two {
            Some((Some(a), Some(b)))
                if a.score > STRONG && b.score > STRONG && (a.x - b.x).hypot(a.y - b.y) < 6.0 =>
            {
                let guess = (2.0 * a.x - b.x, 2.0 * a.y - b.y);
                self.template
                    .near(&frame, guess, 4.0)
                    .filter(|s| s.score > STRONG)
            }
            _ => None,
        };
        let local = local
            .or_else(|| self.template.near(&frame, self.current, 20.0))
            .unwrap_or(Spot {
                x: self.current.0,
                y: self.current.1,
                score: 0.0,
            });
        let mut chosen = local;
        // A challenger: somewhere else the whole-frame look found the mark stronger. Three frames in a row beating where it was is a jump.
        if let Some((at, wins)) = self.challenger {
            match self.template.near(&frame, at, 6.0) {
                Some(there) if there.score > JUMP && there.score > local.score + 0.1 => {
                    let wins = wins + 1;
                    if wins >= 3 {
                        self.current = (there.x, there.y);
                        self.challenger = None;
                        chosen = there;
                        self.reassign((there.x, there.y));
                    } else {
                        self.challenger = Some(((there.x, there.y), wins));
                    }
                }
                _ => self.challenger = None,
            }
        }
        self.since_global += 1;
        if self.challenger.is_none() && (self.since_global >= GLOBAL_EVERY || local.score < PRESENT)
        {
            self.since_global = 0;
            let found_any = self.template.anywhere(&frame);
            if let Some(found) = found_any {
                let far = (found.x - local.x).hypot(found.y - local.y) > 15.0;
                if far && found.score > JUMP && found.score > local.score + 0.15 {
                    if local.score < PRESENT
                        && self
                            .spots
                            .iter()
                            .rev()
                            .take(GLOBAL_EVERY)
                            .all(|s| s.score < PRESENT)
                    {
                        // Nothing where it was for a while: take it at once.
                        self.current = (found.x, found.y);
                        chosen = found;
                        self.reassign((found.x, found.y));
                    } else {
                        self.challenger = Some(((found.x, found.y), 1));
                    }
                }
            }
        }
        if chosen.score > PRESENT {
            self.current = (chosen.x, chosen.y);
        }
        self.spots.push(chosen);
        self.opacities.push(None);
        self.recent.push_back((index, y.to_vec()));
        while self.recent.len() > 2 * GLOBAL_EVERY + 4 {
            if let Some((old, bytes)) = self.recent.pop_front() {
                self.settle(old, &bytes);
            }
        }
    }

    /// The recent frames looked at again near `at` (just jumped there): each takes whichever spot is stronger.
    fn reassign(&mut self, at: (f32, f32)) {
        let template = &self.template;
        for (index, bytes) in &self.recent {
            let frame = Frame {
                y: bytes,
                w: self.w,
                h: self.h,
            };
            if let (Some(there), Some(spot)) =
                (template.near(&frame, at, 6.0), self.spots.get_mut(*index))
            {
                if there.score > spot.score {
                    *spot = there;
                }
            }
        }
    }

    /// A frame's spot is final: its opacity.
    fn settle(&mut self, index: usize, y: &[u8]) {
        let Some(&spot) = self.spots.get(index) else {
            return;
        };
        // Every other frame (it's smoothed over ±12; the fit is the tracking's dearest part).
        let found = if index % 2 == 1 {
            None
        } else if spot.score > PRESENT * 0.5 {
            opacity(
                &Frame {
                    y,
                    w: self.w,
                    h: self.h,
                },
                self.matte,
                (spot.x, spot.y),
                self.curve,
            )
        } else {
            Some(0.0)
        };
        if let Some(slot) = self.opacities.get_mut(index) {
            *slot = found;
        }
    }

    /// Every frame's place: positions smoothed within each stretch between jumps, opacities filled in and smoothed.
    pub fn places(mut self) -> Vec<Place> {
        while let Some((old, bytes)) = self.recent.pop_front() {
            self.settle(old, &bytes);
        }
        smooth(&self.spots, &self.opacities)
    }
}

fn median(mut values: Vec<f32>) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable_by(f32::total_cmp);
    values.get(values.len() / 2).copied()
}

/// How far round the mark the camera's shift is measured (full-size pixels).
const MOTION_MARGIN: usize = 160;
/// The most it's looked for between two frames (quarter-size pixels).
const MOTION_REACH: isize = 14;

/// The camera's shift round the mark from each frame to the next (the lab's whole-frame flow found big pans; a
/// box's flow alone can't): masked normalised cross-correlation of quarter-size windows, the mark's box left out.
/// `path[k]` is where frame k's scene sits against frame 0's, so a scene point at p in frame t is near
/// p + path[j] − path[t] in frame j.
#[derive(Default)]
pub(crate) struct Motion {
    prev: Option<(Plane, (usize, usize), Rect)>,
    pub path: Vec<(f32, f32)>,
}

impl Motion {
    pub fn add(&mut self, frame: &Frame, mark: Rect) {
        let window = mark.grown(MOTION_MARGIN, frame.w, frame.h);
        let (x0, y0) = (window.x0 & !3, window.y0 & !3);
        let (w4, h4) = ((window.x1 - x0) / 4, (window.y1 - y0) / 4);
        let last = self.path.last().copied().unwrap_or((0.0, 0.0));
        let step = match &self.prev {
            Some((prev, origin, prev_mark)) => {
                let cur = frame.small(4, origin.0 / 4, origin.1 / 4, prev.w, prev.h);
                let masked = Rect {
                    x0: (prev_mark.x0.saturating_sub(origin.0 + 8)) / 4,
                    y0: (prev_mark.y0.saturating_sub(origin.1 + 8)) / 4,
                    x1: (prev_mark.x1 + 8).saturating_sub(origin.0).div_ceil(4),
                    y1: (prev_mark.y1 + 8).saturating_sub(origin.1).div_ceil(4),
                };
                let (dx, dy) = shift(prev, &cur, masked);
                (4.0 * dx, 4.0 * dy)
            }
            None => (0.0, 0.0),
        };
        self.path.push((last.0 + step.0, last.1 + step.1));
        self.prev = Some((
            frame.small(4, x0 / 4, y0 / 4, w4.max(1), h4.max(1)),
            (x0, y0),
            mark,
        ));
    }
}

/// Masked NCC of `a` against `b` shifted by (dx, dy) (a's pixel p against b's p + d), `masked` left out.
fn ncc_at(a: &Plane, b: &Plane, masked: Rect, dx: isize, dy: isize, reach: isize) -> f32 {
    let (mut sa, mut sb, mut sab, mut saa, mut sbb, mut n) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    let r = reach as usize;
    for y in r..a.h.saturating_sub(r) {
        for x in r..a.w.saturating_sub(r) {
            if x >= masked.x0 && x < masked.x1 && y >= masked.y0 && y < masked.y1 {
                continue;
            }
            let (va, vb) = (
                f64::from(a.at(x, y)),
                f64::from(b.clamped(x as isize + dx, y as isize + dy)),
            );
            sa += va;
            sb += vb;
            sab += va * vb;
            saa += va * va;
            sbb += vb * vb;
            n += 1.0;
        }
    }
    if n < 50.0 {
        return 0.0;
    }
    let cov = sab - sa * sb / n;
    let var = (saa - sa * sa / n) * (sbb - sb * sb / n);
    if var <= 1e-9 {
        0.0
    } else {
        (cov / var.sqrt()) as f32
    }
}

/// The shift (quarter-size pixels) best matching `a` into `b`: at an eighth size first, then a quarter, to a fraction of a pixel.
fn shift(a: &Plane, b: &Plane, masked: Rect) -> (f32, f32) {
    let (ha, hb) = (a.half(), b.half());
    let hm = Rect {
        x0: masked.x0 / 2,
        y0: masked.y0 / 2,
        x1: masked.x1.div_ceil(2),
        y1: masked.y1.div_ceil(2),
    };
    let reach = MOTION_REACH / 2;
    let mut best = (f32::MIN, 0isize, 0isize);
    for dy in -reach..=reach {
        for dx in -reach..=reach {
            let score = ncc_at(&ha, &hb, hm, dx, dy, reach);
            if score > best.0 {
                best = (score, dx, dy);
            }
        }
    }
    let (cx, cy) = (2 * best.1, 2 * best.2);
    let mut scores = [[0f32; 3]; 3];
    let mut top = (f32::MIN, cx, cy);
    for (j, row) in scores.iter_mut().enumerate() {
        for (i, slot) in row.iter_mut().enumerate() {
            let (dx, dy) = (cx + i as isize - 1, cy + j as isize - 1);
            *slot = ncc_at(a, b, masked, dx, dy, MOTION_REACH + 1);
            if *slot > top.0 {
                top = (*slot, dx, dy);
            }
        }
    }
    // A parabola through the best and its neighbours (when the best is the middle).
    let peak = |l: f32, m: f32, r: f32| {
        let d = l - 2.0 * m + r;
        if d.abs() < 1e-9 {
            0.0
        } else {
            (0.5 * (l - r) / d).clamp(-0.5, 0.5)
        }
    };
    if top.1 == cx && top.2 == cy {
        let [[_, u, _], [l, m, r], [_, d, _]] = scores;
        (cx as f32 + peak(l, m, r), cy as f32 + peak(u, m, d))
    } else {
        (top.1 as f32, top.2 as f32)
    }
}

/// A search score the mark's place and opacity can be trusted at (it's faint over brights: weaker frames take their neighbours').
const STRONG: f32 = 0.25;
/// Frames either side a frame's place is worked out from.
const WINDOW: usize = 12;

/// The lab's track2 clean-up, trusting the frames where the mark is plain: stretches split where it jumps (between
/// strong frames), each frame's position from a line through its stretch's strong frames ±12 (it may drift), its
/// opacity their median; frames with no strong neighbour take what weaker ones say, and none where it isn't.
pub(crate) fn smooth(spots: &[Spot], opacities: &[Option<f32>]) -> Vec<Place> {
    let n = spots.len();
    let score = |i: usize| spots.get(i).map_or(0.0, |s| s.score);
    let strong: Vec<usize> = (0..n).filter(|&i| score(i) > STRONG).collect();
    // Stretches between jumps, from the strong frames; every frame in the stretch of its nearest strong frame.
    let mut stretch_of_strong: Vec<usize> = Vec::with_capacity(strong.len());
    let mut id = 0;
    for (k, &i) in strong.iter().enumerate() {
        if k > 0 {
            if let (Some(a), Some(b)) =
                (strong.get(k - 1).and_then(|&j| spots.get(j)), spots.get(i))
            {
                if (a.x - b.x).hypot(a.y - b.y)
                    > 15.0 + 3.0 * (i - strong.get(k - 1).copied().unwrap_or(i)) as f32
                {
                    id += 1;
                }
            }
        }
        stretch_of_strong.push(id);
    }
    let nearest_strong = |i: usize| -> Option<usize> {
        let at = strong.partition_point(|&j| j < i);
        let after = strong.get(at).map(|&j| (j - i, at));
        let before = at
            .checked_sub(1)
            .and_then(|k| strong.get(k).map(|&j| (i - j, k)));
        match (before, after) {
            (Some(b), Some(a)) => Some(if a.0 < b.0 { a.1 } else { b.1 }),
            (Some(b), None) => Some(b.1),
            (None, Some(a)) => Some(a.1),
            (None, None) => None,
        }
    };
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let own = spots.get(i).copied().unwrap_or(Spot {
            x: 0.0,
            y: 0.0,
            score: 0.0,
        });
        let stretch = nearest_strong(i).and_then(|k| stretch_of_strong.get(k).copied());
        let near: Vec<usize> = strong
            .iter()
            .enumerate()
            .filter(|&(k, &j)| {
                j.abs_diff(i) <= WINDOW && stretch_of_strong.get(k).copied() == stretch
            })
            .map(|(_, &j)| j)
            .collect();
        let (x, y) = if near.len() >= 3 {
            (
                fitted(&near, i, 2.0, |j| spots.get(j).map_or(0.0, |s| s.x)),
                fitted(&near, i, 2.0, |j| spots.get(j).map_or(0.0, |s| s.y)),
            )
        } else if let Some(&j) = near.first() {
            spots.get(j).map_or((own.x, own.y), |s| (s.x, s.y))
        } else if let Some(s) = nearest_strong(i)
            .and_then(|k| strong.get(k))
            .and_then(|&j| spots.get(j))
        {
            if own.score > PRESENT && (own.x - s.x).hypot(own.y - s.y) > 15.0 {
                (own.x, own.y)
            } else {
                (s.x, s.y)
            }
        } else {
            (own.x, own.y)
        };
        // A median of at least three fits (one or two near the brights' limit are noise).
        let opacity_of = |frames: &[usize]| {
            let values: Vec<f32> = frames
                .iter()
                .filter_map(|&j| opacities.get(j).copied().flatten())
                .collect();
            if values.len() >= 3 {
                median(values)
            } else {
                None
            }
        };
        let gap = score(i) <= PRESENT
            && !(near.iter().any(|&j| j < i && i - j <= 4)
                && near.iter().any(|&j| j > i && j - i <= 4));
        // What the frames of this stretch said, all of them (for frames where nearer ones can't tell).
        let stretch_opacity = || {
            let all: Vec<usize> = strong
                .iter()
                .enumerate()
                .filter(|&(k, _)| stretch_of_strong.get(k).copied() == stretch)
                .map(|(_, &j)| j)
                .collect();
            opacity_of(&all)
        };
        let c = if gap {
            // Not found here and not a lone miss between frames where it is: it isn't there.
            0.0
        } else if near.is_empty() {
            // No strong frame near: weaker ones that are there, else the stretch's (it's faint here, over brights).
            let weak: Vec<usize> = (i.saturating_sub(4)..(i + 5).min(n))
                .filter(|&j| score(j) > PRESENT)
                .collect();
            if score(i) > PRESENT {
                opacity_of(&weak).or_else(stretch_opacity).unwrap_or(1.0)
            } else {
                0.0
            }
        } else {
            // A line through the window's fits (each frame's fit wobbles a few percent; a fade is a slope), then the stretch's.
            let fits: Vec<usize> = near
                .iter()
                .copied()
                .filter(|&j| opacities.get(j).copied().flatten().is_some())
                .collect();
            let value = |j: usize| opacities.get(j).copied().flatten().unwrap_or(0.0);
            // A fade shows as the close fits (±4) spreading: their line, never past what they say. Else the
            // window's median (steadier for a mark that doesn't change; a few fits where it starts to show read high).
            let close: Vec<usize> = fits
                .iter()
                .copied()
                .filter(|&j| j.abs_diff(i) <= 4)
                .collect();
            let lo = close
                .iter()
                .map(|&j| value(j))
                .fold(f32::INFINITY, f32::min);
            let hi = close
                .iter()
                .map(|&j| value(j))
                .fold(f32::NEG_INFINITY, f32::max);
            let fading = close.len() >= 3 && hi - lo > 0.15;
            (fits.len() >= 3)
                .then(|| {
                    if fading {
                        fitted(&close, i, 0.1, value).clamp(lo, hi)
                    } else {
                        median(fits.iter().map(|&j| value(j)).collect()).unwrap_or(1.0)
                    }
                })
                .or_else(stretch_opacity)
                .unwrap_or(1.0)
        };
        out.push(Place {
            x,
            y,
            c: c.clamp(0.0, 1.3),
        });
    }
    out
}

/// `value` at frame `at` from a least-squares line through `frames` (residuals over `tolerance` dropped once).
fn fitted(frames: &[usize], at: usize, tolerance: f32, value: impl Fn(usize) -> f32) -> f32 {
    let line = |use_: &[usize]| -> (f32, f32) {
        let n = use_.len().max(1) as f32;
        let tm = use_.iter().map(|&j| j as f32).sum::<f32>() / n;
        let vm = use_.iter().map(|&j| value(j)).sum::<f32>() / n;
        let (stv, stt) = use_.iter().fold((0.0, 0.0), |(a, b), &j| {
            (
                a + (j as f32 - tm) * (value(j) - vm),
                b + (j as f32 - tm).powi(2),
            )
        });
        let slope = if stt > 1e-6 { stv / stt } else { 0.0 };
        (slope, vm - slope * tm)
    };
    let (slope, intercept) = line(frames);
    let kept: Vec<usize> = frames
        .iter()
        .copied()
        .filter(|&j| (value(j) - (slope * j as f32 + intercept)).abs() <= tolerance)
        .collect();
    let (slope, intercept) = if kept.len() >= 3 {
        line(&kept)
    } else {
        (slope, intercept)
    };
    slope * at as f32 + intercept
}

/// The box (full-size pixels) the mark's pixels touch in a frame placed at `place`, grown by `by`.
fn touched(
    matte_box: (usize, usize, usize, usize),
    place: Place,
    by: usize,
    fw: usize,
    fh: usize,
) -> Option<Rect> {
    if place.c <= 0.0 {
        return None;
    }
    let (mx0, my0, mx1, my1) = matte_box;
    let x0 = (place.x + mx0 as f32).floor() as isize - by as isize;
    let y0 = (place.y + my0 as f32).floor() as isize - by as isize;
    let x1 = (place.x + mx1 as f32).ceil() as isize + by as isize;
    let y1 = (place.y + my1 as f32).ceil() as isize + by as isize;
    let clamp = |v: isize, n: usize| v.clamp(0, n as isize) as usize;
    let rect = Rect {
        x0: clamp(x0, fw) & !1,
        y0: clamp(y0, fh) & !1,
        x1: ((clamp(x1, fw) + 1) & !1).min(fw & !1),
        y1: ((clamp(y1, fh) + 1) & !1).min(fh & !1),
    };
    (rect.x1 > rect.x0 && rect.y1 > rect.y0).then_some(rect)
}

/// One frame held while it's needed.
#[derive(Default)]
struct Slot {
    picture: Picture,
    prep: Prep,
    first: Option<Picture>,
    holes: Option<Mask>,
    second_bad: Option<Mask>,
    flows: Option<Flows>,
    weight: Option<Plane>,
}

fn wait_for_foreground() {
    while crate::media::exporting() || crate::util::playing() {
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

/// Takes the mark out of `source`'s seconds [from, to): the strip written to `out` (an mp4: the restored box over its
/// alpha), never touching `keep` (shares: the camera's stamp). None when the mark isn't in that stretch.
#[allow(clippy::too_many_arguments)]
pub fn remove(
    source: &Path,
    footage: Footage,
    from: f64,
    to: f64,
    model: &Model,
    keep: &[Shares],
    out: &Path,
    progress: &dyn Fn(f64),
) -> Result<Option<Removed>, String> {
    let started = Instant::now();
    let (fw, fh) = (footage.width as usize & !1, footage.height as usize & !1);
    let fps = if footage.fps > 1.0 { footage.fps } else { 30.0 };
    if fw < 64 || fh < 64 || to <= from {
        return Err("nothing to take the watermark out of".to_owned());
    }
    let curve = Curve {
        gamma: model.gamma,
        white: model.white,
    };
    let (matte, at) = model.for_size(footage.width, footage.height)?;
    let steps: Vec<i32> = {
        let mut seen = Vec::new();
        for &s in &STEPS {
            let scaled = ((s as f64) * fps / 23.976).round() as i32;
            let scaled = if scaled == 0 { s.signum() } else { scaled };
            if !seen.contains(&scaled) {
                seen.push(scaled);
            }
        }
        seen
    };
    let reach = steps
        .iter()
        .map(|s| s.unsigned_abs() as usize)
        .max()
        .unwrap_or(80);
    let context = (reach + 2) as f64 / fps;
    let start = (from - context).max(0.0);
    let seconds = to + context - start;
    // 1. The mark in every frame.
    let Some(matte_box) = matte.mask(|a| a > 0.003).bounds() else {
        return Ok(None);
    };
    let mut tracker = Tracker::new(&matte, at, curve, fw, fh);
    let mut motion = Motion::default();
    let mut decoder = Decoder::open(
        source,
        start,
        Some(seconds),
        &format!("crop={fw}:{fh}:0:0,format=gray"),
        "gray",
        fw * fh,
        false,
    )?;
    let mut grey = vec![0u8; fw * fh];
    let expected = (seconds * fps).max(1.0);
    let mut count = 0usize;
    while decoder.next(&mut grey)? {
        tracker.add(&grey);
        let now = tracker.current();
        let mark = touched(
            matte_box,
            Place {
                x: now.0,
                y: now.1,
                c: 1.0,
            },
            0,
            fw,
            fh,
        )
        .unwrap_or(Rect {
            x0: 0,
            y0: 0,
            x1: 2,
            y1: 2,
        });
        motion.add(
            &Frame {
                y: &grey,
                w: fw,
                h: fh,
            },
            mark,
        );
        count += 1;
        if count.is_multiple_of(48) {
            progress(0.15 * (count as f64 / expected).min(1.0));
            wait_for_foreground();
        }
    }
    decoder.finish()?;
    let places = tracker.places();
    let n = places.len();
    let k0 = (((from - start) * fps).round() as usize).min(n);
    let k1 = (((to - start) * fps).round() as usize).min(n);
    if k1 <= k0 {
        return Ok(None);
    }
    let marked = places
        .get(k0..k1)
        .map_or(0, |p| p.iter().filter(|p| p.c > 0.0).count());
    if marked == 0 {
        return Ok(None);
    }
    let path = motion.path;
    let shift_of = |t: usize, j: usize| -> (isize, isize) {
        match (path.get(t), path.get(j)) {
            (Some(a), Some(b)) => ((b.0 - a.0).round() as isize, (b.1 - a.1).round() as isize),
            _ => (0, 0),
        }
    };
    // The first pass over the piece only (its handles feed it; a short piece needn't restore seconds round it twice).
    let pass1 = (k0, k1);
    // The strip's box and the work box (what's read in colour).
    let mut strip: Option<Rect> = None;
    for place in places.get(k0..k1).unwrap_or(&[]) {
        if let Some(r) = touched(matte_box, *place, 3 + 5 + 16, fw, fh) {
            strip = Some(strip.map_or(r, |s| s.union(r)));
        }
    }
    let Some(strip) = strip else {
        return Ok(None);
    };
    // The work box: every restored frame's flow box, and where each of its neighbours' scene moved it to.
    let mut work_rect = strip;
    for k in pass1.0.saturating_sub(reach)..(pass1.1 + reach).min(n) {
        let Some(r) = places
            .get(k)
            .and_then(|place| touched(matte_box, *place, 3 + PAD + 2 + FLOW_MARGIN, fw, fh))
        else {
            continue;
        };
        work_rect = work_rect.union(r);
        if k < pass1.0 || k >= pass1.1 {
            continue;
        }
        for &step in &steps {
            let j = k as i64 + i64::from(step);
            if j < 0 || j as usize >= n {
                continue;
            }
            let (dx, dy) = shift_of(k, j as usize);
            let clamp = |v: isize, n: usize| v.clamp(0, n as isize) as usize;
            let moved = Rect {
                x0: clamp(r.x0 as isize + dx, fw) & !1,
                y0: clamp(r.y0 as isize + dy, fh) & !1,
                x1: clamp(r.x1 as isize + dx, fw) & !1,
                y1: clamp(r.y1 as isize + dy, fh) & !1,
            };
            if moved.x1 > moved.x0 && moved.y1 > moved.y0 {
                work_rect = work_rect.union(moved);
            }
        }
    }
    let work = Work {
        x: work_rect.x0,
        y: work_rect.y0,
        w: work_rect.w(),
        h: work_rect.h(),
        frame_w: fw,
        frame_h: fh,
    };
    let strip_local = Rect {
        x0: strip.x0 - work.x,
        y0: strip.y0 - work.y,
        x1: strip.x1 - work.x,
        y1: strip.y1 - work.y,
    };
    // The camera's stamp, in work-box pixels: never changed.
    let kept: Vec<Rect> = keep
        .iter()
        .filter_map(|&[x0, y0, x1, y1]| {
            let px = |v: f64, n: usize| (v.clamp(0.0, 1.0) * n as f64).round() as isize;
            let r = (
                px(x0, fw) - work.x as isize,
                px(y0, fh) - work.y as isize,
                px(x1, fw) - work.x as isize,
                px(y1, fh) - work.y as isize,
            );
            let clamp = |v: isize, n: usize| v.clamp(0, n as isize) as usize;
            let rect = Rect {
                x0: clamp(r.0, work.w),
                y0: clamp(r.1, work.h),
                x1: clamp(r.2, work.w),
                y1: clamp(r.3, work.h),
            };
            (rect.x1 > rect.x0 && rect.y1 > rect.y0).then_some(rect)
        })
        .collect();
    // 2. The restore, block by block.
    let partial: PathBuf = crate::util::partial(out, "mp4");
    let mut encoder = Encoder::open(&partial, strip.w(), strip.h() * 2, fps)?;
    let filters = format!(
        "crop={}:{}:{}:{},format=yuv420p",
        work.w, work.h, work.x, work.y
    );
    let mut decoder = Decoder::open(
        source,
        start,
        Some(seconds),
        &filters,
        "yuv420p",
        work.w * work.h * 3 / 2,
        false,
    )?;
    let threads = std::thread::available_parallelism()
        .map_or(2, std::num::NonZeroUsize::get)
        .clamp(1, 16);
    let mut slots: Vec<Option<Slot>> = (0..n).map(|_| None).collect();
    let mut decoded = 0usize;
    let (cw, ch) = (work.w / 2, work.h / 2);
    let ysize = work.w * work.h;
    let mut buffer = vec![0u8; ysize + 2 * cw * ch];
    let (mut next1, mut next2) = (pass1.0, k0);
    let (mut mark_px, mut filled_px) = (0usize, 0usize);
    let checker = Template::new(&matte);
    let (mut before, mut after) = (Vec::new(), Vec::new());
    let neighbours_of = |k: usize| -> Vec<(i32, usize, (isize, isize))> {
        steps
            .iter()
            .filter_map(|&s| {
                let j = k as i64 + i64::from(s);
                (j >= 0 && (j as usize) < n).then(|| (s, j as usize, shift_of(k, j as usize)))
            })
            .collect()
    };
    let mut ended = false;
    while next2 < k1 {
        wait_for_foreground();
        // Frames read as far as the next block's neighbours reach.
        let want = (next1 + BLOCK + reach).min(n);
        let mut fresh: Vec<(usize, Picture)> = Vec::new();
        while decoded < want && !ended {
            if !decoder.next(&mut buffer)? {
                ended = true;
                break;
            }
            let picture = Picture {
                y: buffer.get(..ysize).map(<[u8]>::to_vec).unwrap_or_default(),
                u: buffer
                    .get(ysize..ysize + cw * ch)
                    .map(<[u8]>::to_vec)
                    .unwrap_or_default(),
                v: buffer
                    .get(ysize + cw * ch..)
                    .map(<[u8]>::to_vec)
                    .unwrap_or_default(),
            };
            fresh.push((decoded, picture));
            decoded += 1;
        }
        // A second read shorter than the first: what it gave is all there is.
        let last1 = if ended { pass1.1.min(decoded) } else { pass1.1 };
        let last2 = if ended { k1.min(decoded) } else { k1 };
        // Each new frame's prep, side by side.
        let prepared: Vec<(usize, Picture, Prep)> = parallel(threads, fresh, |(k, picture)| {
            // The matte placed over its own box and a margin wider than the region's padding (zeros at its edges).
            let alpha = places.get(k).filter(|p| p.c > 0.0).map(|p| {
                let (lx, ly) = (p.x - work.x as f32, p.y - work.y as f32);
                let margin = (PAD + 12) as f32;
                let ox = (lx - margin).floor().max(0.0) as usize;
                let oy = (ly - margin).floor().max(0.0) as usize;
                let ww = ((lx + matte.w as f32 + margin).ceil().max(0.0) as usize)
                    .min(work.w)
                    .saturating_sub(ox);
                let wh = ((ly + matte.h as f32 + margin).ceil().max(0.0) as usize)
                    .min(work.h)
                    .saturating_sub(oy);
                (placed(&matte, (lx, ly), p.c, (ox, oy, ww, wh)), ox, oy)
            });
            let prepared = prep(
                &picture,
                work,
                alpha.as_ref().map(|(a, x, y)| (a, *x, *y)),
                curve,
            );
            (k, picture, prepared)
        });
        for (k, picture, prepared) in prepared {
            if let Some(slot) = slots.get_mut(k) {
                *slot = Some(Slot {
                    picture,
                    prep: prepared,
                    ..Slot::default()
                });
            }
        }
        // Pass 1 for the next block.
        let end1 = (next1 + BLOCK).min(last1).min(decoded);
        if end1 > next1 {
            let block: Vec<usize> = (next1..end1).collect();
            let results: Vec<(usize, Option<Restored>, Flows)> = parallel(threads, block, |k| {
                let Some(own) = slots.get(k).and_then(Option::as_ref) else {
                    return (k, None, Flows::default());
                };
                let neighbours: Vec<Neighbour> = neighbours_of(k)
                    .into_iter()
                    .filter_map(|(step, j, shift)| {
                        slots.get(j).and_then(Option::as_ref).map(|slot| Neighbour {
                            step,
                            shift,
                            prep: &slot.prep,
                            source: &slot.picture,
                            bad: &slot.prep.bad,
                        })
                    })
                    .collect();
                let mut flows = Flows::default();
                let restored = restore(
                    &own.prep,
                    &own.picture,
                    &neighbours,
                    &mut flows,
                    None,
                    work,
                    curve,
                );
                (k, restored, flows)
            });
            for (k, restored, flows) in results {
                let Some(Some(slot)) = slots.get_mut(k) else {
                    continue;
                };
                let mut first = slot.picture.clone();
                if let (Some(restored), Some(region)) = (&restored, slot.prep.region) {
                    paste(&mut first, restored, region, work);
                    let holes = Mask {
                        w: region.w(),
                        h: region.h(),
                        data: slot
                            .prep
                            .reg
                            .data
                            .iter()
                            .zip(&restored.valid.data)
                            .map(|(&r, &v)| r && !v)
                            .collect(),
                    };
                    if holes.any() {
                        slot.second_bad = Some(holes.dilate(5));
                        slot.holes = Some(holes);
                        slot.flows = Some(flows);
                    } else {
                        slot.second_bad = Some(Mask::new(region.w(), region.h()));
                    }
                    slot.weight = Some(restored.weight.clone());
                }
                slot.first = Some(first);
            }
            next1 = end1;
        }
        // Pass 2 (and the strip) for frames whose neighbours all have their first pass.
        let end2 = if next1 >= last1 {
            last2
        } else {
            last2.min(next1.saturating_sub(reach))
        };
        if ended && end1 <= next1 && end2 <= next2 && next1 >= last1 {
            break;
        }
        if end2 > next2 {
            let block: Vec<usize> = (next2..end2).collect();
            let results: Vec<(usize, Option<Restored>)> = parallel(threads, block, |k| {
                let Some(own) = slots.get(k).and_then(Option::as_ref) else {
                    return (k, None);
                };
                let (Some(holes), Some(first)) = (&own.holes, &own.first) else {
                    return (k, None);
                };
                let neighbours: Vec<Neighbour> = neighbours_of(k)
                    .into_iter()
                    .filter_map(|(step, j, shift)| {
                        let slot = slots.get(j).and_then(Option::as_ref)?;
                        let (Some(first), Some(bad)) = (&slot.first, &slot.second_bad) else {
                            return None;
                        };
                        Some(Neighbour {
                            step,
                            shift,
                            prep: &slot.prep,
                            source: first,
                            bad,
                        })
                    })
                    .collect();
                let mut flows = Flows::default();
                // The first pass's flows (moved out would need a lock; they're cloned per frame with holes only).
                if let Some(kept) = &own.flows {
                    flows.pairs = kept.pairs.clone();
                }
                (
                    k,
                    restore(
                        &own.prep,
                        first,
                        &neighbours,
                        &mut flows,
                        Some(holes),
                        work,
                        curve,
                    ),
                )
            });
            for (k, second) in results {
                let Some(Some(slot)) = slots.get(k) else {
                    continue;
                };
                let mut finished = slot.first.clone().unwrap_or_else(|| slot.picture.clone());
                let mut weight = slot.weight.clone();
                if let (Some(second), Some(region)) = (&second, slot.prep.region) {
                    paste(&mut finished, second, region, work);
                    weight =
                        weight.map(|w1| w1.zip(&second.weight, |a, b| 1.0 - (1.0 - a) * (1.0 - b)));
                    // What no neighbour could give is the inverse alone, which leaves the letters' outlines: thin
                    // leftovers (within 4 px of a filled pixel) are filled smoothly from round them; a wide one keeps
                    // the inverse (smoothing it over would be the plastic look).
                    if let Some(holes) = &slot.holes {
                        let left = Mask {
                            w: holes.w,
                            h: holes.h,
                            data: holes
                                .data
                                .iter()
                                .zip(&second.valid.data)
                                .map(|(&h, &v)| h && !v)
                                .collect(),
                        };
                        let thin = super::find::distance(&left).mask(|d| d > 0.0 && d <= 4.0);
                        if thin.any() {
                            inpaint(&mut finished, &thin, region, work);
                        }
                    }
                }
                if let Some(region) = slot.prep.region {
                    let reg = &slot.prep.reg;
                    mark_px += reg.count();
                    let first_valid = slot
                        .holes
                        .as_ref()
                        .map_or(reg.count(), |h| reg.count() - h.count());
                    let second_valid = second.as_ref().map_or(0, |s| s.valid.count());
                    filled_px += first_valid + second_valid;
                    let _ = region;
                }
                if (k - k0).is_multiple_of(6) {
                    if let Some(place) = places.get(k).filter(|p| p.c > 0.0) {
                        let at = (place.x - work.x as f32, place.y - work.y as f32);
                        let score = |picture: &Picture| {
                            checker
                                .near(
                                    &Frame {
                                        y: &picture.y,
                                        w: work.w,
                                        h: work.h,
                                    },
                                    at,
                                    4.0,
                                )
                                .map_or(0.0, |s| s.score.max(0.0))
                        };
                        before.push(score(&slot.picture));
                        after.push(score(&finished));
                    }
                }
                let frame = strip_frame(
                    &slot.picture,
                    &finished,
                    weight.as_ref(),
                    slot.prep.region,
                    strip_local,
                    &kept,
                    work,
                );
                encoder.write(&frame)?;
            }
            next2 = end2;
            progress(0.15 + 0.85 * ((next2 - k0) as f64 / (k1 - k0).max(1) as f64));
        }
        // Frames no one needs any more.
        let keep_from = next2.saturating_sub(reach);
        for slot in slots.iter_mut().take(keep_from) {
            *slot = None;
        }
    }
    let _ = decoder.finish();
    encoder.finish()?;
    std::fs::rename(&partial, out).map_err(|error| format!("keeping the strip: {error}"))?;
    let share = |v: usize, n: usize| (v as f64 / n.max(1) as f64).clamp(0.0, 1.0);
    Ok(Some(Removed {
        region: [
            share(strip.x0, fw),
            share(strip.y0, fh),
            share(strip.x1, fw),
            share(strip.y1, fh),
        ],
        frames: (k1 - k0) as u32,
        marked: marked as u32,
        filled: if mark_px == 0 {
            1.0
        } else {
            filled_px as f32 / mark_px as f32
        },
        left: match (median(before), median(after)) {
            (Some(b), Some(a)) if b > 0.05 => (a / b).clamp(0.0, 1.0),
            _ => 0.0,
        },
        took: started.elapsed().as_secs_f64(),
    }))
}

/// Fills `holes` (over `region`) of a picture smoothly from the pixels round them, brightness and colour.
fn inpaint(picture: &mut Picture, holes: &Mask, region: Rect, work: Work) {
    let (rw, rh) = (region.w(), region.h());
    let y = Plane::from_window(
        &picture.y,
        work.w,
        work.h,
        region.x0 as isize,
        region.y0 as isize,
        rw,
        rh,
    );
    let filled = super::plane::harmonic_fill(&y, holes);
    let (hw, hh) = (rw / 2, rh / 2);
    let half = Mask {
        w: hw,
        h: hh,
        data: (0..hw * hh)
            .map(|i| holes.at((i % hw.max(1)) * 2, (i / hw.max(1)) * 2))
            .collect(),
    };
    let (cw, ch) = (work.w / 2, work.h / 2);
    let u = super::plane::harmonic_fill(
        &Plane::from_window(
            &picture.u,
            cw,
            ch,
            (region.x0 / 2) as isize,
            (region.y0 / 2) as isize,
            hw,
            hh,
        ),
        &half,
    );
    let v = super::plane::harmonic_fill(
        &Plane::from_window(
            &picture.v,
            cw,
            ch,
            (region.x0 / 2) as isize,
            (region.y0 / 2) as isize,
            hw,
            hh,
        ),
        &half,
    );
    for py in 0..rh {
        for px in 0..rw {
            if holes.at(px, py) {
                if let Some(slot) = picture
                    .y
                    .get_mut((region.y0 + py) * work.w + region.x0 + px)
                {
                    *slot = filled.at(px, py).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
    for py in 0..hh {
        for px in 0..hw {
            if half.at(px, py) {
                let at = (region.y0 / 2 + py) * cw + region.x0 / 2 + px;
                if let Some(slot) = picture.u.get_mut(at) {
                    *slot = u.at(px, py).round().clamp(0.0, 255.0) as u8;
                }
                if let Some(slot) = picture.v.get_mut(at) {
                    *slot = v.at(px, py).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

/// `work` over threads, results in order.
fn parallel<T: Send, R: Send>(
    threads: usize,
    items: Vec<T>,
    work: impl Fn(T) -> R + Sync,
) -> Vec<R> {
    if items.len() <= 1 || threads <= 1 {
        return items.into_iter().map(work).collect();
    }
    let chunk = items.len().div_ceil(threads);
    let mut groups: Vec<Vec<T>> = Vec::new();
    let mut items = items.into_iter();
    loop {
        let group: Vec<T> = items.by_ref().take(chunk).collect();
        if group.is_empty() {
            break;
        }
        groups.push(group);
    }
    let work = &work;
    std::thread::scope(|scope| {
        let handles: Vec<_> = groups
            .into_iter()
            .map(|group| {
                scope.spawn(move || {
                    crate::util::background_thread();
                    group.into_iter().map(work).collect::<Vec<R>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    })
}

/// The strip's frame: the restored box premultiplied over its alpha (`O` the original, `F` the restored:
/// colour `F − (1 − a)·O`), stacked, 4:2:0. The camera's stamp is see-through.
fn strip_frame(
    original: &Picture,
    finished: &Picture,
    weight: Option<&Plane>,
    region: Option<Rect>,
    strip: Rect,
    kept: &[Rect],
    work: Work,
) -> Vec<u8> {
    let (sw, sh) = (strip.w(), strip.h());
    let mut alpha = Plane::new(sw, sh, 0.0);
    if let (Some(weight), Some(region)) = (weight, region) {
        for y in 0..sh {
            for x in 0..sw {
                let (wx, wy) = (strip.x0 + x, strip.y0 + y);
                if wx >= region.x0 && wx < region.x1 && wy >= region.y0 && wy < region.y1 {
                    let a = weight.at(wx - region.x0, wy - region.y0);
                    alpha.set(x, y, if a > 0.002 { a } else { 0.0 });
                }
            }
        }
    }
    // A smooth ramp round what changed (x264 rings at a sharp alpha edge, 16-pixel blocks showing as dark dashes);
    // the colour below is written against it, so the picture is the same.
    let changed = alpha.mask(|a| a > 0.0).dilate(9);
    let ramp = changed.plane().gaussian(2.0);
    alpha = alpha.zip(&ramp, |a, r| a.max(r.clamp(0.0, 1.0)));
    for rect in kept {
        for y in rect.y0.max(strip.y0)..rect.y1.min(strip.y1) {
            for x in rect.x0.max(strip.x0)..rect.x1.min(strip.x1) {
                alpha.set(x - strip.x0, y - strip.y0, 0.0);
            }
        }
    }
    let mut out = vec![0u8; sw * sh * 2 * 3 / 2];
    let (cw, chs) = (work.w / 2, sw / 2);
    // Y: the colour over the alpha.
    for y in 0..sh {
        for x in 0..sw {
            let a = alpha.at(x, y);
            let at = (strip.y0 + y) * work.w + strip.x0 + x;
            let (o, f) = (
                f32::from(original.y.get(at).copied().unwrap_or(16)),
                f32::from(finished.y.get(at).copied().unwrap_or(16)),
            );
            let value = if a > 0.0 {
                16.0 + (f - 16.0) - (1.0 - a) * (o - 16.0)
            } else {
                16.0
            };
            if let Some(slot) = out.get_mut(y * sw + x) {
                *slot = value.round().clamp(0.0, 255.0) as u8;
            }
            if let Some(slot) = out.get_mut((sh + y) * sw + x) {
                *slot = (16.0 + 219.0 * a).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    let ysize = sw * sh * 2;
    let csize = chs * sh;
    for (plane, (orig, fin)) in [
        (0usize, (&original.u, &finished.u)),
        (1, (&original.v, &finished.v)),
    ] {
        let base = ysize + plane * csize;
        for y in 0..sh / 2 {
            for x in 0..chs {
                let a = 0.25
                    * (alpha.at(2 * x, 2 * y)
                        + alpha.at(2 * x + 1, 2 * y)
                        + alpha.at(2 * x, 2 * y + 1)
                        + alpha.at(2 * x + 1, 2 * y + 1));
                let at = (strip.y0 / 2 + y) * cw + strip.x0 / 2 + x;
                let (o, f) = (
                    f32::from(orig.get(at).copied().unwrap_or(128)),
                    f32::from(fin.get(at).copied().unwrap_or(128)),
                );
                let value = if a > 0.0 {
                    128.0 + (f - 128.0) - (1.0 - a) * (o - 128.0)
                } else {
                    128.0
                };
                if let Some(slot) = out.get_mut(base + y * chs + x) {
                    *slot = value.round().clamp(0.0, 255.0) as u8;
                }
                if let Some(slot) = out.get_mut(base + (sh / 2 + y) * chs + x) {
                    *slot = 128;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{letters_matte, scene};
    use super::*;

    /// The lab's synthetic path, small: a mark drifting, jumping, fading out and back in elsewhere; every frame's place found.
    #[test]
    fn follows_a_mark_that_drifts_jumps_and_fades() {
        let curve = Curve {
            gamma: 2.5,
            white: 0.72,
        };
        let matte = letters_matte(150, 40, 0.09);
        let (w, h) = (480, 270);
        let truth = |t: usize| -> (f32, f32, f32) {
            let t = t as f32;
            if t < 60.0 {
                (40.0 + 1.5 * t, 30.0 + 0.6 * t, 1.0)
            } else if t < 110.0 {
                (260.0 + 0.8 * (t - 60.0), 190.0 - 0.3 * (t - 60.0), 1.0)
            } else if t < 140.0 {
                (300.0, 175.0, 1.0 - (t - 110.0) / 30.0)
            } else if t < 150.0 {
                (300.0, 175.0, 0.0)
            } else if t < 170.0 {
                (60.0, 120.0, (t - 150.0) / 20.0)
            } else {
                (60.0 + 0.5 * (t - 170.0), 120.0, 1.0)
            }
        };
        let mut tracker = Tracker::new(&matte, [40.0, 30.0], curve, w, h);
        for t in 0..220 {
            let (x, y, c) = truth(t);
            let picture = scene(w, h, t);
            let a = placed(&matte, (x, y), c, (0, 0, w, h));
            let frame: Vec<u8> = picture
                .data
                .iter()
                .zip(&a.data)
                .map(|(&j, &av)| curve.mark(j, av).round().clamp(0.0, 255.0) as u8)
                .collect();
            tracker.add(&frame);
        }
        let places = tracker.places();
        let mut errors = Vec::new();
        for (t, place) in places.iter().enumerate() {
            let (x, y, c) = truth(t);
            if c >= 0.5 {
                // Just after a jump the track may take three frames to believe it.
                if (60..64).contains(&t) {
                    continue;
                }
                errors.push((place.x - x).hypot(place.y - y));
                assert!(
                    (place.c - c).abs() < 0.25,
                    "frame {t}: opacity {} for {c}",
                    place.c
                );
            }
            if c == 0.0 {
                assert!(place.c < 0.2, "frame {t}: opacity {} with no mark", place.c);
            }
        }
        errors.sort_unstable_by(f32::total_cmp);
        let median = errors.get(errors.len() / 2).copied().unwrap();
        let p95 = errors.get(errors.len() * 95 / 100).copied().unwrap();
        assert!(
            median < 0.4 && p95 < 1.5,
            "position error median {median} p95 {p95}"
        );
    }

    #[test]
    fn a_strip_frame_is_premultiplied_over_its_alpha_and_never_touches_the_stamp() {
        let work = Work {
            x: 0,
            y: 0,
            w: 8,
            h: 4,
            frame_w: 8,
            frame_h: 4,
        };
        let original = Picture {
            y: vec![100; 32],
            u: vec![120; 8],
            v: vec![130; 8],
        };
        let mut finished = original.clone();
        finished.y.fill(60);
        let region = Rect {
            x0: 0,
            y0: 0,
            x1: 8,
            y1: 4,
        };
        let weight = Plane::new(8, 4, 1.0);
        let strip = Rect {
            x0: 0,
            y0: 0,
            x1: 8,
            y1: 4,
        };
        let stamp = [Rect {
            x0: 6,
            y0: 0,
            x1: 8,
            y1: 4,
        }];
        let frame = strip_frame(
            &original,
            &finished,
            Some(&weight),
            Some(region),
            strip,
            &stamp,
            work,
        );
        assert_eq!(frame.len(), 8 * 8 * 3 / 2);
        assert_eq!(frame.first(), Some(&60));
        assert_eq!(frame.get(6), Some(&16), "the stamp's colour is none");
        assert_eq!(frame.get(4 * 8), Some(&235), "alpha 1 is white");
        assert_eq!(frame.get(4 * 8 + 6), Some(&16), "the stamp is see-through");
    }
}

/// Real footage, by hand (`EDIT_WATERMARK_SOURCE`: a file; `EDIT_WATERMARK_MODEL`: the model's JSON, learned from the
/// source when missing; `EDIT_WATERMARK_RANGE`: "from,to" seconds; `EDIT_WATERMARK_OUT`: the strip). Prints what it did.
#[cfg(test)]
mod real {
    use super::*;

    #[test]
    fn real_footage() {
        let Ok(source) = std::env::var("EDIT_WATERMARK_SOURCE") else {
            return;
        };
        let source = PathBuf::from(source);
        let probe = crate::media::probe(&source).unwrap();
        let model_path = PathBuf::from(std::env::var("EDIT_WATERMARK_MODEL").unwrap());
        let model: Model = if model_path.exists() {
            serde_json::from_slice(&std::fs::read(&model_path).unwrap()).unwrap()
        } else {
            let started = Instant::now();
            let model = super::super::learn(
                &source,
                (probe.width, probe.height),
                probe.duration,
                None,
                &[],
                &|_| {},
            )
            .unwrap();
            eprintln!("learned in {:.1} s: gamma {} white {} strength {} at {:?} matte {}x{} from {} frames", started.elapsed().as_secs_f64(), model.gamma, model.white, model.strength, model.at, model.matte_width, model.matte_height, model.frames);
            std::fs::write(&model_path, serde_json::to_vec(&model).unwrap()).unwrap();
            model
        };
        let Ok(range) = std::env::var("EDIT_WATERMARK_RANGE") else {
            return;
        };
        let (from, to) = range
            .split_once(',')
            .map(|(a, b)| (a.parse::<f64>().unwrap(), b.parse::<f64>().unwrap()))
            .unwrap();
        let out = PathBuf::from(std::env::var("EDIT_WATERMARK_OUT").unwrap());
        let keep: Vec<Shares> = std::env::var("EDIT_WATERMARK_KEEP")
            .ok()
            .map(|text| {
                text.split(';')
                    .map(|one| {
                        let v: Vec<f64> = one.split(',').map(|n| n.parse().unwrap()).collect();
                        [v[0], v[1], v[2], v[3]]
                    })
                    .collect()
            })
            .unwrap_or_default();
        let footage = Footage {
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
        };
        let removed = remove(&source, footage, from, to, &model, &keep, &out, &|_| {}).unwrap();
        eprintln!(
            "removed: {removed:?} ({:.2} s of work a second of footage)",
            removed.as_ref().map_or(0.0, |r| r.took / (to - from))
        );
    }
}
