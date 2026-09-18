# Cloudflare Workers + D1 template

A Worker that exposes sql-jev as a small JSON HTTP API: it warms judgments against the
TypeSafe System One API and rewrites `jev(...)` calls into lookups on `jev_judgments`
before the statement ever reaches D1.

Files:

| File | What it is |
| --- | --- |
| `wrangler.toml` | Worker name, `main = "worker.ts"`, the D1 binding `DB`, and `JEV_MAX_ROWS` |
| `worker.ts` | The API: `GET /`, `GET /stats`, `POST /query`, `POST /warm`, `POST /judge` |

## Why the SQL is rewritten

SQLite has no user-defined SQL functions, and a hosted SQLite never calls the network
from inside a query, so D1 cannot run `WHERE jev(people, 'the name is European')` as
written. sql-jev splits the work: JavaScript talks to TypeSafe, SQLite does the scanning.

1. `jev.query()` finds every `jev(<relation>, ...)` call in the statement.
2. It read-aheads that relation from D1 (bounded by `jev_settings.max_prefetch_rows`).
3. Rows are packed `batch_size` per request into System One calls, `concurrency` at a time.
4. Answers are upserted into `jev_judgments`, keyed by `(scope, row_ref, judgment_key)`.
5. Each `jev(...)` call becomes a correlated `jev_judgments` lookup, and D1 runs that.

The result: the second identical query, a changed threshold, or a sort by probability
costs zero API calls, and every Worker in every region reuses the same judgments.

## Deploy

Prerequisites: Node >= 18, the Wrangler CLI (or `npx wrangler`), a TypeSafe System One
API key, and a checkout or package install of `sql-jev` next to this directory (the
Worker imports `sql-jev`, and it is its only dependency).

```bash
cd templates/d1

wrangler d1 create sql-jev                                   # 1. prints database_id
# 2. paste that ID into wrangler.toml ([[d1_databases]] database_id)

wrangler d1 execute sql-jev --remote --file=../../sql/sql-jev.sql   # 3. apply the schema

wrangler secret put API_TOKEN                                 # 4. any long random string
wrangler secret put TYPESAFE_API_KEY                          # 5. your TypeSafe key

wrangler deploy                                               # 6. ship it
```

`sql/sql-jev.sql` is idempotent (`CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`), so
running step 3 again is safe, and so is calling `await jev.schema()` from code -- the
same file ships as the `sql-jev/schema` export. It creates `jev_judgments`, `jev_runs`,
`jev_settings` and the views `jev_stats`, `jev_cached`, `jev_meta`, `jev_coverage`.

Re-applying never overwrites a value you changed in `jev_settings`: the seeds only fill
in missing rows.

## Local development

Local D1 is a separate database from the remote one: apply the schema to both.

```bash
cd templates/d1
wrangler d1 execute sql-jev --local --file=../../sql/sql-jev.sql
printf 'API_TOKEN="dev-token"\nTYPESAFE_API_KEY="ts_..."\n' > .dev.vars   # git-ignored
wrangler dev
```

## The API

All routes except `GET /` need `Authorization: Bearer <API_TOKEN>`.

```bash
BASE=https://sql-jev-worker.<your-subdomain>.workers.dev
TOKEN=<your API_TOKEN>

# Service info + version (no auth).
curl -s "$BASE/"

# Durable totals: SELECT * FROM jev_stats, plus this session's counters.
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/stats"

# One SELECT, with the jev() call warmed and rewritten.
curl -s -X POST "$BASE/query" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT name FROM people WHERE jev(people, '\''the name is European'\'') ORDER BY name"}'
# -> { rows, count, run, sql, notes, session }
# `run` is one entry per judged set; `sql` is the statement that actually ran.

# Judge a whole relation now, so later queries are pure jev_judgments lookups.
curl -s -X POST "$BASE/warm" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"relation":"people","condition":"works in healthcare"}'

# Ad-hoc JSON rows: no table, no schema, same judgment cache.
curl -s -X POST "$BASE/judge" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Ada Lovelace"},{"name":"Grace Hopper"}],"condition":"is a European name","mode":"annotate"}'
```

`POST /query` guards: exactly one statement, `SELECT`/`WITH` only, <= 100 bound
parameters, <= 100 KB of SQL, and a `LIMIT` is appended (`JEV_MAX_ROWS`, default 200,
hard cap 1000) when the statement has none. `notes` says what was adjusted.

## Cloudflare limits this template respects

| Limit | Value | Where it shows up |
| --- | --- | --- |
| Bound parameters per statement | 100 | `/query` rejects more; the D1 adapter caps itself |
| SQL statement size | ~100 KB | `/query` rejects more |
| D1 queries per Worker invocation | 1000 | warming a large relation plus the rewritten query must fit; use `/warm` from a scheduled job for big tables |
| User-defined SQL functions | not available | `jev.registerUdfs()` is a no-op on D1; the rewriter is the path |
| Interactive transactions | not available | the SDK writes with batched `exec()`/`batch()` calls |
| Database size | 10 GB | split or archive large relations |
| Response size | Worker memory bound | `/query` returns at most `JEV_MAX_ROWS` rows |

## Key handling

`TYPESAFE_API_KEY` is read from `env` and passed to `createJev()`; it is never written to
a response, never logged, and error messages are scrubbed against both secrets before
they leave the Worker. `API_TOKEN` is compared in constant time. CORS is `*` so a browser
page on any origin can call the API -- change `Access-Control-Allow-Origin` in
`worker.ts` to your own origin before exposing real data.

## Troubleshooting

- `jev: jev_settings not found, using defaults` -- the schema was not applied to the
  database the Worker is actually talking to (local and remote D1 are different).
- `D1_ERROR: too many SQL variables` -- more than 100 bound parameters; pass fewer, or
  use a `WHERE id IN (...)` list built from placeholders under that cap.
- Warming times out or hits the query budget -- small relations only on D1; warm rows
  once and rely on `jev_judgments` afterwards.
- `401 unauthorized` -- `Authorization: Bearer <API_TOKEN>` must match the secret
  exactly; a missing `API_TOKEN` secret is reported as a 500 misconfiguration.
- `only SELECT/WITH statements are allowed` -- by design; the Worker is read-only.
  Seed and migrate the database with `wrangler d1 execute`.
