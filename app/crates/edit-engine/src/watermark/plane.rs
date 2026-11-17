//! Float pictures (one plane each) and the handful of operations the
//! watermark work needs: crops, halving, bilinear reads and resizes, blurs,
//! Sobel gradients and morphology. Borders mirror the edge pixel
//! (OpenCV's BORDER_REFLECT_101), as the lab's OpenCV did.

/// One plane of a picture, row by row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

/// Index `i` reflected into `0..n` without repeating the edge (…2 1 | 0 1 2 … n-1 | n-2 …).
#[inline]
pub fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    if n <= 1 {
        return 0;
    }
    let period = 2 * (n - 1);
    let mut i = i.rem_euclid(period);
    if i >= n {
        i = period - i;
    }
    i as usize
}

impl Plane {
    pub fn new(w: usize, h: usize, value: f32) -> Self {
        Self {
            w,
            h,
            data: vec![value; w * h],
        }
    }

    /// A `w × h` window of `bytes` (a plane `stride` wide) from (x0, y0), clamped at its edges.
    pub fn from_window(
        bytes: &[u8],
        stride: usize,
        rows: usize,
        x0: isize,
        y0: isize,
        w: usize,
        h: usize,
    ) -> Self {
        let mut out = Self::new(w, h, 0.0);
        if stride == 0 || rows == 0 {
            return out;
        }
        for (y, row) in out.data.chunks_exact_mut(w.max(1)).enumerate() {
            let sy = (y0 + y as isize).clamp(0, rows as isize - 1) as usize;
            for (x, value) in row.iter_mut().enumerate() {
                let sx = (x0 + x as isize).clamp(0, stride as isize - 1) as usize;
                *value = f32::from(bytes.get(sy * stride + sx).copied().unwrap_or(0));
            }
        }
        out
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.data.get(y * self.w + x).copied().unwrap_or(0.0)
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, value: f32) {
        let w = self.w;
        if let Some(slot) = self.data.get_mut(y * w + x) {
            *slot = value;
        }
    }

    /// The pixel at (x, y), the nearest edge pixel outside.
    #[inline]
    pub fn clamped(&self, x: isize, y: isize) -> f32 {
        if self.w == 0 || self.h == 0 {
            return 0.0;
        }
        let x = x.clamp(0, self.w as isize - 1) as usize;
        let y = y.clamp(0, self.h as isize - 1) as usize;
        self.at(x, y)
    }

    /// Bilinear read at (x, y) (pixel centres at integers), edge pixels outside.
    #[inline]
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        let fx = x.floor();
        let fy = y.floor();
        let (ax, ay) = (x - fx, y - fy);
        let (ix, iy) = (fx as isize, fy as isize);
        // Inside: two short slices, one bounds check each.
        if ix >= 0 && iy >= 0 && (ix as usize) + 1 < self.w && (iy as usize) + 1 < self.h {
            let at = iy as usize * self.w + ix as usize;
            if let (Some(&[a, b]), Some(&[c, d])) = (
                self.data
                    .get(at..at + 2)
                    .and_then(|s| <&[f32; 2]>::try_from(s).ok()),
                self.data
                    .get(at + self.w..at + self.w + 2)
                    .and_then(|s| <&[f32; 2]>::try_from(s).ok()),
            ) {
                return (a * (1.0 - ax) + b * ax) * (1.0 - ay) + (c * (1.0 - ax) + d * ax) * ay;
            }
        }
        let a = self.clamped(ix, iy);
        let b = self.clamped(ix + 1, iy);
        let c = self.clamped(ix, iy + 1);
        let d = self.clamped(ix + 1, iy + 1);
        (a * (1.0 - ax) + b * ax) * (1.0 - ay) + (c * (1.0 - ax) + d * ax) * ay
    }

    /// Bilinear read with zeros outside (OpenCV's BORDER_CONSTANT 0).
    #[inline]
    pub fn sample_zero(&self, x: f32, y: f32) -> f32 {
        let fx = x.floor();
        let fy = y.floor();
        let (ax, ay) = (x - fx, y - fy);
        let (ix, iy) = (fx as isize, fy as isize);
        let get = |x: isize, y: isize| {
            if x < 0 || y < 0 || x >= self.w as isize || y >= self.h as isize {
                0.0
            } else {
                self.at(x as usize, y as usize)
            }
        };
        (get(ix, iy) * (1.0 - ax) + get(ix + 1, iy) * ax) * (1.0 - ay)
            + (get(ix, iy + 1) * (1.0 - ax) + get(ix + 1, iy + 1) * ax) * ay
    }

    pub fn rows(&self) -> std::slice::ChunksExact<'_, f32> {
        self.data.chunks_exact(self.w.max(1))
    }

    pub fn rows_mut(&mut self) -> std::slice::ChunksExactMut<'_, f32> {
        self.data.chunks_exact_mut(self.w.max(1))
    }

    pub fn map(&self, f: impl Fn(f32) -> f32) -> Self {
        Self {
            w: self.w,
            h: self.h,
            data: self.data.iter().map(|&v| f(v)).collect(),
        }
    }

    /// Element by element with `other` (same size).
    pub fn zip(&self, other: &Self, f: impl Fn(f32, f32) -> f32) -> Self {
        Self {
            w: self.w,
            h: self.h,
            data: self
                .data
                .iter()
                .zip(&other.data)
                .map(|(&a, &b)| f(a, b))
                .collect(),
        }
    }

    /// The `w × h` window from (x0, y0), edge pixels outside.
    pub fn crop(&self, x0: isize, y0: isize, w: usize, h: usize) -> Self {
        let mut out = Self::new(w, h, 0.0);
        for (y, row) in out.data.chunks_exact_mut(w.max(1)).enumerate() {
            for (x, value) in row.iter_mut().enumerate() {
                *value = self.clamped(x0 + x as isize, y0 + y as isize);
            }
        }
        out
    }

    /// Half the size, each pixel the mean of its 2×2 (an odd last row or column averaged with itself).
    pub fn half(&self) -> Self {
        let (w, h) = (self.w.div_ceil(2).max(1), self.h.div_ceil(2).max(1));
        let mut out = Self::new(w, h, 0.0);
        for (y, row) in out.data.chunks_exact_mut(w).enumerate() {
            let (y0, y1) = (2 * y as isize, (2 * y + 1) as isize);
            for (x, value) in row.iter_mut().enumerate() {
                let (x0, x1) = (2 * x as isize, (2 * x + 1) as isize);
                *value = 0.25
                    * (self.clamped(x0, y0)
                        + self.clamped(x1, y0)
                        + self.clamped(x0, y1)
                        + self.clamped(x1, y1));
            }
        }
        out
    }

    /// Resized to `w × h` bilinearly, pixel centres kept (OpenCV's INTER_LINEAR).
    pub fn resized(&self, w: usize, h: usize) -> Self {
        let mut out = Self::new(w, h, 0.0);
        if self.w == 0 || self.h == 0 {
            return out;
        }
        let sx = self.w as f32 / w.max(1) as f32;
        let sy = self.h as f32 / h.max(1) as f32;
        for (y, row) in out.data.chunks_exact_mut(w.max(1)).enumerate() {
            let fy = ((y as f32 + 0.5) * sy - 0.5).max(0.0);
            for (x, value) in row.iter_mut().enumerate() {
                let fx = ((x as f32 + 0.5) * sx - 0.5).max(0.0);
                *value = self.sample(fx, fy);
            }
        }
        out
    }

    /// Convolved with `kernel` (odd length, centred) along rows then columns.
    pub fn separable(&self, kernel: &[f32]) -> Self {
        let r = (kernel.len() / 2) as isize;
        let mut across = Self::new(self.w, self.h, 0.0);
        for (src, dst) in self.rows().zip(across.rows_mut()) {
            for (x, value) in dst.iter_mut().enumerate() {
                let mut sum = 0.0;
                for (k, weight) in kernel.iter().enumerate() {
                    let sx = reflect(x as isize + k as isize - r, self.w);
                    sum += weight * src.get(sx).copied().unwrap_or(0.0);
                }
                *value = sum;
            }
        }
        let mut out = Self::new(self.w, self.h, 0.0);
        for (y, dst) in out.rows_mut().enumerate() {
            for (k, weight) in kernel.iter().enumerate() {
                let sy = reflect(y as isize + k as isize - r, self.h);
                if let Some(src) = across.data.get(sy * self.w..(sy + 1) * self.w) {
                    for (value, &s) in dst.iter_mut().zip(src) {
                        *value += weight * s;
                    }
                }
            }
        }
        out
    }

    /// Gaussian blur (OpenCV's kernel for a given sigma: 4σ either side for floats).
    pub fn gaussian(&self, sigma: f32) -> Self {
        self.separable(&gaussian_kernel(sigma))
    }

    /// A wide Gaussian worked at half size (a blur that wide carries nothing finer), brought back up.
    pub fn gaussian_wide(&self, sigma: f32) -> Self {
        if sigma < 3.0 || self.w < 8 || self.h < 8 {
            return self.gaussian(sigma);
        }
        self.half().gaussian(sigma / 2.0).resized(self.w, self.h)
    }

    /// 3×3 Sobel gradients (x, y), unscaled as OpenCV's.
    pub fn sobel(&self) -> (Self, Self) {
        let mut gx = Self::new(self.w, self.h, 0.0);
        let mut gy = Self::new(self.w, self.h, 0.0);
        let p = |x: isize, y: isize| self.at(reflect(x, self.w), reflect(y, self.h));
        for y in 0..self.h as isize {
            for x in 0..self.w as isize {
                let dx = (p(x + 1, y - 1) + 2.0 * p(x + 1, y) + p(x + 1, y + 1))
                    - (p(x - 1, y - 1) + 2.0 * p(x - 1, y) + p(x - 1, y + 1));
                let dy = (p(x - 1, y + 1) + 2.0 * p(x, y + 1) + p(x + 1, y + 1))
                    - (p(x - 1, y - 1) + 2.0 * p(x, y - 1) + p(x + 1, y - 1));
                gx.set(x as usize, y as usize, dx);
                gy.set(x as usize, y as usize, dy);
            }
        }
        (gx, gy)
    }

    /// Grey erosion (`min`) or dilation (`max`) over a disc `size` across, outside ignored.
    pub fn morph(&self, size: usize, min: bool) -> Self {
        let spans = disc(size);
        let r = (spans.len() / 2) as isize;
        // Each distinct half width's running extreme along the rows, then the disc's rows combined.
        let mut widths: Vec<usize> = spans.clone();
        widths.sort_unstable();
        widths.dedup();
        let pick = |a: f32, b: f32| if min { a.min(b) } else { a.max(b) };
        let start = if min {
            f32::INFINITY
        } else {
            f32::NEG_INFINITY
        };
        let rowwise: Vec<Self> = widths
            .iter()
            .map(|&hw| {
                let mut out = Self::new(self.w, self.h, start);
                for (src, dst) in self.rows().zip(out.rows_mut()) {
                    for (x, value) in dst.iter_mut().enumerate() {
                        let a = x.saturating_sub(hw);
                        let b = (x + hw + 1).min(self.w);
                        *value = src
                            .get(a..b)
                            .map_or(start, |run| run.iter().fold(start, |m, &v| pick(m, v)));
                    }
                }
                out
            })
            .collect();
        let mut out = Self::new(self.w, self.h, start);
        for (k, hw) in spans.iter().enumerate() {
            let Some(level) = widths
                .iter()
                .position(|one| one == hw)
                .and_then(|at| rowwise.get(at))
            else {
                continue;
            };
            let dy = k as isize - r;
            for y in 0..self.h {
                let sy = y as isize + dy;
                if sy < 0 || sy >= self.h as isize {
                    continue;
                }
                let sy = sy as usize;
                let (Some(src), Some(dst)) = (
                    level.data.get(sy * self.w..(sy + 1) * self.w),
                    out.data.get_mut(y * self.w..(y + 1) * self.w),
                ) else {
                    continue;
                };
                for (value, &s) in dst.iter_mut().zip(src) {
                    *value = pick(*value, s);
                }
            }
        }
        out
    }

    /// Pixels where `pick` holds, as a mask.
    pub fn mask(&self, pick: impl Fn(f32) -> bool) -> Mask {
        Mask {
            w: self.w,
            h: self.h,
            data: self.data.iter().map(|&v| pick(v)).collect(),
        }
    }
}

/// OpenCV's Gaussian kernel for `sigma` (float pictures: radius ⌈4σ⌉ rounded as it does).
pub fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let sigma = sigma.max(0.1);
    let size = ((sigma * 8.0 + 1.0).round() as usize) | 1;
    let r = (size / 2) as f32;
    let mut kernel: Vec<f32> = (0..size)
        .map(|i| (-((i as f32 - r).powi(2)) / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = kernel.iter().sum();
    for value in &mut kernel {
        *value /= sum;
    }
    kernel
}

/// A disc `size` across as each row's half width (OpenCV's MORPH_ELLIPSE).
pub fn disc(size: usize) -> Vec<usize> {
    let size = size.max(1);
    let r = (size / 2) as f32;
    let c = r;
    (0..size)
        .map(|row| {
            let dy = row as f32 - c;
            if r == 0.0 {
                return 0;
            }
            let inside = 1.0 - (dy * dy) / (r * r);
            if inside <= 0.0 {
                0
            } else {
                (r * inside.sqrt()).round() as usize
            }
        })
        .collect()
}

/// A yes/no picture.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mask {
    pub w: usize,
    pub h: usize,
    pub data: Vec<bool>,
}

impl Mask {
    pub fn new(w: usize, h: usize) -> Self {
        Self {
            w,
            h,
            data: vec![false; w * h],
        }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> bool {
        self.data.get(y * self.w + x).copied().unwrap_or(false)
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, value: bool) {
        let w = self.w;
        if let Some(slot) = self.data.get_mut(y * w + x) {
            *slot = value;
        }
    }

    pub fn any(&self) -> bool {
        self.data.iter().any(|&v| v)
    }

    pub fn count(&self) -> usize {
        self.data.iter().filter(|&&v| v).count()
    }

    pub fn plane(&self) -> Plane {
        Plane {
            w: self.w,
            h: self.h,
            data: self
                .data
                .iter()
                .map(|&v| if v { 1.0 } else { 0.0 })
                .collect(),
        }
    }

    /// Grown by a `size × size` square (OpenCV's dilate with ones).
    pub fn dilate(&self, size: usize) -> Self {
        self.square(size, true)
    }

    /// Shrunk by a `size × size` square (outside counts as set, as OpenCV's erode).
    pub fn erode(&self, size: usize) -> Self {
        self.square(size, false)
    }

    fn square(&self, size: usize, grow: bool) -> Self {
        let r = (size / 2) as isize;
        let lo = size as isize - 1 - r;
        // Rows then columns: a square is separable.
        let mut across = Self::new(self.w, self.h);
        for y in 0..self.h {
            for x in 0..self.w {
                let mut hit = !grow;
                for dx in -lo..=r {
                    let sx = x as isize + dx;
                    let v = if sx < 0 || sx >= self.w as isize {
                        !grow
                    } else {
                        self.at(sx as usize, y)
                    };
                    if grow && v {
                        hit = true;
                        break;
                    }
                    if !grow && !v {
                        hit = false;
                        break;
                    }
                }
                across.set(x, y, hit);
            }
        }
        let mut out = Self::new(self.w, self.h);
        for y in 0..self.h {
            for x in 0..self.w {
                let mut hit = !grow;
                for dy in -lo..=r {
                    let sy = y as isize + dy;
                    let v = if sy < 0 || sy >= self.h as isize {
                        !grow
                    } else {
                        across.at(x, sy as usize)
                    };
                    if grow && v {
                        hit = true;
                        break;
                    }
                    if !grow && !v {
                        hit = false;
                        break;
                    }
                }
                out.set(x, y, hit);
            }
        }
        out
    }

    /// Grown by a disc `size` across.
    pub fn dilate_disc(&self, size: usize) -> Self {
        self.plane().morph(size, false).mask(|v| v > 0.5)
    }

    /// Opened by a `size` square (specks smaller than it gone).
    pub fn open(&self, size: usize) -> Self {
        self.erode(size).dilate(size)
    }

    /// The box (x0, y0, x1, y1), end exclusive, of what's set; None when nothing is.
    pub fn bounds(&self) -> Option<(usize, usize, usize, usize)> {
        let mut out: Option<(usize, usize, usize, usize)> = None;
        for (y, row) in self.data.chunks_exact(self.w.max(1)).enumerate() {
            for (x, &v) in row.iter().enumerate() {
                if v {
                    out = Some(match out {
                        None => (x, y, x + 1, y + 1),
                        Some((x0, y0, x1, y1)) => {
                            (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1))
                        }
                    });
                }
            }
        }
        out
    }
}

/// Summed-area table of a plane, for box sums in constant time.
pub struct Integral {
    w: usize,
    sums: Vec<f64>,
}

impl Integral {
    pub fn new(plane: &Plane) -> Self {
        let w = plane.w + 1;
        let mut sums = vec![0.0f64; w * (plane.h + 1)];
        for y in 0..plane.h {
            let mut run = 0.0f64;
            for x in 0..plane.w {
                run += f64::from(plane.at(x, y));
                let above = sums.get(y * w + x + 1).copied().unwrap_or(0.0);
                if let Some(slot) = sums.get_mut((y + 1) * w + x + 1) {
                    *slot = above + run;
                }
            }
        }
        Self { w, sums }
    }

    /// The sum over [x0, x1) × [y0, y1).
    #[inline]
    pub fn sum(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
        let at = |x: usize, y: usize| self.sums.get(y * self.w + x).copied().unwrap_or(0.0);
        at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0)
    }
}

/// Fills the pixels set in `unknown` smoothly from the rest (a harmonic fill:
/// each unknown pixel the mean of its four neighbours), started from a coarse
/// to fine guess so a few sweeps settle it.
pub fn harmonic_fill(values: &Plane, unknown: &Mask) -> Plane {
    let guess = coarse_guess(values, unknown);
    let mut out = values.clone();
    for (o, (g, &u)) in out
        .data
        .iter_mut()
        .zip(guess.data.iter().zip(&unknown.data))
    {
        if u {
            *o = *g;
        }
    }
    let cells: Vec<(usize, usize)> = (0..values.h)
        .flat_map(|y| (0..values.w).map(move |x| (x, y)))
        .filter(|&(x, y)| unknown.at(x, y))
        .collect();
    if cells.is_empty() {
        return out;
    }
    // Successive over-relaxation: settles in tens of sweeps where Jacobi needs hundreds.
    let omega = 1.85f32;
    for _ in 0..120 {
        let mut change = 0.0f32;
        for &(x, y) in &cells {
            let (xi, yi) = (x as isize, y as isize);
            let mean = 0.25
                * (out.clamped(xi - 1, yi)
                    + out.clamped(xi + 1, yi)
                    + out.clamped(xi, yi - 1)
                    + out.clamped(xi, yi + 1));
            let old = out.at(x, y);
            let new = old + omega * (mean - old);
            change = change.max((new - old).abs());
            out.set(x, y, new);
        }
        if change < 0.01 {
            break;
        }
    }
    out
}

/// A first guess for every unknown pixel: the known ones averaged down a pyramid and brought back up.
fn coarse_guess(values: &Plane, unknown: &Mask) -> Plane {
    if values.w <= 2 || values.h <= 2 {
        let known: Vec<f32> = values
            .data
            .iter()
            .zip(&unknown.data)
            .filter(|(_, &u)| !u)
            .map(|(&v, _)| v)
            .collect();
        let mean = if known.is_empty() {
            0.0
        } else {
            known.iter().sum::<f32>() / known.len() as f32
        };
        return Plane::new(values.w, values.h, mean);
    }
    let weight = unknown.plane().map(|u| 1.0 - u);
    let weighted = values.zip(&weight, |v, w| v * w);
    let (hw, hh) = (weighted.half(), weight.half());
    let coarse_values = hw.zip(&hh, |v, w| if w > 1e-6 { v / w } else { 0.0 });
    let coarse_unknown = hh.mask(|w| w <= 1e-6);
    let coarse = if coarse_unknown.any() {
        coarse_guess(&coarse_values, &coarse_unknown)
    } else {
        coarse_values
    };
    coarse.resized(values.w, values.h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflect_mirrors_without_repeating_the_edge() {
        let got: Vec<usize> = (-3..8).map(|i| reflect(i, 5)).collect();
        assert_eq!(got, vec![3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1]);
    }

    #[test]
    fn gaussian_keeps_a_flat_plane_flat_and_sums_to_one() {
        let kernel = gaussian_kernel(1.5);
        assert!((kernel.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        let flat = Plane::new(20, 10, 7.0).gaussian(3.0);
        assert!(flat.data.iter().all(|v| (v - 7.0).abs() < 1e-4));
    }

    #[test]
    fn harmonic_fill_bridges_a_hole_in_a_ramp() {
        let mut ramp = Plane::new(30, 20, 0.0);
        for y in 0..20 {
            for x in 0..30 {
                ramp.set(x, y, x as f32);
            }
        }
        let mut hole = Mask::new(30, 20);
        for y in 5..15 {
            for x in 10..20 {
                hole.set(x, y, true);
            }
        }
        let mut damaged = ramp.clone();
        for y in 5..15 {
            for x in 10..20 {
                damaged.set(x, y, 100.0);
            }
        }
        let filled = harmonic_fill(&damaged, &hole);
        for y in 5..15 {
            for x in 10..20 {
                assert!(
                    (filled.at(x, y) - x as f32).abs() < 0.3,
                    "{x},{y}: {}",
                    filled.at(x, y)
                );
            }
        }
    }

    #[test]
    fn erosion_and_dilation_by_a_disc() {
        let mut dot = Plane::new(21, 21, 0.0);
        dot.set(10, 10, 1.0);
        let grown = dot.morph(5, false);
        assert_eq!(grown.at(10, 8), 1.0);
        assert_eq!(grown.at(12, 10), 1.0);
        assert_eq!(grown.at(12, 12), 0.0);
        assert_eq!(grown.morph(5, true).at(10, 10), 1.0);
    }
}
