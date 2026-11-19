import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/** Import edges, file to file, language by language; an import of a library resolves to nothing. */

let root: string;
let imports: Set<string>;

const files: Record<string, string> = {
  // Java / Kotlin: package + name, and the class of a static member
  'src/main/java/org/acme/util/Strings.java': 'package org.acme.util;\npublic class Strings { public static String trim(String s) { return s; } }\n',
  'src/main/java/org/acme/App.java': 'package org.acme;\nimport org.acme.util.Strings;\nimport static org.acme.util.Strings.trim;\nimport java.util.List;\npublic class App {}\n',
  'src/main/kotlin/acme/Repo.kt': 'package acme.data\nclass Repo\n',
  'src/main/kotlin/acme/Service.kt': 'package acme\nimport acme.data.Repo\nclass Service(val repo: Repo)\n',
  // C#: namespaces
  'CoreLib/Mediator.cs': 'namespace Acme.Core { public class Mediator {} }\n',
  'App/Program.cs': 'using Acme.Core;\nusing System.Linq;\nclass Program {}\n',
  // Go: module path from go.mod
  'go.mod': 'module github.com/acme/app\n\ngo 1.22\n',
  'internal/store/store.go': 'package store\nfunc Open() {}\n',
  'cmd/main.go': 'package main\nimport (\n  "fmt"\n  "github.com/acme/app/internal/store"\n)\nfunc main() { store.Open(); fmt.Println() }\n',
  // Rust: crate:: and a child module
  'Cargo.toml': '[package]\nname = "acme-app"\nversion = "0.1.0"\n',
  'src/lib.rs': 'pub mod flags;\nuse crate::flags::defs::FLAGS;\n',
  'src/flags/mod.rs': 'pub mod defs;\n',
  'src/flags/defs.rs': 'pub const FLAGS: u8 = 1;\n',
  // PHP: PSR-4
  'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': 'php/' } } }),
  'php/Http/Router.php': '<?php\nnamespace Acme\\Http;\nclass Router {}\n',
  'php/App.php': '<?php\nnamespace Acme;\nuse Acme\\Http\\Router;\nuse Psr\\Log\\LoggerInterface;\nclass App {}\n',
  // Ruby, Lua, Perl
  'lib/helper.rb': 'module Helper; end\n',
  'app.rb': "require_relative 'lib/helper'\nrequire 'json'\n",
  'lua/acme/utils.lua': 'local M = {}\nreturn M\n',
  'lua/acme/init.lua': 'local u = require("acme.utils")\n',
  'lib/Acme/Util.pm': 'package Acme::Util;\n1;\n',
  'script.pl': 'use Acme::Util;\nuse strict;\n',
  // Dart: package: from pubspec.yaml
  'dart/pubspec.yaml': 'name: acme\n',
  'dart/lib/src/client.dart': 'class Client {}\n',
  'dart/lib/main.dart': "import 'package:acme/src/client.dart';\nimport 'dart:io';\n",
  // TypeScript: './x.js' for x.ts, a workspace package, tsconfig paths; CommonJS require
  'packages/common/package.json': JSON.stringify({ name: '@acme/common' }),
  'packages/common/index.ts': 'export const common = 1;\n',
  'packages/common/utils/colors.ts': 'export const red = 1;\n',
  // A path alias and a glob of two stars: a slash-star then a star-slash inside strings is no comment
  'tsconfig.json': '{ // paths\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["web/src/*"] } }, /* sources */\n  "include": ["**/*.ts"],\n}\n',
  'web/src/store.ts': 'export const store = 1;\n',
  'web/src/main.ts': "import { common } from '@acme/common';\nimport { red } from '@acme/common/utils/colors.js';\nimport { store } from '@app/store';\nimport { x } from './local.js';\nimport cors from 'cors';\n",
  'web/src/local.ts': 'export const x = 1;\n',
  'server/index.js': "const app = require('./app');\nconst express = require('express');\n",
  'server/app.js': 'function createApp() { return {}; }\nmodule.exports = createApp;\n',
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-imports-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const kg = await KiroGraph.init(root);
  try {
    await kg.indexAll();
    imports = new Set((kg as any).db.getRawDb().all(`
      SELECT DISTINCT s.file_path || ' -> ' || t.file_path AS x FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind = 'imports'`).map((r: any) => r.x));
  } finally { kg.close(); }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('imports resolve to project files', () => {
  const expected: Array<[string, string[]]> = [
    ['Java (class, static member)', ['src/main/java/org/acme/App.java -> src/main/java/org/acme/util/Strings.java']],
    ['Kotlin (package not matching the folder)', ['src/main/kotlin/acme/Service.kt -> src/main/kotlin/acme/Repo.kt']],
    ['C# (namespace)', ['App/Program.cs -> CoreLib/Mediator.cs']],
    ['Go (module path)', ['cmd/main.go -> internal/store/store.go']],
    ['Rust (crate:: down the module tree)', ['src/lib.rs -> src/flags/defs.rs']],
    ['PHP (PSR-4)', ['php/App.php -> php/Http/Router.php']],
    ['Ruby (require_relative)', ['app.rb -> lib/helper.rb']],
    ['Lua (require)', ['lua/acme/init.lua -> lua/acme/utils.lua']],
    ['Perl (use)', ['script.pl -> lib/Acme/Util.pm']],
    ['Dart (package:)', ['dart/lib/main.dart -> dart/lib/src/client.dart']],
    ['TypeScript (workspace package, path in it, tsconfig paths, ./x.js for x.ts)', [
      'web/src/main.ts -> packages/common/index.ts',
      'web/src/main.ts -> packages/common/utils/colors.ts',
      'web/src/main.ts -> web/src/store.ts',
      'web/src/main.ts -> web/src/local.ts',
    ]],
    ['JavaScript (CommonJS require)', ['server/index.js -> server/app.js']],
  ];
  for (const [name, edges] of expected) {
    it(name, () => { for (const e of edges) expect(imports, e).toContain(e); });
  }

  it('a library import resolves to nothing', () => {
    const fromLibraries = [...imports].filter(e => /App\.java|Program\.cs|main\.go|App\.php|app\.rb|main\.dart|main\.ts|index\.js/.test(e.split(' -> ')[0]));
    // every edge above is to a project file; none to a made-up path for java.util, System.Linq, fmt, json, dart:io, cors, express
    for (const e of fromLibraries) expect(fs.existsSync(path.join(root, e.split(' -> ')[1])), e).toBe(true);
  });
});
