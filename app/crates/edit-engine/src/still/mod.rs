//! Their captions out of a stretch filmed by a camera that doesn't move, with no model and no rented card.
//!
//! Behind a caption on a still camera is a picture the same camera shows at other moments. Each letter's pixels are
//! taken from the room's plate: each pixel's commonest value across the seconds of the video's files where no caption
//! covers it. The model invents that picture instead, and on interrogation rooms it doubled the notepad on the table
//! and melted hands in nearly every frame (Nov 23, the Hitman video). The answer is {"still": false, "why"} when the
//! stretch isn't a still shot, and the model takes it as before.
//!
//! Ported from finder/still.py (tuned frame by frame on the Hitman and Trooper videos, Nov 24) so it runs wherever
//! the engine does, a Mac included; the OpenCV calls it was tuned with are in `pixels`, bit for bit where it matters.
#![allow(clippy::indexing_slicing)] // see pixels.rs: per-pixel loops, in range by construction, a slip is caught

mod pixels;

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Stdio};

use serde::Deserialize;
use serde_json::{json, Value};

use pixels::{diff3, gray, hsv, luma, median, Gray, Img, Kernel, Mask, Px, Rgb};

const SMALL: (usize, usize) = (160, 90);
/// A frame of the same shot differs from another by less than this (median of 0-255, small picture): people move, the room doesn't.
const SAME_SHOT: f64 = 9.0;
/// Share of a frame's pixels (outside their captions) that must sit on the plate for it to count as that still shot.
const ON_PLATE: f64 = 0.6;
/// Most frames of a stretch that may miss the plate: a stretch with a cut in it goes to the model.
const OFF_PLATE: f64 = 0.08;
/// Frames kept either side of the one being written: for what covers them, and to take a spot from when someone's in it.
const REACH: usize = 60;
/// Frames each hidden pixel is voted on from: a pad or a hand passing through for a moment is outvoted by the room.
const SAMPLES: usize = 5;
/// Seconds either side of a stretch its own picture is read from.
const AROUND: f64 = 45.0;
/// Share of a stretch's hidden pixels that may be filled with no clear look at the spot (no frame nearby, not this
/// stretch's picture, not one the room's picture can trust): above it the stretch goes to the model, which paints that
/// spot convincingly where a still picture can only lay a smooth patch (Nov 24, Trooper 12:17-17:05).
const BLIND: f64 = 0.2;
const PAD: i64 = 14;
const SIBLING_SAMPLES: f64 = 800.0;
/// The strip's alpha is feathered at least this much (minimax_worker.py's FEATHER).
const FEATHER: usize = 5;
/// The longest one stretch may take, plate included: past it the still clean stops and the model takes the stretch.
pub const LONGEST: std::time::Duration = std::time::Duration::from_secs(20 * 60);
/// The plate cache's format: bumped whenever what goes into a plate changes (the npz ones of still.py were v9).
const PLATE_VERSION: u32 = 10;

/// A stretch to clean (found.ts `stillClean`): the model's request, plus where the file's boxes and the plates are.
#[derive(Clone, Debug, Deserialize)]
pub struct Job {
    pub input: String,
    #[serde(default)]
    pub input_args: Vec<String>,
    pub from: f64,
    pub fps: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "bt709")]
    pub matrix: String,
    /// Their words' boxes in source pixels, per frame.
    pub masks: Vec<Vec<Vec<f64>>>,
    /// Where the strip goes.
    pub out: String,
    /// The file's watermark strips under the stretch (none, or the model takes it).
    #[serde(default)]
    pub beneath: Vec<Value>,
    /// The file's boxes (found.ts's JSON).
    pub found: String,
    /// The folder plates are kept in, and the video's name there.
    pub plates: String,
    pub key: String,
    /// The video's other files the finder read: more of the room.
    #[serde(default)]
    pub also: Vec<Also>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Also {
    pub input: String,
    #[serde(default)]
    pub input_args: Vec<String>,
    pub found: String,
}

fn bt709() -> String {
    "bt709".to_owned()
}

/// One box of a file's finder: frames [first, last], its pixels, and what it is.
#[derive(Clone, Debug)]
struct Mark {
    first: f64,
    last: f64,
    x0: i64,
    y0: i64,
    x1: i64,
    y1: i64,
    kind: String,
}

#[derive(Clone, Debug, Default)]
struct Found {
    fps: Option<f64>,
    covered: Vec<(f64, f64)>,
    marks: Vec<Mark>,
}

fn read_found(path: &str) -> Result<Found, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("the file's boxes: {error}"))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("the file's boxes: {error}"))?;
    let number = |value: &Value| value.as_f64().unwrap_or(0.0);
    let fps = value
        .get("fps")
        .and_then(Value::as_f64)
        .filter(|&fps| fps != 0.0);
    let covered = value
        .get("covered")
        .and_then(Value::as_array)
        .map(|spans| {
            spans
                .iter()
                .filter_map(|span| {
                    let span = span.as_array()?;
                    Some((number(span.first()?), number(span.get(1)?)))
                })
                .collect()
        })
        .unwrap_or_default();
    let marks = value
        .get("masks")
        .and_then(Value::as_array)
        .ok_or("the file's boxes have no masks")?
        .iter()
        .filter_map(|mark| {
            let mark = mark.as_array()?;
            let at = |i: usize| mark.get(i).map(number).unwrap_or(0.0);
            Some(Mark {
                first: at(0),
                last: at(1),
                x0: at(2) as i64,
                y0: at(3) as i64,
                x1: at(4) as i64,
                y1: at(5) as i64,
                kind: mark.get(6)?.as_str()?.to_owned(),
            })
        })
        .collect();
    Ok(Found {
        fps,
        covered,
        marks,
    })
}

fn caps_of(found: &Found) -> Vec<&Mark> {
    found
        .marks
        .iter()
        .filter(|m| m.kind == "subtitle" || m.kind == "note")
        .collect()
}

/// Where a file's captions come up (most of them), or None with too few to tell.
fn place_of(caps: &[&Mark]) -> Option<[i64; 4]> {
    if caps.len() < 5 {
        return None;
    }
    let of = |pick: fn(&Mark) -> i64, q: f64| {
        let values: Vec<f64> = caps.iter().map(|m| pick(m) as f64).collect();
        pixels::percentile(&values, q) as i64
    };
    Some([
        of(|m| m.x0, 2.0),
        of(|m| m.y0, 2.0),
        of(|m| m.x1, 98.0),
        of(|m| m.y1, 98.0),
    ])
}

/// A Python slice bound into 0..=len.
fn py(value: i64, len: usize) -> usize {
    if value < 0 {
        (len as i64 + value).max(0) as usize
    } else {
        (value as usize).min(len)
    }
}

/// mask[y0:y1, x0:x1] = True, as Python reads those bounds.
fn fill_py(mask: &mut Mask, x0: i64, y0: i64, x1: i64, y1: i64) {
    let (w, h) = (mask.w, mask.h);
    mask.fill(py(x0, w), py(y0, h), py(x1, w), py(y1, h));
}

/// Python's round(): halves to even.
fn round(value: f64) -> i64 {
    value.round_ties_even() as i64
}

// ---------------------------------------------------------------------------
// FFmpeg

/// Raw RGB frames from an FFmpeg, at background priority.
struct Frames {
    child: crate::util::Watched,
    stdout: ChildStdout,
    w: usize,
    h: usize,
    buffer: Vec<u8>,
}

impl Frames {
    fn open(args: Vec<OsString>, w: usize, h: usize) -> Result<Self, String> {
        let mut command = crate::util::ffmpeg_command();
        crate::util::background_command(&mut command);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| format!("ffmpeg is not available ({error}); install FFmpeg"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg gave no output")?;
        Ok(Self {
            child: crate::util::Watched::new(child),
            stdout,
            w,
            h,
            buffer: vec![0; w * h * 3],
        })
    }

    /// read_frames: the whole picture at `w × h` through `filters`, `extra` before the input.
    fn whole(
        job_input: &str,
        input_args: &[String],
        w: usize,
        h: usize,
        filters: &str,
        extra: &[String],
    ) -> Result<Self, String> {
        let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error"]
            .iter()
            .map(OsString::from)
            .collect();
        args.extend(extra.iter().map(OsString::from));
        args.extend(input_args.iter().map(OsString::from));
        args.push("-i".into());
        args.push(job_input.into());
        for one in [
            "-an",
            "-vf",
            &format!("{filters}scale={w}:{h},format=rgb24"),
            "-fps_mode",
            "vfr",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ] {
            args.push(one.into());
        }
        Self::open(args, w, h)
    }

    /// worker.Frames: the band y0..y1 of a stretch's frames, in order, at the stretch's rate.
    fn band(job: &Job, frames: usize, w: usize, y0: usize, y1: usize) -> Result<Self, String> {
        let first = round(job.from * job.fps);
        let seek = ((first as f64 - 0.5) / job.fps).max(0.0);
        let mut args: Vec<OsString> = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-ss".into(),
            format!("{seek:.6}").into(),
        ];
        args.extend(job.input_args.iter().map(OsString::from));
        args.push("-i".into());
        args.push(job.input.clone().into());
        let filters = format!(
            "setpts=PTS-STARTPTS,fps={:.6},crop={w}:{}:0:{y0},scale=in_color_matrix={}:in_range=tv,format=rgb24",
            job.fps,
            y1 - y0,
            job.matrix
        );
        for one in [
            "-an",
            "-frames:v",
            &frames.to_string(),
            "-vf",
            &filters,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ] {
            args.push(one.into());
        }
        Self::open(args, w, y1 - y0)
    }

    fn next(&mut self) -> Result<Option<Rgb>, String> {
        match self.stdout.read_exact(&mut self.buffer) {
            Ok(()) => Ok(Some(Img {
                w: self.w,
                h: self.h,
                v: self.buffer.as_chunks::<3>().0.to_vec(),
            })),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
            Err(error) => Err(format!("reading the footage: {error}")),
        }
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        self.child.stop();
    }
}

/// worker.Strip: the stacked strip written as it goes (picture over alpha, premultiplied), x264 at CRF 14.
struct Strip {
    child: std::process::Child,
    stdin: Option<ChildStdin>,
    errors: Option<std::thread::JoinHandle<Vec<u8>>>,
    partial: PathBuf,
    out: PathBuf,
    w: usize,
    rows: usize,
}

impl Strip {
    fn open(out: &Path, w: usize, rows: usize, fps: f64) -> Result<Self, String> {
        let gop = round(fps / 2.0).max(1).to_string();
        let mut partial = out.as_os_str().to_owned();
        partial.push(".partial.mp4");
        let partial = PathBuf::from(partial);
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
            "rgb24",
            "-s",
            &format!("{w}x{}", rows * 2),
            "-r",
            &format!("{fps:.6}"),
            "-i",
            "-",
            "-vf",
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
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
        command.arg(&partial);
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
            partial,
            out: out.to_path_buf(),
            w,
            rows,
        })
    }

    /// One frame: see-through with nothing given, else the picture premultiplied over its alpha.
    fn write(&mut self, fill: Option<(&Rgb, &Img<f32>)>) -> Result<(), String> {
        let size = self.w * self.rows * 3;
        let mut bytes = vec![0u8; size * 2];
        if let Some((picture, alpha)) = fill {
            let (top, bottom) = bytes.split_at_mut(size);
            for (((px, &a), up), down) in picture
                .v
                .iter()
                .zip(&alpha.v)
                .zip(top.as_chunks_mut::<3>().0)
                .zip(bottom.as_chunks_mut::<3>().0)
            {
                for c in 0..3 {
                    up[c] = (f32::from(px[c]) * a + 0.5).clamp(0.0, 255.0) as u8;
                }
                let level = (a * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
                down.copy_from_slice(&[level; 3]);
            }
        }
        self.stdin
            .as_mut()
            .ok_or("the strip is closed")?
            .write_all(&bytes)
            .map_err(|error| format!("writing the strip: {error}"))
    }

    fn close(&mut self) -> Result<std::process::ExitStatus, String> {
        drop(self.stdin.take());
        self.child.wait().map_err(|error| error.to_string())
    }

    fn finish(mut self) -> Result<(), String> {
        let status = self.close()?;
        let errors = self
            .errors
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default();
        if !status.success() {
            let text = String::from_utf8_lossy(&errors);
            let last = text.lines().rev().find(|line| !line.trim().is_empty());
            return Err(format!(
                "FFmpeg couldn't write the strip{}",
                last.map(|line| format!(": {}", line.trim()))
                    .unwrap_or_default()
            ));
        }
        std::fs::rename(&self.partial, &self.out).map_err(|error| error.to_string())
    }

    /// Stopped with nothing kept: FFmpeg ends what it wrote, and both files go.
    fn abandon(mut self) {
        let _ = self.close();
        let _ = std::fs::remove_file(&self.out);
        let _ = std::fs::remove_file(&self.partial);
    }
}

impl Drop for Strip {
    fn drop(&mut self) {
        if self.stdin.is_some() {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_file(&self.partial);
        }
    }
}

// ---------------------------------------------------------------------------
// Plates

/// One camera angle's plate being counted: per pixel, how often each brightness (in 16 steps) is seen and their colours.
struct Shot {
    small: Rgb,
    w: usize,
    rows: usize,
    counts: Vec<u16>,
    sums: Vec<[u32; 3]>,
    seen: usize,
    /// Real frames of this shot with no caption in their place: the room with its grain, where the plate is an average.
    real: Vec<Rgb>,
}

impl Shot {
    fn new(small: Rgb, rows: usize, w: usize) -> Self {
        Self {
            small,
            w,
            rows,
            counts: vec![0; rows * w * 16],
            sums: vec![[0; 3]; rows * w * 16],
            seen: 0,
            real: Vec::new(),
        }
    }

    fn add(&mut self, band: &Rgb, skip: &Mask) {
        for (p, (px, &skipped)) in band.v.iter().zip(&skip.v).enumerate() {
            if skipped {
                continue;
            }
            let level =
                ((u32::from(px[0]) + u32::from(px[1]) + u32::from(px[2])) / 48).min(15) as usize;
            let slot = p * 16 + level;
            self.counts[slot] = self.counts[slot].wrapping_add(1);
            let sum = &mut self.sums[slot];
            for c in 0..3 {
                sum[c] = sum[c].wrapping_add(u32::from(px[c]));
            }
        }
        self.seen += 1;
    }

    fn best(&self, p: usize) -> usize {
        let counts = &self.counts[p * 16..p * 16 + 16];
        let mut best = 0;
        for (step, &count) in counts.iter().enumerate() {
            if count > counts[best] {
                best = step;
            }
        }
        best
    }

    fn plate(&self, close: bool) -> Rgb {
        let mut out = Img::filled(self.w, self.rows, [0u8; 3]);
        let mut never = Img::filled(self.w, self.rows, false);
        for p in 0..self.w * self.rows {
            let best = self.best(p);
            let n = u32::from(self.counts[p * 16 + best]);
            let sum = self.sums[p * 16 + best];
            out.v[p] = sum.map(|one| (one / n.max(1)).min(255) as u8);
            never.v[p] = n == 0;
        }
        if close && never.any() {
            pixels::telea(&mut out, &never, 5.0);
        }
        out
    }

    fn keep(&mut self, band: &Rgb) {
        self.real.push(band.clone());
        if self.real.len() >= 24 {
            self.real = std::mem::take(&mut self.real)
                .into_iter()
                .step_by(2)
                .collect();
        }
    }

    /// The kept frame nearest the plate: the fewest people out of their usual place.
    fn real_frame(&self, plate: &Rgb) -> Rgb {
        let off = |one: &Rgb| -> u64 {
            one.v
                .iter()
                .zip(&plate.v)
                .map(|(a, b)| diff3(*a, *b) as u64)
                .sum()
        };
        let mut best: Option<(&Rgb, u64)> = None;
        for one in &self.real {
            let score = off(one);
            if best.is_none_or(|(_, least)| score < least) {
                best = Some((one, score));
            }
        }
        best.map_or_else(|| plate.clone(), |(one, _)| one.clone())
    }

    /// How much of what each pixel showed was the plate's value (0-255): low where someone sat part of the time.
    fn sure(&self) -> Gray {
        let mut out = Img::filled(self.w, self.rows, 0u8);
        for p in 0..self.w * self.rows {
            let counts = &self.counts[p * 16..p * 16 + 16];
            let best = self.best(p);
            let mut near = u32::from(counts[best]);
            if best > 0 {
                near += u32::from(counts[best - 1]);
            }
            if best < 15 {
                near += u32::from(counts[best + 1]);
            }
            let looks: u32 = counts.iter().map(|&one| u32::from(one)).sum();
            // A spot seen only a few times between captions can't be trusted, however much those few agree.
            out.v[p] = if looks >= 5 {
                (255 * near / looks) as u8
            } else {
                0
            };
        }
        out
    }

    /// Each pixel seen at least twice.
    fn seen_twice(&self) -> Mask {
        let mut out = Img::filled(self.w, self.rows, false);
        for p in 0..self.w * self.rows {
            let looks: u32 = self.counts[p * 16..p * 16 + 16]
                .iter()
                .map(|&one| u32::from(one))
                .sum();
            out.v[p] = looks >= 2;
        }
        out
    }
}

/// A made plate: the shot's small picture, the room, how sure each pixel is, and its clearest real frame.
#[derive(Clone, Debug, PartialEq)]
struct Plated {
    small: Rgb,
    plate: Rgb,
    sure: Gray,
    real: Rgb,
}

/// A video's plates and the rows they cover.
type Plates = ((usize, usize), Vec<Plated>);

fn shrunk(frame: &Rgb) -> Rgb {
    pixels::shrink(frame, SMALL.0, SMALL.1)
}

/// The median of |a − b| over two small pictures.
fn small_median(a: &Rgb, b: &Rgb) -> f64 {
    let mut histogram = [0usize; 256];
    for (x, y) in a.v.iter().zip(&b.v) {
        for c in 0..3 {
            histogram[x[c].abs_diff(y[c]) as usize] += 1;
        }
    }
    let n: usize = histogram.iter().sum();
    if n == 0 {
        return f64::NAN;
    }
    let nth = |k: usize| -> f64 {
        let mut seen = 0;
        for (value, &count) in histogram.iter().enumerate() {
            seen += count;
            if seen > k {
                return value as f64;
            }
        }
        255.0
    };
    if n % 2 == 1 {
        nth(n / 2)
    } else {
        (nth(n / 2 - 1) + nth(n / 2)) / 2.0
    }
}

/// Most of a still room's pixels stay put whoever moves in it: the median difference, not the mean.
fn same_shot(a: &Rgb, b: &Rgb) -> bool {
    small_median(a, b) < SAME_SHOT
}

/// Whether a caption's plate or shadow is in its place in this frame, read or not: near-black there. A line the finder
/// missed would otherwise win the few looks that spot gets between captions and be laid back in as the room (Nov 24,
/// Trooper: one sentence over 17 minutes).
fn captioned(frame: &Rgb, place: [i64; 4]) -> bool {
    let [x0, y0, x1, y1] = place;
    let part = frame.crop(
        py(x0, frame.w),
        py(y0, frame.h),
        py(x1, frame.w),
        py(y1, frame.h),
    );
    if !part.v.is_empty() {
        let dark = part.v.iter().filter(|&&px| luma(px) < 40).count();
        if dark as f64 / part.v.len() as f64 >= 0.015 {
            return true;
        }
    }
    // White letters on a soft shadow (no black plate): their strokes (Nov 24, Hitman: an "OK so" the finder never boxed
    // was kept as a clear frame and laid back on the table at 19:58).
    let boxed = [x0 as f64, y0 as f64, x1 as f64, y1 as f64];
    letters(frame, &[boxed], 0.0, frame.h as f64 / 1080.0)
        .0
        .any()
}

/// The skip mask of a frame `here` of a file: its captions' boxes, grown.
fn skip_of(caps: &[&Mark], here: i64, y0: i64, rows: usize, w: usize) -> Mask {
    let mut skip = Img::filled(w, rows, false);
    for m in caps {
        if m.first - 6.0 <= here as f64 && here as f64 <= m.last + 6.0 {
            fill_py(
                &mut skip,
                (m.x0 - PAD).max(0),
                (m.y0 - y0 - PAD).max(0),
                m.x1 + PAD,
                (m.y1 - y0 + PAD).max(0),
            );
        }
    }
    skip
}

fn skip_place(skip: &mut Mask, place: [i64; 4], y0: i64) {
    fill_py(
        skip,
        (place[0] - PAD).max(0),
        (place[1] - y0 - PAD).max(0),
        place[2] + PAD,
        (place[3] - y0 + PAD).max(0),
    );
}

fn plate_path(job: &Job) -> PathBuf {
    let slug: String = job
        .key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(80)
        .collect();
    Path::new(&job.plates).join(format!("{slug}.v{PLATE_VERSION}.plate"))
}

fn save_plates(
    path: &Path,
    span: (usize, usize),
    w: usize,
    plated: &[Plated],
) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    for value in [
        PLATE_VERSION,
        span.0 as u32,
        span.1 as u32,
        w as u32,
        plated.len() as u32,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for one in plated {
        for picture in [&one.small, &one.plate, &one.real] {
            bytes.extend(picture.v.iter().flatten());
        }
        bytes.extend_from_slice(&one.sure.v);
    }
    crate::util::write_atomic(path, &bytes)
}

fn load_plates(path: &Path, w: usize) -> Option<Plates> {
    let bytes = std::fs::read(path).ok()?;
    let word = |i: usize| -> Option<usize> {
        let four: [u8; 4] = bytes.get(i * 4..i * 4 + 4)?.try_into().ok()?;
        Some(u32::from_le_bytes(four) as usize)
    };
    if word(0)? != PLATE_VERSION as usize || word(3)? != w {
        return None;
    }
    let (y0, y1, n) = (word(1)?, word(2)?, word(4)?);
    let rows = y1.checked_sub(y0)?;
    let mut at = 20;
    let mut take = |len: usize| -> Option<&[u8]> {
        let part = bytes.get(at..at + len)?;
        at += len;
        Some(part)
    };
    let rgb = |part: &[u8], w: usize, h: usize| Img {
        w,
        h,
        v: part.as_chunks::<3>().0.to_vec(),
    };
    let mut plated = Vec::new();
    for _ in 0..n {
        let small = rgb(take(SMALL.0 * SMALL.1 * 3)?, SMALL.0, SMALL.1);
        let plate = rgb(take(rows * w * 3)?, w, rows);
        let real = rgb(take(rows * w * 3)?, w, rows);
        let sure = Img {
            w,
            h: rows,
            v: take(rows * w)?.to_vec(),
        };
        plated.push(Plated {
            small,
            plate,
            sure,
            real,
        });
    }
    Some(((y0, y1), plated))
}

/// The video's shots and their plates, kept in `plates` (every stretch of every file of the video reads the same ones).
/// Only from seconds the finder read, each caption's box left out, so no caption of theirs can get into a plate.
fn build_plates(
    job: &Job,
    found: &Found,
    again: bool,
    stopped: Stop<'_>,
) -> Result<Option<Plates>, String> {
    let (w, h) = (job.width as usize, job.height as usize);
    let path = plate_path(job);
    // An empty one (too few looks when it was made) is made again: another file of the video may have them now.
    if !again {
        if let Some(kept) = load_plates(&path, w).filter(|(_, plated)| !plated.is_empty()) {
            return Ok(Some(kept));
        }
    }
    let mut files: Vec<(String, Vec<String>, Found)> =
        vec![(job.input.clone(), job.input_args.clone(), found.clone())];
    for other in job.also.iter().take(24) {
        if let Ok(read) = read_found(&other.found) {
            files.push((other.input.clone(), other.input_args.clone(), read));
        }
    }
    let all_caps: Vec<&Mark> = files.iter().flat_map(|(_, _, one)| caps_of(one)).collect();
    if all_caps.is_empty() {
        return Ok(None);
    }
    let y0 = (all_caps.iter().map(|m| m.y0).min().unwrap_or(0) - 40).max(0) as usize;
    let y1 = ((all_caps.iter().map(|m| m.y1).max().unwrap_or(0) + 40).max(0) as usize).min(h);
    let rows = y1.saturating_sub(y0);
    let mut shots: Vec<Shot> = Vec::new();
    for (input, input_args, one) in &files {
        let read = &one.covered;
        let fps = one.fps.unwrap_or(30.0);
        let caps = caps_of(one);
        let place = place_of(&caps);
        let seconds: f64 = read.iter().map(|(a, b)| b - a).sum();
        if seconds <= 0.0 {
            continue;
        }
        check(stopped)?;
        let rate = (SIBLING_SAMPLES / seconds).clamp(0.25, 2.0);
        let mut frames = Frames::whole(input, input_args, w, h, &format!("fps={rate:.4},"), &[])?;
        let mut at = 0usize;
        while let Some(frame) = frames.next()? {
            check(stopped)?;
            let t = at as f64 / rate;
            at += 1;
            if !read.iter().any(|&(a, b)| a + 0.2 <= t && t <= b - 0.2) {
                continue;
            }
            let here = round(t * fps);
            let mut skip = skip_of(&caps, here, y0 as i64, rows, w);
            let busy = place.is_some_and(|place| captioned(&frame, place));
            if let (true, Some(place)) = (busy, place) {
                skip_place(&mut skip, place, y0 as i64);
            }
            let clear = place.is_some()
                && !busy
                && !caps
                    .iter()
                    .any(|m| m.first - 6.0 <= here as f64 && here as f64 <= m.last + 6.0);
            let small = shrunk(&frame);
            let index = match shots.iter().position(|one| same_shot(&one.small, &small)) {
                Some(index) => index,
                None if shots.len() >= 6 => continue,
                None => {
                    shots.push(Shot::new(small, rows, w));
                    shots.len() - 1
                }
            };
            let band = frame.crop(0, y0, w, y1);
            let shot = &mut shots[index];
            shot.add(&band, &skip);
            if clear {
                shot.keep(&band);
            }
        }
    }
    let mut plated = Vec::new();
    for one in &shots {
        if one.seen >= 8 {
            let plate = one.plate(true);
            plated.push(Plated {
                small: one.small.clone(),
                sure: one.sure(),
                real: one.real_frame(&plate),
                plate,
            });
        }
    }
    std::fs::create_dir_all(&job.plates).map_err(|error| format!("the plates' folder: {error}"))?;
    save_plates(&path, (y0, y1), w, &plated)
        .map_err(|error| format!("keeping the plate: {error}"))?;
    Ok(Some(((y0, y1), plated)))
}

// ---------------------------------------------------------------------------
// Letters

/// worker.on_a_plate: whether the words in a box sit on a plate of one colour that's theirs too.
fn on_a_plate(frame: &Rgb, a: usize, b: usize, c: usize, d: usize, scale: f64) -> bool {
    let coarse = |px: Px| -> usize {
        usize::from(px[0] / 24) * 144 + usize::from(px[1] / 24) * 12 + usize::from(px[2] / 24)
    };
    let mut counts = vec![0usize; 1728];
    for y in c..d {
        for x in a..b {
            counts[coarse(frame.at(x, y))] += 1;
        }
    }
    let size = (b - a) * (d - c);
    let mut top = 0;
    for (i, &count) in counts.iter().enumerate() {
        if count > counts[top] {
            top = i;
        }
    }
    if (counts[top] as f64) < 0.3 * size as f64 {
        return false;
    }
    let ring = (14.0 * scale) as usize;
    let (aa, bb) = (a.saturating_sub(ring), (b + ring).min(frame.w));
    let (cc, dd) = (c.saturating_sub(ring), (d + ring).min(frame.h));
    let (mut outside, mut same) = (0usize, 0usize);
    for y in cc..dd {
        for x in aa..bb {
            if (a..b).contains(&x) && (c..d).contains(&y) {
                continue;
            }
            outside += 1;
            if coarse(frame.at(x, y)) == top {
                same += 1;
            }
        }
    }
    outside > 0 && (same as f64 / outside as f64) < 0.08
}

/// The caption's own pixels and what's near them: (mask, what no other frame should be read from). A caption's letters
/// are thin bright strokes, white or one bold colour, whatever is behind them; a hand, a sleeve or a yellow notepad in
/// its box isn't, and stays the frame's own (Nov 24, the Hitman video: a mask of whatever differed from the room took
/// the officer's hand and pad). A box with no letters in it this frame (a fade, a read a frame late) masks nothing, but
/// is not read from either.
fn letters(frame: &Rgb, boxes: &[[f64; 4]], y0: f64, scale: f64) -> (Mask, Mask) {
    let (rows, w) = (frame.h, frame.w);
    let mut out = Img::filled(w, rows, false);
    let mut cover = Img::filled(w, rows, false);
    for &[x0, by0, x1, by1] in boxes {
        let a = (x0.trunc() as i64 - 6).max(0);
        let b = (x1.trunc() as i64 + 6).min(w as i64);
        let c = ((by0 - y0).trunc() as i64 - 6).max(0);
        let d = ((by1 - y0).trunc() as i64 + 6).min(rows as i64);
        if b <= a || d <= c {
            continue;
        }
        let (a, b, c, d) = (a as usize, b as usize, c as usize, d as usize);
        let part = frame.crop(a, c, b, d);
        let grey = gray(&part);
        let size = part.v.len() as f64;
        // A caption on a plate of its own: the whole box goes. A black plate is nearly half the box at the darkest, which a
        // soft shadow round the letters isn't.
        let darkest = grey.v.iter().filter(|&&v| v < 40).count() as f64 / size;
        if on_a_plate(frame, a, b, c, d, scale) || darkest >= 0.45 {
            out.fill(a, c, b, d);
            cover.fill(a, c, b, d);
            continue;
        }
        let colours: Vec<(i16, u8, u8)> = part.v.iter().map(|&px| hsv(px)).collect();
        let side = (15.0 * scale) as usize | 1;
        let thin = pixels::tophat(&grey, &Kernel::ellipse(side, side));
        let mut core: Mask = Img {
            w: part.w,
            h: part.h,
            v: colours
                .iter()
                .zip(&thin.v)
                .map(|(&(_, sat, val), &thin)| val >= 200 && sat <= 45 && thin >= 35)
                .collect(),
        };
        let bold: Vec<bool> = colours
            .iter()
            .zip(&thin.v)
            .map(|(&(_, sat, val), &thin)| sat > 110 && val > 120 && thin >= 25)
            .collect();
        let bold_count = bold.iter().filter(|&&one| one).count();
        if bold_count as f64 / size >= 0.02 && (core.count() as f64 / size) < 0.02 {
            let mut counts = [0f32; 180];
            for (&(hue, _, _), &one) in colours.iter().zip(&bold) {
                if one {
                    counts[hue as usize % 180] += 1.0;
                }
            }
            let mut spread = [0f32; 180];
            for (i, slot) in spread.iter_mut().enumerate() {
                for shift in -10i32..=10 {
                    *slot += counts[(i as i32 - shift).rem_euclid(180) as usize];
                }
            }
            let top = spread.iter().copied().fold(f32::MIN, f32::max);
            let least = 0.2f32 * top;
            for ((slot, &(hue, _, _)), &one) in core.v.iter_mut().zip(&colours).zip(&bold) {
                if one && spread[hue as usize % 180] >= least {
                    *slot = true;
                }
            }
        }
        let two = Kernel::rect(2, 2);
        let core = pixels::dilate(&pixels::erode(&core, &two), &two);
        // Only groups of strokes the size of a word or a tall letter.
        let wide = Kernel::rect((21.0 * scale) as usize | 1, (5.0 * scale) as usize | 1);
        let joined = pixels::erode(&pixels::dilate(&core, &wide), &wide);
        let (count, parts, sizes) = pixels::parts(&joined);
        let mut word: Vec<bool> = sizes
            .iter()
            .map(|&(bw, bh)| {
                bh as f64 >= 10.0 * scale
                    && (bw as f64 >= 0.06 * (b - a) as f64 || bh as f64 >= 12.0 * scale)
            })
            .collect();
        // A caption's strokes stand on its dark shadow; the bright edge of a page or a cuff stands on the room.
        let labels = pixels::morph(&parts.map(|one| one as u16), &Kernel::rect(7, 7), true, 0);
        let mut around = vec![0usize; count];
        let mut dark = vec![0usize; count];
        for (k, &label) in labels.v.iter().enumerate() {
            if label > 0 && !core.v[k] {
                let label = label as usize;
                if label < count {
                    around[label] += 1;
                    if colours[k].2 < 110 {
                        dark[label] += 1;
                    }
                }
            }
        }
        for (label, one) in word.iter_mut().enumerate() {
            *one = *one && dark[label] as f64 >= 0.5 * around[label].max(1) as f64;
        }
        if let Some(first) = word.first_mut() {
            *first = false;
        }
        let core: Mask = core.zip(&parts, |one, label| one && word[label as usize]);
        if !core.any() {
            cover.fill(a, c, b, d);
            continue;
        }
        // Wide enough for the soft shadow, which reaches past the box; and no other frame is read from a little further
        // out still, or the rim of that frame's shadow is laid in as a faint line.
        let reach = (38.0 * scale) as usize;
        let tail = (22.0 * scale) as usize;
        let (aa, bb) = (a.saturating_sub(reach + tail), (b + reach + tail).min(w));
        let (cc, dd) = (c.saturating_sub(reach + tail), (d + reach + tail).min(rows));
        let mut canvas = Img::filled(bb - aa, dd - cc, false);
        // The black plate the letters sit on, however little of the box it fills: its corners stayed behind otherwise.
        let black: Mask = grey.map(|v| v < 40);
        let (blobs, blob, _) = pixels::parts(&black);
        let near = pixels::dilate(&core, &Kernel::rect(9, 9));
        let mut touching = vec![false; blobs];
        for k in 0..blob.v.len() {
            if near.v[k] && black.v[k] && blob.v[k] > 0 {
                touching[blob.v[k] as usize] = true;
            }
        }
        let laid = core.zip(&blob, |one, label| one || touching[label as usize]);
        canvas.paste(a - aa, c - cc, &laid);
        let grown = pixels::dilate(&canvas, &Kernel::ellipse(reach * 2 + 1, reach * 2 + 1));
        let beyond = pixels::dilate(&grown, &Kernel::ellipse(tail * 2 + 1, tail * 2 + 1));
        for y in 0..grown.h {
            for x in 0..grown.w {
                if grown.at(x, y) {
                    out.set(aa + x, cc + y, true);
                }
                if beyond.at(x, y) {
                    cover.set(aa + x, cc + y, true);
                }
            }
        }
    }
    (out, cover)
}

// ---------------------------------------------------------------------------
// The fill

/// The commonest picture of this stretch and the minute round it, captions left out, from the same shot: what's on the
/// table now (a card put down halfway through the video isn't on the whole video's plate, and a stretch with captions back
/// to back never shows it on its own). (picture, the pixels it saw).
#[allow(clippy::too_many_arguments)]
fn stretch_plate(
    job: &Job,
    total: usize,
    w: usize,
    h: usize,
    y0: usize,
    y1: usize,
    small: &Rgb,
    found: &Found,
    stopped: Stop<'_>,
) -> Result<(Rgb, Mask), String> {
    let fps = job.fps;
    let caps = caps_of(found);
    let place = place_of(&caps);
    let every = found.fps.unwrap_or(fps);
    let start = (job.from - AROUND).max(0.0);
    let end = job.from + total as f64 / fps + AROUND;
    let rate = fps.min(160.0 / (end - start).max(1.0));
    let rows = y1 - y0;
    let mut shot = Shot::new(Img::filled(0, 0, [0; 3]), rows, w);
    let mut frames = Frames::whole(
        &job.input,
        &job.input_args,
        w,
        h,
        &format!("fps={rate:.6},"),
        &["-ss".to_owned(), format!("{start:.3}")],
    )?;
    let mut at = 0usize;
    while let Some(frame) = frames.next()? {
        check(stopped)?;
        let t = start + at as f64 / rate;
        at += 1;
        if t > end {
            break;
        }
        if !same_shot(&shrunk(&frame), small) {
            continue;
        }
        let here = round(t * every);
        let mut skip = skip_of(&caps, here, y0 as i64, rows, w);
        if let Some(place) = place.filter(|&place| captioned(&frame, place)) {
            skip_place(&mut skip, place, y0 as i64);
        }
        shot.add(&frame.crop(0, y0, w, y1), &skip);
    }
    Ok((shot.plate(false), shot.seen_twice()))
}

/// What a stretch's frames lend: the frames themselves and, per frame, what of it is covered (no other frame reads there).
struct Window {
    frames: VecDeque<Rgb>,
    own: VecDeque<Mask>,
}

/// The pictures a fill reads, all on the stretch's rows: the room, this stretch's own (and where it saw), a clear real frame.
struct Pictures<'a> {
    plate: &'a Rgb,
    nearby: &'a Rgb,
    seen: &'a Mask,
    real: &'a Rgb,
    trust: &'a Mask,
    certain: &'a Mask,
}

/// What goes under the mask: each pixel voted on by the nearest frames with no caption on it, so a person stays as
/// they are and something that only passed through doesn't land there; failing that, this stretch's own picture, then
/// the room's where it can be trusted; what's left is closed from around it.
fn filled(
    frame: &Rgb,
    pictures: &Pictures<'_>,
    mask: &Mask,
    scale: f64,
    window: &Window,
    at: usize,
    blind: &mut [usize; 2],
) -> Rgb {
    let (w, rows) = (mask.w, mask.h);
    let plate = pictures.plate;
    let mut out = plate.clone();
    let (mut x_min, mut x_max, mut y_min, mut y_max) = (usize::MAX, 0, usize::MAX, 0);
    for y in 0..rows {
        for x in 0..w {
            if mask.at(x, y) {
                x_min = x_min.min(x);
                x_max = x_max.max(x);
                y_min = y_min.min(y);
                y_max = y_max.max(y);
            }
        }
    }
    if x_min == usize::MAX {
        return out;
    }
    let grow = ((8.0 * scale) as usize).max(3);
    let a = x_min.saturating_sub(grow + 8);
    let b = (x_max + grow + 9).min(w);
    let c = y_min.saturating_sub(grow + 8);
    let d = (y_max + grow + 9).min(rows);
    let (pw, ph) = (b - a, d - c);
    let index = |x: usize, y: usize| (c + y) * w + a + x;
    let want: Vec<bool> = (0..pw * ph)
        .map(|k| mask.v[index(k % pw, k / pw)])
        .collect();
    let mut patch: Vec<Px> = (0..pw * ph)
        .map(|k| plate.v[index(k % pw, k / pw)])
        .collect();
    let mut votes = vec![[[0u8; 3]; SAMPLES]; pw * ph];
    let mut count = vec![0u8; pw * ph];
    let n = window.frames.len() as isize;
    let mut busy = vec![false; pw * ph];
    for step in (3..=REACH).step_by(4) {
        for other in [at as isize - step as isize, at as isize + step as isize] {
            if !(0..n).contains(&other) {
                continue;
            }
            let other = other as usize;
            busy.fill(false);
            for near in other.saturating_sub(2)..(other + 3).min(window.own.len()) {
                let own = &window.own[near];
                for (k, slot) in busy.iter_mut().enumerate() {
                    *slot |= own.v[index(k % pw, k / pw)];
                }
            }
            let picture = &window.frames[other];
            for k in 0..pw * ph {
                if want[k] && !busy[k] && (count[k] as usize) < SAMPLES {
                    votes[k][count[k] as usize] = picture.v[index(k % pw, k / pw)];
                    count[k] += 1;
                }
            }
        }
        if (0..pw * ph).all(|k| !want[k] || count[k] as usize >= SAMPLES) {
            break;
        }
    }
    let known: Vec<bool> = (0..pw * ph)
        .map(|k| pictures.seen.v[index(k % pw, k / pw)])
        .collect();
    let at_of = |picture: &Rgb, k: usize| picture.v[index(k % pw, k / pw)];
    for k in 0..pw * ph {
        if want[k] && known[k] {
            patch[k] = at_of(pictures.nearby, k);
        }
    }
    // An average has no grain and shows as a smooth patch on carpet: a real frame's pixels wherever they agree with it.
    for k in 0..pw * ph {
        let sharp = at_of(pictures.real, k);
        if want[k] && !known[k] && diff3(sharp, patch[k]) < 60 {
            patch[k] = sharp;
        }
    }
    for k in 0..pw * ph {
        let many = count[k] as usize;
        // One or two frames are a poor vote: this stretch's own picture is better, where it saw the spot.
        if !want[k] || many == 0 || (many < 3 && known[k]) {
            continue;
        }
        let mut voted = [0u8; 3];
        for (c, slot) in voted.iter_mut().enumerate() {
            let mut values: Vec<u8> = votes[k][..many].iter().map(|px| px[c]).collect();
            values.sort_unstable();
            *slot = if many % 2 == 1 {
                values[many / 2]
            } else {
                ((u16::from(values[many / 2 - 1]) + u16::from(values[many / 2])) / 2) as u8
            };
        }
        // The nearest frame's own pixel where it agrees with the vote: the same picture, with its grain.
        let first = votes[k][0];
        patch[k] = if diff3(first, voted) < 45 {
            first
        } else {
            voted
        };
    }
    // Something this stretch's picture has that the room's doesn't (the pad, held up for most of it), and that the part of
    // it we can see now shows isn't there any more: the room goes in its place. Wholly hidden, it stays (a card on the table)
    // unless that spot is nearly always plain room.
    let differ: Mask = Img {
        w: pw,
        h: ph,
        v: (0..pw * ph)
            .map(|k| known[k] && diff3(at_of(pictures.nearby, k), at_of(plate, k)) > 45)
            .collect(),
    };
    let (pieces, parts, _) = pixels::parts(&differ);
    if pieces > 1 {
        let mut shown = vec![0usize; pieces];
        let mut off_room = vec![0i64; pieces];
        let mut off_near = vec![0i64; pieces];
        let mut plain = vec![0usize; pieces];
        let mut all = vec![0usize; pieces];
        for (k, (&label, &wanted)) in parts.v.iter().zip(&want).enumerate() {
            let label = label as usize;
            all[label] += 1;
            if pictures.certain.v[index(k % pw, k / pw)] {
                plain[label] += 1;
            }
            if !wanted {
                let now = at_of(frame, k);
                shown[label] += 1;
                off_room[label] += i64::from(diff3(now, at_of(plate, k)));
                off_near[label] += i64::from(diff3(now, at_of(pictures.nearby, k)));
            }
        }
        let gone: Vec<bool> = (0..pieces)
            .map(|label| {
                label > 0
                    && ((shown[label] >= 10 && off_room[label] < off_near[label])
                        || (shown[label] < 10
                            && plain[label] as f64 / all[label].max(1) as f64 >= 0.7))
            })
            .collect();
        for k in 0..pw * ph {
            if want[k] && gone[parts.v[k] as usize] {
                patch[k] = at_of(plate, k);
            }
        }
    }
    for k in 0..pw * ph {
        if want[k] && count[k] == 0 && !known[k] {
            // No frame of these seconds shows it: the room as a clear frame had it, never a smooth guess from around it.
            patch[k] = at_of(pictures.real, k);
            if !pictures.trust.v[index(k % pw, k / pw)] {
                blind[0] += 1;
            }
        }
        if want[k] {
            blind[1] += 1;
        }
    }
    // A line or a speck one frame had (a caption's edge as it slid in, a dotted edge of someone's shoe in the room's picture)
    // is put right from what's round it.
    let patch = Img {
        w: pw,
        h: ph,
        v: patch,
    };
    let wanted = Img {
        w: pw,
        h: ph,
        v: want,
    };
    let smooth = median(&patch, 9, Some(&wanted));
    let mut patch = patch;
    for k in 0..pw * ph {
        if wanted.v[k] && diff3(patch.v[k], smooth.v[k]) > 60 {
            patch.v[k] = smooth.v[k];
        }
    }
    out.paste(a, c, &patch);
    out
}

/// Every 29th pixel of `frame` where `free` is.
fn picked(frame: &Rgb, free: &Mask) -> Vec<Px> {
    frame
        .v
        .iter()
        .zip(&free.v)
        .filter(|(_, &free)| free)
        .map(|(&px, _)| px)
        .step_by(29)
        .collect()
}

fn std_dev(values: impl Iterator<Item = f64> + Clone) -> f64 {
    let n = values.clone().count() as f64;
    let mean = values.clone().sum::<f64>() / n;
    (values.map(|v| (v - mean) * (v - mean)).sum::<f64>() / n).sqrt()
}

/// A black-and-white stretch of the video (the channel cuts to one and back): its colour channels move together.
fn is_gray(frame: &Rgb, free: &Mask) -> bool {
    let picked = picked(frame, free);
    picked.len() >= 100
        && std_dev(picked.iter().map(|px| f64::from(px[0]) - f64::from(px[2]))) < 4.0
        && std_dev(picked.iter().map(|px| f64::from(px[0]) - f64::from(px[1]))) < 4.0
}

/// The room's colour picture in this frame's black and white: each channel a straight-line fit of the picture's
/// brightness, from what's showing.
fn regraded(picture: &Rgb, frame: &Rgb, free: &Mask) -> Rgb {
    let lumas = gray(picture);
    let xs: Vec<f64> = lumas
        .v
        .iter()
        .zip(&free.v)
        .filter(|(_, &free)| free)
        .map(|(&v, _)| f64::from(v))
        .step_by(29)
        .collect();
    let values = picked(frame, free);
    let mut fits = [(0.0, 0.0); 3];
    for (c, fit) in fits.iter_mut().enumerate() {
        let ys: Vec<f64> = values.iter().map(|px| f64::from(px[c])).collect();
        let n = xs.len().max(1) as f64;
        let (mx, my) = (xs.iter().sum::<f64>() / n, ys.iter().sum::<f64>() / n);
        let (mut sxx, mut sxy) = (0.0, 0.0);
        for (x, y) in xs.iter().zip(&ys) {
            sxx += (x - mx) * (x - mx);
            sxy += (x - mx) * (y - my);
        }
        let gain = if sxx > 0.0 { sxy / sxx } else { 0.0 };
        *fit = (gain, my - gain * mx);
    }
    lumas.map(|v| fits.map(|(gain, offset)| (gain * f64::from(v) + offset).clamp(0.0, 255.0) as u8))
}

/// A frame that isn't the room at all (the channel's white flash between two shots): the words closed from what's round them.
fn closed_up(frame: &Rgb, mask: &Mask) -> Rgb {
    let (mut x_min, mut x_max, mut y_min, mut y_max) = (usize::MAX, 0, usize::MAX, 0);
    for y in 0..mask.h {
        for x in 0..mask.w {
            if mask.at(x, y) {
                x_min = x_min.min(x);
                x_max = x_max.max(x);
                y_min = y_min.min(y);
                y_max = y_max.max(y);
            }
        }
    }
    let mut out = frame.clone();
    if x_min == usize::MAX {
        return out;
    }
    let (a, b) = (x_min.saturating_sub(8), (x_max + 9).min(mask.w));
    let (c, d) = (y_min.saturating_sub(8), (y_max + 9).min(mask.h));
    let mut part = frame.crop(a, c, b, d);
    pixels::telea(&mut part, &mask.crop(a, c, b, d), 3.0);
    out.paste(a, c, &part);
    out
}

/// worker.band_of: the rows their words' boxes (grown) cover, on even edges.
fn band_of(masks: &[Vec<[f64; 4]>], height: usize) -> Option<(usize, usize)> {
    let scale = height as f64 / 1080.0;
    let rows: Vec<(f64, f64)> = masks.iter().flatten().map(|b| (b[1], b[3])).collect();
    if rows.is_empty() {
        return None;
    }
    let tallest = rows.iter().map(|r| r.1 - r.0).fold(f64::MIN, f64::max);
    let pad = ((16.0 + 24.0) * scale).max((140.0 * scale).min(0.55 * tallest));
    let top = rows.iter().map(|r| r.0).fold(f64::MAX, f64::min);
    let bottom = rows.iter().map(|r| r.1).fold(f64::MIN, f64::max);
    let height = height as i64;
    let mut y0 = ((top - pad).trunc() as i64).max(0);
    let mut y1 = ((bottom + pad).ceil() as i64).min(height);
    let least = (160.0 * scale) as i64;
    if y1 - y0 < least {
        let grow = least - (y1 - y0);
        y0 = (y0 - grow.div_euclid(2)).max(0);
        y1 = height.min(y0 + least);
        y0 = (y1 - least).max(0);
    }
    y0 -= y0.rem_euclid(2);
    y1 += y1.rem_euclid(2);
    Some((y0 as usize, y1.min(height - height.rem_euclid(2)) as usize))
}

/// Asked between frames whether to stop (the stretch's time is up): an error then, and nothing left behind.
pub type Stop<'a> = &'a dyn Fn() -> bool;

fn check(stopped: Stop<'_>) -> Result<(), String> {
    if stopped() {
        Err("the still clean was stopped".to_owned())
    } else {
        Ok(())
    }
}

fn not_still(why: impl Into<String>) -> Value {
    json!({"still": false, "why": why.into()})
}

/// Cleans the stretch `job` asks for: the strip written to `job.out` and {"still": true, "box"}, or {"still": false,
/// "why"} when this isn't a still shot it can clean (nothing left behind). Runs on the calling thread.
pub fn clean(job: &Job, stopped: Stop<'_>) -> Result<Value, String> {
    let (w, h, fps) = (job.width as usize, job.height as usize, job.fps);
    if w < 16 || h < 16 || fps.is_nan() || fps <= 0.0 {
        return Err("the stretch has no picture size or rate".to_owned());
    }
    let found = read_found(&job.found)?;
    let mut masks: Vec<Vec<[f64; 4]>> = job
        .masks
        .iter()
        .map(|boxes| {
            boxes
                .iter()
                .filter_map(|one| Some([*one.first()?, *one.get(1)?, *one.get(2)?, *one.get(3)?]))
                .collect()
        })
        .collect();
    // A watermark already taken out under these seconds: the room's picture and other frames still have it, so the model
    // (which reads the cleaned frames) takes the stretch.
    if !job.beneath.is_empty() {
        return Ok(not_still("a cleaned watermark under it"));
    }
    // A box far from where this file's captions come up is a title or a screen read as one: left alone, and the strip
    // stays the height of the captions. Only when the file's blur still covers it (a label there at that moment): once
    // this strip is laid, the stretch's caption blur comes off, and anything left out would show.
    let caps = caps_of(&found);
    let place = place_of(&caps);
    if let Some(place) = place {
        let inside = |b: [f64; 4]| {
            let (cx, cy) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
            (place[0] - 40) as f64 <= cx
                && cx <= (place[2] + 40) as f64
                && (place[1] - 40) as f64 <= cy
                && cy <= (place[3] + 40) as f64
        };
        let in_place = caps
            .iter()
            .filter(|m| inside([m.x0 as f64, m.y0 as f64, m.x1 as f64, m.y1 as f64]))
            .count();
        if in_place as f64 >= 0.9 * caps.len() as f64 {
            let every = found.fps.unwrap_or(fps);
            let start = round(job.from * every);
            let labels: Vec<&Mark> = found.marks.iter().filter(|m| m.kind == "label").collect();
            // Wholly under the labels up at that frame: any part outside would show once the caption blur comes off.
            let blurred = |b: [f64; 4], at: i64| -> bool {
                let [x0, y0, x1, y1] = b.map(|v| v.trunc() as i64);
                if x1 <= x0 || y1 <= y0 {
                    return true;
                }
                let mut under = Img::filled((x1 - x0) as usize, (y1 - y0) as usize, false);
                for m in &labels {
                    if m.first <= at as f64 && at as f64 <= m.last {
                        fill_py(
                            &mut under,
                            (m.x0 - x0).max(0),
                            (m.y0 - y0).max(0),
                            (m.x1 - x0).max(0),
                            (m.y1 - y0).max(0),
                        );
                    }
                }
                under.v.iter().all(|&one| one)
            };
            for (index, boxes) in masks.iter().enumerate() {
                for &b in boxes {
                    if !inside(b) && !blurred(b, start + round(index as f64 * every / fps)) {
                        return Ok(not_still("a caption away from the others"));
                    }
                }
            }
            for boxes in &mut masks {
                boxes.retain(|&b| inside(b));
            }
        }
    }
    let mut total = masks.len();
    let Some((y0, y1)) = band_of(&masks, h) else {
        return Ok(json!({"still": true, "box": null, "inferred": 0}));
    };
    let rows = y1 - y0;
    let scale = h as f64 / 1080.0;
    let mut plates = build_plates(job, &found, false, stopped)?;
    // A plate made before this file was read may stop short of its captions: made again with what's known now.
    let top_word = masks
        .iter()
        .flatten()
        .map(|b| b[1])
        .fold(f64::MAX, f64::min)
        .trunc() as i64;
    let bottom_word = masks
        .iter()
        .flatten()
        .map(|b| b[3])
        .fold(f64::MIN, f64::max)
        .trunc() as i64;
    let outside = |span: (usize, usize)| top_word < span.0 as i64 || bottom_word > span.1 as i64;
    if plates.as_ref().is_some_and(|(span, _)| outside(*span)) {
        plates = build_plates(job, &found, true, stopped)?;
    }
    let Some((span, shots)) = plates.filter(|(span, shots)| !shots.is_empty() && !outside(*span))
    else {
        return Ok(not_still("no plate"));
    };
    // Which shot: by the picture at the middle of the stretch.
    let middle = Frames::whole(
        &job.input,
        &job.input_args,
        w,
        h,
        "",
        &[
            "-ss".to_owned(),
            format!("{:.3}", job.from + total as f64 / fps / 2.0),
        ],
    )?
    .next()?;
    let Some(middle) = middle else {
        return Ok(not_still("no picture"));
    };
    let small = shrunk(&middle);
    let mut chosen: Option<(&Plated, f64)> = None;
    for one in &shots {
        let off = small_median(&one.small, &small);
        if chosen.is_none_or(|(_, least)| off < least) {
            chosen = Some((one, off));
        }
    }
    let Some((shot, _)) = chosen else {
        return Ok(not_still("no plate"));
    };
    if !same_shot(&shot.small, &small) {
        return Ok(not_still("another shot"));
    }
    // The plate, on the stretch's rows (rows it doesn't reach hold no caption: checked above).
    let (top, bottom) = (y0.max(span.0), y1.min(span.1));
    let on_rows = |picture: &Rgb| -> Rgb {
        let mut out = Img::filled(w, rows, [0u8; 3]);
        if bottom > top {
            out.paste(
                0,
                top - y0,
                &picture.crop(0, top - span.0, w, bottom - span.0),
            );
        }
        out
    };
    // A pixel's commonest value can differ from its neighbour's by a whole step: a line or a speck here and there.
    let plate = on_rows(&median(&shot.plate, 5, None));
    let mut real = on_rows(&median(&shot.real, 5, None));
    // A clear frame only where it is the room: anything it has that the room's picture hasn't (a word, a passer-by) isn't.
    for (one, &room) in real.v.iter_mut().zip(&plate.v) {
        if diff3(*one, room) > 60 {
            *one = room;
        }
    }
    let mut known = Img::filled(w, rows, false);
    let (mut trust, mut certain) = (known.clone(), known.clone());
    if bottom > top {
        known.fill(0, top - y0, w, bottom - y0);
        for y in top..bottom {
            for x in 0..w {
                let sure = shot.sure.at(x, y - span.0);
                trust.set(x, y - y0, sure >= 150);
                certain.set(x, y - y0, sure >= 205);
            }
        }
    }
    let (nearby, seen) = stretch_plate(job, total, w, h, y0, y1, &small, &found, stopped)?;
    let place_rows = place
        .filter(|place| place[3] > y0 as i64 && place[1] < y1 as i64)
        .map(|place| {
            [
                place[0] as f64,
                place[1].max(y0 as i64) as f64,
                place[2] as f64,
                place[3].min(y1 as i64) as f64,
            ]
        });
    let mut source = Frames::band(job, total, w, y0, y1)?;
    let mut strip = Strip::open(Path::new(&job.out), w, rows, fps)?;
    let wanted = total;
    let mut window = Window {
        frames: VecDeque::new(),
        own: VecDeque::new(),
    };
    let mut marks: VecDeque<Option<Mask>> = VecDeque::new();
    let (mut off, mut checked, mut written, mut next_frame, mut boxed, mut empty, mut off_looks) =
        (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    let mut blind = [0usize; 2];
    let none = Img::filled(w, rows, false);
    let feather = (round(9.0 * scale).max(0) as usize).max(FEATHER);
    let pictures = Pictures {
        plate: &plate,
        nearby: &nearby,
        seen: &seen,
        real: &real,
        trust: &trust,
        certain: &certain,
    };
    while written < total {
        check(stopped)?;
        while next_frame < total && window.frames.len() - (written - off) <= REACH {
            let Some(frame) = source.next()? else {
                total = next_frame;
                break;
            };
            let (m, cover) = if !masks[next_frame].is_empty() {
                let (m, cover) = letters(&frame, &masks[next_frame], y0 as f64, scale);
                boxed += 1;
                if !m.any() {
                    empty += 1;
                }
                (Some(m), cover)
            } else if let Some(place_rows) = place_rows {
                // No box this frame, but a line the finder missed may still be up: its letters lend nothing.
                let seen_letters = letters(&frame, &[place_rows], y0 as f64, scale).0;
                let cover = if seen_letters.any() {
                    seen_letters
                } else {
                    none.clone()
                };
                (None, cover)
            } else {
                (None, none.clone())
            };
            window.frames.push_back(frame);
            marks.push_back(m);
            window.own.push_back(cover);
            next_frame += 1;
        }
        if written >= total {
            break;
        }
        let at = written - off;
        let frame = &window.frames[at];
        let free: Mask = known.zip(&window.own[at], |known, own| known && !own);
        let any_free = free.any();
        let on_room = |room: &Rgb| -> f64 {
            let mut near = 0usize;
            let mut all = 0usize;
            for k in 0..free.v.len() {
                if free.v[k] {
                    all += 1;
                    if diff3(frame.v[k], room.v[k]) < 45 {
                        near += 1;
                    }
                }
            }
            near as f64 / all.max(1) as f64
        };
        let gray_frame = any_free && is_gray(frame, &free);
        if at % 15 == 0 && any_free {
            checked += 1;
            let share = if gray_frame {
                on_room(&regraded(&plate, frame, &free))
            } else {
                on_room(&plate)
            };
            if share < ON_PLATE {
                off_looks += 1;
            }
        }
        match &marks[at] {
            Some(m) if m.any() => {
                let fill = if gray_frame {
                    let (plate, nearby, real) = (
                        regraded(&plate, frame, &free),
                        regraded(&nearby, frame, &free),
                        regraded(&real, frame, &free),
                    );
                    let pictures = Pictures {
                        plate: &plate,
                        nearby: &nearby,
                        real: &real,
                        ..pictures
                    };
                    filled(frame, &pictures, m, scale, &window, at, &mut blind)
                } else if any_free && on_room(&plate) < 0.3 {
                    closed_up(frame, m)
                } else {
                    filled(frame, &pictures, m, scale, &window, at, &mut blind)
                };
                strip.write(Some((&fill, &pixels::alpha_of(m, feather))))?;
            }
            _ => strip.write(None)?,
        }
        written += 1;
        if written - off > REACH {
            window.frames.pop_front();
            window.own.pop_front();
            marks.pop_front();
            off += 1;
        }
    }
    while written < wanted {
        strip.write(None)?;
        written += 1;
    }
    drop(source);
    // Boxes with no letters we can see in most of their frames: a style this doesn't know, for the model.
    let unread = boxed > 0 && empty as f64 / boxed as f64 > 0.6;
    let unseen = blind[1] > 0 && blind[0] as f64 / blind[1] as f64 > BLIND;
    // The footage ended before the stretch did: its last frames would keep their captions.
    let short = total < wanted;
    let off_plate = checked > 0 && off_looks as f64 / checked as f64 > OFF_PLATE;
    if short || unread || unseen || off_plate {
        strip.abandon();
        return Ok(not_still(if short {
            format!(
                "the footage ended {} frames before the stretch did",
                wanted - total
            )
        } else if unseen {
            format!(
                "{}% of the caption's spot is never seen clear",
                round(100.0 * blind[0] as f64 / blind[1] as f64)
            )
        } else if unread {
            format!("{empty} of {boxed} captioned frames without letters")
        } else {
            format!("{off_looks} of {checked} looks off the room's picture")
        }));
    }
    strip.finish()?;
    let blind_share = blind[0] as f64 / blind[1].max(1) as f64;
    Ok(json!({
        "still": true,
        "box": [0.0, y0 as f64 / h as f64, 1.0, y1 as f64 / h as f64],
        "inferred": 0,
        "blind": (blind_share * 1000.0).round() / 1000.0,
    }))
}

#[cfg(test)]
mod tests;
