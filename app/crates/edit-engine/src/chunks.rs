//! Chunked exports (Oct 18): a re-export redoes only what changed.
//!
//! Re-exports are common (15-Year-Old was exported six times, Mom & Teen
//! three) and each redid the whole picture, 5 to 16 minutes. So the picture
//! is encoded in chunks, each its own file starting on a keyframe, named by
//! what's on screen in it: every frame's scene (`evaluate_seen`) with clip ids
//! left out and media named by their content (`media_key`), the picture's
//! settings, and the code that draws and encodes it (`EDIT_RENDER_SOURCE`,
//! build.rs). A chunk ends on a cut whose frame's hash is a multiple of 16
//! (one cut in sixteen: a chunk is about a minute of an edit), at least
//! `MIN_SECONDS` in and at most `MAX_SECONDS`: content decides where chunks
//! end, so trimming a clip changes the chunk around it and the ones after
//! keep their boundaries rather than every chunk after the trim changing.
//!
//! The finished file is the chunks joined without re-encoding (FFmpeg's
//! concat), and the export remembers where each chunk sits in it
//! (`<cache>/export-chunks/<project>/manifest-v1.json`). A re-export copies
//! the chunks that didn't change out of that file (nothing extra is kept on
//! disk) and renders the rest; the sound too when nothing heard changed. The
//! chunks of an export that stopped part-way (cancelled, Edit quit) stay in
//! that folder, so running it again carries on.
//!
//! That folder and its manifest are the last *whole* export's alone (Nov 23,
//! Boyfriends, 2 h 6 min: every picture-beneath a graphic, every range and
//! motion sample was an export of the same project into the same folder, so
//! each replaced the manifest with its own few frames and deleted the files of
//! whatever ran beside it; a re-export reused 0 of 159 chunks, failed on its
//! own deleted chunks and went round whole in 47 minutes). An export of a part
//! has a folder of its own (`render::chunk_name`), and one export at a time
//! works in a folder ([`take`]).

use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use edit_core::{evaluate_seen, Layer, Project, Scene};
use serde::{Deserialize, Serialize};

use crate::export::Plan;

/// A chunk is at least this long unless the export is shorter...
pub const MIN_SECONDS: f64 = 10.0;
/// ...and at most this long.
pub const MAX_SECONDS: f64 = 120.0;
/// A new layout of the manifest or the keys is a new version.
const VERSION: u32 = 1;
const MANIFEST: &str = "manifest-v1.json";
const PLAN: &str = "plan-v1.json";

/// Frames `[start, end)` of the timeline and what's in them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub start: i64,
    pub end: i64,
    pub key: String,
}

impl Chunk {
    pub fn frames(&self) -> i64 {
        self.end - self.start
    }
}

/// What a file holds, as a key: its `media_key`; for a cloud original read
/// through a presigned URL (new every export), its object without the
/// signature: objects are named by their content and never change.
pub fn content_key(path: &Path) -> String {
    crate::util::url_object(path).unwrap_or_else(|| crate::media::media_key(path))
}

fn hasher(seed: &str) -> std::collections::hash_map::DefaultHasher {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut hasher);
    hasher
}

/// A frame's content: the scene without clip ids, its media by content.
fn frame_hash(scene: &Scene, key: &mut dyn FnMut(&str) -> String) -> u64 {
    let mut scene = scene.clone();
    for layer in &mut scene.layers {
        match layer {
            Layer::Video { clip, media, .. } => {
                clip.clear();
                *media = key(media);
            }
            Layer::Text { clip, .. } => clip.clear(),
            Layer::Waveform { clip, sources, .. } => {
                clip.clear();
                for source in sources {
                    source.media = key(&source.media);
                }
            }
            // A glitch's pattern is seeded by the frame's place on the
            // timeline; with no glitch it draws nothing, so it isn't part of
            // what's on screen. Kept, it made every frame under a blur or a
            // vignette new when the timeline shifted: card 1's teasers grew
            // 2.1 s and 105 of its 127 chunks were rendered again (Oct 29).
            Layer::Adjustment { glitch, .. } => {
                if glitch.amount == 0.0 {
                    glitch.seed = 0.0;
                }
            }
            Layer::Solid { .. } => {}
        }
    }
    let mut hasher = hasher("frame");
    format!("{scene:?}").hash(&mut hasher);
    hasher.finish()
}

/// The clips on screen, in order: a change is a cut, where a chunk may end.
fn clips(scene: &Scene) -> Vec<&str> {
    scene
        .layers
        .iter()
        .filter_map(|layer| match layer {
            Layer::Video { clip, .. } | Layer::Text { clip, .. } | Layer::Waveform { clip, .. } => {
                Some(clip.as_str())
            }
            Layer::Adjustment { .. } | Layer::Solid { .. } => None,
        })
        .collect()
}

/// Splits `plan`'s frames into chunks keyed by their content and `settings`
/// (whatever else changes the encoded picture: size, codec, bitrate). `contents`
/// names media by what they are, where the server knows it (exports.ts
/// `contentsOf`: a graphic by its code, footage by its cloud source): the same
/// picture attached again, or read from another place, keeps its chunks. Media
/// it doesn't name are keyed by their file, as before.
pub fn split(
    project: &Project,
    plan: &Plan,
    settings: &str,
    contents: &HashMap<String, String>,
) -> Vec<Chunk> {
    let fps = project.fps();
    let shortest = (MIN_SECONDS * fps).round() as i64;
    let longest = (MAX_SECONDS * fps).round() as i64;
    let mut keys: HashMap<String, String> = HashMap::new();
    let mut key = |media: &str| -> String {
        keys.entry(media.to_owned())
            .or_insert_with(|| {
                if let Some(content) = contents.get(media) {
                    return content.clone();
                }
                project.media(media).map_or_else(
                    || format!("missing:{media}"),
                    |found| content_key(Path::new(&found.path)),
                )
            })
            .clone()
    };
    let begin = || {
        let mut one = hasher(env!("EDIT_RENDER_SOURCE"));
        VERSION.hash(&mut one);
        settings.hash(&mut one);
        let mut two = hasher("second");
        settings.hash(&mut two);
        (one, two)
    };
    let mut out = Vec::new();
    let mut start = plan.start;
    let mut hashes = begin();
    let mut previous: Vec<String> = Vec::new();
    for frame in plan.start..plan.end {
        let scene = evaluate_seen(project, frame);
        let hash = frame_hash(&scene, &mut key);
        let now: Vec<String> = clips(&scene).into_iter().map(str::to_owned).collect();
        let length = frame - start;
        let cut = now != previous;
        if length >= longest || (length >= shortest && cut && hash.is_multiple_of(16)) {
            out.push(finish(start, frame, hashes));
            start = frame;
            hashes = begin();
        }
        hashes.0.write_u64(hash);
        hashes
            .1
            .write_u64(hash.rotate_left(17) ^ 0x9e37_79b9_7f4a_7c15);
        previous = now;
    }
    out.push(finish(start, plan.end, hashes));
    out
}

fn finish(
    start: i64,
    end: i64,
    (mut one, mut two): (
        std::collections::hash_map::DefaultHasher,
        std::collections::hash_map::DefaultHasher,
    ),
) -> Chunk {
    (end - start).hash(&mut one);
    (end - start).hash(&mut two);
    Chunk {
        start,
        end,
        key: format!("{:016x}{:016x}", one.finish(), two.finish()),
    }
}

/// One chunk of a finished export: where it sits in the file (frames).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub key: String,
    pub at: i64,
    pub frames: i64,
}

/// The last finished export of a project, as the next one can reuse it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub output: PathBuf,
    /// The file as it was written: changed or gone, nothing is reused.
    pub size: u64,
    pub modified_ns: u64,
    pub fps: f64,
    pub chunks: Vec<Saved>,
    /// The sound's key, when the file has sound.
    pub sound: Option<String>,
}

/// The folder a project's chunks and manifest live in.
pub fn folder(cache: &Path, project: &str) -> PathBuf {
    let safe: String = project
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    cache.join("export-chunks").join(safe)
}

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((meta.len(), u64::try_from(modified.as_nanos()).ok()?))
}

impl Manifest {
    /// The last export's manifest when its file is still as it was written.
    pub fn load(dir: &Path, fps: f64) -> Option<Manifest> {
        let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
        let manifest: Manifest = serde_json::from_str(&text).ok()?;
        let (size, modified_ns) = stamp(&manifest.output)?;
        (manifest.version == VERSION
            && manifest.fps == fps
            && manifest.size == size
            && manifest.modified_ns == modified_ns)
            .then_some(manifest)
    }

    /// Remembers `output` (finished, in its place) as made of `chunks`.
    pub fn save(
        dir: &Path,
        output: &Path,
        fps: f64,
        chunks: &[Chunk],
        sound: Option<String>,
    ) -> Result<(), String> {
        let (size, modified_ns) = stamp(output).ok_or("the export isn't there")?;
        let first = chunks.first().map_or(0, |chunk| chunk.start);
        let manifest = Manifest {
            version: VERSION,
            output: output.to_owned(),
            size,
            modified_ns,
            fps,
            chunks: chunks
                .iter()
                .map(|chunk| Saved {
                    key: chunk.key.clone(),
                    at: chunk.start - first,
                    frames: chunk.frames(),
                })
                .collect(),
            sound,
        };
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let text = serde_json::to_string(&manifest).map_err(|error| error.to_string())?;
        let temporary = dir.join(format!("{MANIFEST}.partial"));
        std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, dir.join(MANIFEST)).map_err(|error| error.to_string())
    }

    /// Where chunk `key` sits in the file, if it's there.
    pub fn find(&self, key: &str) -> Option<&Saved> {
        self.chunks.iter().find(|saved| saved.key == key)
    }
}

/// Chunk folders an export of this process is working in.
static IN_USE: parking_lot::Mutex<BTreeSet<PathBuf>> = parking_lot::Mutex::new(BTreeSet::new());
/// How long an export waits for the one before it to leave its folder (a
/// cancelled one winding down), before working in a folder of its own.
const WAIT_FOR_FOLDER: Duration = Duration::from_secs(20);

/// A chunk folder held by one export, let go when dropped.
#[derive(Debug)]
pub struct Folder {
    dir: PathBuf,
    /// The asked-for folder was busy: this one is the export's alone, kept for
    /// nothing after it, and no record of it is left.
    pub private: bool,
}

impl Folder {
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        if self.private {
            let _ = std::fs::remove_dir_all(&self.dir);
        } else {
            IN_USE.lock().remove(&self.dir);
        }
    }
}

/// Takes chunk folder `dir` for one export. An export tidies its folder as it
/// starts and ends, so two in one delete each other's chunks ("No such file or
/// directory" at each one's next write, Nov 23). One still busy after a short
/// wait (an engine stuck on another job never lets go) leaves this export a
/// folder of its own beside it: it reuses nothing, and it can't be held up.
pub fn take(dir: &Path, cancel: &AtomicBool) -> Result<Folder, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let began = Instant::now();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        if IN_USE.lock().insert(dir.to_owned()) {
            return Ok(Folder {
                dir: dir.to_owned(),
                private: false,
            });
        }
        if began.elapsed() >= WAIT_FOR_FOLDER {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut name = dir.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        "_beside-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    crate::log::warn(
        "export",
        format!(
            "another export is still in {}: this one works beside it",
            dir.display()
        ),
    );
    Ok(Folder {
        dir: dir.with_file_name(name),
        private: true,
    })
}

/// A chunk made by an earlier run (finished: written to `.partial` first).
pub fn made(dir: &Path, key: &str, extension: &str) -> PathBuf {
    dir.join(format!("{key}.{extension}"))
}

/// The chunks an export is making, written as it starts
/// (`plan-v1.json`: each one's frames and key, and the files' extension), so
/// smooth playback can serve every chunk the moment its file is there.
pub fn write_plan(dir: &Path, chunks: &[Chunk], extension: &str) -> Result<(), String> {
    let text = serde_json::json!({
        "version": VERSION,
        "extension": extension,
        "chunks": chunks
            .iter()
            .map(|chunk| serde_json::json!({"start": chunk.start, "end": chunk.end, "key": chunk.key}))
            .collect::<Vec<_>>(),
    })
    .to_string();
    let temporary = dir.join(format!("{PLAN}.partial"));
    std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, dir.join(PLAN)).map_err(|error| error.to_string())
}

/// Where `chunk` comes in an export focused on frame `focus`: the one
/// holding it and those after, in order, then those before, nearest first.
pub fn focus_order(chunk: &Chunk, focus: i64) -> (u8, i64) {
    if chunk.end > focus {
        (0, chunk.start)
    } else {
        (1, -chunk.start)
    }
}

/// Removes everything in `dir` but the manifest and the chunks in `keep`.
pub fn tidy(dir: &Path, keep: &[&Chunk], extension: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == MANIFEST || name == PLAN {
            continue;
        }
        if keep
            .iter()
            .any(|chunk| name == format!("{}.{extension}", chunk.key))
        {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// Where a chunk's frames come from.
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    /// A file of its own (rendered now or by an earlier run).
    File(PathBuf),
    /// Copied out of the last export, `at` frames in.
    Old { file: PathBuf, at: i64 },
}

/// What a stretch copied out of the last export needs to know of it: how
/// far a keyframe's decoding time leads its presentation (the out point of a
/// stretch is the next chunk's keyframe's decoding time, not its frame's), and
/// where its keyframes are shown (seconds), so each stretch starts on its own.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OldFile {
    pub lead: f64,
    pub keyframes: Vec<f64>,
}

/// Reads `file`'s picture packets (not decoded) for [`OldFile`].
pub fn old_file(file: &Path) -> Result<OldFile, String> {
    let output = crate::util::ffprobe_command()
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,dts_time,flags",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut old = OldFile::default();
    for (index, line) in text.lines().enumerate() {
        let mut parts = line.split(',').map(str::trim);
        let pts: Option<f64> = parts.next().and_then(|value| value.parse().ok());
        let dts: Option<f64> = parts.next().and_then(|value| value.parse().ok());
        let key = parts.next().is_some_and(|flags| flags.starts_with('K'));
        let Some(pts) = pts else { continue };
        if index == 0 {
            old.lead = (pts - dts.unwrap_or(pts)).max(0.0);
        }
        if key {
            old.keyframes.push(pts);
        }
    }
    if old.keyframes.is_empty() {
        return Err("the last export has no picture".to_owned());
    }
    Ok(old)
}

/// A path as FFmpeg's concat list quotes it.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// The concat list joining `pieces` (with their chunks' lengths) at `fps`;
/// `old` is the last export's ([`old_file`]), when anything comes from it.
/// Fails when a stretch to copy doesn't start on one of its keyframes.
pub fn concat_list(pieces: &[(Piece, i64)], fps: f64, old: &OldFile) -> Result<String, String> {
    // Only the picture (track 1 in a chunk and in the joined file): the last
    // export's sound starts early (AAC's priming), and concat would shift the
    // picture by that much if it counted it.
    let mut text = String::from("ffconcat version 1.0\nstream\nexact_stream_id 1\n");
    for (piece, frames) in pieces {
        let duration = *frames as f64 / fps;
        match piece {
            Piece::File(path) => {
                text.push_str(&format!("file {}\nduration {duration}\n", quoted(path)));
            }
            Piece::Old { file, at } => {
                // Just past the keyframe the chunk starts on, as the file has
                // it: seeking to its exact time can land on the keyframe
                // before (a stretch copied out of 97 s came out 12 frames
                // long), and copies drift from the frame's own time by ticks.
                let shown = *at as f64 / fps;
                let keyframe = old
                    .keyframes
                    .iter()
                    .copied()
                    .find(|time| (time - shown).abs() < 0.5 / fps)
                    .ok_or_else(|| format!("the last export has no keyframe at frame {at}"))?;
                let inpoint = keyframe + 0.000_002;
                // Stops before the next chunk's keyframe, which is decoded
                // `lead` before it's shown; half a frame for rounding.
                let outpoint = (*at + frames) as f64 / fps - old.lead - 0.5 / fps;
                text.push_str(&format!(
                    "file {}\ninpoint {inpoint}\noutpoint {outpoint}\nduration {duration}\n",
                    quoted(file)
                ));
            }
        }
    }
    Ok(text)
}

/// Where `list` doesn't lay its chunks end to end over `[start, end)`: a gap, an overlap (a boundary twice) or a
/// chunk listed twice, said with its frames; none when it does. A join of such a list has more or fewer frames than
/// the plan, which only its count said ("joined 33826 frames, not 33786", Marc).
pub fn not_end_to_end(list: &[Chunk], start: i64, end: i64) -> Option<String> {
    let mut at = start;
    for (index, chunk) in list.iter().enumerate() {
        if chunk.start != at || chunk.end <= chunk.start {
            return Some(format!(
                "chunk {} of {} is frames {}–{}, where the one before ended at {at}",
                index + 1,
                list.len(),
                chunk.start,
                chunk.end
            ));
        }
        at = chunk.end;
    }
    (at != end).then(|| format!("the chunks end at frame {at}, not {end}"))
}

/// Each piece of a join whose frames, as the join reads it (a chunk's file from its index, a stretch of the last
/// export through a concat list of its own, `scratch`), aren't the ones its place says: its index and what's off.
/// Read when a joined export's count is wrong, so its failure names the piece instead of only the total.
pub fn pieces_off(
    pieces: &[(Piece, i64)],
    fps: f64,
    old: &OldFile,
    scratch: &Path,
) -> Vec<(usize, String)> {
    let mut off = Vec::new();
    for (index, (piece, frames)) in pieces.iter().enumerate() {
        let found = match piece {
            Piece::File(path) => frames_indexed(path),
            Piece::Old { .. } => concat_list(&[(piece.clone(), *frames)], fps, old)
                .and_then(|text| std::fs::write(scratch, text).map_err(|error| error.to_string()))
                .and_then(|()| frames_listed(scratch)),
        };
        match found {
            Ok(count) if count == *frames => {}
            Ok(count) => off.push((index, format!("has {count} frames, not {frames}"))),
            Err(error) => off.push((index, error)),
        }
    }
    let _ = std::fs::remove_file(scratch);
    off
}

/// The picture packets a concat list (`concat_list`) gives, as the join reads them.
fn frames_listed(list: &Path) -> Result<i64, String> {
    let output = crate::util::ffprobe_command()
        .args(["-v", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(list)
        .args([
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| "its frames couldn't be counted".to_owned())
}

/// The video packets in `file`'s first picture stream (read, not decoded).
pub fn frames_in(file: &Path) -> Result<i64, String> {
    let output = crate::util::ffprobe_command()
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| "couldn't count the export's frames".to_owned())
}

/// The frames `file`'s first picture stream says it has, read from its
/// index (the sample table: nothing demuxed or decoded, a few ms); a file
/// with no picture, or one that won't open, has none to give.
pub fn frames_indexed(file: &Path) -> Result<i64, String> {
    let output = crate::util::ffprobe_command()
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    if !output.status.success() {
        return Err("it doesn't open".to_owned());
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "" => Err("it has no picture".to_owned()),
        // No count in its index (never one of Edit's chunks, which are
        // plain MP4/MOV): counted packet by packet instead.
        "N/A" => frames_in(file),
        text => text
            .parse()
            .map_err(|_| format!("its frame count reads {text:?}")),
    }
}

/// Which of the kept chunk files (each with the frames its place in the plan
/// says it holds) aren't whole, and why: checked from their indexes, a few at
/// a time. A kept chunk is reused for days, so a short or long one would
/// spoil every export of its stretch until it went.
pub fn not_whole(kept: &[(PathBuf, i64)]) -> Vec<(PathBuf, String)> {
    let mut bad = Vec::new();
    for batch in kept.chunks(8) {
        let found: Vec<Option<(PathBuf, String)>> = std::thread::scope(|scope| {
            let running: Vec<_> = batch
                .iter()
                .map(|(file, frames)| {
                    scope.spawn(move || match frames_indexed(file) {
                        Ok(count) if count == *frames => None,
                        Ok(count) => {
                            Some((file.clone(), format!("it has {count} frames, not {frames}")))
                        }
                        Err(error) => Some((file.clone(), error)),
                    })
                })
                .collect();
            running
                .into_iter()
                .map(|thread| {
                    thread
                        .join()
                        .unwrap_or_else(|_| Some((PathBuf::new(), "its check failed".to_owned())))
                })
                .collect()
        });
        bad.extend(found.into_iter().flatten());
    }
    bad
}

/// The picture's codec setup (SPS/PPS) in `file`, hashed: chunks joined
/// without re-encoding must all have the same.
pub fn setup_hash(file: &Path) -> Result<String, String> {
    let output = crate::util::ffprobe_command()
        .args([
            "-v",
            "error",
            "-show_data_hash",
            "CRC32",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=extradata_hash,codec_name,width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if text.is_empty() {
        return Err("a chunk has no picture".to_owned());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_focused_export_makes_the_chunk_at_the_playhead_first_then_on_then_back() {
        let chunk = |start: i64, end: i64| Chunk {
            start,
            end,
            key: format!("{start}"),
        };
        let mut todo = [
            chunk(0, 300),
            chunk(300, 600),
            chunk(600, 900),
            chunk(900, 1200),
        ];
        todo.sort_by_key(|one| focus_order(one, 450));
        let order: Vec<i64> = todo.iter().map(|one| one.start).collect();
        assert_eq!(order, vec![300, 600, 900, 0]);
        let dir = std::env::temp_dir().join(format!("edit-chunks-plan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_plan(&dir, &todo, "mp4").unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(PLAN)).unwrap()).unwrap();
        assert_eq!(written["chunks"][0]["start"], 300);
        assert_eq!(written["extension"], "mp4");
        // The plan stays when the folder is tidied.
        tidy(&dir, &[], "mp4");
        assert!(dir.join(PLAN).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    use super::*;

    #[test]
    fn a_concat_list_copies_old_stretches_up_to_the_next_keyframe() {
        let pieces = vec![
            (Piece::File(PathBuf::from("/c/a b.mp4")), 120),
            (
                Piece::Old {
                    file: PathBuf::from("/out/it's.mp4"),
                    at: 120,
                },
                120,
            ),
        ];
        let old = OldFile {
            lead: 1.0 / 30.0,
            keyframes: vec![0.0, 2.0, 4.0001],
        };
        let text = concat_list(&pieces, 30.0, &old).unwrap();
        assert!(text.contains("file '/c/a b.mp4'\nduration 4\n"));
        assert!(text.contains("file '/out/it'\\''s.mp4'\ninpoint 4.000102\noutpoint 7.95"));
        assert!(text.contains("duration 4\n"));
        // A stretch that doesn't start on a keyframe can't be copied.
        let none = OldFile {
            lead: 0.0,
            keyframes: vec![0.0],
        };
        assert!(concat_list(&pieces, 30.0, &none).is_err());
    }

    #[test]
    fn a_cloud_original_is_keyed_by_its_object_not_its_signature() {
        let one = Path::new("https://r2.example/edit/originals/sha256/ab/x.mp4?X-Amz-Signature=1");
        let two = Path::new("https://r2.example/edit/originals/sha256/ab/x.mp4?X-Amz-Signature=2");
        assert_eq!(content_key(one), content_key(two));
        assert_eq!(
            content_key(one),
            "https://r2.example/edit/originals/sha256/ab/x.mp4"
        );
        // Proxies read through this server's preview path: each its own, whatever the port.
        let a =
            Path::new("http://127.0.0.1:7700/api/cloud/preview?key=edit%2Fproxies%2Fdrive%2Fa.mp4");
        let b =
            Path::new("http://127.0.0.1:7710/api/cloud/preview?key=edit%2Fproxies%2Fdrive%2Fb.mp4");
        assert_eq!(content_key(a), "cloud:edit/proxies/drive/a.mp4");
        assert_ne!(content_key(a), content_key(b));
        assert_eq!(
            content_key(Path::new(
                "http://127.0.0.1:7710/api/cloud/preview?key=edit%2Fproxies%2Fdrive%2Fa.mp4"
            )),
            content_key(a)
        );
    }

    #[test]
    fn a_frame_under_a_blur_hashes_the_same_wherever_it_is_on_the_timeline() {
        use edit_core::{
            evaluate_seen, Blur, Clip, ClipColor, ClipContent, Glitch, Grade, Media, MediaKind,
            Settings, Shake, Transform,
        };
        let project = |at: i64| {
            let mut project = Project::new("p".into(), "t".into(), Settings::default());
            project.media.push(Media {
                id: "m1".into(),
                name: "a.mp4".into(),
                path: "https://r2.example/edit/originals/a.mp4".into(),
                kind: MediaKind::Video,
                duration: 600.0,
                width: 1920,
                height: 1080,
                fps: 30.0,
                has_audio: true,
                markers: Vec::new(),
                cloud: None,
                library: None,
                effect: None,
                effect_key: None,
                effect_from: None,
                stacked_alpha: false,
                cleans: None,
            });
            let (v1, v2) = (project.tracks[0].id.clone(), project.tracks[1].id.clone());
            let clip = |id: &str, track: String, content: ClipContent| Clip {
                id: id.into(),
                track,
                start: at,
                duration: 900,
                color: ClipColor::Blue,
                name: None,
                link: None,
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                person: None,
                parent: None,
                content,
            };
            project.clips.push(clip(
                "c1",
                v1,
                ClipContent::Video {
                    media: "m1".into(),
                    source_in: 10.0,
                    speed: 1.0,
                    transform: Transform::default(),
                    opacity: 1.0,
                    crop: Default::default(),
                    frame: None,
                    blend: Default::default(),
                },
            ));
            project.clips.push(clip(
                "c2",
                v2,
                ClipContent::Adjustment {
                    grade: Grade::default(),
                    shake: Shake::default(),
                    glitch: Glitch::default(),
                    blur: Blur {
                        radius: 30.0,
                        width: 200.0,
                        height: 100.0,
                        ..Blur::default()
                    },
                    opacity: 1.0,
                },
            ));
            project
        };
        let key = |media: &str| media.to_owned();
        let (before, after) = (project(0), project(63));
        for frame in [0, 100, 500] {
            assert_eq!(
                frame_hash(&evaluate_seen(&before, frame), &mut { key }),
                frame_hash(&evaluate_seen(&after, frame + 63), &mut { key }),
            );
        }
    }

    /// A project of ten-second clips, one per entry of `media` (id, file).
    fn cut_project(media: &[(&str, &str)]) -> Project {
        use edit_core::{Clip, ClipColor, ClipContent, Media, MediaKind, Settings, Transform};
        let mut project = Project::new("p".into(), "t".into(), Settings::default());
        let track = project.tracks[0].id.clone();
        for (at, (id, path)) in media.iter().enumerate() {
            if project.media(id).is_none() {
                project.media.push(Media {
                    id: (*id).into(),
                    name: "a.mp4".into(),
                    path: (*path).into(),
                    kind: MediaKind::Video,
                    duration: 6000.0,
                    width: 1920,
                    height: 1080,
                    fps: 30.0,
                    has_audio: false,
                    markers: Vec::new(),
                    cloud: None,
                    library: None,
                    effect: None,
                    effect_key: None,
                    effect_from: None,
                    stacked_alpha: false,
                    cleans: None,
                });
            }
            project.clips.push(Clip {
                id: format!("c{at}"),
                track: track.clone(),
                start: at as i64 * 300,
                duration: 300,
                color: ClipColor::Blue,
                name: None,
                link: None,
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                person: None,
                parent: None,
                content: ClipContent::Video {
                    media: (*id).into(),
                    source_in: at as f64 * 10.0,
                    speed: 1.0,
                    transform: Transform::default(),
                    opacity: 1.0,
                    crop: Default::default(),
                    frame: None,
                    blend: Default::default(),
                },
            });
        }
        project
    }

    fn whole(project: &Project) -> Plan {
        Plan {
            start: 0,
            end: project.duration(),
            width: 1920,
            height: 1080,
            audio: false,
            focus: None,
        }
    }

    fn named(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(id, content)| ((*id).to_owned(), (*content).to_owned()))
            .collect()
    }

    #[test]
    fn the_same_content_keeps_its_chunks_under_a_new_id_or_a_new_place() {
        let first: Vec<(&str, &str)> = (0..40).map(|_| ("m1", "/local/render.mp4")).collect();
        let again: Vec<(&str, &str)> = (0..40)
            .map(|_| ("m9", "https://r2.example/edit/exports/render.mp4?sig=2"))
            .collect();
        let (one, two) = (cut_project(&first), cut_project(&again));
        let before = split(
            &one,
            &whole(&one),
            "s",
            &named(&[("m1", "effect:subs:abc")]),
        );
        let after = split(
            &two,
            &whole(&two),
            "s",
            &named(&[("m9", "effect:subs:abc")]),
        );
        assert_eq!(before, after);
        // Named differently it's another picture, whatever its file.
        let changed = split(
            &one,
            &whole(&one),
            "s",
            &named(&[("m1", "effect:subs:def")]),
        );
        assert!(before.iter().all(|chunk| !changed.contains(chunk)));
    }

    #[test]
    fn a_clip_changed_later_leaves_the_chunks_before_it() {
        let mut media: Vec<(&str, &str)> = (0..60).map(|_| ("m1", "/a.mp4")).collect();
        let contents = named(&[("m1", "cloud:a"), ("m2", "cloud:b")]);
        let one = cut_project(&media);
        let before = split(&one, &whole(&one), "s", &contents);
        media[50] = ("m2", "/b.mp4");
        let two = cut_project(&media);
        let after = split(&two, &whole(&two), "s", &contents);
        let changed_at = 50 * 300;
        // A chunk ending right at the change is decided by the changed frame's hash.
        let early: Vec<&Chunk> = before
            .iter()
            .filter(|chunk| chunk.end < changed_at)
            .collect();
        assert!(!early.is_empty());
        assert!(early.iter().all(|chunk| after.contains(chunk)));
        assert_ne!(before, after);
    }

    #[test]
    fn one_export_at_a_time_works_in_a_folder() {
        let dir = std::env::temp_dir().join(format!("edit-chunk-hold-{}", std::process::id()));
        let cancel = AtomicBool::new(false);
        let held = take(&dir, &cancel).unwrap();
        assert!(!held.private);
        // Cancelled while it waits, it says so at once.
        let stopped = AtomicBool::new(true);
        assert_eq!(take(&dir, &stopped).unwrap_err(), "cancelled");
        drop(held);
        let again = take(&dir, &cancel).unwrap();
        assert_eq!(again.dir(), dir);
        assert!(!again.private);
    }

    #[test]
    fn a_chunk_list_not_end_to_end_is_named() {
        let chunk = |start, end| Chunk {
            start,
            end,
            key: format!("{start}"),
        };
        assert_eq!(
            not_end_to_end(&[chunk(10, 40), chunk(40, 90)], 10, 90),
            None
        );
        // A boundary twice (an overlap), a chunk listed twice, a gap, a short end.
        assert_eq!(
            not_end_to_end(&[chunk(10, 40), chunk(30, 90)], 10, 90).unwrap(),
            "chunk 2 of 2 is frames 30–90, where the one before ended at 40"
        );
        assert!(not_end_to_end(&[chunk(10, 40), chunk(10, 40), chunk(40, 90)], 10, 90).is_some());
        assert!(not_end_to_end(&[chunk(10, 40), chunk(50, 90)], 10, 90).is_some());
        assert_eq!(
            not_end_to_end(&[chunk(10, 40)], 10, 90).unwrap(),
            "the chunks end at frame 40, not 90"
        );
    }

    #[test]
    fn tidy_keeps_the_manifest_and_the_chunks_asked_for() {
        let dir = std::env::temp_dir().join(format!("edit-chunks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [MANIFEST, "aa.mp4", "bb.mp4", "cc.mp4.partial"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let keep = Chunk {
            start: 0,
            end: 1,
            key: "aa".to_owned(),
        };
        tidy(&dir, &[&keep], "mp4");
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["aa.mp4".to_owned(), MANIFEST.to_owned()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
