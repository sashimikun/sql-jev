/**
 * Deterministic stand-in for https://api.typesafe.ai/v1/systemone.
 *
 * Port of pg-jev's test/mock_api.py with the same rules, so expected results stay stable
 * without ever calling the live API:
 *
 *   noul   -> 0.9 when the LAST word of state.condition appears (case-insensitively) in the
 *             canonical row JSON, else 0.1
 *   score  -> level index = length of the row JSON modulo the number of levels
 *   choice -> option index = length of the row JSON modulo the number of options
 *   a condition containing "trigger422" returns HTTP 422 (the non-retryable path)
 *   usage.input_tokens = length of the request body // 4
 *
 * Run standalone: bun run mock/mock-api.ts [port]
 */

import { canonicalJson } from '../src/sql.ts';

export interface MockApi {
  /** Full endpoint URL, e.g. http://127.0.0.1:54321/v1/systemone */
  url: string;
  /** Requests received so far, so tests can prove batching and cache behaviour. */
  requests: number;
  stop(): void;
}

interface Question {
  type?: string;
  criteria?: unknown;
  instructions?: string;
}

interface Payload {
  model?: string;
  state?: { rows?: unknown[]; condition?: string };
  questions?: Record<string, Question>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The whole mock contract, exposed so it can be unit tested without a socket. */
export function mockResponse(
  bodyText: string,
  authorization: string | null,
  expectedKey = 'test-key',
): { status: number; body: Record<string, unknown> } {
  if (authorization !== `Bearer ${expectedKey}`) {
    return { status: 401, body: { error: 'invalid api key' } };
  }
  let payload: Payload;
  try {
    payload = JSON.parse(bodyText) as Payload;
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }
  if (!payload.model) return { status: 400, body: { error: 'model is required' } };
  const questions = payload.questions ?? {};
  if (Object.keys(questions).length === 0) {
    return { status: 400, body: { error: 'questions must have at least one property' } };
  }
  const rows = Array.isArray(payload.state?.rows) ? (payload.state?.rows as unknown[]) : [];
  const condition = typeof payload.state?.condition === 'string' ? payload.state.condition : '';
  if (condition.includes('trigger422')) {
    return { status: 422, body: { error: 'mock validation failure' } };
  }
  const words = condition.trim().split(/\s+/);
  const needle = (words.length > 0 ? (words[words.length - 1] as string) : '').toLowerCase();
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const index = Number(id.slice(1));
    const rowJson = canonicalJson(rows[index] ?? null);
    const lower = rowJson.toLowerCase();
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: needle && lower.includes(needle) ? 0.9 : 0.1 };
      continue;
    }
    if (question.type === 'score') {
      const levels = Array.isArray(question.criteria) ? (question.criteria as string[]) : [];
      if (levels.length === 0) return { status: 422, body: { error: 'score needs levels' } };
      const k = rowJson.length % levels.length;
      answers[id] = {
        type: 'score',
        score: k,
        legend: Object.fromEntries(levels.map((level, j) => [String(j), level])),
        probabilities: Object.fromEntries(levels.map((_level, j) => [String(j), j === k ? 1 : 0])),
        confidence: 1,
      };
      continue;
    }
    if (question.type === 'choice') {
      const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
      if (options.length === 0) return { status: 422, body: { error: 'choice needs options' } };
      const k = rowJson.length % options.length;
      answers[id] = {
        type: 'choice',
        choice: options[k],
        probabilities: Object.fromEntries(options.map((option, j) => [option, j === k ? 1 : 0])),
        confidence: 1,
      };
      continue;
    }
    return { status: 422, body: { error: `unknown primitive ${String(question.type)}` } };
  }
  return {
    status: 200,
    body: {
      model: 'jev-mock',
      answers,
      usage: {
        input_tokens: Math.floor(bodyText.length / 4),
        output_tokens: Object.keys(answers).length,
      },
    },
  };
}

/** Starts the mock on a random port and returns its URL. */
export function startMockApi(options: { expectedKey?: string } = {}): MockApi {
  const expectedKey = options.expectedKey ?? 'test-key';
  const api: MockApi = { url: '', requests: 0, stop: () => undefined };
  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      api.requests += 1;
      const bodyText = await request.text();
      const { status, body } = mockResponse(bodyText, request.headers.get('authorization'), expectedKey);
      return jsonResponse(status, body);
    },
  });
  api.url = `${server.url.origin}/v1/systemone`;
  api.stop = () => server.stop(true);
  return api;
}

if (import.meta.main) {
  const port = Number(Bun.argv[2] ?? 8765);
  const server = Bun.serve({
    port,
    fetch: async (request: Request): Promise<Response> => {
      const { status, body } = mockResponse(await request.text(), request.headers.get('authorization'));
      return jsonResponse(status, body);
    },
  });
  console.log(`jev mock API on ${server.url.origin}/v1/systemone (key: test-key)`);
}
