# Cloudflare Workers + D1 template

A Worker that exposes sql-jev as a small JSON HTTP API: it warms judgments against the
TypeSafe System One API and rewrites `jev(...)` calls into lookups on `jev_judgments`
before the statement ever reaches D1.

Files:

| File | What it is |
| --- | --- |
| `wrangler.toml` | Worker name, `main = "worker.ts"`, the D1 binding `DB`, and `JEV_MAX_ROWS` |
| `worker.ts` | The API: `GET /`, `GET /health`, `GET /stats`, `POST /query`, `POST /warm`, `POST /judge` |

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

All routes except `GET /`, `GET /health` and the CORS preflight (`OPTIONS`) need
`Authorization: Bearer <API_TOKEN>`.

```bash
BASE=https://sql-jev-worker.<your-subdomain>.workers.dev
TOKEN=<your API_TOKEN>

# Service info + version (no auth).
curl -s "$BASE/"

# Same body, for uptime checks (no auth).
curl -s "$BASE/health"

# Durable totals: SELECT * FROM jev_stats, plus this session's counters.
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/stats"

# One SELECT, with the jev() call warmed and rewritten.
curl -s -X POST "$BASE/query" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT name FROM people WHERE jev(people, '\''the name is European'\'') ORDER BY name"}'
# -> { rows, count, run, sql, notes, session }
# `run` is one entry per judged set; `sql` is the statement that actually ran.

# Bound parameters work as they do anywhere else: pass values, not literals.
curl -s -X POST "$BASE/query" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT name FROM people WHERE jev(people, '\''is a musician'\'') AND birth_year > ?","params":[1900]}'

# Judge a whole relation now, so later queries are pure jev_judgments lookups.
curl -s -X POST "$BASE/warm" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"relation":"people","condition":"works in healthcare"}'

# Warm a score/choice judgment: `options` is required for those two kinds.
curl -s -X POST "$BASE/warm" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"relation":"tickets","condition":"which team should handle this?","kind":"choice","options":["billing","technical"]}'

# Ad-hoc JSON rows: no table, no schema, same judgment cache.
curl -s -X POST "$BASE/judge" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Ada Lovelace"},{"name":"Grace Hopper"}],"condition":"is a European name","mode":"annotate"}'
```

### `POST /query` guards

| Guard | Behaviour |
| --- | --- |
| One statement | A second statement (even after a comment or a `;`) is a 400. Semicolons inside literals, identifiers and comments do not count. |
| Read-only | `SELECT`, or `WITH ... SELECT`/`VALUES`. A CTE can precede a write in SQLite (`WITH x AS (SELECT 1) DELETE FROM t`), so the verb after the CTE part decides: any INSERT/UPDATE/DELETE/REPLACE/DDL/`PRAGMA` is a 400 and never reaches D1. |
| Bound parameters | At most 100 (Cloudflare's limit). The count must also match the statement's placeholders (`?`, `?NNN`, `:name`, `@name`), so a mismatch is a 400 instead of a D1 500. Statements using `$name` parameters are left to D1 to check. |
| Statement size | At most 100,000 bytes, Cloudflare's per-statement cap. |
| Response size | A `LIMIT` is appended (`env.JEV_MAX_ROWS`, default 200, hard cap 1000) when the statement has none of its own and does not already end in a `VALUES` list. An explicit `LIMIT 5`, `LIMIT ? OFFSET ?` or `LIMIT 2, 1` is respected as written. |
| Request body | At most 1,000,000 bytes (413). |

`notes` in the response says what was adjusted. `count` is the number of rows returned, and
`run` is empty when the statement carried no `jev*` call.

## Cloudflare limits this template respects

| Limit | Value | Where it shows up |
| --- | --- | --- |
| Bound parameters per statement | 100 | `/query` rejects more, and rejects a placeholder/value mismatch |
| SQL statement size | ~100 KB | `/query` rejects more |
| D1 queries per Worker invocation | 1000 (Paid) / 50 (Free) | warming costs one judgment upsert per newly judged row plus one read-ahead page per `pageSize` rows, packed 50 statements per `exec()` call; keep relations small (a few hundred rows) and warm them from a scheduled job rather than inside a request |
| User-defined SQL functions | not available | `jev.registerUdfs()` is a no-op on D1; the rewriter is the path |
| Interactive transactions | not available | the SDK writes with batched `exec()`/`batch()` calls |
| Database size | 10 GB | split or archive large relations |
| Response size | Worker memory bound | `/query` returns at most `JEV_MAX_ROWS` rows; `/judge` accepts at most 5000 rows and a 1 MB body |

`/warm` accepts at most one relation per call. `options` is required for `kind: "score"` and
`kind: "choice"` (and refused for `noul`, which takes no levels); duplicate levels are refused
because they would make the legend ambiguous.

## Key handling

`TYPESAFE_API_KEY` is read from `env` and passed to `createJev()`; it is never written to
a response, never logged, and error messages are scrubbed against both secrets before
they leave the Worker. `API_TOKEN` is compared in constant time. CORS is `*` so a browser
page on any origin can call the API -- change `Access-Control-Allow-Origin` in
`worker.ts` to your own origin before exposing real data.

`GET /` and `GET /health` are the only routes without auth, and both return static text:
service name, version, the route list and the documented limits. Every other route answers
401 before it looks at the body, so an unauthenticated caller cannot use the status code to
enumerate routes (`POST /nope` is 401, not 404).

## Troubleshooting

- `jev: jev_settings not found, using defaults` -- the schema was not applied to the
  database the Worker is actually talking to (local and remote D1 are different).
- `no such table: jev_stats` / `jev: jev_judgments is missing` -- same cause: run
  `wrangler d1 execute sql-jev --remote --file=../../sql/sql-jev.sql`.
- `D1_ERROR: too many SQL variables` -- more than 100 bound parameters; pass fewer, or
  use a `WHERE id IN (...)` list built from placeholders under that cap. The Worker
  rejects the 101st parameter before it reaches D1, and reports a placeholder/value
  mismatch itself so a D1 500 does not reach the client.
- `only read-only SELECT/WITH statements are allowed, this one runs DELETE` -- a CTE in
  front of a write. The Worker is read-only by design; seed and migrate with
  `wrangler d1 execute`.
- Warming times out or hits the query budget -- small relations only on D1; warm rows
  once and rely on `jev_judgments` afterwards. Re-running the same query costs zero API
  calls (the second response reports `rows_already_judged`).
- `500` with `jev: TypeSafe API error 401` or `403` in the body -- `TYPESAFE_API_KEY`
  is wrong, revoked or expired. The upstream status is passed through in the message; the
  Worker reports it as a 500 because the key is a server-side secret, and the text is
  scrubbed against both secrets before it leaves.
- `401 unauthorized` -- `Authorization: Bearer <API_TOKEN>` must match the secret
  exactly; a missing `API_TOKEN` secret is reported as a 500 misconfiguration.
