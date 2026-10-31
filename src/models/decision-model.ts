import type { EventImage, Usage } from '../types.ts';

export interface DecisionQuestion {
  instructions: string;
  criteria: { true: string; false: string };
}

export interface DecisionRequest {
  state: Record<string, unknown>;
  /** Yes/no questions, answered independently of each other. */
  questions: Record<string, DecisionQuestion>;
  images?: EventImage[];
}

export interface DecisionResponse {
  /** Probability of "yes" per question key. */
  probabilities: Record<string, number>;
  usage: Usage;
}

/**
 * The only contract EDDS needs from a provider: answer independent yes/no
 * questions about a state with a probability each. Adapters in this package
 * cover decision-model APIs (OpenRouter) and chat LLMs (any OpenAI-compatible
 * API, Anthropic); anything else is a `defineDecisionModel` call away.
 */
export interface DecisionModel {
  readonly id: string;
  supportsImages(): boolean | Promise<boolean>;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
}

export type ModelSelector = (event: { name?: string; images?: EventImage[] }) => DecisionModel;

export class DecisionModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`decision model error ${status}: ${message}`);
    this.status = status;
  }
}

/** Builds a DecisionModel from a plain function, for providers without an adapter. */
export function defineDecisionModel(options: {
  id: string;
  images?: boolean;
  decide: (request: DecisionRequest, signal?: AbortSignal) => Promise<DecisionResponse>;
}): DecisionModel {
  return { id: options.id, supportsImages: () => options.images ?? false, decide: options.decide };
}

/**
 * Tries each model in order until one answers. Images are stripped for models
 * that cannot read them, so a text-only backup still gets the text.
 */
export function withFallback(...models: DecisionModel[]): DecisionModel {
  if (models.length === 0) throw new Error('withFallback needs at least one model');
  return {
    id: models.map((m) => m.id).join(' → '),
    async supportsImages() {
      for (const m of models) if (await m.supportsImages()) return true;
      return false;
    },
    async decide(request, signal) {
      const errors: unknown[] = [];
      for (const model of models) {
        try {
          const images = request.images?.length && !(await model.supportsImages()) ? [] : request.images;
          return await model.decide({ ...request, images }, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          errors.push(err);
        }
      }
      throw new AggregateError(errors, `all ${models.length} decision models failed`);
    },
  };
}
