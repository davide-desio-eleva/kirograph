//! The database lock of the WASM SQLite driver, taken by the native writer too.
//!
//! node-sqlite3-wasm locks the database by creating the directory `kirograph.db.lock` for the
//! length of every transaction, reads included, and ignores the POSIX locks native SQLite uses.
//! The native writer takes the same directory around each of its transactions, so a KiroGraph
//! process (an MCP server, a hook) reading the database waits for it as for any other writer.
//! While it works it keeps this process's writer marker fresh (see src/db/db-lock.ts), so the
//! lock is never taken for one left behind by a dead process.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub struct DirLock {
    path: PathBuf,
    marker: Option<PathBuf>,
    last_touch: Option<Instant>,
}

/// How long to wait for a lock held by someone else before giving up.
const MAX_WAIT: Duration = Duration::from_secs(120);

impl DirLock {
    pub fn new(db_path: &Path, marker: Option<PathBuf>) -> Self {
        let mut p = db_path.as_os_str().to_owned();
        p.push(".lock");
        DirLock { path: PathBuf::from(p), marker, last_touch: None }
    }

    /// Refreshes this process's writer marker, at most once a second.
    pub fn touch_marker(&mut self) {
        let Some(marker) = &self.marker else { return };
        if self.last_touch.map(|t| t.elapsed() < Duration::from_secs(1)).unwrap_or(false) {
            return;
        }
        let now = SystemTime::now();
        let ok = fs::File::options().write(true).open(marker).and_then(|f| f.set_modified(now)).is_ok();
        if !ok {
            if let Some(dir) = marker.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let ms = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let _ = fs::write(marker, ms.to_string());
        }
        self.last_touch = Some(Instant::now());
    }

    /// Takes the lock, waiting while another connection holds it.
    pub fn acquire(&mut self) -> Result<LockGuard<'_>, String> {
        let start = Instant::now();
        let mut pause = Duration::from_micros(200);
        loop {
            self.touch_marker();
            match fs::create_dir(&self.path) {
                Ok(()) => return Ok(LockGuard { lock: self }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if start.elapsed() > MAX_WAIT {
                        return Err(format!("database is locked ({} held for over {}s)", self.path.display(), MAX_WAIT.as_secs()));
                    }
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(Duration::from_millis(20));
                }
                Err(e) => return Err(format!("cannot lock the database ({}): {e}", self.path.display())),
            }
        }
    }
}

pub struct LockGuard<'a> {
    lock: &'a mut DirLock,
}

impl LockGuard<'_> {
    pub fn touch(&mut self) {
        self.lock.touch_marker();
    }
}

impl Drop for LockGuard<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.lock.path);
    }
}
