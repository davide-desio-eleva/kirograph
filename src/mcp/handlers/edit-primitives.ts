import * as fs from 'fs';
import * as path from 'path';
import KiroGraph from '../../index';

/** Read a file relative to projectRoot, validate it exists and is within root. */
function readProjectFile(cg: KiroGraph, filePath: string): { absPath: string; content: string } | { error: string } {
  const root = cg.getProjectRoot();
  const absPath = path.resolve(root, filePath);
  if (!absPath.startsWith(root + path.sep) && absPath !== root) return { error: `Path "${filePath}" is outside the project root.` };
  if (!fs.existsSync(absPath)) return { error: `File not found: ${filePath}` };
  return { absPath, content: fs.readFileSync(absPath, 'utf8') };
}

async function writeAndSync(cg: KiroGraph, absPath: string, content: string): Promise<string> {
  fs.writeFileSync(absPath, content, 'utf8');
  const root = cg.getProjectRoot();
  const rel = path.relative(root, absPath);
  try { await cg.sync([rel]); } catch { /* non-critical — index will catch up on next sync */ }
  return rel;
}

export async function handleEditPrimitives(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_refactor': {
      const { renamePreview, suggestRefactorings } = await import('../../graph/refactor');
      const db = cg.getDatabase();
      const mode = args.mode as string;

      if (mode === 'rename') {
        if (!args.symbol) return 'Error: "symbol" parameter is required for rename mode.';
        const preview = renamePreview(db, args.symbol as string);
        if (!preview) return `Symbol "${args.symbol}" not found in index.`;

        const lines = [
          `## Rename Preview: \`${preview.symbol}\``,
          `Kind: ${preview.kind}`,
          `Defined at: ${preview.filePath}:${preview.line}`,
          `Total references: ${preview.totalReferences}`,
          '',
        ];

        if (preview.references.length === 0) {
          lines.push('No references found — this symbol can be safely renamed without affecting other code.');
        } else {
          // Group by file
          const byFile = new Map<string, typeof preview.references>();
          for (const ref of preview.references) {
            if (!byFile.has(ref.filePath)) byFile.set(ref.filePath, []);
            byFile.get(ref.filePath)!.push(ref);
          }

          for (const [file, refs] of byFile) {
            lines.push(`### ${file} (${refs.length} references)`);
            for (const ref of refs.slice(0, 10)) {
              lines.push(`- Line ${ref.line}: \`${ref.context}\` (${ref.edgeKind})`);
            }
            if (refs.length > 10) lines.push(`  …and ${refs.length - 10} more`);
            lines.push('');
          }
        }

        return lines.join('\n');
      }

      if (mode === 'suggest') {
        const suggestions = suggestRefactorings(db, (args.limit as number) ?? 10);
        if (suggestions.length === 0) return 'No refactoring suggestions — the codebase structure looks clean.';

        const lines = [`## Refactoring Suggestions (${suggestions.length})`, ''];
        for (const s of suggestions) {
          const icon = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢';
          lines.push(`${icon} **${s.type}** [${s.priority}]: ${s.description}`);
          lines.push(`   Rationale: ${s.rationale}`);
          if (s.symbols.length > 0) {
            lines.push(`   Symbols: ${s.symbols.slice(0, 3).join(', ')}`);
          }
          lines.push('');
        }

        return lines.join('\n');
      }

      return 'Unknown mode. Use "rename" or "suggest".';
    }

    case 'kirograph_str_replace': {
      const file = args.file as string;
      const oldStr = args.old_str as string;
      const newStr = args.new_str as string;
      const result = readProjectFile(cg, file);
      if ('error' in result) return result.error;
      const { absPath, content } = result;
      const count = content.split(oldStr).length - 1;
      if (count === 0) return `No match found for the given old_str in "${file}". Nothing changed.`;
      if (count > 1) return `Found ${count} matches for old_str in "${file}" — replacement would be ambiguous. Provide more context to make it unique.`;
      const updated = content.replace(oldStr, newStr);
      const rel = await writeAndSync(cg, absPath, updated);
      return `Replaced 1 occurrence in ${rel}.`;
    }

    case 'kirograph_multi_str_replace': {
      const file = args.file as string;
      const pairs = args.pairs as Array<{ old_str: string; new_str: string }>;
      if (!Array.isArray(pairs) || pairs.length === 0) return 'Error: "pairs" must be a non-empty array of {old_str, new_str} objects.';
      const result = readProjectFile(cg, file);
      if ('error' in result) return result.error;
      const { absPath } = result;
      let content = result.content;
      // Validate all replacements before applying any (all-or-nothing)
      for (let i = 0; i < pairs.length; i++) {
        const { old_str } = pairs[i];
        const count = content.split(old_str).length - 1;
        if (count === 0) return `Pair ${i + 1}: no match found for old_str. Transaction aborted, no changes made.`;
        if (count > 1) return `Pair ${i + 1}: found ${count} matches for old_str — ambiguous. Transaction aborted, no changes made.`;
      }
      for (const { old_str, new_str } of pairs) content = content.replace(old_str, new_str);
      const rel = await writeAndSync(cg, absPath, content);
      return `Applied ${pairs.length} replacement(s) in ${rel}.`;
    }

    case 'kirograph_insert_at': {
      const file = args.file as string;
      const anchor = args.anchor as string | undefined;
      const lineNum = args.line as number | undefined;
      const insertContent = args.content as string;
      const position = (args.position as string) ?? 'after';
      const result = readProjectFile(cg, file);
      if ('error' in result) return result.error;
      const { absPath, content } = result;
      let updated: string;
      if (lineNum !== undefined) {
        const lines = content.split('\n');
        const idx = lineNum - 1;
        if (idx < 0 || idx > lines.length) return `Line ${lineNum} is out of range (file has ${lines.length} lines).`;
        const insertIdx = position === 'before' ? idx : idx + 1;
        lines.splice(insertIdx, 0, insertContent);
        updated = lines.join('\n');
      } else if (anchor !== undefined) {
        const idx = content.indexOf(anchor);
        if (idx === -1) return `Anchor not found in "${file}". Nothing changed.`;
        if (content.indexOf(anchor, idx + 1) !== -1) return `Anchor appears more than once in "${file}" — ambiguous. Provide a more unique anchor.`;
        const insertPos = position === 'before' ? idx : idx + anchor.length;
        updated = content.slice(0, insertPos) + insertContent + content.slice(insertPos);
      } else {
        return 'Error: either "anchor" or "line" parameter is required.';
      }
      const rel = await writeAndSync(cg, absPath, updated);
      return `Inserted content in ${rel} (${position} ${anchor ? `"${anchor}"` : `line ${lineNum}`}).`;
    }

    case 'kirograph_ast_grep_rewrite': {
      const { execSync } = await import('child_process');
      // Check ast-grep is available
      try { execSync('which ast-grep', { stdio: 'ignore' }); } catch {
        return 'ast-grep is not installed or not on PATH. Install it (https://ast-grep.github.io/) to use this tool.';
      }
      const file = args.file as string;
      const pattern = args.pattern as string;
      const rewrite = args.rewrite as string;
      const result = readProjectFile(cg, file);
      if ('error' in result) return result.error;
      const { absPath } = result;
      try {
        const output = execSync(
          `ast-grep --pattern ${JSON.stringify(pattern)} --rewrite ${JSON.stringify(rewrite)} --update-all ${JSON.stringify(absPath)}`,
          { encoding: 'utf8', cwd: cg.getProjectRoot() }
        );
        await writeAndSync(cg, absPath, fs.readFileSync(absPath, 'utf8'));
        return `ast-grep rewrite applied to ${file}.\n${output.trim()}`;
      } catch (err: any) {
        return `ast-grep error: ${err.message ?? String(err)}`;
      }
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
