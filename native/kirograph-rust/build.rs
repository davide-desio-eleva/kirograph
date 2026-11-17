//! Compiles the grammar sources fetched into grammars/ (see grammars.json) and generates the
//! table that maps a KiroGraph language name to its tree-sitter language.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    napi_build::setup();

    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("grammars.json")).unwrap()).unwrap();
    println!("cargo:rerun-if-changed=grammars.json");

    let mut externs = String::new();
    let mut arms = String::new();
    let mut names = Vec::new();

    for pkg in manifest["packages"].as_array().unwrap() {
        let name = pkg["package"].as_str().unwrap();
        let dir = root.join("grammars").join(name.rsplit('/').next().unwrap());
        for (lang, spec) in pkg["languages"].as_object().unwrap() {
            let src = dir.join(spec["src"].as_str().unwrap());
            let symbol = spec["symbol"].as_str().unwrap();
            if !src.join("parser.c").exists() {
                panic!(
                    "grammar sources missing for {lang} ({}); run `node scripts/fetch-grammars.mjs`",
                    src.display()
                );
            }
            compile(lang, &src);
            writeln!(externs, "    fn {symbol}() -> *const ();").unwrap();
            writeln!(
                arms,
                "        \"{lang}\" => Some(unsafe {{ tree_sitter_language::LanguageFn::from_raw({symbol}) }}),"
            )
            .unwrap();
            names.push(format!("\"{lang}\""));
        }
    }

    let code = format!(
        "unsafe extern \"C\" {{\n{externs}}}\n\n\
         /// The tree-sitter language compiled in for a KiroGraph language name.\n\
         pub fn grammar(lang: &str) -> Option<tree_sitter_language::LanguageFn> {{\n    match lang {{\n{arms}        _ => None,\n    }}\n}}\n\n\
         /// Languages with a grammar compiled in.\n\
         pub const GRAMMAR_LANGUAGES: &[&str] = &[{}];\n",
        names.join(", ")
    );
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("grammars.rs");
    std::fs::write(out, code).unwrap();
}

fn compile(lang: &str, src: &Path) {
    let mut c = cc::Build::new();
    c.include(src).std("c11").warnings(false).flag_if_supported("-w").opt_level(2);
    // The MSVC headers define static_assert for C++ only; some scanners use it in C
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        c.define("static_assert", "_Static_assert");
    }
    c.file(src.join("parser.c"));
    let scanner_c = src.join("scanner.c");
    if scanner_c.exists() {
        c.file(&scanner_c);
    }
    c.compile(&format!("ts-{lang}"));

    let scanner_cc = src.join("scanner.cc");
    if scanner_cc.exists() {
        let mut cpp = cc::Build::new();
        cpp.cpp(true).include(src).warnings(false).flag_if_supported("-w").opt_level(2);
        cpp.file(&scanner_cc);
        cpp.compile(&format!("ts-{lang}-scanner"));
    }
    println!("cargo:rerun-if-changed={}", src.display());
}
