//! A re-uploader's see-through watermark taken out of footage by arithmetic,
//! on this computer, with nothing sent anywhere (Sphe, Nov 17: "daily dose of
//! crime", a light grey mark at about 8–10% over the whole picture of Tulsa's
//! bodycam). The mark was blended in linear light (gamma about 2.5), so where
//! it sits each pixel is `out = disp((1 − a)·lin(in) + a·W)`: `a` its matte,
//! `W` its white. Undoing that is exact in brightness wherever the picture
//! isn't crushed, but H.264 has already thrown away the detail it lifted out
//! of the darks, so the texture under the letters is copied from the frames
//! around (±3 s, aligned by optical flow, twice), the inverse giving only the
//! brightness: real pixels, no glass or plastic look.
//!
//! Three parts, as the work is done:
//! - [`learn`]: the matte, white and blend curve, once per channel's mark,
//!   from a long stretch of footage that carries it (each pixel's spread of
//!   brightness against the background round the letters, ~2,000 frames).
//! - [`remove`]: each stretch of footage after: the mark found in every frame
//!   (it may drift, jump or fade; its opacity fitted per frame), undone, the
//!   texture under it filled from its neighbours, written as a stacked strip
//!   (picture over alpha) of just the box it touched.
//! - `flow` (DIS on that box only), `find` (the search), `restore` (the
//!   frame's undoing and filling) and `plane` (the picture operations).

mod find;
mod flow;
mod learn;
mod plane;
mod restore;
mod run;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

pub use learn::learn;
pub use run::{remove, Footage, Removed};

/// A channel's mark as learned: what [`remove`] needs of it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Model {
    /// The method's version: a model of another is learned again.
    pub version: u32,
    /// The picture it was learned on (its matte is in that picture's pixels).
    pub width: u32,
    pub height: u32,
    /// The blend curve: `lin(v) = ((v − 16) / 219)^gamma`.
    pub gamma: f32,
    /// Its white, in linear light.
    pub white: f32,
    /// Where its matte's top left sat in the frames it was learned from.
    pub at: [f32; 2],
    pub matte_width: u32,
    pub matte_height: u32,
    /// Its matte, row by row: little-endian f32s, base64.
    pub matte: String,
    /// How strong it is at its strongest letters (their median alpha).
    pub strength: f32,
    /// Frames it was learned from.
    pub frames: u32,
}

pub const VERSION: u32 = 1;

impl Model {
    pub(crate) fn matte(&self) -> Result<plane::Plane, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&self.matte)
            .map_err(|error| format!("the watermark's matte doesn't read: {error}"))?;
        let (w, h) = (self.matte_width as usize, self.matte_height as usize);
        if bytes.len() != w * h * 4 || w == 0 || h == 0 {
            return Err("the watermark's matte isn't its size".to_owned());
        }
        let data = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|four| {
                f32::from_le_bytes([
                    four.first().copied().unwrap_or(0),
                    four.get(1).copied().unwrap_or(0),
                    four.get(2).copied().unwrap_or(0),
                    four.get(3).copied().unwrap_or(0),
                ])
            })
            .collect();
        Ok(plane::Plane { w, h, data })
    }

    pub(crate) fn with_matte(mut self, matte: &plane::Plane) -> Self {
        let bytes: Vec<u8> = matte.data.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.matte = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.matte_width = matte.w as u32;
        self.matte_height = matte.h as u32;
        self
    }

    /// The matte and where it sits, for a picture `w × h` (another size of the same channel's footage: scaled).
    pub(crate) fn for_size(&self, w: u32, h: u32) -> Result<(plane::Plane, [f32; 2]), String> {
        let matte = self.matte()?;
        if w == self.width && h == self.height {
            return Ok((matte, self.at));
        }
        let scale = w as f32 / self.width.max(1) as f32;
        let (mw, mh) = (
            ((matte.w as f32) * scale).round().max(1.0) as usize,
            ((matte.h as f32) * scale).round().max(1.0) as usize,
        );
        Ok((
            matte.resized(mw, mh),
            [self.at[0] * scale, self.at[1] * scale],
        ))
    }
}

/// The blend curve: file values to linear light and back.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Curve {
    pub gamma: f32,
    pub white: f32,
}

impl Curve {
    #[inline]
    pub fn lin(self, v: f32) -> f32 {
        ((v - 16.0) / 219.0).clamp(0.0, 1.2).powf(self.gamma)
    }

    #[inline]
    pub fn disp(self, l: f32) -> f32 {
        l.max(0.0).powf(1.0 / self.gamma) * 219.0 + 16.0
    }

    /// The picture under a mark of alpha `a` (brightness, file values).
    #[inline]
    pub fn undo(self, v: f32, a: f32) -> f32 {
        self.disp((self.lin(v) - a * self.white) / (1.0 - a).max(0.05))
    }

    /// The picture `j` with a mark of alpha `a` over it.
    #[inline]
    pub fn mark(self, j: f32, a: f32) -> f32 {
        self.disp((1.0 - a) * self.lin(j) + a * self.white)
    }

    /// How much the mark squashes brightness at `j` (d out / d in): near 1 in the brights, small in crushed darks.
    #[inline]
    pub fn slope(self, j: f32, a: f32) -> f32 {
        (self.mark(j + 1.0, a) - self.mark(j - 1.0, a)) / 2.0
    }
}

/// How much colour a mark of alpha `a` leaves over brightness `j` (the lab's fit on Tulsa's mark: it greys the darks most).
#[inline]
pub(crate) fn chroma_gain(j: f32, a: f32) -> f32 {
    let k = 0.45 * (-(j - 16.0).max(0.0) / 30.0).exp() + 0.03;
    (1.0 - (a / 0.1) * k).clamp(0.3, 1.0)
}

/// A box as shares of the picture (x0, y0, x1, y1), as the server's boxes are.
pub type Shares = [f64; 4];

/// Synthetic footage for the tests (the lab's generator, small): soft letters and a moving scene.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::plane::Plane;

    /// A matte `w × h` of letter-like strokes (bars and rings 7–8 px thick, soft edges) at `strength`.
    pub fn letters_matte(w: usize, h: usize, strength: f32) -> Plane {
        let mut hard = Plane::new(w, h, 0.0);
        // Each 30 px cell a different letter: a bar, a ring, a ring with a bar through it, two bars, a cross.
        let shapes = [3usize, 1, 4, 0, 2, 1, 3, 0, 4, 2];
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32, y as f32);
                let index = x / 30;
                let shape = shapes.get(index % shapes.len()).copied().unwrap_or(0);
                let left = index as f32 * 30.0;
                let (cx, cy) = (
                    left + 15.0,
                    h as f32 / 2.0 + (index as f32 * 1.7).sin() * 4.0,
                );
                let ring = ((fx - cx).hypot(fy - cy) - 9.0).abs() < 4.0;
                let bar = |at: f32| (fx - at).abs() < 4.0 && fy > 5.0 && fy < h as f32 - 5.0;
                let across = (fy - cy).abs() < 3.5 && (fx - cx).abs() < 11.0;
                let on = match shape {
                    0 => bar(left + 8.0),
                    1 => ring,
                    2 => ring || bar(left + 15.0),
                    3 => bar(left + 6.0) || bar(left + 20.0) || across,
                    _ => across || bar(cx),
                };
                let inside = x >= 2 && x + 2 < w && y >= 2 && y + 2 < h;
                if inside && on {
                    hard.set(x, y, strength);
                }
            }
        }
        hard.gaussian(0.8)
    }

    /// A textured scene moving across the picture over frames `t`, with darks, mids and brights.
    pub fn scene(w: usize, h: usize, t: usize) -> Plane {
        let mut out = Plane::new(w, h, 0.0);
        let (dx, dy) = (t as f32 * 2.3, (t as f32 * 0.07).sin() * 25.0);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32 + dx, y as f32 + dy);
                let base =
                    110.0 + 100.0 * (fx * 0.013).sin() * (fy * 0.005 + t as f32 * 0.01).cos();
                // Texture in some places, smooth (a wall, the sky) in others.
                let busy = (0.5 + 0.5 * (fx * 0.011 + fy * 0.023).sin()).powi(2);
                let detail = busy
                    * (18.0 * (fx * 0.21).sin() * (fy * 0.19).cos()
                        + 9.0 * ((fx + 2.0 * fy) * 0.37).sin());
                out.set(x, y, (base + detail).clamp(16.0, 235.0));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undoing_a_mark_gives_the_picture_back_in_linear_light() {
        let curve = Curve {
            gamma: 2.54,
            white: 0.69,
        };
        for &a in &[0.02f32, 0.08, 0.2, 0.5] {
            for j in (16..=235).step_by(7) {
                let j = j as f32;
                let marked = curve.mark(j, a);
                let back = curve.undo(marked, a);
                // Float noise only (at black a millionth of light is a tenth of a level).
                assert!(
                    (back - j).abs() < if j < 24.0 { 0.6 } else { 0.05 },
                    "a {a} j {j}: {back}"
                );
            }
        }
        // A plain inverse in file values would be off: the mark lifts black a lot and white hardly.
        let black = curve.mark(16.0, 0.08);
        assert!(
            black > 70.0 && black < 100.0,
            "black under the mark: {black}"
        );
        assert!(curve.mark(235.0, 0.08) - 235.0 < 0.0);
        assert!(curve.slope(16.0, 0.08) < 0.3 && curve.slope(200.0, 0.08) > 0.85);
    }

    #[test]
    fn a_model_keeps_its_matte_through_json() {
        let mut matte = plane::Plane::new(5, 3, 0.0);
        matte.set(2, 1, 0.0812);
        let model = Model {
            version: VERSION,
            width: 1280,
            height: 720,
            gamma: 2.5,
            white: 0.7,
            at: [10.0, 20.0],
            matte_width: 0,
            matte_height: 0,
            matte: String::new(),
            strength: 0.08,
            frames: 100,
        }
        .with_matte(&matte);
        let text = serde_json::to_string(&model).unwrap();
        let back: Model = serde_json::from_str(&text).unwrap();
        assert_eq!(back.matte().unwrap(), matte);
        let (scaled, at) = back.for_size(1920, 1080).unwrap();
        assert_eq!((scaled.w, scaled.h), (8, 5));
        assert_eq!(at, [15.0, 30.0]);
    }
}
