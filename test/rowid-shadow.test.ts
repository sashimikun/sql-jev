/**
 * Regression for the P0 that a table's OWN `rowid` column used to hijack the judgment key.
 *
 * SQLite resolves `rowid`, `_rowid_` and `oid` to the real rowid unless the table declares a
 * column with that spelling. A user column named `rowid` therefore shadowed the handle: two rows
 * shared one judgment (a duplicated value, or NULL and '' both landing on the same key), so jev()
 * could return another row's answer. Both halves of the judgment now use `_rowid_` - the
 * read-ahead in src/engine.ts and the rewritten lookup in src/rewrite.ts - and this test pins the
 * agreement, because changing only one half silently returns zero rows for such tables.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { analyzeSql, createJev, rewriteSql, type Jev } from '../src/index.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

/** A table whose user column is literally named `rowid`, with duplicate, NULL and '' values. */
function shadowDb(): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE notes (uid INTEGER PRIMARY KEY, rowid TEXT, note TEXT)');
  const insert = db.prepare('INSERT INTO notes (uid, rowid, note) VALUES (?, ?, ?)');
  insert.run(1, 'dup', 'healthcare, Rotterdam');
  insert.run(2, 'dup', 'banking, Madrid');
  insert.run(3, null, 'healthcare, Osaka');
  insert.run(4, '', 'logistics, Lisbon');
  return db;
}

async function jevFor(db: Database): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false });
}

describe('a table that declares its own column named rowid', () => {
  test('judges every row separately, even with duplicate, NULL and empty user values', async () => {
    const db = shadowDb();
    const jev = await jevFor(db);

    const { rows, sql } = await jev.query<{ uid: number; note: string }>(
      `SELECT uid, note FROM notes WHERE jev(notes, 'the note is healthcare') ORDER BY uid`,
    );

    // Both healthcare rows, and neither of the others: with the shadowed handle, rows 1 and 2
    // collided on 'dup' and rows 3 and 4 on '', so an answer could be applied to the wrong row.
    expect(rows.map((row) => row.uid)).toEqual([1, 3]);

    // The generated lookup must key off the un-shadowable spelling.
    expect(sql).toContain('_rowid_');
    expect(sql).not.toMatch(/CAST\("notes"\.rowid AS TEXT\)/);

    // Four distinct judgments keyed by the REAL rowid: one per row, no collisions.
    const stored = db
      .query('SELECT row_ref, count(*) AS n FROM jev_judgments GROUP BY row_ref ORDER BY row_ref')
      .all() as { row_ref: string; n: number }[];
    expect(stored.map((row) => row.row_ref)).toEqual(['1', '2', '3', '4']);
    expect(stored.every((row) => row.n === 1)).toBe(true);

    // A second run is free, and still returns the same rows through the lookup path.
    const before = api.requests;
    const again = await jev.query<{ uid: number }>(
      `SELECT uid FROM notes WHERE jev(notes, 'the note is healthcare') ORDER BY uid`,
    );
    expect(api.requests).toBe(before);
    expect(again.rows.map((row) => row.uid)).toEqual([1, 3]);

    db.close();
  });

  test('the rewriter alone already emits _rowid_ for such a table', () => {
    const sql = `SELECT uid FROM notes WHERE jev(notes, 'x')`;
    const rewritten = rewriteSql(sql, analyzeSql(sql).calls, 0.5);
    expect(rewritten).toContain('CAST("notes"._rowid_ AS TEXT)');
    expect(rewritten).not.toContain('CAST("notes".rowid');
  });
});
