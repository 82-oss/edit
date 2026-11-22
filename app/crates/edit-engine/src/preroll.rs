//! Reading ahead of a play in Edit.app's window (`crate::player`). A cloud
//! preview that isn't on this Mac whole is decoded through FFmpeg reading
//! Edit's server (its loopback stream, whose bytes come from 2 MiB blocks kept
//! on disk: the server's cloud_blocks.ts), and a decoder reads only what the
//! frame it's drawing needs: a block not here yet is fetched the moment the
//! picture needs it, and the picture waits for it. kenobi, an M1, Nov 17:
//! decodes stalled 1.2–4.6 s inside FFmpeg's reads while the server said the
//! next seconds were here, its guess at which bytes hold which seconds being a
//! straight line through files whose bitrate isn't one.
//!
//! So the seconds ahead of the playhead are read before the picture needs
//! them: each streamed file's stretch the timeline plays there (its picture
//! and its sound together) by an FFmpeg of its own that copies the packets to
//! nowhere (`-c copy -f null`: nothing decoded, a few percent of a core), in
//! the order the timeline plays them. Every byte it reads lands in the
//! server's blocks, so the decoder coming after reads from disk. How far
//! along the timeline it has read (`covered`) is what a held play waits for
//! (`Player::hold`, the page's spinner).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use edit_core::{evaluate_seen, ClipContent, Layer, Project};
use parking_lot::Mutex;

use crate::render::heard_segments;

/// The timeline is looked at this often for its pictures (seconds), and at every clip's start.
const LOOK_EVERY: f64 = 0.25;
/// A stretch reads this far past the last moment asked of it (seconds of the file).
const PAD: f64 = 0.5;
/// What follows on within this many seconds of a file's stretch is read with it.
const JOIN_GAP: f64 = 1.0;

/// Seconds `from..to` of the file at `path`, first played `at` seconds into
/// the timeline read and last `until` (seconds after the read's first frame).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Stretch {
    pub(crate) path: PathBuf,
    pub(crate) from: f64,
    pub(crate) to: f64,
    pub(crate) at: f64,
    pub(crate) until: f64,
}

/// What the timeline plays from frame `from` to `end` that's read through
/// `picture` (a video media's file at a second of it, None when there's
/// nothing to read ahead there: a file on this Mac, or a moment of a stream
/// that's in a local excerpt) and `sound` (a heard media's), as the
/// stretches of each file, in the order they're first played.
pub(crate) fn stretches(
    project: &Project,
    from: i64,
    end: i64,
    picture: impl Fn(&str, f64) -> Option<PathBuf>,
    sound: impl Fn(&str) -> Option<PathBuf>,
) -> Vec<Stretch> {
    let fps = project.fps();
    if end <= from || fps <= 0.0 {
        return Vec::new();
    }
    let seconds = |frame: i64| (frame - from) as f64 / fps;
    // Each moment read: its file, the file's seconds, and the timeline's (from the read's start).
    let mut asked: Vec<(PathBuf, f64, f64, f64)> = Vec::new();
    let step = ((LOOK_EVERY * fps).round() as i64).max(1);
    let mut frames: Vec<i64> = (from..end).step_by(step as usize).collect();
    let hidden: std::collections::HashSet<&str> = project
        .tracks
        .iter()
        .filter(|track| track.hidden)
        .map(|track| track.id.as_str())
        .collect();
    frames.extend(
        project
            .clips
            .iter()
            .filter(|clip| {
                matches!(clip.content, ClipContent::Video { .. })
                    && !hidden.contains(clip.track.as_str())
                    && clip.start > from
                    && clip.start < end
            })
            .map(|clip| clip.start),
    );
    frames.sort_unstable();
    frames.dedup();
    for (index, &frame) in frames.iter().enumerate() {
        let next = frames.get(index + 1).copied().unwrap_or(end);
        let span = (next - frame) as f64 / fps;
        for layer in &evaluate_seen(project, frame).layers {
            let Layer::Video {
                media, source_time, ..
            } = layer
            else {
                continue;
            };
            if project
                .media(media)
                .is_some_and(|found| found.kind == edit_core::MediaKind::Image)
            {
                continue;
            }
            if let Some(path) = picture(media, *source_time) {
                let at = seconds(frame);
                asked.push((path, *source_time, at, at + span));
            }
        }
    }
    let (start, stop) = (from as f64 / fps, end as f64 / fps);
    for segment in heard_segments(project, from, end) {
        let Some(path) = sound(&segment.media) else {
            continue;
        };
        let begins = segment.start.max(start);
        let ends = (segment.start + segment.duration).min(stop);
        if ends <= begins {
            continue;
        }
        let speed = if segment.speed > 0.0 {
            segment.speed
        } else {
            1.0
        };
        let first = segment.source_in + (begins - segment.start) * speed;
        let last = segment.source_in + (ends - segment.start) * speed;
        // Its end too, as its own moment: a long sound is one stretch, read in the timeline's order with the rest.
        if last > first {
            asked.push((path.clone(), last, ends - start, ends - start));
        }
        asked.push((path, first, begins - start, ends - start));
    }
    // In the timeline's order, each moment joins its file's stretch when it follows on from it; else it's a stretch
    // of its own (a cut back in the same file is read again where it's played).
    asked.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.1.total_cmp(&b.1)));
    let mut out: Vec<Stretch> = Vec::new();
    let mut open: std::collections::HashMap<PathBuf, usize> = std::collections::HashMap::new();
    for (path, time, at, until) in asked {
        if let Some(&index) = open.get(&path) {
            if let Some(stretch) = out.get_mut(index) {
                if time >= stretch.from - 1e-6 && time <= stretch.to + JOIN_GAP {
                    stretch.to = stretch.to.max(time + PAD);
                    stretch.until = stretch.until.max(until);
                    continue;
                }
            }
        }
        open.insert(path.clone(), out.len());
        out.push(Stretch {
            path,
            from: time.max(0.0),
            to: time + PAD,
            at,
            until,
        });
    }
    out.sort_by(|a, b| a.at.total_cmp(&b.at));
    out
}

/// Whether `path` is this server's loopback stream of a cloud preview (`…/api/cloud/preview?key=`, or a script's
/// preview in the cloud, `…/api/writer/scripts/<id>/proxy`), whose bytes it keeps in blocks on disk as they're read:
/// what's worth reading ahead.
pub(crate) fn through_server(path: &std::path::Path) -> bool {
    path.to_str().is_some_and(|text| {
        (text.starts_with("http://127.0.0.1:") || text.starts_with("http://localhost:"))
            && (text.contains("/api/cloud/preview?")
                || (text.contains("/api/writer/scripts/")
                    && text
                        .split('?')
                        .next()
                        .is_some_and(|path| path.ends_with("/proxy"))))
    })
}

/// Whether the picture of `path` at `time` (seconds of it) is read through this server: its stream, with no excerpt
/// here holding that moment (a long video's piece cut into a file, which the reader reads instead). Any excerpt of a
/// file left the whole file out, so a long video with one piece cut read every other stretch of it cold at the frame
/// that needed it (the Nov 20 audit).
pub(crate) fn picture_streamed(path: &std::path::Path, time: f64) -> bool {
    through_server(path)
        && crate::excerpts::of(path)
            .is_none_or(|list| crate::excerpts::covering(&list, time, &[]).is_none())
}

/// A line in the window's trace (`player::trace`, `EDIT_PREVIEW_TRACE=1`).
fn trace(what: impl FnOnce() -> String) {
    #[cfg(target_os = "macos")]
    crate::player::trace(what);
    #[cfg(not(target_os = "macos"))]
    let _ = what;
}

/// Stretches being read, `workers` at a time, each by an FFmpeg that's killed
/// when this is dropped (a pause, a jump, the next stretch of a play).
pub(crate) struct Preroll {
    /// The timeline's frames it reads for, and its rate.
    pub(crate) from: i64,
    pub(crate) end: i64,
    fps: f64,
    shared: Arc<Shared>,
}

struct Shared {
    stretches: Vec<Stretch>,
    /// Seconds of each stretch read from its start; infinite once it's done (or gave up).
    read: Mutex<Vec<f64>>,
    next: AtomicUsize,
    cancel: AtomicBool,
    /// The FFmpegs reading now, by stretch, so a drop stops them mid-read.
    children: Mutex<Vec<(usize, Child)>>,
}

impl Preroll {
    /// Reads `stretches` (for frames `from..end` at `fps`), `workers` at a time, on threads of their own.
    pub(crate) fn start(
        stretches: Vec<Stretch>,
        from: i64,
        end: i64,
        fps: f64,
        workers: usize,
    ) -> Self {
        let count = stretches.len();
        let shared = Arc::new(Shared {
            stretches,
            read: Mutex::new(vec![0.0; count]),
            next: AtomicUsize::new(0),
            cancel: AtomicBool::new(false),
            children: Mutex::new(Vec::new()),
        });
        for _ in 0..workers.clamp(1, count.max(1)) {
            let shared = Arc::clone(&shared);
            let _ = std::thread::Builder::new()
                .name("edit preview read-ahead".to_owned())
                .spawn(move || {
                    crate::util::utility_thread();
                    loop {
                        let index = shared.next.fetch_add(1, Ordering::AcqRel);
                        if index >= shared.stretches.len() || shared.cancel.load(Ordering::Acquire)
                        {
                            return;
                        }
                        read(&shared, index);
                    }
                });
        }
        Self {
            from,
            end,
            fps,
            shared,
        }
    }

    /// Seconds of the timeline from `from` that are read through (all of
    /// `from..end` once every stretch is; a stretch partly read counts as far
    /// as its share).
    pub(crate) fn covered(&self) -> f64 {
        let reach = (self.end - self.from).max(0) as f64 / self.fps;
        let read = self.shared.read.lock();
        let mut covered = reach;
        for (stretch, &done) in self.shared.stretches.iter().zip(read.iter()) {
            let length = (stretch.to - stretch.from).max(1e-6);
            if done.is_infinite() || done >= length {
                continue;
            }
            let share = (done / length).clamp(0.0, 1.0);
            covered = covered.min(stretch.at + share * (stretch.until - stretch.at).max(0.0));
        }
        covered.clamp(0.0, reach)
    }

    /// Every stretch read (or given up on).
    pub(crate) fn done(&self) -> bool {
        self.shared
            .read
            .lock()
            .iter()
            .all(|done| done.is_infinite())
    }
}

impl Drop for Preroll {
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::Release);
        for (_, child) in self.shared.children.lock().iter_mut() {
            let _ = child.kill();
        }
    }
}

/// Reads stretch `index` to its end with FFmpeg, saying how far it's got as it goes.
fn read(shared: &Shared, index: usize) {
    let Some(stretch) = shared.stretches.get(index) else {
        return;
    };
    let finish = || {
        if let Some(done) = shared.read.lock().get_mut(index) {
            *done = f64::INFINITY;
        }
    };
    let length = (stretch.to - stretch.from).max(0.0);
    let spawned = crate::util::ffmpeg_command()
        .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(["-protocol_whitelist", crate::util::protocols(&stretch.path)])
        .args(crate::util::url_args(&stretch.path))
        .args([
            "-ss",
            &format!("{:.3}", stretch.from),
            "-t",
            &format!("{length:.3}"),
        ])
        .arg("-i")
        .arg(&stretch.path)
        .args(["-map", "0:v?", "-map", "0:a?", "-c", "copy", "-f", "null"])
        .args(["-progress", "pipe:1", "-stats_period", "0.1", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            trace(|| format!("read-ahead of {}: {error}", stretch.path.display()));
            finish();
            return;
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        finish();
        return;
    };
    shared.children.lock().push((index, child));
    // Dropped meanwhile: the drop's kill may have missed it.
    if shared.cancel.load(Ordering::Acquire) {
        kill(shared, index);
        finish();
        return;
    }
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(micros) = line.strip_prefix("out_time_us=") {
            if let Ok(micros) = micros.trim().parse::<i64>() {
                if let Some(done) = shared.read.lock().get_mut(index) {
                    *done = (micros.max(0) as f64 / 1e6).max(*done);
                }
            }
        }
    }
    let ended = {
        let mut children = shared.children.lock();
        let position = children.iter().position(|(at, _)| *at == index);
        position.map(|position| children.swap_remove(position).1)
    };
    if let Some(mut child) = ended {
        let status = child.wait();
        if !status.as_ref().is_ok_and(|status| status.success())
            && !shared.cancel.load(Ordering::Acquire)
        {
            trace(|| {
                format!(
                    "read-ahead of {} {:.1}–{:.1} s didn't finish: {status:?}",
                    stretch.path.display(),
                    stretch.from,
                    stretch.to
                )
            });
        }
    }
    finish();
}

/// Stops stretch `index`'s FFmpeg, if it's still reading.
fn kill(shared: &Shared, index: usize) {
    let mut children = shared.children.lock();
    if let Some(position) = children.iter().position(|(at, _)| *at == index) {
        let (_, mut child) = children.swap_remove(position);
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edit-preroll-{name}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `seconds` of 30 fps H.264 with a tone.
    fn video(dir: &Path, seconds: u32) -> PathBuf {
        let path = dir.join("v.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size=320x180:rate=30:duration={seconds}"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={seconds}"))
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                "-y",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    fn project(path: &str, clips: serde_json::Value) -> Project {
        serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [{"id": "m", "name": "m", "path": path, "kind": "video", "duration": 8.0,
                "width": 320, "height": 180, "fps": 30, "has_audio": true}],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": clips,
        }))
        .unwrap()
    }

    #[test]
    fn a_shot_played_on_is_one_stretch_of_picture_and_sound() {
        let project = project(
            "http://127.0.0.1:1/api/cloud/preview?key=k",
            json!([
                {"id": "c", "track": "v", "type": "video", "media": "m", "source_in": 1.0, "start": 0, "duration": 240},
                {"id": "s", "track": "a", "type": "audio", "media": "m", "source_in": 1.0, "start": 0, "duration": 240},
            ]),
        );
        let path = |_: &str| Some(PathBuf::from("http://127.0.0.1:1/api/cloud/preview?key=k"));
        let found = stretches(&project, 30, 120, |media, _| path(media), path);
        assert_eq!(found.len(), 1, "{found:?}");
        let stretch = &found[0];
        assert!((stretch.from - 2.0).abs() < 1e-6, "{stretch:?}");
        // To the sound's last moment (5 s of the file) and a little past it.
        assert!((stretch.to - (5.0 + PAD)).abs() < 1e-6, "{stretch:?}");
        assert!(
            stretch.at.abs() < 1e-6 && (stretch.until - 3.0).abs() < 1e-6,
            "{stretch:?}"
        );
    }

    #[test]
    fn a_cut_back_in_a_file_is_read_again_where_its_played_and_local_files_are_left() {
        let project = project(
            "http://127.0.0.1:1/x",
            json!([
                {"id": "c1", "track": "v", "type": "video", "media": "m", "source_in": 5.0, "start": 0, "duration": 30},
                {"id": "c2", "track": "v", "type": "video", "media": "m", "source_in": 0.0, "start": 30, "duration": 30},
            ]),
        );
        let found = stretches(
            &project,
            0,
            60,
            |_, _| Some(PathBuf::from("http://127.0.0.1:1/x")),
            |_| None,
        );
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(
            (found[0].from - 5.0).abs() < 1e-6 && found[0].at.abs() < 1e-6,
            "{found:?}"
        );
        assert!(
            found[1].from.abs() < 1e-6 && (found[1].at - 1.0).abs() < 1e-6,
            "{found:?}"
        );
        assert!(stretches(&project, 0, 60, |_, _| None, |_| None).is_empty());
    }

    #[test]
    fn it_reads_to_the_end_and_says_how_far() {
        let dir = temp_dir("read");
        let file = video(&dir, 6);
        let text = file.to_string_lossy().into_owned();
        let project = project(
            &text,
            json!([
                {"id": "c", "track": "v", "type": "video", "media": "m", "source_in": 0.0, "start": 0, "duration": 180},
                {"id": "s", "track": "a", "type": "audio", "media": "m", "source_in": 0.0, "start": 0, "duration": 180},
            ]),
        );
        let path = |_: &str| Some(file.clone());
        let found = stretches(&project, 0, 120, |media, _| path(media), path);
        assert_eq!(found.len(), 1);
        let preroll = Preroll::start(found, 0, 120, 30.0, 2);
        let began = Instant::now();
        while !preroll.done() {
            assert!(began.elapsed() < Duration::from_secs(20), "never read");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            (preroll.covered() - 4.0).abs() < 1e-6,
            "{}",
            preroll.covered()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_read_that_waits_on_a_quiet_server_counts_nothing_and_stops_when_dropped() {
        // A server that takes the connection and never answers: FFmpeg waits inside its read.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(3));
            drop(socket);
        });
        let url = format!("http://127.0.0.1:{port}/api/cloud/preview?key=k");
        let project = project(
            &url,
            json!([{"id": "c", "track": "v", "type": "video", "media": "m", "source_in": 0.0, "start": 0, "duration": 120}]),
        );
        let found = stretches(&project, 0, 90, |_, _| Some(PathBuf::from(&url)), |_| None);
        let preroll = Preroll::start(found, 0, 90, 30.0, 1);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!preroll.done());
        assert!(preroll.covered() < 1e-6, "{}", preroll.covered());
        let shared = Arc::clone(&preroll.shared);
        drop(preroll);
        let began = Instant::now();
        while !shared.children.lock().is_empty() {
            assert!(
                began.elapsed() < Duration::from_secs(2),
                "its FFmpeg wasn't stopped"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        held.join().unwrap();
    }

    #[test]
    fn a_long_videos_picture_is_read_ahead_where_no_piece_of_it_is_cut_here() {
        let url = "http://127.0.0.1:7700/api/cloud/preview?key=edit%2Fpieces%2Fv3%2Fdrive%2FreadAhead%2Fproxy.mp4";
        assert!(picture_streamed(Path::new(url), 65.0));
        let object = crate::excerpts::object_of(Path::new(url)).unwrap();
        crate::excerpts::add(
            &object,
            [crate::excerpts::Excerpt {
                from: 60.0,
                to: 120.0,
                path: PathBuf::from("/cache/native2/1.mp4"),
            }],
        );
        // The piece cut here is read from its file; the rest of the video still streams, and is read ahead.
        assert!(!picture_streamed(Path::new(url), 65.0));
        assert!(picture_streamed(Path::new(url), 30.0));
        assert!(picture_streamed(Path::new(url), 125.0));
        assert!(!picture_streamed(
            Path::new("/Users/x/.edit/cache/a.mp4"),
            30.0
        ));
    }

    #[test]
    fn a_scripts_preview_in_the_cloud_is_read_ahead_as_the_editors_cloud_footage_is() {
        assert!(through_server(Path::new(
            "http://127.0.0.1:7700/api/cloud/preview?key=edit%2Fproxies%2Fa.mp4"
        )));
        assert!(through_server(Path::new(
            "http://127.0.0.1:7700/api/writer/scripts/7d0e4c1a-2b3f-4a5e-8c9d-0f1e2d3c4b5a/proxy"
        )));
        assert!(!through_server(Path::new(
            "http://127.0.0.1:7700/api/writer/scripts/7d0e4c1a/footage/yt-0.mp4"
        )));
        assert!(!through_server(Path::new(
            "/Users/x/.edit/writer/scripts/a/proxy.mp4"
        )));
        assert!(!through_server(Path::new(
            "https://example.com/api/cloud/preview?key=a"
        )));
    }
}
