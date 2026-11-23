//! KiroGraph's native engine (config `"engine": "rust"`).
//!
//! It takes over extraction (parse every file) and the writing of the graph. Reference
//! resolution, and everything else, stays in TypeScript, and the database is the same file with
//! the same rows, so the rest of KiroGraph does not know which engine wrote it.

#![deny(clippy::all)]

pub mod complexity;
pub mod db;
pub mod engine;
pub mod extract;
pub mod jstext;
pub mod routes;
pub mod types;

pub mod grammars {
    include!(concat!(env!("OUT_DIR"), "/grammars.rs"));
}

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use napi_derive::napi;

/// Languages the engine extracts itself: those whose extraction is ported from
/// src/extraction (every field of every file the same, see test/rust/extract-parity.js). Other
/// files are extracted by the TypeScript engine and handed over already extracted.
pub const NATIVE_LANGUAGES: &[&str] = &[];

#[napi]
pub fn native_languages() -> Vec<String> {
    NATIVE_LANGUAGES.iter().filter(|l| engine::grammar_for(l).is_some()).map(|s| s.to_string()).collect()
}

#[napi(object)]
pub struct GrammarFingerprint {
    pub language: String,
    /// What the compiled grammar has: ABI, parse states, node kinds, fields, hash of the names.
    pub abi: u32,
    pub states: u32,
    pub kinds: u32,
    pub fields: u32,
    pub hash: String,
    /// What grammars/grammars.json records (the WASM file's): both must be equal.
    pub recorded: String,
}

/// The fingerprint of every compiled grammar, measured as scripts/grammars.mjs measures a WASM
/// file, with the recorded one: the two engines parse a file into the same tree only when equal.
#[napi]
pub fn grammar_fingerprints() -> Vec<GrammarFingerprint> {
    use sha2::{Digest, Sha256};
    let mut out = Vec::new();
    for lang in grammars::GRAMMAR_LANGUAGES {
        let Some(f) = grammars::grammar(lang) else { continue };
        let l = tree_sitter::Language::new(f);
        let kinds: Vec<String> = (0..l.node_kind_count() as u16)
            .map(|i| format!("{} {}", if l.node_kind_is_named(i) { "N" } else { "a" }, l.node_kind_for_id(i).unwrap_or("")))
            .collect();
        let fields: Vec<String> = (1..=l.field_count() as u16).map(|i| l.field_name_for_id(i).unwrap_or("").to_string()).collect();
        let digest = Sha256::digest(format!("{}\n\n{}", kinds.join("\n"), fields.join("\n")).as_bytes());
        let rec = grammars::recorded_fingerprint(lang)
            .map(|(a, s, k, f, h)| format!("{a}/{s}/{k}/{f}/{h}"))
            .unwrap_or_default();
        out.push(GrammarFingerprint {
            language: lang.to_string(),
            abi: l.abi_version() as u32,
            states: l.parse_state_count() as u32,
            kinds: l.node_kind_count() as u32,
            fields: l.field_count() as u32,
            hash: hex::encode(digest)[..16].to_string(),
            recorded: rec,
        });
    }
    out
}

#[napi]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi(object)]
pub struct IndexEntry {
    /// Absolute path of a file the engine parses.
    pub path: Option<String>,
    pub language: Option<String>,
    /// An ExtractedFile from the TypeScript engine, as JSON.
    pub extracted: Option<String>,
    /// The file's stat key, taken before it was read; recorded with the file.
    pub stat_key: Option<String>,
}

#[napi(object)]
pub struct IndexOptions {
    pub project_root: String,
    pub db_path: String,
    pub force: bool,
    pub enable_complexity: bool,
    pub max_file_size: f64,
    pub track_oversize: bool,
    pub synchronous_off: bool,
    pub collect_stats: bool,
    pub collect_removed_ids: bool,
    pub threads: Option<u32>,
}

#[napi(object)]
pub struct FileWriteResult {
    pub path: String,
    pub is_new: bool,
    pub old_nodes: i64,
    pub old_edges: i64,
    pub nodes: i64,
    pub edges: i64,
}

#[napi(object)]
pub struct IndexResult {
    pub files_indexed: i64,
    pub nodes_created: i64,
    pub edges_created: i64,
    pub unchanged: i64,
    pub unchanged_paths: Vec<String>,
    pub errors: Vec<String>,
    pub files: Vec<FileWriteResult>,
    pub removed_node_ids: Vec<String>,
    pub timings: HashMap<String, f64>,
}

type Progress = Option<ThreadsafeFunction<(u32, u32), ErrorStrategy::Fatal>>;

fn report(progress: &Progress, current: usize, total: usize) {
    if let Some(p) = progress {
        p.call((current as u32, total as u32), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn make_progress(cb: Option<JsFunction>) -> Result<Progress> {
    match cb {
        None => Ok(None),
        Some(f) => {
            let tsfn: ThreadsafeFunction<(u32, u32), ErrorStrategy::Fatal> =
                f.create_threadsafe_function(0, |ctx: napi::threadsafe_function::ThreadSafeCallContext<(u32, u32)>| {
                    Ok(vec![ctx.env.create_uint32(ctx.value.0)?, ctx.env.create_uint32(ctx.value.1)?])
                })?;
            Ok(Some(tsfn))
        }
    }
}

pub struct IndexTask {
    params: Option<(engine::IndexParams, Vec<engine::Entry>)>,
    progress: Progress,
}

impl Task for IndexTask {
    type Output = engine::IndexOutcome;
    type JsValue = IndexResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let (params, entries) = self.params.take().ok_or_else(|| Error::from_reason("task already run"))?;
        let progress = self.progress.clone();
        engine::run_index(&params, entries, |c, t| report(&progress, c, t)).map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(IndexResult {
            files_indexed: out.files_indexed,
            nodes_created: out.nodes_created,
            edges_created: out.edges_created,
            unchanged: out.unchanged,
            unchanged_paths: out.unchanged_paths,
            errors: out.errors,
            files: out
                .files
                .into_iter()
                .map(|w| FileWriteResult {
                    path: w.path,
                    is_new: w.is_new,
                    old_nodes: w.old_nodes,
                    old_edges: w.old_edges,
                    nodes: w.nodes,
                    edges: w.edges,
                })
                .collect(),
            removed_node_ids: out.removed_node_ids,
            timings: out.timings,
        })
    }
}

/// Extracts and writes the given files, in order, in a background thread.
#[napi(ts_return_type = "Promise<IndexResult>")]
pub fn index_files(options: IndexOptions, entries: Vec<IndexEntry>, on_progress: Option<JsFunction>) -> Result<AsyncTask<IndexTask>> {
    let threads = options
        .threads
        .map(|t| t as usize)
        .filter(|&t| t > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
    let params = engine::IndexParams {
        project_root: options.project_root,
        db_path: options.db_path,
        force: options.force,
        enable_complexity: options.enable_complexity,
        max_file_size: options.max_file_size.max(0.0) as u64,
        track_oversize: options.track_oversize,
        synchronous_off: options.synchronous_off,
        collect_stats: options.collect_stats,
        collect_removed_ids: options.collect_removed_ids,
        threads,
    };
    let mut list = Vec::with_capacity(entries.len());
    for e in entries {
        if let Some(json) = e.extracted {
            list.push(engine::Entry::Extracted { json, stat_key: e.stat_key });
        } else if let (Some(path), Some(language)) = (e.path, e.language) {
            list.push(engine::Entry::Native { path, language, stat_key: e.stat_key });
        }
    }
    Ok(AsyncTask::new(IndexTask { params: Some((params, list)), progress: make_progress(on_progress)? }))
}

/// Extracts one file without writing it, as JSON (for the parity tests).
#[napi]
pub fn extract_file_json(path: String, project_root: String, language: String, enable_complexity: bool) -> Result<Option<String>> {
    let Some(lang_fn) = engine::grammar_for(&language) else { return Ok(None) };
    let bytes = std::fs::read(&path).map_err(|e| Error::from_reason(e.to_string()))?;
    let source = String::from_utf8_lossy(&bytes);
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter::Language::new(lang_fn)).map_err(|e| Error::from_reason(e.to_string()))?;
    let rel = engine::rel_path(std::path::Path::new(&project_root), std::path::Path::new(&path));
    let f = extract::extract_source(&mut parser, &source, &rel, &language, enable_complexity, 0).map_err(Error::from_reason)?;
    Ok(Some(serde_json::to_string(&f).map_err(|e| Error::from_reason(e.to_string()))?))
}
