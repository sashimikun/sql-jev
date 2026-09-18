import { describe, expect, test } from 'bun:test';
import { analyzeSql, rewriteSql, tokenize } from '../src/index.ts';

function plan(sql: string, threshold = 0.5) {
  const analysis = analyzeSql(sql);
  return { sql: rewriteSql(sql, analysis.calls, threshold), calls: analysis.calls };
}

describe('rewriting jev() for engines without user-defined functions', () => {
  test('turns jev(relation, condition) into a jev_judgments lookup by rowid', () => {
    const { sql, calls } = plan("SELECT * FROM people WHERE jev(people, 'the name is European')");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.fn).toBe('jev');
    expect(call.kind).toBe('noul');
    expect(call.output).toBe('bool');
    expect(call.relation).toBe('people');
    expect(call.rowAlias).toBe('people');
    expect(call.judgmentKey).toBe('noul\u001fthe name is European\u001f');
    expect(sql).toContain(
      'FROM jev_judgments j WHERE j.scope = \'people\' ' +
        'AND j.row_ref = CAST("people"._rowid_ AS TEXT)',
    );
    expect(sql).toContain('>= COALESCE(0.5, 0.5)');
    expect(sql).not.toMatch(/\bjev\s*\(/);
  });

  test('resolves FROM ... alias, including a table name used with an alias', () => {
    const byAlias = plan("SELECT name FROM cities c WHERE jev(c, 'x')");
    expect(byAlias.calls[0]!.relation).toBe('cities');
    expect(byAlias.calls[0]!.rowAlias).toBe('c');
    expect(byAlias.sql).toContain('CAST("c"._rowid_ AS TEXT)');

    const byTable = plan("SELECT name FROM cities AS c WHERE jev(cities, 'x')");
    expect(byTable.calls[0]!.relation).toBe('cities');
    expect(byTable.calls[0]!.rowAlias).toBe('c');

    const selfJoin = plan("SELECT 1 FROM a, b WHERE jev(b, 'x')");
    expect(selfJoin.calls[0]!.relation).toBe('b');
  });

  test('rejects an ambiguous relation instead of guessing', () => {
    expect(() => analyzeSql("SELECT 1 FROM cities a JOIN cities b ON 1 WHERE jev(cities, 'x')"))
      .toThrow(/ambiguous/);
  });

  test('rejects a subquery as the row argument, pointing at the JS row API', () => {
    expect(() => analyzeSql("SELECT * FROM t WHERE jev((SELECT r FROM x), 'y')"))
      .toThrow(/no rowid/);
  });

  test('carries an explicit threshold through untouched', () => {
    const { sql } = plan("SELECT 1 FROM cities WHERE jev(cities, 'x', 0.95)");
    expect(sql).toContain('>= COALESCE(0.95, 0.5)');
  });

  test('accepts ARRAY[...] , json_array(...) and literal JSON options', () => {
    const array = plan("SELECT jev_score(c, 'how big?', ARRAY['small','large']) FROM cities c");
    expect(array.calls[0]!.kind).toBe('score');
    expect(array.calls[0]!.options).toEqual(['small', 'large']);
    expect(array.sql).toContain('SELECT j.score FROM jev_judgments j');
    expect(array.sql).toContain("'score\u001fhow big?\u001f[\"small\",\"large\"]'");

    const normalised = plan("SELECT jev_score_norm(c, 'how big?', ARRAY['small','large']) FROM cities c");
    expect(normalised.sql).toContain('j.score / MAX(COALESCE(j.levels_count, 2) - 1, 1)');

    const jsonArray = plan(`SELECT jev_choice(c, 'which?', json_array('a','b')) FROM cities c`);
    expect(jsonArray.calls[0]!.options).toEqual(['a', 'b']);

    const jsonText = plan(`SELECT jev_choice(c, 'which?', '["a","b"]') FROM cities c`);
    expect(jsonText.calls[0]!.options).toEqual(['a', 'b']);

    const tuple = plan(`SELECT jev_score(c, 'q', ('a','b')) FROM cities c`);
    expect(tuple.calls[0]!.options).toEqual(['a', 'b']);
  });

  test('leaves string literals, comments and other functions alone', () => {
    expect(analyzeSql("SELECT 'jev(cities, ''x'')' AS lit").calls).toHaveLength(0);
    expect(analyzeSql("SELECT 1 -- jev(cities, 'x')").calls).toHaveLength(0);
    expect(analyzeSql("SELECT /* jev(cities, 'x') */ 1").calls).toHaveLength(0);
    expect(analyzeSql("SELECT myjev(cities, 'x') FROM cities").calls).toHaveLength(0);
    expect(analyzeSql('SELECT "jev" FROM cities').calls).toHaveLength(0);
  });

  test('rewrites several calls left to right without disturbing each other', () => {
    const { sql, calls } = plan(
      "SELECT * FROM cities WHERE jev(cities, 'a') AND jev_prob(cities, 'b') > 0.5",
    );
    expect(calls.map((call) => call.fn)).toEqual(['jev', 'jev_prob']);
    expect(sql.indexOf("'noul\u001fa\u001f'")).toBeLessThan(sql.indexOf("'noul\u001fb\u001f'"));
  });

  test('reports an unknown primitive exactly like pg-jev does', () => {
    expect(() => analyzeSql("SELECT jev_eval(c, 'q', 'bogus', NULL) FROM cities c"))
      .toThrow(/unknown kind 'bogus'/);
  });

  test('tokenizer keeps literal and identifier spans intact', () => {
    const tokens = tokenize("SELECT 'a;b', \"odd name\", 1.5e3 FROM t -- x\n");
    expect(tokens.map((token) => token.value)).toEqual([
      'SELECT',
      'a;b',
      ',',
      'odd name',
      ',',
      '1.5e3',
      'FROM',
      't',
    ]);
  });
});
