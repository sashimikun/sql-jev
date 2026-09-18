/**
 * Configuration. Same names and defaults as the pg-jev GUCs, so `SET jev.batch_size = 2`
 * becomes `UPDATE jev_settings SET value = '2' WHERE key = 'batch_size'` or
 * `createJev({ batchSize: 2 })`.
 */

import { JevError } from './types.js';

export interface JevConfig {
  /** TypeSafe API key. Falls back to TYPESAFE_API_KEY, then jev_settings.api_key. */
  apiKey?: string;
  /** jev.api_url */
  apiUrl: string;
  /** jev.model */
  model: string;
  /** jev.threshold: probability at which jev() returns true. */
  threshold: number;
  /** jev.batch_size: rows per API request. */
  batchSize: number;
  /** jev.concurrency: parallel API requests. */
  concurrency: number;
  /** jev.max_prefetch_rows: rows read ahead from the scanned relation. */
  maxPrefetchRows: number;
  /** jev.notices: emit a notice per batch run. */
  notices: boolean;
  /** jev.timeout: seconds per API request. */
  timeoutMs: number;
  /** jev.max_rows_per_statement: 0 disables the guard. */
  maxRowsPerStatement: number;
  /** jev.max_chars_per_statement: 0 disables the guard. */
  maxCharsPerStatement: number;
  /** Rows read per pagination step while prefetching a relation. */
  pageSize: number;
  /** Statements sent to Adapter.batchStatements() in one call. */
  batchStatements: number;
  /** Persist judgments in jev_judgments (on) or keep them in process memory only (off). */
  persistJudgments: boolean;
  /** Re-read judgments from jev_judgments on every query instead of using the in-process cache. */
  alwaysRecheck: boolean;
  /** Where notices go. */
  onNotice: (message: string) => void;
}

export const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';

export function defaultConfig(): JevConfig {
  return {
    apiUrl: DEFAULT_API_URL,
    model: 'jev-latest',
    threshold: 0.5,
    batchSize: 40,
    concurrency: 6,
    maxPrefetchRows: 5000,
    notices: true,
    timeoutMs: 90_000,
    maxRowsPerStatement: 0,
    maxCharsPerStatement: 0,
    pageSize: 1000,
    batchStatements: 50,
    persistJudgments: true,
    alwaysRecheck: false,
    onNotice: (message: string) => console.warn(message),
  };
}

/** One row per settings key, as seeded by sql/sql-jev.sql. */
export type JevSettings = Record<string, string>;

export function settingsFromRows(rows: Record<string, unknown>[]): JevSettings {
  const settings: JevSettings = {};
  for (const row of rows) {
    const key = row['key'];
    const value = row['value'];
    if (typeof key === 'string') settings[key] = value === null || value === undefined ? '' : String(value);
  }
  return settings;
}

function num(settings: JevSettings, key: string, fallback: number): number {
  const raw = settings[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new JevError(`jev: setting ${key} must be a number, got '${raw}'`);
  }
  return parsed;
}

function bool(settings: JevSettings, key: string, fallback: boolean): boolean {
  const raw = settings[key];
  if (raw === undefined || raw === '') return fallback;
  return ['on', 'true', '1', 'yes'].includes(raw.toLowerCase()) ? true : !['off', 'false', '0', 'no'].includes(raw.toLowerCase()) ? fallback : false;
}

/** DB settings first (shared across clients), then explicit overrides, then env. */
export function resolveConfig(
  overrides: Partial<JevConfig> = {},
  settings: JevSettings = {},
): JevConfig {
  const base = defaultConfig();
  const merged: JevConfig = {
    ...base,
    apiUrl: settings['api_url'] || base.apiUrl,
    model: settings['model'] || base.model,
    threshold: num(settings, 'threshold', base.threshold),
    batchSize: num(settings, 'batch_size', base.batchSize),
    concurrency: num(settings, 'concurrency', base.concurrency),
    maxPrefetchRows: num(settings, 'max_prefetch_rows', base.maxPrefetchRows),
    notices: bool(settings, 'notices', base.notices),
    timeoutMs: num(settings, 'timeout', 90) * 1000,
    maxRowsPerStatement: num(settings, 'max_rows_per_statement', base.maxRowsPerStatement),
    maxCharsPerStatement: num(settings, 'max_chars_per_statement', base.maxCharsPerStatement),
    ...overrides,
  };
  if (merged.apiKey === undefined) {
    const envKey =
      settings['api_key'] ||
      (typeof process !== 'undefined' ? process.env?.['TYPESAFE_API_KEY'] : undefined) ||
      undefined;
    if (envKey) merged.apiKey = envKey;
  }
  merged.batchSize = Math.max(1, Math.trunc(merged.batchSize));
  merged.concurrency = Math.max(1, Math.trunc(merged.concurrency));
  merged.pageSize = Math.max(1, Math.trunc(merged.pageSize));
  merged.batchStatements = Math.max(1, Math.trunc(merged.batchStatements));
  if (merged.apiKey === '') delete merged.apiKey;
  return merged;
}
