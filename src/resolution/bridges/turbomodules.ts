/**
 * React Native TurboModules Bridge
 *
 * Synthesizes edges between TypeScript TurboModule spec interfaces and their
 * native implementations. TurboModules use codegen specs (Native*.ts files)
 * as the source of truth for the JS ↔ Native contract.
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TurboModuleSpec {
  moduleName: string;
  methods: string[];
  specFilePath: string;
  specNodeId?: string;
}

interface NativeImpl {
  moduleName: string;
  methods: Map<string, string>; // methodName → nodeId
  filePath: string;
}

/**
 * Find TurboModule spec files (Native*.ts) and extract their interfaces.
 */
function findTurboModuleSpecs(context: ResolutionContext): TurboModuleSpec[] {
  const specs: TurboModuleSpec[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    // TurboModule specs follow the naming convention Native*.ts
    const fileName = f.split('/').pop() ?? '';
    if (!fileName.match(/^Native\w+\.(ts|tsx|js)$/)) continue;

    const content = context.readFile(f);
    if (!content) continue;

    // Check for TurboModule interface pattern
    const specMatch = content.match(
      /export\s+interface\s+Spec\s+extends\s+TurboModule\s*\{([^}]*)\}/s
    );
    if (!specMatch) continue;

    // Extract module name from filename: NativeFoo.ts → Foo
    const moduleName = fileName.replace(/^Native/, '').replace(/\.(ts|tsx|js)$/, '');

    // Extract method names from the interface body
    const methods: string[] = [];
    const methodRegex = /(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = methodRegex.exec(specMatch[1])) !== null) {
      methods.push(match[1]);
    }

    // Find the interface node
    const nodes = context.getNodesInFile(f);
    const specNode = nodes.find(
      n => n.kind === 'interface' && n.name === 'Spec'
    );

    specs.push({
      moduleName,
      methods,
      specFilePath: f,
      specNodeId: specNode?.id,
    });
  }

  return specs;
}

/**
 * Find native implementations that match TurboModule specs.
 */
function findNativeImpls(context: ResolutionContext, moduleNames: Set<string>): NativeImpl[] {
  const impls: NativeImpl[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.m') && !f.endsWith('.mm') && !f.endsWith('.swift') &&
        !f.endsWith('.java') && !f.endsWith('.kt')) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    // Try to identify which module this file implements
    let moduleName: string | null = null;

    // ObjC: @implementation RCT<ModuleName> or class name matching
    if (f.endsWith('.m') || f.endsWith('.mm')) {
      const implMatch = content.match(/@implementation\s+(\w+)/);
      if (implMatch) {
        const className = implMatch[1];
        // Try stripping common prefixes
        for (const name of moduleNames) {
          if (className === name || className === `RCT${name}` ||
              className === `${name}Module` || className === `RCT${name}Module`) {
            moduleName = name;
            break;
          }
        }
      }
    }

    // Swift: class that conforms to module name
    if (f.endsWith('.swift')) {
      const classMatch = content.match(/class\s+(\w+)\s*:/);
      if (classMatch) {
        const className = classMatch[1];
        for (const name of moduleNames) {
          if (className === name || className === `${name}Module`) {
            moduleName = name;
            break;
          }
        }
      }
    }

    // Java/Kotlin: class extending ReactContextBaseJavaModule or TurboModule
    if (f.endsWith('.java') || f.endsWith('.kt')) {
      const classMatch = content.match(/class\s+(\w+)\s+(?:extends|:)\s+\w*(?:TurboModule|ReactContextBaseJavaModule)/);
      if (classMatch) {
        const className = classMatch[1];
        for (const name of moduleNames) {
          if (className === name || className === `${name}Module`) {
            moduleName = name;
            break;
          }
        }
      }

      // Also check getName() return value
      const getNameMatch = content.match(/getName\s*\(\s*\)\s*(?::\s*String\s*)?\{[^}]*return\s*"(\w+)"/);
      if (getNameMatch) {
        const returnedName = getNameMatch[1];
        if (moduleNames.has(returnedName)) {
          moduleName = returnedName;
        }
      }
    }

    if (!moduleName) continue;

    // Collect method nodes
    const nodes = context.getNodesInFile(f);
    const methods = new Map<string, string>();
    for (const node of nodes) {
      if (node.kind === 'method' || node.kind === 'function') {
        methods.set(node.name, node.id);
      }
    }

    impls.push({ moduleName, methods, filePath: f });
  }

  return impls;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const turboModulesBridge: BridgeResolver = {
  name: 'turbomodules-bridge',

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles();
    // Check for Native*.ts spec files
    for (const f of files) {
      const fileName = f.split('/').pop() ?? '';
      if (fileName.match(/^Native\w+\.(ts|tsx|js)$/)) {
        const content = context.readFile(f);
        if (content && content.includes('TurboModule')) {
          return true;
        }
      }
    }
    return false;
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    const specs = findTurboModuleSpecs(context);
    if (specs.length === 0) return edges;

    const moduleNames = new Set(specs.map(s => s.moduleName));
    const impls = findNativeImpls(context, moduleNames);

    // Match spec methods to native implementations
    for (const spec of specs) {
      const matchingImpls = impls.filter(i => i.moduleName === spec.moduleName);

      for (const impl of matchingImpls) {
        for (const method of spec.methods) {
          const nativeNodeId = impl.methods.get(method);
          if (!nativeNodeId) continue;

          // Find JS call sites that import and use this module
          const callSites = findCallSitesForModule(context, spec.moduleName, method);

          for (const callSiteId of callSites) {
            edges.push({
              source: callSiteId,
              target: nativeNodeId,
              kind: 'calls',
              confidence: 'inferred',
              confidenceScore: 0.9,
              metadata: {
                synthesizedBy: 'turbomodules-bridge',
                provenance: 'heuristic',
                moduleName: spec.moduleName,
                methodName: method,
                specFile: spec.specFilePath,
              },
            });
          }

          // Also link spec interface to native impl
          if (spec.specNodeId) {
            edges.push({
              source: spec.specNodeId,
              target: nativeNodeId,
              kind: 'references',
              confidence: 'inferred',
              confidenceScore: 0.9,
              metadata: {
                synthesizedBy: 'turbomodules-bridge',
                provenance: 'heuristic',
                moduleName: spec.moduleName,
                methodName: method,
              },
            });
          }
        }
      }
    }

    return edges;
  },
};

/**
 * Find JS/TS call sites that use a specific TurboModule method.
 */
function findCallSitesForModule(
  context: ResolutionContext,
  moduleName: string,
  methodName: string
): string[] {
  const callSiteIds: string[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx') && !f.endsWith('.js') && !f.endsWith('.jsx')) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    // Check if file imports the Native module
    const importPattern = new RegExp(`import\\s+\\w+\\s+from\\s+['"]\\.*/Native${moduleName}['"]`);
    if (!importPattern.test(content)) continue;

    // Find calls to the method
    const callRegex = new RegExp(`\\w+\\.${methodName}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    const nodes = context.getNodesInFile(f);

    while ((match = callRegex.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      const enclosing = nodes.find(
        n => (n.kind === 'function' || n.kind === 'method') &&
             n.startLine <= lineNum && n.endLine >= lineNum
      );
      if (enclosing && !callSiteIds.includes(enclosing.id)) {
        callSiteIds.push(enclosing.id);
      }
    }
  }

  return callSiteIds;
}
