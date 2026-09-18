/**
 * Generates src/schema.ts from sql/sql-jev.sql so there is exactly one copy of the schema:
 * the .sql file that Turso, wrangler and sqlite3 consume, and the string jev.schema() applies.
 *
 *   bun run scripts/sync-schema.ts         (writes src/schema.ts)
 *   bun run scripts/sync-schema.ts --check (fails when src/schema.ts is stale, for CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const schemaPath = join(root, 'sql', 'sql-jev.sql');
const targetPath = join(root, 'src', 'schema.ts');

const sql = readFileSync(schemaPath, 'utf8');
const header = [
  '/**',
  ' * GENERATED FILE -- do not edit. Run `bun run scripts/sync-schema.ts` after editing',
  ' * sql/sql-jev.sql, which is the schema deployed by `sql-jev deploy turso|d1`,',
  ' * `wrangler d1 execute --file`, `turso db shell` and `sqlite3 < file`.',
  ' */',
  '',
].join('\n');
const body = `export const SCHEMA_SQL = ${JSON.stringify(sql)};\n\nexport const SCHEMA_STATEMENT_COUNT = SCHEMA_SQL.split(';').length - 1;\n`;
const output = header + body;

if (process.argv.includes('--check')) {
  const current = readFileSync(targetPath, 'utf8');
  if (current !== output) {
    console.error('src/schema.ts is stale: run `bun run scripts/sync-schema.ts`');
    process.exit(1);
  }
  console.log('src/schema.ts is up to date');
  process.exit(0);
}

writeFileSync(targetPath, output);
console.log(`wrote ${targetPath} (${sql.length} bytes of schema)`);
