/**
 * Expo Modules Bridge
 *
 * Synthesizes edges between JavaScript calls to requireNativeModule('X').fn()
 * and Swift/Kotlin module definitions using the Expo Modules DSL:
 *   Module { Name("X"); AsyncFunction("fn") { ... } }
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ExpoModuleDecl {
  moduleName: string;
  functions: Map<string, string>; // functionName → nodeId
  filePath: string;
}

interface ExpoModuleCall {
  moduleName: string;
  functionName: string;
  callerNodeId: string;
}

/**
 * Find Expo module definitions in Swift/Kotlin files.
 * Parses the Expo DSL: Module { Name("X"); Function("fn") { ... } }
 */
function findExpoModuleDecls(context: ResolutionContext): ExpoModuleDecl[] {
  const decls: ExpoModuleDecl[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.swift') && !f.endsWith('.kt')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    // Look for Expo Module DSL pattern
    // Swift: public class MyModule: Module { ... }
    // or: Module { Name("ModuleName") ... }
    const nameMatch = content.match(/Name\s*\(\s*"(\w+)"\s*\)/);
    if (!nameMatch) continue;

    const moduleName = nameMatch[1];
    const functions = new Map<string, string>();
    const nodes = context.getNodesInFile(f);

    // Find function declarations in the DSL
    // Patterns: Function("name"), AsyncFunction("name"), Property("name")
    const funcRegex = /(?:Async)?Function\s*\(\s*"(\w+)"\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(content)) !== null) {
      const funcName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      // Find the closest node to this declaration
      const closestNode = nodes.find(
        n => (n.kind === 'method' || n.kind === 'function') &&
             Math.abs(n.startLine - lineNum) < 10
      );

      if (closestNode) {
        functions.set(funcName, closestNode.id);
      }
    }

    // Also look for Property declarations
    const propRegex = /Property\s*\(\s*"(\w+)"\s*\)/g;
    while ((match = propRegex.exec(content)) !== null) {
      const propName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const closestNode = nodes.find(
        n => (n.kind === 'property' || n.kind === 'method') &&
             Math.abs(n.startLine - lineNum) < 10
      );

      if (closestNode) {
        functions.set(propName, closestNode.id);
      }
    }

    if (functions.size > 0) {
      decls.push({ moduleName, functions, filePath: f });
    }
  }

  return decls;
}

/**
 * Find JS/TS calls to requireNativeModule('X').fn() or useModule patterns.
 */
function findExpoModuleCalls(context: ResolutionContext): ExpoModuleCall[] {
  const calls: ExpoModuleCall[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx') && !f.endsWith('.js') && !f.endsWith('.jsx')) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    const nodes = context.getNodesInFile(f);

    // Pattern 1: requireNativeModule('ModuleName').methodName(...)
    const requireRegex = /requireNativeModule\s*\(\s*['"](\w+)['"]\s*\)\.(\w+)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = requireRegex.exec(content)) !== null) {
      const moduleName = match[1];
      const functionName = match[2];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const enclosing = nodes.find(
        n => (n.kind === 'function' || n.kind === 'method') &&
             n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        calls.push({ moduleName, functionName, callerNodeId: enclosing.id });
      }
    }

    // Pattern 2: const module = requireNativeModule('X'); module.fn()
    const assignRegex = /(?:const|let|var)\s+(\w+)\s*=\s*requireNativeModule\s*\(\s*['"](\w+)['"]\s*\)/g;
    while ((match = assignRegex.exec(content)) !== null) {
      const varName = match[1];
      const moduleName = match[2];

      // Find calls on this variable
      const callOnVarRegex = new RegExp(`${varName}\\.(\\w+)\\s*\\(`, 'g');
      let callMatch: RegExpExecArray | null;

      while ((callMatch = callOnVarRegex.exec(content)) !== null) {
        const functionName = callMatch[1];
        const lineNum = content.slice(0, callMatch.index).split('\n').length;

        const enclosing = nodes.find(
          n => (n.kind === 'function' || n.kind === 'method') &&
               n.startLine <= lineNum && n.endLine >= lineNum
        );

        if (enclosing) {
          calls.push({ moduleName, functionName, callerNodeId: enclosing.id });
        }
      }
    }
  }

  return calls;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const expoModulesBridge: BridgeResolver = {
  name: 'expo-modules-bridge',

  detect(context: ResolutionContext): boolean {
    // Check for expo-modules-core in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if ('expo-modules-core' in deps || 'expo' in deps) return true;
      } catch {
        // ignore parse errors
      }
    }

    // Check for expo-module.config.json
    if (context.fileExists('expo-module.config.json')) return true;

    // Check in subdirectories
    const files = context.getAllFiles();
    return files.some(f => f.endsWith('expo-module.config.json'));
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    const decls = findExpoModuleDecls(context);
    const calls = findExpoModuleCalls(context);

    // Match calls to declarations
    for (const call of calls) {
      for (const decl of decls) {
        if (call.moduleName !== decl.moduleName) continue;

        const targetNodeId = decl.functions.get(call.functionName);
        if (!targetNodeId) continue;

        edges.push({
          source: call.callerNodeId,
          target: targetNodeId,
          kind: 'calls',
          confidence: 'inferred',
          confidenceScore: 0.9,
          metadata: {
            synthesizedBy: 'expo-modules-bridge',
            provenance: 'heuristic',
            moduleName: call.moduleName,
            functionName: call.functionName,
          },
        });
      }
    }

    return edges;
  },
};
