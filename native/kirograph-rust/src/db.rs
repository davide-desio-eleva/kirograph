//! Native writer for .kirograph/kirograph.db.
//!
//! Writes exactly what src/db/database.ts writes for a file (deleteNodesByFile,
//! deleteUnresolvedRefsByFile, upsertFile, upsertNodes, insertEdges, insertRouteMount,
//! insertUnresolvedRefs), in the same order, so the tables hold the same rows with the same
//! rowids as after an index by the TypeScript engine.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::types::ExtractedFile;

pub struct Db {
    pub conn: Connection,
    /// Time spent waiting for the write lock, in milliseconds.
    pub lock_wait_ms: f64,
}

/// How long in all a transaction waits for the write lock held by another process (SQLite waits
/// `busy_timeout` each time; past that it is tried again), as src/db/db-lock.ts does.
const MAX_WAIT: Duration = Duration::from_secs(120);

/// What writing one file changed, for the sync result.
#[derive(Default, Clone)]
pub struct FileWrite {
    pub path: String,
    pub is_new: bool,
    pub old_nodes: i64,
    pub old_edges: i64,
    pub nodes: i64,
    pub edges: i64,
    pub refs: i64,
}

pub struct WriteOptions {
    pub collect_stats: bool,
    pub collect_removed_ids: bool,
}

/// Removes the full-text rows of a file's nodes. Must run before the nodes are deleted: an
/// external-content FTS table reads the old values from them.
pub fn delete_fts_of_file(conn: &Connection, path: &str) -> Result<(), String> {
    conn.prepare_cached("DELETE FROM nodes_fts WHERE rowid IN (SELECT rowid FROM nodes WHERE file_path = ?)")
        .and_then(|mut s| s.execute([path]))
        .map_err(to_err)?;
    Ok(())
}

/// Adds the full-text rows of the given nodes, in grouped statements.
pub fn insert_fts(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < ids.len() {
        let size = GROUP_SIZES.iter().copied().find(|&g| g <= ids.len() - i).unwrap_or(1);
        let sql = format!(
            "INSERT OR REPLACE INTO nodes_fts (rowid, id, name, qualified_name, docstring, signature) SELECT rowid, id, name, qualified_name, COALESCE(docstring, ''), COALESCE(signature, '') FROM nodes WHERE id IN ({})",
            vec!["?"; size].join(",")
        );
        conn.prepare_cached(&sql)
            .and_then(|mut st| st.execute(rusqlite::params_from_iter(ids[i..i + size].iter())))
            .map_err(to_err)?;
        i += size;
    }
    Ok(())
}

/// Rows per grouped statement, largest first. Powers of two keep the distinct statements few.
const GROUP_SIZES: [usize; 10] = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1];

fn to_err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Another process holds the lock (SQLite already waited busy_timeout).
fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::DatabaseBusy)
}

impl Db {
    pub fn open(db_path: &Path, synchronous_off: bool) -> Result<Db, String> {
        let conn = Connection::open(db_path).map_err(to_err)?;
        // Same settings as the TypeScript connection (src/db/database.ts). The database is in WAL
        // mode (the TypeScript connection that opened it first switched it); SQLite's own locks
        // order the writers of every process.
        conn.execute_batch(&format!(
            "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous={}; PRAGMA cache_size=-262144; PRAGMA temp_store=MEMORY;",
            if synchronous_off { "OFF" } else { "NORMAL" }
        ))
        .map_err(to_err)?;
        conn.set_prepared_statement_cache_capacity(64);
        Ok(Db { conn, lock_wait_ms: 0.0 })
    }

    /// Runs `f` inside a transaction. It begins IMMEDIATE, taking the write lock at once (a
    /// deferred one that reads first fails in WAL when another process commits before its first
    /// write), and waits for a lock another process holds up to MAX_WAIT.
    pub fn transaction<T>(&mut self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let waited = Instant::now();
        loop {
            match self.conn.execute_batch("BEGIN IMMEDIATE") {
                Ok(()) => break,
                Err(e) if is_busy(&e) && waited.elapsed() < MAX_WAIT => continue,
                Err(e) => return Err(to_err(e)),
            }
        }
        self.lock_wait_ms += waited.elapsed().as_secs_f64() * 1000.0;
        match f(&self.conn) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT").map_err(to_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// path → (content hash, stat key) of every indexed file.
    pub fn file_hashes(&mut self) -> Result<HashMap<String, (String, Option<String>)>, String> {
        self.transaction(|conn| {
            let mut stmt = conn.prepare("SELECT path, content_hash, stat_key FROM files").map_err(to_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
                .map_err(to_err)?;
            let mut map = HashMap::new();
            for r in rows {
                let (p, h, k) = r.map_err(to_err)?;
                map.insert(p, (h, k));
            }
            Ok(map)
        })
    }
}

/// Languages whose references the TypeScript infra extractor resolves by exact qualified name.
const INFRA_LANGUAGES: &str = "('hcl', 'yaml', 'json', 'bash')";

/// Port of GraphDatabase.detachIncomingEdges (src/db/database.ts): the resolution edges coming
/// into the file's symbols from other files go back to unresolved references, filed under the file
/// they come from, so a rewritten file keeps its callers. The same statement, so both engines
/// write the same rows.
pub fn detach_incoming_edges(conn: &Connection, path: &str) -> Result<(), String> {
    let sql = format!(
        "INSERT INTO unresolved_refs (source_id, ref_name, ref_kind, file_path, line, column, metadata)
         SELECT e.source,
                CASE WHEN e.kind = 'imports' THEN s.name
                     WHEN e.kind = 'references' OR (e.kind = 'calls' AND t.language IN {infra}) THEN t.qualified_name
                     ELSE t.name END,
                CASE e.kind WHEN 'imports' THEN 'import'
                            WHEN 'references' THEN 'reference'
                            WHEN 'extends' THEN 'extends'
                            WHEN 'implements' THEN 'implements'
                            ELSE CASE WHEN t.language IN {infra} THEN 'qualified_call' ELSE 'function' END END,
                s.file_path, e.line, e.column, e.metadata
         FROM edges e
         JOIN nodes t ON t.id = e.target
         JOIN nodes s ON s.id = e.source
         WHERE t.file_path = ?1 AND s.file_path <> ?1
           AND e.kind IN ('calls', 'imports', 'extends', 'implements', 'references')
           AND e.confidence = 'extracted'
         ORDER BY e.id",
        infra = INFRA_LANGUAGES
    );
    conn.prepare_cached(&sql).and_then(|mut s| s.execute([path])).map_err(to_err)?;
    Ok(())
}

/// Port of GraphDatabase.detachDependentEdges and requeueEdges (src/db/database.ts): the call
/// edges whose resolution read the file (`edge_deps`: a supertype's file, a return type's
/// function's, a parameter's callers') go back to unresolved references, to be resolved again. The
/// same statements in the same order, so both engines write the same rows.
pub fn detach_dependent_edges(conn: &Connection, path: &str) -> Result<(), String> {
    let dep = format!("f:{path}");
    let rows: Vec<i64> = {
        let mut s = conn
            .prepare_cached(
                "SELECT e.rowid AS rid FROM edges e WHERE e.id IN (SELECT edge_id FROM edge_deps WHERE dep = ?) AND e.confidence = 'extracted'",
            )
            .map_err(to_err)?;
        let it = s.query_map([dep.as_str()], |r| r.get::<_, i64>(0)).map_err(to_err)?;
        it.collect::<Result<_, _>>().map_err(to_err)?
    };
    for chunk in rows.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        conn.execute(
            &format!(
                "INSERT INTO unresolved_refs (source_id, ref_name, ref_kind, file_path, line, column, metadata)
         SELECT e.source, t.name, 'function', s.file_path, e.line, e.column, e.metadata
         FROM edges e JOIN nodes t ON t.id = e.target JOIN nodes s ON s.id = e.source
         WHERE e.rowid IN ({marks})"
            ),
            rusqlite::params_from_iter(chunk.iter()),
        )
        .map_err(to_err)?;
        conn.execute(&format!("DELETE FROM edges WHERE rowid IN ({marks})"), rusqlite::params_from_iter(chunk.iter())).map_err(to_err)?;
    }
    Ok(())
}

/// Writes one file inside a savepoint: if anything fails, only this file's writes are undone.
pub fn write_file_in_savepoint(
    conn: &Connection,
    f: &ExtractedFile,
    indexed_at: i64,
    opts: &WriteOptions,
    removed_ids: &mut Vec<String>,
) -> Result<FileWrite, String> {
    conn.execute_batch("SAVEPOINT kg_rs").map_err(to_err)?;
    let mut ids = Vec::new();
    match write_file(conn, f, indexed_at, opts, &mut ids, None) {
        Ok(w) => {
            conn.execute_batch("RELEASE kg_rs").map_err(to_err)?;
            removed_ids.extend(ids);
            Ok(w)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO kg_rs; RELEASE kg_rs");
            Err(e)
        }
    }
}

fn json_text(v: &Option<Value>) -> Option<String> {
    v.as_ref().map(|v| serde_json::to_string(v).unwrap_or_default())
}

/// Writes one file. With `deferred_fts`, its full-text rows are neither removed nor added here:
/// the caller removed them before (delete_fts_of_file) and adds the ids collected in it after
/// (insert_fts), so FTS5 flushes once per transaction instead of once per statement.
pub fn write_file(
    conn: &Connection,
    f: &ExtractedFile,
    indexed_at: i64,
    opts: &WriteOptions,
    removed_ids: &mut Vec<String>,
    mut deferred_fts: Option<&mut Vec<String>>,
) -> Result<FileWrite, String> {
    let path = f.file_path.as_str();
    let mut w = FileWrite { path: path.to_string(), ..Default::default() };

    if opts.collect_stats {
        w.is_new = conn
            .prepare_cached("SELECT 1 FROM files WHERE path = ?")
            .and_then(|mut s| s.query_row([path], |_| Ok(())).optional())
            .map_err(to_err)?
            .is_none();
        w.old_nodes = conn
            .prepare_cached("SELECT count(*) FROM nodes WHERE file_path = ?")
            .and_then(|mut s| s.query_row([path], |r| r.get(0)))
            .map_err(to_err)?;
        w.old_edges = conn
            .prepare_cached(
                "SELECT count(*) FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?1) OR target IN (SELECT id FROM nodes WHERE file_path = ?1)",
            )
            .and_then(|mut s| s.query_row([path], |r| r.get(0)))
            .map_err(to_err)?;
    }

    // deleteNodesByFile
    let old_ids: Vec<String> = {
        let mut s = conn.prepare_cached("SELECT id FROM nodes WHERE file_path = ?").map_err(to_err)?;
        let rows = s.query_map([path], |r| r.get::<_, String>(0)).map_err(to_err)?;
        rows.collect::<Result<_, _>>().map_err(to_err)?
    };
    if !old_ids.is_empty() {
        detach_incoming_edges(conn, path)?;
        detach_dependent_edges(conn, path)?;
        conn.prepare_cached(
            "DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?1) OR target IN (SELECT id FROM nodes WHERE file_path = ?1)",
        )
        .and_then(|mut s| s.execute([path]))
        .map_err(to_err)?;
        if deferred_fts.is_none() {
            delete_fts_of_file(conn, path)?;
        }
        conn.prepare_cached("DELETE FROM nodes WHERE file_path = ?").and_then(|mut s| s.execute([path])).map_err(to_err)?;
        if opts.collect_removed_ids {
            removed_ids.extend(old_ids);
        }
    }

    // deleteUnresolvedRefsByFile
    conn.prepare_cached("DELETE FROM unresolved_refs WHERE file_path = ?").and_then(|mut s| s.execute([path])).map_err(to_err)?;
    conn.prepare_cached("DELETE FROM route_mounts WHERE file_path = ?").and_then(|mut s| s.execute([path])).map_err(to_err)?;

    // upsertFile
    conn.prepare_cached(
        "INSERT OR REPLACE INTO files (path, content_hash, language, file_size, symbol_count, indexed_at, stat_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .and_then(|mut s| s.execute(params![path, f.content_hash, f.language, f.file_size, f.nodes.len() as i64, indexed_at, f.stat_key]))
    .map_err(to_err)?;

    // upsertNodes: when an id appears twice the later node wins, at the place of the first
    let mut unique: IndexMap<&str, &crate::types::GraphNode> = IndexMap::new();
    for n in &f.nodes {
        unique.insert(n.id.as_str(), n);
    }
    {
        let mut ins = conn
            .prepare_cached(
                "INSERT OR REPLACE INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters, updated_at, complexity_cyclomatic, complexity_cognitive, complexity_halstead, maintainability_index, nesting_depth, return_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .map_err(to_err)?;
        for n in unique.values() {
            let halstead = n.complexity_halstead.as_ref().map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
            ins.execute(params![
                n.id,
                n.kind,
                n.name,
                n.qualified_name,
                n.file_path,
                n.language,
                n.start_line,
                n.end_line,
                n.start_column,
                n.end_column,
                n.docstring,
                n.signature,
                n.visibility,
                n.is_exported as i64,
                n.is_async as i64,
                n.is_static as i64,
                n.is_abstract as i64,
                json_text(&n.decorators),
                json_text(&n.type_parameters),
                n.updated_at,
                n.complexity_cyclomatic,
                n.complexity_cognitive,
                halstead,
                n.maintainability_index,
                n.nesting_depth,
                n.return_type,
            ])
            .map_err(to_err)?;
        }
        let ids: Vec<String> = unique.keys().map(|k| k.to_string()).collect();
        match deferred_fts.as_mut() {
            Some(list) => list.extend(ids),
            None => insert_fts(conn, &ids)?,
        }
    }
    w.nodes = f.nodes.len() as i64;

    // insertEdges
    {
        let mut ins = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, column, confidence, confidence_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .map_err(to_err)?;
        for e in &f.edges {
            ins.execute(params![
                e.source,
                e.target,
                e.kind,
                json_text(&e.metadata),
                e.line,
                e.column,
                e.confidence.as_deref().unwrap_or("extracted"),
                e.confidence_score.unwrap_or(1.0),
            ])
            .map_err(to_err)?;
        }
    }
    w.edges = f.edges.len() as i64;

    // insertRouteMount
    if let Some(mounts) = &f.route_mounts {
        let mut ins = conn
            .prepare_cached(
                "INSERT INTO route_mounts (file_path, plugin_name, imported_name, specifier, prefix, line, inline_start, inline_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .map_err(to_err)?;
        for m in mounts {
            ins.execute(params![path, m.plugin_name, m.imported_name, m.specifier, m.prefix, m.line, m.inline_start, m.inline_end])
                .map_err(to_err)?;
        }
    }

    // insertUnresolvedRefs
    {
        let mut ins = conn
            .prepare_cached(
                "INSERT INTO unresolved_refs (source_id, ref_name, ref_kind, file_path, line, column, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .map_err(to_err)?;
        for r in &f.unresolved_refs {
            let meta = r.metadata.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default());
            ins.execute(params![r.source_id, r.ref_name, r.ref_kind, path, r.line, r.column, meta]).map_err(to_err)?;
        }
    }
    w.refs = f.unresolved_refs.len() as i64;
    Ok(w)
}
