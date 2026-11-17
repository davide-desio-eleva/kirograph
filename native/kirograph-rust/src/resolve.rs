//! Port of ReferenceResolver.resolveUnresolvedRefs (src/resolution/index.ts) and the name
//! matcher (src/resolution/name-matcher.ts).
//!
//! Candidates are kept in table order, as the TypeScript caches keep them, so "the first
//! candidate" is the same node in both engines.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use rusqlite::{params_from_iter, Connection, OptionalExtension};

use crate::db::Db;
use crate::jstext::js_lower;

struct NodeRow {
    id: String,
    kind: String,
    name: String,
    qualified_name: String,
}

struct Caches {
    nodes: Vec<NodeRow>,
    by_name: HashMap<String, Vec<usize>>,
    by_lower: HashMap<String, Vec<usize>>,
    /// Insertion order of first appearance, value of the last node with that name (a JS Map).
    by_qualified: IndexMap<String, usize>,
    namespace_prefix: HashMap<String, String>,
}

fn to_err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn warm(conn: &Connection) -> Result<Caches, String> {
    let mut stmt = conn.prepare("SELECT id, kind, name, qualified_name FROM nodes").map_err(to_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(NodeRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                qualified_name: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })
        .map_err(to_err)?;
    let mut c = Caches {
        nodes: Vec::new(),
        by_name: HashMap::new(),
        by_lower: HashMap::new(),
        by_qualified: IndexMap::new(),
        namespace_prefix: HashMap::new(),
    };
    for r in rows {
        let n = r.map_err(to_err)?;
        let i = c.nodes.len();
        c.by_name.entry(n.name.clone()).or_default().push(i);
        if !n.qualified_name.is_empty() {
            c.by_qualified.insert(n.qualified_name.clone(), i);
        }
        c.by_lower.entry(js_lower(&n.name)).or_default().push(i);
        c.nodes.push(n);
    }
    for (qual, &i) in &c.by_qualified {
        let n = &c.nodes[i];
        if matches!(n.kind.as_str(), "class" | "interface" | "namespace" | "module") {
            let parts: Vec<&str> = qual.split('.').collect();
            for k in 1..parts.len() {
                let prefix = parts[..k].join(".");
                c.namespace_prefix.entry(prefix).or_insert_with(|| n.id.clone());
            }
        }
    }
    Ok(c)
}

impl Caches {
    fn name(&self, name: &str) -> &[usize] {
        self.by_name.get(name).map(|v| v.as_slice()).unwrap_or(&[])
    }

    fn qualified(&self, q: &str) -> Option<&NodeRow> {
        self.by_qualified.get(q).map(|&i| &self.nodes[i])
    }

    /// `matchReference` over the lowercase candidates.
    fn match_reference(&self, ref_name: &str, candidates: &[usize], threshold: f64) -> Option<String> {
        if ref_name.is_empty() || candidates.is_empty() {
            return None;
        }
        let nodes = candidates.iter().map(|&i| &self.nodes[i]);
        if 0.95 >= threshold {
            if let Some(n) = nodes.clone().find(|n| n.qualified_name == ref_name) {
                return Some(n.id.clone());
            }
        }
        if 0.9 >= threshold {
            if let Some(n) = nodes.clone().find(|n| n.name == ref_name) {
                return Some(n.id.clone());
            }
        }
        if ref_name.contains('.') && 0.85 >= threshold {
            let method = &ref_name[ref_name.rfind('.').unwrap() + 1..];
            if let Some(n) = nodes.clone().find(|n| n.name == method) {
                return Some(n.id.clone());
            }
        }
        if 0.5 >= threshold {
            let lower = js_lower(ref_name);
            if let Some(n) = nodes.clone().find(|n| js_lower(&n.name) == lower) {
                return Some(n.id.clone());
            }
        }
        None
    }

    fn resolve_type_name(&self, name: &str) -> Option<String> {
        let cands = self.name(name);
        if !cands.is_empty() {
            let preferred = cands
                .iter()
                .map(|&i| &self.nodes[i])
                .find(|n| matches!(n.kind.as_str(), "class" | "interface" | "trait" | "protocol"));
            return Some(preferred.unwrap_or(&self.nodes[cands[0]]).id.clone());
        }
        self.qualified(name).map(|n| n.id.clone())
    }

    fn resolve_import_path(&self, conn: &Connection, import_path: &str, source_file: &str) -> Result<Option<String>, String> {
        if import_path.starts_with('.') {
            let source_dir = match source_file.rfind('/') {
                Some(i) => &source_file[..=i],
                None => "",
            };
            let joined = format!("{source_dir}{import_path}");
            let mut normalized: Vec<&str> = Vec::new();
            for seg in joined.split('/') {
                if seg == ".." {
                    normalized.pop();
                } else if seg != "." {
                    normalized.push(seg);
                }
            }
            let base = normalized.join("/");
            let candidates = [
                base.clone(),
                format!("{base}.ts"),
                format!("{base}.tsx"),
                format!("{base}.js"),
                format!("{base}.jsx"),
                format!("{base}/index.ts"),
                format!("{base}/index.tsx"),
                format!("{base}/index.js"),
            ];
            let mut stmt = conn.prepare_cached("SELECT id FROM nodes WHERE file_path = ? LIMIT 1").map_err(to_err)?;
            for c in &candidates {
                if let Some(id) = stmt.query_row([c], |r| r.get::<_, String>(0)).optional().map_err(to_err)? {
                    return Ok(Some(id));
                }
            }
            return Ok(None);
        }

        if import_path.ends_with(".*") || import_path.ends_with('*') {
            let ns = import_path.strip_suffix(".*").unwrap_or(import_path);
            let ns = ns.strip_suffix('*').unwrap_or(ns);
            return Ok(self.namespace_prefix.get(ns).cloned());
        }

        if let Some(n) = self.qualified(import_path) {
            return Ok(Some(n.id.clone()));
        }

        if let Some(last_dot) = import_path.rfind('.') {
            if last_dot > 0 {
                let type_name = &import_path[last_dot + 1..];
                let namespace = &import_path[..last_dot];
                for &i in self.name(type_name) {
                    let n = &self.nodes[i];
                    if !n.qualified_name.is_empty() && n.qualified_name.starts_with(namespace) {
                        return Ok(Some(n.id.clone()));
                    }
                }
            }
        }

        let last = import_path.rsplit('.').next().unwrap_or("");
        for &i in self.name(last) {
            let n = &self.nodes[i];
            if n.kind == "namespace" && n.name == import_path {
                return Ok(Some(n.id.clone()));
            }
        }
        Ok(self.namespace_prefix.get(import_path).cloned())
    }
}

struct RefRow {
    id: i64,
    source_id: String,
    ref_name: String,
    ref_kind: String,
    file_path: String,
    line: Option<i64>,
    column: Option<i64>,
    metadata: Option<String>,
    attempted: Option<String>,
}

pub struct ResolveOutcome {
    pub resolved: i64,
    pub remaining: i64,
    pub errors: Vec<String>,
}

/// References per transaction. The TypeScript resolver uses 1000 to bound WASM memory; natively
/// the cost is the commit itself (a journal file created and removed), so batches are larger.
const BATCH: usize = 10_000;

pub fn run_resolve(
    db_path: &str,
    marker: Option<String>,
    threshold: f64,
    synchronous_off: bool,
    mut progress: impl FnMut(usize, usize),
) -> Result<ResolveOutcome, String> {
    let started = std::time::Instant::now();
    let mut db = Db::open(Path::new(db_path), marker.map(PathBuf::from), synchronous_off)?;
    let (caches, refs) = db.transaction(|conn, _| {
        let caches = warm(conn)?;
        let mut stmt = conn
            .prepare("SELECT id, source_id, ref_name, ref_kind, file_path, line, column, metadata, attempted_strategies FROM unresolved_refs")
            .map_err(to_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RefRow {
                    id: r.get(0)?,
                    source_id: r.get(1)?,
                    ref_name: r.get(2)?,
                    ref_kind: r.get(3)?,
                    file_path: r.get(4)?,
                    line: r.get(5)?,
                    column: r.get(6)?,
                    metadata: r.get(7)?,
                    attempted: r.get(8)?,
                })
            })
            .map_err(to_err)?;
        let refs: Vec<RefRow> = rows.collect::<Result<_, _>>().map_err(to_err)?;
        Ok((caches, refs))
    })?;

    let warm_ms = started.elapsed().as_secs_f64() * 1000.0;
    let total = refs.len();
    let mut resolved = 0i64;
    let mut errors = Vec::new();
    // A full index (synchronous off) resolves in one transaction: every batch rewrites pages of the
    // edge indexes, and each transaction copies them to the rollback journal again
    let batch_size = if synchronous_off { refs.len().max(1) } else { BATCH };
    for (b, batch) in refs.chunks(batch_size).enumerate() {
        let result = db.transaction(|conn, guard| {
            guard.touch();
            let mut edges: Vec<(&RefRow, String, &'static str)> = Vec::new();
            let mut resolved_ids: Vec<i64> = Vec::new();
            let mut to_record: IndexMap<String, Vec<i64>> = IndexMap::new();
            for r in batch {
                let mut attempted: Vec<&str> = Vec::new();
                let mut target: Option<String>;
                match r.ref_kind.as_str() {
                    "reference" | "qualified_call" => {
                        attempted.push("qualified");
                        target = caches.qualified(&r.ref_name).map(|n| n.id.clone());
                    }
                    "import" => {
                        attempted.push("import-path");
                        target = caches.resolve_import_path(conn, &r.ref_name, &r.file_path)?;
                    }
                    "extends" | "implements" => {
                        attempted.push("type-name");
                        target = caches.resolve_type_name(&r.ref_name);
                    }
                    _ => {
                        attempted.push("framework");
                        attempted.push("qualified");
                        target = caches.qualified(&r.ref_name).map(|n| n.id.clone());
                        if target.is_none() && r.ref_name.contains('.') {
                            attempted.push("method");
                            let method = &r.ref_name[r.ref_name.rfind('.').unwrap() + 1..];
                            target = caches.name(method).first().map(|&i| caches.nodes[i].id.clone());
                        }
                        if target.is_none() {
                            attempted.push("exact");
                            target = caches.name(&r.ref_name).first().map(|&i| caches.nodes[i].id.clone());
                        }
                        if target.is_none() {
                            attempted.push("fuzzy");
                            let lower = js_lower(&r.ref_name);
                            if let Some(c) = caches.by_lower.get(&lower) {
                                target = caches.match_reference(&r.ref_name, c, threshold);
                            }
                        }
                    }
                }
                if let Some(t) = target {
                    let kind = match r.ref_kind.as_str() {
                        "reference" => "references",
                        "import" => "imports",
                        "extends" => "extends",
                        "implements" => "implements",
                        _ => "calls",
                    };
                    edges.push((r, t, kind));
                    resolved_ids.push(r.id);
                } else {
                    let json = serde_json::to_string(&attempted).unwrap_or_default();
                    if r.attempted.as_deref() != Some(json.as_str()) {
                        to_record.entry(json).or_default().push(r.id);
                    }
                }
            }

            let mut ins = conn
                .prepare_cached(
                    "INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, column, confidence, confidence_score) VALUES (?, ?, ?, ?, ?, ?, 'extracted', 1.0)",
                )
                .map_err(to_err)?;
            for (r, t, kind) in &edges {
                // JSON.parse then JSON.stringify: the stored text, normalised
                let meta = r.metadata.as_ref().map(|m| match serde_json::from_str::<serde_json::Value>(m) {
                    Ok(v) => serde_json::to_string(&v).unwrap_or_else(|_| m.clone()),
                    Err(_) => m.clone(),
                });
                ins.execute(rusqlite::params![r.source_id, t, kind, meta, r.line, r.column]).map_err(to_err)?;
            }
            for group in resolved_ids.chunks(512) {
                let sql = format!("DELETE FROM unresolved_refs WHERE id IN ({})", vec!["?"; group.len()].join(","));
                conn.prepare_cached(&sql).and_then(|mut s| s.execute(params_from_iter(group.iter()))).map_err(to_err)?;
            }
            for (json, ids) in &to_record {
                for group in ids.chunks(512) {
                    let sql = format!(
                        "UPDATE unresolved_refs SET attempted_strategies = ? WHERE id IN ({})",
                        vec!["?"; group.len()].join(",")
                    );
                    let mut values: Vec<rusqlite::types::Value> = vec![json.clone().into()];
                    values.extend(group.iter().map(|&i| rusqlite::types::Value::Integer(i)));
                    conn.prepare_cached(&sql).and_then(|mut s| s.execute(params_from_iter(values))).map_err(to_err)?;
                }
            }
            Ok(edges.len() as i64)
        });
        match result {
            Ok(n) => resolved += n,
            Err(e) => errors.push(format!("batch {}-{} failed: {e}", b * batch_size, (b * batch_size + batch.len()))),
        }
        progress((b * batch_size + batch.len()).min(total), total);
    }

    let remaining = db.transaction(|conn, _| {
        conn.query_row("SELECT COUNT(*) FROM unresolved_refs", [], |r| r.get::<_, i64>(0)).map_err(to_err)
    })?;
    if std::env::var_os("KIROGRAPH_RUST_DEBUG").is_some() {
        eprintln!(
            "[kirograph-rust] resolve: {total} refs, {resolved} resolved, warm {warm_ms:.0} ms, total {:.0} ms, lock wait {:.0} ms",
            started.elapsed().as_secs_f64() * 1000.0,
            db.lock_wait_ms
        );
    }
    Ok(ResolveOutcome { resolved, remaining, errors })
}
