# sql-jev deploy templates

Ready-to-adapt starting points for the two hosted engine families sql-jev supports.
Both follow the same split: **JavaScript talks to TypeSafe, SQLite does the scanning.**

| Template | Engine | Deploy path | Rewritten SQL | UDFs |
| --- | --- | --- | --- | --- |
| [`d1/`](./d1/README.md) | Cloudflare D1 + Workers | `wrangler d1 create/execute`, `wrangler deploy` | yes, required | no (`registerUdfs()` is a no-op) |
| [`turso/`](./turso/README.md) | Turso / libSQL | `turso db create`, `turso db shell`, `turso db tokens create` | yes, the only path on Turso Cloud | no on Turso Cloud, yes on embedded libSQL and local SQLite |

## Why a rewritten SQL statement, and not a function call in SQL

SQLite has no user-defined SQL functions, and a hosted SQLite never calls the network
from inside a query. `SELECT name FROM people WHERE jev(people, 'the name is European')`
therefore cannot run as written. sql-jev does the work around the database:

1. `jev.query()` finds every `jev(<relation>, ...)` call in the statement.
2. The SDK read-aheads that relation (bounded by `jev_settings.max_prefetch_rows`).
3. Rows are packed `batch_size` per request into TypeSafe System One calls, `concurrency`
   at a time -- from JavaScript, where `fetch()` exists.
4. Answers are upserted into `jev_judgments`, keyed by `(scope, row_ref, judgment_key)`:
   the durable replacement for pg-jev's session cache, shared by every client.
5. Each `jev(...)` call is rewritten into a `jev_judgments` lookup; the database executes
   that plain SQL.

So a repeated query, a changed threshold, or a sort by probability costs zero API calls,
and a row whose content changed gets a new `row_hash` and is judged again.

## The schema is the same for both

`sql/sql-jev.sql` creates `jev_judgments`, `jev_runs`, `jev_settings` and the views
`jev_stats`, `jev_cached`, `jev_meta`, `jev_coverage`. It is idempotent and ships inside
the package as the `sql-jev/schema` export, so `await jev.schema()` and the CLI/`wrangler`
paths apply the same file:

```bash
# Turso
turso db create sql-jev
turso db shell sql-jev < sql/sql-jev.sql

# D1 (remote and local are different databases; do both if you run wrangler dev)
wrangler d1 create sql-jev
wrangler d1 execute sql-jev --remote --file=sql/sql-jev.sql
wrangler d1 execute sql-jev --local  --file=sql/sql-jev.sql
```

## Credentials

| Variable | Used by | Where to set it |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | both | `wrangler secret put TYPESAFE_API_KEY`, or your shell/secret store |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Turso | `turso db show <db> --url`, `turso db tokens create <db>` |
| `API_TOKEN` | the D1 Worker | `wrangler secret put API_TOKEN` (a shared secret for the HTTP API) |
| `TURSO_API_TOKEN` | CI only | GitHub secret, for `turso` CLI in `.github/workflows/deploy.yml` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | CI only | GitHub secrets, for `wrangler` |

The TypeSafe key is server-side only: the D1 template never returns it and scrubs error
messages against it. Never prefix it with `PUBLIC_`/`VITE_`/`NEXT_PUBLIC_` in a browser
bundle.

## Limits worth reading before you deploy

| | D1 | Turso |
| --- | --- | --- |
| Bound parameters per statement | 100 | 32766 |
| SQL statement size | ~100 KB | effectively unbounded |
| User-defined SQL functions | no | no on Turso Cloud |
| Interactive transactions | no | `client.batch()` is one atomic transaction |
| TEMP tables | n/a | rejected by sqld; sql-jev never uses them |
| Query/API budget | 1000 D1 queries per Worker invocation | connection/plan dependent |
| Database size | 10 GB | plan dependent |
| Values above ~4 MB | not supported by D1 | may fail on Turso |

Warm large relations ahead of time (`jev.warm(relation, condition)`, or `POST /warm` on
the D1 template) and rely on `jev_judgments` afterwards; then a request only pays for the
rows that were never judged.

## Next steps

- `d1/README.md` -- wrangler walkthrough, local dev, curl examples, key handling.
- `turso/README.md` -- CLI walkthrough, `deploy.sh`, `example.ts`, and why Turso has no UDFs.
- `../README.md` -- the SDK itself: `createJev`, `query`, `translate`, `warm`, `filter`, `annotate`, `stats`, `dbStats`, `schema`, plus how the rewriter and `jev_judgments` work.
- `../sql/sql-jev.sql` -- the schema every target applies (the single source of truth).
- `../test/` -- the parity suite: the pg-jev regression scenarios, the rewriter, the UDF wiring, and the D1 limits.
