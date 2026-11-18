//! Edit's native addon: `edit-engine` and `edit-core` for the TypeScript
//! server, through napi-rs. Bindings only:
//! every function here converts its arguments, calls the engine, and turns a
//! `Result<T, String>` into a value or an `Error` with the same message (the
//! agent reads these strings).
//!
//! How each call runs: sync calls take microseconds to a few
//! milliseconds; async ones run on napi's tokio runtime in `spawn_blocking`;
//! long jobs report through an unref'd `ThreadsafeFunction`. Every entry
//! point contains panics (`edit_engine::util::catch`): a crash becomes
//! "<what> crashed (…); this is a bug in Edit", never a dead server.

// napi-derive registers the bindings only outside `cargo test`, so a test
// build sees them as unused; the bun tests (`test/`) exercise them.
#![cfg_attr(test, allow(dead_code))]

mod analysis;
mod export;
mod lifecycle;
mod media;
mod project;
mod render;
mod sound;

/// On Linux the addon's memory comes from mimalloc, not glibc's malloc. glibc gives each thread that allocates
/// at once its own arena (up to 8 a core: 256 on mandalorian), and what's freed in one stays there. Every export
/// starts its own threads (decoders, planner, compositor), and each landed on another arena. So the server
/// kept what every export had used: Nov 19, the Linux prod Edit's `edit` reached 10.3 GB, nearly all of it free
/// memory in 211 of glibc's 64 MB heaps, and was OOM-killed at its 10 GB limit. Its two agents were rendering effects
/// and checking cuts on two 2-hour compilations. Ten rounds of four exports of a 2-hour video's 1080p kept 1.5 GB
/// (73 MB after a `malloc_trim`); with mimalloc, freed pages handed back at once (`hand_back_freed_memory`), 67 MB,
/// the exports as fast. A Mac's allocator keeps no arena per thread.
#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// `mi_option_purge_delay` in mimalloc.h's `mi_option_e` (libmimalloc-sys has no constant for it; its 15th is
/// an older name). `the_purge_delay_is_the_option_set` checks it's still that option.
#[cfg(target_os = "linux")]
const PURGE_DELAY: libmimalloc_sys::mi_option_t = 15;

/// mimalloc hands freed pages back to the system at once, not a second later (its default): with the delay, the pages
/// of the threads that had ended were kept (an export's decoders: 700 MB after the ten rounds above).
pub(crate) fn hand_back_freed_memory() {
    #[cfg(target_os = "linux")]
    // SAFETY: sets one of mimalloc's options; any thread may, at any time.
    unsafe {
        libmimalloc_sys::mi_option_set(PURGE_DELAY, 0);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    /// The option is mimalloc's purge delay: a second until it's set (its default), then 0.
    #[test]
    fn the_purge_delay_is_the_option_set() {
        // SAFETY: reads one of mimalloc's options.
        let before = unsafe { libmimalloc_sys::mi_option_get(super::PURGE_DELAY) };
        assert_eq!(
            before, 1000,
            "mimalloc's purge delay is a second by default"
        );
        super::hand_back_freed_memory();
        // SAFETY: as above.
        assert_eq!(
            unsafe { libmimalloc_sys::mi_option_get(super::PURGE_DELAY) },
            0
        );
    }
}

/// An `Error` whose message is exactly `message`.
pub(crate) fn fail(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message.into())
}

/// Runs quick work on the calling (JS) thread, a panic contained.
pub(crate) fn sync<T>(what: &str, work: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    edit_engine::util::catch(what, work)
        .and_then(|result| result)
        .map_err(fail)
}

/// Runs blocking work on the runtime's blocking pool, a panic contained.
pub(crate) async fn blocking<T: Send + 'static>(
    what: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> napi::Result<T> {
    tokio::task::spawn_blocking(move || {
        edit_engine::util::catch(what, work).and_then(|result| result)
    })
    .await
    .map_err(|error| fail(format!("{what} crashed ({error}); this is a bug in Edit")))?
    .map_err(fail)
}

/// A progress callback: called with 0–1 as work goes, never keeping the
/// process alive (weak), never blocking the native side (non-blocking calls).
pub(crate) type Progress =
    napi::threadsafe_function::ThreadsafeFunction<f64, (), f64, napi::Status, false, true>;

pub(crate) fn report(progress: &Progress, value: f64) {
    progress.call(
        value,
        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// The media cache `init` gave.
pub(crate) fn cache_dir() -> Result<std::path::PathBuf, String> {
    edit_engine::util::cache_dir()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "the native engine isn't initialised (call init first)".to_owned())
}
