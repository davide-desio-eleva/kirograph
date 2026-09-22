/**
 * KiroGraph PatternLibraryLoader — loads and merges YAML pattern rule files.
 *
 * js-yaml is not a declared dependency, so this uses the lightweight shared
 * YAML parser (src/shared/yaml.ts) that handles the flat key:value + nested
 * rule: block format used by KiroGraph pattern rule files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PatternRule } from './types';
import { logWarn } from '../errors';
import { parseYaml as _parseYaml } from '../shared/yaml';

// ── PatternLibraryLoader ──────────────────────────────────────────────────────

export class PatternLibraryLoader {
  /**
   * Load, validate, and merge rules from the builtin path and optional custom path.
   * User-supplied rules override bundled rules on id collision.
   */
  load(builtinPath: string, customPath?: string): PatternRule[] {
    const builtin = this._loadDirectory(builtinPath, 'builtin');
    const builtinMap = new Map<string, PatternRule>();
    for (const rule of builtin) builtinMap.set(rule.id, rule);

    if (!customPath) return builtin;

    const custom = this._loadDirectory(customPath, 'custom');
    const merged = new Map<string, PatternRule>(builtinMap);
    for (const rule of custom) {
      if (merged.has(rule.id)) {
        logWarn(`PatternLibraryLoader: custom rule "${rule.id}" overrides bundled rule`);
      }
      merged.set(rule.id, rule);
    }

    return [...merged.values()];
  }

  private _loadDirectory(dirPath: string, source: string): PatternRule[] {
    if (!fs.existsSync(dirPath)) {
      logWarn(`PatternLibraryLoader: ${source} library path does not exist: ${dirPath}`);
      return [];
    }

    const rules: PatternRule[] = [];
    const seenIds = new Map<string, string>();

    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch (err) {
      logWarn(`PatternLibraryLoader: failed to read ${source} directory "${dirPath}": ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const parsed = _parseYaml(text);
        const rule = this._validate(parsed, filePath);
        if (!rule) continue;

        if (seenIds.has(rule.id)) {
          logWarn(`PatternLibraryLoader: duplicate rule id "${rule.id}" in ${source} library — found in "${seenIds.get(rule.id)}" and "${filePath}", using last loaded`);
        }
        seenIds.set(rule.id, filePath);
        rules.push(rule);
      } catch (err) {
        logWarn(`PatternLibraryLoader: failed to load rule file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return rules;
  }

  private _validate(parsed: Record<string, unknown>, filePath: string): PatternRule | null {
    const required = ['id', 'language', 'severity', 'owaspCategory', 'description', 'fixHint', 'rule'];
    for (const field of required) {
      if (parsed[field] === undefined || parsed[field] === null) {
        logWarn(`PatternLibraryLoader: rule file "${filePath}" is missing required field "${field}", skipping`);
        return null;
      }
    }

    const id = String(parsed['id']);
    const language = parsed['language'];
    const severity = String(parsed['severity']) as PatternRule['severity'];
    const owaspCategory = String(parsed['owaspCategory']);
    const description = String(parsed['description']);
    const fixHint = String(parsed['fixHint']);
    const rule = parsed['rule'];

    const validSeverities = new Set(['critical', 'high', 'medium', 'low']);
    if (!validSeverities.has(severity)) {
      logWarn(`PatternLibraryLoader: rule file "${filePath}" has invalid severity "${severity}", skipping`);
      return null;
    }

    if (typeof language !== 'string' && !Array.isArray(language)) {
      logWarn(`PatternLibraryLoader: rule file "${filePath}" has invalid language field, skipping`);
      return null;
    }

    if (typeof rule !== 'object' || Array.isArray(rule) || rule === null) {
      logWarn(`PatternLibraryLoader: rule file "${filePath}" has invalid rule field (must be an object), skipping`);
      return null;
    }

    return {
      id,
      language: Array.isArray(language) ? (language as string[]) : String(language),
      severity,
      owaspCategory,
      description,
      fixHint,
      rule: rule as Record<string, unknown>,
    };
  }
}
