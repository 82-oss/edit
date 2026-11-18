//! Dense optical flow by inverse search (Kroeger et al. 2016, "DIS", as
//! OpenCV's medium preset runs it): patches of the first picture looked for
//! in the second coarse to fine, each by Gauss-Newton on mean-normalised
//! intensities, then spread to every pixel weighted by how well each patch's
//! move explains it. It only ever runs on the small box round a watermark, so
//! a whole flow is a fraction of a millisecond to a few.

use super::plane::Plane;

/// A flow field: each pixel's move (x, y) into the other picture.
#[derive(Clone, Debug, Default)]
pub struct Flow {
    pub u: Plane,
    pub v: Plane,
}

impl Flow {
    pub fn zero(w: usize, h: usize) -> Self {
        Self {
            u: Plane::new(w, h, 0.0),
            v: Plane::new(w, h, 0.0),
        }
    }

    /// Resized to `w × h`, the moves scaled with it.
    pub fn resized(&self, w: usize, h: usize) -> Self {
        let sx = w as f32 / self.u.w.max(1) as f32;
        let sy = h as f32 / self.u.h.max(1) as f32;
        Self {
            u: self.u.resized(w, h).map(|v| v * sx),
            v: self.v.resized(w, h).map(|v| v * sy),
        }
    }
}

const PATCH: usize = 8;
const STRIDE: usize = 4;
const ITERATIONS: usize = 8;

/// The flow from `a` to `b` (same size), worked out to half their size (OpenCV's finest scale 1) and returned at that size.
pub fn dis(a: &Plane, b: &Plane) -> Flow {
    // Pyramids: level 0 is the pictures as given.
    let coarsest = {
        let wide = (2.0 * a.w as f32 / (4.0 * PATCH as f32))
            .max(1.0)
            .log2()
            .floor() as usize;
        wide.clamp(1, 5)
    };
    let mut pa = vec![a.clone()];
    let mut pb = vec![b.clone()];
    for _ in 0..coarsest {
        let (Some(la), Some(lb)) = (pa.last(), pb.last()) else {
            break;
        };
        let (na, nb) = (la.half(), lb.half());
        pa.push(na);
        pb.push(nb);
    }
    let top = pa.len() - 1;
    let mut flow: Option<Flow> = None;
    for level in (1..=top).rev() {
        let (Some(ia), Some(ib)) = (pa.get(level), pb.get(level)) else {
            continue;
        };
        let start = match flow.take() {
            Some(previous) => previous.resized(ia.w, ia.h),
            None => Flow::zero(ia.w, ia.h),
        };
        flow = Some(level_flow(ia, ib, &start));
    }
    flow.unwrap_or_else(|| Flow::zero(a.w.div_ceil(2), a.h.div_ceil(2)))
}

/// One level: every patch's move found from `start`, then densified.
fn level_flow(a: &Plane, b: &Plane, start: &Flow) -> Flow {
    let (gx, gy) = a.sobel();
    let (gx, gy) = (gx.map(|v| v / 8.0), gy.map(|v| v / 8.0));
    let w = a.w;
    let h = a.h;
    if w < PATCH || h < PATCH {
        return start.clone();
    }
    let xs: Vec<usize> = grid(w);
    let ys: Vec<usize> = grid(h);
    let mut moves: Vec<(f32, f32)> = Vec::with_capacity(xs.len() * ys.len());
    let n = (PATCH * PATCH) as f32;
    for (row, &py) in ys.iter().enumerate() {
        for (col, &px) in xs.iter().enumerate() {
            // The template: the patch of `a`, mean-normalised, its gradients and their Hessian.
            let mut t = [0f32; PATCH * PATCH];
            let mut tx = [0f32; PATCH * PATCH];
            let mut ty = [0f32; PATCH * PATCH];
            let mut mean = 0.0;
            for (k, ((tv, txv), tyv)) in t
                .iter_mut()
                .zip(tx.iter_mut())
                .zip(ty.iter_mut())
                .enumerate()
            {
                let (x, y) = (px + k % PATCH, py + k / PATCH);
                *tv = a.at(x, y);
                *txv = gx.at(x, y);
                *tyv = gy.at(x, y);
                mean += *tv;
            }
            mean /= n;
            let (mut gxm, mut gym) = (0.0, 0.0);
            for (tv, (txv, tyv)) in t.iter_mut().zip(tx.iter().zip(&ty)) {
                *tv -= mean;
                gxm += txv;
                gym += tyv;
            }
            let (gxm, gym) = (gxm / n, gym / n);
            let (mut hxx, mut hxy, mut hyy) = (0.0f32, 0.0f32, 0.0f32);
            for (txv, tyv) in tx.iter_mut().zip(ty.iter_mut()) {
                *txv -= gxm;
                *tyv -= gym;
                hxx += *txv * *txv;
                hxy += *txv * *tyv;
                hyy += *tyv * *tyv;
            }
            let det = hxx * hyy - hxy * hxy;
            let centre = ((px + PATCH / 2) as f32, (py + PATCH / 2) as f32);
            // Spatial propagation: the move carried down from the coarser level, or the patch's left or upper neighbour's, whichever fits best.
            let mut candidates = vec![(
                start.u.sample(centre.0, centre.1),
                start.v.sample(centre.0, centre.1),
            )];
            if col > 0 {
                if let Some(&m) = moves.get(row * xs.len() + col - 1) {
                    candidates.push(m);
                }
            }
            if row > 0 {
                if let Some(&m) = moves.get((row - 1) * xs.len() + col) {
                    candidates.push(m);
                }
            }
            let cost = |u: f32, v: f32| -> f32 {
                let mut warped = [0f32; PATCH * PATCH];
                let mut m = 0.0;
                for (k, value) in warped.iter_mut().enumerate() {
                    *value = b.sample((px + k % PATCH) as f32 + u, (py + k / PATCH) as f32 + v);
                    m += *value;
                }
                m /= n;
                warped
                    .iter()
                    .zip(&t)
                    .map(|(&wv, &tv)| (wv - m - tv).powi(2))
                    .sum()
            };
            let mut best = candidates.first().copied().unwrap_or((0.0, 0.0));
            let mut best_cost = cost(best.0, best.1);
            for &(u, v) in candidates.iter().skip(1) {
                let c = cost(u, v);
                if c < best_cost {
                    best_cost = c;
                    best = (u, v);
                }
            }
            let (mut u, mut v) = best;
            if det.abs() > 1e-6 {
                // Gauss-Newton from the best start, keeping the best fit seen; a patch never wanders past its own size.
                let mut kept = (best_cost, u, v);
                for _ in 0..ITERATIONS {
                    let mut warped = [0f32; PATCH * PATCH];
                    let mut m = 0.0;
                    for (k, value) in warped.iter_mut().enumerate() {
                        *value = b.sample((px + k % PATCH) as f32 + u, (py + k / PATCH) as f32 + v);
                        m += *value;
                    }
                    m /= n;
                    let (mut bx, mut by, mut ssd) = (0.0f32, 0.0f32, 0.0f32);
                    for (((wv, tv), txv), tyv) in warped.iter().zip(&t).zip(&tx).zip(&ty) {
                        let e = wv - m - tv;
                        bx += txv * e;
                        by += tyv * e;
                        ssd += e * e;
                    }
                    if ssd < kept.0 {
                        kept = (ssd, u, v);
                    } else if ssd > kept.0 * 1.5 {
                        break;
                    }
                    let du = (hyy * bx - hxy * by) / det;
                    let dv = (hxx * by - hxy * bx) / det;
                    u -= du;
                    v -= dv;
                    if !u.is_finite()
                        || !v.is_finite()
                        || (u - best.0).abs() > PATCH as f32
                        || (v - best.1).abs() > PATCH as f32
                    {
                        break;
                    }
                    if du * du + dv * dv < 1e-4 {
                        let c = cost(u, v);
                        if c < kept.0 {
                            kept = (c, u, v);
                        }
                        break;
                    }
                }
                (u, v) = (kept.1, kept.2);
            }
            moves.push((u, v));
        }
    }
    densify(a, b, &xs, &ys, &moves)
}

/// Patch corners along one side: every STRIDE pixels, the last flush with the edge.
fn grid(size: usize) -> Vec<usize> {
    let last = size - PATCH;
    let mut out: Vec<usize> = (0..=last).step_by(STRIDE).collect();
    if out.last() != Some(&last) {
        out.push(last);
    }
    out
}

/// Each pixel's move: the moves of the patches covering it, each weighted by 1 / max(1, how far off it puts the pixel).
fn densify(a: &Plane, b: &Plane, xs: &[usize], ys: &[usize], moves: &[(f32, f32)]) -> Flow {
    let (w, h) = (a.w, a.h);
    let mut su = Plane::new(w, h, 0.0);
    let mut sv = Plane::new(w, h, 0.0);
    let mut sw = Plane::new(w, h, 0.0);
    for (row, &py) in ys.iter().enumerate() {
        for (col, &px) in xs.iter().enumerate() {
            let Some(&(u, v)) = moves.get(row * xs.len() + col) else {
                continue;
            };
            for dy in 0..PATCH {
                for dx in 0..PATCH {
                    let (x, y) = (px + dx, py + dy);
                    let d = (b.sample(x as f32 + u, y as f32 + v) - a.at(x, y)).abs();
                    let weight = 1.0 / d.max(1.0);
                    let at = y * w + x;
                    if let (Some(pu), Some(pv), Some(pw)) = (
                        su.data.get_mut(at),
                        sv.data.get_mut(at),
                        sw.data.get_mut(at),
                    ) {
                        *pu += weight * u;
                        *pv += weight * v;
                        *pw += weight;
                    }
                }
            }
        }
    }
    for ((pu, pv), &pw) in su.data.iter_mut().zip(sv.data.iter_mut()).zip(&sw.data) {
        if pw > 0.0 {
            *pu /= pw;
            *pv /= pw;
        }
    }
    Flow { u: su, v: sv }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texture(w: usize, h: usize, shift: (f32, f32)) -> Plane {
        let mut out = Plane::new(w, h, 0.0);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32 - shift.0, y as f32 - shift.1);
                let value = 120.0
                    + 50.0 * (fx * 0.31).sin() * (fy * 0.23).cos()
                    + 30.0 * ((fx + fy) * 0.11).sin()
                    + 20.0 * (fx * 0.07 - fy * 0.13).cos();
                out.set(x, y, value);
            }
        }
        out
    }

    #[test]
    fn finds_a_whole_picture_move() {
        let a = texture(160, 96, (0.0, 0.0));
        let b = texture(160, 96, (5.3, -3.6));
        let flow = dis(&a, &b).resized(160, 96);
        let (mut eu, mut ev, mut n) = (0.0, 0.0, 0.0);
        for y in 16..80 {
            for x in 16..144 {
                eu += (flow.u.at(x, y) - 5.3).abs();
                ev += (flow.v.at(x, y) + 3.6).abs();
                n += 1.0;
            }
        }
        assert!(
            eu / n < 0.35 && ev / n < 0.35,
            "mean error {} {}",
            eu / n,
            ev / n
        );
    }
}
