//! Native rendering: single frames (for agents and the UI) and full exports.
//! Both run the same `edit-render` compositor the browser preview runs as WASM.
//!
//! An export is a pipeline: a planner evaluates frames a little ahead and hands
//! each clip's run of frames to one of a few decoder threads (so the next
//! clip's file is opened and sought while this one plays), the compositor
//! uploads, renders and queues each frame's readback without waiting for it,
//! and an encoder thread reads frames back and hands them to the encoder. The
//! sound is mixed first (`crate::mix`; seconds, and slower beside the video's
//! decoders), and the two are put together at the end without re-encoding.

use parking_lot::{Condvar, Mutex};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use edit_core::{audio_segments, evaluate_seen, AudioSegment, Layer, Media, Project, Scene};
use edit_render::{frame::Framing, text::BUNDLED_FONTS, wgpu, wgpu::WriteOnly, Renderer};

use crate::export::{ExportOptions, Format, Plan};
#[cfg(target_os = "macos")]
use crate::mac_media::{Writer as ChunkWriter, WriterOptions};
#[cfg(not(target_os = "macos"))]
use crate::pipe_writer::{Writer as ChunkWriter, WriterOptions};

/// The GPU device renderers draw with. On a Mac each renderer has its own;
/// on Linux they share one, made once: NVIDIA's driver (615) deadlocked when
/// one renderer's device was destroyed while another's submitted work (Nov 7,
/// the renderer's tests side by side; exports, previews and frames for the
/// agent do the same in the server).
fn gpu() -> Result<(wgpu::Device, wgpu::Queue), String> {
    #[cfg(not(target_os = "macos"))]
    {
        static SHARED: parking_lot::Mutex<Option<(wgpu::Device, wgpu::Queue)>> =
            parking_lot::Mutex::new(None);
        let mut shared = SHARED.lock();
        if let Some((device, queue)) = shared.as_ref() {
            return Ok((device.clone(), queue.clone()));
        }
        let made = new_gpu()?;
        *shared = Some(made.clone());
        Ok(made)
    }
    #[cfg(target_os = "macos")]
    new_gpu()
}

fn new_gpu() -> Result<(wgpu::Device, wgpu::Queue), String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    // Vulkan or Metal only: OpenGL (EGL) opened beside Vulkan deadlocked
    // NVIDIA's driver when renderers came and went side by side (Linux, Nov 7).
    descriptor.backends = wgpu::Backends::PRIMARY;
    // No debug labels on GPU objects (a debug build's default): with renderers
    // made side by side, Vulkan's loader crashed naming one
    // (vkSetDebugUtilsObjectNameEXT, NVIDIA 615 on Linux, Nov 7: `just dev`'s
    // debug addon and `just check`'s tests, never a release build).
    descriptor.flags.remove(wgpu::InstanceFlags::DEBUG);
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|error| format!("no GPU available: {error}"))?;
    if std::env::var("EDIT_REQUIRE_GPU").as_deref() == Ok("1")
        && adapter.get_info().device_type == wgpu::DeviceType::Cpu
    {
        return Err("the cloud worker has no hardware graphics adapter".to_owned());
    }
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("edit native"),
        ..Default::default()
    }))
    .map_err(|error| format!("GPU device: {error}"))
}

pub fn new_renderer(width: u32, height: u32) -> Result<Renderer, String> {
    let (device, queue) = gpu()?;
    let mut renderer = Renderer::new(device, queue, width, height);
    for (family, weight, file) in BUNDLED_FONTS {
        if let Some(bytes) = edit_render::text::bundled_font_bytes(file) {
            renderer.fonts_mut().add(family, *weight, bytes)?;
        }
    }
    Ok(renderer)
}

/// Decoded size for a source drawn into a `width`×`height` frame: contain-fit, even.
/// A stacked file (`Media::stacked_alpha`) is decoded whole, its picture fitted.
fn decode_size(media: &Media, width: u32, height: u32) -> (u32, u32) {
    let (mw, mh) = (media.width.max(2) as f32, media.height.max(2) as f32);
    let fit = (width as f32 / mw).min(height as f32 / mh).min(1.0);
    let even = |value: f32| ((value.round() as u32) / 2 * 2).max(2);
    let file_height = if media.stacked_alpha { mh * 2.0 } else { mh };
    (even(mw * fit), even(file_height * fit))
}

/// A stacked frame (picture over its alpha, `Media::stacked_alpha`) as one
/// straight-alpha picture of its top half's size, as an image with
/// see-through parts is everywhere else.
pub fn unstack(width: u32, height: u32, pixels: &[u8]) -> RgbaImage {
    let half = (height / 2) as usize;
    let row = width as usize * 4;
    let (picture, matte) = pixels.split_at((half * row).min(pixels.len()));
    let mut out = Vec::with_capacity(half * row);
    for ([r, g, b, _], [_, alpha, _, _]) in picture
        .as_chunks::<4>()
        .0
        .iter()
        .zip(matte.as_chunks::<4>().0)
    {
        let alpha = *alpha;
        let straight = |value: u8| {
            if alpha == 0 {
                0
            } else {
                (u32::from(value.min(alpha)) * 255 / u32::from(alpha)) as u8
            }
        };
        out.extend_from_slice(&[straight(*r), straight(*g), straight(*b), alpha]);
    }
    RgbaImage {
        width,
        height: half as u32,
        pixels: out,
    }
}

/// Pixel order of decoded and rendered frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Order {
    Rgba,
    /// The video decoder's and encoder's own order: no conversion on the CPU
    /// (the renderer samples a BGRA texture the same as an RGBA one).
    Bgra,
    /// BT.709 TV-range 4:2:0 planes, as the source holds them: an export's
    /// decoder off a Mac, for footage already in it (`yuv420_source`), turned
    /// into RGBA on the GPU (`Renderer::upload_video_yuv420`).
    Yuv420,
}

/// Whether an export's decoder can hand over `path`'s frames as the 4:2:0
/// they are (`Order::Yuv420`): off a Mac, video that is 8-bit 4:2:0 BT.709 TV
/// range already, so FFmpeg converts nothing and the GPU's RGBA is what its
/// own was. Anything else (BT.601 or untagged, full range, 10-bit or HDR)
/// stays FFmpeg's to convert, as before: brought to BT.709 first it came out
/// 34-50 dB from that. A cloud original is probed by its first excerpt (a
/// stream copy of it); one with none isn't probed. Once per file.
fn yuv420_source(path: &Path) -> bool {
    if cfg!(target_os = "macos") {
        return false;
    }
    static PROBED: std::sync::OnceLock<Mutex<HashMap<PathBuf, bool>>> = std::sync::OnceLock::new();
    let probed = PROBED.get_or_init(Default::default);
    if let Some(known) = probed.lock().get(path) {
        return *known;
    }
    let file = if crate::util::is_url(path) {
        crate::excerpts::of(path)
            .and_then(|excerpts| excerpts.first().map(|excerpt| excerpt.path.clone()))
            .filter(|file| file.is_file())
    } else {
        Some(path.to_path_buf())
    };
    let fits = file.is_some_and(|file| {
        crate::util::ffprobe_command()
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
            .args([
                "stream=pix_fmt,color_space,color_range",
                "-of",
                "default=nw=1",
            ])
            .arg(&file)
            .output()
            .is_ok_and(|output| {
                let said = String::from_utf8_lossy(&output.stdout);
                let field = |name: &str| {
                    said.lines()
                        .find_map(|line| line.strip_prefix(&format!("{name}=")))
                        .unwrap_or("")
                        .trim()
                        .to_owned()
                };
                output.status.success()
                    && field("pix_fmt") == "yuv420p"
                    && field("color_space") == "bt709"
                    && matches!(field("color_range").as_str(), "tv" | "unknown")
            })
    });
    probed.lock().insert(path.to_path_buf(), fits);
    fits
}

/// How an export's decoder hands over `media` decoded at `size`: as the
/// 4:2:0 it is when that's BT.709 (`yuv420_source`) and it's decoded at its
/// own size. Scaled down in 4:2:0 its colour would keep half the frame's
/// resolution, not the source's: sharp coloured edges 10% of a frame off
/// FFmpeg's RGBA, by as much as 197 (Nov 8, 720p into 360p).
fn decode_order(media: &Media, path: &Path, size: (u32, u32)) -> Order {
    if media.kind == edit_core::MediaKind::Video
        && size == (media.width, media.height)
        && yuv420_source(path)
    {
        Order::Yuv420
    } else {
        Order::Bgra
    }
}

/// A decoded picture into the renderer, by its order.
fn upload(
    renderer: &mut Renderer,
    clip: &str,
    width: u32,
    height: u32,
    pixels: &[u8],
    order: Order,
) {
    match order {
        Order::Yuv420 => renderer.upload_video_yuv420(clip, width, height, pixels),
        Order::Rgba | Order::Bgra => {
            renderer.upload_video(clip, width, height, pixels, order == Order::Bgra)
        }
    }
}

/// What a reader decodes: a file at a size, in an order, as a still or as
/// moving pictures. The kind is part of it: an effect's render lands as an
/// .mp4 at the path its clear still was read from a moment before, and the
/// reader that read it as a picture (ImageIO, failing) was taken again for the
/// video, failing every frame until the window gave up (Nov 16).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct DecodeKey {
    path: PathBuf,
    width: u32,
    height: u32,
    order: Order,
    still: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub(crate) key: DecodeKey,
    fps: f64,
}

impl Source {
    fn new(media: &Media, path: PathBuf, (width, height): (u32, u32), order: Order) -> Self {
        Self {
            key: DecodeKey {
                path,
                width,
                height,
                order,
                still: media.kind == edit_core::MediaKind::Image,
            },
            fps: if media.fps > 0.0 { media.fps } else { 30.0 },
        }
    }

    /// A video file read as moving pictures at `(width, height)`.
    #[cfg(test)]
    pub(crate) fn video(path: &Path, (width, height): (u32, u32), order: Order, fps: f64) -> Self {
        Self {
            key: DecodeKey {
                path: path.to_path_buf(),
                width,
                height,
                order,
                still: false,
            },
            fps,
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        let pixels = self.key.width as usize * self.key.height as usize;
        if self.key.order == Order::Yuv420 {
            pixels * 3 / 2
        } else {
            pixels * 4
        }
    }
}

/// Where a preview frame's decoding went (the native player reads and resets
/// them per frame, `crate::player`): decoders opened, seeks, frames read on
/// from just behind, FFmpeg reads, each with its time. One process draws one
/// preview, so plain counters across its decoder threads are enough.
pub mod decode_stats {
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(crate) static OPENS: AtomicU64 = AtomicU64::new(0);
    pub(crate) static OPEN_NS: AtomicU64 = AtomicU64::new(0);
    pub(crate) static SEEKS: AtomicU64 = AtomicU64::new(0);
    pub(crate) static SEEK_NS: AtomicU64 = AtomicU64::new(0);
    pub(crate) static FORWARD: AtomicU64 = AtomicU64::new(0);
    pub(crate) static FORWARD_NS: AtomicU64 = AtomicU64::new(0);
    pub(crate) static FFMPEG: AtomicU64 = AtomicU64::new(0);
    pub(crate) static FFMPEG_NS: AtomicU64 = AtomicU64::new(0);
    /// Decoders opened and seeked ahead of the playhead (`PreviewPictures::warm`), on their own threads.
    pub(crate) static AHEAD: AtomicU64 = AtomicU64::new(0);
    pub(crate) static AHEAD_NS: AtomicU64 = AtomicU64::new(0);
    /// Pictures read from those decoded behind the playhead (`crate::behind`) instead of a reader.
    pub(crate) static KEPT: AtomicU64 = AtomicU64::new(0);

    std::thread_local! {
        /// Set on a decode-ahead thread: its opens and seeks count as `AHEAD`, not as a frame's.
        pub(crate) static AHEAD_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    pub(crate) fn add(count: &AtomicU64, time: &AtomicU64, since: std::time::Instant) {
        if AHEAD_THREAD.with(std::cell::Cell::get) {
            AHEAD.fetch_add(1, Ordering::Relaxed);
            AHEAD_NS.fetch_add(since.elapsed().as_nanos() as u64, Ordering::Relaxed);
            return;
        }
        count.fetch_add(1, Ordering::Relaxed);
        time.fetch_add(since.elapsed().as_nanos() as u64, Ordering::Relaxed);
    }

    /// Counts and milliseconds since the last call: opens, seeks, forward reads, FFmpeg reads.
    #[derive(Clone, Copy, Debug, Default, PartialEq)]
    pub struct Taken {
        pub opens: u64,
        pub open_ms: f64,
        pub seeks: u64,
        pub seek_ms: f64,
        pub forward: u64,
        pub forward_ms: f64,
        pub ffmpeg: u64,
        pub ffmpeg_ms: f64,
        /// Opens and seeks done ahead of the playhead since the last call, and their time.
        pub ahead: u64,
        pub ahead_ms: f64,
        /// Pictures read from those decoded behind the playhead.
        pub kept: u64,
    }

    pub fn take() -> Taken {
        let ms = |time: &AtomicU64| time.swap(0, Ordering::Relaxed) as f64 / 1e6;
        Taken {
            ahead: AHEAD.swap(0, Ordering::Relaxed),
            ahead_ms: ms(&AHEAD_NS),
            opens: OPENS.swap(0, Ordering::Relaxed),
            open_ms: ms(&OPEN_NS),
            seeks: SEEKS.swap(0, Ordering::Relaxed),
            seek_ms: ms(&SEEK_NS),
            forward: FORWARD.swap(0, Ordering::Relaxed),
            forward_ms: ms(&FORWARD_NS),
            ffmpeg: FFMPEG.swap(0, Ordering::Relaxed),
            ffmpeg_ms: ms(&FFMPEG_NS),
            kept: KEPT.swap(0, Ordering::Relaxed),
        }
    }
}

/// Sequential reader for one source that restarts on jumps: AVFoundation on
/// the Mac, FFmpeg for what it can't read (and elsewhere), ImageIO for stills.
pub(crate) struct VideoReader {
    pub(crate) source: Source,
    pub(crate) width: u32,
    pub(crate) height: u32,
    child: Option<(crate::util::Watched, ChildStdout)>,
    #[cfg(target_os = "macos")]
    native: Option<crate::mac_media::Reader>,
    #[cfg(target_os = "macos")]
    native_failed: bool,
    start: f64,
    next_index: i64,
    frame: Vec<u8>,
    has_frame: bool,
    eof: bool,
    spare: Vec<u8>,
    /// Source seconds last asked for: which pooled reader continues best.
    position: Option<f64>,
    /// The frame asked for now continues from the last one (for `decode_stats`).
    forward: bool,
    /// Made ready for a cut ahead of the playhead (then, or looked for since) and not read from yet.
    ahead: Option<Instant>,
    /// When it was last put back after a read (`ReaderPool::put`): a reader the play draws from is put back every frame.
    read_at: Option<Instant>,
    /// A still has been copied out since it was decoded.
    copied: bool,
    /// A cloud original's stretches cut to this Mac (`crate::excerpts`), read instead of the URL where they reach.
    excerpts: Option<Arc<Vec<crate::excerpts::Excerpt>>>,
    /// `crate::excerpts::changes` when `excerpts` was last looked up.
    excerpts_seen: u64,
    /// The excerpt being read (its index) and its reader.
    excerpt: Option<(usize, Box<VideoReader>)>,
    /// Excerpts that wouldn't read: the URL for those stretches.
    broken: Vec<usize>,
    /// The next excerpt's reader, opened and standing on its first frame on a thread of its own while this
    /// one plays towards it (`prime_next`): one piece ahead, never more.
    next: Option<(PathBuf, std::thread::JoinHandle<Option<VideoReader>>)>,
    /// A read failed: never put back in a pool, so the next asks a fresh reader (`ReaderPool::put`).
    failed: bool,
}

impl VideoReader {
    /// Small frames for face and text finders (Vision on a Mac, YuNet
    /// elsewhere), using FFmpeg's ranged input for cloud media and
    /// AVFoundation for local files on a Mac, just as timeline rendering does.
    pub(crate) fn analysis(path: &Path, width: u32, height: u32) -> Self {
        Self::analysis_at(path, width, height, 30.0)
    }

    /// As `analysis`, each frame asked for the file's own frame at `fps` (its
    /// rate): a read that must land on the frame where something changes.
    pub(crate) fn analysis_at(path: &Path, width: u32, height: u32, fps: f64) -> Self {
        Self::open(Source {
            key: DecodeKey {
                path: path.to_path_buf(),
                width,
                height,
                order: Order::Bgra,
                still: false,
            },
            fps: if fps.is_finite() && fps > 0.0 {
                fps
            } else {
                30.0
            },
        })
    }

    pub(crate) fn open(source: Source) -> Self {
        #[cfg(test)]
        tests::OPENED.with(|opened| opened.set(opened.get() + 1));
        let (width, height) = (source.key.width, source.key.height);
        #[cfg(target_os = "macos")]
        let url = crate::util::is_url(&source.key.path);
        let excerpts_seen = crate::excerpts::changes();
        let excerpts = crate::excerpts::of(&source.key.path);
        Self {
            source,
            width,
            height,
            child: None,
            #[cfg(target_os = "macos")]
            native: None,
            #[cfg(target_os = "macos")]
            // AVAssetReader only reads local files: a cloud original's URL is FFmpeg's.
            native_failed: std::env::var_os("EDIT_FFMPEG_VIDEO").is_some() || url,
            start: 0.0,
            next_index: 0,
            frame: Vec::new(),
            has_frame: false,
            eof: false,
            spare: Vec::new(),
            position: None,
            forward: false,
            ahead: None,
            read_at: None,
            copied: false,
            excerpts,
            excerpts_seen,
            excerpt: None,
            broken: Vec::new(),
            next: None,
            failed: false,
        }
    }

    /// Takes the excerpts cut since this reader last looked; whether an
    /// excerpt it had open was let go for it (its picture isn't this reader's
    /// last any more). The window's player keeps its readers, and a long
    /// preview's pieces are cut behind it once its project is open: a reader
    /// opened before a piece was cut read the stream for as long as it lived.
    fn look_for_excerpts(&mut self) -> bool {
        let now = crate::excerpts::changes();
        if now == self.excerpts_seen {
            return false;
        }
        self.excerpts_seen = now;
        let fresh = crate::excerpts::of(&self.source.key.path);
        let same = match (&self.excerpts, &fresh) {
            (Some(held), Some(known)) => Arc::ptr_eq(held, known),
            (None, None) => true,
            _ => false,
        };
        if same {
            return false;
        }
        let held = std::mem::replace(&mut self.excerpts, fresh);
        // Both count in the list it held.
        self.broken.clear();
        // The excerpt being read stays open where it's still known (another piece cut puts it at another index):
        // let go, the piece playing was opened and seeked again on the frame after each piece cut elsewhere.
        let Some((at, reader)) = self.excerpt.take() else {
            return false;
        };
        let reading = held.as_ref().and_then(|held| held.get(at));
        let still = self
            .excerpts
            .as_ref()
            .and_then(|known| known.iter().position(|excerpt| Some(excerpt) == reading));
        match still {
            Some(index) => {
                self.excerpt = Some((index, reader));
                false
            }
            None => true,
        }
    }

    /// The reader `prime_next` made ready for the excerpt at `path`, if it was this one; the thread is waited
    /// for (opened seconds ago, it's done by now, and a wait is never longer than opening it here).
    fn primed(&mut self, path: &Path) -> Option<VideoReader> {
        match self.next.take() {
            Some((at, thread)) if at == path => thread.join().ok().flatten(),
            _ => None,
        }
    }

    /// Reading forward in excerpt `index` at `time` (excerpt seconds of the original): the excerpt it goes on
    /// to is opened and seeked to its first frame on another thread once that's `PRIME_SECONDS` away, so
    /// crossing into it reads on (Nov 18, kenobi: a long preview played across 4:00 opened its next piece's
    /// copy on the frame, 133 ms, and three pictures were missed at every minute).
    fn prime_next(&mut self, excerpts: &[crate::excerpts::Excerpt], index: usize, time: f64) {
        let Some(current) = excerpts.get(index) else {
            return;
        };
        // The one read next: the first starting after this one's start and within it (`covering` takes the
        // latest start), as a long preview's pieces follow each other.
        let Some(next) = excerpts
            .iter()
            .enumerate()
            .filter(|(at, excerpt)| {
                *at != index
                    && !self.broken.contains(at)
                    && excerpt.from > current.from + 1e-6
                    && excerpt.from <= current.to + 1e-6
            })
            .map(|(_, excerpt)| excerpt)
            .min_by(|a, b| a.from.total_cmp(&b.from))
        else {
            return;
        };
        if next.from - time > PRIME_SECONDS
            || self.next.as_ref().is_some_and(|(at, _)| *at == next.path)
            || !next.path.is_file()
        {
            return;
        }
        let mut source = self.source.clone();
        source.key.path = next.path.clone();
        let thread = std::thread::Builder::new()
            .name("edit next piece".to_owned())
            .spawn(move || {
                // Behind the frame being drawn, and counted as decoding ahead, not as a frame's.
                crate::util::utility_thread();
                decode_stats::AHEAD_THREAD.with(|ahead| ahead.set(true));
                let mut reader = VideoReader::open(source);
                let mut scratch = vec![0_u8; reader.source.bytes()];
                reader.frame_into(0.0, &mut scratch, false).ok()?;
                Some(reader)
            });
        // One that couldn't start: the excerpt is opened on its frame, as before.
        self.next = thread.ok().map(|thread| (next.path.clone(), thread));
    }

    /// The frame at `time` from a local excerpt that holds it, into `out`;
    /// None when none does (or the one that does won't read: it's left out
    /// after, and the URL read instead).
    fn read_excerpt(
        &mut self,
        time: f64,
        mut out: WriteOnly<'_, [u8]>,
        if_changed: bool,
    ) -> Option<bool> {
        let excerpts = self.excerpts.clone()?;
        let playing = self.forward;
        // The frame nearest `time` is read from the excerpt that holds it, at
        // its own time. A time in a piece's last half-frame is nearest the next
        // piece's first frame, which a piece cut to its own frames doesn't have:
        // its last frame was shown again in its place (Nov 10, a 29.99992 fps
        // preview at 30 fps, a repeat and a frame missed at piece 20's start).
        let time = if self.source.fps > 0.0 {
            self.nearest(time) as f64 / self.source.fps
        } else {
            time
        };
        loop {
            let index = crate::excerpts::covering(&excerpts, time, &self.broken)?;
            let excerpt = excerpts.get(index)?;
            let switched = self.excerpt.as_ref().is_none_or(|(at, _)| *at != index);
            if switched {
                if !excerpt.path.is_file() {
                    self.broken.push(index);
                    continue;
                }
                let reader = self.primed(&excerpt.path).unwrap_or_else(|| {
                    let mut source = self.source.clone();
                    source.key.path = excerpt.path.clone();
                    VideoReader::open(source)
                });
                self.excerpt = Some((index, Box::new(reader)));
            }
            let (_, reader) = self.excerpt.as_mut()?;
            // Another excerpt's reader (a primed one has read its first frame already) says the picture changed.
            match reader.frame_into_mapped(
                (time - excerpt.from).max(0.0),
                out.slice(..),
                if_changed && !switched,
            ) {
                Ok(changed) => {
                    if playing {
                        self.prime_next(&excerpts, index, time);
                    }
                    return Some(changed);
                }
                Err(error) => {
                    crate::log::warn(
                        "render",
                        format!(
                            "excerpt {} won't read ({error}); reading the cloud original there",
                            excerpt.path.display()
                        ),
                    );
                    self.excerpt = None;
                    self.broken.push(index);
                }
            }
        }
    }

    /// The source frame nearest `time` (as the preview's `videoTime` and the
    /// native reader pick it): frame n covers `[(n - 0.5) / fps, (n + 0.5) / fps)`.
    fn nearest(&self, time: f64) -> i64 {
        (time.max(0.0) * self.source.fps + 0.5 + 1e-7).floor() as i64
    }

    /// Restarts FFmpeg at the frame nearest `time`. FFmpeg begins at the first
    /// frame at or after the time it's given, so it's given half a frame
    /// before that frame (seeking to `time` itself landed a frame late when
    /// `time` was in the first half of a frame), and the timestamps are
    /// re-based on it (`setpts`) so `fps=` keeps every frame in its own slot
    /// rather than rounding half-frame times one way or the other.
    fn restart(&mut self, time: f64) -> Result<(), String> {
        self.stop();
        self.spare.resize(self.source.bytes(), 0);
        let first = self.nearest(time);
        let fps = self.source.fps;
        let time = ((first as f64 - 0.5) / fps).max(0.0);
        let mut child = crate::util::ffmpeg_command()
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-threads",
                "2",
                "-filter_threads",
                "1",
                "-ss",
                &format!("{time:.6}"),
                "-protocol_whitelist",
                crate::util::protocols(&self.source.key.path),
            ])
            .args(crate::util::url_args(&self.source.key.path))
            // A cloud original read from R2: decoded on the Mac's media engine.
            .args(
                if cfg!(target_os = "macos") && crate::util::is_url(&self.source.key.path) {
                    &["-hwaccel", "videotoolbox"][..]
                } else {
                    &[]
                },
            )
            .arg("-i")
            .arg(&self.source.key.path)
            .args([
                "-an",
                "-vf",
                &format!(
                    "setpts=PTS-STARTPTS,fps={:.6},scale={}:{}:flags=bicubic",
                    self.source.fps, self.width, self.height
                ),
                "-threads",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                match self.source.key.order {
                    Order::Rgba => "rgba",
                    Order::Bgra => "bgra",
                    Order::Yuv420 => "yuv420p",
                },
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
        self.child = Some((crate::util::Watched::new(child), stdout));
        self.start = first as f64 / fps;
        self.next_index = 0;
        self.eof = false;
        self.has_frame = false;
        Ok(())
    }

    fn decode_still(&mut self) -> Result<(), String> {
        self.frame.resize(self.source.bytes(), 0);
        #[cfg(target_os = "macos")]
        crate::mac_media::image(
            &self.source.key.path,
            self.width,
            self.height,
            &mut self.frame,
        )?;
        #[cfg(not(target_os = "macos"))]
        self.decode_still_ffmpeg()?;
        #[cfg(target_os = "macos")]
        if self.source.key.order == Order::Bgra {
            for pixel in self.frame.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
        self.has_frame = true;
        self.copied = false;
        Ok(())
    }

    /// A still through FFmpeg (elsewhere than a Mac): its one frame, with no
    /// seek and no `fps`. FFmpeg 8 gives nothing at all for a picture asked
    /// from `-ss 0`: every JPEG and PNG on Linux, so the first photo in an
    /// export failed it ("failed to fill whole buffer", Cops Realize, Nov 8).
    #[cfg(not(target_os = "macos"))]
    fn decode_still_ffmpeg(&mut self) -> Result<(), String> {
        self.stop();
        let path = &self.source.key.path;
        let output = crate::util::ffmpeg_command()
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                crate::util::protocols(path),
            ])
            .args(crate::util::url_args(path))
            .arg("-i")
            .arg(path)
            .args([
                "-an",
                "-frames:v",
                "1",
                "-vf",
                &format!("scale={}:{}:flags=bicubic", self.width, self.height),
                "-f",
                "rawvideo",
                "-pix_fmt",
                match self.source.key.order {
                    Order::Rgba => "rgba",
                    Order::Bgra => "bgra",
                    Order::Yuv420 => "yuv420p",
                },
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        if output.stdout.len() != self.frame.len() {
            let why = String::from_utf8_lossy(&output.stderr);
            let why = why.trim();
            return Err(format!(
                "could not decode {}: {}",
                path.display(),
                if why.is_empty() {
                    "FFmpeg gave no picture"
                } else {
                    why
                }
            ));
        }
        self.frame.copy_from_slice(&output.stdout);
        Ok(())
    }

    /// Frame covering `time` (seconds into the source), into the reader's own buffer.
    pub(crate) fn frame_at(&mut self, time: f64) -> Result<&[u8], String> {
        self.forward = self
            .position
            .is_some_and(|position| position <= time + 1e-6 && time - position <= 2.0);
        self.position = Some(time);
        if self.source.key.still {
            if !self.has_frame {
                self.decode_still()?;
            }
            return Ok(&self.frame);
        }
        self.look_for_excerpts();
        if self.excerpts.is_some() {
            let mut frame = std::mem::take(&mut self.frame);
            frame.resize(self.source.bytes(), 0);
            let read = self.read_excerpt(time, WriteOnly::from_mut(&mut frame[..]), false);
            self.frame = frame;
            if read.is_some() {
                return Ok(&self.frame);
            }
        }
        #[cfg(target_os = "macos")]
        if !self.native_failed {
            let mut frame = std::mem::take(&mut self.frame);
            frame.resize(self.source.bytes(), 0);
            let decoded = self.native_frame(time, WriteOnly::from_mut(&mut frame[..]), false);
            self.frame = frame;
            if decoded.is_ok() {
                return Ok(&self.frame);
            }
        }
        self.read_ffmpeg(time)?;
        Ok(&self.frame)
    }

    /// The frame covering `time` into `out` (sized for this reader). With
    /// `if_changed`, Ok(false) leaves `out` alone when the picture is the one
    /// last copied out (a slowed clip shows each frame several times).
    pub(crate) fn frame_into(
        &mut self,
        time: f64,
        out: &mut [u8],
        if_changed: bool,
    ) -> Result<bool, String> {
        self.frame_into_mapped(time, WriteOnly::from_mut(out), if_changed)
    }

    /// `frame_into` memory that's only ever written (a mapped GPU buffer's:
    /// reading it back is wgpu's to forbid, and slow where it's write-combined).
    pub(crate) fn frame_into_mapped(
        &mut self,
        time: f64,
        out: WriteOnly<'_, [u8]>,
        if_changed: bool,
    ) -> Result<bool, String> {
        let read = self.read_into(time, out, if_changed);
        if read.is_err() {
            self.failed = true;
        }
        read
    }

    fn read_into(
        &mut self,
        time: f64,
        mut out: WriteOnly<'_, [u8]>,
        if_changed: bool,
    ) -> Result<bool, String> {
        // Read on from just behind (as the pool picks one), else a seek.
        self.forward = self
            .position
            .is_some_and(|position| position <= time + 1e-6 && time - position <= 2.0);
        self.position = Some(time);
        if self.source.key.still {
            if !self.has_frame {
                self.decode_still()?;
            }
            if if_changed && self.copied {
                return Ok(false);
            }
            out.copy_from_slice(self.frame.get(..out.len()).ok_or("still size changed")?);
            self.copied = true;
            return Ok(true);
        }
        let dropped = self.look_for_excerpts();
        if self.excerpts.is_some() {
            if let Some(changed) = self.read_excerpt(time, out.slice(..), if_changed) {
                return Ok(changed);
            }
            // Off the excerpts: what `out` holds is the excerpt's, not this reader's last picture.
            if self.excerpt.take().is_some() || dropped {
                return self.frame_into_url(time, out, false);
            }
        }
        self.frame_into_url(time, out, if_changed && !dropped)
    }

    /// `frame_into` from the reader's own file (the URL of a cloud original).
    fn frame_into_url(
        &mut self,
        time: f64,
        mut out: WriteOnly<'_, [u8]>,
        if_changed: bool,
    ) -> Result<bool, String> {
        #[cfg(target_os = "macos")]
        if !self.native_failed {
            if let Ok(changed) = self.native_frame(time, out.slice(..), if_changed) {
                return Ok(changed);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = if_changed; // only the Mac's reader can tell a picture didn't change
        let started = Instant::now();
        self.read_ffmpeg(time)?;
        decode_stats::add(&decode_stats::FFMPEG, &decode_stats::FFMPEG_NS, started);
        out.copy_from_slice(self.frame.get(..out.len()).ok_or("decoded size changed")?);
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    fn native_frame(
        &mut self,
        time: f64,
        mut out: WriteOnly<'_, [u8]>,
        if_changed: bool,
    ) -> Result<bool, String> {
        let decoded = (|| {
            use decode_stats as stats;
            if self.native.is_none() {
                let started = Instant::now();
                self.native = Some(crate::mac_media::Reader::open(
                    &self.source.key.path,
                    self.width,
                    self.height,
                )?);
                stats::add(&stats::OPENS, &stats::OPEN_NS, started);
                self.forward = false;
            }
            let started = Instant::now();
            let read = self
                .native
                .as_mut()
                .ok_or("native reader missing")?
                .frame_to(time, out.slice(..), self.source.key.order, if_changed);
            if self.forward {
                stats::add(&stats::FORWARD, &stats::FORWARD_NS, started);
            } else {
                stats::add(&stats::SEEKS, &stats::SEEK_NS, started);
            }
            read
        })();
        if let Err(error) = &decoded {
            crate::log::warn(
                "render",
                format!(
                    "native decode of {}: {error}; using FFmpeg",
                    self.source.key.path.display()
                ),
            );
            self.native = None;
            self.native_failed = true;
        }
        decoded
    }

    fn read_ffmpeg(&mut self, time: f64) -> Result<(), String> {
        let fps = self.source.fps;
        // Index 0 is the frame at `start`; the one wanted is the nearest to `time`.
        let target = |reader: &Self| reader.nearest(time) - (reader.start * fps).round() as i64;
        let ahead = time - (self.start + self.next_index as f64 / fps);
        let wanted = target(self);
        if self.child.is_none()
            || wanted < 0
            || (!self.eof && ahead > 2.0)
            // Already past it: the frame held now is index `next_index - 1`.
            || (self.next_index > 0 && wanted < self.next_index - 1)
        {
            self.restart(time)?;
        }
        self.frame.resize(self.source.bytes(), 0);
        let mut want = target(self);
        let mut backed_off = false;
        while !self.eof && self.next_index <= want {
            let Some((child, stdout)) = self.child.as_mut() else {
                break;
            };
            match stdout.read_exact(&mut self.spare) {
                Ok(()) => {
                    std::mem::swap(&mut self.frame, &mut self.spare);
                    self.has_frame = true;
                    self.next_index += 1;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::UnexpectedEof && self.has_frame =>
                {
                    if !child.wait().map_err(|error| error.to_string())?.success() {
                        return Err(format!(
                            "decoder failed for {}",
                            self.source.key.path.display()
                        ));
                    }
                    // End of source: hold the last frame.
                    self.eof = true;
                    break;
                }
                // Asked for its very end (an 8.0 s map's frame at 8.0 s, a
                // look_at_media sample at a clip's last instant): the seek
                // lands past the last frame and nothing comes. Start a second
                // earlier and hold the last frame there is.
                Err(error)
                    if error.kind() == std::io::ErrorKind::UnexpectedEof
                        && !backed_off
                        && self.start > 0.0 =>
                {
                    backed_off = true;
                    let earlier = (self.start - 1.0).max(0.0);
                    self.restart(earlier)?;
                    want = target(self);
                }
                Err(error) => {
                    return Err(format!(
                        "could not decode {}: {error}",
                        self.source.key.path.display()
                    ))
                }
            }
        }
        Ok(())
    }

    fn stop(&mut self) {
        if let Some((mut child, _)) = self.child.take() {
            child.stop();
        }
    }
}

impl Drop for VideoReader {
    fn drop(&mut self) {
        self.stop();
    }
}

/// How far ahead (source seconds) of the next excerpt a reader playing towards it has it opened
/// (`VideoReader::prime_next`): the window's cuts are warmed as far ahead (`player::AHEAD_SECONDS`).
const PRIME_SECONDS: f64 = 3.0;

/// How long a reader made ready for a cut ahead is the last the pool lets go: the playhead reaches
/// the cut within three seconds of playing (`player::AHEAD_SECONDS`), or it went elsewhere.
const AHEAD_KEPT: std::time::Duration = std::time::Duration::from_secs(4);

/// A reader read from within this long is in use (a play's is put back every frame): one made ready for
/// a cut ahead never pushes it out (`ReaderPool::put_ahead`).
const IN_USE: std::time::Duration = std::time::Duration::from_secs(1);

/// A cut's reader asked for this long ago and not opened yet (the ahead thread busy with others) isn't
/// opened: its cut was within three seconds of playing when it was asked (`player::AHEAD_SECONDS`).
#[cfg(target_os = "macos")]
const AHEAD_STALE: std::time::Duration = std::time::Duration::from_secs(3);

/// Open readers kept between frames, by file and size rather than by clip, so
/// cutting back to a file (jump cuts, a sheet's frames) continues a reader
/// instead of opening and seeking a new one.
struct ReaderPool {
    readers: Vec<(VideoReader, u64)>,
    clock: u64,
    total: usize,
    per_key: usize,
}

impl ReaderPool {
    fn new(total: usize, per_key: usize) -> Self {
        Self {
            readers: Vec::new(),
            clock: 0,
            total,
            per_key,
        }
    }

    /// The pooled reader for `source` that gets to `time` soonest (one just
    /// behind it decodes forward; anything else seeks), or a new one. One
    /// made ready for a cut ahead waits for its cut: it's never the one
    /// taken to seek somewhere else.
    fn take(&mut self, source: &Source, time: f64) -> VideoReader {
        let cost = |reader: &VideoReader, used: u64| match reader.position {
            _ if reader.source.key.still && reader.has_frame => 0.0,
            Some(position) if position <= time + 1e-6 && time - position <= 2.0 => time - position,
            _ if reader
                .ahead
                .is_some_and(|since| since.elapsed() < AHEAD_KEPT) =>
            {
                f64::INFINITY
            }
            _ => 1e6 - used as f64 * 1e-3,
        };
        let best = self
            .readers
            .iter()
            .enumerate()
            .filter(|(_, (reader, used))| {
                reader.source.key == source.key && cost(reader, *used).is_finite()
            })
            .min_by(|(_, (a, at)), (_, (b, bt))| cost(a, *at).total_cmp(&cost(b, *bt)))
            .map(|(index, _)| index);
        match best {
            Some(index) => {
                let mut reader = self.readers.swap_remove(index).0;
                reader.ahead = None;
                reader
            }
            None => VideoReader::open(source.clone()),
        }
    }

    /// Whether a pooled reader of `source` would read on to `time` (it's just behind it) rather than seek.
    /// Asked by the window's decode-ahead (PreviewPictures), which only Edit.app has: one made ready
    /// for that cut is wanted still, and stays kept (`put_ahead`).
    #[cfg(any(target_os = "macos", test))]
    fn ready(&mut self, source: &Source, time: f64) -> bool {
        let mut found = false;
        for (reader, _) in &mut self.readers {
            if reader.source.key == source.key
                && ((reader.source.key.still && reader.has_frame)
                    || reader.position.is_some_and(|position| {
                        position <= time + 1e-6 && time - position <= FORWARD
                    }))
            {
                found = true;
                if reader.ahead.is_some() {
                    reader.ahead = Some(Instant::now());
                }
            }
        }
        found
    }

    /// A reader made ready for a cut ahead of the playhead. The pool lets the reader longest unused
    /// go, which is this one by the time its cut comes (it was made seconds ago; the readers playing
    /// are used every frame): so for a few seconds it's the last to go, not the first. Making room for
    /// it, a reader in use (`IN_USE`) is the last to go: with the readers of a file made ready for cuts
    /// filling its share, the one the play was drawing from was the only one not kept, and went (the Nov
    /// 21 audit: a seek on the next frame). Another made ready goes first then, or this one.
    #[cfg(any(target_os = "macos", test))]
    fn put_ahead(&mut self, mut reader: VideoReader) {
        reader.ahead = Some(Instant::now());
        self.keep(reader, true);
    }

    /// A reader back for later. One whose read failed is let go: put back, the same file asked
    /// again took it, and it failed again however the file had changed since.
    fn put(&mut self, mut reader: VideoReader) {
        reader.read_at = Some(Instant::now());
        self.keep(reader, false);
    }

    fn keep(&mut self, reader: VideoReader, ahead: bool) {
        if reader.failed {
            return;
        }
        self.clock += 1;
        let key = reader.source.key.clone();
        self.readers.push((reader, self.clock));
        let oldest = |readers: &Vec<(VideoReader, u64)>, key: Option<&DecodeKey>| {
            readers
                .iter()
                .enumerate()
                .filter(|(_, (reader, _))| key.is_none_or(|key| reader.source.key == *key))
                .min_by_key(|(_, (reader, used))| {
                    let kept = reader
                        .ahead
                        .is_some_and(|since| since.elapsed() < AHEAD_KEPT);
                    let in_use = ahead
                        && reader.ahead.is_none()
                        && reader.read_at.is_some_and(|at| at.elapsed() < IN_USE);
                    (in_use, kept, *used)
                })
                .map(|(index, _)| index)
        };
        while self
            .readers
            .iter()
            .filter(|(reader, _)| reader.source.key == key)
            .count()
            > self.per_key
        {
            let Some(index) = oldest(&self.readers, Some(&key)) else {
                break;
            };
            self.readers.swap_remove(index);
        }
        while self.readers.len() > self.total {
            let Some(index) = oldest(&self.readers, None) else {
                break;
            };
            self.readers.swap_remove(index);
        }
    }

    fn clear(&mut self) {
        self.readers.clear();
    }
}

/// Frames for `requests` (each a source and a time), decoded on up to
/// `threads` threads, each going through its share in file and time order.
/// Readers come from and go back to `pool`.
fn decode_all(
    pool: &mut ReaderPool,
    requests: &[(Source, f64)],
    threads: usize,
) -> Result<Vec<Vec<u8>>, String> {
    decode_all_into(pool, requests, threads, &mut Vec::new())
}

/// `decode_all` into buffers taken from `spare` where one is the size (a
/// reader writes every byte of its frame): a fresh zeroed buffer each layer and
/// frame was pages faulted in and zeroed at every one of the native preview's
/// draws, 8 MB a 1080p picture.
fn decode_all_into(
    pool: &mut ReaderPool,
    requests: &[(Source, f64)],
    threads: usize,
    spare: &mut Vec<Vec<u8>>,
) -> Result<Vec<Vec<u8>>, String> {
    let mut buffers: Vec<Option<Vec<u8>>> = requests
        .iter()
        .map(|(source, _)| {
            let bytes = source.bytes();
            Some(
                match spare.iter().position(|buffer| buffer.len() == bytes) {
                    Some(at) => spare.swap_remove(at),
                    None => vec![0_u8; bytes],
                },
            )
        })
        .collect();
    let mut order: Vec<usize> = (0..requests.len()).collect();
    order.sort_by(|a, b| {
        let (Some((sa, ta)), Some((sb, tb))) = (requests.get(*a), requests.get(*b)) else {
            return std::cmp::Ordering::Equal;
        };
        (&sa.key.path, sa.key.width, sa.key.height)
            .cmp(&(&sb.key.path, sb.key.width, sb.key.height))
            .then(ta.total_cmp(tb))
    });
    let threads = threads.clamp(1, requests.len().max(1));
    let share = order.len().div_ceil(threads).max(1);
    let shares: Vec<Vec<usize>> = order.chunks(share).map(<[usize]>::to_vec).collect();
    // Each share's readers, taken from the pool before the threads start: one
    // for every change of file or size along it. A share holding two layers
    // (a picture over its own blurred copy, B-roll over a shot) opened a new
    // reader for the second on every frame, and seeked it: 473 opens and 490
    // seeks in 160 s of Cops Realize (Nov 8), 20–30 ms a frame.
    let mut work = Vec::new();
    for share in shares {
        let outs: Vec<Vec<u8>> = share
            .iter()
            .map(|index| {
                buffers
                    .get_mut(*index)
                    .and_then(Option::take)
                    .unwrap_or_default()
            })
            .collect();
        let mut readers = VecDeque::new();
        let mut last: Option<&DecodeKey> = None;
        for index in &share {
            let Some((source, time)) = requests.get(*index) else {
                continue;
            };
            if last != Some(&source.key) {
                readers.push_back(pool.take(source, *time));
                last = Some(&source.key);
            }
        }
        if !readers.is_empty() {
            work.push((share, readers, outs));
        }
    }
    let run = |(share, mut readers, outs): (Vec<usize>, VecDeque<VideoReader>, Vec<Vec<u8>>)| {
        let mut outs = outs.into_iter();
        let mut done = Vec::new();
        let mut spent = Vec::new();
        let mut reader: Option<VideoReader> = None;
        for index in share {
            let Some((source, time)) = requests.get(index) else {
                continue;
            };
            if reader
                .as_ref()
                .is_none_or(|one| one.source.key != source.key)
            {
                spent.extend(reader.take());
                reader = Some(
                    readers
                        .pop_front()
                        .unwrap_or_else(|| VideoReader::open(source.clone())),
                );
            }
            let Some(reader) = reader.as_mut() else {
                continue;
            };
            let mut out = outs.next().unwrap_or_default();
            out.resize(source.bytes(), 0);
            let decoded = reader.frame_into(*time, &mut out, false);
            done.push((index, decoded.map(|_| out)));
        }
        spent.extend(reader);
        spent.extend(readers);
        (done, spent)
    };
    let results: Vec<_> = if work.len() <= 1 {
        work.into_iter().map(run).collect()
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = work
                .into_iter()
                .map(|item| scope.spawn(move || run(item)))
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect()
        })
    };
    let mut frames: Vec<Option<Vec<u8>>> = vec![None; requests.len()];
    let mut failure = None;
    for (done, spent) in results {
        for reader in spent {
            pool.put(reader);
        }
        for (index, decoded) in done {
            match decoded {
                Ok(pixels) => {
                    if let Some(slot) = frames.get_mut(index) {
                        *slot = Some(pixels);
                    }
                }
                Err(error) => failure = Some(error),
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    frames
        .into_iter()
        .map(|frame| frame.ok_or_else(|| "a frame wasn't decoded".to_owned()))
        .collect()
}

// ---------------------------------------------------------------------------
// Single frames

/// Owns a GPU on its own thread; frame renders queue here, the agent's ahead
/// of the UI's (covers and thumbnails can wait; an agent's turn can't).
pub struct FrameRenderer {
    queue: Arc<JobQueue>,
}

struct JobQueue {
    jobs: Mutex<Queues>,
    ready: Condvar,
    /// Set by `stop`: the thread ends, and its GPU and readers go with it.
    stopped: AtomicBool,
}

#[derive(Default)]
struct Queues {
    agent: VecDeque<FrameJob>,
    ui: VecDeque<FrameJob>,
}

struct FrameJob {
    project: Project,
    frames: Vec<i64>,
    /// Longest side of each returned image; 0 = project size.
    max_side: u32,
    reply: tokio::sync::oneshot::Sender<Result<Vec<RgbaImage>, String>>,
}

pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// Readers left open this long with nothing to render are closed, and the
/// renderer with them (off a Mac; on one it lets go of its textures,
/// `Renderer::release`): kept, a burst of the agent's frames left the server
/// 440 MB bigger for good (mandalorian, Nov 17: 181 MB, 1.2 GB after 4 frames
/// and 2 looks, 618 MB 90 s on; 498 MB let go). On a Mac each renderer has its
/// own Metal device, and let go and made again it kept 124 MB more, not less
/// (kenobi, Nov 17), so there the renderer and its device stay.
const IDLE: Duration = Duration::from_secs(20);

impl FrameRenderer {
    /// `cache` is the media cache: waveforms' sound levels and light previews.
    pub fn start(cache: PathBuf) -> Arc<Self> {
        let queue = Arc::new(JobQueue {
            jobs: Mutex::new(Queues::default()),
            ready: Condvar::new(),
            stopped: AtomicBool::new(false),
        });
        let jobs = Arc::clone(&queue);
        std::thread::spawn(move || {
            let mut renderer: Option<Renderer> = None;
            // Whether the renderer has let go of the last job's textures since it rendered.
            let mut released = true;
            let mut last_project = String::new();
            let mut pool = ReaderPool::new(6, 2);
            loop {
                let job = {
                    let mut queues = jobs.jobs.lock();
                    loop {
                        if jobs.stopped.load(Ordering::Acquire) {
                            // Waiting callers hear "renderer stopped".
                            queues.agent.clear();
                            queues.ui.clear();
                            return;
                        }
                        if let Some(job) =
                            queues.agent.pop_front().or_else(|| queues.ui.pop_front())
                        {
                            break job;
                        }
                        if jobs.ready.wait_for(&mut queues, IDLE).timed_out()
                            && queues.agent.is_empty()
                            && queues.ui.is_empty()
                            && (!pool.readers.is_empty() || !released)
                        {
                            pool.clear();
                            // Off a Mac the device is shared (`gpu`): the renderer goes, made
                            // again on the shared device at the next frame. On a Mac it would
                            // take its own Metal device with it, made again each time.
                            if cfg!(target_os = "macos") {
                                if let Some(renderer) = renderer.as_mut() {
                                    renderer.release();
                                }
                            } else {
                                renderer = None;
                                last_project.clear();
                            }
                            released = true;
                            crate::util::give_back_memory();
                        }
                    }
                };
                if job.reply.is_closed() {
                    continue;
                }
                let rendering = Instant::now();
                released = false;
                let caught = crate::util::catch("rendering a frame", || {
                    let settings = job.project.settings;
                    let renderer = match &mut renderer {
                        Some(renderer) => renderer,
                        empty => empty.insert(new_renderer(settings.width, settings.height)?),
                    };
                    // Media ids are per project: another project's may be other files.
                    if job.project.id != last_project {
                        renderer.clear_peaks();
                        last_project = job.project.id.clone();
                    }
                    render_job(
                        renderer,
                        &mut pool,
                        &job.project,
                        &job.frames,
                        job.max_side,
                        &cache,
                    )
                });
                // A crash may leave the GPU state half-way: start afresh next time.
                if caught.is_err() {
                    renderer = None;
                    pool.clear();
                }
                let result = caught.and_then(|result| result);
                let name = if job.frames.len() > 1 {
                    "render: frames"
                } else {
                    "render: frame"
                };
                crate::log::record(
                    "render",
                    name,
                    rendering.elapsed(),
                    result.as_ref().err().map(String::as_str),
                );
                let _ = job.reply.send(result);
            }
        });
        Arc::new(Self { queue })
    }

    /// Ends the renderer's thread once the frame it's on is done; renders
    /// waiting, and any asked for later, fail with "renderer stopped".
    pub fn stop(&self) {
        self.queue.stopped.store(true, Ordering::Release);
        let _held = self.queue.jobs.lock();
        self.queue.ready.notify_all();
    }

    /// Renders for the UI (covers, the export dialog, saving a frame).
    pub async fn render(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
    ) -> Result<Vec<RgbaImage>, String> {
        self.submit(project, frames, max_side, false).await
    }

    /// Renders for an agent's tool call, ahead of any UI renders waiting.
    pub async fn render_for_agent(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
    ) -> Result<Vec<RgbaImage>, String> {
        self.submit(project, frames, max_side, true).await
    }

    async fn submit(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
        agent: bool,
    ) -> Result<Vec<RgbaImage>, String> {
        let (reply, response) = tokio::sync::oneshot::channel();
        {
            let mut queues = self.queue.jobs.lock();
            if self.queue.stopped.load(Ordering::Acquire) {
                return Err("renderer stopped".to_owned());
            }
            // Callers that gave up leave nothing to wait behind.
            queues.agent.retain(|job| !job.reply.is_closed());
            queues.ui.retain(|job| !job.reply.is_closed());
            let (queue, limit) = if agent {
                (&mut queues.agent, 16)
            } else {
                (&mut queues.ui, 8)
            };
            if queue.len() >= limit {
                return Err("renderer busy; try again shortly".to_owned());
            }
            queue.push_back(FrameJob {
                project,
                frames,
                max_side,
                reply,
            });
        }
        self.queue.ready.notify_one();
        response.await.map_err(|_| "renderer stopped".to_owned())?
    }
}

/// A scene's video pictures for the native preview (`crate::player`): each
/// video layer's clip and its frame, decoded at the size it's shown in a
/// `shown` picture from `sources` (a media's preview file, else its own path),
/// through `pool` so playing on decodes forward and a jump seeks.
#[cfg(target_os = "macos")]
pub(crate) struct PreviewPictures {
    /// Shared with the decode-ahead threads, which put the readers they opened and seeked here.
    pool: Arc<Mutex<ReaderPool>>,
    ahead: mpsc::Sender<(Source, f64, Instant)>,
    /// Pictures decoded behind the playhead while it moves back at rest.
    behind: crate::behind::Behind,
    /// Buffers of pictures drawn and let go (`recycle`), decoded into again.
    spare: Vec<Vec<u8>>,
}

/// Threads opening and seeking readers ahead of the playhead (a cut to a new
/// file cost its seek, 20-80 ms, on the drawing path: Cops Realize, Nov 9).
#[cfg(target_os = "macos")]
const AHEAD_THREADS: usize = 1;

/// A clip's decoded picture: its clip, width, height and BGRA pixels.
#[cfg(target_os = "macos")]
pub(crate) type Picture = (String, u32, u32, crate::behind::Pixels);

/// How many readers the preview keeps, and how many of one file (the one longest unused goes when there are more).
#[cfg(target_os = "macos")]
pub(crate) const READERS: usize = 12;
#[cfg(target_os = "macos")]
pub(crate) const READERS_A_FILE: usize = 3;

#[cfg(target_os = "macos")]
impl PreviewPictures {
    pub(crate) fn new() -> Self {
        // A few readers per file: two layers of one source, the way back after a jump, and the next cut's.
        let pool = Arc::new(Mutex::new(ReaderPool::new(READERS, READERS_A_FILE)));
        // What the ahead threads are opening now (file, size and the time in ms): a cut asked for every frame is opened once.
        let opening: Arc<Mutex<HashSet<(DecodeKey, i64)>>> = Arc::new(Mutex::new(HashSet::new()));
        let (ahead, requests) = mpsc::channel::<(Source, f64, Instant)>();
        let requests = Arc::new(Mutex::new(requests));
        for _ in 0..AHEAD_THREADS {
            let (pool, opening, requests) = (
                Arc::clone(&pool),
                Arc::clone(&opening),
                Arc::clone(&requests),
            );
            let _ = std::thread::Builder::new()
                .name("edit preview ahead".to_owned())
                .spawn(move || {
                    // Behind the frame being drawn: utility work, never ahead of the player's thread.
                    crate::util::utility_thread();
                    decode_stats::AHEAD_THREAD.with(|ahead| ahead.set(true));
                    loop {
                        // One receiver shared: whichever thread is free takes the next request.
                        let next = requests.lock().recv();
                        let Ok((source, time, asked)) = next else {
                            return;
                        };
                        // Asked for a cut that's been reached or left by now: opened, it only took a reader's place.
                        if asked.elapsed() > AHEAD_STALE {
                            continue;
                        }
                        let key = (source.key.clone(), (time * 1000.0).round() as i64);
                        if pool.lock().ready(&source, time) || !opening.lock().insert(key.clone()) {
                            continue;
                        }
                        let mut reader = VideoReader::open(source.clone());
                        let mut scratch = vec![0_u8; source.bytes()];
                        // The frame decoded here is dropped: the reader now stands on it, and the frame's own
                        // read is a copy out of what it holds.
                        if reader.frame_into(time, &mut scratch, false).is_ok() {
                            pool.lock().put_ahead(reader);
                        }
                        opening.lock().remove(&key);
                    }
                });
        }
        Self {
            pool,
            ahead,
            behind: crate::behind::Behind::new(crate::behind::BUDGET),
            spare: Vec::new(),
        }
    }

    pub(crate) fn clear(&mut self) {
        self.pool.lock().clear();
        self.behind.clear();
    }

    /// Lets go of the pictures decoded behind the playhead (the edit or the size changed).
    pub(crate) fn forget(&mut self) {
        self.behind.clear();
    }

    /// Playing: the pictures behind the playhead stop being decoded (they're kept).
    pub(crate) fn playing(&mut self) {
        self.behind.stop();
    }

    /// Lets go of the readers of files not in `read` (a media read from another file now); the rest stay.
    pub(crate) fn keep_only(&mut self, read: &HashSet<&PathBuf>) {
        self.pool
            .lock()
            .readers
            .retain(|(reader, _)| read.contains(&reader.source.key.path));
        self.behind.clear();
    }

    /// The playhead is at `frame` at rest: moving back, the pictures of the frames below it are decoded on
    /// another thread (`crate::behind`), so the next steps back read them instead of seeking.
    pub(crate) fn moved(
        &mut self,
        project: &Project,
        frame: i64,
        shown: (u32, u32),
        sources: &std::collections::HashMap<String, PathBuf>,
    ) {
        self.behind.moved(frame, project.fps(), |at| {
            video_requests(project, &evaluate_seen(project, at), shown, sources)
                .map(|(requests, _)| requests)
                .unwrap_or_default()
        });
    }

    /// Has a reader of `media` opened and seeked to `source_time` on another
    /// thread, unless one is there (or on its way), so a cut to it reads on
    /// instead of seeking on the drawing path.
    pub(crate) fn warm(
        &self,
        project: &Project,
        media: &str,
        source_time: f64,
        shown: (u32, u32),
        sources: &std::collections::HashMap<String, PathBuf>,
    ) {
        let Some(found) = project.media(media) else {
            return;
        };
        // A picture too: decoded at its cut it took 15–25 ms of the frame's time (ImageIO), a hold
        // of two frames at every photo while playing (Cops Realize, Nov 15).
        let path = sources
            .get(media)
            .cloned()
            .unwrap_or_else(|| PathBuf::from(&found.path));
        let source = Source::new(
            found,
            path,
            decode_size(found, shown.0, shown.1),
            Order::Bgra,
        );
        if self.pool.lock().ready(&source, source_time) {
            return;
        }
        let _ = self.ahead.send((source, source_time, Instant::now()));
    }

    /// `(clip, width, height, BGRA pixels)` for each video layer of `scene`, and whether a
    /// neighbour's picture stood in for one. At rest (`rest`: the frame), a picture decoded behind
    /// the playhead is read instead of a reader: its own, or mid-drag (not `exact`) the nearest kept
    /// within the step (`crate::behind`).
    pub(crate) fn decode(
        &mut self,
        project: &Project,
        scene: &Scene,
        shown: (u32, u32),
        sources: &std::collections::HashMap<String, PathBuf>,
        rest: Option<i64>,
        exact: bool,
    ) -> Result<(Vec<Picture>, bool), String> {
        let (requests, clips) = video_requests(project, scene, shown, sources)?;
        let (kept, stood_in) = match rest {
            Some(frame) => {
                let found = self.behind.lookup(frame, &requests, exact);
                (found.pictures, found.stood_in)
            }
            None => (vec![None; requests.len()], false),
        };
        let missing: Vec<(Source, f64)> = requests
            .iter()
            .zip(&kept)
            .filter(|(_, kept)| kept.is_none())
            .map(|(request, _)| request.clone())
            .collect();
        decode_stats::KEPT.fetch_add(
            (requests.len() - missing.len()) as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        let threads = if missing.len() > 2 { 4 } else { 1 };
        let decoded = decode_all_into(&mut self.pool.lock(), &missing, threads, &mut self.spare);
        if decoded.is_err() {
            // What's kept may be of a file that changed.
            self.behind.clear();
        }
        let mut decoded = decoded?.into_iter();
        let pictures = clips
            .into_iter()
            .zip(&requests)
            .zip(kept)
            .map(|((clip, (source, _)), kept)| -> Result<Picture, String> {
                let pixels = kept
                    .or_else(|| decoded.next().map(Arc::new))
                    .ok_or_else(|| "a frame wasn't decoded".to_owned())?;
                Ok((clip, source.key.width, source.key.height, pixels))
            })
            .collect::<Result<Vec<Picture>, String>>()?;
        Ok((pictures, stood_in))
    }

    /// Takes back pictures drawn: each one nothing else holds (the pictures
    /// kept behind the playhead share theirs) is decoded into again, a few kept.
    /// A full pool makes room by letting go of one of another size: kept
    /// first come, buffers of sizes no longer drawn (a resized window, another
    /// project) filled it for good and none of the new size was kept again.
    pub(crate) fn recycle(&mut self, pictures: Vec<Picture>) {
        for (_, _, _, pixels) in pictures {
            if let Ok(buffer) = Arc::try_unwrap(pixels) {
                keep_spare(&mut self.spare, buffer);
            }
        }
    }
}

/// The most buffers a preview keeps to decode into again.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SPARE_BUFFERS: usize = 8;

/// Keeps `buffer` in `spare` to decode into again: with the pool full, in
/// place of one of another size, else not at all.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keep_spare(spare: &mut Vec<Vec<u8>>, buffer: Vec<u8>) {
    if spare.len() < SPARE_BUFFERS {
        spare.push(buffer);
    } else if let Some(slot) = spare.iter_mut().find(|kept| kept.len() != buffer.len()) {
        *slot = buffer;
    }
}

/// What's read for each video layer of a scene (its file and source time), and the layers' clips.
#[cfg(target_os = "macos")]
type Requests = (Vec<(Source, f64)>, Vec<String>);

/// Each video layer of `scene` as what's read for it (its file, decoded at the size it's shown in a
/// `shown` picture, and its source time), with its clip.
#[cfg(target_os = "macos")]
fn video_requests(
    project: &Project,
    scene: &Scene,
    shown: (u32, u32),
    sources: &std::collections::HashMap<String, PathBuf>,
) -> Result<Requests, String> {
    let mut requests = Vec::new();
    let mut clips = Vec::new();
    for layer in &scene.layers {
        if let Layer::Video {
            clip,
            media,
            source_time,
            ..
        } = layer
        {
            let found = project
                .media(media)
                .ok_or_else(|| format!("unknown media {media}"))?;
            let path = sources
                .get(media)
                .cloned()
                .unwrap_or_else(|| PathBuf::from(&found.path));
            requests.push((
                Source::new(
                    found,
                    path,
                    decode_size(found, shown.0, shown.1),
                    Order::Bgra,
                ),
                *source_time,
            ));
            clips.push(clip.clone());
        }
    }
    Ok((requests, clips))
}

/// Gives the renderer the sound levels this frame's waveforms read: each
/// media's peaks from the media cache (missing ones are tried again next frame).
pub(crate) fn feed_peaks(renderer: &mut Renderer, project: &Project, scene: &Scene, cache: &Path) {
    for layer in &scene.layers {
        let Layer::Waveform { sources, .. } = layer else {
            continue;
        };
        for source in sources {
            if renderer.has_peaks(&source.media) {
                continue;
            }
            let Some(media) = project.media(&source.media) else {
                continue;
            };
            let path = cache
                .join(crate::media::media_key(Path::new(&media.path)))
                .join("peaks.bin");
            if let Ok(peaks) = std::fs::read(path) {
                renderer.set_peaks(&source.media, peaks);
            }
        }
    }
}

/// Where to decode `media` from for a picture whose longest side is
/// `max_side` (0 = full size): the light 720p preview when that's enough and
/// made (short keyframe intervals, a fraction of the decoding), else the file.
fn picture_source(media: &Media, size: (u32, u32), max_side: u32, cache: Option<&Path>) -> Source {
    let original = PathBuf::from(&media.path);
    let path = match cache {
        Some(cache)
            if max_side > 0 && max_side <= 720 && media.kind == edit_core::MediaKind::Video =>
        {
            crate::media::light_preview(cache, &original).unwrap_or(original)
        }
        _ => original,
    };
    Source::new(media, path, size, Order::Bgra)
}

/// Renders `frames` of `project`: every picture they need decoded first (in
/// parallel, at the size they'll be shown), then composited one by one.
fn render_job(
    renderer: &mut Renderer,
    pool: &mut ReaderPool,
    project: &Project,
    frames: &[i64],
    max_side: u32,
    cache: &Path,
) -> Result<Vec<RgbaImage>, String> {
    let settings = project.settings;
    let (width, height) = (settings.width, settings.height);
    let longest = width.max(height).max(1);
    let scale = if max_side > 0 && max_side < longest {
        f64::from(max_side) / f64::from(longest)
    } else {
        1.0
    };
    let shown = (
        ((f64::from(width) * scale).round() as u32).max(2),
        ((f64::from(height) * scale).round() as u32).max(2),
    );
    let scenes: Vec<Scene> = frames
        .iter()
        .map(|frame| evaluate_seen(project, *frame))
        .collect();
    let mut requests = Vec::new();
    let mut layers = Vec::new();
    for (index, scene) in scenes.iter().enumerate() {
        for layer in &scene.layers {
            if let Layer::Video {
                clip,
                media,
                source_time,
                ..
            } = layer
            {
                let media = project
                    .media(media)
                    .ok_or_else(|| format!("unknown media {media}"))?;
                let size = decode_size(media, shown.0, shown.1);
                requests.push((
                    picture_source(media, size, max_side, Some(cache)),
                    *source_time,
                ));
                layers.push((index, clip.as_str()));
            }
        }
    }
    let threads = if requests.len() > 2 { 4 } else { 1 };
    let decoding = Instant::now();
    let decoded = decode_all(pool, &requests, threads)?;
    let decoding = decoding.elapsed();
    let compositing = Instant::now();
    let mut pictures: Vec<Vec<(&str, &Source, Vec<u8>)>> =
        scenes.iter().map(|_| Vec::new()).collect();
    for (((index, clip), (source, _)), pixels) in layers.into_iter().zip(&requests).zip(decoded) {
        if let Some(list) = pictures.get_mut(index) {
            list.push((clip, source, pixels));
        }
    }
    let mut images = Vec::new();
    for (scene, pictures) in scenes.iter().zip(pictures) {
        feed_peaks(renderer, project, scene, cache);
        for (clip, source, pixels) in &pictures {
            renderer.upload_video(clip, source.key.width, source.key.height, pixels, true);
        }
        renderer.render(scene);
        let image = RgbaImage {
            width,
            height,
            pixels: renderer.read_output()?,
        };
        images.push(if max_side > 0 {
            downscale(&image, max_side)
        } else {
            image
        });
    }
    if frames.len() > 1 {
        crate::log::info(
            "render",
            format!(
                "{} frames: {} pictures decoded in {}, composited in {}",
                frames.len(),
                requests.len(),
                crate::log::human(decoding),
                crate::log::human(compositing.elapsed())
            ),
        );
    }
    Ok(images)
}

/// Evenly spaced frames of a media file between `start` and `end` (seconds of
/// the file), at most `max_side` px, decoded side by side (from the light
/// preview when it's made).
pub fn media_frames(
    media: &Media,
    cache: Option<&Path>,
    start: f64,
    end: f64,
    count: usize,
    max_side: u32,
) -> Result<(Vec<RgbaImage>, Vec<f64>), String> {
    let end = end.min(media.duration).max(start);
    let times: Vec<f64> = (0..count)
        .map(|index| {
            if count == 1 {
                start
            } else {
                start + (end - start) * index as f64 / (count - 1) as f64
            }
        })
        .collect();
    let size = decode_size(media, max_side, max_side);
    let mut source = picture_source(media, size, max_side, cache);
    source.key.order = Order::Rgba;
    let requests: Vec<(Source, f64)> = times.iter().map(|time| (source.clone(), *time)).collect();
    let mut pool = ReaderPool::new(4, 4);
    let frames = decode_all(&mut pool, &requests, 4)?;
    let images = frames
        .into_iter()
        .map(|pixels| {
            if media.stacked_alpha {
                unstack(size.0, size.1, &pixels)
            } else {
                RgbaImage {
                    width: size.0,
                    height: size.1,
                    pixels,
                }
            }
        })
        .collect();
    Ok((images, times))
}

/// One frame of a media file at full size (RGBA), for saving as a still.
pub fn media_still(media: &Media, time: f64) -> Result<RgbaImage, String> {
    let size = decode_size(media, media.width.max(2), media.height.max(2));
    let source = Source::new(media, PathBuf::from(&media.path), size, Order::Rgba);
    let mut reader = VideoReader::open(source);
    let pixels = reader.frame_at(time)?.to_vec();
    if media.stacked_alpha {
        return Ok(unstack(size.0, size.1, &pixels));
    }
    Ok(RgbaImage {
        width: size.0,
        height: size.1,
        pixels,
    })
}

/// Saves the frame of `media` at `time` (seconds) as a PNG at `out`: decoded
/// natively and written by ImageIO on the Mac, grabbed by FFmpeg otherwise.
/// Blocking: call it off the async runtime.
pub fn save_still(media: &Media, time: f64, out: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let native = media_still(media, time).and_then(|still| {
            let png = crate::mac_media::encode_image(
                &still.pixels,
                still.width,
                still.height,
                still.width as usize * 4,
                None,
            )?;
            std::fs::write(out, png).map_err(|error| error.to_string())
        });
        match native {
            Ok(()) => return Ok(()),
            Err(error) => crate::log::warn(
                "render",
                format!("native still of {}: {error}; using FFmpeg", media.path),
            ),
        }
    }
    let mut command = crate::util::ffmpeg_command();
    command.args(["-hide_banner", "-loglevel", "error", "-y"]);
    // A photo is its one frame, read with no seek: FFmpeg 8 gives no picture
    // at all for a JPEG or PNG asked from -ss 0, and says nothing (Killer
    // Pastor on Linux, Nov 8: still_frame "couldn't take the frame:" on two
    // news photos; exports had the same, 6462ccee).
    if media.kind != edit_core::MediaKind::Image {
        command.arg("-ss").arg(format!("{time:.3}"));
    }
    command.arg("-i").arg(&media.path);
    // A stacked file: its top half with the bottom half's grey as its alpha.
    if media.stacked_alpha {
        command.args([
            "-filter_complex",
            "[0:v]split[c][m];[c]crop=iw:ih/2:0:0[top];[m]crop=iw:ih/2:0:ih/2,format=gray[alpha];[top][alpha]alphamerge,unpremultiply=inplace=1,format=rgba",
        ]);
    }
    let output = command
        .args(["-frames:v", "1"])
        .arg(out)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !output.status.success() || !out.is_file() {
        return Err(format!(
            "couldn't take the frame: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Scales down so the longest side is at most `max_side` (Accelerate's
/// resampler on the Mac, a box filter elsewhere).
pub fn downscale(image: &RgbaImage, max_side: u32) -> RgbaImage {
    let longest = image.width.max(image.height);
    if longest <= max_side {
        return RgbaImage {
            width: image.width,
            height: image.height,
            pixels: image.pixels.clone(),
        };
    }
    let scale = max_side as f32 / longest as f32;
    let (w, h) = (
        ((image.width as f32 * scale).round() as u32).max(1),
        ((image.height as f32 * scale).round() as u32).max(1),
    );
    let mut pixels = vec![0_u8; (w * h * 4) as usize];
    #[cfg(target_os = "macos")]
    if crate::mac_media::scale(
        &image.pixels,
        (image.width, image.height, image.width as usize * 4),
        &mut pixels,
        (w, h),
    )
    .is_ok()
    {
        return RgbaImage {
            width: w,
            height: h,
            pixels,
        };
    }
    for y in 0..h {
        let sy0 = (y as f32 / scale) as u32;
        let sy1 = (((y + 1) as f32 / scale) as u32).clamp(sy0 + 1, image.height);
        for x in 0..w {
            let sx0 = (x as f32 / scale) as u32;
            let sx1 = (((x + 1) as f32 / scale) as u32).clamp(sx0 + 1, image.width);
            let mut sum = [0_u64; 4];
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * image.width + sx) * 4) as usize;
                    let pixel = image.pixels.get(i..i + 4).into_iter().flatten();
                    for (total, value) in sum.iter_mut().zip(pixel) {
                        *total += u64::from(*value);
                    }
                }
            }
            let n = (sy1 - sy0) * (sx1 - sx0);
            let o = ((y * w + x) * 4) as usize;
            for (out, total) in pixels.get_mut(o..o + 4).into_iter().flatten().zip(sum) {
                *out = (total / u64::from(n.max(1))) as u8;
            }
        }
    }
    RgbaImage {
        width: w,
        height: h,
        pixels,
    }
}

pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // Frames are big and short-lived: fast compression is the better trade.
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&image.pixels)
            .map_err(|error| error.to_string())?;
    }
    Ok(out)
}

/// A picture for a model: JPEG (quality 80), PNG only when that fails; with its MIME type.
pub fn encode_for_agent(image: &RgbaImage) -> Result<(Vec<u8>, &'static str), String> {
    #[cfg(target_os = "macos")]
    if let Ok(jpeg) = crate::mac_media::encode_image(
        &image.pixels,
        image.width,
        image.height,
        image.width as usize * 4,
        Some(0.8),
    ) {
        return Ok((jpeg, "image/jpeg"));
    }
    // Elsewhere (Linux, Windows) the same quality as ImageIO's 0.8, its alpha dropped as ImageIO's JPEG drops it: a PNG
    // frame was 1.4–4 MB, sent with every look and kept again in the agent's session (Nov 13: 1.2 GB of one project's).
    #[cfg(not(target_os = "macos"))]
    if let (Ok(width), Ok(height)) = (u16::try_from(image.width), u16::try_from(image.height)) {
        let mut jpeg = Vec::new();
        if jpeg_encoder::Encoder::new(&mut jpeg, 80)
            .encode(&image.pixels, width, height, jpeg_encoder::ColorType::Rgba)
            .is_ok()
        {
            return Ok((jpeg, "image/jpeg"));
        }
    }
    Ok((encode_png(image)?, "image/png"))
}

/// Contact-sheet cells' longest side: four across makes a ~1.5k px sheet, plenty for a model.
pub const SHEET_CELL: u32 = 360;

// ---------------------------------------------------------------------------
// Export

/// A file removed when dropped: an export's partial file, its sound or
/// chapters beside it.
pub struct ExportFile(pub PathBuf);
impl Drop for ExportFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A file beside `output` named for what it holds; removed when dropped.
pub fn beside(output: &Path, suffix: &str) -> ExportFile {
    let mut name = output.as_os_str().to_owned();
    name.push(suffix);
    ExportFile(PathBuf::from(name))
}

/// What an export of `project` as `options` ask will cover, checked before
/// anything starts: an empty timeline, an invalid project, a span with no
/// sound for a sound-only format, or settings that can't work (a target size
/// too small for the span) fail here, not mid-render. A span with no sound
/// exports picture only.
pub fn export_plan(project: &Project, options: &ExportOptions) -> Result<Plan, String> {
    if project.duration() <= 0 {
        return Err("the timeline is empty".to_owned());
    }
    project.validate()?;
    let mut plan = crate::export::plan(options, project, true)?;
    if heard_segments(project, plan.start, plan.end).is_empty() {
        if !options.format.has_video() {
            return Err("there's no sound to export in that span".to_owned());
        }
        plan.audio = false;
    }
    crate::export::codec_args(options, &plan, project.fps())?;
    Ok(plan)
}

/// The file an export of project `id` writes beside `output` while it
/// runs: only a complete export replaces `output`, so a failed or cancelled
/// one can't destroy an older file.
pub fn partial_path(output: &Path, id: &str, format: Format) -> PathBuf {
    let mut name = output.as_os_str().to_owned();
    name.push(format!(
        ".{}-{}.partial.{}",
        std::process::id(),
        id,
        format.extension()
    ));
    PathBuf::from(name)
}

/// Removes partial files of this export ([`partial_path`]), and what was
/// beside them, that a server no longer running left beside `output` (killed mid-export: the file can be
/// gigabytes, and a restarted server's has a new name).
fn remove_stale_partials(output: &Path, id: &str, format: Format) {
    let (Some(dir), Some(name)) = (output.parent(), output.file_name()) else {
        return;
    };
    let prefix = format!("{}.", name.to_string_lossy());
    let suffix = format!("-{id}.partial.{}", format.extension());
    let Ok(entries) = std::fs::read_dir(if dir.as_os_str().is_empty() {
        Path::new(".")
    } else {
        dir
    }) else {
        return;
    };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        // The partial file, or what was beside it (its sound, chapters, concat list).
        let Some(pid) = file
            .strip_prefix(&prefix)
            .and_then(|rest| rest.split_once(&suffix))
            .filter(|(_, after)| after.is_empty() || after.starts_with('.'))
            .and_then(|(pid, _)| pid.parse::<i32>().ok())
        else {
            continue;
        };
        // This process exports one thing at a time, so its own is left over too.
        // SAFETY: signal 0 only asks whether the process exists.
        let alive = pid != std::process::id() as i32
            && (unsafe { libc::kill(pid, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM));
        if !alive {
            crate::log::info(
                "export",
                format!("removing {file}, left by an export cut short"),
            );
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Exports `project` (its media already the files to read: originals, not
/// proxies) to `output` through its partial file ([`partial_path`]), renamed
/// onto `output` once complete. "cancelled" when `cancel` is set.
#[allow(clippy::too_many_arguments)]
pub fn export_file(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    sounds: &HashMap<String, PathBuf>,
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
) -> Result<(), String> {
    remove_stale_partials(output, &project.id, options.format);
    let path = partial_path(output, &project.id, options.format);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let temporary = ExportFile(path);
    let mut progress = progress;
    let settings = native_options(project, options, plan, false)?;
    let mut made = None;
    if let Some(settings) = settings {
        // Tried twice before exporting it whole: the chunks made are kept, so
        // a second try only makes the rest. A sound encoder that stalled once
        // under load (card 1, Oct 29) sent a 93-minute edit to the whole
        // export, hours where the chunks take minutes. The second try copies
        // nothing out of the last export: what it copied may be what was
        // wrong, and copying it again fails the same way (Nov 2, JJ's Mom
        // Secretly v2: both joins had 53141 frames, not 53036, and the whole
        // export after stalled on a Mac out of memory).
        for attempt in 1..=2 {
            match export_chunked(
                project,
                options,
                plan,
                settings,
                &temporary.0,
                cache,
                sounds,
                attempt == 1,
                cancel,
                &mut progress,
            ) {
                Ok(chunks) => {
                    made = Some(chunks);
                    break;
                }
                Err(error) if error == "cancelled" || cancel.load(Ordering::Acquire) => {
                    return Err("cancelled".to_owned())
                }
                Err(error) if attempt == 1 => crate::log::warn(
                    "export",
                    format!("a chunked export failed ({error}); trying the chunks again, rendering what it had copied from the last export"),
                ),
                Err(error) => crate::log::warn(
                    "export",
                    format!("a chunked export failed again ({error}); exporting it whole"),
                ),
            }
        }
    }
    if made.is_none() {
        // The native encoder first; when it fails (stalled on a Mac out of
        // memory: JJ's, Nov 2, after 16 minutes), once more with FFmpeg's.
        let whole = |native: bool, progress: &mut dyn FnMut(f32)| {
            export_with(
                project,
                options,
                plan,
                &temporary.0,
                cache,
                sounds,
                native,
                cancel,
                progress,
            )
        };
        match whole(true, &mut progress) {
            Err(error)
                if error != "cancelled"
                    && !cancel.load(Ordering::Acquire)
                    && is_native_encoder_error(&error) =>
            {
                crate::log::warn(
                    "export",
                    format!("the whole export failed ({error}); exporting it again with FFmpeg's encoder"),
                );
                whole(false, &mut progress)?;
            }
            other => other?,
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    std::fs::rename(&temporary.0, output).map_err(|error| error.to_string())?;
    if let Some((chunks, sound)) = made {
        let dir = chunk_folder(cache, project, options, plan);
        // Its chunks are in the file now, which the next export copies them out of.
        crate::chunks::tidy(&dir, &[], options.format.extension());
        if let Err(error) =
            crate::chunks::Manifest::save(&dir, output, project.fps(), &chunks, sound)
        {
            crate::log::warn(
                "export",
                format!("couldn't remember the export's chunks: {error}"),
            );
        }
    }
    Ok(())
}

/// Exports `project` to `output` in chunks (`chunks.rs`): the chunks that are
/// in the last export (or left by a run that stopped) are copied, the rest
/// rendered, and the sound mixed again only when something heard changed.
/// Says which chunks the file is made of and the sound's key.
#[allow(clippy::too_many_arguments)]
fn export_chunked(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    settings: WriterOptions,
    output: &Path,
    cache: &Path,
    sounds: &HashMap<String, PathBuf>,
    reuse_last: bool,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(Vec<crate::chunks::Chunk>, Option<String>), String> {
    use crate::chunks::{self, Piece};
    let _first = crate::media::foreground();
    let fps = project.fps();
    let seconds = plan.seconds(fps);
    let extension = options.format.extension();
    let dir = chunk_folder(cache, project, options, plan);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let framed = framing(project, options, plan);
    let mut key = format!(
        "{:?}|{}x{}|{}|{}|{}",
        options.format, plan.width, plan.height, settings.bitrate, settings.key_interval, fps
    );
    if let Some(framed) = framed {
        key.push_str(&format!("|{:?}", framed.fill));
    }
    let list = crate::log::time_on("export", "export: chunks", &project.id, || {
        Ok::<_, String>(chunks::split(project, plan, &key))
    })?;
    let last = chunks::Manifest::load(&dir, fps).filter(|_| reuse_last);
    // A chunk kept from a run that stopped is reused only when it's whole: it
    // opens and has the frames its place in the plan says. A short or long one
    // went into every export of its stretch, failing each join ("joined 33826
    // frames, not 33786", Marc) until the folder was cleared days later.
    let kept: Vec<(PathBuf, i64)> = list
        .iter()
        .map(|chunk| (chunks::made(&dir, &chunk.key, extension), chunk.frames()))
        .filter(|(file, _)| file.exists())
        .collect();
    for (file, why) in chunks::not_whole(&kept) {
        crate::log::warn(
            "export",
            format!(
                "export: a kept chunk isn't whole ({why}); rendering it again: {}",
                file.display()
            ),
        );
        let _ = std::fs::remove_file(&file);
    }
    let mut pieces = Vec::new();
    let mut todo = Vec::new();
    let mut copied = 0;
    for chunk in &list {
        let file = chunks::made(&dir, &chunk.key, extension);
        if file.exists() {
            copied += chunk.frames();
            pieces.push((Piece::File(file), chunk.frames()));
            continue;
        }
        if let Some((last, saved)) = last.as_ref().and_then(|last| {
            last.find(&chunk.key)
                .filter(|saved| saved.frames == chunk.frames())
                .map(|saved| (last, saved))
        }) {
            copied += chunk.frames();
            pieces.push((
                Piece::Old {
                    file: last.output.clone(),
                    at: saved.at,
                },
                chunk.frames(),
            ));
            continue;
        }
        todo.push(chunk);
        pieces.push((Piece::File(file), chunk.frames()));
    }
    // Chunks of other exports, and any cut short, go.
    chunks::tidy(&dir, &list.iter().collect::<Vec<_>>(), extension);
    // What's to come, for smooth playback to serve each chunk as it lands.
    chunks::write_plan(&dir, &list, extension)?;
    // Smooth playback's from the viewer's playhead on, then what's before it.
    if let Some(focus) = plan.focus {
        todo.sort_by_key(|chunk| chunks::focus_order(chunk, focus));
    }
    let parts = if plan.audio {
        crate::mix::parts(
            &heard_segments(project, plan.start, plan.end),
            |media| sound_path(project, sounds, media),
            plan.start as f64 / fps,
            seconds,
        )
    } else {
        Vec::new()
    };
    let sound_key = (!parts.is_empty()).then(|| sound_key(options, &parts, seconds));
    let old_sound = last
        .as_ref()
        .filter(|last| sound_key.is_some() && last.sound == sound_key)
        .map(|last| last.output.clone());
    crate::log::info(
        "export",
        format!(
            "export: {} of {} chunks ({} of {} frames) already made; the sound {}; the video on {}",
            list.len() - todo.len(),
            list.len(),
            copied,
            plan.end - plan.start,
            match (&sound_key, &old_sound) {
                (None, _) => "isn't needed",
                (Some(_), Some(_)) => "is the last export's",
                (Some(_), None) => "is mixed again",
            },
            ChunkWriter::encoder(settings.hevc)
        ),
    );
    let rendering = todo.iter().map(|chunk| chunk.frames()).sum::<i64>() as f32;
    let total = (plan.end - plan.start).max(1) as f32;
    let sound_share = if sound_key.is_some() && old_sound.is_none() {
        0.05
    } else {
        0.0
    };
    let picture_share = (1.0 - sound_share) * (rendering / total);
    let sound_file = beside(output, ".sound.m4a");
    let mixing = sound_key.is_some() && old_sound.is_none();
    // Focused (smooth playback, played as each chunk lands): the chunks
    // around the first minute from the playhead are rendered before the
    // sound's mix, the rest after it. The mix first held a 26-minute edit's
    // first chunk back 2 minutes (Nov 2).
    let (first, rest): (Vec<&chunks::Chunk>, Vec<&chunks::Chunk>) = match plan.focus {
        Some(_) if mixing => {
            let mut frames = 0;
            let ahead = (fps * FOCUS_AHEAD_SECONDS).round() as i64;
            todo.iter().partition(|chunk| {
                let take = frames < ahead;
                frames += chunk.frames();
                take
            })
        }
        _ => (Vec::new(), todo.clone()),
    };
    let rendered = (first.iter().map(|chunk| chunk.frames()).sum::<i64>() as f32
        / rendering.max(1.0))
        * picture_share;
    let render_these = |these: &[&chunks::Chunk],
                        from: f32,
                        share: f32,
                        cancel: &AtomicBool,
                        progress: &mut dyn FnMut(f32)|
     -> Result<(), String> {
        if these.is_empty() {
            return Ok(());
        }
        let ranges: Vec<(i64, i64)> = these.iter().map(|chunk| (chunk.start, chunk.end)).collect();
        let sink = Sink::Chunks(ChunkSink {
            todo: these
                .iter()
                .map(|chunk| {
                    (
                        chunk.start,
                        chunk.end,
                        chunks::made(&dir, &chunk.key, extension),
                    )
                })
                .collect(),
            open: None,
            size: (plan.width, plan.height),
            framing: framed,
            fps,
            settings: WriterOptions {
                faststart: false,
                ..settings
            },
        });
        crate::log::time_on("export", "export: native video", &project.id, || {
            render_frames(project, &ranges, sink, cache, cancel, &mut |done| {
                progress(from + done * share)
            })
        })
    };
    render_these(&first, 0.0, rendered, cancel, &mut *progress)?;
    let mix = |cancel: &AtomicBool, progress: &mut dyn FnMut(f32)| {
        mix_sound(
            project,
            options,
            &parts,
            seconds,
            &sound_file.0,
            Some(&dir.join("sound")),
            cancel,
            progress,
        )
    };
    if mixing {
        // The mix runs beside the picture: on mandalorian it was 2.9 s of a
        // 13 s minute's export, all of it before the first frame, and about 1
        // s of 10.8 on kenobi (M1, Nov 17).
        let background = crate::media::is_background();
        // The sound's share done, as f32 bits: the picture's thread reports both.
        let heard = std::sync::atomic::AtomicU32::new(0);
        // Either half failing stops the other (as the user's cancel stops
        // both): a sound that couldn't be mixed let the whole picture render
        // before the export said so, a picture that failed waited out the mix.
        let stop = AtomicBool::new(false);
        let ended = AtomicBool::new(false);
        let (sound, picture) = std::thread::scope(|scope| {
            // However this ends, the mix is told to stop too: a panic in the picture's half ended the watch below, so
            // the export waited out the whole mix with its Cancel never reaching it.
            struct Ended<'a>(&'a AtomicBool, &'a AtomicBool);
            impl Drop for Ended<'_> {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Release);
                    if std::thread::panicking() {
                        self.1.store(true, Ordering::Release);
                    }
                }
            }
            let _ended = Ended(&ended, &stop);
            scope.spawn(|| {
                while !ended.load(Ordering::Acquire) {
                    if cancel.load(Ordering::Acquire) {
                        stop.store(true, Ordering::Release);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
            // The export's decoders, so its Cancel ends the ones the mix starts too.
            let decoders = crate::util::decoders();
            let sound = scope.spawn(|| {
                let run = || {
                    crate::util::with_decoders(decoders, || {
                        mix(&stop, &mut |done| {
                            heard.store(done.to_bits(), Ordering::Release)
                        })
                    })
                };
                let mixed = if background {
                    crate::media::as_background(run)
                } else {
                    run()
                };
                if mixed.is_err() {
                    stop.store(true, Ordering::Release);
                }
                mixed
            });
            let mut picture_done = 0.0_f32;
            let mut tell = |picture: f32| {
                let sound = f32::from_bits(heard.load(Ordering::Acquire));
                progress(rendered + sound * sound_share + picture * (picture_share - rendered));
            };
            let picture = render_these(&rest, 0.0, 1.0, &stop, &mut |done| {
                picture_done = done;
                tell(done);
            });
            if picture.is_err() {
                stop.store(true, Ordering::Release);
            }
            // The picture done first (all of it copied, a change heard alone): the bar follows the mix.
            while !sound.is_finished() {
                std::thread::sleep(Duration::from_millis(200));
                tell(if picture.is_ok() { 1.0 } else { picture_done });
            }
            let sound = sound
                .join()
                .unwrap_or_else(|_| Err("the sound's mix stopped".to_owned()));
            (sound, picture)
        });
        stopped_together(picture, sound, cancel)?;
    } else {
        if mixing {
            mix(cancel, &mut |done| progress(rendered + done * sound_share))?;
        }
        render_these(
            &rest,
            rendered + sound_share,
            picture_share - rendered,
            cancel,
            &mut *progress,
        )?;
    }
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    // Chunks joined without re-encoding need one codec setup: each file's
    // read once (every chunk copied from the last export is the same file,
    // probed again for each: 45 ms a probe).
    let mut setups = HashSet::new();
    let mut probed = HashSet::new();
    for (piece, _) in &pieces {
        let file: &Path = match piece {
            Piece::File(path) => path,
            Piece::Old { file, .. } => file,
        };
        if !probed.insert(file) {
            continue;
        }
        setups.insert(chunks::setup_hash(file)?);
        if setups.len() > 1 {
            return Err("chunks were encoded with different settings".to_owned());
        }
    }
    let old = match &last {
        Some(last)
            if pieces
                .iter()
                .any(|(piece, _)| matches!(piece, Piece::Old { .. })) =>
        {
            chunks::old_file(&last.output)?
        }
        _ => chunks::OldFile::default(),
    };
    let chapters = crate::export::chapters_file(options, plan, fps)
        .map(|text| -> Result<ExportFile, String> {
            let file = beside(output, ".chapters.txt");
            std::fs::write(&file.0, text).map_err(|error| error.to_string())?;
            Ok(file)
        })
        .transpose()?;
    let concat = beside(output, ".chunks.txt");
    std::fs::write(&concat.0, chunks::concat_list(&pieces, fps, &old)?)
        .map_err(|error| error.to_string())?;
    let sound = match (&sound_key, &old_sound) {
        (None, _) => None,
        (Some(_), Some(old)) => Some(old.as_path()),
        (Some(_), None) => Some(sound_file.0.as_path()),
    };
    crate::log::time_on("export", "export: join", &project.id, || {
        join_chunks(
            options,
            &concat.0,
            sound,
            chapters.as_ref().map(|file| file.0.as_path()),
            output,
        )
    })?;
    let frames = chunks::frames_in(output)?;
    if frames != plan.end - plan.start {
        return Err(format!(
            "the joined export has {frames} frames, not {}",
            plan.end - plan.start
        ));
    }
    progress(1.0);
    Ok((list, sound_key))
}

/// Joins the chunks in the concat list `list`, the sound (its first sound
/// stream: a mix or the last export) and chapters into `output`.
fn join_chunks(
    options: &ExportOptions,
    list: &Path,
    sound: Option<&Path>,
    chapters: Option<&Path>,
    output: &Path,
) -> Result<(), String> {
    let mut command = crate::util::ffmpeg_command();
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(list);
    let mut inputs = 1;
    if let Some(sound) = sound {
        command.arg("-i").arg(sound);
        inputs += 1;
    }
    if let Some(chapters) = chapters {
        command.args(["-f", "ffmetadata", "-i"]).arg(chapters);
    }
    command.args(["-map", "0:v:0"]);
    if sound.is_some() {
        command.args(["-map", "1:a:0"]);
    }
    // The chapters file's metadata, not none: `-map_metadata -1` also drops
    // the chapters' titles, so every chapter came out unnamed (Oct 31). The
    // file holds no tags of its own, so the export still carries none.
    if chapters.is_some() {
        command.args([
            "-map_chapters",
            &inputs.to_string(),
            "-map_metadata",
            &inputs.to_string(),
        ]);
    } else {
        command.args(["-map_chapters", "-1", "-map_metadata", "-1"]);
    }
    command.args(["-c", "copy"]);
    if options.format == Format::Hevc {
        command.args(["-tag:v", "hvc1"]);
    }
    let result = command
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(output)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !result.status.success() {
        return Err(
            crate::util::ffmpeg_said(&String::from_utf8_lossy(&result.stderr))
                .unwrap_or_else(|| "joining the chunks failed".to_owned()),
        );
    }
    Ok(())
}

/// Audio that's heard (unmuted, from media with sound) and overlaps frames `[start, end)`.
pub fn heard_segments(project: &Project, start: i64, end: i64) -> Vec<AudioSegment> {
    let fps = project.fps();
    let (from, to) = (start as f64 / fps, end as f64 / fps);
    audio_segments(project)
        .into_iter()
        .filter(|segment| {
            segment.start < to
                && segment.start + segment.duration > from
                && project
                    .media(&segment.media)
                    .is_some_and(|media| media.has_audio)
        })
        .collect()
}

/// Exports `project` to `output` (written as it goes: see [`export_file`]).
pub fn export(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
) -> Result<(), String> {
    export_with(
        project,
        options,
        plan,
        output,
        cache,
        &HashMap::new(),
        true,
        cancel,
        progress,
    )
}

/// The file each heard media's sound is mixed from: its copy in `sounds`, else its own.
fn sound_path(
    project: &Project,
    sounds: &HashMap<String, PathBuf>,
    media: &str,
) -> Option<PathBuf> {
    sounds
        .get(media)
        .cloned()
        .or_else(|| project.media(media).map(|media| PathBuf::from(&media.path)))
}

/// [`export`], mixing from `sounds` where given; the picture through the
/// native encoder when `native` and it suits, else FFmpeg's.
#[allow(clippy::too_many_arguments)]
fn export_with(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    sounds: &HashMap<String, PathBuf>,
    native: bool,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    // Background previews wait until it's done.
    let _first = crate::media::foreground();
    let fps = project.fps();
    let seconds = plan.seconds(fps);
    let video = options.format.has_video();
    let chapters = crate::export::chapters_file(options, plan, fps)
        .map(|text| -> Result<ExportFile, String> {
            let file = beside(output, ".chapters.txt");
            std::fs::write(&file.0, text).map_err(|error| error.to_string())?;
            Ok(file)
        })
        .transpose()?;
    let parts = if plan.audio {
        crate::mix::parts(
            &heard_segments(project, plan.start, plan.end),
            |media| sound_path(project, sounds, media),
            plan.start as f64 / fps,
            seconds,
        )
    } else {
        Vec::new()
    };
    let sound = !parts.is_empty();
    // What's put together at the end, if anything: the sound and chapters
    // join the picture without re-encoding it.
    let joined = video && (sound || chapters.is_some());
    let sound_file = (video && sound).then(|| {
        beside(
            output,
            if options.format == Format::Prores {
                ".sound.wav"
            } else {
                ".sound.m4a"
            },
        )
    });
    let picture_file =
        joined.then(|| beside(output, &format!(".picture.{}", options.format.extension())));
    // The sound first, then the picture. Mixing beside the picture's decoders
    // made both slower (AVFoundation's readers contend): a 2-minute edit's
    // 126 sounds mix in ~1.3 s alone but took ~45 s alongside its video.
    // The sound's share of the progress is its share of the time, roughly.
    let share = if video { 0.05 } else { 1.0 };
    if sound {
        let destination = sound_file.as_ref().map_or(output, |file| file.0.as_path());
        mix_sound(
            project,
            options,
            &parts,
            seconds,
            destination,
            None,
            cancel,
            &mut |done| progress(done * share),
        )?;
    }
    let before = if sound { share } else { 0.0 };
    if video {
        let destination = picture_file
            .as_ref()
            .map_or(output, |file| file.0.as_path());
        render_picture(
            project,
            options,
            plan,
            destination,
            !joined,
            native,
            cache,
            cancel,
            &mut |done| progress(before + done * (1.0 - before)),
        )?;
    }
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    if let Some(picture_file) = &picture_file {
        crate::log::time_on("export", "export: join", &project.id, || {
            join(
                options,
                &picture_file.0,
                sound_file.as_ref().map(|file| file.0.as_path()),
                chapters.as_ref().map(|file| file.0.as_path()),
                output,
            )
        })?;
    }
    Ok(())
}

/// Mixes `parts` (`seconds` long) into `destination`: the file itself for a
/// sound format, else the sound a join copies in.
/// `blocks`: where a chunked export keeps its sound a minute at a time
/// (`mix::render_kept`): smooth playback's renders (background exports)
/// only, whose sound nothing measures for loudness; a real export's sound is
/// mixed and encoded whole, as before.
#[allow(clippy::too_many_arguments)]
fn mix_sound(
    project: &Project,
    options: &ExportOptions,
    parts: &[crate::mix::Part],
    seconds: f64,
    destination: &Path,
    blocks: Option<&Path>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    let video = options.format.has_video();
    let scratch = beside(destination, ".mix.f32");
    let codec = crate::export::audio_args(options);
    let encoding = crate::mix::Encoding {
        codec: &codec,
        // MP4's AAC goes into an .m4a that the join copies.
        aac: (video && matches!(options.format, Format::H264 | Format::Hevc))
            .then(|| options.sound_bitrate()),
    };
    // Written beside it, then renamed into place whole: smooth playback plays
    // the mix the moment it's there, and it was there half-written (Nov 2).
    // (Its own extension kept: a WAV or MP3 export's mix is its file.)
    let extension = destination.extension().map_or_else(
        || "m4a".to_owned(),
        |ext| ext.to_string_lossy().into_owned(),
    );
    let mixing = beside(destination, &format!(".mixing.{extension}"));
    crate::log::time_on("export", "export: sound", &project.id, || {
        crate::util::killed_on_cancel(cancel, || {
            let total = (seconds * crate::mix::RATE as f64).round() as usize;
            match (blocks, options.target_loudness(), encoding.aac) {
                (Some(blocks), None, Some(bitrate)) if crate::media::is_background() => {
                    crate::mix::render_kept(
                        parts, total, bitrate, &mixing.0, blocks, cancel, progress,
                    )
                }
                (_, loudness, _) => crate::mix::render(
                    parts, total, loudness, &encoding, &mixing.0, &scratch.0, cancel, progress,
                ),
            }
        })
    })?;
    std::fs::rename(&mixing.0, destination).map_err(|error| format!("the sound's mix: {error}"))
}

/// What a mix of `parts` sounds like, as a key: the parts (their files by
/// content), the loudness and the codec. The same key is the same sound.
pub fn sound_key(options: &ExportOptions, parts: &[crate::mix::Part], seconds: f64) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    "sound-v2".hash(&mut hasher);
    env!("EDIT_SOUND_SOURCE").hash(&mut hasher);
    format!("{parts:?}").hash(&mut hasher);
    for part in parts {
        crate::chunks::content_key(&part.path).hash(&mut hasher);
    }
    format!("{:?}", options.target_loudness()).hash(&mut hasher);
    crate::export::audio_args(options).hash(&mut hasher);
    options.sound_bitrate().hash(&mut hasher);
    seconds.to_bits().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Puts the picture, sound and chapters into `output` without re-encoding.
fn join(
    options: &ExportOptions,
    picture: &Path,
    sound: Option<&Path>,
    chapters: Option<&Path>,
    output: &Path,
) -> Result<(), String> {
    let mut command = crate::util::ffmpeg_command();
    command
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(picture);
    let mut inputs = 1;
    if let Some(sound) = sound {
        command.arg("-i").arg(sound);
        inputs += 1;
    }
    if let Some(chapters) = chapters {
        command.args(["-f", "ffmetadata", "-i"]).arg(chapters);
    }
    command.args(["-map", "0:v:0"]);
    if sound.is_some() {
        command.args(["-map", "1:a:0"]);
    }
    if chapters.is_some() {
        command.args(["-map_chapters", &inputs.to_string()]);
    }
    command.args(["-c", "copy"]);
    if options.format == Format::Hevc {
        command.args(["-tag:v", "hvc1"]);
    }
    if matches!(options.format, Format::H264 | Format::Hevc) {
        command.args(["-movflags", "+faststart"]);
    }
    let result = command
        .arg(output)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !result.status.success() {
        return Err(
            crate::util::ffmpeg_said(&String::from_utf8_lossy(&result.stderr))
                .unwrap_or_else(|| "joining the picture and sound failed".to_owned()),
        );
    }
    Ok(())
}

/// Renders the picture to `output`: AVFoundation's hardware encoder for the
/// standard Mac shapes, FFmpeg otherwise. `alone` means nothing is joined to
/// it afterwards (so it gets its index at the front itself).
#[allow(clippy::too_many_arguments)]
fn render_picture(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    alone: bool,
    native: bool,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    let _ = native;
    #[cfg(target_os = "macos")]
    if let Some(writer) = native
        .then(|| native_writer(project, options, plan, output, alone))
        .transpose()?
        .flatten()
    {
        crate::log::info(
            "export",
            format!(
                "export: the video in one piece on {}",
                crate::mac_media::Writer::encoder(options.format == Format::Hevc)
            ),
        );
        return crate::log::time_on("export", "export: native video", &project.id, || {
            render_frames(
                project,
                &[(plan.start, plan.end)],
                Sink::Native {
                    writer,
                    first: plan.start,
                    framing: framing(project, options, plan),
                },
                cache,
                cancel,
                progress,
            )
        });
    }
    let settings = project.settings;
    let (width, height) = (settings.width, settings.height);
    let mut command = crate::util::ffmpeg_command();
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-filter_complex_threads",
            "2",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{width}x{height}"),
            "-framerate",
            &if settings.ntsc {
                format!("{}/1001", settings.fps * 1000)
            } else {
                settings.fps.to_string()
            },
            "-i",
            "pipe:0",
            "-filter_complex",
            &crate::export::video_graph(options, (width, height), (plan.width, plan.height)),
            "-map",
            "[vout]",
        ])
        .args(crate::export::video_args(options, plan, project.fps())?);
    if alone && matches!(options.format, Format::H264 | Format::Hevc) {
        command.args(["-movflags", "+faststart"]);
    }
    command
        .args(["-threads", "2"])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut encoder = command
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let stdin = encoder.stdin.take().ok_or("ffmpeg stdin")?;
    let stderr = encoder.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let sink = Sink::Pipe {
        stdin: BufWriter::with_capacity(1 << 20, stdin),
        width,
        height,
    };
    let result = crate::log::time_on("export", "export: video", &project.id, || {
        render_frames(
            project,
            &[(plan.start, plan.end)],
            sink,
            cache,
            cancel,
            progress,
        )
    });
    if result.is_err() {
        let _ = encoder.kill();
    }
    let status = encoder.wait().map_err(|error| error.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    let said = crate::util::ffmpeg_said(&stderr);
    // A refused encoder shows here only as the frames' "stopped early": FFmpeg's reason with it (not after a
    // failure of the render's own, where FFmpeg was ended for it).
    if let Err(error) = result {
        return Err(match said {
            Some(said) if error == "the encoder stopped early" => format!("{error}: {said}"),
            _ => error,
        });
    }
    if !status.success() {
        return Err(said.unwrap_or_else(|| "encode failed".to_owned()));
    }
    Ok(())
}

/// The outcome of a picture and its sound made side by side, each stopped
/// when the other failed: the failure that stopped them, never the other's
/// "cancelled" (which would read as the user's cancel and skip the retry).
fn stopped_together(
    picture: Result<(), String>,
    sound: Result<(), String>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) && (picture.is_err() || sound.is_err()) {
        return Err("cancelled".to_owned());
    }
    match (picture, sound) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(picture), Err(sound)) => Err(if picture == "cancelled" {
            if sound == "cancelled" {
                "the picture and its sound stopped".to_owned()
            } else {
                sound
            }
        } else {
            picture
        }),
    }
}

/// The standard Mac video path encodes with AVFoundation; the compositor
/// remains shared with the browser. Nonstandard shapes/rates and
/// software-quality exports keep the compatibility encoder (None).
fn native_options(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    alone: bool,
) -> Result<Option<WriterOptions>, String> {
    if !options.hardware
        || std::env::var_os("EDIT_FFMPEG_VIDEO").is_some()
        || !matches!(options.format, Format::H264 | Format::Hevc)
        // A rate asked for that isn't the edit's own (30 for a 29.97 edit
        // too): FFmpeg's `fps` filter makes it, the chunks are the edit's rate.
        || options
            .fps
            .is_some_and(|fps| fps > 0 && (f64::from(fps) - project.fps()).abs() > 1e-9)
    {
        return Ok(None);
    }
    // Off a Mac the chunks are FFmpeg's (`pipe_writer`): HEVC needs NVENC or libx265.
    let encoders = crate::export::encoders();
    if !cfg!(target_os = "macos")
        && options.format == Format::Hevc
        && !(encoders.nvenc || encoders.hevc)
    {
        return Ok(None);
    }
    Ok(Some(WriterOptions {
        hevc: options.format == Format::Hevc,
        bitrate: crate::export::video_bitrate(options, plan, project.fps())?,
        key_interval: options.key_interval(f64::from(project.settings.fps)),
        finished: true,
        faststart: alone,
        yuv420: false,
    }))
}

/// Where an export's chunks and its manifest go (`chunks::folder`): the
/// project's own at its shape and size; a folder of its own for each other
/// shape and size, so a Vertical export neither tidies away nor takes the
/// place of the record the next full-size re-export copies its chunks from.
fn chunk_folder(cache: &Path, project: &Project, options: &ExportOptions, plan: &Plan) -> PathBuf {
    crate::chunks::folder(
        cache,
        &chunk_name(project, options, plan).unwrap_or_else(|| project.id.clone()),
    )
}

/// The name of an export's chunk folder (`chunks::folder`) when it isn't the
/// project's own: a framed export's. The server restores and clears by it.
pub fn chunk_name(project: &Project, options: &ExportOptions, plan: &Plan) -> Option<String> {
    framing(project, options, plan).map(|framed| {
        format!(
            "{}.{}x{}-{:?}",
            project.id, framed.width, framed.height, framed.fill
        )
    })
}

/// An export's other shape or size, framed on the GPU (`edit_render::frame`)
/// for the native encoders, where FFmpeg's graph (`export::video_graph`) did
/// it on the CPU: none at the project's own shape and size.
fn framing(project: &Project, options: &ExportOptions, plan: &Plan) -> Option<Framing> {
    use crate::export::{Fill as Shaped, Shape};
    let fill = match (options.shape, options.fill) {
        (Shape::Original, _) => {
            if (plan.width, plan.height) == (project.settings.width, project.settings.height) {
                return None;
            }
            edit_render::frame::Fill::Stretch
        }
        (_, Shaped::Blur) => edit_render::frame::Fill::Blur,
        (_, Shaped::Crop) => edit_render::frame::Fill::Crop,
        (_, Shaped::Black) => edit_render::frame::Fill::Black,
    };
    Some(Framing {
        width: plan.width,
        height: plan.height,
        fill,
    })
}

/// An error of the native (AVFoundation) encoder, which FFmpeg's may not
/// have: stalled, a frame rejected, a buffer it couldn't give.
fn is_native_encoder_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("native encoder")
        || lower.contains("encoder pixel buffer")
        || lower.contains("the encoder stopped early")
}

#[cfg(target_os = "macos")]
fn native_writer(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    alone: bool,
) -> Result<Option<crate::mac_media::Writer>, String> {
    let Some(settings) = native_options(project, options, plan, alone)? else {
        return Ok(None);
    };
    match crate::mac_media::Writer::open(output, plan.width, plan.height, project.fps(), settings) {
        Ok(writer) => Ok(Some(writer)),
        Err(error) => {
            crate::log::warn(
                "export",
                format!("native encoder unavailable: {error}; using FFmpeg"),
            );
            Ok(None)
        }
    }
}

/// Writes each chunk of a chunked export to its own file: `<key>.partial.mp4`
/// while it's being written, renamed to `<key>.mp4` once whole.
struct ChunkSink {
    /// Frames `[start, end)` and the file, in the order they're rendered.
    todo: VecDeque<(i64, i64, PathBuf)>,
    /// The chunk being written: its frames, file, writer and frames written.
    open: Option<(i64, i64, PathBuf, ChunkWriter, i64)>,
    size: (u32, u32),
    /// The render framed to `size` (`framing`), when that isn't the project's.
    framing: Option<Framing>,
    fps: f64,
    settings: WriterOptions,
}

impl ChunkSink {
    fn partial(path: &Path) -> PathBuf {
        path.with_extension("partial.mp4")
    }

    fn write(&mut self, frame: i64, pixels: &[u8], stride: usize) -> Result<(), String> {
        // A frame outside the open chunk is the next chunk's: after it, or
        // before it in a focused export (the playhead's chunks first, then
        // those before: Nov 2, the last chunk took frame 0 into its encoder
        // and failed, "Native encoder: The operation could not be completed").
        if self
            .open
            .as_ref()
            .is_some_and(|open| frame >= open.1 || frame < open.0)
        {
            self.close()?;
        }
        if self.open.is_none() {
            let (start, end, path) = self
                .todo
                .pop_front()
                .ok_or("a frame came after the last chunk")?;
            if frame != start {
                return Err("a chunk's frames came out of order".to_owned());
            }
            let writer = ChunkWriter::open(
                &Self::partial(&path),
                self.size.0,
                self.size.1,
                self.fps,
                self.settings,
            )?;
            self.open = Some((start, end, path, writer, 0));
        }
        let Some((start, _, _, writer, written)) = self.open.as_mut() else {
            return Err("no chunk is open".to_owned());
        };
        writer.frame(frame - *start, pixels, stride, Order::Rgba)?;
        *written += 1;
        Ok(())
    }

    /// Finishes the open chunk; one cut short is removed, never kept.
    fn close(&mut self) -> Result<(), String> {
        let Some((start, end, path, mut writer, written)) = self.open.take() else {
            return Ok(());
        };
        let partial = Self::partial(&path);
        if written != end - start {
            drop(writer);
            let _ = std::fs::remove_file(&partial);
            return Err("the export stopped part-way through a chunk".to_owned());
        }
        writer.finish(written)?;
        std::fs::rename(&partial, &path).map_err(|error| error.to_string())
    }

    fn finish(mut self) -> Result<(), String> {
        self.close()?;
        if self.todo.is_empty() {
            Ok(())
        } else {
            Err("the export stopped before every chunk was made".to_owned())
        }
    }
}

/// Where rendered frames go (on the encoder thread).
enum Sink {
    /// Frames from `first` on into one file.
    #[cfg(target_os = "macos")]
    Native {
        writer: crate::mac_media::Writer,
        first: i64,
        framing: Option<Framing>,
    },
    /// Each chunk into its own file (`chunks.rs`).
    Chunks(ChunkSink),
    Pipe {
        stdin: BufWriter<ChildStdin>,
        width: u32,
        height: u32,
    },
}

impl Sink {
    /// The framing the frames are rendered to (`framing`).
    fn framing(&self) -> Option<Framing> {
        match self {
            #[cfg(target_os = "macos")]
            Sink::Native { framing, .. } => *framing,
            Sink::Chunks(chunks) => chunks.framing,
            Sink::Pipe { .. } => None,
        }
    }

    /// Takes its frames as the GPU's 4:2:0 (`Renderer::copy_output_yuv420_to`)
    /// when it can: the chunks of a `width`×`height` render, FFmpeg's off a
    /// Mac and AVAssetWriter's (as 420v) on one.
    fn take_yuv420(&mut self, width: u32, height: u32) -> bool {
        if let Sink::Chunks(chunks) = self {
            chunks.settings.yuv420 =
                chunks.size == (width, height) && Renderer::yuv420_fits(width, height);
            return chunks.settings.yuv420;
        }
        let _ = (width, height);
        false
    }

    /// Timeline frame `frame` (RGBA, rows `stride` bytes apart; or 4:2:0
    /// planes after `take_yuv420`).
    fn write(&mut self, _frame: i64, pixels: &[u8], stride: usize) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            Sink::Native { writer, first, .. } => {
                writer.frame(_frame - *first, pixels, stride, Order::Rgba)
            }
            Sink::Chunks(chunks) => chunks.write(_frame, pixels, stride),
            Sink::Pipe {
                stdin,
                width,
                height,
            } => {
                let row = *width as usize * 4;
                for line in pixels.chunks(stride).take(*height as usize) {
                    stdin
                        .write_all(line.get(..row).ok_or("GPU readback came back short")?)
                        .map_err(|_| "the encoder stopped early".to_owned())?;
                }
                Ok(())
            }
        }
    }

    fn finish(self, _frames: i64) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            Sink::Native { mut writer, .. } => writer.finish(_frames),
            Sink::Chunks(chunks) => chunks.finish(),
            Sink::Pipe { mut stdin, .. } => stdin
                .flush()
                .map_err(|_| "the encoder stopped early".to_owned()),
        }
    }
}

/// Decoder threads per export: one plays the current clip while the others
/// open and seek the next ones.
const DECODERS: usize = 3;
/// A focused export renders this much from the playhead before the sound's mix (seconds).
const FOCUS_AHEAD_SECONDS: f64 = 60.0;
/// Frames the planner (and so the decoders) may run ahead of the compositor.
const LOOKAHEAD: usize = 48;
/// Readback buffers in flight between the compositor and the encoder.
const READBACKS: usize = 3;
/// How far ahead (source seconds) a reader decodes forward rather than seeks
/// (the native reader's own limit).
const FORWARD: f64 = 2.0;

/// How the compositor gets a video layer's picture.
enum Decode {
    /// From decoder thread n (which was sent the job).
    Worker(usize),
    /// On the compositor's own thread (more clips overlap than there are decoders).
    Inline(Source, f64),
    Missing(String),
}

/// A frame the planner evaluated, and where its pictures come from.
struct Planned {
    frame: i64,
    scene: Scene,
    decodes: Vec<(String, Decode)>,
}

struct DecodeJob {
    frame: i64,
    clip: String,
    source: Source,
    time: f64,
    /// The first frame of the clip's run (always copied, never "unchanged").
    first: bool,
}

struct Decoded {
    frame: i64,
    clip: String,
    width: u32,
    height: u32,
    order: Order,
    /// None: the same picture as this clip's last.
    pixels: Option<Pixels>,
}

/// A decoded picture: in memory, or written by the decoder straight into a
/// GPU staging buffer (RGBA or BGRA rows that fit `Renderer::staged_fits`),
/// which the compositor copies into the video's texture on the GPU
/// (`Renderer::upload_video_staged`), not through `write_texture`'s copy.
enum Pixels {
    Bytes(Vec<u8>),
    Staged(wgpu::Buffer),
}

/// A staging buffer for `bytes` a decoder writes into: one the compositor
/// gave back (mapped again once the GPU copied it), else a new one mapped.
fn staging(device: &wgpu::Device, recycled: &mut Vec<wgpu::Buffer>, bytes: u64) -> wgpu::Buffer {
    if let Some(at) = recycled.iter().position(|buffer| buffer.size() == bytes) {
        return recycled.swap_remove(at);
    }
    // Another size now (the next clip's): the last one's buffers go, not kept to the export's end.
    recycled.retain(|buffer| buffer.size() == bytes);
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("edit decoded frame"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_WRITE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: true,
    })
}

/// One decoder thread: decodes its jobs in order, recycling pixel buffers.
/// It keeps one reader open (each holds a hardware decoder and its buffers):
/// a clip in the same file carries on with it (the planner sends jump cuts to
/// the decoder already in that file), any other opens a new one.
fn decoder(
    jobs: mpsc::Receiver<DecodeJob>,
    out: mpsc::SyncSender<Result<Decoded, String>>,
    recycle: mpsc::Receiver<Pixels>,
    device: wgpu::Device,
) {
    let mut current: Option<(String, VideoReader)> = None;
    let mut spare: Vec<Vec<u8>> = Vec::new();
    let mut staged: Vec<wgpu::Buffer> = Vec::new();
    for job in jobs {
        if job.first || current.as_ref().is_none_or(|(clip, _)| *clip != job.clip) {
            let reader = match current.take() {
                Some((_, reader)) if reader.source.key == job.source.key => reader,
                _ => VideoReader::open(job.source.clone()),
            };
            current = Some((job.clip.clone(), reader));
        }
        let Some((_, reader)) = current.as_mut() else {
            break;
        };
        for given in recycle.try_iter() {
            match given {
                Pixels::Bytes(buffer) => spare.push(buffer),
                Pixels::Staged(buffer) => staged.push(buffer),
            }
        }
        let key = &job.source.key;
        // BGRA only: a Mac's reader turns BGRA into RGBA in place, reading
        // back what it wrote, and mapped memory is only ever written.
        let stage = key.order == Order::Bgra && Renderer::staged_fits(key.width);
        let decoded = if stage {
            let buffer = staging(&device, &mut staged, job.source.bytes() as u64);
            let changed = match buffer.slice(..).get_mapped_range_mut() {
                Ok(mut view) => reader.frame_into_mapped(job.time, view.slice(..), !job.first),
                Err(error) => Err(format!("a decoded frame's buffer: {error}")),
            };
            changed.map(|changed| {
                if changed {
                    buffer.unmap();
                    Some(Pixels::Staged(buffer))
                } else {
                    staged.push(buffer);
                    None
                }
            })
        } else {
            let mut buffer = spare.pop().unwrap_or_default();
            buffer.resize(job.source.bytes(), 0);
            reader
                .frame_into(job.time, &mut buffer, !job.first)
                .map(|changed| {
                    if changed {
                        Some(Pixels::Bytes(buffer))
                    } else {
                        spare.push(buffer);
                        None
                    }
                })
        };
        let result = decoded.map(|pixels| Decoded {
            frame: job.frame,
            clip: job.clip,
            width: job.source.key.width,
            height: job.source.key.height,
            order: job.source.key.order,
            pixels,
        });
        let failed = result.is_err();
        if out.send(result).is_err() || failed {
            break;
        }
    }
}

/// The planner: evaluates each frame, gives each clip's run to a free decoder
/// (the one idle longest, so it can get ahead), and passes the frame on.
fn planner(
    project: &Project,
    ranges: &[(i64, i64)],
    jobs: Vec<mpsc::Sender<DecodeJob>>,
    planned: mpsc::SyncSender<Planned>,
    cancel: &AtomicBool,
) {
    let (width, height) = (project.settings.width, project.settings.height);
    let mut sources: HashMap<String, Source> = HashMap::new();
    let mut assigned: HashMap<String, Option<usize>> = HashMap::new();
    // Each decoder's current clip, and the frame its last run ended on.
    let mut decoders: Vec<(Option<String>, i64)> = vec![(None, i64::MIN); jobs.len()];
    // Where each decoder's reader was left: file and source seconds.
    let mut left: Vec<Option<(PathBuf, f64)>> = vec![None; jobs.len()];
    for frame in ranges.iter().flat_map(|&(from, to)| from..to) {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        let scene = evaluate_seen(project, frame);
        let mut decodes = Vec::new();
        let present: HashSet<&String> = scene
            .layers
            .iter()
            .filter_map(|layer| match layer {
                Layer::Video { clip, .. } => Some(clip),
                _ => None,
            })
            .collect();
        // A clip that's gone has finished its run: its decoder is free for
        // the clips starting on this frame.
        for (busy, ended) in &mut decoders {
            if busy.as_ref().is_some_and(|clip| !present.contains(clip)) {
                *busy = None;
                *ended = frame;
            }
        }
        assigned.retain(|clip, _| present.contains(clip));
        for layer in &scene.layers {
            let Layer::Video {
                clip,
                media,
                source_time,
                ..
            } = layer
            else {
                continue;
            };
            let source = match sources.get(media) {
                Some(source) => source.clone(),
                None => match project.media(media) {
                    Some(found) => {
                        let path = PathBuf::from(&found.path);
                        let size = decode_size(found, width, height);
                        let order = decode_order(found, &path, size);
                        let source = Source::new(found, path, size, order);
                        sources.insert(media.clone(), source.clone());
                        source
                    }
                    None => {
                        decodes.push((
                            clip.clone(),
                            Decode::Missing(format!("unknown media {media}")),
                        ));
                        continue;
                    }
                },
            };
            let (worker, first) = match assigned.get(clip) {
                Some(Some(worker)) => (Some(*worker), false),
                // Decoded inline (none was free), or new: a free decoder takes it.
                _ => {
                    // A jump cut forward in the file a free decoder just read
                    // continues there (decoding the gap costs less than a
                    // seek); otherwise the decoder idle longest gets ahead.
                    let continues = |index: usize| {
                        left.get(index)
                            .and_then(Option::as_ref)
                            .is_some_and(|(path, at)| {
                                *path == source.key.path
                                    && *source_time >= *at
                                    && *source_time - *at <= FORWARD
                            })
                    };
                    let free = decoders
                        .iter()
                        .enumerate()
                        .filter(|(_, (busy, _))| busy.is_none())
                        .min_by_key(|(index, (_, ended))| (!continues(*index), *ended))
                        .map(|(index, _)| index);
                    if let Some((busy, _)) = free.and_then(|index| decoders.get_mut(index)) {
                        *busy = Some(clip.clone());
                    }
                    assigned.insert(clip.clone(), free);
                    (free, true)
                }
            };
            let sent = worker
                .and_then(|index| jobs.get(index))
                .is_some_and(|jobs| {
                    jobs.send(DecodeJob {
                        frame,
                        clip: clip.clone(),
                        source: source.clone(),
                        time: *source_time,
                        first,
                    })
                    .is_ok()
                });
            if let Some(at) = worker
                .filter(|_| sent)
                .and_then(|index| left.get_mut(index))
            {
                *at = Some((source.key.path.clone(), *source_time));
            }
            decodes.push((
                clip.clone(),
                match worker {
                    Some(index) if sent => Decode::Worker(index),
                    _ => Decode::Inline(source, *source_time),
                },
            ));
        }
        if planned
            .send(Planned {
                frame,
                scene,
                decodes,
            })
            .is_err()
        {
            break;
        }
    }
}

/// A frame read back for the encoder: the buffer it's in and when it's ready.
struct Readback {
    /// The timeline frame.
    frame: i64,
    slot: usize,
    submission: wgpu::SubmissionIndex,
    mapped: mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
}

/// Renders the frames of `ranges` (timeline frames `[from, to)`, in order)
/// into `sink`, finishing it.
fn render_frames(
    project: &Project,
    ranges: &[(i64, i64)],
    sink: Sink,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    crate::util::killed_on_cancel(cancel, || {
        render_frames_watched(project, ranges, sink, cache, cancel, progress)
    })
}

fn render_frames_watched(
    project: &Project,
    ranges: &[(i64, i64)],
    mut sink: Sink,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    let mut renderer = new_renderer(project.settings.width, project.settings.height)?;
    renderer.set_framing(sink.framing());
    let (width, height) = renderer.picture_size();
    let device = renderer.device().clone();
    let row = renderer.output_row_bytes() as usize;
    let yuv420 = sink.take_yuv420(width, height);
    let buffers: Vec<wgpu::Buffer> = (0..READBACKS)
        .map(|_| {
            if yuv420 {
                renderer.yuv420_buffer()
            } else {
                renderer.output_buffer()
            }
        })
        .collect();
    let total = ranges
        .iter()
        .map(|(from, to)| to - from)
        .sum::<i64>()
        .max(1);
    std::thread::scope(|scope| {
        let _kill = crate::util::KillOnPanic::new();
        let (planned_tx, planned) = mpsc::sync_channel::<Planned>(LOOKAHEAD);
        let mut job_senders = Vec::new();
        let mut outputs = Vec::new();
        let mut recyclers = Vec::new();
        for _ in 0..DECODERS {
            let (job_tx, job_rx) = mpsc::channel::<DecodeJob>();
            let (out_tx, out_rx) = mpsc::sync_channel(2);
            let (recycle_tx, recycle_rx) = mpsc::channel::<Pixels>();
            let decoders = crate::util::decoders();
            let device = device.clone();
            scope.spawn(move || {
                crate::util::with_decoders(decoders, || decoder(job_rx, out_tx, recycle_rx, device))
            });
            job_senders.push(job_tx);
            outputs.push(out_rx);
            recyclers.push(recycle_tx);
        }
        scope.spawn(move || planner(project, ranges, job_senders, planned_tx, cancel));
        let (free_tx, free) = mpsc::sync_channel::<usize>(READBACKS);
        for slot in 0..READBACKS {
            let _ = free_tx.send(slot);
        }
        let (readback_tx, readbacks) = mpsc::sync_channel::<Readback>(READBACKS);
        let buffers = &buffers;
        let encoder = scope.spawn(move || -> Result<(), String> {
            let mut written = 0;
            for readback in readbacks {
                let buffer = buffers.get(readback.slot).ok_or("no readback buffer")?;
                let mapped = readback.mapped;
                loop {
                    match mapped.try_recv() {
                        Ok(result) => {
                            result.map_err(|error| format!("GPU readback failed: {error}"))?;
                            break;
                        }
                        Err(mpsc::TryRecvError::Empty) => {
                            let _ = device.poll(wgpu::PollType::Wait {
                                submission_index: Some(readback.submission.clone()),
                                timeout: Some(Duration::from_secs(1)),
                            });
                        }
                        Err(mpsc::TryRecvError::Disconnected) => {
                            return Err("GPU readback was dropped".to_owned())
                        }
                    }
                }
                let view = buffer
                    .slice(..)
                    .get_mapped_range()
                    .map_err(|error| format!("GPU readback failed: {error}"))?;
                let wrote = sink.write(readback.frame, &view, row);
                drop(view);
                buffer.unmap();
                wrote?;
                written += 1;
                if free_tx.send(readback.slot).is_err() {
                    break;
                }
            }
            sink.finish(written)
        });
        let composited = (|| -> Result<(), String> {
            let mut inline_pool = ReaderPool::new(4, 2);
            let mut inline: HashMap<String, VideoReader> = HashMap::new();
            let mut scratch = Vec::new();
            let mut last_report = Instant::now();
            // Where the compositor waited: on the planner, the decoders, the encoder.
            let (mut on_plan, mut on_decode, mut on_encode) =
                (Duration::ZERO, Duration::ZERO, Duration::ZERO);
            let started = Instant::now();
            let mut planned = planned.into_iter();
            let mut done = 0;
            loop {
                let waiting = Instant::now();
                let Some(planned) = planned.next() else {
                    break;
                };
                on_plan += waiting.elapsed();
                if cancel.load(Ordering::Acquire) {
                    return Err("cancelled".to_owned());
                }
                feed_peaks(&mut renderer, project, &planned.scene, cache);
                for (clip, decode) in &planned.decodes {
                    match decode {
                        Decode::Worker(index) => {
                            let waiting = Instant::now();
                            let decoded = outputs
                                .get(*index)
                                .ok_or("no such decoder")?
                                .recv()
                                .map_err(|_| "a decoder stopped".to_owned())??;
                            on_decode += waiting.elapsed();
                            if decoded.frame != planned.frame || decoded.clip != *clip {
                                return Err("decoding fell out of step".to_owned());
                            }
                            match decoded.pixels {
                                Some(Pixels::Bytes(pixels)) => {
                                    upload(
                                        &mut renderer,
                                        clip,
                                        decoded.width,
                                        decoded.height,
                                        &pixels,
                                        decoded.order,
                                    );
                                    if let Some(recycle) = recyclers.get(*index) {
                                        let _ = recycle.send(Pixels::Bytes(pixels));
                                    }
                                }
                                Some(Pixels::Staged(buffer)) => {
                                    renderer.upload_video_staged(
                                        clip,
                                        decoded.width,
                                        decoded.height,
                                        &buffer,
                                        decoded.order == Order::Bgra,
                                    );
                                    // Mapped again once the GPU has copied it: back to its decoder.
                                    if let Some(recycle) = recyclers.get(*index).cloned() {
                                        let back = buffer.clone();
                                        buffer.slice(..).map_async(
                                            wgpu::MapMode::Write,
                                            move |mapped| {
                                                if mapped.is_ok() {
                                                    let _ = recycle.send(Pixels::Staged(back));
                                                }
                                            },
                                        );
                                    }
                                }
                                None => {}
                            }
                        }
                        Decode::Inline(source, time) => {
                            let reader = inline
                                .entry(clip.clone())
                                .or_insert_with(|| inline_pool.take(source, *time));
                            scratch.resize(source.bytes(), 0);
                            reader.frame_into(*time, &mut scratch, false)?;
                            upload(
                                &mut renderer,
                                clip,
                                source.key.width,
                                source.key.height,
                                &scratch,
                                source.key.order,
                            );
                        }
                        Decode::Missing(error) => return Err(error.clone()),
                    }
                }
                let gone: Vec<String> = inline
                    .keys()
                    .filter(|clip| {
                        !planned.decodes.iter().any(|(active, decode)| {
                            active == *clip && matches!(decode, Decode::Inline(..))
                        })
                    })
                    .cloned()
                    .collect();
                for clip in gone {
                    if let Some(reader) = inline.remove(&clip) {
                        inline_pool.put(reader);
                    }
                }
                renderer.render(&planned.scene);
                let waiting = Instant::now();
                let slot = free.recv().map_err(|_| "the encoder stopped".to_owned())?;
                on_encode += waiting.elapsed();
                let buffer = buffers.get(slot).ok_or("no readback buffer")?;
                let submission = if yuv420 {
                    renderer.copy_output_yuv420_to(buffer)
                } else {
                    renderer.copy_output_to(buffer)
                };
                let (mapped_tx, mapped) = mpsc::channel();
                buffer
                    .slice(..)
                    .map_async(wgpu::MapMode::Read, move |result| {
                        let _ = mapped_tx.send(result);
                    });
                readback_tx
                    .send(Readback {
                        frame: planned.frame,
                        slot,
                        submission,
                        mapped,
                    })
                    .map_err(|_| "the encoder stopped".to_owned())?;
                done += 1;
                if last_report.elapsed() > Duration::from_millis(200) {
                    last_report = Instant::now();
                    progress(done as f32 / total as f32);
                }
            }
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".to_owned());
            }
            crate::log::info(
                "export",
                format!(
                    "{} frames composited in {}; waited {} on planning, {} on decoding, {} on encoding",
                    total,
                    crate::log::human(started.elapsed()),
                    crate::log::human(on_plan),
                    crate::log::human(on_decode),
                    crate::log::human(on_encode),
                ),
            );
            Ok(())
        })();
        drop(readback_tx);
        drop(outputs);
        let encoded = encoder
            .join()
            .unwrap_or_else(|_| Err("the encoder crashed".to_owned()));
        // The encoder's own error explains a compositor that found it gone;
        // any other error of the compositor's is why the encoder was left
        // with a chunk cut short (Nov 2: Kroger's export said only "the
        // export stopped part-way through a chunk", three times over, the
        // compositor's reason never logged).
        match (composited, encoded) {
            (Err(error), _) if error == "cancelled" => Err(error),
            (Err(error), Err(encoder)) if error == "the encoder stopped" => Err(encoder),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    thread_local! {
        /// Readers opened on this thread (`VideoReader::open`).
        pub(super) static OPENED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }

    /// The agent's pictures are JPEG on every system (a PNG frame was 1.4–4 MB, kept again in its session).
    #[test]
    fn agent_pictures_are_jpeg() {
        let image = RgbaImage {
            width: 64,
            height: 36,
            pixels: (0..64 * 36 * 4).map(|i| (i % 251) as u8).collect(),
        };
        let (bytes, mime) = encode_for_agent(&image).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }

    /// Two layers of one file at two sizes, played on: each keeps its pooled
    /// reader, where the second was opened (and seeked) again every frame.
    #[test]
    fn a_stacked_frame_is_its_picture_with_the_alpha_below_it() {
        // 2×1 picture over its alpha: premultiplied half red, then clear.
        let file = [
            128, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128, 255, 0, 0, 0, 255,
        ];
        let still = unstack(2, 2, &file);
        assert_eq!((still.width, still.height), (2, 1));
        assert_eq!(still.pixels, vec![255, 0, 0, 128, 0, 0, 0, 0]);
    }

    #[test]
    fn two_layers_keep_their_readers_from_frame_to_frame() {
        let dir = temp_dir("two-layers");
        let video = dir.join("bars.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=320x180:rate=30:duration=2")
            .args(["-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p"])
            .arg(&video)
            .status()
            .unwrap();
        assert!(made.success());
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "bars", "path": video, "kind": "video", "duration": 2.0,
            "width": 320, "height": 180, "fps": 30, "has_audio": false
        }))
        .unwrap();
        let big = Source::new(&media, video.clone(), (320, 180), Order::Bgra);
        let small = Source::new(&media, video.clone(), (160, 90), Order::Bgra);
        let mut pool = ReaderPool::new(12, 3);
        let before = OPENED.with(std::cell::Cell::get);
        for frame in 0..20 {
            let time = f64::from(frame) / 30.0;
            let decoded =
                decode_all(&mut pool, &[(big.clone(), time), (small.clone(), time)], 1).unwrap();
            assert_eq!(decoded.len(), 2);
        }
        assert_eq!(OPENED.with(std::cell::Cell::get) - before, 2);
    }

    /// A photo's still is taken with no seek (FFmpeg 8 gives nothing for a JPEG or PNG asked from -ss 0).
    #[test]
    fn a_photos_still_is_taken() {
        let dir = temp_dir("still");
        let photo = dir.join("photo.png");
        let made = crate::util::ffmpeg_command()
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:size=64x36",
                "-frames:v",
                "1",
            ])
            .arg(&photo)
            .status()
            .unwrap();
        assert!(made.success());
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "photo", "path": photo, "kind": "image", "duration": 5.0,
            "width": 64, "height": 36, "has_audio": false
        }))
        .unwrap();
        let out = dir.join("still.png");
        save_still(&media, 0.0, &out).unwrap();
        assert!(std::fs::metadata(&out).unwrap().len() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edit-render-{name}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 2 s 320×180 source of one flat colour, its sound a 0.8 click at `click` s.
    fn source(dir: &Path, name: &str, color: &str, click: f64) -> PathBuf {
        let path = dir.join(name);
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("color=c={color}:size=320x180:rate=30:duration=2"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!(
                "aevalsrc='if(between(t\\,{click}\\,{click}+0.002)\\,0.8\\,0)':s=48000:d=2:c=stereo"
            ))
            .args([
                "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    fn decode_video(path: &Path) -> Vec<u8> {
        let output = crate::util::ffmpeg_command()
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-vf",
                "scale=32:18",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    }

    fn decode_sound(path: &Path) -> Vec<f32> {
        let output = crate::util::ffmpeg_command()
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-map", "0:a:0", "-f", "f32le", "-ac", "2", "-ar", "48000", "-",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        output
            .stdout
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect()
    }

    fn duration(path: &Path, stream: &str) -> f64 {
        let output = crate::util::ffprobe_command()
            .args([
                "-v",
                "error",
                "-select_streams",
                stream,
                "-show_entries",
                "stream=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .unwrap()
    }

    /// Many short cuts between two files, each clip's sound with it: every
    /// frame shows the right file, the sound stays in sync with the picture,
    /// and both last exactly the span.
    #[test]
    fn exports_cuts_in_sync_with_their_sound() {
        let dir = temp_dir("export");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let mut clips = Vec::new();
        // Twelve 5-frame cuts alternating red/blue, red from 0.4 s, blue from 0.9 s.
        for index in 0..12 {
            let (media, source_in) = if index % 2 == 0 {
                ("r", 0.4)
            } else {
                ("b", 0.9)
            };
            let start = index * 5;
            clips.push(
                json!({"id": format!("v{index}"), "track": "v", "type": "video", "media": media,
                "source_in": source_in, "start": start, "duration": 5}),
            );
            clips.push(
                json!({"id": format!("a{index}"), "track": "a", "type": "audio", "media": media,
                "source_in": source_in, "start": start, "duration": 5}),
            );
        }
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [
                {"id": "r", "name": "red", "path": red, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true},
                {"id": "b", "name": "blue", "path": blue, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}
            ],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": clips,
        }))
        .unwrap();
        let options = ExportOptions::default();
        let plan = crate::export::plan(&options, &project, true).unwrap();
        let output = dir.join("out.mp4");
        export(
            &project,
            &options,
            &plan,
            &output,
            &dir,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(
            (duration(&output, "v:0") - 2.0).abs() < 0.04,
            "{}",
            duration(&output, "v:0")
        );
        assert!(
            (duration(&output, "a:0") - 2.0).abs() < 0.03,
            "{}",
            duration(&output, "a:0")
        );
        let frames = decode_video(&output);
        let pixel = 32 * 18 * 3;
        assert_eq!(frames.len(), pixel * 60);
        for frame in 0..60 {
            let middle = &frames[frame * pixel + (9 * 32 + 16) * 3..][..3];
            let red = (frame / 5) % 2 == 0;
            assert!(
                if red {
                    middle[0] > 180 && middle[2] < 80
                } else {
                    middle[2] > 180 && middle[0] < 80
                },
                "frame {frame}: {middle:?}"
            );
        }
        // Each cut plays 0.4–0.567 s of red (click at 0.5) or 0.9–1.067 of blue
        // (click at 1.0): the click sounds 0.1 s into every cut.
        let sound = decode_sound(&output);
        for index in 0..12 {
            let start = index * 5 * 48000 / 30;
            let window = &sound[start * 2..(start + 8000) * 2];
            let loudest = (0..8000)
                .max_by(|a, b| window[a * 2].abs().total_cmp(&window[b * 2].abs()))
                .unwrap();
            assert!(
                (loudest as i64 - 4800).abs() < 96,
                "cut {index}: click at {loudest} samples, expected 4800"
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Footage already in BT.709 TV-range 4:2:0 is decoded as it is and made
    /// RGBA on the GPU, and comes out the picture FFmpeg's RGBA was; other
    /// footage, and footage scaled to the frame, keeps FFmpeg's RGBA.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn footage_decoded_as_420_is_ffmpegs_picture() {
        let dir = temp_dir("decode420");
        let make = |name: &str, size: &str, vf: &str| {
            let path = dir.join(name);
            let made = crate::util::ffmpeg_command()
                .args(["-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("testsrc2=size={size}:rate=30:duration=1"))
                .args(["-vf", vf, "-c:v", "libx264", "-crf", "12"])
                .arg(&path)
                .status()
                .unwrap();
            assert!(made.success());
            path
        };
        let tagged = |matrix: &str, range: &str, format: &str, space: &str| {
            format!(
                "scale=out_color_matrix={matrix}:out_range={range},format={format},\
                 setparams=colorspace={space}:range={range}"
            )
        };
        let bt709 = make(
            "709.mp4",
            "640x360",
            &tagged("bt709", "tv", "yuv420p", "bt709"),
        );
        let big = make(
            "709-big.mp4",
            "1280x720",
            &tagged("bt709", "tv", "yuv420p", "bt709"),
        );
        let bt601 = make(
            "601.mp4",
            "640x360",
            &tagged("bt601", "tv", "yuv420p", "bt470bg"),
        );
        let full = make(
            "full.mp4",
            "640x360",
            &tagged("bt709", "pc", "yuvj420p", "bt709"),
        );
        let bare = make("bare.mp4", "640x360", "format=yuv420p");
        assert!(yuv420_source(&bt709) && yuv420_source(&big));
        assert!(!yuv420_source(&bt601) && !yuv420_source(&full) && !yuv420_source(&bare));
        let (w, h) = (640, 360);
        let mut renderer = new_renderer(w, h).unwrap();
        let scene = Scene {
            width: w,
            height: h,
            layers: vec![Layer::Video {
                clip: "c".into(),
                media: "m".into(),
                source_time: 0.0,
                transform: Default::default(),
                opacity: 1.0,
                crop: Default::default(),
                frame: None,
                blend: Default::default(),
                stacked: false,
            }],
        };
        let media = |path: &PathBuf, (width, height): (u32, u32)| -> Media {
            serde_json::from_value(json!({
                "id": "m", "name": "m", "path": path, "kind": "video", "duration": 1.0,
                "width": width, "height": height, "fps": 30, "has_audio": false
            }))
            .unwrap()
        };
        // Scaled to the frame, it keeps FFmpeg's RGBA.
        let scaled = media(&big, (1280, 720));
        assert_eq!(
            decode_order(&scaled, &big, decode_size(&scaled, w, h)),
            Order::Bgra
        );
        {
            let path = &bt709;
            let media = media(path, (w, h));
            assert_eq!(decode_order(&media, path, (w, h)), Order::Yuv420);
            let mut picture = |order: Order| {
                let source = Source::new(&media, path.clone(), (w, h), order);
                let mut reader = VideoReader::open(source.clone());
                let mut pixels = vec![0; source.bytes()];
                reader.frame_into(0.5, &mut pixels, false).unwrap();
                upload(&mut renderer, "c", w, h, &pixels, order);
                renderer.render(&scene);
                renderer.read_output().unwrap()
            };
            let (before, after) = (picture(Order::Bgra), picture(Order::Yuv420));
            let mut worst = 0;
            let mut off = 0;
            for (a, b) in before.iter().zip(&after) {
                let difference = a.abs_diff(*b);
                worst = worst.max(difference);
                off += usize::from(difference > 1);
            }
            let share = off as f64 / before.len() as f64;
            eprintln!(
                "{}: worst {worst}, {share:.4} more than 1 off",
                path.display()
            );
            assert!(worst <= 3 && share < 0.01, "worst {worst}, {share} off");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Off a Mac a chunked export's picture is converted to 4:2:0 on the GPU
    /// (`Renderer::copy_output_yuv420_to`), a whole one by FFmpeg: the two
    /// come out the same picture, tagged BT.709 TV range alike.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_gpus_420_is_ffmpegs() {
        let dir = temp_dir("yuv420");
        let bars = dir.join("bars.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=320x180:rate=30:duration=1")
            .args(["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p"])
            .arg(&bars)
            .status()
            .unwrap();
        assert!(made.success());
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [{"id": "m", "name": "bars", "path": bars, "kind": "video", "duration": 1.0,
                "width": 320, "height": 180, "fps": 30, "has_audio": false}],
            "tracks": [{"id": "v", "kind": "video"}],
            "clips": [{"id": "c", "track": "v", "type": "video", "media": "m",
                "source_in": 0.0, "start": 0, "duration": 30}],
        }))
        .unwrap();
        let options = ExportOptions {
            quality: crate::export::Quality::High,
            ..ExportOptions::default()
        };
        let plan = export_plan(&project, &options).unwrap();
        let (gpu, ffmpeg) = (dir.join("gpu.mp4"), dir.join("ffmpeg.mp4"));
        let cancel = AtomicBool::new(false);
        let cache = dir.join("cache");
        export_file(
            &project,
            &options,
            &plan,
            &gpu,
            &cache,
            &HashMap::new(),
            &cancel,
            |_| {},
        )
        .unwrap();
        export(&project, &options, &plan, &ffmpeg, &dir, &cancel, |_| {}).unwrap();
        let probe = |path: &Path| {
            let output = crate::util::ffprobe_command()
                .args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
                .args(["stream=pix_fmt,color_space,color_range,color_primaries,color_transfer"])
                .args(["-of", "csv=p=0"])
                .arg(path)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        assert_eq!(probe(&gpu), "yuv420p,tv,bt709,bt709,bt709");
        assert_eq!(probe(&gpu), probe(&ffmpeg));
        let compared = crate::util::ffmpeg_command()
            .args(["-hide_banner", "-i"])
            .arg(&gpu)
            .arg("-i")
            .arg(&ffmpeg)
            .args(["-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"])
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&compared.stderr);
        let psnr = |plane: &str| -> f64 {
            said.split(&format!(" {plane}:"))
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|value| value.parse().ok())
                .unwrap_or_else(|| panic!("no PSNR {plane} in {said}"))
        };
        eprintln!(
            "GPU against FFmpeg: Y {} U {} V {} dB",
            psnr("y"),
            psnr("u"),
            psnr("v")
        );
        for plane in ["y", "u", "v"] {
            assert!(psnr(plane) > 38.0, "{plane}: {said}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// A preview's full pool of buffers to decode into takes the size drawn
    /// now in place of one it no longer draws (a resized window).
    #[test]
    fn spare_buffers_make_way_for_the_size_drawn_now() {
        let mut spare = vec![vec![0_u8; 4]; SPARE_BUFFERS];
        for _ in 0..3 {
            keep_spare(&mut spare, vec![0_u8; 8]);
        }
        assert_eq!(spare.len(), SPARE_BUFFERS);
        assert_eq!(spare.iter().filter(|kept| kept.len() == 8).count(), 3);
        let mut full = vec![vec![0_u8; 8]; SPARE_BUFFERS];
        keep_spare(&mut full, vec![0_u8; 8]);
        assert_eq!(full.len(), SPARE_BUFFERS);
    }

    /// A shape or size other than the project's is framed on the GPU for a
    /// chunked export (`edit_render::frame`), as FFmpeg's graph frames a whole
    /// one: the same picture in the same place, as bright, for every fill.
    #[test]
    fn the_gpus_framing_is_ffmpegs() {
        use crate::export::{Fill, Shape};
        let dir = temp_dir("framing");
        let bars = dir.join("bars.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=640x360:rate=30:duration=1")
            .args(["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p"])
            .arg(&bars)
            .status()
            .unwrap();
        assert!(made.success());
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 640, "height": 360, "fps": 30},
            "media": [{"id": "m", "name": "bars", "path": bars, "kind": "video", "duration": 1.0,
                "width": 640, "height": 360, "fps": 30, "has_audio": false}],
            "tracks": [{"id": "v", "kind": "video"}],
            "clips": [{"id": "c", "track": "v", "type": "video", "media": "m",
                "source_in": 0.0, "start": 0, "duration": 15}],
        }))
        .unwrap();
        for (shape, fill, size) in [
            (Shape::Vertical, Fill::Blur, 360),
            (Shape::Square, Fill::Crop, 360),
            (Shape::Portrait, Fill::Black, 360),
            (Shape::Square, Fill::Blur, 360),
            (Shape::Original, Fill::Blur, 180),
        ] {
            let options = ExportOptions {
                shape,
                fill,
                size: Some(size),
                quality: crate::export::Quality::High,
                audio: false,
                ..ExportOptions::default()
            };
            let plan = export_plan(&project, &options).unwrap();
            let (gpu, ffmpeg) = (dir.join("gpu.mp4"), dir.join("ffmpeg.mp4"));
            let cancel = AtomicBool::new(false);
            let cache = dir.join("cache");
            export_file(
                &project,
                &options,
                &plan,
                &gpu,
                &cache,
                &HashMap::new(),
                &cancel,
                |_| {},
            )
            .unwrap();
            // Made of chunks, as the GPU frames them: not FFmpeg's whole
            // export after the chunks failed, which would compare FFmpeg with itself.
            assert!(
                chunk_folder(&cache, &project, &options, &plan)
                    .join("manifest-v1.json")
                    .is_file(),
                "{shape:?} {fill:?}: not exported in chunks"
            );
            export(&project, &options, &plan, &ffmpeg, &dir, &cancel, |_| {}).unwrap();
            let compared = crate::util::ffmpeg_command()
                .args(["-hide_banner", "-i"])
                .arg(&gpu)
                .arg("-i")
                .arg(&ffmpeg)
                .args([
                    "-lavfi",
                    "[0:v]split[a][c];[1:v]split[b][d];[a][b]psnr;[c]signalstats,metadata=print[e];[d]signalstats,metadata=print[f];[e][f]hstack",
                    "-f",
                    "null",
                    "-",
                ])
                .output()
                .unwrap();
            let said = String::from_utf8_lossy(&compared.stderr);
            let summary = said.rsplit("PSNR").next().unwrap_or_default();
            let psnr = |plane: &str| -> f64 {
                summary
                    .split(&format!(" {plane}:"))
                    .nth(1)
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_else(|| panic!("no PSNR {plane} in {said}"))
            };
            // Each plane's mean, the GPU's less FFmpeg's over the frames: a
            // colour moved (U and V swapped, a tint) shows here, not in Y.
            let drift = |plane: &str| -> f64 {
                let means: Vec<f64> = said
                    .split(&format!("lavfi.signalstats.{plane}AVG="))
                    .skip(1)
                    .filter_map(|rest| rest.split_whitespace().next()?.parse().ok())
                    .collect();
                let (gpu, ffmpeg) = means
                    .chunks(2)
                    .fold((0.0, 0.0), |(a, b), pair| (a + pair[0], b + pair[1]));
                (gpu - ffmpeg) / (means.len() / 2).max(1) as f64
            };
            eprintln!(
                "{shape:?} {fill:?} at {size}: PSNR Y {} U {} V {} dB, {:+.2} {:+.2} {:+.2} levels",
                psnr("y"),
                psnr("u"),
                psnr("v"),
                drift("Y"),
                drift("U"),
                drift("V")
            );
            assert!(psnr("y") > 36.0, "{shape:?} {fill:?}: {said}");
            // The blur's colour is the least exact (its quarter-size blur):
            // Square Blur's V 33.9 dB on these bars here (Nov 18); swapped
            // planes fall far under this, and far off in their means. A Mac's
            // chunks are VideoToolbox's, not FFmpeg's: its colour on these
            // bars at 360p is 28–38 dB for every fill, Crop and Black too (the
            // M1, Nov 18), the encoders' difference, so it's held to the means.
            if !cfg!(target_os = "macos") {
                for plane in ["u", "v"] {
                    assert!(psnr(plane) > 32.0, "{shape:?} {fill:?} {plane}: {said}");
                }
            }
            assert!(
                drift("Y").abs() < 0.75,
                "{shape:?} {fill:?}: Y {:+.2} levels",
                drift("Y")
            );
            for plane in ["U", "V"] {
                assert!(
                    drift(plane).abs() < 0.5,
                    "{shape:?} {fill:?}: {plane} {:+.2} levels",
                    drift(plane)
                );
            }
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// 100 one-second cuts alternating red and blue (`blue_at` makes those
    /// clips blue instead), each with its sound.
    fn cuts(red: &Path, blue: &Path, blue_at: &[i64], skip_first: i64) -> Project {
        let mut clips = Vec::new();
        let first = skip_first;
        for index in first..100 {
            let blue_here = index % 2 == 1 || blue_at.contains(&index);
            let media = if blue_here { "b" } else { "r" };
            let start = (index - first) * 30;
            clips.push(
                json!({"id": format!("v{index}"), "track": "v", "type": "video", "media": media,
                "source_in": 0.4 + index as f64 * 0.005, "start": start, "duration": 30}),
            );
            clips.push(json!({"id": format!("a{index}"), "track": "a", "type": "audio", "media": if index % 2 == 1 { "b" } else { "r" },
                "source_in": 0.4, "start": start, "duration": 30}));
        }
        serde_json::from_value(json!({
            "version": 1, "id": "chunky", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [
                {"id": "r", "name": "red", "path": red, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true},
                {"id": "b", "name": "blue", "path": blue, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}
            ],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": clips,
        }))
        .unwrap()
    }

    fn manifest(cache: &Path) -> crate::chunks::Manifest {
        let text = std::fs::read_to_string(
            crate::chunks::folder(cache, "chunky").join("manifest-v1.json"),
        )
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// Every frame of `output` is the colour `project` has there.
    fn shows(output: &Path, blue: impl Fn(usize) -> bool, frames: usize) {
        let decoded = decode_video(output);
        let pixel = 32 * 18 * 3;
        assert_eq!(decoded.len(), pixel * frames);
        for frame in 0..frames {
            let middle = &decoded[frame * pixel + (9 * 32 + 16) * 3..][..3];
            assert!(
                if blue(frame) {
                    middle[2] > 180 && middle[0] < 80
                } else {
                    middle[0] > 180 && middle[2] < 80
                },
                "frame {frame}: {middle:?}"
            );
        }
    }

    /// A re-export whose copies out of the last export come out wrong (Nov 2,
    /// JJ's Mom Secretly v2: the join had 105 frames too many, twice) tries
    /// again rendering those chunks, not copying them again, and stays a
    /// chunked export instead of going whole.
    #[test]
    fn a_second_try_renders_what_the_first_copied_from_the_last_export() {
        let dir = temp_dir("chunks-retry");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let run = |project: &Project, name: &str| {
            let plan = export_plan(project, &options).unwrap();
            let output = dir.join(name);
            export_file(
                project,
                &options,
                &plan,
                &output,
                &cache,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            output
        };
        let one = run(&cuts(&red, &blue, &[], 0), "one.mp4");
        // The last export spoilt where its manifest can't tell: the same size and time.
        let modified = std::fs::metadata(&one).unwrap().modified().unwrap();
        let size = std::fs::metadata(&one).unwrap().len();
        std::fs::write(&one, vec![0_u8; size as usize]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&one)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let two = run(&cuts(&red, &blue, &[96], 0), "two.mp4");
        assert_eq!(
            manifest(&cache).output,
            two,
            "made of chunks, not exported whole"
        );
        shows(
            &two,
            |frame| (frame / 30) % 2 == 1 || frame / 30 == 96,
            3000,
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// A chunk kept from a run that stopped but short of its frames (Marc's
    /// "joined 33826 frames, not 33786", never explained) is rendered again,
    /// not joined: it failed both chunked tries and sent the export whole.
    #[test]
    fn a_kept_chunk_short_of_its_frames_is_rendered_again() {
        let dir = temp_dir("chunks-kept-short");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let project = cuts(&red, &blue, &[], 0);
        let run = |name: &str| {
            let plan = export_plan(&project, &options).unwrap();
            let output = dir.join(name);
            export_file(
                &project,
                &options,
                &plan,
                &output,
                &cache,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            output
        };
        let one = run("one.mp4");
        let made = manifest(&cache);
        assert!(made.chunks.len() >= 2, "{:?}", made.chunks);
        // The second chunk's file as a stopped run would have kept it, but a
        // second short, cut from the export's start (the same encoder's setup).
        let folder = crate::chunks::folder(&cache, "chunky");
        let second = &made.chunks[1];
        let short = crate::chunks::made(&folder, &second.key, "mp4");
        let cut = crate::util::ffmpeg_command()
            .args(["-v", "error", "-y", "-i"])
            .arg(&one)
            .args(["-map", "0:v", "-c", "copy", "-frames:v"])
            .arg((second.frames - 30).to_string())
            .arg(&short)
            .status()
            .unwrap();
        assert!(cut.success());
        assert_eq!(
            crate::chunks::frames_indexed(&short).unwrap(),
            second.frames - 30
        );
        // Nothing to copy from the last export: every chunk is rendered or kept.
        std::fs::remove_file(folder.join("manifest-v1.json")).unwrap();
        let two = run("two.mp4");
        assert_eq!(
            manifest(&cache).output,
            two,
            "made of chunks, not exported whole"
        );
        shows(&two, |frame| (frame / 30) % 2 == 1, 3000);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Smooth playback's render (a background export) keeps its sound a
    /// minute at a time: the file's sound is the edit's length, and after a
    /// change to the edit's last seconds only the last minute is made again.
    #[test]
    fn smooth_playback_keeps_its_sound_a_minute_at_a_time() {
        let dir = temp_dir("kept-sound");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions {
            quality: crate::export::Quality::Small,
            ..ExportOptions::default()
        };
        let cache = dir.join("cache");
        let run = |project: &Project, name: &str| {
            let plan = export_plan(project, &options).unwrap();
            let output = dir.join(name);
            crate::media::as_background(|| {
                export_file(
                    project,
                    &options,
                    &plan,
                    &output,
                    &cache,
                    &HashMap::new(),
                    &AtomicBool::new(false),
                    |_| {},
                )
            })
            .unwrap();
            output
        };
        let blocks = crate::chunks::folder(&cache, "chunky").join("sound");
        let names = || {
            let mut names: Vec<String> = std::fs::read_dir(&blocks)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        let one = run(&cuts(&red, &blue, &[], 0), "one.mp4");
        assert!(
            (duration(&one, "a:0") - 100.0).abs() < 0.05,
            "{}",
            duration(&one, "a:0")
        );
        let first = names();
        assert_eq!(first.len(), 2, "{first:?}");
        assert!(first.iter().all(|name| name.ends_with(".aac")));
        // The last second's sound quieter: only the last minute's is made again.
        let mut quieter = serde_json::to_value(cuts(&red, &blue, &[], 0)).unwrap();
        for clip in quieter["clips"].as_array_mut().unwrap() {
            if clip["id"] == "a99" {
                clip["volume_db"] = json!(-6.0);
            }
        }
        let two = run(&serde_json::from_value(quieter).unwrap(), "two.mp4");
        assert!(
            (duration(&two, "a:0") - 100.0).abs() < 0.05,
            "{}",
            duration(&two, "a:0")
        );
        let second = names();
        assert_eq!(second.len(), 2);
        assert_eq!(
            second.iter().filter(|name| first.contains(name)).count(),
            1,
            "{first:?} then {second:?}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// A focused export (smooth playback: the playhead's chunks first, then
    /// on, then those before) makes the same file as one in order: every
    /// frame where it belongs, made of chunks, not exported whole.
    #[test]
    fn a_focused_export_renders_from_the_playhead_and_joins_in_order() {
        let dir = temp_dir("focused");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let project = cuts(&red, &blue, &[], 0);
        let mut plan = export_plan(&project, &options).unwrap();
        plan.focus = Some(1500);
        let output = dir.join("focused.mp4");
        export_file(
            &project,
            &options,
            &plan,
            &output,
            &cache,
            &HashMap::new(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let made = manifest(&cache);
        // Where chunks end hangs on the fresh sources' keys (one cut in 16 may end one), so a
        // run makes two or more: two came up on Nov 5 and failed a nightly's check at ">= 3".
        assert!(made.chunks.len() >= 2, "{:?}", made.chunks);
        assert_eq!(made.output, output, "made of chunks, not exported whole");
        shows(&output, |frame| (frame / 30) % 2 == 1, 3000);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn only_the_native_encoders_failures_are_tried_again_with_ffmpeg() {
        assert!(is_native_encoder_error("Native encoder stalled"));
        assert!(is_native_encoder_error(
            "Native encoder: The operation could not be completed"
        ));
        assert!(is_native_encoder_error(
            "Cannot allocate native encoder pixel buffer"
        ));
        assert!(!is_native_encoder_error("cancelled"));
        assert!(!is_native_encoder_error(
            "No video frame at the requested source time"
        ));
    }

    #[test]
    fn a_vertical_export_keeps_the_full_size_ones_chunks_for_the_next() {
        // A Vertical export is chunked too now (framed on the GPU): in a folder of its own, it
        // left the record the next full-size re-export copies its chunks from as it was.
        let dir = temp_dir("vertical-chunks");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let cache = dir.join("cache");
        let project = cuts(&red, &blue, &[], 0);
        let run = |options: &ExportOptions, name: &str| {
            let plan = export_plan(&project, options).unwrap();
            let output = dir.join(name);
            export_file(
                &project,
                options,
                &plan,
                &output,
                &cache,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            output
        };
        let full = run(&ExportOptions::default(), "full.mp4");
        let made = manifest(&cache);
        assert_eq!(made.output, full);
        let vertical = ExportOptions {
            shape: crate::export::Shape::Vertical,
            size: Some(180),
            ..ExportOptions::default()
        };
        run(&vertical, "vertical.mp4");
        let kept = manifest(&cache);
        assert_eq!(
            kept.output, full,
            "the full-size record is the full-size export's still"
        );
        assert_eq!(kept.chunks.len(), made.chunks.len());
        std::fs::remove_dir_all(dir).ok();
    }

    /// A chunked re-export copies what didn't change out of the last export
    /// and gives the same file a whole export would: every frame, the sound
    /// the length of the picture; a trim near the start leaves later chunks
    /// as they were when the trim ends on a chunk boundary.
    #[test]
    fn a_re_export_redoes_only_the_chunks_that_changed() {
        let dir = temp_dir("chunks");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let run = |project: &Project, name: &str| {
            let plan = export_plan(project, &options).unwrap();
            let output = dir.join(name);
            export_file(
                project,
                &options,
                &plan,
                &output,
                &cache,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            output
        };
        let first = cuts(&red, &blue, &[], 0);
        let one = run(&first, "one.mp4");
        let made = manifest(&cache);
        assert!(made.chunks.len() >= 2, "{:?}", made.chunks);
        assert_eq!(made.output, one);
        shows(&one, |frame| (frame / 30) % 2 == 1, 3000);
        // Clip 96 (frames 2880 to 2909) turns blue: the chunk it's in is new,
        // and every chunk that ends before it is copied as it was. (A chunk
        // may or may not end on its first frame now: content decides.)
        let changed = cuts(&red, &blue, &[96], 0);
        let two = run(&changed, "two.mp4");
        let again = manifest(&cache);
        assert_eq!(again.output, two);
        let before_the_change = |manifest: &crate::chunks::Manifest| {
            manifest
                .chunks
                .iter()
                .filter(|chunk| chunk.at + chunk.frames < 2880)
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(before_the_change(&made), before_the_change(&again));
        let covering = |manifest: &crate::chunks::Manifest| {
            manifest
                .chunks
                .iter()
                .find(|chunk| (chunk.at..chunk.at + chunk.frames).contains(&2880))
                .map(|chunk| chunk.key.clone())
        };
        assert_ne!(covering(&made), covering(&again));
        assert_eq!(made.sound, again.sound, "only the picture changed");
        shows(
            &two,
            |frame| (frame / 30) % 2 == 1 || frame / 30 == 96,
            3000,
        );
        let first_frame = crate::util::ffprobe_command()
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-read_intervals",
                "%+#1",
                "-show_entries",
                "packet=pts_time",
                "-of",
                "csv=p=0",
            ])
            .arg(&two)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&first_frame.stdout).trim(),
            "0.000000",
            "the picture starts with the sound"
        );
        assert!((duration(&two, "v:0") - 100.0).abs() < 0.04);
        assert!(
            (duration(&two, "a:0") - 100.0).abs() < 0.05,
            "{}",
            duration(&two, "a:0")
        );
        // Trim exactly the first chunk. Trimming only one cut can move an
        // anchor below MIN_SECONDS and legitimately change later boundaries;
        // which cut is an anchor varies with the source's content key.
        let removed = again.chunks[0].frames;
        assert_eq!(removed % 30, 0);
        let skipped = removed / 30;
        let trimmed = cuts(&red, &blue, &[96], skipped);
        let three = run(&trimmed, "three.mp4");
        let last = manifest(&cache);
        assert!(
            last.chunks
                .iter()
                .all(|chunk| again.chunks.iter().any(|old| old.key == chunk.key)),
            "{:?} against {:?}",
            last.chunks,
            again.chunks
        );
        shows(
            &three,
            |frame| {
                let index = frame / 30 + skipped as usize;
                index % 2 == 1 || index == 96
            },
            (3000 - removed) as usize,
        );
        assert!(
            (duration(&three, "a:0") - (100.0 - removed as f64 / 30.0)).abs() < 0.05,
            "{}",
            duration(&three, "a:0")
        );
        // Nothing's left in the chunk folder but the manifest and the plan.
        let mut left: Vec<String> = std::fs::read_dir(crate::chunks::folder(&cache, "chunky"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["manifest-v1.json", "plan-v1.json"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_media_with_a_sound_copy_is_mixed_from_it() {
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [{"id": "m", "name": "m", "path": "https://r2/x.mp4?sig", "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}],
            "tracks": [], "clips": [],
        }))
        .unwrap();
        let sounds = HashMap::from([("m".to_owned(), PathBuf::from("/cache/sound.mov"))]);
        assert_eq!(
            sound_path(&project, &sounds, "m"),
            Some(PathBuf::from("/cache/sound.mov"))
        );
        assert_eq!(
            sound_path(&project, &HashMap::new(), "m"),
            Some(PathBuf::from("https://r2/x.mp4?sig"))
        );
    }

    /// An NTSC project (24 × 1000/1001) exports at exactly 24000/1001, its
    /// frames and sound the timeline's length at that rate.
    #[test]
    fn an_ntsc_project_exports_at_its_exact_rate() {
        let dir = temp_dir("ntsc");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "ntsc", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 24, "ntsc": true},
            "media": [{"id": "r", "name": "red", "path": red, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": [
                {"id": "v1", "track": "v", "type": "video", "media": "r", "source_in": 0.0, "start": 0, "duration": 46},
                {"id": "a1", "track": "a", "type": "audio", "media": "r", "source_in": 0.0, "start": 0, "duration": 46}
            ],
        }))
        .unwrap();
        assert!((project.fps() - 23.976_023_976).abs() < 1e-6);
        let options = ExportOptions::default();
        let plan = export_plan(&project, &options).unwrap();
        let output = dir.join("ntsc.mp4");
        let cache = dir.join("cache");
        export_file(
            &project,
            &options,
            &plan,
            &output,
            &cache,
            &HashMap::new(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let probe = crate::util::ffprobe_command()
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_packets",
                "-show_entries",
                "stream=r_frame_rate,nb_read_packets",
                "-of",
                "csv=p=0",
            ])
            .arg(&output)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&probe.stdout).trim(),
            "24000/1001,46"
        );
        let seconds = 46.0 * 1001.0 / 24000.0;
        assert!(
            (duration(&output, "v:0") - seconds).abs() < 0.01,
            "{}",
            duration(&output, "v:0")
        );
        assert!(
            (duration(&output, "a:0") - seconds).abs() < 0.03,
            "{}",
            duration(&output, "a:0")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn partial_exports_of_dead_servers_are_removed() {
        let dir = temp_dir("stale");
        let output = dir.join("out.mp4");
        let own = std::process::id();
        for name in [
            "out.mp4.999999-p.partial.mp4".to_owned(),
            format!("out.mp4.{own}-p.partial.mp4"),
            "out.mp4.999999-p.partial.mp4.sound.m4a".to_owned(),
            "out.mp4.1-p.partial.mp4".to_owned(),
            "out.mp4.999999-q.partial.mp4".to_owned(),
            "other.mp4.999999-p.partial.mp4".to_owned(),
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        remove_stale_partials(&output, "p", Format::H264);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                "other.mp4.999999-p.partial.mp4",
                "out.mp4.1-p.partial.mp4",
                "out.mp4.999999-q.partial.mp4"
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// A 2 s 30 fps 64×36 grey source whose frame n is lit 16 + 3n (flat, so
    /// nearly lossless; not lossless, which AVFoundation can't decode),
    /// so every decoded picture says which frame it is.
    fn frame_counter(dir: &Path) -> PathBuf {
        let path = dir.join("counter.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "10", "-bf", "0"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    /// A cloud address here that answers every read with a 404 at once: a
    /// read of it fails as an unreachable one does, without FFmpeg's
    /// reconnect backoff on a network error (r2.invalid: 10-20 s a read).
    fn missing_url(path: &str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                use std::io::{Read, Write};
                let mut asked = [0_u8; 4096];
                let _ = stream.read(&mut asked);
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        format!("http://127.0.0.1:{port}{path}")
    }

    /// Which frame of [`frame_counter`] a decoded RGBA picture is.
    fn counted(frame: &[u8]) -> i64 {
        // Limited-range grey 16 + 3n is full-range 3n × 255 / 219.
        (f64::from(frame[0]) * 219.0 / 255.0 / 3.0).round() as i64
    }

    /// A cloud original's reader reads a local excerpt where one holds the
    /// time, frame for frame: an excerpt cut off a keyframe, from a source
    /// with B-frames, shows the original's frame at `t` at `t - from`.
    #[test]
    fn readers_read_a_cloud_original_from_its_local_excerpt() {
        let dir = temp_dir("excerpt");
        let path = dir.join("counter-b.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "12", "-bf", "3"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        // Frame 21 (0.7 s) is no keyframe: the copy starts at 12's and hides 12–20.
        let excerpt = dir.join("excerpt.mp4");
        let cut = crate::util::ffmpeg_command()
            .args(["-v", "error", "-ss", "0.7", "-i"])
            .arg(&path)
            .args(["-t", "0.8", "-map", "0:v:0", "-c:v", "copy", "-an"])
            .arg(&excerpt)
            .status()
            .unwrap();
        assert!(cut.success());
        let object = &missing_url("/edit/originals/drive/counterB/counter-b.mp4");
        crate::excerpts::add(
            object,
            [crate::excerpts::Excerpt {
                from: 0.7,
                to: 1.5,
                path: excerpt.clone(),
            }],
        );
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": format!("{object}?sig=1"), "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, PathBuf::from(&media.path), (64, 36), Order::Rgba);
        let mut reader = VideoReader::open(source.clone());
        for n in 21..=44_i64 {
            let got = counted(reader.frame_at(n as f64 / 30.0).unwrap());
            assert_eq!(got, n, "frame {n} read on");
        }
        let mut out = vec![0; source.bytes()];
        for n in [40_i64, 22, 33] {
            let mut fresh = VideoReader::open(source.clone());
            assert!(fresh.frame_into(n as f64 / 30.0, &mut out, false).unwrap());
            assert_eq!(counted(&out), n, "frame {n} from a fresh reader");
        }
        // Through AVFoundation, not FFmpeg's fallback.
        #[cfg(target_os = "macos")]
        assert!(reader
            .excerpt
            .as_ref()
            .is_some_and(|(_, inner)| !inner.native_failed));
        // Outside it the URL is read (one that doesn't answer here).
        assert!(reader.frame_at(1.8).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    /// A reader opened before its excerpt was cut reads it once it's there:
    /// the window's player keeps its readers, and a long preview's pieces are
    /// cut after the project opens (Nov 10: those readers streamed for good).
    #[test]
    fn a_reader_open_before_an_excerpt_was_cut_reads_it_after() {
        let dir = temp_dir("excerpt-late");
        let path = dir.join("counter-late.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "15"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let cut = |from: &str, name: &str| {
            let out = dir.join(name);
            let done = crate::util::ffmpeg_command()
                .args(["-v", "error", "-ss", from, "-i"])
                .arg(&path)
                .args(["-t", "0.5", "-map", "0:v:0", "-c:v", "copy", "-an"])
                .arg(&out)
                .status()
                .unwrap();
            assert!(done.success());
            out
        };
        let object = &missing_url("/edit/pieces/v3/youtube/lateLATE01/proxy.mp4");
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": format!("{object}?sig=1"), "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, PathBuf::from(&media.path), (64, 36), Order::Rgba);
        // Opened with nothing cut: the stream, which doesn't answer here.
        let mut reader = VideoReader::open(source.clone());
        assert!(reader.excerpts.is_none());
        assert!(reader.frame_at(0.6).is_err());
        // The piece from 0.5 s is cut: the same reader reads it.
        crate::excerpts::add(
            object,
            [crate::excerpts::Excerpt {
                from: 0.5,
                to: 1.0,
                path: cut("0.5", "a.mp4"),
            }],
        );
        for n in [18_i64, 15, 29] {
            assert_eq!(
                counted(reader.frame_at(n as f64 / 30.0).unwrap()),
                n,
                "frame {n}"
            );
        }
        // And the next one, cut while that one's open; a frame of the first again after.
        let mut out = vec![0; source.bytes()];
        crate::excerpts::add(
            object,
            [crate::excerpts::Excerpt {
                from: 1.0,
                to: 1.5,
                path: cut("1.0", "b.mp4"),
            }],
        );
        for n in [31_i64, 44, 20] {
            assert!(reader.frame_into(n as f64 / 30.0, &mut out, true).unwrap());
            assert_eq!(counted(&out), n, "frame {n} after the second piece");
        }
        // Where no piece reaches, still the stream.
        assert!(reader.frame_at(1.8).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    /// A time in a piece's last half-frame is the next piece's first frame, as
    /// it is read from the stream: each piece is cut to its own frames, so the
    /// one before has no frame there (Nov 10, a long preview in the window:
    /// its last frame shown twice and the next piece's first never).
    #[test]
    fn a_time_nearest_the_next_pieces_first_frame_reads_it() {
        let dir = temp_dir("excerpt-edge");
        let path = dir.join("counter-edge.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "15"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let cut = |from: &str, name: &str| {
            let out = dir.join(name);
            let done = crate::util::ffmpeg_command()
                .args(["-v", "error", "-ss", from, "-i"])
                .arg(&path)
                .args(["-frames:v", "15", "-map", "0:v:0", "-c:v", "copy", "-an"])
                .arg(&out)
                .status()
                .unwrap();
            assert!(done.success());
            out
        };
        let object = "https://r2.invalid/edit/pieces/v3/youtube/edgeEDGE01/proxy.mp4";
        crate::excerpts::add(
            object,
            [
                crate::excerpts::Excerpt {
                    from: 0.5,
                    to: 1.0,
                    path: cut("0.5", "a.mp4"),
                },
                crate::excerpts::Excerpt {
                    from: 1.0,
                    to: 1.5,
                    path: cut("1.0", "b.mp4"),
                },
            ],
        );
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": format!("{object}?sig=1"), "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, PathBuf::from(&media.path), (64, 36), Order::Rgba);
        let mut reader = VideoReader::open(source.clone());
        let mut out = vec![0; source.bytes()];
        // Frame 29 (a's last), then a third of a frame before b: frame 30, b's first. And back.
        for (time, n) in [
            (29.0 / 30.0, 29_i64),
            (1.0 - 0.3 / 30.0, 30),
            (29.4 / 30.0, 29),
            (14.6 / 30.0, 15),
        ] {
            assert!(
                reader.frame_into(time, &mut out, false).is_ok(),
                "at {time}"
            );
            assert_eq!(counted(&out), n, "at {time}");
            assert_eq!(counted(reader.frame_at(time).unwrap()), n, "at {time}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Playing on into the next piece reads it from a reader opened and seeked to its first frame on
    /// another thread beforehand, and a piece cut elsewhere while one plays leaves the one playing open
    /// (Nov 18, kenobi: a long preview opened each minute's copy on its frame, three pictures missed).
    #[test]
    fn playing_into_the_next_piece_reads_on_from_a_reader_opened_ahead() {
        let dir = temp_dir("excerpt-next");
        let path = dir.join("counter-next.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "15"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let cut = |from: &str, name: &str| {
            let out = dir.join(name);
            let done = crate::util::ffmpeg_command()
                .args(["-v", "error", "-ss", from, "-i"])
                .arg(&path)
                .args(["-frames:v", "15", "-map", "0:v:0", "-c:v", "copy", "-an"])
                .arg(&out)
                .status()
                .unwrap();
            assert!(done.success());
            out
        };
        let piece = |from: f64, name: &str| crate::excerpts::Excerpt {
            from,
            to: from + 0.5,
            path: cut(&format!("{from}"), name),
        };
        let object = "https://r2.invalid/edit/pieces/v3/youtube/nextNEXT01/proxy.mp4";
        crate::excerpts::add(object, [piece(0.5, "a.mp4"), piece(1.0, "b.mp4")]);
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": format!("{object}?sig=1"), "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, PathBuf::from(&media.path), (64, 36), Order::Rgba);
        let opened = || OPENED.with(std::cell::Cell::get);
        let before = opened();
        let mut reader = VideoReader::open(source.clone());
        let mut out = vec![0; source.bytes()];
        for n in 15..=44_i64 {
            // The piece before is cut while a plays: a moves down the list and stays open.
            if n == 20 {
                crate::excerpts::add(object, [piece(0.0, "z.mp4")]);
            }
            assert!(
                reader.frame_into(n as f64 / 30.0, &mut out, true).unwrap(),
                "frame {n}"
            );
            assert_eq!(counted(&out), n, "frame {n}");
        }
        // The reader itself and a's on this thread; b's on the one that made it ready.
        assert_eq!(opened() - before, 2);
        assert!(reader.next.is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    /// A file cut by FFmpeg a hair before a keyframe keeps the frames from the
    /// keyframe before, marked to discard, and starts its edit after them:
    /// AVFoundation hands the last of those out at the edit's start, then the
    /// file's own first frame 1/90000 s later. Its first frame is the latter
    /// (Nov 10: a long preview's piece 20 opened on the frame before it).
    #[test]
    fn a_file_starting_after_frames_to_discard_starts_on_its_own_first_frame() {
        let dir = temp_dir("discarded-start");
        let path = dir.join("counter.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "15", "-bf", "0", "-video_track_timescale", "90000"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let cut = dir.join("cut.mp4");
        let done = crate::util::ffmpeg_command()
            .args(["-v", "error", "-ss", "0.99999", "-i"])
            .arg(&path)
            .args(["-t", "0.5", "-map", "0:v:0", "-c:v", "copy", "-an"])
            .arg(&cut)
            .status()
            .unwrap();
        assert!(done.success());
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": cut.to_string_lossy(), "kind": "video",
            "duration": 0.5, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, cut.clone(), (64, 36), Order::Rgba);
        let mut reader = VideoReader::open(source);
        for n in [0_i64, 1, 0, 2] {
            assert_eq!(
                counted(reader.frame_at(n as f64 / 30.0).unwrap()),
                30 + n,
                "frame {n}"
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// The same with NTSC's 30000/1001 and a GOP longer than a cell (CCTV,
    /// screen recordings): a cell begins on the frame grid, ⌊30·n·fps⌋, well
    /// past the keyframe before it, and every frame read from the excerpt is
    /// the very picture read from the original.
    #[test]
    fn excerpts_of_long_gops_at_ntsc_rates_read_as_the_original() {
        let dir = temp_dir("excerpt-ntsc");
        let path = dir.join("long-gop.mp4");
        let made = crate::util::ffmpeg_command()
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=96x54:rate=30000/1001:duration=40")
            .args([
                "-c:v", "libx264", "-g", "1200", "-bf", "2", "-pix_fmt", "yuv420p",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let fps = 30000.0 / 1001.0;
        // Cell 1: frame ⌊30 × 29.97⌋ = 899 on; the only keyframe before it is frame 0.
        let from = (30.0_f64 * fps + 1e-6).floor() / fps;
        let excerpt = dir.join("cell-1.mp4");
        let cut = crate::util::ffmpeg_command()
            .args(["-v", "error", "-ss", &format!("{from:.6}"), "-i"])
            .arg(&path)
            .args([
                "-t",
                &format!("{:.6}", 40.0 - from),
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-an",
            ])
            .arg(&excerpt)
            .status()
            .unwrap();
        assert!(cut.success());
        let object = "https://r2.invalid/edit/originals/drive/ntscLongGop/long-gop.mp4";
        crate::excerpts::add(
            object,
            [crate::excerpts::Excerpt {
                from,
                to: 40.0,
                path: excerpt.clone(),
            }],
        );
        let media = |at: &str| -> Media {
            serde_json::from_value(json!({
                "id": "m", "name": "m", "path": at, "kind": "video",
                "duration": 40.0, "width": 96, "height": 54, "fps": fps
            }))
            .unwrap()
        };
        let original = media(path.to_str().unwrap());
        let cloud = media(&format!("{object}?sig=1"));
        let source =
            |media: &Media| Source::new(media, PathBuf::from(&media.path), (96, 54), Order::Rgba);
        let (mut here, mut there) = (
            VideoReader::open(source(&original)),
            VideoReader::open(source(&cloud)),
        );
        for n in [899_i64, 900, 901, 950, 1100, 1180] {
            let time = n as f64 / fps;
            let want = here.frame_at(time).unwrap().to_vec();
            assert_eq!(there.frame_at(time).unwrap(), &want[..], "frame {n}");
        }
        #[cfg(target_os = "macos")]
        assert!(there
            .excerpt
            .as_ref()
            .is_some_and(|(_, inner)| !inner.native_failed));
        std::fs::remove_dir_all(dir).ok();
    }

    /// FFmpeg's reader (cloud originals, URL sources) shows the frame nearest
    /// the time asked, as the preview and the native reader do, whether it
    /// starts there or reads on to it.
    #[test]
    fn ffmpeg_reader_picks_the_nearest_frame() {
        let dir = temp_dir("nearest");
        let path = frame_counter(&dir);
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": path, "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, path.clone(), (64, 36), Order::Rgba);
        let reader = || {
            #[allow(unused_mut)]
            let mut reader = VideoReader::open(source.clone());
            #[cfg(target_os = "macos")]
            {
                reader.native_failed = true;
            }
            reader
        };
        // Fresh readers, each started in the first or second half of a frame.
        for n in [0_i64, 1, 7, 15, 31, 44, 58] {
            for offset in [-0.45, -0.2, 0.0, 0.2, 0.45] {
                let time = ((n as f64 + offset) / 30.0).max(0.0);
                let mut fresh = reader();
                let got = counted(fresh.frame_at(time).unwrap());
                assert_eq!(got, n, "started at {time:.4} s (frame {n} {offset:+})");
            }
        }
        // One reader reading on, a frame at a time and skipping, at times in
        // either half of a frame; then back.
        let mut on = reader();
        let mut times = vec![];
        for n in 3..40 {
            times.push((n, (n as f64 + if n % 2 == 0 { -0.3 } else { 0.3 }) / 30.0));
        }
        for n in [42, 47, 55, 12, 13] {
            times.push((n, (n as f64 - 0.4) / 30.0));
        }
        for (n, time) in times {
            assert_eq!(counted(on.frame_at(time).unwrap()), n, "at {time:.4} s");
        }
        // The native reader picks the same frames.
        #[cfg(target_os = "macos")]
        {
            let mut native = crate::mac_media::Reader::open(&path, 64, 36).unwrap();
            let mut frame = vec![0_u8; 64 * 36 * 4];
            for n in [0_i64, 7, 8, 9, 31, 44] {
                for offset in [-0.3, 0.3] {
                    let time = ((n as f64 + offset) / 30.0).max(0.0);
                    native.frame(time, &mut frame, Order::Rgba, false).unwrap();
                    assert_eq!(counted(&frame), n, "native at {time:.4}");
                }
            }
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_photo_reads_as_its_one_frame() {
        // FFmpeg 8 gave no picture for a JPEG or PNG read from `-ss 0`.
        let dir = temp_dir("photo");
        for name in ["photo.jpg", "photo.png"] {
            let path = dir.join(name);
            let made = crate::util::ffmpeg_command()
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=64x36",
                    "-frames:v",
                    "1",
                ])
                .arg(&path)
                .status()
                .unwrap();
            assert!(made.success());
            let media: Media = serde_json::from_value(json!({
                "id": "m", "name": "m", "path": path, "kind": "image",
                "duration": 5.0, "width": 64, "height": 36, "fps": 0
            }))
            .unwrap();
            let mut reader =
                VideoReader::open(Source::new(&media, path.clone(), (32, 18), Order::Rgba));
            let frame = reader.frame_at(2.0).unwrap();
            assert_eq!(frame.len(), 32 * 18 * 4, "{name}");
            assert!(
                frame[0] > 200 && frame[1] < 60 && frame[2] < 60,
                "{name}: {:?}",
                &frame[..4]
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_frame_asked_at_the_very_end_is_the_last_one() {
        // look_at_media sampled an 8.0 s map at 8.0 s: the seek landed past
        // the last frame and the reader failed ("failed to fill whole buffer").
        let dir = temp_dir("end");
        let path = frame_counter(&dir);
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": path, "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, path.clone(), (64, 36), Order::Rgba);
        for time in [2.0, 2.05, 1.99] {
            #[allow(unused_mut)]
            let mut reader = VideoReader::open(source.clone());
            #[cfg(target_os = "macos")]
            {
                reader.native_failed = true;
            }
            let got = counted(reader.frame_at(time).unwrap());
            assert_eq!(got, 59, "at {time:.3} s");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Times a 1080p export of footage wholly under full-frame B-roll (the
    /// footage isn't seen, so it isn't decoded). Ignored: a measurement.
    /// `cargo test -p edit-engine --release covered_footage -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_export_of_covered_footage() {
        // The export's own account of where the time went.
        struct Print;
        impl crate::log::Sink for Print {
            fn log(&self, _: crate::log::Level, area: &str, message: String) {
                if area == "export" {
                    println!("  {message}");
                }
            }
            fn record(&self, _: &str, _: &str, _: Duration, _: Option<&str>) {}
        }
        crate::log::use_sink(Box::new(Print));
        let dir = temp_dir("covered");
        let make = |name: &str, pattern: &str| {
            let path = dir.join(name);
            let made = crate::util::ffmpeg_command()
                .args(["-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("{pattern}=size=1920x1080:rate=30:duration=20"))
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-g",
                    "60",
                    "-pix_fmt",
                    "yuv420p",
                    // Tagged as most footage is (YouTube's, phones'): decoded as 4:2:0.
                    "-colorspace",
                    "bt709",
                    "-color_range",
                    "tv",
                ])
                .arg(&path)
                .status()
                .unwrap();
            assert!(made.success());
            path
        };
        let footage = make("footage.mp4", "testsrc2");
        let broll = make("broll.mp4", "testsrc");
        let project = |covered: bool| -> Project {
            let mut clips = vec![
                json!({"id": "b", "track": "v2", "type": "video", "media": "b",
                "source_in": 0.0, "start": 0, "duration": 600}),
            ];
            if covered {
                clips.push(
                    json!({"id": "f", "track": "v1", "type": "video", "media": "f",
                    "source_in": 0.0, "start": 0, "duration": 600}),
                );
            }
            serde_json::from_value(json!({
                "version": 1, "id": "p", "name": "t",
                "settings": {"width": 1920, "height": 1080, "fps": 30},
                "media": [
                    {"id": "f", "name": "footage", "path": footage, "kind": "video", "duration": 20.0, "width": 1920, "height": 1080, "fps": 30, "has_audio": false},
                    {"id": "b", "name": "broll", "path": broll, "kind": "video", "duration": 20.0, "width": 1920, "height": 1080, "fps": 30, "has_audio": false}
                ],
                "tracks": [{"id": "v1", "kind": "video"}, {"id": "v2", "kind": "video"}],
                "clips": clips,
            }))
            .unwrap()
        };
        // Nothing decoded: how fast the picture goes to the encoder alone.
        let title: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 1920, "height": 1080, "fps": 30},
            "media": [],
            "tracks": [{"id": "v1", "kind": "video"}, {"id": "v2", "kind": "video"}],
            "clips": [
                {"id": "s", "track": "v1", "type": "solid", "fill": [0.1, 0.2, 0.4, 1.0],
                    "start": 0, "duration": 600},
                {"id": "t", "track": "v2", "type": "text", "text": "A title over a colour",
                    "start": 0, "duration": 600},
            ],
        }))
        .unwrap();
        // Twice each, alternating: the first export also warms the GPU up.
        for (label, covered) in [
            ("A title alone", None),
            ("B-roll alone", Some(false)),
            ("B-roll over footage", Some(true)),
            ("A title alone", None),
            ("B-roll alone", Some(false)),
            ("B-roll over footage", Some(true)),
        ] {
            let project = covered.map_or_else(|| title.clone(), project);
            let options = ExportOptions::default();
            let plan = crate::export::plan(&options, &project, false).unwrap();
            // The app's export, in chunks; none kept from the last run.
            std::fs::remove_dir_all(crate::chunks::folder(&dir, &project.id)).ok();
            let started = Instant::now();
            export_file(
                &project,
                &options,
                &plan,
                &dir.join("out.mp4"),
                &dir,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            println!("{label}: 600 frames in {:.2?}", started.elapsed());
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Three layers cut to one: the clip starting on that frame gets one of
    /// the decoders the three just left, not the compositor's own thread.
    #[test]
    fn a_clip_after_a_layered_cut_gets_a_decoder() {
        let clip = |id: &str, track: &str, start: i64, duration: i64| {
            json!({"id": id, "track": track, "type": "video", "media": "m",
                "source_in": 0.0, "start": start, "duration": duration})
        };
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [{"id": "m", "name": "m", "path": "/nowhere/m.mp4", "kind": "video",
                "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": false}],
            "tracks": [{"id": "v1", "kind": "video"}, {"id": "v2", "kind": "video"},
                {"id": "v3", "kind": "video"}],
            "clips": [clip("a", "v1", 0, 1), clip("b", "v2", 0, 1), clip("c", "v3", 0, 1),
                clip("d", "v1", 1, 2)],
        }))
        .unwrap();
        let (senders, _receivers): (Vec<_>, Vec<_>) =
            (0..DECODERS).map(|_| mpsc::channel::<DecodeJob>()).unzip();
        let (planned_tx, planned) = mpsc::sync_channel(8);
        planner(
            &project,
            &[(0, 3)],
            senders,
            planned_tx,
            &AtomicBool::new(false),
        );
        let decodes: Vec<Vec<(String, bool)>> = planned
            .into_iter()
            .map(|planned| {
                planned
                    .decodes
                    .into_iter()
                    .map(|(clip, decode)| (clip, matches!(decode, Decode::Worker(_))))
                    .collect()
            })
            .collect();
        assert_eq!(decodes.len(), 3);
        assert!(decodes[0].iter().all(|(_, worker)| *worker), "{decodes:?}");
        assert_eq!(decodes[1], vec![("d".to_owned(), true)]);
        assert_eq!(decodes[2], vec![("d".to_owned(), true)]);
    }

    #[test]
    fn readers_are_pooled_by_file_and_continue_forward() {
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": "/nowhere.mp4", "kind": "video",
            "duration": 10.0, "width": 1920, "height": 1080, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, "/nowhere.mp4".into(), (640, 360), Order::Bgra);
        let mut pool = ReaderPool::new(3, 2);
        let mut behind = VideoReader::open(source.clone());
        behind.position = Some(4.0);
        let mut far = VideoReader::open(source.clone());
        far.position = Some(9.0);
        pool.put(far);
        pool.put(behind);
        assert_eq!(
            pool.take(&source, 4.5).position,
            Some(4.0),
            "the one just behind"
        );
        // A third for the same file pushes out its oldest; other files count to the total.
        pool.put(VideoReader::open(source.clone()));
        pool.put(VideoReader::open(source.clone()));
        assert_eq!(pool.readers.len(), 2);
        let mut other = source.clone();
        other.key.path = "/other.mp4".into();
        pool.put(VideoReader::open(other.clone()));
        pool.put(VideoReader::open(other));
        assert_eq!(pool.readers.len(), 3);
    }

    /// An effect's render lands as an .mp4 where its clear still was read (Nov 16): the reader that
    /// read the path as a picture isn't taken for the video, and the other way round.
    #[test]
    fn a_path_that_changes_kind_gets_a_fresh_reader() {
        let media = |kind: &str| -> Media {
            serde_json::from_value(json!({
                "id": "m", "name": "m", "path": "/nowhere/effect.mp4", "kind": kind,
                "duration": 10.0, "width": 1920, "height": 1080, "fps": 30
            }))
            .unwrap()
        };
        let path = PathBuf::from("/nowhere/effect.mp4");
        let as_still = Source::new(&media("image"), path.clone(), (640, 360), Order::Bgra);
        let as_video = Source::new(&media("video"), path, (640, 360), Order::Bgra);
        let mut pool = ReaderPool::new(6, 2);
        let mut still = VideoReader::open(as_still.clone());
        still.has_frame = true;
        pool.put(still);
        let before = OPENED.with(std::cell::Cell::get);
        let taken = pool.take(&as_video, 0.0);
        assert!(!taken.source.key.still, "read as the video it is now");
        assert_eq!(
            OPENED.with(std::cell::Cell::get) - before,
            1,
            "a new reader"
        );
        pool.put(taken);
        let back = pool.take(&as_still, 0.0);
        assert!(back.source.key.still, "the still's own reader");
        assert_eq!(
            OPENED.with(std::cell::Cell::get) - before,
            1,
            "kept from before"
        );
    }

    /// A reader whose read failed is let go, not pooled: the next ask for the file opens it again.
    #[test]
    fn a_failed_reader_isnt_reused() {
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": "/nowhere/gone.png", "kind": "image",
            "duration": 0.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, "/nowhere/gone.png".into(), (64, 36), Order::Bgra);
        let mut pool = ReaderPool::new(6, 2);
        let before = OPENED.with(std::cell::Cell::get);
        assert!(decode_all(&mut pool, &[(source.clone(), 0.0)], 1).is_err());
        assert!(pool.readers.is_empty(), "the failed reader isn't kept");
        assert!(decode_all(&mut pool, &[(source, 0.0)], 1).is_err());
        assert_eq!(
            OPENED.with(std::cell::Cell::get) - before,
            2,
            "opened afresh"
        );
        // One that read is kept as before.
        let mut fine = VideoReader::open(Source::new(
            &media,
            "/nowhere/fine.png".into(),
            (64, 36),
            Order::Bgra,
        ));
        fine.has_frame = true;
        pool.put(fine);
        assert_eq!(pool.readers.len(), 1);
    }

    /// Readers made ready for cuts ahead, more of one file than it keeps (requests waiting behind a slow
    /// open, Nov 21 audit), push out each other or themselves, never the reader the play is drawing from.
    #[test]
    fn readers_made_ready_for_cuts_never_push_out_the_one_playing() {
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": "/nowhere.mp4", "kind": "video",
            "duration": 900.0, "width": 1920, "height": 1080, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, "/nowhere.mp4".into(), (640, 360), Order::Bgra);
        let at = |seconds: f64| {
            let mut reader = VideoReader::open(source.clone());
            reader.position = Some(seconds);
            reader
        };
        let mut pool = ReaderPool::new(3, 3);
        pool.put(at(10.0));
        for cut in [20.0, 21.0, 22.0, 23.0, 24.0] {
            pool.put_ahead(at(cut));
            assert!(pool.readers.len() <= 3);
            assert!(
                pool.ready(&source, 10.0),
                "the playing one went for the cut at {cut}"
            );
        }
        // The newest cuts' readers stand beside it.
        assert!(pool.ready(&source, 24.0) && pool.ready(&source, 23.0));
        assert_eq!(pool.take(&source, 10.0 + 1.0 / 30.0).position, Some(10.0));
    }

    /// At 2× a cut's reader was made ready, then let go for being the longest unused just before
    /// its cut came (Cops Realize, frames 928 and 1007: a seek on the frame of the cut).
    #[test]
    fn a_reader_made_ready_for_a_cut_is_the_last_let_go() {
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": "/nowhere.mp4", "kind": "video",
            "duration": 900.0, "width": 1920, "height": 1080, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, "/nowhere.mp4".into(), (640, 360), Order::Bgra);
        let at = |seconds: f64| {
            let mut reader = VideoReader::open(source.clone());
            reader.position = Some(seconds);
            reader
        };
        let mut pool = ReaderPool::new(3, 3);
        pool.put_ahead(at(532.0));
        // The readers playing are put back every frame, and others come: the cut's stays.
        for frame in 0..10 {
            let playing = pool.take(&source, 160.0 + f64::from(frame) / 30.0);
            assert_ne!(
                playing.position,
                Some(532.0),
                "the cut's reader isn't taken to play on"
            );
            pool.put(at(160.0 + f64::from(frame) / 30.0));
            pool.put(at(40.0));
            pool.put(at(700.0));
        }
        assert!(pool.ready(&source, 532.0), "still there for its cut");
        // Read from at its cut, it's a reader like any other again.
        let cut = pool.take(&source, 532.0);
        assert_eq!((cut.position, cut.ahead.is_none()), (Some(532.0), true));
    }
}
