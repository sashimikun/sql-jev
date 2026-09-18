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

/** Stable JSON with sorted object keys, used for hashing and for cache keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'bigint') return String(value);
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** kind | condition | options, the unique identity of one judgment. */
export function judgmentKey(
  kind: string,
  condition: string,
  options: string[] | null | undefined,
): string {
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

/** Rows bigger than this are truncated in notices, never in requests. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

const encoder = new TextEncoder();

/** sha256 hex of a row's canonical JSON; the cache key inside a relation. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new JevSqlError(
      'jev: WebCrypto is unavailable in this runtime, so rows cannot be hashed for caching',
    );
  }
  return toHex(await subtle.digest('SHA-256', encoder.encode(text)));
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

/** rows[i] references used by the questions, so a row must be plain JSON-serializable. */
export function jsonSafeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
