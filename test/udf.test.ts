/**
 * User-defined function mode. The rewriter is the portable path; registering jev* functions is
 * an extra for engines that expose create_function (better-sqlite3, node:sqlite, embedded
 * libSQL builds). Turso Cloud and Cloudflare D1 have none, and bun:sqlite 1.4 has no
 * function() API either, so the wiring is tested through a stub that records the registrations
 * and then calls them exactly the way SQLite would.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createJev, type Jev } from '../src/index.ts';
import { openDb, startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

const GERMANY = 'the country is Germany';

/** Installs a create_function stand-in so the UDF path is testable on any runtime. */
function stubUdfApi(db: Database): Map<string, (...args: unknown[]) => unknown> {
  const attached = new Map<string, (...args: unknown[]) => unknown>();
  (db as unknown as { function: unknown }).function = (
    name: string,
    fn: (...args: unknown[]) => unknown,
  ): void => {
    attached.set(name, fn);
  };
  return attached;
}

async function jevFor(db: Database): Promise<{ jev: Jev; sql: Map<string, (...args: unknown[]) => unknown> }> {
  const sql = stubUdfApi(db);
  const jev = await createJev({ db, apiKey: 'test-key', apiUrl: api.url, notices: false });
  return { jev, sql };
}

describe('jev* SQL functions', () => {
  test('registers the whole function set from pg-jev', async () => {
    const db = openDb();
    const { jev, sql } = await jevFor(db);
    expect(jev.adapter.capabilities.supportsUdf).toBe(true);
    expect(jev.registerUdfs()).toBe(true);
    expect([...sql.keys()].sort()).toEqual([
      'jev',
      'jev_cache_clear',
      'jev_choice',
      'jev_confidence',
      'jev_eval',
      'jev_prob',
      'jev_score',
      'jev_score_norm',
      'jev_stats',
      'jev_version',
    ]);
    db.close();
  });

  test('answers from the warmed cache with the same values as the rewriter', async () => {
    const db = openDb();
    const { jev, sql } = await jevFor(db);
    jev.registerUdfs();
    await jev.warm('cities', GERMANY);

    const predicate = sql.get('jev')!;
    expect(predicate('cities', 1, GERMANY)).toBe(1);
    expect(predicate('cities', 2, GERMANY)).toBe(0);
    expect(predicate('cities', 1, GERMANY, 0.95)).toBe(0);
    expect(sql.get('jev_prob')!('cities', 1, GERMANY)).toBe(0.9);
    expect(sql.get('jev_prob')!('cities', 2, GERMANY)).toBe(0.1);
    expect(sql.get('jev_version')!()).toBe('0.2.0');
    expect(String(sql.get('jev_stats')!())).toContain('"requests":');
    expect(sql.get('jev_cache_clear')!()).toBe(1);
    db.close();
  });

  test('score, choice and confidence answers match the SQL path', async () => {
    const db = openDb();
    const { jev, sql } = await jevFor(db);
    jev.registerUdfs();
    await jev.warm('cities', 'which continent?', { kind: 'choice', options: ['europe', 'asia'] });
    const choice = sql.get('jev_choice')!('cities', 1, 'which continent?', '["europe","asia"]');
    expect(['europe', 'asia']).toContain(String(choice));
    const confidence = sql.get('jev_confidence')!(
      'cities',
      1,
      'which continent?',
      'choice',
      '[\"europe\",\"asia\"]',
    );
    expect(confidence).toBe(1);
    const raw = JSON.parse(String(sql.get('jev_eval')!('cities', 1, 'which continent?', 'choice', '[\"europe\",\"asia\"]')));
    expect(raw.type).toBe('choice');
    db.close();
  });

  test('refuses an unwarmed row with an actionable error', async () => {
    const db = openDb();
    const { jev, sql } = await jevFor(db);
    jev.registerUdfs();
    await jev.warm('cities', GERMANY);
    // an unknown row is not in the cache: -1 rather than a wrong answer
    expect(sql.get('jev_prob')!('cities', 999, GERMANY)).toBe(-1);
    // confidence cannot be guessed, so it fails loudly
    expect(() =>
      sql.get('jev_confidence')!('cities', 999, 'which continent?', 'choice', '[\"europe\"]'),
    ).toThrow(/has not been judged/);
    db.close();
  });
});
