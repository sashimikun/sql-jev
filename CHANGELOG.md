# Changelog

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
- Optional `registerUdfs()` installs the `jev*` function set where the engine exposes
  `create_function`.
- JS row API for subquery results and JSON payloads: `filter`, `annotate`, `prob`, `score`,
  `scoreNorm`, `choice`, `confidence`, `eval`.

**Tooling**

- `sql-jev init | deploy turso | deploy d1 | sql | stats | version`, with verified deploy plans
  and `--dry-run`.
- `sql/sql-jev.sql` is the single source of the schema; `src/schema.ts` is generated from it.
- Deterministic mock TypeSafe endpoint; 35 tests that never touch the live API.
