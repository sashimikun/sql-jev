/**
 * Dogfood suite for the rewriter (rewrite-dogfooder).
 *
 * Every case here asserts two things at once:
 *   1. the rewrite (analysis fields and the SQL text), and
 *   2. that the rewritten statement is VALID SQL: `sql/sql-jev.sql` is applied to a throwaway
 *      SQLite file, tables are seeded with jev_judgments keyed by the real rowid, and the
 *      rewritten statement runs through bun:sqlite.
 *
 * A rewritten statement that cannot execute, or that reads the wrong rows, fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSql, rewriteSql } from '../src/rewrite.ts';
import { judgmentKey } from '../src/sql.ts';

const scratch = mkdtempSync(join(tmpdir(), 'sql-jev-rewrite-dogfood-'));
const SCHEMA = readFileSync(new URL('../sql/sql-jev.sql', import.meta.url), 'utf8');

let db: Database;

function openDatabase(): Database {
  const database = new Database(join(scratch, 'dogfood.db'));
  database.exec(SCHEMA);
  database.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
    INSERT INTO people VALUES (1,'ann','berlin'),(2,'bob','paris'),(3,'cid','rome');
    CREATE TABLE cities (id INTEGER PRIMARY KEY, country TEXT, name TEXT);
    INSERT INTO cities VALUES (1,'Germany','berlin'),(2,'France','paris'),(3,'Italy','rome');
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, subject TEXT);
    INSERT INTO tickets VALUES (1,'refund'),(2,'question'),(3,'outage');
    CREATE TABLE orders (id INTEGER PRIMARY KEY, person_id INT, amount REAL);
    INSERT INTO orders VALUES (1,1,10.0),(2,2,20.0),(3,1,30.0);
    -- a user column that shadows the real rowid
    CREATE TABLE shadow (uid INTEGER PRIMARY KEY, rowid TEXT, name TEXT);
    INSERT INTO shadow VALUES (10,'dup','a'),(11,'dup','b'),(12,NULL,'c');
    CREATE TABLE norowid (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    INSERT INTO norowid VALUES ('a','1'),('b','2');
    CREATE VIEW people_v AS SELECT id, name, city FROM people;
    CREATE VIEW resolved_v AS SELECT id AS rowid, name FROM people;
  `);
  return database;
}

type Values = Record<string, unknown>;

/** Seeds jev_judgments the way a warm row would have written them: keyed by the real rowid. */
function seed(
  scope: string,
  kind: string,
  condition: string,
  options: string[] | null,
  byRowRef: Record<string, Values>,
): void {
  const key = judgmentKey(kind, condition, options);
  for (const [rowRef, values] of Object.entries(byRowRef)) {
    const columns = Object.keys(values).filter((column) => column !== 'answer_json');
    db.query(
      `INSERT OR REPLACE INTO jev_judgments
         (scope,row_ref,row_hash,judgment_key,kind,condition,options_json,answer_json${columns
           .map((column) => `,${column}`)
           .join('')})
       VALUES (?${',?'.repeat(7 + columns.length)})`,
    ).run(
      scope,
      rowRef,
      `hash-${scope}-${rowRef}`,
      key,
      kind,
      condition,
      options ? JSON.stringify(options) : null,
      typeof values.answer_json === 'string' ? values.answer_json : '{}',
      ...columns.map((column) => values[column] as never),
    );
  }
}

function seedAll(): void {
  seed('people', 'noul', 'x', null, {
    '1': { prob: 0.9, answer_json: '{"type":"noul","noul":0.9}' },
    '2': { prob: 0.1 },
    '3': { prob: 0.9 },
  });
  seed('cities', 'noul', 'x', null, { '1': { prob: 0.1 }, '2': { prob: 0.9 }, '3': { prob: 0.9 } });
  seed('tickets', 'noul', 'y', null, { '1': { prob: 0.9 }, '2': { prob: 0.1 }, '3': { prob: 0.2 } });
  seed('orders', 'noul', 'x', null, { '1': { prob: 0.9 }, '2': { prob: 0.1 }, '3': { prob: 0.9 } });
  seed('main.people', 'noul', 'x', null, {
    '1': { prob: 0.9 },
    '2': { prob: 0.1 },
    '3': { prob: 0.9 },
  });
  seed('shadow', 'noul', 'x', null, {
    '10': { prob: 0.9 },
    '11': { prob: 0.1 },
    '12': { prob: 0.9 },
  });
  seed('s', 'noul', 'x', null, { '1': { prob: 0.9 } });
  seed('people', 'score', 'q', ['a', 'b'], {
    '1': { score: 1.5, levels_count: 3, label: 'b', confidence: 0.8 },
  });
  seed('people', 'score', 'how big?', ['small', 'large'], { '3': { score: 1.0, levels_count: 2 } });
  seed('people', 'choice', 'pick', ["a'b", 'c"d'], { '1': { label: "a'b" } });
}

/** Analyzes and rewrites, so a call-site failure is reported as a rewrite failure. */
function rewrite(sql: string, threshold = 0.5): string {
  const analysis = analyzeSql(sql);
  return rewriteSql(sql, analysis.calls, threshold);
}

/** Runs the rewritten statement inside a transaction that is always rolled back. */
function run(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const rewritten = rewrite(sql);
  db.exec('BEGIN');
  try {
    return db.query(rewritten).all(...(params as never[])) as Record<string, unknown>[];
  } finally {
    db.exec('ROLLBACK');
  }
}

/** Runs a DML statement, then reads `followUp`, then rolls back. */
function runDml(
  sql: string,
  followUp: string,
  params: unknown[] = [],
): { changes: number; rows: Record<string, unknown>[] } {
  const rewritten = rewrite(sql);
  db.exec('BEGIN');
  try {
    const changes = db.query(rewritten).run(...(params as never[])).changes;
    const rows = db.query(followUp).all() as Record<string, unknown>[];
    return { changes, rows };
  } finally {
    db.exec('ROLLBACK');
  }
}

beforeAll(() => {
  db = openDatabase();
  seedAll();
});

afterAll(() => {
  db?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('dogfood: the rewritten statement is valid executable SQL', () => {
  test('a bare predicate reads the real rowid and selects the warmed rows', () => {
    expect(run(`SELECT name FROM people WHERE jev(people, 'x') ORDER BY name`)).toEqual([
      { name: 'ann' },
      { name: 'cid' },
    ]);
  });

  test('the fragment keys off _rowid_, never off a user column named rowid', () => {
    // Proof that `rowid` is shadowed by a user column on this table: the plain name resolves to
    // the declared TEXT column, while `_rowid_` and `oid` still reach the real rowid.
    expect(
      db
        .query(
          `SELECT uid, "shadow".rowid AS plain, "shadow"._rowid_ AS under, "shadow".oid AS oid
           FROM shadow ORDER BY uid`,
        )
        .all(),
    ).toEqual([
      { uid: 10, plain: 'dup', under: 10, oid: 10 },
      { uid: 11, plain: 'dup', under: 11, oid: 11 },
      { uid: 12, plain: null, under: 12, oid: 12 },
    ]);

    const analysis = analyzeSql(`SELECT uid FROM shadow WHERE jev(shadow, 'x')`);
    expect(analysis.calls[0]!.rowAliasSql).toBe('"shadow"');
    const rewritten = rewriteSql(`SELECT uid FROM shadow WHERE jev(shadow, 'x')`, analysis.calls, 0.5);
    expect(rewritten).toContain('CAST("shadow"._rowid_ AS TEXT)');
    expect(rewritten).not.toContain('CAST("shadow".rowid AS TEXT)');

    // Two rows share the value 'dup' in the user column, and one is NULL: keyed off that column
    // the lookup either collapses rows or misses them entirely.
    db.exec('BEGIN');
    try {
      expect(
        db.query(rewritten).all() as Record<string, unknown>[],
      ).toEqual([{ uid: 10 }, { uid: 12 }]);
    } finally {
      db.exec('ROLLBACK');
    }
  });

  test('a table whose user rowid column repeats still gets one judgment per row', () => {
    const rewritten = rewrite(`SELECT uid FROM shadow WHERE jev_prob(shadow, 'x') > 0.5 ORDER BY uid`);
    db.exec('BEGIN');
    try {
      expect(db.query(rewritten).all()).toEqual([{ uid: 10 }, { uid: 12 }]);
    } finally {
      db.exec('ROLLBACK');
    }
  });

  test('an alias rebinding inside a subquery resolves to the inner relation', () => {
    // `p` is people outside and cities inside: the inner binding must win, or the rewrite
    // compares cities rowids against people judgments.
    const sql = `SELECT p.id FROM people p WHERE p.id IN (SELECT id FROM cities p WHERE jev(p, 'x')) ORDER BY p.id`;
    const analysis = analyzeSql(sql);
    expect(analysis.calls[0]!.relation).toBe('cities');
    expect(analysis.calls[0]!.rowAlias).toBe('p');
    expect(run(sql)).toEqual([{ id: 2 }, { id: 3 }]);
  });

  test('a correlated subquery may still use the outer alias', () => {
    // `p` is bound in the outer scope and used inside the subquery, where `c` is bound.
    expect(
      run(
        `SELECT p.id FROM people p
          WHERE EXISTS (SELECT 1 FROM cities c WHERE c.id = p.id AND jev(p, 'x'))
          ORDER BY p.id`,
      ),
    ).toEqual([{ id: 1 }, { id: 3 }]);

    expect(
      run(
        `SELECT name FROM people p WHERE EXISTS (SELECT 1 FROM orders o
           WHERE o.person_id = p.id AND jev(p, 'x')) ORDER BY name`,
      ),
    ).toEqual([{ name: 'ann' }]);
  });

  test('a CTE that only reads the real table is rewritten normally', () => {
    expect(run(`WITH c AS (SELECT * FROM people WHERE jev(people, 'x')) SELECT count(*) AS n FROM c`)).toEqual([
      { n: 2 },
    ]);
  });

  test('an INNER JOIN resolves each alias to its own relation', () => {
    expect(
      run(
        `SELECT p.name, t.subject FROM people p
           JOIN orders o ON o.person_id = p.id
           JOIN tickets t ON t.id = o.id
          WHERE jev(p, 'x') AND jev(t, 'y')`,
      ),
    ).toEqual([{ name: 'ann', subject: 'refund' }]);
  });

  test('a LEFT JOIN judges the joined table and keeps NULL handles out of the result', () => {
    expect(run(`SELECT p.name, t.subject FROM people p LEFT JOIN tickets t ON t.id = p.id WHERE jev(t, 'y')`)).toEqual(
      [{ name: 'ann', subject: 'refund' }],
    );
  });

  test('jev() in a JOIN ON clause executes', () => {
    expect(
      run(`SELECT count(*) AS n FROM people p JOIN orders o ON o.person_id = p.id AND jev(p, 'x')`),
    ).toEqual([{ n: 2 }]);
  });

  test('window functions, GROUP BY/HAVING and ORDER BY jev_prob() all execute', () => {
    expect(
      run(`SELECT name, rank() OVER (ORDER BY jev_prob(people, 'x') DESC) AS r FROM people ORDER BY name`),
    ).toEqual([
      { name: 'ann', r: 1 },
      { name: 'bob', r: 3 },
      { name: 'cid', r: 1 },
    ]);

    expect(
      run(
        `SELECT city, count(*) AS n FROM people GROUP BY city HAVING jev_prob(people, 'x') > 0.5 ORDER BY city`,
      ),
    ).toEqual([
      { city: 'berlin', n: 1 },
      { city: 'rome', n: 1 },
    ]);

    expect(run(`SELECT name, jev_prob(people, 'x') AS p FROM people ORDER BY p DESC, name LIMIT 2`)).toEqual([
      { name: 'ann', p: 0.9 },
      { name: 'cid', p: 0.9 },
    ]);
  });

  test('jev() composes with NOT, AND, OR, CASE, COALESCE and the SELECT list', () => {
    expect(run(`SELECT name FROM people WHERE NOT jev(people, 'x') OR jev_prob(people, 'x') > 0.99`)).toEqual([
      { name: 'bob' },
    ]);

    expect(
      run(
        `SELECT name, CASE WHEN jev(people, 'x') AND jev_prob(people, 'x') >= 0.9 THEN 'y' ELSE 'n' END AS v,
                COALESCE(jev_confidence(people, 'x', 'noul'), -2.0) AS c
           FROM people WHERE jev(people, 'x') OR jev_prob(people, 'x') > 0.99 ORDER BY name`,
      ),
    ).toEqual([
      { name: 'ann', v: 'y', c: -2.0 },
      { name: 'cid', v: 'y', c: -2.0 },
    ]);
  });

  test('the four option spellings all execute, including quotes inside options', () => {
    const expected = [{ c: "a'b" }];
    expect(run(`SELECT jev_choice(people, 'pick', ARRAY['a''b','c"d']) AS c FROM people WHERE id = 1`)).toEqual(expected);
    expect(run(`SELECT jev_choice(people, 'pick', json_array('a''b','c"d')) AS c FROM people WHERE id = 1`)).toEqual(
      expected,
    );
    expect(run(`SELECT jev_choice(people, 'pick', '["a''b","c\\"d"]') AS c FROM people WHERE id = 1`)).toEqual(expected);
    expect(run(`SELECT jev_choice(people, 'pick', ('a''b','c"d')) AS c FROM people WHERE id = 1`)).toEqual(expected);
  });

  test('ARRAY spacing and score/score_norm render executable SQL', () => {
    expect(run(`SELECT jev_score(people, 'q', ARRAY[ 'a' , 'b' ]) AS s FROM people WHERE id = 1`)).toEqual([{ s: 1.5 }]);
    expect(run(`SELECT jev_score_norm(people, 'q', ARRAY['a','b']) AS s FROM people WHERE id = 1`)).toEqual([
      { s: 0.75 },
    ]);
    expect(run(`SELECT jev_score(people, 'q', ARRAY['a','b']) AS s FROM people WHERE id = 2`)).toEqual([{ s: -1 }]);
  });

  test('jev_confidence and jev_eval read the warmed answer', () => {
    expect(run(`SELECT jev_confidence(people, 'q', 'score', ARRAY['a','b']) AS c FROM people WHERE id = 1`)).toEqual([
      { c: 0.8 },
    ]);
    expect(run(`SELECT jev_eval(people, 'x', 'noul') AS raw FROM people WHERE id = 1`)).toEqual([
      { raw: '{"type":"noul","noul":0.9}' },
    ]);
    // No judgment stored: NULL (confidence/eval) rather than a fabricated number.
    expect(run(`SELECT jev_confidence(people, 'q', 'score', ARRAY['a','b']) AS c FROM people WHERE id = 2`)).toEqual([
      { c: null },
    ]);
  });

  test('UPDATE ... WHERE, UPDATE ... SET and DELETE ... WHERE carry the predicate', () => {
    expect(
      runDml(`UPDATE tickets SET subject = 'z' WHERE jev(tickets, 'y')`, `SELECT subject FROM tickets WHERE id = 1`),
    ).toEqual({ changes: 1, rows: [{ subject: 'z' }] });

    expect(
      runDml(
        `UPDATE people SET name = CASE WHEN jev(people, 'x') THEN 'hot' ELSE 'cold' END WHERE id = 1`,
        `SELECT name FROM people WHERE id = 1`,
      ),
    ).toEqual({ changes: 1, rows: [{ name: 'hot' }] });

    expect(
      runDml(`UPDATE people SET name = name WHERE jev(people, 'x')`, `SELECT name FROM people WHERE id = 2`),
    ).toEqual({ changes: 2, rows: [{ name: 'bob' }] });

    expect(runDml(`DELETE FROM orders WHERE jev(orders, 'x')`, `SELECT id FROM orders`)).toEqual({
      changes: 2,
      rows: [{ id: 2 }],
    });

    expect(runDml(`DELETE FROM people AS p WHERE jev(p, 'x')`, `SELECT id FROM people`)).toEqual({
      changes: 2,
      rows: [{ id: 2 }],
    });

    expect(
      runDml(
        `INSERT INTO orders (person_id, amount) SELECT person_id, amount + 1 FROM orders WHERE jev(orders, 'x')`,
        `SELECT id FROM orders`,
      ),
    ).toEqual({ changes: 2, rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] });

    expect(
      runDml(
        `UPDATE people SET name = 'x' FROM orders o WHERE o.person_id = people.id AND jev(o, 'x')`,
        `SELECT id FROM people WHERE name = 'x'`,
      ),
    ).toEqual({ changes: 1, rows: [{ id: 1 }] });
  });

  test('? placeholders before, between and after jev calls keep their rows', () => {
    expect(run(`SELECT id FROM people WHERE name = ? AND jev(people, 'x')`, ['ann'])).toEqual([{ id: 1 }]);
    expect(run(`SELECT id FROM people WHERE jev(people, 'x') AND city = ? AND id = ?`, ['berlin', 1])).toEqual([
      { id: 1 },
    ]);
    expect(run(`SELECT id FROM people WHERE jev(people, 'x') AND id = ?`, [3])).toEqual([{ id: 3 }]);
    expect(
      run(`SELECT id FROM people WHERE id >= ? AND jev(people, 'x') AND city <> ? AND jev_prob(people, 'x') > ? ORDER BY id`, [
        1,
        'paris',
        0.5,
      ]),
    ).toEqual([{ id: 1 }, { id: 3 }]);
    // A placeholder on each side of a jev call whose own arguments contain commas and options.
    expect(
      run(
        `SELECT id FROM people WHERE name = ? AND jev_choice(people, 'pick', ARRAY['a''b','c"d']) = ?
           AND jev(people, 'x') AND id = ?`,
        ['ann', "a'b", 1],
      ),
    ).toEqual([{ id: 1 }]);
    // The threshold expression is carried through verbatim, so its placeholder stays in place.
    expect(run(`SELECT id FROM people WHERE jev(people, 'x', ?) AND id = 3`, [0.85])).toEqual([{ id: 3 }]);
    expect(run(`SELECT id FROM people WHERE jev(people, 'x', ?) AND id = 3`, [0.95])).toEqual([]);
  });

  test('explicit thresholds, trailing semicolons and mixed-case names execute', () => {
    expect(run(`SELECT id FROM people WHERE jev(people, 'x', 0.85) ORDER BY id`)).toEqual([{ id: 1 }, { id: 3 }]);
    expect(run(`SELECT name FROM people WHERE jev(people, 'x') ORDER BY name;`)).toEqual([
      { name: 'ann' },
      { name: 'cid' },
    ]);
    expect(run(`SELECT name FROM people WHERE JEV(people, 'x') AND Jev_Prob(PEOPLE, 'x') > 0.5 ORDER BY name`)).toEqual(
      [{ name: 'ann' }, { name: 'cid' }],
    );
  });

  test('tabs, newlines and comments inside the argument list execute', () => {
    expect(
      run(
        `SELECT name
           FROM people -- trailing comment
          WHERE jev(\t/* first arg */ people,
                     'x'\t)
            AND id <> /* mid-expression */ 2
          ORDER BY name`,
      ),
    ).toEqual([{ name: 'ann' }, { name: 'cid' }]);
    expect(
      run(`SELECT name FROM people WHERE jev(people, 'x') /* between the calls */ AND jev_prob(people, 'x') > 0.5 ORDER BY name`),
    ).toEqual([{ name: 'ann' }, { name: 'cid' }]);
  });

  test('quoted and schema-dotted relation names execute', () => {
    expect(run(`SELECT name FROM "people" WHERE jev("people", 'x') ORDER BY name`)).toEqual([
      { name: 'ann' },
      { name: 'cid' },
    ]);
    expect(run(`SELECT name FROM main.people WHERE jev(main.people, 'x') ORDER BY name`)).toEqual([
      { name: 'ann' },
      { name: 'cid' },
    ]);
    expect(run(`SELECT name FROM main.people WHERE jev(people, 'x') ORDER BY name`)).toEqual([
      { name: 'ann' },
      { name: 'cid' },
    ]);
  });
});

describe('dogfood: handles with no rowid fail loudly, never silently', () => {
  test('a subquery in FROM with an alias is refused, pointing at the JS row API', () => {
    expect(() => analyzeSql(`SELECT * FROM (SELECT id, name FROM people) s WHERE jev(s, 'x')`)).toThrow(
      /no rowid.*row API/s,
    );
    // Even when the subquery projects a column called rowid, which would make the rewritten
    // statement valid SQL and silently key judgments off the alias name.
    expect(() =>
      analyzeSql(`SELECT * FROM (SELECT id AS rowid, name FROM people) s WHERE jev(s, 'x')`),
    ).toThrow(/no rowid.*row API/s);
  });

  test('a CTE used as the relation is refused, pointing at the JS row API', () => {
    expect(() => analyzeSql(`WITH active AS (SELECT id FROM people) SELECT * FROM active WHERE jev(active, 'x')`)).toThrow(
      /no rowid.*row API/s,
    );
    expect(() =>
      analyzeSql(`WITH people AS (SELECT 1 AS id) SELECT * FROM people WHERE jev(people, 'x')`),
    ).toThrow(/no rowid.*row API/s);
    expect(() =>
      analyzeSql(`WITH RECURSIVE walk(n) AS (SELECT 1) SELECT * FROM walk WHERE jev(walk, 'x')`),
    ).toThrow(/no rowid.*row API/s);
    expect(() =>
      analyzeSql(`WITH n(a) AS (SELECT 1) SELECT * FROM n WHERE jev(n, 'x')`),
    ).toThrow(/no rowid.*row API/s);
    expect(() =>
      analyzeSql(`WITH t AS MATERIALIZED (SELECT 1 AS id) SELECT * FROM t WHERE jev(t, 'x')`),
    ).toThrow(/no rowid.*row API/s);
    expect(() =>
      analyzeSql(`WITH "my cte" AS (SELECT 1 AS id) SELECT * FROM "my cte" WHERE jev("my cte", 'x')`),
    ).toThrow(/no rowid.*row API/s);
  });

  test('a CTE name that is aliased onto another relation is not confused with the CTE', () => {
    const analysis = analyzeSql(`WITH people AS (SELECT 1 AS id) SELECT * FROM orders people WHERE jev(people, 'x')`);
    expect(analysis.calls[0]!.relation).toBe('orders');
    expect(analysis.calls[0]!.rowAlias).toBe('people');
  });

  test('a view or a WITHOUT ROWID table cannot be judged through SQL', () => {
    expect(() => run(`SELECT * FROM people_v WHERE jev(people_v, 'x')`)).toThrow(/rowid/);
    expect(() => run(`SELECT * FROM resolved_v WHERE jev(resolved_v, 'x')`)).toThrow(/rowid/);
    expect(() => run(`SELECT * FROM norowid WHERE jev(norowid, 'x')`)).toThrow(/rowid/);
  });

  test('a subquery given as the row argument is refused', () => {
    expect(() => analyzeSql(`SELECT * FROM people WHERE jev((SELECT id FROM cities LIMIT 1), 'x')`)).toThrow(
      /no rowid/,
    );
  });

  test('an ambiguous table name is refused instead of guessed', () => {
    expect(() => analyzeSql(`SELECT 1 FROM cities a JOIN cities b ON a.id = b.id WHERE jev(cities, 'x')`)).toThrow(
      /ambiguous/,
    );
  });

  test('a statement whose relation is not in scope still fails loudly', () => {
    // Nothing to key a rowid off, so the emitted SQL must not run and must not match rows.
    expect(() => run(`SELECT * FROM cities WHERE jev(people, 'x')`)).toThrow();
  });
});

describe('dogfood: passthrough safety', () => {
  const untouched = [
    `SELECT id, name FROM people WHERE id > 1 ORDER BY name;`,
    `WITH c AS (SELECT 1 AS k) SELECT * FROM c`,
    `SELECT 'jev(' AS s, "jev" FROM people`,
    `-- jev(people, 'x')\nSELECT 1`,
    `SELECT 1 AS jev, jev FROM people -- a column called jev`,
  ];

  test('a statement with no jev call is passed through byte-identical', () => {
    for (const sql of untouched) {
      const analysis = analyzeSql(sql);
      expect(analysis.calls).toHaveLength(0);
      expect(rewriteSql(sql, analysis.calls, 0.5)).toBe(sql);
    }
  });

  test("'jev(' inside a string literal is not a call, and a real call beside it still runs", () => {
    expect(analyzeSql(`SELECT 'jev(people, ''x'')' AS lit`).calls).toHaveLength(0);
    expect(run(`SELECT 'jev(people, ''x'')' AS lit FROM people WHERE jev(people, 'x') AND id = 1`)).toEqual([
      { lit: "jev(people, 'x')" },
    ]);
  });

  test('a column aliased as jev does not become a call', () => {
    expect(analyzeSql(`SELECT 1 AS jev FROM people WHERE id = 1`).calls).toHaveLength(0);
    expect(run(`SELECT 1 AS jev FROM people WHERE id = 1`)).toEqual([{ jev: 1 }]);
  });

  test('no rewritten statement keeps a bare jev* call', () => {
    const statements = [
      `SELECT * FROM people WHERE jev(people, 'x') AND jev_prob(people, 'x') > 0.5`,
      `SELECT jev_score(people, 'q', ARRAY['a','b']) FROM people`,
      `SELECT jev_choice(people, 'pick', json_array('a''b','c"d')) FROM people`,
      `SELECT jev_eval(people, 'x', 'noul') FROM people`,
    ];
    for (const sql of statements) {
      const rewritten = rewrite(sql);
      expect(rewritten).not.toMatch(/\bjev(_prob|_score|_score_norm|_choice|_confidence|_eval)?\s*\(/);
    }
  });
});
