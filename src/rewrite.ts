/**
 * The SQL-lite equivalent of `jev()` on Postgres.
 *
 * PostgreSQL passes a whole row to a function (`jev(people, 'the name is European')`) and
 * pg-jev resolves that composite value itself. SQLite has no composite row argument, and
 * Cloudflare D1 cannot register user-defined functions at all, so this module:
 *
 *   1. tokenizes the statement, ignoring string literals, quoted identifiers and comments;
 *   2. finds every jev* call and maps its relation argument to the table actually read
 *      (resolving `FROM people p` style aliases);
 *   3. rewrites each call to a correlated lookup on jev_judgments, which the engine has
 *      already filled by read-ahead, so the SQL text you wrote stays the SQL you wrote.
 *
 * `SELECT name FROM cities WHERE jev(cities, 'the country is Germany')` works on Turso and
 * on D1 with no user-defined function anywhere.
 */

import { judgmentKey, quoteIdentifier, quoteLiteral, relationSqlFor } from './sql.js';
import { JevSqlError, type JevKind } from './types.js';

export interface Token {
  kind: 'word' | 'string' | 'quoted' | 'number' | 'punct';
  value: string;
  start: number;
  end: number;
}

const FUNCTIONS = new Set([
  'jev',
  'jev_prob',
  'jev_score',
  'jev_score_norm',
  'jev_choice',
  'jev_confidence',
  'jev_eval',
]);

const PRIMITIVES = new Set<string>(['noul', 'score', 'choice']);

/** Words that can never be a table alias. */
const RESERVED = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'limit', 'offset', 'having', 'join',
  'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'using', 'as', 'union', 'all',
  'except', 'intersect', 'with', 'recursive', 'and', 'or', 'not', 'is', 'null', 'in',
  'between', 'like', 'glob', 'case', 'when', 'then', 'else', 'end', 'values', 'set',
  'returning', 'indexed', 'window', 'filter', 'over', 'collate', 'distinct', 'asc', 'desc',
  'natural', 'table', 'insert', 'update', 'delete', 'create', 'drop', 'alter', 'into',
]);

/** Splits SQL into tokens, skipping comments and keeping literal spans intact. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        value += sql[j] as string;
        j += 1;
      }
      out.push({ kind: 'string', value, start: i, end: j });
      i = j;
      continue;
    }
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        value += sql[j] as string;
        j += 1;
      }
      out.push({ kind: 'quoted', value, start: i, end: j });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j] as string)) j += 1;
      out.push({ kind: 'word', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9]/.test(sql[j] as string)) j += 1;
      if (sql[j] === '.') {
        j += 1;
        while (j < n && /[0-9]/.test(sql[j] as string)) j += 1;
      }
      if (sql[j] === 'e' || sql[j] === 'E') {
        let k = j + 1;
        if (sql[k] === '+' || sql[k] === '-') k += 1;
        if (/[0-9]/.test(sql[k] ?? '')) {
          j = k;
          while (j < n && /[0-9]/.test(sql[j] as string)) j += 1;
        }
      }
      out.push({ kind: 'number', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    out.push({ kind: 'punct', value: ch, start: i, end: i + 1 });
    i += 1;
  }
  return out;
}

function matchParen(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind !== 'punct') continue;
    if (tok.value === '(') depth += 1;
    else if (tok.value === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits the arguments of a call; `openIdx` is the index of its '('. */
function readArgs(tokens: Token[], openIdx: number): { args: Token[][]; closeIdx: number } {
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 1; // the call's own parentheses are already open
  for (let i = openIdx + 1; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'punct') {
      if (tok.value === '(' || tok.value === '[') depth += 1;
      else if (tok.value === ']') depth -= 1;
      else if (tok.value === ')') {
        depth -= 1;
        if (depth === 0) {
          if (current.length > 0) args.push(current);
          return { args, closeIdx: i };
        }
      } else if (tok.value === ',' && depth === 1) {
        args.push(current);
        current = [];
        continue;
      }
    }
    current.push(tok);
  }
  throw new JevSqlError('jev: unbalanced parentheses in jev() call');
}

function textOf(sql: string, tokens: Token[]): string {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!first || !last) return '';
  return sql.slice(first.start, last.end).trim();
}

/** 'a' -> a ; ARRAY['a','b'] -> [a, b] ; '["a","b"]' -> [a, b] ; json_array('a','b') -> [a, b] */
function parseOptions(sql: string, tokens: Token[], fnName: string): string[] {
  if (tokens.length === 0) {
    throw new JevSqlError(`${fnName}: levels/options are required`);
  }
  const single = tokens.length === 1 ? tokens[0] : undefined;
  if (single && single.kind === 'string') {
    const raw = single.value.trim();
    if (raw.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new JevSqlError(`${fnName}: could not parse options JSON ${textOf(sql, tokens)}`);
      }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        throw new JevSqlError(`${fnName}: options must be a JSON array of strings`);
      }
      return parsed as string[];
    }
    throw new JevSqlError(
      `${fnName}: options must be a literal list, for example ARRAY['billing','sales'] or '[\"billing\",\"sales\"]'`,
    );
  }
  let inner = tokens;
  const head = tokens[0];
  if (head && head.kind === 'word' && head.value.toLowerCase() === 'array') {
    const open = tokens[1];
    const close = tokens[tokens.length - 1];
    if (!open || open.value !== '[' || !close || close.value !== ']') {
      throw new JevSqlError(`${fnName}: expected ARRAY['a','b', ...]`);
    }
    inner = tokens.slice(2, -1);
  } else if (head && head.kind === 'word' && head.value.toLowerCase() === 'json_array') {
    const open = tokens[1];
    const close = tokens[tokens.length - 1];
    if (!open || open.value !== '(' || !close || close.value !== ')') {
      throw new JevSqlError(`${fnName}: expected json_array('a', 'b', ...)`);
    }
    inner = tokens.slice(2, -1);
  } else if (head && head.kind === 'punct' && head.value === '(') {
    inner = tokens.slice(1, -1);
  } else {
    throw new JevSqlError(
      `${fnName}: options must be a literal list, for example ARRAY['billing','sales'] or '[\"billing\",\"sales\"]'`,
    );
  }
  const values: string[] = [];
  for (const tok of inner) {
    if (tok.kind === 'string' || tok.kind === 'quoted') values.push(tok.value);
    else if (tok.kind === 'punct' && tok.value === ',') continue;
    else {
      throw new JevSqlError(`${fnName}: options must be string literals, found '${tok.value}'`);
    }
  }
  if (values.length === 0) throw new JevSqlError(`${fnName}: options must not be empty`);
  return values;
}

function parseStringArg(sql: string, tokens: Token[], fnName: string, what: string): string {
  const first = tokens[0];
  if (!first || tokens.length !== 1 || first.kind !== 'string') {
    throw new JevSqlError(
      `${fnName}: ${what} must be a string literal, found ${textOf(sql, tokens) || 'nothing'}`,
    );
  }
  return first.value;
}

export type CallOutput =
  | 'bool'
  | 'prob'
  | 'score'
  | 'score_norm'
  | 'choice'
  | 'confidence'
  | 'eval';

export interface AnalyzedCall {
  fn: string;
  kind: JevKind;
  output: CallOutput;
  /** Relation read ahead, e.g. 'people' (or 'main.people'). The judgment scope. */
  relation: string;
  /** The relation as quoted SQL, e.g. "people" or "main"."people". */
  relationSql: string;
  /** Identifier the user wrote as the first argument. */
  relationAlias: string;
  /** The written identifier as quoted SQL. */
  relationAliasSql: string;
  /** Identifier usable for rowid in this statement, e.g. 'p' for `FROM people p`. */
  rowAlias: string;
  /** rowAlias as quoted SQL, safe for dotted and quoted names. */
  rowAliasSql: string;
  condition: string;
  options: string[] | null;
  /** Raw SQL text of an explicit threshold argument, if any. */
  thresholdSql: string | null;
  /** kind | condition | options, the identity of the judgment to look up. */
  judgmentKey: string;
  start: number;
  end: number;
  text: string;
}

export interface SqlAnalysis {
  sql: string;
  calls: AnalyzedCall[];
  /** alias (lowercased) -> relation, for `FROM people p` style queries. */
  aliases: Map<string, string>;
}

interface RelationParts {
  name: string;
  key: string;
}

/** Reads `people`, `main.people`, `"my table"` after a FROM/JOIN keyword. */
function readRelation(
  tokens: Token[],
  startIdx: number,
): { relation: RelationParts; nextIdx: number } | null {
  let i = startIdx;
  const parts: string[] = [];
  for (;;) {
    const tok = tokens[i];
    if (!tok) return null;
    if (tok.kind === 'word' || tok.kind === 'quoted') {
      parts.push(tok.value);
      i += 1;
    } else {
      return null;
    }
    const dot = tokens[i];
    if (dot && dot.kind === 'punct' && dot.value === '.') {
      i += 1;
      continue;
    }
    break;
  }
  const name = parts.map((part) => quoteIdentifier(part)).join('.');
  const key = parts.join('.');
  if (!key) return null;
  return { relation: { name, key }, nextIdx: i };
}

function buildAliasMap(tokens: Token[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind !== 'word') continue;
    const keyword = tok.value.toLowerCase();
    if (keyword !== 'from' && keyword !== 'join') continue;
    const after = tokens[i + 1];
    if (!after) continue;
    if (after.kind === 'punct' && after.value === '(') {
      // A subquery: only its trailing alias is a relation handle.
      const close = matchParen(tokens, i + 1);
      if (close === -1) continue;
      let j = close + 1;
      const asTok = tokens[j];
      if (asTok && asTok.kind === 'word' && asTok.value.toLowerCase() === 'as') j += 1;
      const aliasTok = tokens[j];
      if (aliasTok && (aliasTok.kind === 'word' || aliasTok.kind === 'quoted')) {
        if (aliasTok.kind === 'quoted' || !RESERVED.has(aliasTok.value.toLowerCase())) {
          map.set(aliasTok.value.toLowerCase(), aliasTok.value);
        }
      }
      continue;
    }
    if (after.kind === 'word' && RESERVED.has(after.value.toLowerCase())) continue;
    const read = readRelation(tokens, i + 1);
    if (!read) continue;
    const { relation, nextIdx } = read;
    let j = nextIdx;
    let alias: string | null = null;
    const asTok = tokens[j];
    if (asTok && asTok.kind === 'word' && asTok.value.toLowerCase() === 'as') {
      const aliasTok = tokens[j + 1];
      if (aliasTok && (aliasTok.kind === 'word' || aliasTok.kind === 'quoted')) {
        alias = aliasTok.value;
        j += 2;
      }
    } else if (asTok && (asTok.kind === 'quoted' || (asTok.kind === 'word' && !RESERVED.has(asTok.value.toLowerCase())))) {
      alias = asTok.value;
      j += 1;
    }
    const key = (alias ?? relation.key).toLowerCase();
    if (!map.has(key)) map.set(key, relation.key);
    if (!alias) {
      const selfKey = relation.key.toLowerCase();
      if (!map.has(selfKey)) map.set(selfKey, relation.key);
    }
  }
  return map;
}

/** Reads `people`, `main.people` or `"my table"` as a call's first argument. */
function relationNameParts(
  sql: string,
  tokens: Token[],
  fn: string,
): { text: string; sql: string } {
  const parts: { text: string; quoted: boolean }[] = [];
  tokens.forEach((token, index) => {
    if (index % 2 === 0) {
      if (token.kind !== 'word' && token.kind !== 'quoted') {
        throw new JevSqlError(
          `${fn}: the first argument must be a table or alias name, found ` +
            `${textOf(sql, tokens) || 'nothing'}. Rows from a subquery have no rowid; ` +
            'read them through the JS row API (await jev.filter(rows, condition)) instead.',
        );
      }
      parts.push({ text: token.value, quoted: token.kind === 'quoted' });
      return;
    }
    if (!(token.kind === 'punct' && token.value === '.')) {
      throw new JevSqlError(`${fn}: could not read the relation argument ${textOf(sql, tokens)}`);
    }
  });
  if (parts.length === 0) {
    throw new JevSqlError(`${fn}: the first argument must be a table or alias name`);
  }
  const text = parts.map((part) => part.text).join('.');
  const quotedSql =
    parts.length === 1 && parts[0]!.quoted
      ? quoteIdentifier(parts[0]!.text)
      : parts.map((part) => quoteIdentifier(part.text)).join('.');
  return { text, sql: quotedSql };
}

function outputFor(fn: string, kind: JevKind): CallOutput {
  switch (fn) {
    case 'jev':
      return 'bool';
    case 'jev_prob':
      return 'prob';
    case 'jev_score':
      return 'score';
    case 'jev_score_norm':
      return 'score_norm';
    case 'jev_choice':
      return 'choice';
    case 'jev_confidence':
      return 'confidence';
    case 'jev_eval':
      return 'eval';
    default:
      throw new JevSqlError(`jev: unknown function '${fn}'`);
  }
}

/** Locates every jev* call and resolves relation, condition, options and threshold. */
export function analyzeSql(sql: string): SqlAnalysis {
  const tokens = tokenize(sql);
  const aliases = buildAliasMap(tokens);
  const calls: AnalyzedCall[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind !== 'word') continue;
    const fn = tok.value.toLowerCase();
    if (!FUNCTIONS.has(fn)) continue;
    const prev = tokens[i - 1];
    if (prev && prev.kind === 'punct' && (prev.value === '.' || prev.value === '"')) continue;
    const open = tokens[i + 1];
    if (!open || open.kind !== 'punct' || open.value !== '(') continue;
    const { args, closeIdx } = readArgs(tokens, i + 1);
    const last = tokens[closeIdx] as Token;
    if (args.length < 2) {
      throw new JevSqlError(`${fn}: expected at least a relation and a condition`);
    }
    const nameParts = relationNameParts(sql, args[0] as Token[], fn);
    const relationAlias = nameParts.text;
    const relationAliasSql = nameParts.sql;
    const key = relationAlias.toLowerCase();
    const written = aliases.get(key);
    const relation = written ?? relationAlias;
    let rowAlias = relationAlias;
    let rowAliasSql = relationAliasSql;
    if (written === undefined) {
      const candidates = [...aliases.entries()].filter(([, rel]) => rel.toLowerCase() === key);
      if (candidates.length === 1) {
        rowAlias = candidates[0]![0];
        rowAliasSql = quoteIdentifier(rowAlias);
      } else if (candidates.length > 1) {
        throw new JevSqlError(
          `${fn}: '${relationAlias}' is ambiguous in this statement; use one of the aliases: ` +
            candidates.map(([alias]) => alias).join(', '),
        );
      }
    }
    const relationSql = written === undefined ? relationAliasSql : relationSqlFor(written);

    let kind: JevKind = 'noul';
    let options: string[] | null = null;
    let thresholdSql: string | null = null;
    switch (fn) {
      case 'jev': {
        if (args.length > 3) throw new JevSqlError('jev: expected jev(relation, condition [, threshold])');
        const third = args[2];
        if (third) thresholdSql = textOf(sql, third);
        break;
      }
      case 'jev_prob': {
        if (args.length > 2) throw new JevSqlError('jev_prob: expected jev_prob(relation, condition)');
        break;
      }
      case 'jev_score':
      case 'jev_score_norm': {
        if (args.length !== 3) {
          throw new JevSqlError(`${fn}: expected ${fn}(relation, question, levels)`);
        }
        kind = 'score';
        options = parseOptions(sql, args[2] as Token[], fn);
        break;
      }
      case 'jev_choice': {
        if (args.length !== 3) throw new JevSqlError('jev_choice: expected jev_choice(relation, question, options)');
        kind = 'choice';
        options = parseOptions(sql, args[2] as Token[], fn);
        break;
      }
      case 'jev_confidence':
      case 'jev_eval': {
        const kindTokens = args[2];
        let rawKind = fn === 'jev_eval' ? 'noul' : null;
        if (kindTokens) {
          rawKind = parseStringArg(sql, kindTokens, fn, 'kind').toLowerCase();
        }
        if (rawKind === null) throw new JevSqlError(`${fn}: expected ${fn}(relation, question, kind, options)`);
        if (!PRIMITIVES.has(rawKind)) {
          throw new JevSqlError(`jev: unknown kind '${rawKind}'`);
        }
        kind = rawKind as JevKind;
        const optionTokens = args[3];
        if (optionTokens) options = parseOptions(sql, optionTokens, fn);
        if ((kind === 'score' || kind === 'choice') && !options) {
          throw new JevSqlError(`${fn}: ${kind} requires options`);
        }
        if (kind === 'noul') options = null;
        break;
      }
      default:
        throw new JevSqlError(`jev: unknown function '${fn}'`);
    }

    const condition = parseStringArg(sql, args[1] as Token[], fn, 'condition');
    calls.push({
      fn,
      kind,
      output: outputFor(fn, kind),
      relation,
      relationAlias,
      relationAliasSql,
      relationSql,
      rowAlias,
      rowAliasSql,
      condition,
      options,
      thresholdSql,
      judgmentKey: judgmentKey(kind, condition, options),
      start: tok.start,
      end: last.end,
      text: sql.slice(tok.start, last.end),
    });
    i = closeIdx;
  }
  return { sql, calls, aliases };
}

/** Unwarmed rows read as -1 (prob/score), '' (choice), or NULL (confidence/eval). */
export function renderCall(call: AnalyzedCall, fallbackThreshold: number): string {
  const where =
    `FROM jev_judgments j WHERE j.scope = ${quoteLiteral(call.relation)}` +
    ` AND j.row_ref = CAST(${call.rowAliasSql}.rowid AS TEXT)` +
    ` AND j.judgment_key = ${quoteLiteral(call.judgmentKey)}`;
  const subExpr = (expr: string): string => `(SELECT ${expr} ${where})`;
  switch (call.output) {
    case 'prob':
      return `COALESCE(${subExpr('j.prob')}, -1.0)`;
    case 'score':
      return `COALESCE(${subExpr('j.score')}, -1.0)`;
    case 'score_norm':
      return `COALESCE(${subExpr('j.score / MAX(COALESCE(j.levels_count, 2) - 1, 1)')}, -1.0)`;
    case 'choice':
      return `COALESCE(${subExpr('j.label')}, '')`;
    case 'confidence':
      return subExpr('j.confidence');
    case 'eval':
      return subExpr('j.answer_json');
    case 'bool': {
      const threshold = call.thresholdSql ?? String(fallbackThreshold);
      return `(COALESCE(${subExpr('j.prob')}, -1.0) >= COALESCE(${threshold}, ${fallbackThreshold}))`;
    }
    default:
      throw new JevSqlError(`jev: cannot render ${call.fn}`);
  }
}

/** Replaces every call with its correlated lookup, right to left so offsets stay valid. */
export function rewriteSql(
  sql: string,
  calls: AnalyzedCall[],
  fallbackThreshold: number,
): string {
  let out = sql;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i] as AnalyzedCall;
    out = out.slice(0, call.start) + renderCall(call, fallbackThreshold) + out.slice(call.end);
  }
  return out;
}
