/**
 * Turso / libSQL (@libsql/client): remote libsql:// and https:// URLs, embedded replicas
 * and local files. libSQL supports create_function, so jev* SQL functions can be registered
 * in addition to the rewriter.
 */

import { returnsRows, rowObjects, splitStatements, type Adapter, type AdapterCapabilities, type Statement } from './types.js';

export interface LibsqlResultLike {
  rows: unknown[];
  columns?: string[];
}

export interface LibsqlClientLike {
  execute(input: string | { sql: string; args?: unknown[] }): Promise<LibsqlResultLike>;
  executeMultiple?(sql: string): Promise<unknown>;
  batch?(statements: unknown[], mode?: string): Promise<unknown>;
  create_function?(name: string, fn: (...args: unknown[]) => unknown): unknown;
  createFunction?(name: string, fn: (...args: unknown[]) => unknown): unknown;
  close?(): void;
}

const LIBSQL_CAPABILITIES: AdapterCapabilities = {
  maxBoundParams: 900,
  maxBatchStatements: 500,
  supportsUdf: false, // set per client, once we know whether create_function exists
  multiStatementExec: false, // batch() is safer and atomic-ish; executeMultiple is not staged
  maxStatementBytes: 0,
};

async function rowsOf(
  client: LibsqlClientLike,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const result = await client.execute(params.length > 0 ? { sql, args: params } : sql);
  return rowObjects(result?.rows ?? [], result?.columns);
}

export function libsqlAdapter(client: LibsqlClientLike): Adapter {
  const attach = client.create_function ?? client.createFunction;
  const capabilities: AdapterCapabilities = {
    ...LIBSQL_CAPABILITIES,
    supportsUdf: typeof attach === 'function',
  };
  return {
    name: 'libsql',
    capabilities,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (!returnsRows(sql)) {
        await rowsOf(client, sql, params);
        return [];
      }
      return (await rowsOf(client, sql, params)) as T[];
    },
    async exec(sql: string): Promise<void> {
      if (client.executeMultiple) {
        await client.executeMultiple(sql);
        return;
      }
      for (const statement of splitStatements(sql)) await client.execute(statement);
    },
    async batchStatements(statements: Statement[]): Promise<void> {
      if (client.batch) {
        await client.batch(
          statements.map((statement) => ({ sql: statement.sql, args: statement.params ?? [] })),
          'write',
        );
        return;
      }
      for (const statement of statements) {
        await rowsOf(client, statement.sql, statement.params ?? []);
      }
    },
    attachFunction(name: string, fn: (...args: unknown[]) => unknown): boolean {
      if (!attach) return false;
      (attach as (name: string, fn: (...args: unknown[]) => unknown) => unknown).call(client, name, fn);
      return true;
    },
  };
}
