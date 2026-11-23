//! The extraction result, with the same fields as `ExtractedFile` in src/extraction/extractor.ts.
//! Files the TypeScript extractor handles arrive in this shape too (as JSON), so one writer
//! stores both.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub file_path: String,
    pub language: String,
    pub start_line: i64,
    pub end_line: i64,
    pub start_column: i64,
    pub end_column: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docstring: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(default)]
    pub is_exported: bool,
    #[serde(default)]
    pub is_async: bool,
    #[serde(default)]
    pub is_static: bool,
    #[serde(default)]
    pub is_abstract: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decorators: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_parameters: Option<Value>,
    /// The class a function or method returns (`Repo`, `Job[]`, `Queue<Job>`), read by resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complexity_cyclomatic: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complexity_cognitive: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complexity_halstead: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintainability_index: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nesting_depth: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_score: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedRef {
    pub source_id: String,
    pub ref_name: String,
    pub ref_kind: String,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub column: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteMountFact {
    pub plugin_name: String,
    pub imported_name: Option<String>,
    pub specifier: Option<String>,
    pub prefix: String,
    pub line: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_end: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFile {
    pub file_path: String,
    pub language: String,
    pub content_hash: String,
    pub file_size: i64,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub unresolved_refs: Vec<UnresolvedRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_mounts: Option<Vec<RouteMountFact>>,
    /// The file's stat key when it was read (TypeScript FileRecord.statKey); recorded with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat_key: Option<String>,
}
