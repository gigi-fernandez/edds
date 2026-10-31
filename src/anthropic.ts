import type Anthropic from '@anthropic-ai/sdk';
import { ChatDecisionModel, type ChatTransport } from './models/chat.ts';
import { DecisionModelError } from './models/decision-model.ts';

export interface AnthropicOptions {
  /**
   * An Anthropic SDK client. Bedrock (AnthropicBedrockMantle) and Vertex
   * (AnthropicVertex) clients work too. Created from the environment when omitted.
   */
  client?: Anthropic;
  model?: string;
  /** Routing is classification work, which does well at low effort. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /**
   * Server-side refusal fallbacks. Claude API only: set false for Bedrock,
   * Vertex or Foundry clients.
   */
  fallbacks?: boolean;
  images?: boolean;
}

export function anthropicTransport(options: AnthropicOptions = {}): ChatTransport {
  let client = options.client;
  const model = options.model ?? 'claude-opus-5-5';
  const fallbacks = options.fallbacks ?? true;

  return {
    id: model,
    images: options.images ?? true,
    async complete({ system, prompt, images, schema, signal }) {
      client ??= new (await import('@anthropic-ai/sdk')).default();
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.format === 'png' ? ('image/png' as const) : ('image/jpeg' as const), data: img.data },
        })),
        { type: 'text' as const, text: prompt },
      ];

      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: options.maxTokens ?? 4096,
          system,
          messages: [{ role: 'user', content }],
          output_config: { effort: options.effort ?? 'low', format: { type: 'json_schema', schema } },
          ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal },
      );

      if (response.stop_reason === 'refusal') {
        throw new DecisionModelError(422, `request declined (${response.stop_details?.category ?? 'no category'})`);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new DecisionModelError(502, 'reply was cut off at max_tokens; raise maxTokens');
      }
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { text, usage: { inputTokens: response.usage.input_tokens } };
    },
  };
}

/** A DecisionModel backed by Claude through the Anthropic SDK. */
export function anthropic(options: AnthropicOptions = {}): ChatDecisionModel {
  return new ChatDecisionModel(anthropicTransport(options));
}
