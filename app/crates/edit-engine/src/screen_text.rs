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
            let lines = crate::mac_media::text(bgra, wide, high)?;
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
/// reads). Boxes are shares of the whole picture, in `times`' order.
/// Blocking: call from spawn_blocking.
pub fn read_at(
    source: &Path,
    (width, height): (u32, u32),
    fps: f64,
    region: [f64; 4],
    times: &[f64],
) -> Result<Vec<Vec<Seen>>, String> {
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
    let (crop_w, crop_h) = (x1 - x0, y1 - y0);
    // Read in time order, a stretch per thread, then put back in the order asked.
    let mut order: Vec<usize> = (0..times.len()).collect();
    let time = |at: usize| times.get(at).copied().unwrap_or(0.0);
    order.sort_by(|a, b| time(*a).total_cmp(&time(*b)));
    let parts = order.len().div_ceil(8).clamp(1, 3);
    let chunk = order.len().div_ceil(parts).max(1);
    // Each time's index in `times` and what was read there.
    type Part = Vec<(usize, Vec<Seen>)>;
    let read = |part: &[usize]| -> Result<Part, String> {
        let mut reader = crate::render::VideoReader::analysis_at(source, wide, high, fps);
        let mut crop = vec![0u8; crop_w * crop_h * 4];
        let mut out = Vec::with_capacity(part.len());
        for &at in part {
            let bgra = reader.frame_at(time(at).max(0.0))?;
            let stride = wide as usize * 4;
            for (row, line) in crop.chunks_exact_mut(crop_w * 4).enumerate() {
                let from = (y0 + row) * stride + x0 * 4;
                let Some(pixels) = bgra.get(from..from + crop_w * 4) else {
                    return Err("the frame is smaller than its size".to_owned());
                };
                line.copy_from_slice(pixels);
            }
            #[cfg(target_os = "macos")]
            let lines = crate::mac_media::text(&crop, crop_w as u32, crop_h as u32)?;
            #[cfg(not(target_os = "macos"))]
            let lines = crate::text_model::text(&crop, crop_w as u32, crop_h as u32)?;
            let to_frame = |value: f32, from: usize, across: usize, whole: u32| {
                let at = (from as f64 + f64::from(value).clamp(0.0, 1.0) * across as f64)
                    / f64::from(whole);
                (at * 1000.0).round() / 1000.0
            };
            let seen = lines
                .into_iter()
                .filter(|(_, sure, _)| *sure >= SURE)
                .map(|(b, _, t)| Seen {
                    b: [
                        to_frame(b[0], x0, crop_w, wide),
                        to_frame(b[1], y0, crop_h, high),
                        to_frame(b[2], x0, crop_w, wide),
                        to_frame(b[3], y0, crop_h, high),
                    ],
                    t,
                })
                .collect();
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

/// The text read in `source` so far, without looking at anything new (the audit).
pub fn cached(source: &Path) -> Option<Texts> {
    let file = crate::util::media_cache(source)?.join(FILE);
    let found: Found = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    Some(found.samples)
}
