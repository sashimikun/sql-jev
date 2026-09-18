/**
 * TypeSafe System One HTTP client.
 *
 * Port of call_api() in pg-jev: POST {model, state, questions} with a bearer token, retry
 * 429/529/5xx and network failures with exponential backoff, surface everything else as an
 * error. The wire contract was verified against the public https://api.typesafe.ai/openapi.json.
 */

import type { JevConfig } from './config.js';
import { JevError, type JevApiResponse } from './types.js';

export interface SystemOneRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}

export const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

/**
 * The retry knobs, exported so a test (or an unusual deployment) can shorten the wait without
 * changing the semantics: 6 attempts, 0.5 s doubling to 8 s, exactly as pg-jev counts them.
 */
export const RETRY = {
  attempts: MAX_ATTEMPTS,
  baseMs: BASE_DELAY_MS,
  maxMs: MAX_DELAY_MS,
};

/**
 * Sleeps the backoff, but never past the call's deadline. False when the budget is used up.
 */
async function waitOut(delay: number, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  await sleep(Math.min(delay, remaining));
  return Date.now() < deadline;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apiKeyOf(config: JevConfig): string {
  const key = config.apiKey;
  if (!key) {
    throw new JevError(
      'jev: no API key. Pass { apiKey }, set TYPESAFE_API_KEY, or run ' +
        "UPDATE jev_settings SET value = '<key>' WHERE key = 'api_key'.",
    );
  }
  return key;
}

/** A malformed api_url is a typo, not a network problem: fail at once instead of after 15 s. */
function assertApiUrl(config: JevConfig): void {
  try {
    // eslint-disable-next-line no-new
    new URL(config.apiUrl);
  } catch {
    throw new JevError(`jev: api_url is not a URL: '${config.apiUrl}'`);
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * One request carries many questions over one shared state.
 * Retries 429/529/5xx and transport errors; anything else fails the statement.
 *
 * `jev.timeout` is the wall-clock budget of the whole call, retries included, not a per-attempt
 * timeout multiplied by RETRY.attempts. Six attempts of 90 s is 9 minutes, which is longer than
 * any caller waits for an answer (a Worker request, an HTTP client, a CLI user), so the caller
 * would never see the real error; a hung endpoint now costs one budget and says "timeout after
 * <jev.timeout> ms" instead of being sent six times. Every attempt gets whatever is left of the
 * budget, and the loop stops as soon as the budget is gone.
 */
export async function postSystemOne(
  config: JevConfig,
  request: SystemOneRequest,
): Promise<JevApiResponse> {
  const key = apiKeyOf(config);
  assertApiUrl(config);
  const body = JSON.stringify(request);
  const deadline = Date.now() + config.timeoutMs;
  let delay = RETRY.baseMs;
  let last = '';
  for (let attempt = 0; attempt < RETRY.attempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining <= 0) break;
    // The first attempt gets exactly jev.timeout so the timeout message is the configured
    // number; later attempts share what is left of the budget.
    const budget = attempt === 0 ? config.timeoutMs : Math.max(1, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    const started = Date.now();
    try {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': 'sql-jev/0.1.0',
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 300);
        last = `${response.status} ${text}`;
        if (response.status === 429 || response.status === 529 || response.status >= 500) {
          if (attempt === RETRY.attempts - 1) break;
          if (!(await waitOut(delay, deadline))) break;
          delay = Math.min(delay * 2, RETRY.maxMs);
          continue;
        }
        throw new JevError(`jev: TypeSafe API error ${last}`);
      }
      const data = (await response.json()) as JevApiResponse;
      if (!data || typeof data !== 'object' || typeof data.answers !== 'object' || data.answers === null) {
        throw new JevError(`jev: TypeSafe API returned no answers (${pathOf(config.apiUrl)})`);
      }
      data._ms = Date.now() - started;
      return data;
    } catch (error) {
      if (error instanceof JevError) throw error;
      // An aborted attempt is the timeout, not a broken network: say which, and how long.
      last =
        controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? `timeout after ${budget} ms (jev.timeout)`
          : error instanceof Error
            ? error.message
            : String(error);
      if (attempt === RETRY.attempts - 1) break;
      if (!(await waitOut(delay, deadline))) break;
      delay = Math.min(delay * 2, RETRY.maxMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new JevError(`jev: TypeSafe API unreachable after retries: ${last}`);
}
