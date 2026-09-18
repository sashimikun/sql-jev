/**
 * Cloudflare D1 code path: no user-defined functions, 100 bound parameters per statement,
 * ~100 KB per SQL string, 1000 queries per Worker invocation. The fake binding enforces those
 * limits, so a green test means the D1 path stays inside them.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createJev, type Jev } from '../src/index.ts';
import { FakeD1, openDb, startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

const GERMANY = 'the country is Germany';

function jevFor(d1: FakeD1, db: Database, overrides: Record<string, unknown> = {}): Promise<Jev> {
  void db;
  return createJev({
    d1: d1 as never,
    apiKey: 'test-key',
    apiUrl: api.url,
    notices: false,
    ...overrides,
  });
}

describe('cloudflare D1', () => {
  test('never registers a user-defined function', async () => {
    const db = openDb();
    const jev = await jevFor(new FakeD1(db), db);
    expect(jev.adapter.name).toBe('d1');
    expect(jev.adapter.capabilities.supportsUdf).toBe(false);
    expect(jev.registerUdfs()).toBe(false);
    db.close();
  });

  test('applies the schema and answers jev() through the rewriter', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
    const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
    insert.run(1, 'Berlin', 'Germany');
    insert.run(2, 'Tokyo', 'Japan');
    insert.run(3, 'Munich', 'Germany');
    const d1 = new FakeD1(db);
    const jev = await jevFor(d1, db);

    await jev.schema();
    expect(d1.execCalls).toBeGreaterThan(0);

    const { rows, sql: rewritten } = await jev.query<{ name: string }>(
      `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id`,
    );
    expect(rows.map((row) => row.name)).toEqual(['Berlin', 'Munich']);
    expect(d1.statements.some((statement) => statement.includes('INSERT INTO jev_judgments'))).toBe(true);
    expect(rewritten).toContain('jev_judgments');
    expect(rewritten).not.toMatch(/\bjev\s*\(/);
    db.close();
  });

  test('packs a 60-row read-ahead into very few calls inside every D1 limit', async () => {
    const db = openDb({ cities: 60 });
    const d1 = new FakeD1(db, { maxBoundParams: 100, maxStatementBytes: 100_000 });
    const jev = await jevFor(d1, db);

    const execBefore = d1.execCalls;
    const batchesBefore = d1.batchCalls;
    const run = await jev.warm('cities', GERMANY);

    // 60 rows / batch_size 40 = 2 API requests
    expect(run.requests).toBe(2);
    expect(run.rows_judged).toBe(60);
    // one literal exec() script holds them all, so the query budget survives
    expect(d1.execCalls - execBefore).toBeLessThanOrEqual(2);
    expect(d1.batchCalls).toBe(batchesBefore);
    const inserts = d1.statements.filter((sql) => sql.startsWith('INSERT INTO jev_judgments'));
    expect(inserts).toHaveLength(60);
    expect((db.query('SELECT count(*) AS c FROM jev_judgments').get() as { c: number }).c).toBe(60);

    const { rows } = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}')`,
    );
    expect(rows[0]!.c).toBe(20); // every third city
    db.close();
  });

  test('a 5000-row table still stays under the parameter limit per statement', async () => {
    const db = openDb({ cities: 5000 });
    const d1 = new FakeD1(db);
    const jev = await jevFor(d1, db);
    await jev.warm('cities', GERMANY);
    expect((db.query('SELECT count(*) AS c FROM jev_judgments').get() as { c: number }).c).toBe(5000);
    db.close();
  });
});
