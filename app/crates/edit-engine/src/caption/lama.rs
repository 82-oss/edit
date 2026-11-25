//! LaMa (big-lama, Apache-2.0; Suvorov et al. 2021) run through ONNX Runtime: on a Mac by Core ML, elsewhere by CUDA
//! where an NVIDIA card and its libraries are there, else on the processor. The ONNX file is LaMa rebuilt from its own
//! code with its weights, its Fourier transforms done as matrix products whose cos/sin tables are inputs made here
//! for each picture size (caption-removal-trial/rebuild2.py; checked against the original to 0.004 of a level), so the
//! graph is only convolutions and matrix products and runs on any of them, at any size.
#![allow(clippy::indexing_slicing)] // pixel loops over one crop, in range by construction

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::still::pixels::{Mask, Rgb};

/// A loaded LaMa and where it runs.
pub struct Lama {
    _env: ort::environment::Environment,
    session: Session,
    pub provider: &'static str,
}

/// cos and sin of 2π·i·j/n, i < n, j < k, as [n × k] (i·j mod n first, so large sizes stay exact).
fn tables(n: usize, k: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut c, mut s) = (Vec::with_capacity(n * k), Vec::with_capacity(n * k));
    for i in 0..n {
        for j in 0..k {
            let a = std::f64::consts::TAU * ((i * j) % n) as f64 / n as f64;
            c.push(a.cos() as f32);
            s.push(a.sin() as f32);
        }
    }
    (c, s)
}

fn ort_err(error: impl std::fmt::Display) -> String {
    format!("LaMa: {error}")
}

impl Lama {
    /// The model at `path`, on the fastest place this computer has for it.
    pub fn load(path: &Path) -> Result<Self, String> {
        let env = ort::init()
            .with_name("edit-lama")
            .build()
            .map_err(ort_err)?;
        let fast = {
            #[cfg(target_os = "macos")]
            {
                use ort::ep::coreml::{ComputeUnits, ModelFormat};
                let cache = std::env::temp_dir().join("edit-lama-coreml");
                let _ = std::fs::create_dir_all(&cache);
                (
                    ort::ep::CoreML::default()
                        .with_model_format(ModelFormat::MLProgram)
                        .with_compute_units(ComputeUnits::All)
                        .with_model_cache_dir(cache.display())
                        .build()
                        .error_on_failure(),
                    "coreml",
                )
            }
            #[cfg(not(target_os = "macos"))]
            {
                (ort::ep::CUDA::default().build().error_on_failure(), "cuda")
            }
        };
        let tried = Session::builder(&env)
            .map_err(ort_err)?
            .with_execution_providers([fast.0])
            .map_err(|error| ort_err(error.message()))
            .and_then(|mut builder| builder.commit_from_file(path).map_err(ort_err));
        let (session, provider) = match tried {
            Ok(session) => (session, fast.1),
            Err(why) => {
                crate::log::warn(
                    "removal",
                    format!(
                        "LaMa can't run on {} ({why}); on the processor instead",
                        fast.1
                    ),
                );
                (
                    Session::builder(&env)
                        .map_err(ort_err)?
                        .commit_from_file(path)
                        .map_err(ort_err)?,
                    "cpu",
                )
            }
        };
        Ok(Self {
            _env: env,
            session,
            provider,
        })
    }

    /// `picture`'s pixels under `hole` filled (same size; any size: padded to eights here); the rest as given.
    pub fn fill(&mut self, picture: &Rgb, hole: &Mask) -> Result<Rgb, String> {
        let (w, h) = (picture.w, picture.h);
        let (pw, ph) = (w.div_ceil(8) * 8, h.div_ceil(8) * 8);
        if w == 0 || h == 0 {
            return Ok(picture.clone());
        }
        // Padded by the edge pixels, nothing to fill there.
        let mut image = vec![0f32; 3 * pw * ph];
        let mut mask = vec![0f32; pw * ph];
        for y in 0..ph {
            let sy = y.min(h - 1);
            for x in 0..pw {
                let sx = x.min(w - 1);
                let px = picture.v[sy * w + sx];
                for c in 0..3 {
                    image[c * pw * ph + y * pw + x] = f32::from(px[c]) / 255.0;
                }
                if y < h && x < w && hole.v[y * w + x] {
                    mask[y * pw + x] = 1.0;
                }
            }
        }
        let (ch, sh) = tables(ph / 8, ph / 8);
        let (cw, sw) = tables(pw / 8, pw / 16 + 1);
        let tensor = |shape: Vec<usize>, data: Vec<f32>| {
            Tensor::from_array((shape, data.into_boxed_slice())).map_err(ort_err)
        };
        let inputs = ort::inputs![
            "image" => tensor(vec![1, 3, ph, pw], image)?,
            "mask" => tensor(vec![1, 1, ph, pw], mask)?,
            "ch" => tensor(vec![ph / 8, ph / 8], ch)?,
            "sh" => tensor(vec![ph / 8, ph / 8], sh)?,
            "cw" => tensor(vec![pw / 8, pw / 16 + 1], cw)?,
            "sw" => tensor(vec![pw / 8, pw / 16 + 1], sw)?,
        ];
        let outputs = self.session.run(inputs).map_err(ort_err)?;
        let (_, data) = outputs["out"]
            .try_extract_tensor::<f32>()
            .map_err(ort_err)?;
        if data.len() < 3 * pw * ph {
            return Err("LaMa gave back too little".to_owned());
        }
        let mut out = picture.clone();
        for y in 0..h {
            for x in 0..w {
                if hole.v[y * w + x] {
                    let mut px = [0u8; 3];
                    for (c, one) in px.iter_mut().enumerate() {
                        *one = (data[c * pw * ph + y * pw + x] * 255.0)
                            .round()
                            .clamp(0.0, 255.0) as u8;
                    }
                    out.v[y * w + x] = px;
                }
            }
        }
        Ok(out)
    }
}
