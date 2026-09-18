/**
 * SQLite-side helpers: canonical row JSON, judgment keys, literals and hashing.
 *
 * The judgment key is the analogue of pg-jev's session cache key
 * `json.dumps([rel_type, query, kind, opts], sort_keys=True)`: the same condition written
 * twice collapses to one judged set.
 */

import { JevSqlError } from './types.js';

/** Unit separator: cannot appear in a SQL string literal or a condition typed by a human. */
export const KEY_SEP = '\u001f';

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
 * kind | condition | options, the unique identity of one judgment.
 *
 * The two U+001F separators cannot be forged from the *options* side: those are JSON text, and
 * JSON escapes every control character, so a raw U+001F only ever appears inside `condition`.
 * The final separator is therefore the split point of the key, and distinct conditions keep
 * distinct keys. For the record: `['a\u001fb']` hashes to `["a\u001fb"]` -- escaped -- so it
 * cannot collide with any other pair either.
 */
export function judgmentKey(
  kind: string,
  condition: string,
  options: string[] | null | undefined,
): string {
  if (condition.includes('\u0000')) {
    throw new JevSqlError('jev: NUL bytes are not supported in conditions or questions');
  }
  const opts = options && options.length ? canonicalJson(options) : '';
  return `${kind}${KEY_SEP}${condition}${KEY_SEP}${opts}`;
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
