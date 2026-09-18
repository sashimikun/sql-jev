# sql-jev

Natural-language `WHERE` clauses for SQLite, Turso/libSQL and Cloudflare D1.

```sql
SELECT * FROM people WHERE jev(people, 'the name is European');
```

## Start here — 5 commands, about 2 minutes

```bash
# 1. Not on npm yet. Install from this checkout (2 seconds):
bun add file:../sql-jev                  # or: npm install ../sql-jev

# 2. Create a database with the schema (1 second):
sqlite3 demo.db < sql/sql-jev.sql

# 3. Give it a key (free at https://console.typesafe.ai):
export TYPESAFE_API_KEY=...

# 4. Ask a question in plain language (about 2 seconds, 1 API call):
cat > ask.ts <<'TS'
import { Database } from 'bun:sqlite';
import { createJev } from 'sql-jev';

const db = new Database('demo.db');
db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);
         INSERT INTO people (name) VALUES ('Giulia Rossi'), ('Kenji Tanaka');`);

const jev = await createJev({ db, apiKey: process.env.TYPESAFE_API_KEY });
const { rows, run } = await jev.query(
  `SELECT name FROM people WHERE jev(people, 'the name is European')`,
);
console.log(rows, run[0]?.requests, 'API request(s)');
db.close();
TS
bun run ask.ts

# 5. Run it again. Same output, 0 API requests — judgments are in the table now.
bun run ask.ts
```

Expected: `[ { name: "Giulia Rossi" } ] 1 API request(s)`, then `0 API request(s)`.

Unhappy paths, stated plainly:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `jev: no API key` | no key found | `export TYPESAFE_API_KEY`, or `UPDATE jev_settings SET value='<key>' WHERE key='api_key'` |
| `jev: jev_judgments is missing` | schema not applied | run step 2, or `await jev.schema()` |
| `Could not resolve "sql-jev"` | dependency not installed | step 1 |
| `jev: cannot read ahead ... rowid` | the relation has no rowid (view, CTE, `WITHOUT ROWID`) | use `await jev.filter(rows, condition)` |

## The three deploy paths

**Turso / libSQL** (about 3 minutes, needs `turso auth login`):

```bash
bunx sql-jev deploy turso --db my-db        # or --dry-run to only print the commands
# prints: turso db create, db shell < schema, db show --url, db tokens create
```

**Cloudflare D1** (about 5 minutes, needs `wrangler login`):

```bash
bunx sql-jev init --worker d1 --dir .       # copies templates/d1 next to your code
bunx sql-jev deploy d1 --db my-db --worker  # create + schema + wrangler deploy
```

**Plain SQLite** (about 5 seconds):

```bash
sqlite3 my.db < sql/sql-jev.sql
```

## What actually works, measured

| Check | Result |
| --- | --- |
| Test suite | 144 tests, 0 failures, no credentials needed (deterministic mock API) |
| Live model, local SQLite | European names scored 0.98 / 0.97 / best-country choice 5 of 5 correct |
| Rewritten query on real D1 | identical rows and order to the local run, 200 of 200 |
| 200 rows persisted on real D1 | 2 `exec()` calls, 108 + 92 statements, both under D1's 100 KB limit |
| Deployed Worker, warmed condition | `requests: 0` — the edge reused judgments written from a laptop |
| Deployed Worker, new condition | 200 rows judged live: 5 requests, 21,212 input tokens, $0.000891, model `jev-1.13.0` |

## What `jev()` turns into

You write the condition. SQLite runs plain SQL — no extension, no UDF, no network from SQL:

```sql
-- you write
SELECT * FROM people WHERE jev(people, 'the name is European');

-- D1/Turso run
SELECT * FROM people
WHERE (COALESCE((SELECT j.prob FROM jev_judgments j
                 WHERE j.scope = 'people'
                   AND j.row_ref = CAST("people"._rowid_ AS TEXT)
                   AND j.judgment_key = 'noul<US>the name is European<US>'), -1.0)
       >= COALESCE(0.5, 0.5));
```

Why it has to be this shape: SQLite has no composite row argument, Cloudflare D1 can register no
user-defined functions at all, and Turso Cloud refuses `create_function` and `load_extension`. So
JavaScript talks to the model and SQLite answers from a table.

Five steps, per query:

1. Find every `jev(<relation>, ...)` call in the statement and resolve `FROM people p` aliases.
2. Read that relation ahead by `_rowid_`, up to `jev.max_prefetch_rows`.
3. Batch the un-judged rows, 40 per request, 6 requests in flight, into TypeSafe System One.
4. Upsert every answer into `jev_judgments`, keyed by `(scope, row_ref, judgment_key)` plus a
   `sha256(canonical row JSON)` staleness hash.
5. Rewrite each call into the lookup above and run the plain SQL.

A repeat query, a changed threshold or a sort by probability costs 0 API calls — in any process,
region or deploy.

## Functions

Same names and semantics as [pg-jev](https://github.com/realZachi/pg-jev).

| SQL | Returns | Purpose |
| --- | --- | --- |
| `jev(relation, condition [, threshold])` | boolean | `WHERE` predicate; threshold: argument → setting → 0.5 |
| `jev_prob(relation, condition)` | real | probability 0..1 |
| `jev_score(relation, question, levels)` | real | probability-weighted position on ordered levels |
| `jev_score_norm(relation, question, levels)` | real | same, 0..1 |
| `jev_choice(relation, question, options)` | text | most likely option |
| `jev_confidence(relation, question, kind, options)` | real | confidence of a score/choice answer |
| `jev_eval(relation, question [, kind [, options]])` | text (JSON) | full raw answer |

Levels and options take four spellings: `ARRAY['a','b']`, `json_array('a','b')`, `'["a","b"]'`,
`('a','b')`.

Views: `jev_stats` (requests, tokens, cost, cache), `jev_cached`, `jev_coverage`, `jev_meta`.

Un-warmed rows read as `-1.0` (prob/score), `''` (choice), `NULL` (confidence/eval). The SDK always
warms first, so you only see that if you run rewritten SQL by hand.

Rows from a view, a CTE or a subquery have no rowid. Judge those in JavaScript:

```ts
await jev.filter(rows, 'the customer mentions leaving');    // rows that match
await jev.annotate(rows, 'the customer is angry');          // rows + jev_prob
await jev.choice(rows, 'which team?', ['billing', 'sales']);
```

## Settings

`UPDATE jev_settings SET value = '2' WHERE key = 'batch_size';` — or per process,
`createJev({ batchSize: 2 })`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `api_key` | env `TYPESAFE_API_KEY` | TypeSafe key |
| `api_url` | `https://api.typesafe.ai/v1/systemone` | endpoint (proxies, mocks, tests) |
| `model` | `jev-latest` | model, or pinned such as `jev-1.13.0` |
| `threshold` | `0.5` | probability at which `jev()` is true |
| `batch_size` / `concurrency` | `40` / `6` | rows per request, requests in flight |
| `max_prefetch_rows` | `5000` | rows read ahead; rows past it are refused, not silently dropped |
| `notices` / `timeout` | `on` / `90` | batch notices; whole-call budget incl. retries |
| `max_rows_per_statement` | `0` (off) | refuse a statement sending more rows |
| `max_chars_per_statement` | `0` (off) | same, for characters |

## Connect from your runtime

```ts
await createJev({ db })                     // bun:sqlite, node:sqlite, better-sqlite3
await createJev({ client })                 // @libsql/client (Turso, embedded, local file)
await createJev({ url, authToken })         // same, creates its own client
await createJev({ d1: env.DB })             // Cloudflare Workers
```

`query(sql)` → `{ rows, sql, run }` · `translate(sql)` → rewritten SQL (**it warms; it spends**) ·
`plan(sql)` → rewrites + warm-up · `warm(relation, condition)` → judge a whole table now ·
`exec(sql)` → a script · `filter/annotate/prob/score/choice/confidence/eval` → JS row API ·
`stats()`, `dbStats()`, `cacheClear()`, `schema()`, `version()`, `registerUdfs()`.

Rewriting with no API calls: `rewriteSql(sql, analyzeSql(sql).calls, threshold)`.

## Limits and caveats

Facts that change a design decision:

- **Full scan by design.** Every scanned row goes to the model once. Filter with indexed predicates
  first, or raise `max_prefetch_rows` deliberately.
- **Row contents leave your machine.** They go to TypeSafe. Do not use it on data you may not share.
- **`_rowid_` tables only** for `jev()` in SQL. Views, CTEs, subqueries: use the JS row API.
- **D1: 1000 queries per Worker invocation.** A 5000-row warm needs ~37. Warm large tables from a
  scheduled job (`POST /warm`), or cap the Worker with `JEV_MAX_ROWS`.
- **A probability belongs to a (batch state, question) pair.** The same row scored 0.05 inside a
  5-row state and 0.04 alone; 3 identical fresh judgments returned 0.03 three times. Once judged,
  the content-hash cache pins the value, so re-runs and sorts are stable.
- **The JS row API is a separate scope** (`@row`, content-hashed), so a payload equal to a table row
  is judged separately and the two values can differ slightly.
- **No UDFs on hosted engines.** `registerUdfs()` returns `true` only on `node:sqlite` and
  better-sqlite3. D1, Turso Cloud and `bun:sqlite` 1.4 fall back to the rewriter, which is
  automatic.
- **Turso Cloud rejects `TEMP` tables**; sql-jev never uses them. Values above ~4 MB may fail.

## Develop

```bash
bun install
bun run typecheck:all     # src, the D1 Worker template, deploy.sh syntax
bun test                  # 144 tests, mock API, no credentials
bun run build             # ESM + types, zero runtime dependencies
bun run scripts/sync-schema.ts --check   # sql/sql-jev.sql vs src/schema.ts
```

`sql/sql-jev.sql` is the single source of the schema: it is what `turso db shell`,
`wrangler d1 execute --file`, `sqlite3 <` and `sql-jev init` apply. `src/schema.ts` is generated
from it.

Docs in this repo are shaped with the
[i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/main/skills/i-have-adhd) writing skill:
action first, numbered steps, no preamble.

## License

MIT. An independent port of [pg-jev](https://github.com/realZachi/pg-jev) (PostgreSQL License).
Jev and TypeSafe are trademarks of their respective owners; not affiliated with TypeSafe.
