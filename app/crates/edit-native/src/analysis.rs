//! Looking at footage: tracking a box (`track`), faces (Vision, `faces`),
//! redaction (`censor`), camera angles (`seats`), and the desktop profile's
//! pictures (`desktop`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Frames looked at per second of source when finding faces.
#[napi]
pub const FACES_RATE: f64 = edit_engine::faces::RATE;

#[napi(object)]
pub struct TrackAnchor {
    /// Seconds into the source.
    pub at: f64,
    /// [x0, y0, x1, y1] in source pixels.
    #[napi(ts_type = "[number, number, number, number]")]
    pub region: Vec<f64>,
}

#[napi(object)]
pub struct TrackRequest {
    pub path: String,
    /// The source's picture size.
    #[napi(ts_type = "[number, number]")]
    pub size: Vec<u32>,
    /// The source's frame rate (0 if unknown).
    pub fps: f64,
    /// Seconds of the source to track over (at most 180 s).
    pub from: f64,
    pub to: f64,
    pub anchors: Vec<TrackAnchor>,
}

#[napi(object)]
pub struct TrackSample {
    pub time: f64,
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
pub struct Tracked {
    pub samples: Vec<TrackSample>,
    /// Stretches (source seconds) where the box wasn't found.
    #[napi(ts_type = "[number, number][]")]
    pub lost: Vec<Vec<f64>>,
    /// Cuts inside the footage (source seconds of the first frame after).
    pub cuts: Vec<f64>,
}

fn pair<T: Copy>(values: &[T], what: &str) -> Result<(T, T), String> {
    match values {
        [a, b] => Ok((*a, *b)),
        _ => Err(format!("{what} needs two numbers")),
    }
}

/// Follows a box given at one or more moments through the source (frames
/// kept in native memory a few minutes for another pass).
#[napi]
pub async fn track_anchors(request: TrackRequest) -> napi::Result<Tracked> {
    crate::blocking("tracking", move || {
        let size = pair(&request.size, "size")?;
        let anchors = request
            .anchors
            .iter()
            .map(|anchor| match anchor.region.as_slice() {
                [x0, y0, x1, y1] => Ok(edit_engine::track::Anchor {
                    at: anchor.at,
                    region: [*x0, *y0, *x1, *y1],
                }),
                _ => Err("a region is [x0, y0, x1, y1]".to_owned()),
            })
            .collect::<Result<Vec<_>, String>>()?;
        let tracked = edit_engine::track::track_anchors(
            Path::new(&request.path),
            size,
            request.fps,
            request.from,
            request.to,
            &anchors,
        )?;
        Ok(Tracked {
            samples: tracked
                .samples
                .iter()
                .map(|sample| TrackSample {
                    time: sample.time,
                    x: sample.x,
                    y: sample.y,
                })
                .collect(),
            lost: tracked.lost.iter().map(|(a, b)| vec![*a, *b]).collect(),
            cuts: tracked.cuts,
        })
    })
    .await
}

type Faces = BTreeMap<i64, Vec<[f32; 4]>>;

fn faces_json(faces: &Faces) -> Result<serde_json::Value, String> {
    serde_json::to_value(faces).map_err(|error| error.to_string())
}

/// The faces at `indexes` (source seconds × FACES_RATE) of the footage at
/// `source`: from its cache, the rest found now (Vision; a minute or two for
/// a long file's first run; nothing off macOS).
#[napi(
    ts_args_type = "source: string, size: [number, number], indexes: number[]",
    ts_return_type = "Promise<Record<number, Box[]>>"
)]
pub async fn faces_detect(
    source: String,
    size: Vec<u32>,
    indexes: Vec<i64>,
) -> napi::Result<serde_json::Value> {
    crate::blocking("finding faces", move || {
        let size = pair(&size, "size")?;
        let indexes: BTreeSet<i64> = indexes.into_iter().collect();
        faces_json(&edit_engine::faces::detect(
            Path::new(&source),
            size,
            &indexes,
        )?)
    })
    .await
}

/// Frames looked at per second of source when reading text on screen.
#[napi]
pub const SCREEN_TEXT_RATE: f64 = edit_engine::screen_text::RATE;

fn texts_json(texts: &edit_engine::screen_text::Texts) -> Result<serde_json::Value, String> {
    serde_json::to_value(texts).map_err(|error| error.to_string())
}

/// The words on screen at `indexes` (source seconds × SCREEN_TEXT_RATE) of
/// the footage at `source`, each with its box: from its cache, the rest read
/// now (Vision; nothing off macOS).
#[napi(
    ts_args_type = "source: string, size: [number, number], indexes: number[]",
    ts_return_type = "Promise<Record<number, ScreenText[]>>"
)]
pub async fn screen_text_detect(
    source: String,
    size: Vec<u32>,
    indexes: Vec<i64>,
) -> napi::Result<serde_json::Value> {
    crate::blocking("reading text on screen", move || {
        let size = pair(&size, "size")?;
        let indexes: BTreeSet<i64> = indexes.into_iter().collect();
        texts_json(&edit_engine::screen_text::detect(
            Path::new(&source),
            size,
            &indexes,
        )?)
    })
    .await
}

/// The words in `region` (x0, y0, x1, y1 as shares) of the frames at `times`
/// (source seconds, the file's own frames at `fps`) of the footage at
/// `source`, read at its own size: small text in a corner (a bodycam's
/// clock). One list a time, in `times`' order; nothing kept.
#[napi(
    ts_args_type = "source: string, size: [number, number], fps: number, region: Box, times: number[]",
    ts_return_type = "Promise<ScreenText[][]>"
)]
pub async fn screen_text_at(
    source: String,
    size: Vec<u32>,
    fps: f64,
    region: Vec<f64>,
    times: Vec<f64>,
) -> napi::Result<serde_json::Value> {
    crate::blocking("reading text on screen", move || {
        let size = pair(&size, "size")?;
        let region: [f64; 4] = region
            .try_into()
            .map_err(|_| "region: four numbers".to_owned())?;
        serde_json::to_value(edit_engine::screen_text::read_at(
            Path::new(&source),
            size,
            fps,
            region,
            &times,
        )?)
        .map_err(|error| error.to_string())
    })
    .await
}

/// Stretches open for reading (`screen_text_stretch`), by id.
static STRETCHES: parking_lot::Mutex<
    BTreeMap<u32, std::sync::Arc<parking_lot::Mutex<edit_engine::screen_text::Stretch>>>,
> = parking_lot::Mutex::new(BTreeMap::new());
static NEXT_STRETCH: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Opens a stretch of the footage at `source` to read the words in `region`
/// (as `screen_text_at`) in time order: one decode carried through it, the
/// frames asked to be kept held for a read back (`screen_text_stretch_read`).
/// Its id; close it when done (`screen_text_stretch_close`).
#[napi(ts_args_type = "source: string, size: [number, number], fps: number, region: Box")]
pub fn screen_text_stretch(
    source: String,
    size: Vec<u32>,
    fps: f64,
    region: Vec<f64>,
) -> napi::Result<u32> {
    crate::sync("reading text on screen", || {
        let size = pair(&size, "size")?;
        let region: [f64; 4] = region
            .try_into()
            .map_err(|_| "region: four numbers".to_owned())?;
        let stretch =
            edit_engine::screen_text::Stretch::open(Path::new(&source), size, fps, region)?;
        let id = NEXT_STRETCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        STRETCHES
            .lock()
            .insert(id, std::sync::Arc::new(parking_lot::Mutex::new(stretch)));
        Ok(id)
    })
}

/// The words at `times` (source seconds) of stretch `id`, one list a time in
/// `times`' order, the frames at `keep` held for a later read.
#[napi(ts_return_type = "Promise<ScreenText[][]>")]
pub async fn screen_text_stretch_read(
    id: u32,
    times: Vec<f64>,
    keep: Vec<f64>,
) -> napi::Result<serde_json::Value> {
    let stretch = STRETCHES
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| crate::fail("that stretch isn't open"))?;
    crate::blocking("reading text on screen", move || {
        serde_json::to_value(stretch.lock().read(&times, &keep)?).map_err(|error| error.to_string())
    })
    .await
}

/// Lets stretch `id` go (its decoder and frames).
#[napi]
pub fn screen_text_stretch_close(id: u32) {
    STRETCHES.lock().remove(&id);
}

/// The words on screen read in `source` so far, without looking at anything new.
#[napi(ts_return_type = "Record<number, ScreenText[]> | null")]
pub fn screen_text_cached(source: String) -> napi::Result<Option<serde_json::Value>> {
    crate::sync("reading text on screen", || {
        edit_engine::screen_text::cached(Path::new(&source))
            .map(|texts| texts_json(&texts))
            .transpose()
    })
}

/// The faces found in `source` so far, without looking at anything new.
#[napi(ts_return_type = "Record<number, Box[]> | null")]
pub fn faces_cached(source: String) -> napi::Result<Option<serde_json::Value>> {
    crate::sync("reading faces", || {
        edit_engine::faces::cached(Path::new(&source))
            .map(|faces| faces_json(&faces))
            .transpose()
    })
}

#[napi(object)]
pub struct CensorCheck {
    pub issues: Vec<serde_json::Value>,
    /// Files not read yet (`censor_check_pending`).
    pub pending: Vec<String>,
}

/// B-roll that's mostly censored (`censored_broll`), from the files already
/// read; with `start`, files not read yet start being read in the background.
#[napi]
pub fn censor_issues(
    #[napi(ts_arg_type = "ProjectInput")] project: crate::project::ProjectInput,
    start: bool,
) -> napi::Result<CensorCheck> {
    crate::sync("checking for censored footage", || {
        let project = crate::project::project_of(&project)?;
        let (issues, pending) = edit_engine::censor::issues(&project, &crate::cache_dir()?, start);
        Ok(CensorCheck { issues, pending })
    })
}

/// Reads a video for censored stretches in the background (one at a time),
/// so the audit's `censored_broll` is ready when the edit is reviewed: for
/// footage whose light preview was just made. `read`: the file to decode in
/// its place (a pieced proxy's original), the result kept as `path`'s.
#[napi]
pub fn censor_warm(path: String, read: Option<String>) {
    if let Ok(cache) = crate::cache_dir() {
        edit_engine::censor::analyse_in_background(
            cache,
            PathBuf::from(path),
            read.map(PathBuf::from),
        );
    }
}

/// Whether a person is watching a play on this machine now (the server's
/// playing.ts): the censor checks' FFmpeg stops while one is, and goes on after.
#[napi]
pub fn set_playing(playing: bool) {
    edit_engine::util::set_playing(playing);
}

/// Has every analysis of the media at `path` decode `read` in its place (a
/// pieced proxy's original); none: `path` itself again.
#[napi]
pub fn analyse_from(path: String, read: Option<String>) {
    edit_engine::media::analyse_from(Path::new(&path), read.map(PathBuf::from));
}

#[napi(object)]
pub struct Scenes {
    /// (start, end seconds, camera angle or null for a cutaway); the last
    /// scene ends at Infinity.
    #[napi(ts_type = "[number, number, number | null][]")]
    pub scenes: Vec<Vec<Option<f64>>>,
    pub angles: u32,
}

/// Scenes and camera angles in small greyscale frames (64 × 36 bytes each,
/// two a second, one after another).
#[napi]
pub async fn seats_scenes(gray: Buffer) -> napi::Result<Scenes> {
    let frames = gray.to_vec();
    crate::blocking("finding camera angles", move || {
        let (scenes, angles) = edit_engine::seats::scenes(&frames);
        Ok(Scenes {
            scenes: scenes
                .into_iter()
                .map(|(start, end, angle)| vec![Some(start), Some(end), angle.map(|a| a as f64)])
                .collect(),
            angles: u32::try_from(angles).unwrap_or(u32::MAX),
        })
    })
    .await
}

/// The desktop profile's pictures for a `width` × `height` frame, drawn into
/// `<home>/graphics/` if missing: [wallpaper, photo viewer, notepad].
#[napi(ts_return_type = "Promise<[string, string, string]>")]
pub async fn desktop_files(
    width: u32,
    height: u32,
    photo_title: String,
    notepad_title: String,
) -> napi::Result<Vec<String>> {
    crate::blocking("drawing the desktop", move || {
        let home = crate::lifecycle::home()?;
        let files =
            edit_engine::desktop::files(&home, width, height, &photo_title, &notepad_title)?;
        Ok(files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect())
    })
    .await
}

/// A desktop window's frame (`kind`: photo_viewer, notepad or video_player)
/// `width` × `height` pixels at scale `scale`, drawn into `<home>/graphics/`
/// if missing: its path.
#[napi]
pub async fn desktop_window(
    kind: String,
    width: u32,
    height: u32,
    scale: f64,
) -> napi::Result<String> {
    crate::blocking("drawing a desktop window", move || {
        let home = crate::lifecycle::home()?;
        let path = edit_engine::desktop::window_file(&home, &kind, width, height, scale)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// The laid-out size [width, height] of `text` in Geist at `px`, as the
/// renderer lays it out (the desktop profile's Notepad lines).
#[napi(ts_return_type = "[number, number]")]
pub fn text_block(text: String, px: f64, weight: u32, line_height: f64) -> napi::Result<Vec<f64>> {
    crate::sync("measuring text", || {
        let weight = u16::try_from(weight).map_err(|_| format!("weight {weight} is too big"))?;
        let (width, height) = edit_engine::desktop::text_block(&text, px, weight, line_height);
        Ok(vec![width, height])
    })
}

/// A channel's see-through watermark learned from footage that carries it
/// (the engine's watermark.rs `learn`): in `hint` (shares, x0 y0 x1 y1) when
/// the team showed where, else wherever a see-through mark stays put, never in
/// `avoid` (the camera's stamp). The model as JSON text, kept with the channel.
#[napi(
    ts_args_type = "source: string, size: [number, number], duration: number, hint: Box | null, avoid: Box[], onProgress: (progress: number) => void",
    ts_return_type = "Promise<string>"
)]
pub async fn watermark_learn(
    source: String,
    size: Vec<u32>,
    duration: f64,
    hint: Option<Vec<f64>>,
    avoid: Vec<Vec<f64>>,
    on_progress: crate::Progress,
) -> napi::Result<String> {
    crate::blocking("learning a watermark", move || {
        edit_engine::util::background_thread();
        let size = pair(&size, "size")?;
        let hint = hint.map(|one| shares(&one)).transpose()?;
        let avoid = avoid
            .iter()
            .map(|one| shares(one))
            .collect::<Result<Vec<_>, _>>()?;
        let model = edit_engine::watermark::learn(
            Path::new(&source),
            size,
            duration,
            hint,
            &avoid,
            &|progress| {
                crate::report(&on_progress, progress);
            },
        )?;
        serde_json::to_string(&model).map_err(|error| error.to_string())
    })
    .await
}

/// One stretch of footage to take a watermark out of.
#[napi(object)]
pub struct WatermarkPiece {
    pub source: String,
    #[napi(ts_type = "[number, number]")]
    pub size: Vec<u32>,
    pub fps: f64,
    /// Source seconds [from, to): the strip's first frame is `from`.
    pub from: f64,
    pub to: f64,
    /// The channel's model (JSON text, from `watermarkLearn`).
    pub model: String,
    /// Never touched (shares): the camera's stamp.
    #[napi(ts_type = "Box[]")]
    pub keep: Vec<Vec<f64>>,
    /// Where the strip goes (an mp4: the restored box over its alpha).
    pub out: String,
}

/// Takes the watermark out of a piece (the engine's watermark.rs `remove`):
/// what it did, or null when the mark isn't in that stretch (nothing written).
#[napi(
    ts_args_type = "piece: WatermarkPiece, onProgress: (progress: number) => void",
    ts_return_type = "Promise<WatermarkRemoved | null>"
)]
pub async fn watermark_remove(
    piece: WatermarkPiece,
    on_progress: crate::Progress,
) -> napi::Result<Option<serde_json::Value>> {
    crate::blocking("taking a watermark out", move || {
        edit_engine::util::background_thread();
        let (width, height) = pair(&piece.size, "size")?;
        let model: edit_engine::watermark::Model = serde_json::from_str(&piece.model)
            .map_err(|error| format!("the watermark's model doesn't read: {error}"))?;
        let keep = piece
            .keep
            .iter()
            .map(|one| shares(one))
            .collect::<Result<Vec<_>, _>>()?;
        let footage = edit_engine::watermark::Footage {
            width,
            height,
            fps: piece.fps,
        };
        let removed = edit_engine::watermark::remove(
            Path::new(&piece.source),
            footage,
            piece.from,
            piece.to,
            &model,
            &keep,
            Path::new(&piece.out),
            &|progress| {
                crate::report(&on_progress, progress);
            },
        )?;
        removed
            .map(|one| serde_json::to_value(one).map_err(|error| error.to_string()))
            .transpose()
    })
    .await
}

/// Their captions out of a stretch filmed by a camera that doesn't move (the engine's still.rs `clean`), from `job`
/// (found.ts `stillClean`'s JSON): on a thread of its own at background priority, stopped once it has taken longer
/// than a stretch may.
#[napi(ts_return_type = "Promise<StillAnswer>")]
pub async fn still_clean(job: String) -> napi::Result<serde_json::Value> {
    crate::blocking("cleaning a still stretch", move || {
        let job: edit_engine::still::Job = serde_json::from_str(&job)
            .map_err(|error| format!("the still clean's job doesn't read: {error}"))?;
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    edit_engine::util::background_thread();
                    let deadline = std::time::Instant::now() + edit_engine::still::LONGEST;
                    edit_engine::still::clean(&job, &|| std::time::Instant::now() > deadline)
                })
                .join()
                .map_err(|payload| edit_engine::util::crashed("the still clean", &*payload))?
        })
    })
    .await
}

/// Their captions out of a stretch the still clean can't take (the engine's caption.rs `clean`: the shadow brightened
/// back, the letters filled by LaMa at `model`, steadied along the camera's motion), from `job` (the still clean's job,
/// text_inpaint.ts's request): on a thread of its own at background priority, stopped once it has taken longer than a
/// stretch may.
#[napi(ts_return_type = "Promise<CaptionAnswer>")]
pub async fn caption_clean(job: String, model: String) -> napi::Result<serde_json::Value> {
    crate::blocking("cleaning a stretch's captions", move || {
        let job: edit_engine::still::Job = serde_json::from_str(&job)
            .map_err(|error| format!("the caption clean's job doesn't read: {error}"))?;
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    edit_engine::util::background_thread();
                    let deadline = std::time::Instant::now() + edit_engine::still::LONGEST;
                    edit_engine::caption::clean(&job, std::path::Path::new(&model), &|| {
                        std::time::Instant::now() > deadline
                    })
                })
                .join()
                .map_err(|payload| edit_engine::util::crashed("the caption clean", &*payload))?
        })
    })
    .await
}

fn shares(values: &[f64]) -> Result<[f64; 4], String> {
    values
        .try_into()
        .map_err(|_| "a box is four numbers".to_owned())
}
