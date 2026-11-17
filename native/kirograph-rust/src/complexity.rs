//! Port of the text-based complexity metrics in src/extraction/extractor.ts (enableComplexity).

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::types::GraphNode;

fn strip_regexes() -> &'static [(Regex, &'static str); 5] {
    static R: OnceLock<[(Regex, &'static str); 5]> = OnceLock::new();
    R.get_or_init(|| {
        [
            (Regex::new(r"`[^`]*`").unwrap(), "``"),
            (Regex::new(r#""(?:[^"\\]|\\[^\n\r\x{2028}\x{2029}])*""#).unwrap(), "\"\""),
            (Regex::new(r"'(?:[^'\\]|\\[^\n\r\x{2028}\x{2029}])*'").unwrap(), "''"),
            (Regex::new(r"//[^\n]*").unwrap(), ""),
            (Regex::new(r"(?s)/\*.*?\*/").unwrap(), ""),
        ]
    })
}

fn cc_regexes() -> &'static [Regex] {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| {
        [
            r"(?-u:\b)if(?-u:\b)",
            r"(?-u:\b)else[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+if(?-u:\b)",
            r"(?-u:\b)elif(?-u:\b)",
            r"(?-u:\b)for(?-u:\b)",
            r"(?-u:\b)while(?-u:\b)",
            r"(?-u:\b)do(?-u:\b)",
            r"(?-u:\b)case(?-u:\b)",
            r"(?-u:\b)catch(?-u:\b)",
            r"(?-u:\b)except(?-u:\b)",
            r"&&",
            r"\|\|",
            r"\?\?",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    })
}

fn token_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?-u:\b)[A-Za-z0-9_]+(?-u:\b)|[+\-*/=<>!&|^~%]+|[(){}\[\],;.]").unwrap())
}

/// `/(?<![?!])\?(?![.?:])/g`: a `?` that is a ternary, not `?.`, `??` or `?:`.
fn count_ternaries(s: &str) -> usize {
    let b = s.as_bytes();
    let mut n = 0;
    for i in 0..b.len() {
        if b[i] != b'?' {
            continue;
        }
        if i > 0 && (b[i - 1] == b'?' || b[i - 1] == b'!') {
            continue;
        }
        if i + 1 < b.len() && matches!(b[i + 1], b'.' | b'?' | b':') {
            continue;
        }
        n += 1;
    }
    n
}

pub fn cyclomatic(src: &str) -> i64 {
    let mut stripped = src.to_string();
    for (re, rep) in strip_regexes() {
        stripped = re.replace_all(&stripped, *rep).into_owned();
    }
    let mut count = 0usize;
    for re in cc_regexes() {
        count += re.find_iter(&stripped).count();
    }
    count += count_ternaries(&stripped);
    1 + count as i64
}

pub fn nesting_depth(src: &str) -> i64 {
    let (mut depth, mut max) = (0i64, 0i64);
    for c in src.chars() {
        if c == '{' {
            depth += 1;
            if depth > max {
                max = depth;
            }
        } else if c == '}' {
            depth = (depth - 1).max(0);
        }
    }
    max
}

/// Sets the metrics of every function and method, as the TypeScript extractor does.
pub fn apply(source: &str, nodes: &mut [GraphNode]) {
    let lines: Vec<&str> = source.split('\n').collect();
    for n in nodes.iter_mut() {
        if n.kind != "function" && n.kind != "method" {
            continue;
        }
        let start = ((n.start_line - 1).max(0) as usize).min(lines.len());
        let end = (n.end_line.max(0) as usize).min(lines.len()).max(start);
        let fn_source = lines[start..end].join("\n");
        let cc = cyclomatic(&fn_source);
        let depth = nesting_depth(&fn_source);
        let loc = (n.end_line - n.start_line + 1) as f64;
        let tokens: Vec<&str> = token_regex().find_iter(&fn_source).map(|m| m.as_str()).collect();
        let volume = if tokens.len() > 1 {
            let unique: HashSet<&str> = tokens.iter().copied().collect();
            let u = if unique.is_empty() { 1 } else { unique.len() };
            tokens.len() as f64 * (u as f64).log2()
        } else {
            0.0
        };
        let mi = (171.0 - 5.2 * volume.max(1.0).ln() - 0.23 * cc as f64 - 16.2 * loc.max(1.0).ln()).clamp(0.0, 100.0);
        n.complexity_cyclomatic = Some(cc);
        n.nesting_depth = Some(depth);
        n.maintainability_index = Some((mi * 10.0).round() / 10.0);
    }
}
