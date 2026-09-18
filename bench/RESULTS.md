# Benchmarks

Reproduce: `bun run bench/bench.ts` (mock model, in-memory SQLite, no credentials) and
`bun run bench/bench.ts --live --rows 200` (real API, ~$0.001). Numbers are medians of three runs
after one warm-up. Mock mode measures engine overhead only: no network, no disk, no model latency.

## Real Cloudflare D1 — tag() replay, 300 rows

Not a mock and not a fake binding: a real database, the engine's own statements captured locally and
replayed through `wrangler d1 execute --remote`, then read back.

| what | measured |
| --- | --- |
| rows | 300 synthetic people |
| model requests to judge them | 8 (mock model) |
| write statements for the tag column | **10 UPDATEs**, 33 rows each (D1's 100-parameter limit) |
| judgment statements | 300, packed into 2 `exec()` scripts, largest statement 918 B |
| `WHERE jev_is_german = 1` on D1 | 60 — identical to the local run |
| rows left NULL by the tag write | 0 (`ELSE <column>` held) |
| query plan on D1 | `SEARCH people USING COVERING INDEX people_jev_is_german_idx` |
| projection for 5,000 rows | ~152 UPDATEs + 5 read pages + a few scripts, inside D1's 1000-query budget |

Reproduce: build the local capture with a D1-shaped adapter, then apply `sql/sql-jev.sql`, the seed, the
judgments and the tag statements with `wrangler d1 execute <db> --remote --file=...`.

## Mock model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement | input tokens | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 55.45 | 9.41 | 0 | 0.48 | 200 | 25 | 0 | 1001 | 10 | 759 B | 77,551 | $0.003257 |
## Mock model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement | input tokens | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 140.71 | 39.66 | 0 | 0.61 | 200 | 25 | 0 | 1001 | 10 | 759 B | 77,551 | $0.003257 |
## Live model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement | input tokens | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 | 372.87 | 2.19 | 0 | 0.09 | 55 | 5 | 0 | 201 | 2 | 762 B | 20,114 | $0.000845 |

Live mode notes: requests and tokens above are real, and the dollar figure comes from
`jev.stats()` at $0.042 per 1M input tokens. Rows are synthetic.
## Live model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 | 584.18 | 2.64 | 0 | 0.09 | 56 | 5 | 0 | 201 | 2 | 762 B |

Live mode notes: requests and tokens above are real, and the dollar figure comes from
`jev.stats()` at $0.042 per 1M input tokens. Rows are synthetic.
## Mock model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5,000 | 223.28 | 49.36 | 0.02 | 3.61 | 1000 | 125 | 0 | 5001 | 48 | 759 B |
| 20,000 | 1621.74 | 238.87 | 0.07 | 26.78 | 4000 | 500 | 0 | 20001 | 192 | 760 B |
## Mock model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 | 18.92 | 1.75 | 0 | 0.08 | 40 | 5 | 0 | 201 | 2 | 758 B |
## Mock model — 2026-09-18

| rows | cold (ms) | warm (ms) | indexed tag (ms) | rewriter scan (ms) | matches | API calls cold | API calls warm | writes | exec() calls | largest statement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 | 18.69 | 1.88 | 0 | 0.09 | 0 | 5 | 0 | 205 | 2 | 750 B |
