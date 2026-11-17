//! Port of src/extraction/routes.ts: HTTP routes and plugin mounts of JS/TS servers.

use std::collections::HashSet;

use tree_sitter::Node;

use crate::extract::{children, named_children, Ctx};
use crate::jstext::{js_lower, slice_inner, strip_quotes};
use crate::types::{GraphNode, UnresolvedRef};

pub enum MountTarget {
    Name { name: String },
    Namespace { object: String, name: String },
    Require { specifier: String },
    Inline { start_line: i64, end_line: i64 },
}

pub struct RouteMount {
    pub target: MountTarget,
    pub prefix: String,
    pub line: i64,
}

pub struct Routes {
    pub nodes: Vec<GraphNode>,
    pub refs: Vec<UnresolvedRef>,
    pub mounts: Vec<RouteMount>,
}

const ROUTE_RECEIVERS: &[&str] = &["app", "router", "fastify", "server", "api"];
const HTTP_METHODS: &[&str] = &["get", "post", "put", "patch", "delete", "options", "head", "all"];

fn is_function_node(t: &str) -> bool {
    matches!(t, "arrow_function" | "function_expression" | "function")
}

struct ParsedRoute<'t> {
    method: String,
    path: String,
    handler: Option<Node<'t>>,
}

enum ParsedCall<'t> {
    Routes(Vec<ParsedRoute<'t>>),
    Mount { target: MountTarget, prefix: String },
}

pub fn extract_routes<'t, F>(ctx: &Ctx, root: Node<'t>, mut collect_calls: F) -> Routes
where
    F: FnMut(Node<'t>, &str, &mut Vec<UnresolvedRef>),
{
    let mut out = Routes { nodes: Vec::new(), refs: Vec::new(), mounts: Vec::new() };
    let mut receivers: HashSet<String> = ROUTE_RECEIVERS.iter().map(|s| s.to_string()).collect();
    plugin_parameter_names(ctx, root, &mut receivers);

    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            match parse_call(ctx, node, &receivers) {
                Some(ParsedCall::Mount { target, prefix }) => {
                    out.mounts.push(RouteMount { target, prefix, line: node.start_position().row as i64 + 1 });
                }
                Some(ParsedCall::Routes(routes)) => {
                    for route in routes {
                        add_route(ctx, &mut out, route, node, &mut collect_calls);
                    }
                }
                None => {}
            }
        }
        for c in children(node).into_iter().rev() {
            stack.push(c);
        }
    }
    out
}

fn add_route<'t, F>(ctx: &Ctx, out: &mut Routes, route: ParsedRoute<'t>, call: Node<'t>, collect_calls: &mut F)
where
    F: FnMut(Node<'t>, &str, &mut Vec<UnresolvedRef>),
{
    let line = call.start_position().row as i64 + 1;
    let id = format!("route:{}:{}:{}:{}", ctx.file_path, route.method, route.path, line);
    let language = if ctx.file_path.ends_with(".ts") || ctx.file_path.ends_with(".tsx") { "typescript" } else { "javascript" };
    out.nodes.push(GraphNode {
        id: id.clone(),
        kind: "route".into(),
        name: format!("{} {}", route.method, route.path),
        qualified_name: format!("{}::{}:{}", ctx.file_path, route.method, route.path),
        file_path: ctx.file_path.into(),
        start_line: line,
        end_line: call.end_position().row as i64 + 1,
        start_column: ctx.start_col(call),
        end_column: ctx.end_col(call),
        language: language.into(),
        updated_at: ctx.now,
        ..Default::default()
    });

    let Some(handler) = route.handler else { return };
    if is_function_node(handler.kind()) {
        collect_calls(handler, &id, &mut out.refs);
        return;
    }
    if let Some(ref_name) = handler_name(ctx, handler) {
        out.refs.push(UnresolvedRef {
            source_id: id,
            ref_name,
            ref_kind: "function".into(),
            line: Some(line),
            column: Some(ctx.start_col(handler)),
            metadata: None,
        });
    }
}

fn parse_call<'t>(ctx: &Ctx, node: Node<'t>, receivers: &HashSet<String>) -> Option<ParsedCall<'t>> {
    let f = node.child_by_field_name("function")?;
    if f.kind() != "member_expression" {
        return None;
    }
    let obj = f.child_by_field_name("object")?;
    let prop = f.child_by_field_name("property")?;
    if obj.kind() != "identifier" || !receivers.contains(ctx.text(obj)) {
        return None;
    }
    let method = js_lower(ctx.text(prop));
    let args_node = node.child_by_field_name("arguments")?;
    let args: Vec<Node> = named_children(args_node).into_iter().filter(|a| a.kind() != "comment").collect();

    if method == "register" {
        return parse_mount(ctx, &args);
    }
    if method == "route" {
        return parse_route_object(ctx, &args);
    }
    if HTTP_METHODS.contains(&method.as_str()) {
        return parse_shorthand(ctx, &method, &args).map(|r| ParsedCall::Routes(vec![r]));
    }
    None
}

fn plugin_parameter_names(ctx: &Ctx, root: Node, names: &mut HashSet<String>) {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "arrow_function" {
            if let Some(single) = node.child_by_field_name("parameter") {
                if single.kind() == "identifier" {
                    names.insert(ctx.text(single).to_string());
                }
            }
        }
        if node.kind() == "formal_parameters" {
            if let Some(first) = named_children(node).into_iter().find(|c| c.kind() != "comment") {
                if first.kind() == "identifier" {
                    names.insert(ctx.text(first).to_string());
                }
                if first.kind() == "required_parameter" || first.kind() == "optional_parameter" {
                    if let Some(p) = first.child_by_field_name("pattern") {
                        if p.kind() == "identifier" {
                            names.insert(ctx.text(p).to_string());
                        }
                    }
                }
            }
        }
        for c in children(node).into_iter().rev() {
            stack.push(c);
        }
    }
}

fn parse_shorthand<'t>(ctx: &Ctx, method: &str, args: &[Node<'t>]) -> Option<ParsedRoute<'t>> {
    if args.len() < 2 {
        return None;
    }
    let path_node = args[0];
    if path_node.kind() != "string" {
        return None;
    }
    let path = slice_inner(ctx.text(path_node));
    if !path.starts_with('/') {
        return None;
    }
    Some(ParsedRoute { method: method.to_ascii_uppercase(), path, handler: Some(args[args.len() - 1]) })
}

fn parse_route_object<'t>(ctx: &Ctx, args: &[Node<'t>]) -> Option<ParsedCall<'t>> {
    if args.len() != 1 || args[0].kind() != "object" {
        return None;
    }
    let obj = args[0];
    let method_node = object_value(ctx, obj, "method");
    let url_node = object_value(ctx, obj, "url");
    let handler = object_value(ctx, obj, "handler");
    let (method_node, url_node) = (method_node?, url_node?);

    let path = string_content(ctx, url_node)?;
    if !path.starts_with('/') {
        return None;
    }
    let method_nodes = if method_node.kind() == "array" { named_children(method_node) } else { vec![method_node] };
    let mut routes = Vec::new();
    for m in method_nodes {
        let Some(method) = string_content(ctx, m).map(|s| js_lower(&s)) else { continue };
        if method.is_empty() || !HTTP_METHODS.contains(&method.as_str()) {
            continue;
        }
        routes.push(ParsedRoute { method: method.to_ascii_uppercase(), path: path.clone(), handler });
    }
    if routes.is_empty() {
        None
    } else {
        Some(ParsedCall::Routes(routes))
    }
}

fn parse_mount<'t>(ctx: &Ctx, args: &[Node<'t>]) -> Option<ParsedCall<'t>> {
    let first = *args.first()?;
    let target = parse_mount_target(ctx, first)?;
    let mut prefix = String::new();
    if let Some(second) = args.get(1) {
        if second.kind() == "object" {
            let value = object_value(ctx, *second, "prefix").and_then(|n| string_content(ctx, n));
            if let Some(v) = value {
                if !v.starts_with('/') {
                    return None;
                }
                prefix = v;
            }
        }
    }
    Some(ParsedCall::Mount { target, prefix })
}

fn parse_mount_target(ctx: &Ctx, node: Node) -> Option<MountTarget> {
    if is_function_node(node.kind()) {
        return Some(MountTarget::Inline {
            start_line: node.start_position().row as i64 + 1,
            end_line: node.end_position().row as i64 + 1,
        });
    }
    match node.kind() {
        "identifier" => Some(MountTarget::Name { name: ctx.text(node).to_string() }),
        "member_expression" => {
            let obj = node.child_by_field_name("object");
            let prop = node.child_by_field_name("property");
            match (obj, prop) {
                (Some(o), Some(p)) if o.kind() == "identifier" => {
                    Some(MountTarget::Namespace { object: ctx.text(o).to_string(), name: ctx.text(p).to_string() })
                }
                _ => None,
            }
        }
        "call_expression" => {
            let f = node.child_by_field_name("function");
            let arg = node.child_by_field_name("arguments").and_then(|a| named_children(a).into_iter().next());
            match (f, arg) {
                (Some(f), Some(a)) if ctx.text(f) == "require" && a.kind() == "string" => {
                    Some(MountTarget::Require { specifier: slice_inner(ctx.text(a)) })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Value node of `key` in an object literal. The first matching property decides, even when its
/// value is missing.
fn object_value<'t>(ctx: &Ctx, obj: Node<'t>, key: &str) -> Option<Node<'t>> {
    for prop in named_children(obj) {
        if prop.kind() == "pair" {
            if let Some(k) = prop.child_by_field_name("key") {
                if strip_quotes(ctx.text(k)) == key {
                    return prop.child_by_field_name("value");
                }
            }
        } else if prop.kind() == "shorthand_property_identifier" && ctx.text(prop) == key {
            return Some(prop);
        }
    }
    None
}

fn string_content(ctx: &Ctx, node: Node) -> Option<String> {
    if node.kind() == "string" {
        Some(slice_inner(ctx.text(node)))
    } else {
        None
    }
}

fn handler_name(ctx: &Ctx, handler: Node) -> Option<String> {
    if matches!(handler.kind(), "identifier" | "shorthand_property_identifier" | "member_expression") {
        let name = ctx.text(handler);
        let mut chars = name.chars();
        let ok = match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
                chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.')
            }
            _ => false,
        };
        return if ok { Some(name.to_string()) } else { None };
    }
    None
}
