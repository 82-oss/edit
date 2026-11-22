//! Words on screen in footage: Apple's Vision text recognition on frames of
//! the light preview, one a second of source, kept per file in its cache dir
//! (`text-v1.json`) like the faces (faces.rs). What it's for: another
//! channel's burned-in calls to action ("SUBSCRIBE", the bell) and logos in a
//! re-upload, which the team wants blurred wherever they show (Corrupt Cop's
//! "Subscribe should be blurred here. This could appear throughout the
//! video"). Off macOS PaddleOCR reads them (`text_model`), kept in its own
//! file (`text-paddle-v1.json`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Frames looked at per second of source.
pub const RATE: f64 = 1.0;
/// The analysis's file in the media's cache dir; a new method is a new file.
#[cfg(target_os = "macos")]
const FILE: &str = "text-v1.json";
/// PaddleOCR's (off macOS): its own file, never taken for Vision's.
#[cfg(not(target_os = "macos"))]
const FILE: &str = "text-paddle-v1.json";
/// How wide the frames looked at are: a channel's subscribe button reads at this size.
const WIDE: u32 = 960;
/// Text the recogniser is less sure of is ignored.
const SURE: f32 = 0.3;

/// One piece of text seen: its box (x0, y0, x1, y1 as shares of the picture
/// from its top left) and what it says.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Seen {
    pub b: [f64; 4],
    pub t: String,
}

/// The text at each sample index (source seconds × RATE).
pub type Texts = BTreeMap<i64, Vec<Seen>>;

/// One stretch's reads, index by index.
type Read = Vec<(i64, Vec<Seen>)>;

#[derive(Default, Deserialize, Serialize)]
struct Found {
    samples: Texts,
}

/// The text at `indexes` (source seconds × RATE) of the footage at `source`
/// (`size` its picture size): from its cache, the rest read now. Blocking:
/// call from spawn_blocking.
pub fn detect(source: &Path, size: (u32, u32), indexes: &BTreeSet<i64>) -> Result<Texts, String> {
    // One read per file at a time (faces.rs's locks, under a key of its own).
    let lock = crate::faces::lock_for(&source.with_extension("text"));
    let _held = lock.lock();
    let file = crate::util::media_cache(source).map(|dir| dir.join(FILE));
    let mut found: Found = file
        .as_ref()
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let missing: Vec<i64> = indexes
        .iter()
        .copied()
        .filter(|index| !found.samples.contains_key(index))
        .collect();
    if !missing.is_empty() {
        let fresh = look(source, size, &missing)?;
        let any = !fresh.is_empty();
        found.samples.extend(fresh);
        if let Some(file) = file.filter(|_| any) {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let bytes = serde_json::to_vec(&found).map_err(|error| error.to_string())?;
            crate::util::write_atomic(&file, &bytes).map_err(|error| error.to_string())?;
        }
    }
    Ok(indexes
        .iter()
        .filter_map(|index| Some((*index, found.samples.get(index)?.clone())))
        .collect())
}

/// Reads the text at `indexes` (sorted): the light preview decoded (by
/// AVFoundation on a Mac, FFmpeg elsewhere), in up to three stretches side by
/// side, each frame given to Vision on a Mac, PaddleOCR elsewhere.
fn look(source: &Path, (width, height): (u32, u32), indexes: &[i64]) -> Result<Texts, String> {
    let wide = WIDE.min(width.max(2)) & !1;
    let decode = crate::track::decode_source(source, wide as usize);
    let high = ((f64::from(wide) * f64::from(height.max(1)) / f64::from(width.max(1))).round()
        as u32
        & !1)
        .max(2);
    let parts = indexes.len().div_ceil(300).clamp(1, 3);
    let chunk = indexes.len().div_ceil(parts);
    let read = |part: &[i64]| -> Result<Read, String> {
        let mut reader = crate::render::VideoReader::analysis(&decode, wide, high);

        let mut out = Vec::with_capacity(part.len());
        for &index in part {
            let time = index as f64 / RATE;
            let bgra = reader.frame_at(time)?;
            #[cfg(target_os = "macos")]
            let lines = crate::mac_media::text(bgra, wide, high, false)?;
            #[cfg(not(target_os = "macos"))]
            let lines = crate::text_model::text(bgra, wide, high)?;
            let seen = lines
                .into_iter()
                .filter(|(_, sure, _)| *sure >= SURE)
                .map(|(b, _, t)| Seen {
                    b: b.map(|value| (f64::from(value).clamp(0.0, 1.0) * 1000.0).round() / 1000.0),
                    t,
                })
                .collect();
            out.push((index, seen));
        }
        Ok(out)
    };
    let results: Vec<Result<Read, String>> = std::thread::scope(|scope| {
        let reads: Vec<_> = indexes
            .chunks(chunk.max(1))
            .map(|part| {
                scope.spawn(move || {
                    // Analysis, behind the player and the page (`util::background_thread`).
                    crate::util::background_thread();
                    read(part)
                })
            })
            .collect();
        reads
            .into_iter()
            .map(|read| {
                read.join()
                    .unwrap_or_else(|_| Err("text finder crashed".into()))
            })
            .collect()
    });
    let mut out = BTreeMap::new();
    for result in results {
        out.extend(result?);
    }
    Ok(out)
}

/// The widest frame `read_at` decodes.
const AT_MOST_WIDE: u32 = 1920;

/// The words in `region` (x0, y0, x1, y1 as shares of the picture) of the
/// frames at `times` (source seconds, each the file's own frame there at
/// `fps`, its rate) of `source` (`size` its picture size), read at the file's
/// own size up to 1920 wide: small text a 960-wide frame loses, a bodycam's
/// clock in its corner (the server's camera_clock.ts, which keeps what it
/// reads). Boxes are shares of the whole picture, in `times`' order. On a
/// Mac, at Vision's accurate level: a box the blur follows must hold every
/// letter (`mac_media::text`).
/// Blocking: call from spawn_blocking.
pub fn read_at(
    source: &Path,
    (width, height): (u32, u32),
    fps: f64,
    region: [f64; 4],
    times: &[f64],
) -> Result<Vec<Vec<Seen>>, String> {
    let cut = Cut::of((width, height), region)?;
    // Read in time order, a stretch per thread, then put back in the order asked.
    let mut order: Vec<usize> = (0..times.len()).collect();
    let time = |at: usize| times.get(at).copied().unwrap_or(0.0);
    order.sort_by(|a, b| time(*a).total_cmp(&time(*b)));
    let parts = order.len().div_ceil(8).clamp(1, 3);
    let chunk = order.len().div_ceil(parts).max(1);
    // Each time's index in `times` and what was read there.
    type Part = Vec<(usize, Vec<Seen>)>;
    let read = |part: &[usize]| -> Result<Part, String> {
        let mut reader = crate::render::VideoReader::analysis_at(source, cut.wide, cut.high, fps);
        let mut crop = Vec::new();
        let mut out = Vec::with_capacity(part.len());
        for &at in part {
            cut.crop(reader.frame_at(time(at).max(0.0))?, &mut crop)?;
            let seen = cut.seen(lines_in(&crop, cut.w, cut.h, &|_| None)?);
            out.push((at, seen));
        }
        Ok(out)
    };
    let results: Vec<Result<Part, String>> = std::thread::scope(|scope| {
        let reads: Vec<_> = order
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    crate::util::background_thread();
                    read(part)
                })
            })
            .collect();
        reads
            .into_iter()
            .map(|read| {
                read.join()
                    .unwrap_or_else(|_| Err("text finder crashed".into()))
            })
            .collect()
    });
    let mut out = vec![Vec::new(); times.len()];
    for result in results {
        for (at, seen) in result? {
            if let Some(slot) = out.get_mut(at) {
                *slot = seen;
            }
        }
    }
    Ok(out)
}

/// A region of the frames read for words: the frame's size as decoded (up to
/// AT_MOST_WIDE across) and the region's pixels in it.
#[derive(Clone, Copy)]
struct Cut {
    wide: u32,
    high: u32,
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
}

impl Cut {
    fn of((width, height): (u32, u32), region: [f64; 4]) -> Result<Self, String> {
        let wide = AT_MOST_WIDE.min(width.max(2)) & !1;
        let high = ((f64::from(wide) * f64::from(height.max(1)) / f64::from(width.max(1))).round()
            as u32
            & !1)
            .max(2);
        let share = |value: f64| value.clamp(0.0, 1.0);
        let x0 = (share(region[0]) * f64::from(wide)).floor() as usize;
        let y0 = (share(region[1]) * f64::from(high)).floor() as usize;
        let x1 = ((share(region[2]) * f64::from(wide)).ceil() as usize).min(wide as usize);
        let y1 = ((share(region[3]) * f64::from(high)).ceil() as usize).min(high as usize);
        if x1 < x0 + 8 || y1 < y0 + 8 {
            return Err("the region to read is too small".to_owned());
        }
        Ok(Self {
            wide,
            high,
            x0,
            y0,
            w: x1 - x0,
            h: y1 - y0,
        })
    }

    /// The region's pixels out of a decoded frame.
    fn crop(&self, bgra: &[u8], into: &mut Vec<u8>) -> Result<(), String> {
        into.resize(self.w * self.h * 4, 0);
        let stride = self.wide as usize * 4;
        for (row, line) in into.chunks_exact_mut(self.w * 4).enumerate() {
            let from = (self.y0 + row) * stride + self.x0 * 4;
            let Some(pixels) = bgra.get(from..from + self.w * 4) else {
                return Err("the frame is smaller than its size".to_owned());
            };
            line.copy_from_slice(pixels);
        }
        Ok(())
    }

    /// The lines read in the region (boxes as its shares), sure enough, as shares of the whole picture.
    fn seen(&self, lines: Vec<Line>) -> Vec<Seen> {
        let to_frame = |value: f32, from: usize, across: usize, whole: u32| {
            let at =
                (from as f64 + f64::from(value).clamp(0.0, 1.0) * across as f64) / f64::from(whole);
            (at * 1000.0).round() / 1000.0
        };
        lines
            .into_iter()
            .filter(|(_, sure, _)| *sure >= SURE)
            .map(|(b, _, t)| Seen {
                b: [
                    to_frame(b[0], self.x0, self.w, self.wide),
                    to_frame(b[1], self.y0, self.h, self.high),
                    to_frame(b[2], self.x0, self.w, self.wide),
                    to_frame(b[3], self.y0, self.h, self.high),
                ],
                t,
            })
            .collect()
    }
}

/// A line read: its box (shares of what was read), how sure, its words.
type Line = ([f32; 4], f32, String);

/// The lines in a `w`×`h` BGRA crop, at Vision's accurate level on a Mac (a
/// box the blur follows must hold every letter); off a Mac, a line `known`
/// has (by its pixel box) taken from it rather than read again.
#[cfg_attr(target_os = "macos", allow(unused_variables))]
fn lines_in(
    crop: &[u8],
    w: usize,
    h: usize,
    known: &dyn Fn([usize; 4]) -> Option<(String, f32)>,
) -> Result<Vec<Line>, String> {
    #[cfg(target_os = "macos")]
    return crate::mac_media::text(crop, w as u32, h as u32, true);
    #[cfg(not(target_os = "macos"))]
    return crate::text_model::text_knowing(crop, w as u32, h as u32, known);
}

/// Reads of a stretch (`Stretch::read`) done side by side: 3, or 4 on a Linux machine with many cores (its OCR on the
/// CPU; three stretches are read at once there, text_blur.ts `AT_ONCE`).
fn workers() -> usize {
    static WORKERS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *WORKERS.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
        if cfg!(target_os = "linux") && cores >= 24 {
            4
        } else {
            3
        }
    })
}

/// Text-model runs at once across every stretch read (each stretch's `workers` wait for one): on Linux a quarter of the
/// cores, 2 to 6 (Nov 22, Sphe's prod Linux Edit on 32 threads: three stretches of four workers each, beside their
/// decoders, took its whole 16-core quota, and each run holds its model's working memory); elsewhere a stretch's own
/// workers (a Mac reads one stretch at a time, with Vision).
fn slots() -> usize {
    static SLOTS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *SLOTS.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
        if cfg!(target_os = "linux") {
            (cores / 4).clamp(2, 6)
        } else {
            workers()
        }
    })
}

static BUSY: parking_lot::Mutex<usize> = parking_lot::Mutex::new(0);
static FREED: parking_lot::Condvar = parking_lot::Condvar::new();
/// The most text-model runs seen at once (tests).
static MOST: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Runs `work` (one look or read of the text model) once one of the `slots` is free.
fn in_slot<R>(work: impl FnOnce() -> R) -> R {
    struct Held;
    impl Drop for Held {
        fn drop(&mut self) {
            *BUSY.lock() -= 1;
            FREED.notify_one();
        }
    }
    {
        let mut busy = BUSY.lock();
        while *busy >= slots() {
            FREED.wait(&mut busy);
        }
        *busy += 1;
        MOST.fetch_max(*busy, std::sync::atomic::Ordering::Relaxed);
    }
    let _held = Held;
    work()
}

/// Two crops show the same thing when their luma differs by at most this on average and no more than ALIKE_OFF of
/// their pixels differ by over ALIKE_BY (of 255). Nov 19, a compilation's subtitles read 3 times a second: the same line
/// read twice differed by 0.0–0.6 on average (3.7 once, a fade), never a pixel by over 48; a letter changed is hundreds.
const ALIKE_MEAN: f64 = 2.5;
const ALIKE_BY: u8 = 48;
const ALIKE_OFF: usize = 8;

/// Off a Mac, frames read this wide or wider are first looked at for where their text is at half size (a quarter of
/// the finder's work), and where it's all as it was in the frame read before (each place within a pixel at that size,
/// its pixels unchanged) that frame's lines are taken (Nov 19: the finder over a tall band at 1920 across took 0.6 s a
/// read, and their subtitles hold a second or more). Half of 1920 is the 960 their subtitles and labels were found at
/// (`WIDE`), so none of theirs is too small for it.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const GATE: u32 = 2 * WIDE;

/// One frame read in a stretch: its crop's luma, the lines read in it, and where its text was at half size (`GATE`).
#[derive(Clone)]
struct Done {
    luma: Arc<Vec<u8>>,
    lines: Arc<Vec<Line>>,
    gate: Option<Arc<Vec<[usize; 4]>>>,
}

/// A frame to read in a stretch, as it's looked at first: its index, crop, the crop's luma, and where its text is at
/// half size (`GATE`).
struct Look {
    index: i64,
    crop: Arc<Vec<u8>>,
    luma: Vec<u8>,
    gate: Option<Vec<[usize; 4]>>,
}

/// The crop's luma (BT.601, as a picture's brightness), what reads are compared by.
fn luma_of(crop: &[u8]) -> Vec<u8> {
    crop.as_chunks::<4>()
        .0
        .iter()
        .map(|[b, g, r, _]| {
            ((u32::from(*b) * 29 + u32::from(*g) * 150 + u32::from(*r) * 77 + 128) >> 8) as u8
        })
        .collect()
}

/// Whether `a` and `b` (lumas `w` wide) show the same pixels in `area` (x0, y0, x1, y1).
fn alike(a: &[u8], b: &[u8], w: usize, [x0, y0, x1, y1]: [usize; 4]) -> bool {
    if a.len() != b.len() || x1 <= x0 || y1 <= y0 {
        return false;
    }
    let (mut sum, mut off) = (0u64, 0usize);
    for y in y0..y1 {
        let (Some(one), Some(two)) = (a.get(y * w + x0..y * w + x1), b.get(y * w + x0..y * w + x1))
        else {
            return false;
        };
        for (p, q) in one.iter().zip(two) {
            let by = p.abs_diff(*q);
            sum += u64::from(by);
            if by > ALIKE_BY {
                off += 1;
                if off > ALIKE_OFF {
                    return false;
                }
            }
        }
    }
    (sum as f64) <= ALIKE_MEAN * ((x1 - x0) * (y1 - y0)) as f64
}

/// A BGRA picture `w`×`h` at half size (each 2×2 averaged).
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn halved(bgra: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let (hw, hh) = (w / 2, h / 2);
    let mut out = vec![0u8; hw * hh * 4];
    for (y, row) in out.chunks_exact_mut(hw * 4).enumerate() {
        let (top, bottom) = ((2 * y) * w * 4, (2 * y + 1) * w * 4);
        for (x, pixel) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            for (channel, value) in pixel.iter_mut().enumerate() {
                let at = |row: usize, dx: usize| {
                    u32::from(
                        bgra.get(row + (2 * x + dx) * 4 + channel)
                            .copied()
                            .unwrap_or(0),
                    )
                };
                *value = ((at(top, 0) + at(top, 1) + at(bottom, 0) + at(bottom, 1) + 2) / 4) as u8;
            }
        }
    }
    (out, hw, hh)
}

/// Where the text is in `crop` at half size (`GATE`), off a Mac and when the frame is wide enough; else None.
fn gate_of(cut: &Cut, crop: &[u8]) -> Result<Option<Vec<[usize; 4]>>, String> {
    #[cfg(not(target_os = "macos"))]
    if cut.wide >= GATE {
        let (half, hw, hh) = halved(crop, cut.w, cut.h);
        return crate::text_model::find(&half, hw as u32, hh as u32).map(Some);
    }
    let _ = (cut, crop);
    Ok(None)
}

/// Whether a frame (`luma`, its text at half size `gate`) shows what `was` did: its whole crop unchanged, or its text
/// in the same places at half size with their pixels (the places doubled, a pixel more round) unchanged.
fn as_before(
    cut: &Cut,
    luma: &[u8],
    gate: Option<&Vec<[usize; 4]>>,
    was: (&[u8], Option<&Vec<[usize; 4]>>),
) -> bool {
    let (w, h) = (cut.w, cut.h);
    let (was_luma, was_gate) = was;
    if alike(luma, was_luma, w, [0, 0, w, h]) {
        return true;
    }
    let (Some(now), Some(then)) = (gate, was_gate) else {
        return false;
    };
    now.len() == then.len()
        && now
            .iter()
            .zip(then)
            .all(|(a, b)| a.iter().zip(b).all(|(a, b)| a.abs_diff(*b) <= 1))
        && then.iter().all(|b| {
            let area = [
                (2 * b[0]).saturating_sub(2),
                (2 * b[1]).saturating_sub(2),
                (2 * b[2] + 2).min(w),
                (2 * b[3] + 2).min(h),
            ];
            alike(luma, was_luma, w, area)
        })
}

/// Rows (y0, y1) of a `h`-high crop to look for text in at full size, across all of it: those of `gate`'s places (at
/// half size) doubled, MARGIN more above and below, each strip's height made a multiple of STRIP (so the finder's plans
/// are few), grown evenly and kept inside the crop, strips that meet joined. None when that's most of the crop (it's
/// looked at whole). Nov 19: cut across to the places' width as well, the boxes came out further from the whole
/// crop's (up to 4 px) for 5% less time.
fn strips_of(gate: &[[usize; 4]], h: usize) -> Option<Vec<(usize, usize)>> {
    /// Above and below a place found at half size: its letters and the finder's context round them (at 32 the boxes
    /// came out up to 4 px off the whole crop's, at 64 within 3, most the same).
    const MARGIN: usize = 64;
    const STRIP: usize = 64;
    let mut strips: Vec<(usize, usize)> = gate
        .iter()
        .map(|b| {
            (
                (2 * b[1]).saturating_sub(MARGIN),
                (2 * b[3] + MARGIN).min(h),
            )
        })
        .filter(|(y0, y1)| y1 > y0)
        .collect();
    loop {
        strips.sort_unstable();
        let mut joined: Vec<(usize, usize)> = Vec::new();
        for (y0, y1) in strips.iter().copied() {
            let high = (y1 - y0).div_ceil(STRIP) * STRIP;
            let (y0, y1) = if high >= h {
                (0, h)
            } else {
                let top = y0.saturating_sub((high - (y1 - y0)) / 2).min(h - high);
                (top, top + high)
            };
            match joined.last_mut() {
                Some(last) if y0 <= last.1 => *last = (last.0.min(y0), last.1.max(y1)),
                _ => joined.push((y0, y1)),
            }
        }
        let stable = joined == strips;
        strips = joined;
        if stable {
            break;
        }
    }
    let rows: usize = strips.iter().map(|(y0, y1)| y1 - y0).sum();
    (rows * 5 < h * 4).then_some(strips)
}

/// The lines in `crop` (luma `luma`; where its text is at half size, `gate`), each line found where one was read in
/// `before` with its pixels unchanged taken as it was there. With `gate`, only the rows round its places are looked
/// at (`strips_of`), and with no place at all there's none.
fn read_knowing(
    cut: &Cut,
    crop: &[u8],
    luma: &[u8],
    gate: Option<&Vec<[usize; 4]>>,
    before: Option<&Done>,
) -> Result<Vec<Line>, String> {
    let (w, h) = (cut.w, cut.h);
    let pixels = |b: &[f32; 4]| -> [usize; 4] {
        [
            (b[0] * w as f32).round() as usize,
            (b[1] * h as f32).round() as usize,
            (b[2] * w as f32).round() as usize,
            (b[3] * h as f32).round() as usize,
        ]
    };
    let known = |found: [usize; 4]| -> Option<(String, f32)> {
        let done = before?;
        done.lines.iter().find_map(|(b, sure, words)| {
            let was = pixels(b);
            let near = found.iter().zip(was).all(|(a, b)| a.abs_diff(b) <= 2);
            (near && alike(luma, &done.luma, w, found)).then(|| (words.clone(), *sure))
        })
    };
    let Some(strips) = gate.and_then(|gate| strips_of(gate, h)) else {
        return lines_in(crop, w, h, &known);
    };
    let mut out: Vec<(usize, Line)> = Vec::new();
    for (y0, y1) in strips {
        let high = y1 - y0;
        let rows = crop
            .get(y0 * w * 4..y1 * w * 4)
            .ok_or("a strip outside its crop")?;
        let moved = |found: [usize; 4]| known([found[0], found[1] + y0, found[2], found[3] + y0]);
        for (b, sure, words) in lines_in(rows, w, high, &moved)? {
            let top = (b[1] * high as f32).round() as usize + y0;
            let bottom = (b[3] * high as f32).round() as usize + y0;
            out.push((
                top / 8 * 100_000 + (b[0] * w as f32).round() as usize,
                (
                    [b[0], top as f32 / h as f32, b[2], bottom as f32 / h as f32],
                    sure,
                    words,
                ),
            ));
        }
    }
    // Top to bottom, then left to right, as the finder gives them.
    out.sort_by_key(|(order, _)| *order);
    Ok(out.into_iter().map(|(_, line)| line).collect())
}

/// Runs `work` on each of `items` on up to WORKERS threads (each takes the next not taken): the results in order.
fn side_by_side<T: Sync, R: Send>(
    items: &[T],
    work: impl Fn(&T) -> Result<R, String> + Sync,
) -> Result<Vec<R>, String> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let threads = workers().min(items.len()).max(1);
    let results: Vec<Result<Vec<(usize, R)>, String>> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| -> Result<Vec<(usize, R)>, String> {
                    crate::util::background_thread();
                    let mut out = Vec::new();
                    loop {
                        let at = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(item) = items.get(at) else {
                            return Ok(out);
                        };
                        out.push((at, in_slot(|| work(item))?));
                    }
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|_| Err("text finder crashed".into()))
            })
            .collect()
    });
    let mut out: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    for result in results {
        for (at, value) in result? {
            if let Some(slot) = out.get_mut(at) {
                *slot = Some(value);
            }
        }
    }
    out.into_iter()
        .map(|one| one.ok_or_else(|| "a frame wasn't read".to_owned()))
        .collect()
}

/// Off a Mac, a stretch's frames as FFmpeg cuts them out: only the region's pixels come down the pipe (Nov 19: whole
/// 1920 frames, 8 MB each, were most of a stretch's time once the reads were few), the same pixels `VideoReader`'s frame
/// would give cut there (the same seek, rate and scaling, converted before the cut).
#[cfg(not(target_os = "macos"))]
struct CropStream {
    source: std::path::PathBuf,
    fps: f64,
    cut: Cut,
    child: Option<(crate::util::Watched, std::process::ChildStdout)>,
    /// The frame (index at `fps`) the pipe gives next.
    next: i64,
    /// The last frame read, at its index (held past the file's end).
    last: Option<(i64, Arc<Vec<u8>>)>,
    /// What frames passed over are read into.
    spare: Vec<u8>,
    eof: bool,
}

#[cfg(not(target_os = "macos"))]
impl CropStream {
    fn new(source: &Path, fps: f64, cut: Cut) -> Self {
        Self {
            source: source.to_path_buf(),
            fps,
            cut,
            child: None,
            next: 0,
            last: None,
            spare: Vec::new(),
            eof: false,
        }
    }

    /// FFmpeg started at frame `index`, half a frame before it and re-based so `fps=` keeps each frame in its slot
    /// (`VideoReader::restart`).
    fn restart(&mut self, index: i64) -> Result<(), String> {
        self.child = None;
        let index = index.max(0);
        let time = ((index as f64 - 0.5) / self.fps).max(0.0);
        let Cut {
            wide,
            high,
            x0,
            y0,
            w,
            h,
        } = self.cut;
        let mut child = crate::util::ffmpeg_command()
            .args(["-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "1", "-ss", &format!("{time:.6}"), "-protocol_whitelist", crate::util::protocols(&self.source)])
            .args(crate::util::url_args(&self.source))
            .arg("-i")
            .arg(&self.source)
            .args([
                "-an",
                "-vf",
                &format!("setpts=PTS-STARTPTS,fps={:.6},scale={wide}:{high}:flags=bicubic,format=bgra,crop={w}:{h}:{x0}:{y0}", self.fps),
                "-threads",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "pipe:1",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
        self.child = Some((crate::util::Watched::new(child), stdout));
        self.next = index;
        self.last = None;
        self.eof = false;
        Ok(())
    }

    /// The region's pixels at frame `index`: read on from the last when it's ahead (within two seconds), else a seek.
    fn frame(&mut self, index: i64) -> Result<Arc<Vec<u8>>, String> {
        use std::io::Read;
        if let Some((at, pixels)) = &self.last {
            if *at == index || (self.eof && *at < index) {
                return Ok(pixels.clone());
            }
        }
        let far = (2.0 * self.fps).ceil() as i64;
        if self.child.is_none() || index < self.next || index - self.next > far {
            self.restart(index)?;
        }
        let bytes = self.cut.w * self.cut.h * 4;
        let mut backed_off = false;
        while !self.eof && self.next <= index {
            let Some((child, stdout)) = self.child.as_mut() else {
                break;
            };
            // Passed-over frames into the spare; the one asked for into its own.
            let target = self.next == index;
            let mut frame = if target {
                vec![0u8; bytes]
            } else {
                std::mem::take(&mut self.spare)
            };
            frame.resize(bytes, 0);
            match stdout.read_exact(&mut frame) {
                Ok(()) => {
                    if target {
                        self.last = Some((self.next, Arc::new(frame)));
                    } else {
                        self.last = None;
                        self.spare = frame;
                    }
                    self.next += 1;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::UnexpectedEof
                        && (self.last.is_some() || self.next > 0 && !self.spare.is_empty()) =>
                {
                    if !child.wait().map_err(|error| error.to_string())?.success() {
                        return Err(format!("decoder failed for {}", self.source.display()));
                    }
                    // The file's end: its last frame held.
                    if self.last.is_none() {
                        self.last =
                            Some((self.next - 1, Arc::new(std::mem::take(&mut self.spare))));
                    }
                    self.eof = true;
                }
                // Asked for its very end: the seek lands past the last frame. A second earlier, its last frame held.
                Err(error)
                    if error.kind() == std::io::ErrorKind::UnexpectedEof
                        && !backed_off
                        && index > 0 =>
                {
                    backed_off = true;
                    self.restart(index - self.fps.round() as i64)?;
                }
                Err(error) => {
                    return Err(format!(
                        "could not decode {}: {error}",
                        self.source.display()
                    ));
                }
            }
        }
        self.last
            .as_ref()
            .map(|(_, pixels)| pixels.clone())
            .ok_or_else(|| format!("could not decode {}: no picture", self.source.display()))
    }
}

/// One stretch of footage read for its words in time order (the server's text_blur.ts): one decode carried forward
/// through it rather than a seek for each read (Nov 19: a compilation's cloud original was opened again every few
/// reads, 2 s a read in all), the frames that may be asked for again (a read between two that differ) kept as it
/// passes them, and a frame that shows what the one read before it did taken as read there (`as_before`); the rest
/// read side by side.
pub struct Stretch {
    #[cfg(target_os = "macos")]
    reader: crate::render::VideoReader,
    #[cfg(not(target_os = "macos"))]
    reader: CropStream,
    fps: f64,
    cut: Cut,
    /// Frames kept to be read later, by index at `fps`.
    kept: BTreeMap<i64, Arc<Vec<u8>>>,
    /// Frames read, by index: what a later read is compared with.
    done: BTreeMap<i64, Done>,
}

impl Stretch {
    /// The words in `region` (x0, y0, x1, y1 as shares of the picture) of `source` (`size` its picture size, `fps` its
    /// rate), read at its own size up to AT_MOST_WIDE across as `read_at` does. Nothing is decoded until read.
    pub fn open(
        source: &Path,
        size: (u32, u32),
        fps: f64,
        region: [f64; 4],
    ) -> Result<Self, String> {
        let cut = Cut::of(size, region)?;
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            30.0
        };
        Ok(Self {
            #[cfg(target_os = "macos")]
            reader: crate::render::VideoReader::analysis_at(source, cut.wide, cut.high, fps),
            #[cfg(not(target_os = "macos"))]
            reader: CropStream::new(source, fps, cut),
            fps,
            cut,
            kept: BTreeMap::new(),
            done: BTreeMap::new(),
        })
    }

    /// The file's frame at `time` (as `VideoReader` picks it).
    fn index(&self, time: f64) -> i64 {
        (time.max(0.0) * self.fps + 0.5 + 1e-7).floor() as i64
    }

    /// `items` (frame indexes, in order) decoded in time order with the frames at `keeping` (those kept before taken
    /// as they are, the frames of `keeping` kept for the next read), each looked at for where its text is
    /// (`gate_of`) side by side as it comes.
    fn decode_and_look(
        &mut self,
        items: &[i64],
        time_of: &BTreeMap<i64, f64>,
        keeping: &BTreeSet<i64>,
    ) -> Result<Vec<Look>, String> {
        let cut = self.cut;
        let wanted: BTreeSet<i64> = items.iter().copied().collect();
        let mut kept = BTreeMap::new();
        let (send, take) = std::sync::mpsc::sync_channel::<(i64, Arc<Vec<u8>>)>(2 * workers());
        // Each worker's own hold on the queue: once they're all gone, a send fails rather than waiting.
        let take = Arc::new(parking_lot::Mutex::new(take));
        let (decoded, looked) = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..workers().min(items.len()).max(1))
                .map(|_| {
                    let (take, cut) = (take.clone(), &cut);
                    scope.spawn(move || -> Result<Vec<Look>, String> {
                        crate::util::background_thread();
                        let mut out = Ok(Vec::new());
                        // Taken until the decode ends, even after a failure (the decode would wait on a full queue).
                        loop {
                            let next = take.lock().recv();
                            let Ok((index, crop)) = next else {
                                return out;
                            };
                            if let Ok(looks) = out.as_mut() {
                                match in_slot(|| gate_of(cut, &crop)) {
                                    Ok(gate) => looks.push(Look {
                                        index,
                                        luma: luma_of(&crop),
                                        crop,
                                        gate,
                                    }),
                                    Err(error) => out = Err(error),
                                }
                            }
                        }
                    })
                })
                .collect();
            drop(take);
            let decoded = (|| -> Result<(), String> {
                #[cfg(target_os = "macos")]
                let mut scratch = Vec::new();
                for (index, time) in time_of {
                    let asked = wanted.contains(index);
                    if !asked && !keeping.contains(index) {
                        continue;
                    }
                    let crop = match self.kept.get(index) {
                        Some(crop) => crop.clone(),
                        #[cfg(target_os = "macos")]
                        None => {
                            cut.crop(self.reader.frame_at(*time)?, &mut scratch)?;
                            Arc::new(scratch.clone())
                        }
                        #[cfg(not(target_os = "macos"))]
                        None => {
                            let _ = time;
                            self.reader.frame(*index)?
                        }
                    };
                    if keeping.contains(index) {
                        kept.insert(*index, crop.clone());
                    }
                    if asked {
                        send.send((*index, crop))
                            .map_err(|_| "text finder crashed".to_owned())?;
                    }
                }
                Ok(())
            })();
            drop(send);
            let looked: Vec<Result<Vec<Look>, String>> = workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|_| Err("text finder crashed".into()))
                })
                .collect();
            (decoded, looked)
        });
        decoded?;
        self.kept = kept;
        let mut looks = Vec::with_capacity(items.len());
        for one in looked {
            looks.extend(one?);
        }
        looks.sort_by_key(|look| look.index);
        if looks.len() != items.len() {
            return Err("a frame wasn't looked at".to_owned());
        }
        Ok(looks)
    }

    /// The words at `times` (source seconds, best in time order and after those read before, as shares of the whole
    /// picture), keeping the frames at `keep` for a later read (any kept before and not in `keep` let go). A time
    /// behind the decode and not kept is a seek. Blocking: call from spawn_blocking.
    pub fn read(&mut self, times: &[f64], keep: &[f64]) -> Result<Vec<Vec<Seen>>, String> {
        let asked: Vec<i64> = times.iter().map(|time| self.index(*time)).collect();
        let keeping: BTreeSet<i64> = keep.iter().map(|time| self.index(*time)).collect();
        let items: Vec<i64> = asked
            .iter()
            .copied()
            .collect::<BTreeSet<i64>>()
            .into_iter()
            .filter(|index| !self.done.contains_key(index))
            .collect();
        // What reads are compared with: the last frame read at or before the first asked now, and all after it.
        if let Some(lowest) = items.iter().chain(&keeping).min() {
            if let Some(floor) = self
                .done
                .range(..=*lowest)
                .next_back()
                .map(|(index, _)| *index)
            {
                self.done = self.done.split_off(&floor);
            }
        }
        // A time for each index (the first asked there), so the reader picks that frame.
        let mut time_of: BTreeMap<i64, f64> = BTreeMap::new();
        for (index, time) in asked.iter().zip(times) {
            time_of.entry(*index).or_insert(*time);
        }
        for index in &keeping {
            time_of.entry(*index).or_insert(*index as f64 / self.fps);
        }
        let cut = self.cut;
        let looks = self.decode_and_look(&items, &time_of, &keeping)?;
        // What each shows the same as: the frame read before it in time (read in this call when it's the later, else
        // the last read before this call), when `as_before`; else it's read.
        enum From {
            Read,
            /// The read before it in this call (its position), or what that one was taken from.
            Here(usize),
            Earlier,
        }
        let earlier: Vec<Option<(i64, Done)>> = items
            .iter()
            .map(|index| {
                self.done
                    .range(..*index)
                    .next_back()
                    .map(|(at, done)| (*at, done.clone()))
            })
            .collect();
        let mut from: Vec<From> = Vec::with_capacity(items.len());
        let mut last: Option<(i64, &Look, usize)> = None;
        for (at, (look, before)) in looks.iter().zip(&earlier).enumerate() {
            let here = last
                .filter(|(index, _, _)| before.as_ref().is_none_or(|(earlier, _)| earlier < index));
            let one = match (here, before) {
                (Some((_, was, root)), _) => {
                    if as_before(
                        &cut,
                        &look.luma,
                        look.gate.as_ref(),
                        (&was.luma, was.gate.as_ref()),
                    ) {
                        From::Here(root)
                    } else {
                        From::Read
                    }
                }
                (None, Some((_, done)))
                    if as_before(
                        &cut,
                        &look.luma,
                        look.gate.as_ref(),
                        (&done.luma, done.gate.as_deref()),
                    ) =>
                {
                    From::Earlier
                }
                _ => From::Read,
            };
            // What a read after this one that shows the same is taken from: this one's own root.
            let root = match one {
                From::Here(root) => root,
                _ => at,
            };
            from.push(one);
            last = Some((look.index, look, root));
        }
        // The reads to make, side by side; the rest as the read they show the same as.
        let fresh: Vec<(&Look, Option<&Done>)> = looks
            .iter()
            .zip(&from)
            .zip(&earlier)
            .filter(|((_, from), _)| matches!(from, From::Read))
            .map(|((look, _), before)| (look, before.as_ref().map(|(_, done)| done)))
            .collect();
        let mut read = side_by_side(&fresh, |(look, before)| {
            read_knowing(&cut, &look.crop, &look.luma, look.gate.as_ref(), *before).map(Arc::new)
        })?
        .into_iter();
        let mut lines: Vec<Arc<Vec<Line>>> = Vec::with_capacity(items.len());
        for (one, before) in from.iter().zip(&earlier) {
            let these = match one {
                From::Read => read.next(),
                From::Earlier => before.as_ref().map(|(_, done)| done.lines.clone()),
                From::Here(root) => lines.get(*root).cloned(),
            };
            lines.push(these.ok_or("a frame wasn't read")?);
        }
        for (look, lines) in looks.into_iter().zip(lines) {
            self.done.insert(
                look.index,
                Done {
                    luma: Arc::new(look.luma),
                    lines,
                    gate: look.gate.map(Arc::new),
                },
            );
        }
        asked
            .iter()
            .map(|index| {
                self.done
                    .get(index)
                    .map(|done| self.cut.seen(done.lines.as_ref().clone()))
                    .ok_or_else(|| "a frame wasn't read".to_owned())
            })
            .collect()
    }
}

/// The text read in `source` so far, without looking at anything new (the audit).
pub fn cached(source: &Path) -> Option<Texts> {
    let file = crate::util::media_cache(source)?.join(FILE);
    let found: Found = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    Some(found.samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey `w`×`h` luma with a white bar (a line of words) over `x0..x1`, rows 20–40.
    fn picture(w: usize, h: usize, x0: usize, x1: usize) -> Vec<u8> {
        let mut out = vec![90u8; w * h];
        for y in 20..40 {
            for x in x0..x1 {
                out[y * w + x] = 240;
            }
        }
        out
    }

    /// However many stretches read at once, each with its workers, the text model runs in at most `slots` at a time.
    #[test]
    fn text_model_runs_across_stretches_stay_within_their_slots() {
        let ran = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..3 * workers() * 2 {
                scope.spawn(|| {
                    in_slot(|| {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        ran.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    });
                });
            }
        });
        assert_eq!(ran.into_inner(), 3 * workers() * 2);
        let most = MOST.load(std::sync::atomic::Ordering::Relaxed);
        assert!(
            most <= slots() && most >= 1,
            "{most} at once, {} slots",
            slots()
        );
        assert_eq!(*BUSY.lock(), 0);
        #[cfg(target_os = "linux")]
        assert!((2..=6).contains(&slots()));
    }

    #[test]
    fn the_same_line_read_again_is_alike_and_a_letter_more_is_not() {
        let (w, h) = (400, 60);
        let line = picture(w, h, 50, 300);
        // Compression's noise: every pixel a little off.
        let noisy: Vec<u8> = line
            .iter()
            .enumerate()
            .map(|(at, v)| v.saturating_add((at % 3) as u8))
            .collect();
        assert!(alike(&line, &noisy, w, [0, 0, w, h]));
        // A letter more at its end (15 px across): hundreds of pixels changed.
        let longer = picture(w, h, 50, 315);
        assert!(!alike(&line, &longer, w, [0, 0, w, h]));
        assert!(!alike(&line, &longer, w, [40, 10, 330, 50]));
        // Away from it, nothing changed.
        assert!(alike(&line, &longer, w, [0, 45, w, h]));
    }

    #[test]
    fn strips_round_the_places_found_are_whole_steps_high_and_joined_where_they_meet() {
        // A line at half size rows 40–55: 80–110 doubled, 64 more each side, 16–174 → 192 high.
        // Most of a 220-high crop: looked at whole.
        assert_eq!(strips_of(&[[10, 40, 200, 55]], 220), None);
        let tall = 1000;
        assert_eq!(strips_of(&[[10, 40, 200, 55]], tall), Some(vec![(0, 192)]));
        // Two lines stacked tight are one strip; one far below is its own.
        let strips = strips_of(
            &[
                [10, 200, 200, 215],
                [10, 218, 200, 233],
                [10, 450, 200, 465],
            ],
            tall,
        )
        .unwrap();
        assert_eq!(strips.len(), 2);
        assert!(strips
            .iter()
            .all(|(y0, y1)| (y1 - y0) % 64 == 0 && *y1 <= tall));
        assert!(strips[0].0 <= 400 - 64 && strips[0].1 >= 466 + 64);
        assert!(strips[1].0 <= 900 - 64 && strips[1].1 >= 930 + 64);
        // No place found: nothing to look at.
        assert_eq!(strips_of(&[], tall), Some(vec![]));
    }

    #[test]
    fn a_frame_is_as_before_when_its_text_is_where_it_was_with_the_same_pixels_whatever_moves_round_it(
    ) {
        let cut = Cut {
            wide: 1920,
            high: 1080,
            x0: 0,
            y0: 0,
            w: 400,
            h: 60,
        };
        let was = picture(400, 60, 50, 300);
        let gate = vec![[25, 10, 150, 20]];
        // The picture round the line changed (the camera moved), the line didn't.
        let mut moved = was.clone();
        for value in moved.iter_mut().take(400 * 15) {
            *value = 10;
        }
        assert!(!alike(&moved, &was, 400, [0, 0, 400, 60]));
        assert!(as_before(&cut, &moved, Some(&gate), (&was, Some(&gate))));
        // Its words changed in place: read again.
        let other = picture(400, 60, 50, 280);
        assert!(!as_before(&cut, &other, Some(&gate), (&was, Some(&gate))));
        // A line more found, or one moved by more than a pixel at half size: read again.
        assert!(!as_before(
            &cut,
            &moved,
            Some(&vec![[25, 10, 150, 20], [25, 0, 60, 8]]),
            (&was, Some(&gate))
        ));
        assert!(!as_before(
            &cut,
            &moved,
            Some(&vec![[28, 10, 150, 20]]),
            (&was, Some(&gate))
        ));
        // Without where its text is (a Mac, a small picture), only a crop that didn't change at all.
        assert!(!as_before(&cut, &moved, None, (&was, None)));
        assert!(as_before(&cut, &was.clone(), None, (&was, None)));
    }
}
