/**
 * Guards the packaged CLI the way npm actually runs it.
 *
 * npm and npx execute a bin through a symlink in node_modules/.bin, so `process.argv[1]` is that
 * symlink and not the module path. The first version of the entry-point check compared them without
 * resolving, which made the published CLI exit 0 with no output: `npx sql-jev version` printed
 * nothing. These tests run the built binary through a real symlink and assert it works.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repo, 'dist', 'cli.js');

function runThroughSymlink(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const binDir = mkdtempSync(join(tmpdir(), 'sql-jev-bin-'));
  const bin = join(binDir, 'sql-jev');
  symlinkSync(cli, bin);
  const proc = Bun.spawnSync({ cmd: ['node', bin, ...args], cwd });
  rmSync(binDir, { recursive: true, force: true });
  return {
    stdout: proc.stdout.toString().trim(),
    // plans, notices and nudges go to stderr on purpose: stdout stays pipeable
    stderr: proc.stderr.toString().trim(),
    status: proc.exitCode ?? 1,
  };
}

describe('the packaged CLI', () => {
  beforeAll(() => {
    if (!existsSync(cli)) {
      const built = Bun.spawnSync({ cmd: ['bun', 'run', 'build'], cwd: repo });
      expect(built.exitCode).toBe(0);
    }
  });

  test('answers through a node_modules/.bin style symlink', () => {
    const { stdout, status } = runThroughSymlink(['version'], repo);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('applies the schema from the packaged sql/ directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sql-jev-init-'));
    const dbFile = join(dir, 'demo.db');
    mkdirSync(dir, { recursive: true });
    const { status } = runThroughSymlink(['init', '--db', dbFile], repo);
    expect(status).toBe(0);
    const db = new Database(dbFile);
    const objects = (
      db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]
    ).map((row) => row.name);
    expect(objects).toContain('jev_judgments');
    expect(objects).toContain('jev_stats');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('prints a deploy plan without running anything', () => {
    const { stderr, status } = runThroughSymlink(['deploy', 'turso', '--db', 'demo', '--dry-run'], repo);
    expect(status).toBe(0);
    expect(stderr).toContain('turso db create demo');
    expect(stderr).toContain('dry run');
  });

  test('prints help instead of dying when it is imported, not executed', async () => {
    const module = await import('../src/cli.ts');
    expect(typeof module.main).toBe('function');
    expect(typeof module.parseArgs).toBe('function');
  });
});
