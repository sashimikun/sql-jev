/**
 * The libSQL / Turso path, exercised with a scripted fake @libsql/client.
 *
 * The committed suite stays mock-only and dependency-free: `@libsql/client` is an optional
 * peer and is never imported here. Instead, `FakeLibsqlClient` mirrors what the real
 * `@libsql/client` 0.18.0 was observed to do (recorded in
 * /tmp/dogfood-libsql/probe*.ts and in the dogfood findings):
 *
 *   - `execute()` takes a string or `{ sql, args }` and returns `{ rows, columns, rowsAffected }`
 *   - rows are plain objects with enumerable column names
 *   - `executeMultiple(sql)` runs a script with no arguments
 *   - `batch(statements, mode)` takes `[{ sql, args }]` and a mode string ('write' for writes)
 *   - there is no `create_function`, so `supportsUdf` is false
 *   - a multi-statement string handed to `execute()` runs only the FIRST statement, silently
 *
 * The last point is why the tests below also assert that sql-jev never sends a multi-statement
 * string to `execute()`: on the real client that would drop the trailing statements without an
 * error, so the adapter must batch or split instead.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createJev } from '../src/index.ts';
import { libsqlAdapter } from '../src/adapters/index.ts';
import { isSelect, rowObjects, splitStatements } from '../src/adapters/types.ts';
import { SCHEMA_SQL } from '../src/schema.ts';
import { startMockApi, type MockApi } from './harness.ts';

let api: MockApi;

beforeAll(() => {
  api = startMockApi();
});

afterAll(() => {
  api.stop();
});

interface ExecuteCall {
  kind: 'execute';
  sql: string;
  args: unknown[];
}

interface ExecCall {
  kind: 'executeMultiple';
  sql: string;
}

interface BatchCall {
  kind: 'batch';
  mode: string | undefined;
  statements: { sql: string; args: unknown[] }[];
}

type Call = ExecuteCall | ExecCall | BatchCall;

interface FakeOptions {
  /** Omit executeMultiple/batch/create_function to model a client that lacks them. */
  executeMultiple?: boolean;
  batch?: boolean;
  createFunction?: boolean;
  /** Return rows as arrays plus a `columns` list, the shape rowObjects has to normalise. */
  arrayRows?: boolean;
}

/** A @libsql/client-shaped handle over a real in-memory SQLite database. */
class FakeLibsqlClient {
  readonly calls: Call[] = [];
  readonly attached: { name: string; fn: (...args: unknown[]) => unknown }[] = [];
  readonly executeMultiple?: (sql: string) => Promise<void>;
  readonly batch?: (statements: { sql: string; args?: unknown[] }[], mode?: string) => Promise<unknown[]>;
  readonly create_function?: (name: string, fn: (...args: unknown[]) => unknown) => void;
  closed = false;

  constructor(
    private readonly db: Database,
    options: FakeOptions = {},
  ) {
    if (options.executeMultiple !== false) {
      this.executeMultiple = async (sql: string): Promise<void> => {
        this.calls.push({ kind: 'executeMultiple', sql });
        // The real client's executeMultiple is not atomic; DDL plus idempotent seeds are enough.
        for (const statement of splitStatements(sql)) this.db.exec(statement);
      };
    }
    if (options.batch !== false) {
      this.batch = async (
        statements: { sql: string; args?: unknown[] }[],
        mode?: string,
      ): Promise<unknown[]> => {
        this.calls.push({
          kind: 'batch',
          mode,
          statements: statements.map((statement) => ({
            sql: statement.sql,
            args: statement.args ?? [],
          })),
        });
        this.db.exec('BEGIN');
        try {
          const results = statements.map((statement) => this.run(statement.sql, statement.args ?? []));
          this.db.exec('COMMIT');
          return results;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      };
    }
    if (options.createFunction) {
      this.create_function = (name: string, fn: (...args: unknown[]) => unknown): void => {
        this.attached.push({ name, fn });
      };
    }
    this.arrayRows = options.arrayRows ?? false;
  }

  private readonly arrayRows: boolean;

  execute(input: string | { sql: string; args?: unknown[] }): Promise<{
    rows: unknown[];
    columns: string[];
    rowsAffected: number;
  }> {
    const sql = typeof input === 'string' ? input : input.sql;
    const args = typeof input === 'string' ? [] : (input.args ?? []);
    this.calls.push({ kind: 'execute', sql, args });
    return Promise.resolve(this.run(sql, args));
  }

  close(): void {
    this.closed = true;
  }

  /** Mirrors the real client: prepare() consumes one statement, so extras are dropped. */
  private run(sql: string, args: unknown[]): { rows: unknown[]; columns: string[]; rowsAffected: number } {
    const statement = this.db.prepare(sql);
    const columns = (statement as unknown as { columnNames: string[] }).columnNames ?? [];
    if (columns.length === 0) {
      const info = statement.run(...(args as never[]));
      return { rows: [], columns: [], rowsAffected: Number(info.changes) };
    }
    const rows = this.arrayRows
      ? statement.values(...(args as never[]))
      : statement.all(...(args as never[]));
    return { rows, columns, rowsAffected: 0 };
  }
}

function fakeClient(options: FakeOptions = {}): { client: FakeLibsqlClient; db: Database } {
  const db = new Database(':memory:');
  return { client: new FakeLibsqlClient(db, options), db };
}

function schemaObjects(db: Database): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

async function jevFor(client: FakeLibsqlClient, overrides: Record<string, unknown> = {}) {
  return createJev({ client, apiKey: 'test-key', apiUrl: api.url, notices: false, ...overrides });
}

describe('libSQL adapter: capabilities and UDF detection', () => {
  test('reports the conservative parameter budget and no UDFs without create_function', () => {
    const { client } = fakeClient();
    const adapter = libsqlAdapter(client);
    expect(adapter.name).toBe('libsql');
    expect(adapter.capabilities.maxBoundParams).toBe(900);
    expect(adapter.capabilities.maxBatchStatements).toBe(500);
    expect(adapter.capabilities.multiStatementExec).toBe(false);
    expect(adapter.capabilities.supportsUdf).toBe(false);
    expect(adapter.attachFunction?.('jev', () => true)).toBe(false);
  });

  test('detects create_function (and createFunction) when the client exposes one', () => {
    const { client } = fakeClient({ createFunction: true });
    const adapter = libsqlAdapter(client);
    expect(adapter.capabilities.supportsUdf).toBe(true);
    const fn = (): number => 0.5;
    expect(adapter.attachFunction?.('jev', fn)).toBe(true);
    expect(client.attached).toEqual([{ name: 'jev', fn }]);

    const camel = new FakeLibsqlClient(new Database(':memory:'));
    Object.defineProperty(camel, 'createFunction', {
      value: (name: string, fn: (...args: unknown[]) => unknown) => camel.attached.push({ name, fn }),
    });
    const camelAdapter = libsqlAdapter(camel);
    expect(camelAdapter.capabilities.supportsUdf).toBe(true);
    expect(camelAdapter.attachFunction?.('jev_prob', fn)).toBe(true);
  });
});

describe('libSQL adapter: rows and statement routing', () => {
  test('a SELECT returns rows as objects and passes {sql, args} only when there are parameters', async () => {
    const { client, db } = fakeClient();
    db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO people (name) VALUES ('Anouk')");
    const adapter = libsqlAdapter(client);

    expect(await adapter.query('SELECT name FROM people')).toEqual([{ name: 'Anouk' }]);
    expect(client.calls[0]).toEqual({ kind: 'execute', sql: 'SELECT name FROM people', args: [] });
    expect(
      await adapter.query('SELECT name FROM people WHERE id = ?', [1]),
    ).toEqual([{ name: 'Anouk' }]);
    expect(client.calls[1]).toEqual({
      kind: 'execute',
      sql: 'SELECT name FROM people WHERE id = ?',
      args: [1],
    });
  });

  test('array-shaped driver rows are normalised with the columns list', () => {
    expect(
      rowObjects(
        [
          [1, 'Anouk'],
          [2, 'Kenji'],
        ],
        ['id', 'name'],
      ),
    ).toEqual([
      { id: 1, name: 'Anouk' },
      { id: 2, name: 'Kenji' },
    ]);
  });

  test('the real client row shape (named keys plus hidden indices) passes through cleanly', async () => {
    const { client, db } = fakeClient();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO t (name) VALUES ('x')");
    const adapter = libsqlAdapter(client);
    const rows = await adapter.query<Record<string, unknown>>('SELECT id, name FROM t');
    const row = rows[0]!;
    // @libsql/client adds non-enumerable numeric indices and `length`; JSON and Object.keys
    // must stay clean so row hashes and the API state see the columns only.
    Object.defineProperty(row, 'length', { value: 2 });
    expect(Array.isArray(row)).toBe(false);
    expect(Object.keys(row)).toEqual(['id', 'name']);
    expect(JSON.stringify(row)).toBe('{"id":1,"name":"x"}');
  });

  test('write statements execute and return no rows', async () => {
    const { client, db } = fakeClient();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const adapter = libsqlAdapter(client);

    expect(await adapter.query('CREATE TABLE IF NOT EXISTS u (x)')).toEqual([]);
    expect(await adapter.query('INSERT INTO t (name) VALUES (?)', ['one'])).toEqual([]);
    expect(
      await adapter.query(
        'INSERT INTO t (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name',
        [1, 'one'],
      ),
    ).toEqual([]);
    expect(await adapter.query("UPDATE t SET name = 'two' WHERE id = 1")).toEqual([]);
    expect(await adapter.query('DELETE FROM t WHERE id = 1')).toEqual([]);

    const rows = db.query('SELECT name FROM sqlite_master ORDER BY name').all() as { name: string }[];
    expect(rows.map((row) => row.name)).toContain('u');
    expect(db.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  test('isSelect is right for every statement sql-jev sends', () => {
    const reads = [
      'SELECT rowid AS __jev_rowid__, * FROM people ORDER BY rowid LIMIT ? OFFSET ?',
      'SELECT key, value FROM jev_settings',
      'SELECT row_ref, row_hash, answer_json FROM jev_judgments WHERE scope = ?',
      'SELECT * FROM jev_stats',
      'PRAGMA table_info(people)',
    ];
    for (const sql of reads) expect(isSelect(sql)).toBe(true);

    const writes = [
      'INSERT INTO jev_runs (scope, judgment_key) VALUES (?, ?)',
      'INSERT INTO jev_judgments (scope, row_ref) VALUES (?, ?) ON CONFLICT (scope, row_ref) DO UPDATE SET row_hash = excluded.row_hash',
      'UPDATE jev_settings SET value = ? WHERE key = ?',
      'DELETE FROM jev_judgments',
      'CREATE TABLE IF NOT EXISTS jev_runs (scope TEXT)',
    ];
    for (const sql of writes) expect(isSelect(sql)).toBe(false);
  });
});

describe('libSQL adapter: scripts and batches', () => {
  test('exec() applies the whole schema through executeMultiple in one call', async () => {
    const { client, db } = fakeClient();
    const adapter = libsqlAdapter(client);

    await adapter.exec(SCHEMA_SQL);
    const scripts = client.calls.filter((call) => call.kind === 'executeMultiple');
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as ExecCall).sql).toBe(SCHEMA_SQL);
    for (const name of ['jev_judgments', 'jev_runs', 'jev_settings', 'jev_stats', 'jev_meta']) {
      expect(schemaObjects(db)).toContain(name);
    }

    // idempotent: a second apply is safe and touches nothing new
    const objects = schemaObjects(db);
    await adapter.exec(SCHEMA_SQL);
    expect(client.calls.filter((call) => call.kind === 'executeMultiple')).toHaveLength(2);
    expect(schemaObjects(db)).toEqual(objects);
  });

  test('exec() falls back to one statement per execute() when executeMultiple is missing', async () => {
    const { client, db } = fakeClient({ executeMultiple: false });
    const adapter = libsqlAdapter(client);

    await adapter.exec(SCHEMA_SQL);
    const executed = client.calls.filter((call): call is ExecuteCall => call.kind === 'execute');
    expect(executed.length).toBeGreaterThan(10);
    // one statement per call: the real client silently drops the rest of a multi-statement string
    for (const call of executed) expect(splitStatements(call.sql)).toHaveLength(1);
    for (const name of ['jev_judgments', 'jev_runs', 'jev_settings', 'jev_stats']) {
      expect(schemaObjects(db)).toContain(name);
    }
    expect(db.query("SELECT value FROM jev_settings WHERE key = 'version'").get()).toEqual({
      value: '0.1.0',
    });
  });

  test('batchStatements() sends every {sql, args} pair through batch(..., "write")', async () => {
    const { client, db } = fakeClient();
    db.exec('CREATE TABLE m (a INTEGER, b TEXT)');
    const adapter = libsqlAdapter(client);

    await adapter.batchStatements?.([
      { sql: 'INSERT INTO m (a, b) VALUES (?, ?)', params: [1, 'one'] },
      { sql: 'INSERT INTO m (a, b) VALUES (?, ?)', params: [2, 'two'] },
      { sql: "INSERT INTO m (a, b) VALUES (3, 'three')" },
    ]);

    const batches = client.calls.filter((call): call is BatchCall => call.kind === 'batch');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.mode).toBe('write');
    expect(batches[0]!.statements).toEqual([
      { sql: 'INSERT INTO m (a, b) VALUES (?, ?)', args: [1, 'one'] },
      { sql: 'INSERT INTO m (a, b) VALUES (?, ?)', args: [2, 'two'] },
      { sql: "INSERT INTO m (a, b) VALUES (3, 'three')", args: [] },
    ]);
    expect(db.query('SELECT count(*) AS n FROM m').get()).toEqual({ n: 3 });
  });

  test('batchStatements() falls back to execute() when the client has no batch()', async () => {
    const { client, db } = fakeClient({ batch: false });
    db.exec('CREATE TABLE m (a INTEGER)');
    const adapter = libsqlAdapter(client);

    await adapter.batchStatements?.([{ sql: 'INSERT INTO m (a) VALUES (?)', params: [7] }]);
    expect(client.calls.every((call) => call.kind === 'execute')).toBe(true);
    expect(db.query('SELECT a FROM m').get()).toEqual({ a: 7 });
  });
});

describe('the libSQL path end to end (fake client, mock TypeSafe API)', () => {
  test('jev.query() warms, rewrites, caches and agrees with translate()', async () => {
    const { client, db } = fakeClient();
    const jev = await jevFor(client);
    await jev.schema();
    db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT)');
    await client.batch?.(
      [
        { sql: 'INSERT INTO people (name, note) VALUES (?, ?)', args: ['Anouk Dekker', 'healthcare, Rotterdam'] },
        { sql: 'INSERT INTO people (name, note) VALUES (?, ?)', args: ['Mateo Alvarez', 'banking, Madrid'] },
        { sql: 'INSERT INTO people (name, note) VALUES (?, ?)', args: ['Yuki Tanaka', 'healthcare, Osaka'] },
      ],
      'write',
    );

    const before = api.requests;
    const statement = "SELECT name FROM people WHERE jev(people, 'the note is healthcare') ORDER BY name";
    const { rows, sql, run } = await jev.query<{ name: string }>(statement);
    expect(rows.map((row) => row.name)).toEqual(['Anouk Dekker', 'Yuki Tanaka']);
    expect(run[0]?.rows_judged).toBe(3);
    expect(sql).toContain('jev_judgments');
    expect(api.requests).toBeGreaterThan(before);

    // the judgments are in the table, keyed by scope + row_ref + judgment_key
    const stored = db.query('SELECT count(*) AS n FROM jev_judgments').get() as { n: number };
    expect(stored.n).toBe(3);

    // a repeated query is free, and running the translated SQL directly gives the same rows
    const requests = api.requests;
    const again = await jev.query<{ name: string }>(statement);
    expect(api.requests).toBe(requests);
    expect(again.rows.map((row) => row.name)).toEqual(['Anouk Dekker', 'Yuki Tanaka']);

    const translated = await jev.translate(statement);
    const direct = (await client.execute(translated)).rows as { name: string }[];
    expect(direct.map((row) => row.name)).toEqual(['Anouk Dekker', 'Yuki Tanaka']);
  });

  test('the judged-set INSERTs stay inside 900 parameters and always upsert', async () => {
    const { client, db } = fakeClient();
    const jev = await jevFor(client, { batchSize: 40 });
    await jev.schema();
    db.exec('CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT, country TEXT)');
    const insert = db.prepare('INSERT INTO cities (id, name, country) VALUES (?, ?, ?)');
    for (let i = 1; i <= 150; i += 1) insert.run(i, `City ${i}`, i % 2 === 0 ? 'Germany' : 'Japan');

    const { rows } = await jev.query<{ name: string }>(
      "SELECT name FROM cities WHERE jev(cities, 'the country is Germany') ORDER BY id",
    );
    expect(rows).toHaveLength(75);

    // Verified against the real client: every statement stays inside the adapter's declared
    // budget (900 bound parameters, 500 statements per batch call) and every judged-set write
    // is an idempotent ON CONFLICT upsert in a 'write' batch.
    const statementCalls = client.calls.filter(
      (call): call is ExecuteCall | BatchCall => call.kind === 'execute' || call.kind === 'batch',
    );
    let judgedInserts = 0;
    let batchCalls = 0;
    for (const call of statementCalls) {
      const statements =
        call.kind === 'execute' ? [{ sql: call.sql, args: call.args }] : call.statements;
      if (call.kind === 'batch') {
        batchCalls += 1;
        expect(call.mode).toBe('write');
        expect(call.statements.length).toBeLessThanOrEqual(
          libsqlAdapter(client).capabilities.maxBatchStatements,
        );
      }
      for (const statement of statements) {
        // the real client silently drops every statement after the first
        expect(splitStatements(statement.sql)).toHaveLength(1);
        expect(statement.args.length).toBeLessThanOrEqual(900);
        if (statement.sql.includes('INTO jev_judgments')) {
          judgedInserts += 1;
          expect(statement.sql).toContain('ON CONFLICT');
          expect(statement.sql).toContain('excluded.');
          expect(statement.args).toHaveLength(14);
        }
      }
    }
    // 150 rows: one upsert per row, shipped through batch() rather than 150 round trips
    expect(judgedInserts).toBe(150);
    expect(batchCalls).toBe(1);
    const stored = db.query('SELECT count(*) AS n FROM jev_judgments').get() as { n: number };
    expect(stored.n).toBe(150);
    expect(db.query('SELECT count(*) AS n FROM jev_runs').get()).toEqual({ n: 1 });
  });

  test("the ad-hoc '@row' cache works through libSQL too", async () => {
    const { client } = fakeClient();
    const jev = await jevFor(client);
    await jev.schema();
    const rows = [
      { name: 'Anouk Dekker', note: 'the note is healthcare' },
      { name: 'Mateo Alvarez', note: 'banking' },
    ];

    const annotated = await jev.annotate(rows, 'the note is healthcare');
    expect(annotated[0]?.jev_prob).toBeGreaterThan(0.5);

    const requests = api.requests;
    const again = await jev.annotate(rows, 'the note is healthcare');
    expect(api.requests).toBe(requests);
    expect(again).toEqual(annotated);
  });
});
