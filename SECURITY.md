# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.15.x  | ✅ Current release |
| < 0.15  | ❌ No patches      |

## Reporting a Vulnerability

If you discover a security vulnerability in KiroGraph, please report it responsibly.

**Do NOT open a public issue.**

Instead, email: **davide.desio@eleva.it**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to expect

- Acknowledgment within 48 hours
- Assessment and fix timeline within 7 days
- Credit in the release notes (unless you prefer anonymity)

## Scope

KiroGraph runs 100% locally with no network calls. The primary attack surface is:

- **Malicious tree-sitter grammars** — KiroGraph uses WASM-compiled grammars from `tree-sitter-wasms`. A compromised grammar could potentially execute arbitrary code within the WASM sandbox.
- **SQLite injection** — All queries use parameterized statements, but reports of bypass are welcome.
- **MCP tool input** — Tool arguments come from the AI agent. Malformed input should be handled gracefully.
- **Shell compression (`kirograph_exec`)** — Executes shell commands. The command itself comes from the agent, not from untrusted user input, but edge cases may exist.

## Out of Scope

- Vulnerabilities in dependencies (report upstream, but let us know so we can pin/patch)
- Issues requiring physical access to the machine
- Social engineering attacks
