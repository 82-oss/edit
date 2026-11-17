//! Finding the mark in each frame (the lab's track.py): its matte's
//! gradients matched against the frame's (normalised cross-correlation of
//! the x and y Sobel gradients, averaged), so it's found whatever the
//! picture's brightness; near where it was at half size then full size to a
//! fraction of a pixel, and over the whole frame every half second at an
//! eighth then a quarter size, which is how a jump is caught. Then how strong
//! it is in that frame: the opacity at which the undone strokes' insides
//! match the background just outside them, on smooth stretches.

use super::plane::{Integral, Mask, Plane};
use super::Curve;

/// The matte's gradients at one size, zero-mean, with their norm.
struct Level {
    scale: usize,
    w: usize,
    h: usize,
    gx: Vec<f32>,
    gy: Vec<f32>,
    norm_x: f32,
    norm_y: f32,
}

impl Level {
    fn new(matte: &Plane, scale: usize) -> Self {
        let mut small = matte.clone();
        let mut s = 1;
        while s < scale {
            small = small.half();
            s *= 2;
        }
        let (gx, gy) = small.sobel();
        let centre = |g: &Plane| {
            let mean = g.data.iter().sum::<f32>() / g.data.len().max(1) as f32;
            let data: Vec<f32> = g.data.iter().map(|v| v - mean).collect();
            let norm = data.iter().map(|v| v * v).sum::<f32>().sqrt();
            (data, norm)
        };
        let ((gx, norm_x), (gy, norm_y)) = (centre(&gx), centre(&gy));
        Self {
            scale,
            w: small.w,
            h: small.h,
            gx,
            gy,
            norm_x,
            norm_y,
        }
    }
}

/// The mark's matte, ready to be looked for.
pub struct Template {
    levels: Vec<Level>,
}

/// Where the mark is in a frame: its matte's top left (full-size pixels) and how sure (−1–1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub x: f32,
    pub y: f32,
    pub score: f32,
}

impl Template {
    pub fn new(matte: &Plane) -> Self {
        Self {
            levels: [1usize, 2, 4, 8]
                .iter()
                .map(|&s| Level::new(matte, s))
                .collect(),
        }
    }

    fn level(&self, scale: usize) -> Option<&Level> {
        self.levels.iter().find(|l| l.scale == scale)
    }

    /// Best spot within `reach` full-size pixels of `near`, found at half size and refined at full size.
    pub fn near(&self, frame: &Frame, near: (f32, f32), reach: f32) -> Option<Spot> {
        let half = self.search(frame, 2, near, (reach / 2.0).ceil() as isize)?;
        let spot = self.search(frame, 1, (half.x, half.y), 2)?;
        Some(spot)
    }

    /// Best spots anywhere in the frame: an eighth size over all of it, the best few refined at a quarter, half and full size.
    pub fn anywhere(&self, frame: &Frame) -> Option<Spot> {
        let level = self.level(8)?;
        let (gx, gy, ox, oy) = frame.gradients(8, 0, 0, frame.w / 8, frame.h / 8);
        let (gw, gh) = (gx.w, gx.h);
        if gw <= level.w || gh <= level.h {
            return None;
        }
        let map = scores(&gx, &gy, level, 0, 0, gw - level.w, gh - level.h);
        // The best few peaks, far enough apart.
        let mut peaks: Vec<(f32, usize, usize)> = Vec::new();
        let mw = gw - level.w + 1;
        let mut order: Vec<(f32, usize)> = map
            .iter()
            .copied()
            .enumerate()
            .map(|(i, s)| (s, i))
            .collect();
        order.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
        for (score, i) in order {
            let (x, y) = (i % mw, i / mw);
            if peaks
                .iter()
                .all(|&(_, px, py)| px.abs_diff(x) > 3 || py.abs_diff(y) > 3)
            {
                peaks.push((score, x, y));
            }
            if peaks.len() >= 3 {
                break;
            }
        }
        let _ = (ox, oy);
        peaks
            .into_iter()
            .filter_map(|(_, x, y)| {
                let at = ((x * 8) as f32, (y * 8) as f32);
                let quarter = self.search(frame, 4, at, 3)?;
                self.near(frame, (quarter.x, quarter.y), 6.0)
            })
            .max_by(|a, b| a.score.total_cmp(&b.score))
    }

    /// The best spot at `scale` within `reach` (that size's pixels) of `near` (full-size), refined to a fraction of a pixel.
    fn search(&self, frame: &Frame, scale: usize, near: (f32, f32), reach: isize) -> Option<Spot> {
        let level = self.level(scale)?;
        let cx = (near.0 / scale as f32).round() as isize;
        let cy = (near.1 / scale as f32).round() as isize;
        let (sw, sh) = ((frame.w / scale) as isize, (frame.h / scale) as isize);
        let x0 = (cx - reach).clamp(0, (sw - level.w as isize).max(0));
        let y0 = (cy - reach).clamp(0, (sh - level.h as isize).max(0));
        let x1 = (cx + reach).clamp(0, (sw - level.w as isize).max(0));
        let y1 = (cy + reach).clamp(0, (sh - level.h as isize).max(0));
        if sw < level.w as isize || sh < level.h as isize {
            return None;
        }
        // The window the search reads, one pixel more each side for the gradients.
        let (wx, wy) = ((x0 - 1).max(0) as usize, (y0 - 1).max(0) as usize);
        let ww = ((x1 + level.w as isize + 1).min(sw) as usize).saturating_sub(wx);
        let wh = ((y1 + level.h as isize + 1).min(sh) as usize).saturating_sub(wy);
        let (gx, gy, _, _) = frame.gradients(scale, wx, wy, ww, wh);
        let (rx0, ry0) = (x0 as usize - wx, y0 as usize - wy);
        let (rx1, ry1) = (x1 as usize - wx, y1 as usize - wy);
        let map = scores(&gx, &gy, level, rx0, ry0, rx1, ry1);
        let mw = rx1 - rx0 + 1;
        let (best, i) = map
            .iter()
            .copied()
            .enumerate()
            .map(|(i, s)| (s, i))
            .max_by(|a, b| a.0.total_cmp(&b.0))?;
        let (bx, by) = (i % mw, i / mw);
        let at = |x: isize, y: isize| -> Option<f32> {
            if x < 0 || y < 0 || x as usize >= mw || y as usize > ry1 - ry0 {
                None
            } else {
                map.get(y as usize * mw + x as usize).copied()
            }
        };
        let peak = |a: Option<f32>, b: f32, c: Option<f32>| match (a, c) {
            (Some(a), Some(c)) => {
                let d = a - 2.0 * b + c;
                if d.abs() < 1e-9 {
                    0.0
                } else {
                    (0.5 * (a - c) / d).clamp(-1.0, 1.0)
                }
            }
            _ => 0.0,
        };
        let (bxi, byi) = (bx as isize, by as isize);
        let dx = peak(at(bxi - 1, byi), best, at(bxi + 1, byi));
        let dy = peak(at(bxi, byi - 1), best, at(bxi, byi + 1));
        Some(Spot {
            x: ((wx + rx0 + bx) as f32 + dx) * scale as f32,
            y: ((wy + ry0 + by) as f32 + dy) * scale as f32,
            score: best,
        })
    }
}

/// Scores (the x and y gradients' normalised cross-correlations, averaged) for top lefts [x0, x1] × [y0, y1] of `level` over (gx, gy).
fn scores(
    gx: &Plane,
    gy: &Plane,
    level: &Level,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
) -> Vec<f32> {
    let n = (level.w * level.h) as f64;
    let (ix, ix2) = (Integral::new(gx), Integral::new(&gx.map(|v| v * v)));
    let (iy, iy2) = (Integral::new(gy), Integral::new(&gy.map(|v| v * v)));
    let mut out = Vec::with_capacity((x1 + 1 - x0) * (y1 + 1 - y0));
    for y in y0..=y1 {
        for x in x0..=x1 {
            let mut dot_x = 0.0f32;
            let mut dot_y = 0.0f32;
            for ty in 0..level.h {
                let (Some(rx), Some(ry)) = (
                    gx.data
                        .get((y + ty) * gx.w + x..(y + ty) * gx.w + x + level.w),
                    gy.data
                        .get((y + ty) * gy.w + x..(y + ty) * gy.w + x + level.w),
                ) else {
                    continue;
                };
                let (Some(tx), Some(tyv)) = (
                    level.gx.get(ty * level.w..(ty + 1) * level.w),
                    level.gy.get(ty * level.w..(ty + 1) * level.w),
                ) else {
                    continue;
                };
                dot_x += rx.iter().zip(tx).map(|(a, b)| a * b).sum::<f32>();
                dot_y += ry.iter().zip(tyv).map(|(a, b)| a * b).sum::<f32>();
            }
            let var = |i: &Integral, i2: &Integral| {
                let s = i.sum(x, y, x + level.w, y + level.h);
                let s2 = i2.sum(x, y, x + level.w, y + level.h);
                (s2 - s * s / n).max(0.0).sqrt() as f32
            };
            let (vx, vy) = (var(&ix, &ix2), var(&iy, &iy2));
            let cx = if vx * level.norm_x > 1e-6 {
                dot_x / (vx * level.norm_x)
            } else {
                0.0
            };
            let cy = if vy * level.norm_y > 1e-6 {
                dot_y / (vy * level.norm_y)
            } else {
                0.0
            };
            out.push((cx + cy) / 2.0);
        }
    }
    out
}

/// A frame's brightness as the search reads it.
pub struct Frame<'a> {
    pub y: &'a [u8],
    pub w: usize,
    pub h: usize,
}

impl Frame<'_> {
    /// The Sobel gradients of the window (x0, y0, w, h) of this frame at 1/`scale` size (each pixel the mean of its scale × scale block).
    fn gradients(
        &self,
        scale: usize,
        x0: usize,
        y0: usize,
        w: usize,
        h: usize,
    ) -> (Plane, Plane, usize, usize) {
        let (gx, gy) = self.small(scale, x0, y0, w, h).sobel();
        (gx, gy, x0, y0)
    }

    /// The window (x0, y0, w, h) of this frame at 1/`scale` size (each pixel the mean of its scale × scale block).
    pub fn small(&self, scale: usize, x0: usize, y0: usize, w: usize, h: usize) -> Plane {
        let mut small = Plane::new(w, h, 0.0);
        let inv = 1.0 / (scale * scale) as f32;
        for (y, row) in small.rows_mut().enumerate() {
            for (x, value) in row.iter_mut().enumerate() {
                let (sx, sy) = ((x0 + x) * scale, (y0 + y) * scale);
                let mut sum = 0u32;
                for dy in 0..scale {
                    let Some(line) = self
                        .y
                        .get((sy + dy).min(self.h.saturating_sub(1)) * self.w..)
                    else {
                        continue;
                    };
                    for dx in 0..scale {
                        sum += u32::from(
                            line.get((sx + dx).min(self.w.saturating_sub(1)))
                                .copied()
                                .unwrap_or(0),
                        );
                    }
                }
                *value = sum as f32 * inv;
            }
        }
        small
    }
}

/// The matte placed at `at` (its top left, full-size pixels), scaled by `c`, over the window (ox, oy, w, h).
pub fn placed(
    matte: &Plane,
    at: (f32, f32),
    c: f32,
    window: (usize, usize, usize, usize),
) -> Plane {
    let (x, y) = at;
    let (ox, oy, w, h) = window;
    let mut out = Plane::new(w, h, 0.0);
    if c <= 0.0 {
        return out;
    }
    for (row, line) in out.rows_mut().enumerate() {
        let my = (oy + row) as f32 - y;
        if my <= -1.0 || my >= matte.h as f32 {
            continue;
        }
        for (col, value) in line.iter_mut().enumerate() {
            let mx = (ox + col) as f32 - x;
            if mx <= -1.0 || mx >= matte.w as f32 {
                continue;
            }
            *value = c * matte.sample_zero(mx, my);
        }
    }
    out
}

/// The mark's opacity in this frame (1: as learned): undone at the right
/// opacity, the strokes' insides (2–4 px in) match the background 4–6 px
/// outside, where that background is smooth. None when too little of it is.
pub fn opacity(frame: &Frame, matte: &Plane, at: (f32, f32), curve: Curve) -> Option<f32> {
    let pad = 12usize;
    let ox = (at.0.floor() as isize - pad as isize).max(0) as usize;
    let oy = (at.1.floor() as isize - pad as isize).max(0) as usize;
    let w = ((at.0.ceil() as usize + matte.w + pad).min(frame.w)).saturating_sub(ox);
    let h = ((at.1.ceil() as usize + matte.h + pad).min(frame.h)).saturating_sub(oy);
    if w < 16 || h < 16 {
        return None;
    }
    let a = placed(matte, at, 1.0, (ox, oy, w, h));
    let peak = a.data.iter().copied().fold(0.0f32, f32::max);
    if peak <= 0.0 {
        return None;
    }
    let image = Plane::from_window(frame.y, frame.w, frame.h, ox as isize, oy as isize, w, h);
    let strokes = a.mask(|v| v > 0.5 * peak);
    let inside = distance(&strokes);
    let outside = distance(&Mask {
        w,
        h,
        data: strokes.data.iter().map(|v| !v).collect(),
    });
    let band = |d: &Plane, lo: f32, hi: f32| d.map(|v| if v >= lo && v <= hi { 1.0 } else { 0.0 });
    let (inb, outb) = (band(&inside, 2.0, 4.0), band(&outside, 4.0, 6.0));
    let k = 4usize;
    let (bi, bo) = (Integral::new(&inb), Integral::new(&outb));
    let (so, so2) = (
        Integral::new(&image.zip(&outb, |v, b| v * b)),
        Integral::new(&image.zip(&outb, |v, b| v * v * b)),
    );
    let mut edges: Vec<(usize, usize, f64, f64)> = Vec::new();
    for y in k..h.saturating_sub(k + 1) {
        for x in k..w.saturating_sub(k + 1) {
            let d = inside.at(x, y);
            if !(d > 0.0 && d <= 1.5) {
                continue;
            }
            let (x0, y0, x1, y1) = (x - k, y - k, x + k + 1, y + k + 1);
            let area = ((x1 - x0) * (y1 - y0)) as f64;
            let (ni, no) = (bi.sum(x0, y0, x1, y1), bo.sum(x0, y0, x1, y1));
            if ni / area <= 0.1 || no / area <= 0.1 {
                continue;
            }
            let mean_out = so.sum(x0, y0, x1, y1) / no;
            let var_out = so2.sum(x0, y0, x1, y1) / no - mean_out * mean_out;
            if var_out < 16.0 {
                edges.push((x, y, mean_out, ni));
            }
        }
    }
    if edges.len() < 30 {
        return None;
    }
    let error = |c: f32| -> f32 {
        let undone = Plane {
            w,
            h,
            data: image
                .data
                .iter()
                .zip(&a.data)
                .zip(&inb.data)
                .map(|((&v, &av), &b)| if b > 0.0 { curve.undo(v, av * c) } else { 0.0 })
                .collect(),
        };
        let ij = Integral::new(&undone);
        let mut diffs: Vec<f32> = edges
            .iter()
            .map(|&(x, y, mean_out, ni)| {
                (ij.sum(x - k, y - k, x + k + 1, y + k + 1) / ni - mean_out) as f32
            })
            .collect();
        diffs.sort_unstable_by(f32::total_cmp);
        diffs.get(diffs.len() / 2).copied().unwrap_or(0.0)
    };
    // The opacity where the error crosses zero, between grid points.
    let grid: Vec<(f32, f32)> = (0..=32)
        .map(|i| i as f32 * 0.05)
        .map(|c| (c, error(c)))
        .collect();
    // Over brights the mark changes so little that its strength can't be told.
    let (Some(none), Some(full)) = (grid.first(), grid.get(20)) else {
        return None;
    };
    if (none.1 - full.1).abs() < 6.0 {
        return None;
    }
    for pair in grid.windows(2) {
        if let [(c0, e0), (c1, e1)] = pair {
            if *e0 > 0.0 && *e1 <= 0.0 {
                return Some(c0 + (c1 - c0) * e0 / (e0 - e1));
            }
        }
    }
    grid.iter()
        .min_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
        .map(|&(c, _)| c)
}

/// Each set pixel's distance to the nearest unset one (two-pass 3-4 chamfer, in pixels), 0 where unset.
pub fn distance(mask: &Mask) -> Plane {
    let (w, h) = (mask.w, mask.h);
    let far = (w + h) as f32 * 3.0;
    let mut d = Plane {
        w,
        h,
        data: mask
            .data
            .iter()
            .map(|&v| if v { far } else { 0.0 })
            .collect(),
    };
    let get = |d: &Plane, x: isize, y: isize| {
        if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
            far
        } else {
            d.at(x as usize, y as usize)
        }
    };
    for y in 0..h as isize {
        for x in 0..w as isize {
            let here = d.at(x as usize, y as usize);
            if here == 0.0 {
                continue;
            }
            let best = here
                .min(get(&d, x - 1, y) + 3.0)
                .min(get(&d, x, y - 1) + 3.0)
                .min(get(&d, x - 1, y - 1) + 4.0)
                .min(get(&d, x + 1, y - 1) + 4.0);
            d.set(x as usize, y as usize, best);
        }
    }
    for y in (0..h as isize).rev() {
        for x in (0..w as isize).rev() {
            let here = d.at(x as usize, y as usize);
            if here == 0.0 {
                continue;
            }
            let best = here
                .min(get(&d, x + 1, y) + 3.0)
                .min(get(&d, x, y + 1) + 3.0)
                .min(get(&d, x + 1, y + 1) + 4.0)
                .min(get(&d, x - 1, y + 1) + 4.0);
            d.set(x as usize, y as usize, best);
        }
    }
    // Outside the picture doesn't count as unset: only real unset pixels end a distance (the border cases stay far).
    d.map(|v| v / 3.0)
}

#[cfg(test)]
mod tests {
    use super::super::tests_support::{letters_matte, scene};
    use super::*;

    fn marked(
        w: usize,
        h: usize,
        t: usize,
        matte: &Plane,
        at: (f32, f32),
        c: f32,
        curve: Curve,
    ) -> Vec<u8> {
        let picture = scene(w, h, t);
        let a = placed(matte, at, c, (0, 0, w, h));
        picture
            .data
            .iter()
            .zip(&a.data)
            .map(|(&j, &av)| curve.mark(j, av).round().clamp(0.0, 255.0) as u8)
            .collect()
    }

    #[test]
    fn finds_a_faint_mark_anywhere_and_to_a_fraction_of_a_pixel_near() {
        let curve = Curve {
            gamma: 2.5,
            white: 0.72,
        };
        let matte = letters_matte(150, 40, 0.09);
        let template = Template::new(&matte);
        let (w, h) = (480, 270);
        for (t, at) in [
            (3usize, (201.4f32, 120.7f32)),
            (40, (30.0, 200.2)),
            (77, (300.6, 15.3)),
        ] {
            let frame = marked(w, h, t, &matte, at, 1.0, curve);
            let frame = Frame { y: &frame, w, h };
            let spot = template.anywhere(&frame).unwrap();
            assert!(
                (spot.x - at.0).abs() < 0.6 && (spot.y - at.1).abs() < 0.6,
                "{at:?}: {spot:?}"
            );
            assert!(spot.score > 0.15, "{spot:?}");
            let near = template
                .near(&frame, (at.0 + 7.0, at.1 - 5.0), 20.0)
                .unwrap();
            assert!(
                (near.x - at.0).abs() < 0.5 && (near.y - at.1).abs() < 0.5,
                "{at:?}: {near:?}"
            );
        }
        // No mark: nothing scores like one.
        let picture: Vec<u8> = scene(w, h, 5)
            .data
            .iter()
            .map(|&v| v.round() as u8)
            .collect();
        let spot = template.anywhere(&Frame { y: &picture, w, h }).unwrap();
        assert!(spot.score < 0.25, "{spot:?}");
    }

    #[test]
    fn fits_the_opacity_of_a_fading_mark() {
        let curve = Curve {
            gamma: 2.5,
            white: 0.72,
        };
        let matte = letters_matte(150, 40, 0.09);
        let (w, h) = (300, 140);
        let at = (60.0, 50.0);
        for &c in &[1.0f32, 0.7, 0.4] {
            let mut got = Vec::new();
            for t in 0..9 {
                let frame = marked(w, h, t * 11, &matte, at, c, curve);
                if let Some(o) = opacity(&Frame { y: &frame, w, h }, &matte, at, curve) {
                    got.push(o);
                }
            }
            got.sort_unstable_by(f32::total_cmp);
            let median = got.get(got.len() / 2).copied().unwrap();
            assert!((median - c).abs() < 0.12, "c {c}: {got:?}");
        }
    }
}
