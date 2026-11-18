# Supported Languages & Frameworks

Every grammar is built from a source pinned in `grammars/grammars.json` (see [CONTRIBUTING](../../CONTRIBUTING.md#grammars)).
For each language, what the graph holds:

- **Symbols**: declarations (functions, methods, classes, types, modules, variables).
- **Calls**: call edges, resolved to the function they call (see [How it works](how-it-works.md)); a call into a library stays unresolved.
- **Imports**: import edges to the project's files; an import of a library resolves to nothing.
- **Supertypes**: `extends` / `implements` edges.
- **Typed receivers**: a call on a receiver whose type the code declares (a typed parameter, a field, a local made by a constructor, a declared return type) reaches the method of that type or its supertypes.

## General-purpose

| Language | Extensions | Symbols | Calls | Imports | Supertypes | Typed receivers |
|----------|-----------|:-:|:-:|:-:|:-:|:-:|
| TypeScript, TSX | `.ts`, `.tsx`, `.mts`, `.cts` | ✓ | ✓ | ✓ relative, tsconfig `paths`, workspace packages | ✓ | ✓ |
| JavaScript, JSX | `.js`, `.jsx`, `.mjs`, `.cjs` | ✓ | ✓ | ✓ ES and CommonJS `require` | ✓ | ✓ |
| Python | `.py` | ✓ | ✓ | ✓ modules, packages, re-exports | ✓ | ✓ |
| Java | `.java` | ✓ | ✓ | ✓ by package | ✓ | ✓ |
| Kotlin | `.kt`, `.kts` | ✓ | ✓ | ✓ by package | ✓ | ✓ |
| Scala | `.scala`, `.sc`, `.sbt` | ✓ | ✓ | ✓ by package | ✓ | — |
| C# | `.cs` | ✓ | ✓ | ✓ by namespace | ✓ | ✓ |
| Go | `.go` | ✓ | ✓ | ✓ by `go.mod` module path | ✓ embedding | ✓ |
| Rust | `.rs` | ✓ | ✓ | ✓ `crate::` / `super::` / workspace crates | ✓ `impl Trait for` | ✓ |
| C | `.c`, `.h` | ✓ | ✓ through `#include` | ✓ | — | — |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, C++ `.h` | ✓ | ✓ through `#include` | ✓ | ✓ | — |
| Objective-C | `.m`, `.mm`, Objective-C `.h` | ✓ | ✓ messages | ✓ | ✓ | — |
| Swift | `.swift` | ✓ | ✓ | ✓ Swift package targets | ✓ | ✓ |
| Dart | `.dart` | ✓ | ✓ | ✓ `package:` and relative | ✓ | ✓ |
| PHP | `.php` | ✓ | ✓ | ✓ PSR-4 | ✓ | ✓ |
| Ruby | `.rb` | ✓ | ✓ | ✓ `require`, `require_relative` | ✓ `<`, `include` | — |
| Lua | `.lua` | ✓ | ✓ | ✓ `require` | — | — |
| Elixir | `.ex`, `.exs` | ✓ | ✓ | ✓ by module | — | — |
| OCaml | `.ml`, `.mli` | ✓ | ✓ | ✓ `open` | — | — |
| Haskell | `.hs`, `.lhs` | ✓ | ✓ | ✓ by module | — | — |
| Elm | `.elm` | ✓ | ✓ | ✓ by module | — | — |
| ReScript | `.res`, `.resi` | ✓ | ✓ | — | — | — |
| Zig | `.zig`, `.zon` | ✓ | ✓ | — | — | — |
| Bash | `.sh`, `.bash`, `.zsh` | ✓ | ✓ | ✓ `source` | — | — |
| Perl | `.pl`, `.pm` | ✓ | ✓ | ✓ `use` | — | — |
| PowerShell | `.ps1`, `.psm1`, `.psd1` | ✓ | ✓ commands | ✓ `Import-Module` | — | — |
| R | `.r`, `.R` | ✓ | ✓ | ✓ `library()` | — | — |
| Julia | `.jl` | ✓ | ✓ | ✓ `include()` | — | — |
| Nix | `.nix` | ✓ `let` bindings and functions | ✓ | ✓ `import` | — | — |
| Pascal / Delphi | `.pas`, `.dpr`, `.lpr` | ✓ | ✓ | ✓ `uses` | ✓ | — |
| GDScript | `.gd` | ✓ | ✓ | — | — | — |

## Frontend & UI

| Language | Extensions | Extraction |
|----------|-----------|-----------|
| React / React Native / Next.js | `.tsx`, `.jsx` | TypeScript / JavaScript, with components and routes |
| Angular | `.ts`, `.html` | TypeScript, with framework detection |
| Vue | `.vue` | the `<script>` blocks, as TypeScript or JavaScript |
| Svelte | `.svelte` | the `<script>` blocks, as TypeScript or JavaScript |
| Astro | `.astro` | the frontmatter, as TypeScript |
| HTML | `.html`, `.htm` | — |
| CSS | `.css` | rules |
| SCSS / Sass | `.scss`, `.sass` | top-level rules, mixins, functions, `$variables`; `@include` calls; `@use` / `@forward` / `@import` imports |
| Liquid (Shopify) | `.liquid` | a template is a component; `assign` / `capture` variables; `render` / `include` / `section` imports |

## Domain-specific

| Language | Domain | Extensions | Extraction |
|----------|--------|-----------|-----------|
| Solidity | Blockchain / Web3 | `.sol` | contracts, libraries, functions, events, modifiers; calls (`super` to the parent); imports with remappings; `is` supertypes |
| Verilog / SystemVerilog | Hardware | `.v`, `.sv`, `.svh` | modules, functions, tasks; a module instance is a use of its module |
| SQL | Databases | `.sql` | tables, views, functions, from the text of each statement |

## Configuration & Infrastructure

| Language | Extensions | Symbols | References |
|----------|-----------|---------|------------|
| HCL (Terraform) | `.tf`, `.tfvars` | Blocks by address: `aws_s3_bucket.logs`, `data.aws_ami.base`, `module.vpc`, `var.region`, `local.name`, `output.arn`, `provider.aws`, and the state a backend writes (`state:<key>`) | `var.*`, `local.*`, `module.*`, `data.*` and resources used in expressions; each input of a local module to the module's `var.<input>`; a `terraform_remote_state` to the backend with the same `key`; a `.tfvars` value to its variable |
| YAML | `.yaml`, `.yml`, `.tpl` | Helm `values.yaml` keys (`values.image.tag`, four levels), chart dependencies, `define` blocks; Kubernetes objects (`Deployment/web`); GitHub Actions jobs and the actions they use; docker-compose services; top-level keys of other files | `.Values.*` in templates to the values; `include`/`template` to the define; a job's `needs`; a compose service's `depends_on`; a local reusable workflow or action |
| JSON (configuration) | `package.json`, `tsconfig*.json`, `*.config.json`, `appsettings*.json`, `.vscode/`, `config/`, … | Keys three levels deep; `package.json` scripts as functions | A script that runs another (`npm run build`) |

Infrastructure references are resolved by exact name within their scope (a Terraform module is a directory, a Helm chart is the directory of its `Chart.yaml`), so `var.region` in one module never links to another module's. Shell scripts also get the files they `source` and the calls to their functions, including functions defined in a sourced file. Only JSON files whose name or folder says they configure something are indexed; other JSON is data (see the data module).

---

## Framework Detection

KiroGraph automatically detects frameworks and enriches the graph with framework-specific semantics (routes, components, lifecycle methods):

### Web Frameworks

**JavaScript / TypeScript:** React, Next.js, React Native, Angular, Svelte, SvelteKit, Express, Fastify, Koa

**Vue:** Vue, Nuxt

**Python:** Django, Flask, FastAPI

**Ruby:** Rails

**Java:** Spring, Spring Boot, Spring MVC

**Scala:** Play, Akka HTTP, http4s

**Go:** generic Go resolver

**Rust:** generic Rust resolver

**C#:** ASP.NET Core

**Swift:** SwiftUI, UIKit, Vapor

**PHP:** Laravel

**Elixir:** Phoenix

**Solidity:** Hardhat, Foundry, Truffle (OpenZeppelin patterns)

### Infrastructure as Code

AWS CDK, SST, Serverless Framework, AWS SAM, Terraform / OpenTofu, Pulumi, CloudFormation, AWS Amplify Gen 2

### Containers & Orchestration

Kubernetes, Helm, Docker Compose

### Configuration Management

Ansible

Detected frameworks are stored in config and used to improve symbol extraction and resolution.
