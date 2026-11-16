//! Pictures decoded behind the playhead, so a drag back reads them instead of
//! seeking. A reader only decodes forward: every step back was a seek, the
//! decoder starting over from the keyframe before (35–40 ms a picture on an M1,
//! against 2 ms a step forward: a drag back drew 25 pictures a second, Nov 16).
//!
//! While the playhead moves back at rest, a thread of its own decodes the
//! stretches below it with a reader of its own (one seek a stretch, then
//! forward), and keeps each picture as the drawing path would have read it: by
//! its file, size and the exact source time asked (`Fill`), so a hit is that
//! picture whatever the footage's frame rate. The drawing path looks here
//! first at rest and reads the rest as before; playing never looks, so a play
//! reads exactly as it did. The pictures are bounded by bytes (`BUDGET`), the
//! farthest from the playhead going first, and all go when the edit, the
//! media, the size or a read changes (`clear`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use parking_lot::Mutex;

use crate::render::{DecodeKey, Source, VideoReader};

/// Bytes of pictures kept: about 32 at 1080p (8.3 MB each as BGRA), more at
/// the smaller size a viewer usually shows. Edit runs on 8 GB Macs beside
/// exports and agents, so they all go after `IDLE` with no step back.
pub(crate) const BUDGET: usize = 256 << 20;

/// Threads filling, each a stretch at a time with readers of its own: a stretch
/// is a seek and then its frames forward, so two keep ahead of a drag one can't.
const FILLERS: usize = 2;

/// Readers a fill thread keeps between stretches (one per file it fills from).
const READERS: usize = 2;

/// With nothing asked this long, the readers and the pictures go.
const IDLE: Duration = Duration::from_secs(20);

/// A decoded picture, shared by the cache and the frames drawn from it.
pub(crate) type Pixels = Arc<Vec<u8>>;

struct Entry {
    pixels: Pixels,
    /// The timeline frame it was decoded for (`Cache::insert` lets go by it).
    frame: i64,
}

pub(crate) struct Cache {
    entries: HashMap<(DecodeKey, u64), Entry>,
    bytes: usize,
    budget: usize,
    /// Bumped by every `clear`: a fill begun before it puts nothing in.
    generation: u64,
    /// The frame last looked up.
    at: i64,
}

impl Cache {
    fn new(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            budget,
            generation: 0,
            at: 0,
        }
    }

    fn contains(&self, key: &DecodeKey, time: f64) -> bool {
        self.entries.contains_key(&(key.clone(), time.to_bits()))
    }

    fn get(&self, key: &DecodeKey, time: f64) -> Option<Pixels> {
        self.entries
            .get(&(key.clone(), time.to_bits()))
            .map(|entry| Arc::clone(&entry.pixels))
    }

    /// Keeps `pixels`, letting go first of the pictures above the playhead (the
    /// farthest first: they're passed, and a reader reads on forward anyway),
    /// then of those farthest below it. False when there's nothing to let go
    /// that's worth less than it, or the cache was cleared since `generation`.
    fn insert(
        &mut self,
        generation: u64,
        key: DecodeKey,
        time: f64,
        frame: i64,
        pixels: Pixels,
    ) -> bool {
        if generation != self.generation || pixels.len() > self.budget {
            return false;
        }
        let at = self.at;
        let worth = |frame: i64| (frame > at, (frame - at).abs());
        let this = worth(frame);
        while self.bytes + pixels.len() > self.budget {
            let least = self
                .entries
                .iter()
                .max_by_key(|(_, entry)| worth(entry.frame))
                .map(|(key, entry)| (key.clone(), worth(entry.frame)));
            match least {
                Some((key, less)) if less > this => {
                    if let Some(gone) = self.entries.remove(&key) {
                        self.bytes -= gone.pixels.len();
                    }
                }
                _ => return false,
            }
        }
        self.bytes += pixels.len();
        if let Some(old) = self
            .entries
            .insert((key, time.to_bits()), Entry { pixels, frame })
        {
            self.bytes -= old.pixels.len();
        }
        true
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.generation += 1;
    }
}

/// One stretch to decode: for each file, its source times ascending, each with
/// the timeline frame it's for.
struct Fill {
    generation: u64,
    run: u64,
    files: Vec<(Source, Vec<(f64, i64)>)>,
}

pub(crate) struct Behind {
    cache: Arc<Mutex<Cache>>,
    fills: mpsc::Sender<Fill>,
    /// The run of steps back now: a fill of an older one stops.
    run: Arc<AtomicU64>,
    /// The frames asked for in this run, `[low, top]`, and the cache's generation then.
    asked: Option<(i64, i64, u64)>,
    /// The frame drawn last at rest.
    last: Option<i64>,
}

impl Behind {
    pub(crate) fn new(budget: usize) -> Self {
        let cache = Arc::new(Mutex::new(Cache::new(budget)));
        let run = Arc::new(AtomicU64::new(0));
        let (fills, requests) = mpsc::channel::<Fill>();
        let requests = Arc::new(Mutex::new(requests));
        for _ in 0..FILLERS {
            let (held, current, requests) =
                (Arc::clone(&cache), Arc::clone(&run), Arc::clone(&requests));
            let _ = std::thread::Builder::new()
                .name("edit preview behind".to_owned())
                .spawn(move || fill(&held, &current, &requests));
        }
        Self {
            cache,
            fills,
            run,
            asked: None,
            last: None,
        }
    }

    /// The pictures kept for `requests` at `frame` (None where there's none).
    pub(crate) fn lookup(&self, frame: i64, requests: &[(Source, f64)]) -> Vec<Option<Pixels>> {
        let mut cache = self.cache.lock();
        cache.at = frame;
        requests
            .iter()
            .map(|(source, time)| cache.get(&source.key, *time))
            .collect()
    }

    /// The playhead is at `frame` at rest. Stepping back (by less than
    /// `STEP_SECONDS`: a click farther back is a jump, not a drag), the
    /// stretches below it are asked for: `AHEAD` of them kept asked below the
    /// playhead, each of `stretch` frames (from the bytes a frame's pictures
    /// take, and at most a second), and `layers` says what each frame reads. A
    /// step forward asks for nothing; a step back outside what this run asked
    /// starts another.
    pub(crate) fn moved(
        &mut self,
        frame: i64,
        fps: f64,
        mut layers: impl FnMut(i64) -> Vec<(Source, f64)>,
    ) {
        let Some(last) = self.last.replace(frame) else {
            return;
        };
        if frame >= last || (last - frame) as f64 > STEP_SECONDS * fps {
            return;
        }
        let bytes: usize = layers(frame).iter().map(|(source, _)| source.bytes()).sum();
        if bytes == 0 {
            return;
        }
        let (budget, generation) = {
            let cache = self.cache.lock();
            (cache.budget, cache.generation)
        };
        // Two thirds of the pictures kept are the stretches asked below the
        // playhead; the rest the ones passed, for a drag that turns.
        let stretch = ((budget / 3 / bytes) as i64).clamp(2, fps.round().max(2.0) as i64);
        let below = stretch * AHEAD;
        let (mut low, top) = match self.asked {
            // Gone idle since, what was asked is gone too.
            Some((low, top, asked)) if low <= frame && frame <= top && asked == generation => {
                (low, top)
            }
            _ => {
                // Whatever an earlier run still has to decode isn't wanted now.
                self.run.fetch_add(1, Ordering::AcqRel);
                (frame, frame)
            }
        };
        while low > 0 && frame - low < below {
            let from = (low - stretch).max(0);
            self.ask(from..low, &mut layers);
            low = from;
        }
        self.asked = Some((low, top, generation));
    }

    /// Playing: what's left to fill stops (it would take the decoder's time from the play), the pictures stay.
    pub(crate) fn stop(&mut self) {
        if self.last.take().is_some() | self.asked.take().is_some() {
            self.run.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Lets every picture go (the edit, the media or the size changed, or a read failed), and any fill under way.
    pub(crate) fn clear(&mut self) {
        self.cache.lock().clear();
        self.run.fetch_add(1, Ordering::AcqRel);
        self.asked = None;
        self.last = None;
    }

    fn ask(
        &self,
        frames: std::ops::Range<i64>,
        layers: &mut impl FnMut(i64) -> Vec<(Source, f64)>,
    ) {
        let mut files: Vec<(Source, Vec<(f64, i64)>)> = Vec::new();
        for frame in frames {
            for (source, time) in layers(frame) {
                match files.iter_mut().find(|(file, _)| file.key == source.key) {
                    Some((_, times)) => times.push((time, frame)),
                    None => files.push((source, vec![(time, frame)])),
                }
            }
        }
        for (_, times) in &mut files {
            // Forward, so one seek starts each file's stretch.
            times.sort_by(|a, b| a.0.total_cmp(&b.0));
            times.dedup_by(|a, b| a.0.to_bits() == b.0.to_bits());
        }
        let generation = self.cache.lock().generation;
        let _ = self.fills.send(Fill {
            generation,
            run: self.run.load(Ordering::Acquire),
            files,
        });
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.cache.lock().bytes
    }
}

/// How many stretches are kept asked for below the playhead.
const AHEAD: i64 = 2;

/// A step back farther than this is a jump (a click on the bar), not a drag's step: nothing is filled for it.
const STEP_SECONDS: f64 = 2.0;

/// A fill thread: each stretch asked, decoded forward with its own readers
/// into the cache, unless a newer run or a `clear` came since.
fn fill(cache: &Mutex<Cache>, run: &AtomicU64, requests: &Mutex<mpsc::Receiver<Fill>>) {
    // Behind the frame being drawn: utility work, never ahead of the player's thread.
    crate::util::utility_thread();
    crate::render::decode_stats::AHEAD_THREAD.with(|ahead| ahead.set(true));
    let mut readers: Vec<VideoReader> = Vec::new();
    let mut generation = 0;
    loop {
        // One receiver shared: whichever thread is free takes the next stretch.
        let next = requests.lock().recv_timeout(IDLE);
        let job = match next {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                readers.clear();
                let mut held = cache.lock();
                if held.bytes > 0 {
                    held.clear();
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        let stale =
            || job.run != run.load(Ordering::Acquire) || job.generation != cache.lock().generation;
        if stale() {
            continue;
        }
        if job.generation != generation {
            // The media may have changed under the readers held.
            readers.clear();
            generation = job.generation;
        }
        'files: for (source, times) in job.files {
            let wanted: Vec<(f64, i64)> = {
                let held = cache.lock();
                times
                    .into_iter()
                    .filter(|(time, _)| !held.contains(&source.key, *time))
                    .collect()
            };
            if wanted.is_empty() {
                continue;
            }
            let mut reader = match readers
                .iter()
                .position(|reader| reader.source.key == source.key)
            {
                Some(index) => readers.swap_remove(index),
                None => VideoReader::open(source.clone()),
            };
            for (time, frame) in wanted {
                if stale() {
                    break 'files;
                }
                let mut pixels = vec![0_u8; source.bytes()];
                if reader.frame_into(time, &mut pixels, false).is_err() {
                    // Left for the drawing path, which reads it and says why.
                    continue 'files;
                }
                if !cache.lock().insert(
                    job.generation,
                    source.key.clone(),
                    time,
                    frame,
                    Arc::new(pixels),
                ) {
                    break;
                }
            }
            readers.push(reader);
            if readers.len() > READERS {
                readers.remove(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::Order;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Instant;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edit-behind-{name}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `seconds` of 30 fps H.264 at `width`×`height`, a keyframe every `gop` frames, every frame different.
    fn video(dir: &Path, width: u32, height: u32, seconds: u32, gop: u32) -> PathBuf {
        let path = dir.join(format!("{width}x{height}-g{gop}.mp4"));
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg(format!(
                "testsrc2=size={width}x{height}:rate=30:duration={seconds}"
            ))
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-g",
                &gop.to_string(),
                "-y",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    fn source(path: &Path, width: u32, height: u32) -> Source {
        Source::video(path, (width, height), Order::Bgra, 30.0)
    }

    /// Waits until the fill has kept the pictures for `frames` (or 10 s).
    fn wait_for(behind: &Behind, source: &Source, frames: impl Iterator<Item = i64> + Clone) {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            let cache = behind.cache.lock();
            if frames
                .clone()
                .all(|frame| cache.contains(&source.key, frame as f64 / 30.0))
            {
                return;
            }
            drop(cache);
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("the fill didn't keep the frames asked");
    }

    /// A step back is a picture kept by the fill, the same as a reader reads
    /// there; a step forward asks for nothing.
    #[test]
    fn steps_back_read_what_the_fill_kept() {
        let dir = temp_dir("steps");
        let path = video(&dir, 320, 180, 3, 30);
        let file = source(&path, 320, 180);
        let mut behind = Behind::new(BUDGET);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        behind.moved(60, 30.0, layers);
        behind.moved(61, 30.0, layers);
        assert_eq!(behind.bytes(), 0, "forward asks for nothing");
        behind.moved(60, 30.0, layers);
        // Two stretches below, of a second each at this size.
        wait_for(&behind, &file, 0..60);
        let mut reader = VideoReader::open(file.clone());
        for frame in [59, 45, 31, 30, 0] {
            let kept = behind.lookup(frame, &layers(frame)).remove(0);
            let mut read = vec![0_u8; file.bytes()];
            reader
                .frame_into(frame as f64 / 30.0, &mut read, false)
                .unwrap();
            assert!(kept.as_deref() == Some(&read), "frame {frame}");
        }
        assert!(behind.lookup(61, &layers(61))[0].is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A changed edit or media lets every picture go, and a fill under way puts nothing in after.
    #[test]
    fn a_clear_lets_the_pictures_go() {
        let dir = temp_dir("clear");
        let path = video(&dir, 320, 180, 2, 30);
        let file = source(&path, 320, 180);
        let mut behind = Behind::new(BUDGET);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        behind.moved(40, 30.0, layers);
        behind.moved(39, 30.0, layers);
        wait_for(&behind, &file, 9..39);
        behind.clear();
        assert_eq!(behind.bytes(), 0);
        assert!(behind.lookup(20, &layers(20))[0].is_none());
        // A fill asked before the clear keeps nothing.
        let mut stale = Cache::new(BUDGET);
        let generation = stale.generation;
        stale.clear();
        assert!(!stale.insert(generation, file.key.clone(), 0.0, 0, Arc::new(vec![0; 16])));
        // And after it, a step back fills again.
        behind.moved(30, 30.0, layers);
        behind.moved(29, 30.0, layers);
        wait_for(&behind, &file, 0..29);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A click far back is a jump, not a drag: nothing is filled for it. And a play stops the fill
    /// (its run is over), the next step back after it starting a run of its own.
    #[test]
    fn jumps_and_plays_fill_nothing() {
        let file = source(Path::new("/nowhere.mp4"), 16, 16);
        let mut behind = Behind::new(BUDGET);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        behind.moved(300, 30.0, layers);
        behind.moved(100, 30.0, layers);
        assert!(behind.asked.is_none(), "a jump of 200 frames");
        behind.moved(99, 30.0, layers);
        assert!(behind.asked.is_some(), "a step back");
        let run = behind.run.load(Ordering::Acquire);
        behind.stop();
        assert!(behind.run.load(Ordering::Acquire) > run);
        assert!(behind.asked.is_none() && behind.last.is_none());
        behind.moved(80, 30.0, layers);
        assert!(behind.asked.is_none(), "the first frame drawn after a play");
    }

    /// The pictures kept never take more than the budget, the farthest from the playhead going first.
    #[test]
    fn the_bytes_stay_in_the_budget() {
        let key = source(Path::new("/nowhere.mp4"), 16, 16).key;
        let mut cache = Cache::new(10 * 1024);
        cache.at = 100;
        for frame in 80..100 {
            cache.insert(
                0,
                key.clone(),
                frame as f64 / 30.0,
                frame,
                Arc::new(vec![0; 1024]),
            );
            assert!(cache.bytes <= 10 * 1024);
        }
        // The ten nearest the playhead stayed.
        assert_eq!(cache.entries.len(), 10);
        assert!((90..100).all(|frame| cache.contains(&key, frame as f64 / 30.0)));
        // One farther than all of them isn't kept.
        assert!(!cache.insert(0, key.clone(), 0.0, 0, Arc::new(vec![0; 1024])));
        // Moved back, the ones passed above go for the ones below, however near.
        cache.at = 95;
        for frame in [89, 88] {
            assert!(cache.insert(
                0,
                key.clone(),
                frame as f64 / 30.0,
                frame,
                Arc::new(vec![0; 1024])
            ));
        }
        assert!(!cache.contains(&key, 99.0 / 30.0) && !cache.contains(&key, 98.0 / 30.0));
        assert!(cache.contains(&key, 96.0 / 30.0));
        assert!(cache.bytes <= 10 * 1024);
        // The fill's stretches are sized to fit beside what's passed.
        let dir = temp_dir("budget");
        let path = video(&dir, 320, 180, 2, 30);
        let file = source(&path, 320, 180);
        let frame_bytes = file.bytes();
        let mut behind = Behind::new(frame_bytes * 12);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        behind.moved(59, 30.0, layers);
        for frame in (0..59).rev() {
            behind.moved(frame, 30.0, layers);
            behind.lookup(frame, &layers(frame));
            assert!(behind.bytes() <= frame_bytes * 12);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Times each step of a drag back through 1080p30 H.264, a keyframe every 2 s (an export's) and
    /// every half second (a preview's), frame by frame and three frames a step, a step every 25 ms (a
    /// mouse drag's events), the reader alone and with the fill; and forward, a step on's cost.
    /// `cargo test -p edit-engine --release --lib -- --ignored --nocapture drag_back_bench`.
    #[test]
    #[ignore]
    fn drag_back_bench() {
        let dir = temp_dir("bench");
        for gop in [60, 15] {
            let path = video(&dir, 1920, 1080, 10, gop);
            let file = source(&path, 1920, 1080);
            let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
            let report = |name: &str, mut times: Vec<f64>| {
                times.sort_by(f64::total_cmp);
                let mean = times.iter().sum::<f64>() / times.len() as f64;
                let at = |q: f64| times[((times.len() - 1) as f64 * q) as usize];
                println!(
                    "g{gop} {name}: {} steps, mean {mean:.1} ms, median {:.1}, p90 {:.1}, max {:.1}, over 20 ms {}",
                    times.len(),
                    at(0.5),
                    at(0.9),
                    at(1.0),
                    times.iter().filter(|ms| **ms > 20.0).count()
                );
            };
            let drag = |frames: &[i64], fill: bool| -> Vec<f64> {
                let mut reader = VideoReader::open(file.clone());
                let mut behind = Behind::new(BUDGET);
                let mut out = vec![0_u8; file.bytes()];
                // Standing on the first, as a drag starts.
                reader
                    .frame_into(frames[0] as f64 / 30.0, &mut out, false)
                    .unwrap();
                behind.moved(frames[0], 30.0, layers);
                let mut times = Vec::new();
                let started = Instant::now();
                for (step, frame) in frames.iter().enumerate().skip(1) {
                    let due = started + Duration::from_millis(25 * step as u64);
                    if let Some(wait) = due.checked_duration_since(Instant::now()) {
                        std::thread::sleep(wait);
                    }
                    let begun = Instant::now();
                    let kept = fill
                        .then(|| behind.lookup(*frame, &layers(*frame)).remove(0))
                        .flatten();
                    match kept {
                        // Handed to the renderer as it is, as the reader's `out` is.
                        Some(pixels) => drop(pixels),
                        None => {
                            reader
                                .frame_into(*frame as f64 / 30.0, &mut out, false)
                                .unwrap();
                        }
                    }
                    times.push(begun.elapsed().as_secs_f64() * 1000.0);
                    if fill {
                        behind.moved(*frame, 30.0, layers);
                    }
                }
                times
            };
            let back_one: Vec<i64> = (150..=290).rev().collect();
            let back_three: Vec<i64> = (0..=290).rev().step_by(3).collect();
            let forward_one: Vec<i64> = (150..=290).collect();
            report("back 1 a step, reader alone", drag(&back_one, false));
            report("back 1 a step, with the fill", drag(&back_one, true));
            report("back 3 a step, reader alone", drag(&back_three, false));
            report("back 3 a step, with the fill", drag(&back_three, true));
            report("forward 1 a step, reader alone", drag(&forward_one, false));
            report("forward 1 a step, with the fill", drag(&forward_one, true));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
