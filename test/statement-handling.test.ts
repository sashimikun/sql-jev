/**
 * Regressions for the statement-shape P0s that a dogfooding worker found in the adapters:
 *
 *   P0-1  a leading `--`/block comment made a SELECT look like a write, so the driver's rows were
 *         dropped and jev.query() returned [] for SQL that plainly reads.
 *   P0-2  `INSERT ... RETURNING id` was treated as a write, so the row was written and the returned
 *         rows were silently discarded.
 *   P1    a multi-statement string ran only its first statement, silently (drivers drop the rest).
 *
 * Both P0s came from guessing the verb off the first 16 characters of the string. The verb is now
 * resolved from tokens, past comments and past a `WITH ... AS (...)` preamble, and any statement
 * with a top-level RETURNING is read back.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createJev, JevError, returnsRows, statementVerb, type Jev } from '../src/index.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

function citiesDb(): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
  insert.run(1, 'Berlin', 'Germany');
  insert.run(2, 'Tokyo', 'Japan');
  insert.run(3, 'Munich', 'Germany');
  return db;
}

async function jevFor(db: Database): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false });
}

describe('statement verbs are read from tokens, not from the first characters', () => {
  test('a leading comment does not hide a SELECT', () => {
    expect(statementVerb('-- explain analyze\nSELECT 1')).toBe('select');
    expect(statementVerb('/* a note */ SELECT 1')).toBe('select');
    expect(statementVerb('   \n\t-- x\n-- y\n  select 1')).toBe('select');
    expect(returnsRows('-- comment\nSELECT 1')).toBe(true);
  });

  test('a CTE preamble is not the verb: WITH ... DELETE is still a write', () => {
    expect(statementVerb('WITH t AS (SELECT 1) SELECT * FROM t')).toBe('select');
    expect(statementVerb('WITH t AS (SELECT 1) DELETE FROM cities')).toBe('delete');
    expect(returnsRows('WITH t AS (SELECT 1) DELETE FROM cities')).toBe(false);
    expect(returnsRows('WITH t (a, b) AS (SELECT 1, 2) SELECT a FROM t')).toBe(true);
  });

  test('RETURNING is a row producer, a literal is not', () => {
    expect(returnsRows("INSERT INTO t (a) VALUES (1) RETURNING id")).toBe(true);
    expect(returnsRows('UPDATE t SET a = 1 RETURNING a')).toBe(true);
    expect(returnsRows('DELETE FROM t RETURNING id')).toBe(true);
    expect(returnsRows("INSERT INTO t (note) VALUES ('returning')")).toBe(false);
    expect(returnsRows('INSERT INTO t (a) VALUES (1)')).toBe(false);
  });
});

describe('the engine reads rows back for those statements', () => {
  test('a commented jev() query returns rows instead of an empty result', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const { rows } = await jev.query<{ name: string }>(
      `-- pick the German cities\n/* and keep them ordered */\nSELECT name FROM cities WHERE jev(cities, 'the country is Germany') ORDER BY id`,
    );
    expect(rows.map((row) => row.name)).toEqual(['Berlin', 'Munich']);
    db.close();
  });

  test('INSERT ... RETURNING returns the written row', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const { rows } = await jev.query<{ id: number; name: string }>(
      "INSERT INTO cities (id, name, country) VALUES (4, 'Zurich', 'Switzerland') RETURNING id, name",
    );
    expect(rows).toEqual([{ id: 4, name: 'Zurich' }]);
    expect(db.query('SELECT count(*) AS c FROM cities').get()).toEqual({ c: 4 });
    db.close();
  });
});

describe('a script is refused by query() and accepted by exec()', () => {
  test('query() says so instead of running only the first statement', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const error = await jev
      .query("UPDATE cities SET country = 'x' WHERE id = 1; UPDATE cities SET country = 'y' WHERE id = 2")
      .catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(JevError);
    expect((error as Error).message).toContain('runs one statement');
    // Nothing ran: the silent-first-statement behaviour is what this guards against.
    expect(db.query('SELECT country FROM cities WHERE id = 1').get()).toEqual({ country: 'Germany' });
    db.close();
  });

  test('exec() runs the whole script', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    await jev.exec(
      "UPDATE cities SET country = 'x' WHERE id = 1;\nUPDATE cities SET country = 'y' WHERE id = 2;",
    );
    expect(db.query('SELECT country FROM cities WHERE id = 1').get()).toEqual({ country: 'x' });
    expect(db.query('SELECT country FROM cities WHERE id = 2').get()).toEqual({ country: 'y' });
    db.close();
  });

  test('a trailing semicolon is still one statement', async () => {
    const db = citiesDb();
    const jev = await jevFor(db);
    const { rows } = await jev.query<{ c: number }>('SELECT count(*) AS c FROM cities;');
    expect(rows[0]!.c).toBe(3);
    db.close();
  });
});
