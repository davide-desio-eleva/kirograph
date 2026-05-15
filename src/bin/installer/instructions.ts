import { CAVEMAN_RULES, CavemanMode } from './caveman';

export function buildAgentInstructions(cavemanMode?: CavemanMode | 'off'): string {
  const content = `# KiroGraph

KiroGraph builds a local semantic knowledge graph of this codebase. When the \`kirograph\` MCP server is available, prefer its tools over broad grep/glob/file-read exploration.

## Tool selection

- Start code tasks with \`kirograph_context\`.
- Find symbols by name with \`kirograph_search\`.
- Inspect a symbol with \`kirograph_node\`; set \`includeCode: true\` only when source is needed.
- Trace call flow with \`kirograph_callers\` and \`kirograph_callees\`.
- Check blast radius before edits with \`kirograph_impact\`.
- Use \`kirograph_path\` to explain how two symbols connect.
- Use \`kirograph_type_hierarchy\` for inheritance/interface questions.
- Use \`kirograph_files\` to inspect indexed file structure.
- Use \`kirograph_status\` if results seem stale or incomplete.
- Use \`kirograph_architecture\`, \`kirograph_coupling\`, and \`kirograph_package\` for package/layer questions when architecture analysis is enabled.
- Use \`kirograph_hotspots\`, \`kirograph_surprising\`, and \`kirograph_diff\` for refactor planning and review.

## Workflow

1. Call \`kirograph_context\` for orientation.
2. Drill into specific symbols with \`kirograph_node\`.
3. Use graph traversal tools before reading unrelated files.
4. Fall back to normal filesystem tools only when the graph is missing, stale, or lacks the needed detail.

If \`.kirograph/\` does not exist, ask whether to run \`kirograph init --index\`.
`;

  const caveman = cavemanMode && cavemanMode !== 'off' ? CAVEMAN_RULES[cavemanMode] : null;
  return caveman ? content.trimEnd() + '\n\n' + caveman + '\n' : content;
}

