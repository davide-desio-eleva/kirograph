/**
 * React Native Legacy Bridge
 *
 * Synthesizes edges between JavaScript/TypeScript calls to NativeModules.X.method()
 * and native implementations declared via RCT_EXPORT_METHOD (ObjC) or @ReactMethod (Java/Kotlin).
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface NativeModuleCall {
  moduleName: string;
  methodName: string;
  callerNodeId: string;
}

interface NativeMethodDecl {
  moduleName: string;
  methodName: string;
  nodeId: string;
  language: 'objc' | 'java' | 'kotlin';
}

/**
 * Scan JS/TS files for NativeModules.X.method() call patterns.
 */
function findNativeModuleCalls(context: ResolutionContext): NativeModuleCall[] {
  const calls: NativeModuleCall[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx') && !f.endsWith('.js') && !f.endsWith('.jsx')) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    // Match NativeModules.ModuleName.methodName patterns
    const nativeModuleRegex = /NativeModules\.(\w+)\.(\w+)\s*\(/g;
    let match: RegExpExecArray | null;

    const nodes = context.getNodesInFile(f);

    while ((match = nativeModuleRegex.exec(content)) !== null) {
      const moduleName = match[1];
      const methodName = match[2];
      const lineNum = content.slice(0, match.index).split('\n').length;

      // Find enclosing function/method
      const enclosing = nodes.find(
        n => (n.kind === 'function' || n.kind === 'method') &&
             n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        calls.push({ moduleName, methodName, callerNodeId: enclosing.id });
      }
    }
  }

  return calls;
}

/**
 * Scan native files for RCT_EXPORT_METHOD / @ReactMethod declarations.
 */
function findNativeMethodDecls(context: ResolutionContext): NativeMethodDecl[] {
  const decls: NativeMethodDecl[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    // ObjC files
    if (f.endsWith('.m') || f.endsWith('.mm')) {
      const content = context.readFile(f);
      if (!content) continue;

      // Extract module name from RCT_EXPORT_MODULE(Name)
      const moduleMatch = content.match(/RCT_EXPORT_MODULE\((\w*)\)/);
      // Also try class name pattern: @implementation RCTModuleName
      const implMatch = content.match(/@implementation\s+(\w+)/);

      let moduleName = moduleMatch?.[1] || '';
      if (!moduleName && implMatch) {
        // Strip RCT prefix for module name
        moduleName = implMatch[1].replace(/^RCT/, '');
      }

      if (!moduleName) continue;

      // Find RCT_EXPORT_METHOD declarations
      const methodRegex = /RCT_EXPORT_METHOD\((\w+)/g;
      let methodMatch: RegExpExecArray | null;
      const nodes = context.getNodesInFile(f);

      while ((methodMatch = methodRegex.exec(content)) !== null) {
        const methodName = methodMatch[1];
        const lineNum = content.slice(0, methodMatch.index).split('\n').length;

        // Find the node for this method
        const methodNode = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               (n.name === methodName || n.name.startsWith(methodName)) &&
               Math.abs(n.startLine - lineNum) < 5
        );

        if (methodNode) {
          decls.push({ moduleName, methodName, nodeId: methodNode.id, language: 'objc' });
        }
      }

      // Also check RCT_REMAP_METHOD
      const remapRegex = /RCT_REMAP_METHOD\((\w+)\s*,\s*(\w+)/g;
      let remapMatch: RegExpExecArray | null;
      while ((remapMatch = remapRegex.exec(content)) !== null) {
        const jsMethodName = remapMatch[1];
        const lineNum = content.slice(0, remapMatch.index).split('\n').length;

        const methodNode = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               Math.abs(n.startLine - lineNum) < 5
        );

        if (methodNode) {
          decls.push({ moduleName, methodName: jsMethodName, nodeId: methodNode.id, language: 'objc' });
        }
      }
    }

    // Java/Kotlin files
    if (f.endsWith('.java') || f.endsWith('.kt')) {
      const content = context.readFile(f);
      if (!content) continue;

      // Extract module name from getName() method
      const getNameMatch = content.match(/getName\s*\(\s*\)\s*\{[^}]*return\s*"(\w+)"/);
      // Also try class name
      const classMatch = content.match(/class\s+(\w+Module)\b/);

      let moduleName = getNameMatch?.[1] || '';
      if (!moduleName && classMatch) {
        moduleName = classMatch[1].replace(/Module$/, '');
      }

      if (!moduleName) continue;

      // Find @ReactMethod annotated methods
      const reactMethodRegex = /@ReactMethod[\s\S]*?(?:fun|void|public)\s+(\w+)\s*\(/g;
      let methodMatch: RegExpExecArray | null;
      const nodes = context.getNodesInFile(f);

      while ((methodMatch = reactMethodRegex.exec(content)) !== null) {
        const methodName = methodMatch[1];
        const lineNum = content.slice(0, methodMatch.index).split('\n').length;

        const methodNode = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               n.name === methodName &&
               Math.abs(n.startLine - lineNum) < 5
        );

        if (methodNode) {
          decls.push({ moduleName, methodName, nodeId: methodNode.id, language: 'java' });
        }
      }
    }
  }

  return decls;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const reactNativeLegacyBridge: BridgeResolver = {
  name: 'react-native-legacy-bridge',

  detect(context: ResolutionContext): boolean {
    // Check for react-native in package.json
    const packageJson = context.readFile('package.json');
    if (!packageJson) return false;

    try {
      const pkg = JSON.parse(packageJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return 'react-native' in deps;
    } catch {
      return false;
    }
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    const calls = findNativeModuleCalls(context);
    const decls = findNativeMethodDecls(context);

    // Match calls to declarations by module name + method name
    for (const call of calls) {
      for (const decl of decls) {
        if (call.moduleName === decl.moduleName && call.methodName === decl.methodName) {
          edges.push({
            source: call.callerNodeId,
            target: decl.nodeId,
            kind: 'calls',
            confidence: 'inferred',
            confidenceScore: 0.85,
            metadata: {
              synthesizedBy: 'react-native-legacy-bridge',
              provenance: 'heuristic',
              moduleName: call.moduleName,
              methodName: call.methodName,
              nativeLanguage: decl.language,
            },
          });
        }
      }
    }

    return edges;
  },
};
