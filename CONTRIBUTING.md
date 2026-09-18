# Contributing

Thanks for helping. A few rules keep this port honest.

## Never call the live API in tests

Every test runs against `mock/mock-api.ts`, a deterministic stand-in for
`https://api.typesafe.ai/v1/systemone`. It follows the same rules as pg-jev's `mock_api.py`, so
results are stable and CI needs no credentials:

- `noul` → `0.9` when the last word of the condition appears in the row JSON, else `0.1`
- `score` / `choice` → index derived from the length of the canonical row JSON
- a condition containing `trigger422` returns HTTP 422 (the non-retryable path)
- `usage.input_tokens = len(body) // 4`

## Keep SQL parity with pg-jev

Function names, argument order, thresholds, defaults, notices, error text and the cost formula
come from [pg-jev](https://github.com/realZachi/pg-jev). If you change one of them, change it in
both projects, and port the matching scenario from pg-jev's
`test/sql/01_basic.sql` / `02_errors.sql` into `test/engine.test.ts`.

When a pg-jev behaviour cannot exist on SQLite, document it in the README's
"Port notes" section instead of inventing a new one.

## The schema is a single file

`sql/sql-jev.sql` is the source of truth: it is what `turso db shell`, `wrangler d1 execute
--file`, `sqlite3 <` and `sql-jev init` apply. `src/schema.ts` is generated from it — after any
edit run:

```bash
bun run scripts/sync-schema.ts
```

CI runs `--check` and fails when the two have drifted, so a schema change is one edit plus one
command.

## Platform limits are contracts

Cloudflare D1 allows 100 bound parameters per statement, ~100 KB per SQL string, 1,000 queries
per Worker invocation on Paid (50 on Free), and no user-defined functions. Turso Cloud has no
`create_function` and rejects `TEMP` tables. `test/d1.test.ts` runs against a fake binding that
enforces those limits; keep it that way rather than asserting on behaviour that only works locally.

## Docs style

Docs follow the [i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/main/skills/i-have-adhd)
writing skill: lead with the action the reader can run, number multi-step work, no preamble and no
recap, concrete numbers instead of "a bit of work", and at most five items per list. Reference
tables (functions, settings, platform limits) stay complete - the shape changes, not the facts.

## Before opening a pull request

```bash
bun install
bun run typecheck
bun test
bun run scripts/sync-schema.ts --check
bun run build
bunx tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --skipLibCheck templates/d1/worker.ts
```

Then say what you verified, and which platform limits you checked against.

## Releasing

Two ways, both run typecheck, the suite, the build, a version check, `npm publish --provenance` and the
GitHub release notes:

```bash
# 1. from a terminal
git tag v0.2.1 && git push origin v0.2.1

# 2. from the browser: Actions -> Release -> Run workflow -> patch | minor | major
```

The tag must match `package.json`; the second flow bumps it for you, commits, tags and pushes. A tag
pushed by that workflow cannot start a second release (pushes made with `GITHUB_TOKEN` never trigger
workflows), so a release publishes exactly once.

### Publishing credentials, once

**Trusted publishing (preferred, nothing to rotate).** On npmjs.com, open the package, then
*Settings -> Trusted Publisher -> GitHub Actions* and enter this repository (`sashimikun/sql-jev`) and
the workflow filename `release.yml`. The workflow then publishes with a short-lived OIDC credential.
A trusted publisher can only be attached to a package that already exists, so the very first release
has to go out with a token or a local `npm publish`.

**Granular token (bridge for the first release, or if you prefer a secret).** npmjs.com -> *Access
Tokens -> Generate New Token -> Granular*: *All packages*, *Read and write*, and tick **Bypass
two-factor authentication**. Then:

```bash
gh secret set NPM_TOKEN -R sashimikun/sql-jev     # paste the token; it never touches a shell history
```

The workflow uses the token when `NPM_TOKEN` exists and falls back to OIDC when it does not, so you can
drop the secret the moment trusted publishing is configured. Tokens expire; OIDC does not.
