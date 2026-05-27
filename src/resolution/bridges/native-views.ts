/**
 * Fabric/Paper Native Views Bridge
 *
 * Synthesizes edges between JSX usage of native components (<MyView />)
 * and their native view manager implementations. Uses convention-based
 * name + suffix lookup to match components to their native counterparts.
 *
 * Conventions:
 *   <MyView /> → MyViewManager, MyViewComponentView, RCTMyViewManager
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface NativeViewUsage {
  componentName: string;
  usageNodeId: string;
  filePath: string;
}

interface NativeViewManager {
  componentName: string; // The base component name (without Manager suffix)
  nodeId: string;
  filePath: string;
  className: string;
}

/**
 * Common suffixes for native view manager classes.
 */
const VIEW_MANAGER_SUFFIXES = [
  'Manager',
  'ViewManager',
  'ComponentView',
  'NativeComponent',
];

/**
 * Common prefixes for native view manager classes.
 */
const VIEW_MANAGER_PREFIXES = ['RCT', ''];

/**
 * Find JSX usages of native components in JS/TS files.
 * Native components are typically PascalCase and imported from native modules.
 */
function findNativeViewUsages(context: ResolutionContext): NativeViewUsage[] {
  const usages: NativeViewUsage[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.tsx') && !f.endsWith('.jsx')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    const nodes = context.getNodesInFile(f);

    // Look for requireNativeComponent('ComponentName') patterns
    const requireNativeRegex = /requireNativeComponent\s*(?:<[^>]*>)?\s*\(\s*['"](\w+)['"]\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = requireNativeRegex.exec(content)) !== null) {
      const componentName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      // Find enclosing node or file-level node
      const enclosing = nodes.find(
        n => n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        usages.push({ componentName, usageNodeId: enclosing.id, filePath: f });
      }
    }

    // Look for codegenNativeComponent('ComponentName') patterns (Fabric)
    const codegenRegex = /codegenNativeComponent\s*(?:<[^>]*>)?\s*\(\s*['"](\w+)['"]\s*\)/g;
    while ((match = codegenRegex.exec(content)) !== null) {
      const componentName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const enclosing = nodes.find(
        n => n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        usages.push({ componentName, usageNodeId: enclosing.id, filePath: f });
      }
    }

    // Look for UIManager.getViewManagerConfig('ComponentName')
    const uiManagerRegex = /UIManager\.getViewManagerConfig\s*\(\s*['"](\w+)['"]\s*\)/g;
    while ((match = uiManagerRegex.exec(content)) !== null) {
      const componentName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const enclosing = nodes.find(
        n => n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        usages.push({ componentName, usageNodeId: enclosing.id, filePath: f });
      }
    }
  }

  return usages;
}

/**
 * Find native view manager classes in ObjC/Swift/Java/Kotlin files.
 */
function findNativeViewManagers(context: ResolutionContext): NativeViewManager[] {
  const managers: NativeViewManager[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.m') && !f.endsWith('.mm') && !f.endsWith('.swift') &&
        !f.endsWith('.java') && !f.endsWith('.kt') && !f.endsWith('.h')) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    const nodes = context.getNodesInFile(f);

    // ObjC: @implementation RCTMyViewManager or subclass of RCTViewManager
    if (f.endsWith('.m') || f.endsWith('.mm') || f.endsWith('.h')) {
      // Find class implementations/declarations
      const implRegex = /@(?:implementation|interface)\s+(\w+(?:Manager|ViewManager|ComponentView))\b/g;
      let match: RegExpExecArray | null;

      while ((match = implRegex.exec(content)) !== null) {
        const className = match[1];
        const componentName = extractComponentName(className);

        const classNode = nodes.find(
          n => n.kind === 'class' && n.name === className
        );

        if (classNode && componentName) {
          managers.push({ componentName, nodeId: classNode.id, filePath: f, className });
        }
      }

      // Also check RCT_EXPORT_VIEW_PROPERTY patterns
      if (content.includes('RCT_EXPORT_VIEW_PROPERTY') || content.includes('RCTViewManager')) {
        const classImpl = content.match(/@implementation\s+(\w+)/);
        if (classImpl) {
          const className = classImpl[1];
          const componentName = extractComponentName(className);
          const classNode = nodes.find(n => n.kind === 'class' && n.name === className);

          if (classNode && componentName) {
            const exists = managers.some(m => m.nodeId === classNode.id);
            if (!exists) {
              managers.push({ componentName, nodeId: classNode.id, filePath: f, className });
            }
          }
        }
      }
    }

    // Swift: class that extends RCTViewManager or uses @objc
    if (f.endsWith('.swift')) {
      const classRegex = /class\s+(\w+(?:Manager|ViewManager|ComponentView))\s*:\s*(\w+)/g;
      let match: RegExpExecArray | null;

      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1];
        const componentName = extractComponentName(className);

        const classNode = nodes.find(
          n => n.kind === 'class' && n.name === className
        );

        if (classNode && componentName) {
          managers.push({ componentName, nodeId: classNode.id, filePath: f, className });
        }
      }
    }

    // Java/Kotlin: class extending SimpleViewManager or ViewGroupManager
    if (f.endsWith('.java') || f.endsWith('.kt')) {
      const classRegex = /class\s+(\w+(?:Manager|ViewManager))\s+(?:extends|:)\s+\w*(?:ViewManager|SimpleViewManager|ViewGroupManager)/g;
      let match: RegExpExecArray | null;

      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1];
        const componentName = extractComponentName(className);

        const classNode = nodes.find(
          n => n.kind === 'class' && n.name === className
        );

        if (classNode && componentName) {
          managers.push({ componentName, nodeId: classNode.id, filePath: f, className });
        }
      }

      // Also check getName() return value for the component name
      const getNameMatch = content.match(/getName\s*\(\s*\)\s*(?::\s*String\s*)?\{[^}]*return\s*"(\w+)"/);
      if (getNameMatch) {
        const registeredName = getNameMatch[1];
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          const classNode = nodes.find(n => n.kind === 'class' && n.name === classMatch[1]);
          if (classNode) {
            const exists = managers.some(m => m.nodeId === classNode.id);
            if (!exists) {
              managers.push({
                componentName: registeredName,
                nodeId: classNode.id,
                filePath: f,
                className: classMatch[1],
              });
            }
          }
        }
      }
    }
  }

  return managers;
}

/**
 * Extract the base component name from a view manager class name.
 * RCTMyViewManager → MyView
 * MyViewManager → MyView
 * MyComponentView → My
 */
function extractComponentName(className: string): string | null {
  // Strip prefixes
  let name = className;
  for (const prefix of VIEW_MANAGER_PREFIXES) {
    if (prefix && name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }

  // Strip suffixes
  for (const suffix of VIEW_MANAGER_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      if (name.length > 0) return name;
    }
  }

  return name.length > 0 ? name : null;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const nativeViewsBridge: BridgeResolver = {
  name: 'native-views-bridge',

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles();

    // Check for view manager files or codegen specs
    for (const f of files) {
      const fileName = f.split('/').pop() ?? '';

      // Check for ViewManager pattern in filenames
      if (fileName.includes('ViewManager') || fileName.includes('ComponentView')) {
        return true;
      }

      // Check for requireNativeComponent or codegenNativeComponent in JS/TS
      if (f.endsWith('.tsx') || f.endsWith('.jsx') || f.endsWith('.ts') || f.endsWith('.js')) {
        const content = context.readFile(f);
        if (content && (
          content.includes('requireNativeComponent') ||
          content.includes('codegenNativeComponent')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    const usages = findNativeViewUsages(context);
    const managers = findNativeViewManagers(context);

    // Match usages to managers by component name
    for (const usage of usages) {
      for (const manager of managers) {
        // Direct name match
        if (usage.componentName === manager.componentName) {
          edges.push({
            source: usage.usageNodeId,
            target: manager.nodeId,
            kind: 'references',
            confidence: 'inferred',
            confidenceScore: 0.85,
            metadata: {
              synthesizedBy: 'native-views-bridge',
              provenance: 'heuristic',
              componentName: usage.componentName,
              nativeClass: manager.className,
            },
          });
        }

        // Also try case-insensitive match
        if (usage.componentName.toLowerCase() === manager.componentName.toLowerCase() &&
            usage.componentName !== manager.componentName) {
          edges.push({
            source: usage.usageNodeId,
            target: manager.nodeId,
            kind: 'references',
            confidence: 'inferred',
            confidenceScore: 0.75,
            metadata: {
              synthesizedBy: 'native-views-bridge',
              provenance: 'heuristic',
              componentName: usage.componentName,
              nativeClass: manager.className,
              matchType: 'case-insensitive',
            },
          });
        }
      }
    }

    return edges;
  },
};
