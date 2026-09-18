<p align="center">
  <b>sql-jev</b><br>
  <i>ask your SQLite tables questions in plain language</i><br>
  Turso / libSQL · Cloudflare D1 · plain SQLite
</p>

# sql-jev — natural-language predicates for SQLite, libSQL and D1

Write the condition the way you would say it. SQLite does the rest.

`sql-jev` is a SQL-lite port of [pg-jev](https://github.com/realZachi/pg-jev). Every row is judged
by [TypeSafe's Jev](https://docs.typesafe.ai), a System One model that returns calibrated
probabilities instead of generated text. No index, no embeddings, no vector column.

The SQL is the same SQL you would write on Postgres:

```sql
SELECT * FROM people WHERE jev(people, 'the name is European');

SELECT subject, jev_prob(tickets, 'the customer is angry') AS p
FROM tickets ORDER BY p DESC LIMIT 20;

SELECT jev_choice(tickets, 'which team should handle this?',
                  ARRAY['billing', 'technical', 'security', 'sales']) AS team, count(*)
FROM tickets GROUP BY 1;

SELECT name, jev_score(products, 'how luxurious is this product?',
                       ARRAY['budget', 'mid-range', 'premium', 'luxury']) AS luxury
FROM products ORDER BY luxury DESC;
```

`jev()` composes with everything else: `AND age > 40`, joins, `GROUP BY`, `LIMIT`,
`ORDER BY jev_prob(...) DESC`.

```bash
bunx sql-jev deploy turso            # create db + schema + print the env vars
bunx sql-jev deploy d1 --worker      # create db + schema + deploy the Worker
bunx sql-jev init --db ./local.db    # or just schema a local file
```

---

## Deploy in one command

### Turso / libSQL

```bash
turso auth signup                                   # once
bunx sql-jev deploy turso --db my-db                # or: bunx sql-jev deploy turso --dry-run
```

That runs exactly:

```bash
turso db create my-db
turso db shell my-db < sql/sql-jev.sql              # also: turso db shell my-db --from-dump sql/sql-jev.sql
turso db show my-db --url                           # -> libsql://my-db-....turso.io
turso db tokens create my-db                        # -> the auth token
```

Then:

```ts
import { createJev } from 'sql-jev';

const jev = await createJev({
  url: process.env.TURSO_DATABASE_URL,      // libsql://...
  authToken: process.env.TURSO_AUTH_TOKEN,
  apiKey: process.env.TYPESAFE_API_KEY,     // https://console.typesafe.ai
});

const { rows } = await jev.query(
  `SELECT * FROM people WHERE jev(people, 'the name is European')`,
);
```

### Cloudflare D1

```bash
wrangler login
bunx sql-jev init --worker d1 --dir .               # copies templates/d1 into ./templates/d1
bunx sql-jev deploy d1 --db my-db --worker          # create + schema + wrangler deploy
```

The Worker in `templates/d1` exposes a small JSON API over your D1 database
(`POST /query`, `POST /warm`, `POST /judge`, `GET /stats`), holds the TypeSafe key as a secret,
and never lets the key or a raw API error reach a response. See
[docs in the template](templates/d1/README.md).

### Plain SQLite

```bash
sqlite3 my.db < sql/sql-jev.sql       # the schema is ordinary SQLite
bunx sql-jev init --db my.db          # same thing, via Node/Bun
```

---

## Why SQLite needs a different design

On Postgres, pg-jev receives the whole row as a composite value, judges a whole table in a few
batched requests, and caches the answers in the backend session (`GD`). SQLite has neither of
those two things:

* **No composite row argument.** `jev(people, ...)` has no analogue: a SQLite function can only
  take scalars. `rowid` is the row handle SQLite does have.
* **No network from SQL on hosted engines.** Cloudflare D1 cannot register user-defined functions
  at all (its API is `prepare`/`batch`/`exec`/`dump`/`withSession`, and `sqlite3_create_function`
  is never reachable). Turso Cloud has no `create_function` and refuses
  `load_extension`. So nothing reachable from SQL can call the model.

So the work is split: **JavaScript does the talking, SQLite does the scanning.**

```
jeV.query("SELECT * FROM people WHERE jev(people, 'the name is European')")
  │
  ├─ 1. tokenize the statement, find jev(relation, ...) calls, resolve `FROM people p` aliases
  ├─ 2. read the relation once, paged by rowid      (up to jev.max_prefetch_rows)  ← read-ahead
  ├─ 3. judge the rows it has not seen: jev.batch_size rows per request, one shared
  │     state, one question per row, jev.concurrency requests in flight            ← batching
  ├─ 4. upsert every answer into jev_judgments, keyed by
  │     (scope, row_ref, judgment_key)                                             ← durable cache
  └─ 5. rewrite every call into a correlated lookup on jev_judgments, then run it
```

Step 5 is what makes D1 possible. Your statement:

```sql
SELECT * FROM people WHERE jev(people, 'the name is European')
```

becomes:

```sql
SELECT * FROM people
WHERE (COALESCE((SELECT j.prob FROM jev_judgments j
                 WHERE j.scope = 'people'
                   AND j.row_ref = CAST("people".rowid AS TEXT)
                   AND j.judgment_key = 'noul<US>the name is European<US>'), -1.0)
       >= COALESCE(0.5, 0.5))
```

Plain SQLite, no extension, no UDF, no network. (The real key separator is U+001F, a character
that cannot appear in a SQL string literal.)

### What that buys you

| pg-jev | sql-jev |
| --- | --- |
| Read-ahead of the scanned table, one statement at a time | Same read-ahead, paged by rowid |
| Batched requests, `jev.batch_size` rows each | Same, same default 40 |
| `jev.concurrency` parallel requests | Same, same default 6 |
| Retry 429/529/5xx with backoff | Same, 6 attempts, 0.5 s doubling to 8 s |
| Cache in the session (`GD`), lost on disconnect | `jev_judgments` table: survives disconnects, shared by every client and region |
| `sha1(row_json)` as the row cache key | `sha256(canonical row JSON)` per rowid: a changed row is judged again |
| `jev_stats()` from session memory | Session counters **and** a durable `jev_stats` view over `jev_runs` |

Re-running a query, changing the threshold, or sorting by probability costs zero API calls —
exactly as on Postgres. On SQLite it also costs zero calls for the *next* client, worker or
region, which is the one place this port is strictly better than the original.

---

## How it works, bottom to top

1. **Read-ahead.** The first call for a relation + judgment reads the whole relation (up to
   `jev.max_prefetch_rows`, `pageSize` rows at a time) and judges it. That is why
   `WHERE jev(people, ...)` works at all: `people.rowid` is known for every row before the
   rewritten statement runs.
2. **One state, many questions.** Rows are packed `jev.batch_size` per request into one shared
   state `{"condition": ..., "rows": [...]}` with one question per row (`r0`, `r1`, ...). Jev
   evaluates all questions over that state in parallel, far cheaper than one request per row.
3. **Cache by row content.** Each stored judgment carries `row_hash = sha256(canonical row JSON)`.
   A row that changed gets a different hash and is judged again; everything else is reused. The
   in-process mirror (`GD`'s equivalent) makes repeats free even for a warm process.
4. **Spend guards.** `jev.max_rows_per_statement` and `jev.max_chars_per_statement` abort a
   statement *before* anything is sent, with the same messages pg-jev uses.
5. **Durable cost accounting.** Every judged set writes one `jev_runs` row, so
   `SELECT * FROM jev_stats` reports requests, tokens, estimated cost and cached answers even in
   a stateless Worker.

---

## Functions

Identical names and semantics to pg-jev. `relation` is the table (or its alias) that the rows
come from.

| SQL | Returns | Purpose |
| --- | --- | --- |
| `jev(relation, condition [, threshold])` | boolean | `WHERE` predicate. Threshold: argument → `jev_settings.threshold` → 0.5 |
| `jev_prob(relation, condition)` | real | Probability 0..1 that the row satisfies the condition |
| `jev_score(relation, question, levels)` | real | Probability-weighted position on ordered levels (0 .. n-1) |
| `jev_score_norm(relation, question, levels)` | real | Same, normalised to 0..1 |
| `jev_choice(relation, question, options)` | text | The most likely option for the row |
| `jev_confidence(relation, question, kind, options)` | real | Confidence of a `score`/`choice` answer |
| `jev_eval(relation, question [, kind [, options]])` | text (JSON) | Full raw answer: probabilities, legend, confidence |

Option lists accept four spellings, so PG-style SQL keeps working:

```sql
ARRAY['billing','sales']      -- Postgres style, converted for you
json_array('billing','sales') -- SQLite style
'["billing","sales"]'         -- a JSON literal
('billing','sales')           -- a row-value literal
```

Views, which replace the two functions that need session state:

| View | Purpose |
| --- | --- |
| `jev_stats` | Requests, tokens, output tokens, rows evaluated, api_ms, errors, cached answers, estimated cost |
| `jev_cached` | Which relation/condition pairs are already judged, and when |
| `jev_coverage` | Judged row count per relation + judgment key (missing = not sent yet) |
| `jev_meta` | Schema version, default model, default threshold |

**Unwarmed rows.** The SDK always warms before it runs your statement, so this only matters if you
run rewritten SQL by hand: a row with no judgment reads as `-1.0` for `jev`/`jev_prob`/`jev_score`,
`''` for `jev_choice`, and `NULL` for `jev_confidence`/`jev_eval`.

**Row identity.** `jev()` needs a rowid table. Views, subqueries and `WITHOUT ROWID` tables have no
rowid, so they are judged through the JS row API instead (see below) — the port of pg-jev's
"anonymous record" fallback.

### JavaScript row API

For subquery results, CTE output, API payloads or any array of objects:

```ts
const jev = await createJev({ db, apiKey });

await jev.filter(rows, 'the customer threatens to leave');       // rows that satisfy it
await jev.annotate(rows, 'the customer is angry');               // rows + jev_prob
await jev.prob(rows, 'works in healthcare');                     // number[]
await jev.score(rows, 'how urgent is this?', ['low', 'high']);   // (number|null)[]
await jev.scoreNorm(rows, 'how urgent is this?', ['low', 'high']);
await jev.choice(rows, 'which team?', ['billing', 'sales']);     // (string|null)[]
await jev.confidence(rows, 'which team?', 'choice', ['billing', 'sales']);
await jev.eval(rows, 'which team?', 'choice', ['billing', 'sales']);  // raw answers
```

These are cached by row content too (`scope = '@row'`, keyed by content hash), so the same payload
judged twice costs nothing.

### Engine API

| Call | Purpose |
| --- | --- |
| `createJev({ d1 \| client \| db \| url \| adapter, ...config })` | Connect, load `jev_settings`, return the engine |
| `await jev.query(sql, params?)` | Warm what the statement needs, then run it: `{ rows, sql, run }` |
| `await jev.translate(sql)` | The rewritten SQL only, for engines you drive yourself |
| `await jev.plan(sql)` | The rewrites *and* the warm-up, without running the statement |
| `await jev.warm(relation, condition, { kind, options })` | Judge a whole relation now (the cron-friendly call) |
| `await jev.schema()` | Apply `sql/sql-jev.sql` (idempotent, safe on a cold start) |
| `jev.stats()` | Session counters, same shape as pg-jev's `jev_stats()` |
| `await jev.dbStats()` | The durable `jev_stats` view |
| `await jev.cacheClear({ keepPersisted })` | Forget the cache; `keepPersisted: true` keeps the rows |
| `await jev.version()` | Schema version from `jev_settings`, else the code version |
| `jev.registerUdfs()` | Register `jev*` SQL functions where the engine allows it |
| `await jev.ready()` | Load settings explicitly, when you build with `new Jev(...)` |

### Adapters

`createJev` takes whichever handle you already have:

| Option | Engine | Notes |
| --- | --- | --- |
| `{ d1: env.DB }` | Cloudflare D1, Durable Object SQLite | No UDFs, 100 bound params/statement, ~100 KB/statement, 1000 queries/invocation — all respected |
| `{ client }` | `@libsql/client` | Turso remote, embedded replica, local file. `batch()` ships many statements in one atomic roundtrip |
| `{ url, authToken }` | Turso / libSQL | Creates its own client; needs the optional peer `@libsql/client` |
| `{ db }` | `bun:sqlite`, `node:sqlite`, `better-sqlite3` | Local SQLite, transactions for the write path |
| `{ adapter }` | Anything else | Implement `query`, `exec`, `capabilities` |

### UDF mode (optional)

Where the engine exposes `create_function` — `node:sqlite`, `better-sqlite3`, embedded libSQL
builds — `jev.registerUdfs()` installs `jev`, `jev_prob`, `jev_score`, `jev_score_norm`,
`jev_choice`, `jev_confidence`, `jev_eval`, `jev_stats`, `jev_version` and `jev_cache_clear` as
real SQL functions. SQLite has no composite row, so the row is passed as `scope` + `rowid`:

```ts
jev.registerUdfs();
await jev.warm('people', 'the name is European');
db.query(`SELECT * FROM people
          WHERE jev('people', people.rowid, 'the name is European')`).all();
```

**Not available** on Cloudflare D1 (no UDF support at all), Turso Cloud (no `create_function`), or
`bun:sqlite` 1.4 (no `function()` API). There, the rewriter is the path — and it needs no
registration.

---

## Settings

pg-jev reads GUCs (`SET jev.batch_size = 2`). A table can be read by every client and every
region, so settings live in `jev_settings`:

```sql
UPDATE jev_settings SET value = '2' WHERE key = 'batch_size';
SELECT * FROM jev_meta;
```

…or per process: `createJev({ batchSize: 2, threshold: 0.05, apiKey })`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `api_key` | `TYPESAFE_API_KEY` | TypeSafe key (a secret: prefer the env var or the Worker secret) |
| `api_url` | `https://api.typesafe.ai/v1/systemone` | Endpoint — proxies, mocks, tests |
| `model` | `jev-latest` | Model name or a pinned version such as `jev-1.13.0` |
| `threshold` | `0.5` | Probability at which `jev()` returns true |
| `batch_size` | `40` | Rows per API request |
| `concurrency` | `6` | Parallel API requests |
| `max_prefetch_rows` | `5000` | Rows read ahead from the scanned relation |
| `notices` | `on` | Emit a notice per batch run (Switch to `onNotice` in code) |
| `timeout` | `90` | Seconds per API request |
| `max_rows_per_statement` | `0` (off) | Abort a statement that would send more rows than this |
| `max_chars_per_statement` | `0` (off) | Same, for characters of row data |

Plus two transport knobs: `pageSize` (rows per read-ahead page, default 1000) and
`batchStatements` (statements per `batch()` call, default 50).

---

## Port notes

**Identical.** Function names and signatures, thresholds, the question/state wire format, retry and
error semantics (including `jev: TypeSafe API error 429 ...` style messages), the cost model
(`$0.042` per 1M input tokens, output free), the read-ahead, the batching math, the spend guards,
and `jev_stats()`'s field names.

**Different, deliberately.**

* The session cache is a table. That is a feature, not a compromise: judgments are shared across
  connections, Workers and regions, and a re-deploy does not throw them away.
* `jev_stats()` is a view (`SELECT * FROM jev_stats`); the function form exists in UDF mode.
* `jev_cache_clear()` is `await jev.cacheClear()`; pass `{ keepPersisted: true }` to drop only the
  in-process mirror.
* Anonymous records (pg-jev's per-row fallback) are the JS row API: `await jev.filter(rows, cond)`.
* Row identity is `rowid` plus a content hash, not just a content hash, because SQL has to look the
  row up by a key it can compute.

**Caveats.**

* Full scan by design: every scanned row is sent to the API once. Filter with indexed predicates
  first, or raise `max_prefetch_rows` deliberately.
* Row contents go to a third-party API. Do not use it on data you may not share.
* On D1 there are no interactive transactions: writes are idempotent upserts in batched `exec()`
  calls. An interrupted Worker can leave a partially judged set, which repairs itself on the next
  run — never a wrong answer.
* Turso's `sqld` rejects `TEMP` tables; `sql-jev` never uses them.
* The model's context is 64k tokens (≈32k for the state), so very wide rows mean fewer rows per
  request — lower `batch_size` rather than raising it.

---

## Development

```bash
bun install
bun run typecheck          # tsc, strict
bun test                   # 35 tests, deterministic mock API, no credentials
bun run mock               # the mock TypeSafe endpoint on :8765
bun run build              # tsc -> dist (ESM, zero runtime dependencies)

bun run scripts/sync-schema.ts          # regenerate src/schema.ts from sql/sql-jev.sql
bun run scripts/sync-schema.ts --check   # fail if the two drifted (CI runs this)
```

`sql/sql-jev.sql` is the single source of truth for the schema: it is what `turso db shell`,
`wrangler d1 execute --file`, `sqlite3 <` and `npx sql-jev init` apply, and `src/schema.ts` is
generated from it so `await jev.schema()` applies the same text.

The suite covers the scenarios from pg-jev's own regression tests (predicate, threshold handling,
probability ordering, `batch_size` behaviour, score/choice/confidence, read-ahead plus cache hits,
spend guards, error paths and the "errors are counted, the session keeps working" rule), plus the
SQL rewriter, the UDF wiring, the CLI deploy plans, and the D1 path against a fake binding that
enforces Cloudflare's real 100-parameter and 100 KB statement limits.

```
test/engine.test.ts    predicates, score/choice, caching, guards, errors, JS row API
test/rewrite.test.ts   tokenizer, alias resolution, options parsing, safe non-rewriting
test/d1.test.ts        D1 limits, literal exec packing, 5000-row read-ahead
test/udf.test.ts       jev* SQL function registration and answers
test/deploy.test.ts    deploy plans, dry runs, `init`, schema sync
mock/mock-api.ts       deterministic stand-in for System One
```

---

## License

MIT. `sql-jev` is an independent port of [pg-jev](https://github.com/realZachi/pg-jev)
(PostgreSQL License). Jev and TypeSafe are trademarks of their respective owners; this project is
not affiliated with TypeSafe.
