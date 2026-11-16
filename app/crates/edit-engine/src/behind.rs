//! Pictures decoded behind the playhead, so a drag back reads them instead of
//! seeking. A reader only decodes forward: every step back was a seek, the
//! decoder starting over from the keyframe before (35–40 ms a picture on an M1,
//! against 2 ms a step forward: a drag back drew 25 pictures a second, Nov 16).
//!
//! While the playhead moves back at rest, two threads of their own decode the
//! stretches below it with readers of their own (one seek a stretch, then
//! forward), and keep each picture as the drawing path would have read it: by
//! its file, size and the exact source time asked (`Fill`), so a hit is that
//! picture whatever the footage's frame rate. The drawing path looks here
//! first at rest and reads the rest as before; playing never looks, so a play
//! reads exactly as it did. The pictures are bounded by bytes (`BUDGET`), the
//! farthest from the playhead going first, and all go when the edit, the
//! media, the size or a read changes (`clear`).
//!
//! The fill follows the drag's speed (a kenobi M1, Nov 16: a drag of 5 frames a
//! step drew 18 pictures a second, against 51 at 1 a step, its fixed lead of
//! ~20 frames being less than one seek ahead). Steps k frames apart keep every
//! k-th picture (`Run::stride`), so the budget covers k times the timeline, and
//! the stretches asked reach at least `LEAD_STEPS` steps below the playhead.
//! Mid-drag, a frame with no picture of its own shows the nearest one kept
//! within the step (`lookup`); once the playhead rests, its exact frame is
//! drawn (the player's `sharpen`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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

/// How many stretches are kept asked for below the playhead, at least.
const AHEAD: i64 = 2;

/// How many of the drag's steps the stretches asked reach below the playhead,
/// at least: a stretch is ready a seek and its decoding after it's asked
/// (35–130 ms and 2 ms a frame on an M1), so the lead is in steps, not frames.
const LEAD_STEPS: i64 = 10;

/// A step back farther than this is a jump (a click on the bar), not a drag's step: nothing is filled for it.
const STEP_SECONDS: f64 = 2.0;

/// A picture standing in mid-drag is of the same stretch of footage: its
/// source time within what this many times the frames between would play
/// (so a second layer of the same file, or the other side of a cut in it, is
/// never shown for the first).
const STAND_IN_SPEED: f64 = 4.0;

/// A decoded picture, shared by the cache and the frames drawn from it.
pub(crate) type Pixels = Arc<Vec<u8>>;

struct Entry {
    pixels: Pixels,
    /// The timeline frame it was decoded for (`Cache::insert` lets go by it).
    frame: i64,
    /// The source time it was read at.
    time: f64,
    /// Kept every `stride` frames: mid-drag it stands for the frames that near it.
    stride: i64,
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

    /// The picture of `key` kept nearest `frame`, within `step` frames of it
    /// (or the stride it was kept at, when that's more), and of the same
    /// stretch of footage as `time` (`STAND_IN_SPEED`). A stretch's top frame
    /// is the last its reader gives, so a drag short of decoding reaches it
    /// first: the one a step below is there by then.
    fn near(&self, key: &DecodeKey, time: f64, frame: i64, step: i64, fps: f64) -> Option<Pixels> {
        self.entries
            .iter()
            .filter(|((kept, _), _)| kept == key)
            .filter_map(|(_, entry)| {
                let apart = (entry.frame - frame).abs();
                let off = (entry.time - time).abs();
                let close = off <= (apart as f64 + 1.0) / fps * STAND_IN_SPEED;
                (apart <= step.max(entry.stride) && close).then_some((apart, off, entry))
            })
            .min_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)))
            .map(|(_, _, entry)| Arc::clone(&entry.pixels))
    }

    /// Keeps `pixels`, letting go first of the pictures above the playhead (the
    /// farthest first: they're passed, and a reader reads on forward anyway),
    /// then of those farthest below it. False when there's nothing to let go
    /// that's worth less than it, or the cache was cleared since `generation`.
    fn insert(&mut self, generation: u64, key: DecodeKey, kept: Kept, pixels: Pixels) -> bool {
        if generation != self.generation || pixels.len() > self.budget {
            return false;
        }
        let at = self.at;
        let worth = |frame: i64| (frame > at, (frame - at).abs());
        let this = worth(kept.frame);
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
        let entry = Entry {
            pixels,
            frame: kept.frame,
            time: kept.time,
            stride: kept.stride,
        };
        if let Some(old) = self.entries.insert((key, kept.time.to_bits()), entry) {
            self.bytes -= old.pixels.len();
        }
        true
    }

    fn clear(&mut self) {
        self.entries = HashMap::new();
        self.bytes = 0;
        self.generation += 1;
    }
}

/// Where a picture to keep is from: its source time, the timeline frame it's for, and the stride it's kept at.
#[derive(Clone, Copy, Debug)]
struct Kept {
    time: f64,
    frame: i64,
    stride: i64,
}

/// One stretch to decode: for each file, the pictures to keep ascending by source time.
struct Fill {
    generation: u64,
    run: u64,
    files: Vec<(Source, Vec<Kept>)>,
}

/// The steps back of one drag, and what's been asked for them.
#[derive(Clone, Copy, Debug)]
struct Run {
    /// The frames asked for, `[low, top]`.
    low: i64,
    top: i64,
    /// The cache's generation then (gone idle since, what was asked is gone too).
    generation: u64,
    /// The pictures of the stretch asked last are kept every this many frames: the drag's step then.
    stride: i64,
}

/// What `lookup` found for a frame's layers: a picture for each (None where
/// there's none), and whether any is a neighbour's standing in for it.
pub(crate) struct Found {
    pub(crate) pictures: Vec<Option<Pixels>>,
    pub(crate) stood_in: bool,
}

pub(crate) struct Behind {
    cache: Arc<Mutex<Cache>>,
    fills: mpsc::Sender<Fill>,
    /// The run of steps back now: a fill of an older one stops.
    run: Arc<AtomicU64>,
    /// This drag's steps back, while there's one.
    asked: Option<Run>,
    /// The frame drawn last at rest.
    last: Option<i64>,
    /// The edit's frame rate, as `moved` last had it.
    fps: f64,
    /// Readers the fill threads hold (they all go after `IDLE`).
    #[cfg(test)]
    readers: Arc<AtomicUsize>,
}

impl Behind {
    pub(crate) fn new(budget: usize) -> Self {
        Self::with_idle(budget, IDLE)
    }

    fn with_idle(budget: usize, idle: Duration) -> Self {
        let cache = Arc::new(Mutex::new(Cache::new(budget)));
        let run = Arc::new(AtomicU64::new(0));
        let readers = Arc::new(AtomicUsize::new(0));
        let (fills, requests) = mpsc::channel::<Fill>();
        let requests = Arc::new(Mutex::new(requests));
        for _ in 0..FILLERS {
            let (held, current, requests, readers) = (
                Arc::clone(&cache),
                Arc::clone(&run),
                Arc::clone(&requests),
                Arc::clone(&readers),
            );
            let _ = std::thread::Builder::new()
                .name("edit preview behind".to_owned())
                .spawn(move || fill(&held, &current, &requests, &readers, idle));
        }
        Self {
            cache,
            fills,
            run,
            asked: None,
            last: None,
            fps: 30.0,
            #[cfg(test)]
            readers,
        }
    }

    /// The pictures kept for `requests` at `frame`. Mid-drag (stepping back
    /// from the frame drawn last at rest, and not `exact`), a request with no
    /// picture of its own takes the nearest kept within the step (`Cache::near`).
    pub(crate) fn lookup(&self, frame: i64, requests: &[(Source, f64)], exact: bool) -> Found {
        let step = self
            .last
            .map(|last| last - frame)
            .filter(|step| !exact && *step > 0 && (*step as f64) <= STEP_SECONDS * self.fps);
        let mut cache = self.cache.lock();
        cache.at = frame;
        let mut stood_in = false;
        let pictures = requests
            .iter()
            .map(|(source, time)| {
                cache.get(&source.key, *time).or_else(|| {
                    let near = cache.near(&source.key, *time, frame, step?, self.fps);
                    stood_in |= near.is_some();
                    near
                })
            })
            .collect();
        Found { pictures, stood_in }
    }

    /// The playhead is at `frame` at rest. Stepping back (by less than
    /// `STEP_SECONDS`: a click farther back is a jump, not a drag), the
    /// stretches below it are asked for, each of `stretch` frames (from the
    /// bytes a frame's pictures take, and at most a second) with a picture kept
    /// every step's frames, reaching `AHEAD` stretches and `LEAD_STEPS` steps
    /// below the playhead; `layers` says what each frame reads. A step forward
    /// asks for nothing; a step back outside what this run asked, or much
    /// slower than its stride (its pictures too sparse now), starts another.
    pub(crate) fn moved(
        &mut self,
        frame: i64,
        fps: f64,
        mut layers: impl FnMut(i64) -> Vec<(Source, f64)>,
    ) {
        self.fps = fps;
        let Some(last) = self.last.replace(frame) else {
            return;
        };
        let step = last - frame;
        if step <= 0 || step as f64 > STEP_SECONDS * fps {
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
        let second = fps.round().max(2.0) as i64;
        // Never sparser than a third of a second: a drag that fast shows a picture a step all the same.
        let stride = step.min(second / 3).max(1);
        // Two thirds of the pictures kept are the stretches asked below the
        // playhead; the rest the ones passed, for a drag that turns.
        let pictures = (budget / 3 / bytes) as i64;
        let stretch = (pictures * stride).clamp(2, second);
        let lead = (AHEAD * stretch).max((LEAD_STEPS * step).min(2 * pictures * stride));
        let (mut low, top) = match self.asked {
            Some(run)
                if run.low <= frame
                    && frame <= run.top
                    && run.generation == generation
                    && stride * 2 > run.stride =>
            {
                (run.low, run.top)
            }
            _ => {
                // Whatever an earlier run still has to decode isn't wanted now.
                self.run.fetch_add(1, Ordering::AcqRel);
                (frame, frame)
            }
        };
        while low > 0 && frame - low < lead {
            let from = (low - stretch).max(0);
            self.ask(from..low, frame, stride, &mut layers);
            low = from;
        }
        self.asked = Some(Run {
            low,
            top,
            generation,
            stride,
        });
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

    /// Asks for the pictures of `frames` every `stride` frames, counted from the playhead at `at`
    /// (so a drag that keeps its pace lands on them).
    fn ask(
        &self,
        frames: std::ops::Range<i64>,
        at: i64,
        stride: i64,
        layers: &mut impl FnMut(i64) -> Vec<(Source, f64)>,
    ) {
        let mut files: Vec<(Source, Vec<Kept>)> = Vec::new();
        for frame in frames.filter(|frame| (at - frame) % stride == 0) {
            for (source, time) in layers(frame) {
                let kept = Kept {
                    time,
                    frame,
                    stride,
                };
                match files.iter_mut().find(|(file, _)| file.key == source.key) {
                    Some((_, times)) => times.push(kept),
                    None => files.push((source, vec![kept])),
                }
            }
        }
        for (_, times) in &mut files {
            // Forward, so one seek starts each file's stretch.
            times.sort_by(|a, b| a.time.total_cmp(&b.time));
            times.dedup_by(|a, b| a.time.to_bits() == b.time.to_bits());
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

/// A fill thread: each stretch asked, decoded forward with its own readers
/// into the cache, unless a newer run or a `clear` came since. With nothing
/// asked for `idle`, its readers go, and the pictures with them.
fn fill(
    cache: &Mutex<Cache>,
    run: &AtomicU64,
    requests: &Mutex<mpsc::Receiver<Fill>>,
    held: &AtomicUsize,
    idle: Duration,
) {
    // Behind the frame being drawn: utility work, never ahead of the player's thread.
    crate::util::utility_thread();
    crate::render::decode_stats::AHEAD_THREAD.with(|ahead| ahead.set(true));
    let mut readers: Vec<VideoReader> = Vec::new();
    let mut generation = 0;
    let mut holding = 0;
    let mut hold = |readers: &Vec<VideoReader>| {
        held.fetch_add(readers.len(), Ordering::AcqRel);
        held.fetch_sub(holding, Ordering::AcqRel);
        holding = readers.len();
    };
    loop {
        // One receiver shared: whichever thread is free takes the next stretch. The one waiting
        // for the receiver waits no longer than `idle` either: the readers of a thread that never
        // got it back stayed open for good (~70 MB of a window's footprint after a drag, Nov 16).
        let next = match requests.try_lock_for(idle) {
            Some(receiver) => receiver.recv_timeout(idle),
            None => Err(mpsc::RecvTimeoutError::Timeout),
        };
        let job = match next {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                readers.clear();
                hold(&readers);
                let mut kept = cache.lock();
                if kept.bytes > 0 {
                    kept.clear();
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
            hold(&readers);
            generation = job.generation;
        }
        'files: for (source, times) in job.files {
            let wanted: Vec<Kept> = {
                let kept = cache.lock();
                times
                    .into_iter()
                    .filter(|want| !kept.contains(&source.key, want.time))
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
            for want in wanted {
                if stale() {
                    readers.push(reader);
                    break 'files;
                }
                let mut pixels = vec![0_u8; source.bytes()];
                // Reading on to it decodes the frames between (a reader only goes forward); only this one is kept.
                if reader.frame_into(want.time, &mut pixels, false).is_err() {
                    // Left for the drawing path, which reads it and says why.
                    continue 'files;
                }
                if !cache
                    .lock()
                    .insert(job.generation, source.key.clone(), want, Arc::new(pixels))
                {
                    break;
                }
            }
            readers.push(reader);
        }
        while readers.len() > READERS {
            readers.remove(0);
        }
        hold(&readers);
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

    /// A picture of frame `frame` at 30 fps, kept frame by frame.
    fn kept(frame: i64) -> Kept {
        Kept {
            time: frame as f64 / 30.0,
            frame,
            stride: 1,
        }
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
            let kept = behind
                .lookup(frame, &layers(frame), true)
                .pictures
                .remove(0);
            let mut read = vec![0_u8; file.bytes()];
            reader
                .frame_into(frame as f64 / 30.0, &mut read, false)
                .unwrap();
            assert!(kept.as_deref() == Some(&read), "frame {frame}");
        }
        assert!(behind.lookup(61, &layers(61), false).pictures[0].is_none());
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
        assert!(behind.lookup(20, &layers(20), false).pictures[0].is_none());
        // A fill asked before the clear keeps nothing.
        let mut stale = Cache::new(BUDGET);
        let generation = stale.generation;
        stale.clear();
        assert!(!stale.insert(generation, file.key.clone(), kept(0), Arc::new(vec![0; 16])));
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
            cache.insert(0, key.clone(), kept(frame), Arc::new(vec![0; 1024]));
            assert!(cache.bytes <= 10 * 1024);
        }
        // The ten nearest the playhead stayed.
        assert_eq!(cache.entries.len(), 10);
        assert!((90..100).all(|frame| cache.contains(&key, frame as f64 / 30.0)));
        // One farther than all of them isn't kept.
        assert!(!cache.insert(0, key.clone(), kept(0), Arc::new(vec![0; 1024])));
        // Moved back, the ones passed above go for the ones below, however near.
        cache.at = 95;
        for frame in [89, 88] {
            assert!(cache.insert(0, key.clone(), kept(frame), Arc::new(vec![0; 1024])));
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
            behind.lookup(frame, &layers(frame), false);
            assert!(behind.bytes() <= frame_bytes * 12);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A drag of 5 frames a step keeps every 5th picture, counted from the playhead, so the budget
    /// covers five times the timeline; a frame between them shows the nearest kept within the step,
    /// never another layer's, and an exact ask (at rest) takes only its own.
    #[test]
    fn fast_steps_keep_every_kth_picture() {
        let dir = temp_dir("fast");
        let path = video(&dir, 320, 180, 10, 30);
        let file = source(&path, 320, 180);
        let mut behind = Behind::new(BUDGET);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        behind.moved(290, 30.0, layers);
        behind.moved(285, 30.0, layers);
        let run = behind.asked.unwrap();
        assert_eq!((run.stride, run.low), (5, 225), "two stretches of a second");
        let every_fifth = (225..285).filter(|frame| (285 - frame) % 5 == 0);
        wait_for(&behind, &file, every_fifth.clone());
        assert_eq!(behind.cache.lock().entries.len(), every_fifth.count());
        assert_eq!(behind.bytes(), 12 * file.bytes());
        assert!(!behind.cache.lock().contains(&file.key, 284.0 / 30.0));
        // Mid-drag, 283 shows 280's picture (3 frames off, within the stride it was kept at).
        let found = behind.lookup(283, &layers(283), false);
        let kept_280 = behind.cache.lock().get(&file.key, 280.0 / 30.0);
        assert!(found.stood_in);
        assert!(found.pictures[0].as_deref() == kept_280.as_deref());
        // A second layer of the same file elsewhere in it gets none of them.
        let two = [layers(283).remove(0), (file.clone(), 2.0)];
        let found = behind.lookup(283, &two, false);
        assert!(found.pictures[0].is_some() && found.pictures[1].is_none());
        // At rest, the exact frame or nothing.
        let found = behind.lookup(283, &layers(283), true);
        assert!(found.pictures[0].is_none() && !found.stood_in);
        assert!(!behind.lookup(280, &layers(280), true).stood_in);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The lead is in steps: ten steps of 10 frames ask for a hundred frames or more below the
    /// playhead, where a frame-by-frame drag asks for its two stretches.
    #[test]
    fn the_lead_follows_the_step() {
        let file = source(Path::new("/nowhere.mp4"), 320, 180);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        let mut behind = Behind::new(BUDGET);
        behind.moved(290, 30.0, layers);
        behind.moved(280, 30.0, layers);
        // Stretches of a second until a hundred frames are asked.
        assert_eq!(
            behind.asked.map(|run| (run.stride, run.low)),
            Some((10, 160))
        );
        let mut behind = Behind::new(BUDGET);
        behind.moved(290, 30.0, layers);
        behind.moved(289, 30.0, layers);
        assert_eq!(
            behind.asked.map(|run| (run.stride, run.low)),
            Some((1, 229))
        );
    }

    /// A drag that slows to a frame a step through pictures kept every 5th starts a run of its own,
    /// filling the frames between.
    #[test]
    fn a_drag_that_slows_fills_densely() {
        let dir = temp_dir("slows");
        let path = video(&dir, 320, 180, 10, 30);
        let file = source(&path, 320, 180);
        let mut behind = Behind::new(BUDGET);
        let layers = |frame: i64| vec![(file.clone(), frame as f64 / 30.0)];
        behind.moved(290, 30.0, layers);
        behind.moved(285, 30.0, layers);
        wait_for(
            &behind,
            &file,
            (255..285).filter(|frame| (285 - frame) % 5 == 0),
        );
        let run = behind.run.load(Ordering::Acquire);
        behind.moved(284, 30.0, layers);
        assert!(behind.run.load(Ordering::Acquire) > run);
        assert_eq!(
            behind.asked.map(|run| (run.stride, run.low)),
            Some((1, 224))
        );
        wait_for(&behind, &file, 224..284);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// With nothing asked for a while, every fill thread lets its readers go, not only the one that
    /// was waiting on the stretches, and the pictures go too.
    #[test]
    fn idle_fills_let_their_readers_go() {
        let dir = temp_dir("idle");
        let (one, two) = (video(&dir, 320, 180, 3, 30), video(&dir, 160, 90, 3, 30));
        let (one, two) = (source(&one, 320, 180), source(&two, 160, 90));
        let idle = Duration::from_millis(300);
        let mut behind = Behind::with_idle(BUDGET, idle);
        // Two layers, two files: both threads take stretches.
        let layers = |frame: i64| {
            vec![
                (one.clone(), frame as f64 / 30.0),
                (two.clone(), frame as f64 / 30.0),
            ]
        };
        behind.moved(80, 30.0, layers);
        behind.moved(79, 30.0, layers);
        wait_for(&behind, &one, 19..79);
        wait_for(&behind, &two, 19..79);
        let started = Instant::now();
        while behind.readers.load(Ordering::Acquire) > 0 || behind.bytes() > 0 {
            assert!(
                started.elapsed() < idle * 4,
                "readers or pictures held after going idle"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Times each step of a drag back through 1080p30 H.264, a keyframe every 2 s (an export's) and
    /// every half second (a preview's), frame by frame, three and five frames a step, a step every 25 ms (a
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
            let report = |name: &str, (mut times, kept, stood): (Vec<f64>, usize, usize)| {
                times.sort_by(f64::total_cmp);
                let mean = times.iter().sum::<f64>() / times.len() as f64;
                let at = |q: f64| times[((times.len() - 1) as f64 * q) as usize];
                println!(
                    "g{gop} {name}: {} steps, mean {mean:.1} ms, median {:.1}, p90 {:.1}, max {:.1}, over 20 ms {}, kept {kept} ({stood} standing in)",
                    times.len(),
                    at(0.5),
                    at(0.9),
                    at(1.0),
                    times.iter().filter(|ms| **ms > 20.0).count()
                );
            };
            let drag = |frames: &[i64], fill: bool| -> (Vec<f64>, usize, usize) {
                let mut reader = VideoReader::open(file.clone());
                let mut behind = Behind::new(BUDGET);
                let mut out = vec![0_u8; file.bytes()];
                // Standing on the first, as a drag starts.
                reader
                    .frame_into(frames[0] as f64 / 30.0, &mut out, false)
                    .unwrap();
                behind.moved(frames[0], 30.0, layers);
                let mut times = Vec::new();
                let (mut kept_steps, mut stood) = (0, 0);
                let started = Instant::now();
                for (step, frame) in frames.iter().enumerate().skip(1) {
                    let due = started + Duration::from_millis(25 * step as u64);
                    if let Some(wait) = due.checked_duration_since(Instant::now()) {
                        std::thread::sleep(wait);
                    }
                    let begun = Instant::now();
                    let kept = fill
                        .then(|| {
                            let mut found = behind.lookup(*frame, &layers(*frame), false);
                            stood += usize::from(found.stood_in);
                            found.pictures.remove(0)
                        })
                        .flatten();
                    kept_steps += usize::from(kept.is_some());
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
                (times, kept_steps, stood)
            };
            let back_one: Vec<i64> = (150..=290).rev().collect();
            let back_three: Vec<i64> = (0..=290).rev().step_by(3).collect();
            let back_five: Vec<i64> = (0..=290).rev().step_by(5).collect();
            let forward_one: Vec<i64> = (150..=290).collect();
            report("back 1 a step, reader alone", drag(&back_one, false));
            report("back 1 a step, with the fill", drag(&back_one, true));
            report("back 3 a step, reader alone", drag(&back_three, false));
            report("back 3 a step, with the fill", drag(&back_three, true));
            report("back 5 a step, reader alone", drag(&back_five, false));
            report("back 5 a step, with the fill", drag(&back_five, true));
            report("forward 1 a step, reader alone", drag(&forward_one, false));
            report("forward 1 a step, with the fill", drag(&forward_one, true));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
