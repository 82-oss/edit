//! Exports a project the ways the team does and says what each took: wall seconds, CPU
//! seconds (this process and the FFmpegs it ran) and peak memory. A measurement for the
//! resource climb, not a test: `cargo run -p edit-engine --release --example export_bench --
//! <project.json> <out dir> [case…]`. Media paths in the project are relative to its folder.
//! Every case starts with no chunks kept, as a first export does.

// A measurement run by hand or by the climb: a bad input should stop it loudly.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use edit_core::Project;
use edit_engine::export::{ExportOptions, Fill, Preset, Quality, Shape};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn options(case: &str) -> ExportOptions {
    let mut options = ExportOptions {
        size: Some(1080),
        hardware: true,
        audio: true,
        loudness: Some(-14.0),
        ..ExportOptions::default()
    };
    match case {
        // A share: YouTube's settings at 1080p (exporting.ts DEFAULTS, preset youtube).
        "share" => options.preset = Preset::Youtube,
        // A Short: 9:16 over a blurred copy of itself.
        "vertical" => {
            options.shape = Shape::Vertical;
            options.fill = Fill::Blur;
        }
        // Smooth playback's render (playback_render.ts playbackOptions), after every settled edit.
        "smooth" => {
            options.size = None;
            options.quality = Quality::Small;
            options.loudness = None;
            options.fill = Fill::Black;
        }
        other => panic!("no case {other}"),
    }
    // The yardstick a case's output is held to: the same picture as ProRes 422 HQ.
    if std::env::var_os("BENCH_REFERENCE").is_some() {
        options.format = edit_engine::export::Format::Prores;
    }
    options
}

struct Usage {
    cpu: f64,
    children: f64,
}

fn usage() -> Usage {
    let seconds = |who| {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(who, &mut usage) };
        let time = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
        (time(usage.ru_utime) + time(usage.ru_stime), usage.ru_maxrss)
    };
    Usage {
        cpu: seconds(libc::RUSAGE_SELF).0,
        children: seconds(libc::RUSAGE_CHILDREN).0,
    }
}

fn peak_bytes(who: i32) -> f64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(who, &mut usage) };
    // Linux gives KiB, macOS bytes.
    if cfg!(target_os = "macos") {
        usage.ru_maxrss as f64
    } else {
        usage.ru_maxrss as f64 * 1024.0
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let project_path = PathBuf::from(args.next().expect("project.json"));
    let out = PathBuf::from(args.next().expect("out dir"));
    let mut cases: Vec<String> = args.collect();
    if cases.is_empty() {
        cases = vec!["share".into(), "vertical".into(), "smooth".into()];
    }
    let base = project_path.parent().unwrap().canonicalize().unwrap();
    let mut json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&project_path).unwrap()).unwrap();
    for media in json["media"].as_array_mut().unwrap() {
        let path = media["path"].as_str().unwrap().to_owned();
        media["path"] = base.join(path).to_string_lossy().into_owned().into();
    }
    let project: Project = serde_json::from_value(json).unwrap();
    std::fs::create_dir_all(&out).unwrap();
    // Absolute, as the server's are: the join's list names chunks by path.
    let out = out.canonicalize().unwrap();
    let cache = out.join("cache");
    for case in &cases {
        let options = options(case);
        let plan = edit_engine::export::plan(&options, &project, true).unwrap();
        std::fs::remove_dir_all(&cache).ok();
        std::fs::create_dir_all(&cache).unwrap();
        let output = edit_engine::export::with_extension(&out.join(case), options.format);
        std::fs::remove_file(&output).ok();
        let before = usage();
        let started = Instant::now();
        edit_engine::render::export_file(
            &project,
            &options,
            &plan,
            &output,
            &cache,
            &HashMap::new(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap_or_else(|error| panic!("{case}: {error}"));
        let wall = started.elapsed().as_secs_f64();
        let after = usage();
        println!(
            "{{\"case\":\"{case}\",\"wall\":{wall:.3},\"cpu\":{:.3},\"children_cpu\":{:.3},\"peak_self\":{:.0},\"peak_child\":{:.0},\"output\":{:?}}}",
            after.cpu - before.cpu,
            after.children - before.children,
            peak_bytes(libc::RUSAGE_SELF),
            peak_bytes(libc::RUSAGE_CHILDREN),
            output_path(&output),
        );
    }
    std::fs::remove_dir_all(&cache).ok();
}

fn output_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
