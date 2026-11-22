//! What the engine needs from its host: where FFmpeg is, where the media
//! cache is, atomic writes, and containing panics. The native addon sets
//! them from `init`.

use std::any::Any;
use std::ffi::OsString;
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// FFmpeg

/// The FFmpeg Edit runs. Releases ship it beside the `edit` binary as
/// `edit-ffmpeg` / `edit-ffprobe` (named so they never shadow the user's own
/// on PATH), or in Edit.app's Resources; a dev build falls back to the ones
/// on PATH. `EDIT_FFMPEG` / `EDIT_FFPROBE` point at others, and a host that
/// knows better ([`use_tools`], called before the first use) says where.
pub fn ffmpeg() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| chosen(0).unwrap_or_else(|| find("ffmpeg", "EDIT_FFMPEG")))
}

pub fn ffprobe() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| chosen(1).unwrap_or_else(|| find("ffprobe", "EDIT_FFPROBE")))
}

/// FFmpeg as a command to run, with the system's certificates (below). Every
/// FFmpeg the engine starts is made here.
pub fn ffmpeg_command() -> std::process::Command {
    tool_command(ffmpeg())
}

/// ffprobe as a command to run, with the system's certificates.
pub fn ffprobe_command() -> std::process::Command {
    tool_command(ffprobe())
}

/// A tool's command with `SSL_CERT_FILE` set to the system's certificates
/// where the environment has none: the shipped static FFmpeg's OpenSSL
/// doesn't know where macOS keeps them, so an HTTPS read without them fails
/// verification. The server sets it for its own children (tools.ts
/// `shareCertificates`), but Bun's `process.env` never reaches this
/// process's own environment, so the engine's children went without: the
/// censor check of a pieced proxy's original on R2 failed in under half a
/// second with "Error opening input files: Input/output error" (Sphe's M4,
/// Nov 17, nightly-78, three at the agent's first look).
fn tool_command(path: &OsString) -> std::process::Command {
    let mut command = std::process::Command::new(path);
    if std::env::var_os("SSL_CERT_FILE").is_none_or(|value| value.is_empty()) {
        if let Some(file) = certificates() {
            command.env("SSL_CERT_FILE", file);
        }
    }
    command
}

/// The system's certificates: macOS's, then Debian's and Ubuntu's, then Fedora's.
pub fn certificates() -> Option<&'static str> {
    const SYSTEMS: [&str; 3] = [
        "/etc/ssl/cert.pem",
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
    ];
    static FOUND: OnceLock<Option<&'static str>> = OnceLock::new();
    *FOUND.get_or_init(|| SYSTEMS.into_iter().find(|file| Path::new(file).is_file()))
}

/// FFmpeg and ffprobe as the host found them. Only the first call counts,
/// and only before [`ffmpeg`] / [`ffprobe`] are first asked.
pub fn use_tools(ffmpeg: OsString, ffprobe: OsString) {
    let _ = CHOSEN.set([ffmpeg, ffprobe]);
}

static CHOSEN: OnceLock<[OsString; 2]> = OnceLock::new();

fn chosen(index: usize) -> Option<OsString> {
    CHOSEN
        .get()
        .and_then(|tools| tools.get(index))
        .filter(|path| !path.is_empty())
        .cloned()
}

/// Whether the FFmpeg in use is the one shipped with Edit.
pub fn bundled() -> bool {
    PathBuf::from(ffmpeg()).is_absolute()
}

/// The `edit` binary as installed: `EDIT_EXE` when this process is the same
/// program run under another name (the desktop app's "Edit"), else this one.
pub fn original_exe() -> std::io::Result<PathBuf> {
    match std::env::var_os("EDIT_EXE") {
        Some(path) => Ok(PathBuf::from(path)),
        None => std::env::current_exe(),
    }
}

fn find(tool: &str, variable: &str) -> OsString {
    if let Some(path) = std::env::var_os(variable).filter(|path| !path.is_empty()) {
        return path;
    }
    let beside = original_exe()
        .and_then(std::fs::canonicalize)
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    let shipped = format!("edit-{tool}");
    let candidates = beside
        .iter()
        .flat_map(|dir| [dir.join(&shipped), dir.join("../Resources").join(&shipped)]);
    for candidate in candidates {
        if candidate.is_file() {
            return candidate.into_os_string();
        }
    }
    tool.into()
}

/// Whether `path` is an http(s) URL (a cloud original read through a
/// presigned URL, `cloud_media`) rather than a file.
pub fn is_url(path: &Path) -> bool {
    path.to_str()
        .is_some_and(|text| text.starts_with("https://") || text.starts_with("http://"))
}

/// The object a URL reads, whatever signature or port it's read with: a
/// presigned R2 URL without its query (the signature is new every time), and
/// this server's preview URL (`…/api/cloud/preview?key=<R2 key>`) by its key,
/// as `cloud:<key>`. Every proxy is read through the one preview path, so
/// without the key they were all one object (Nov 3: chunk keys and excerpts
/// of different proxies could be taken for each other's).
pub fn url_object(path: &Path) -> Option<String> {
    if !is_url(path) {
        return None;
    }
    let text = path.to_string_lossy();
    let (base, query) = text.split_once('?').unwrap_or((&text, ""));
    for pair in query.split('&') {
        if let Some(key) = pair.strip_prefix("key=") {
            return Some(format!("cloud:{}", percent_decode(key)));
        }
    }
    Some(base.to_owned())
}

/// `%XX` escapes (and `+`) in a URL's query value, decoded.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (byte, hex) {
            (b'%', Some(value)) => {
                out.push(value);
                at += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                at += 1;
            }
            (other, _) => {
                out.push(other);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The protocols FFmpeg may use to read `path`: files and pipes, plus HTTPS
/// for a URL (never for a file, so a crafted playlist can't reach the network).
pub fn protocols(path: &Path) -> &'static str {
    if is_url(path) {
        "file,pipe,http,https,tcp,tls,crypto"
    } else {
        "file,pipe"
    }
}

/// FFmpeg's input options for reading `path` over HTTPS: the system's
/// certificates (the shipped static FFmpeg's OpenSSL doesn't know where macOS
/// keeps them, so without them every HTTPS read fails verification; Linux's
/// are where Debian and Fedora keep them), and picking a long read from R2
/// back up when the connection drops.
pub fn url_args(path: &Path) -> &'static [&'static str] {
    // A read that gets nothing for 30 s fails (and reconnects) rather than
    // waiting forever on a connection that went quiet.
    const RECONNECT: [&str; 8] = [
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "10",
        "-rw_timeout",
        "30000000",
    ];
    static SECURE: OnceLock<Vec<&'static str>> = OnceLock::new();
    if !is_url(path) {
        &[]
    } else if path
        .to_str()
        .is_some_and(|text| text.starts_with("https://"))
    {
        SECURE.get_or_init(|| {
            let mut args = Vec::new();
            if let Some(file) = certificates() {
                args.extend(["-ca_file", file]);
            }
            args.extend(RECONNECT);
            args
        })
    } else {
        &RECONNECT
    }
}

// ---------------------------------------------------------------------------
// The media cache and cache keys

/// Edit's media cache (`Store::cache_dir`), set once the server starts.
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn use_cache_dir(dir: PathBuf) {
    let _ = CACHE_DIR.set(dir);
}

/// The media cache, once set.
pub fn cache_dir() -> Option<&'static Path> {
    CACHE_DIR.get().map(PathBuf::as_path)
}

/// A media file's cache folder (where the server keeps its previews and
/// waveform), for work that has no store at hand.
pub fn media_cache(source: &Path) -> Option<PathBuf> {
    Some(CACHE_DIR.get()?.join(crate::media::media_key(source)))
}

// ---------------------------------------------------------------------------
// Files

/// Writes `bytes` to `path` through a temporary file beside it, synced and
/// renamed into place, so a reader sees the old file or the new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}-{}.tmp", std::process::id(), next_file_id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The file `path` is written to before it's renamed into place
/// (`preview-light.<pid>-<n>.partial.mp4`), its own for each writer: an FFmpeg
/// left running by a server that died kept writing the same
/// `preview-light.partial.mp4` as the next server's, and the light preview
/// renamed into place had its index pointing at the wrong bytes ("Decoder
/// error." from the start to the end of the 57-minute Sabrina Limon 2nd).
/// Ones left behind (untouched for an hour) are removed.
pub fn partial(path: &Path, extension: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prefix = format!("{stem}.");
    let suffix = format!("partial.{extension}");
    let left = |entry: &std::fs::DirEntry| {
        entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600))
    };
    if let Some(entries) = path.parent().and_then(|dir| std::fs::read_dir(dir).ok()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ours = name
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix(&suffix))
                .is_some_and(|tag| {
                    tag.is_empty()
                        || tag
                            .trim_end_matches('.')
                            .bytes()
                            .all(|b| b.is_ascii_digit() || b == b'-')
                });
            if ours && left(&entry) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    path.with_extension(format!(
        "{}-{}.{suffix}",
        std::process::id(),
        next_file_id()
    ))
}

/// A number no other call in this process gets (temporary files, new ids).
pub fn next_file_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

// ---------------------------------------------------------------------------
// Decoders a cancel kills

/// The FFmpeg decoders an export started. A decoder blocked in a read (a
/// stalled network, a hung FFmpeg) never looks at the cancel flag, so
/// [`killed_on_cancel`] kills them: the blocked read ends and the export
/// stops. A pid is listed only until its child is reaped (taken out first,
/// under the same lock), so a kill never reaches a reused pid.
#[derive(Default)]
pub struct Decoders {
    pids: parking_lot::Mutex<std::collections::HashSet<u32>>,
}

impl Decoders {
    fn kill_all(&self) {
        for pid in self.pids.lock().iter() {
            // SAFETY: signalling our own child, listed only until it's reaped.
            unsafe {
                libc::kill(*pid as i32, libc::SIGKILL);
            }
        }
    }
}

std::thread_local! {
    static DECODERS: std::cell::RefCell<Option<std::sync::Arc<Decoders>>> =
        const { std::cell::RefCell::new(None) };
}

/// This thread's export's decoders, to carry into the threads it starts.
pub fn decoders() -> Option<std::sync::Arc<Decoders>> {
    DECODERS.with(|current| current.borrow().clone())
}

/// Runs `work` with the decoders it starts listed in `decoders`.
pub fn with_decoders<T>(decoders: Option<std::sync::Arc<Decoders>>, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<Option<std::sync::Arc<Decoders>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let before = self.0.take().flatten();
            DECODERS.with(|current| current.replace(before));
        }
    }
    let _restore = Restore(Some(DECODERS.with(|current| current.replace(decoders))));
    work()
}

/// Hands freed memory back to the system: glibc keeps what's freed in its
/// arenas (a let-go renderer's buffers stayed in the server's RSS); a Mac's
/// allocator gives it back by itself.
pub fn give_back_memory() {
    #[cfg(target_os = "linux")]
    // SAFETY: malloc_trim only walks glibc's own heaps.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// Runs `work` (an export), killing the decoders it starts once `cancel` is
/// set, or once it panics. The watch ends however `work` does: ended only
/// after it returned, a panic (a GPU validation error, Nov 17) left it watching
/// and the export hung for good instead of failing.
pub fn killed_on_cancel<T>(cancel: &std::sync::atomic::AtomicBool, work: impl FnOnce() -> T) -> T {
    struct Done<'a>(&'a std::sync::atomic::AtomicBool, &'a Decoders);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            if std::thread::panicking() {
                self.1.kill_all();
            }
            self.0.store(true, Ordering::Release);
        }
    }
    let decoders = std::sync::Arc::new(Decoders::default());
    let done = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Acquire) {
                if cancel.load(Ordering::Acquire) {
                    decoders.kill_all();
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        let _done = Done(&done, &decoders);
        with_decoders(Some(std::sync::Arc::clone(&decoders)), work)
    })
}

/// Kills this thread's export's decoders if dropped by a panic. Made inside a
/// `std::thread::scope` whose threads read from decoders: the scope joins them
/// before the panic gets out of it, and one blocked on a stalled read would
/// keep it, and the export, there for good (`killed_on_cancel`'s own watch is
/// outside the scope, so it never got the chance).
pub struct KillOnPanic(Option<std::sync::Arc<Decoders>>);

impl KillOnPanic {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(decoders())
    }
}

impl Drop for KillOnPanic {
    fn drop(&mut self) {
        if let Some(decoders) = &self.0 {
            if std::thread::panicking() {
                decoders.kill_all();
            }
        }
    }
}

/// A decoder child listed with this thread's export (if any) until it's reaped.
pub struct Watched {
    pub child: std::process::Child,
    decoders: Option<std::sync::Arc<Decoders>>,
}

impl Watched {
    pub fn new(child: std::process::Child) -> Self {
        let decoders = decoders();
        if let Some(decoders) = &decoders {
            decoders.pids.lock().insert(child.id());
        }
        Self { child, decoders }
    }

    fn unlist(&mut self) {
        if let Some(decoders) = self.decoders.take() {
            decoders.pids.lock().remove(&self.child.id());
        }
    }

    /// Waits for it to exit (it's no longer killed on cancel).
    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.unlist();
        self.child.wait()
    }

    pub fn stop(&mut self) {
        self.unlist();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------------------
// Panics

/// What a panic said, for logs and the job's error.
pub fn message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned())
}

/// Logs a crash in `what` and words it as the error the caller returns.
pub fn crashed(what: &str, payload: &(dyn Any + Send)) -> String {
    let message = message(payload);
    crate::log::error("crash", format!("{what} crashed: {message}"));
    format!("{what} crashed ({message}); this is a bug in Edit")
}

/// Runs `work`, turning a panic into an error naming `what`: a bug in one
/// job must not take the server down or leave the job "working" forever.
pub fn catch<T>(what: &str, work: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(AssertUnwindSafe(work)).map_err(|payload| crashed(what, &*payload))
}

/// Marks this thread as utility work (macOS QoS): the system schedules it
/// behind the threads drawing and playing, so decoding ahead and mixing sound
/// never take the frame's time on a busy Mac. Elsewhere, nothing.
pub fn utility_thread() {
    #[cfg(target_os = "macos")]
    // SAFETY: a plain call on the calling thread, with a constant class and no relative priority.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
}

/// How far below everything else background analysis runs (nice): its own
/// threads on Linux, and the tools it starts everywhere. On a Mac a nice of 10
/// lowers a process's base priority from the default 31 to 21, about where
/// utility QoS sits (20), and it still runs on the performance cores (background
/// QoS would pin it to the efficiency cores, too slow for what an agent waits on).
pub const BACKGROUND_NICE: i32 = 10;

/// Marks this thread as background work (reading words or faces on screen, a
/// censor check, smooth playback's render): utility QoS on a Mac (as [`utility_thread`]), nice
/// [`BACKGROUND_NICE`] on Linux, so the player, the page and the server's own
/// answers go first (kenobi, Nov 17: 73 subtitle reads and 46 censor checks
/// on opening a project, load 16.7 on 8 cores, while a cold play passed over
/// 515 frames in 23 s). Only on a thread of its own: a pool thread would keep it.
pub fn background_thread() {
    utility_thread();
    #[cfg(target_os = "linux")]
    // SAFETY: lowering this thread's own priority by its id; a failure leaves it as it was.
    unsafe {
        libc::setpriority(
            libc::PRIO_PROCESS,
            libc::gettid() as libc::id_t,
            BACKGROUND_NICE,
        );
    }
}

/// Starts `command`'s tool at background priority (nice
/// [`BACKGROUND_NICE`]): an FFmpeg that background analysis runs (a censor
/// check, a waveform). Never for exports, previews or anything a person
/// watches being made.
#[cfg(unix)]
pub fn background_command(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::unix::process::CommandExt;
    // SAFETY: setpriority is async-signal-safe, and nothing else runs between fork and exec.
    unsafe {
        command.pre_exec(|| {
            libc::setpriority(libc::PRIO_PROCESS, 0, BACKGROUND_NICE);
            Ok(())
        });
    }
    command
}

static PLAYING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The host says whether a person is watching a play on this machine now
/// (the server's playing.ts): background analysis waits while one is.
pub fn set_playing(playing: bool) {
    PLAYING.store(playing, Ordering::Release);
}

/// Whether a person is watching a play on this machine now.
pub fn playing() -> bool {
    PLAYING.load(Ordering::Acquire)
}

/// Marks this thread as what's on screen now (macOS QoS user-interactive):
/// the window's player, which draws each frame as it comes due. At the default
/// class it sat idle up to 134 ms between two 1 ms draws while the server
/// beside it was busy (Nov 15, 18 holds over 50 ms in 160 s of play). Elsewhere, nothing.
pub fn interactive_thread() {
    #[cfg(target_os = "macos")]
    // SAFETY: a plain call on the calling thread, with a constant class and no relative priority.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

/// What FFmpeg said that names why it failed, from its stderr: its first
/// lines that aren't the knock-on ones every failure ends with ("Nothing was
/// written into output file", "Task finished with error code"…), each without
/// its `[name @ 0x…]` prefix (an encoder's name kept), at most two, joined;
/// else its last line. None when it said nothing. Until Nov 22 only the last
/// line was kept, which is always a knock-on: a beneath export NVENC refused
/// ("Invalid Level") read "Nothing was written…" seventeen times on Linux.
pub fn ffmpeg_said(stderr: &str) -> Option<String> {
    const KNOCK_ON: [&str; 9] = [
        "Nothing was written into output file",
        "Task finished with error code",
        "Terminating thread with return code",
        "Error sending frames to consumers",
        "Could not open encoder before EOF",
        "Conversion failed",
        "Error while filtering",
        "Error while processing the decoded data",
        "Error muxing a packet",
    ];
    let plain = |line: &str| -> String {
        let mut rest = line.trim();
        let mut name: Option<&str> = None;
        while let Some((inside, after)) = rest
            .strip_prefix('[')
            .and_then(|after| after.split_once(']'))
        {
            let Some((own, _)) = inside.split_once(" @ ") else {
                break;
            };
            // An encoder's or decoder's own name ("h264_nvenc"), not FFmpeg's plumbing ("vost#0:0/…", "enc:…").
            if name.is_none() && !own.contains(['#', ':', '/']) {
                name = Some(own);
            }
            rest = after.trim_start();
        }
        match name {
            Some(name) => format!("{name}: {rest}"),
            None => rest.to_owned(),
        }
    };
    let lines: Vec<&str> = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut kept: Vec<String> = Vec::new();
    for line in &lines {
        let line = plain(line);
        if KNOCK_ON.iter().any(|knock| line.contains(knock)) || kept.contains(&line) {
            continue;
        }
        kept.push(line);
        if kept.len() == 2 {
            break;
        }
    }
    if kept.is_empty() {
        return lines.last().map(|line| plain(line));
    }
    let mut said = kept.join("; ");
    if said.len() > 400 {
        let mut end = 400;
        while !said.is_char_boundary(end) {
            end -= 1;
        }
        said.truncate(end);
        said.push('…');
    }
    Some(said)
}

#[cfg(test)]
mod tests {

    /// An export that panics fails (the panic comes back to `catch`) rather than hanging.
    #[test]
    fn a_panicking_export_fails_rather_than_hangs() {
        let (sent, came) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let result = catch("the export", || {
                killed_on_cancel(&cancel, || -> u32 { panic!("a validation error") })
            });
            let _ = sent.send(result.is_err());
        });
        let failed = came.recv_timeout(std::time::Duration::from_secs(10));
        assert_eq!(failed, Ok(true), "the export hung");
    }

    /// A panic while a decoder's read is blocked (a stalled file or download)
    /// fails the export too: the decoder is killed before the scope that
    /// started its reader waits for it.
    #[test]
    fn a_panic_beside_a_blocked_decoder_fails_rather_than_hangs() {
        use std::io::Read;
        let (sent, came) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let result = catch("the export", || {
                killed_on_cancel(&cancel, || {
                    std::thread::scope(|scope| {
                        let _kill = KillOnPanic::new();
                        let (started, reading) = std::sync::mpsc::channel();
                        let decoders = decoders();
                        scope.spawn(move || {
                            with_decoders(decoders, || {
                                let child = std::process::Command::new("sleep")
                                    .arg("600")
                                    .stdout(std::process::Stdio::piped())
                                    .spawn()
                                    .unwrap();
                                let mut decoder = Watched::new(child);
                                let mut out = decoder.child.stdout.take().unwrap();
                                started.send(()).unwrap();
                                let _ = out.read_to_end(&mut Vec::new());
                            });
                        });
                        reading.recv().unwrap();
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        panic!("a validation error");
                    })
                })
            });
            let _ = sent.send(result.is_err());
        });
        let failed = came.recv_timeout(std::time::Duration::from_secs(10));
        assert_eq!(failed, Ok(true), "the export hung");
    }

    use super::*;

    #[test]
    fn every_tool_command_carries_the_systems_certificates() {
        // Bun's process.env never reaches this process's environment (Sphe's M4, Nov 17): each command says it itself.
        for command in [ffmpeg_command(), ffprobe_command()] {
            let given = command
                .get_envs()
                .find(|(name, _)| *name == "SSL_CERT_FILE")
                .and_then(|(_, value)| value.map(|value| value.to_os_string()));
            match (
                std::env::var_os("SSL_CERT_FILE").filter(|value| !value.is_empty()),
                certificates(),
            ) {
                // Set already: inherited as it is.
                (Some(_), _) => assert_eq!(given, None),
                (None, Some(file)) => assert_eq!(given, Some(OsString::from(file))),
                (None, None) => assert_eq!(given, None),
            }
        }
    }

    #[test]
    fn each_writer_has_its_own_partial_file() {
        let dir = std::env::temp_dir().join(format!(
            "edit-partial-{}-{}",
            std::process::id(),
            next_file_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let light = dir.join("preview-light.mp4");
        let (first, second) = (partial(&light, "mp4"), partial(&light, "mp4"));
        assert_ne!(first, second);
        let name = first.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("preview-light.") && name.ends_with(".partial.mp4"),
            "{name}"
        );
        // Left behind an hour ago (the old shared name, another process's), or another file's: only the first two go.
        let old = SystemTime::now() - Duration::from_secs(7200);
        for file in [
            "preview-light.partial.mp4",
            "preview-light.1-0.partial.mp4",
            "preview.1-0.partial.mp4",
            "preview-light.mp4",
        ] {
            let file = std::fs::File::create(dir.join(file)).unwrap();
            file.set_modified(old).unwrap();
        }
        std::fs::write(dir.join("preview-light.2-0.partial.mp4"), b"").unwrap();
        partial(&light, "mp4");
        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "preview-light.2-0.partial.mp4",
                "preview-light.mp4",
                "preview.1-0.partial.mp4"
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn panics_become_errors() {
        assert_eq!(catch("sum", || 1 + 1), Ok(2));
        let error = catch("job", || -> u8 { panic!("boom") }).unwrap_err();
        assert!(error.contains("job crashed (boom)"), "{error}");
        let error = catch("job", || -> u8 { panic!("{}", String::from("owned")) }).unwrap_err();
        assert!(error.contains("owned"), "{error}");
    }

    /// A shell saying its own niceness (`ps`): what a tool started this way runs at. A Mac's `nice`
    /// won't run without a tool to start, so it can't be asked alone.
    #[test]
    fn background_tools_and_threads_run_below_the_rest() {
        let shell = || {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "ps -o nice= -p $$"]);
            command
        };
        let niceness = |command: &mut std::process::Command| -> i32 {
            let out = command.output().expect("nice runs");
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .expect("a niceness")
        };
        let ours = niceness(&mut shell());
        let lowered = niceness(background_command(&mut shell()));
        assert_eq!(lowered, BACKGROUND_NICE.max(ours));
        // A background thread's own work, and what it starts, on Linux (a Mac's QoS isn't a niceness).
        #[cfg(target_os = "linux")]
        {
            let from_thread = std::thread::spawn(move || {
                background_thread();
                niceness(&mut shell())
            })
            .join()
            .unwrap();
            assert_eq!(from_thread, BACKGROUND_NICE.max(ours));
            // The thread that asked is left as it was.
            assert_eq!(niceness(&mut shell()), ours);
        }
    }

    #[test]
    fn playing_is_said_by_the_host() {
        assert!(!playing());
        set_playing(true);
        assert!(playing());
        set_playing(false);
        assert!(!playing());
    }

    /// NVENC refusing a bitrate over H.264's top level (Nov 22): its reason, not the knock-on lines after it.
    #[test]
    fn ffmpegs_reason_is_kept_not_its_last_line() {
        let stderr = "[h264_nvenc @ 0x5ecff358f000] InitializeEncoder failed: invalid param (8): Invalid Level.
[vost#0:0/h264_nvenc @ 0x5ecff358eac0] [enc:h264_nvenc @ 0x5ecff358ef80] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
[vf#0:0 @ 0x5ecff35aa080] Error sending frames to consumers: Invalid argument
[vf#0:0 @ 0x5ecff35aa080] Task finished with error code: -22 (Invalid argument)
[vf#0:0 @ 0x5ecff35aa080] Terminating thread with return code -22 (Invalid argument)
[vost#0:0/h264_nvenc @ 0x5ecff358eac0] [enc:h264_nvenc @ 0x5ecff358ef80] Could not open encoder before EOF
[out#0/mp4 @ 0x5ecff358e5c0] Nothing was written into output file, because at least one of its streams received no packets.
";
        assert_eq!(
            super::ffmpeg_said(stderr).as_deref(),
            Some("h264_nvenc: InitializeEncoder failed: invalid param (8): Invalid Level.; Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.")
        );
        // Only knock-on lines: the last, as before.
        assert_eq!(
            super::ffmpeg_said("[out#0/mp4 @ 0x1] Nothing was written into output file.\n")
                .as_deref(),
            Some("Nothing was written into output file.")
        );
        assert_eq!(super::ffmpeg_said("\n  \n"), None);
        assert_eq!(
            super::ffmpeg_said("pipe:0: Invalid data found when processing input\n").as_deref(),
            Some("pipe:0: Invalid data found when processing input")
        );
    }
}
