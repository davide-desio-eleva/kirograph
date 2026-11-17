//! Port of src/extraction/extractor.ts (the generic tree walker and its helpers).
//!
//! Every function here mirrors the TypeScript function of the same name, in the same order of
//! checks, so both engines produce the same nodes, edges and references for a file. When the
//! TypeScript changes, this file must change with it; test/rust/parity.sh compares the two.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tree_sitter::{Node, Parser};

use crate::complexity;
use crate::jstext::*;
use crate::routes;
use crate::types::*;

/// What one file is parsed against.
///
/// The tree is parsed from UTF-16, as web-tree-sitter parses a JavaScript string: tree-sitter's
/// error recovery weighs skipped text by its size in bytes, so a file with syntax errors can
/// recover differently from UTF-8. Node offsets are therefore UTF-16 byte offsets; `utf8_at` maps
/// a UTF-16 code unit index to the UTF-8 offset in `source` (None when the file is ASCII, where
/// both are the same).
pub struct Ctx<'a> {
    pub source: &'a str,
    pub file_path: &'a str,
    pub language: &'a str,
    pub now: i64,
    pub utf8_at: Option<Vec<u32>>,
}

impl<'a> Ctx<'a> {
    fn byte(&self, utf16_byte: usize) -> usize {
        let unit = utf16_byte / 2;
        match &self.utf8_at {
            None => unit,
            Some(map) => map[unit.min(map.len() - 1)] as usize,
        }
    }

    pub fn text(&self, n: Node) -> &'a str {
        &self.source[self.byte(n.start_byte())..self.byte(n.end_byte())]
    }

    /// Column of a node's start in UTF-16 code units, as web-tree-sitter reports it.
    pub fn start_col(&self, n: Node) -> i64 {
        (n.start_position().column / 2) as i64
    }

    pub fn end_col(&self, n: Node) -> i64 {
        (n.end_position().column / 2) as i64
    }
}

/// The UTF-16 encoding of `source`, and the UTF-8 offset of each code unit (None for ASCII).
pub fn utf16_of(source: &str) -> (Vec<u16>, Option<Vec<u32>>) {
    let units: Vec<u16> = source.encode_utf16().collect();
    if source.is_ascii() {
        return (units, None);
    }
    let mut map = Vec::with_capacity(units.len() + 1);
    for (i, c) in source.char_indices() {
        for _ in 0..c.len_utf16() {
            map.push(i as u32);
        }
    }
    map.push(source.len() as u32);
    (units, Some(map))
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn make_node_id(file_path: &str, kind: &str, name: &str, line: i64) -> String {
    let h = sha256_hex(format!("{file_path}:{kind}:{name}:{line}").as_bytes());
    format!("{kind}:{}", &h[..32])
}

/// All children (named and anonymous) of a node, as `node.child(i)` for i in 0..childCount.
pub fn children(n: Node) -> Vec<Node> {
    let mut cursor = n.walk();
    n.children(&mut cursor).collect()
}

pub fn named_children(n: Node) -> Vec<Node> {
    let mut cursor = n.walk();
    n.named_children(&mut cursor).collect()
}

pub const JS_TS_LANGUAGES: &[&str] = &["javascript", "typescript", "tsx", "jsx"];

pub fn is_js_ts(lang: &str) -> bool {
    JS_TS_LANGUAGES.contains(&lang)
}

/// Extracts a file the generic walker handles. `source` is the file decoded as UTF-8.
pub fn extract_source(
    parser: &mut Parser,
    source: &str,
    rel_path: &str,
    language: &str,
    enable_complexity: bool,
    now: i64,
) -> Result<ExtractedFile, String> {
    let content_hash = sha256_hex(source.as_bytes());
    let file_size = source.len() as i64;

    let (units, utf8_at) = utf16_of(source);
    let tree = match parser.parse_utf16_le(&units, None) {
        Some(t) => t,
        // The TypeScript extractor records a file whose parse crashes with no symbols
        None => {
            return Ok(ExtractedFile {
                file_path: rel_path.to_string(),
                language: language.to_string(),
                content_hash,
                file_size,
                ..Default::default()
            })
        }
    };
    let root = tree.root_node();
    let ctx = Ctx { source, file_path: rel_path, language, now, utf8_at };

    let mut out = Out::default();
    walk_tree(&ctx, root, &mut out, None);

    let mut route_mounts = None;
    if is_js_ts(language) {
        let imports = collect_import_bindings(&ctx, root);
        let r = routes::extract_routes(&ctx, root, |handler, route_id, refs| {
            walk_for_calls(&ctx, handler, route_id, refs)
        });
        out.nodes.extend(r.nodes);
        out.refs.extend(r.refs);
        route_mounts = Some(r.mounts.into_iter().map(|m| to_mount_fact(m, &imports)).collect());
        link_import_bindings(&imports, &mut out.edges, &out.refs);
    }

    if enable_complexity {
        complexity::apply(source, &mut out.nodes);
    }

    Ok(ExtractedFile {
        file_path: rel_path.to_string(),
        language: language.to_string(),
        content_hash,
        file_size,
        nodes: out.nodes,
        edges: out.edges,
        unresolved_refs: out.refs,
        route_mounts,
        stat_key: None,
    })
}

#[derive(Default)]
pub struct Out {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub refs: Vec<UnresolvedRef>,
}

fn contains_edge(parent: &str, child: &str) -> GraphEdge {
    GraphEdge { source: parent.to_string(), target: child.to_string(), kind: "contains".into(), ..Default::default() }
}

// ── Elixir ────────────────────────────────────────────────────────────────────

fn elixir_def_kind(t: &str) -> Option<&'static str> {
    Some(match t {
        "defmodule" => "module",
        "def" | "defp" | "defmacro" | "defmacrop" => "function",
        "defprotocol" => "interface",
        "defimpl" => "class",
        "defstruct" => "struct",
        _ => return None,
    })
}

fn elixir_call_target<'a>(ctx: &Ctx<'a>, node: Node) -> Option<&'a str> {
    let target = node.child_by_field_name("target").or_else(|| node.child(0))?;
    let t = js_trim(ctx.text(target));
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn elixir_first_arg(node: Node) -> Option<Node> {
    for child in children(node) {
        if child.kind() == "arguments" {
            return child.named_child(0).or_else(|| child.child(0));
        }
    }
    None
}

fn extract_elixir_name(ctx: &Ctx, node: Node, kind: &str) -> Option<String> {
    let first = elixir_first_arg(node)?;
    if kind == "module" || kind == "interface" || kind == "class" {
        return Some(js_trim(ctx.text(first)).to_string());
    }
    if kind == "function" {
        if first.kind() == "call" {
            if let Some(name_node) = first.child_by_field_name("target").or_else(|| first.child(0)) {
                return Some(js_trim(ctx.text(name_node)).to_string());
            }
        }
        return Some(js_trim(ctx.text(first)).to_string());
    }
    None
}

fn walk_elixir_call(ctx: &Ctx, node: Node, out: &mut Out, parent_id: Option<&str>) {
    let Some(target) = elixir_call_target(ctx, node) else {
        for c in children(node) {
            walk_tree(ctx, c, out, parent_id);
        }
        return;
    };

    if matches!(target, "alias" | "import" | "require" | "use") {
        let mod_path = elixir_first_arg(node).map(|a| js_trim(ctx.text(a)).to_string()).filter(|s| !s.is_empty());
        if let Some(mod_path) = mod_path {
            let line = node.start_position().row as i64 + 1;
            let id = make_node_id(ctx.file_path, "import", &mod_path, line);
            out.nodes.push(GraphNode {
                id: id.clone(),
                kind: "import".into(),
                name: mod_path.clone(),
                qualified_name: format!("{}::import:{}", ctx.file_path, mod_path),
                file_path: ctx.file_path.into(),
                language: ctx.language.into(),
                start_line: line,
                end_line: node.end_position().row as i64 + 1,
                start_column: ctx.start_col(node),
                end_column: ctx.end_col(node),
                updated_at: ctx.now,
                ..Default::default()
            });
            out.refs.push(UnresolvedRef {
                source_id: id,
                ref_name: mod_path,
                ref_kind: "import".into(),
                line: Some(line),
                column: Some(ctx.start_col(node)),
                metadata: None,
            });
        }
        return;
    }

    if let Some(def_kind) = elixir_def_kind(target) {
        if let Some(name) = extract_elixir_name(ctx, node, def_kind).filter(|s| !s.is_empty()) {
            let line = node.start_position().row as i64 + 1;
            let id = make_node_id(ctx.file_path, def_kind, &name, line);
            let is_private = target == "defp" || target == "defmacrop";
            out.nodes.push(GraphNode {
                id: id.clone(),
                kind: def_kind.into(),
                name: name.clone(),
                qualified_name: format!("{}::{}", ctx.file_path, name),
                file_path: ctx.file_path.into(),
                language: ctx.language.into(),
                start_line: line,
                end_line: node.end_position().row as i64 + 1,
                start_column: ctx.start_col(node),
                end_column: ctx.end_col(node),
                docstring: extract_docstring(ctx, node),
                signature: extract_signature(ctx, node, def_kind),
                visibility: Some(if is_private { "private" } else { "public" }.into()),
                is_exported: !is_private,
                updated_at: ctx.now,
                ..Default::default()
            });
            if let Some(p) = parent_id {
                out.edges.push(contains_edge(p, &id));
            }
            walk_for_calls(ctx, node, &id, &mut out.refs);
            for c in children(node) {
                walk_tree(ctx, c, out, Some(&id));
            }
            return;
        }
    }

    for c in children(node) {
        walk_tree(ctx, c, out, parent_id);
    }
}

// ── Node type mappings ────────────────────────────────────────────────────────

fn is_transparent(t: &str) -> bool {
    matches!(t, "export_statement" | "program" | "source_file" | "module" | "translation_unit" | "chunk")
}

fn kind_map(t: &str) -> Option<&'static str> {
    Some(match t {
        "function_declaration" | "function_expression" | "arrow_function" | "function_definition" | "function_item"
        | "function_declaration_go" => "function",
        "method_definition" | "method_declaration" | "constructor_declaration" => "method",
        "class_declaration" | "abstract_class_declaration" | "class_expression" | "class_definition" | "impl_item" => {
            "class"
        }
        "struct_item" | "struct_definition" => "struct",
        "interface_declaration" => "interface",
        "trait_item" | "trait_definition" => "trait",
        "protocol_declaration" => "interface",
        "enum_declaration" | "enum_item" => "enum",
        "type_alias_declaration" | "type_declaration" | "typealias_declaration" | "type_item" | "type_alias" => {
            "type_alias"
        }
        "namespace_declaration" | "module_definition" => "namespace",
        "lexical_declaration" | "variable_declaration" => "variable",
        "method" => "method",
        "class" => "class",
        "local_function_definition_statement" | "function_definition_statement" => "function",
        _ => return None,
    })
}

fn extract_variable_kind(node: Node) -> &'static str {
    for c in children(node) {
        if c.kind() == "const" {
            return "constant";
        }
    }
    "variable"
}

const DART_WIDGET_SUPERCLASSES: &[&str] =
    &["StatelessWidget", "StatefulWidget", "HookWidget", "ConsumerWidget", "ConsumerStatefulWidget"];

fn refine_dart_class_kind(ctx: &Ctx, node: Node) -> &'static str {
    static EXTENDS: OnceLock<Regex> = OnceLock::new();
    let extends = EXTENDS.get_or_init(|| Regex::new(&format!("^extends{JS_S}+")).unwrap());
    for child in children(node) {
        if child.kind() == "superclass" {
            let super_text = ctx.text(child);
            let stripped = extends.replace(super_text, "");
            if DART_WIDGET_SUPERCLASSES.contains(&js_trim(&stripped)) {
                return "component";
            }
            for type_node in children(child) {
                if type_node.kind() == "type_identifier" || type_node.kind() == "identifier" {
                    let name = js_trim(ctx.text(type_node));
                    if DART_WIDGET_SUPERCLASSES.contains(&name) {
                        return "component";
                    }
                    if name.ends_with("Widget") && name != "State" {
                        return "component";
                    }
                }
            }
        }
    }
    "class"
}

fn is_import_node(t: &str) -> bool {
    matches!(
        t,
        "import_statement"
            | "import_from_statement"
            | "import_declaration"
            | "use_declaration"
            | "using_directive"
            | "namespace_use_declaration"
            | "import_header"
            | "import_or_export"
            | "include_statement"
            | "preproc_include"
    )
}

// ── Main tree walker ──────────────────────────────────────────────────────────

pub fn walk_tree(ctx: &Ctx, node: Node, out: &mut Out, parent_id: Option<&str>) {
    let t = node.kind();
    if is_transparent(t) {
        for c in children(node) {
            walk_tree(ctx, c, out, parent_id);
        }
        return;
    }

    if ctx.language == "elixir" && t == "call" {
        walk_elixir_call(ctx, node, out, parent_id);
        return;
    }

    if is_import_node(t) {
        if let Some(n) = extract_import(ctx, node, &mut out.refs) {
            out.nodes.push(n);
        }
        return;
    }

    let mut kind: Option<&'static str> = kind_map(t);
    if t == "lexical_declaration" || t == "variable_declaration" {
        kind = Some(extract_variable_kind(node));
    }
    if kind.is_none() {
        kind = language_specific_kind(t, ctx.language);
    }
    if ctx.language == "dart" && t == "class_definition" && kind == Some("class") {
        kind = Some(refine_dart_class_kind(ctx, node));
    }

    if let Some(kind) = kind {
        if let Some(name) = extract_name_nonempty(ctx, node, kind) {
            let line = node.start_position().row as i64 + 1;
            let id = make_node_id(ctx.file_path, kind, &name, line);
            let visibility = extract_visibility(ctx, node);
            out.nodes.push(GraphNode {
                id: id.clone(),
                kind: kind.into(),
                name: name.clone(),
                qualified_name: format!("{}::{}", ctx.file_path, name),
                file_path: ctx.file_path.into(),
                language: ctx.language.into(),
                start_line: line,
                end_line: node.end_position().row as i64 + 1,
                start_column: ctx.start_col(node),
                end_column: ctx.end_col(node),
                docstring: extract_docstring(ctx, node),
                signature: extract_signature(ctx, node, kind),
                visibility,
                is_exported: is_exported(node),
                is_async: has_child_kind(node, "async"),
                is_static: has_child_kind(node, "static"),
                is_abstract: is_abstract(node),
                updated_at: ctx.now,
                ..Default::default()
            });
            if let Some(p) = parent_id {
                out.edges.push(contains_edge(p, &id));
            }
            walk_for_calls(ctx, node, &id, &mut out.refs);
            if (kind == "class" || kind == "interface") && (ctx.language == "csharp" || ctx.language == "java") {
                extract_inheritance(ctx, node, &id, &mut out.refs);
            }
            for c in children(node) {
                walk_tree(ctx, c, out, Some(&id));
            }
            return;
        }
    }

    for c in children(node) {
        walk_tree(ctx, c, out, parent_id);
    }
}

fn language_specific_kind(t: &str, lang: &str) -> Option<&'static str> {
    let k = match (lang, t) {
        ("python", "assignment") => "variable",
        ("go", "var_declaration" | "short_var_declaration") => "variable",
        ("go", "const_declaration") => "constant",
        ("go", "type_spec") => "type_alias",
        ("rust", "let_declaration") => "variable",
        ("rust", "const_item") => "constant",
        ("rust", "static_item") => "variable",
        ("java", "field_declaration") => "property",
        ("java", "local_variable_declaration") => "variable",
        ("csharp", "field_declaration") => "property",
        ("php", "property_declaration") => "property",
        ("php", "const_declaration") => "constant",
        ("kotlin", "property_declaration") => "variable",
        ("swift", "property_declaration") => "property",
        ("swift", "constant_declaration") => "constant",
        ("dart", "function_signature") => "function",
        ("dart", "method_signature") => "method",
        ("ruby", "singleton_method") => "method",
        ("scala", "object_definition") => "class",
        ("scala", "val_definition" | "var_definition") => "variable",
        ("scala", "type_definition") => "type_alias",
        ("lua", "local_function") => "function",
        ("lua", "local_variable_declaration" | "variable_assignment") => "variable",
        ("zig", "VarDecl") => "variable",
        ("zig", "ContainerDecl") => "struct",
        ("bash", "variable_assignment") => "variable",
        ("ocaml", "let_binding") => "variable",
        ("ocaml", "type_binding") => "type_alias",
        ("ocaml", "module_binding") => "namespace",
        ("elm", "function_declaration_left") => "function",
        ("elm", "type_alias_declaration") => "type_alias",
        ("solidity", "contract_declaration") => "class",
        ("solidity", "event_definition" | "modifier_definition") => "function",
        ("solidity", "state_variable_declaration") => "variable",
        ("objc", "class_interface" | "class_implementation") => "class",
        ("objc", "protocol_declaration") => "interface",
        ("objc", "method_declaration") => "method",
        ("objc", "property_declaration") => "property",
        ("hcl", "block") => "namespace",
        ("hcl", "attribute") => "variable",
        ("scss", "mixin_statement" | "function_statement") => "function",
        ("scss", "variable_declaration") => "variable",
        ("scss", "include_statement" | "use_statement" | "forward_statement") => "import",
        ("scss", "placeholder") => "class",
        ("css", "rule_set") => "class",
        ("css", "declaration") => "variable",
        ("rescript", "let_binding") => "function",
        ("rescript", "type_definition") => "type_alias",
        ("rescript", "module_declaration") => "module",
        ("sql", "create_function_statement" | "create_view_statement" | "create_procedure_statement") => "function",
        ("sql", "create_table_statement") => "class",
        ("r", "function_definition") => "function",
        ("r", "left_assignment") => "variable",
        ("julia", "function_definition" | "macro_definition") => "function",
        ("julia", "struct_definition") => "struct",
        ("julia", "module_definition") => "module",
        ("powershell", "function_statement") => "function",
        ("powershell", "class_statement") => "class",
        ("perl", "subroutine_declaration_statement") => "function",
        ("perl", "package_statement") => "module",
        ("gdscript", "function_definition") => "function",
        ("gdscript", "class_definition") => "class",
        ("gdscript", "variable_statement") => "variable",
        ("astro", "function_declaration" | "function_definition") => "function",
        ("nix", "function") => "function",
        ("nix", "binding") => "variable",
        ("verilog", "module_declaration") => "class",
        ("verilog", "task_declaration" | "function_declaration") => "function",
        _ => return None,
    };
    Some(k)
}

// ── Import extraction ─────────────────────────────────────────────────────────

fn extract_import(ctx: &Ctx, node: Node, refs: &mut Vec<UnresolvedRef>) -> Option<GraphNode> {
    let module_path = extract_import_source(ctx, node).filter(|p| !p.is_empty())?;
    let line = node.start_position().row as i64 + 1;
    let id = make_node_id(ctx.file_path, "import", &module_path, line);
    let n = GraphNode {
        id: id.clone(),
        kind: "import".into(),
        name: module_path.clone(),
        qualified_name: format!("{}::import:{}", ctx.file_path, module_path),
        file_path: ctx.file_path.into(),
        language: ctx.language.into(),
        start_line: line,
        end_line: node.end_position().row as i64 + 1,
        start_column: ctx.start_col(node),
        end_column: ctx.end_col(node),
        updated_at: ctx.now,
        ..Default::default()
    };
    refs.push(UnresolvedRef {
        source_id: id,
        ref_name: module_path,
        ref_kind: "import".into(),
        line: Some(line),
        column: Some(ctx.start_col(node)),
        metadata: None,
    });
    Some(n)
}

fn import_regexes() -> &'static (Regex, Regex) {
    static R: OnceLock<(Regex, Regex)> = OnceLock::new();
    R.get_or_init(|| {
        (
            Regex::new(&format!(r"^import{JS_S}+({JS_DOT}+?)(?:[;*]|{JS_S})*$")).unwrap(),
            Regex::new(&format!(r"^use{JS_S}+({JS_DOT}+?)(?:;|{JS_S})*$")).unwrap(),
        )
    })
}

/// The module path of an import statement. The checks run in the TypeScript order: a node type
/// that several branches accept takes the first that finds something.
pub fn extract_import_source(ctx: &Ctx, node: Node) -> Option<String> {
    let t = node.kind();
    let lang = ctx.language;

    if t == "import_statement" {
        let cs = children(node);
        for c in cs.iter().rev() {
            if c.kind() == "string" {
                return Some(strip_quotes(ctx.text(*c)));
            }
        }
    }

    if t == "import_from_statement" {
        for c in children(node) {
            if c.kind() == "dotted_name" || c.kind() == "relative_import" {
                return Some(ctx.text(c).to_string());
            }
        }
    }
    if t == "import_statement" && lang == "python" {
        for c in children(node) {
            if c.kind() == "dotted_name" {
                return Some(ctx.text(c).to_string());
            }
        }
    }

    if t == "import_declaration" {
        for c in children(node) {
            if c.kind() == "string" {
                return Some(strip_quotes(ctx.text(c)));
            }
            if c.kind() == "import_spec_list" {
                for spec in children(c) {
                    if spec.kind() == "import_spec" {
                        for s in children(spec) {
                            if s.kind() == "string" {
                                return Some(strip_quotes(ctx.text(s)));
                            }
                        }
                    }
                }
            }
        }
    }

    if t == "use_declaration" {
        for c in children(node) {
            if c.kind() != "use" && c.kind() != ";" {
                return Some(ctx.text(c).to_string());
            }
        }
    }

    if t == "using_directive" {
        for c in children(node) {
            if c.kind() == "qualified_name" || c.kind() == "identifier" {
                return Some(ctx.text(c).to_string());
            }
        }
    }

    if t == "import_declaration" || t == "import_header" {
        let text = js_trim(ctx.text(node));
        if let Some(m) = import_regexes().0.captures(text) {
            return Some(js_trim(&m[1]).to_string());
        }
    }

    if t == "namespace_use_declaration" {
        let text = js_trim(ctx.text(node));
        if let Some(m) = import_regexes().1.captures(text) {
            return Some(js_trim(&m[1]).to_string());
        }
    }

    if t == "import_declaration" || t == "import_or_export" {
        for c in children(node) {
            if c.kind() == "identifier" || c.kind() == "string" {
                return Some(ctx.text(c).to_string());
            }
        }
    }

    if t == "preproc_include" {
        for c in children(node) {
            if c.kind() == "string_literal" || c.kind() == "system_lib_string" {
                return Some(ctx.text(c).chars().filter(|ch| !matches!(ch, '<' | '>' | '"')).collect());
            }
        }
    }

    None
}

// ── Name extraction ───────────────────────────────────────────────────────────

fn extract_name(ctx: &Ctx, node: Node, kind: &str) -> Option<String> {
    let cs = children(node);
    if kind == "variable" || kind == "constant" {
        for c in &cs {
            if c.kind() == "variable_declarator" {
                for gc in children(*c) {
                    if gc.kind() == "identifier" {
                        return Some(ctx.text(gc).to_string());
                    }
                }
            }
        }
    }

    for c in &cs {
        if c.kind() == "var_spec" || c.kind() == "const_spec" {
            for gc in children(*c) {
                if gc.kind() == "identifier" {
                    return Some(ctx.text(gc).to_string());
                }
            }
        }
    }

    if node.kind() == "function_definition_statement" {
        for c in &cs {
            if c.kind() == "variable" {
                let mut last: Option<&str> = None;
                for gc in children(*c) {
                    if gc.kind() == "identifier" {
                        last = Some(ctx.text(gc));
                    }
                }
                // `if (lastId)`: an empty name does not count
                if let Some(l) = last.filter(|l| !l.is_empty()) {
                    return Some(l.to_string());
                }
            }
        }
    }

    for c in &cs {
        if matches!(
            c.kind(),
            "identifier" | "property_identifier" | "type_identifier" | "simple_identifier" | "word" | "name" | "constant"
        ) {
            return Some(ctx.text(*c).to_string());
        }
    }

    if node.kind() == "assignment" {
        if let Some(left) = node.child(0) {
            if left.kind() == "identifier" {
                return Some(ctx.text(left).to_string());
            }
        }
    }
    None
}

/// `extractName` followed by the walker's `if (name)`: an empty name makes no node.
fn extract_name_nonempty(ctx: &Ctx, node: Node, kind: &str) -> Option<String> {
    extract_name(ctx, node, kind).filter(|n| !n.is_empty())
}

// ── Signature extraction ──────────────────────────────────────────────────────

fn signature_body_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(&format!(r"{JS_S}*[{{:]{JS_S}*\n|=>|\{{")).unwrap())
}

pub fn extract_signature(ctx: &Ctx, node: Node, kind: &str) -> Option<String> {
    let text = ctx.text(node);
    if kind == "function" || kind == "method" {
        let body_start = signature_body_regex().find(text).map(|m| m.start());
        let header = match body_start {
            Some(i) if i > 0 => js_trim(&text[..i]),
            _ => js_trim(first_line(text)),
        };
        let h = js_truncate(header, 150);
        return if h.is_empty() { None } else { Some(h) };
    }
    let first = js_trim(first_line(text));
    let s = js_truncate(first, 120);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ── Visibility extraction ─────────────────────────────────────────────────────

fn extract_visibility(ctx: &Ctx, node: Node) -> Option<String> {
    let cs = children(node);
    for c in &cs {
        if c.kind() == "accessibility_modifier" {
            match ctx.text(*c) {
                "public" => return Some("public".into()),
                "private" => return Some("private".into()),
                "protected" => return Some("protected".into()),
                _ => {}
            }
        }
        match c.kind() {
            "public" => return Some("public".into()),
            "private" => return Some("private".into()),
            "protected" => return Some("protected".into()),
            "internal" => return Some("internal".into()),
            _ => {}
        }
    }
    match ctx.language {
        "rust" => {
            for c in &cs {
                if c.kind() == "visibility_modifier" {
                    return Some(if ctx.text(*c).starts_with("pub") { "public" } else { "private" }.into());
                }
            }
            Some("private".into())
        }
        "csharp" => Some("private".into()),
        "php" => Some("public".into()),
        "swift" => {
            for c in &cs {
                if c.kind() == "fileprivate" {
                    return Some("private".into());
                }
            }
            Some("internal".into())
        }
        "python" => {
            let name = extract_name(ctx, node, "function");
            match name.as_deref() {
                Some(n) if n.starts_with('_') && !n.starts_with("__") => Some("protected".into()),
                Some(n) if n.starts_with("__") => Some("private".into()),
                _ => Some("public".into()),
            }
        }
        _ => None,
    }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

fn docstring_regexes() -> &'static [Regex; 4] {
    static R: OnceLock<[Regex; 4]> = OnceLock::new();
    R.get_or_init(|| {
        [
            Regex::new(&format!(r"(?mR)^/\*+{JS_S}*")).unwrap(),
            Regex::new(&format!(r"(?mR){JS_S}*\*+/{JS_S}*$")).unwrap(),
            Regex::new(&format!(r"(?mR)^{JS_S}*\*{JS_S}?")).unwrap(),
            Regex::new(&format!(r"(?mR)^//{JS_S}?")).unwrap(),
        ]
    })
}

pub fn extract_docstring(ctx: &Ctx, node: Node) -> Option<String> {
    let mut lines: Vec<&str> = Vec::new();
    let mut sibling = node.prev_named_sibling();
    while let Some(s) = sibling {
        if !matches!(s.kind(), "comment" | "block_comment" | "line_comment" | "documentation_comment") {
            break;
        }
        lines.push(ctx.text(s));
        sibling = s.prev_named_sibling();
    }
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    let joined = lines.join("\n");
    let r = docstring_regexes();
    let a = r[0].replace_all(&joined, "");
    let b = r[1].replace_all(&a, "");
    let c = r[2].replace_all(&b, "");
    let d = r[3].replace_all(&c, "");
    let cleaned = js_trim(&d);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn is_exported(node: Node) -> bool {
    let mut current = node.parent();
    while let Some(c) = current {
        if c.kind() == "export_statement" {
            return true;
        }
        if matches!(c.kind(), "function_body" | "class_body" | "statement_block") {
            break;
        }
        current = c.parent();
    }
    false
}

fn has_child_kind(node: Node, kind: &str) -> bool {
    children(node).iter().any(|c| c.kind() == kind)
}

fn is_abstract(node: Node) -> bool {
    if node.kind() == "abstract_class_declaration" {
        return true;
    }
    for c in children(node) {
        if c.kind() == "abstract" {
            return true;
        }
        if c.kind() == "modifiers" && children(c).iter().any(|m| m.kind() == "abstract") {
            return true;
        }
    }
    false
}

// ── Call reference collection ─────────────────────────────────────────────────

fn is_call_node(t: &str) -> bool {
    matches!(
        t,
        "call_expression" | "invocation_expression" | "method_invocation" | "call" | "function_call_expression"
    )
}

fn extract_call_name(ctx: &Ctx, node: Node) -> Option<String> {
    for field in ["name", "method", "function", "target"] {
        if let Some(f) = node.child_by_field_name(field) {
            if matches!(f.kind(), "identifier" | "name" | "property_identifier" | "type_identifier") {
                let text = js_trim(ctx.text(f));
                if !text.is_empty() && is_js_identifier(text) {
                    return Some(text.to_string());
                }
            }
        }
    }
    if let Some(func) = node.child(0) {
        let full = ctx.text(func);
        let before_paren = match full.find('(') {
            Some(i) => &full[..i],
            None => full,
        };
        let raw = js_trim(before_paren);
        if !raw.is_empty() && js_len(raw) < 100 {
            let last = raw.rsplit('.').next().unwrap_or("");
            let callee = js_trim(last);
            if !callee.is_empty() && is_js_identifier(callee) {
                return Some(callee.to_string());
            }
        }
    }
    None
}

pub fn walk_for_calls(ctx: &Ctx, node: Node, source_id: &str, refs: &mut Vec<UnresolvedRef>) {
    // Iterative pre-order walk: deep expressions (long call chains) would otherwise grow the stack
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if is_call_node(n.kind()) {
            if let Some(callee) = extract_call_name(ctx, n) {
                let mut metadata = Map::new();
                if is_js_ts(ctx.language) {
                    if let Some(k) = classify_first_argument(ctx, n) {
                        metadata.insert("argKind".into(), Value::String(k.into()));
                    }
                    if let Some(r) = callee_root_name(ctx, n) {
                        metadata.insert("rootName".into(), Value::String(r));
                    }
                } else if let Some(k) = classify_generic_argument(ctx, n) {
                    metadata.insert("argKind".into(), Value::String(k.into()));
                }
                refs.push(UnresolvedRef {
                    source_id: source_id.to_string(),
                    ref_name: callee,
                    ref_kind: "function".into(),
                    line: Some(n.start_position().row as i64 + 1),
                    column: Some(ctx.start_col(n)),
                    metadata: if metadata.is_empty() { None } else { Some(metadata) },
                });
            }
        }
        let cs = children(n);
        for c in cs.into_iter().rev() {
            stack.push(c);
        }
    }
}

fn callee_root_name(ctx: &Ctx, call: Node) -> Option<String> {
    let mut f = call.child_by_field_name("function");
    while let Some(n) = f {
        if n.kind() != "member_expression" {
            break;
        }
        f = n.child_by_field_name("object");
    }
    let n = f?;
    if n.kind() == "identifier" {
        Some(ctx.text(n).to_string())
    } else {
        None
    }
}

struct ArgShape {
    stat: &'static [&'static str],
    interpolating: &'static [&'static str],
    binary: &'static [&'static str],
    wrapper: Option<&'static str>,
}

fn generic_arg_shape(lang: &str) -> Option<ArgShape> {
    Some(match lang {
        "python" => ArgShape { stat: &["string"], interpolating: &[], binary: &["binary_operator"], wrapper: None },
        "java" => ArgShape { stat: &["string_literal"], interpolating: &[], binary: &["binary_expression"], wrapper: None },
        "go" => ArgShape {
            stat: &["interpreted_string_literal", "raw_string_literal"],
            interpolating: &[],
            binary: &["binary_expression"],
            wrapper: None,
        },
        "csharp" => ArgShape {
            stat: &["string_literal", "verbatim_string_literal", "raw_string_literal"],
            interpolating: &["interpolated_string_expression"],
            binary: &["binary_expression"],
            wrapper: Some("argument"),
        },
        "php" => ArgShape {
            stat: &["string"],
            interpolating: &["encapsed_string", "heredoc"],
            binary: &["binary_expression"],
            wrapper: Some("argument"),
        },
        "ruby" => ArgShape { stat: &["string"], interpolating: &[], binary: &["binary"], wrapper: None },
        "rust" => ArgShape {
            stat: &["string_literal", "raw_string_literal"],
            interpolating: &[],
            binary: &["binary_expression"],
            wrapper: None,
        },
        "kotlin" => ArgShape { stat: &["string_literal"], interpolating: &[], binary: &["additive_expression"], wrapper: None },
        _ => return None,
    })
}

fn interpolation_marker() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"#\{|\$\{|\{\$|\$[A-Za-z_@]|^\$@?"|^[A-Za-z]*[fF][A-Za-z]*["']"#).unwrap())
}

fn classify_generic_argument(ctx: &Ctx, call: Node) -> Option<&'static str> {
    let shape = generic_arg_shape(ctx.language)?;
    let mut first = call.child_by_field_name("arguments").and_then(|a| a.named_child(0));
    while let Some(f) = first {
        if f.kind() != "comment" {
            break;
        }
        first = f.next_named_sibling();
    }
    let mut first = first?;
    if let Some(w) = shape.wrapper {
        if first.kind() == w {
            first = first.named_child(0)?;
        }
    }
    let t = first.kind();
    if shape.binary.contains(&t) || shape.interpolating.contains(&t) {
        return Some("dynamic");
    }
    if shape.stat.contains(&t) {
        return Some(if interpolation_marker().is_match(ctx.text(first)) { "dynamic" } else { "static" });
    }
    Some("dynamic")
}

fn classify_first_argument(ctx: &Ctx, call: Node) -> Option<&'static str> {
    let first = call.child_by_field_name("arguments")?.named_child(0)?;
    if first.kind() == "tagged_template_expression" || first.kind() == "call_expression" {
        let tag = first.child_by_field_name("function");
        let tag_args = first.child_by_field_name("arguments");
        let is_sql = tag.map(|t| t.kind() == "identifier" && ctx.text(t) == "sql").unwrap_or(false);
        if first.kind() == "tagged_template_expression" || tag_args.map(|a| a.kind() == "template_string").unwrap_or(false) {
            return Some(if is_sql { "parameterized" } else { "dynamic" });
        }
    }
    if first.kind() == "string" {
        return Some("static");
    }
    if first.kind() == "template_string" {
        let has_sub = named_children(first).iter().any(|c| c.kind() == "template_substitution");
        return Some(if has_sub { "dynamic" } else { "static" });
    }
    Some("dynamic")
}

// ── Import bindings (JS/TS) ───────────────────────────────────────────────────

#[derive(Clone)]
pub struct ImportBinding {
    pub specifier: String,
    pub import_id: String,
    pub imported_name: Option<String>,
}

/// Local name → binding. Keeps the JavaScript Map's behaviour: a later import of the same local
/// name replaces the earlier one.
pub type ImportBindings = HashMap<String, ImportBinding>;

fn collect_import_bindings(ctx: &Ctx, root: Node) -> ImportBindings {
    let mut bindings = ImportBindings::new();
    for node in named_children(root) {
        if node.kind() != "import_statement" {
            continue;
        }
        let Some(spec) = extract_import_source(ctx, node) else { continue };
        if spec.is_empty() {
            continue;
        }
        let import_id = make_node_id(ctx.file_path, "import", &spec, node.start_position().row as i64 + 1);
        for (local, imported) in import_binding_names(ctx, node) {
            bindings.insert(local, ImportBinding { specifier: spec.clone(), import_id: import_id.clone(), imported_name: imported });
        }
    }
    bindings
}

fn import_binding_names(ctx: &Ctx, node: Node) -> Vec<(String, Option<String>)> {
    let mut names = Vec::new();
    let Some(clause) = named_children(node).into_iter().find(|c| c.kind() == "import_clause") else {
        return names;
    };
    for child in named_children(clause) {
        match child.kind() {
            "identifier" => names.push((ctx.text(child).to_string(), None)),
            "namespace_import" => {
                if let Some(id) = named_children(child).into_iter().find(|c| c.kind() == "identifier") {
                    names.push((ctx.text(id).to_string(), None));
                }
            }
            "named_imports" => {
                for spec in named_children(child) {
                    if spec.kind() != "import_specifier" {
                        continue;
                    }
                    let name = spec.child_by_field_name("name");
                    let alias = spec.child_by_field_name("alias");
                    let local = alias.or(name);
                    if let (Some(local), Some(name)) = (local, name) {
                        names.push((ctx.text(local).to_string(), Some(ctx.text(name).to_string())));
                    }
                }
            }
            _ => {}
        }
    }
    names
}

fn link_import_bindings(imports: &ImportBindings, edges: &mut Vec<GraphEdge>, refs: &[UnresolvedRef]) {
    if imports.is_empty() {
        return;
    }
    let mut linked: HashSet<(String, String)> = HashSet::new();
    for r in refs {
        if r.ref_kind != "function" {
            continue;
        }
        let Some(Value::String(root)) = r.metadata.as_ref().and_then(|m| m.get("rootName")) else { continue };
        let Some(b) = imports.get(root) else { continue };
        if b.specifier.starts_with('.') || b.specifier.starts_with('/') {
            continue;
        }
        if !linked.insert((r.source_id.clone(), b.import_id.clone())) {
            continue;
        }
        edges.push(GraphEdge {
            source: r.source_id.clone(),
            target: b.import_id.clone(),
            kind: "references".into(),
            line: r.line,
            column: r.column,
            confidence: Some("inferred".into()),
            confidence_score: Some(0.8),
            metadata: None,
        });
    }
}

fn to_mount_fact(m: routes::RouteMount, imports: &ImportBindings) -> RouteMountFact {
    use routes::MountTarget::*;
    match m.target {
        Inline { start_line, end_line } => RouteMountFact {
            plugin_name: "<inline>".into(),
            imported_name: None,
            specifier: None,
            prefix: m.prefix,
            line: m.line,
            inline_start: Some(start_line),
            inline_end: Some(end_line),
        },
        Require { specifier } => RouteMountFact {
            plugin_name: specifier.clone(),
            imported_name: None,
            specifier: Some(specifier),
            prefix: m.prefix,
            line: m.line,
            ..Default::default()
        },
        Namespace { object, name } => RouteMountFact {
            plugin_name: name.clone(),
            imported_name: Some(name),
            specifier: imports.get(&object).map(|b| b.specifier.clone()),
            prefix: m.prefix,
            line: m.line,
            ..Default::default()
        },
        Name { name } => {
            let b = imports.get(&name);
            RouteMountFact {
                plugin_name: name.clone(),
                imported_name: b.and_then(|b| b.imported_name.clone()),
                specifier: b.map(|b| b.specifier.clone()),
                prefix: m.prefix,
                line: m.line,
                ..Default::default()
            }
        }
    }
}

// ── Inheritance extraction ────────────────────────────────────────────────────

fn extract_type_name(ctx: &Ctx, node: Node) -> Option<String> {
    let t = node.kind();
    let nonempty = |s: &str| {
        let s = js_trim(s);
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    };
    if t == "identifier" || t == "type_identifier" || t == "name" {
        return nonempty(ctx.text(node));
    }
    if t == "qualified_name" || t == "generic_name" || t == "scoped_type_identifier" {
        for c in children(node).into_iter().rev() {
            if matches!(c.kind(), "identifier" | "type_identifier" | "name") {
                return nonempty(ctx.text(c));
            }
        }
    }
    None
}

fn extract_inheritance(ctx: &Ctx, node: Node, class_id: &str, refs: &mut Vec<UnresolvedRef>) {
    for child in children(node) {
        if ctx.language == "csharp" && child.kind() == "base_list" {
            for item in children(child) {
                if let Some(name) = extract_type_name(ctx, item) {
                    refs.push(UnresolvedRef {
                        source_id: class_id.into(),
                        ref_name: name,
                        ref_kind: "extends".into(),
                        line: Some(item.start_position().row as i64 + 1),
                        column: Some(ctx.start_col(item)),
                        metadata: None,
                    });
                }
            }
        }
        if ctx.language == "java" {
            if child.kind() == "superclass" {
                if let Some(type_node) = child.named_child(0) {
                    if let Some(name) = extract_type_name(ctx, type_node) {
                        refs.push(UnresolvedRef {
                            source_id: class_id.into(),
                            ref_name: name,
                            ref_kind: "extends".into(),
                            line: Some(child.start_position().row as i64 + 1),
                            column: Some(ctx.start_col(child)),
                            metadata: None,
                        });
                    }
                }
            }
            if child.kind() == "super_interfaces" || child.kind() == "extends_interfaces" {
                if let Some(type_list) = child.named_child(0) {
                    for type_node in named_children(type_list) {
                        if let Some(name) = extract_type_name(ctx, type_node) {
                            refs.push(UnresolvedRef {
                                source_id: class_id.into(),
                                ref_name: name,
                                ref_kind: if child.kind() == "extends_interfaces" { "extends" } else { "implements" }.into(),
                                line: Some(type_node.start_position().row as i64 + 1),
                                column: Some(ctx.start_col(type_node)),
                                metadata: None,
                            });
                        }
                    }
                }
            }
        }
    }
}
