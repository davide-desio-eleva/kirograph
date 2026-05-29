/**
 * Android React Native Bridge
 *
 * Synthesizes edges between JavaScript/TypeScript calls to NativeModules.X.method()
 * (and NativeEventEmitter) and their Kotlin/Java implementations declared via
 * @ReactMethod or @ReactProp in classes extending ReactContextBaseJavaModule.
 *
 * Covers the Android/Kotlin/Java side of the React Native bridge, closing the
 * gap with the iOS/ObjC coverage provided by react-native-legacy-bridge.
 */

import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AndroidNativeModuleCall {
  moduleName: string;
  methodName: string;
  callerNodeId: string;
  via: 'NativeModules' | 'NativeEventEmitter';
}

interface AndroidReactMethodDecl {
  moduleName: string;
  methodName: string;
  nodeId: string;
  isBlocking: boolean;
  filePath: string;
}

interface AndroidReactPropDecl {
  moduleName: string;
  propName: string;
  nodeId: string;
  filePath: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect Android project root presence by checking for android/ directory
 * marker files or Kotlin/Java files that import react-native packages.
 */
function hasAndroidNativeFiles(context: ResolutionContext): boolean {
  const files = context.getAllFiles();
  for (const f of files) {
    if (!f.endsWith('.kt') && !f.endsWith('.java')) continue;
    const content = context.readFile(f);
    if (!content) continue;
    if (
      content.includes('ReactContextBaseJavaModule') ||
      content.includes('@ReactMethod') ||
      content.includes('@ReactProp')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the module name exposed to JS from a Kotlin/Java native module file.
 *
 * Priority:
 *   1. Explicit string in getName() return: `return "ModuleName"`
 *   2. Class name stripping common suffixes (Module, Manager)
 */
function extractModuleName(content: string, filePath: string): string | null {
  // Kotlin: override fun getName() = "Name" or fun getName(): String { return "Name" }
  const ktSingleLine = content.match(/override\s+fun\s+getName\s*\(\s*\)\s*=\s*"(\w+)"/);
  if (ktSingleLine) return ktSingleLine[1];

  // Java/Kotlin block-style getName()
  const blockStyle = content.match(
    /(?:override\s+)?fun\s+getName\s*\(\s*\)\s*(?::\s*String\s*)?\{[^}]*?return\s*"(\w+)"/s
  );
  if (blockStyle) return blockStyle[1];

  // Java getName()
  const javaStyle = content.match(
    /(?:@Override\s+)?(?:public\s+)?String\s+getName\s*\(\s*\)\s*\{[^}]*?return\s*"(\w+)"/s
  );
  if (javaStyle) return javaStyle[1];

  // Fallback: derive from class name
  const classMatch = content.match(/class\s+(\w+)/);
  if (classMatch) {
    return classMatch[1]
      .replace(/Module$/, '')
      .replace(/Manager$/, '')
      .replace(/Package$/, '') || null;
  }

  return null;
}

/**
 * Scan all Kotlin/Java files for @ReactMethod annotations and collect the
 * corresponding method declarations with their graph node IDs.
 */
function findReactMethodDecls(context: ResolutionContext): AndroidReactMethodDecl[] {
  const decls: AndroidReactMethodDecl[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.kt') && !f.endsWith('.java')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    // Only process files that are React Native modules
    if (
      !content.includes('ReactContextBaseJavaModule') &&
      !content.includes('ReactMethod')
    ) {
      continue;
    }

    const moduleName = extractModuleName(content, f);
    if (!moduleName) continue;

    const nodes = context.getNodesInFile(f);

    // Match @ReactMethod (and @ReactMethod(isBlockingSynchronousMethod = true))
    // followed by fun/void/public <methodName>(
    const reactMethodRegex =
      /@ReactMethod(?:\s*\(\s*isBlockingSynchronousMethod\s*=\s*(true|false)\s*\))?\s*\n?\s*(?:@\w+\s*)*(?:fun|public\s+\w+)\s+(\w+)\s*\(/g;

    let match: RegExpExecArray | null;
    while ((match = reactMethodRegex.exec(content)) !== null) {
      const isBlocking = match[1] === 'true';
      const methodName = match[2];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const methodNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function') &&
          n.name === methodName &&
          Math.abs(n.startLine - lineNum) < 8
      );

      if (methodNode) {
        decls.push({
          moduleName,
          methodName,
          nodeId: methodNode.id,
          isBlocking,
          filePath: f,
        });
      }
    }
  }

  return decls;
}

/**
 * Scan Kotlin/Java ViewManager files for @ReactProp annotations and collect
 * the corresponding setter method declarations.
 */
function findReactPropDecls(context: ResolutionContext): AndroidReactPropDecl[] {
  const decls: AndroidReactPropDecl[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.kt') && !f.endsWith('.java')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    if (!content.includes('@ReactProp')) continue;

    const moduleName = extractModuleName(content, f);
    if (!moduleName) continue;

    const nodes = context.getNodesInFile(f);

    // @ReactProp(name = "propName") followed by fun/void setPropName(...)
    const reactPropRegex =
      /@ReactProp\s*\(\s*name\s*=\s*"(\w+)"[^)]*\)\s*\n?\s*(?:@\w+\s*)*(?:fun|public\s+void)\s+(\w+)\s*\(/g;

    let match: RegExpExecArray | null;
    while ((match = reactPropRegex.exec(content)) !== null) {
      const propName = match[1];
      const setterName = match[2];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const methodNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function') &&
          n.name === setterName &&
          Math.abs(n.startLine - lineNum) < 8
      );

      if (methodNode) {
        decls.push({ moduleName, propName, nodeId: methodNode.id, filePath: f });
      }
    }
  }

  return decls;
}

/**
 * Scan JS/TS files for:
 *   - NativeModules.ModuleName.methodName(...)
 *   - const { ModuleName } = NativeModules; ... ModuleName.methodName(...)
 *   - new NativeEventEmitter(NativeModules.ModuleName)
 */
function findAndroidNativeModuleCalls(context: ResolutionContext): AndroidNativeModuleCall[] {
  const calls: AndroidNativeModuleCall[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (
      !f.endsWith('.ts') &&
      !f.endsWith('.tsx') &&
      !f.endsWith('.js') &&
      !f.endsWith('.jsx')
    ) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    // Skip if no NativeModules reference at all
    if (!content.includes('NativeModules')) continue;

    const nodes = context.getNodesInFile(f);

    /**
     * Helper: find the enclosing function/method node for a character offset.
     */
    const enclosingNode = (offset: number) => {
      const lineNum = content.slice(0, offset).split('\n').length;
      return nodes.find(
        n =>
          (n.kind === 'function' || n.kind === 'method') &&
          n.startLine <= lineNum &&
          n.endLine >= lineNum
      );
    };

    // 1. Direct: NativeModules.ModuleName.methodName(
    const directRegex = /NativeModules\.(\w+)\.(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = directRegex.exec(content)) !== null) {
      const moduleName = match[1];
      const methodName = match[2];
      const caller = enclosingNode(match.index);
      if (caller) {
        calls.push({ moduleName, methodName, callerNodeId: caller.id, via: 'NativeModules' });
      }
    }

    // 2. Destructured: const { ModuleName } = NativeModules (then ModuleName.method)
    const destructureRegex = /const\s*\{([^}]+)\}\s*=\s*NativeModules/g;
    while ((match = destructureRegex.exec(content)) !== null) {
      const moduleNames = match[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      for (const moduleName of moduleNames) {
        // Find all calls to moduleName.methodName(
        const callRegex = new RegExp(`\\b${moduleName}\\.(\\w+)\\s*\\(`, 'g');
        let callMatch: RegExpExecArray | null;
        while ((callMatch = callRegex.exec(content)) !== null) {
          const methodName = callMatch[1];
          const caller = enclosingNode(callMatch.index);
          if (caller) {
            calls.push({
              moduleName,
              methodName,
              callerNodeId: caller.id,
              via: 'NativeModules',
            });
          }
        }
      }
    }

    // 3. NativeEventEmitter usage: new NativeEventEmitter(NativeModules.ModuleName)
    const emitterRegex = /new\s+NativeEventEmitter\s*\(\s*NativeModules\.(\w+)\s*\)/g;
    while ((match = emitterRegex.exec(content)) !== null) {
      const moduleName = match[1];
      const caller = enclosingNode(match.index);
      if (caller) {
        // Synthesize a synthetic "attach" method call to represent the binding
        calls.push({
          moduleName,
          methodName: '__eventEmitterAttach__',
          callerNodeId: caller.id,
          via: 'NativeEventEmitter',
        });
      }
    }
  }

  return calls;
}

/**
 * Scan JS/TS files for JSX prop usages that match @ReactProp names.
 * e.g. <MyView color="red" /> → color prop setter in ViewManager
 *
 * Returns a map of propName → callerNodeId[]
 */
function findJsxPropUsages(
  context: ResolutionContext,
  propNames: Set<string>
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.tsx') && !f.endsWith('.jsx')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    const nodes = context.getNodesInFile(f);

    for (const propName of propNames) {
      // Match JSX attribute: propName={...} or propName="..."
      const attrRegex = new RegExp(`\\b${propName}\\s*=\\s*(?:\\{|")`, 'g');
      let match: RegExpExecArray | null;
      while ((match = attrRegex.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        const enclosing = nodes.find(
          n =>
            (n.kind === 'function' || n.kind === 'method') &&
            n.startLine <= lineNum &&
            n.endLine >= lineNum
        );
        if (enclosing) {
          const existing = result.get(propName) ?? [];
          if (!existing.includes(enclosing.id)) {
            existing.push(enclosing.id);
          }
          result.set(propName, existing);
        }
      }
    }
  }

  return result;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const androidRnBridge: BridgeResolver = {
  name: 'android-rn-bridge',

  detect(context: ResolutionContext): boolean {
    // Must be a React Native project
    const packageJson = context.readFile('package.json');
    if (!packageJson) return false;

    try {
      const pkg = JSON.parse(packageJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!('react-native' in deps)) return false;
    } catch {
      return false;
    }

    // Must have Android native files with RN annotations
    return hasAndroidNativeFiles(context);
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    // ── 1. @ReactMethod edges ────────────────────────────────────────────────

    const methodDecls = findReactMethodDecls(context);
    const jsCalls = findAndroidNativeModuleCalls(context);

    for (const call of jsCalls) {
      // NativeEventEmitter attach — skip method matching, handled below
      if (call.via === 'NativeEventEmitter') continue;

      for (const decl of methodDecls) {
        if (call.moduleName === decl.moduleName && call.methodName === decl.methodName) {
          edges.push({
            source: call.callerNodeId,
            target: decl.nodeId,
            kind: 'calls',
            confidence: 'inferred',
            confidenceScore: decl.isBlocking ? 0.75 : 0.7,
            metadata: {
              synthesizedBy: 'android-rn-bridge',
              provenance: 'heuristic',
              moduleName: call.moduleName,
              methodName: call.methodName,
              nativeLanguage: decl.filePath.endsWith('.kt') ? 'kotlin' : 'java',
              isBlockingSynchronousMethod: decl.isBlocking,
            },
          });
        }
      }
    }

    // ── 2. NativeEventEmitter → module edges ────────────────────────────────
    //    Synthesize a "references" edge from the JS emitter attachment to the
    //    module class node so the call graph surfaces the Android ↔ JS binding.

    const emitterCalls = jsCalls.filter(c => c.via === 'NativeEventEmitter');
    for (const call of emitterCalls) {
      // Find any @ReactMethod in the referenced module as a representative target
      const moduleDecls = methodDecls.filter(d => d.moduleName === call.moduleName);
      for (const decl of moduleDecls) {
        edges.push({
          source: call.callerNodeId,
          target: decl.nodeId,
          kind: 'references',
          confidence: 'inferred',
          confidenceScore: 0.65,
          metadata: {
            synthesizedBy: 'android-rn-bridge',
            provenance: 'heuristic',
            moduleName: call.moduleName,
            via: 'NativeEventEmitter',
            nativeLanguage: decl.filePath.endsWith('.kt') ? 'kotlin' : 'java',
          },
        });
        // Only one representative edge per emitter attachment
        break;
      }
    }

    // ── 3. @ReactProp edges ──────────────────────────────────────────────────

    const propDecls = findReactPropDecls(context);
    if (propDecls.length > 0) {
      const propNameSet = new Set(propDecls.map(p => p.propName));
      const jsxUsages = findJsxPropUsages(context, propNameSet);

      for (const propDecl of propDecls) {
        const callerIds = jsxUsages.get(propDecl.propName) ?? [];
        for (const callerId of callerIds) {
          edges.push({
            source: callerId,
            target: propDecl.nodeId,
            kind: 'references',
            confidence: 'inferred',
            confidenceScore: 0.7,
            metadata: {
              synthesizedBy: 'android-rn-bridge',
              provenance: 'heuristic',
              moduleName: propDecl.moduleName,
              propName: propDecl.propName,
              nativeLanguage: propDecl.filePath.endsWith('.kt') ? 'kotlin' : 'java',
            },
          });
        }
      }
    }

    return edges;
  },
};
