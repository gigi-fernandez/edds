import type { ChatTransport } from './chat.ts';
import { ChatDecisionModel } from './chat.ts';
import { DecisionModelError } from './decision-model.ts';

/** Base URLs of common providers that speak the OpenAI chat completions protocol. */
export const OPENAI_COMPATIBLE = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
} as const;

export interface OpenAICompatibleOptions {
  /** A URL, or a key of OPENAI_COMPATIBLE such as 'openai' or 'ollama'. */
  baseUrl: string;
  model: string;
  /** Defaults to the env var named by `apiKeyEnv`. Local servers can omit both. */
  apiKey?: string;
  apiKeyEnv?: string;
  /** Whether the model accepts images. Default false. */
  images?: boolean;
  /**
   * How to ask for JSON: a strict schema (best), plain JSON mode, or prompt
   * only, for servers that support neither. Default 'json_schema'.
   */
  responseFormat?: 'json_schema' | 'json_object' | 'none';
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export function openAICompatibleTransport(options: OpenAICompatibleOptions): ChatTransport {
  const baseUrl = (OPENAI_COMPATIBLE as Record<string, string>)[options.baseUrl] ?? options.baseUrl;
  const fetchImpl = options.fetch ?? fetch;
  const format = options.responseFormat ?? 'json_schema';

  return {
    id: options.model,
    images: options.images ?? false,
    async complete({ system, prompt, images, schema, signal }) {
      const apiKey = options.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
      const content = images.length
        ? [
            ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/${img.format === 'jpg' ? 'jpeg' : img.format};base64,${img.data}` } })),
            { type: 'text', text: prompt },
          ]
        : prompt;
      const body: Record<string, unknown> = {
        model: options.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      };
      if (format === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'probabilities', strict: true, schema } };
      if (format === 'json_object') body.response_format = { type: 'json_object' };

      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new DecisionModelError(res.status, err?.error?.message ?? res.statusText);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; cost?: number };
      };
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, costUsd: json.usage?.cost ?? 0 },
      };
    },
  };
}

/** Shorthand: a DecisionModel backed by any OpenAI-compatible chat API. */
export function openAICompatible(options: OpenAICompatibleOptions): ChatDecisionModel {
  return new ChatDecisionModel(openAICompatibleTransport(options));
}
