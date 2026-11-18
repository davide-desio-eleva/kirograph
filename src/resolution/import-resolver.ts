/**
 * The project files an import names, language by language: `import org.x.Foo` (Java, Kotlin, Scala),
 * `using A.B` (C#), `"github.com/org/repo/pkg"` (Go), `crate::a::b` (Rust), `App\Http\Foo` (PHP),
 * `require 'x'` (Ruby), `package:x/y.dart` (Dart), `import Module` (Swift), `Foo::Bar` (Perl),
 * `uses Unit` (Pascal), `Plug.SSL` (Elixir), `require("a.b")` (Lua), `open Mod` (OCaml), and
 * JavaScript / TypeScript module specifiers (relative, `.js` for `.ts`, workspace packages, tsconfig
 * paths). An import of something outside the project (a library, the standard library) resolves to
 * nothing.
 *
 * Read from the files table, the symbols of each file, and a few manifests (go.mod, Cargo.toml,
 * composer.json, pubspec.yaml, package.json, tsconfig.json); built once per resolution pass.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Node } from '../types';

type Lang = string;

/** At most this many files for an import of a whole package or namespace. */
const PACKAGE_CAP = 100;

const extOf = (f: string): string => f.slice(f.lastIndexOf('.') + 1).toLowerCase();
const dirOf = (f: string): string => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
const baseOf = (f: string): string => f.slice(f.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** `a/b/../c` → `a/c`; null when it climbs above the root. */
function normalize(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') { if (out.length === 0) return null; out.pop(); } else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

export class ImportResolver {
  private files: string[];
  private fileSet: Set<string>;
  private byDir = new Map<string, string[]>();
  /** Files by every suffix of their path without the extension (`b/c` and `a/b/c` for a/b/c.rb). */
  private bySuffix = new Map<string, string[]>();
  private texts = new Map<string, string>();
  private cache = new Map<string, Map<string, unknown>>();

  constructor(private root: string, files: string[], private symbolsOf: (file: string) => Node[]) {
    this.files = files;
    this.fileSet = new Set(files);
    for (const f of files) {
      const d = dirOf(f);
      (this.byDir.get(d) ?? this.byDir.set(d, []).get(d)!).push(f);
      const parts = f.replace(/\.[^./]+$/, '').split('/');
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('/');
        (this.bySuffix.get(key) ?? this.bySuffix.set(key, []).get(key)!).push(f);
      }
    }
  }

  /** Whether the resolver reads the imports of a file (by its extension). */
  handles(file: string): boolean {
    return ImportResolver.HANDLED.has(extOf(file));
  }

  private static HANDLED = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
    'java', 'kt', 'kts', 'scala', 'sc', 'cs', 'go', 'rs', 'php', 'rb', 'dart', 'swift', 'pl', 'pm', 'pas', 'pp',
    'dpr', 'lpr', 'ex', 'exs', 'lua', 'ml', 'mli', 'jl', 'sol', 'scss', 'sass']);

  /** The project files an import names, from a file of a language. */
  resolve(spec: string, from: string, language: Lang): string[] {
    const out = this.resolveIn(spec.trim(), from, language).filter(f => f !== from);
    return [...new Set(out)].slice(0, PACKAGE_CAP);
  }

  private resolveIn(spec: string, from: string, language: Lang): string[] {
    switch (language) {
      case 'typescript': case 'tsx': case 'javascript': case 'jsx': case 'vue': case 'svelte': case 'astro':
        return this.js(spec, from);
      case 'java': case 'kotlin': case 'scala': return this.jvm(spec, language);
      case 'csharp': return this.csharp(spec);
      case 'go': return this.go(spec, from);
      case 'rust': return this.rust(spec, from);
      case 'php': return this.php(spec);
      case 'ruby': return this.bySuffixOrRelative(spec, from, ['rb']);
      case 'dart': return this.dart(spec, from);
      case 'swift': return this.swift(spec);
      case 'perl': return this.suffix(spec.replace(/::/g, '/'), ['pm', 'pl']);
      case 'pascal': return this.pascal(spec);
      case 'elixir': return this.elixir(spec);
      case 'lua': return this.lua(spec);
      case 'ocaml': return this.ocaml(spec);
      case 'julia': return spec.startsWith('./') ? this.relative(spec, from, ['jl']) : [];
      case 'solidity': return this.solidity(spec, from);
      case 'scss': return this.scss(spec, from);
      default: return [];
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private text(f: string, limit = 64 * 1024): string {
    let t = this.texts.get(f);
    if (t === undefined) {
      try {
        const fd = fs.openSync(path.join(this.root, f), 'r');
        try {
          const buf = Buffer.alloc(limit);
          const n = fs.readSync(fd, buf, 0, limit, 0);
          t = buf.subarray(0, n).toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { t = ''; }
      this.texts.set(f, t);
    }
    return t;
  }

  private memo<T>(name: string, key: string, compute: () => T): T {
    let m = this.cache.get(name);
    if (!m) this.cache.set(name, (m = new Map()));
    if (!m.has(key)) m.set(key, compute());
    return m.get(key) as T;
  }

  /** Files whose path ends with the suffix (without extension), of the given extensions; the shortest paths first. */
  private suffix(suffix: string, exts: string[]): string[] {
    const found = (this.bySuffix.get(suffix.replace(/^\/+|\/+$/g, '')) ?? []).filter(f => exts.includes(extOf(f)));
    return found.sort((a, b) => a.length - b.length).slice(0, 1);
  }

  /** `./x` / `../x` from the importing file's folder, with one of the extensions (or as written). */
  private relative(spec: string, from: string, exts: string[], indexNames: string[] = []): string[] {
    const base = normalize(`${dirOf(from)}/${spec}`);
    if (base === null) return [];
    if (this.fileSet.has(base)) return [base];
    for (const e of exts) if (this.fileSet.has(`${base}.${e}`)) return [`${base}.${e}`];
    for (const idx of indexNames) for (const e of exts) if (this.fileSet.has(`${base}/${idx}.${e}`)) return [`${base}/${idx}.${e}`];
    return [];
  }

  private bySuffixOrRelative(spec: string, from: string, exts: string[]): string[] {
    if (spec.startsWith('.')) return this.relative(spec, from, exts);
    return this.suffix(spec, exts);
  }

  /** The nearest file named `name` in the importing file's folder or above it. */
  private nearestUp(from: string, name: string): string | null {
    for (let d = dirOf(from); ; d = dirOf(d)) {
      const f = d ? `${d}/${name}` : name;
      if (this.fileSet.has(f) || fs.existsSync(path.join(this.root, f))) return f;
      if (!d) return null;
    }
  }

  private readJson(f: string): any {
    try {
      // tsconfig.json allows comments and trailing commas
      const raw = this.text(f, 512 * 1024).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(raw);
    } catch { return null; }
  }

  // ── JavaScript / TypeScript ────────────────────────────────────────────────

  private static JS_EXTS = ['ts', 'tsx', 'd.ts', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'json'];

  /** A path in the project as a module: as written, with an extension, as a folder's index; `.js` for `.ts`. */
  private jsFile(base: string): string[] {
    const tryBase = (b: string): string[] => {
      if (this.fileSet.has(b)) return [b];
      for (const e of ImportResolver.JS_EXTS) if (this.fileSet.has(`${b}.${e}`)) return [`${b}.${e}`];
      for (const e of ImportResolver.JS_EXTS) if (this.fileSet.has(`${b}/index.${e}`)) return [`${b}/index.${e}`];
      return [];
    };
    const direct = tryBase(base);
    if (direct.length > 0) return direct;
    // ESM TypeScript imports './x.js' for x.ts
    const m = /^(.*)\.(js|jsx|mjs|cjs)$/.exec(base);
    return m ? tryBase(m[1]) : [];
  }

  /** Workspace packages: their name → folder and entry file. */
  private packages(): Map<string, { dir: string; entry?: string }> {
    return this.memo('js', 'packages', () => {
      const out = new Map<string, { dir: string; entry?: string }>();
      for (const f of this.files) {
        if (!f.endsWith('package.json') || baseOf(f) !== 'package' || f.includes('node_modules/')) continue;
        const pkg = this.readJson(f);
        if (!pkg?.name || out.has(pkg.name)) continue;
        out.set(pkg.name, { dir: dirOf(f), entry: pkg.source ?? pkg.types ?? pkg.typings ?? pkg.module ?? pkg.main });
      }
      return out;
    });
  }

  /** tsconfig `paths` (with `baseUrl`) of the tsconfig nearest the importing file. */
  private tsPaths(from: string): { dir: string; base: string; paths: Record<string, string[]> } | null {
    return this.memo('js', `tsconfig:${dirOf(from)}`, () => {
      for (let d = dirOf(from); ; d = dirOf(d)) {
        for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']) {
          const f = d ? `${d}/${name}` : name;
          if (!fs.existsSync(path.join(this.root, f))) continue;
          const opts = this.readJson(f)?.compilerOptions;
          if (opts?.paths) return { dir: d, base: normalize(`${d}/${opts.baseUrl ?? '.'}`) ?? d, paths: opts.paths };
        }
        if (!d) return null;
      }
    });
  }

  private js(spec: string, from: string): string[] {
    if (spec.startsWith('.')) {
      const base = normalize(`${dirOf(from)}/${spec}`);
      return base === null ? [] : this.jsFile(base);
    }
    // tsconfig paths: "@app/*": ["src/app/*"]
    const ts = this.tsPaths(from);
    if (ts) {
      for (const [pattern, targets] of Object.entries(ts.paths)) {
        const star = pattern.indexOf('*');
        const matched = star < 0 ? (spec === pattern ? '' : null)
          : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
        if (matched === null) continue;
        for (const target of targets) {
          const p = normalize(`${ts.base}/${target.replace('*', matched)}`);
          const found = p === null ? [] : this.jsFile(p);
          if (found.length > 0) return found;
        }
      }
    }
    // A workspace package, or a path inside one: `@nestjs/common`, `@nestjs/common/utils/x.js`
    const pkgs = this.packages();
    const parts = spec.split('/');
    for (let n = Math.min(parts.length, spec.startsWith('@') ? 2 : 1); n >= 1; n--) {
      const name = parts.slice(0, n).join('/');
      const pkg = pkgs.get(name);
      if (!pkg) continue;
      const rest = parts.slice(n).join('/');
      if (rest) {
        for (const base of [`${pkg.dir}/${rest}`, `${pkg.dir}/src/${rest}`]) {
          const found = this.jsFile(normalize(base) ?? base);
          if (found.length > 0) return found;
        }
        return [];
      }
      const entries = [pkg.entry, 'src/index', 'index', 'lib/index'].filter(Boolean) as string[];
      for (const e of entries) {
        const found = this.jsFile(normalize(`${pkg.dir}/${e}`) ?? e);
        // The built entry (dist/index.js) is not in the project: the source's is
        if (found.length > 0) return found;
      }
      return [];
    }
    return [];
  }

  // ── Java, Kotlin, Scala ────────────────────────────────────────────────────

  /** Qualified names (`org.x.Foo`, `org.x.helper`) → files, and packages → files. */
  private jvmIndex(): { names: Map<string, string[]>; packages: Map<string, string[]> } {
    return this.memo('jvm', 'index', () => {
      const names = new Map<string, string[]>();
      const packages = new Map<string, string[]>();
      const add = (m: Map<string, string[]>, k: string, f: string) => (m.get(k) ?? m.set(k, []).get(k)!).push(f);
      for (const f of this.files) {
        if (!['java', 'kt', 'kts', 'scala', 'sc'].includes(extOf(f))) continue;
        const pkg = /^\s*package\s+([\w.]+)/m.exec(this.text(f, 16 * 1024))?.[1] ?? '';
        add(packages, pkg, f);
        const declared = new Set<string>([baseOf(f)]);
        for (const n of this.symbolsOf(f)) {
          if (['class', 'interface', 'enum', 'struct', 'trait', 'function', 'type_alias', 'module', 'variable', 'constant', 'property'].includes(n.kind)) declared.add(n.name);
        }
        for (const name of declared) add(names, pkg ? `${pkg}.${name}` : name, f);
      }
      return { names, packages };
    });
  }

  private jvm(spec: string, language: Lang): string[] {
    let s = spec.replace(/^static\s+/, '').replace(/;$/, '').trim();
    const { names, packages } = this.jvmIndex();
    // Scala: a.b.{C, D => E}
    const brace = /^(.*)\.\{(.*)\}$/.exec(s);
    if (brace) {
      return brace[2].split(',').flatMap(part => this.jvm(`${brace[1]}.${part.split(/=>|⇒/)[0].trim()}`, language));
    }
    // Wildcard: a.b.* (Java, Kotlin), a.b._ (Scala)
    if (/\.(\*|_)$/.test(s)) {
      const pkg = s.replace(/\.(\*|_)$/, '');
      return packages.get(pkg) ?? names.get(pkg) ?? [];
    }
    s = s.replace(/\s+as\s+\w+$/, '');
    // The name, else the class of a static or nested member (a.b.C.member, a.b.C.Inner)
    const parts = s.split('.');
    for (let n = parts.length; n >= Math.max(1, parts.length - 2); n--) {
      const found = names.get(parts.slice(0, n).join('.'));
      if (found) return found;
    }
    return [];
  }

  // ── C# ─────────────────────────────────────────────────────────────────────

  private csharpIndex(): Map<string, string[]> {
    return this.memo('cs', 'index', () => {
      const out = new Map<string, string[]>();
      for (const f of this.files) {
        if (extOf(f) !== 'cs') continue;
        const re = /^\s*namespace\s+([\w.]+)/gm;
        const text = this.text(f);
        for (let m = re.exec(text); m; m = re.exec(text)) (out.get(m[1]) ?? out.set(m[1], []).get(m[1])!).push(f);
      }
      return out;
    });
  }

  private csharp(spec: string): string[] {
    const s = spec.replace(/^static\s+/, '').replace(/;$/, '').trim();
    const index = this.csharpIndex();
    const files = index.get(s);
    if (files) return files;
    // using static A.B.C: the class C in namespace A.B
    const dot = s.lastIndexOf('.');
    if (dot > 0) {
      const ns = index.get(s.slice(0, dot)) ?? [];
      const cls = s.slice(dot + 1);
      return ns.filter(f => baseOf(f) === cls || this.symbolsOf(f).some(n => n.name === cls));
    }
    return [];
  }

  // ── Go ─────────────────────────────────────────────────────────────────────

  private go(spec: string, from: string): string[] {
    const mod = this.memo('go', `mod:${dirOf(from)}`, () => {
      const f = this.nearestUp(from, 'go.mod');
      const name = f ? /^\s*module\s+(\S+)/m.exec(this.text(f))?.[1] : undefined;
      return f && name ? { dir: dirOf(f), name } : null;
    });
    if (!mod || !(spec === mod.name || spec.startsWith(`${mod.name}/`))) return [];
    const dir = normalize(`${mod.dir}/${spec.slice(mod.name.length)}`) ?? '';
    return (this.byDir.get(dir) ?? []).filter(f => extOf(f) === 'go' && !f.endsWith('_test.go'));
  }

  // ── Rust ───────────────────────────────────────────────────────────────────

  /** The crate a file belongs to: its Cargo.toml folder, root module file and name. */
  private crateOf(from: string): { dir: string; root: string; name: string } | null {
    return this.memo('rust', `crate:${dirOf(from)}`, () => {
      const toml = this.nearestUp(from, 'Cargo.toml');
      if (!toml) return null;
      const dir = dirOf(toml);
      const manifest = this.text(toml);
      const name = (/^\s*name\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? '').replace(/-/g, '_');
      const src = dir ? `${dir}/src` : 'src';
      // [lib] / [[bin]] path = "crates/core/main.rs" (ripgrep's), else src/lib.rs, src/main.rs
      const declared = [...manifest.matchAll(/^\[(?:lib|\[bin\])\][^[]*?^\s*path\s*=\s*"([^"]+)"/gms)]
        .map(m => normalize(`${dir}/${m[1]}`)).filter((f): f is string => !!f && this.fileSet.has(f));
      // The root that the importing file is under, when the crate has several
      const root = declared.sort((a, b) => (from.startsWith(dirOf(b)) ? 1 : 0) - (from.startsWith(dirOf(a)) ? 1 : 0))[0]
        ?? [`${src}/lib.rs`, `${src}/main.rs`].find(f => this.fileSet.has(f)) ?? '';
      return { dir, root, name };
    });
  }

  /** Workspace crates by name. */
  private crates(): Map<string, string> {
    return this.memo('rust', 'crates', () => {
      const out = new Map<string, string>();
      for (const f of this.files) {
        if (extOf(f) !== 'rs') continue;
        const c = this.crateOf(f);
        if (c?.name && c.root && !out.has(c.name)) out.set(c.name, c.root);
      }
      return out;
    });
  }

  /** The folder a module file's submodules live in: src/ for lib.rs / mod.rs, src/a/ for src/a.rs. */
  private static moduleDir(file: string): string {
    return /(^|\/)(lib|main|mod)\.rs$/.test(file) ? dirOf(file) : file.replace(/\.rs$/, '');
  }

  private moduleFileIn(dir: string, name: string): string | null {
    const prefix = dir ? `${dir}/` : '';
    return [`${prefix}${name}.rs`, `${prefix}${name}/mod.rs`].find(f => this.fileSet.has(f)) ?? null;
  }

  /** `use a::{b, c::{d, e}}` → a::b, a::c::d, a::c::e */
  private static expandUse(spec: string): string[] {
    const s = spec.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '');
    const open = s.indexOf('{');
    if (open < 0) return [s];
    let depth = 0, close = -1;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) { close = i; break; }
    }
    if (close < 0) return [s];
    const head = s.slice(0, open);
    const parts: string[] = [];
    let d = 0, start = open + 1;
    for (let i = open + 1; i < close; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}') d--;
      else if (s[i] === ',' && d === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    parts.push(s.slice(start, close));
    return parts.filter(Boolean).flatMap(p => ImportResolver.expandUse(head + p));
  }

  /** The module file of a folder of modules: the crate root for src/, else dir.rs or dir/mod.rs. */
  private moduleFileForDir(dir: string, crate: { dir: string; root: string } | null): string | null {
    if (crate && crate.root && dir === dirOf(crate.root)) return crate.root;
    return this.moduleFileIn(dirOf(dir), baseOf(dir));
  }

  /** The parent module of a module file (`super`): src/a/b.rs → src/a.rs, src/a/mod.rs → the crate root. */
  private parentModule(file: string, crate: { dir: string; root: string } | null): string | null {
    if (/(^|\/)(lib|main)\.rs$/.test(file)) return null;
    const parentDir = /(^|\/)mod\.rs$/.test(file) ? dirOf(dirOf(file)) : dirOf(file);
    return this.moduleFileForDir(parentDir, crate);
  }

  private rust(spec: string, from: string): string[] {
    const crate = this.crateOf(from);
    return ImportResolver.expandUse(spec).flatMap(usePath => {
      const segs = usePath.split('::').filter(Boolean);
      let file: string | null;
      let i = 1;
      if (segs[0] === 'crate') file = crate?.root || null;
      else if (segs[0] === 'self') file = from;
      else if (segs[0] === 'super') file = this.parentModule(from, crate);
      else if (this.crates().has(segs[0])) file = this.crates().get(segs[0])!;
      // A child module declared with `mod name;` is usable by its name
      else file = this.moduleFileIn(ImportResolver.moduleDir(from), segs[0]);
      // Further `super::`, then down the module path: crate::a::b::Item → src/a/b.rs
      while (file && segs[i] === 'super') { file = this.parentModule(file, crate); i++; }
      for (; file && i < segs.length; i++) {
        if (segs[i] === '*' || segs[i] === 'self') break;
        const next = this.moduleFileIn(ImportResolver.moduleDir(file), segs[i]);
        if (!next) break;
        file = next;
      }
      return file ? [file] : [];
    });
  }

  // ── PHP ────────────────────────────────────────────────────────────────────

  private psr4(): Array<{ prefix: string; dir: string }> {
    return this.memo('php', 'psr4', () => {
      const out: Array<{ prefix: string; dir: string }> = [];
      for (const f of this.files) {
        if (!f.endsWith('composer.json') || f.includes('vendor/')) continue;
        const json = this.readJson(f);
        for (const section of [json?.autoload, json?.['autoload-dev']]) {
          for (const [prefix, dirs] of Object.entries<any>(section?.['psr-4'] ?? {})) {
            for (const d of Array.isArray(dirs) ? dirs : [dirs]) out.push({ prefix, dir: normalize(`${dirOf(f)}/${d}`) ?? d });
          }
        }
      }
      return out.sort((a, b) => b.prefix.length - a.prefix.length);
    });
  }

  private php(spec: string): string[] {
    const s = spec.replace(/^(function|const)\s+/, '').replace(/\s+as\s+\w+$/, '').replace(/^\\+/, '').trim();
    for (const { prefix, dir } of this.psr4()) {
      if (!s.startsWith(prefix)) continue;
      const f = `${dir ? dir + '/' : ''}${s.slice(prefix.length).replace(/\\/g, '/')}.php`;
      if (this.fileSet.has(f)) return [f];
    }
    return this.suffix(s.replace(/\\/g, '/'), ['php']);
  }

  // ── Dart ───────────────────────────────────────────────────────────────────

  private dart(spec: string, from: string): string[] {
    if (spec.startsWith('dart:')) return [];
    const pkg = /^package:([\w]+)\/(.*)$/.exec(spec);
    if (pkg) {
      const dirs = this.memo('dart', 'pubspecs', () => {
        const out = new Map<string, string>();
        for (const f of this.files) {
          if (!/(^|\/)pubspec\.yaml$/.test(f)) continue;
          const name = /^name:\s*([\w]+)/m.exec(this.text(f))?.[1];
          if (name && !out.has(name)) out.set(name, dirOf(f));
        }
        return out;
      });
      const dir = dirs.get(pkg[1]);
      if (dir === undefined) return [];
      const f = normalize(`${dir}/lib/${pkg[2]}`);
      return f && this.fileSet.has(f) ? [f] : [];
    }
    return this.relative(spec, from, []);
  }

  // ── Swift ──────────────────────────────────────────────────────────────────

  private swift(spec: string): string[] {
    // A Swift package's target: its `path:` in Package.swift (`.target(name: "Alamofire", path: "Source")`),
    // else Sources/<Module>/
    const name = spec.replace(/^(@\w+\s+)*(class|struct|enum|protocol|func|typealias|var|let)\s+/, '').split('.')[0];
    const targets = this.memo('swift', 'targets', () => {
      const out = new Map<string, string>();
      for (const f of this.files.filter(f => /(^|\/)Package\.swift$/.test(f)).concat(fs.existsSync(path.join(this.root, 'Package.swift')) ? ['Package.swift'] : [])) {
        const text = this.text(f);
        for (const m of text.matchAll(/\.(?:target|executableTarget|testTarget)\(\s*name:\s*"([^"]+)"([^)]*)/g)) {
          const p = /path:\s*"([^"]+)"/.exec(m[2])?.[1] ?? `Sources/${m[1]}`;
          if (!out.has(m[1])) out.set(m[1], normalize(`${dirOf(f)}/${p}`) ?? p);
        }
      }
      return out;
    });
    const dir = targets.get(name) ?? `Sources/${name}`;
    return this.files.filter(f => extOf(f) === 'swift' && (f.startsWith(`${dir}/`) || new RegExp(`(^|/)Sources/${name}/`).test(f)));
  }

  // ── Solidity, SCSS ─────────────────────────────────────────────────────────

  /** Solidity: relative paths, remappings (`@openzeppelin/contracts/=contracts/`), project-root paths. */
  private solidity(spec: string, from: string): string[] {
    if (spec.startsWith('.')) return this.relative(spec, from, []);
    const remaps = this.memo('sol', 'remappings', () => {
      const out: Array<{ prefix: string; dir: string }> = [];
      for (const f of ['remappings.txt', ...this.files.filter(f => /(^|\/)remappings\.txt$/.test(f))]) {
        for (const line of this.text(f).split('\n')) {
          const m = /^\s*([^=\s]+)=(\S+)\s*$/.exec(line);
          if (m) out.push({ prefix: m[1], dir: normalize(`${dirOf(f)}/${m[2]}`) ?? m[2] });
        }
      }
      return out.sort((a, b) => b.prefix.length - a.prefix.length);
    });
    for (const { prefix, dir } of remaps) {
      if (!spec.startsWith(prefix)) continue;
      const f = normalize(`${dir}/${spec.slice(prefix.length)}`);
      if (f && this.fileSet.has(f)) return [f];
    }
    return this.fileSet.has(spec) ? [spec] : [];
  }

  /** SCSS: `@use 'base'` is base.scss, the partial _base.scss, or base/_index.scss; next to the file, else by path. */
  private scss(spec: string, from: string): string[] {
    const s = spec.replace(/^sass:.*$/, '');
    if (!s || /^(https?:)?\/\//.test(s)) return [];
    const variants = (p: string): string[] => {
      const dir = dirOf(p), base = p.slice(p.lastIndexOf('/') + 1).replace(/\.(scss|sass|css)$/, '');
      const prefix = dir ? `${dir}/` : '';
      return [`${prefix}${base}.scss`, `${prefix}_${base}.scss`, `${prefix}${base}.sass`, `${prefix}_${base}.sass`, `${prefix}${base}.css`,
        `${prefix}${base}/_index.scss`, `${prefix}${base}/index.scss`];
    };
    const local = normalize(`${dirOf(from)}/${s}`);
    for (const f of local ? variants(local) : []) if (this.fileSet.has(f)) return [f];
    for (const f of variants(s)) {
      const found = this.suffix(f.replace(/\.[^./]+$/, ''), ['scss', 'sass', 'css']);
      if (found.length > 0) return found;
    }
    return [];
  }

  // ── Pascal, Elixir, Lua, OCaml ─────────────────────────────────────────────

  private pascal(spec: string): string[] {
    const name = spec.split(/\s+in\s+/i)[0].trim().toLowerCase();
    return this.files.filter(f => ['pas', 'pp', 'dpr', 'lpr', 'inc'].includes(extOf(f)) && baseOf(f).toLowerCase() === name).slice(0, 1);
  }

  private elixir(spec: string): string[] {
    const index = this.memo('elixir', 'modules', () => {
      const out = new Map<string, string>();
      for (const f of this.files) {
        if (!['ex', 'exs'].includes(extOf(f))) continue;
        const re = /^\s*defmodule\s+([\w.]+)/gm;
        const text = this.text(f);
        for (let m = re.exec(text); m; m = re.exec(text)) if (!out.has(m[1])) out.set(m[1], f);
      }
      return out;
    });
    const s = spec.replace(/,.*$/, '').trim();
    const f = index.get(s);
    return f ? [f] : [];
  }

  private lua(spec: string): string[] {
    const p = spec.replace(/\./g, '/');
    return [...this.suffix(p, ['lua']), ...this.suffix(`${p}/init`, ['lua'])].slice(0, 1);
  }

  private ocaml(spec: string): string[] {
    const mod = spec.split('.')[0];
    const file = mod.charAt(0).toLowerCase() + mod.slice(1);
    return this.files.filter(f => ['ml', 'mli'].includes(extOf(f)) && baseOf(f) === file).sort((a, b) => (extOf(a) === 'ml' ? -1 : 1) - (extOf(b) === 'ml' ? -1 : 1)).slice(0, 1);
  }
}
