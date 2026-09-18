/**
 * Dialect adapters. Everything the engine needs from a host database.
 *
 * Verified platform limits drive the defaults:
 *   Cloudflare D1    100 bound parameters per query, 50 statements per batch() call,
 *                    ~100 KB per SQL statement, no user-defined functions, no interactive
 *                    transactions (batch() is the atomic unit), 1000 queries per invocation.
 *   Turso / libSQL   900 bound parameters (conservative; the server allows 32766), batch()
 *   and SQLite        ships many statements in one roundtrip and is atomic; no TEMP tables
 *                    on sqld, and no user-defined functions on Turso Cloud or D1.
 */

import { tokenize } from '../rewrite.js';

export interface AdapterCapabilities {
  /** Maximum bound parameters in one statement. */
  maxBoundParams: number;
  /** Maximum statements passed to batchStatements() in one call. */
  maxBatchStatements: number;
  /** create_function / db.function available: jev* SQL functions can be registered. */
  supportsUdf: boolean;
  /** exec() accepts several statements in one string; used to pack inserts into few calls. */
  multiStatementExec: boolean;
  /** Hard limit on one SQL string (0 = unlimited). Used to chunk literal inserts. */
  maxStatementBytes: number;
}

export interface Statement {
  sql: string;
  params?: unknown[];
}

export interface Adapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /** Runs a statement and returns rows as objects. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs one or more statements with no result needed. */
  exec(sql: string): Promise<void>;
  /** Optional fast path: many statements in one roundtrip (D1 batch(), libSQL batch(), a local transaction). */
  batchStatements?(statements: Statement[]): Promise<void>;
  /** Optional user-defined function registration. */
  attachFunction?(name: string, fn: (...args: unknown[]) => unknown): boolean;
}

export function isSelect(sql: string): boolean {
  const head = sql.trimStart().slice(0, 16).toLowerCase();
  return (
    head.startsWith('select') ||
    head.startsWith('with') ||
    head.startsWith('pragma') ||
    head.startsWith('explain')
  );
}

/** Rows may arrive as objects (most drivers) or as arrays with a columns list (libSQL). */
export function rowObjects(
  rows: unknown[],
  columns?: string[] | undefined,
): Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (Array.isArray(first)) {
    const names = columns ?? [];
    return rows.map((row) => {
      const values = row as unknown[];
      const out: Record<string, unknown> = {};
      names.forEach((name, index) => {
        out[name] = values[index];
      });
      return out;
    });
  }
  return rows as Record<string, unknown>[];
}

/**
 * Splits a SQL script on top-level semicolons, ignoring literals and comments, so a schema
 * file can be applied statement by statement on clients that refuse multi-statement SQL.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const token of tokenize(script)) {
    if (token.kind === 'punct' && token.value === ';') {
      const piece = script.slice(start, token.start).trim();
      if (piece) out.push(piece);
      start = token.end;
    }
  }
  const tail = script.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}
