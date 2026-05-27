/**
 * Swift ↔ ObjC Bridge
 *
 * Synthesizes edges between Swift functions with @objc attributes and
 * Objective-C message sends that match the mangled selector.
 *
 * Name mangling rules:
 *   - func foo(bar: Int) → -fooWithBar:
 *   - init(name:) → -initWithName:
 *   - var x → -x / -setX:
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Swift → ObjC name mangling ────────────────────────────────────────────────

/**
 * Convert a Swift function signature to its ObjC selector equivalent.
 * Examples:
 *   foo(bar:baz:) → fooWithBar:baz:
 *   init(name:) → initWithName:
 *   doSomething() → doSomething
 */
function swiftToObjcSelector(funcName: string, signature?: string): string[] {
  const selectors: string[] = [];

  // Extract parameter labels from signature if available
  // Signature format: func foo(bar: Int, baz: String)
  if (signature) {
    const paramMatch = signature.match(/\(([^)]*)\)/);
    if (paramMatch) {
      const params = paramMatch[1].split(',').map(p => p.trim()).filter(Boolean);
      if (params.length === 0) {
        // No params: selector is just the function name
        selectors.push(funcName);
      } else {
        // First param label gets "With" prefix (Cocoa convention)
        const labels = params.map(p => {
          const parts = p.split(':')[0].trim().split(/\s+/);
          return parts[0]; // external label
        });

        if (labels.length > 0 && labels[0] !== '_') {
          const firstLabel = labels[0];
          const capitalizedFirst = firstLabel.charAt(0).toUpperCase() + firstLabel.slice(1);
          let selector = `${funcName}With${capitalizedFirst}:`;
          for (let i = 1; i < labels.length; i++) {
            if (labels[i] !== '_') {
              selector += `${labels[i]}:`;
            } else {
              selector += ':';
            }
          }
          selectors.push(selector);
        }

        // Also try direct selector without "With" prefix
        let directSelector = `${funcName}:`;
        for (let i = 1; i < labels.length; i++) {
          if (labels[i] !== '_') {
            directSelector += `${labels[i]}:`;
          } else {
            directSelector += ':';
          }
        }
        selectors.push(directSelector);
      }
    }
  }

  // Always include the bare name as a candidate
  selectors.push(funcName);

  // For init methods, add initWith variant
  if (funcName === 'init' && signature) {
    const paramMatch = signature.match(/\(([^)]*)\)/);
    if (paramMatch) {
      const params = paramMatch[1].split(',').map(p => p.trim()).filter(Boolean);
      if (params.length > 0) {
        const firstLabel = params[0].split(':')[0].trim().split(/\s+/)[0];
        if (firstLabel !== '_') {
          const cap = firstLabel.charAt(0).toUpperCase() + firstLabel.slice(1);
          selectors.push(`initWith${cap}:`);
        }
      }
    }
  }

  return [...new Set(selectors)];
}

/**
 * Generate ObjC property accessor selectors for a Swift property.
 * var x → [x, setX:]
 */
function swiftPropertyToObjcSelectors(propName: string): string[] {
  const capitalized = propName.charAt(0).toUpperCase() + propName.slice(1);
  return [propName, `set${capitalized}:`];
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const swiftObjcBridge: BridgeResolver = {
  name: 'swift-objc-bridge',

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles();
    let hasSwift = false;
    let hasObjc = false;

    for (const f of files) {
      if (f.endsWith('.swift')) hasSwift = true;
      if (f.endsWith('.m') || f.endsWith('.mm') || f.endsWith('.h')) hasObjc = true;
      if (hasSwift && hasObjc) return true;
    }

    return false;
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];
    const files = context.getAllFiles();

    // Collect Swift @objc functions and properties
    const swiftNodes: Node[] = [];
    for (const f of files) {
      if (f.endsWith('.swift')) {
        const nodes = context.getNodesInFile(f);
        for (const node of nodes) {
          if (
            (node.kind === 'function' || node.kind === 'method' || node.kind === 'property') &&
            node.decorators?.includes('objc')
          ) {
            swiftNodes.push(node);
          }
        }
      }
    }

    if (swiftNodes.length === 0) return edges;

    // Build selector → Swift node map
    const selectorToSwiftNode = new Map<string, Node>();
    for (const node of swiftNodes) {
      if (node.kind === 'property') {
        const selectors = swiftPropertyToObjcSelectors(node.name);
        for (const sel of selectors) {
          selectorToSwiftNode.set(sel, node);
        }
      } else {
        const selectors = swiftToObjcSelector(node.name, node.signature);
        for (const sel of selectors) {
          selectorToSwiftNode.set(sel, node);
        }
      }
    }

    // Scan ObjC files for message sends matching selectors
    for (const f of files) {
      if (!f.endsWith('.m') && !f.endsWith('.mm')) continue;

      const content = context.readFile(f);
      if (!content) continue;

      const objcNodes = context.getNodesInFile(f);

      // Look for message send patterns: [obj selectorName...]
      // Also look for method declarations that call Swift methods
      for (const node of objcNodes) {
        if (node.kind !== 'method' && node.kind !== 'function') continue;

        // Check if this ObjC method name matches a Swift selector
        const swiftTarget = selectorToSwiftNode.get(node.name);
        if (swiftTarget) {
          edges.push({
            source: node.id,
            target: swiftTarget.id,
            kind: 'calls',
            confidence: 'inferred',
            confidenceScore: 0.85,
            metadata: {
              synthesizedBy: 'swift-objc-bridge',
              provenance: 'heuristic',
              direction: 'objc-to-swift',
            },
          });
        }
      }

      // Regex-based scan for message sends in ObjC source
      const msgSendRegex = /\[[\w\s.]+\s+(\w+(?::\w*)*)\s*\]/g;
      let match: RegExpExecArray | null;
      while ((match = msgSendRegex.exec(content)) !== null) {
        const selector = match[1];
        const swiftTarget = selectorToSwiftNode.get(selector);
        if (!swiftTarget) continue;

        // Find the enclosing ObjC function/method for this call site
        const lineNum = content.slice(0, match.index).split('\n').length;
        const enclosingNode = objcNodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               n.startLine <= lineNum && n.endLine >= lineNum
        );

        if (enclosingNode) {
          // Avoid duplicate edges
          const exists = edges.some(
            e => e.source === enclosingNode.id && e.target === swiftTarget.id
          );
          if (!exists) {
            edges.push({
              source: enclosingNode.id,
              target: swiftTarget.id,
              kind: 'calls',
              confidence: 'inferred',
              confidenceScore: 0.8,
              metadata: {
                synthesizedBy: 'swift-objc-bridge',
                provenance: 'heuristic',
                direction: 'objc-to-swift',
                selector,
              },
            });
          }
        }
      }
    }

    // Reverse direction: Swift calling ObjC methods
    // Look for Swift files calling ObjC selectors
    for (const f of files) {
      if (!f.endsWith('.swift')) continue;

      const content = context.readFile(f);
      if (!content) continue;

      const swiftFileNodes = context.getNodesInFile(f);

      // Collect all ObjC method nodes for matching
      const objcMethods: Node[] = [];
      for (const of2 of files) {
        if (!of2.endsWith('.m') && !of2.endsWith('.mm') && !of2.endsWith('.h')) continue;
        const nodes = context.getNodesInFile(of2);
        for (const n of nodes) {
          if (n.kind === 'method' || n.kind === 'function') {
            objcMethods.push(n);
          }
        }
      }

      // Match Swift method calls to ObjC implementations
      for (const swiftNode of swiftFileNodes) {
        if (swiftNode.kind !== 'method' && swiftNode.kind !== 'function') continue;

        for (const objcMethod of objcMethods) {
          // Check if the Swift node references the ObjC method name
          const nameMatch = swiftNode.name === objcMethod.name;
          if (nameMatch) {
            const exists = edges.some(
              e => e.source === swiftNode.id && e.target === objcMethod.id
            );
            if (!exists) {
              edges.push({
                source: swiftNode.id,
                target: objcMethod.id,
                kind: 'calls',
                confidence: 'inferred',
                confidenceScore: 0.7,
                metadata: {
                  synthesizedBy: 'swift-objc-bridge',
                  provenance: 'heuristic',
                  direction: 'swift-to-objc',
                },
              });
            }
          }
        }
      }
    }

    return edges;
  },
};
