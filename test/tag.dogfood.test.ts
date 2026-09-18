/**
 * tag() dogfood tests (round 2, tag-auditor).
 *
 * Every test here is a repro of a real attack on tag() that the round-2 brief listed. They are
 * mock-only: `startMockApi()` from the harness, plus one local scripted endpoint (still a local
 * mock, never api.typesafe.ai) to answer with a missing field, and `FakeD1` for the Cloudflare
 * shape. What they pin:
 *
 *   1. two concurrent tag() calls for the SAME new column (the loser of the ALTER race sees
 *      `duplicate column name`, which is success, not a crash)
 *   2. the process-level column cache is a cache: an external DROP COLUMN / table rebuild re-creates
 *      the column instead of failing the tag
 *   3. an empty table still gets the column and the index, and still spends nothing
 *   4. D1 shape (100 bound params, 100 KB per statement): 200 rows and 5000 rows, every statement
 *      inside both limits and every value correct row by row
 *   5. column-name edges: two conditions that slug to one column, a 40-character truncation
 *      collision, SQL keywords, a column that already exists with a different declared type
 *   6. the `jev_*` reservation: never sent to the model, never re-judged
 *   7. thresholds 0 and 1, and a row the model cannot score keeps its value instead of being NULLed
 *   8. rows_written and the predicate hint match the data
 *   9. a relation with no rowid fails with a message that names the cause
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createJev,
  sqliteAdapter,
  type Adapter,
  type Jev,
} from '../src/index.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { FakeD1, startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

const GERMANY = 'the country is Germany';
const COLUMN = 'jev_the_country_is_germany';

function citiesDb(rows = 5): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
  for (let i = 1; i <= rows; i += 1) {
    insert.run(i, `City ${i}`, i % 3 === 0 ? 'Germany' : 'Japan');
  }
  return db;
}

function jevFor(db: Database, overrides: Record<string, unknown> = {}): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false, ...overrides });
}

/** A local stand-in for the model that records what it was sent and can drop a field. */
function scriptedApi(
  answer: (row: Record<string, unknown>, condition: string) => Record<string, unknown>,
): { url: string; requests: number; bodies: any[]; stop: () => void } {
  const state = { url: '', requests: 0, bodies: [] as any[], stop: (): void => undefined };
  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      state.requests += 1;
      const body = JSON.parse(await request.text());
      state.bodies.push(body);
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions ?? {})) {
        const row = body.state?.rows?.[Number(id.slice(1))] ?? {};
        answers[id] = answer(row, String(body.state?.condition ?? ''));
      }
      return Response.json({
        model: 'jev-mock',
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  state.url = `${server.url.origin}/v1/systemone`;
  state.stop = () => server.stop(true);
  return state;
}

/**
 * Realistic round trips: on libSQL/Turso and D1 the "does the column exist?" probe and the ALTER
 * are two network calls, so two concurrent tag() calls interleave between them. bun:sqlite answers
 * both inside one microtask, which hides the race.
 */
function networkish(adapter: Adapter, ms: number): Adapter {
  return {
    ...adapter,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (/^\s*UPDATE\b/i.test(sql) && /WHERE 0\s*$/i.test(sql)) await Bun.sleep(ms);
      return adapter.query<T>(sql, params);
    },
    async exec(sql: string): Promise<void> {
      if (/^\s*ALTER TABLE\b/i.test(sql)) await Bun.sleep(ms);
      return adapter.exec(sql);
    },
  };
}

describe('tag() lifecycle', () => {
  test('two concurrent tag() calls for the same new column both succeed', async () => {
    const db = citiesDb(3);
    const jev = await createJev({
      adapter: networkish(sqliteAdapter(db), 40),
      apiKey: 'test-key',
      apiUrl: api.url,
      notices: false,
    });

    const results = await Promise.all([jev.tag('cities', GERMANY), jev.tag('cities', GERMANY)]);

    // The loser of the ALTER race gets `duplicate column name`: the column exists and holds the
    // same answers, so it is success. Exactly one call can claim it created the column.
    expect(results.map((result) => result.rows_written)).toEqual([3, 3]);
    expect(results.filter((result) => result.column_created)).toHaveLength(1);
    const rows = db.query(`SELECT id, "${COLUMN}" AS v FROM cities ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 1, v: 0 },
      { id: 2, v: 0 },
      { id: 3, v: 1 },
    ]);
    db.close();
  });

  test('a column dropped behind the process is re-created, not an error', async () => {
    const db = citiesDb(5);
    const jev = await jevFor(db);
    await jev.tag('cities', GERMANY);
    const requests = api.requests;

    db.exec(`DROP INDEX cities_${COLUMN}_idx`);
    db.exec(`ALTER TABLE cities DROP COLUMN ${COLUMN}`);
    const again = await jev.tag('cities', GERMANY);

    expect(again.column_created).toBe(true);
    expect(again.index_created).toBe(true);
    expect(again.rows_written).toBe(5);
    expect(again.rows_judged).toBe(0); // the answers are still in jev_judgments
    expect(api.requests).toBe(requests);
    const rows = db.query(`SELECT id, "${COLUMN}" AS v FROM cities ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 1, v: 0 },
      { id: 2, v: 0 },
      { id: 3, v: 1 },
      { id: 4, v: 0 },
      { id: 5, v: 0 },
    ]);
    db.close();
  });

  test('a rebuilt table (the D1/Turso migration shape) is re-tagged', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    await jev.tag('cities', GERMANY);

    db.exec('DROP TABLE cities');
    db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
    db.exec("INSERT INTO cities VALUES (1, 'Berlin', 'Germany'), (2, 'Tokyo', 'Japan')");
    const again = await jev.tag('cities', GERMANY);

    expect(again.column_created).toBe(true);
    expect(again.rows_written).toBe(2);
    expect(db.query(`SELECT id, "${COLUMN}" AS v FROM cities ORDER BY id`).all()).toEqual([
      { id: 1, v: 1 },
      { id: 2, v: 0 },
    ]);
    db.close();
  });

  test('an empty table gets the column and the index and spends nothing', async () => {
    const db = citiesDb(0);
    const jev = await jevFor(db);
    const before = api.requests;

    const result = await jev.tag('cities', GERMANY);

    expect(result.column_created).toBe(true);
    expect(result.index_created).toBe(true);
    expect(result.rows_written).toBe(0);
    expect(result.rows_judged).toBe(0);
    expect(api.requests - before).toBe(0);
    const declared = db
      .query("SELECT type FROM pragma_table_info('cities') WHERE name = ?")
      .get(COLUMN) as { type: string };
    expect(declared.type).toBe('INTEGER');
    const index = db
      .query("SELECT count(*) AS c FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(`cities_${COLUMN}_idx`) as { c: number };
    expect(index.c).toBe(1);

    // and the column is usable as soon as rows arrive
    db.exec(
      "INSERT INTO cities (id, name, country) VALUES (1, 'Berlin', 'Germany'), (2, 'Tokyo', 'Japan')",
    );
    const filled = await jev.tag('cities', GERMANY);
    expect(filled.rows_written).toBe(2);
    expect(db.query(`SELECT id, "${COLUMN}" AS v FROM cities ORDER BY id`).all()).toEqual([
      { id: 1, v: 1 },
      { id: 2, v: 0 },
    ]);
    db.close();
  });
});

describe('tag() column names', () => {
  test('two conditions that slug to one column are refused, the first keeps its values', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    await jev.tag('cities', GERMANY);

    const requests = api.requests;
    await expect(jev.tag('cities', 'the country is germany')).rejects.toThrow(
      /default tag column for noul "the country is Germany"/,
    );
    expect(api.requests).toBe(requests); // refused before the read-ahead and the model call
    expect(db.query(`SELECT id, "${COLUMN}" AS v FROM cities ORDER BY id`).all()).toEqual([
      { id: 1, v: 0 },
      { id: 2, v: 0 },
      { id: 3, v: 1 },
    ]);

    // an explicit column is the caller saying "I know": it is always allowed
    const other = await jev.tag('cities', 'the country is germany', { column: 'is_german' });
    expect(other.column).toBe('is_german');
    expect(db.query('SELECT id, is_german AS v FROM cities ORDER BY id').all()).toEqual([
      { id: 1, v: 0 },
      { id: 2, v: 0 },
      { id: 3, v: 1 },
    ]);
    db.close();
  });

  test('a 40-character truncation collision is refused', async () => {
    const db = citiesDb(2);
    const jev = await jevFor(db);
    const today = 'the customer complains about the price which is much too high today';
    const tomorrow = 'the customer complains about the price which is much too high tomorrow';
    const first = await jev.tag('cities', today);
    expect(first.column).toBe('jev_the_customer_complains_about_the_price_w');

    await expect(jev.tag('cities', tomorrow)).rejects.toThrow(/default tag column/);
    const columns = (
      db.query("SELECT name FROM pragma_table_info('cities')").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns.filter((name) => name.startsWith('jev_the_customer'))).toHaveLength(1);
    db.close();
  });

  test('SQL keywords are usable column names', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    for (const column of ['order', 'group', 'select']) {
      const result = await jev.tag('cities', GERMANY, { column, index: false });
      expect(result.predicate).toBe(`"${column}" = 1`);
      expect(db.query(`SELECT count(*) AS c FROM cities WHERE ${result.predicate}`).get()).toEqual({
        c: 1,
      });
    }
    db.close();
  });

  test('a column that already exists with a different declared type raises a notice', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, flag TEXT)');
    db.exec("INSERT INTO notes VALUES (1, 'Germany', NULL), (2, 'Japan', NULL)");
    const notices: string[] = [];
    const jev = await createJev({
      db,
      apiKey: 'test-key',
      apiUrl: api.url,
      onNotice: (message: string) => notices.push(message),
    });

    const result = await jev.tag('notes', 'the body is Germany', { column: 'flag', index: false });

    expect(result.sql_type).toBe('INTEGER');
    // SQLite's TEXT affinity stores the tag as text: the write still resolves, the type does not.
    expect(db.query('SELECT typeof(flag) AS t FROM notes WHERE id = 1').get()).toEqual({ t: 'text' });
    expect(notices.some((message) => /declared TEXT/.test(message))).toBe(true);
    // and the predicate still selects the right row, which is why this is a notice, not an error
    expect(db.query(`SELECT id FROM notes WHERE ${result.predicate}`).all()).toEqual([{ id: 1 }]);
    // a column tag() creates itself is never flagged (progress notices are fine)
    notices.length = 0;
    await jev.tag('notes', 'the body is Japan', { column: 'fresh', index: false });
    expect(notices.filter((message) => /declared/.test(message))).toEqual([]);
    db.close();
  });
});

describe('tag() and the reserved jev_ namespace', () => {
  test('jev_* columns are never sent to the model and never re-judged', async () => {
    const mock = scriptedApi(() => ({ type: 'noul', noul: 0.9 }));
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, jev_notes TEXT)');
    db.exec("INSERT INTO notes VALUES (1, 'Germany', 'private'), (2, 'Japan', 'private')");
    const jev = await createJev({
      db,
      apiKey: 'test-key',
      apiUrl: mock.url,
      notices: false,
    });

    await jev.tag('notes', 'the body is Germany', { column: 'jev_mine', index: false });
    const sent = JSON.stringify(mock.bodies.flatMap((body) => body.state.rows));
    expect(sent).not.toContain('private');
    expect(sent).not.toContain('jev_notes');
    expect(sent).not.toContain('jev_mine');

    const requests = mock.requests;
    const again = await jev.tag('notes', 'the body is Germany', { column: 'jev_mine', index: false });
    expect(mock.requests).toBe(requests);
    expect(again.rows_judged).toBe(0);
    expect(again.rows_already_judged).toBe(2);
    mock.stop();
    db.close();
  });
});

describe('tag() values', () => {
  test('threshold 0 marks every row, threshold 1 marks none of the mock 0.1/0.9 answers', async () => {
    const db = citiesDb(3);
    const jev = await jevFor(db);
    const zero = await jev.tag('cities', GERMANY, { column: 't0', threshold: 0, index: false });
    const one = await jev.tag('cities', GERMANY, { column: 't1', threshold: 1, index: false });
    expect({ zero: zero.threshold, one: one.threshold }).toEqual({ zero: 0, one: 1 });
    expect(db.query('SELECT group_concat(t0) AS v FROM cities').get()).toEqual({ v: '1,1,1' });
    expect(db.query('SELECT group_concat(t1) AS v FROM cities').get()).toEqual({ v: '0,0,0' });
    db.close();
  });

  test('a row the model cannot score keeps its old value instead of being NULLed', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    db.exec(
      "INSERT INTO notes VALUES (1, 'Germany'), (2, 'unscorable Germany'), (3, 'Japan')",
    );
    const first = await jevFor(db);
    const firstResult = await first.tag('notes', 'the body mentions Germany', { column: 'is_de', index: false });
    expect(firstResult.rows_written).toBe(3);

    // the model now answers without `noul` for the row it cannot score
    const mock = scriptedApi((row, condition) => {
      const needle = condition.trim().split(/\s+/).pop() ?? '';
      return JSON.stringify(row).toLowerCase().includes('unscorable')
        ? { type: 'noul' }
        : { type: 'noul', noul: String(row['body']).includes(needle) ? 0.9 : 0.1 };
    });
    const second = await createJev({ db, apiKey: 'test-key', apiUrl: mock.url, notices: false });
    db.exec("UPDATE notes SET body = body || '!'"); // every row changes, so every row is judged again
    const result = await second.tag('notes', 'the body mentions Germany', { column: 'is_de', index: false });

    expect(result.rows_judged).toBe(3);
    expect(result.rows_written).toBe(2); // the unscorable row is not in the UPDATE at all
    expect(db.query('SELECT id, is_de FROM notes ORDER BY id').all()).toEqual([
      { id: 1, is_de: 1 },
      { id: 2, is_de: 1 }, // kept: never NULL, never 0
      { id: 3, is_de: 0 },
    ]);
    mock.stop();
    db.close();
  });

  test('rows_written and the predicate describe the data that was written', async () => {
    const db = citiesDb(5);
    const jev = await jevFor(db);
    const noul = await jev.tag('cities', GERMANY, { index: false });
    const nonNull = db
      .query(`SELECT count(*) AS c FROM cities WHERE "${COLUMN}" IS NOT NULL`)
      .get() as { c: number };
    expect(noul.rows_written).toBe(nonNull.c);
    expect(db.query(`SELECT id FROM cities WHERE ${noul.predicate} ORDER BY id`).all()).toEqual(
      db.query(`SELECT id FROM cities WHERE "${COLUMN}" = 1 ORDER BY id`).all(),
    );

    const choice = await jev.tag('cities', 'which country?', {
      kind: 'choice',
      options: ['Germany', 'Japan'],
      column: 'pick',
      index: false,
    });
    // the predicate is runnable and selects the rows holding the option with the most rows
    const byPredicate = db
      .query(`SELECT count(*) AS c FROM cities WHERE ${choice.predicate}`)
      .get() as { c: number };
    expect(byPredicate.c).toBeGreaterThan(0);
    expect(choice.predicate).toMatch(/^"pick" = '[A-Za-z]+'$/);

    const score = await jev.tag('cities', 'how far north?', {
      kind: 'score',
      options: ['south', 'middle', 'north'],
      column: 'north',
      index: false,
    });
    expect(score.predicate).toBe('"north" >= 1');
    const scored = db
      .query(`SELECT count(*) AS c FROM cities WHERE ${score.predicate}`)
      .get() as { c: number };
    const expected = db
      .query('SELECT count(*) AS c FROM cities WHERE north >= 1')
      .get() as { c: number };
    expect(scored.c).toBe(expected.c);
    db.close();
  });

  test('a relation with no rowid says so', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, country TEXT)');
    db.exec("INSERT INTO cities VALUES (1, 'Germany')");
    db.exec('CREATE VIEW city_view AS SELECT * FROM cities');
    db.exec('CREATE TABLE wr (id INTEGER PRIMARY KEY, country TEXT) WITHOUT ROWID');
    db.exec("INSERT INTO wr VALUES (1, 'Germany')");
    const jev = await jevFor(db);

    await expect(jev.tag('city_view', GERMANY)).rejects.toThrow(/needs a rowid table/);
    await expect(jev.tag('wr', GERMANY)).rejects.toThrow(/needs a rowid table/);
    db.close();
  });
});

describe('tag() through a D1-shaped adapter', () => {
  async function d1Tag(rows: number): Promise<void> {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
    const insert = db.prepare('INSERT INTO big (id, name, country) VALUES (?, ?, ?)');
    for (let i = 1; i <= rows; i += 1) {
      insert.run(i, `Row ${i}`, i % 3 === 0 ? 'Germany' : 'Japan');
    }
    const d1 = new FakeD1(db);
    const jev = await createJev({
      d1: d1 as never,
      apiKey: 'test-key',
      apiUrl: api.url,
      notices: false,
    });

    const result = await jev.tag('big', GERMANY);

    expect(result.column_created).toBe(true);
    expect(result.index_created).toBe(true);
    expect(result.rows_written).toBe(rows);
    // every statement D1 saw is inside both of its limits
    expect(d1.statements.every((sql) => sql.length <= 100_000)).toBe(true);
    expect(d1.statements.every((sql) => (sql.match(/\?/g) ?? []).length <= 100)).toBe(true);
    // and the column was written by real UPDATEs, not by something rebuilt from their parameters
    const updates = d1.statements.filter(
      (sql) => sql.trimStart().startsWith('UPDATE') && sql.includes('CASE _rowid_'),
    );
    expect(updates.length).toBe(Math.ceil(rows / 33)); // 100 bound params / 3 params per row
    expect(updates.every((sql) => sql.includes('ELSE "jev_the_country_is_germany" END'))).toBe(true);

    // row by row, not just a count
    const all = db
      .query('SELECT id, jev_the_country_is_germany AS v FROM big ORDER BY id')
      .all() as { id: number; v: number }[];
    expect(all.length).toBe(rows);
    for (const row of all) {
      expect(row.v).toBe(row.id % 3 === 0 ? 1 : 0);
    }

    // re-tagging writes again, and still writes the same values
    const again = await jev.tag('big', GERMANY);
    expect(again.column_created).toBe(false);
    expect(again.rows_written).toBe(rows);
    expect(
      (db.query('SELECT count(*) AS c FROM big WHERE jev_the_country_is_germany = 1').get() as {
        c: number;
      }).c,
    ).toBe(Math.floor(rows / 3));
    db.close();
  }

  test('200 rows stay inside 100 bound params and 100 KB per statement', async () => {
    await d1Tag(200);
  });

  test('5000 rows stay inside 100 bound params and 100 KB per statement', async () => {
    await d1Tag(5000);
  });
});
