// Where the app's own log goes (threadbear_client::log, the Swift app's
// AppLog): the installed app's ~/Library/Logs/Threadbear/desktop.log, or a
// scripted app's app.log beside its automation file, so a spec or an agent
// driving it can read why something didn't happen (`dev-app.sh log` reads
// the Swift app's). Any other launch (a debug build run by hand) writes to
// stderr only, and never into the installed app's file. A Windows release
// has no stderr to see (main.rs makes it a windowed program), so it writes
// to %LOCALAPPDATA%\Threadbear\Logs\desktop.log, panics included.
use crate::installed;
use std::path::{Path, PathBuf};

/// A build with no console: the Windows release (main.rs's
/// `windows_subsystem`, under the same conditions).
const NO_CONSOLE: bool = cfg!(all(windows, not(debug_assertions), not(feature = "automation")));

pub(crate) fn path() -> Option<PathBuf> {
    let launch = installed::launch();
    if launch.scripted {
        let file = std::env::var_os("THREADBEAR_AUTOMATION")?;
        return Some(Path::new(&file).parent()?.join("app.log"));
    }
    if NO_CONSOLE {
        let local = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
        return Some(PathBuf::from(local).join("Threadbear").join("Logs").join("desktop.log"));
    }
    launch.installed.then(|| installed::logs_dir().join("desktop.log"))
}

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Seconds since the app started, for lines a restart explains (a thread
/// switch that had to read, as a restart empties the kept threads).
pub(crate) fn uptime_s() -> u64 {
    STARTED.get_or_init(std::time::Instant::now).elapsed().as_secs()
}

/// From the app's start, before the connection's first line.
pub(crate) fn start() {
    STARTED.get_or_init(std::time::Instant::now);
    threadbear_core::wire::set_logger(|message| threadbear_client::log::write("decode", message));
    let Some(path) = path() else { return };
    // Owner-only, as every file the app writes (private_file_source.rs).
    let opened = path.parent().map_or(Ok(()), threadbear_core::private_file::dir).and_then(|()| threadbear_client::log::open(&path, threadbear_core::private_file::append));
    match opened {
        Ok(()) => threadbear_client::log::write("app", &format!("started {}", installed::launch().build.as_ref().map_or("(no build info)", |b| b.short.as_str()))),
        Err(e) => eprintln!("threadbear: couldn't open the app log at {}: {e}", path.display()),
    }
    // With no console, Rust's own panic message would go nowhere, so it goes
    // in the log too, before whatever hook was there (crash_reporting.rs).
    if NO_CONSOLE {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            threadbear_client::log::write("panic", &info.to_string());
            previous(info);
        }));
    }
}
