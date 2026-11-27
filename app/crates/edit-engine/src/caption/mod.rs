//! Their captions out of a stretch the still clean can't take (a moving camera, or a room never seen clear), on this
//! computer, free: each caption's letters found, the style's soft shadow brightened back instead of erased (what was
//! behind it is still in the picture: legs, a basket, a shoe), only the letters and the darkest of their outline filled
//! by LaMa, and the fill steadied along the camera's motion so it doesn't shimmer.
//!
//! Built Nov 25 to replace MiniMax on RunPod (slow, failing, paid): judged by eye on four moving bodycam stretches and the
//! Hitman notepad stretch ("this feels almost like vmake"), and scored against three stretches whose true picture under
//! the caption is known (caption-removal-trial/score.py). Ported from caption-removal-trial/remove.py.
//!
//! Takes the still clean's job (`still::Job`) and answers the same way: the stacked see-through strip of the captions'
//! band at `job.out`, and {"box": shares, "inferred": frames LaMa filled, "style", "provider"}.
#![allow(clippy::indexing_slicing)] // per-pixel loops over one band, in range by construction

mod blur;
mod lama;
pub mod shadow;

use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::still::pixels::{self, Img, Mask, Rgb};
use crate::still::{band_of, check, Frames, Job, Strip};

/// Asked between frames whether to stop, from more than one stage at once.
pub type SyncStop<'a> = &'a (dyn Fn() -> bool + Sync);
use crate::watermark::flow::dis;
use crate::watermark::plane::{harmonic_fill, Plane};
use shadow::REACH;

/// Frames looked at for the style: about this many, spread over the stretch.
const SAMPLES: usize = 8;
/// Steadying: the share of the previous cleaned frame (moved along the camera's motion) kept where the two agree.
const MIX: f32 = 0.5;
/// The strip's alpha feathered this much.
const FEATHER: usize = 5;

/// When a fill is carried to the next frame instead of LaMa filling it afresh.
#[derive(Clone, Copy, Debug)]
pub struct Tuning {
    /// The most frames in a row a fill is carried on a camera that moves (each carry resamples it a little).
    pub key_moving: usize,
    /// ...and on one that doesn't (an exact copy).
    pub key_still: usize,
    /// The most what's carried may differ from the frame just outside the hole (mean, 0-255, in any strip).
    pub agree: f32,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            // Nov 25, four bodycam stretches, the notepad and three known-answer ones: 4 and 45 kept the scores within 0.4
            // of a fresh fill every frame, with 15 of 120 frames filled on the still camera.
            key_moving: 4,
            key_still: 45,
            agree: 3.0,
        }
    }
}

/// Where a stretch's time went, by step (seconds).
#[derive(Default)]
struct Clock {
    at: Option<std::time::Instant>,
    spent: Vec<(&'static str, f64)>,
}

/// A frame on its way from the front stage to the middle: no caption on it, or brightened with its hole.
enum Prepared {
    Clear,
    Captioned {
        res: Rgb,
        hole: Mask,
        near: Mask,
        gray: Plane,
    },
}

/// The most frames brightened at once (a quarter of the cores, at least two).
const BRIGHTEN_AT_ONCE: usize = 8;

/// One frame's letters undone where they darkened it (`area`, the stretch's band): the frame brightened back, the
/// hole LaMa fills, the rim around it, and the frame's grey for the motion; Clear with no letters on it.
fn brighten(
    frame: Rgb,
    s: Mask,
    area: Option<(usize, usize, usize, usize)>,
    style: &shadow::Style,
    scale: f32,
    w: usize,
    rows: usize,
) -> Prepared {
    let Some((ax0, ay0, ax1, ay1)) = area else {
        return Prepared::Clear;
    };
    let (undone, hole_c, near_c) = shadow::undo(
        &frame.crop(ax0, ay0, ax1, ay1),
        &s.crop(ax0, ay0, ax1, ay1),
        style,
        scale,
    );
    let mut res = frame.clone();
    res.paste(ax0, ay0, &undone);
    let mut hole: Mask = Img::filled(w, rows, false);
    hole.paste(ax0, ay0, &hole_c);
    let mut near: Mask = Img::filled(w, rows, false);
    near.paste(ax0, ay0, &near_c);
    let gray = luma_plane(&frame);
    Prepared::Captioned {
        res,
        hole,
        near,
        gray,
    }
}

impl Clock {
    /// Another stage's time added in (the stages overlap: the sum is work, not the stretch's wall time).
    fn add(&mut self, other: &Self) {
        for (name, took) in &other.spent {
            if *name == "start" {
                continue;
            }
            match self.spent.iter_mut().find(|(one, _)| one == name) {
                Some((_, sum)) => *sum += took,
                None => self.spent.push((name, *took)),
            }
        }
    }

    fn tick(&mut self, name: &'static str) {
        let now = std::time::Instant::now();
        let took = self.at.map_or(0.0, |at| (now - at).as_secs_f64());
        self.at = Some(now);
        match self.spent.iter_mut().find(|(one, _)| *one == name) {
            Some((_, sum)) => *sum += took,
            None => self.spent.push((name, took)),
        }
    }

    fn seconds(&self) -> Value {
        Value::Object(
            self.spent
                .iter()
                .map(|(name, sum)| ((*name).to_owned(), json!((sum * 100.0).round() / 100.0)))
                .collect(),
        )
    }
}

/// The model, loaded once and kept (an ONNX Runtime session on the GPU takes seconds to make).
static MODEL: Mutex<Option<(std::path::PathBuf, lama::Lama)>> = Mutex::new(None);

fn boxes_of(job: &Job) -> Vec<Vec<[f64; 4]>> {
    job.masks
        .iter()
        .map(|boxes| {
            boxes
                .iter()
                .filter_map(|one| Some([*one.first()?, *one.get(1)?, *one.get(2)?, *one.get(3)?]))
                .collect()
        })
        .collect()
}

/// The area a frame's caption work is done in (band rows): its boxes and what the shadow reaches, with room to spare.
fn area_of(
    boxes: &[[f64; 4]],
    y0: usize,
    w: usize,
    rows: usize,
    margin: f64,
) -> Option<(usize, usize, usize, usize)> {
    if boxes.is_empty() {
        return None;
    }
    let x0 = boxes.iter().map(|b| b[0]).fold(f64::MAX, f64::min) - margin;
    let x1 = boxes.iter().map(|b| b[2]).fold(f64::MIN, f64::max) + margin;
    let top = boxes.iter().map(|b| b[1]).fold(f64::MAX, f64::min) - y0 as f64 - margin;
    let bottom = boxes.iter().map(|b| b[3]).fold(f64::MIN, f64::max) - y0 as f64 + margin;
    let clamp = |v: f64, n: usize| v.round().clamp(0.0, n as f64) as usize;
    let (x0, x1, a, b) = (
        clamp(x0, w),
        clamp(x1, w),
        clamp(top, rows),
        clamp(bottom, rows),
    );
    (x1 > x0 && b > a).then_some((x0, a, x1, b))
}

/// The frame's boxes moved into band rows.
fn in_band(boxes: &[[f64; 4]], y0: usize) -> Vec<[f64; 4]> {
    boxes
        .iter()
        .map(|b| [b[0], b[1] - y0 as f64, b[2], b[3] - y0 as f64])
        .collect()
}

fn luma_plane(picture: &Rgb) -> Plane {
    Plane {
        w: picture.w,
        h: picture.h,
        data: picture
            .v
            .iter()
            .map(|&px| f32::from(pixels::luma(px)))
            .collect(),
    }
}

/// The previous frame's cleaned band moved onto this frame along the camera's motion, round this frame's hole: what
/// carries a fill from frame to frame, and what steadies a fresh one. Motion is read at half size round the hole and
/// closed in under the letters (the caption stands still while the picture moves); a camera that doesn't move gets
/// none at all, so what's carried is an exact copy and doesn't soften frame after frame.
struct Carried {
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
    before: [Plane; 3],
    /// Whether each pixel's source is inside the last frame's band.
    inside: Vec<bool>,
    /// The camera didn't move (nothing was moved: an exact copy).
    still: bool,
}

fn carried(
    prev: &(Plane, Rgb, Mask),
    gray_now: &Plane,
    hole: &Mask,
    scale: f32,
) -> Option<Carried> {
    let (w, h) = (hole.w, hole.h);
    let (prev_gray, prev_clean, prev_hole) = prev;
    let wm = |m: &Mask| crate::watermark::plane::Mask {
        w: m.w,
        h: m.h,
        data: m.v.clone(),
    };
    let (bx0, by0, bx1, by1) = wm(hole).bounds()?;
    let under: Mask = hole.zip(prev_hole, |a, b| a || b);
    let under = pixels::dilate(&under, &pixels::Kernel::rect(9, 9));
    let (ux0, uy0, ux1, uy1) = wm(&under).bounds()?;
    let reach = (64.0 * scale) as usize;
    let (rx0, ry0) = (ux0.saturating_sub(reach), uy0.saturating_sub(reach));
    let (rx1, ry1) = ((ux1 + reach).min(w), (uy1 + reach).min(h));
    let (rw, rh) = (rx1 - rx0, ry1 - ry0);
    let cut = |p: &Plane| p.crop(rx0 as isize, ry0 as isize, rw, rh);
    let flow = dis(&cut(gray_now), &cut(prev_gray));
    let under_half = Plane {
        w: rw,
        h: rh,
        data: under
            .crop(rx0, ry0, rx1, ry1)
            .v
            .iter()
            .map(|&v| if v { 1.0 } else { 0.0 })
            .collect(),
    }
    .half()
    .mask(|v| v > 0.0);
    // A camera that doesn't move: its flow is noise, which would soften what's carried a little every frame.
    let mut moves: Vec<f32> = flow
        .u
        .data
        .iter()
        .zip(&flow.v.data)
        .zip(&under_half.data)
        .filter(|(_, &u)| !u)
        .map(|((&a, &b), _)| a.abs().max(b.abs()))
        .collect();
    moves.sort_by(f32::total_cmp);
    let still = moves.get(moves.len() / 2).is_none_or(|&m| m < 0.15);
    let flow = if still {
        crate::watermark::flow::Flow::zero(rw, rh)
    } else {
        crate::watermark::flow::Flow {
            u: harmonic_fill(&flow.u, &under_half),
            v: harmonic_fill(&flow.v, &under_half),
        }
        .resized(rw, rh)
    };
    // Round the hole, and the rings outside it its agreement is judged on.
    let pad = (32.0 * scale) as usize;
    let (x0, y0) = (
        bx0.saturating_sub(pad).max(rx0),
        by0.saturating_sub(pad).max(ry0),
    );
    let (x1, y1) = ((bx1 + pad).min(rx1), (by1 + pad).min(ry1));
    let (cw, ch) = (x1 - x0, y1 - y0);
    let prev_planes = shadow::planes(&prev_clean.crop(rx0, ry0, rx1, ry1));
    let mut before = [
        Plane::new(cw, ch, 0.0),
        Plane::new(cw, ch, 0.0),
        Plane::new(cw, ch, 0.0),
    ];
    let mut inside = vec![false; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let (lx, ly) = (x0 + x - rx0, y0 + y - ry0);
            let (u, v) = if still {
                (0.0, 0.0)
            } else {
                (flow.u.at(lx, ly), flow.v.at(lx, ly))
            };
            let (mx, my) = (lx as f32 + u, ly as f32 + v);
            let (gx, gy) = (rx0 as f32 + mx, ry0 as f32 + my);
            inside[y * cw + x] =
                gx >= 0.0 && gy >= 0.0 && gx <= (w - 1) as f32 && gy <= (h - 1) as f32;
            for c in 0..3 {
                before[c].set(x, y, prev_planes[c].sample(mx, my));
            }
        }
    }
    Some(Carried {
        x0,
        y0,
        w: cw,
        h: ch,
        before,
        inside,
        still,
    })
}

/// Whether what's carried still lines up with this frame where both can be seen, as well as the picture a little
/// further out lines up with itself (a moving, compressed picture never matches its last frame exactly): the ring just
/// outside the hole against one beyond it, strip by strip across the caption so a hand crossing one word is caught.
fn agrees(carry: &Carried, res: &Rgb, hole: &Mask, scale: f32, most: f32) -> bool {
    let local = hole.crop(carry.x0, carry.y0, carry.x0 + carry.w, carry.y0 + carry.h);
    let dist = shadow::distance_to(&local);
    let (near_lo, near_hi, far_lo, far_hi) =
        (2.0 * scale, 10.0 * scale, 14.0 * scale, 30.0 * scale);
    let strip = ((96.0 * scale) as usize).max(16);
    // Per strip: (near sum, near count, far sum, far count).
    let mut sums = vec![(0f32, 0usize, 0f32, 0usize); carry.w / strip + 1];
    for y in 0..carry.h {
        for x in 0..carry.w {
            let k = y * carry.w + x;
            let d = dist.data[k];
            let near = d > near_lo && d <= near_hi;
            let far = d > far_lo && d <= far_hi;
            if !(near || far) || !carry.inside[k] {
                continue;
            }
            let now = res.at(carry.x0 + x, carry.y0 + y);
            let diff = (0..3)
                .map(|c| (carry.before[c].at(x, y) - f32::from(now[c])).abs())
                .sum::<f32>()
                / 3.0;
            let slot = &mut sums[x / strip];
            if near {
                slot.0 += diff;
                slot.1 += 1;
            } else {
                slot.2 += diff;
                slot.3 += 1;
            }
        }
    }
    sums.iter().all(|&(near, n, far, m)| {
        n < 20 || m < 20 || near / n as f32 <= 1.5 * far / m as f32 + most
    })
}

/// This frame's hole taken from what's carried; false (nothing changed) where any of it has no source.
fn carry_into(carry: &Carried, res: &mut Rgb, hole: &Mask) -> bool {
    for y in 0..carry.h {
        for x in 0..carry.w {
            if hole.at(carry.x0 + x, carry.y0 + y) && !carry.inside[y * carry.w + x] {
                return false;
            }
        }
    }
    for y in 0..carry.h {
        for x in 0..carry.w {
            let (gx, gy) = (carry.x0 + x, carry.y0 + y);
            if hole.at(gx, gy) {
                res.set(
                    gx,
                    gy,
                    [0, 1, 2].map(|c| carry.before[c].at(x, y).round().clamp(0.0, 255.0) as u8),
                );
            }
        }
    }
    true
}

/// A fresh fill steadied: mixed with what's carried where the two agree (where they don't, something moved, and the
/// fresh fill stays).
fn steady(carry: &Carried, res: &mut Rgb, hole: &Mask) {
    let mut apart = Plane::new(carry.w, carry.h, 0.0);
    for y in 0..carry.h {
        for x in 0..carry.w {
            let now = res.at(carry.x0 + x, carry.y0 + y);
            let diff = (0..3)
                .map(|c| (carry.before[c].at(x, y) - f32::from(now[c])).abs())
                .sum::<f32>()
                / 3.0;
            apart.set(x, y, diff);
        }
    }
    let apart = blur::gaussian(&apart, 3.0);
    for y in 0..carry.h {
        for x in 0..carry.w {
            let (gx, gy) = (carry.x0 + x, carry.y0 + y);
            if !hole.at(gx, gy) || !carry.inside[y * carry.w + x] {
                continue;
            }
            let mix = MIX * ((70.0 - apart.at(x, y)) / 35.0).clamp(0.0, 1.0);
            if mix <= 0.0 {
                continue;
            }
            let fresh = res.at(gx, gy);
            let px = [0, 1, 2].map(|c| {
                (f32::from(fresh[c]) * (1.0 - mix) + carry.before[c].at(x, y) * mix)
                    .round()
                    .clamp(0.0, 255.0) as u8
            });
            res.set(gx, gy, px);
        }
    }
}

/// LaMa on the hole's box and a margin round it (the crop to eights done by the model).
fn fill(model: &mut lama::Lama, picture: &mut Rgb, hole: &Mask, scale: f32) -> Result<(), String> {
    let Some((x0, y0, x1, y1)) = crate::watermark::plane::Mask {
        w: hole.w,
        h: hole.h,
        data: hole.v.clone(),
    }
    .bounds() else {
        return Ok(());
    };
    let m = (48.0 * scale) as usize;
    let (x0, y0) = (x0.saturating_sub(m) / 8 * 8, y0.saturating_sub(m) / 8 * 8);
    let (x1, y1) = (
        ((x1 + m).div_ceil(8) * 8).min(picture.w),
        ((y1 + m).div_ceil(8) * 8).min(picture.h),
    );
    let crop = picture.crop(x0, y0, x1, y1);
    let filled = model.fill(&crop, &hole.crop(x0, y0, x1, y1))?;
    picture.paste(x0, y0, &filled);
    Ok(())
}

/// Cleans the stretch `job` asks for with the LaMa at `model`: the strip at `job.out` and {"box", "inferred", "style",
/// "provider"}. Runs on the calling thread; `stopped` is asked between frames.
pub fn clean(job: &Job, model: &Path, stopped: SyncStop<'_>) -> Result<Value, String> {
    clean_with(job, model, Tuning::default(), stopped)
}

/// `clean` with its carrying tuned.
pub fn clean_with(
    job: &Job,
    model: &Path,
    tuning: Tuning,
    stopped: SyncStop<'_>,
) -> Result<Value, String> {
    let (w, h, fps) = (job.width as usize, job.height as usize, job.fps);
    if w < 16 || h < 16 || fps.is_nan() || fps <= 0.0 {
        return Err("the stretch has no picture size or rate".to_owned());
    }
    // A watermark already taken out under these seconds would come back where the caption's strip is laid: not taken
    // here (the strips under it aren't laid first, as minimax_worker.py does).
    if !job.beneath.is_empty() {
        return Err("a cleaned watermark is under it".to_owned());
    }
    let masks = boxes_of(job);
    let total = masks.len();
    let Some((y0, y1)) = band_of(&masks, h) else {
        return Ok(json!({"box": null, "inferred": 0}));
    };
    let rows = y1 - y0;
    let mut clock = Clock::default();
    clock.tick("start");
    let letters_scale = h as f64 / 1080.0;
    let scale = h as f32 / 720.0;
    let margin = f64::from((REACH + 40.0) * scale);

    // The style, from a few frames spread over the stretch.
    let with_boxes: Vec<usize> = (0..total).filter(|&i| !masks[i].is_empty()).collect();
    let step = (with_boxes.len() / (SAMPLES * 2)).max(1);
    let wanted: Vec<usize> = with_boxes.iter().copied().step_by(step).collect();
    let mut samples = Vec::new();
    {
        let mut source = Frames::band(job, total, w, y0, y1)?;
        let mut at = 0usize;
        let mut next = wanted.iter().peekable();
        while let Some(&&want) = next.peek() {
            check(stopped)?;
            let Some(frame) = source.next(stopped)? else {
                break;
            };
            if at == want {
                next.next();
                let boxes = in_band(&masks[at], y0);
                if let Some((ax0, ay0, ax1, ay1)) = area_of(&masks[at], y0, w, rows, margin) {
                    let mut s: Mask = Img::filled(w, rows, false);
                    shadow::strokes_in(&frame, &boxes, letters_scale, &mut s);
                    if let Some(one) = shadow::sample(
                        &frame.crop(ax0, ay0, ax1, ay1),
                        &s.crop(ax0, ay0, ax1, ay1),
                        scale,
                    ) {
                        samples.push(one);
                    }
                }
                if samples.len() >= SAMPLES {
                    break;
                }
            }
            at += 1;
        }
    }
    clock.tick("style frames");
    let Some((style, fit_error, no_shadow)) = shadow::fit(&samples) else {
        return Err("no caption letters found to clean".to_owned());
    };

    // The model is loaded once and kept; it's held only for each frame it fills, so two stretches cleaned at once share
    // it, and one's reading, motion and levelling go on while the other's frame is filled (Nov 27, mandalorian: held
    // for a whole stretch, a second lane only waited, while LaMa was 124 s of a 472 s stretch and the 4060 idled).
    let provider = {
        let mut guard = MODEL
            .lock()
            .map_err(|_| "the model's lock was poisoned".to_owned())?;
        if guard.as_ref().is_none_or(|(path, _)| path != model) {
            *guard = Some((model.to_path_buf(), lama::Lama::load(model)?));
        }
        let Some((_, lama)) = guard.as_ref() else {
            return Err("the model didn't load".to_owned());
        };
        lama.provider
    };
    clock.tick("fit and model");

    // Three stages a frame apart, so the slowest sets the pace instead of their sum: the front reads each frame, finds
    // its letters and brightens it (no frame depends on another there); the middle carries or fills and levels, in
    // order (a carry needs the last frame's result); the back makes the strip's alpha and writes it.
    let source = Frames::band(job, total, w, y0, y1)?;
    let strip = Strip::open(Path::new(&job.out), w, rows, fps)?;
    let (to_middle, from_front) = std::sync::mpsc::sync_channel::<Prepared>(3);
    let (to_back, from_middle) = std::sync::mpsc::sync_channel::<Option<(Rgb, Mask)>>(3);
    let (mut inferred, mut carried_frames, mut age) = (0usize, 0usize, 0usize);
    let (front, middle, back) = std::thread::scope(|scope| {
        let front = scope.spawn(|| {
            let mut source = source;
            let mut clock = Clock::default();
            clock.tick("start");
            let mut read = 0usize;
            // Each frame's brightening on a thread of its own, several frames at once, handed on in order: no frame
            // depends on another here, and one thread at a time was the stretch's pace (Nov 27, mandalorian: 692 s of a
            // 23 s stretch's 790, 0.75 s a frame on a 1920x936 band, while LaMa waited 489 s for it and the 4060 idled).
            let at_once = std::thread::available_parallelism()
                .map_or(4, |n| n.get() / 4)
                .clamp(2, BRIGHTEN_AT_ONCE);
            let mut pending: std::collections::VecDeque<
                std::thread::ScopedJoinHandle<'_, Prepared>,
            > = std::collections::VecDeque::new();
            let mut open = true;
            let style = &style;
            while read < total && open {
                check(stopped)?;
                let Some(frame) = source.next(stopped)? else {
                    break;
                };
                clock.tick("decode");
                let boxes = in_band(&masks[read], y0);
                let mut s: Mask = Img::filled(w, rows, false);
                if !boxes.is_empty() {
                    shadow::strokes_in(&frame, &boxes, letters_scale, &mut s);
                }
                clock.tick("letters");
                let area = area_of(&masks[read], y0, w, rows, margin).filter(|_| s.any());
                pending.push_back(
                    scope.spawn(move || brighten(frame, s, area, style, scale, w, rows)),
                );
                read += 1;
                if pending.len() >= at_once {
                    let Some(oldest) = pending.pop_front() else {
                        break;
                    };
                    let prepared = oldest.join().map_err(|payload| {
                        crate::util::crashed("brightening a frame", &*payload)
                    })?;
                    clock.tick("brighten");
                    open = to_middle.send(prepared).is_ok();
                }
            }
            for one in pending {
                let prepared = one
                    .join()
                    .map_err(|payload| crate::util::crashed("brightening a frame", &*payload))?;
                clock.tick("brighten");
                if open {
                    open = to_middle.send(prepared).is_ok();
                }
            }
            drop(to_middle);
            Ok::<_, String>((read, clock))
        });
        let back = scope.spawn(move || {
            let mut strip = strip;
            let mut clock = Clock::default();
            clock.tick("start");
            for one in from_middle {
                match one {
                    None => strip.write(None)?,
                    Some((res, changed)) => {
                        let alpha = pixels::alpha_of(&changed, FEATHER);
                        strip.write(Some((&res, &alpha)))?;
                    }
                }
                clock.tick("write");
            }
            Ok::<_, String>((strip, clock))
        });
        let middle = (|| -> Result<Clock, String> {
            let mut clock = Clock::default();
            clock.tick("start");
            let mut prev: Option<(Plane, Rgb, Mask)> = None;
            for one in from_front {
                check(stopped)?;
                let Prepared::Captioned {
                    mut res,
                    hole,
                    near,
                    gray,
                } = one
                else {
                    prev = None;
                    if to_back.send(None).is_err() {
                        break;
                    }
                    continue;
                };
                clock.tick("waiting");
                if hole.any() {
                    let carry = prev
                        .as_ref()
                        .and_then(|before| carried(before, &gray, &hole, scale));
                    clock.tick("motion");
                    let age_ok = carry.as_ref().is_some_and(|one| {
                        age < if one.still {
                            tuning.key_still
                        } else {
                            tuning.key_moving
                        }
                    });
                    let carried_in = age_ok
                        && carry
                            .as_ref()
                            .is_some_and(|one| agrees(one, &res, &hole, scale, tuning.agree))
                        && carry
                            .as_ref()
                            .is_some_and(|one| carry_into(one, &mut res, &hole));
                    if carried_in {
                        age += 1;
                        carried_frames += 1;
                    } else {
                        {
                            let mut guard = MODEL
                                .lock()
                                .map_err(|_| "the model's lock was poisoned".to_owned())?;
                            let Some((_, lama)) = guard.as_mut() else {
                                return Err("the model went away".to_owned());
                            };
                            fill(lama, &mut res, &hole, scale)?;
                        }
                        clock.tick("lama");
                        inferred += 1;
                        age = 0;
                        if let Some(one) = &carry {
                            steady(one, &mut res, &hole);
                        }
                    }
                    shadow::level(&mut res, &hole, &near);
                    clock.tick("level");
                }
                let changed: Mask = near.zip(&hole, |a, b| a || b);
                if to_back.send(Some((res.clone(), changed))).is_err() {
                    break;
                }
                prev = Some((gray, res, hole));
            }
            Ok(clock)
        })();
        drop(to_back);
        let back = back
            .join()
            .map_err(|_| "the strip's writer stopped".to_owned())
            .and_then(|one| one);
        let front = front
            .join()
            .map_err(|_| "the frame reader stopped".to_owned())
            .and_then(|one| one);
        (front, middle, back)
    });
    let strip = match back {
        Ok((strip, write_clock)) => {
            clock.add(&write_clock);
            strip
        }
        Err(error) => return Err(error),
    };
    let fail = |strip: Strip, error: String| -> Result<Value, String> {
        strip.abandon();
        Err(error)
    };
    let written = match (front, middle) {
        (Ok((read, front_clock)), Ok(middle_clock)) => {
            clock.add(&front_clock);
            clock.add(&middle_clock);
            read
        }
        (Err(error), _) | (_, Err(error)) => return fail(strip, error),
    };
    if written < total {
        return fail(
            strip,
            format!(
                "the footage ended {} frames before the stretch did",
                total - written
            ),
        );
    }
    strip.finish()?;
    Ok(json!({
        "box": [0.0, y0 as f64 / h as f64, 1.0, y1 as f64 / h as f64],
        "inferred": inferred,
        "carried": carried_frames,
        "style": style,
        "fit": [(fit_error * 1000.0).round() / 1000.0, (no_shadow * 1000.0).round() / 1000.0],
        "provider": provider,
        "seconds": clock.seconds(),
    }))
}
