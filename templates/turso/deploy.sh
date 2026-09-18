#!/usr/bin/env bash
#
# Create a Turso database, load sql/sql-jev.sql into it, and print the connection details.
#
#   bash templates/turso/deploy.sh sql-jev              # create + migrate + report
#   bash templates/turso/deploy.sh sql-jev --dry-run    # print the commands, run nothing
#   bash templates/turso/deploy.sh --help
#
# The database name may also come from $TURSO_DB_NAME. An existing database is left in
# place and only migrated, so the script is safe to re-run.
#
# Needs the Turso CLI and one interactive `turso auth signup` / `turso auth login` first:
#   curl -sSfL https://get.tur.so/install.sh | bash
#
# Everything runs under `set -euo pipefail`: the first failing command stops the script.

set -euo pipefail

DB_NAME="${TURSO_DB_NAME:-}"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: bash templates/turso/deploy.sh <database-name> [--dry-run]

  <database-name>  Turso database to create or migrate (or $TURSO_DB_NAME)

Options:
  --dry-run        Print the turso commands instead of running them
  -h, --help       Show this help

What it runs, in order:
  turso db create <name>                        (skipped when the database exists)
  turso db shell <name> < sql/sql-jev.sql       (idempotent schema + settings seeds)
  turso db shell <name> "SELECT ... jev_settings"
  turso db show <name> --url                    (libsql://...)
  turso db show <name> --http-url               (https://..., for HTTP clients)
  turso db tokens create <name>                 (the auth token, printed once)
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'error: unknown option %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$DB_NAME" ]; then
        printf 'error: unexpected extra argument %s\n\n' "$1" >&2
        usage >&2
        exit 2
      fi
      DB_NAME="$1"
      ;;
  esac
  shift
done

if [ -z "$DB_NAME" ]; then
  printf 'error: database name is required\n\n' >&2
  usage >&2
  exit 2
fi

if ! printf '%s' "$DB_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$'; then
  printf 'error: database name %s may only contain letters, digits, - and _\n' "$DB_NAME" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SCHEMA_FILE="${REPO_ROOT}/sql/sql-jev.sql"

# run <command...>: echo the command, then run it unless --dry-run was given.
run() {
  printf '  $ %s\n' "$*"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  "$@"
}

# turso_db_exists: exit 0 when `turso db show <name>` succeeds.
turso_db_exists() {
  if [ "$DRY_RUN" -eq 1 ]; then
    return 1
  fi
  turso db show "$DB_NAME" --url >/dev/null 2>&1
}

printf 'sql-jev / Turso deploy: database=%s%s\n' "$DB_NAME" "$([ "$DRY_RUN" -eq 1 ] && printf ' (dry run)')"

if ! command -v turso >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
  printf 'error: the turso CLI is not on PATH.\n' >&2
  printf '       curl -sSfL https://get.tur.so/install.sh | bash\n' >&2
  exit 127
fi

if [ ! -f "$SCHEMA_FILE" ] && [ "$DRY_RUN" -eq 0 ]; then
  printf 'error: %s not found (run this script from the sql-jev repository)\n' "$SCHEMA_FILE" >&2
  exit 1
fi

# ---------------------------------------------------------------- 1. the database

printf '\n1. database\n'
if turso_db_exists; then
  printf '  database %s already exists, keeping it\n' "$DB_NAME"
else
  run turso db create "$DB_NAME"
fi

# ---------------------------------------------------------------- 2. the schema

printf '\n2. schema (sql/sql-jev.sql: jev_judgments, jev_runs, jev_settings and the views)\n'
printf '  $ turso db shell %s < %s\n' "$DB_NAME" "$SCHEMA_FILE"
if [ "$DRY_RUN" -eq 0 ]; then
  # Idempotent: CREATE ... IF NOT EXISTS plus INSERT OR IGNORE seeds.
  turso db shell "$DB_NAME" <"$SCHEMA_FILE"
fi

# ---------------------------------------------------------------- 3. verify

printf '\n3. verify\n'
printf '  $ turso db shell %s "SELECT key, value FROM jev_settings WHERE key IN (%s)"\n' \
  "$DB_NAME" "'version','model','threshold'"
if [ "$DRY_RUN" -eq 0 ]; then
  turso db shell "$DB_NAME" \
    "SELECT key, value FROM jev_settings WHERE key IN ('version','model','threshold') ORDER BY key;"
fi

# ---------------------------------------------------------------- 4. connection

printf '\n4. connection details\n'
DB_URL=""
HTTP_URL=""
if [ "$DRY_RUN" -eq 1 ]; then
  DB_URL="<turso db show ${DB_NAME} --url>"
  HTTP_URL="<turso db show ${DB_NAME} --http-url>"
  printf '  $ turso db show %s --url\n' "$DB_NAME"
  printf '  $ turso db show %s --http-url\n' "$DB_NAME"
else
  DB_URL="$(turso db show "$DB_NAME" --url | tr -d '[:space:]')"
  HTTP_URL="$(turso db show "$DB_NAME" --http-url | tr -d '[:space:]')"
  case "$DB_URL" in
    libsql://* | file:* | ws://*) ;;
    *)
      printf 'warning: unexpected URL from turso db show: %s\n' "$DB_URL" >&2
      ;;
  esac
  printf '  url: %s\n' "$DB_URL"
  printf '  http: %s\n' "$HTTP_URL"
fi

# ---------------------------------------------------------------- 5. auth token

printf '\n5. auth token\n'
printf '  $ turso db tokens create %s\n' "$DB_NAME"
if [ "$DRY_RUN" -eq 1 ]; then
  AUTH_TOKEN="<turso db tokens create ${DB_NAME}>"
else
  AUTH_TOKEN="$(turso db tokens create "$DB_NAME" | tr -d '[:space:]')"
fi

cat <<EOF

Database '$DB_NAME' is ready. Export the two env vars the client needs:

  export TURSO_DATABASE_URL='${DB_URL}'
  export TURSO_AUTH_TOKEN='${AUTH_TOKEN}'
  export TYPESAFE_API_KEY='ts_...'   # your TypeSafe System One key

Then run the example (it applies the schema again, idempotently, and queries the table):

  bun run templates/turso/example.ts

Notes:
  - turso db show '$DB_NAME' --url          gives the libsql:// URL (the client's URL)
  - turso db show '$DB_NAME' --http-url     gives the https:// URL (plain HTTP clients)
  - turso db tokens create '$DB_NAME'       mints another token when this one is lost
  - The token above is a secret: it is shown once and is not recoverable from Turso.
  - Turso has no user-defined SQL functions, so jev.registerUdfs() does nothing there;
    the rewriter inside jev.query()/jev.translate() is the only path.
EOF
