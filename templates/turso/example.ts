/**
 * sql-jev on Turso / libSQL -- end to end in one file.
 *
 *   turso auth signup                                              # once
 *   turso db create sql-jev
 *   turso db shell sql-jev < sql/sql-jev.sql                       # or: templates/turso/deploy.sh sql-jev
 *   export TURSO_DATABASE_URL="$(turso db show sql-jev --url)"     # libsql://...
 *   export TURSO_AUTH_TOKEN="$(turso db tokens create sql-jev)"
 *   export TYPESAFE_API_KEY="ts_..."                               # your TypeSafe key
 *   bun run templates/turso/example.ts
 *
 * Needs the optional peer dependency @libsql/client (`npm i @libsql/client`). sql-jev
 * itself has zero runtime dependencies; the client is what speaks the libsql:// wire
 * protocol.
 *
 * Turso has NO user-defined SQL functions: the libSQL client Turso Cloud hands you has
 * no create_function, and load_extension is not authorized. So jev.registerUdfs() does
 * nothing here and the rewriter inside jev.query()/jev.translate() is the only path.
 * What Turso does give you is a much larger parameter budget (32766), effectively
 * unbounded statement text, and atomic client.batch() -- see README.md.
 */

import { createClient } from '@libsql/client';
import { createJev } from 'sql-jev';

const url = process.env['TURSO_DATABASE_URL'];
const authToken = process.env['TURSO_AUTH_TOKEN'];
const apiKey = process.env['TYPESAFE_API_KEY'];

if (!url) throw new Error('set TURSO_DATABASE_URL (turso db show <db> --url)');
if (!apiKey) throw new Error('set TYPESAFE_API_KEY');

// One client for the whole process: libSQL pools and reuses the HTTP/WS connection.
const client = createClient({ url, ...(authToken ? { authToken } : {}) });

// createJev({ url, authToken, apiKey }) works too and creates its own client. Passing an
// existing client lets you own the connection, the retry policy and client.close().
const jev = await createJev({ client, apiKey });

// Idempotent: applies sql/sql-jev.sql, the same file `turso db shell <db> < sql/sql-jev.sql`
// applies. Safe to call on every cold start (no-op after the first one).
await jev.schema();
console.log('schema version:', await jev.version());

// ---------------------------------------------------------------- sample data

await client.execute('DROP TABLE IF EXISTS people');
await client.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)');

const sample: Array<[string, string]> = [
  ['Ada Lovelace', 'first programmer, London'],
  ['Grace Hopper', 'computing pioneer, New York'],
  ['Marie Curie', 'physicist and chemist, Warsaw and Paris'],
  ['Alan Turing', 'mathematician, London'],
  ['Katherine Johnson', 'orbital mechanics, Hampton'],
  ['Yukio Mishima', 'novelist, Tokyo'],
];

// One batch is one atomic transaction on libSQL.
await client.batch(
  sample.map(([name, note]) => ({
    sql: 'INSERT INTO people (name, note) VALUES (?, ?)',
    args: [name, note],
  })),
  'write',
);

// ---------------------------------------------------------------- 1. SQL with jev()

// jev() is not a real SQL function here. The SDK reads `people` (read-ahead), judges the
// rows with TypeSafe, stores the answers in jev_judgments, and runs the rewritten SQL.
const { rows, run, sql } = await jev.query<{ name: string }>(
  "SELECT name FROM people WHERE jev(people, 'the name is European') ORDER BY name",
);

console.log('\n-- 1. jev() in SQL');
console.table(rows);
console.log('summary:', run);
console.log('rewritten SQL:\n', sql);

// ---------------------------------------------------------------- 2. The SQL alone

// translate() warms the judgments and returns just the rewritten statement, for when you
// want to run it yourself (client.batch() is atomic, so several reads can share it).
const rewritten = await jev.translate("SELECT name FROM people WHERE jev(people, 'is a woman')");
console.log('\n-- 2. translate()\n', rewritten);
console.log((await client.execute(rewritten)).rows);

// ---------------------------------------------------------------- 3. Warm first

// Judge a whole relation once; later queries are pure jev_judgments lookups and cost no
// API calls and no read-ahead.
const summary = await jev.warm('people', 'works in healthcare');
console.log('\n-- 3. warm()', summary.rows_judged, 'rows,', summary.requests, 'request(s)');

// ---------------------------------------------------------------- 4. Ad-hoc JSON rows

// No table required: rows are hashed into the same jev_judgments cache under scope '@row'.
const people = [
  { name: 'Ada Lovelace', note: 'first programmer, London' },
  { name: 'Grace Hopper', note: 'computing pioneer, New York' },
  { name: 'Yukio Mishima', note: 'novelist, Tokyo' },
];

const kept = await jev.filter(people, 'the name is European');
const annotated = await jev.annotate(people, 'the name is European');
console.log('\n-- 4. filter()', kept.map((row) => row['name']));
console.table(annotated.map((row) => ({ name: row['name'], jev_prob: row.jev_prob })));

// ---------------------------------------------------------------- 5. Counters

console.log('\n-- 5. this session:', jev.stats()); // requests, tokens, cost, cache hits
console.log('-- 5. durable totals:', await jev.dbStats()); // SELECT * FROM jev_stats

// ---------------------------------------------------------------- 6. UDFs: not on Turso

// false on Turso Cloud: there is no create_function, and load_extension is refused.
// registerUdfs() returns true only on engines that expose one, such as bun:sqlite,
// node:sqlite or better-sqlite3 -- which is also why the rewriter exists at all.
console.log('\n-- 6. registerUdfs() on Turso:', jev.registerUdfs());

// Same reason the pg-jev per-row path cannot be used here: there is no jev() function to
// call from SQL, so every jev(...) call must go through jev.query()/jev.translate().

client.close();
