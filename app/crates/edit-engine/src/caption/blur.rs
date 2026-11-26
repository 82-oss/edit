//! The Gaussian blur the caption clean leans on, the same as `Plane::gaussian` (its kernel, its mirrored border) but
//! laid out for speed: each row padded once and convolved straight, the columns done a whole row at a time, so the
//! compiler can vectorise both (Nov 25: 48 blurs a frame in the rim repair made brightening 200 ms of a 415 ms frame).
#![allow(clippy::indexing_slicing)] // index arithmetic over one padded row or plane, in range by construction

use crate::watermark::plane::{gaussian_kernel, reflect, Plane};

/// `p` blurred by a Gaussian of `sigma` (OpenCV's kernel for floats; the border mirrored without its edge).
pub fn gaussian(p: &Plane, sigma: f32) -> Plane {
    let (w, h) = (p.w, p.h);
    if w == 0 || h == 0 {
        return p.clone();
    }
    let kernel = gaussian_kernel(sigma);
    let r = kernel.len() / 2;
    let mut across = vec![0f32; w * h];
    let mut padded = vec![0f32; w + 2 * r];
    for y in 0..h {
        let row = &p.data[y * w..(y + 1) * w];
        for (i, slot) in padded.iter_mut().enumerate() {
            *slot = row[reflect(i as isize - r as isize, w)];
        }
        let out = &mut across[y * w..(y + 1) * w];
        for (k, &weight) in kernel.iter().enumerate() {
            let src = &padded[k..k + w];
            for (o, &s) in out.iter_mut().zip(src) {
                *o += weight * s;
            }
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let dst = &mut out[y * w..(y + 1) * w];
        for (k, &weight) in kernel.iter().enumerate() {
            let sy = reflect(y as isize + k as isize - r as isize, h);
            let src = &across[sy * w..(sy + 1) * w];
            for (o, &s) in dst.iter_mut().zip(src) {
                *o += weight * s;
            }
        }
    }
    Plane { w, h, data: out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_as_the_plane_blur() {
        let (w, h) = (37, 23);
        let p = Plane {
            w,
            h,
            data: (0..w * h).map(|i| ((i * 7919) % 255) as f32).collect(),
        };
        for sigma in [0.8f32, 1.5, 3.0, 6.0] {
            let a = gaussian(&p, sigma);
            let b = p.gaussian(sigma);
            let worst = a
                .data
                .iter()
                .zip(&b.data)
                .map(|(x, y)| (x - y).abs())
                .fold(0.0f32, f32::max);
            assert!(worst < 1e-3, "sigma {sigma}: {worst}");
        }
    }
}
