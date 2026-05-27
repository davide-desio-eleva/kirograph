/**
 * Native → JS Events Bridge
 *
 * Synthesizes edges between native event emitters (sendEventWithName: in ObjC,
 * .emit() in Java/Kotlin) and JavaScript event listeners (NativeEventEmitter.addListener).
 * Matches by literal event name string.
 */

import type { Node } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface EventListener {
  eventName: string;
  listenerNodeId: string;
  filePath: string;
}

interface EventEmitter {
  eventName: string;
  emitterNodeId: string;
  filePath: string;
  language: 'objc' | 'java' | 'kotlin' | 'swift';
}

/**
 * Find JS/TS event listeners using NativeEventEmitter.addListener pattern.
 */
function findEventListeners(context: ResolutionContext): EventListener[] {
  const listeners: EventListener[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx') && !f.endsWith('.js') && !f.endsWith('.jsx')) {
      continue;
    }

    const content = context.readFile(f);
    if (!content) continue;

    const nodes = context.getNodesInFile(f);

    // Pattern 1: emitter.addListener('eventName', callback)
    const addListenerRegex = /\.addListener\s*\(\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = addListenerRegex.exec(content)) !== null) {
      const eventName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const enclosing = nodes.find(
        n => (n.kind === 'function' || n.kind === 'method') &&
             n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        listeners.push({ eventName, listenerNodeId: enclosing.id, filePath: f });
      }
    }

    // Pattern 2: DeviceEventEmitter.addListener('eventName', ...)
    const deviceEmitterRegex = /DeviceEventEmitter\.addListener\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = deviceEmitterRegex.exec(content)) !== null) {
      const eventName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const enclosing = nodes.find(
        n => (n.kind === 'function' || n.kind === 'method') &&
             n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        listeners.push({ eventName, listenerNodeId: enclosing.id, filePath: f });
      }
    }

    // Pattern 3: useEffect with subscription pattern
    const subscriptionRegex = /(?:on|subscribe|addEventListener)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = subscriptionRegex.exec(content)) !== null) {
      const eventName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      const enclosing = nodes.find(
        n => (n.kind === 'function' || n.kind === 'method') &&
             n.startLine <= lineNum && n.endLine >= lineNum
      );

      if (enclosing) {
        listeners.push({ eventName, listenerNodeId: enclosing.id, filePath: f });
      }
    }
  }

  return listeners;
}

/**
 * Find native event emitters in ObjC/Swift/Java/Kotlin files.
 */
function findEventEmitters(context: ResolutionContext): EventEmitter[] {
  const emitters: EventEmitter[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    // ObjC files
    if (f.endsWith('.m') || f.endsWith('.mm')) {
      const content = context.readFile(f);
      if (!content) continue;

      const nodes = context.getNodesInFile(f);

      // Pattern: sendEventWithName:@"eventName"
      const sendEventRegex = /sendEventWithName\s*:\s*@"([^"]+)"/g;
      let match: RegExpExecArray | null;

      while ((match = sendEventRegex.exec(content)) !== null) {
        const eventName = match[1];
        const lineNum = content.slice(0, match.index).split('\n').length;

        const enclosing = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               n.startLine <= lineNum && n.endLine >= lineNum
        );

        if (enclosing) {
          emitters.push({ eventName, emitterNodeId: enclosing.id, filePath: f, language: 'objc' });
        }
      }
    }

    // Swift files
    if (f.endsWith('.swift')) {
      const content = context.readFile(f);
      if (!content) continue;

      const nodes = context.getNodesInFile(f);

      // Pattern: sendEvent(withName: "eventName", ...)
      const sendEventRegex = /sendEvent\s*\(\s*withName\s*:\s*"([^"]+)"/g;
      let match: RegExpExecArray | null;

      while ((match = sendEventRegex.exec(content)) !== null) {
        const eventName = match[1];
        const lineNum = content.slice(0, match.index).split('\n').length;

        const enclosing = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               n.startLine <= lineNum && n.endLine >= lineNum
        );

        if (enclosing) {
          emitters.push({ eventName, emitterNodeId: enclosing.id, filePath: f, language: 'swift' });
        }
      }

      // Expo pattern: sendEvent("eventName", ...)
      const expoSendRegex = /sendEvent\s*\(\s*"([^"]+)"/g;
      while ((match = expoSendRegex.exec(content)) !== null) {
        const eventName = match[1];
        const lineNum = content.slice(0, match.index).split('\n').length;

        const enclosing = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               n.startLine <= lineNum && n.endLine >= lineNum
        );

        if (enclosing) {
          emitters.push({ eventName, emitterNodeId: enclosing.id, filePath: f, language: 'swift' });
        }
      }
    }

    // Java/Kotlin files
    if (f.endsWith('.java') || f.endsWith('.kt')) {
      const content = context.readFile(f);
      if (!content) continue;

      const nodes = context.getNodesInFile(f);

      // Pattern: .emit("eventName", ...) or sendEvent("eventName", ...)
      const emitRegex = /(?:\.emit|sendEvent)\s*\(\s*"([^"]+)"/g;
      let match: RegExpExecArray | null;

      while ((match = emitRegex.exec(content)) !== null) {
        const eventName = match[1];
        const lineNum = content.slice(0, match.index).split('\n').length;

        const enclosing = nodes.find(
          n => (n.kind === 'method' || n.kind === 'function') &&
               n.startLine <= lineNum && n.endLine >= lineNum
        );

        if (enclosing) {
          const lang = f.endsWith('.kt') ? 'kotlin' as const : 'java' as const;
          emitters.push({ eventName, emitterNodeId: enclosing.id, filePath: f, language: lang });
        }
      }
    }
  }

  return emitters;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const nativeEventsBridge: BridgeResolver = {
  name: 'native-events-bridge',

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles();

    for (const f of files) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx') && !f.endsWith('.js') && !f.endsWith('.jsx')) {
        continue;
      }

      const content = context.readFile(f);
      if (!content) continue;

      // Check for NativeEventEmitter or DeviceEventEmitter usage
      if (content.includes('NativeEventEmitter') || content.includes('DeviceEventEmitter')) {
        return true;
      }
    }

    return false;
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    const listeners = findEventListeners(context);
    const emitters = findEventEmitters(context);

    // Match emitters to listeners by event name
    // Direction: native emitter → JS listener (native calls into JS)
    for (const emitter of emitters) {
      for (const listener of listeners) {
        if (emitter.eventName === listener.eventName) {
          edges.push({
            source: emitter.emitterNodeId,
            target: listener.listenerNodeId,
            kind: 'calls',
            confidence: 'inferred',
            confidenceScore: 0.85,
            metadata: {
              synthesizedBy: 'native-events-bridge',
              provenance: 'heuristic',
              eventName: emitter.eventName,
              direction: 'native-to-js',
              nativeLanguage: emitter.language,
            },
          });
        }
      }
    }

    return edges;
  },
};
