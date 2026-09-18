/**
 * Any in-process SQLite handle: bun:sqlite, node:sqlite, better-sqlite3.
 * These expose statement objects and (except node:sqlite) user-defined functions, so both the
 * rewriter and native jev* SQL functions work here.
 */

import { isSelect, rowObjects, type Adapter, type AdapterCapabilities, type Statement } from './types.js';

export interface SqliteStatementLike {
  all?(...params: unknown[]): unknown[];
  run?(...params: unknown[]): unknown;
  get?(...params: unknown[]): unknown;
}

export interface SqliteLike {
  prepare(sql: string): SqliteStatementLike;
  query?(sql: string): SqliteStatementLike;
  exec?(sql: string): unknown;
  run?(sql: string, ...params: unknown[]): unknown;
  function?(name: string, fn: (...args: unknown[]) => unknown): unknown;
}

function statement(db: SqliteLike, sql: string): SqliteStatementLike {
  if (typeof db.query === 'function') return db.query(sql);
  return db.prepare(sql);
}

function execute(db: SqliteLike, sql: string, params: unknown[]): unknown[] {
  const prepared = statement(db, sql);
  if (isSelect(sql)) {
    if (typeof prepared.all === 'function') return prepared.all(...params);
    if (typeof prepared.get === 'function') {
      const row = prepared.get(...params);
      return row === undefined || row === null ? [] : [row];
    }
    throw new Error('sql-jev: this SQLite handle cannot return rows');
  }
  if (typeof prepared.run === 'function') {
    prepared.run(...params);
    return [];
  }
  if (typeof prepared.all === 'function') {
    prepared.all(...params);
    return [];
  }
  throw new Error('sql-jev: this SQLite handle cannot run statements');
}

export function sqliteAdapter(db: SqliteLike): Adapter {
  const execRaw = (sql: string): void => {
    if (typeof db.exec === 'function') {
      db.exec(sql);
      return;
    }
    if (typeof db.run === 'function') {
      db.run(sql);
      return;
    }
    execute(db, sql, []);
  };
  const capabilities: AdapterCapabilities = {
    maxBoundParams: 900,
    maxBatchStatements: 500,
    supportsUdf: typeof db.function === 'function',
    multiStatementExec: true,
    maxStatementBytes: 0,
  };
  return {
    name: 'sqlite',
    capabilities,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return rowObjects(execute(db, sql, params)) as T[];
    },
    async exec(sql: string): Promise<void> {
      execRaw(sql);
    },
    async batchStatements(statements: Statement[]): Promise<void> {
      execRaw('BEGIN');
      try {
        for (const item of statements) execute(db, item.sql, item.params ?? []);
        execRaw('COMMIT');
      } catch (error) {
        try {
          execRaw('ROLLBACK');
        } catch {
          // ignoring a rollback failure: the original error matters more
        }
        throw error;
      }
    },
    attachFunction(name: string, fn: (...args: unknown[]) => unknown): boolean {
      if (typeof db.function !== 'function') return false;
      db.function(name, fn);
      return true;
    },
  };
}
