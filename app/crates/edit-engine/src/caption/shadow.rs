//! A caption's letters and its shadow: the white strokes, the style's shadow fitted to the footage, and each frame's
//! shadow brightened back with the hole LaMa fills. Ported from caption-removal-trial/remove.py (Nov 25, judged by eye on
//! four moving bodycam stretches and the Hitman notepad stretch, and scored on three known-answer stretches).
#![allow(clippy::indexing_slicing)] // per-pixel loops over pictures of one size, in range by construction

use super::blur::gaussian;
use crate::still::pixels::{self, gray, hsv, Img, Kernel, Mask, Rgb};
use crate::watermark::find::distance;
use crate::watermark::plane::{self as wplane, Plane};

/// Nothing farther than this from a letter (at 720 lines) is ever changed.
pub const REACH: f32 = 30.0;
/// Where the shadow leaves less than this much of the picture, it goes in the hole.
const TOO_DARK: f32 = 0.5;
/// ...and where a 1 px misfit of the fitted shadow would be off by this much brightness.
const STEEP: f32 = 0.08;
/// The hole grown by this much (px at 720 lines) before LaMa.
const GROW_HOLE: usize = 1;
/// The 1 px rings just outside the hole matched to the picture beyond them.
const RIM: usize = 4;
/// How far out from the hole the fill's coarse brightness is matched to.
const LEVEL_FROM: usize = 6;

/// The style's shadow: darkening = min(cap, k · blur(letters grown by `grow`, sigma)), at 720 lines.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Style {
    pub k: f32,
    pub sigma: f32,
    pub grow: usize,
    pub cap: f32,
}

fn as_wmask(mask: &Mask) -> wplane::Mask {
    wplane::Mask {
        w: mask.w,
        h: mask.h,
        data: mask.v.clone(),
    }
}

fn plane_of(mask: &Mask) -> Plane {
    Plane {
        w: mask.w,
        h: mask.h,
        data: mask.v.iter().map(|&v| if v { 1.0 } else { 0.0 }).collect(),
    }
}

/// Each pixel's distance to the nearest set pixel of `mask` (0 on it).
pub(crate) fn distance_to(mask: &Mask) -> Plane {
    distance(&wplane::Mask {
        w: mask.w,
        h: mask.h,
        data: mask.v.iter().map(|&v| !v).collect(),
    })
}

/// A caption's white strokes in one box (x0, y0, x1, y1 in the picture's pixels): thin, bright, colourless (or one
/// bold colour), in word-sized groups standing on a dark surround, plus punctuation on the same line. Edit's finder's
/// letters (still::letters) without its plate branch and without growing them.
pub fn strokes_in(frame: &Rgb, boxes: &[[f64; 4]], scale: f64, out: &mut Mask) {
    let (rows, w) = (frame.h, frame.w);
    for &[x0, by0, x1, by1] in boxes {
        let a = (x0.trunc() as i64 - 6).max(0);
        let b = (x1.trunc() as i64 + 6).min(w as i64);
        let c = (by0.trunc() as i64 - 6).max(0);
        let d = (by1.trunc() as i64 + 6).min(rows as i64);
        if b <= a || d <= c {
            continue;
        }
        let (a, b, c, d) = (a as usize, b as usize, c as usize, d as usize);
        let part = frame.crop(a, c, b, d);
        let grey = gray(&part);
        let size = part.v.len() as f64;
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
            for ((slot, &(hue, _, _)), &one) in core.v.iter_mut().zip(&colours).zip(&bold) {
                if one && spread[hue as usize % 180] >= 0.2 * top {
                    *slot = true;
                }
            }
        }
        let two = Kernel::rect(2, 2);
        let core = pixels::dilate(&pixels::erode(&core, &two), &two);
        let wide = Kernel::rect((21.0 * scale) as usize | 1, (5.0 * scale) as usize | 1);
        let joined = pixels::erode(&pixels::dilate(&core, &wide), &wide);
        let (count, parts, sizes) = pixels::parts(&joined);
        let word: Vec<bool> = sizes
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
            let label = label as usize;
            if label > 0 && label < count && !core.v[k] {
                around[label] += 1;
                if colours[k].2 < 110 {
                    dark[label] += 1;
                }
            }
        }
        let dark_ok: Vec<bool> = (0..count)
            .map(|l| dark[l] as f64 >= 0.5 * around[l].max(1) as f64)
            .collect();
        let mut keep: Vec<bool> = (0..count).map(|l| word[l] && dark_ok[l]).collect();
        if let Some(first) = keep.first_mut() {
            *first = false;
        }
        // Punctuation (an apostrophe, a full stop, a leading dash) is too small to pass as a word: kept when it stands on
        // the same dark shadow and sits on the words' line, within about a word space of them.
        let words: Mask = core.zip(&parts, |one, label| one && keep[label as usize]);
        if words.any() {
            let line = pixels::dilate(
                &words,
                &Kernel::rect((90.0 * scale) as usize | 1, (30.0 * scale) as usize | 1),
            );
            let mut near = vec![false; count];
            for k in 0..joined.v.len() {
                if line.v[k] && joined.v[k] {
                    near[parts.v[k] as usize] = true;
                }
            }
            for l in 1..count {
                keep[l] = keep[l] || (dark_ok[l] && near[l]);
            }
        }
        for y in 0..part.h {
            for x in 0..part.w {
                let k = y * part.w + x;
                if core.v[k] && keep[parts.v[k] as usize] {
                    out.set(a + x, c + y, true);
                }
            }
        }
    }
}

/// min(cap, k · blur(mask grown by `grow`, sigma)).
fn darkening(s: &Mask, k: f32, sigma: f32, grow: usize, cap: f32) -> Plane {
    let grown = if grow > 0 {
        pixels::dilate(s, &Kernel::ellipse(2 * grow + 1, 2 * grow + 1))
    } else {
        s.clone()
    };
    gaussian(&plane_of(&grown), sigma).map(|v| (k * v).min(cap))
}

/// One frame's letters and picture kept for fitting the style: at half size, round its letters.
pub struct Sample {
    s: Mask,
    per: Vec<Vec<usize>>,
    ratio: Plane,
}

const BINS: [f32; 10] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.5, 8.0, 10.0, 12.5, 15.0];

/// The picture without the shadow, spot by spot: closed in from just outside the shadow's reach (Telea on the gray).
fn reference(g: &Plane, dist: &Plane) -> Plane {
    let mut rgb: Rgb = Img {
        w: g.w,
        h: g.h,
        v: g.data
            .iter()
            .map(|&v| {
                let b = v.round().clamp(0.0, 255.0) as u8;
                [b, b, b]
            })
            .collect(),
    };
    let holes: Mask = Img {
        w: g.w,
        h: g.h,
        v: dist.data.iter().map(|&d| d < 13.0).collect(),
    };
    pixels::telea(&mut rgb, &holes, 6.0);
    Plane {
        w: g.w,
        h: g.h,
        data: rgb.v.iter().map(|px| f32::from(px[0])).collect(),
    }
}

/// A plane at half the size it would have at 720 lines (the size the style is fitted at).
fn fit_size(p: &Plane, scale: f32) -> Plane {
    if (scale - 1.0).abs() < 0.01 {
        return p.half();
    }
    let f = 0.5 / scale;
    let (w, h) = (
        ((p.w as f32) * f).round().max(1.0) as usize,
        ((p.h as f32) * f).round().max(1.0) as usize,
    );
    gaussian(p, 0.5 / f).resized(w, h)
}

/// A sample from a frame's letters `s` and picture `frame` (same size: the caption's area), or None if too few letters.
/// `scale` is the picture's lines over 720.
pub fn sample(frame: &Rgb, s: &Mask, scale: f32) -> Option<Sample> {
    if (s.count() as f32) < 1500.0 * scale * scale {
        return None;
    }
    let g = fit_size(
        &Plane {
            w: frame.w,
            h: frame.h,
            data: frame
                .v
                .iter()
                .map(|&px| f32::from(pixels::luma(px)))
                .collect(),
        },
        scale,
    );
    let s = fit_size(&plane_of(s), scale).mask(|v| v > 0.25);
    let s = Img {
        w: s.w,
        h: s.h,
        v: s.data,
    };
    let dist = distance_to(&s);
    let r = reference(&g, &dist);
    let ratio = g.zip(&r, |a, b| a / b.max(12.0));
    let dens = gaussian(&plane_of(&s), 6.0);
    let mut near: Vec<f64> = Vec::new();
    for (k, &d) in dist.data.iter().enumerate() {
        if d > 1.0 && d < 15.0 {
            near.push(f64::from(dens.data[k]));
        }
    }
    if near.is_empty() {
        return None;
    }
    near.sort_by(f64::total_cmp);
    let lo = pixels::percentile(&near, 33.0) as f32;
    let hi = pixels::percentile(&near, 66.0) as f32;
    let mut per = vec![Vec::new(); (BINS.len() - 1) * 3];
    for (k, (&d, &de)) in dist.data.iter().zip(&dens.data).enumerate() {
        for (bi, pair) in BINS.windows(2).enumerate() {
            if d >= pair[0] && d < pair[1] {
                let di = if de <= lo {
                    0
                } else if de <= hi {
                    1
                } else {
                    2
                };
                per[bi * 3 + di].push(k);
            }
        }
    }
    Some(Sample { s, per, ratio })
}

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        0.5 * (values[n / 2 - 1] + values[n / 2])
    }
}

fn nan_median(values: impl Iterator<Item = f64>) -> f64 {
    median(values.filter(|v| !v.is_nan()).collect())
}

/// The style's shadow fitted to the samples: how dark the picture is round the letters (as a share of the picture
/// without it), by distance from the letters and by how dense the letters are there (a soft glow piles up between
/// letters; a tight outline doesn't), against what each candidate shadow predicts on the same letters. Fitted at half
/// size. (style, its error, the error of no shadow at all).
pub fn fit(samples: &[Sample]) -> Option<(Style, f64, f64)> {
    if samples.is_empty() {
        return None;
    }
    let cells = (BINS.len() - 1) * 3;
    let obs: Vec<f64> = (0..cells)
        .map(|c| {
            nan_median(samples.iter().map(|one| {
                let at = &one.per[c];
                if at.len() > 15 {
                    median(at.iter().map(|&k| f64::from(one.ratio.data[k])).collect())
                } else {
                    f64::NAN
                }
            }))
        })
        .collect();
    let mut best: Option<(f64, Style)> = None;
    const CAPS: [f32; 4] = [0.8, 0.85, 0.9, 0.97];
    const KS: [f32; 9] = [0.6, 0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.0, 4.0];
    for grow in [0usize, 2, 4, 6, 8, 10, 12] {
        for sigma in [2.0f32, 3.0, 4.0, 5.0, 6.0, 7.0, 9.0] {
            // The blur depends only on these two: worked once per sample, then each k and cap read off it.
            let blurred: Vec<Plane> = samples
                .iter()
                .map(|one| darkening(&one.s, 1.0, sigma / 2.0, grow / 2, f32::MAX))
                .collect();
            for cap in CAPS {
                for k in KS {
                    let pred: Vec<f64> = (0..cells)
                        .map(|c| {
                            nan_median(samples.iter().zip(&blurred).map(|(one, b)| {
                                let at = &one.per[c];
                                if at.len() > 15 {
                                    let sum: f64 = at
                                        .iter()
                                        .map(|&i| f64::from(1.0 - (k * b.data[i]).min(cap)))
                                        .sum();
                                    sum / at.len() as f64
                                } else {
                                    f64::NAN
                                }
                            }))
                        })
                        .collect();
                    let errs: Vec<f64> = pred
                        .iter()
                        .zip(&obs)
                        .map(|(p, o)| (p - o).abs())
                        .filter(|e| !e.is_nan())
                        .collect();
                    if errs.is_empty() {
                        continue;
                    }
                    let err = errs.iter().sum::<f64>() / errs.len() as f64;
                    if best.as_ref().is_none_or(|(least, _)| err < *least) {
                        best = Some((
                            err,
                            Style {
                                k,
                                sigma,
                                grow,
                                cap,
                            },
                        ));
                    }
                }
            }
        }
    }
    let none: Vec<f64> = obs
        .iter()
        .map(|o| (1.0 - o).abs())
        .filter(|e| !e.is_nan())
        .collect();
    let none = none.iter().sum::<f64>() / none.len().max(1) as f64;
    best.map(|(err, style)| (style, err, none))
}

/// gaussian(v · m) / max(gaussian(m), 1e-3): v's blur over where m is set.
fn mblur(v: &Plane, m: &Plane, sigma: f32) -> Plane {
    let top = gaussian(&v.zip(m, |a, b| a * b), sigma);
    let under = gaussian(m, sigma);
    top.zip(&under, |a, b| a / b.max(1e-3))
}

/// np.gradient's magnitude: central differences inside, one-sided at the edges.
fn gradient(a: &Plane) -> Plane {
    let (w, h) = (a.w, a.h);
    let mut out = Plane::new(w, h, 0.0);
    for y in 0..h {
        for x in 0..w {
            let gx = if w < 2 {
                0.0
            } else if x == 0 {
                a.at(1, y) - a.at(0, y)
            } else if x == w - 1 {
                a.at(w - 1, y) - a.at(w - 2, y)
            } else {
                0.5 * (a.at(x + 1, y) - a.at(x - 1, y))
            };
            let gy = if h < 2 {
                0.0
            } else if y == 0 {
                a.at(x, 1) - a.at(x, 0)
            } else if y == h - 1 {
                a.at(x, h - 1) - a.at(x, h - 2)
            } else {
                0.5 * (a.at(x, y + 1) - a.at(x, y - 1))
            };
            out.set(x, y, gx.hypot(gy));
        }
    }
    out
}

/// The picture as three float planes, and back.
pub fn planes(frame: &Rgb) -> [Plane; 3] {
    let one = |c: usize| Plane {
        w: frame.w,
        h: frame.h,
        data: frame.v.iter().map(|px| f32::from(px[c])).collect(),
    };
    [one(0), one(1), one(2)]
}

pub fn rgb(planes: &[Plane; 3]) -> Rgb {
    let [r, g, b] = planes;
    Img {
        w: r.w,
        h: r.h,
        v: r.data
            .iter()
            .zip(&g.data)
            .zip(&b.data)
            .map(|((&r, &g), &b)| [r, g, b].map(|v| v.round().clamp(0.0, 255.0) as u8))
            .collect(),
    }
}

/// One frame's caption area undone: the shadow brightened back near the letters, the hole LaMa fills (the letters,
/// where the shadow leaves too little, and where it's too steep to brighten reliably), and the rim just outside the
/// hole matched to the picture a little further out. (picture, hole, near: within REACH of a letter). `scale` is the
/// picture's lines over 720.
pub fn undo(frame: &Rgb, s: &Mask, style: &Style, scale: f32) -> (Rgb, Mask, Mask) {
    let (w, h) = (frame.w, frame.h);
    if !s.any() {
        return (
            frame.clone(),
            Img::filled(w, h, false),
            Img::filled(w, h, false),
        );
    }
    let dist_l = distance_to(s);
    let near: Mask = Img {
        w,
        h,
        v: dist_l.data.iter().map(|&d| d <= REACH * scale).collect(),
    };
    let a = darkening(
        s,
        style.k,
        style.sigma * scale,
        (style.grow as f32 * scale).round() as usize,
        style.cap,
    )
    .zip(&plane_of(&near), |a, n| a * n);
    // Per pixel at 720 lines: the same shadow drawn larger changes less from one pixel to the next.
    let grad = gradient(&a).map(|g| g * scale);
    let core = pixels::dilate(s, &Kernel::rect(5, 5));
    let mut hole: Mask = Img {
        w,
        h,
        v: (0..w * h)
            .map(|k| {
                let av = a.data[k];
                core.v[k]
                    || av > 1.0 - TOO_DARK
                    || (near.v[k] && grad.data[k] / (1.0 - av).max(0.05).powi(2) > STEEP)
            })
            .collect(),
    };
    let grow = ((GROW_HOLE as f32 * scale).round() as usize).max(1);
    hole = pixels::dilate(&hole, &Kernel::ellipse(2 * grow + 1, 2 * grow + 1));
    let mut out = planes(frame);
    for p in &mut out {
        for (k, v) in p.data.iter_mut().enumerate() {
            if !hole.v[k] {
                *v /= 1.0 - a.data[k];
            }
        }
    }
    // LaMa carries the hole's edge inward, so the rim just outside it has to be right: a rim 5% too dark doubles its
    // error and draws grey letter shapes. Each 1 px ring matched to the picture a few px further out, per colour.
    let dist = distance_to(&hole).map(|d| d / scale);
    let rim = RIM as f32;
    let beyond = Plane {
        w,
        h,
        data: dist
            .data
            .iter()
            .map(|&d| {
                if d > rim + 1.0 && d <= rim + 5.0 {
                    1.0
                } else {
                    0.0
                }
            })
            .collect(),
    };
    let targets: Vec<Plane> = out.iter().map(|p| mblur(p, &beyond, 3.0)).collect();
    for k in 1..=RIM {
        let k = k as f32;
        let ring = Plane {
            w,
            h,
            data: dist
                .data
                .iter()
                .zip(&near.v)
                .map(|(&d, &n)| {
                    if d > k - 0.5 && d <= k + 0.5 && n {
                        1.0
                    } else {
                        0.0
                    }
                })
                .collect(),
        };
        if !ring.data.iter().any(|&v| v > 0.0) {
            continue;
        }
        let under = gaussian(&ring, 3.0);
        for (p, target) in out.iter_mut().zip(&targets) {
            let top = gaussian(&p.zip(&ring, |a, b| a * b), 3.0);
            for (i, v) in p.data.iter_mut().enumerate() {
                if ring.data[i] > 0.0 {
                    let here = top.data[i] / under.data[i].max(1e-3);
                    *v *= (target.data[i] / here.max(1.0)).clamp(1.0, 1.4);
                }
            }
        }
    }
    (rgb(&out), hole, near)
}

/// After the fill: its coarse brightness made to continue the picture a little way out from the hole, where the
/// brightening is right, LaMa's texture kept. Brightness only (a colour estimate drags a nearby pad's yellow in) and only
/// ever brighter (the fault is leftover shadow, which only darkens).
pub fn level(res: &mut Rgb, hole: &Mask, near: &Mask) {
    let Some((x0, y0, x1, y1)) = as_wmask(hole).bounds() else {
        return;
    };
    let (x0, y0) = (x0.saturating_sub(40), y0.saturating_sub(40));
    let (x1, y1) = ((x1 + 40).min(res.w), (y1 + 40).min(res.h));
    let r = res.crop(x0, y0, x1, y1);
    let (w, h) = (r.w, r.h);
    let hc = hole.crop(x0, y0, x1, y1);
    let nc = near.crop(x0, y0, x1, y1);
    let inner = pixels::dilate(
        &hc,
        &Kernel::ellipse(2 * LEVEL_FROM + 1, 2 * LEVEL_FROM + 1),
    );
    let gray = Plane {
        w,
        h,
        data: r
            .v
            .iter()
            .map(|px| (f32::from(px[0]) + f32::from(px[1]) + f32::from(px[2])) / 3.0)
            .collect(),
    };
    let lo = gaussian(&gray, 4.0);
    let small = lo.half();
    let inner_small = plane_of(&inner).half().mask(|v| v > 0.0);
    let mut s_rgb: Rgb = Img {
        w: small.w,
        h: small.h,
        v: small
            .data
            .iter()
            .map(|&v| {
                let b = v.round().clamp(0.0, 255.0) as u8;
                [b, b, b]
            })
            .collect(),
    };
    pixels::telea(
        &mut s_rgb,
        &Img {
            w: small.w,
            h: small.h,
            v: inner_small.data,
        },
        5.0,
    );
    let expect = Plane {
        w: small.w,
        h: small.h,
        data: s_rgb.v.iter().map(|px| f32::from(px[0])).collect(),
    }
    .resized(w, h);
    let expect = gaussian(&expect, 2.0);
    let on: Mask = inner.zip(&nc, |a, b| a && b);
    let soft = gaussian(&plane_of(&on), 1.5);
    let mut out = r.clone();
    for k in 0..w * h {
        let gain = if on.v[k] {
            (expect.data[k] / lo.data[k].max(1.0)).clamp(1.0, 1.4)
        } else {
            1.0
        };
        let t = soft.data[k];
        for c in 0..3 {
            let v = f32::from(r.v[k][c]);
            out.v[k][c] = (v * (1.0 - t) + v * gain * t).round().clamp(0.0, 255.0) as u8;
        }
    }
    res.paste(x0, y0, &out);
}
