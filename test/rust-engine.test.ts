import { describe, it, expect, afterEach } from 'vitest';
import { effectiveEngine, rustEngineFor, rustEngineFallback, loadRustEngine, _resetRustEngine } from '../src/core/rust-engine';
import type { KiroGraphConfig } from '../src/config';

const saved = process.env.KIROGRAPH_ENGINE;
afterEach(() => {
  if (saved === undefined) delete process.env.KIROGRAPH_ENGINE; else process.env.KIROGRAPH_ENGINE = saved;
  _resetRustEngine();
});

const config = (engine: 'node' | 'rust') => ({ engine } as KiroGraphConfig);

describe('index engine selection', () => {
  it('follows the configuration', () => {
    delete process.env.KIROGRAPH_ENGINE;
    expect(effectiveEngine(config('node'))).toBe('node');
    expect(effectiveEngine(config('rust'))).toBe('rust');
    expect(effectiveEngine({} as KiroGraphConfig)).toBe('node');
  });

  it('is overridden by KIROGRAPH_ENGINE for one run', () => {
    process.env.KIROGRAPH_ENGINE = 'rust';
    expect(effectiveEngine(config('node'))).toBe('rust');
    process.env.KIROGRAPH_ENGINE = 'node';
    expect(effectiveEngine(config('rust'))).toBe('node');
    process.env.KIROGRAPH_ENGINE = 'other';
    expect(effectiveEngine(config('rust'))).toBe('rust');
  });

  it('uses no native engine and reports no fallback when the engine is node', () => {
    delete process.env.KIROGRAPH_ENGINE;
    expect(rustEngineFor(config('node'))).toBeNull();
    expect(rustEngineFallback(config('node'))).toBeNull();
  });

  it('falls back to node, with a reason, only when the module does not load', () => {
    delete process.env.KIROGRAPH_ENGINE;
    const loaded = loadRustEngine();
    if (loaded) {
      expect(rustEngineFor(config('rust'))).toBe(loaded);
      expect(rustEngineFallback(config('rust'))).toBeNull();
      expect(loaded.nativeLanguages()).toContain('typescript');
    } else {
      expect(rustEngineFor(config('rust'))).toBeNull();
      expect(rustEngineFallback(config('rust'))).toMatch(/^engine "rust" unavailable/);
    }
  });
});
