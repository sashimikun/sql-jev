/**
 * Benchmark: what a plain-language predicate costs in time, writes and money.
 *
 *   bun run bench/bench.ts                 # mock model, in-memory SQLite: engine overhead only
 *   bun run bench/bench.ts --rows 1000,5000,20000
 *   bun run bench/bench.ts --live          # 200 rows against the real API (needs TYPESAFE_API_KEY)
 *
 * What each number means:
 *   cold      first query for a condition: read-ahead + judge + persist + rewrite + run
 *   warm      the same query again: rewrite + run, 0 API calls
 *   tagged    the tag() column path: an indexed lookup, no rewriter and no correlated subquery
 *   scanned   the same predicate through jev() with judgments already stored
 *   writes    statements (and exec() calls) needed to persist the judgments
 *
 * Default mode uses the deterministic mock model, so it is reproducible and needs no credentials.
 * That means it measures ENGINE overhead: no network, no disk, no model latency. The --live mode is
 * the only one that reports real API cost, and it prints the measured tokens and dollars.
 */

import { Database } from 'bun:sqlite';
import { createJev, splitStatements, type Jev } from '../src/index.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { startMockApi, type MockApi } from '../test/harness.ts';

const CONDITION = 'the person is from Germany';
// The mock model answers 0.9 when the last word of the condition appears in the row JSON, so
// "germany" gives a realistic ~20% selectivity instead of a benchmark that matches nothing.
const COUNTRIES = ['Germany', 'Japan', 'Ireland', 'Italy', 'China'];
const FIRST = ['Anna', 'Yuki', 'Liam', 'Sofia', 'Chen', 'Marie', 'Hiro', 'Sean', 'Lucia', 'Wei'];
const LAST = ['Muller', 'Tanaka', "O'Brien", 'Rossi', 'Wei', 'Dubois', 'Sato', 'Kelly', 'Ferrari'];

interface Case {
  rows: number;
  cold_ms: number;
  warm_ms: number;
  tagged_ms: number;
  scanned_ms: number;
  requests_cold: number;
  requests_warm: number;
  matches: number;
  writes: number;
  exec_calls: number;
  max_statement_bytes: number;
  input_tokens: number;
  cost_usd: number;
}

function parseRows(argv: string[]): number[] {
  const flag = argv.find((arg) => arg.startsWith('--rows'));
  if (!flag) return [5000, 20000];
  const value = flag.includes('=') ? flag.split('=')[1] : argv[argv.indexOf(flag) + 1];
  const list = String(value ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return list.length > 0 ? list : [1000, 5000];
}

function seed(rows: number): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, country TEXT, note TEXT)');
  const insert = db.prepare('INSERT INTO people (id, name, country, note) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= rows; i += 1) {
    insert.run(
      i,
      `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
      COUNTRIES[i % COUNTRIES.length],
      i % 20 === 0 ? 'works outdoors, night shifts' : 'office work, mostly meetings',
    );
  }
  db.exec('COMMIT');
  return db;
}

/** Median of three runs, after one warm-up, so a single JIT hiccup cannot decide the number. */
async function median(runs: number, fn: () => Promise<number> | number): Promise<number> {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return Number((samples[Math.floor(samples.length / 2)] as number).toFixed(2));
}

/** A D1-shaped adapter that records what the engine would send, to count writes and bytes. */
function recordingD1(db: Database): {
  adapter: {
    name: string;
    capabilities: {
      maxBoundParams: number;
      maxBatchStatements: number;
      supportsUdf: boolean;
      multiStatementExec: boolean;
      maxStatementBytes: number;
    };
    query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
    exec: (sql: string) => Promise<void>;
    batchStatements: (statements: { sql: string; params?: unknown[] }[]) => Promise<void>;
  };
  stats: () => { statements: number; execCalls: number; maxStatementBytes: number };
} {
  let writes = 0;
  let execCalls = 0;
  let maxStatementBytes = 0;
  const adapter = {
    name: 'd1-sim',
    capabilities: {
      maxBoundParams: 100,
      maxBatchStatements: 50,
      supportsUdf: false,
      multiStatementExec: true,
      maxStatementBytes: 100_000,
    },
    async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      const head = sql.trimStart().slice(0, 8).toLowerCase();
      if (head.startsWith('select') || head.startsWith('with')) {
        return db.query(sql).all(...(params as never[])) as Record<string, unknown>[];
      }
      writes += 1;
      db.prepare(sql).run(...(params as never[]));
      return [];
    },
    async exec(sql: string): Promise<void> {
      execCalls += 1;
      for (const statement of splitStatements(sql)) {
        writes += 1;
        maxStatementBytes = Math.max(maxStatementBytes, statement.length);
        try {
          db.exec(statement);
        } catch (error) {
          console.error(`failed statement (${statement.length} bytes):`);
          console.error(`${statement.slice(0, 400)}…`);
          throw error;
        }
      }
    },
    async batchStatements(batch: { sql: string; params?: unknown[] }[]): Promise<void> {
      for (const statement of batch) await adapter.query(statement.sql, statement.params ?? []);
    },
  };
  return {
    adapter,
    stats: () => ({ statements: writes, execCalls, maxStatementBytes }),
  };
}

async function runCase(rows: number, api: MockApi, live: boolean, key: string | undefined): Promise<Case> {
  const db = seed(rows);
  const sim = recordingD1(db);
  const jev: Jev = await createJev({
    adapter: sim.adapter,
    apiKey: live ? key : 'test-key',
    ...(live ? {} : { apiUrl: api.url }),
    // The read-ahead refuses a truncated relation by design, so measure the whole table on purpose.
    maxPrefetchRows: rows + 1,
    notices: false,
  });

  // cold: the first query for this condition pays for reading, judging and storing
  const coldQuery = `SELECT count(*) AS c FROM people WHERE jev(people, '${CONDITION}')`;
  const startedCold = performance.now();
  const cold = await jev.query<{ c: number }>(coldQuery);
  const cold_ms = Number((performance.now() - startedCold).toFixed(2));
  const requestsCold = jev.stats().requests;
  const inputTokens = jev.stats().input_tokens;
  const costUsd = jev.stats().estimated_cost_usd;
  const matches = cold.rows[0]?.c ?? 0;
  const writes = sim.stats().statements;
  const execCalls = sim.stats().execCalls;
  const maxStatementBytes = sim.stats().maxStatementBytes;

  const warm_ms = await median(3, async () => {
    await jev.query(coldQuery);
  });

  // tagged: materialise the predicate, then read it like any other column
  const tagStarted = performance.now();
  const tagged = await jev.tag('people', CONDITION, { column: 'jev_european' });
  const tagMs = performance.now() - tagStarted;
  const taggedQuery = 'SELECT count(*) AS c FROM people WHERE jev_european = 1';
  const tagged_ms = await median(3, () => db.query(taggedQuery).get() as { c: number });

  // scanned: the same predicate through the rewriter with judgments already stored
  const rewritten = await jev.translate(coldQuery);
  const scanned_ms = await median(3, () => db.query(rewritten).get() as { c: number });

  const indexUsed = (
    db.query(`EXPLAIN QUERY PLAN ${taggedQuery}`).all() as { detail: string }[]
  ).some((row) => /USING INDEX|USING COVERING INDEX/i.test(row.detail));

  if (!indexUsed) throw new Error(`the tag index was not used for ${taggedQuery}`);
  if (tagged.rows_judged > 0) {
    console.error(`note: tag() re-judged ${tagged.rows_judged} rows (expected 0 after the cold run)`);
  }
  console.error(
    `rows=${rows} cold=${cold_ms}ms warm=${warm_ms}ms tag=${tagMs.toFixed(2)}ms ` +
      `indexed=${tagged_ms}ms scanned=${scanned_ms}ms matches=${matches} ` +
      `requests=${requestsCold} writes=${writes} exec=${execCalls} maxStmt=${maxStatementBytes}B`,
  );
  db.close();
  return {
    rows,
    cold_ms,
    warm_ms,
    tagged_ms,
    scanned_ms,
    requests_cold: requestsCold,
    requests_warm: jev.stats().requests - requestsCold,
    matches,
    writes,
    exec_calls: execCalls,
    max_statement_bytes: maxStatementBytes,
    input_tokens: inputTokens,
    cost_usd: costUsd,
  };
}

function table(cases: Case[]): string {
  const header =
    '| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement | input tokens | cost |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const lines = cases.map(
    (row) =>
      `| ${row.rows.toLocaleString('en-US')} | ${row.cold_ms} | ${row.warm_ms} | ${row.tagged_ms} | ` +
      `${row.scanned_ms} | ${row.matches} | ${row.requests_cold} | ${row.requests_warm} | ` +
      `${row.writes} | ${row.exec_calls} | ${row.max_statement_bytes} B | ` +
      `${row.input_tokens.toLocaleString('en-US')} | $${row.cost_usd.toFixed(6)} |`,
  );
  return [header, ...lines].join('\n');
}

const argv = Bun.argv.slice(2);
const live = argv.includes('--live');
const rows = parseRows(argv.filter((arg) => arg !== '--live'));
const api = startMockApi();
const key = process.env['TYPESAFE_API_KEY'];

const sqliteVersion = (() => {
  const db = new Database(':memory:');
  const row = db.query('SELECT sqlite_version() AS v').get() as { v: string };
  db.close();
  return row.v;
})();

console.log(`sql-jev benchmark — bun ${Bun.version}, sqlite ${sqliteVersion}, mode ${live ? 'LIVE' : 'mock'}`);
const cases: Case[] = [];
for (const count of rows) {
  cases.push(await runCase(count, api, live && Boolean(key), key));
}
api.stop();

const section = [
  `## ${live ? 'Live model' : 'Mock model'} — ${new Date().toISOString().slice(0, 10)}`,
  '',
  table(cases),
  '',
];
if (live) {
  section.push(
    'Live mode notes: requests and tokens above are real, and the dollar figure comes from',
    '`jev.stats()` at $0.042 per 1M input tokens. Rows are synthetic.',
    '',
  );
}

const results = { when: new Date().toISOString(), mode: live ? 'live' : 'mock', bun: Bun.version, sqlite: sqliteVersion, cases };
await Bun.write('bench/results.json', `${JSON.stringify(results, null, 2)}\n`);
console.log(table(cases));

// Keep a short history so a regression is visible instead of remembered.
const header = `# Benchmarks

Reproduce: \`bun run bench/bench.ts\` (mock model, in-memory SQLite, no credentials) and
\`bun run bench/bench.ts --live --rows 200\` (real API, ~$0.001). Numbers are medians of three runs
after one warm-up. Mock mode measures engine overhead only: no network, no disk, no model latency.

`;
const existing = await Bun.file('bench/RESULTS.md').exists()
  ? await Bun.file('bench/RESULTS.md').text()
  : header;
const history = existing.startsWith('# Benchmarks') ? existing.slice(header.length) : existing;
await Bun.write('bench/RESULTS.md', `${header}${section.join('\n')}${history}`);
console.error('wrote bench/RESULTS.md and bench/results.json');
