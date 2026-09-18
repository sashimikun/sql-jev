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
 */
export async function postSystemOne(
  config: JevConfig,
  request: SystemOneRequest,
): Promise<JevApiResponse> {
  const key = apiKeyOf(config);
  const body = JSON.stringify(request);
  let delay = BASE_DELAY_MS;
  let last = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
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
          if (attempt === MAX_ATTEMPTS - 1) break;
          await sleep(delay);
          delay = Math.min(delay * 2, MAX_DELAY_MS);
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
      last = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new JevError(`jev: TypeSafe API unreachable after retries: ${last}`);
}
