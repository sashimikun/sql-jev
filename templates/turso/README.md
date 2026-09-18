# Turso / libSQL template

Two files, one workflow:

| File | What it is |
| --- | --- |
| `deploy.sh` | Create the database, load `sql/sql-jev.sql`, verify, print the URL and both env vars |
| `example.ts` | End-to-end script: schema, sample rows, `jev()` in SQL, `translate()`, `warm()`, `filter()`/`annotate()`, counters |

```bash
bash templates/turso/deploy.sh sql-jev            # or: --dry-run to see the commands first
turso db shell sql-jev < sql/sql-jev.sql          # what the script does at step 2
```

## Deploy

```bash
# once per machine
turso auth signup            # or: turso auth login

turso db create sql-jev                                              # 1. create
turso db shell sql-jev < sql/sql-jev.sql                             # 2. schema + settings
# turso db shell sql-jev --from-dump sql/sql-jev.sql                 #    same thing, from a file

turso db show sql-jev --url                                          # 3. libsql://...turso.io
turso db show sql-jev --http-url                                     #    https://...turso.io
turso db tokens create sql-jev                                       # 4. the auth token
```

`sql/sql-jev.sql` is idempotent (`CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`), so
step 2 is safe to repeat, and `await jev.schema()` in code applies the same file (it
ships as the `sql-jev/schema` export). It creates `jev_judgments`, `jev_runs`,
`jev_settings` and the views `jev_stats`, `jev_cached`, `jev_meta`, `jev_coverage`.

Re-applying never overwrites a value you changed in `jev_settings`: the seeds only fill
in missing rows.

## Connect

```bash
export TURSO_DATABASE_URL="$(turso db show sql-jev --url)"     # libsql://...
export TURSO_AUTH_TOKEN="$(turso db tokens create sql-jev)"
export TYPESAFE_API_KEY="ts_..."                               # TypeSafe System One key
bun run templates/turso/example.ts                             # or: node --experimental-strip-types
```

```ts
import { createJev } from 'sql-jev';

// Form A: let sql-jev create the client. Needs the optional peer @libsql/client,
// which is the only thing that speaks the libsql:// wire protocol.
const jev = await createJev({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  apiKey: process.env.TYPESAFE_API_KEY,
});

// Form B: bring your own client, so you own pooling, retries and close().
import { createClient } from '@libsql/client';
const client = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const sameJev = await createJev({ client, apiKey: process.env.TYPESAFE_API_KEY });
```

sql-jev itself has zero runtime dependencies; `@libsql/client` is an optional peer needed
by Form A (and by Form B, obviously) and nothing else.

## No user-defined SQL functions on Turso

Turso Cloud does **not** support user-defined SQL functions: the client it hands out has
no `create_function` (its surface is `batch`/`close`/`execute`/`executeMultiple`/`migrate`/
`reconnect`/`sync`/`transaction`), and `load_extension` is refused as "not authorized".
So on Turso:

- `jev.registerUdfs()` returns `false` and registers nothing. Do not design around
  `WHERE jev(people, people.rowid, '...')` here.
- The **rewriter is the only path**: `jev.query(sql)` warms the judgments, rewrites every
  `jev(<relation>, '<condition>')` into a correlated `jev_judgments` lookup, and runs the
  rewritten statement. `jev.translate(sql)` gives you that rewritten SQL on its own.
- UDFs work on engines that expose one -- `bun:sqlite`, `node:sqlite`, `better-sqlite3`,
  embedded libSQL -- which is exactly why both paths exist.

## Limits to keep in mind

| Limit | Value | Notes |
| --- | --- | --- |
| Bound parameters per statement | 32766 | far above D1's 100; the libSQL adapter batches `write` statements |
| Statement text | effectively unbounded | no 100 KB ceiling like D1 |
| Transactions | `client.batch()` is one atomic transaction | use it for writes and for multi-statement reads |
| TEMP tables | rejected by sqld: `unsupported statement: CREATE TEMP TABLE` | sql-jev never creates them, so nothing to work around |
| Individual value size | ~4 MB may fail | keep large blobs out of judged relations |
| Storage | plan-dependent | see your Turso plan |

## How a query runs

1. `jev.query()` finds every `jev(<relation>, ...)` call in the statement.
2. It read-aheads that relation from Turso, bounded by `jev_settings.max_prefetch_rows`.
3. Rows are packed `batch_size` per request into one System One call, `concurrency` at a time.
4. Answers are upserted into `jev_judgments`, keyed by `(scope, row_ref, judgment_key)`.
5. The statement is rewritten so each `jev(...)` becomes a `jev_judgments` lookup, and
   libSQL runs that -- no API call, no read-ahead for already-judged rows.

A repeated query, a changed threshold or a sort by probability therefore costs zero API
calls, and every client and connection reuses the same durable cache.
