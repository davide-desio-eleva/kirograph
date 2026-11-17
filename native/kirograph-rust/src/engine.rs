//! The index/sync extraction phase: read, hash, parse (in parallel) and write, in file order.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use rayon::prelude::*;
use tree_sitter::Parser;

use crate::db::{delete_fts_of_file, insert_fts, write_file, write_file_in_savepoint, Db, FileWrite, WriteOptions};
use crate::extract::{extract_source, sha256_hex};
use crate::grammars;
use crate::types::ExtractedFile;

/// One file to index, in the order the files are written.
pub enum Entry {
    /// Parsed here.
    Native { path: String, language: String, stat_key: Option<String> },
    /// Extracted by the TypeScript engine (a language without a native extractor), as JSON.
    Extracted { json: String, stat_key: Option<String> },
}

pub struct IndexParams {
    pub project_root: String,
    pub db_path: String,
    pub marker_path: Option<String>,
    pub force: bool,
    pub enable_complexity: bool,
    pub max_file_size: u64,
    /// A file over `max_file_size` is skipped (index) or recorded without symbols (sync).
    pub track_oversize: bool,
    pub synchronous_off: bool,
    pub collect_stats: bool,
    pub collect_removed_ids: bool,
    pub threads: usize,
}

#[derive(Default)]
pub struct IndexOutcome {
    pub files_indexed: i64,
    pub nodes_created: i64,
    pub edges_created: i64,
    pub unchanged: i64,
    pub unchanged_paths: Vec<String>,
    pub errors: Vec<String>,
    pub files: Vec<FileWrite>,
    pub removed_node_ids: Vec<String>,
    pub timings: HashMap<String, f64>,
}

enum Prepared {
    Write(ExtractedFile),
    /// Unchanged: its relative path (its stat key is recorded by the caller).
    Unchanged(String),
    Skip,
    Error(String),
}

/// Files parsed and written per round. Bounds memory, and how long the database lock is held.
const CHUNK: usize = 1024;

thread_local! {
    static PARSERS: RefCell<HashMap<String, Parser>> = RefCell::new(HashMap::new());
}

/// The grammar a language is parsed with (JSX files use the JavaScript grammar).
pub fn grammar_for(language: &str) -> Option<tree_sitter_language::LanguageFn> {
    grammars::grammar(if language == "jsx" { "javascript" } else { language })
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `validatePath` in extractor.ts: the file must be inside the project, symlinks resolved.
fn inside_project(file: &Path, real_root: Option<&Path>, root: &Path) -> bool {
    match (std::fs::canonicalize(file), real_root) {
        (Ok(real), Some(rr)) => real == rr || real.starts_with(rr),
        _ => {
            let normalized = normalize(file);
            normalized.to_string_lossy().starts_with(&*normalize(root).to_string_lossy())
        }
    }
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `path.relative(root, file)` with forward slashes, for a file inside root.
pub fn rel_path(root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(root).map(Path::to_path_buf).unwrap_or_else(|_| file.to_path_buf());
    rel.to_string_lossy().replace('\\', "/")
}

fn prepare_native(
    p: &IndexParams,
    root: &Path,
    real_root: Option<&Path>,
    hashes: &HashMap<String, (String, Option<String>)>,
    abs: &str,
    language: &str,
    stat_key: Option<&str>,
) -> Prepared {
    let file = Path::new(abs);
    let rel = rel_path(root, file);
    let known = hashes.get(&rel);
    // The stat key the index recorded is the file's current one: unchanged, not even read
    if let (Some((_, Some(recorded))), Some(current)) = (known, stat_key) {
        if recorded == current && (p.track_oversize || !p.force) {
            return Prepared::Unchanged(rel);
        }
    }
    let known = known.map(|(h, _)| h);
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(_) => return Prepared::Skip,
    };
    let oversize = bytes.len() as u64 > p.max_file_size;

    if p.track_oversize {
        // sync: an unchanged file is skipped by the hash of its bytes, before it is parsed
        if let Some(h) = known {
            if !oversize && sha256_hex(&bytes) == *h {
                return Prepared::Unchanged(rel);
            }
        }
    } else {
        if oversize {
            return Prepared::Skip;
        }
        if !p.force {
            if let Some(h) = known {
                if sha256_hex(&bytes) == *h {
                    return Prepared::Unchanged(rel);
                }
            }
        }
    }

    if !inside_project(file, real_root, root) {
        return Prepared::Skip;
    }
    let source = String::from_utf8_lossy(&bytes);
    let now = now_ms();

    let extracted = if source.len() as u64 > p.max_file_size {
        // Recorded without symbols, like extractFile does for an oversized file
        ExtractedFile {
            file_path: rel.clone(),
            language: language.to_string(),
            content_hash: sha256_hex(source.as_bytes()),
            file_size: source.len() as i64,
            ..Default::default()
        }
    } else {
        let Some(lang_fn) = grammar_for(language) else {
            return Prepared::Error(format!("{abs}: no native grammar for {language}"));
        };
        let result = PARSERS.with(|cell| {
            let mut parsers = cell.borrow_mut();
            let parser = parsers.entry(language.to_string()).or_insert_with(|| {
                let mut parser = Parser::new();
                let _ = parser.set_language(&tree_sitter::Language::new(lang_fn));
                parser
            });
            extract_source(parser, &source, &rel, language, p.enable_complexity, now)
        });
        match result {
            Ok(e) => e,
            Err(e) => return Prepared::Error(format!("{abs}: {e}")),
        }
    };

    if p.track_oversize {
        if let Some(h) = known {
            if *h == extracted.content_hash {
                return Prepared::Unchanged(rel);
            }
        }
    }
    let mut extracted = extracted;
    extracted.stat_key = stat_key.map(str::to_string);
    Prepared::Write(extracted)
}

pub fn run_index(p: &IndexParams, entries: Vec<Entry>, mut progress: impl FnMut(usize, usize)) -> Result<IndexOutcome, String> {
    let mut out = IndexOutcome::default();
    let root = PathBuf::from(&p.project_root);
    let real_root = std::fs::canonicalize(&root).ok();
    let mut db = Db::open(Path::new(&p.db_path), p.marker_path.as_ref().map(PathBuf::from), p.synchronous_off)?;

    let t0 = Instant::now();
    let hashes = if p.force && !p.track_oversize { HashMap::new() } else { db.file_hashes()? };
    *out.timings.entry("hashes".into()).or_default() += t0.elapsed().as_secs_f64() * 1000.0;

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(p.threads)
        // Deep syntax trees are walked recursively, as the TypeScript extractor does
        .stack_size(64 * 1024 * 1024)
        .build()
        .map_err(|e| e.to_string())?;

    let opts = WriteOptions { collect_stats: p.collect_stats, collect_removed_ids: p.collect_removed_ids };
    let total = entries.len();
    let mut done = 0usize;
    // The next round is parsed while this one is written
    let (tx, rx) = std::sync::mpsc::sync_channel::<(Vec<Entry>, Vec<Prepared>, f64)>(1);
    // A full index (synchronous off) writes larger rounds: each transaction copies the index pages
    // it changes to the rollback journal, so fewer transactions write less
    let chunk_size = if p.synchronous_off { CHUNK * 4 } else { CHUNK };
    std::thread::scope(|scope| -> Result<(), String> {
        let (root, real_root, hashes, pool) = (&root, &real_root, &hashes, &pool);
        scope.spawn(move || {
            let mut entries = entries.into_iter().peekable();
            while entries.peek().is_some() {
                let chunk: Vec<Entry> = entries.by_ref().take(chunk_size).collect();
                let t_parse = Instant::now();
                let prepared: Vec<Prepared> = pool.install(|| {
                    chunk
                        .par_iter()
                        .map(|e| match e {
                            Entry::Native { path, language, stat_key } => {
                                prepare_native(p, root, real_root.as_deref(), hashes, path, language, stat_key.as_deref())
                            }
                            Entry::Extracted { json, stat_key } => match serde_json::from_str::<ExtractedFile>(json) {
                                Ok(mut f) => {
                                    f.stat_key = stat_key.clone();
                                    Prepared::Write(f)
                                }
                                Err(err) => Prepared::Error(format!("invalid extraction result: {err}")),
                            },
                        })
                        .collect()
                });
                let ms = t_parse.elapsed().as_secs_f64() * 1000.0;
                if tx.send((chunk, prepared, ms)).is_err() {
                    break; // the writer stopped
                }
            }
        });

        for (chunk, prepared, parse_ms) in rx {
            *out.timings.entry("parse".into()).or_default() += parse_ms;
            let t_write = Instant::now();
            let mut writes = Vec::new();
            let mut errors = Vec::new();
            let mut removed = Vec::new();
            let mut unchanged = 0i64;
        let mut unchanged_paths: Vec<String> = Vec::new();
            for prep in &prepared {
                match prep {
                    Prepared::Unchanged(rel) => {
                        unchanged += 1;
                        unchanged_paths.push(rel.clone());
                    }
                    Prepared::Error(e) => errors.push(e.clone()),
                    _ => {}
                }
            }
            out.unchanged += unchanged;
            out.unchanged_paths.extend(unchanged_paths);
            // Fast path: the whole round in one transaction. A savepoint per file (so that one file
            // that fails does not undo the others) makes FTS5 flush its pending index each time, so
            // savepoints are used only when the fast path fails, to find and skip the failing file.
            let fast = db.transaction(|conn, guard| {
                let mut w = Vec::new();
                let mut r = Vec::new();
                let mut fts = Vec::new();
                for prep in &prepared {
                    if let Prepared::Write(f) = prep {
                        delete_fts_of_file(conn, &f.file_path)?;
                    }
                }
                for prep in &prepared {
                    if let Prepared::Write(f) = prep {
                        guard.touch();
                        w.push(write_file(conn, f, now_ms(), &opts, &mut r, Some(&mut fts))?);
                    }
                }
                insert_fts(conn, &fts)?;
                Ok((w, r))
            });
            match fast {
                Ok((w, r)) => {
                    writes = w;
                    removed = r;
                }
                Err(_) => {
                    db.transaction(|conn, guard| {
                        for (entry, prep) in chunk.iter().zip(prepared.iter()) {
                            if let Prepared::Write(f) = prep {
                                guard.touch();
                                match write_file_in_savepoint(conn, f, now_ms(), &opts, &mut removed) {
                                    Ok(w) => writes.push(w),
                                    Err(e) => {
                                        let name = match entry {
                                            Entry::Native { path, .. } => path.clone(),
                                            Entry::Extracted { .. } => f.file_path.clone(),
                                        };
                                        errors.push(format!("{name}: {e}"));
                                    }
                                }
                            }
                        }
                        Ok(())
                    })?;
                }
            }
            *out.timings.entry("write".into()).or_default() += t_write.elapsed().as_secs_f64() * 1000.0;

            for w in &writes {
                out.files_indexed += 1;
                out.nodes_created += w.nodes;
                out.edges_created += w.edges;
            }
            out.files.extend(writes);
            out.errors.extend(errors);
            out.removed_node_ids.extend(removed);
            done += chunk.len();
            progress(done, total);
        }
        Ok(())
    })?;
    out.timings.insert("lockWait".into(), db.lock_wait_ms);
    Ok(out)
}
