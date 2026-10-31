import type { ListenerRules, RuleVerdict } from './rules/rules.ts';

export interface EventImage {
  format: 'png' | 'jpg' | 'jpeg';
  /** Standard base64, without a `data:` prefix. */
  data: string;
}

export interface EddsEvent<P = unknown> {
  /** Stable id used in traces. Generated when missing. */
  id?: string;
  /** Optional event name. Rules can read it as field `name`. */
  name?: string;
  payload: P;
  images?: EventImage[];
}

/** `skipped`: not evaluated, because a hard rule on the abuse guard blocked the event first. */
export type DecisionSource = 'model' | 'rule' | 'error' | 'skipped';

export interface Decision {
  listenerId: string;
  /** Probability that the listener is relevant. Rules decide with 1 or 0. */
  probability: number;
  source: DecisionSource;
  /** Id of the rule that decided, when `source` is `rule`. */
  ruleId?: string;
  threshold: number;
  fired: boolean;
  /** Set when the listener cleared its threshold but did not fire. */
  suppressedBy?: 'abuse' | 'maxFired';
}

export interface Listener<P = unknown> {
  id: string;
  /** Plain-language description of when this listener should fire. */
  description: string;
  /** Overrides the yes/no criteria derived from `description`. */
  criteria?: { true: string; false: string };
  /** Fire when probability >= threshold. Falls back to the Edds default. */
  threshold?: number;
  /** Hand-written hard rules, merged with any loaded rule set. */
  rules?: ListenerRules;
  handler: (event: EddsEvent<P>, decision: Decision) => unknown;
}

export interface Usage {
  inputTokens: number;
  costUsd: number;
}

export interface EmitError {
  kind: 'model' | 'handler' | 'trace';
  listenerId?: string;
  error: unknown;
}

export interface EmitResult {
  eventId: string;
  /** One decision per registered listener, in registration order. */
  decisions: Decision[];
  /** The built-in abuse guard's decision. It is asked about every event. */
  abuse: Decision;
  /** True when the abuse guard stopped every other listener from firing. */
  blocked: boolean;
  /** Ids of listeners whose handler ran. */
  fired: string[];
  errors: EmitError[];
  usage: Usage;
}

export interface ShadowHit {
  ruleId: string;
  verdict: RuleVerdict;
}
