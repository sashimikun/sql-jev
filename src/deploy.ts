/**
 * One-command deploy plans for Turso and Cloudflare D1.
 *
 * Kept as pure data (bin + args + stdin) so the exact commands are unit tested, printed by
 * --dry-run, and reusable from a CI job or a shell script.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface Command {
  bin: string;
  args: string[];
  /** A file piped to the command's stdin, e.g. the schema for `turso db shell`. */
  stdinFile?: string;
  note?: string;
}

export interface DeployPlanOptions {
  /** Database name to create/use. */
  db: string;
  /** Path to sql/sql-jev.sql. */
  schemaPath: string;
  /** D1: apply to --remote (default) or --local. */
  remote?: boolean;
  /** D1: also run `wrangler deploy` for the Worker in templates/d1. */
  worker?: boolean;
}

export function quoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(command: Command): string {
  const parts = [command.bin, ...command.args.map(quoteArg)];
  if (command.stdinFile) parts.push('<', command.stdinFile);
  return parts.join(' ');
}

/** turso auth signup once, then: create, schema, URL, token. */
export function tursoPlan(options: DeployPlanOptions): Command[] {
  return [
    {
      bin: 'turso',
      args: ['db', 'create', options.db],
      note: 'creates the database (ignore "already exists" on a re-run)',
    },
    {
      bin: 'turso',
      args: ['db', 'shell', options.db],
      stdinFile: options.schemaPath,
      note: 'applies sql/sql-jev.sql (also works as: turso db shell <db> --from-dump sql/sql-jev.sql)',
    },
    {
      bin: 'turso',
      args: ['db', 'show', options.db, '--url'],
      note: 'prints the libsql:// URL for TURSO_DATABASE_URL',
    },
    {
      bin: 'turso',
      args: ['db', 'tokens', 'create', options.db],
      note: 'prints the token for TURSO_AUTH_TOKEN',
    },
  ];
}

/** wrangler d1 create, apply the schema, optionally deploy the Worker. */
export function d1Plan(options: DeployPlanOptions): Command[] {
  const target = options.remote === false ? '--local' : '--remote';
  const plan: Command[] = [
    {
      bin: 'wrangler',
      args: ['d1', 'create', options.db],
      note: 'creates the database and prints the database_id for wrangler.toml',
    },
    {
      bin: 'wrangler',
      args: ['d1', 'execute', options.db, target, `--file=${options.schemaPath}`],
      note: `applies sql/sql-jev.sql to the ${target.slice(2)} database`,
    },
  ];
  if (options.worker) {
    plan.push({
      bin: 'wrangler',
      args: ['deploy'],
      note: 'deploys the Worker from templates/d1 (copied in by `sql-jev init --worker d1`)',
    });
  }
  return plan;
}

export interface RunOptions {
  dryRun: boolean;
  cwd: string;
  onOutput?: (text: string) => void;
}

export interface RunResult {
  command: string;
  code: number;
  output: string;
}

/** Runs a plan, or prints it when dryRun is set. A non-zero status stops the plan. */
export function runCommands(commands: Command[], options: RunOptions): RunResult[] {
  const results: RunResult[] = [];
  for (const command of commands) {
    const line = formatCommand(command);
    if (options.dryRun) {
      options.onOutput?.(`[dry-run] ${line}${command.note ? `  # ${command.note}` : ''}`);
      results.push({ command: line, code: 0, output: '' });
      continue;
    }
    options.onOutput?.(`$ ${line}${command.note ? `  # ${command.note}` : ''}`);
    const input = command.stdinFile ? readFileSync(command.stdinFile) : undefined;
    const result = spawnSync(command.bin, command.args, {
      cwd: options.cwd,
      input,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (output.trim()) options.onOutput?.(output.trimEnd());
    const code = result.status ?? 1;
    results.push({ command: line, code, output });
    if (code !== 0) {
      const detail = result.error ? ` (${result.error.message})` : '';
      throw new Error(`sql-jev: \`${line}\` exited with ${code}${detail}`);
    }
  }
  return results;
}

export function schemaPath(cwd: string): string {
  return join(cwd, 'sql', 'sql-jev.sql');
}

/** Environment hints printed after a successful Turso deploy. */
export function tursoEnvHints(db: string): string[] {
  return [
    `export TURSO_DATABASE_URL="$(turso db show ${quoteArg(db)} --url)"`,
    `export TURSO_AUTH_TOKEN="$(turso db tokens create ${quoteArg(db)})"`,
    'export TYPESAFE_API_KEY="<from https://console.typesafe.ai>"',
  ];
}

export function d1EnvHints(db: string): string[] {
  return [
    `wrangler d1 list | grep ${quoteArg(db)}   # put the database_id (and name) in wrangler.toml`,
    'wrangler secret put TYPESAFE_API_KEY      # the TypeSafe key, never in the config file',
    'wrangler secret put API_TOKEN             # the bearer token your Worker demands',
  ];
}
