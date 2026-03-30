/**
 * KiroGraph Error Handling and Logging Infrastructure
 */

// ── Logger ────────────────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export const defaultLogger: Logger = {
  debug(msg: string, ...args: unknown[]): void {
    if (process.env.KIROGRAPH_DEBUG) {
      console.debug('[kirograph:debug]', msg, ...args);
    }
  },
  info(msg: string, ...args: unknown[]): void {
    console.info('[kirograph:info]', msg, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    console.warn('[kirograph:warn]', msg, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    console.error('[kirograph:error]', msg, ...args);
  },
};

export const silentLogger: Logger = {
  debug(): void { /* noop */ },
  info(): void { /* noop */ },
  warn(): void { /* noop */ },
  error(): void { /* noop */ },
};

let _logger: Logger = defaultLogger;

export function setLogger(l: Logger): void {
  _logger = l;
}

export function getLogger(): Logger {
  return _logger;
}

export function logDebug(msg: string, ...args: unknown[]): void {
  _logger.debug(msg, ...args);
}

export function logWarn(msg: string, ...args: unknown[]): void {
  _logger.warn(msg, ...args);
}

export function logError(msg: string, ...args: unknown[]): void {
  _logger.error(msg, ...args);
}

// ── Error Classes ─────────────────────────────────────────────────────────────

export class KiroGraphError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'KiroGraphError';
    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IndexError extends KiroGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'INDEX_ERROR', context);
    this.name = 'IndexError';
  }
}

export class ResolutionError extends KiroGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'RESOLUTION_ERROR', context);
    this.name = 'ResolutionError';
  }
}

export class EmbeddingError extends KiroGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'EMBEDDING_ERROR', context);
    this.name = 'EmbeddingError';
  }
}

export class ConfigError extends KiroGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context);
    this.name = 'ConfigError';
  }
}

export class TraversalError extends KiroGraphError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'TRAVERSAL_ERROR', context);
    this.name = 'TraversalError';
  }
}

// ── Migrated from src/types.ts ────────────────────────────────────────────────

export class FileError extends KiroGraphError {
  constructor(message: string, public readonly filePath: string) {
    super(message, 'FILE_ERROR', { filePath });
    this.name = 'FileError';
  }
}

export class ParseError extends KiroGraphError {
  constructor(message: string, public readonly filePath: string, public readonly line?: number) {
    super(message, 'PARSE_ERROR', { filePath, line });
    this.name = 'ParseError';
  }
}

export class DatabaseError extends KiroGraphError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
    this.name = 'DatabaseError';
  }
}
