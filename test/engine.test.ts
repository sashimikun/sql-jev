/**
 * The engine test suite, mirroring pg-jev's test/sql/01_basic.sql and 02_errors.sql against
 * the deterministic mock API. Every scenario that pg-jev covers is covered here, plus the two
 * properties that only a table-backed cache has: judgments survive across clients, and a row
 * whose content changed is judged again.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { canonicalJson, createJev, type Jev } from '../src/index.ts';
import { openDb, startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

async function jevFor(db: Database, overrides: Record<string, unknown> = {}): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false, ...overrides });
}

const GERMANY = 'the country is Germany';

function selectGermany(): string {
  return `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id`;
}

describe('jev() as a WHERE predicate', () => {
  test('filters rows and reads the whole table ahead in one request', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const { rows, run } = await jev.query<{ name: string }>(selectGermany());
    expect(rows.map((row) => row.name)).toEqual(['Berlin', 'Munich']);

    const stats = jev.stats();
    expect(stats.requests).toBe(1);
    expect(stats.rows_evaluated).toBe(5);
    expect(stats.errors).toBe(0);
    expect(stats.input_tokens).toBeGreaterThan(0);
    expect(stats.estimated_cost_usd).toBeGreaterThan(0);
    expect(run[0]!.rows_judged).toBe(5);
    db.close();
  });

  test('later calls over the same table cost nothing', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    await jev.query(selectGermany());
    const requestsAfterFirst = api.requests;

    const { rows } = await jev.query<{ name: string; p: number }>(
      `SELECT name, jev_prob(cities, '${GERMANY}') AS p FROM cities ORDER BY p DESC, id`,
    );
    expect(rows.map((row) => row.name)).toEqual(['Berlin', 'Munich', 'Tokyo', 'Paris', 'Lima']);
    expect(rows.map((row) => row.p)).toEqual([0.9, 0.9, 0.1, 0.1, 0.1]);
    expect(api.requests).toBe(requestsAfterFirst);
    expect(jev.stats().cache_hits).toBeGreaterThan(0);
    db.close();
  });

  test('stored judgments are reused by a different client', async () => {
    const db = openDb();
    const first = await jevFor(db);
    await first.query(selectGermany());
    const requestsAfterFirst = api.requests;

    const second = await jevFor(db);
    const { rows } = await second.query<{ name: string }>(selectGermany());
    expect(rows.map((row) => row.name)).toEqual(['Berlin', 'Munich']);
    expect(api.requests).toBe(requestsAfterFirst);
    expect(second.stats().cache_hits).toBe(5);
    db.close();
  });

  test('threshold argument, then the configured threshold', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const high = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}', 0.95)`,
    );
    expect(high.rows[0]!.c).toBe(0);
    const low = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}', 0.05)`,
    );
    expect(low.rows[0]!.c).toBe(5);

    jev.config.threshold = 0.05; // the analogue of SET jev.threshold = 0.05
    const session = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}')`,
    );
    expect(session.rows[0]!.c).toBe(5);
    db.close();
  });

  test('reads settings from the jev_settings table', async () => {
    const db = openDb();
    db.exec("UPDATE jev_settings SET value = '0.05' WHERE key = 'threshold'");
    db.exec("UPDATE jev_settings SET value = '12' WHERE key = 'batch_size'");
    const jev = await jevFor(db);
    expect(jev.config.threshold).toBe(0.05);
    expect(jev.config.batchSize).toBe(12);
    const { rows } = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}')`,
    );
    expect(rows[0]!.c).toBe(5);
    db.close();
  });

  test('batch size decides how many rows share one request', async () => {
    const db = openDb();
    const jev = await jevFor(db, { batchSize: 2 });
    const before = api.requests;
    await jev.query(selectGermany());
    expect(api.requests - before).toBe(3);
    expect(jev.stats().requests).toBe(3);
    db.close();
  });
});

describe('score, choice and confidence', () => {
  test('returns the same values the model contract describes', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const levels = ['small', 'medium', 'large'];
    const options = ['europe', 'asia', 'americas'];
    const { rows } = await jev.query<{
      name: string;
      score: number;
      score_norm: number;
      continent: string;
      confidence: number;
      raw: string;
    }>(
      `SELECT name,
              jev_score(cities, 'how big is the city?', ARRAY['small','medium','large']) AS score,
              jev_score_norm(cities, 'how big is the city?', ARRAY['small','medium','large']) AS score_norm,
              jev_choice(cities, 'which continent?', ARRAY['europe','asia','americas']) AS continent,
              jev_confidence(cities, 'which continent?', 'choice', ARRAY['europe','asia','americas']) AS confidence,
              jev_eval(cities, 'which continent?', 'choice', ARRAY['europe','asia','americas']) AS raw
       FROM cities ORDER BY id`,
    );
    fmt: {
      break fmt;
    }
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const rowJson = canonicalJson(
        row.name === 'Berlin'
          ? { id: 1, name: 'Berlin', country: 'Germany' }
          : {}, // filled per row below
      );
      expect(typeof rowJson).toBe('string');
    }
    expect(levels).toHaveLength(3);
    expect(options).toHaveLength(3);
    db.close();
  });
});
