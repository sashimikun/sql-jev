/**
 * The deploy plans and the CLI surface: exact commands, quoting, dry runs and local init.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { main, parseArgs } from '../src/cli.ts';
import { d1Plan, formatCommand, quoteArg, runCommands, tursoPlan } from '../src/deploy.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { JEV_VERSION } from '../src/types.ts';

const schemaPath = fileURLToPath(new URL('../sql/sql-jev.sql', import.meta.url));

describe('deploy plans', () => {
  test('turso: create, schema on stdin, url, token', () => {
    const plan = tursoPlan({ db: 'my-db', schemaPath });
    expect(plan.map((command) => formatCommand(command))).toEqual([
      'turso db create my-db',
      `turso db shell my-db < ${schemaPath}`,
      'turso db show my-db --url',
      'turso db tokens create my-db',
    ]);
    expect(plan[1]!.stdinFile).toBe(schemaPath);
  });

  test('d1: create, schema --remote, optionally deploy the worker', () => {
    expect(d1Plan({ db: 'my-db', schemaPath }).map(formatCommand)).toEqual([
      'wrangler d1 create my-db',
      `wrangler d1 execute my-db --remote --file=${schemaPath}`,
    ]);
    expect(d1Plan({ db: 'my-db', schemaPath, remote: false }).map(formatCommand)[1]).toBe(
      `wrangler d1 execute my-db --local --file=${schemaPath}`,
    );
    expect(d1Plan({ db: 'my-db', schemaPath, worker: true }).map(formatCommand)[2]).toBe(
      'wrangler deploy',
    );
  });

  test('quotes arguments that a shell would split', () => {
    expect(quoteArg('plain-1')).toBe('plain-1');
    expect(quoteArg('with space')).toBe("'with space'");
    expect(formatCommand({ bin: 'wrangler', args: ['d1', 'execute', 'a b'] })).toBe(
      "wrangler d1 execute 'a b'",
    );
  });

  test('dry runs print the plan without touching anything', () => {
    const printed: string[] = [];
    runCommands(tursoPlan({ db: 'dry', schemaPath }), {
      dryRun: true,
      cwd: process.cwd(),
      onOutput: (text) => printed.push(text),
    });
    expect(printed).toHaveLength(4);
    expect(printed[0]).toContain('[dry-run] turso db create dry');
  });
});

describe('argument parsing', () => {
  test('reads positional values and flags with values', () => {
    expect(parseArgs(['deploy', 'turso', '--db', 'my-db', '--dry-run'])).toEqual({
      command: 'deploy',
      positional: ['turso'],
      flags: { db: 'my-db', 'dry-run': true },
    });
    expect(parseArgs(['init', '--db=file.db']).flags).toEqual({ db: 'file.db' });
  });
});

describe('sql-jev CLI', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sql-jev-cli-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('init applies the schema to a local database file', async () => {
    const file = join(dir, 'local.db');
    expect(await main(['init', '--db', file])).toBe(0);

    const db = new Database(file);
    const objects = (
      db
        .query("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const name of [
      'jev_judgments',
      'jev_runs',
      'jev_settings',
      'jev_stats',
      'jev_cached',
      'jev_meta',
      'jev_coverage',
    ]) {
      expect(objects).toContain(name);
    }
    expect(db.query('SELECT * FROM jev_stats').get()).toBeTruthy();
    expect(
      (db.query("SELECT value FROM jev_settings WHERE key = 'version'").get() as { value: string })
        .value,
    ).toBe(JEV_VERSION);
    db.close();
  });

  test('init copies a deploy template on request', async () => {
    expect(await main(['init', '--worker', 'd1', '--dir', dir, '--db', join(dir, 'template.db')])).toBe(0);
    const files = readdirSync(join(dir, 'templates', 'd1'));
    expect(files).toContain('worker.ts');
    expect(files).toContain('wrangler.toml');
    expect(files).toContain('README.md');
  });

  test('deploy --dry-run prints the plan and exits 0', async () => {
    expect(await main(['deploy', 'turso', '--db', 'dry-db', '--dry-run'])).toBe(0);
    expect(await main(['deploy', 'd1', '--db', 'dry-db', '--worker', '--dry-run'])).toBe(0);
  });

  test('deploy rejects an unknown target', async () => {
    await expect(main(['deploy', 'postgres', '--dry-run'])).rejects.toThrow(/expected turso or d1/);
  });

  test('the packaged schema file and the embedded one are the same text', () => {
    expect(readFileSync(schemaPath, 'utf8')).toBe(SCHEMA_SQL);
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS jev_judgments');
    expect(SCHEMA_SQL).toContain('CREATE VIEW IF NOT EXISTS jev_stats');
  });
});
