# Supported Languages & Frameworks

## General-purpose

| Language | Extensions |
|----------|-----------|
| TypeScript | `.ts` |
| JavaScript | `.js` |
| TSX | `.tsx` |
| JSX | `.jsx` |
| Python | `.py` |
| Go | `.go` |
| Rust | `.rs` |
| Java | `.java` |
| C | `.c`, `.h` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp` |
| C# | `.cs` |
| PHP | `.php` |
| Ruby | `.rb` |
| Swift | `.swift` |
| Kotlin | `.kt` |
| Dart | `.dart` |
| Scala | `.scala`, `.sc`, `.sbt` |
| Lua | `.lua` |
| Zig | `.zig`, `.zon` |
| Bash | `.sh`, `.bash`, `.zsh` |
| OCaml | `.ml`, `.mli` |
| Elm | `.elm` |
| Objective-C | `.m` |

## Frontend & UI

| Language | Extensions |
|----------|-----------|
| React / React Native | `.tsx`, `.jsx` (via TypeScript/JSX grammars) |
| Next.js | `.tsx`, `.jsx` (via TypeScript/JSX grammars) |
| Angular | `.ts`, `.html` (via TypeScript/HTML grammars) |
| Svelte | `.svelte` |
| Vue | `.vue` |
| HTML | `.html`, `.htm` |
| CSS | `.css` |
| SCSS / Sass | `.scss`, `.sass` |

## Domain-specific

| Language | Domain | Extensions |
|----------|--------|-----------|
| Solidity | Blockchain / Web3 | `.sol` |
| Elixir | Distributed systems / Real-time | `.ex`, `.exs` |

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
