-- sql-jev 0.1.0 -- natural-language predicates for SQLite, libSQL/Turso and Cloudflare D1.
--
--   SELECT * FROM people WHERE jev(people, 'the name is European');
--   SELECT name, jev_prob(people, 'works in healthcare') AS p FROM people ORDER BY p DESC;
--   SELECT name, jev_score(products, 'how luxurious is this?', ARRAY['budget','mid-range','luxury']) FROM products;
--   SELECT subject, jev_choice(tickets, 'which team?', ARRAY['billing','technical','sales']) FROM tickets;
--
-- Port of pg-jev (https://github.com/realZachi/pg-jev). SQLite has no session-local
-- untrusted language and hosted engines never call the network from SQL, so the
-- session cache of pg-jev becomes a table: `jev_judgments`.
--
-- How a query runs (see src/engine.ts and src/rewrite.ts):
--   1. The SDK reads the relation referenced by jev(<relation>, ...) once
--      (up to jev.max_prefetch_rows), exactly like the pg-jev read-ahead.
--   2. Rows are packed `jev.batch_size` per request into one shared state
--      ({"condition": ..., "rows": [...]}) with one question per row, and the
--      requests run `jev.concurrency` at a time.
--   3. Answers are upserted into jev_judgments keyed by (relation, row, judgment),
--      so re-running the query, changing the threshold, sorting by probability or
--      asking the same condition again costs no API calls. A row whose content
--      changed gets a new row_hash and is judged again.
--   4. jev() in the SQL text is rewritten to a correlated lookup on jev_judgments,
--      so it works on engines without user-defined functions (Cloudflare D1).
--
-- Settings live in jev_settings and mirror the pg-jev GUCs (SET jev.<name>):
--   api_key, api_url, model, threshold, batch_size, concurrency,
--   max_prefetch_rows, notices, timeout, max_rows_per_statement,
--   max_chars_per_statement
--   -- UPDATE jev_settings SET value = '2' WHERE key = 'batch_size';
--
-- Deploy this file in one command:
--   turso db create my-db && turso db shell my-db < sql/sql-jev.sql
--   wrangler d1 create my-db && wrangler d1 execute my-db --file sql/sql-jev.sql --remote
--   npx sql-jev deploy turso   |   npx sql-jev deploy d1

-- ---------------------------------------------------------------- judgments

-- One row per (relation, row, judgment). The analogue of the pg-jev session cache,
-- but durable and shared by every client and every connection pool.
CREATE TABLE IF NOT EXISTS jev_judgments (
  scope           TEXT    NOT NULL,           -- relation the row was read from ('@row' for ad-hoc JSON rows)
  row_ref         TEXT    NOT NULL,           -- rowid as text, or sha256(row_json) for ad-hoc rows
  row_hash        TEXT    NOT NULL,           -- sha256 of the canonical row JSON: staleness check
  judgment_key    TEXT    NOT NULL,           -- kind + condition + options + format + model, see src/sql.ts
  kind            TEXT    NOT NULL,           -- noul | score | choice
  condition       TEXT    NOT NULL,           -- the natural-language condition or question
  options_json    TEXT,                       -- JSON array of levels/options, or NULL
  answer_json     TEXT    NOT NULL,           -- raw answer, same shape as jev_eval() in pg-jev
  prob            REAL,                       -- noul: probability the row satisfies the condition
  label           TEXT,                       -- choice: most likely option
  score           REAL,                       -- score: probability-weighted level index
  levels_count    INTEGER,                    -- number of levels/options, for score_norm
  confidence      REAL,                       -- confidence of a score/choice answer
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, row_ref, judgment_key)
);

-- Predicate lookups: WHERE scope = ? AND row_ref = ? AND judgment_key = ?
CREATE INDEX IF NOT EXISTS jev_judgments_row
  ON jev_judgments (scope, row_ref, judgment_key);

-- Ranking lookups: ORDER BY prob DESC over one relation + condition
CREATE INDEX IF NOT EXISTS jev_judgments_rank
  ON jev_judgments (scope, judgment_key, prob);

-- ---------------------------------------------------------------- run log

-- One row per batch request. Kept so jev_stats can report requests, tokens,
-- estimated cost and cache hits without a session, which is what pg-jev gets from GD.
CREATE TABLE IF NOT EXISTS jev_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT,
  judgment_key        TEXT,
  kind                TEXT,
  model               TEXT,
  rows_judged         INTEGER NOT NULL DEFAULT 0,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  api_ms              REAL    NOT NULL DEFAULT 0,
  estimated_cost_usd  REAL    NOT NULL DEFAULT 0,
  errors              INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS jev_runs_created ON jev_runs (created_at);

-- ---------------------------------------------------------------- settings

-- GUC parity: pg-jev reads SET jev.<name>; here it is a table, so it survives
-- across clients, workers and regions.
CREATE TABLE IF NOT EXISTS jev_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT OR IGNORE INTO jev_settings (key, value) VALUES
  ('version',                  '0.2.0'),
  ('api_key',                  ''),
  ('api_url',                  'https://api.typesafe.ai/v1/systemone'),
  ('model',                    'jev-latest'),
  ('threshold',                '0.5'),
  ('batch_size',               '40'),
  ('concurrency',              '6'),
  ('max_prefetch_rows',        '5000'),
  ('notices',                  'on'),
  ('timeout',                  '90'),
  ('max_rows_per_statement',   '0'),
  ('max_chars_per_statement',  '0');

-- ---------------------------------------------------------------- views

-- Parity with jev_stats(): requests, tokens, estimated cost, rows judged.
-- pg-jev: SELECT jev_stats();   sql-jev on D1: SELECT * FROM jev_stats;
CREATE VIEW IF NOT EXISTS jev_stats AS
SELECT
  (SELECT count(*) FROM jev_runs)                                         AS runs,
  COALESCE((SELECT sum(requests)        FROM jev_runs), 0)               AS requests,
  COALESCE((SELECT sum(input_tokens)    FROM jev_runs), 0)               AS input_tokens,
  COALESCE((SELECT sum(output_tokens)   FROM jev_runs), 0)               AS output_tokens,
  COALESCE((SELECT sum(rows_judged)     FROM jev_runs), 0)               AS rows_evaluated,
  COALESCE((SELECT round(sum(api_ms), 3) FROM jev_runs), 0)              AS api_ms,
  COALESCE((SELECT sum(errors)          FROM jev_runs), 0)               AS errors,
  COALESCE((SELECT count(*) FROM jev_judgments), 0)                      AS cached_answers,
  COALESCE((SELECT round(sum(input_tokens) * 0.042 / 1000000, 6) FROM jev_runs), 0) AS estimated_cost_usd;

-- Which relation/condition pairs are already judged, and how stale they are.
-- `model` is part of the grouping: the same condition judged by two models is two entries, not one
-- doubled count.
CREATE VIEW IF NOT EXISTS jev_cached AS
SELECT
  scope,
  kind,
  condition,
  options_json,
  model,
  count(*)          AS rows_judged,
  min(updated_at)   AS first_judged_at,
  max(updated_at)   AS last_judged_at
FROM jev_judgments
GROUP BY scope, kind, condition, options_json, model;

-- Parity with jev_version().
CREATE VIEW IF NOT EXISTS jev_meta AS
SELECT
  (SELECT value FROM jev_settings WHERE key = 'version') AS version,
  (SELECT value FROM jev_settings WHERE key = 'model')   AS model,
  (SELECT value FROM jev_settings WHERE key = 'threshold') AS threshold;

-- Number of rows of <relation> that are already judged (missing = not yet sent to the API).
-- Usage: SELECT * FROM jev_coverage WHERE scope = 'people' AND judgment_key = '...';
CREATE VIEW IF NOT EXISTS jev_coverage AS
SELECT scope, judgment_key, count(*) AS rows_judged, max(updated_at) AS last_judged_at
FROM jev_judgments
GROUP BY scope, judgment_key;
