import { DecisionModelError, type DecisionModel, type DecisionRequest, type DecisionResponse } from './decision-model.ts';

export interface OpenRouterOptions {
  /** Any decision model id, e.g. `typesafe/jev-1.14` or `openai/gpt-6-luna-decisions`. */
  model: string;
  /** Defaults to `process.env.OPENROUTER_API_KEY`. */
  apiKey?: string;
  /** Skip the capability lookup and state image support directly. */
  images?: boolean;
  baseUrl?: string;
  /** Provider routing preferences, passed through as-is. */
  provider?: Record<string, unknown>;
  /** Retries for 429 and 5xx responses. */
  retries?: number;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai';
const modalityCache = new Map<string, Promise<Map<string, string[]>>>();

/** Lists decision models on OpenRouter with their input modalities. */
export function listDecisionModels(
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string[]>> {
  let cached = modalityCache.get(baseUrl);
  if (!cached) {
    cached = fetchImpl(`${baseUrl}/api/v1/models?output_modalities=decisions`)
      .then(async (res) => {
        if (!res.ok) throw new DecisionModelError(res.status, 'could not list decision models');
        const body = (await res.json()) as { data: { id: string; architecture?: { input_modalities?: string[] } }[] };
        return new Map(body.data.map((m) => [m.id, m.architecture?.input_modalities ?? ['text']]));
      })
      .catch((err) => {
        modalityCache.delete(baseUrl);
        throw err;
      });
    modalityCache.set(baseUrl, cached);
  }
  return cached;
}

export class OpenRouterDecisionModel implements DecisionModel {
  readonly id: string;
  readonly #options: OpenRouterOptions;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: OpenRouterOptions) {
    this.id = options.model;
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async supportsImages(): Promise<boolean> {
    if (this.#options.images !== undefined) return this.#options.images;
    const models = await listDecisionModels(this.#baseUrl, this.#fetch);
    return models.get(this.id)?.includes('image') ?? false;
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const apiKey = this.#options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new DecisionModelError(401, 'no API key: set OPENROUTER_API_KEY or pass apiKey');

    // Images go in `assets`; state references them by whole-string keys,
    // which every decision model accepts (only Jev accepts embedded references).
    const images = request.images ?? [];
    const refs = images.map((_, i) => `image_${i}`);
    const body: Record<string, unknown> = {
      model: this.id,
      state: refs.length ? { ...request.state, images: refs } : request.state,
      questions: Object.fromEntries(
        Object.entries(request.questions).map(([key, q]) => [key, { type: 'noul', ...q }]),
      ),
    };
    if (refs.length) {
      body.assets = Object.fromEntries(
        images.map((img, i) => [refs[i], { type: 'image', format: img.format, data_base64: img.data }]),
      );
    }
    if (this.#options.provider) body.provider = this.#options.provider;

    const retries = this.#options.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(`${this.#baseUrl}/api/alpha/decisions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) return parseResponse(await res.json(), Object.keys(request.questions));

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new DecisionModelError(res.status, err?.error?.message ?? res.statusText);
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}

function parseResponse(json: unknown, keys: string[]): DecisionResponse {
  const body = json as {
    answers?: Record<string, { noul?: number }>;
    usage?: { input_tokens?: number; cost?: number };
  };
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    const p = body.answers?.[key]?.noul;
    if (typeof p !== 'number') throw new DecisionModelError(502, `missing answer for question "${key}"`);
    probabilities[key] = p;
  }
  return {
    probabilities,
    usage: { inputTokens: body.usage?.input_tokens ?? 0, costUsd: body.usage?.cost ?? 0 },
  };
}
