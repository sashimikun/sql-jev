/**
 * Question primitives and answer shapes of TypeSafe's System One API.
 *
 * Direct port of the builders in pg-jev's sql/jev--0.1.0.sql: one request carries many
 * questions over one shared state, so a table of N rows costs ceil(N / batch_size)
 * requests instead of N.
 */

export type JevKind = 'noul' | 'score' | 'choice';

/** Raw answer for one question. Same JSON shape as pg-jev's jev_eval(). */
export interface JevAnswer {
  type?: string;
  /** noul: calibrated probability that the row satisfies the condition (0..1). */
  noul?: number;
  /** score: probability-weighted position on the ordered levels. */
  score?: number;
  /** score: level index (as a string key) to level label. */
  legend?: Record<string, string>;
  /** score/choice: probability per level or option. */
  probabilities?: Record<string, number>;
  /** choice: the most likely option. */
  choice?: string;
  /** score/choice: confidence of the answer. */
  confidence?: number;
  [key: string]: unknown;
}

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface JevApiResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
  /** wall time of the HTTP call in milliseconds, added by the client. */
  _ms?: number;
}

/** Session counters, mirroring jev_stats() in pg-jev. */
export interface JevRunStats {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  rows_evaluated: number;
  cache_hits: number;
  api_ms: number;
  batches: number;
  errors: number;
  estimated_cost_usd: number;
  cached_answers: number;
}

/** jev-1.13 list price; output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const JEV_VERSION = '0.1.0';

export class JevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevError';
  }
}

/** Raised while planning SQL: unknown function, unknown primitive, bad relation argument. */
export class JevSqlError extends JevError {
  constructor(message: string) {
    super(message);
    this.name = 'JevSqlError';
  }
}

export function emptyRunStats(): JevRunStats {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    rows_evaluated: 0,
    cache_hits: 0,
    api_ms: 0,
    batches: 0,
    errors: 0,
    estimated_cost_usd: 0,
    cached_answers: 0,
  };
}

function ref(index: number): string {
  return `rows[${index}]`;
}

/**
 * One question per row, all evaluated over one shared state.
 * Mirrors build_question() in pg-jev.
 */
export function buildQuestion(
  kind: JevKind,
  query: string,
  options: string[] | null,
  index: number,
): Record<string, unknown> {
  const r = ref(index);
  if (kind === 'noul') {
    return {
      type: 'noul',
      instructions: `Does the record \`${r}\` satisfy the condition stated in \`condition\`?`,
      criteria: {
        true: 'The record satisfies the condition',
        false: 'The record does not satisfy the condition',
      },
    };
  }
  if (kind === 'score') {
    if (!options || options.length === 0) {
      throw new JevError('jev_score: levels are required');
    }
    return {
      type: 'score',
      instructions: `Rate the record \`${r}\`: ${query}`,
      criteria: options.slice(),
    };
  }
  if (kind === 'choice') {
    if (!options || options.length === 0) {
      throw new JevError('jev_choice: options are required');
    }
    const criteria: Record<string, null> = {};
    for (const option of options) criteria[option] = null;
    return {
      type: 'choice',
      instructions: `For the record \`${r}\`: ${query}`,
      criteria,
    };
  }
  throw new JevError(`jev: unknown kind '${String(kind)}'`);
}

/** Mirrors state_for() in pg-jev: noul shares the condition, score/choice carry the rows only. */
export function buildState(
  kind: JevKind,
  query: string,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  return kind === 'noul' ? { condition: query, rows } : { rows };
}

export function answerProb(answer: JevAnswer | undefined): number | null {
  const value = answer?.noul;
  return typeof value === 'number' ? value : null;
}

export function answerScore(answer: JevAnswer | undefined): number | null {
  const value = answer?.score;
  return typeof value === 'number' ? value : null;
}

export function answerChoice(answer: JevAnswer | undefined): string | null {
  const value = answer?.choice;
  return typeof value === 'string' ? value : null;
}

export function answerConfidence(answer: JevAnswer | undefined): number | null {
  const value = answer?.confidence;
  return typeof value === 'number' ? value : null;
}

/** Number of levels learned from the answer's legend, falling back to the requested options. */
export function answerLevelsCount(
  answer: JevAnswer | undefined,
  options: string[] | null,
): number | null {
  const legend = answer?.legend;
  if (legend && typeof legend === 'object') return Object.keys(legend).length;
  const probabilities = answer?.probabilities;
  if (probabilities && typeof probabilities === 'object') {
    return Object.keys(probabilities).length;
  }
  return options ? options.length : null;
}

/**
 * jev_score_norm: score / greatest(levels - 1, 1), so rubrics of different sizes compare.
 * pg-jev uses array_length(options) - 1.
 */
export function scoreNorm(score: number | null, levelsCount: number | null): number | null {
  if (score === null) return null;
  const divisor = Math.max((levelsCount ?? 2) - 1, 1);
  return score / divisor;
}
