//! String operations with JavaScript semantics.
//!
//! The TypeScript extractor measures and cuts strings in UTF-16 code units, trims the JavaScript
//! whitespace set and uses JavaScript regular expressions. The Rust engine must produce the same
//! strings and numbers, so these helpers reproduce those rules on UTF-8 text.

/// Characters `String.prototype.trim` removes, and `\s` matches, in JavaScript.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// The JavaScript `\s` class, for use inside a `regex` pattern.
pub const JS_S: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// The JavaScript `.` (any character but a line terminator), for use inside a `regex` pattern.
pub const JS_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.length` in JavaScript.
pub fn js_len(s: &str) -> usize {
    if s.is_ascii() {
        return s.len();
    }
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in JavaScript. A surrogate pair cut in half becomes U+FFFD, the character a
/// lone surrogate turns into when the string is written as UTF-8.
pub fn js_prefix(s: &str, n: usize) -> String {
    if s.is_ascii() {
        return s[..n.min(s.len())].to_string();
    }
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            if units < n {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        units += w;
    }
    out
}

/// Truncates like `text.length > max ? text.slice(0, max) + '…' : text`.
pub fn js_truncate(s: &str, max: usize) -> String {
    if js_len(s) > max {
        let mut t = js_prefix(s, max);
        t.push('…');
        t
    } else {
        s.to_string()
    }
}

/// The first line of `s`, as `s.split('\n')[0]`.
pub fn first_line(s: &str) -> &str {
    match s.find('\n') {
        Some(i) => &s[..i],
        None => s,
    }
}

/// `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`
pub fn is_js_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// `s.replace(/^['"`]|['"`]$/g, '')`: one quote off each end.
pub fn strip_quotes(s: &str) -> String {
    let is_q = |c: char| c == '\'' || c == '"' || c == '`';
    let mut t = s;
    if let Some(c) = t.chars().next() {
        if is_q(c) {
            t = &t[1..];
        }
    }
    if let Some(c) = t.chars().last() {
        if is_q(c) {
            t = &t[..t.len() - 1];
        }
    }
    t.to_string()
}

/// `s.slice(1, -1)` for a string literal's text (both ends are ASCII quotes).
pub fn slice_inner(s: &str) -> String {
    if js_len(s) < 2 {
        return String::new();
    }
    let mut it = s.char_indices();
    let start = it.nth(1).map(|(i, _)| i).unwrap_or(s.len());
    let end = s.char_indices().last().map(|(i, _)| i).unwrap_or(0);
    if start >= end {
        return String::new();
    }
    s[start..end].to_string()
}

/// `s.toLowerCase()`: Unicode lowercase, as JavaScript does it outside special locales.
pub fn js_lower(s: &str) -> String {
    if s.is_ascii() {
        s.to_ascii_lowercase()
    } else {
        s.to_lowercase()
    }
}
