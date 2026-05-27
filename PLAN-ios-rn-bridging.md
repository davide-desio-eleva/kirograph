# Plan: Mixed iOS / React Native / Expo Cross-Language Bridging

## Overview

Close the last remaining gap vs CodeGraph by implementing cross-language flow resolution for iOS and React Native codebases. This enables `kirograph_callers`, `kirograph_callees`, `kirograph_impact`, and `kirograph_flows` to trace calls across language boundaries that static tree-sitter parsing alone cannot resolve.

## What CodeGraph Does

CodeGraph implements 7 bridge types that synthesize edges between symbols in different languages:

| Bridge | Source | Target | How it works |
|--------|--------|--------|--------------|
| Swift → ObjC | `obj.foo(bar:)` | `-fooWithBar:` selector | @objc auto-bridging rules + Cocoa preposition prefixes |
| ObjC → Swift | `[obj fooWithBar:]` | `@objc func foo(bar:)` | Reverse-bridge name candidates |
| RN Legacy Bridge | `NativeModules.X.fn()` | `RCT_EXPORT_METHOD` / `@ReactMethod` | Parses macro/annotation declarations |
| RN TurboModules | `import M from './NativeM'` | Native impl matching Codegen spec | Treats Native<X>.ts spec as ground truth |
| RN native → JS events | `NativeEventEmitter.addListener('e')` | `sendEventWithName:@"e"` | Synthesized event channel by literal name |
| Expo Modules | `requireNativeModule('X').fn()` | `Module { Name("X"); AsyncFunction("fn") }` | Parses Expo DSL literals |
| Fabric/Paper views | `<MyView prop={v}/>` | Native impl class | Convention-based name+suffix lookup |

Each bridge emits edges tagged `provenance:'heuristic'` with `metadata.synthesizedBy` set to a stable channel name.

## Implementation Plan

### Phase 1: Bridge Infrastructure

**File**: `src/resolution/bridges/index.ts`

Create a bridge resolver interface that runs after standard resolution:

```typescript
interface BridgeResolver {
  name: string;
  /** Detect if this bridge is relevant for the project */
  detect(context: ResolutionContext): boolean;
  /** Synthesize cross-language edges */
  resolve(context: ResolutionContext): SynthesizedEdge[];
}

interface SynthesizedEdge {
  source: string; // node ID
  target: string; // node ID
  kind: EdgeKind;
  confidence: 'inferred';
  confidenceScore: number;
  metadata: {
    synthesizedBy: string; // e.g. 'swift-objc-bridge'
    provenance: 'heuristic';
  };
}
```

### Phase 2: Swift ↔ ObjC Bridge

**File**: `src/resolution/bridges/swift-objc.ts`

Detection: project has both `.swift` and `.m`/`.mm` files.

Resolution logic:
1. Find Swift functions with `@objc` attribute (already extracted as nodes)
2. Apply Swift → ObjC name mangling rules:
   - `func foo(bar: Int)` → `-fooWithBar:`
   - `init(name:)` → `-initWithName:`
   - Property `var x` → `-x` / `-setX:`
3. Find ObjC message sends that match the mangled selector
4. Emit `calls` edges between them

### Phase 3: React Native Legacy Bridge

**File**: `src/resolution/bridges/react-native.ts`

Detection: project has `react-native` in package.json dependencies.

Resolution logic:
1. Find JS/TS calls to `NativeModules.X.methodName()`
2. Find ObjC `RCT_EXPORT_METHOD(methodName:...)` or Java `@ReactMethod` annotations
3. Match by module name + method name
4. Emit `calls` edges

### Phase 4: React Native TurboModules

**File**: `src/resolution/bridges/turbomodules.ts`

Detection: project has `Native*.ts` spec files with TurboModule interfaces.

Resolution logic:
1. Find TypeScript spec interfaces (`export interface Spec extends TurboModule`)
2. Find native implementations matching the module name
3. Match method signatures between spec and impl
4. Emit `calls` edges from JS call sites → native implementations

### Phase 5: Expo Modules

**File**: `src/resolution/bridges/expo-modules.ts`

Detection: project has `expo-modules-core` dependency or `expo-module.config.json`.

Resolution logic:
1. Find JS calls to `requireNativeModule('X').fn()`
2. Find Swift/Kotlin module definitions: `Module { Name("X"); AsyncFunction("fn") { ... } }`
3. Match by module name + function name
4. Emit `calls` edges

### Phase 6: Native → JS Events

**File**: `src/resolution/bridges/native-events.ts`

Detection: project uses `NativeEventEmitter`.

Resolution logic:
1. Find JS `addListener('eventName', callback)` calls
2. Find native `sendEventWithName:@"eventName"` (ObjC) or `.emit("eventName")` (Java/Kotlin)
3. Match by literal event name string
4. Emit `calls` edges (native → JS direction)

### Phase 7: Fabric/Paper View Components

**File**: `src/resolution/bridges/native-views.ts`

Detection: project has view manager files or Codegen specs.

Resolution logic:
1. Find JSX usage of native components (`<MyView />`)
2. Find native view manager classes by convention:
   - `MyView` → `MyViewManager`, `MyViewComponentView`, `RCTMyViewManager`
3. Match by name + suffix convention
4. Emit `references` edges

---

## Execution Order

| # | Phase | Effort | Depends On |
|---|-------|--------|-----------|
| 1 | Bridge infrastructure | Small | — |
| 2 | Swift ↔ ObjC | Medium | Phase 1 |
| 3 | RN Legacy Bridge | Medium | Phase 1 |
| 4 | TurboModules | Medium | Phase 1 |
| 5 | Expo Modules | Small | Phase 1 |
| 6 | Native Events | Small | Phase 1 |
| 7 | Fabric/Paper Views | Small | Phase 1 |

Total estimated effort: 5-7 days.

## Files to Create

- `src/resolution/bridges/index.ts` — Bridge resolver registry + interface
- `src/resolution/bridges/swift-objc.ts` — Swift ↔ ObjC bridging
- `src/resolution/bridges/react-native.ts` — RN Legacy Bridge
- `src/resolution/bridges/turbomodules.ts` — TurboModules
- `src/resolution/bridges/expo-modules.ts` — Expo Modules
- `src/resolution/bridges/native-events.ts` — Native → JS events
- `src/resolution/bridges/native-views.ts` — Fabric/Paper views

## Files to Modify

- `src/resolution/index.ts` — Call bridge resolvers after standard resolution
- `src/frameworks/index.ts` — Add detection for RN/Expo projects
- `src/types.ts` — No changes needed (Edge already has confidence + metadata)

## Testing

Each bridge should be tested against a small fixture project:
- Swift ↔ ObjC: a minimal iOS project with bridging
- RN: a minimal React Native project with a native module
- Expo: a minimal Expo module

## Notes

- All synthesized edges use `confidence: 'inferred'` and `confidenceScore: 0.7-0.9` (heuristic-based)
- The `metadata.synthesizedBy` field lets agents know these are cross-language hops
- Bridges only run when the relevant languages/frameworks are detected in the project
- No performance impact on non-iOS/RN projects (bridges skip via `detect()`)
