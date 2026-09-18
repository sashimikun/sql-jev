# Changelog

## 0.2.0

**Indexable predicates: `await jev.tag(relation, condition, opts)`**

- Writes a judgment into a real column (`jev_*`: 0/1 for `noul`, REAL for `score`, TEXT for
  `choice`), fills it from `jev_judgments`, and creates an index on it. The predicate then needs no
  rewriter at all: `WHERE jev_the_name_is_european = 1`.
- Measured on 20,000 rows at 20% selectivity: 0.07 ms indexed versus 26.8 ms through `jev()`.
- Re-running judges only rows whose content changed; rows the model cannot score keep their value.
- Columns named `jev_*` are reserved: never sent to the model, never hashed into a row id.

**Judgment keys carry the model and the prompt format**

- The key is now `kind | condition | options | KEY_FORMAT | model`. Switching `model` re-judges
  instead of silently reusing another model's answers -- the failure mode every session-scoped cache
  has, where nobody notices until the numbers look wrong.
- `KEY_FORMAT` is bumped when the question templates change.
- Upgrading from 0.1.0: old three-part keys never match again, so every row is judged once more on
  its next query. `DELETE FROM jev_judgments` reclaims the space.

**Other**

- `jev.exec(sql)` runs scripts; `jev.query()` refuses multi-statement SQL instead of silently
  running only the first statement.
- `bench/bench.ts` + `bench/RESULTS.md`: cold, warm, tagged, scanned, writes, exec() calls,
  statement sizes, tokens and dollars, reproducible with the mock model.

**Fixed**

- The literal script packer could rebuild a non-upsert statement from its parameters: `tag()` on
  D1-shaped engines emitted a corrupt `INSERT` instead of its `UPDATE`. It now asserts its shape and
  refuses anything else. Found by the benchmark.
- SQLite treats an unknown double-quoted name as a string literal, so the old column probe reported
  a missing tag column as present. The probe is now a zero-row write.
- A tag column used to be sent to the model and hashed into every row id, so adding one re-judged
  the whole table and fed a previous answer back as input.

## 0.1.0

First release: a SQL-lite port of [pg-jev](https://github.com/realZachi/pg-jev) that runs on
Turso / libSQL, Cloudflare D1 and plain SQLite.

**SQL surface** (names and semantics identical to pg-jev)

- `jev(relation, condition [, threshold])`, `jev_prob`, `jev_score`, `jev_score_norm`,
  `jev_choice`, `jev_confidence`, `jev_eval` — rewritten into lookups on `jev_judgments` for
  engines that cannot register user-defined functions.
- Option lists accept `ARRAY['a','b']`, `json_array('a','b')`, `'["a","b"]'` and `('a','b')`.
- Views `jev_stats`, `jev_cached`, `jev_coverage`, `jev_meta` replace the two pg-jev functions
  that need session state.

**Engine**

- Read-ahead by rowid (`max_prefetch_rows`, 5000 by default), batching (`batch_size`, 40),
  parallel requests (`concurrency`, 6), the same retry policy, and the same spend guards
  (`max_rows_per_statement`, `max_chars_per_statement`).
- Judgments persist in a table keyed by `(scope, row_ref, judgment_key)` with a
  `sha256(canonical row JSON)` staleness hash, so a second client, Worker or region reuses them.
- `jev_runs` + `jev_stats` give durable request, token and cost accounting.
- Adapters for D1, `@libsql/client`, `bun:sqlite` / `node:sqlite` / `better-sqlite3`, plus a
  bring-your-own `Adapter` interface. D1 limits (100 bound parameters, ~100 KB statements,
  1000 queries per invocation) shape the write path: literal statements packed into few
  `exec()` calls.
- Optional `registerUdfs()` installs the `jev*` function set where the engine exposes a UDF
  registration API (`node:sqlite`, `better-sqlite3`); elsewhere it returns `false`.
- JS row API for subquery results and JSON payloads: `filter`, `annotate`, `prob`, `score`,
  `scoreNorm`, `choice`, `confidence`, `eval`.

**Tooling**

- `sql-jev init | deploy turso | deploy d1 | sql | stats | version`, with verified deploy plans
  and `--dry-run`.
- `sql/sql-jev.sql` is the single source of the schema; `src/schema.ts` is generated from it.
- Deterministic mock TypeSafe endpoint; the test suite never touches the live API (`bun test`).
