/**
 * key-auditor regressions (round 2): the judgment key carries the REQUESTED model and KEY_FORMAT.
 *
 * Every test here comes from a one-sided check of that change: the key must be identical on the SQL
 * path (`analyzeSql`/`rewriteSql`) and on the JS path (`specFor`/`jev.warm`/`jev.tag`), the encoding
 * must not be forgeable from the user-reachable fields (`condition`, `model`), and the key must stay
 * small enough for the statement that inlines it. No test in this file touches the live API: the
 * mock endpoint is the only network.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  KEY_FORMAT,
  KEY_SEP,
  judgmentKey,
  specFor,
  createJev,
  analyzeSql,
  rewriteSql,
  type Jev,
} from '../src/index.ts';
// MAX_CONDITION_CHARS is exported by src/sql.ts. It is not re-exported from the package root yet
// (src/index.ts is frozen this round), so the test imports it from where it lives.
import { MAX_CONDITION_CHARS } from '../src/sql.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { openDb, startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

const GERMANY = 'the country is Germany';
/** A model id the type safe deployments use as an example of a pinned version. */
const PINNED = 'jev-1.13.0';

async function jevFor(db: Database, overrides: Record<string, unknown> = {}): Promise<Jev> {
  return createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false, ...overrides });
}

/** Every judgment key stored for one relation. */
function storedKeys(db: Database, scope = 'cities'): string[] {
  return (
    db
      .query<{ k: string }, [string]>('SELECT DISTINCT judgment_key AS k FROM jev_judgments WHERE scope = ?')
      .all(scope) as { k: string }[]
  ).map((row) => row.k);
}

// -------------------------------------------------------------------- agreement

describe('one judgment serves the SQL path and the JS path', () => {
  /**
   * The rewriter builds the key for the SQL path, `specFor()` builds it for the JS path. Both are
   * asked for a key for the same (condition, model) and must answer identically -- otherwise the
   * SQL path pays for rows the JS path already judged (or worse, serves another model's answer).
   */
  test('the rewriter and specFor agree, for the default model', () => {
    const call = analyzeSql(`SELECT * FROM cities WHERE jev(cities, '${GERMANY}')`).calls[0]!;
    expect(call.judgmentKey).toBe(specFor('noul', GERMANY, null, 'jev-latest').key);
    expect(call.judgmentKey).toBe(specFor('noul', GERMANY).key); // the default argument is the same
  });

  test('the rewriter and specFor agree, for a model set through createJev', async () => {
    const db = openDb();
    const jev = await jevFor(db, { model: PINNED });
    // The engine's own spec is the one the JS path uses; compare it with the SQL path's key.
    const warm = await jev.warm('cities', GERMANY);
    expect(warm.rows_judged).toBe(5);
    const [key] = storedKeys(db);
    expect(key).toBe(specFor('noul', GERMANY, null, PINNED).key);
    const call = analyzeSql(`SELECT * FROM cities WHERE jev(cities, '${GERMANY}')`, { model: PINNED })
      .calls[0]!;
    expect(call.judgmentKey).toBe(key);
    expect((await jev.translate(`SELECT * FROM cities WHERE jev(cities, '${GERMANY}')`)).includes(`'${key}'`)).toBe(
      true,
    );
    db.close();
  });

  test('the rewriter and specFor agree, for a model set through the jev_settings row', async () => {
    const db = openDb();
    db.prepare("UPDATE jev_settings SET value = ? WHERE key = 'model'").run(PINNED);
    const jev = await jevFor(db); // no override: the row is the only source of the model
    const warm = await jev.warm('cities', GERMANY);
    expect(warm.rows_judged).toBe(5);
    const [key] = storedKeys(db);
    expect(key).toBe(specFor('noul', GERMANY, null, PINNED).key);
    expect((await jev.translate(`SELECT * FROM cities WHERE jev(cities, '${GERMANY}')`)).includes(`'${key}'`)).toBe(
      true,
    );
    expect(key.endsWith(`${KEY_SEP}${PINNED}`)).toBe(true);
    db.close();
  });

  /**
   * The cost claim in one direction: the JS path pays, the SQL path does not. The counter is the
   * mock's own request counter, so a cache miss is impossible to miss.
   */
  test('JS path first: warm() pays for the rows, the SQL path reuses them for free', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const warm = await jev.warm('cities', GERMANY);
    expect(warm.requests).toBe(1);
    const afterWarm = api.requests;

    const { rows } = await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(rows.length).toBe(2); // Berlin and Munich
    expect(api.requests - afterWarm).toBe(0);
    db.close();
  });

  test('SQL path first: query() pays, warm() then reuses it for free', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const before = api.requests;
    const { rows } = await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(rows.length).toBe(2);
    const afterQuery = api.requests;
    expect(afterQuery - before).toBeGreaterThan(0); // 5 rows, one batch, so one request

    const warm = await jev.warm('cities', GERMANY);
    expect(warm.rows_judged).toBe(0);
    expect(warm.rows_already_judged).toBe(5);
    expect(warm.requests).toBe(0);
    expect(api.requests - afterQuery).toBe(0);
    db.close();
  });

  test('the same holds for a pinned model set through the jev_settings row', async () => {
    const db = openDb();
    db.prepare("UPDATE jev_settings SET value = ? WHERE key = 'model'").run(PINNED);
    const jev = await jevFor(db);
    const { rows } = await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(rows.length).toBe(2);
    expect(api.requests).toBeGreaterThan(0);
    const afterQuery = api.requests;
    const warm = await jev.warm('cities', GERMANY);
    expect(warm.rows_already_judged).toBe(5);
    expect(api.requests - afterQuery).toBe(0);
    db.close();
  });

  test('a model change adds exactly one new key and re-judges once', async () => {
    const db = openDb();
    const first = await jevFor(db);
    await first.warm('cities', GERMANY);
    expect(storedKeys(db)).toEqual([judgmentKey('noul', GERMANY, null, 'jev-latest')]);

    const second = await jevFor(db, { model: PINNED });
    const warm = await second.warm('cities', GERMANY);
    expect(warm.rows_judged).toBe(5);
    expect(new Set(storedKeys(db))).toEqual(
      new Set([judgmentKey('noul', GERMANY, null, 'jev-latest'), judgmentKey('noul', GERMANY, null, PINNED)]),
    );
    // ... and the model that was pinned first is still free the second time.
    const again = await first.warm('cities', GERMANY);
    expect(again.requests).toBe(0);
    db.close();
  });

  test('tag() writes the same key the rewriter looks up', async () => {
    const db = openDb();
    const jev = await jevFor(db, { model: PINNED });
    // The default column name starts with `jev_`, the reserved prefix: a tag column outside that
    // prefix changes every row hash, so the rows would be judged again for a different reason.
    await jev.tag('cities', GERMANY, { index: false });
    const [key] = storedKeys(db);
    expect(key).toBe(judgmentKey('noul', GERMANY, null, PINNED));
    const afterTag = api.requests;
    const { rows } = await jev.query(
      `SELECT count(*) AS c FROM cities WHERE jev_the_country_is_germany = 1`,
    );
    expect(rows).toEqual([{ c: 2 }]);
    const { rows: viaJev } = await jev.query(`SELECT name FROM cities WHERE jev(cities, '${GERMANY}')`);
    expect(viaJev.length).toBe(2);
    expect(api.requests - afterTag).toBe(0);
    db.close();
  });
});

// --------------------------------------------------------------------- forgery

describe('a crafted condition or model cannot forge another pair\'s key', () => {
  /**
   * The pre-fix encoding was a plain join, and both `condition` (a SQL string literal may hold any
   * byte except NUL) and `model` (from `jev_settings`/the env) can contain the separator. These two
   * pairs returned the SAME key, so the second pair read the first pair's answers:
   *
   *   judgmentKey('noul', 'x\u001f\u001f1\u001fm', null, 'M')
   *   judgmentKey('noul', 'x',                     null, 'm\u001f\u001f1\u001fM')
   *
   * Both fields are escaped now, so the field boundaries cannot move.
   */
  test('a condition cannot impersonate the format and model fields', () => {
    const forgedLeft = judgmentKey('noul', `x${KEY_SEP}${KEY_SEP}1${KEY_SEP}m`, null, 'M');
    const forgedRight = judgmentKey('noul', 'x', null, `m${KEY_SEP}${KEY_SEP}1${KEY_SEP}M`);
    expect(forgedLeft).not.toBe(forgedRight);
    // A separator-free field is unchanged: the five fields sit exactly where they always did.
    expect(judgmentKey('noul', 'plain', null, 'M').split(KEY_SEP)).toEqual(['noul', 'plain', '', KEY_FORMAT, 'M']);
  });

  test('a model id containing the separator cannot steal another model\'s answers', () => {
    const honest = judgmentKey('noul', 'is it a bird?', null, 'jev-1.13.0');
    const crafted = judgmentKey('noul', 'is it a bird?', null, `jev-latest${KEY_SEP}${KEY_FORMAT}`);
    expect(crafted).not.toBe(honest);
  });

  /**
   * The escape is a bounded, decidable encoding, so the property can be *searched*: every short
   * condition over an alphabet containing the separator, crossed with hostile model ids, must map
   * to a distinct key.
   */
  test('no collision in a brute-forced space of hostile conditions and models', () => {
    const alphabet = ['a', '1', KEY_SEP];
    const conditions = [''];
    let layer = [''];
    for (let length = 1; length <= 5; length += 1) {
      const next: string[] = [];
      for (const base of layer) for (const char of alphabet) next.push(base + char);
      conditions.push(...next);
      layer = next;
    }
    const models = ['M', 'N', 'jev-latest', `a${KEY_SEP}${KEY_SEP}1${KEY_SEP}b`, `x${KEY_SEP}y`, KEY_SEP];
    const optionsList: (string[] | null)[] = [null, [], ['a']];
    const seen = new Map<string, string>();
    let tuples = 0;
    for (const kind of ['noul', 'score']) {
      for (const condition of conditions) {
        for (const options of optionsList) {
          for (const model of models) {
            tuples += 1;
            const id = JSON.stringify([kind, condition, options?.length ? options : null, model]);
            const key = judgmentKey(kind, condition, options, model);
            const owner = seen.get(key);
            if (owner === undefined) seen.set(key, id);
            else expect(owner).toBe(id); // same key only for the same judgment
          }
        }
      }
    }
    expect(tuples).toBeGreaterThan(5000);
    expect(new Set(seen.keys()).size).toBeGreaterThan(conditions.length * models.length);
  });

  test('options containing the separator still keep their own key', () => {
    const a = judgmentKey('choice', 'which?', ['a\u001fb']);
    const b = judgmentKey('choice', 'which?', ['a', 'b']);
    const c = judgmentKey('choice', `which?\u001fa\u001fb`, null);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ------------------------------------------------------------------ key length

describe('key length is bounded before anything is spent', () => {
  test('a condition at the limit still rewrites to a statement D1 accepts', () => {
    const condition = 'x'.repeat(MAX_CONDITION_CHARS);
    const sql = `SELECT name FROM cities WHERE jev(cities, '${condition}')`;
    const rewritten = rewriteSql(sql, analyzeSql(sql).calls, 0.5);
    // The call is replaced by the lookup, so the condition survives once -- inside the inlined key.
    // Measured: a 32 768-character condition rewrites to 32 989 characters, and a 100 000-character
    // condition (the shape refused below) would rewrite to 100 221, past Cloudflare D1's ~100 KB.
    expect(rewritten.length).toBeGreaterThan(condition.length);
    expect(rewritten.length - condition.length).toBeLessThan(1000);
    expect(rewritten.length).toBeLessThan(100_000);
  });

  test('a 100 000-character condition is refused before a single row is sent', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const before = api.requests;
    const huge = 'x'.repeat(100_000);
    await expect(jev.query(`SELECT name FROM cities WHERE jev(cities, '${huge}')`)).rejects.toThrow(
      /limit for a condition/,
    );
    await expect(jev.warm('cities', huge)).rejects.toThrow(/limit for a condition/);
    expect(api.requests - before).toBe(0); // nothing was judged, so nothing was paid for
    expect(storedKeys(db)).toEqual([]);
    db.close();
  });

  test('the JS row API is bounded by the same limit', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    await expect(jev.filter([{ a: 1 }], 'x'.repeat(MAX_CONDITION_CHARS + 1))).rejects.toThrow(
      /limit for a condition/,
    );
    db.close();
  });
});

// ------------------------------------------- migration and the resolved model

describe('migration: existing keys keep matching, the resolved model is recorded', () => {
  /**
   * The escape only fires when a field actually contains the separator, so every key for an ordinary
   * condition is byte-identical to the five-part join it was before this change. Nothing written by
   * 0.2.0 for a normal condition is invalidated by the escape.
   */
  test('a separator-free condition produces the plain five-part key', () => {
    expect(judgmentKey('noul', GERMANY)).toBe(
      ['noul', GERMANY, '', KEY_FORMAT, 'jev-latest'].join(KEY_SEP),
    );
    expect(judgmentKey('choice', 'which team?', ['a', 'b'], PINNED)).toBe(
      ['choice', 'which team?', '["a","b"]', KEY_FORMAT, PINNED].join(KEY_SEP),
    );
  });

  test('the key pins the requested model while the row records the resolved one', async () => {
    const db = openDb();
    const jev = await jevFor(db);
    const warm = await jev.warm('cities', GERMANY);
    const row = db
      .query<{ judgment_key: string; model: string }, []>(
        'SELECT judgment_key, model FROM jev_judgments LIMIT 1',
      )
      .get()!;
    expect(row.judgment_key.endsWith(`${KEY_SEP}jev-latest`)).toBe(true);
    // The mock answers with 'jev-mock'; whatever the deployment resolves 'jev-latest' to, the row
    // carries it, so a mixed cache is visible with GROUP BY model.
    expect(row.model).toBe('jev-mock');
    expect(warm.model).toBe('jev-mock');
    const mixed = db
      .query<{ model: string; n: number }, []>('SELECT model, count(*) AS n FROM jev_judgments GROUP BY model')
      .all();
    expect(mixed).toEqual([{ model: 'jev-mock', n: 5 }]);
    db.close();
  });

  test('the alias and the version it resolves to are two keys, so pinning re-judges once', async () => {
    const db = openDb();
    const alias = await jevFor(db); // jev-latest
    await alias.warm('cities', GERMANY);
    // Measured live: jev-latest resolved to jev-1.13.0, and pinning that version judged every row
    // again even though the same model had answered. The cost lives in the key, not in the model.
    const pinned = await jevFor(db, { model: 'jev-1.13.0' });
    const warm = await pinned.warm('cities', GERMANY);
    expect(warm.rows_judged).toBe(5);
    expect(new Set(storedKeys(db))).toEqual(
      new Set([
        judgmentKey('noul', GERMANY, null, 'jev-latest'),
        judgmentKey('noul', GERMANY, null, 'jev-1.13.0'),
      ]),
    );
    // ... and both keys were answered by the same resolved model, so nothing about the answers changed.
    expect(
      (db.query('SELECT count(DISTINCT model) AS c FROM jev_judgments').get() as { c: number }).c,
    ).toBe(1);
    db.close();
  });

  test('report: jev_cached collapses two models of one condition into one row', async () => {
    const db = openDb();
    const first = await jevFor(db);
    await first.warm('cities', GERMANY);
    const second = await jevFor(db, { model: PINNED });
    await second.warm('cities', GERMANY);

    const cached = db
      .query<{ rows_judged: number; condition: string }, []>(
        'SELECT rows_judged, condition FROM jev_cached',
      )
      .all();
    // Two judgments exist (2 keys), each for 5 of the 5 rows.
    expect(storedKeys(db)).toHaveLength(2);
    expect((db.query('SELECT count(*) AS c FROM jev_judgments').get() as { c: number }).c).toBe(10);
    // Today jev_cached groups by (scope, kind, condition, options_json) -- without the model -- so it
    // reports 10 rows judged for a 5-row table. Asserted here so the number is visible; the view is
    // in the frozen schema (sql/sql-jev.sql) and is reported to the parent.
    expect(cached).toEqual([{ rows_judged: 10, condition: GERMANY }]);
    db.close();
  });
});
