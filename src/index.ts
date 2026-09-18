/**
 * sql-jev -- ask your SQLite tables questions in plain language.
 *
 *   const jev = await createJev({ client, apiKey: env.TYPESAFE_API_KEY });   // Turso / libSQL
 *   const jev = await createJev({ d1: env.DB,    apiKey: env.TYPESAFE_API_KEY }); // Cloudflare D1
 *   const jev = await createJev({ db,            apiKey: env.TYPESAFE_API_KEY }); // bun:sqlite, node:sqlite
 *
 *   const { rows } = await jev.query(
 *     `SELECT * FROM people WHERE jev(people, 'the name is European')`,
 *   );
 */

import { d1Adapter, libsqlAdapter, sqliteAdapter } from './adapters/index.js';
import type { D1DatabaseLike } from './adapters/d1.js';
import type { LibsqlClientLike } from './adapters/libsql.js';
import type { SqliteLike } from './adapters/sqlite.js';
import type { Adapter } from './adapters/types.js';
import type { JevConfig } from './config.js';
import { Jev } from './engine.js';
import { JevError } from './types.js';

export interface CreateJevOptions extends Partial<JevConfig> {
  /** Bring any dialect: an Adapter is the only thing the engine needs. */
  adapter?: Adapter;
  /** Cloudflare D1 binding, or a Durable Object `ctx.storage.sql` shaped object. */
  d1?: D1DatabaseLike;
  /** A @libsql/client instance (Turso remote, embedded replica, local file). */
  client?: LibsqlClientLike;
  /** bun:sqlite, node:sqlite or better-sqlite3 handle. */
  db?: SqliteLike;
  /** libsql:// or file: URL. Creates a @libsql/client if it is installed. */
  url?: string;
  authToken?: string;
  /** Worker env: TYPESAFE_API_KEY is read from here when apiKey is not given. */
  env?: Record<string, unknown>;
  /** Read api_url/model/threshold/... from jev_settings on ready(). Default true. */
  loadSettings?: boolean;
  /** Register jev* SQL functions after connecting, where the engine supports them. */
  registerUdfs?: boolean;
}

const BINDING_KEYS = [
  'adapter',
  'd1',
  'client',
  'db',
  'url',
  'authToken',
  'env',
  'loadSettings',
  'registerUdfs',
] as const;

function configOverrides(options: CreateJevOptions): Partial<JevConfig> {
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if ((BINDING_KEYS as readonly string[]).includes(key)) continue;
    if (value === undefined) continue;
    overrides[key] = value;
  }
  return overrides as Partial<JevConfig>;
}

export async function resolveAdapter(options: CreateJevOptions): Promise<Adapter> {
  if (options.adapter) return options.adapter;
  if (options.d1) return d1Adapter(options.d1);
  if (options.client) return libsqlAdapter(options.client);
  if (options.db) return sqliteAdapter(options.db);
  if (options.url) {
    let module: { createClient?: (config: { url: string; authToken?: string }) => LibsqlClientLike };
    try {
      // @ts-ignore @libsql/client is an optional peer dependency, only needed for the url form
      module = (await import('@libsql/client')) as typeof module;
    } catch {
      throw new JevError(
        'jev: the { url } form needs @libsql/client. Install it (npm i @libsql/client) ' +
          'or pass { client } that you created yourself.',
      );
    }
    if (typeof module.createClient !== 'function') {
      throw new JevError('jev: @libsql/client did not export createClient');
    }
    const client = module.createClient({
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    });
    return libsqlAdapter(client);
  }
  throw new JevError(
    'jev: connect with one of { adapter }, { d1 }, { client }, { db } or { url }',
  );
}

/** Connects, loads jev_settings, and optionally registers jev* SQL functions. */
export async function createJev(options: CreateJevOptions): Promise<Jev> {
  const adapter = await resolveAdapter(options);
  const overrides = configOverrides(options);
  if (!overrides.apiKey) {
    const fromEnv = options.env?.['TYPESAFE_API_KEY'];
    if (typeof fromEnv === 'string' && fromEnv) overrides.apiKey = fromEnv;
  }
  const jev = new Jev({
    adapter,
    ...overrides,
    loadSettings: options.loadSettings ?? true,
  });
  await jev.ready();
  if (options.registerUdfs) jev.registerUdfs();
  return jev;
}

export { Jev, specFor } from './engine.js';
export type {
  JevOptions,
  JudgeSpec,
  QueryResult,
  RunSummary,
  TagOptions,
  TagResult,
} from './engine.js';
export { analyzeSql, renderCall, rewriteSql, tokenize } from './rewrite.js';
export type { AnalyzedCall, CallOutput, SqlAnalysis, Token } from './rewrite.js';
export {
  KEY_FORMAT,
  KEY_SEP,
  MAX_CONDITION_CHARS,
  canonicalJson,
  judgmentKey,
  quoteIdentifier,
  quoteLiteral,
  relationSqlFor,
  sha256Hex,
} from './sql.js';
export {
  DEFAULT_API_URL,
  defaultConfig,
  resolveConfig,
  settingsFromRows,
} from './config.js';
export type { JevConfig, JevSettings } from './config.js';
export {
  JEV_VERSION,
  JevError,
  JevSqlError,
  USD_PER_INPUT_TOKEN,
  answerChoice,
  answerConfidence,
  answerLevelsCount,
  answerProb,
  answerScore,
  buildQuestion,
  buildState,
  scoreNorm,
} from './types.js';
export type { JevAnswer, JevKind, JevRunStats, JevUsage } from './types.js';
export {
  d1Adapter,
  isSelect,
  libsqlAdapter,
  returnsRows,
  rowObjects,
  splitStatements,
  sqliteAdapter,
  statementVerb,
} from './adapters/index.js';
export type {
  Adapter,
  AdapterCapabilities,
  Statement as AdapterStatement,
} from './adapters/index.js';
export type { D1DatabaseLike, D1PreparedStatementLike } from './adapters/d1.js';
export type { LibsqlClientLike, LibsqlResultLike } from './adapters/libsql.js';
export type { SqliteLike, SqliteStatementLike } from './adapters/sqlite.js';
