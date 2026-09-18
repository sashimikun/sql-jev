/**
 * templates/d1/worker.ts -- the HTTP surface, driven directly through its fetch handler.
 *
 * Every request in this file goes to the local mock TypeSafe endpoint or to a throwaway
 * local server; the suite never touches the live API. It covers the Worker's own guards
 * (auth, read-only statements, parameter counting, LIMIT handling, request caps), the leak
 * rule (no response may contain a secret, not even the first 8 characters), and the
 * end-to-end path: schema through the D1-shaped binding -> warm -> rewritten query.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FakeD1, openDb, startMockApi, type MockApi } from './harness.ts';
import worker from '../templates/d1/worker.ts';

const TYPE_KEY = 'test-key'; // the mock API's expected bearer token
const API_TOKEN = 'api-token-0123456789abcdef';
const GERMANY = 'the country is Germany';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

interface Harness {
  db: ReturnType<typeof openDb>;
  d1: FakeD1;
  env: Record<string, unknown>;
  close(): void;
}

/** A D1-shaped binding over the harness database, with the mock API configured. */
function harness(options: { apiUrl?: string; maxRows?: string } = {}): Harness {
  const db = openDb();
  db.prepare('UPDATE jev_settings SET value = ? WHERE key = ?').run(
    options.apiUrl ?? api.url,
    'api_url',
  );
  db.prepare('UPDATE jev_settings SET value = ? WHERE key = ?').run('off', 'notices');
  const d1 = new FakeD1(db);
  return {
    db,
    d1,
    env: {
      DB: d1,
      API_TOKEN,
      TYPESAFE_API_KEY: TYPE_KEY,
      ...(options.maxRows === undefined ? { JEV_MAX_ROWS: '200' } : { JEV_MAX_ROWS: options.maxRows }),
    },
    close: () => db.close(),
  };
}

interface CallOptions {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(
  env: Record<string, unknown>,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const { token = API_TOKEN, body, headers = {} } = options;
  const initHeaders: Record<string, string> = { ...headers };
  if (token !== null) initHeaders['Authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers: initHeaders };
  if (body !== undefined) {
    initHeaders['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`https://worker.test${path}`, init), env as never, {
    waitUntil() {},
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text === '' ? null : JSON.parse(text),
    headers: response.headers,
  };
}

/** The rule from the Worker docs: no response may carry a secret, whole or in part. */
function expectNoSecret(text: string): void {
  expect(text).not.toContain(TYPE_KEY);
  expect(text).not.toContain(TYPE_KEY.slice(0, 8));
  expect(text).not.toContain(API_TOKEN);
  expect(text).not.toContain(API_TOKEN.slice(0, 8));
}

describe('d1 worker: auth and routing', () => {
  test('every private route answers 401 without a valid bearer token', async () => {
    const { env, close } = harness();
    const routes: [string, string][] = [
      ['GET', '/stats'],
      ['POST', '/query'],
      ['POST', '/warm'],
      ['POST', '/judge'],
      ['POST', '/nope'],
    ];
    for (const [method, path] of routes) {
      for (const token of [null, 'wrong-token', '']) {
        const response = await call(env, method, path, { token, body: { sql: 'SELECT 1 AS a' } });
        expect(response.status).toBe(401);
        expectNoSecret(response.text);
      }
    }
    // A bearer header with no scheme value is not a token.
    const bare = await call(env, 'GET', '/stats', { token: null, headers: { Authorization: 'Bearer' } });
    expect(bare.status).toBe(401);
    close();
  });

  test('service info and health are public, static and leak nothing', async () => {
    const { env, close } = harness();
    for (const path of ['/', '/health']) {
      const response = await call(env, 'GET', path, { token: null });
      expect(response.status).toBe(200);
      expect(response.json.service).toBe('sql-jev-worker');
      expect(response.json.routes['POST /query']).toContain('{ sql, params? }');
      expectNoSecret(response.text);
    }
    // A private route must not be guessable from a public one.
    const method = await call(env, 'GET', '/stats', { token: null });
    expect(Object.keys(method.json)).toEqual(['error']);
    close();
  });

  test('unknown route and unknown method', async () => {
    const { env, close } = harness();
    const unknown = await call(env, 'PUT', '/nope');
    expect(unknown.status).toBe(404);
    expectNoSecret(unknown.text);

    const wrongMethod = await call(env, 'GET', '/query');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.json.error).toBe('method not allowed');

    const doubled = await call(env, 'POST', '//query', { body: { sql: 'SELECT 1 AS a' } });
    expect(doubled.status).toBe(404);
    close();
  });

  test('CORS preflight needs no token and error replies keep the CORS headers', async () => {
    const { env, close } = harness();
    const preflight = await call(env, 'OPTIONS', '/query', { token: null });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');

    const denied = await call(env, 'GET', '/stats', { token: null });
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');
    close();
  });

  test('a missing API_TOKEN secret is reported as a misconfiguration, not a crash', async () => {
    const { env, close } = harness();
    delete env['API_TOKEN'];
    const response = await call(env, 'GET', '/stats');
    expect(response.status).toBe(500);
    expect(response.json.error).toContain('API_TOKEN');
    expect(response.json.error).not.toContain('worker.ts:');
    close();
  });
});

describe('d1 worker: the Worker is read-only', () => {
  test('a write hidden behind a CTE is refused and the table is untouched', async () => {
    const { env, d1, close } = harness();
    const before = 5; // openDb seeds 5 cities
    const writes = [
      'WITH t AS (SELECT 1) DELETE FROM cities WHERE id > 0',
      "WITH t AS (SELECT 1) INSERT INTO cities (id, name, country) SELECT 99, 'x', 'y'",
      "WITH t AS (SELECT 1), u AS (SELECT 2) UPDATE cities SET name = 'hacked'",
      "WITH t AS (SELECT 1) REPLACE INTO cities (id, name, country) VALUES (1, 'x', 'y')",
    ];
    for (const sql of writes) {
      const response = await call(env, 'POST', '/query', { body: { sql } });
      expect(response.status).toBe(400);
      expect(response.json.error).toContain('read-only');
    }
    const rows = await call(env, 'POST', '/query', { body: { sql: 'SELECT count(*) AS c FROM cities' } });
    expect(rows.json.rows[0].c).toBe(before);
    close();
  });

  test('a read-only CTE statement still works', async () => {
    const { env, close } = harness();
    const response = await call(env, 'POST', '/query', {
      body: {
        sql: "WITH g AS (SELECT id, name FROM cities WHERE country = 'Germany') SELECT * FROM g ORDER BY id",
      },
    });
    expect(response.status).toBe(200);
    expect(response.json.rows.map((row: { name: string }) => row.name)).toEqual(['Berlin', 'Munich']);
    close();
  });

  test('non-SELECT statements and multi-statement bodies are refused', async () => {
    const { env, d1, close } = harness();
    const cases: [string, string][] = [
      ['DELETE FROM cities', 'only SELECT/WITH'],
      ['PRAGMA table_info(cities)', 'only SELECT/WITH'],
      ['/* c */ DROP TABLE cities', 'only SELECT/WITH'],
      ['SELECT 1; DROP TABLE cities', 'exactly one statement'],
      ['SELECT 1; -- comment\nSELECT 2', 'exactly one statement'],
    ];
    for (const [sql, expected] of cases) {
      const response = await call(env, 'POST', '/query', { body: { sql } });
      expect(response.status).toBe(400);
      expect(response.json.error).toContain(expected);
    }
    expect(d1.statements.some((statement) => /drop table cities/i.test(statement))).toBe(false);
    close();
  });
});

describe('d1 worker: POST /query guards', () => {
  test('an explicit LIMIT of every spelling is respected, and the default is appended otherwise', async () => {
    const { env, close } = harness();
    const cases: [string, unknown[], number][] = [
      ['SELECT name FROM cities ORDER BY id LIMIT 2', [], 2],
      ['SELECT name FROM cities ORDER BY id LIMIT ?', [2], 2],
      ['SELECT name FROM cities ORDER BY id LIMIT ? OFFSET ?', [2, 1], 2],
      ['SELECT name FROM cities ORDER BY id LIMIT 2, 1', [], 1],
      ['SELECT name FROM cities ORDER BY id LIMIT 2 -- trailing comment', [], 2],
    ];
    for (const [sql, params, expected] of cases) {
      const response = await call(env, 'POST', '/query', { body: { sql, params } });
      expect(`${sql} -> ${response.status}`).toBe(`${sql} -> 200`);
      expect(`${sql} -> ${response.json.rows.length}`).toBe(`${sql} -> ${expected}`);
      expect(response.json.notes.some((note: string) => note.includes('appended LIMIT'))).toBe(false);
    }

    const appended = await call(env, 'POST', '/query', {
      body: { sql: "SELECT 'limit 5' AS s FROM cities" },
    });
    expect(appended.status).toBe(200);
    expect(appended.json.sql).toEndWith('LIMIT 200');
    expect(appended.json.notes.some((note: string) => note.includes('appended LIMIT 200'))).toBe(true);

    // A LIMIT inside a subquery does not bound the outer statement.
    const nested = await call(env, 'POST', '/query', {
      body: { sql: 'SELECT name FROM (SELECT name FROM cities LIMIT 2)' },
    });
    expect(nested.json.sql).toEndWith('LIMIT 200');

    // A VALUES list cannot take a LIMIT clause, so none may be appended.
    const values = await call(env, 'POST', '/query', {
      body: { sql: 'WITH t AS (SELECT 1) VALUES (1), (2)' },
    });
    expect(`${values.status} ${values.text}`).toStartWith('200');
    expect(values.json.rows.length).toBe(2);

    // The appended bound must not silently change an aggregate.
    const counted = await call(env, 'POST', '/query', {
      body: { sql: 'SELECT count(*) AS c FROM cities' },
    });
    expect(counted.json.rows[0].c).toBe(5);
    close();
  });

  test('the bound-parameter count is checked before D1 sees the statement', async () => {
    const { env, d1, close } = harness();
    const cases: [string, unknown[], number][] = [
      ['SELECT ? AS a', [], 400],
      ['SELECT 1 AS a', [1, 2, 3], 400],
      ['SELECT ? AS a', 'oops', 400],
      ['SELECT ?2 AS b, ?1 AS a', ['x', 'y'], 200],
      ["SELECT 'a?b' AS s FROM cities WHERE id = ?", [1], 200],
      ['SELECT :x AS a', [7], 200],
    ];
    for (const [sql, params, expected] of cases) {
      const response = await call(env, 'POST', '/query', { body: { sql, params } });
      expect(response.status).toBe(expected);
    }

    const tooMany = await call(env, 'POST', '/query', {
      body: { sql: `SELECT ${Array(101).fill('?').join(',')}`, params: Array(101).fill(1) },
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error).toContain('at most 100');
    expect(d1.statements.some((statement) => statement.includes('SELECT ?,?'))).toBe(false);
    close();
  });

  test('statement and body caps', async () => {
    const { env, close } = harness();
    const tooLong = await call(env, 'POST', '/query', {
      body: { sql: `SELECT '${'x'.repeat(150_000)}' AS s` },
    });
    expect(tooLong.status).toBe(413);
    expectNoSecret(tooLong.text);

    const tooBig = await call(env, 'POST', '/query', {
      body: { sql: `SELECT '${'x'.repeat(1_100_000)}' AS s` },
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.error).toContain('larger than');
    close();
  });

  test('a jev() call inside a string literal is data, not a call', async () => {
    const { env, close } = harness();
    const before = api.requests;
    const response = await call(env, 'POST', '/query', {
      body: { sql: `SELECT 'jev(cities, ''${GERMANY}'')' AS s` },
    });
    expect(response.status).toBe(200);
    expect(response.json.rows[0].s).toBe(`jev(cities, '${GERMANY}')`);
    expect(response.json.run).toEqual([]);
    expect(response.json.sql).toContain("jev(cities, ''");
    expect(response.json.notes.join(' ')).toContain('no jev() calls');
    expect(api.requests).toBe(before); // a literal must not reach the model
    close();
  });

  test('invalid bodies are 400s, never 500s', async () => {
    const { env, close } = harness();
    for (const body of ['{oops', '[1,2]', '']) {
      const response = await call(env, 'POST', '/query', { body });
      expect(response.status).toBe(400);
      expectNoSecret(response.text);
    }
    const missing = await call(env, 'POST', '/query', { body: {} });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain('sql');
    close();
  });
});

describe('d1 worker: POST /warm and POST /judge', () => {
  test('kind and options are validated', async () => {
    const { env, close } = harness();
    const cases: [unknown, number, string][] = [
      [{ relation: 'cities', condition: 'q', kind: 'bogus' }, 400, 'kind must be one of'],
      [{ relation: 'cities', condition: 'q', kind: 'choice' }, 400, 'needs options'],
      [{ relation: 'cities', condition: 'q', kind: 'score' }, 400, 'needs options'],
      [{ relation: 'cities', condition: 'q', options: ['a', 'b'] }, 400, 'only apply to kind'],
      [{ relation: 'cities', condition: 'q', kind: 'choice', options: ['a', 'a'] }, 400, 'must not repeat'],
      [{ relation: 'cities', condition: 'q', kind: 'choice', options: [1, 2] }, 400, 'non-empty strings'],
      [{ relation: 'cities', condition: 'q', kind: 'choice', options: 'a,b' }, 400, 'array of strings'],
      [{ condition: 'q' }, 400, 'relation'],
    ];
    for (const [body, status, expected] of cases) {
      const response = await call(env, 'POST', '/warm', { body });
      expect(response.status).toBe(status);
      expect(response.json.error).toContain(expected);
      expectNoSecret(response.text);
    }

    const ok = await call(env, 'POST', '/warm', {
      body: { relation: 'cities', condition: 'which country?', kind: 'choice', options: ['germany', 'japan'] },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.run.kind).toBe('choice');
    expect(ok.json.run.rows_judged).toBe(5);
    close();
  });

  test('a relation that does not exist reports the read-ahead failure, not a stack trace', async () => {
    const { env, close } = harness();
    const response = await call(env, 'POST', '/warm', { body: { relation: 'nope', condition: 'x' } });
    expect(response.status).toBe(500);
    expect(response.json.error).toContain('cannot read ahead');
    expect(response.json.error).not.toContain('worker.ts:');
    expect(response.json.error).not.toContain('\n');
    expectNoSecret(response.text);
    close();
  });

  test('/judge validates rows and mode, and annotate/filter agree', async () => {
    const { env, close } = harness();
    const bad: [unknown, number, string][] = [
      [{ rows: [], condition: 'x', mode: 'bogus' }, 400, 'mode must be'],
      [{ rows: 'x', condition: 'x' }, 400, 'rows must be an array'],
      [{ rows: [1, 2], condition: 'x' }, 400, 'every entry of rows'],
      [{ rows: Array(5001).fill({ a: 1 }), condition: 'x' }, 413, 'at most 5000'],
    ];
    for (const [body, status, expected] of bad) {
      const response = await call(env, 'POST', '/judge', { body });
      expect(response.status).toBe(status);
      expect(response.json.error).toContain(expected);
    }

    const rows = [{ name: 'Ada', country: 'Germany' }, { name: 'Grace' }, { name: 'Alan' }];
    const annotate = await call(env, 'POST', '/judge', { body: { rows, condition: 'germany', mode: 'annotate' } });
    expect(annotate.status).toBe(200);
    expect(annotate.json.rows[0].jev_prob).toBe(0.9);
    expect(annotate.json.rows[1].jev_prob).toBe(0.1);

    const filter = await call(env, 'POST', '/judge', { body: { rows, condition: 'germany' } });
    expect(filter.json.count).toBe(1);
    expect(filter.json.rows[0].name).toBe('Ada');
    close();
  });
});

describe('d1 worker: secrets and failure paths', () => {
  test('an upstream error that echoes the secrets is scrubbed before it leaves', async () => {
    const leaky = Bun.serve({
      port: 0,
      fetch: (request: Request) =>
        new Response(
          JSON.stringify({
            error: `bad key ${TYPE_KEY} header ${request.headers.get('authorization') ?? ''}`,
            trace: 'at postSystemOne (/worker.ts:99:9)',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    });
    try {
      const { env, close } = harness({ apiUrl: `${leaky.url.origin}/v1/systemone` });
      const response = await call(env, 'POST', '/warm', { body: { relation: 'cities', condition: 'x' } });
      expect(response.status).toBe(500);
      expect(response.text).toContain('[redacted]');
      expectNoSecret(response.text);
      close();
    } finally {
      leaky.stop(true);
    }
  });

  test('a missing TypeSafe key is a clear 500, not a leak', async () => {
    // The engine's key order is { apiKey } -> jev_settings.api_key -> process.env.TYPESAFE_API_KEY,
    // so a developer shell that exports the real key would defeat this test. Pin all three.
    const ambient = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];
    try {
      const { env, db, close } = harness();
      // The Worker itself never caches a Jev instance -- connect() runs once per request -- so a
      // missing secret must fail on this request, not on an earlier one.
      expect((db.query("SELECT value FROM jev_settings WHERE key = 'api_key'").get() as { value: string }).value)
        .toBe('');
      delete env['TYPESAFE_API_KEY'];
      const response = await call(env, 'POST', '/query', {
        body: { sql: "SELECT name FROM cities WHERE jev(cities, 'x')" },
      });
      expect(response.status).toBe(500);
      expect(response.json.error).toContain('no API key');
      expectNoSecret(response.text);
      close();
    } finally {
      if (ambient === undefined) delete process.env['TYPESAFE_API_KEY'];
      else process.env['TYPESAFE_API_KEY'] = ambient;
    }
  });

  test('a key the upstream rejects leaks neither the key nor the upstream body', async () => {
    // The Worker passes env.TYPESAFE_API_KEY to createJev(), which beats both jev_settings.api_key
    // and the ambient process env, so this case is deterministic whatever the shell exports.
    const wrong = 'wrong-key-0123456789abcdef';
    const { env, close } = harness();
    env['TYPESAFE_API_KEY'] = wrong;
    const response = await call(env, 'POST', '/query', {
      body: { sql: "SELECT name FROM cities WHERE jev(cities, 'x')" },
    });
    // The mock answers 401 "invalid api key": a server-side secret fault is a 500, and the text
    // carries the upstream status but never the key or the raw upstream body.
    expect(response.status).toBe(500);
    expect(response.json.error).toContain('401');
    expect(response.text).not.toContain(wrong);
    expect(response.text).not.toContain(wrong.slice(0, 8));
    expectNoSecret(response.text);
    close();
  });
});

describe('d1 worker: the end-to-end path', () => {
  test('the schema applies through the binding and a jev() query returns judged rows', async () => {
    const { env, d1, close } = harness();
    const stats = await call(env, 'GET', '/stats');
    expect(stats.status).toBe(200);
    expect(stats.json.stats).toBeTruthy();

    const first = await call(env, 'POST', '/query', {
      body: { sql: `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id` },
    });
    expect(first.status).toBe(200);
    expect(first.json.rows.map((row: { name: string }) => row.name)).toEqual(['Berlin', 'Munich']);
    expect(first.json.sql).toContain('jev_judgments');
    expect(first.json.sql).not.toMatch(/\bjev\s*\(/);
    expect(first.json.run[0].requests).toBe(1);
    // The only note is the appended bound: the statement did carry a jev() call.
    expect(first.json.notes.length).toBe(1);
    expect(first.json.notes[0]).toContain('appended LIMIT 200');

    // The second run is answered from jev_judgments: zero API requests.
    const second = await call(env, 'POST', '/query', {
      body: { sql: `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') ORDER BY id` },
    });
    expect(second.json.rows.length).toBe(2);
    expect(second.json.run[0].requests).toBe(0);
    expect(second.json.run[0].rows_already_judged).toBe(5);

    // A bound parameter composes with the rewrite.
    const bounded = await call(env, 'POST', '/query', {
      body: {
        sql: `SELECT name FROM cities WHERE jev(cities, '${GERMANY}') AND id < ? ORDER BY id`,
        params: [3],
      },
    });
    expect(bounded.json.rows.map((row: { name: string }) => row.name)).toEqual(['Berlin']);

    // A plain statement says so in `notes` instead of pretending it was judged.
    const plain = await call(env, 'POST', '/query', { body: { sql: 'SELECT 1 AS a' } });
    expect(plain.json.run).toEqual([]);
    expect(plain.json.notes.join(' ')).toContain('no jev() calls');
    expect(d1.statements.some((statement) => statement.includes('INSERT INTO jev_judgments'))).toBe(true);
    close();
  });

  test('concurrent requests do not share engine state', async () => {
    const { env, close } = harness();
    const results = await Promise.all([
      call(env, 'POST', '/query', { body: { sql: `SELECT name FROM cities WHERE jev(cities, '${GERMANY}')` } }),
      call(env, 'POST', '/judge', { body: { rows: [{ n: 'germany' }, { n: 'japan' }], condition: 'germany' } }),
      call(env, 'POST', '/query', { body: { sql: `SELECT name FROM cities WHERE jev(cities, '${GERMANY}')` } }),
      call(env, 'POST', '/judge', { body: { rows: [{ n: 'germany' }], condition: 'germany' } }),
      call(env, 'GET', '/stats'),
      call(env, 'POST', '/warm', { body: { relation: 'cities', condition: GERMANY } }),
    ]);
    for (const response of results) expect(response.status).toBe(200);
    const names = results[0]!.json.rows.map((row: { name: string }) => row.name);
    expect(names).toEqual(['Berlin', 'Munich']);
    expect(results[2]!.json.rows.map((row: { name: string }) => row.name)).toEqual(['Berlin', 'Munich']);
    expect(results[3]!.json.count).toBe(1);
    close();
  });
});
