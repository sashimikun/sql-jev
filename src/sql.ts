/**
 * SQLite-side helpers: canonical row JSON, judgment keys, literals and hashing.
 *
 * The judgment key is the analogue of pg-jev's session cache key
 * `json.dumps([rel_type, query, kind, opts], sort_keys=True)`: the same condition written
 * twice collapses to one judged set.
 */

import { DEFAULT_MODEL } from './config.js';
import { JevSqlError } from './types.js';

/**
 * Field separator of a judgment key, and the separator of the in-process mirror entry.
 *
 * It is NOT true that U+001F cannot reach a key: a SQL string literal may hold any byte except
 * NUL, so a condition can contain one, and `model` comes from `jev_settings` / the env. The fields
 * are escaped before they are joined, exactly because of that -- see `escapeKeyField()`.
 */
export const KEY_SEP = '\u001f';

/**
 * Longest condition/question a judgment key will carry (32 KiB).
 *
 * The key is inlined into the rewritten statement as a SQL literal, and it carries the condition
 * verbatim, so the condition's length becomes the statement's length: measured today, a
 * 100 000-character condition rewrites to a 100 221-character SELECT, and Cloudflare D1 rejects a
 * statement over ~100 KB. That failure is not free: rows are sent to the model before the rewritten
 * statement runs, so the money is spent and the user gets `D1_ERROR: SQL statement too long`.
 * 32 KiB of condition keeps every call's contribution at about a third of the limit (32 989
 * characters measured), so a statement can still hold several max-size calls.
 */
export const MAX_CONDITION_CHARS = 32 * 1024;

/**
 * Doubles every separator inside one key field, so a field can never contain an *unescaped* one.
 *
 * The key is a plain join, so an unescaped separator inside a field moves the field boundaries and
 * makes the encoding ambiguous. Reproduced before this escape existed:
 *
 *   judgmentKey('noul', 'x\u001f\u001f1\u001fm', null, 'M')
 *   judgmentKey('noul', 'x',                     null, 'm\u001f\u001f1\u001fM')
 *
 * both return `noul\u001fx\u001f\u001f1\u001fm\u001f\u001f1\u001fM`, so the second pair reads the
 * first pair's answers: a forged cache entry. `condition` is user text, `options` is JSON-escaped
 * already, and `model` comes from `jev_settings`/env, so two reachable fields could carry a
 * separator.
 *
 * Doubling (rather than dropping or replacing the character) keeps the encoding injective -- a
 * doubled separator is data, a single one is a boundary -- and leaves every separator-free field
 * byte-identical. Keys for ordinary conditions therefore do not change, so this escape costs
 * existing installations nothing. Brute-forced in test/key.dogfood.test.ts.
 */
function escapeKeyField(value: string): string {
  return value.includes(KEY_SEP) ? value.split(KEY_SEP).join(KEY_SEP + KEY_SEP) : value;
}

/**
 * Version of the question templates (the instructions/criteria sent to the model). Bump it when a
 * template changes: it is part of every judgment key, so old answers stop matching and are re-judged.
 */
export const KEY_FORMAT = '1';

/** How deep a row value may nest before we refuse it instead of recursing forever. */
const MAX_ROW_DEPTH = 64;

/**
 * The one definition of what a row value becomes on the wire (request body and row hash).
 * SQLite hands BLOBs back as `Uint8Array` and big integers as `BigInt`, and a JS caller can
 * pass a `Date`, a `Map`, a `Buffer` or a cycle. Plain `JSON.stringify` would silently send
 * `{"0":222,"1":173}` for a BLOB, `{}` for a Map and would throw for BigInt, so the rules are
 * explicit here and `jsonSafeRow()` applies them before hashing *and* before sending:
 *
 *   undefined / function / symbol    dropped from objects, `null` inside arrays
 *   NaN / ±Infinity / Invalid Date   `null` (JSON has no such values)
 *   bigint                           a number when exactly representable, else a decimal string
 *   Date                             ISO-8601 string
 *   Uint8Array / Buffer / ArrayBuffer / DataView
 *                                    `\x` + lowercase hex, the text Postgres' jsonb uses for
 *                                    bytea -- not a fake `{"0":..}` byte map sent to the model
 *   Map                              object with string keys; Set -> array
 *   object with toJSON()             the result of toJSON()
 *   cycle or > 64 levels             JevSqlError, loudly
 */
export function normalizeForApi(value: unknown, depth = 0, seen?: Set<object>): unknown {
  if (value === null) return null;
  // undefined is not null: the policy above drops it from an object (the key was never there for
  // JSON.stringify either) and only turns it into null inside an array, where the slot must stay.
  if (value === undefined) return undefined;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value as number) ? value : null;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (type === 'function' || type === 'symbol') return undefined;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : value.toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return `\\x${hexOfBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))}`;
  }
  if (value instanceof ArrayBuffer) return `\\x${hexOfBytes(new Uint8Array(value))}`;
  if (depth > MAX_ROW_DEPTH) {
    throw new JevSqlError(`jev: row value nests deeper than ${MAX_ROW_DEPTH} levels`);
  }
  const ancestors = seen ?? new Set<object>();
  if (ancestors.has(value as object)) {
    throw new JevSqlError('jev: row value contains a cycle and cannot be sent to the model');
  }
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForApi(item, depth + 1, ancestors) ?? null);
    }
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value) out[String(key)] = normalizeForApi(item, depth + 1, ancestors);
      return out;
    }
    if (value instanceof Set) {
      return [...value].map((item) => normalizeForApi(item, depth + 1, ancestors) ?? null);
    }
    const record = value as Record<string, unknown> & { toJSON?: unknown };
    if (typeof record.toJSON === 'function') {
      return normalizeForApi((record.toJSON as () => unknown).call(record), depth + 1, ancestors);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const item = normalizeForApi(record[key], depth + 1, ancestors);
      if (item !== undefined) out[key] = item;
    }
    return out;
  } finally {
    ancestors.delete(value as object);
  }
}

/** Stable JSON text of an already normalized value: keys sorted, no whitespace. */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    parts.push(`${JSON.stringify(key)}:${stableJson(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Stable JSON with sorted object keys, used for hashing and for cache keys.
 * `canonicalJson(row)` and `JSON.stringify(jsonSafeRow(row))` describe the same values, so the
 * row hash always covers exactly what the model was sent.
 */
export function canonicalJson(value: unknown): string {
  return stableJson(normalizeForApi(value));
}

/**
 * kind | condition | options | format | model, the unique identity of one judgment.
 *
 * Every field is run through `escapeKeyField()` first, so a separator inside a field (a condition
 * from a hostile SQL string, a model id from `jev_settings`) cannot shift the field boundaries and
 * forge another pair's key.
 *
 * `format` (KEY_FORMAT) is bumped whenever the question templates change, and `model` is the
 * REQUESTED model (`jev-latest`, `jev-1.13.0`, ...). Both are in the key on purpose: a judgment
 * made by another model, or by another prompt shape, is not an answer to today's question. Without
 * them a model swap silently reuses the old values -- which is exactly what happens on engines whose
 * cache is only session-scoped, where nobody notices until the results look wrong.
 *
 * Because the key carries the *requested* model and not the resolved one, changing what an alias
 * like `jev-latest` points at does NOT invalidate anything: a table judged before the alias moved
 * keeps serving those answers next to answers from the new version, all under one key. The resolved
 * model is recorded (`jev_judgments.model`, `RunSummary.model`), so a mixed cache is visible with
 * `SELECT model, count(*) FROM jev_judgments GROUP BY model`, and can be cleared with
 * `DELETE FROM jev_judgments WHERE model <> '<the version you want>'`. Pin a concrete version in
 * settings if the answer set must move with the server.
 *
 * The same asymmetry costs one re-judge in the other direction: `jev-latest` and the version it
 * currently resolves to are two different keys, so switching between them judges every row again
 * even though the same model answers. Measured live: `jev-latest` resolved to `jev-1.13.0`, and
 * pinning `jev-1.13.0` judged all 5 rows of a 5-row table a second time.
 *
 * A condition longer than MAX_CONDITION_CHARS is refused here, before any API call, because the key
 * is inlined into the rewritten statement (see MAX_CONDITION_CHARS).
 */
export function judgmentKey(
  kind: string,
  condition: string,
  options: string[] | null | undefined,
  model: string = DEFAULT_MODEL,
): string {
  if (condition.includes('\u0000')) {
    throw new JevSqlError('jev: NUL bytes are not supported in conditions or questions');
  }
  if (condition.length > MAX_CONDITION_CHARS) {
    throw new JevSqlError(
      `jev: this condition is ${condition.length} characters long, above the ` +
        `${MAX_CONDITION_CHARS}-character limit for a condition or question. The judgment key ` +
        'carries the condition and is inlined into the rewritten statement, and Cloudflare D1 ' +
        'rejects a statement over ~100 KB -- after the rows have already been sent to the model. ' +
        'Pass the long text as a column of the relation and ask a short question about it.',
    );
  }
  const opts = options && options.length ? canonicalJson(options) : '';
  return [kind, condition, opts, KEY_FORMAT, model].map(escapeKeyField).join(KEY_SEP);
}

/** A single-quoted SQL string literal, safe for remote engines and parameter limits. */
export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) {
    throw new JevSqlError('jev: NUL bytes are not supported in identifiers or conditions');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** A double-quoted SQL identifier. */
export function quoteIdentifier(value: string): string {
  if (value.includes('\u0000')) {
    throw new JevSqlError('jev: NUL bytes are not supported in identifiers');
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** 'people' -> "people"; 'main.people' -> "main"."people" */
export function relationSqlFor(scope: string): string {
  return scope
    .split('.')
    .map((part) => quoteIdentifier(part))
    .join('.');
}

const encoder = new TextEncoder();

/** Lowercase hex of a byte view, used for SHA-256 digests and for binary row values. */
function hexOfBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

/** sha256 hex of a row's canonical JSON; the cache key inside a relation. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new JevSqlError(
      'jev: WebCrypto is unavailable in this runtime, so rows cannot be hashed for caching',
    );
  }
  return hexOfBytes(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(text))));
}

/** Hashes many rows without unbounded parallelism. */
export async function sha256HexAll(texts: string[], concurrency = 32): Promise<string[]> {
  const out = new Array<string>(texts.length);
  let cursor = 0;
  const workers = new Array(Math.min(Math.max(concurrency, 1), Math.max(texts.length, 1)))
    .fill(0)
    .map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= texts.length) return;
        out[index] = await sha256Hex(texts[index] as string);
      }
    });
  await Promise.all(workers);
  return out;
}

/**
 * The row as it goes to the model: every value put through normalizeForApi(), so
 * `JSON.stringify(jsonSafeRow(row))` always equals `canonicalJson(row)` -- the row hash covers
 * exactly the bytes the API was sent, for BLOBs, BigInts, Dates and nested objects alike.
 */
export function jsonSafeRow(row: Record<string, unknown>): Record<string, unknown> {
  // Round-tripping through canonicalJson gives three things at once: the value policy above,
  // deeply sorted object keys, and therefore `JSON.stringify(jsonSafeRow(row)) === canonicalJson(row)`
  // at every nesting level. The row hash must cover exactly the body the model is sent, or the
  // cache key could drift from the wire body (a nested object whose keys were inserted in a
  // different order would hash differently from the bytes on the wire). A cycle or an
  // over-deep value throws here, before anything is sent.
  return JSON.parse(canonicalJson(row)) as Record<string, unknown>;
}
