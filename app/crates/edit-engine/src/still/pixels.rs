//! Pictures and the OpenCV operations the still clean was tuned with (finder/still.py, Nov 24): grey and HSV as
//! OpenCV's 8-bit tables make them, area shrinking, median filters, morphology with OpenCV's structuring elements
//! and borders, connected parts numbered as OpenCV numbers them, Telea's inpainting and the alpha's Gaussian. Each
//! gives what the OpenCV call gave, bit for bit where a threshold reads it.
//!
//! Indexing is plain here: every index is in range by construction, the loops are per pixel, and a slip is a panic
//! that `util::catch` turns into an error (the stretch then goes to the model, as any failure of the still clean does).
#![allow(clippy::indexing_slicing)]

use std::sync::OnceLock;

pub type Px = [u8; 3];

/// A picture, row by row.
#[derive(Clone, Debug, PartialEq)]
pub struct Img<T> {
    pub w: usize,
    pub h: usize,
    pub v: Vec<T>,
}

pub type Rgb = Img<Px>;
pub type Mask = Img<bool>;
pub type Gray = Img<u8>;

impl<T: Copy> Img<T> {
    pub fn filled(w: usize, h: usize, value: T) -> Self {
        Self {
            w,
            h,
            v: vec![value; w * h],
        }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> T {
        self.v[y * self.w + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, value: T) {
        let w = self.w;
        self.v[y * w + x] = value;
    }

    pub fn row(&self, y: usize) -> &[T] {
        &self.v[y * self.w..(y + 1) * self.w]
    }

    /// Columns x0..x1 of rows y0..y1, each bound clamped into the picture (a Python slice's non-negative bounds).
    pub fn crop(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> Self {
        let (x1, y1) = (x1.min(self.w), y1.min(self.h));
        let (x0, y0) = (x0.min(x1), y0.min(y1));
        let mut v = Vec::with_capacity((x1 - x0) * (y1 - y0));
        for y in y0..y1 {
            v.extend_from_slice(&self.v[y * self.w + x0..y * self.w + x1]);
        }
        Self {
            w: x1 - x0,
            h: y1 - y0,
            v,
        }
    }

    /// `from` laid at (x0, y0), what falls outside left out.
    pub fn paste(&mut self, x0: usize, y0: usize, from: &Self) {
        let w = from.w.min(self.w.saturating_sub(x0));
        for y in 0..from.h.min(self.h.saturating_sub(y0)) {
            let at = (y0 + y) * self.w + x0;
            self.v[at..at + w].copy_from_slice(&from.v[y * from.w..y * from.w + w]);
        }
    }

    pub fn map<U>(&self, f: impl Fn(T) -> U) -> Img<U> {
        Img {
            w: self.w,
            h: self.h,
            v: self.v.iter().map(|&one| f(one)).collect(),
        }
    }

    pub fn zip<U: Copy, R>(&self, other: &Img<U>, f: impl Fn(T, U) -> R) -> Img<R> {
        Img {
            w: self.w,
            h: self.h,
            v: self
                .v
                .iter()
                .zip(&other.v)
                .map(|(&a, &b)| f(a, b))
                .collect(),
        }
    }
}

impl Mask {
    pub fn any(&self) -> bool {
        self.v.iter().any(|&one| one)
    }

    pub fn count(&self) -> usize {
        self.v.iter().filter(|&&one| one).count()
    }

    /// Rows y0..y1, columns x0..x1 set (clamped).
    pub fn fill(&mut self, x0: usize, y0: usize, x1: usize, y1: usize) {
        let (x1, y1) = (x1.min(self.w), y1.min(self.h));
        for y in y0.min(y1)..y1 {
            for x in x0.min(x1)..x1 {
                self.v[y * self.w + x] = true;
            }
        }
    }
}

/// |a − b| summed over the three channels.
#[inline]
pub fn diff3(a: Px, b: Px) -> i32 {
    (i32::from(a[0]) - i32::from(b[0])).abs()
        + (i32::from(a[1]) - i32::from(b[1])).abs()
        + (i32::from(a[2]) - i32::from(b[2])).abs()
}

/// OpenCV's cvRound: to the nearest, halves to even.
#[inline]
pub fn cv_round(value: f64) -> i64 {
    value.round_ties_even() as i64
}

#[inline]
pub fn saturate_u8(value: f64) -> u8 {
    cv_round(value).clamp(0, 255) as u8
}

// ---------------------------------------------------------------------------
// Colour

/// cvtColor RGB2GRAY on 8 bits: 0.299, 0.587, 0.114 in 15-bit fixed point (OpenCV 4.x `RY15`, `GY15`, `BY15`).
#[inline]
pub fn luma(px: Px) -> u8 {
    ((u32::from(px[0]) * 9798 + u32::from(px[1]) * 19235 + u32::from(px[2]) * 3735 + 16384) >> 15)
        as u8
}

pub fn gray(img: &Rgb) -> Gray {
    img.map(luma)
}

fn hsv_tables() -> &'static ([i32; 256], [i32; 256]) {
    static TABLES: OnceLock<([i32; 256], [i32; 256])> = OnceLock::new();
    TABLES.get_or_init(|| {
        let (mut sdiv, mut hdiv) = ([0i32; 256], [0i32; 256]);
        for i in 1..256 {
            sdiv[i] = cv_round(f64::from(255 << 12) / i as f64) as i32;
            hdiv[i] = cv_round(f64::from(180 << 12) / (6.0 * i as f64)) as i32;
        }
        (sdiv, hdiv)
    })
}

/// cvtColor RGB2HSV on 8 bits: hue 0–179, saturation and value 0–255.
#[inline]
pub fn hsv(px: Px) -> (i16, u8, u8) {
    let (sdiv, hdiv) = hsv_tables();
    let (r, g, b) = (i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
    let v = b.max(g).max(r);
    let vmin = b.min(g).min(r);
    let diff = v - vmin;
    let vr = if v == r { -1 } else { 0 };
    let vg = if v == g { -1 } else { 0 };
    let s = (diff * sdiv[v as usize] + (1 << 11)) >> 12;
    let mut h = (vr & (g - b)) + (!vr & ((vg & (b - r + 2 * diff)) + (!vg & (r - g + 4 * diff))));
    h = (h * hdiv[diff as usize] + (1 << 11)) >> 12;
    if h < 0 {
        h += 180;
    }
    (h as i16, s as u8, v as u8)
}

// ---------------------------------------------------------------------------
// Shrinking

/// resize INTER_AREA to `w × h`: whole blocks averaged when the sizes divide (OpenCV's fast path, its rounding),
/// else each source pixel weighted by how much of it the destination pixel covers.
pub fn shrink(img: &Rgb, w: usize, h: usize) -> Rgb {
    let mut out = Img::filled(w, h, [0u8; 3]);
    if img.w == 0 || img.h == 0 || w == 0 || h == 0 {
        return out;
    }
    if img.w.is_multiple_of(w) && img.h.is_multiple_of(h) {
        let (sx, sy) = (img.w / w, img.h / h);
        let scale = 1.0f32 / (sx * sy) as f32;
        for y in 0..h {
            for x in 0..w {
                let mut sum = [0i32; 3];
                for yy in y * sy..(y + 1) * sy {
                    for px in &img.v[yy * img.w + x * sx..yy * img.w + (x + 1) * sx] {
                        for c in 0..3 {
                            sum[c] += i32::from(px[c]);
                        }
                    }
                }
                let mut px = [0u8; 3];
                for c in 0..3 {
                    px[c] = saturate_u8(f64::from(sum[c] as f32 * scale));
                }
                out.set(x, y, px);
            }
        }
        return out;
    }
    let spans = |from: usize, to: usize| -> Vec<Vec<(usize, f64)>> {
        let scale = from as f64 / to as f64;
        (0..to)
            .map(|d| {
                let (a, b) = (d as f64 * scale, ((d + 1) as f64 * scale).min(from as f64));
                let mut out = Vec::new();
                let mut s = a.floor() as usize;
                while (s as f64) < b && s < from {
                    let cover = (b.min((s + 1) as f64) - a.max(s as f64)) / (b - a);
                    if cover > 1e-9 {
                        out.push((s, cover));
                    }
                    s += 1;
                }
                out
            })
            .collect()
    };
    let (xs, ys) = (spans(img.w, w), spans(img.h, h));
    for (y, ry) in ys.iter().enumerate() {
        for (x, rx) in xs.iter().enumerate() {
            let mut sum = [0f64; 3];
            for &(sy, wy) in ry {
                for &(sx, wx) in rx {
                    let px = img.at(sx, sy);
                    for c in 0..3 {
                        sum[c] += f64::from(px[c]) * wy * wx;
                    }
                }
            }
            out.set(x, y, sum.map(saturate_u8));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Median

/// medianBlur with a `k × k` window (k odd), the edge pixel repeated past the border, each channel its own; only
/// where `only` is set when given (elsewhere the picture's own pixel).
pub fn median(img: &Rgb, k: usize, only: Option<&Mask>) -> Rgb {
    let mut out = img.clone();
    let (w, h) = (img.w, img.h);
    if w == 0 || h == 0 {
        return out;
    }
    let r = (k / 2) as isize;
    let rank = (k * k / 2) as u32;
    let clamp_x = |x: isize| x.clamp(0, w as isize - 1) as usize;
    let clamp_y = |y: isize| y.clamp(0, h as isize - 1) as usize;
    for y in 0..h {
        let wanted = |x: usize| only.is_none_or(|mask| mask.at(x, y));
        let Some(first) = (0..w).find(|&x| wanted(x)) else {
            continue;
        };
        let last = (first..w).rev().find(|&x| wanted(x)).unwrap_or(first);
        let rows: Vec<usize> = (-r..=r).map(|dy| clamp_y(y as isize + dy)).collect();
        for c in 0..3 {
            let mut fine = [0u32; 256];
            let mut coarse = [0u32; 16];
            let column = |x: usize, add: bool, fine: &mut [u32; 256], coarse: &mut [u32; 16]| {
                for &yy in &rows {
                    let value = img.v[yy * w + x][c] as usize;
                    if add {
                        fine[value] += 1;
                        coarse[value >> 4] += 1;
                    } else {
                        fine[value] -= 1;
                        coarse[value >> 4] -= 1;
                    }
                }
            };
            for dx in -r..=r {
                column(clamp_x(first as isize + dx), true, &mut fine, &mut coarse);
            }
            for x in first..=last {
                if x > first {
                    column(clamp_x(x as isize - r - 1), false, &mut fine, &mut coarse);
                    column(clamp_x(x as isize + r), true, &mut fine, &mut coarse);
                }
                if !wanted(x) {
                    continue;
                }
                let mut seen = 0u32;
                let mut bin = 0usize;
                while seen + coarse[bin] <= rank {
                    seen += coarse[bin];
                    bin += 1;
                }
                let mut value = bin << 4;
                while seen + fine[value] <= rank {
                    seen += fine[value];
                    value += 1;
                }
                out.v[y * w + x][c] = value as u8;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Morphology

/// A structuring element as OpenCV reads it round a pixel: each of its rows as (dy, dx from, dx to).
#[derive(Clone, Debug, PartialEq)]
pub struct Kernel {
    rows: Vec<(isize, isize, isize)>,
}

impl Kernel {
    /// MORPH_RECT `w × h`, anchored at (w/2, h/2) as OpenCV's default anchor is (an even side reads one more before).
    pub fn rect(w: usize, h: usize) -> Self {
        let (ax, ay) = ((w / 2) as isize, (h / 2) as isize);
        Self {
            rows: (0..h as isize)
                .map(|i| (i - ay, -ax, w as isize - 1 - ax))
                .collect(),
        }
    }

    /// getStructuringElement(MORPH_ELLIPSE, (w, h)), anchored at its centre.
    pub fn ellipse(w: usize, h: usize) -> Self {
        let (r, c) = ((h / 2) as isize, (w / 2) as isize);
        let inv_r2 = if r > 0 { 1.0 / (r * r) as f64 } else { 0.0 };
        let mut rows = Vec::new();
        for i in 0..h as isize {
            let dy = i - r;
            if dy.abs() > r {
                continue;
            }
            let dx = cv_round((c as f64) * (((r * r - dy * dy) as f64) * inv_r2).sqrt()) as isize;
            let (j1, j2) = ((c - dx).max(0), (c + dx + 1).min(w as isize));
            if j2 > j1 {
                rows.push((dy, j1 - c, j2 - 1 - c));
            }
        }
        Self { rows }
    }
}

/// dilate of a mask: set where any pixel the kernel reads is (the border reads nothing, as OpenCV's default border
/// does for dilation). Each row's runs are spread with a difference array, so a wide kernel costs no more per run.
pub fn dilate(mask: &Mask, kernel: &Kernel) -> Mask {
    let (w, h) = (mask.w, mask.h);
    let mut marks = vec![0i32; (w + 1) * h];
    for sy in 0..h {
        let row = mask.row(sy);
        let mut x = 0;
        while x < w {
            if !row[x] {
                x += 1;
                continue;
            }
            let s = x;
            while x < w && row[x] {
                x += 1;
            }
            let e = x - 1;
            for &(dy, dx0, dx1) in &kernel.rows {
                let y = sy as isize - dy;
                if y < 0 || y >= h as isize {
                    continue;
                }
                let lo = (s as isize - dx1).max(0);
                let hi = (e as isize - dx0).min(w as isize - 1);
                if lo > hi {
                    continue;
                }
                let base = y as usize * (w + 1);
                marks[base + lo as usize] += 1;
                marks[base + hi as usize + 1] -= 1;
            }
        }
    }
    let mut out = Img::filled(w, h, false);
    for y in 0..h {
        let mut level = 0;
        for x in 0..w {
            level += marks[y * (w + 1) + x];
            out.v[y * w + x] = level > 0;
        }
    }
    out
}

/// erode of a mask: set where every pixel the kernel reads is (past the border counts as set, as OpenCV's default).
pub fn erode(mask: &Mask, kernel: &Kernel) -> Mask {
    dilate(&mask.map(|one| !one), kernel).map(|one| !one)
}

/// The largest (or smallest) value of each row over [x + from, x + to], the border read as `none`.
fn row_extreme<T: Copy + Ord>(
    row: &[T],
    from: isize,
    to: isize,
    none: T,
    max: bool,
    out: &mut [T],
) {
    let w = row.len() as isize;
    let len = (to - from + 1) as usize;
    let pick = |a: T, b: T| if max { a.max(b) } else { a.min(b) };
    if len == 1 {
        for (x, slot) in out.iter_mut().enumerate() {
            let at = x as isize + from;
            *slot = if (0..w).contains(&at) {
                row[at as usize]
            } else {
                none
            };
        }
        return;
    }
    // Padded run covering every window, then van Herk / Gil-Werman blocks.
    let total = row.len() + len - 1;
    let padded: Vec<T> = (0..total as isize)
        .map(|i| {
            let at = i + from;
            if (0..w).contains(&at) {
                row[at as usize]
            } else {
                none
            }
        })
        .collect();
    let mut ahead = padded.clone();
    let mut behind = padded.clone();
    for i in 1..total {
        if i % len != 0 {
            ahead[i] = pick(ahead[i - 1], padded[i]);
        }
    }
    for i in (0..total.saturating_sub(1)).rev() {
        if (i + 1) % len != 0 {
            behind[i] = pick(behind[i + 1], padded[i]);
        }
    }
    for (x, slot) in out.iter_mut().enumerate() {
        *slot = pick(behind[x], ahead[x + len - 1]);
    }
}

/// Grey dilation (max) or erosion (min) by `kernel`, the border ignored (OpenCV's default border value).
pub fn morph<T: Copy + Ord + Default>(img: &Img<T>, kernel: &Kernel, max: bool, none: T) -> Img<T> {
    let (w, h) = (img.w, img.h);
    let mut spans: Vec<(isize, isize)> = kernel.rows.iter().map(|&(_, a, b)| (a, b)).collect();
    spans.sort_unstable();
    spans.dedup();
    let mut extremes: Vec<Vec<T>> = Vec::with_capacity(spans.len());
    for &(from, to) in &spans {
        let mut plane = vec![T::default(); w * h];
        for y in 0..h {
            row_extreme(
                img.row(y),
                from,
                to,
                none,
                max,
                &mut plane[y * w..(y + 1) * w],
            );
        }
        extremes.push(plane);
    }
    let mut out = Img::filled(w, h, none);
    for &(dy, from, to) in &kernel.rows {
        let Ok(which) = spans.binary_search(&(from, to)) else {
            continue;
        };
        let plane = &extremes[which];
        for y in 0..h {
            let sy = y as isize + dy;
            if sy < 0 || sy >= h as isize {
                continue;
            }
            let source = &plane[sy as usize * w..(sy as usize + 1) * w];
            for (slot, &value) in out.v[y * w..(y + 1) * w].iter_mut().zip(source) {
                *slot = if max {
                    (*slot).max(value)
                } else {
                    (*slot).min(value)
                };
            }
        }
    }
    out
}

/// morphologyEx MORPH_TOPHAT: the picture less its opening (thin bright strokes).
pub fn tophat(img: &Gray, kernel: &Kernel) -> Gray {
    let opened = morph(&morph(img, kernel, false, 255), kernel, true, 0);
    img.zip(&opened, |a, b| a.saturating_sub(b))
}

// ---------------------------------------------------------------------------
// Connected parts

/// connectedComponentsWithStats, 8-connected: the labels (0 the background) numbered in the order OpenCV's block
/// scan first meets each part (two rows at a time), and each label's (width, height); the count includes the background.
pub fn parts(mask: &Mask) -> (usize, Img<u32>, Vec<(usize, usize)>) {
    let (w, h) = (mask.w, mask.h);
    let mut parent: Vec<u32> = vec![0];
    let mut provisional = Img::filled(w, h, 0u32);
    fn find(parent: &mut [u32], mut a: u32) -> u32 {
        while parent[a as usize] != a {
            parent[a as usize] = parent[parent[a as usize] as usize];
            a = parent[a as usize];
        }
        a
    }
    for y in 0..h {
        for x in 0..w {
            if !mask.v[y * w + x] {
                continue;
            }
            let mut label = 0u32;
            let neighbours = [
                (x as isize - 1, y as isize),
                (x as isize - 1, y as isize - 1),
                (x as isize, y as isize - 1),
                (x as isize + 1, y as isize - 1),
            ];
            for (nx, ny) in neighbours {
                if nx < 0 || ny < 0 || nx >= w as isize {
                    continue;
                }
                let other = provisional.v[ny as usize * w + nx as usize];
                if other == 0 {
                    continue;
                }
                if label == 0 {
                    label = find(&mut parent, other);
                } else {
                    let (a, b) = (find(&mut parent, label), find(&mut parent, other));
                    if a != b {
                        let (low, high) = (a.min(b), a.max(b));
                        parent[high as usize] = low;
                        label = low;
                    }
                }
            }
            if label == 0 {
                label = parent.len() as u32;
                parent.push(label);
            }
            provisional.v[y * w + x] = label;
        }
    }
    let mut number = vec![0u32; parent.len()];
    let mut count = 1u32;
    for by in (0..h).step_by(2) {
        for x in 0..w {
            for y in by..(by + 2).min(h) {
                let label = provisional.v[y * w + x];
                if label == 0 {
                    continue;
                }
                let root = find(&mut parent, label) as usize;
                if number[root] == 0 {
                    number[root] = count;
                    count += 1;
                }
            }
        }
    }
    let mut boxes = vec![(usize::MAX, usize::MAX, 0usize, 0usize); count as usize];
    let mut labels = Img::filled(w, h, 0u32);
    for y in 0..h {
        for x in 0..w {
            let label = provisional.v[y * w + x];
            if label == 0 {
                continue;
            }
            let root = find(&mut parent, label) as usize;
            let n = number[root];
            labels.v[y * w + x] = n;
            let b = &mut boxes[n as usize];
            *b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
        }
    }
    let sizes = boxes
        .iter()
        .map(|&(x0, y0, x1, y1)| {
            if x0 == usize::MAX {
                (w, h)
            } else {
                (x1 - x0 + 1, y1 - y0 + 1)
            }
        })
        .collect();
    (count as usize, labels, sizes)
}

// ---------------------------------------------------------------------------
// Telea

const KNOWN: u8 = 0;
const BAND: u8 = 1;
const INSIDE: u8 = 2;
const CHANGE: u8 = 3;

/// OpenCV's priority queue for the fast march: the smallest time first, ties in the order they came.
struct March {
    heap: std::collections::BinaryHeap<std::cmp::Reverse<(u64, usize, usize)>>,
    order: u32,
}

impl March {
    fn new() -> Self {
        Self {
            heap: std::collections::BinaryHeap::new(),
            order: 0,
        }
    }

    fn push(&mut self, i: usize, j: usize, t: f32) {
        let mut bits = t.to_bits();
        if bits << 1 == 0 {
            bits = 0;
        }
        bits = if bits & 0x8000_0000 != 0 {
            !bits
        } else {
            bits | 0x8000_0000
        };
        let key = (u64::from(bits) << 32) | u64::from(self.order);
        self.order = self.order.wrapping_add(1);
        self.heap.push(std::cmp::Reverse((key, i, j)));
    }

    fn pop(&mut self) -> Option<(usize, usize)> {
        self.heap.pop().map(|std::cmp::Reverse((_, i, j))| (i, j))
    }
}

fn solve(f: &Img<u8>, t: &Img<f32>, i1: usize, j1: usize, i2: usize, j2: usize) -> f32 {
    let a11 = f64::from(t.at(j1, i1));
    let a22 = f64::from(t.at(j2, i2));
    let m12 = a11.min(a22);
    let sol = if f.at(j1, i1) != INSIDE {
        if f.at(j2, i2) != INSIDE {
            if (a11 - a22).abs() >= 1.0 {
                1.0 + m12
            } else {
                (a11 + a22 + (2.0 - (a11 - a22) * (a11 - a22)).sqrt()) * 0.5
            }
        } else {
            1.0 + a11
        }
    } else if f.at(j2, i2) != INSIDE {
        1.0 + a22
    } else {
        1.0 + m12
    };
    sol as f32
}

fn min4(f: &Img<u8>, t: &Img<f32>, i: usize, j: usize) -> f32 {
    let a = solve(f, t, i - 1, j, i, j - 1).min(solve(f, t, i + 1, j, i, j - 1));
    let c = solve(f, t, i - 1, j, i, j + 1).min(solve(f, t, i + 1, j, i, j + 1));
    a.min(c)
}

fn march(f: &mut Img<u8>, t: &mut Img<f32>, queue: &mut March, negate: bool) {
    let (rows, cols) = (f.h, f.w);
    while let Some((ii, jj)) = queue.pop() {
        f.set(jj, ii, if negate { CHANGE } else { KNOWN });
        for (i, j) in [(ii - 1, jj), (ii, jj - 1), (ii + 1, jj), (ii, jj + 1)] {
            if i == 0 || j == 0 || i > rows || j > cols {
                continue;
            }
            if f.at(j, i) == INSIDE {
                let dist = min4(f, t, i, j);
                t.set(j, i, dist);
                f.set(j, i, BAND);
                queue.push(i, j, dist);
            }
        }
    }
    if negate {
        for (state, time) in f.v.iter_mut().zip(t.v.iter_mut()) {
            if *state == CHANGE {
                *state = KNOWN;
                *time = -*time;
            }
        }
    }
}

/// inpaint(…, INPAINT_TELEA) on an RGB picture: each pixel under `holes` filled from the known pixels within
/// `radius`, from the outside in (OpenCV's own march and weights).
pub fn telea(img: &mut Rgb, holes: &Mask, radius: f64) {
    let range = cv_round(radius).clamp(1, 100) as usize;
    let (ecols, erows) = (img.w + 2, img.h + 2);
    let mut mask = Img::filled(ecols, erows, KNOWN);
    for y in 0..img.h {
        for x in 0..img.w {
            if holes.at(x, y) {
                mask.set(x + 1, y + 1, INSIDE);
            }
        }
    }
    let border = |plane: &mut Img<u8>| {
        for x in 0..plane.w {
            plane.set(x, 0, 0);
            plane.set(x, plane.h - 1, 0);
        }
        for y in 0..plane.h {
            plane.set(0, y, 0);
            plane.set(plane.w - 1, y, 0);
        }
    };
    border(&mut mask);
    let inside = mask.map(|one| one != 0);
    let cross = Kernel {
        rows: vec![(-1, 0, 0), (0, -1, 1), (1, 0, 0)],
    };
    let near = dilate(&inside, &cross);
    let mut band = near.zip(&inside, |a, b| if a && !b { INSIDE } else { 0 });
    border(&mut band);
    let mut t = Img::filled(ecols, erows, 1.0e6f32);
    let mut heap = March::new();
    for i in 0..erows {
        for j in 0..ecols {
            if band.at(j, i) != 0 {
                heap.push(i, j, 0.0);
                t.set(j, i, 0.0);
            }
        }
    }
    let ring = dilate(&inside, &Kernel::rect(2 * range + 1, 2 * range + 1));
    let mut out = Img::filled(ecols, erows, 0u8);
    for k in 0..out.v.len() {
        if ring.v[k] && !inside.v[k] && band.v[k] == 0 {
            out.v[k] = INSIDE;
        }
    }
    border(&mut out);
    let mut outside = March::new();
    for i in 0..erows {
        for j in 0..ecols {
            if band.at(j, i) != 0 {
                outside.push(i, j, 0.0);
            }
        }
    }
    march(&mut out, &mut t, &mut outside, true);

    // The fill, from the band inwards.
    let f = &mut mask;
    let side = 2 * range + 1;
    let r = range as isize;
    let mut half = vec![0isize; side];
    for dk in -r..=r {
        let mut width = 0isize;
        while (width + 1) * (width + 1) + dk * dk <= r * r {
            width += 1;
        }
        half[(dk + r) as usize] = width;
    }
    let mut dst = vec![0f32; side * side];
    for dk in -r..=r {
        for dl in -r..=r {
            if dk == 0 && dl == 0 {
                continue;
            }
            let (ry, rx) = (-dk as f32, -dl as f32);
            let len = rx * rx + ry * ry;
            dst[((dk + r) as usize) * side + (dl + r) as usize] =
                (1.0 / (f64::from(len) * f64::from(len).sqrt())) as f32;
        }
    }
    let threshold = 0.01f32;
    let w = img.w;
    let px = |img: &Rgb, row: usize, col: usize| -> [f32; 3] {
        let p = img.v[row * w + col];
        [f32::from(p[0]), f32::from(p[1]), f32::from(p[2])]
    };
    while let Some((ii, jj)) = heap.pop() {
        f.set(jj, ii, KNOWN);
        for (i, j) in [(ii - 1, jj), (ii, jj - 1), (ii + 1, jj), (ii, jj + 1)] {
            if i == 0 || j == 0 || i > erows - 1 || j > ecols - 1 {
                continue;
            }
            if f.at(j, i) != INSIDE {
                continue;
            }
            let dist = min4(f, &t, i, j);
            t.set(j, i, dist);
            // gradT
            let tij = t.at(j, i);
            let gx = if f.at(j + 1, i) != INSIDE {
                if f.at(j - 1, i) != INSIDE {
                    (t.at(j + 1, i) - t.at(j - 1, i)) * 0.5
                } else {
                    t.at(j + 1, i) - tij
                }
            } else if f.at(j - 1, i) != INSIDE {
                tij - t.at(j - 1, i)
            } else {
                0.0
            };
            let gy = if f.at(j, i + 1) != INSIDE {
                if f.at(j, i - 1) != INSIDE {
                    (t.at(j, i + 1) - t.at(j, i - 1)) * 0.5
                } else {
                    t.at(j, i + 1) - tij
                }
            } else if f.at(j, i - 1) != INSIDE {
                tij - t.at(j, i - 1)
            } else {
                0.0
            };
            let (ia, jx, jy, s) = (
                &mut [0f32; 3],
                &mut [0f32; 3],
                &mut [0f32; 3],
                &mut [1.0e-20f32; 3],
            );
            let kbeg = (i as isize - r).max(1) as usize;
            let kend = (i + range).min(erows - 2);
            for k in kbeg..=kend {
                let km = k - 1 + usize::from(k == 1);
                let kp = k - 1 - usize::from(k == erows - 2);
                let rw = half[(k as isize - i as isize + r) as usize];
                let lbeg = (j as isize - rw).max(1) as usize;
                let lend = ((j as isize + rw) as usize).min(ecols - 2);
                if lbeg > lend {
                    continue;
                }
                let ry = (i as isize - k as isize) as f32;
                for l in lbeg..=lend {
                    if f.at(l, k) == INSIDE {
                        continue;
                    }
                    let rx = (j as isize - l as isize) as f32;
                    let lev = (1.0 / (1.0 + f64::from((t.at(l, k) - tij).abs()))) as f32;
                    let mut dir = rx * gx + ry * gy;
                    if dir.abs() <= threshold {
                        dir = 0.000_001;
                    }
                    let d = dst[((k as isize - i as isize + r) as usize) * side
                        + (l as isize - j as isize + r) as usize];
                    let weight = (d * lev * dir).abs();
                    let lm = l - 1 + usize::from(l == 1);
                    let lp = l - 1 - usize::from(l == ecols - 2);
                    let gix: [f32; 3] = if f.at(l + 1, k) != INSIDE {
                        if f.at(l - 1, k) != INSIDE {
                            let (a, b) = (px(img, km, lp + 1), px(img, km, lm - 1));
                            [0, 1, 2].map(|c| (a[c] - b[c]) * 2.0)
                        } else {
                            let (a, b) = (px(img, km, lp + 1), px(img, km, lm));
                            [0, 1, 2].map(|c| a[c] - b[c])
                        }
                    } else if f.at(l - 1, k) != INSIDE {
                        let (a, b) = (px(img, km, lp), px(img, km, lm - 1));
                        [0, 1, 2].map(|c| a[c] - b[c])
                    } else {
                        [0.0; 3]
                    };
                    let giy: [f32; 3] = if f.at(l, k + 1) != INSIDE {
                        if f.at(l, k - 1) != INSIDE {
                            let (a, b) = (px(img, kp + 1, lm), px(img, km - 1, lm));
                            [0, 1, 2].map(|c| (a[c] - b[c]) * 2.0)
                        } else {
                            let (a, b) = (px(img, kp + 1, lm), px(img, km, lm));
                            [0, 1, 2].map(|c| a[c] - b[c])
                        }
                    } else if f.at(l, k - 1) != INSIDE {
                        let (a, b) = (px(img, kp, lm), px(img, km - 1, lm));
                        [0, 1, 2].map(|c| a[c] - b[c])
                    } else {
                        [0.0; 3]
                    };
                    let value = px(img, k - 1, l - 1);
                    for c in 0..3 {
                        ia[c] += weight * value[c];
                        jx[c] -= weight * (gix[c] * rx);
                        jy[c] -= weight * (giy[c] * ry);
                        s[c] += weight;
                    }
                }
            }
            let mut filled = [0u8; 3];
            for c in 0..3 {
                let sat = ia[c] / s[c]
                    + (jx[c] + jy[c]) / ((jx[c] * jx[c] + jy[c] * jy[c]).sqrt() + 1.0e-20);
                filled[c] = saturate_u8(f64::from(sat) + 0.5);
            }
            img.set(j - 1, i - 1, filled);
            f.set(j, i, BAND);
            heap.push(i, j, dist);
        }
    }
}

// ---------------------------------------------------------------------------
// The alpha

/// worker.alpha_of: the mask (0/255) blurred by a Gaussian `2·feather + 1` wide (OpenCV's own sigma for that size,
/// the border mirrored without its edge), × 1.35, capped at 1.
pub fn alpha_of(mask: &Mask, feather: usize) -> Img<f32> {
    let k = feather * 2 + 1;
    let sigma = 0.3 * ((k as f64 - 1.0) * 0.5 - 1.0) + 0.8;
    let scale = -0.5 / (sigma * sigma);
    let mut taps: Vec<f64> = (0..k)
        .map(|i| {
            let x = i as f64 - (k as f64 - 1.0) * 0.5;
            (scale * x * x).exp()
        })
        .collect();
    let sum = 1.0 / taps.iter().sum::<f64>();
    for tap in &mut taps {
        *tap *= sum;
    }
    let taps: Vec<f32> = taps.iter().map(|&one| one as f32).collect();
    let (w, h) = (mask.w, mask.h);
    let r = (k / 2) as isize;
    let reflect = |i: isize, n: usize| -> usize {
        if n <= 1 {
            return 0;
        }
        let period = 2 * (n as isize - 1);
        let mut i = i.rem_euclid(period);
        if i >= n as isize {
            i = period - i;
        }
        i as usize
    };
    let source: Vec<f32> = mask
        .v
        .iter()
        .map(|&one| if one { 1.0 } else { 0.0 })
        .collect();
    let mut across = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0f32;
            for (i, &tap) in taps.iter().enumerate() {
                sum += tap * source[y * w + reflect(x as isize + i as isize - r, w)];
            }
            across[y * w + x] = sum;
        }
    }
    let mut out = Img::filled(w, h, 0f32);
    let centre = taps[k / 2];
    for y in 0..h {
        for x in 0..w {
            let mut sum = centre * across[y * w + x];
            for d in 1..=r {
                let up = across[reflect(y as isize - d, h) * w + x];
                let down = across[reflect(y as isize + d, h) * w + x];
                sum += taps[(r + d) as usize] * (up + down);
            }
            out.v[y * w + x] = (sum * 1.35).clamp(0.0, 1.0);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// numpy

/// np.percentile (linear) of `values`.
pub fn percentile(values: &[f64], q: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    if n == 0 {
        return f64::NAN;
    }
    let index = (n as f64 - 1.0) * (q / 100.0);
    let below = index.floor();
    let gamma = index - below;
    let lo = (below as usize).min(n - 1);
    let hi = (lo + 1).min(n - 1);
    let (a, b) = (sorted[lo], sorted[hi]);
    let diff = b - a;
    if gamma >= 0.5 {
        b - diff * (1.0 - gamma)
    } else {
        a + diff * gamma
    }
}
