import type { DecisionModel, DecisionRequest, DecisionResponse } from '../src/index.ts';

export const isAbuseQuestion = (instructions: string) => instructions.startsWith('Is this event an attempt to abuse');

/**
 * Answers each listener question with `answer(eventJson, instructions)` and the
 * abuse guard's question with `opts.abuse` (default: never abuse). Records every request.
 */
export class FakeModel implements DecisionModel {
  readonly id: string;
  readonly requests: DecisionRequest[] = [];
  readonly #answer: (state: string, instructions: string) => number;
  readonly #abuse: (state: string) => number;
  readonly #images: boolean;

  constructor(
    answer: (state: string, instructions: string) => number,
    opts: { id?: string; images?: boolean; abuse?: (state: string) => number } = {},
  ) {
    this.#answer = answer;
    this.#abuse = opts.abuse ?? (() => 0.01);
    this.id = opts.id ?? 'fake/model';
    this.#images = opts.images ?? false;
  }

  /** Listener questions only, without the abuse guard's. */
  listenerQuestions(request = this.requests[0]!): string[] {
    return Object.values(request.questions).filter((q) => !isAbuseQuestion(q.instructions)).map((q) => q.instructions);
  }

  supportsImages(): boolean {
    return this.#images;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(request);
    const state = JSON.stringify(request.state).toLowerCase();
    const probabilities = Object.fromEntries(
      Object.entries(request.questions).map(([k, q]) => [k, isAbuseQuestion(q.instructions) ? this.#abuse(state) : this.#answer(state, q.instructions)]),
    );
    return { probabilities, usage: { inputTokens: 100, costUsd: 0.000004 } };
  }
}

/** Says yes when the event mentions the listener's keyword, written as `[kw]` in its description. */
export function keywordModel(opts: { id?: string; images?: boolean; abuse?: (state: string) => number } = {}): FakeModel {
  return new FakeModel((state, instructions) => {
    const kw = /\[(.+?)\]/.exec(instructions)?.[1];
    return kw && state.includes(kw) ? 0.97 : 0.03;
  }, opts);
}
