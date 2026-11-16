//! Edit's desktop window: a native webview (Tauri) onto the server `edit`
//! runs, so the UI, REST, websocket and MCP all work exactly as in a browser.
//!
//! - `edit-window --url http://127.0.0.1:7700/`: what `edit app` starts (as
//!   `<home>/bin/Edit`, the name the Dock shows). It quits when its stdin
//!   closes, so a server that dies (or execs into an update) leaves no window.
//! - No `--url`: Edit.app (`just bundle`), opened from Finder. The server is
//!   `Resources/edit serve`, started here unless something already answers on
//!   the port, and stopped (Ctrl-C, so its cloud projects are let go) when the
//!   window closes. A server that goes while the window is open (an update's
//!   restart that didn't come back: Nov 1, the window sat at "Restarting…"
//!   with nothing behind it) is started again: the new build, after an update.
//!
//! Quitting leaves nothing of Edit.app running (Nov 4, Sphe on macOS 27: Edit
//! stayed in the Dock as "running in background" after Quit and had to be
//! stopped again). The server runs in its own process group, so everything it
//! started (Claude, Chrome's map pages, FFmpeg) goes with it; it gets a few
//! seconds to let its cloud projects go, then the group is killed. A server
//! this app left behind before (found on the port, Resources/edit of this same
//! app) is taken over and stopped on quit too, instead of reused forever.
//!
//! A window older than its server opens itself again. An update replaces
//! Edit.app and execs the server into the new build, and the window stayed
//! the old binary until Edit was reopened (nightly-76 on Sphe's M4, Nov 16),
//! though the player's fixes are in it. The window learns its build from its
//! own server's first answer, sends it with the long poll once it's quiet, and
//! told `relaunch` (apps/server/src/window_focus.ts) opens its bundle again at
//! the same path (the new one), onto the same page, letting go of the server
//! for the new window to take over (`leftover_server`). Opened again for a
//! build, it never is again for that build.

#[cfg(target_os = "macos")]
mod events;
#[cfg(target_os = "macos")]
mod notices;
#[cfg(target_os = "macos")]
mod preview;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 7700;

fn fail(message: &str) -> ! {
    eprintln!("edit: {message}");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    match flag("--url") {
        Some(url) => run(&url, None, true, None),
        None => {
            let port = flag("--port")
                .map(|port| {
                    port.parse()
                        .unwrap_or_else(|_| fail("--port must be a number"))
                })
                .unwrap_or(DEFAULT_PORT);
            let server = start_server(port).or_else(|| leftover_server(port));
            let home = format!("http://127.0.0.1:{port}/");
            // Opened again (`relaunch`): the page it was on.
            let page = flag("--page")
                .filter(|page| same_origin(page, &home))
                .unwrap_or(home);
            run(
                &page,
                server.map(|server| (server, port)),
                false,
                flag("--relaunched"),
            );
        }
    }
}

/// Whether `page` is a page of the server at `home`.
fn same_origin(page: &str, home: &str) -> bool {
    match (page.parse::<Url>(), home.parse::<Url>()) {
        (Ok(page), Ok(home)) => page.origin() == home.origin(),
        _ => false,
    }
}

/// Opens the editor at `url` and runs until the window closes (or, with
/// `watch_stdin`, until stdin closes). `relaunched`: the server's build this
/// window was opened again for.
fn run(
    url: &str,
    server: Option<(Server, u16)>,
    watch_stdin: bool,
    relaunched: Option<String>,
) -> ! {
    let url: Url = url.parse().unwrap_or_else(|_| fail("bad URL"));
    #[cfg(target_os = "macos")]
    events::guard();
    let closing = Arc::new(AtomicBool::new(false));
    let port = server.as_ref().map(|(_, port)| *port);
    let server = Arc::new(Mutex::new(server.map(|(server, _)| server)));
    if let Some(port) = port {
        let (server, closing) = (Arc::clone(&server), Arc::clone(&closing));
        std::thread::spawn(move || keep_serving(&server, &closing, port));
    }
    // Only a server of this app's own is of the window's build.
    let ours = port.map(|port| Ours {
        server: Arc::clone(&server),
        closing: Arc::clone(&closing),
        port,
    });
    let build = Build {
        owns: ours.is_some(),
        mine: None,
        relaunched_for: relaunched,
    };
    let local = url.clone();
    let builder = tauri::Builder::default();
    // The native preview: the page's viewer drawn by the engine in a layer under it.
    #[cfg(target_os = "macos")]
    let builder =
        builder
            .manage(preview::Previews::default())
            .invoke_handler(tauri::generate_handler![
                preview::preview_open,
                preview::preview_place,
                preview::preview_project,
                preview::preview_patch,
                preview::preview_sources,
                preview::preview_frame,
                preview::preview_play,
                preview::preview_pause,
                preview::preview_position,
                preview::preview_hint,
                preview::preview_rate,
                preview::preview_volume,
                preview::preview_close,
                notices::notices_status,
                notices::notices_allow,
                notices::notices_test,
            ]);
    let app = builder
        .setup(move |app| {
            if watch_stdin {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut stdin = std::io::stdin();
                    let mut sink = [0_u8; 4096];
                    while matches!(stdin.read(&mut sink), Ok(read) if read > 0) {}
                    handle.exit(0);
                });
            }
            #[cfg(target_os = "macos")]
            notices::init(app.handle());
            // Brought to the front when the server asks (the browser's sign-in came back), and its notices posted.
            if let (Some(host), Some(port)) = (local.host_str(), local.port_or_known_default()) {
                let handle = app.handle().clone();
                let host = host.to_owned();
                std::thread::spawn(move || {
                    follow_focus(&handle, &host, port, build, ours.as_ref());
                });
            }
            let stays_inside = local.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(local.clone()))
                .title("Edit")
                // The page shows its own title; the bar keeps just the traffic lights.
                .hidden_title(true)
                // A see-through bar over the window's colour: black, as Home is
                // (Sphe, Nov 3: the bar "needs to be black like the background").
                .title_bar_style(tauri::TitleBarStyle::Transparent)
                .background_color(tauri::webview::Color(0, 0, 0, 255))
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                // Opens filling the screen (zoomed, not macOS full screen: the
                // menu bar and Dock stay); the size above is what un-zooming gives.
                .maximized(true)
                // Let the page take file drops itself (the timeline uploads them).
                .disable_drag_drop_handler()
                // Links out (articles, sources) belong in the browser, not the editor's window.
                .on_navigation(move |url| {
                    let inside = url.origin() == stays_inside.origin();
                    if !inside {
                        open_in_browser(url);
                    }
                    inside
                })
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            #[cfg(target_os = "macos")]
            preview::check(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| fail(&format!("could not open the window: {error}")));
    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            closing.store(true, Ordering::SeqCst);
            let running = server.lock().ok().and_then(|mut server| server.take());
            if let Some(running) = running {
                stop(running);
            }
        }
    });
    std::process::exit(0);
}

/// Watches Edit.app's server and starts it again when it has gone while the
/// window is open. An update execs the server into the new build in place; if
/// that never answers (the exec failed, or it died starting), the page waited
/// on "Restarting…" with nothing behind it. Starting `Resources/edit` again
/// runs whatever build is there now, and the page reloads once it answers. A
/// build that keeps dying within a minute of starting is tried three times.
fn keep_serving(server: &Mutex<Option<Server>>, closing: &AtomicBool, port: u16) {
    let mut started = Instant::now();
    let mut quick_deaths = 0;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if closing.load(Ordering::SeqCst) {
            return;
        }
        let Ok(mut guard) = server.lock() else { return };
        let gone = match guard.as_mut() {
            Some(Server::Started(child)) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
            // One taken over from before isn't ours to start again.
            Some(Server::Leftover(_)) | None => return,
        };
        if !gone || closing.load(Ordering::SeqCst) {
            continue;
        }
        if started.elapsed() < Duration::from_secs(60) {
            quick_deaths += 1;
        } else {
            quick_deaths = 0;
        }
        if quick_deaths >= 3 {
            eprintln!("edit: the server keeps stopping; quit Edit and open it again");
            *guard = None;
            return;
        }
        eprintln!("edit: the server stopped; starting it again");
        *guard = None;
        drop(guard);
        // None when something else answers on the port now: the window carries on with that one.
        let Some(child) = start_server(port) else {
            return;
        };
        started = Instant::now();
        let Ok(mut guard) = server.lock() else { return };
        if closing.load(Ordering::SeqCst) {
            drop(guard);
            stop(child);
            return;
        }
        *guard = Some(child);
    }
}

/// A notification to post (the server's notices.ts): a click opens `path`.
#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Notice {
    key: String,
    title: String,
    body: String,
    path: String,
}

/// One poll's answer: whether to come to the front, notices to post, the
/// server's build, and whether this window should open itself again.
#[derive(serde::Deserialize, Debug, Default, PartialEq)]
struct Answer {
    #[serde(default)]
    focus: bool,
    #[serde(default)]
    notices: Vec<Notice>,
    #[serde(default)]
    build: Option<String>,
    #[serde(default)]
    relaunch: bool,
}

/// What the window knows of its build, to open itself again when its server's isn't it.
#[derive(Debug, Default, PartialEq)]
struct Build {
    /// Whether the server is this app's own (started here or taken over): only then is its build the window's.
    owns: bool,
    /// The window's build: its own server's, as the first answer to say one had it.
    mine: Option<String>,
    /// The server's build this window was opened again for (`--relaunched`): never again for it.
    relaunched_for: Option<String>,
}

impl Build {
    /// Learns the window's build from the first answer that says the server's.
    fn heard(&mut self, answer: &Answer) {
        if self.owns && self.mine.is_none() {
            self.mine.clone_from(&answer.build);
        }
    }

    /// The build to ask with: the window's, once it's quiet (a server that finds it differs answers
    /// `relaunch` at once). None when it isn't quiet, or the window doesn't know its own.
    fn to_send(&self, quiet: bool) -> Option<&str> {
        let mine = self.mine.as_deref().filter(|_| self.owns && quiet)?;
        mine.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .then_some(mine)
    }

    /// The server's build to open this window again for, when the answer says to: one the window
    /// isn't, and wasn't opened again for already.
    fn relaunch_for<'a>(&self, answer: &'a Answer) -> Option<&'a str> {
        let server = answer.build.as_deref()?;
        (answer.relaunch
            && self.owns
            && self.mine.as_deref().is_some_and(|mine| mine != server)
            && self.relaunched_for.as_deref() != Some(server))
        .then_some(server)
    }
}

/// The server this window runs (or took over), for `relaunch` to leave running.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Ours {
    server: Arc<Mutex<Option<Server>>>,
    closing: Arc<AtomicBool>,
    port: u16,
}

/// Input untouched this long (or the window not in front), and nothing playing: a quiet moment to
/// open the window again in.
const QUIET: Duration = Duration::from_secs(20);

/// Whether nobody is using the window now: nothing playing, and it isn't in front or the Mac's
/// input has been idle `QUIET`.
fn quiet(handle: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    if preview::playing() {
        return false;
    }
    let front = handle
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    !front || idle() >= QUIET
}

/// How long since the last key, click or mouse move anywhere in this Mac's session.
#[cfg(target_os = "macos")]
fn idle() -> Duration {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType.
    // SAFETY: reads the session's input clock; it takes and returns plain numbers.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    Duration::try_from_secs_f64(seconds).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn idle() -> Duration {
    Duration::ZERO
}

/// Opens Edit.app again from its bundle's path (after an update, the new one) onto the page this
/// window shows, and quits this window, leaving the server running for the new one to take over.
/// In front only if this window was. False when the new one couldn't be opened (this one stays).
#[cfg(target_os = "macos")]
fn relaunch(handle: &AppHandle, ours: &Ours, build: &str) -> bool {
    let Some(bundle) = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .ok()
        .and_then(|exe| exe.ancestors().nth(3).map(PathBuf::from))
        .filter(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
    else {
        return false;
    };
    let window = handle.get_webview_window("main");
    let page = window.as_ref().and_then(|window| window.url().ok());
    let front = window
        .as_ref()
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    let mut open = Command::new("/usr/bin/open");
    open.arg("-n");
    if !front {
        open.arg("-g");
    }
    let port = ours.port.to_string();
    open.arg(&bundle)
        .arg("--args")
        .args(["--port", &port, "--relaunched", build]);
    if let Some(page) = &page {
        open.args(["--page", page.as_str()]);
    }
    if !open.status().is_ok_and(|status| status.success()) {
        eprintln!("edit: couldn't open {} again", bundle.display());
        return false;
    }
    // Not stopped on the way out: the new window takes it over.
    ours.closing.store(true, Ordering::SeqCst);
    let left = ours.server.lock().ok().and_then(|mut server| server.take());
    drop(left);
    handle.exit(0);
    true
}

#[cfg(not(target_os = "macos"))]
fn relaunch(_handle: &AppHandle, _ours: &Ours, _build: &str) -> bool {
    false
}

/// Asks the server, again and again, whether the window should come to the
/// front (`GET /api/window/next`, a long poll: `{"focus":true}` when it should,
/// `{"focus":false}` after ~25 s to ask again), and brings it forward when
/// told; notices that came with the answer are posted (src/notices.rs).
/// A server without the route (older) or not answering is asked again later.
/// Told to `relaunch` at a quiet moment, it opens the window again.
fn follow_focus(handle: &AppHandle, host: &str, port: u16, mut build: Build, ours: Option<&Ours>) {
    loop {
        let asking = build.to_send(quiet(handle)).map(str::to_owned);
        match ask_focus(host, port, asking.as_deref()) {
            Ok(answer) => {
                build.heard(&answer);
                if let (Some(server), Some(ours)) = (build.relaunch_for(&answer), ours) {
                    if quiet(handle) {
                        if relaunch(handle, ours, server) {
                            return;
                        }
                        // Not opened: not tried again for this build.
                        build.relaunched_for = Some(server.to_owned());
                    }
                }
                if answer.focus {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                #[cfg(target_os = "macos")]
                for notice in &answer.notices {
                    notices::post(notice);
                }
            }
            Err(()) => std::thread::sleep(Duration::from_secs(5)),
        }
    }
}

/// One long poll: whether the server wants the window in front, and what to post. `build`: the
/// window's, sent once it's quiet.
fn ask_focus(host: &str, port: u16, build: Option<&str>) -> Result<Answer, ()> {
    let mut stream = TcpStream::connect((host, port)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(40)))
        .map_err(|_| ())?;
    let query = build.map_or(String::new(), |build| format!("?build={build}"));
    write!(
        stream,
        "GET /api/window/next{query} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    .map_err(|_| ())?;
    let mut answer = String::new();
    stream.read_to_string(&mut answer).map_err(|_| ())?;
    if !answer.starts_with("HTTP/1.1 200") {
        return Err(());
    }
    let body = answer.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    // An answer that isn't the JSON expected still says whether to come forward.
    Ok(
        serde_json::from_str(body.trim()).unwrap_or_else(|_| Answer {
            focus: answer.contains("\"focus\":true"),
            ..Answer::default()
        }),
    )
}

fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = Command::new("open").arg(url.as_str()).spawn();
    }
}

/// The server behind the window: one it started, or one this same app left
/// running before (taken over, so quitting stops it).
enum Server {
    Started(Child),
    Leftover(u32),
}

/// Edit.app's own server program, `Contents/Resources/edit`.
fn server_program() -> PathBuf {
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .unwrap_or_else(|error| fail(&format!("could not find this program: {error}")));
    exe.parent()
        .and_then(|macos| macos.parent())
        .map(|contents| contents.join("Resources").join("edit"))
        .unwrap_or_else(|| fail("Edit.app has no Resources/edit"))
}

/// Edit.app's server: `Resources/edit serve` beside this program, unless an
/// Edit already serves on the port (then the window opens onto that one).
fn start_server(port: u16) -> Option<Server> {
    if TcpListener::bind(("127.0.0.1", port)).is_err() {
        return None;
    }
    let edit = server_program();
    let mut command = Command::new(&edit);
    command
        .args(["serve", "--port", &port.to_string()])
        // Opened from Finder: the server borrows the login shell's PATH and keys.
        .env("EDIT_ADOPT_SHELL_ENV", "1")
        .stdin(Stdio::null());
    // Its own process group: what it starts is stopped with it.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let child = command
        .spawn()
        .unwrap_or_else(|error| fail(&format!("could not start {}: {error}", edit.display())));
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Some(Server::Started(child))
}

/// A server on `port` that is this app's own `Resources/edit`, left running
/// by an earlier window (it crashed, or was killed): taken over, so quitting
/// stops it. Anything else on the port (`edit serve` in a terminal, a dev
/// server) is only opened onto, never stopped.
fn leftover_server(port: u16) -> Option<Server> {
    let ours = std::fs::canonicalize(server_program()).ok()?;
    let listening = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&listening.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .find(|pid| program_of(*pid).is_some_and(|program| program == ours))
        .map(Server::Leftover)
}

/// The program process `pid` runs, as `ps` names it (macOS: its full path).
fn program_of(pid: u32) -> Option<PathBuf> {
    let shown = Command::new("/bin/ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&shown.stdout).trim().to_owned();
    if path.is_empty() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

/// How long the server has after Quit to push its cloud projects and let
/// their locks go (it bounds its own shutdown below this; what it couldn't
/// push stays marked and goes up at the next start).
const QUIT_GRACE: Duration = Duration::from_secs(6);

/// Stops the server as Ctrl-C would (it pushes its cloud projects and lets
/// their locks go), then kills whatever is left of its process group (Claude,
/// map pages, FFmpeg), so nothing of Edit runs on after Quit.
fn stop(server: Server) {
    match server {
        Server::Started(mut child) => {
            let pid = child.id();
            signal(pid, false, Signal::Interrupt);
            let started = Instant::now();
            while started.elapsed() < QUIT_GRACE {
                if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // The group outlives its leader: anything it started still in it goes too.
            signal(pid, true, Signal::Kill);
            let _ = child.kill();
            let _ = child.wait();
        }
        Server::Leftover(pid) => {
            signal(pid, false, Signal::Interrupt);
            let started = Instant::now();
            while started.elapsed() < QUIT_GRACE && alive(pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            // A group of its own only when an earlier window started it that way.
            signal(pid, leads_group(pid), Signal::Kill);
            signal(pid, false, Signal::Kill);
        }
    }
}

enum Signal {
    Interrupt,
    Kill,
}

/// Sends `signal` to process `pid`, or to its whole process group.
#[cfg(unix)]
fn signal(pid: u32, group: bool, signal: Signal) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    let number = match signal {
        Signal::Interrupt => libc::SIGINT,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: kill only sends a signal; a process or group that's gone answers ESRCH.
    unsafe {
        libc::kill(if group { -pid } else { pid }, number);
    }
}

#[cfg(not(unix))]
fn signal(_pid: u32, _group: bool, _signal: Signal) {}

/// Whether process `pid` is still running.
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 checks the process exists and sends nothing.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

/// Whether process `pid` leads its own process group.
#[cfg(unix)]
fn leads_group(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: getpgid only reads the process's group id.
    unsafe { libc::getpgid(pid) == pid }
}

#[cfg(not(unix))]
fn leads_group(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{alive, ask_focus, same_origin, stop, Answer, Build, Notice, Server};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::process::{Command, Stdio};

    /// Quit leaves nothing running: a server that exits on Ctrl-C but left
    /// something it started behind (Nov 4, "running in background" on macOS 27)
    /// takes that with it.
    #[cfg(unix)]
    #[test]
    fn quitting_stops_what_the_server_started() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(Stdio::piped());
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let left: u32 = line.trim().parse().unwrap();
        assert!(alive(left));
        stop(Server::Started(child));
        // Killed, then reaped by launchd once orphaned: give it a moment.
        let started = std::time::Instant::now();
        while alive(left) && started.elapsed() < std::time::Duration::from_secs(5) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!alive(left));
    }

    /// A server answering one request with `answer`; what it was asked comes back.
    fn serve_once(answer: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // The whole request first, as a server does: closing with some of
            // it unread resets the connection under the answer.
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            stream.write_all(answer.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (port, asked)
    }

    #[test]
    fn the_window_comes_forward_only_when_the_server_says_so() {
        let (port, asked) =
            serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"focus\":true}");
        assert_eq!(
            ask_focus("127.0.0.1", port, None).map(|answer| answer.focus),
            Ok(true)
        );
        assert!(asked
            .join()
            .unwrap()
            .starts_with("GET /api/window/next HTTP/1.1\r\n"));
        let (port, _) = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"focus\":false}");
        assert_eq!(ask_focus("127.0.0.1", port, None), Ok(Answer::default()));
        // Notices to post come with the answer.
        let (port, _) = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"focus\":false,\"notices\":[{\"key\":\"k\",\"title\":\"First draft is ready\",\"body\":\"Mom\",\"path\":\"/scripts/a\"}]}");
        assert_eq!(
            ask_focus("127.0.0.1", port, None).map(|answer| answer.notices),
            Ok(vec![Notice {
                key: "k".into(),
                title: "First draft is ready".into(),
                body: "Mom".into(),
                path: "/scripts/a".into()
            }])
        );
        // An older server without the route: asked again later.
        let (port, _) = serve_once("HTTP/1.1 404 Not Found\r\n\r\nnot found");
        assert_eq!(ask_focus("127.0.0.1", port, None), Err(()));
    }

    /// The window sends its build with the poll, and hears the server's.
    #[test]
    fn the_poll_carries_both_builds() {
        let (port, asked) = serve_once(
            "HTTP/1.1 200 OK\r\n\r\n{\"focus\":false,\"notices\":[],\"relaunch\":true,\"build\":\"nightly-77\"}",
        );
        let answer = ask_focus("127.0.0.1", port, Some("nightly-76")).unwrap();
        assert!(asked
            .join()
            .unwrap()
            .starts_with("GET /api/window/next?build=nightly-76 HTTP/1.1\r\n"));
        assert_eq!(
            (answer.relaunch, answer.build.as_deref()),
            (true, Some("nightly-77"))
        );
    }

    fn told(relaunch: bool, build: &str) -> Answer {
        Answer {
            relaunch,
            build: Some(build.to_owned()),
            ..Answer::default()
        }
    }

    /// The window's build is its own server's first answer's; it's sent only once quiet; a server
    /// of another build that says so opens the window again, once per build, and never a window
    /// onto a server that isn't its own.
    #[test]
    fn the_window_opens_again_only_for_a_newer_server_of_its_own() {
        let mut build = Build {
            owns: true,
            ..Build::default()
        };
        assert_eq!(build.to_send(true), None, "its build isn't known yet");
        build.heard(&told(false, "nightly-76"));
        build.heard(&told(false, "nightly-77"));
        assert_eq!(build.mine.as_deref(), Some("nightly-76"), "learnt once");
        assert_eq!(build.to_send(false), None, "not while it's used");
        assert_eq!(build.to_send(true), Some("nightly-76"));
        assert_eq!(build.relaunch_for(&told(false, "nightly-77")), None);
        assert_eq!(build.relaunch_for(&told(true, "nightly-76")), None);
        assert_eq!(
            build.relaunch_for(&told(true, "nightly-77")),
            Some("nightly-77")
        );
        // Opened again for 77: never again for it, but for the next.
        let mut again = Build {
            owns: true,
            relaunched_for: Some("nightly-77".to_owned()),
            ..Build::default()
        };
        again.heard(&told(false, "nightly-76"));
        assert_eq!(again.relaunch_for(&told(true, "nightly-77")), None);
        assert_eq!(
            again.relaunch_for(&told(true, "nightly-78")),
            Some("nightly-78")
        );
        // A server not its own (a terminal's, `edit app`'s) is never its build.
        let mut foreign = Build::default();
        foreign.heard(&told(false, "nightly-76"));
        assert_eq!((foreign.mine.as_ref(), foreign.to_send(true)), (None, None));
        assert_eq!(foreign.relaunch_for(&told(true, "nightly-77")), None);
        // A build that isn't a tag's isn't put in the URL.
        let odd = Build {
            owns: true,
            mine: Some("v0 0&x".to_owned()),
            ..Build::default()
        };
        assert_eq!(odd.to_send(true), None);
    }

    #[test]
    fn a_relaunch_opens_its_own_servers_pages_only() {
        let home = "http://127.0.0.1:7700/";
        assert!(same_origin("http://127.0.0.1:7700/projects/abc?x=1", home));
        assert!(!same_origin("http://127.0.0.1:7701/projects/abc", home));
        assert!(!same_origin("https://example.com/", home));
        assert!(!same_origin("not a url", home));
    }
}
