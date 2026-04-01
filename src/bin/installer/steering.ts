/**
 * KiroGraph Installer — Kiro steering file
 */

import * as fs from 'fs';
import * as path from 'path';

const STEERING_CONTENT = `---
inclusion: always
---

# KiroGraph

KiroGraph builds a semantic knowledge graph of your codebase for faster, smarter code exploration.

## When \`.kirograph/\` exists in the project

Use KiroGraph MCP tools for exploration instead of grep/glob/file reads:

| Tool | Use For |
|------|---------|
| \`kirograph_search\` | Find symbols by name (functions, classes, types) |
| \`kirograph_context\` | Get relevant code context for a task — **start here** |
| \`kirograph_callers\` | Find what calls a function |
| \`kirograph_callees\` | Find what a function calls |
| \`kirograph_impact\` | See what's affected by changing a symbol |
| \`kirograph_node\` | Get details + source code for a symbol |
| \`kirograph_status\` | Check index health and statistics |
| \`kirograph_files\` | List the indexed file structure |
| \`kirograph_dead_code\` | Find symbols with no incoming references |
| \`kirograph_circular_deps\` | Detect circular import dependencies |
| \`kirograph_path\` | Find the shortest path between two symbols |
| \`kirograph_type_hierarchy\` | Traverse class/interface inheritance |

### Workflow

1. Start with \`kirograph_context\` for any task — it returns entry points and related code in one call.
2. Use \`kirograph_search\` instead of grep for finding symbols.
3. Use \`kirograph_callers\`/\`kirograph_callees\` to trace code flow.
4. Use \`kirograph_impact\` before making changes to understand blast radius.
5. Use \`kirograph_files\` to explore the project structure.
6. Use \`kirograph_dead_code\` to identify unused code before refactoring.

### If \`.kirograph/\` does NOT exist

Ask the user: "This project doesn't have KiroGraph initialized. Run \`kirograph init -i\` to build a code knowledge graph for faster exploration?"
`;

export function writeSteering(kiroDir: string): void {
  const steeringDir = path.join(kiroDir, 'steering');
  fs.mkdirSync(steeringDir, { recursive: true });
  const steeringPath = path.join(steeringDir, 'kirograph.md');
  fs.writeFileSync(steeringPath, STEERING_CONTENT);
  console.log(`  ✓ Steering file written to ${steeringPath}`);
}
