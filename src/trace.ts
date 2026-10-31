import type { DecisionSource, ShadowHit, Usage } from './types.ts';

export interface TraceDecision {
  listenerId: string;
  /** Listener description at the time, so the review agent can read it. */
  description: string;
  probability: number | null;
  source: DecisionSource;
  ruleId?: string;
  /** Model probability for a rule-decided listener that was sampled for audit. */
  audit?: number;
  /** Shadow rule that matched; it was logged but did not decide. */
  shadow?: ShadowHit;
}

export interface TraceEntry {
  ts: string;
  eventId: string;
  name?: string;
  /** Flattened event text after `reveal`, which is what rules match against. */
  text: string;
  /** Text after filler pruning, which is what the model saw. */
  prunedText?: string;
  language?: string;
  model?: string;
  imagesDropped?: number;
  /** The abuse guard blocked the event. Its own decision is in `decisions`. */
  blocked?: boolean;
  /** The abuse guard fired in `flag` mode, so other listeners still ran. */
  flagged?: boolean;
  decisions: TraceDecision[];
  usage: Usage;
  errors?: string[];
}

export interface TraceSink {
  record(entry: TraceEntry): void | Promise<void>;
}

/** Keeps entries in memory. Handy for tests and short scripts. */
export class MemoryTraceSink implements TraceSink {
  readonly entries: TraceEntry[] = [];
  record(entry: TraceEntry): void {
    this.entries.push(entry);
  }
}
