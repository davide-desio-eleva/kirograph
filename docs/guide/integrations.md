# Integrations

## Using with Kiro (Primary)

`kirograph install` or `kirograph install --target kiro` sets up four things in your Kiro workspace (all coexist, so you can switch between IDE and CLI freely):

### MCP Server (`.kiro/settings/mcp.json`)

Registers the KiroGraph MCP server with all tools auto-approved. Used by both the IDE and the CLI agent:

```json
{
  "mcpServers": {
    "kirograph": {
      "command": "kirograph",
      "args": ["serve", "--mcp"],
      "autoApprove": [
        "kirograph_search", "kirograph_context", "kirograph_callers",
        "kirograph_callees", "kirograph_impact", "kirograph_node",
        "kirograph_status", "kirograph_files", "kirograph_dead_code",
        "kirograph_circular_deps", "kirograph_path", "kirograph_type_hierarchy",
        "kirograph_architecture", "kirograph_coupling", "kirograph_package",
        "kirograph_hotspots", "kirograph_surprising", "kirograph_diff",
        "kirograph_exec", "kirograph_gain",
        "kirograph_mem_search", "kirograph_mem_store",
        "kirograph_mem_timeline", "kirograph_mem_status",
        "kirograph_docs_toc", "kirograph_docs_search",
        "kirograph_docs_section", "kirograph_docs_outline", "kirograph_docs_refs",
        "kirograph_data_list", "kirograph_data_describe",
        "kirograph_data_query", "kirograph_data_aggregate", "kirograph_data_search",
        "kirograph_data_join", "kirograph_data_correlations", "kirograph_data_quality"
      ]
    }
  }
}
```

### IDE Hooks (`.kiro/hooks/`)

Up to three hooks are installed (`.kiro.hook` extension):

| Hook file | Event | Type | Behavior |
|-----------|-------|------|----------|
| `kirograph-sync-if-dirty.kiro.hook` | `agentStop` | `runCommand` | Runs `kirograph sync --quiet` when the agent stops. Skips unchanged files via content hashing. |
| `kirograph-compress-hint.kiro.hook` | `preToolUse` (shell) | `askAgent` | Reminds the agent to use `kirograph_exec` for commands that benefit from token compression. Only installed when shell compression is enabled. |
| `kirograph-mem-capture.kiro.hook` | `agentStop` | `askAgent` | Prompts the agent to store important observations in memory at the end of each session. Only installed when memory is enabled. |

### Global Hook Library (`~/.kirograph/hooks/`)

Personal Kiro hooks can be saved outside any project and reused across workspaces.

| Command | Action |
|---------|--------|
| `kirograph hook save [path]` | Copy hooks from `.kiro/hooks/` to `~/.kirograph/hooks/` (overwrites same filename) |
| `kirograph hook import [path]` | Copy global hooks into `.kiro/hooks/` |
| `kirograph hook list` | List saved global hooks (display name and description) |

During interactive **`kirograph install --target kiro`** (no `--yes`), if the global store is non-empty, the installer adds a **Hooks** step (after Agent Behavior, before Memory) to import global hooks (`None`, `All`, or `Select specific hooks`). Selected hooks are copied after bundled KiroGraph hooks are written so defaults take precedence on filename conflicts. Use `kirograph hook import` for a standalone import outside install.

### CLI Agent Config (`.kiro/agents/kirograph.json`)

A custom agent for Kiro CLI with session-boundary sync hooks:

| Event | Action |
|-------|--------|
| `agentSpawn` | `kirograph sync-if-dirty --quiet` (catches edits made between sessions) |
| `userPromptSubmit` | `kirograph sync-if-dirty --quiet` (keeps graph fresh within a session) |
| `stop` | `kirograph sync-if-dirty --quiet` (deferred flush, mirrors IDE `agentStop`) |

Use it with:

```bash
kiro-cli --agent kirograph
```

Or swap inside an active session:

```
/agent swap kirograph
```

### Steering File (`.kiro/steering/kirograph.md`)

Always-active. Teaches the Kiro IDE to prefer graph tools over file scanning when `.kirograph/` exists. Includes a quick decision guide, tool selection rules, and — when enabled — sections for memory, docs, data, and security.

### Workflow Steering Files (`inclusion: manual`)

KiroGraph installs 5 task-specific steering files alongside the main one. These are **not** always active — they are loaded on demand by the agent when you mention the workflow, or by typing `/kirograph-<name>` in a Kiro session.

| File | Activate with | When to use |
|------|--------------|-------------|
| `kirograph-review.md` | `/kirograph-review` | Structured code review — blast radius, test coverage, coupling |
| `kirograph-debug.md` | `/kirograph-debug` | Systematic debugging — trace calls, check recent changes, find root cause |
| `kirograph-architecture.md` | `/kirograph-architecture` | Architecture exploration — packages, layers, coupling metrics, cycles |
| `kirograph-onboard.md` | `/kirograph-onboard` | Onboarding a new codebase — structure, entry points, key symbols |
| `kirograph-refactor.md` | `/kirograph-refactor` | Safe refactoring — blast radius, rename preview, verify after changes |
| `kirograph-security.md` | `/kirograph-security` | Security audit — vulnerability triage, EPSS prioritization, license compliance, staleness *(written only when `enableSecurity: true`)* |

**How to activate in Kiro IDE:** mention the workflow by name in your prompt (e.g. "do a security audit" or "review this PR") and Kiro will auto-load the relevant steering file. You can also explicitly type `/kirograph-security` to force-load it.

**How to activate in other agents (Claude Code, Cursor, etc.):** paste the file content as context, or reference `.kiro/steering/kirograph-security.md` directly in your prompt.

All workflow files follow the same structure: numbered steps with exact tool calls, an interpretation reference, and tips.

---

## Other Tools (Experimental)

> **⚠️ Community-contributed, vibecoded, unverified.** These integrations are provided as-is. PRs welcome for fixes and corrections.

KiroGraph can be installed for any MCP-capable coding agent. All targets share the same `.kirograph/` data — installing another target only writes that tool's integration files and reuses the existing graph.

```bash
kirograph install --target <name>
```

### Supported Targets (34)

| Tool | Target | MCP Config | Instructions | Hooks | Pattern |
|------|--------|-----------|--------------|-------|---------|
| 🎯 **Kiro** *(primary)* | `kiro` | `.kiro/settings/mcp.json` | Steering + CLI agent | ✅ sync + hint + memory | Full |
| Cursor | `cursor` | `.cursor/mcp.json` | `.cursor/rules/kirograph.mdc` | ✅ sync on stop | A |
| GitHub Copilot | `copilot` | `.github/copilot-mcp.json` | `.github/copilot-instructions.md` | ✅ sync on session-end | A |
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json` | `AGENTS.md` | — | D |
| Roo Code | `roo` | `.roo/mcp.json` | `.roo/rules/kirograph.md` | — | A |
| JetBrains Junie | `junie` | `.junie/mcp/mcp.json` | `.junie/AGENTS.md` | — | A |
| Continue | `continue` | `.continue/mcpServers/kirograph.json` | `.continue/rules/kirograph.md` | — | A |
| Warp | `warp` | `.warp/.mcp.json` | `AGENTS.md` | — | A |
| Trae | `trae` | `.trae/mcp.json` | `.trae/rules/kirograph.md` | — | A |
| Augment Code | `augment` | `.augment/mcp.json` | `augment-guidelines.md` | — | A |
| Sourcegraph Amp | `amp` | `.amp/config.json` | `.amp/instructions.md` | — | A |
| Tabnine | `tabnine` | `.tabnine/mcp.json` | `.tabnine/instructions.md` | — | A |
| Claude Code | `claude` | `.mcp.json` | `CLAUDE.md` | ✅ sync on Stop | B |
| Codex CLI | `codex` | `.codex/hooks.json` | `AGENTS.md` | ✅ sync on Stop | B |
| Gemini CLI | `gemini-cli` | `.gemini/settings.json` | `GEMINI.md` | ✅ SessionEnd | C |
| OpenCode | `opencode` | `.opencode.json` | `.opencode.json (instructions)` | ✅ plugin | C |
| Kilo Code | `kilo` | `kilo.json` | `.kilo/rules/kirograph.md` | — | C |
| Devin | `devin` | `.devin/config.json` | `AGENTS.md` | ✅ .devin/hooks.v1.json | C |
| OpenHands | `openhands` | `.openhands/config.json` | `AGENTS.md` | — | C |
| Windsurf | `windsurf` | Print command | `.windsurf/rules/kirograph.md` | ✅ sync on response | D |
| Cline | `cline` | Print command | `.clinerules/kirograph.md` | ✅ sync script | D |
| Antigravity | `antigravity` | Print command | `GEMINI.md` | ✅ .agents/hooks.json | D |
| Aider | `aider` | Print CLI flag | `CONVENTIONS.md` | — | D |
| Replit Agent | `replit` | Print command | `AGENTS.md` | — | D |
| Block Goose | `goose` | Print command | `AGENTS.md` | — | D |
| Mistral Vibe | `mistral-vibe` | Print command | `.kirograph/mistral-vibe.md` | — | D |
| IBM Bob | `ibm-bob` | Print command | `.kirograph/ibm-bob.md` | — | D |
| Crush | `crush` | Print command | `.kirograph/crush.md` | — | D |
| Droid Factory | `droid-factory` | Print command | `.kirograph/droid-factory.md` | — | D |
| ForgeCode | `forgecode` | Print command | `.kirograph/forgecode.md` | — | D |
| iFlow CLI | `iflow` | Print command | `.kirograph/iflow.md` | — | D |
| Qwen Code | `qwen` | Print command | `.kirograph/qwen.md` | — | D |
| Atlassian Rovo Dev | `rovo` | Print command | `.kirograph/rovo.md` | — | D |
| Qoder | `qoder` | Print command | `.kirograph/qoder.md` | — | D |

### Integration Patterns

**Pattern A — Project-level MCP config + rules file:** The installer writes a JSON config file the tool reads on startup, plus a rules/instructions file the agent loads into context. Restart the tool after installing.

**Pattern B — Standard mcpServers + project memory file:** Writes a standard `mcpServers` config plus a generated block in the tool's project memory file (`CLAUDE.md`, `AGENTS.md`). The block is idempotent.

**Pattern C — Custom config format:** The tool has its own config schema. The installer merges the kirograph entry without overwriting other settings.

**Pattern D — Print-only:** The tool's MCP config is user-scoped or cloud-hosted. The installer writes instructions locally and prints the exact command to register the MCP server.

### Auto-Sync Hooks

For tools that support lifecycle hooks, the installer writes auto-sync hooks that run `kirograph sync` when the agent finishes:

| Tool | Hook file | Event | Behavior |
|------|-----------|-------|----------|
| Kiro | `.kiro/hooks/*.kiro.hook` | agentStop + preToolUse | Sync + compression hint + memory capture |
| Cursor | `.cursor/hooks.json` | stop | Sync on task completion |
| Windsurf | `.windsurf/hooks.json` | post_cascade_response | Sync after each response |
| Claude Code | `.claude/settings.json` | Stop | Sync on session stop |
| GitHub Copilot | `.github/hooks.json` | session-end | Sync on session end |
| Cline | `.clinerules/hooks/task_completed` | task_completed | Executable script that syncs |
| Codex CLI | `.codex/hooks.json` | Stop | Sync on session stop |
| Antigravity | `.agents/hooks.json` | Stop | Sync on execution stop |
| Gemini CLI | `.gemini/settings.json` | SessionEnd | Sync on session end |
| OpenCode | `.opencode/plugins/kirograph-sync.js` | session.idle | JS plugin that syncs |
| Devin | `.devin/hooks.v1.json` | Stop | Sync on session stop |

For tools **without** a hook system (22 targets), the generated instructions include a "Session Hygiene" section that tells the agent to manually run `kirograph sync` at the start and end of each session.

### Multiple Targets

You can install multiple targets in the same project. They all share the same `.kirograph/` graph data:

```bash
kirograph install                      # Auto-detect all platforms and configure them
kirograph install --all                # Same, but skip the confirmation prompt
kirograph install --target cursor      # Install for a specific platform only
kirograph install --target copilot     # Install for another specific platform
```

When run without `--target`, KiroGraph auto-detects which AI coding tools are installed by checking for known config directories and CLI binaries, then offers to configure them all:

```
$ kirograph install

  Detected platforms:

    ✓ Kiro                 (.kiro/ found in project)
    ✓ Claude Code          (claude binary on PATH)
    ✓ Cursor               (.cursor/ found in project)

  Install KiroGraph for all 3 detected platform(s)? [Y/n]
```
