//! Learning a channel's mark from footage that carries it (the lab's
//! matte2 + refine, Nov 17): over ~2,000 frames a second apart, each pixel's
//! spread of brightness. Where the mark is, every quantile of a pixel's
//! brightness is the background's quantile with the mark blended over it, so
//! against the background filled in smoothly from round the letters each
//! pixel's quantiles fall on a line in linear light whose slope is `1 − a`
//! and whose intercept is `a·W`. The curve's gamma is the one making those
//! lines straightest; then `W` from the letters' cores, each pixel's `a` by
//! least squares, refined twice so the undone quantiles match the background's.
//!
//! Only per-pixel histograms are kept (256 counts a pixel), never frames.

use std::path::Path;

use super::plane::{harmonic_fill, Mask, Plane};
use super::run::Decoder;
use super::{Curve, Model, Shares, VERSION};

/// Quantiles looked at (percent), and how many of the lowest are fitted (the top ones clip and carry overlays).
const QS: [f32; 19] = [
    5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0,
    85.0, 90.0, 95.0,
];
const FITTED: usize = 16;
const MEDIAN: usize = 9;
/// Frames sampled at most, a second apart at most.
const FRAMES: f64 = 2400.0;
/// Pixels round the found letters kept in the learned box.
const MARGIN: usize = 40;

/// Each pixel's 256-bin histogram over the frames seen.
struct Hist {
    w: usize,
    h: usize,
    counts: Vec<u16>,
    frames: usize,
}

impl Hist {
    fn new(w: usize, h: usize) -> Self {
        Self {
            w,
            h,
            counts: vec![0; w * h * 256],
            frames: 0,
        }
    }

    fn add(&mut self, frame: &[u8]) {
        if self.frames >= u16::MAX as usize {
            return;
        }
        for (bins, &v) in self.counts.as_chunks_mut::<256>().0.iter_mut().zip(frame) {
            if let Some(count) = bins.get_mut(usize::from(v)) {
                *count = count.saturating_add(1);
            }
        }
        self.frames += 1;
    }

    /// The quantiles `qs` (percent, rising) of every pixel, interpolated between ranks as numpy's.
    fn quantiles(&self, qs: &[f32]) -> Vec<Plane> {
        let mut out: Vec<Plane> = qs.iter().map(|_| Plane::new(self.w, self.h, 0.0)).collect();
        let n = self.frames.max(1);
        let ranks: Vec<f32> = qs.iter().map(|q| q / 100.0 * (n - 1) as f32).collect();
        for (p, bins) in self.counts.as_chunks::<256>().0.iter().enumerate() {
            // The value of the r-th order statistic, walking the histogram once for every rank.
            let mut wanted: Vec<(usize, usize)> = Vec::with_capacity(ranks.len() * 2);
            for (k, &r) in ranks.iter().enumerate() {
                wanted.push((r.floor() as usize, 2 * k));
                wanted.push((r.ceil() as usize, 2 * k + 1));
            }
            wanted.sort_unstable();
            let mut values = vec![0f32; ranks.len() * 2];
            let mut seen = 0usize;
            let mut next = wanted.iter().peekable();
            for (value, &count) in bins.iter().enumerate() {
                seen += usize::from(count);
                while let Some(&&(rank, slot)) = next.peek() {
                    if rank < seen {
                        if let Some(v) = values.get_mut(slot) {
                            *v = value as f32;
                        }
                        next.next();
                    } else {
                        break;
                    }
                }
            }
            for (k, &r) in ranks.iter().enumerate() {
                let (lo, hi) = (
                    values.get(2 * k).copied().unwrap_or(0.0),
                    values.get(2 * k + 1).copied().unwrap_or(0.0),
                );
                if let Some(plane) = out.get_mut(k) {
                    if let Some(slot) = plane.data.get_mut(p) {
                        *slot = lo + (r - r.floor()) * (hi - lo);
                    }
                }
            }
        }
        out
    }
}

/// Learns the mark in `source` (`size` its picture, `duration` seconds): in
/// `hint` (shares) when the team showed where, else wherever footage shows a
/// see-through mark that stays put, never in `avoid` (the camera's stamp).
pub fn learn(
    source: &Path,
    size: (u32, u32),
    duration: f64,
    hint: Option<Shares>,
    avoid: &[Shares],
    progress: &dyn Fn(f64),
) -> Result<Model, String> {
    let (fw, fh) = (size.0 as usize, size.1 as usize);
    if fw < 64 || fh < 64 {
        return Err("the footage is too small to find a watermark in".to_owned());
    }
    let rate = (FRAMES / duration.max(1.0)).min(1.0);
    let found = match hint {
        Some(box_) => {
            let px = to_pixels(box_, fw, fh);
            (
                px.0.saturating_sub(MARGIN),
                px.1.saturating_sub(MARGIN),
                (px.2 + MARGIN).min(fw),
                (px.3 + MARGIN).min(fh),
            )
        }
        None => {
            progress(0.0);
            let found = detect(source, fw, fh, duration, avoid, &|share| {
                progress(share * 0.4)
            })?;
            (
                found.0.saturating_sub(MARGIN),
                found.1.saturating_sub(MARGIN),
                (found.2 + MARGIN).min(fw),
                (found.3 + MARGIN).min(fh),
            )
        }
    };
    // Even, as yuv crops want.
    let x0 = found.0 & !1;
    let y0 = found.1 & !1;
    let w = ((found.2 - x0) & !1).max(2);
    let h = ((found.3 - y0) & !1).max(2);
    if w * h > 1_500_000 {
        return Err("that box is too big for a watermark".to_owned());
    }
    let start = if hint.is_some() { 0.0 } else { 0.4 };
    let mut hist = Hist::new(w, h);
    let expected = (duration * rate).max(1.0);
    let filters = format!("fps={rate:.6},crop={w}:{h}:{x0}:{y0},format=gray");
    let mut decoder = Decoder::open(source, 0.0, None, &filters, "gray", w * h, true)?;
    let mut frame = vec![0u8; w * h];
    while decoder.next(&mut frame)? {
        hist.add(&frame);
        if hist.frames.is_multiple_of(50) {
            progress(start + (1.0 - start) * 0.9 * (hist.frames as f64 / expected).min(1.0));
        }
    }
    decoder.finish()?;
    if hist.frames < 30 {
        return Err(format!(
            "only {} frames of the footage could be read to learn its watermark",
            hist.frames
        ));
    }
    let mut avoid_mask = Mask::new(w, h);
    for &one in avoid {
        let (ax0, ay0, ax1, ay1) = to_pixels(one, fw, fh);
        for y in ay0.max(y0)..ay1.min(y0 + h) {
            for x in ax0.max(x0)..ax1.min(x0 + w) {
                avoid_mask.set(x - x0, y - y0, true);
            }
        }
    }
    let qs = hist.quantiles(&QS);
    let strokes = strokes_of(&qs, &avoid_mask)?;
    // The curve, measured directly as the lab did: each frame's strokes just inside against just outside.
    let pairs_rate = rate * (1000.0 / hist.frames as f64).min(1.0);
    let mut decoder = Decoder::open(
        source,
        0.0,
        None,
        &format!("fps={pairs_rate:.6},crop={w}:{h}:{x0}:{y0},format=gray"),
        "gray",
        w * h,
        true,
    )?;
    let mut pairs = Pairs::new(&strokes);
    let expected_pairs = (duration * pairs_rate).max(1.0);
    let mut seen = 0usize;
    while decoder.next(&mut frame)? {
        pairs.add(&Plane::from_window(&frame, w, h, 0, 0, w, h));
        seen += 1;
        if seen.is_multiple_of(50) {
            progress(
                start + (1.0 - start) * (0.9 + 0.09 * (seen as f64 / expected_pairs).min(1.0)),
            );
        }
    }
    decoder.finish()?;
    let curve = pairs.curve();
    let estimate = estimate(&qs, &avoid_mask, curve)?;
    progress(1.0);
    let Some((mx0, my0, mx1, my1)) = estimate.alpha.mask(|a| a > 0.002).bounds() else {
        return Err("no see-through watermark there".to_owned());
    };
    let (cx0, cy0) = (mx0.saturating_sub(4), my0.saturating_sub(4));
    let (cx1, cy1) = ((mx1 + 4).min(w), (my1 + 4).min(h));
    let matte = estimate
        .alpha
        .crop(cx0 as isize, cy0 as isize, cx1 - cx0, cy1 - cy0);
    Ok(Model {
        version: VERSION,
        width: size.0,
        height: size.1,
        gamma: estimate.gamma,
        white: estimate.white,
        at: [(x0 + cx0) as f32, (y0 + cy0) as f32],
        matte_width: 0,
        matte_height: 0,
        matte: String::new(),
        strength: estimate.strength,
        frames: hist.frames as u32,
    }
    .with_matte(&matte))
}

fn to_pixels(box_: Shares, w: usize, h: usize) -> (usize, usize, usize, usize) {
    let [x0, y0, x1, y1] = box_;
    let clamp = |v: f64, n: usize| (v.clamp(0.0, 1.0) * n as f64).round() as usize;
    (
        clamp(x0, w),
        clamp(y0, h),
        clamp(x1, w).max(clamp(x0, w) + 1),
        clamp(y1, h).max(clamp(y0, h) + 1),
    )
}

/// What [`estimate`] finds.
pub(crate) struct Estimate {
    pub alpha: Plane,
    pub gamma: f32,
    pub white: f32,
    pub strength: f32,
}

/// The mark's letters in a still: bright strokes thinner than `size` standing out of a grey opening of the picture.
fn letters(q50: &Plane, size: usize) -> Mask {
    let opened = q50.morph(size, true).morph(size, false);
    let d = q50.zip(&opened, |a, b| a - b);
    let mut sorted: Vec<f32> = d.data.clone();
    sorted.sort_unstable_by(f32::total_cmp);
    let p995 = sorted
        .get(((sorted.len() as f32 - 1.0) * 0.995) as usize)
        .copied()
        .unwrap_or(0.0);
    let threshold = (0.25 * p995).max(2.0);
    d.mask(|v| v > threshold)
}

/// The matte, white and curve from each pixel's quantiles (`qs`, file values, [`QS`]).
/// The mark's strokes in the learned box: bright and thin in the median, never in `avoid`.
fn strokes_of(qs: &[Plane], avoid: &Mask) -> Result<Mask, String> {
    let q50 = qs.get(MEDIAN).ok_or("no quantiles")?;
    let mut m = letters(q50, 31).open(3);
    for (v, &no) in m.data.iter_mut().zip(&avoid.data) {
        if no {
            *v = false;
        }
    }
    if m.count() < 30 {
        return Err("no see-through watermark there".to_owned());
    }
    Ok(m)
}

/// Pairs of brightness just outside a stroke (4–6 px out, where it's smooth) and just inside it (3–5 px in),
/// over many frames: the blend curve read straight off the footage (the lab's blendfn).
struct Pairs {
    edges: Vec<(usize, usize)>,
    inside: Plane,
    outside: Plane,
    values: Vec<(f32, f32)>,
}

impl Pairs {
    const K: usize = 5;

    fn new(strokes: &Mask) -> Self {
        let din = super::find::distance(strokes);
        let dout = super::find::distance(&Mask {
            w: strokes.w,
            h: strokes.h,
            data: strokes.data.iter().map(|v| !v).collect(),
        });
        let inside = din.map(|d| if (3.0..=5.0).contains(&d) { 1.0 } else { 0.0 });
        let outside = dout.map(|d| if (4.0..=6.0).contains(&d) { 1.0 } else { 0.0 });
        let (bi, bo) = (
            super::plane::Integral::new(&inside),
            super::plane::Integral::new(&outside),
        );
        let k = Self::K;
        let area = ((2 * k + 1) * (2 * k + 1)) as f64;
        let mut edges = Vec::new();
        for y in k..strokes.h.saturating_sub(k + 1) {
            for x in k..strokes.w.saturating_sub(k + 1) {
                let d = din.at(x, y);
                if d > 0.0
                    && d <= 1.5
                    && bi.sum(x - k, y - k, x + k + 1, y + k + 1) / area > 0.1
                    && bo.sum(x - k, y - k, x + k + 1, y + k + 1) / area > 0.1
                {
                    edges.push((x, y));
                }
            }
        }
        Self {
            edges,
            inside,
            outside,
            values: Vec::new(),
        }
    }

    fn add(&mut self, frame: &Plane) {
        let k = Self::K;
        let si = super::plane::Integral::new(&frame.zip(&self.inside, |v, b| v * b));
        let so = super::plane::Integral::new(&frame.zip(&self.outside, |v, b| v * b));
        let so2 = super::plane::Integral::new(&frame.zip(&self.outside, |v, b| v * v * b));
        let (bi, bo) = (
            super::plane::Integral::new(&self.inside),
            super::plane::Integral::new(&self.outside),
        );
        for &(x, y) in &self.edges {
            let (x0, y0, x1, y1) = (x - k, y - k, x + k + 1, y + k + 1);
            let (ni, no) = (bi.sum(x0, y0, x1, y1), bo.sum(x0, y0, x1, y1));
            let mo = so.sum(x0, y0, x1, y1) / no;
            if so2.sum(x0, y0, x1, y1) / no - mo * mo < 9.0 {
                self.values
                    .push((mo as f32, (si.sum(x0, y0, x1, y1) / ni) as f32));
            }
        }
    }

    /// The curve (gamma, white) and the strokes' alpha best explaining the pairs, binned five levels wide.
    fn curve(&self) -> Option<(Curve, f32)> {
        let mut bins: Vec<Vec<f32>> = vec![Vec::new(); 48];
        let mut outs: Vec<Vec<f32>> = vec![Vec::new(); 48];
        for &(o, i) in &self.values {
            let b = (((o - 16.0) / 5.0).floor().max(0.0) as usize).min(47);
            if let (Some(bin), Some(out)) = (bins.get_mut(b), outs.get_mut(b)) {
                bin.push(i);
                out.push(o);
            }
        }
        let points: Vec<(f32, f32, f32)> = bins
            .into_iter()
            .zip(outs)
            .filter(|(bin, _)| bin.len() >= 200)
            .map(|(mut bin, mut out)| {
                (
                    median(&mut out),
                    median(&mut bin),
                    (bin.len() as f32).sqrt(),
                )
            })
            .collect();
        if points.len() < 6 {
            return None;
        }
        let fit = |gamma: f32| -> (f32, Curve, f32) {
            let curve = Curve { gamma, white: 1.0 };
            let x: Vec<f32> = points.iter().map(|p| curve.lin(p.0)).collect();
            let y: Vec<f32> = points.iter().map(|p| curve.lin(p.1)).collect();
            let w: Vec<f32> = points.iter().map(|p| p.2).collect();
            let (slope, intercept) = weighted_line(&x, &y, &w);
            let a = 1.0 - slope;
            if !(0.005..0.9).contains(&a) {
                return (f32::INFINITY, curve, a);
            }
            let residual = points
                .iter()
                .zip(&x)
                .map(|(p, &xv)| p.2 * (curve.disp(slope * xv + intercept) - p.1).powi(2))
                .sum();
            (
                residual,
                Curve {
                    gamma,
                    white: intercept / a,
                },
                a,
            )
        };
        let mut best = fit(2.2);
        for step in 0..=120 {
            let one = fit(1.0 + 0.02 * step as f32);
            if one.0 < best.0 {
                best = one;
            }
        }
        best.0.is_finite().then_some((best.1, best.2))
    }
}

/// The matte, white and curve from each pixel's quantiles (`qs`, file values, [`QS`]); the curve as measured when given.
pub(crate) fn estimate(
    qs: &[Plane],
    avoid: &Mask,
    measured: Option<(Curve, f32)>,
) -> Result<Estimate, String> {
    let q50 = qs.get(MEDIAN).ok_or("no quantiles")?;
    let (w, h) = (q50.w, q50.h);
    let m = strokes_of(qs, avoid)?;
    let md = m.dilate_disc(15);
    let core = m.erode(7);
    let core_px: Vec<usize> = core
        .data
        .iter()
        .enumerate()
        .filter(|(_, &v)| v)
        .map(|(i, _)| i)
        .collect();
    if core_px.len() < 20 {
        return Err("the watermark's letters are too thin to learn".to_owned());
    }
    // The curve: the gamma under which the cores' quantiles, against the background's, fall on one line in linear
    // light (slope 1 − a, intercept a·W) with the least error back in file values (the lab's fitfn, pooled).
    let filled_display: Vec<Plane> = qs
        .iter()
        .take(FITTED)
        .map(|q| harmonic_fill(q, &md))
        .collect();
    let pairs: Vec<(f32, f32)> = core_px
        .iter()
        .flat_map(|&p| {
            filled_display.iter().zip(qs.iter()).map(move |(f, q)| {
                (
                    f.data.get(p).copied().unwrap_or(0.0),
                    q.data.get(p).copied().unwrap_or(0.0),
                )
            })
        })
        .collect();
    let fit = |gamma: f32| -> (f32, f32, f32) {
        let curve = Curve { gamma, white: 1.0 };
        let (x, y): (Vec<f32>, Vec<f32>) = pairs
            .iter()
            .map(|&(b, m)| (curve.lin(b), curve.lin(m)))
            .unzip();
        let weights: Vec<f32> = pairs.iter().map(|&(b, _)| level_weight(b, gamma)).collect();
        let (slope, intercept) = weighted_line(&x, &y, &weights);
        let a = 1.0 - slope;
        if !(0.005..0.9).contains(&a) {
            return (f32::INFINITY, a, 1.0);
        }
        let residual = x
            .iter()
            .zip(&pairs)
            .map(|(&xv, &(_, seen))| (curve.disp(slope * xv + intercept) - seen).powi(2))
            .sum::<f32>();
        (residual, a, intercept / a)
    };
    let mut best = (f32::INFINITY, 2.2f32);
    for step in 0..=24 {
        let gamma = 1.0 + 0.1 * step as f32;
        let (r, _, _) = fit(gamma);
        if r < best.0 {
            best = (r, gamma);
        }
    }
    let around = best.1;
    for step in -5..=5 {
        let gamma = around + 0.02 * step as f32;
        let (r, _, _) = fit(gamma);
        if r < best.0 {
            best = (r, gamma);
        }
    }
    let gamma = measured.map_or(best.1, |(curve, _)| curve.gamma);
    let lin_curve = Curve { gamma, white: 1.0 };
    // The matte in linear light (the lab's matte2), quantiles filled under the letters; the white pooled over the cores.
    let ql: Vec<Plane> = qs.iter().map(|q| q.map(|v| lin_curve.lin(v))).collect();
    let qj: Vec<Plane> = ql
        .iter()
        .take(FITTED)
        .map(|q| harmonic_fill(&q.map(|v| v * 255.0), &md).map(|v| v / 255.0))
        .collect();
    let (xs, ds): (Vec<f32>, Vec<f32>) = core_px
        .iter()
        .flat_map(|&p| {
            qj.iter().zip(ql.iter()).map(move |(j, q)| {
                let jv = j.data.get(p).copied().unwrap_or(0.0);
                (jv, q.data.get(p).copied().unwrap_or(0.0) - jv)
            })
        })
        .unzip();
    let (slope, intercept) = line(&xs, &ds);
    let core_alpha = -slope;
    if measured.is_none() && core_alpha < 0.005 {
        return Err("no see-through watermark there".to_owned());
    }
    let white = measured.map_or((intercept / core_alpha).clamp(0.3, 1.2), |(curve, _)| {
        curve.white.clamp(0.3, 1.2)
    });
    let mut alpha = Plane::new(w, h, 0.0);
    for (p, slot) in alpha.data.iter_mut().enumerate() {
        if !md.data.get(p).copied().unwrap_or(false) {
            continue;
        }
        let (mut num, mut den) = (0.0f32, 0.0f32);
        for (q, j) in ql.iter().zip(&qj) {
            let jv = j.data.get(p).copied().unwrap_or(0.0);
            let mut d = white - jv;
            if d.abs() < 0.05 {
                d = 0.0;
            }
            num += (q.data.get(p).copied().unwrap_or(0.0) - jv) * d;
            den += d * d;
        }
        *slot = (num / (den + 1e-6)).clamp(0.0, 0.9);
    }
    // Twice: the undone quantiles made to match the background's.
    for _ in 0..2 {
        for (p, slot) in alpha.data.iter_mut().enumerate() {
            if !md.data.get(p).copied().unwrap_or(false) {
                continue;
            }
            let a = *slot;
            let (mut num, mut den) = (0.0f32, 0.0f32);
            for (q, j) in ql.iter().zip(&qj) {
                let (lv, jv) = (
                    q.data.get(p).copied().unwrap_or(0.0),
                    j.data.get(p).copied().unwrap_or(0.0),
                );
                let err = (lv - a * white) / (1.0 - a) - jv;
                let dj = (jv - white) / (1.0 - a);
                num += err * dj;
                den += dj * dj;
            }
            let step = num / (den + 1e-9);
            if step.is_finite() {
                *slot = (a - step).clamp(0.0, 0.9);
            }
        }
    }
    let mut strengths: Vec<f32> = core_px
        .iter()
        .filter_map(|&p| alpha.data.get(p).copied())
        .collect();
    let strength = median(&mut strengths);
    if !(0.01..=0.5).contains(&strength) {
        return Err(format!(
            "what's there isn't a see-through watermark (strength {strength:.2})"
        ));
    }
    Ok(Estimate {
        alpha,
        gamma,
        white,
        strength,
    })
}

/// How much a point at file value `v` counts: one over the square of how far a level moves it in linear light,
/// so the fill's error of a level or two weighs the same in the darks and the brights.
fn level_weight(v: f32, gamma: f32) -> f32 {
    let derivative = gamma / 219.0 * ((v - 16.0) / 219.0).max(0.03).powf(gamma - 1.0);
    1.0 / (derivative * derivative).max(1e-12)
}

/// Weighted least-squares line through (x, y): slope and intercept.
fn weighted_line(x: &[f32], y: &[f32], w: &[f32]) -> (f32, f32) {
    let total: f64 = w.iter().map(|&v| f64::from(v)).sum::<f64>().max(1e-12);
    let mean = |values: &[f32]| {
        values
            .iter()
            .zip(w)
            .map(|(&v, &k)| f64::from(v) * f64::from(k))
            .sum::<f64>()
            / total
    };
    let (xm, ym) = (mean(x), mean(y));
    let (sxy, sxx) = x
        .iter()
        .zip(y)
        .zip(w)
        .fold((0.0f64, 0.0f64), |(a, b), ((&xv, &yv), &k)| {
            let (dx, dy) = (f64::from(xv) - xm, f64::from(yv) - ym);
            (a + f64::from(k) * dx * dy, b + f64::from(k) * dx * dx)
        });
    let slope = sxy / (sxx + 1e-18);
    (slope as f32, (ym - slope * xm) as f32)
}

/// Least-squares line through (x, y): slope and intercept.
fn line(x: &[f32], y: &[f32]) -> (f32, f32) {
    let n = x.len().max(1) as f32;
    let xm = x.iter().sum::<f32>() / n;
    let ym = y.iter().sum::<f32>() / n;
    let (sxy, sxx) = x.iter().zip(y).fold((0.0, 0.0), |(a, b), (&xv, &yv)| {
        (a + (xv - xm) * (yv - ym), b + (xv - xm).powi(2))
    });
    let slope = sxy / (sxx + 1e-9);
    (slope, ym - slope * xm)
}

fn median(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable_by(f32::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(0.0)
}

/// Where in the picture a see-through mark stays put: a quarter-size look at
/// footage a second apart, its strokes (thin and bright in the median) kept
/// where they lift the darks while the background under them keeps most of
/// its spread (a see-through mark; opaque text has none of its own). The box
/// in the picture's pixels (x0, y0, x1, y1).
fn detect(
    source: &Path,
    fw: usize,
    fh: usize,
    duration: f64,
    avoid: &[Shares],
    progress: &dyn Fn(f64),
) -> Result<(usize, usize, usize, usize), String> {
    let (w, h) = ((fw / 4) & !1, (fh / 4) & !1);
    let rate = (900.0 / duration.max(1.0)).min(1.0);
    let filters = format!("fps={rate:.6},scale={w}:{h}:flags=area,format=gray");
    let mut decoder = Decoder::open(source, 0.0, None, &filters, "gray", w * h, true)?;
    let mut hist = Hist::new(w, h);
    let mut frame = vec![0u8; w * h];
    let expected = (duration * rate).max(1.0);
    while decoder.next(&mut frame)? {
        hist.add(&frame);
        if hist.frames.is_multiple_of(50) {
            progress((hist.frames as f64 / expected).min(1.0));
        }
    }
    decoder.finish()?;
    if hist.frames < 30 {
        return Err("too little of the footage could be read to find a watermark".to_owned());
    }
    let q = hist.quantiles(&QS);
    let (Some(q20), Some(q50)) = (q.get(3), q.get(MEDIAN)) else {
        return Err("no quantiles".to_owned());
    };
    // Bright strokes in the median or in the darker quantiles (a see-through mark lifts the darks most).
    let tophat = |plane: &Plane| {
        let opened = plane.morph(9, true).morph(9, false);
        plane.zip(&opened, |a, b| a - b)
    };
    let (t20, t50) = (tophat(q20), tophat(q50));
    let mut m = Mask {
        w,
        h,
        data: t20
            .data
            .iter()
            .zip(&t50.data)
            .map(|(&a, &b)| a > 6.0 || b > 6.0)
            .collect(),
    };
    for &one in avoid {
        let (ax0, ay0, ax1, ay1) = to_pixels(one, w, h);
        for y in ay0..ay1.min(h) {
            for x in ax0..ax1.min(w) {
                m.set(x, y, false);
            }
        }
    }
    let md = m.dilate_disc(5);
    let curve = Curve {
        gamma: 2.4,
        white: 1.0,
    };
    let ql: Vec<Plane> = q
        .iter()
        .take(FITTED)
        .map(|plane| plane.map(|v| curve.lin(v)))
        .collect();
    let qj: Vec<Plane> = ql.iter().map(|plane| harmonic_fill(plane, &md)).collect();
    // A mark's pixel: its quantiles on one line against the background's (the same mark over every brightness),
    // lifting black, at most half opaque. A label only there some of the time isn't; nor is the scene's own edge.
    let mut marks = Mask::new(w, h);
    for p in 0..w * h {
        if !m.data.get(p).copied().unwrap_or(false) {
            continue;
        }
        let xs: Vec<f32> = qj
            .iter()
            .map(|j| j.data.get(p).copied().unwrap_or(0.0))
            .collect();
        let ys: Vec<f32> = ql
            .iter()
            .map(|l| l.data.get(p).copied().unwrap_or(0.0))
            .collect();
        let (slope, intercept) = line(&xs, &ys);
        let a = 1.0 - slope;
        let ym = ys.iter().sum::<f32>() / ys.len().max(1) as f32;
        let total: f32 = ys.iter().map(|y| (y - ym).powi(2)).sum();
        let residual: f32 = xs
            .iter()
            .zip(&ys)
            .map(|(&x, &y)| (y - (slope * x + intercept)).powi(2))
            .sum();
        let fit = if total > 0.0 {
            1.0 - residual / total
        } else {
            0.0
        };
        // At a quarter size a 4 × 4 block mixes letter and background in file values, which bends the line: its
        // slope can't be trusted there (it's learned at full size after), only that it is one and lifts black.
        if (-0.3..=0.5).contains(&a) && intercept > 0.006 && fit > 0.95 {
            if let Some(v) = marks.data.get_mut(p) {
                *v = true;
            }
        }
    }
    let mut kept: Vec<(usize, (usize, usize, usize, usize))> = Vec::new();
    for word in components(&marks.dilate(5)) {
        let strokes = word
            .iter()
            .filter(|&&p| marks.data.get(p).copied().unwrap_or(false))
            .count();
        if strokes < 12 {
            continue;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for &p in &word {
            let (x, y) = (p % w, p / w);
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
        }
        kept.push((strokes, (x0, y0, x1, y1)));
    }
    // Words near each other are one mark; the mark is the group with the most strokes.
    let mut groups: Vec<(usize, (usize, usize, usize, usize))> = Vec::new();
    for (strokes, b) in kept {
        let close = |g: &(usize, usize, usize, usize)| {
            b.0 <= g.2 + 16 && g.0 <= b.2 + 16 && b.1 <= g.3 + 16 && g.1 <= b.3 + 16
        };
        match groups.iter_mut().find(|(_, g)| close(g)) {
            Some((n, g)) => {
                *n += strokes;
                *g = (g.0.min(b.0), g.1.min(b.1), g.2.max(b.2), g.3.max(b.3));
            }
            None => groups.push((strokes, b)),
        }
    }
    let Some(&(_, (x0, y0, x1, y1))) = groups.iter().max_by_key(|(n, _)| *n) else {
        return Err("no see-through watermark that stays put was found in the footage".to_owned());
    };
    Ok((
        (x0 * fw) / w,
        (y0 * fh) / h,
        ((x1 * fw) / w).min(fw),
        ((y1 * fh) / h).min(fh),
    ))
}

/// The pixels of each connected (4-way) run of `mask`, by index.
fn components(mask: &Mask) -> Vec<Vec<usize>> {
    let (w, h) = (mask.w, mask.h);
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    for start in 0..w * h {
        if seen.get(start).copied().unwrap_or(true)
            || !mask.data.get(start).copied().unwrap_or(false)
        {
            continue;
        }
        let mut stack = vec![start];
        let mut part = Vec::new();
        if let Some(s) = seen.get_mut(start) {
            *s = true;
        }
        while let Some(p) = stack.pop() {
            part.push(p);
            let (x, y) = (p % w, p / w);
            let mut near = Vec::with_capacity(4);
            if x > 0 {
                near.push(p - 1);
            }
            if x + 1 < w {
                near.push(p + 1);
            }
            if y > 0 {
                near.push(p - w);
            }
            if y + 1 < h {
                near.push(p + w);
            }
            for q in near {
                if mask.data.get(q).copied().unwrap_or(false)
                    && !seen.get(q).copied().unwrap_or(true)
                {
                    if let Some(s) = seen.get_mut(q) {
                        *s = true;
                    }
                    stack.push(q);
                }
            }
        }
        out.push(part);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{letters_matte, scene};
    use super::*;

    /// A synthetic stretch: moving scenes with a still mark blended in linear light; the estimate finds its gamma, white and matte.
    #[test]
    fn learns_a_marks_matte_white_and_curve_from_its_footage() {
        let (w, h) = (200, 90);
        let truth = letters_matte(150, 40, 0.09);
        let curve = Curve {
            gamma: 2.5,
            white: 0.72,
        };
        let mut hist = Hist::new(w, h);
        for t in 0..900 {
            let picture = scene(w, h, t);
            let mut marked = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    let a = if (25..175).contains(&x) && (25..65).contains(&y) {
                        truth.at(x - 25, y - 25)
                    } else {
                        0.0
                    };
                    let j = picture.at(x, y);
                    let v = curve.mark(j, a);
                    if let Some(slot) = marked.get_mut(y * w + x) {
                        *slot = v.round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
            hist.add(&marked);
        }
        let got = estimate(&hist.quantiles(&QS), &Mask::new(w, h), None).unwrap();
        assert!((got.gamma - 2.5).abs() < 0.25, "gamma {}", got.gamma);
        // What counts: the learned mark lays the same light over every brightness as the real one.
        let learned = Curve {
            gamma: got.gamma,
            white: got.white,
        };
        for j in (16..=235).step_by(10) {
            let j = j as f32;
            let (want, have) = (curve.mark(j, 0.09), learned.mark(j, got.strength));
            assert!(
                (want - have).abs() < 2.0,
                "over {j}: {want} against {have} (white {}, strength {})",
                got.white,
                got.strength
            );
        }
        // The matte: each pixel's learned mark over a dark and a mid background as the real one, within a level and a half.
        let mut err = 0.0;
        let mut n = 0.0;
        for y in 0..40 {
            for x in 0..150 {
                let t = truth.at(x, y);
                if t > 0.02 {
                    let a = got.alpha.at(x + 25, y + 25);
                    for j in [30.0f32, 120.0] {
                        err += (curve.mark(j, t) - learned.mark(j, a)).abs();
                        n += 1.0;
                    }
                }
            }
        }
        assert!(
            n > 100.0 && err / n < 1.5,
            "matte error {} levels over {n}",
            err / n
        );
    }
}
