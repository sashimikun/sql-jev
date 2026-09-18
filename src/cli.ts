#!/usr/bin/env node
/**
 * sql-jev CLI.
 *
 *   sql-jev init [--db <file>] [--print]        apply sql/sql-jev.sql locally, or print it
 *   sql-jev init --worker d1|turso              also copy the deploy template into ./templates
 *   sql-jev deploy turso [--db <name>] [--dry-run]
 *   sql-jev deploy d1 [--db <name>] [--remote|--local] [--worker] [--dry-run]
 *   sql-jev sql "SELECT ... WHERE jev(t, 'condition')" [--url <libsql-url>] [--token <t>]
 *   sql-jev stats [--url <libsql-url>] [--token <t>]
 *   sql-jev version
 *
 * The API key comes from TYPESAFE_API_KEY, or from jev_settings.api_key in the database.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJev, JEV_VERSION } from './index.js';
import { SCHEMA_SQL } from './schema.js';
import {
  d1EnvHints,
  d1Plan,
  runCommands,
  schemaPath,
  tursoEnvHints,
  tursoPlan,
  type Command,
} from './deploy.js';

export interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) flags[name as string] = inline;
      else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) {
        flags[name as string] = rest[i + 1] as string;
        i += 1;
      } else flags[name as string] = true;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      flags[token.slice(1)] = true;
      continue;
    }
    positional.push(token);
  }
  return { command, positional, flags };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

const HELP = `sql-jev ${JEV_VERSION} -- ask your SQLite tables questions in plain language

Usage
  sql-jev init [--db <file>] [--print] [--worker d1|turso]
  sql-jev deploy turso [--db <name>] [--dry-run]
  sql-jev deploy d1 [--db <name>] [--remote|--local] [--worker] [--dry-run]
  sql-jev sql "<query>" [--url <libsql-url>] [--token <token>]
  sql-jev stats [--url <libsql-url>] [--token <token>]
  sql-jev version

Environment
  TYPESAFE_API_KEY   TypeSafe System One key (https://console.typesafe.ai)
  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN   for the sql/stats commands on Turso
`;

function sqlModuleCandidates(): string[] {
  return ['node:sqlite', 'bun:sqlite', 'better-sqlite3'];
}

async function openLocalDatabase(file: string): Promise<{ exec(sql: string): void; close(): void }> {
  for (const specifier of sqlModuleCandidates()) {
    try {
      const module = (await import(specifier)) as Record<string, unknown>;
      const ctor =
        (module['DatabaseSync'] as (new (path: string) => unknown) | undefined) ??
        (module['Database'] as (new (path: string) => unknown) | undefined) ??
        (module['default'] as (new (path: string) => unknown) | undefined);
      if (typeof ctor !== 'function') continue;
      const db = new ctor(file) as { exec(sql: string): void; close(): void };
      return db;
    } catch {
      continue;
    }
  }
  throw new Error(
    'sql-jev: no local SQLite driver found. Use Node 22+ (node:sqlite), Bun (bun:sqlite), ' +
      'or `npm i better-sqlite3`, or apply sql/sql-jev.sql with the sqlite3 CLI.',
  );
}

function printRows(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => formatCell(row[column]).length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] as number)).join('  ').trimEnd();
  console.log(line(columns));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(columns.map((column) => formatCell(row[column]))));
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function commandInit(args: CliArgs, cwd: string): Promise<void> {
  if (args.flags['print']) {
    process.stdout.write(SCHEMA_SQL);
    return;
  }
  const worker = typeof args.flags['worker'] === 'string' ? (args.flags['worker'] as string) : null;
  // Where a template is copied: ./templates inside the project that runs the command.
  const targetRoot =
    typeof args.flags['dir'] === 'string' ? resolve(cwd, args.flags['dir'] as string) : cwd;
  if (worker) {
    const source = join(packageRoot(), 'templates', worker);
    if (!existsSync(source)) throw new Error(`sql-jev: unknown template '${worker}'`);
    const target = join(targetRoot, 'templates', worker);
    mkdirSync(target, { recursive: true });
    for (const name of ['worker.ts', 'wrangler.toml', 'README.md', 'deploy.sh', 'example.ts']) {
      const file = join(source, name);
      if (existsSync(file)) copyFileSync(file, join(target, name));
    }
    console.log(`copied the ${worker} template to ${target}`);
  }
  const file =
    typeof args.flags['db'] === 'string'
      ? resolve(cwd, args.flags['db'] as string)
      : join(targetRoot, 'sql-jev.db');
  if (file === ':memory:') {
    process.stdout.write(SCHEMA_SQL);
    return;
  }
  const db = await openLocalDatabase(file);
  db.exec(SCHEMA_SQL);
  db.close();
  console.log(`applied sql/sql-jev.sql to ${resolve(cwd, file)}`);
  console.log('next: sql-jev sql \"SELECT * FROM people WHERE jev(people, condition)\"');
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function planFor(target: string, args: CliArgs, cwd: string): Command[] {
  const db = typeof args.flags['db'] === 'string' ? (args.flags['db'] as string) : 'sql-jev';
  const schema = typeof args.flags['schema'] === 'string'
    ? (args.flags['schema'] as string)
    : schemaPath(packageRoot());
  if (!existsSync(schema) && !args.flags['dry-run']) {
    throw new Error(`sql-jev: schema not found at ${schema}`);
  }
  if (target === 'turso') return tursoPlan({ db, schemaPath: schema });
  if (target === 'd1') {
    return d1Plan({
      db,
      schemaPath: schema,
      remote: args.flags['local'] ? false : true,
      worker: Boolean(args.flags['worker']),
    });
  }
  throw new Error(`sql-jev: unknown deploy target '${target}' (expected turso or d1)`);
}

async function connectForSql(args: CliArgs) {
  const url = (args.flags['url'] as string | undefined) ?? process.env['TURSO_DATABASE_URL'];
  const authToken = (args.flags['token'] as string | undefined) ?? process.env['TURSO_AUTH_TOKEN'];
  if (!url) {
    throw new Error('sql-jev: pass --url <libsql-url> or set TURSO_DATABASE_URL');
  }
  return createJev({ url, ...(authToken ? { authToken } : {}) });
}

async function commandSql(args: CliArgs): Promise<void> {
  const query = args.positional[0];
  if (!query) throw new Error('sql-jev: pass a query, e.g. sql-jev sql "SELECT 1"');
  const jev = await connectForSql(args);
  const { rows, sql, run } = await jev.query(query);
  if (sql !== query) console.error(`-- rewritten:\n${sql}`);
  printRows(rows);
  if (run.length > 0) {
    console.error(
      `-- judged ${run.reduce((total, item) => total + item.rows_judged, 0)} rows in ` +
        `${run.reduce((total, item) => total + item.requests, 0)} requests, ` +
        `${run.reduce((total, item) => total + item.input_tokens, 0)} input tokens`,
    );
  }
  console.error(`-- session: ${JSON.stringify(jev.stats())}`);
}

async function commandStats(args: CliArgs): Promise<void> {
  const jev = await connectForSql(args);
  const totals = await jev.dbStats();
  console.error('-- durable (jev_stats view):');
  printRows(totals);
  console.error('-- this session:');
  printRows([jev.stats() as unknown as Record<string, unknown>]);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  switch (args.command) {
    case 'init':
      await commandInit(args, cwd);
      return 0;
    case 'deploy': {
      const target = args.positional[0] ?? '';
      const plan = planFor(target, args, cwd);
      const dryRun = Boolean(args.flags['dry-run']);
      runCommands(plan, {
        dryRun,
        cwd,
        onOutput: (text) => console.error(text),
      });
      if (dryRun) {
        console.error('\n-- dry run: nothing was executed. Drop --dry-run to apply.');
        return 0;
      }
      const db = typeof args.flags['db'] === 'string' ? (args.flags['db'] as string) : 'sql-jev';
      console.error('\n-- next:');
      for (const hint of target === 'turso' ? tursoEnvHints(db) : d1EnvHints(db)) {
        console.error(`   ${hint}`);
      }
      return 0;
    }
    case 'sql':
      await commandSql(args);
      return 0;
    case 'stats':
      await commandStats(args);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      console.log(JEV_VERSION);
      return 0;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(HELP);
      return args.command === 'help' || args.flags['help'] ? 0 : 1;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
