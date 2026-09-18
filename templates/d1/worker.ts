/**
 * sql-jev on Cloudflare Workers + D1 -- a small JSON HTTP API.
 *
 * WHY THE SQL IS REWRITTEN (read this before editing)
 * ---------------------------------------------------
 * SQLite has no user-defined SQL functions, and a hosted SQLite never calls the network
 * from inside a query. So `SELECT ... WHERE jev(people, 'the name is European')` cannot
 * execute as written on D1: nothing reachable from SQL can talk to TypeSafe.
 *
 * sql-jev splits the work: JavaScript does the talking, SQLite does the scanning.
 *   1. jev.query()/plan() finds every jev(<relation>, ...) call in the statement.
 *   2. The SDK read-aheads that relation from D1 (bounded by jev.max_prefetch_rows),
 *      exactly like the pg-jev read-ahead.
 *   3. Rows are packed jev.batch_size per request into TypeSafe System One calls, run
 *      jev.concurrency at a time -- from JavaScript, where fetch() exists.
 *   4. Every answer is upserted into jev_judgments keyed by (scope, row_ref,
 *      judgment_key): the durable replacement for pg-jev's session cache.
 *   5. Each jev(...) call is rewritten into a correlated lookup against jev_judgments,
 *      and that plain SQL statement is what D1 finally executes.
 *
 * Consequence: a repeated query, a changed threshold, or a sort by probability costs
 * zero API calls, and any Worker in any region reuses the judgments already in the DB.
 *
 * CLOUDFLARE LIMITS THIS CODE RESPECTS
 * ------------------------------------
 *   - 100 bound parameters per statement (POST /query rejects more)
 *   - ~100 KB per SQL statement         (POST /query rejects more)
 *   - 1000 D1 queries per Worker invocation: warming a large relation plus the rewritten
 *     statement must fit in one invocation, so keep relations small or warm them from a
 *     scheduled job with /warm
 *   - no user-defined SQL functions     (registerUdfs() is a no-op on D1; the rewriter is used)
 *   - no interactive transactions       (the SDK keeps its writes in batched exec()/batch() calls)
 *   - 10 GB per database
 *
 * ROUTES
 * ------
 *   GET  /       service info + version
 *   GET  /health alias of GET / (for uptime checks)
 *   GET  /stats  SELECT * FROM jev_stats (durable totals) + this session's counters
 *   POST /query  { "sql": "SELECT ... WHERE jev(people, '...')", "params": [] }
 *                -> { rows, count, run, sql, notes, session }
 *   POST /warm   { "relation": "people", "condition": "the name is European",
 *                  "kind": "noul" | "score" | "choice", "options": [...] }
 *                -> { run }
 *   POST /judge  { "rows": [{ ... }], "condition": "...", "mode": "filter" | "annotate" }
 *                -> { rows } (filter) or { rows } with a jev_prob column (annotate)
 *
 * WRITE PROTECTION
 * ----------------
 * POST /query accepts exactly one statement and only if it is read-only (SELECT, or WITH
 * ending in SELECT/VALUES). A CTE can precede a write in SQLite --
 * `WITH x AS (SELECT 1) DELETE FROM t` -- so the verb that follows the CTE part decides,
 * not the leading keyword. Everything else (INSERT/UPDATE/DELETE/REPLACE/PRAGMA/DDL) is
 * refused with 400 before it reaches D1.
 *
 * AUTH
 * ----
 * Every route except `GET /`, `GET /health` and the CORS preflight requires
 * `Authorization: Bearer <env.API_TOKEN>`.
 * The TypeSafe key lives in env.TYPESAFE_API_KEY and is only ever handed to createJev();
 * it is never echoed in a response, and error text is scrubbed before it leaves.
 */

/**
 * `sql-jev` is ESM-only and publishes its types from `./dist`, which is produced by
 * `npm run build`. A fresh checkout therefore has no declarations for it, while the
 * import itself stays the real, bundler-resolvable one that Wrangler needs.
 *
 * The local interfaces below mirror the package's exported types, so this template
 * type-checks standalone:
 *
 *   bunx tsc --noEmit --strict --target es2022 --module esnext \
 *     --moduleResolution bundler --skipLibCheck templates/d1/worker.ts
 *
 * Once sql-jev is installed (or dist/ exists), drop the directive and the import is
 * type-checked normally.
 */
// @ts-ignore -- types ship in ./dist; see the note above.
import { createJev as createJevUntyped, JEV_VERSION as jevVersionUntyped } from 'sql-jev';

// ------------------------------------------------------------------ local types

/**
 * Minimal structural mirror of @cloudflare/workers-types and of sql-jev's
 * D1DatabaseLike. `prepare(sql).bind(...).all()` is the only shape the SDK uses, so a
 * real D1 binding satisfies this interface unchanged.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[]; success?: boolean; error?: string }>;
  run?(): Promise<unknown>;
  first?<T = unknown>(): Promise<T | null>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<{ count?: number; duration?: number } | void>;
  batch?(statements: D1PreparedStatement[]): Promise<unknown>;
  withSession?(): unknown;
}

export type JevKind = 'noul' | 'score' | 'choice';

/** Mirrors sql-jev's RunSummary: what one judged set cost (also the shape of a jev_runs row). */
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
}

/** Mirrors sql-jev's QueryResult. */
export interface QueryResult<T> {
  rows: T[];
  /** The SQL that actually ran, with every jev* call replaced by a jev_judgments lookup. */
  sql: string;
  run: RunSummary[];
}

/** Mirrors sql-jev's JevRunStats: the session counters, same shape as pg-jev's jev_stats(). */
export interface JevRunStats {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  rows_evaluated: number;
  cache_hits: number;
  api_ms: number;
  batches: number;
  errors: number;
  estimated_cost_usd: number;
  cached_answers: number;
}

export interface WarmOptions {
  kind?: JevKind;
  options?: string[] | null;
}

export interface JudgeOptions extends WarmOptions {
  threshold?: number;
}

/** The surface of createJev()/Jev that this Worker uses. */
export interface Jev {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  translate(sql: string): Promise<string>;
  warm(relation: string, condition: string, options?: WarmOptions): Promise<RunSummary>;
  filter<T extends Record<string, unknown>>(
    rows: T[],
    condition: string,
    options?: JudgeOptions,
  ): Promise<T[]>;
  annotate<T extends Record<string, unknown>>(
    rows: T[],
    condition: string,
  ): Promise<(T & { jev_prob: number })[]>;
  stats(): JevRunStats;
  dbStats(): Promise<Record<string, unknown>[]>;
  schema(): Promise<void>;
  version(): Promise<string>;
  registerUdfs(): boolean;
}

export interface CreateJevOptions {
  /** Cloudflare D1 binding. */
  d1?: D1Database;
  /** TypeSafe API key. Falls back to env.TYPESAFE_API_KEY, then jev_settings.api_key. */
  apiKey?: string;
  loadSettings?: boolean;
  /** Always false here: D1 cannot register SQL functions. */
  registerUdfs?: boolean;
  apiUrl?: string;
  model?: string;
  threshold?: number;
  batchSize?: number;
  concurrency?: number;
  maxPrefetchRows?: number;
}

export interface CreateJev {
  (options: CreateJevOptions): Promise<Jev>;
}

/** `createJev` with this file's local types; the runtime value is the real one. */
const createJev = createJevUntyped as CreateJev;

/** Version of sql-jev this Worker was built against. */
export const VERSION: string = String(jevVersionUntyped);

/** Env: bindings and secrets from wrangler.toml plus `wrangler secret put`. */
export interface Env {
  /** D1 binding. `[[d1_databases]] binding = "DB"` in wrangler.toml. */
  DB: D1Database;
  /** Shared secret for this API. `wrangler secret put API_TOKEN`. */
  API_TOKEN: string;
  /** TypeSafe System One key. `wrangler secret put TYPESAFE_API_KEY`. */
  TYPESAFE_API_KEY: string;
  /** Optional per-deployment overrides, same names as jev_settings. */
  JEV_MAX_ROWS?: string;
  JEV_THRESHOLD?: string;
  JEV_MODEL?: string;
  JEV_BATCH_SIZE?: string;
  JEV_CONCURRENCY?: string;
  JEV_MAX_PREFETCH_ROWS?: string;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerHandler {
  fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response>;
}

// ------------------------------------------------------------------ constants

export const SERVICE = 'sql-jev-worker';
/** Rows POST /query returns when the statement carries no LIMIT of its own. */
export const MAX_ROWS_DEFAULT = 200;
/** Hard ceiling for JEV_MAX_ROWS: a Worker cannot stream a big result anyway. */
export const MAX_ROWS_CEILING = 1000;
/** D1 refuses a statement with more than 100 bound parameters. */
export const MAX_BOUND_PARAMS = 100;
/** D1 tops out around 100 KB of SQL text per statement. */
export const MAX_STATEMENT_BYTES = 100_000;
/** D1 allows 1000 queries per Worker invocation. */
export const D1_QUERY_BUDGET = 1000;
/** Ad-hoc rows one POST /judge call may carry. */
export const MAX_JUDGE_ROWS = 5000;
/** Request body cap, before JSON.parse. */
export const MAX_BODY_BYTES = 1_000_000;

const KINDS: readonly JevKind[] = ['noul', 'score', 'choice'];

/** "*" so a browser page on any origin can call the API. Narrow this in production. */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

// ------------------------------------------------------------------ HTTP helpers

/** An error with an HTTP status; anything else is reported as 500. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** JSON response with CORS and no-store. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** CORS preflight. */
function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Removes anything that looks like a secret from text that is about to be returned.
 * The TypeSafe key must never travel back to a client, not even inside an error message.
 */
export function redact(text: string, env: Env): string {
  let out = text;
  for (const secret of [env.TYPESAFE_API_KEY, env.API_TOKEN]) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function errorResponse(error: unknown, env: Env): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: redact(message, env) }, 500);
}

/** Constant-time string compare for the bearer secret. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

/** Returns a 401/500 response when the request is not authorized, else null. */
export function authorize(request: Request, env: Env): Response | null {
  if (typeof env.API_TOKEN !== 'string' || env.API_TOKEN.length === 0) {
    return json({ error: 'server misconfigured: API_TOKEN is not set (wrangler secret put API_TOKEN)' }, 500);
  }
  const header = (request.headers.get('Authorization') ?? '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match ? match[1] : null;
  if (token === null || !constantTimeEqual(token, env.API_TOKEN)) {
    return json({ error: 'unauthorized: send Authorization: Bearer <API_TOKEN>' }, 401);
  }
  return null;
}

/** Reads a JSON body with a size guard; throws HttpError(413/400) when it is unusable. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  // Refuse a declared-oversized body before buffering it: a Worker has a hard memory limit.
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, `body larger than ${MAX_BODY_BYTES} bytes`);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, `body larger than ${MAX_BODY_BYTES} bytes`);
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'body must be valid JSON');
  }
}

// ------------------------------------------------------------------ SQL guard

/**
 * True when `sql` holds more than one statement. Semicolons inside string literals,
 * quoted identifiers and comments do not count. Both D1 and POST /query accept exactly
 * one statement per call, so this is a request-shape check, not a sanitizer.
 */
export function hasMultipleStatements(sql: string): boolean {
  let statements = 0;
  let sawToken = false;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      sawToken = true;
      continue;
    }
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === ';') {
      if (sawToken) {
        statements += 1;
        sawToken = false;
      }
      index += 1;
      continue;
    }
    if (!/\s/.test(char)) sawToken = true;
    index += 1;
  }
  if (sawToken) statements += 1;
  return statements > 1;
}

/** First keyword of a statement, skipping leading whitespace and comments. */
export function leadingKeyword(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    break;
  }
  const match = /^[A-Za-z]+/.exec(sql.slice(index));
  return match ? match[0].toUpperCase() : '';
}

/** Trailing whitespace and a single trailing separator removed. */
function stripTrailingSeparator(sql: string): string {
  let out = sql.trim();
  while (out.endsWith(';')) out = out.slice(0, -1).trimEnd();
  return out;
}

/**
 * String literals, quoted identifiers and comments replaced by spaces. The result keeps the
 * input's length and every parenthesis, so parens, keywords and parameter markers can be
 * scanned without being fooled by `'-- not a comment'`, by a `?` inside a literal, or by a
 * `'limit 5'` string.
 */
export function stripNonCode(sql: string): string {
  const out = [...sql];
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) out[index] = ' ';
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      blank(start, index);
      continue;
    }
    if (char === '[') {
      const start = index;
      while (index < sql.length && sql[index] !== ']') index += 1;
      index += 1;
      blank(start, index);
      continue;
    }
    if (char === '-' && next === '-') {
      const start = index;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      blank(start, index);
      continue;
    }
    if (char === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      blank(start, index);
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Candidate verbs of a statement: the first word, plus every word that directly follows a
 * `)` closing a group at the outermost level. That is exactly where the verb of a
 * `WITH ... AS (...) <verb>` statement sits, so a CTE body cannot hide it.
 */
function topLevelVerbCandidates(sql: string): string[] {
  const stripped = stripNonCode(sql);
  const words: string[] = [];
  let depth = 0;
  let afterGroup = false;
  let seen = false;
  let index = 0;
  while (index < stripped.length) {
    const char = stripped[index];
    if (char === '(') {
      depth += 1;
      afterGroup = false;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      afterGroup = depth === 0;
      index += 1;
      continue;
    }
    if (/\s/.test(char ?? '')) {
      index += 1;
      continue;
    }
    if (depth > 0) {
      afterGroup = false;
      index += 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stripped.slice(index));
    if (!match) {
      afterGroup = false;
      index += 1;
      continue;
    }
    if (!seen || afterGroup) words.push(match[0].toUpperCase());
    seen = true;
    afterGroup = false;
    index += match[0].length;
  }
  return words;
}

const STATEMENT_VERBS = new Set([
  'SELECT', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER',
  'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE', 'ATTACH', 'DETACH', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'RELEASE', 'END', 'EXPLAIN', 'LOAD', 'MERGE', 'CALL', 'SET',
]);

/**
 * The verb the statement really runs. SQLite allows a CTE before a write
 * (`WITH x AS (SELECT 1) DELETE FROM t`), so the leading keyword on its own is not enough
 * to tell a read from a write.
 */
export function statementVerb(sql: string): string {
  for (const word of topLevelVerbCandidates(sql)) if (STATEMENT_VERBS.has(word)) return word;
  return '';
}

/** Only a statement that really runs SELECT/VALUES may reach D1: this Worker is read-only. */
export function isReadOnlyStatement(sql: string): boolean {
  const verb = statementVerb(sql);
  return verb === 'SELECT' || verb === 'VALUES';
}

/**
 * True when the statement carries a LIMIT of its own, at the outermost level and outside
 * literals and comments: `LIMIT 5`, `LIMIT 5 OFFSET 2`, `LIMIT ?`, `LIMIT 2, 1`, `LIMIT 5 --`.
 * A LIMIT inside a subquery does not count: the outer statement is still unbounded.
 */
export function hasTopLevelLimit(sql: string): boolean {
  const stripped = stripNonCode(sql);
  let depth = 0;
  let index = 0;
  while (index < stripped.length) {
    const char = stripped[index];
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth > 0) {
      index += 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stripped.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    if (match[0].toUpperCase() === 'LIMIT') return true;
    index += match[0].length;
  }
  return false;
}

/**
 * How many bound values the statement needs, using SQLite's own index assignment for `?`,
 * `?NNN`, `:name` and `@name`. Returns null when the statement contains a `$` followed by an
 * identifier character: that is either a `$name` parameter or a `$` inside an identifier, and
 * a text scan cannot tell them apart, so the count is left to D1.
 */
export function boundParameterCount(sql: string): number | null {
  const stripped = stripNonCode(sql);
  if (/\$[A-Za-z0-9_]/.test(stripped)) return null;
  const named = new Set<string>();
  let next = 0;
  let index = 0;
  while (index < stripped.length) {
    const char = stripped[index];
    if (char === '?') {
      const digits = /^\d+/.exec(stripped.slice(index + 1));
      if (digits) {
        next = Math.max(next, Number(digits[0]));
        index += 1 + digits[0].length;
        continue;
      }
      next += 1;
      index += 1;
      continue;
    }
    if (char === ':' || char === '@') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stripped.slice(index + 1));
      if (match) {
        const name = `${char}${match[0].toLowerCase()}`;
        if (!named.has(name)) {
          named.add(name);
          next += 1;
        }
        index += 1 + match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return next;
}

/**
 * Keeps a response bounded: when the statement has no LIMIT of its own, one is appended and
 * the caller is told about it in `notes`. An explicit LIMIT is left untouched -- including
 * `LIMIT ?` and SQLite's `LIMIT offset, count` form.
 */
export function boundRows(sql: string, maxRows: number): { sql: string; notes: string[] } {
  const trimmed = stripTrailingSeparator(sql);
  if (hasTopLevelLimit(trimmed)) return { sql: trimmed, notes: [] };
  // `VALUES (1), (2)` is a literal list already bounded by the statement text, and SQLite
  // rejects a LIMIT clause after a bare VALUES list (`near "LIMIT": syntax error`).
  if (statementVerb(trimmed) === 'VALUES') return { sql: trimmed, notes: [] };
  return {
    sql: `${trimmed} LIMIT ${maxRows}`,
    notes: [`appended LIMIT ${maxRows}: raise env.JEV_MAX_ROWS or add an explicit LIMIT for more`],
  };
}

function maxRows(env: Env): number {
  const configured = envNumber(env.JEV_MAX_ROWS);
  if (configured === undefined || configured < 1) return MAX_ROWS_DEFAULT;
  return Math.min(Math.trunc(configured), MAX_ROWS_CEILING);
}

// ------------------------------------------------------------------ jev glue

function envNumber(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Per-deployment overrides from the Worker environment, in jev_settings naming. */
function envOverrides(env: Env): Partial<CreateJevOptions> {
  const overrides: Partial<CreateJevOptions> = {};
  const threshold = envNumber(env.JEV_THRESHOLD);
  if (threshold !== undefined) overrides.threshold = threshold;
  const batchSize = envNumber(env.JEV_BATCH_SIZE);
  if (batchSize !== undefined) overrides.batchSize = batchSize;
  const concurrency = envNumber(env.JEV_CONCURRENCY);
  if (concurrency !== undefined) overrides.concurrency = concurrency;
  const maxPrefetchRows = envNumber(env.JEV_MAX_PREFETCH_ROWS);
  if (maxPrefetchRows !== undefined) overrides.maxPrefetchRows = maxPrefetchRows;
  if (typeof env.JEV_MODEL === 'string' && env.JEV_MODEL.trim() !== '') overrides.model = env.JEV_MODEL.trim();
  return overrides;
}

/**
 * One Jev handle per request. D1 bindings are per-invocation, so the durable cache is
 * jev_judgments in the database, not the isolate. jev_settings holds the shared
 * threshold/model/batch_size and is read by loadSettings.
 */
async function connect(env: Env): Promise<Jev> {
  return createJev({
    d1: env.DB,
    apiKey: env.TYPESAFE_API_KEY,
    loadSettings: true,
    // D1 cannot register user-defined SQL functions: the rewriter is the only path.
    registerUdfs: false,
    ...envOverrides(env),
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalKind(value: unknown): JevKind | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const kind = String(value).toLowerCase();
  if (!KINDS.includes(kind as JevKind)) {
    throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  }
  return kind as JevKind;
}

function optionalStringArray(value: unknown, field: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array of strings`);
  return value.map((item) => {
    // No silent String() coercion: [1, 2] would otherwise become the levels "1" and "2".
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HttpError(400, `${field} must be an array of non-empty strings`);
    }
    return item;
  });
}

// ------------------------------------------------------------------ routes

function serviceInfo(): Record<string, unknown> {
  return {
    service: SERVICE,
    version: VERSION,
    runtime: 'cloudflare-workers',
    database: 'd1 (binding DB)',
    routes: {
      'GET /': 'service info + version',
      'GET /health': 'alias of GET / (no auth, for uptime checks)',
      'GET /stats': 'SELECT * FROM jev_stats, plus this session counters',
      'POST /query': '{ sql, params? } -> { rows, count, run, sql, notes, session }',
      'POST /warm': '{ relation, condition, kind?, options? } -> { run }',
      'POST /judge': '{ rows, condition, mode? } -> { mode, rows, count }',
    },
    limits: {
      max_rows_per_query: MAX_ROWS_CEILING,
      max_bound_params: MAX_BOUND_PARAMS,
      max_statement_bytes: MAX_STATEMENT_BYTES,
      max_judge_rows: MAX_JUDGE_ROWS,
      max_body_bytes: MAX_BODY_BYTES,
      d1_queries_per_invocation: D1_QUERY_BUDGET,
      user_defined_sql_functions: false,
      interactive_transactions: false,
      max_database_size: '10 GB',
    },
    notes: [
      'SQL cannot call the network, so jev* calls are rewritten into jev_judgments lookups.',
      'One read-only SELECT/WITH statement per POST /query; a null response never means "missing data".',
      'The TypeSafe key is used by the server only and is never returned.',
      'Auth: Authorization: Bearer <API_TOKEN> on every route except GET / and OPTIONS.',
    ],
  };
}

/** GET /stats -- durable totals from the jev_stats view, plus the session counters. */
async function handleStats(env: Env): Promise<Response> {
  const jev = await connect(env);
  const stats = await jev.dbStats();
  return json({ stats: stats[0] ?? null, session: jev.stats() });
}

/**
 * POST /query -- one SELECT/WITH statement, with every jev* call rewritten after the
 * SDK warms the judgments it needs.
 */
async function handleQuery(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const raw = requireString(body.sql, 'sql');
  if (body.params !== undefined && body.params !== null && !Array.isArray(body.params)) {
    throw new HttpError(400, 'params must be an array of bound values');
  }
  const params = Array.isArray(body.params) ? body.params : [];
  if (new TextEncoder().encode(raw).length > MAX_STATEMENT_BYTES) {
    throw new HttpError(413, `sql exceeds the D1 limit of ${MAX_STATEMENT_BYTES} bytes per statement`);
  }
  if (hasMultipleStatements(raw)) {
    throw new HttpError(400, 'send exactly one statement: D1 executes one statement per call');
  }
  const keyword = leadingKeyword(raw);
  if (keyword !== 'SELECT' && keyword !== 'WITH') {
    throw new HttpError(400, `only SELECT/WITH statements are allowed, got '${keyword || 'an empty statement'}'`);
  }
  // `WITH x AS (SELECT 1) DELETE FROM t` is one statement whose first keyword is WITH, and
  // D1 would run the DELETE. The verb decides, not the leading keyword.
  if (!isReadOnlyStatement(raw)) {
    throw new HttpError(
      400,
      `only read-only SELECT/WITH statements are allowed, this one runs ${statementVerb(raw)}`,
    );
  }
  if (params.length > MAX_BOUND_PARAMS) {
    throw new HttpError(400, `D1 allows at most ${MAX_BOUND_PARAMS} bound parameters, got ${params.length}`);
  }
  const expected = boundParameterCount(raw);
  if (expected !== null && expected !== params.length) {
    throw new HttpError(
      400,
      `sql expects ${expected} bound parameter${expected === 1 ? '' : 's'}, got ${params.length}`,
    );
  }

  const cap = maxRows(env);
  const bounded = boundRows(raw, cap);
  const jev = await connect(env);
  const result = await jev.query<Record<string, unknown>>(bounded.sql, params);
  const rows = result.rows.slice(0, cap);
  const notes = [...bounded.notes];
  if (result.rows.length > rows.length) notes.push(`truncated to ${cap} rows`);
  if (result.run.length === 0) notes.push('no jev() calls in this statement: it ran as plain SQL');

  return json({
    rows,
    count: rows.length,
    run: result.run,
    sql: result.sql,
    notes,
    session: jev.stats(),
  });
}

/**
 * POST /warm -- judge a whole relation now, so later queries are pure jev_judgments
 * lookups. Mind the 1000-queries-per-invocation budget on large relations.
 */
async function handleWarm(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const relation = requireString(body.relation, 'relation');
  const condition = requireString(body.condition, 'condition');
  const kind = optionalKind(body.kind) ?? 'noul';
  const options = optionalStringArray(body.options, 'options');
  // jev_choice and jev_score take their levels from `options`; without them the SDK throws
  // and the client sees a 500 for what is a missing request field.
  if (kind === 'choice' || kind === 'score') {
    if (options === null || options.length === 0) {
      throw new HttpError(400, `kind '${kind}' needs options: pass options: ['level', ...]`);
    }
    if (new Set(options).size !== options.length) {
      // Duplicate levels make the legend ambiguous, so the answer would be a guess.
      throw new HttpError(400, `options must not repeat: ${JSON.stringify(options)}`);
    }
  } else if (options !== null) {
    // `jev(people, 'condition')` carries no options; warming with them would store a second
    // judgment under a different key and judge every row twice.
    throw new HttpError(400, "options only apply to kind 'score' or 'choice'");
  }

  const jev = await connect(env);
  const run = await jev.warm(relation, condition, { kind, options });
  return json({ run });
}

/**
 * POST /judge -- conditions over ad-hoc JSON rows: no SQL, no table, no schema. The
 * rows are hashed into the same jev_judgments table, so the answers are cached too.
 */
async function handleJudge(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const condition = requireString(body.condition, 'condition');
  const mode = body.mode === undefined || body.mode === null || body.mode === '' ? 'filter' : String(body.mode);
  if (mode !== 'filter' && mode !== 'annotate') throw new HttpError(400, "mode must be 'filter' or 'annotate'");
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'rows must be an array of objects');
  if (body.rows.length > MAX_JUDGE_ROWS) {
    throw new HttpError(413, `rows must be at most ${MAX_JUDGE_ROWS} per call`);
  }
  const rows: Record<string, unknown>[] = [];
  for (const row of body.rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new HttpError(400, 'every entry of rows must be a JSON object');
    }
    rows.push(row as Record<string, unknown>);
  }

  const jev = await connect(env);
  if (mode === 'annotate') {
    const annotated = await jev.annotate(rows, condition);
    return json({ mode, condition, count: annotated.length, rows: annotated, session: jev.stats() });
  }
  const kept = await jev.filter(rows, condition);
  return json({ mode, condition, count: kept.length, rows: kept, session: jev.stats() });
}

// ------------------------------------------------------------------ worker

const worker: WorkerHandler = {
  /** ESM Worker entry: export default { fetch }. */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return preflight();

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/health') {
        if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        return json(serviceInfo());
      }

      const denied = authorize(request, env);
      if (denied) return denied;

      if (path === '/stats') {
        if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        return await handleStats(env);
      }
      if (path === '/query') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        return await handleQuery(request, env);
      }
      if (path === '/warm') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        return await handleWarm(request, env);
      }
      if (path === '/judge') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        return await handleJudge(request, env);
      }
      return json({ error: `no route for ${request.method} ${path}` }, 404);
    } catch (error) {
      return errorResponse(error, env);
    }
  },
};

export default worker;
