/**
 * tag(): materialise a judgment into a real column, so the predicate becomes indexable plain SQL.
 *
 * These tests pin the properties that make it worth having:
 *   - the column is written from `jev_judgments`, so it never costs a second model call
 *   - re-running judges nothing and rewrites nothing that did not change
 *   - a changed row flips its column value (the content hash decides)
 *   - the index really exists, because that is what makes `WHERE <column> = 1` cheap
 *   - rows the model cannot score are left alone instead of being nulled
 *
 * Plus the versioned judgment key: a different model must not reuse another model's answers.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  KEY_FORMAT,
  canonicalJson,
  createJev,
  judgmentKey,
  type Jev,
} from '../src/index.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

const CITIES = [
  { id: 1, name: 'Berlin', country: 'Germany' },
  { id: 2, name: 'Tokyo', country: 'Japan' },
  { id: 3, name: 'Paris', country: 'France' },
  { id: 4, name: 'Lima', country: 'Peru' },
  { id: 5, name: 'Munich', country: 'Germany' },
];

function citiesDb(rows = CITIES): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.name, row.country);
  return db;
}

async function jevFor(db: Database, overrides: Record<string, unknown> = {}): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false, ...overrides });
}

const GERMANY = 'the country is Germany';
const GERMANY_COLUMN = 'jev_the_country_is_germany';

function columnRows(db: Database, column: string): { id: number; value: unknown }[] {
  return db
    .query(`SELECT id, "${column}" AS value FROM cities ORDER BY id`)
    .all() as { id: number; value: unknown }[];
}

function hasIndex(db: Database, name: string): boolean {
  return (
    db.query("SELECT count(*) AS c FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as {
      c: number;
    }
  ).c > 0;
}

describe('tag() writes an indexable column', () => {
  test('a noul condition becomes a 0/1 column and the predicate needs no rewriter', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);

    const result = await jev.tag('cities', GERMANY);

    expect(result.column).toBe(GERMANY_COLUMN);
    expect(result.sql_type).toBe('INTEGER');
    expect(result.column_created).toBe(true);
    expect(result.index_created).toBe(true);
    expect(result.rows_written).toBe(5);
    expect(result.predicate).toBe(`"${GERMANY_COLUMN}" = 1`);
    expect(hasIndex(db, 'cities_jev_the_country_is_germany_idx')).toBe(true);

    // The whole point: plain SQL, an index, no jev() call anywhere.
    const matches = db
      .query(`SELECT name FROM cities WHERE "${GERMANY_COLUMN}" = 1 ORDER BY id`)
      .all() as { name: string }[];
    expect(matches.map((row) => row.name)).toEqual(['Berlin', 'Munich']);

    // The values came from the judgments table, not from a second API call.
    const stored = db
      .query('SELECT count(*) AS c FROM jev_judgments WHERE scope = ?')
      .get('cities') as { c: number };
    expect(stored.c).toBe(5);

    db.close();
  });

  test('re-running spends nothing and leaves the values alone', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    await jev.tag('cities', GERMANY);
    const requests = api.requests;

    const again = await jev.tag('cities', GERMANY);
    expect(api.requests).toBe(requests);
    expect(again.rows_judged).toBe(0);
    expect(again.rows_already_judged).toBe(5);
    expect(again.column_created).toBe(false);
    expect(columnRows(db, GERMANY_COLUMN).map((row) => row.value)).toEqual([1, 0, 0, 0, 1]);
    db.close();
  });

  test('an edited row is judged again and its column flips', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    await jev.tag('cities', GERMANY);

    db.prepare("UPDATE cities SET country = 'Japan' WHERE id = 1").run();
    const after = await jev.tag('cities', GERMANY);

    expect(after.rows_judged).toBe(1);
    const rows = columnRows(db, GERMANY_COLUMN);
    expect(rows.find((row) => row.id === 1)!.value).toBe(0);
    expect(rows.filter((row) => row.value === 1).map((row) => row.id)).toEqual([5]);
    db.close();
  });

  test('threshold decides where 1 starts', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const strict = await jev.tag('cities', GERMANY, { threshold: 0.95, index: false });
    expect(strict.threshold).toBe(0.95);
    expect(strict.index_created).toBe(false);
    expect(columnRows(db, GERMANY_COLUMN).every((row) => row.value === 0)).toBe(true);
    db.close();
  });

  test('score and choice columns keep their own types and normalisation', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const levels = ['small', 'medium', 'large'];
    const options = ['europe', 'asia', 'americas'];

    const scored = await jev.tag('cities', 'how big is the city?', {
      kind: 'score',
      options: levels,
      column: 'size',
      normalise: true,
    });
    const chose = await jev.tag('cities', 'which continent?', {
      kind: 'choice',
      options,
      column: 'continent',
    });

    expect(scored.sql_type).toBe('REAL');
    expect(scored.normalised).toBe(true);
    expect(chose.sql_type).toBe('TEXT');
    expect(chose.predicate).toContain('continent');

    for (const city of CITIES) {
      const level = canonicalJson(city).length % 3;
      const row = db
        .query('SELECT size, continent FROM cities WHERE id = ?')
        .get(city.id) as { size: number; continent: string };
      expect(row.size).toBeCloseTo(level / 2, 6);
      expect(row.continent).toBe(options[level]);
    }
    db.close();
  });

  test('a custom column name and no index are honoured', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const result = await jev.tag('cities', GERMANY, { column: 'is_german', index: false });
    expect(result.column).toBe('is_german');
    expect(result.index_created).toBe(false);
    expect(hasIndex(db, 'cities_is_german_idx')).toBe(false);
    expect(
      (db.query('SELECT count(*) AS c FROM cities WHERE is_german = 1').get() as { c: number }).c,
    ).toBe(2);
    db.close();
  });

  test('refuses a column name SQLite cannot hold, and refuses to tag past the read-ahead cap', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    await expect(jev.tag('cities', GERMANY, { column: 'bad name' })).rejects.toThrow(
      /not a usable column name/,
    );

    const capped = await jevFor(db, { maxPrefetchRows: 2 });
    await expect(capped.tag('cities', GERMANY, { column: 'small_cap' })).rejects.toThrow(
      /max_prefetch_rows/,
    );
    db.close();
  });

  test('works on a table that declares its own rowid column', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('CREATE TABLE notes (uid INTEGER PRIMARY KEY, rowid TEXT, note TEXT)');
    const insert = db.prepare('INSERT INTO notes (uid, rowid, note) VALUES (?, ?, ?)');
    insert.run(1, 'dup', 'healthcare, Rotterdam');
    insert.run(2, 'dup', 'banking, Madrid');
    insert.run(3, null, 'healthcare, Osaka');
    insert.run(4, '', 'logistics, Lisbon');

    const jev = await jevFor(db);
    const result = await jev.tag('notes', 'the note is healthcare', { column: 'is_healthcare' });
    expect(result.rows_written).toBe(4);
    const rows = db
      .query('SELECT uid FROM notes WHERE is_healthcare = 1 ORDER BY uid')
      .all() as { uid: number }[];
    expect(rows.map((row) => row.uid)).toEqual([1, 3]);
    db.close();
  });
});

describe('the judgment key carries the model and the template format', () => {
  test('it is derived, and it names both components', () => {
    const key = judgmentKey('noul', 'x');
    expect(key.startsWith('noul\u001fx\u001f')).toBe(true);
    expect(key).toContain(`\u001f${KEY_FORMAT}\u001f`);
    expect(key.endsWith('\u001fjev-latest')).toBe(true);
    expect(judgmentKey('noul', 'x', null, 'jev-1.13.0')).not.toBe(key);
  });

  test('changing the model re-judges instead of reusing the old answers', async () => {
    const db = citiesDb();
    const first = await jevFor(db);
    await first.tag('cities', GERMANY, { column: 'a_col', index: false });
    const requestsAfterFirst = api.requests;

    const second = await jevFor(db, { model: 'jev-1.13.0' });
    const result = await second.tag('cities', GERMANY, { column: 'b_col', index: false });

    expect(api.requests).toBeGreaterThan(requestsAfterFirst);
    expect(result.rows_judged).toBe(5);

    const keys = db
      .query("SELECT DISTINCT judgment_key FROM jev_judgments WHERE scope = 'cities'")
      .all() as { judgment_key: string }[];
    expect(keys).toHaveLength(2);
    expect(keys.some((row) => row.judgment_key.endsWith('jev-latest'))).toBe(true);
    expect(keys.some((row) => row.judgment_key.endsWith('jev-1.13.0'))).toBe(true);
    db.close();
  });

  test('the SQL path uses the configured model in its fragment', async () => {
    const db = citiesDb();
    const jev = await jevFor(db, { model: 'jev-1.13.0' });
    const sql = await jev.translate(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(sql).toContain('jev-1.13.0');
    expect(sql).not.toContain('jev-latest');
    db.close();
  });
});
