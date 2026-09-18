/**
 * Test harness: a mock TypeSafe endpoint, an in-memory SQLite database with the schema
 * applied, and a D1 binding stand-in that enforces Cloudflare's real limits so the D1 code
 * path is tested rather than assumed.
 */

import { Database } from 'bun:sqlite';
import { tokenize } from '../src/rewrite.ts';
import { SCHEMA_SQL } from '../src/schema.ts';

export { startMockApi, mockResponse, type MockApi } from '../mock/mock-api.ts';

export const CITIES = [
  { id: 1, name: 'Berlin', country: 'Germany' },
  { id: 2, name: 'Tokyo', country: 'Japan' },
  { id: 3, name: 'Paris', country: 'France' },
  { id: 4, name: 'Lima', country: 'Peru' },
  { id: 5, name: 'Munich', country: 'Germany' },
];

export function openDb(options: { cities?: number } = {}): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
  const rows = options.cities ? makeCities(options.cities) : CITIES;
  for (const city of rows) insert.run(city.id, city.name, city.country);
  return db;
}

function makeCities(count: number): { id: number; name: string; country: string }[] {
  const out: { id: number; name: string; country: string }[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({ id: i, name: `City ${i}`, country: i % 3 === 0 ? 'Germany' : 'Japan' });
  }
  return out;
}

/** Splits a SQL script on top-level semicolons, ignoring literals and comments. */
export function splitSql(script: string): string[] {
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

/**
 * A D1Database-shaped object over real SQLite that refuses what Cloudflare refuses:
 * more than 100 bound parameters per statement, or a statement over ~100 KB.
 */
export class FakeD1 {
  readonly statements: string[] = [];
  execCalls = 0;
  batchCalls = 0;

  constructor(
    private readonly db: Database,
    private readonly limits = { maxBoundParams: 100, maxStatementBytes: 100_000 },
  ) {}

  prepare(sql: string): any {
    const self = this;
    const make = (params: unknown[]): any => ({
      bind: (...values: unknown[]): any => {
        if (values.length > self.limits.maxBoundParams) {
          throw new Error(
            `D1_ERROR: too many bound parameters: ${values.length} (limit ${self.limits.maxBoundParams})`,
          );
        }
        return make(values);
      },
      all: async (): Promise<{ results: unknown[]; success: boolean }> => self.run(sql, params),
      run: async (): Promise<{ results: unknown[]; success: boolean }> => self.run(sql, params),
      first: async (): Promise<unknown> => (self.run(sql, params).results as unknown[])[0] ?? null,
    });
    return make([]);
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.execCalls += 1;
    let count = 0;
    for (const statement of splitSql(sql)) {
      if (statement.length > this.limits.maxStatementBytes) {
        throw new Error(`D1_ERROR: SQL statement too long: ${statement.length} bytes`);
      }
      this.statements.push(statement);
      this.db.exec(statement);
      count += 1;
    }
    return { count, duration: 1 };
  }

  async batch(prepared: any[]): Promise<unknown[]> {
    this.batchCalls += 1;
    const out: unknown[] = [];
    for (const statement of prepared) out.push(await statement.all());
    return out;
  }

  private run(sql: string, params: unknown[]): { results: unknown[]; success: boolean } {
    const head = sql.trimStart().slice(0, 8).toLowerCase();
    this.statements.push(sql);
    if (head.startsWith('select') || head.startsWith('with') || head.startsWith('pragma')) {
      return { results: this.db.query(sql).all(...(params as never[])), success: true };
    }
    this.db.prepare(sql).run(...(params as never[]));
    return { results: [], success: true };
  }
}
