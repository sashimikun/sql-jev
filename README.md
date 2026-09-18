# sql-jev

Ask your SQLite tables questions in plain language. SQLite, Turso/libSQL, Cloudflare D1.

```sql
SELECT * FROM people WHERE jev(people, 'the name is European');
```

## Start — 2 minutes

```bash
bun add file:../sql-jev              # 1. not on npm yet
sqlite3 demo.db < sql/sql-jev.sql    # 2. create the schema
export TYPESAFE_API_KEY=...          # 3. free key: https://console.typesafe.ai
```

```ts
// 4. save as ask.ts
import { Database } from 'bun:sqlite';
import { createJev } from 'sql-jev';

const db = new Database('demo.db');
db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);
         INSERT INTO people (name) VALUES ('Giulia Rossi'), ('Kenji Tanaka');`);

const jev = await createJev({ db, apiKey: process.env.TYPESAFE_API_KEY });
const { rows } = await jev.query(`SELECT name FROM people WHERE jev(people, 'the name is European')`);
console.log(rows);
db.close();
```

```bash
bun run ask.ts     # 5. [ { name: 'Giulia Rossi' } ]  — 1 API call
bun run ask.ts     #    same rows                  — 0 API calls
```

## Errors

| Error | Fix |
| --- | --- |
| `jev: no API key` | step 3, or `UPDATE jev_settings SET value='<key>' WHERE key='api_key'` |
| `jev: jev_judgments is missing` | step 2, or `await jev.schema()` |
| `Could not resolve "sql-jev"` | step 1 |
| `jev: cannot read ahead ... rowid` | table has no rowid (view, CTE): use `await jev.filter(rows, 'condition')` |

## Deploy — one command each

```bash
bunx sql-jev deploy turso --db my-db           # Turso, ~3 min
bunx sql-jev deploy d1 --db my-db --worker     # Cloudflare D1, ~5 min
sqlite3 my.db < sql/sql-jev.sql                # plain SQLite, 5 sec
```

`--dry-run` prints the commands without running them.

## SQL functions

| Function | Returns |
| --- | --- |
| `jev(relation, condition [, threshold])` | boolean — `WHERE` predicate, threshold default 0.5 |
| `jev_prob(relation, condition)` | real 0..1 |
| `jev_score(relation, question, levels)` | real, position on ordered levels |
| `jev_score_norm(relation, question, levels)` | real 0..1 |
| `jev_choice(relation, question, options)` | text, most likely option |
| `jev_confidence(relation, question, kind, options)` | real |
| `jev_eval(relation, question [, kind [, options]])` | JSON text |

Levels and options take any of: `ARRAY['a','b']` · `json_array('a','b')` · `'["a","b"]'` · `('a','b')`.

Views: `jev_stats` · `jev_cached` · `jev_coverage` · `jev_meta`.

## JS row API — for views, CTEs, JSON payloads (no rowid)

```ts
await jev.filter(rows, 'the customer mentions leaving');   // matching rows
await jev.annotate(rows, 'the customer is angry');         // rows + jev_prob
await jev.choice(rows, 'which team?', ['billing', 'sales']);
await jev.score(rows, 'how urgent?', ['low', 'high']);
await jev.warm('people', 'the name is European');          // judge a whole table now
```

## Settings

`UPDATE jev_settings SET value = '2' WHERE key = 'batch_size'` — or `createJev({ batchSize: 2 })`.

| Key | Default |
| --- | --- |
| `api_key` | env `TYPESAFE_API_KEY` |
| `api_url` | `https://api.typesafe.ai/v1/systemone` |
| `model` | `jev-latest` |
| `threshold` | `0.5` |
| `batch_size` / `concurrency` | `40` / `6` |
| `max_prefetch_rows` | `5000` |
| `notices` / `timeout` | `on` / `90` (whole call, retries included) |
| `max_rows_per_statement` | `0` (off) |

## Know before you deploy

- **Full scan.** Every scanned row goes to the model once.
- **Row contents leave your machine.** They go to TypeSafe.
- **`jev()` in SQL needs a rowid table.** Views, CTEs, subqueries: use the JS row API.
- **D1: 1000 queries per Worker invocation.** 5000 rows ≈ 37 — warm big tables on a schedule.
- **First query spends, later ones are free.** Judgments persist in `jev_judgments`; a changed row
  is judged again.

## Develop

```bash
bun install && bun test     # 144 tests, mock model, no credentials
bun run typecheck:all
```

## License

MIT — see `LICENSE`.
