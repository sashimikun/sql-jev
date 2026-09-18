/**
 * Engine dogfood regressions. Every test here was written from a reproduced defect (or a
 * reproduced property) found while exercising src/engine.ts, src/api.ts, src/sql.ts and
 * src/config.ts against a real model and against scripted servers. No test in this file calls
 * the live API: the mock endpoint and local scripted servers are the only network.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RETRY, postSystemOne, type SystemOneRequest } from '../src/api.ts';
import { canonicalJson, judgmentKey, jsonSafeRow, sha256Hex } from '../src/sql.ts';
import { JevError, createJev, resolveConfig, type Jev, type JevConfig } from '../src/index.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { openDb, startMockApi, mockResponse, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

const GERMANY = 'the country is Germany';

async function jevFor(db: Database, overrides: Record<string, unknown> = {}): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false, ...overrides });
}

function citiesDb(count: number): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
  for (let i = 1; i <= count; i += 1) {
    insert.run(i, `City ${i}`, i % 3 === 0 ? 'Germany' : 'Japan');
  }
  return db;
}

/**
 * A local endpoint that records every request body and answers with the mock's contract, so a
 * test can see exactly what the engine would have sent to TypeSafe. `delayMs` widens the window
 * between two concurrent statements (see the spend-guard tests).
 */
function capturingApi(options: { delayMs?: number; delayFor?: string } = {}) {
  const bodies: string[] = [];
  let seen = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const body = await request.text();
      bodies.push(body);
      seen += 1;
      if (options.delayMs && seen === 1 && (!options.delayFor || body.includes(options.delayFor))) {
        await Bun.sleep(options.delayMs);
      }
      const { status, body: answer } = mockResponse(body, request.headers.get('authorization'));
      return new Response(JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    url: `${server.url.origin}/v1/systemone`,
    bodies,
    stop: () => server.stop(true),
  };
}

/** A local endpoint with scripted responses, for the retry / timeout / error paths. */
function scriptedApi(script: (attempt: number, body: string) => Response | Promise<Response>) {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      attempts += 1;
      return script(attempts, await request.text());
    },
  });
  return {
    url: `${server.url.origin}/v1/systemone`,
    get attempts() {
      return attempts;
    },
    stop: () => server.stop(true),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ONE_ANSWER = { answers: { r0: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 7 } };

// ---------------------------------------------------------------- prefetch coverage

describe('rows past jev.max_prefetch_rows', () => {
  test('are refused by default instead of silently failing jev()', async () => {
    const db = citiesDb(10);
    const jev = await jevFor(db, { maxPrefetchRows: 4 });
    const error = await jev
      .query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`)
      .catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(JevError);
    expect((error as Error).message).toContain('more rows than jev.max_prefetch_rows = 4');
    expect((error as Error).message).toContain('silently drops those rows');
    expect((error as Error).message).toContain('prefetchOverflow');
    // Nothing was sent: the refusal happens before the API call.
    expect(jev.stats().requests).toBe(0);
    db.close();
  });

  test('the default would otherwise have returned 1 of 3 matching rows (the silent-wrongness proof)', async () => {
    const db = citiesDb(10);
    const jev = await jevFor(db, { maxPrefetchRows: 4, prefetchOverflow: 'partial' });
    const warnings: string[] = [];
    jev.config.notices = false; // 'partial' must warn even when ordinary notices are off
    jev.config.onNotice = (message) => warnings.push(message);
    const { rows } = await jev.query<{ name: string }>(
      `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id`,
    );
    expect(rows.map((row) => row.name)).toEqual(['City 3']); // City 6 and City 9 are dropped
    expect(warnings.join('\n')).toContain('more rows than jev.max_prefetch_rows');
    db.close();
  });

  test('a relation holding exactly max_prefetch_rows rows is complete, not truncated', async () => {
    const db = citiesDb(4);
    const jev = await jevFor(db, { maxPrefetchRows: 4 });
    const { rows } = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}')`,
    );
    expect(rows[0]!.c).toBe(1);
    expect(jev.stats().rows_evaluated).toBe(4);
    db.close();
  });

  test('max_prefetch_rows = 0 is rejected as configuration, not answered with no rows', () => {
    expect(() => resolveConfig({ maxPrefetchRows: 0 })).toThrow(/max_prefetch_rows must be/);
  });
});

// ---------------------------------------------------------------- spend guards, concurrently

describe('spend guards are per statement, not per instance', () => {
  test('two statements running at once each keep their own budget', async () => {
    const db = citiesDb(15);
    const jev = await jevFor(db, { maxRowsPerStatement: 40, batchSize: 5 });
    const twoGroups = `SELECT count(*) AS c FROM cities
        WHERE jev(cities, 'the city is germany') AND jev_prob(cities, 'the city is japan') > 0.05`;
    // A different judgment key on purpose: reusing 'the city is japan' here would race with the
    // other statement's own read-ahead of the same rows, and whichever statement found the other's
    // judgments already persisted would judge fewer rows -- a flaky counter, not a budget test.
    const oneGroup = `SELECT count(*) AS c FROM cities WHERE jev(cities, 'the city is japan and large')`;
    // 30 rows + 15 rows: each statement is inside maxRowsPerStatement = 40, so neither may fail.
    const [a, b] = await Promise.all([jev.query(twoGroups), jev.query(oneGroup)]);
    expect(a.rows[0]).toBeDefined();
    expect(b.rows[0]).toBeDefined();
    expect(jev.stats().rows_evaluated).toBe(45);
    db.close();
  });

  test('a statement over the limit fails while its neighbour is unaffected', async () => {
    const db = citiesDb(30);
    const jev = await jevFor(db, { maxRowsPerStatement: 40, batchSize: 10 });
    const over = `SELECT count(*) AS c FROM cities
        WHERE jev(cities, 'the city is germany') AND jev_prob(cities, 'the city is japan') > 0.05`;
    const fine = `SELECT count(*) AS c FROM cities WHERE jev(cities, 'the city is japan and large')`;
    const [overResult, fineResult] = await Promise.allSettled([jev.query(over), jev.query(fine)]);
    expect(overResult.status).toBe('rejected');
    expect((overResult as PromiseRejectedResult).reason.message).toContain('60 rows');
    // The neighbour sent 30 rows and must not be blamed for the other statement's 60.
    expect(fineResult.status).toBe('fulfilled');
    db.close();
  });
});

// ---------------------------------------------------------------- the in-process mirror

describe('the in-process cache mirror', () => {
  test('makes a repeat JS row API call free even with persistJudgments: false', async () => {
    const db = citiesDb(0);
    const jev = await jevFor(db, { persistJudgments: false });
    const rows = [{ id: 1, name: 'Berlin', country: 'Germany' }];
    const before = api.requests;
    const first = await jev.prob(rows, GERMANY);
    expect(api.requests - before).toBe(1);
    const second = await jev.prob(rows, GERMANY);
    expect(second).toEqual(first);
    expect(api.requests - before).toBe(1); // the mirror answered, nothing was sent
    expect(jev.stats().cache_hits).toBe(1);
    expect(jev.stats().rows_evaluated).toBe(1);
    db.close();
  });

  test('still re-judges a row whose content changed', async () => {
    const db = citiesDb(0);
    const jev = await jevFor(db, { persistJudgments: false });
    const before = api.requests;
    await jev.prob([{ id: 1, name: 'Berlin', country: 'Germany' }], GERMANY);
    await jev.prob([{ id: 1, name: 'Munich', country: 'Germany' }], GERMANY);
    expect(api.requests - before).toBe(2);
    db.close();
  });

  test('refuses SQL that would read an empty judgment table', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db, { persistJudgments: false });
    const error = await jev
      .query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`)
      .catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(JevError);
    expect((error as Error).message).toContain('persistJudgments: false');
    expect(jev.stats().requests).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------- row serialization

describe('what a row looks like on the wire', () => {
  test('a BLOB is hex, not a fake {"0":..} object', async () => {
    const capture = capturingApi();
    const db = citiesDb(0);
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, blob BLOB, note TEXT)');
    db.prepare('INSERT INTO docs (id, blob, note) VALUES (?, ?, ?)').run(
      1,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      "héllo 🙃 o'brien",
    );
    const jev = await createJev({ db, apiKey: 'test-key', apiUrl: capture.url, notices: false });
    await jev.query(`SELECT id FROM docs WHERE jev(docs, 'the note is hello')`);
    const body = capture.bodies[0] as string;
    expect(body).toContain('\\\\xdeadbeef');
    expect(body).not.toContain('"blob":{"0"');
    expect(body).toContain('héllo 🙃');
    capture.stop();
    db.close();
  });

  test('BigInt, Date, Map, Set, NaN and nested objects survive, and the hash matches the body', async () => {
    const capture = capturingApi();
    const db = citiesDb(0);
    const jev = await createJev({ db, apiKey: 'test-key', apiUrl: capture.url, notices: false });
    const row = {
      id: 9007199254740993n,
      small: 7n,
      when: new Date('2024-01-02T03:04:05.000Z'),
      tags: new Set(['a', 'b']),
      meta: new Map<string, unknown>([['k', 1]]),
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      nested: { b: 2, a: [1, { z: null }] },
      skipped: undefined,
    };
    await jev.prob([row], 'the row is fine');
    const sent = JSON.parse(capture.bodies[0] as string).state.rows[0] as Record<string, unknown>;
    expect(sent['id']).toBe('9007199254740993'); // exact, as a string: JSON has no such integer
    expect(sent['small']).toBe(7);
    expect(sent['when']).toBe('2024-01-02T03:04:05.000Z');
    expect(sent['tags']).toEqual(['a', 'b']);
    expect(sent['meta']).toEqual({ k: 1 });
    expect(sent['nan']).toBeNull();
    expect(sent['inf']).toBeNull();
    expect(sent['nested']).toEqual({ b: 2, a: [1, { z: null }] });
    expect('skipped' in sent).toBe(false);
    // The row hash covers exactly what the model was sent: the cache key cannot drift from the body.
    expect(canonicalJson(row)).toBe(JSON.stringify(jsonSafeRow(row)));
    capture.stop();
    db.close();
  });

  test('a cyclic row fails loudly instead of recursing', async () => {
    const db = citiesDb(0);
    const jev = await jevFor(db);
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic['self'] = cyclic;
    const error = await jev.prob([cyclic], GERMANY).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(JevError);
    expect((error as Error).message).toContain('cycle');
    db.close();
  });

  test('canonicalJson keeps JSON.stringify agreement for the hostile values', () => {
    const values: Record<string, unknown>[] = [
      { a: undefined, b: null, c: 1.5, d: 'x' },
      { date: new Date(0), bin: new Uint8Array([0, 255]) },
      { fn: () => 1, sym: Symbol('s') },
      { n: [Number.NaN, Number.POSITIVE_INFINITY, 3] },
      { nested: { z: [1, 'two', { three: 3 }] } },
    ];
    for (const row of values) {
      // canonicalJson sorts object keys (a stable hash must not depend on insertion order), so the
      // agreement with JSON.stringify is about the values, not the byte order of the keys.
      expect(JSON.parse(canonicalJson(row))).toEqual(JSON.parse(JSON.stringify(jsonSafeRow(row))));
      // An object key whose value is `undefined` is dropped, exactly as JSON.stringify drops it.
      for (const key of Object.keys(row)) {
        if (row[key] === undefined) expect(canonicalJson(row)).not.toContain(`"${key}"`);
      }
    }
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}'); // sorted, not insertion-ordered
  });

  test('a NUL in a condition is refused rather than truncated by SQLite', () => {
    expect(() => judgmentKey('noul', 'a\u0000b', null)).toThrow(/NUL/);
  });
});

// ---------------------------------------------------------------- judgment identity

describe('judgment identity and hostile conditions', () => {
  test('quotes, backslashes, newlines, U+001F and emoji cannot inject or collide', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    const hostile = [
      `the name is O'Brien`,
      `the name is '); DROP TABLE cities; --`,
      'the name is a\\b',
      'the name is a\nb',
      'the name\u001fis a',
      'the name is 🇩🇪',
    ];
    for (const condition of hostile) {
      await jev.warm('cities', condition);
    }
    expect(
      (db.query('SELECT count(*) AS c FROM cities').get() as { c: number }).c,
    ).toBe(3); // the table is still there
    const keys = db
      .query<{ k: string }, []>('SELECT DISTINCT judgment_key AS k FROM jev_judgments')
      .all();
    expect(keys).toHaveLength(hostile.length); // one judgment per condition, no shared cache entry
    for (const condition of hostile) {
      // The rewritten statement finds the same judgment the warm-up stored.
      const { rows } = await jev.query<{ c: number }>(
        `SELECT count(*) AS c FROM cities WHERE jev(cities, ${sqlLiteral(condition)})`,
      );
      expect(rows).toHaveLength(1);
    }
    db.close();
  });

  test('options containing U+001F keep their own judgment key', () => {
    const a = judgmentKey('choice', 'which?', ['a\u001fb']);
    const b = judgmentKey('choice', 'which?', ['a', 'b']);
    const c = judgmentKey('choice', `which?\u001fa\u001fb`, null);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test('an identical condition reuses the judgment, a changed row is judged again', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    const before = api.requests;
    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(api.requests - before).toBe(1);
    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(api.requests - before).toBe(1); // identical content: no new request
    db.prepare('UPDATE cities SET name = ? WHERE id = 3').run('München');
    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(api.requests - before).toBe(2); // the row changed, so it was judged again
    const rows = db
      .query<{ id: number; name: string; prob: number }, []>(
        "SELECT row_ref AS id, prob FROM jev_judgments ORDER BY id",
      )
      .all();
    expect(rows).toHaveLength(3);
    db.close();
  });

  test('a row inserted after the read-ahead is judged on the next query', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    const first = await jev.query<{ name: string }>(
      `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id`,
    );
    expect(first.rows.map((row) => row.name)).toEqual(['City 3']);
    db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)').run(4, 'Hamburg', 'Germany');
    const requestsBefore = api.requests;
    const second = await jev.query<{ name: string }>(
      `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id`,
    );
    expect(second.rows.map((row) => row.name)).toEqual(['City 3', 'Hamburg']);
    expect(api.requests - requestsBefore).toBe(1); // only the new row was sent
    expect(second.run[0]!.rows_judged).toBe(1);
    expect(second.run[0]!.rows_already_judged).toBe(3);
    db.close();
  });

  test('two concurrent queries keep every judgment and count each row once', async () => {
    const db = citiesDb(12);
    const jev = await jevFor(db, { batchSize: 4, persistJudgments: true });
    const german = `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}')`;
    const japanese = `SELECT count(*) AS c FROM cities WHERE jev(cities, 'the country is Japan')`;
    const [a, b] = await Promise.all([jev.query<{ c: number }>(german), jev.query<{ c: number }>(japanese)]);
    expect(a.rows[0]!.c).toBe(4);
    expect(b.rows[0]!.c).toBe(8);
    const stored = db
      .query<{ scope: string; n: number }, []>(
        'SELECT scope, count(*) AS n FROM jev_judgments GROUP BY scope',
      )
      .all();
    expect(stored).toEqual([{ scope: 'cities', n: 24 }]);
    expect(jev.stats().rows_evaluated).toBe(24);
    expect(jev.stats().requests).toBe(6); // 24 rows / batch_size 4
    db.close();
  });
});

// ---------------------------------------------------------------- HTTP client

describe('the TypeSafe client', () => {
  function config(apiUrl: string, extra: Partial<JevConfig> = {}): JevConfig {
    return resolveConfig({ apiKey: 'test-key', apiUrl, notices: false, ...extra });
  }

  const request: SystemOneRequest = {
    model: 'jev-latest',
    state: { condition: 'x', rows: [{ id: 1 }] },
    questions: { r0: { type: 'noul' } },
  };

  test('retries a 429 and then succeeds', async () => {
    const server = scriptedApi((attempt) =>
      attempt === 1 ? json(429, { error: 'slow down' }) : json(200, ONE_ANSWER),
    );
    const previous = RETRY.baseMs;
    RETRY.baseMs = 1;
    try {
      const response = await postSystemOne(config(server.url), request);
      expect(response.answers['r0']?.noul).toBe(0.9);
      expect(server.attempts).toBe(2);
      expect(response._ms).toBeGreaterThanOrEqual(0);
    } finally {
      RETRY.baseMs = previous;
      server.stop();
    }
  });

  test('retries a 500 up to the attempt limit, then reports unreachable', async () => {
    const server = scriptedApi(() => json(500, { error: 'boom' }));
    const previousAttempts = RETRY.attempts;
    const previousBaseMs = RETRY.baseMs;
    try {
      RETRY.attempts = 3;
      RETRY.baseMs = 1;
      const error = await postSystemOne(config(server.url), request).catch((e: Error) => e);
      expect((error as Error).message).toStartWith('jev: TypeSafe API unreachable after retries: 500');
      expect((error as Error).message).toContain('boom');
      expect(server.attempts).toBe(3);
    } finally {
      RETRY.attempts = previousAttempts;
      RETRY.baseMs = previousBaseMs;
      server.stop();
    }
  });

  test('fails a 422 immediately, with the status and the body', async () => {
    const server = scriptedApi(() => json(422, { error: 'validation failed' }));
    const error = await postSystemOne(config(server.url), request).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      'jev: TypeSafe API error 422 {"error":"validation failed"}',
    );
    expect(server.attempts).toBe(1); // never retried
    server.stop();
  });

  test('reports a timeout as a timeout, after jev.timeout', async () => {
    const server = scriptedApi(async () => {
      await Bun.sleep(300);
      return json(200, ONE_ANSWER);
    });
    const previousAttempts = RETRY.attempts;
    const previousBaseMs = RETRY.baseMs;
    try {
      RETRY.attempts = 2;
      RETRY.baseMs = 1;
      const error = await postSystemOne(config(server.url, { timeoutMs: 60 }), request).catch(
        (e: Error) => e,
      );
      expect((error as Error).message).toContain('unreachable after retries: timeout after 60 ms');
      expect((error as Error).message).toContain('jev.timeout');
    } finally {
      RETRY.attempts = previousAttempts;
      RETRY.baseMs = previousBaseMs;
      server.stop();
    }
  });

  test('rejects a malformed api_url at once, and a missing key with advice', async () => {
    const badUrl = await postSystemOne(config('not a url'), request).catch((e: Error) => e);
    expect((badUrl as Error).message).toBe("jev: api_url is not a URL: 'not a url'");

    const noKey = resolveConfig({ apiUrl: 'http://127.0.0.1:1/x' });
    delete noKey.apiKey;
    const missing = await postSystemOne(noKey, request).catch((e: Error) => e);
    expect((missing as Error).message).toContain('jev: no API key');
  });

  test('a 200 without answers is an error, not an empty result set', async () => {
    const server = scriptedApi(() => json(200, { model: 'jev-x' }));
    const error = await postSystemOne(config(server.url), request).catch((e: Error) => e);
    expect((error as Error).message).toContain('returned no answers');
    expect(server.attempts).toBe(1);
    server.stop();
  });
});

// ---------------------------------------------------------------- stats

describe('stats they can be trusted with money', () => {
  test('a judged run is durable, a pure cache hit is not logged', async () => {
    const db = citiesDb(3);
    db.exec('DELETE FROM jev_runs');
    const jev = await jevFor(db);
    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    const runs = db.query<Record<string, unknown>, []>('SELECT * FROM jev_runs').all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ scope: 'cities', rows_judged: 3, requests: 1, errors: 0 });
    expect(Number(runs[0]!['input_tokens'])).toBeGreaterThan(0);

    const stats = db.query<Record<string, number>, []>('SELECT * FROM jev_stats').get()!;
    const session = jev.stats();
    expect(stats['requests']).toBe(session.requests);
    expect(stats['input_tokens']).toBe(session.input_tokens);
    expect(stats['rows_evaluated']).toBe(3);
    expect(stats['cached_answers']).toBe(3);
    expect(stats['estimated_cost_usd']).toBeCloseTo(
      Number((session.input_tokens * (0.042 / 1_000_000)).toFixed(6)),
      9,
    );

    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(db.query('SELECT count(*) AS c FROM jev_runs').get()).toEqual({ c: 1 });
    db.close();
  });

  test('a JS-only run is counted in session stats AND in jev_stats', async () => {
    const db = citiesDb(0);
    db.exec('DELETE FROM jev_runs');
    const jev = await jevFor(db);
    await jev.prob([{ id: 1, name: 'Berlin' }, { id: 2, name: 'Tokyo' }], GERMANY);
    const session = jev.stats();
    expect(session.requests).toBe(1);
    expect(session.rows_evaluated).toBe(2);
    expect(session.input_tokens).toBeGreaterThan(0);
    expect(session.estimated_cost_usd).toBe(
      Number((session.input_tokens * (0.042 / 1_000_000)).toFixed(6)),
    );

    const runs = db.query<Record<string, unknown>, []>('SELECT * FROM jev_runs').all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ scope: '@row', rows_judged: 2, requests: 1 });
    expect(Number(runs[0]!['input_tokens'])).toBe(session.input_tokens);

    const durable = db.query<Record<string, number>, []>('SELECT * FROM jev_stats').get()!;
    expect(durable['requests']).toBe(1);
    expect(durable['input_tokens']).toBe(session.input_tokens);
    expect(durable['rows_evaluated']).toBe(2);

    // The second call is a pure cache hit: same numbers, no new run row.
    await jev.prob([{ id: 1, name: 'Berlin' }, { id: 2, name: 'Tokyo' }], GERMANY);
    expect(db.query('SELECT count(*) AS c FROM jev_runs').get()).toEqual({ c: 1 });
    expect(jev.stats().cache_hits).toBe(2);
    db.close();
  });

  test('a failed batch is counted in the session and in jev_runs.errors', async () => {
    const db = citiesDb(3);
    db.exec('DELETE FROM jev_runs');
    const jev = await jevFor(db);
    const error = await jev
      .query(`SELECT name FROM cities WHERE jev(cities, 'trigger422 the country is Germany')`)
      .catch((thrown: Error) => thrown);
    expect((error as Error).message).toContain('TypeSafe API error 422');
    expect(jev.stats().errors).toBe(1);
    expect(jev.stats().requests).toBe(0);
    const runs = db.query<Record<string, unknown>, []>('SELECT * FROM jev_runs').all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ rows_judged: 0, errors: 1 });
    expect(db.query('SELECT errors FROM jev_stats').get()).toEqual({ errors: 1 });
    // The session keeps working afterwards.
    const ok = await jev.query<{ c: number }>(
      `SELECT count(*) AS c FROM cities WHERE jev(cities, '${GERMANY}')`,
    );
    expect(ok.rows[0]!.c).toBe(1);
    db.close();
  });

  test('the row hash stored in jev_judgments is sha256 of the canonical row JSON', async () => {
    const db = citiesDb(1);
    const jev = await jevFor(db);
    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    const stored = db
      .query<{ row_hash: string }, []>('SELECT row_hash FROM jev_judgments')
      .get()!;
    expect(stored.row_hash).toBe(await sha256Hex(canonicalJson({ id: 1, name: 'City 1', country: 'Japan' })));
    db.close();
  });

  test('batch_size and concurrency decide the request count, and progress notices are monotone', async () => {
    const db = citiesDb(10);
    const notices: string[] = [];
    const jev = await createJev({
      db,
      apiKey: 'test-key',
      apiUrl: api.url,
      batchSize: 4,
      concurrency: 3,
      onNotice: (message) => notices.push(message),
    });
    await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(jev.stats().requests).toBe(3);
    expect(jev.stats().batches).toBe(3);
    const progress = notices.filter((message) => message.includes('progress'));
    // pg-jev logs one line per completed request whenever there is more than one request.
    expect(progress).toHaveLength(3);
    const counts = progress.map((message) => {
      const match = /progress (\d+)\/(\d+) requests, (\d+)\/(\d+) rows/.exec(message)!;
      return [Number(match[1]), Number(match[3])];
    });
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]![0]!).toBeGreaterThan(counts[i - 1]![0]!);
      expect(counts[i]![1]!).toBeGreaterThan(counts[i - 1]![1]!);
    }
    expect(counts.at(-1)![1]).toBe(10);
    db.close();
  });
});

// ---------------------------------------------------------------- the retry budget

describe('jev.timeout bounds the whole call, retries included', () => {
  function config(apiUrl: string, extra: Partial<JevConfig> = {}): JevConfig {
    return resolveConfig({ apiKey: 'test-key', apiUrl, notices: false, ...extra });
  }

  const request: SystemOneRequest = {
    model: 'jev-latest',
    state: { condition: 'x', rows: [{ id: 1 }] },
    questions: { r0: { type: 'noul' } },
  };

  test('a hung endpoint costs one jev.timeout, not jev.timeout x 6', async () => {
    const server = scriptedApi(async () => {
      await Bun.sleep(5_000); // never answers inside the budget
      return json(200, ONE_ANSWER);
    });
    const previous = RETRY.attempts;
    try {
      // The default 6 attempts must not multiply the budget: 6 x 60 ms would be 360 ms plus
      // backoff, and the old code took jev.timeout per attempt.
      RETRY.attempts = 6;
      const started = Date.now();
      const error = await postSystemOne(config(server.url, { timeoutMs: 60 }), request).catch(
        (thrown: Error) => thrown,
      );
      const elapsed = Date.now() - started;
      expect((error as Error).message).toContain('unreachable after retries: timeout after 60 ms');
      expect(server.attempts).toBe(1); // a timeout is not retried: the budget is gone
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      RETRY.attempts = previous;
      server.stop();
    }
  });

  test('a 429 still retries while the budget lasts, and backoff never outlives it', async () => {
    const server = scriptedApi((attempt) => (attempt < 3 ? json(429, { error: 'slow' }) : json(200, ONE_ANSWER)));
    const previousAttempts = RETRY.attempts;
    const previousBaseMs = RETRY.baseMs;
    try {
      RETRY.attempts = 6;
      RETRY.baseMs = 40;
      // 200 ms of budget is enough for three attempts and two 40 ms sleeps, but not for the
      // 40 -> 80 ms backoff the third failure would ask for.
      const response = await postSystemOne(config(server.url, { timeoutMs: 200 }), request);
      expect(response.answers['r0']?.noul).toBe(0.9);
      expect(server.attempts).toBe(3);
    } finally {
      RETRY.attempts = previousAttempts;
      RETRY.baseMs = previousBaseMs;
      server.stop();
    }
  });
});

// ---------------------------------------------------------------- UDF availability

describe('registerUdfs() reports the truth about the handle', () => {
  test('a real bun:sqlite handle has no create_function, so UDF mode is off', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    expect(typeof (db as unknown as { function?: unknown }).function).toBe('undefined');
    const jev = await jevFor(db);
    expect(jev.adapter.capabilities.supportsUdf).toBe(false);
    expect(jev.registerUdfs()).toBe(false);
    db.close();
  });

  test('a handle with function() gets the whole jev* set, and re-registering is idempotent', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const names: string[] = [];
    (db as unknown as { function: unknown }).function = (name: string): void => {
      names.push(name);
    };
    const jev = await jevFor(db);
    expect(jev.registerUdfs()).toBe(true);
    expect(jev.registerUdfs()).toBe(true);
    expect(names).toContain('jev');
    expect(names).toContain('jev_stats');
    db.close();
  });
});

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

void openDb; // harness parity: the shared helper stays available to later additions
