/**
 * Flutter Method Channel Bridge
 *
 * Synthesizes edges between Dart callers using MethodChannel.invokeMethod() /
 * EventChannel.receiveBroadcastStream() and their native handler implementations
 * in Kotlin/Java (setMethodCallHandler / setStreamHandler) or Swift/ObjC
 * (FlutterMethodChannel.setMethodCallHandler).
 *
 * The channel name string (e.g. "com.example/camera") is the linking key between
 * the Dart side and each native platform side.
 */

import type { ResolutionContext } from '../../frameworks/types';
import type { BridgeResolver, SynthesizedEdge } from './index';

// ── Types ─────────────────────────────────────────────────────────────────────

type ChannelType = 'method' | 'event';

interface DartChannelCall {
  channelName: string;
  methodName: string | null; // null for EventChannel receiveBroadcastStream
  channelType: ChannelType;
  callerNodeId: string;
  filePath: string;
}

interface NativeChannelHandler {
  channelName: string;
  channelType: ChannelType;
  nodeId: string;
  language: 'kotlin' | 'java' | 'swift' | 'objc';
  filePath: string;
}

// ── Detection helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if pubspec.yaml declares a flutter dependency, indicating
 * this is a Flutter project.
 */
function hasPubspecFlutter(context: ResolutionContext): boolean {
  const pubspec = context.readFile('pubspec.yaml');
  if (!pubspec) return false;
  // Flutter apps have a "flutter:" section or flutter as a dependency
  return /^\s*flutter\s*:/m.test(pubspec) || /flutter\s*:/.test(pubspec);
}

/**
 * Returns true if any .dart file in the project uses MethodChannel or
 * EventChannel, as a secondary detection heuristic.
 */
function hasDartChannelUsage(context: ResolutionContext): boolean {
  const files = context.getAllFiles();
  for (const f of files) {
    if (!f.endsWith('.dart')) continue;
    const content = context.readFile(f);
    if (!content) continue;
    if (content.includes('MethodChannel(') || content.includes('EventChannel(')) {
      return true;
    }
  }
  return false;
}

// ── Dart-side parsing ─────────────────────────────────────────────────────────

/**
 * Extract all channel name strings declared in a Dart file.
 *
 * Handles both forms:
 *   static const _channel = MethodChannel('com.example/camera');
 *   final _channel = MethodChannel("com.example/camera");
 *
 * Returns a map of variable name → { channelName, channelType }.
 */
function extractDartChannelDeclarations(
  content: string
): Map<string, { channelName: string; channelType: ChannelType }> {
  const map = new Map<string, { channelName: string; channelType: ChannelType }>();

  // MethodChannel / EventChannel variable declarations
  // Matches: [final|static const] <name> = MethodChannel('...')
  const declRegex =
    /(?:static\s+const|final|const|var)\s+(\w+)\s*=\s*(MethodChannel|EventChannel)\s*\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(content)) !== null) {
    const varName = match[1];
    const channelClass = match[2];
    const channelName = match[3];
    map.set(varName, {
      channelName,
      channelType: channelClass === 'EventChannel' ? 'event' : 'method',
    });
  }

  // Also handle inline: MethodChannel('com.example/camera').invokeMethod(...)
  // These are collected during call scanning below; no variable name needed.

  return map;
}

/**
 * Scan all .dart files for MethodChannel.invokeMethod() and
 * EventChannel.receiveBroadcastStream() call sites, then resolve them to
 * graph nodes.
 */
function findDartChannelCalls(context: ResolutionContext): DartChannelCall[] {
  const calls: DartChannelCall[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.dart')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    if (!content.includes('MethodChannel') && !content.includes('EventChannel')) {
      continue;
    }

    const nodes = context.getNodesInFile(f);

    /**
     * Find the enclosing function/method node for a given character offset.
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

    // Build variable name → channel info map for this file
    const channelVars = extractDartChannelDeclarations(content);

    // 1. invokeMethod calls on a known variable:
    //    _channel.invokeMethod('takePicture', ...)
    const invokeVarRegex = /\b(\w+)\.invokeMethod\s*\(\s*['"](\w+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = invokeVarRegex.exec(content)) !== null) {
      const varName = match[1];
      const methodName = match[2];
      const info = channelVars.get(varName);
      if (!info || info.channelType !== 'method') continue;

      const caller = enclosingNode(match.index);
      if (caller) {
        calls.push({
          channelName: info.channelName,
          methodName,
          channelType: 'method',
          callerNodeId: caller.id,
          filePath: f,
        });
      }
    }

    // 2. Inline invokeMethod: MethodChannel('name').invokeMethod('method')
    const inlineInvokeRegex =
      /MethodChannel\s*\(\s*['"]([^'"]+)['"]\s*\)\.invokeMethod\s*\(\s*['"](\w+)['"]/g;
    while ((match = inlineInvokeRegex.exec(content)) !== null) {
      const channelName = match[1];
      const methodName = match[2];
      const caller = enclosingNode(match.index);
      if (caller) {
        calls.push({
          channelName,
          methodName,
          channelType: 'method',
          callerNodeId: caller.id,
          filePath: f,
        });
      }
    }

    // 3. EventChannel receiveBroadcastStream on a known variable:
    //    _eventChannel.receiveBroadcastStream()
    const broadcastVarRegex = /\b(\w+)\.receiveBroadcastStream\s*\(/g;
    while ((match = broadcastVarRegex.exec(content)) !== null) {
      const varName = match[1];
      const info = channelVars.get(varName);
      if (!info || info.channelType !== 'event') continue;

      const caller = enclosingNode(match.index);
      if (caller) {
        calls.push({
          channelName: info.channelName,
          methodName: null,
          channelType: 'event',
          callerNodeId: caller.id,
          filePath: f,
        });
      }
    }

    // 4. Inline EventChannel: EventChannel('name').receiveBroadcastStream()
    const inlineBroadcastRegex =
      /EventChannel\s*\(\s*['"]([^'"]+)['"]\s*\)\.receiveBroadcastStream\s*\(/g;
    while ((match = inlineBroadcastRegex.exec(content)) !== null) {
      const channelName = match[1];
      const caller = enclosingNode(match.index);
      if (caller) {
        calls.push({
          channelName,
          methodName: null,
          channelType: 'event',
          callerNodeId: caller.id,
          filePath: f,
        });
      }
    }
  }

  return calls;
}

// ── Native-side parsing ───────────────────────────────────────────────────────

/**
 * Extract a channel name from the region of source text surrounding a
 * setMethodCallHandler / setStreamHandler call.
 *
 * Searches backwards up to `lookback` characters from `offset` for a quoted
 * string that is likely the channel name argument passed to the MethodChannel /
 * EventChannel constructor.
 *
 * Returns null if no candidate string is found.
 */
function extractChannelNameNearOffset(
  content: string,
  offset: number,
  lookback = 400
): string | null {
  const region = content.slice(Math.max(0, offset - lookback), offset + 200);

  // Look for a quoted string that looks like a channel name (contains '/')
  // Dart convention: "com.example/channelName"
  const channelNameRegex = /['"]([a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+)['"]/g;
  let best: string | null = null;
  let bestDist = Infinity;
  let match: RegExpExecArray | null;
  while ((match = channelNameRegex.exec(region)) !== null) {
    const dist = Math.abs(match.index - lookback);
    if (dist < bestDist) {
      bestDist = dist;
      best = match[1];
    }
  }

  // Fallback: any quoted string that could be a channel name (no slash required)
  if (!best) {
    const fallbackRegex = /['"]([a-zA-Z0-9._/-]{5,})['"]/g;
    while ((match = fallbackRegex.exec(region)) !== null) {
      const dist = Math.abs(match.index - lookback);
      if (dist < bestDist) {
        bestDist = dist;
        best = match[1];
      }
    }
  }

  return best;
}

/**
 * Scan Kotlin/Java files for Flutter MethodChannel and EventChannel handler
 * registrations:
 *   MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example/camera")
 *     .setMethodCallHandler { ... }
 *   EventChannel(..., "com.example/stream").setStreamHandler(...)
 */
function findKotlinJavaHandlers(context: ResolutionContext): NativeChannelHandler[] {
  const handlers: NativeChannelHandler[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.kt') && !f.endsWith('.java')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    const isFlutterNative =
      content.includes('setMethodCallHandler') ||
      content.includes('setStreamHandler') ||
      content.includes('FlutterPlugin') ||
      content.includes('MethodChannel') ||
      content.includes('EventChannel');

    if (!isFlutterNative) continue;

    const nodes = context.getNodesInFile(f);
    const language: 'kotlin' | 'java' = f.endsWith('.kt') ? 'kotlin' : 'java';

    // setMethodCallHandler { call, result -> ... } or .setMethodCallHandler(handler)
    const methodHandlerRegex = /\.setMethodCallHandler\s*[\({]/g;
    let match: RegExpExecArray | null;
    while ((match = methodHandlerRegex.exec(content)) !== null) {
      const channelName = extractChannelNameNearOffset(content, match.index);
      if (!channelName) continue;

      const lineNum = content.slice(0, match.index).split('\n').length;
      const handlerNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function' || n.kind === 'class') &&
          Math.abs(n.startLine - lineNum) < 10
      );

      if (handlerNode) {
        handlers.push({
          channelName,
          channelType: 'method',
          nodeId: handlerNode.id,
          language,
          filePath: f,
        });
      }
    }

    // setStreamHandler(...) for EventChannel
    const streamHandlerRegex = /\.setStreamHandler\s*\(/g;
    while ((match = streamHandlerRegex.exec(content)) !== null) {
      const channelName = extractChannelNameNearOffset(content, match.index);
      if (!channelName) continue;

      const lineNum = content.slice(0, match.index).split('\n').length;
      const handlerNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function' || n.kind === 'class') &&
          Math.abs(n.startLine - lineNum) < 10
      );

      if (handlerNode) {
        handlers.push({
          channelName,
          channelType: 'event',
          nodeId: handlerNode.id,
          language,
          filePath: f,
        });
      }
    }
  }

  return handlers;
}

/**
 * Scan Swift files for FlutterMethodChannel and FlutterEventChannel handler
 * registrations:
 *   let channel = FlutterMethodChannel(name: "com.example/camera", binaryMessenger: ...)
 *   channel.setMethodCallHandler { call, result in ... }
 *
 *   FlutterEventChannel(name: "com.example/stream", binaryMessenger: ...)
 *     .setStreamHandler(...)
 */
function findSwiftHandlers(context: ResolutionContext): NativeChannelHandler[] {
  const handlers: NativeChannelHandler[] = [];
  const files = context.getAllFiles();

  for (const f of files) {
    if (!f.endsWith('.swift')) continue;

    const content = context.readFile(f);
    if (!content) continue;

    const isFlutterNative =
      content.includes('FlutterMethodChannel') ||
      content.includes('FlutterEventChannel') ||
      content.includes('setMethodCallHandler') ||
      content.includes('setStreamHandler');

    if (!isFlutterNative) continue;

    const nodes = context.getNodesInFile(f);

    // Build a map of Swift variable name → channel name for this file.
    // FlutterMethodChannel(name: "com.example/camera", binaryMessenger: ...)
    const channelVarMap = new Map<string, { channelName: string; channelType: ChannelType }>();

    const flutterChannelDeclRegex =
      /(?:let|var)\s+(\w+)\s*=\s*(FlutterMethodChannel|FlutterEventChannel)\s*\(\s*name\s*:\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = flutterChannelDeclRegex.exec(content)) !== null) {
      const varName = match[1];
      const channelClass = match[2];
      const channelName = match[3];
      channelVarMap.set(varName, {
        channelName,
        channelType: channelClass === 'FlutterEventChannel' ? 'event' : 'method',
      });
    }

    // Also handle inline FlutterMethodChannel(name:...).setMethodCallHandler
    const inlineMethodHandlerRegex =
      /FlutterMethodChannel\s*\(\s*name\s*:\s*"([^"]+)"[^)]*\)\s*\.setMethodCallHandler/g;
    while ((match = inlineMethodHandlerRegex.exec(content)) !== null) {
      const channelName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;
      const handlerNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function' || n.kind === 'class') &&
          Math.abs(n.startLine - lineNum) < 10
      );
      if (handlerNode) {
        handlers.push({
          channelName,
          channelType: 'method',
          nodeId: handlerNode.id,
          language: 'swift',
          filePath: f,
        });
      }
    }

    // Named variable: channel.setMethodCallHandler { call, result in ... }
    const namedMethodHandlerRegex = /\b(\w+)\.setMethodCallHandler\s*\{/g;
    while ((match = namedMethodHandlerRegex.exec(content)) !== null) {
      const varName = match[1];
      const info = channelVarMap.get(varName);
      if (!info || info.channelType !== 'method') continue;

      const lineNum = content.slice(0, match.index).split('\n').length;
      const handlerNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function' || n.kind === 'class') &&
          Math.abs(n.startLine - lineNum) < 10
      );
      if (handlerNode) {
        handlers.push({
          channelName: info.channelName,
          channelType: 'method',
          nodeId: handlerNode.id,
          language: 'swift',
          filePath: f,
        });
      }
    }

    // EventChannel: inline FlutterEventChannel(name:...).setStreamHandler(...)
    const inlineStreamHandlerRegex =
      /FlutterEventChannel\s*\(\s*name\s*:\s*"([^"]+)"[^)]*\)\s*\.setStreamHandler/g;
    while ((match = inlineStreamHandlerRegex.exec(content)) !== null) {
      const channelName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;
      const handlerNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function' || n.kind === 'class') &&
          Math.abs(n.startLine - lineNum) < 10
      );
      if (handlerNode) {
        handlers.push({
          channelName,
          channelType: 'event',
          nodeId: handlerNode.id,
          language: 'swift',
          filePath: f,
        });
      }
    }

    // Named variable: eventChannel.setStreamHandler(...)
    const namedStreamHandlerRegex = /\b(\w+)\.setStreamHandler\s*\(/g;
    while ((match = namedStreamHandlerRegex.exec(content)) !== null) {
      const varName = match[1];
      const info = channelVarMap.get(varName);
      if (!info || info.channelType !== 'event') continue;

      const lineNum = content.slice(0, match.index).split('\n').length;
      const handlerNode = nodes.find(
        n =>
          (n.kind === 'method' || n.kind === 'function' || n.kind === 'class') &&
          Math.abs(n.startLine - lineNum) < 10
      );
      if (handlerNode) {
        handlers.push({
          channelName: info.channelName,
          channelType: 'event',
          nodeId: handlerNode.id,
          language: 'swift',
          filePath: f,
        });
      }
    }
  }

  return handlers;
}

// ── Bridge Implementation ─────────────────────────────────────────────────────

export const flutterChannelBridge: BridgeResolver = {
  name: 'flutter-channel-bridge',

  detect(context: ResolutionContext): boolean {
    // Primary signal: pubspec.yaml with flutter dependency
    if (hasPubspecFlutter(context)) return true;

    // Secondary signal: .dart files that use MethodChannel / EventChannel
    return hasDartChannelUsage(context);
  },

  resolve(context: ResolutionContext): SynthesizedEdge[] {
    const edges: SynthesizedEdge[] = [];

    const dartCalls = findDartChannelCalls(context);
    if (dartCalls.length === 0) return edges;

    const kotlinJavaHandlers = findKotlinJavaHandlers(context);
    const swiftHandlers = findSwiftHandlers(context);
    const allHandlers: NativeChannelHandler[] = [...kotlinJavaHandlers, ...swiftHandlers];

    for (const call of dartCalls) {
      const matchingHandlers = allHandlers.filter(
        h => h.channelName === call.channelName && h.channelType === call.channelType
      );

      for (const handler of matchingHandlers) {
        if (call.channelType === 'method') {
          // MethodChannel invokeMethod → native setMethodCallHandler
          edges.push({
            source: call.callerNodeId,
            target: handler.nodeId,
            kind: 'calls',
            confidence: 'inferred',
            confidenceScore: 0.7,
            metadata: {
              synthesizedBy: 'flutter-channel-bridge',
              provenance: 'heuristic',
              channelName: call.channelName,
              methodName: call.methodName ?? undefined,
              channelType: 'method',
              nativeLanguage: handler.language,
            },
          });
        } else {
          // EventChannel receiveBroadcastStream → native setStreamHandler
          edges.push({
            source: call.callerNodeId,
            target: handler.nodeId,
            kind: 'references',
            confidence: 'inferred',
            confidenceScore: 0.65,
            metadata: {
              synthesizedBy: 'flutter-channel-bridge',
              provenance: 'heuristic',
              channelName: call.channelName,
              channelType: 'event',
              nativeLanguage: handler.language,
            },
          });
        }
      }
    }

    return edges;
  },
};
