//! Compiles the grammar sources the TypeScript engine builds its WASM files from (prepared by
//! `node scripts/grammars.mjs sources` and listed in grammars/.sources/native.json at the root of
//! the repository) and generates the table that maps a KiroGraph language name to its tree-sitter
//! language, with the fingerprint grammars/grammars.json records for it.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    napi_build::setup();

    let crate_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = crate_dir.join("..").join("..");
    let list_path = repo.join("grammars").join(".sources").join("native.json");
    println!("cargo:rerun-if-changed={}", list_path.display());
    let list: serde_json::Value = match std::fs::read_to_string(&list_path) {
        Ok(text) => serde_json::from_str(&text).unwrap(),
        Err(_) => panic!(
            "grammar sources missing ({}); run `node scripts/grammars.mjs sources` at the root of the repository",
            list_path.display()
        ),
    };

    let mut externs = String::new();
    let mut arms = String::new();
    let mut prints = String::new();
    let mut names = Vec::new();

    for (lang, spec) in list.as_object().unwrap() {
        let src = repo.join(spec["src"].as_str().unwrap());
        let symbol = format!("tree_sitter_{}", spec["symbol"].as_str().unwrap());
        if !src.join("parser.c").exists() {
            panic!("grammar sources missing for {lang} ({}); run `node scripts/grammars.mjs sources`", src.display());
        }
        compile(lang, &src);
        writeln!(externs, "    fn {symbol}() -> *const ();").unwrap();
        writeln!(arms, "        \"{lang}\" => Some(unsafe {{ tree_sitter_language::LanguageFn::from_raw({symbol}) }}),").unwrap();
        let fp = &spec["fingerprint"];
        writeln!(
            prints,
            "        \"{lang}\" => Some(({}, {}, {}, {}, \"{}\")),",
            fp["abi"], fp["states"], fp["kinds"], fp["fields"], fp["hash"].as_str().unwrap_or("")
        )
        .unwrap();
        names.push(format!("\"{lang}\""));
    }

    let code = format!(
        "unsafe extern \"C\" {{\n{externs}}}\n\n\
         /// The tree-sitter language compiled in for a KiroGraph language name.\n\
         pub fn grammar(lang: &str) -> Option<tree_sitter_language::LanguageFn> {{\n    match lang {{\n{arms}        _ => None,\n    }}\n}}\n\n\
         /// The fingerprint grammars/grammars.json records for a language: ABI, parse states, node\n\
         /// kinds, fields and the hash of their names (the WASM file's, which this one must match).\n\
         pub fn recorded_fingerprint(lang: &str) -> Option<(u32, u32, u32, u32, &'static str)> {{\n    match lang {{\n{prints}        _ => None,\n    }}\n}}\n\n\
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
