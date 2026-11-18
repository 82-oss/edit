//! One frame's mark undone (the lab's engine.py `restore_seq`, per frame).
//! The inverse gives each pixel's brightness; the texture comes from the
//! frames around, where the same bit of the scene isn't under the mark:
//! optical flow from this frame to each neighbour (nearest first, ±3 s), a
//! pixel taken when the flow agrees both ways and lands clear of the mark,
//! the median of the first three kept. The inverse then corrects the copy's
//! brightness at low frequency only where it's well conditioned (not in
//! crushed darks), and chroma likewise. A second pass fills what the first
//! couldn't from the first pass's results. Everything here is in the work
//! box's coordinates (a crop of the frame round where the mark goes).

use super::flow::{dis, Flow};
use super::plane::{Mask, Plane};
use super::{chroma_gain, Curve};

/// Candidates kept a pixel.
const K: usize = 3;
/// Flows worked out a frame at most (a second pass adds as many again for its holes).
const MAX_FLOWS: usize = 24;
/// New flows a second pass may add for its holes (they mostly have no clean source anywhere).
const MAX_FLOWS_AGAIN: usize = 4;
/// Padding round the mark's pixels that's worked on.
pub const PAD: usize = 40;
/// Room round that for the flow to land in.
pub const FLOW_MARGIN: usize = 48;
/// The lab's neighbours (frames at 23.976 fps), nearest first.
pub const STEPS: [i32; 24] = [
    1, -1, 2, -2, 3, -3, 5, -5, 8, -8, 12, -12, 18, -18, 24, -24, 32, -32, 48, -48, 64, -64, 80,
    -80,
];

/// A rectangle in the work box: [x0, x1) × [y0, y1), its corners even.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Rect {
    pub fn w(&self) -> usize {
        self.x1 - self.x0
    }
    pub fn h(&self) -> usize {
        self.y1 - self.y0
    }
    pub fn union(self, other: Self) -> Self {
        Self {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }
    /// Grown by `by`, inside [0, w) × [0, h), corners even.
    pub fn grown(&self, by: usize, w: usize, h: usize) -> Self {
        let x0 = self.x0.saturating_sub(by) & !1;
        let y0 = self.y0.saturating_sub(by) & !1;
        let x1 = ((self.x1 + by).min(w) + 1) & !1;
        let y1 = ((self.y1 + by).min(h) + 1) & !1;
        Self {
            x0,
            y0,
            x1: x1.min(w & !1),
            y1: y1.min(h & !1),
        }
    }
}

/// A frame's picture: its Y, U and V over the work box (4:2:0).
#[derive(Clone, Debug, Default)]
pub struct Picture {
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

/// What a frame's mark is, worked out once and read by its neighbours.
#[derive(Clone, Debug, Default)]
pub struct Prep {
    /// The box worked on (the mark's pixels and PAD), None where there's no mark.
    pub region: Option<Rect>,
    /// The mark's alpha over the region.
    pub alpha: Plane,
    /// The pixels to change: alpha > 0.003 grown 7 × 7.
    pub reg: Mask,
    /// Pixels a neighbour mustn't take: alpha > 0.002 grown 5 × 5.
    pub bad: Mask,
    /// The work box's brightness with the mark undone (rounded), what the flow is worked out on.
    pub m8: Vec<u8>,
    /// The undone brightness and colour over the region (colour at half size).
    pub my: Plane,
    pub mu: Plane,
    pub mv: Plane,
}

/// The work box: where it sits in the frame and the frame's size.
#[derive(Clone, Copy, Debug)]
pub struct Work {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    pub frame_w: usize,
    pub frame_h: usize,
}

/// Bilinear read of an 8-bit plane `w` wide, edge pixels outside.
#[inline]
pub fn read(bytes: &[u8], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let fx = x.floor();
    let fy = y.floor();
    let (ax, ay) = (x - fx, y - fy);
    let at = |x: isize, y: isize| {
        let x = x.clamp(0, w as isize - 1) as usize;
        let y = y.clamp(0, h as isize - 1) as usize;
        f32::from(bytes.get(y * w + x).copied().unwrap_or(0))
    };
    let (ix, iy) = (fx as isize, fy as isize);
    (at(ix, iy) * (1.0 - ax) + at(ix + 1, iy) * ax) * (1.0 - ay)
        + (at(ix, iy + 1) * (1.0 - ax) + at(ix + 1, iy + 1) * ax) * ay
}

/// A frame's mark worked out: `alpha` over a window of the work box from (ox, oy), zero at its edges (None: no mark this frame).
pub fn prep(
    picture: &Picture,
    work: Work,
    alpha: Option<(&Plane, usize, usize)>,
    curve: Curve,
) -> Prep {
    let mut out = Prep {
        m8: picture.y.clone(),
        ..Prep::default()
    };
    let Some((alpha, ox, oy)) = alpha else {
        return out;
    };
    let full = alpha.mask(|a| a > 0.003).dilate(7);
    let Some((x0, y0, x1, y1)) = full.bounds() else {
        return out;
    };
    let (x0, y0, x1, y1) = (x0 + ox, y0 + oy, x1 + ox, y1 + oy);
    // The lab's box: 40 more each side (41 at the far ends), corners even, inside the frame (here, the work box).
    let region = Rect {
        x0: x0.saturating_sub(PAD) & !1,
        y0: y0.saturating_sub(PAD) & !1,
        x1: ((x1 + PAD).min(work.w) + 1) & !1,
        y1: ((y1 + PAD).min(work.h) + 1) & !1,
    };
    let region = Rect {
        x1: region.x1.min(work.w & !1),
        y1: region.y1.min(work.h & !1),
        ..region
    };
    let (rw, rh) = (region.w(), region.h());
    let a = alpha.crop(
        region.x0 as isize - ox as isize,
        region.y0 as isize - oy as isize,
        rw,
        rh,
    );
    out.reg = full_crop(&full, region, ox, oy);
    out.bad = a.mask(|v| v > 0.002).dilate(5);
    let y = Plane::from_window(
        &picture.y,
        work.w,
        work.h,
        region.x0 as isize,
        region.y0 as isize,
        rw,
        rh,
    );
    out.my = y.zip(&a, |v, av| curve.undo(v, av));
    for (py, row) in out.my.rows().enumerate() {
        for (px, &v) in row.iter().enumerate() {
            if let Some(slot) = out.m8.get_mut((region.y0 + py) * work.w + region.x0 + px) {
                *slot = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    let (hw, hh) = (rw / 2, rh / 2);
    let ah = a.half();
    let jh = out.my.half();
    let gain = jh.zip(&ah, chroma_gain);
    let (cw, ch) = (work.w / 2, work.h / 2);
    let u = Plane::from_window(
        &picture.u,
        cw,
        ch,
        (region.x0 / 2) as isize,
        (region.y0 / 2) as isize,
        hw,
        hh,
    );
    let v = Plane::from_window(
        &picture.v,
        cw,
        ch,
        (region.x0 / 2) as isize,
        (region.y0 / 2) as isize,
        hw,
        hh,
    );
    out.mu = u.zip(&gain, |c, g| (c - 128.0) / g + 128.0);
    out.mv = v.zip(&gain, |c, g| (c - 128.0) / g + 128.0);
    out.alpha = a;
    out.region = Some(region);
    out
}

fn full_crop(mask: &Mask, region: Rect, ox: usize, oy: usize) -> Mask {
    let mut out = Mask::new(region.w(), region.h());
    for y in 0..region.h() {
        for x in 0..region.w() {
            let (mx, my) = (
                (region.x0 + x) as isize - ox as isize,
                (region.y0 + y) as isize - oy as isize,
            );
            if mx >= 0 && my >= 0 {
                out.set(x, y, mask.at(mx as usize, my as usize));
            }
        }
    }
    out
}

/// A neighbour as the restore reads it: its frame's offset, its prep, the picture copied from and what it mustn't give.
pub struct Neighbour<'a> {
    pub step: i32,
    /// Where the scene moved from this frame to it (whole pixels): its crop is taken there, so the flow only finds what's left.
    pub shift: (isize, isize),
    pub prep: &'a Prep,
    pub source: &'a Picture,
    /// Over its region (its prep's): pixels not to take.
    pub bad: &'a Mask,
}

/// Flows to each neighbour (both ways, over the frame's flow box), kept for the second pass.
#[derive(Default)]
pub struct Flows {
    /// Each neighbour's flows both ways, over the box they were worked out on.
    pub pairs: Vec<(i32, Rect, Flow, Flow)>,
}

/// One frame restored over its region.
pub struct Restored {
    pub y: Plane,
    pub u: Plane,
    pub v: Plane,
    /// The pixels a neighbour gave.
    pub valid: Mask,
    /// How much of the restored picture shows (the rest the source's).
    pub weight: Plane,
}

/// The flow box for a frame's region.
pub fn flow_area(region: Rect, work: Work) -> Rect {
    region.grown(FLOW_MARGIN, work.w, work.h)
}

fn flow_of(
    own: &Prep,
    other: &Prep,
    area: Rect,
    shift: (isize, isize),
    work: Work,
) -> (Flow, Flow) {
    let crop = |m8: &[u8], dx: isize, dy: isize| {
        Plane::from_window(
            m8,
            work.w,
            work.h,
            area.x0 as isize + dx,
            area.y0 as isize + dy,
            area.w(),
            area.h(),
        )
        .half()
    };
    let (a, b) = (crop(&own.m8, 0, 0), crop(&other.m8, shift.0, shift.1));
    (dis(&a, &b), dis(&b, &a))
}

/// Whether a neighbour can give anything: some of the region's pixels, moved by its shift, land in the work box clear of its mark.
fn useful(own: &Prep, region: Rect, neighbour: &Neighbour, work: Work) -> bool {
    let (dx, dy) = neighbour.shift;
    let other = neighbour.prep.region;
    let mut clear = 0usize;
    let mut total = 0usize;
    for py in (0..region.h()).step_by(2) {
        for px in (0..region.w()).step_by(2) {
            if !own.reg.at(px, py) {
                continue;
            }
            total += 1;
            let (x, y) = (
                (region.x0 + px) as isize + dx,
                (region.y0 + py) as isize + dy,
            );
            if x < 1 || y < 1 || x >= work.w as isize - 2 || y >= work.h as isize - 2 {
                continue;
            }
            let refused = other.is_some_and(|r| {
                let (lx, ly) = (x - r.x0 as isize, y - r.y0 as isize);
                lx >= 0
                    && ly >= 0
                    && (lx as usize) < r.w()
                    && (ly as usize) < r.h()
                    && neighbour.bad.at(lx as usize, ly as usize)
            });
            if !refused {
                clear += 1;
            }
        }
    }
    total > 0 && clear * 100 >= 3 * total
}

/// The flow's move at work-box pixel (x, y), in full-size pixels.
#[inline]
fn move_at(flow: &Flow, area: Rect, x: f32, y: f32) -> (f32, f32) {
    let sx = area.w() as f32 / flow.u.w.max(1) as f32;
    let sy = area.h() as f32 / flow.u.h.max(1) as f32;
    let fx = (x - area.x0 as f32 + 0.5) / sx - 0.5;
    let fy = (y - area.y0 as f32 + 0.5) / sy - 0.5;
    (flow.u.sample(fx, fy) * sx, flow.v.sample(fx, fy) * sy)
}

/// Restores a frame: `own` its prep and `source` its picture (the original, or the first pass's), `only` (over its region) the pixels this pass may change (the second pass: the first's holes).
#[allow(clippy::too_many_arguments)]
pub fn restore(
    own: &Prep,
    source: &Picture,
    neighbours: &[Neighbour],
    flows: &mut Flows,
    only: Option<&Mask>,
    work: Work,
    curve: Curve,
) -> Option<Restored> {
    let region = own.region?;
    let (rw, rh) = (region.w(), region.h());
    // Only the letters and a ring round them are filled (the ring feeds the brightness correction and the blend);
    // each neighbour's flow is worked out over the box of what's still waiting, which shrinks as near frames fill it.
    let wanted = match only {
        Some(holes) => holes.dilate(3),
        None => own.reg.dilate(19),
    };
    let wanted_count = wanted.count().max(1);
    let mut computed = 0usize;
    let mut cand = vec![vec![f32::NAN; rw * rh]; K];
    let (hw, hh) = (rw / 2, rh / 2);
    let mut cand_u = vec![vec![f32::NAN; hw * hh]; K];
    let mut cand_v = vec![vec![f32::NAN; hw * hh]; K];
    let mut count = vec![0usize; rw * rh];
    let (cw, ch) = (work.w / 2, work.h / 2);
    for neighbour in neighbours {
        let waiting = Mask {
            w: rw,
            h: rh,
            data: count
                .iter()
                .zip(&wanted.data)
                .map(|(&c, &w)| w && c < K)
                .collect(),
        };
        // Done when nearly every pixel has a candidate and most have their three: the last scattered ones would cost
        // every flow left. At most MAX_FLOWS flows a frame.
        let none = count
            .iter()
            .zip(&wanted.data)
            .filter(|(&c, &w)| w && c == 0)
            .count();
        if (none * 100 <= wanted_count && waiting.count() * 100 <= 15 * wanted_count)
            || computed
                >= if only.is_some() {
                    MAX_FLOWS_AGAIN
                } else {
                    MAX_FLOWS
                }
        {
            break;
        }
        let Some((bx0, by0, bx1, by1)) = waiting.bounds() else {
            break;
        };
        let at = flows
            .pairs
            .iter()
            .position(|(step, _, _, _)| *step == neighbour.step);
        let at = match at {
            Some(at) => at,
            None => {
                if !useful(own, region, neighbour, work) {
                    continue;
                }
                let waiting_box = Rect {
                    x0: region.x0 + bx0,
                    y0: region.y0 + by0,
                    x1: region.x0 + bx1,
                    y1: region.y0 + by1,
                };
                let area = flow_area(waiting_box, work);
                let (f, b) = flow_of(own, neighbour.prep, area, neighbour.shift, work);
                computed += 1;
                flows.pairs.push((neighbour.step, area, f, b));
                flows.pairs.len() - 1
            }
        };
        let Some((_, area, forward, backward)) = flows.pairs.get(at) else {
            continue;
        };
        let area = *area;
        let other = neighbour.prep.region;
        for py in by0..by1 {
            for px in bx0..bx1 {
                let i = py * rw + px;
                let Some(n) = count.get(i).copied() else {
                    continue;
                };
                if n >= K || !wanted.at(px, py) {
                    continue;
                }
                // Outside this neighbour's flow box (it was worked out for a smaller one).
                let (xr, yr) = (region.x0 + px, region.y0 + py);
                if xr < area.x0 || yr < area.y0 || xr >= area.x1 || yr >= area.y1 {
                    continue;
                }
                let (x, y) = ((region.x0 + px) as f32, (region.y0 + py) as f32);
                let (fu, fv) = move_at(forward, area, x, y);
                let (sx, sy) = (neighbour.shift.0 as f32, neighbour.shift.1 as f32);
                let (mx, my) = (x + fu + sx, y + fv + sy);
                let (gx, gy) = (mx + work.x as f32, my + work.y as f32);
                // Inside the frame, the work box, and the neighbour's flow box (its crop, moved by the shift).
                let (ax, ay) = (x + fu, y + fv);
                let inside = gx >= 1.0
                    && gx < work.frame_w as f32 - 2.0
                    && gy >= 1.0
                    && gy < work.frame_h as f32 - 2.0
                    && mx >= 0.0
                    && my >= 0.0
                    && mx <= (work.w - 1) as f32
                    && my <= (work.h - 1) as f32
                    && ax >= area.x0 as f32
                    && ay >= area.y0 as f32
                    && ax <= (area.x1 - 1) as f32
                    && ay <= (area.y1 - 1) as f32;
                if !inside {
                    continue;
                }
                let (bu, bv) = move_at(backward, area, ax, ay);
                if ((fu + bu).powi(2) + (fv + bv).powi(2)).sqrt() >= 1.2 {
                    continue;
                }
                let refused = match other {
                    Some(r) => {
                        let (lx, ly) = (mx - r.x0 as f32, my - r.y0 as f32);
                        if lx > -1.0 && ly > -1.0 && lx < r.w() as f32 && ly < r.h() as f32 {
                            bilinear_mask(neighbour.bad, lx, ly) >= 0.01
                        } else {
                            false
                        }
                    }
                    None => false,
                };
                if refused {
                    continue;
                }
                // The copy must look like this frame's undone picture where that's to be trusted (a flow that agrees
                // both ways can still be wrong: a white speck carried onto grey road, a jacket smeared at an occlusion).
                let own_value = own.my.at(px, py);
                let trust =
                    ((curve.slope(own_value, own.alpha.at(px, py)) - 0.3) / 0.4).clamp(0.0, 1.0);
                let theirs = read(&neighbour.prep.m8, work.w, work.h, mx, my);
                if (theirs - own_value).abs() > 10.0 + 30.0 * (1.0 - trust) {
                    continue;
                }
                if let Some(slot) = cand.get_mut(n).and_then(|c| c.get_mut(i)) {
                    *slot = read(&neighbour.source.y, work.w, work.h, mx, my);
                }
                if px % 2 == 0 && py % 2 == 0 && px / 2 < hw && py / 2 < hh {
                    let hi = (py / 2) * hw + px / 2;
                    if let Some(slot) = cand_u.get_mut(n).and_then(|c| c.get_mut(hi)) {
                        *slot = read(&neighbour.source.u, cw, ch, mx / 2.0, my / 2.0);
                    }
                    if let Some(slot) = cand_v.get_mut(n).and_then(|c| c.get_mut(hi)) {
                        *slot = read(&neighbour.source.v, cw, ch, mx / 2.0, my / 2.0);
                    }
                }
                if let Some(c) = count.get_mut(i) {
                    *c += 1;
                }
            }
        }
    }
    let median = |slots: &[Vec<f32>], i: usize| -> f32 {
        let mut values: Vec<f32> = slots
            .iter()
            .filter_map(|s| s.get(i).copied())
            .filter(|v| !v.is_nan())
            .collect();
        match values.len() {
            0 => f32::NAN,
            1 => values.first().copied().unwrap_or(f32::NAN),
            2 => values.iter().sum::<f32>() / 2.0,
            _ => {
                values.sort_unstable_by(f32::total_cmp);
                values.get(values.len() / 2).copied().unwrap_or(f32::NAN)
            }
        }
    };
    let fill_y = Plane {
        w: rw,
        h: rh,
        data: (0..rw * rh).map(|i| median(&cand, i)).collect(),
    };
    let fill_u = Plane {
        w: hw,
        h: hh,
        data: (0..hw * hh).map(|i| median(&cand_u, i)).collect(),
    };
    let fill_v = Plane {
        w: hw,
        h: hh,
        data: (0..hw * hh).map(|i| median(&cand_v, i)).collect(),
    };
    let valid = Mask {
        w: rw,
        h: rh,
        data: count.iter().map(|&c| c > 0).collect(),
    };
    let w_valid = valid.plane();
    let m = &own.my;
    // The inverse's brightness trusted only where it's well conditioned.
    let conf = m.zip(&own.alpha, |j, a| {
        ((curve.slope(j, a) - 0.3) / 0.4).clamp(0.0, 1.0)
    });
    let wl = w_valid.zip(&conf, |w, c| w * c);
    let d = Plane {
        w: rw,
        h: rh,
        data: m
            .data
            .iter()
            .zip(&fill_y.data)
            .zip(&valid.data)
            .map(|((&mv, &fv), &ok)| if ok { mv - fv } else { 0.0 })
            .collect(),
    };
    let sigma = 7.0;
    let nw = wl.gaussian_wide(sigma);
    let dw = d.zip(&wl, |a, b| a * b).gaussian_wide(sigma);
    let low = nw.zip(&dw, |n, s| if n > 0.05 { s / n.max(1e-3) } else { 0.0 });
    let fused = Plane {
        w: rw,
        h: rh,
        data: (0..rw * rh)
            .map(|i| {
                let ok = valid.data.get(i).copied().unwrap_or(false);
                if ok {
                    fill_y.data.get(i).copied().unwrap_or(0.0)
                        + low.data.get(i).copied().unwrap_or(0.0)
                } else {
                    m.data.get(i).copied().unwrap_or(0.0)
                }
            })
            .collect(),
    };
    let wv = w_valid.gaussian(1.5);
    let out_y = Plane {
        w: rw,
        h: rh,
        data: (0..rw * rh)
            .map(|i| {
                let wvv = wv.data.get(i).copied().unwrap_or(0.0);
                let f = fused.data.get(i).copied().unwrap_or(0.0);
                let f = if f.is_nan() { 0.0 } else { f };
                wvv * f + (1.0 - wvv) * m.data.get(i).copied().unwrap_or(0.0)
            })
            .collect(),
    };
    let regc = match only {
        Some(only) => Mask {
            w: rw,
            h: rh,
            data: own
                .reg
                .data
                .iter()
                .zip(&only.data)
                .map(|(&a, &b)| a && b)
                .collect(),
        },
        None => own.reg.clone(),
    };
    let mut bw = regc.plane().gaussian(1.0).map(|v| v.clamp(0.0, 1.0));
    if only.is_some() {
        bw = bw.zip(&w_valid, |a, b| a * b);
    }
    let src_y = Plane::from_window(
        &source.y,
        work.w,
        work.h,
        region.x0 as isize,
        region.y0 as isize,
        rw,
        rh,
    );
    let new_y = Plane {
        w: rw,
        h: rh,
        data: (0..rw * rh)
            .map(|i| {
                let b = bw.data.get(i).copied().unwrap_or(0.0);
                b * out_y.data.get(i).copied().unwrap_or(0.0)
                    + (1.0 - b) * src_y.data.get(i).copied().unwrap_or(0.0)
            })
            .collect(),
    };
    // Colour: the copies, their low frequencies corrected by the inverse's.
    let hv = Mask {
        w: hw,
        h: hh,
        data: (0..hw * hh)
            .map(|i| valid.at((i % hw.max(1)) * 2, (i / hw.max(1)) * 2))
            .collect(),
    };
    let wh = hv.plane();
    let nb = wh.gaussian_wide(sigma / 2.0).map(|v| v.max(1e-3));
    let whf = wh.gaussian(0.8);
    let bh = Plane {
        w: hw,
        h: hh,
        data: (0..hw * hh)
            .map(|i| bw.at((i % hw.max(1)) * 2, (i / hw.max(1)) * 2))
            .collect(),
    };
    let colour = |mc: &Plane, fill: &Plane, plane: &[u8]| -> Plane {
        let d = Plane {
            w: hw,
            h: hh,
            data: (0..hw * hh)
                .map(|i| {
                    if hv.data.get(i).copied().unwrap_or(false) {
                        mc.data.get(i).copied().unwrap_or(0.0)
                            - fill.data.get(i).copied().unwrap_or(0.0)
                    } else {
                        0.0
                    }
                })
                .collect(),
        };
        let lowc = d.gaussian_wide(sigma / 2.0).zip(&nb, |a, b| a / b);
        let src = Plane::from_window(
            plane,
            cw,
            ch,
            (region.x0 / 2) as isize,
            (region.y0 / 2) as isize,
            hw,
            hh,
        );
        Plane {
            w: hw,
            h: hh,
            data: (0..hw * hh)
                .map(|i| {
                    let mcv = mc.data.get(i).copied().unwrap_or(0.0);
                    let fv = if hv.data.get(i).copied().unwrap_or(false) {
                        fill.data.get(i).copied().unwrap_or(0.0)
                            + lowc.data.get(i).copied().unwrap_or(0.0)
                    } else {
                        mcv
                    };
                    let fv = if fv.is_nan() { 0.0 } else { fv };
                    let wf = whf.data.get(i).copied().unwrap_or(0.0);
                    let c = wf * fv + (1.0 - wf) * mcv;
                    let b = bh.data.get(i).copied().unwrap_or(0.0);
                    b * c + (1.0 - b) * src.data.get(i).copied().unwrap_or(0.0)
                })
                .collect(),
        }
    };
    let new_u = colour(&own.mu, &fill_u, &source.u);
    let new_v = colour(&own.mv, &fill_v, &source.v);
    let valid = Mask {
        w: rw,
        h: rh,
        data: valid
            .data
            .iter()
            .zip(&regc.data)
            .map(|(&a, &b)| a && b)
            .collect(),
    };
    Some(Restored {
        y: new_y,
        u: new_u,
        v: new_v,
        valid,
        weight: bw,
    })
}

/// A mask read bilinearly (1 where set), zero outside.
#[inline]
fn bilinear_mask(mask: &Mask, x: f32, y: f32) -> f32 {
    let fx = x.floor();
    let fy = y.floor();
    let (ax, ay) = (x - fx, y - fy);
    let at = |x: isize, y: isize| {
        if x < 0 || y < 0 || x >= mask.w as isize || y >= mask.h as isize {
            0.0
        } else if mask.at(x as usize, y as usize) {
            1.0
        } else {
            0.0
        }
    };
    let (ix, iy) = (fx as isize, fy as isize);
    (at(ix, iy) * (1.0 - ax) + at(ix + 1, iy) * ax) * (1.0 - ay)
        + (at(ix, iy + 1) * (1.0 - ax) + at(ix + 1, iy + 1) * ax) * ay
}

/// Writes a restored region into a copy of the frame's picture.
pub fn paste(into: &mut Picture, restored: &Restored, region: Rect, work: Work) {
    for (py, row) in restored.y.rows().enumerate() {
        for (px, &v) in row.iter().enumerate() {
            if let Some(slot) = into.y.get_mut((region.y0 + py) * work.w + region.x0 + px) {
                *slot = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    let cw = work.w / 2;
    for (plane, values) in [(&mut into.u, &restored.u), (&mut into.v, &restored.v)] {
        for (py, row) in values.rows().enumerate() {
            for (px, &v) in row.iter().enumerate() {
                if let Some(slot) = plane.get_mut((region.y0 / 2 + py) * cw + region.x0 / 2 + px) {
                    *slot = v.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}
