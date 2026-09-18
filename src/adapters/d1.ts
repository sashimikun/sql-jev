/**
 * Cloudflare D1 (and Durable Object SQLite via the same D1-shaped binding).
 *
 * D1 cannot register user-defined functions and refuses a statement with more than 100
 * bound parameters, so this adapter declares that, and the engine switches to literal
 * multi-statement exec() writes to stay inside the 1000-queries-per-invocation budget.
 */

import { isSelect, rowObjects, type Adapter, type AdapterCapabilities, type Statement } from './types.js';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[]; success?: boolean; error?: string }>;
  run?(): Promise<unknown>;
  first?<T = unknown>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<{ count?: number; duration?: number } | void>;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown>;
  withSession?(): unknown;
}

const D1_CAPABILITIES: AdapterCapabilities = {
  maxBoundParams: 100,
  maxBatchStatements: 50,
  supportsUdf: false,
  multiStatementExec: true,
  maxStatementBytes: 100_000,
};

async function run(db: D1DatabaseLike, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const prepared = params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const result = await prepared.all();
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error(`D1 error: ${result.error}`);
  }
  return rowObjects((result?.results ?? []) as unknown[]);
}

export function d1Adapter(db: D1DatabaseLike): Adapter {
  return {
    name: 'd1',
    capabilities: D1_CAPABILITIES,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (!isSelect(sql)) {
        await run(db, sql, params);
        return [];
      }
      return (await run(db, sql, params)) as T[];
    },
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async batchStatements(statements: Statement[]): Promise<void> {
      if (!db.batch) {
        for (const statement of statements) await run(db, statement.sql, statement.params ?? []);
        return;
      }
      const prepared = statements.map((statement) => {
        const params = statement.params ?? [];
        return params.length > 0 ? db.prepare(statement.sql).bind(...params) : db.prepare(statement.sql);
      });
      await db.batch(prepared);
    },
  };
}
