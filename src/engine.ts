/**
 * The judgment engine: read-ahead, batching, concurrency, cache and spend guards.
 *
 * Port of the PL/Python body of _jev_eval() in pg-jev:
 *
 *   pg-jev                                     sql-jev
 *   ----------------------------------------   ------------------------------------------
 *   read the whole table once per statement    read the relation once, paged by rowid
 *   rows batched jev.batch_size per request    same, same default 40
 *   jev.concurrency parallel requests          same, same default 6
 *   cache in the backend session (GD)          jev_judgments table (+ in-process mirror)
 *   sha1(row_json) as the cache key            sha256(canonical row JSON), plus rowid
 *   statement_timestamp read-ahead guard       per-statement guard, per query() call
 *   jev_stats() from GD                        local counters + jev_stats view
 *
 * The one real difference: SQLite can only look a judged row up by a key it can compute in
 * SQL. rowid is that key, so judgments are stored per (relation, rowid, judgment). A row
 * whose content changed has a different row_hash and is judged again.
 */

import { apiKeyOf, postSystemOne } from './api.js';
import {
  resolveConfig,
  settingsFromRows,
  type JevConfig,
  type JevSettings,
} from './config.js';
import { analyzeSql, rewriteSql, type AnalyzedCall } from './rewrite.js';
import {
  KEY_SEP,
  canonicalJson,
  judgmentKey as makeJudgmentKey,
  jsonSafeRow,
  quoteIdentifier,
  quoteLiteral,
  relationSqlFor,
  sha256HexAll,
} from './sql.js';
import {
  JevError,
  USD_PER_INPUT_TOKEN,
  JEV_VERSION,
  answerChoice,
  answerConfidence,
  answerLevelsCount,
  answerProb,
  answerScore,
  buildQuestion,
  buildState,
  emptyRunStats,
  scoreNorm,
  type JevAnswer,
  type JevKind,
  type JevRunStats,
} from './types.js';
import { splitStatements, type Adapter } from './adapters/types.js';

export interface JudgeSpec {
  kind: JevKind;
  /** The condition (noul) or the question (score/choice). */
  condition: string;
  options: string[] | null;
  key: string;
}

export function specFor(
  kind: JevKind,
  condition: string,
  options: string[] | null = null,
): JudgeSpec {
  return { kind, condition, options, key: makeJudgmentKey(kind, condition, options) };
}

interface Item {
  /** rowid as text, or the content hash for ad-hoc rows. */
  rowRef: string;
  hash: string;
  row: Record<string, unknown>;
}

/** What one judged set cost. Mirrors the fields of the jev_runs row. */
export interface RunSummary {
  scope: string;
  kind: JevKind;
  condition: string;
  judgment_key: string;
  rows_judged: number;
  rows_already_judged: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  api_ms: number;
  estimated_cost_usd: number;
  model: string | null;
  /** 1 when the judged set failed; the durable jev_stats view reports the sum. */
  errors?: number;
}

/** In-process mirror of one judgment: the row hash it was judged for, and the raw answer. */
interface MirrorEntry {
  hash: string;
  raw: string;
}

export interface QueryResult<T> {
  rows: T[];
  /** The SQL that actually ran, with every jev* call replaced by a jev_judgments lookup. */
  sql: string;
  run: RunSummary[];
}

const ROW_REF_COLUMN = '__jev_row_ref__';
const AD_HOC_SCOPE = '@row';

/**
 * The spend accumulator of ONE statement (one plan()/query()/warm()/judgeArray() call).
 *
 * It is deliberately not instance state. jev.max_rows_per_statement /
 * jev.max_chars_per_statement are sold as a guard for shared and public deployments, and a
 * single Jev instance is documented as safe to share; a shared accumulator made two
 * concurrent statements contaminate each other in both directions - a 30-row statement
 * aborted at 45 rows because a 15-row statement ran beside it, and a 60-row statement
 * escaped because the concurrent statement had just reset the counter.
 */
export interface StatementBudget {
  rows: number;
  chars: number;
}

/** A fresh budget: call this once at the start of every statement. */
function newStatementBudget(): StatementBudget {
  return { rows: 0, chars: 0 };
}

/** What one ensure() call actually spent. The only source of truth for a run summary. */
interface JudgedTotals {
  rows: number;
  requests: number;
  tokens: number;
  outputTokens: number;
  apiMs: number;
  model: string | null;
}

/**
 * The run summary of one satisfied (scope, judgment) pair. Every spend number comes from
 * JudgedTotals - never from a placeholder. `SELECT * FROM jev_stats` sums jev_runs and the
 * README tells users to read it for spend, so a run that spent money must record what it spent.
 */
function runSummary(
  scope: string,
  spec: JudgeSpec,
  judged: JudgedTotals,
  alreadyJudged: number,
): RunSummary {
  const tokens = judged.tokens;
  return {
    scope,
    kind: spec.kind,
    condition: spec.condition,
    judgment_key: spec.key,
    rows_judged: judged.rows,
    rows_already_judged: alreadyJudged,
    requests: judged.requests,
    input_tokens: tokens,
    output_tokens: judged.outputTokens,
    api_ms: judged.apiMs,
    estimated_cost_usd: Number((tokens * USD_PER_INPUT_TOKEN).toFixed(6)),
    model: judged.model,
  };
}

/**
 * One upsert for every judged row, shared by the parameterized and the literal (D1) path.
 * input_tokens is omitted on purpose: per-batch usage lives in jev_runs.
 */
const UPSERT_HEAD =
  'INSERT INTO jev_judgments (scope, row_ref, row_hash, judgment_key, kind, condition, ' +
  'options_json, answer_json, prob, label, score, levels_count, confidence, model) VALUES ';
const UPSERT_TAIL =
  ' ON CONFLICT(scope, row_ref, judgment_key) DO UPDATE SET ' +
  'row_hash = excluded.row_hash, answer_json = excluded.answer_json, prob = excluded.prob, ' +
  'label = excluded.label, score = excluded.score, levels_count = excluded.levels_count, ' +
  'confidence = excluded.confidence, model = excluded.model, ' +
  "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** A literal for the D1 script path. NUL bytes are dropped: SQLite strings cannot hold them. */
function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return quoteLiteral(String(value).replace(/\u0000/g, ''));
}

export interface JevOptions extends Partial<JevConfig> {
  /** Bring your own dialect: Turso/libSQL client, Cloudflare D1 binding, bun:sqlite, node:sqlite, better-sqlite3. */
  adapter: Adapter;
  /** Read api_url/model/threshold/... from jev_settings once, on ready(). Default true. */
  loadSettings?: boolean;
}

export class Jev {
  adapter: Adapter;
  config: JevConfig;
  private readonly overrides: Partial<JevConfig>;
  private readonly shouldLoadSettings: boolean;
  private settingsLoaded = false;
  private schemaMissing = false;
  private counters: JevRunStats = emptyRunStats();
  /** In-process mirror of jev_judgments, the GD equivalent. Key: scope|rowRef|judgmentKey. */
  private memory = new Map<string, MirrorEntry>();

  constructor(options: JevOptions) {
    const { adapter, loadSettings, ...overrides } = options;
    this.adapter = adapter;
    this.overrides = overrides;
    this.shouldLoadSettings = loadSettings ?? true;
    this.config = resolveConfig(overrides);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Loads jev_settings so the database and the process agree on threshold, model, batching. */
  async ready(): Promise<this> {
    if (this.shouldLoadSettings && !this.settingsLoaded) {
      this.settingsLoaded = true;
      let rows: Record<string, unknown>[] | null = null;
      try {
        rows = await this.adapter.query('SELECT key, value FROM jev_settings');
      } catch (error) {
        this.schemaMissing = true;
        this.notice(
          'jev: jev_settings not found, using defaults. Apply the schema with ' +
            '`npx sql-jev deploy turso|d1`, `npx sql-jev init`, or `await jev.schema()`.',
        );
      }
      if (rows) {
        const settings: JevSettings = settingsFromRows(rows);
        this.config = resolveConfig(this.overrides, settings);
      }
    }
    return this;
  }

  /** Applies sql/sql-jev.sql (idempotent, safe to run on every cold start). */
  async schema(): Promise<void> {
    const { SCHEMA_SQL } = await import('./schema.js');
    await this.adapter.exec(SCHEMA_SQL);
    this.schemaMissing = false;
  }

  async version(): Promise<string> {
    try {
      const rows = await this.adapter.query(
        "SELECT value FROM jev_settings WHERE key = 'version'",
      );
      const value = rows[0]?.['value'];
      if (typeof value === 'string' && value) return value;
    } catch {
      // fall through to the code version
    }
    return JEV_VERSION;
  }

  // ------------------------------------------------------------------ statistics

  /** Session counters, same shape as jev_stats() in pg-jev. */
  stats(): JevRunStats {
    return {
      ...this.counters,
      estimated_cost_usd: Number(
        (this.counters.input_tokens * USD_PER_INPUT_TOKEN).toFixed(6),
      ),
    };
  }

  /** Durable totals from the jev_stats view: works across Workers, regions and connections. */
  async dbStats(): Promise<Record<string, unknown>[]> {
    return this.adapter.query('SELECT * FROM jev_stats');
  }

  /** Forget cached judgments: the in-process mirror and, unless kept, the jev_judgments rows. */
  async cacheClear(options: { keepPersisted?: boolean } = {}): Promise<void> {
    this.memory.clear();
    if (!options.keepPersisted) {
      await this.adapter.exec('DELETE FROM jev_judgments');
    }
  }

  // ------------------------------------------------------------------ JS row API

  /** Rows of `rows` that satisfy the condition: the JS equivalent of WHERE jev(row, ...). */
  async filter<T extends Record<string, unknown>>(
    rows: T[],
    condition: string,
    options: { threshold?: number; kind?: JevKind; options?: string[] | null } = {},
  ): Promise<T[]> {
    const threshold = options.threshold ?? this.config.threshold;
    const kind = options.kind ?? 'noul';
    const spec = specFor(kind, condition, options.options ?? null);
    const answers = await this.judgeArray(spec, rows as Record<string, unknown>[]);
    return rows.filter((_row, index) => {
      const answer = answers[index];
      if (kind === 'noul') return (answerProb(answer) ?? -1) >= threshold;
      if (kind === 'score') {
        return (scoreNorm(answerScore(answer), answerLevelsCount(answer, spec.options)) ?? -1) >= threshold;
      }
      return (answerChoice(answer) ?? '') !== '';
    });
  }

  /** Rows annotated with the probability, mirroring ORDER BY jev_prob(...) DESC. */
  async annotate<T extends Record<string, unknown>>(
    rows: T[],
    condition: string,
  ): Promise<(T & { jev_prob: number })[]> {
    const answers = await this.judgeArray(specFor('noul', condition), rows as Record<string, unknown>[]);
    return rows.map((row, index) => ({ ...row, jev_prob: answerProb(answers[index]) ?? -1 }));
  }

  async prob(rows: Record<string, unknown>[], condition: string): Promise<number[]> {
    const answers = await this.judgeArray(specFor('noul', condition), rows);
    return answers.map((answer) => answerProb(answer) ?? -1);
  }

  async score(
    rows: Record<string, unknown>[],
    question: string,
    levels: string[],
  ): Promise<(number | null)[]> {
    const spec = specFor('score', question, levels);
    const answers = await this.judgeArray(spec, rows);
    return answers.map((answer) => answerScore(answer));
  }

  async scoreNorm(
    rows: Record<string, unknown>[],
    question: string,
    levels: string[],
  ): Promise<(number | null)[]> {
    const spec = specFor('score', question, levels);
    const answers = await this.judgeArray(spec, rows);
    return answers.map((answer) => scoreNorm(answerScore(answer), answerLevelsCount(answer, levels)));
  }

  async choice(
    rows: Record<string, unknown>[],
    question: string,
    options: string[],
  ): Promise<(string | null)[]> {
    const spec = specFor('choice', question, options);
    const answers = await this.judgeArray(spec, rows);
    return answers.map((answer) => answerChoice(answer));
  }

  async confidence(
    rows: Record<string, unknown>[],
    question: string,
    kind: JevKind,
    options: string[] | null,
  ): Promise<(number | null)[]> {
    const spec = specFor(kind, question, options);
    const answers = await this.judgeArray(spec, rows);
    return answers.map((answer) => answerConfidence(answer));
  }

  async eval(
    rows: Record<string, unknown>[],
    question: string,
    kind: JevKind = 'noul',
    options: string[] | null = null,
  ): Promise<(JevAnswer | null)[]> {
    const spec = specFor(kind, question, options);
    const answers = await this.judgeArray(spec, rows);
    return answers.map((answer) => answer ?? null);
  }

  // ------------------------------------------------------------------ SQL API

  /**
   * Warms every judgment the statement needs and returns the rewritten statement.
   *
   * This is not a cheap string rewrite: it reads the referenced relations ahead and JUDGES the
   * rows that are not cached yet, so it spends API calls and money. For rewriting with zero API
   * calls, use the exported pure functions `analyzeSql()` + `rewriteSql()`.
   */
  async plan(sql: string): Promise<QueryResult<never> & { calls: AnalyzedCall[] }> {
    await this.ready();
    const analysis = analyzeSql(sql);
    if (analysis.calls.length === 0) {
      return { sql, calls: [], rows: [], run: [] };
    }
    this.requireSchema();
    if (!this.config.persistJudgments) {
      // jev() is rewritten into a lookup on jev_judgments. With persistence off that table stays
      // empty, so every row would read as -1.0 and the statement would return nothing at all --
      // a wrong answer, not an error. Refuse loudly instead.
      throw new JevError(
        'jev: persistJudgments: false cannot serve SQL that calls jev*(): the rewrites look the ' +
          'judgments up in jev_judgments, which stays empty, so the statement would silently ' +
          'return no rows. Keep persistence on for SQL, or use the JS row API ' +
          '(jev.filter/jev.prob/...) or registerUdfs() with jev.warm().',
      );
    }
    // One budget for the whole statement, owned by this call: plan() shares it across the
    // relation groups it warms. It is never instance state, because two statements that run
    // concurrently on one Jev must not share an accumulator - a shared counter both aborts
    // innocent statements and lets an over-limit statement escape when the other one resets it.
    const budget = newStatementBudget();
    const groups = new Map<string, { relation: string; relationSql: string; spec: JudgeSpec }>();
    for (const call of analysis.calls) {
      const key = `${call.relation}${KEY_SEP}${call.judgmentKey}`;
      if (!groups.has(key)) {
        groups.set(key, {
          relation: call.relation,
          relationSql: call.relationSql,
          spec: specFor(call.kind, call.condition, call.options),
        });
      }
    }
    const run: RunSummary[] = [];
    for (const group of groups.values()) {
      run.push(await this.warmRelation(group.relation, group.relationSql, group.spec, budget));
    }
    return {
      sql: rewriteSql(sql, analysis.calls, this.config.threshold),
      calls: analysis.calls,
      rows: [],
      run,
    };
  }

  /** Runs the statement with every jev* call translated, after warming the judgments. */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.assertSingleStatement(sql);
    const planned = await this.plan(sql);
    if (planned.calls.length === 0) {
      const rows = await this.adapter.query<T>(sql, params);
      return { rows, sql, run: [] };
    }
    const rows = await this.adapter.query<T>(planned.sql, params);
    return { rows, sql: planned.sql, run: planned.run };
  }

  /**
   * Runs a script through the adapter's exec(). No jev() rewriting, so this is for DDL and for
   * multi-statement scripts: jev.query() deliberately refuses those, because most drivers drop
   * every statement after the first without raising an error.
   */
  async exec(sql: string): Promise<void> {
    await this.adapter.exec(sql);
  }

  /** jev.query() runs exactly one statement; refuse the rest loudly instead of truncating it. */
  private assertSingleStatement(sql: string): void {
    if (splitStatements(sql).length > 1) {
      throw new JevError(
        'jev.query() runs one statement: this SQL contains several. Run them one at a time, or ' +
          'use jev.exec(sql) for a script (drivers silently drop every statement after the first).',
      );
    }
  }

  /**
   * The rewritten SQL, for engines you drive yourself (D1 batch(), libSQL batch()).
   *
   * Like plan(), this WARMS: it reads the relations ahead and judges uncached rows, so it
   * spends API calls and money before the SQL string is returned. It is not a pure rewrite. For
   * rewriting only, call `rewriteSql(sql, analyzeSql(sql).calls, threshold)` (all exported from
   * the package root) and warm separately - e.g. with `await jev.warm(...)`.
   */
  async translate(sql: string): Promise<string> {
    const planned = await this.plan(sql);
    return planned.sql;
  }

  /** Run the whole table through the model now, the analogue of a first jev() call in Postgres. */
  async warm(
    relation: string,
    condition: string,
    options: { kind?: JevKind; options?: string[] | null } = {},
  ): Promise<RunSummary> {
    await this.ready();
    this.requireSchema();
    const spec = specFor(options.kind ?? 'noul', condition, options.options ?? null);
    // warm() is a statement of its own, so it gets its own budget (see newStatementBudget).
    return this.warmRelation(relation, relationSqlFor(relation), spec, newStatementBudget());
  }

  // ------------------------------------------------------------------ user-defined functions

  /**
   * Registers jev* SQL functions, where the handle exposes a create_function API: `node:sqlite`
   * (`DatabaseSync.function`), `better-sqlite3` (`db.function`) and libSQL builds that expose
   * `create_function`. This is the *extra* path; the rewriter is the portable one.
   *
   * It returns false instead of pretending, because two of the platforms this package is sold
   * for cannot do it at all:
   *
   *   - `bun:sqlite` 1.4 has no function()/createFunction API (`typeof db.function` is
   *     `undefined`, verified on Bun 1.4.0), so a jev created over a bun:sqlite handle reports
   *     `capabilities.supportsUdf === false` and this returns false.
   *   - Turso Cloud and Cloudflare D1 have no CREATE FUNCTION, so nothing to register against;
   *     use `jev.query()`/`jev.translate()` (the rewriter) or the JS row API there.
   *
   * Where it does work, the functions are synchronous lookups into the warmed in-process cache,
   * exactly like pg-jev's per-row path: warm first (await jev.warm(...) or a query through
   * jev.query()), then read.
   *
   *   SELECT * FROM people WHERE jev('people', people._rowid_, 'the name is European');
   */
  registerUdfs(): boolean {
    const adapter = this.adapter;
    if (!adapter.capabilities.supportsUdf || !adapter.attachFunction) return false;
    const attach = (name: string, fn: (...args: unknown[]) => unknown): void => {
      adapter.attachFunction?.(name, fn);
    };
    const asRef = (value: unknown): string =>
      typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'number'
          ? String(Math.trunc(value))
          : String(value ?? '');
    const parseOptions = (value: unknown): string[] | null => {
      if (value === null || value === undefined) return null;
      if (Array.isArray(value)) return value.map((item) => String(item));
      if (typeof value !== 'string' || value.trim() === '') return null;
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new JevError('jev: options must be a JSON array');
      return parsed.map((item) => String(item));
    };
    const lookup = (scope: string, rowRef: string, spec: JudgeSpec): JevAnswer | null => {
      const entry = this.memory.get(memoryKey(scope, rowRef, spec.key));
      if (!entry) return null;
      return JSON.parse(entry.raw) as JevAnswer;
    };
    const need = (scope: string, rowRef: string, spec: JudgeSpec): JevAnswer => {
      const answer = lookup(scope, rowRef, spec);
      if (!answer) {
        throw new JevError(
          `jev: row ${scope}#${rowRef} has not been judged for '${spec.condition}'. ` +
            'Warm it first: await jev.warm(relation, condition) or run the query through jev.query().',
        );
      }
      return answer;
    };

    attach('jev', (scope, rowRef, condition, threshold) => {
      const spec = specFor('noul', String(condition));
      const answer = lookup(String(scope), asRef(rowRef), spec);
      const limit = typeof threshold === 'number' ? threshold : this.config.threshold;
      return (answerProb(answer ?? undefined) ?? -1) >= limit ? 1 : 0;
    });
    attach('jev_prob', (scope, rowRef, condition) => {
      const answer = lookup(String(scope), asRef(rowRef), specFor('noul', String(condition)));
      return answerProb(answer ?? undefined) ?? -1;
    });
    attach('jev_score', (scope, rowRef, question, levels) => {
      const spec = specFor('score', String(question), parseOptions(levels));
      const answer = lookup(String(scope), asRef(rowRef), spec);
      return answerScore(answer ?? undefined) ?? -1;
    });
    attach('jev_score_norm', (scope, rowRef, question, levels) => {
      const options = parseOptions(levels);
      const spec = specFor('score', String(question), options);
      const answer = lookup(String(scope), asRef(rowRef), spec);
      const score = answerScore(answer ?? undefined);
      if (score === null) return -1;
      return scoreNorm(score, answerLevelsCount(answer ?? undefined, options)) ?? -1;
    });
    attach('jev_choice', (scope, rowRef, question, options) => {
      const spec = specFor('choice', String(question), parseOptions(options));
      const answer = lookup(String(scope), asRef(rowRef), spec);
      return answerChoice(answer ?? undefined) ?? '';
    });
    attach('jev_confidence', (scope, rowRef, question, kind, options) => {
      const primitive = String(kind).toLowerCase() as JevKind;
      const spec = specFor(primitive, String(question), parseOptions(options));
      const answer = need(String(scope), asRef(rowRef), spec);
      return answerConfidence(answer);
    });
    attach('jev_eval', (scope, rowRef, question, kind, options) => {
      const primitive = (kind === null || kind === undefined ? 'noul' : String(kind).toLowerCase()) as JevKind;
      const spec = specFor(primitive, String(question), parseOptions(options));
      return JSON.stringify(need(String(scope), asRef(rowRef), spec));
    });
    attach('jev_version', () => JEV_VERSION);
    attach('jev_stats', () => JSON.stringify(this.stats()));
    attach('jev_cache_clear', () => {
      this.memory.clear();
      return 1;
    });
    this.notice(`jev: registered SQL functions on ${this.adapter.name} (UDF mode)`);
    return true;
  }

  // ------------------------------------------------------------------ internals

  private notice(message: string): void {
    if (this.config.notices) this.config.onNotice(message);
  }

  private requireSchema(): void {
    if (!this.schemaMissing) return;
    throw new JevError(
      'jev: jev_judgments is missing. Apply sql/sql-jev.sql first: ' +
        '`npx sql-jev init --db <file>` locally, `npx sql-jev deploy turso|d1`, or `await jev.schema()`.',
    );
  }

  /**
   * Spend guard: refuse a statement that would send more than the configured rows/characters.
   * `budget` belongs to exactly one statement (see newStatementBudget), so concurrent
   * statements on one Jev never see each other's rows.
   */
  private guard(budget: StatementBudget, sizes: number[]): void {
    budget.rows += sizes.length;
    budget.chars += sizes.reduce((total, size) => total + size, 0);
    const { maxRowsPerStatement, maxCharsPerStatement } = this.config;
    if (maxRowsPerStatement && budget.rows > maxRowsPerStatement) {
      throw new JevError(
        `jev: this statement would send ${budget.rows} rows to the API, ` +
          `above jev.max_rows_per_statement = ${maxRowsPerStatement}`,
      );
    }
    if (maxCharsPerStatement && budget.chars > maxCharsPerStatement) {
      throw new JevError(
        `jev: this statement would send ${budget.chars} characters of row data to the API, ` +
          `above jev.max_chars_per_statement = ${maxCharsPerStatement}`,
      );
    }
  }

  /**
   * Reads up to jev.max_prefetch_rows rows of `relation`, paged by rowid, and reports whether
   * the relation held more rows than that.
   *
   * Rows past the cap are never judged. The rewritten jev() reads a missing judgment as -1.0,
   * which is `false`, so `WHERE jev(...)` would silently drop every row past the cap. The caller
   * decides what to do with `truncated` (see handlePrefetchOverflow); it must never be ignored.
   */
  private async readRelation(relation: string): Promise<{ items: Item[]; truncated: boolean }> {
    const items: Item[] = [];
    const limit = this.config.maxPrefetchRows;
    while (items.length < limit) {
      const page = Math.min(this.config.pageSize, limit - items.length);
      let rows: Record<string, unknown>[];
      try {
        rows = await this.adapter.query<Record<string, unknown>>(
          // `_rowid_` rather than `rowid`: SQLite resolves rowid, _rowid_ and oid to the real
          // rowid unless the table declares a column with that spelling, and a user column named
          // `rowid` is common. src/rewrite.ts keys its lookup off `_rowid_` too, so the read-ahead
          // here and the rewritten lookup in SQL must always agree on the spelling.
          `SELECT _rowid_ AS ${quoteIdentifier(ROW_REF_COLUMN)}, * FROM ${relation} ` +
            `ORDER BY _rowid_ LIMIT ? OFFSET ?`,
          [page, items.length],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only claim a rowid problem when the engine actually complains about one: wrapping every
        // failure in the rowid hint (an out-of-range INTEGER, a locked database, a bad parameter)
        // sent people hunting for the wrong cause.
        const rowidProblem = /rowid|no such column|without rowid/i.test(message);
        throw new JevError(
          `jev: cannot read ahead ${relation}: ${message}` +
            (rowidProblem
              ? '. jev() needs a rowid table; use the JS row API for subqueries, views and ' +
                'WITHOUT ROWID tables.'
              : ''),
        );
      }
      if (rows.length === 0) break;
      for (const raw of rows) {
        const rowRef = raw[ROW_REF_COLUMN];
        const row: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (key === ROW_REF_COLUMN) continue;
          row[key] = value;
        }
        items.push({
          rowRef: rowRef === null || rowRef === undefined ? '' : String(rowRef),
          hash: '',
          row: jsonSafeRow(row),
        });
      }
      if (rows.length < page) break;
    }
    // Exactly `limit` rows read: was that the whole relation, or is there one more row we would
    // never judge? A relation holding exactly max_prefetch_rows rows is complete, not truncated.
    const truncated =
      items.length >= limit &&
      (
        await this.adapter.query<Record<string, unknown>>(
          `SELECT _rowid_ FROM ${relation} ORDER BY _rowid_ LIMIT 1 OFFSET ?`,
          [limit],
        )
      ).length > 0;
    const hashes = await sha256HexAll(items.map((item) => canonicalJson(item.row)));
    items.forEach((item, index) => {
      item.hash = hashes[index] as string;
    });
    return { items, truncated };
  }

  /**
   * What to do when a relation holds more rows than jev.max_prefetch_rows.
   *
   * There is no per-row fallback here the way pg-jev has one: SQLite cannot call the model, so a
   * row past the cap simply has no judgment, and the rewritten jev()/jev_prob()/jev_score()
   * read a missing judgment as -1.0 -- false. Returning that as a normal answer is silent
   * wrongness (a 10-row table with max_prefetch_rows = 4 returned 1 of its 3 German cities and
   * said nothing), so the default is to refuse the statement; `prefetchOverflow: 'partial'`
   * keeps the old coverage but says so out loud, whatever `notices` is set to.
   */
  private handlePrefetchOverflow(relation: string): void {
    const message =
      `jev: ${relation} holds more rows than jev.max_prefetch_rows = ${this.config.maxPrefetchRows}, ` +
      'so the rows past that cap have no judgment. jev()/jev_prob()/jev_score() read a missing ' +
      'judgment as -1.0, i.e. false, which silently drops those rows from the result. ' +
      'Raise jev.max_prefetch_rows to the size of the relation, filter with a predicate SQLite ' +
      'can evaluate itself, or use the JS row API (jev.filter / jev.prob) for a payload you ' +
      "already hold. To accept the partial coverage anyway, set prefetchOverflow: 'partial'.";
    if (this.config.prefetchOverflow !== 'partial') throw new JevError(message);
    this.config.onNotice(message);
  }

  /**
   * Judges one relation + one judgment, reusing everything already stored.
   * `scope` is the unquoted relation name, shared by the SQL lookup, the JS row API and the
   * registered SQL functions, so `warm('people', ...)` and `jev(people, ...)` in SQL agree.
   * `budget` defaults to a fresh per-call budget: a direct warmRelation() call is its own
   * statement. plan() passes one shared budget so the whole statement is guarded as a unit.
   */
  async warmRelation(
    scope: string,
    relationSql: string,
    spec: JudgeSpec,
    budget: StatementBudget = newStatementBudget(),
  ): Promise<RunSummary> {
    const { items, truncated } = await this.readRelation(relationSql);
    if (truncated) this.handlePrefetchOverflow(scope);
    const { judged, alreadyJudged } = await this.ensure(spec, scope, items, budget);
    const summary = runSummary(scope, spec, judged, alreadyJudged);
    if (judged.rows > 0) {
      this.notice(
        `jev: ${spec.kind} → judged ${judged.rows} row${judged.rows === 1 ? '' : 's'} of ${scope} ` +
          `in ${judged.requests} request${judged.requests === 1 ? '' : 's'}, ${summary.input_tokens} input tokens ` +
          `(≈$${summary.estimated_cost_usd.toFixed(4)}), ${judged.apiMs.toFixed(0)} ms`,
      );
      if (this.config.persistJudgments) await this.logRun(summary);
    } else {
      this.notice(
        `jev: ${spec.kind} → all ${items.length} row${items.length === 1 ? '' : 's'} of ${scope} are ` +
          'already judged: 0 requests, $0',
      );
    }
    return summary;
  }

  /**
   * Writes one jev_runs row for a statement that actually judged rows, so the durable
   * `jev_stats` view reports real requests, tokens, ms and cost even in a stateless Worker.
   *
   * A pure cache hit is not logged: nothing was sent and nothing was spent, and a row of
   * placeholder zeros is indistinguishable from a statement whose real spend is zero. Cached
   * coverage stays visible in `jev_judgments` / `jev_stats.cached_answers` and in the session
   * `cache_hits` counter, and the notice says "0 requests, $0" out loud.
   */
  private async logRun(summary: RunSummary): Promise<void> {
    try {
      await this.adapter.query(
        'INSERT INTO jev_runs (scope, judgment_key, kind, model, rows_judged, requests, ' +
          'input_tokens, output_tokens, api_ms, estimated_cost_usd, errors) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          summary.scope,
          summary.judgment_key,
          summary.kind,
          summary.model,
          summary.rows_judged,
          summary.requests,
          summary.input_tokens,
          summary.output_tokens,
          summary.api_ms,
          summary.estimated_cost_usd,
          summary.errors ?? 0,
        ],
      );
    } catch {
      // jev_runs is observability, never a reason to fail a query
    }
  }

  /** The cache: read what is already judged, ask for the rest, store it. */
  private async ensure(
    spec: JudgeSpec,
    scope: string,
    items: Item[],
    budget: StatementBudget,
  ): Promise<{
    answers: Map<string, JevAnswer>;
    judged: JudgedTotals;
    alreadyJudged: number;
  }> {
    const answers = new Map<string, JevAnswer>();
    if (items.length === 0) {
      return {
        answers,
        judged: { rows: 0, requests: 0, tokens: 0, outputTokens: 0, apiMs: 0, model: null },
        alreadyJudged: 0,
      };
    }
    const stored = await this.readStored(scope, spec.key, items);
    const missing: Item[] = [];
    for (const item of items) {
      // The in-process mirror is checked on its own, not only as a shortcut for a row that is
      // also still in jev_judgments: with persistJudgments: false the table is empty by design
      // and the mirror is the whole cache. It is still hash-checked, so a changed row is judged
      // again. alwaysRecheck deliberately skips it: that knob means "ask jev_judgments again".
      const mirror = this.memory.get(memoryKey(scope, item.rowRef, spec.key));
      if (!this.config.alwaysRecheck && mirror && mirror.hash === item.hash) {
        answers.set(item.rowRef, JSON.parse(mirror.raw) as JevAnswer);
        continue;
      }
      const storedEntry = stored.get(item.rowRef);
      if (storedEntry && storedEntry.hash === item.hash) {
        answers.set(item.rowRef, storedEntry.answer);
        this.memory.set(memoryKey(scope, item.rowRef, spec.key), {
          hash: storedEntry.hash,
          raw: storedEntry.raw,
        });
        continue;
      }
      missing.push(item);
    }
    const alreadyJudged = items.length - missing.length;
    this.counters.cache_hits += alreadyJudged;
    this.counters.cached_answers += stored.size;
    if (missing.length === 0) {
      return {
        answers,
        judged: { rows: 0, requests: 0, tokens: 0, outputTokens: 0, apiMs: 0, model: null },
        alreadyJudged,
      };
    }
    this.guard(budget, missing.map((item) => canonicalJson(item.row).length));
    let fresh: {
      answers: Map<number, JevAnswer>;
      requests: number;
      tokens: number;
      outputTokens: number;
      apiMs: number;
      model: string | null;
    };
    try {
      fresh = await this.judgeBatch(spec, missing);
    } catch (error) {
      // The session counter already counted the failure; log it durably too, so jev_stats.errors
      // is not always 0 in a stateless Worker, and rethrow so the caller still sees the error.
      if (this.config.persistJudgments) {
        await this.logRun({
          ...runSummary(scope, spec, { rows: 0, requests: 0, tokens: 0, outputTokens: 0, apiMs: 0, model: null }, alreadyJudged),
          errors: 1,
        });
      }
      throw error;
    }
    missing.forEach((item, index) => {
      const answer = fresh.answers.get(index);
      if (answer) answers.set(item.rowRef, answer);
    });
    if (fresh.answers.size !== missing.length) {
      throw new JevError(
        `jev: TypeSafe returned ${fresh.answers.size} answers for ${missing.length} rows`,
      );
    }
    await this.persist(scope, spec, missing, answers, fresh.model);
    return {
      answers,
      judged: {
        rows: missing.length,
        requests: fresh.requests,
        tokens: fresh.tokens,
        outputTokens: fresh.outputTokens,
        apiMs: fresh.apiMs,
        model: fresh.model,
      },
      alreadyJudged,
    };
  }

  /** Selects what jev_judgments already knows about (scope, judgment_key). */
  private async readStored(
    scope: string,
    judgmentKeyValue: string,
    items: Item[],
  ): Promise<Map<string, { hash: string; answer: JevAnswer; raw: string }>> {
    const stored = new Map<string, { hash: string; answer: JevAnswer; raw: string }>();
    if (scope === AD_HOC_SCOPE) {
      const perStatement = Math.max(1, this.adapter.capabilities.maxBoundParams - 2);
      for (let start = 0; start < items.length; start += perStatement) {
        const chunk = items.slice(start, start + perStatement);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = await this.adapter.query<Record<string, unknown>>(
          'SELECT row_ref, row_hash, answer_json FROM jev_judgments ' +
            `WHERE scope = ? AND judgment_key = ? AND row_ref IN (${placeholders})`,
          [scope, judgmentKeyValue, ...chunk.map((item) => item.rowRef)],
        );
        for (const row of rows) collectStored(stored, row);
      }
      return stored;
    }
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT row_ref, row_hash, answer_json FROM jev_judgments WHERE scope = ? AND judgment_key = ?',
      [scope, judgmentKeyValue],
    );
    for (const row of rows) collectStored(stored, row);
    return stored;
  }

  /** One batched, concurrent API run; answers come back keyed by index. */
  private async judgeBatch(
    spec: JudgeSpec,
    items: Item[],
  ): Promise<{
    answers: Map<number, JevAnswer>;
    requests: number;
    tokens: number;
    outputTokens: number;
    apiMs: number;
    model: string | null;
  }> {
    const config = this.config;
    apiKeyOf(config);
    const batches: { items: Item[]; start: number }[] = [];
    for (let i = 0; i < items.length; i += config.batchSize) {
      batches.push({ items: items.slice(i, i + config.batchSize), start: i });
    }
    const started = Date.now();
    const responses: (Awaited<ReturnType<typeof postSystemOne>> | undefined)[] = new Array(
      batches.length,
    );
    let cursor = 0;
    let completed = 0;
    let rowsDone = 0;
    const workers = new Array(Math.min(config.concurrency, batches.length)).fill(0).map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= batches.length) return;
        const batch = batches[index] as { items: Item[]; start: number };
        const questions: Record<string, unknown> = {};
        const stateRows: Record<string, unknown>[] = [];
        batch.items.forEach((item, rowIndex) => {
          questions[`r${rowIndex}`] = buildQuestion(spec.kind, spec.condition, spec.options, rowIndex);
          stateRows.push(item.row);
        });
        try {
          responses[index] = await postSystemOne(config, {
            model: config.model,
            state: buildState(spec.kind, spec.condition, stateRows),
            questions,
          });
        } catch (error) {
          this.counters.errors += 1;
          throw error;
        }
        completed += 1;
        // Progress follows completion order, like pg-jev's as_completed() loop: both numbers only
        // ever grow, instead of summing whichever batches happen to come first.
        rowsDone += batch.items.length;
        if (config.notices && batches.length > 1) {
          this.notice(
            `jev: progress ${completed}/${batches.length} requests, ${rowsDone}/${items.length} rows`,
          );
        }
      }
    });
    await Promise.all(workers);
    const answers = new Map<number, JevAnswer>();
    let tokens = 0;
    let outputTokens = 0;
    let apiMs = 0;
    let model: string | null = null;
    batches.forEach((batch, batchIndex) => {
      const response = responses[batchIndex];
      if (!response) return;
      this.counters.requests += 1;
      this.counters.batches += 1;
      const usage = response.usage ?? {};
      tokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      apiMs += response._ms ?? 0;
      model = response.model ?? model;
      this.counters.input_tokens += usage.input_tokens ?? 0;
      this.counters.output_tokens += usage.output_tokens ?? 0;
      this.counters.api_ms += response._ms ?? 0;
      batch.items.forEach((_item, rowIndex) => {
        const answer = response.answers[`r${rowIndex}`];
        if (answer) answers.set(batch.start + rowIndex, answer);
      });
      return;
    });
    this.counters.rows_evaluated += items.length;
    const elapsed = Math.max(Date.now() - started, 0);
    return { answers, requests: batches.length, tokens, outputTokens, apiMs: apiMs || elapsed, model };
  }

  /** Idempotent upsert, chunked to respect the engine's bound-parameter limit. */
  private async persist(
    scope: string,
    spec: JudgeSpec,
    items: Item[],
    answers: Map<string, JevAnswer>,
    model: string | null,
  ): Promise<void> {
    if (!this.config.persistJudgments) {
      for (const item of items) {
        const answer = answers.get(item.rowRef);
        if (answer) {
          this.memory.set(memoryKey(scope, item.rowRef, spec.key), {
            hash: item.hash,
            raw: JSON.stringify(answer),
          });
        }
      }
      return;
    }
    const columns = 14;
    const perStatement = Math.max(1, Math.floor(this.adapter.capabilities.maxBoundParams / columns));
    const sql = `${UPSERT_HEAD}(${new Array(columns).fill('?').join(', ')})${UPSERT_TAIL}`;
    const statements: { sql: string; params: unknown[] }[] = [];
    for (const item of items) {
      const answer = answers.get(item.rowRef);
      if (!answer) continue;
      this.memory.set(memoryKey(scope, item.rowRef, spec.key), {
        hash: item.hash,
        raw: JSON.stringify(answer),
      });
      const levels = spec.options ? spec.options.length : null;
      statements.push({
        sql,
        params: [
          scope,
          item.rowRef,
          item.hash,
          spec.key,
          spec.kind,
          spec.condition,
          spec.options ? canonicalJson(spec.options) : null,
          JSON.stringify(answer),
          answerProb(answer),
          answerChoice(answer),
          answerScore(answer),
          levels,
          answerConfidence(answer),
          model,
        ],
      });
    }
    if (statements.length === 0) return;
    const caps = this.adapter.capabilities;
    if (caps.multiStatementExec && caps.maxStatementBytes > 0) {
      await this.persistAsScript(statements, caps.maxStatementBytes);
      return;
    }
    const chunkSize = Math.max(1, perStatement);
    const chunks: { sql: string; params: unknown[] }[][] = [];
    for (let i = 0; i < statements.length; i += chunkSize) {
      chunks.push(statements.slice(i, i + chunkSize));
    }
    if (this.adapter.batchStatements) {
      const batches = Math.max(1, Math.min(this.config.batchStatements, caps.maxBatchStatements));
      for (let i = 0; i < chunks.length; i += batches) {
        await this.adapter.batchStatements(chunks.slice(i, i + batches).flat());
      }
      return;
    }
    for (const chunk of chunks) {
      for (const statement of chunk) {
        await this.adapter.query(statement.sql, statement.params);
      }
    }
  }

  /**
   * Cloudflare D1 path: literal multi-row INSERTs packed into few exec() calls.
   * D1 allows only 100 bound parameters per statement (7 rows) but ~100 KB per SQL string
   * (100+ rows) and 1000 queries per Worker invocation, so a script beats parameters there.
   * Partial writes are harmless: every statement is an idempotent upsert.
   */
  private async persistAsScript(
    statements: { sql: string; params: unknown[] }[],
    maxStatementBytes: number,
  ): Promise<void> {
    const limit = Math.max(1024, Math.floor(maxStatementBytes * 0.8));
    let buffer: string[] = [];
    let size = 0;
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const script = buffer.join(';\n');
      buffer = [];
      size = 0;
      await this.adapter.exec(script);
    };
    for (const statement of statements) {
      const tuple = `(${statement.params.map(sqlValue).join(', ')})`;
      const text = `${UPSERT_HEAD}${tuple}${UPSERT_TAIL}`;
      if (size > 0 && size + text.length > limit) await flush();
      buffer.push(text);
      size += text.length + 2;
    }
    await flush();
  }

  /** Ad-hoc rows (subquery results, JSON payloads): content-keyed, like pg-jev's fallback path. */
  private async judgeArray(
    spec: JudgeSpec,
    rows: Record<string, unknown>[],
  ): Promise<(JevAnswer | undefined)[]> {
    await this.ready();
    this.requireSchema();
    if (rows.length === 0) return [];
    const clean = rows.map((row) => jsonSafeRow(row));
    const hashes = await sha256HexAll(clean.map((row) => canonicalJson(row)));
    const items: Item[] = clean.map((row, index) => ({
      rowRef: hashes[index] as string,
      hash: hashes[index] as string,
      row,
    }));
    const { answers, judged, alreadyJudged } = await this.ensure(
      spec,
      AD_HOC_SCOPE,
      items,
      newStatementBudget(),
    );
    // The JS row API spends exactly like the SQL API, so it reports exactly like the SQL API:
    // these numbers come from ensure()/judgeBatch(), never from a placeholder.
    const run = runSummary(AD_HOC_SCOPE, spec, judged, alreadyJudged);
    if (judged.rows > 0) {
      this.notice(
        `jev: ${spec.kind} → judged ${judged.rows} row${judged.rows === 1 ? '' : 's'} ` +
          `in ${judged.requests} request${judged.requests === 1 ? '' : 's'}, ${run.input_tokens} input tokens ` +
          `(≈$${run.estimated_cost_usd.toFixed(4)}), ${judged.apiMs.toFixed(0)} ms`,
      );
      if (this.config.persistJudgments) await this.logRun(run);
    } else {
      this.notice(
        `jev: ${spec.kind} → all ${items.length} row${items.length === 1 ? '' : 's'} already judged: ` +
          '0 requests, $0',
      );
    }
    return items.map((item) => answers.get(item.rowRef));
  }
}

/**
 * The in-process mirror key. JSON.stringify of the tuple is injective for any scope, row ref and
 * judgment key -- including a condition holding the U+001F separator -- so two different
 * judgments can never share a mirrored answer.
 */
function memoryKey(scope: string, rowRef: string, judgmentKeyValue: string): string {
  return JSON.stringify([scope, rowRef, judgmentKeyValue]);
}

function collectStored(
  target: Map<string, { hash: string; answer: JevAnswer; raw: string }>,
  row: Record<string, unknown>,
): void {
  const rowRef = row['row_ref'];
  const raw = row['answer_json'];
  const hash = row['row_hash'];
  if (typeof rowRef !== 'string' || typeof raw !== 'string') return;
  try {
    target.set(rowRef, {
      hash: typeof hash === 'string' ? hash : '',
      answer: JSON.parse(raw) as JevAnswer,
      raw,
    });
  } catch {
    // a corrupt cache entry is simply re-judged
  }
}

export { AD_HOC_SCOPE, ROW_REF_COLUMN };
