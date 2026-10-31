import { eventText, flatten, readField } from '../text.ts';
import type { EddsEvent } from '../types.ts';

export interface RuleMeta {
  id?: string;
  source?: 'manual' | 'review-agent';
  note?: string;
  /** Lower bound of agreement with the model when the rule was proposed. */
  precision?: number;
  /** Number of traced events the rule matched when proposed. */
  support?: number;
  createdAt?: string;
}

/**
 * JSON-serializable hard rule. `field` is a dot path on the event
 * (`name`, `payload.subject`); without it, rules match the flattened event text.
 */
export type Rule =
  | { kind: 'keywords'; any: string[]; field?: string; meta?: RuleMeta }
  | { kind: 'regex'; pattern: string; flags?: string; field?: string; meta?: RuleMeta }
  | { kind: 'equals'; field: string; value: string | number | boolean | null; meta?: RuleMeta }
  | { kind: 'all'; rules: Rule[]; meta?: RuleMeta }
  | { kind: 'any'; rules: Rule[]; meta?: RuleMeta }
  | { kind: 'not'; rule: Rule; meta?: RuleMeta };

/**
 * Evaluation order: `require` (none match → reject), `reject` (any match → reject),
 * `accept` (any match → accept). Anything left goes to the decision model.
 */
export interface ListenerRules {
  require?: Rule[];
  reject?: Rule[];
  accept?: Rule[];
}

export interface RuleSet {
  version: 1;
  listeners: Record<string, ListenerRules>;
}

export type RuleVerdict = 'accept' | 'reject';
export type RuleStage = keyof ListenerRules;

export interface RuleOutcome {
  verdict: RuleVerdict;
  stage: RuleStage;
  ruleId: string;
}

type Subject = Pick<EddsEvent, 'name' | 'payload'>;

export class RuleContext {
  readonly event: Subject;
  #text: string | undefined;

  constructor(event: Subject, text?: string) {
    this.event = event;
    this.#text = text;
  }

  get text(): string {
    return (this.#text ??= eventText(this.event));
  }

  textOf(field: string | undefined): string {
    if (field === undefined) return this.text;
    return flatten(readField(this.event, field));
  }
}

const compiled = new WeakMap<Rule, RegExp>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexFor(rule: Extract<Rule, { kind: 'keywords' | 'regex' }>): RegExp {
  let re = compiled.get(rule);
  if (!re) {
    if (rule.kind === 'regex') {
      re = new RegExp(rule.pattern, rule.flags ?? 'iu');
    } else {
      const alternatives = rule.any.map((k) => escapeRegex(k.trim()).replace(/\s+/g, '\\s+'));
      re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
    }
    compiled.set(rule, re);
  }
  re.lastIndex = 0;
  return re;
}

export function matches(rule: Rule, ctx: RuleContext): boolean {
  switch (rule.kind) {
    case 'keywords':
    case 'regex':
      return regexFor(rule).test(ctx.textOf(rule.field));
    case 'equals':
      return readField(ctx.event, rule.field) === rule.value;
    case 'all':
      return rule.rules.every((r) => matches(r, ctx));
    case 'any':
      return rule.rules.some((r) => matches(r, ctx));
    case 'not':
      return !matches(rule.rule, ctx);
  }
}

export function ruleId(rule: Rule, stage: RuleStage, index: number): string {
  return rule.meta?.id ?? `${stage}[${index}]`;
}

export function evaluateRules(rules: ListenerRules | undefined, ctx: RuleContext): RuleOutcome | null {
  if (!rules) return null;
  if (rules.require?.length) {
    const ok = rules.require.every((r) => matches(r, ctx));
    if (!ok) {
      const index = rules.require.findIndex((r) => !matches(r, ctx));
      return { verdict: 'reject', stage: 'require', ruleId: ruleId(rules.require[index]!, 'require', index) };
    }
  }
  for (const stage of ['reject', 'accept'] as const) {
    const list = rules[stage] ?? [];
    const index = list.findIndex((r) => matches(r, ctx));
    if (index >= 0) return { verdict: stage, stage, ruleId: ruleId(list[index]!, stage, index) };
  }
  return null;
}

export function mergeRules(...sets: (ListenerRules | undefined)[]): ListenerRules | undefined {
  const present = sets.filter((s): s is ListenerRules => s !== undefined);
  if (present.length === 0) return undefined;
  return {
    require: present.flatMap((s) => s.require ?? []),
    reject: present.flatMap((s) => s.reject ?? []),
    accept: present.flatMap((s) => s.accept ?? []),
  };
}

const KINDS = new Set(['keywords', 'regex', 'equals', 'all', 'any', 'not']);

function assertRule(rule: unknown, where: string): asserts rule is Rule {
  const r = rule as Record<string, unknown>;
  if (!r || typeof r !== 'object' || !KINDS.has(r.kind as string)) {
    throw new Error(`${where}: unknown rule kind ${JSON.stringify(r?.kind)}`);
  }
  if (r.kind === 'keywords' && !(Array.isArray(r.any) && r.any.length && r.any.every((k) => typeof k === 'string'))) {
    throw new Error(`${where}: keywords rule needs a non-empty "any" string array`);
  }
  if (r.kind === 'regex') {
    if (typeof r.pattern !== 'string') throw new Error(`${where}: regex rule needs "pattern"`);
    new RegExp(r.pattern, (r.flags as string | undefined) ?? 'iu');
  }
  if (r.kind === 'equals' && typeof r.field !== 'string') throw new Error(`${where}: equals rule needs "field"`);
  if (r.kind === 'all' || r.kind === 'any') {
    if (!Array.isArray(r.rules)) throw new Error(`${where}: ${r.kind} rule needs "rules"`);
    r.rules.forEach((child, i) => assertRule(child, `${where}.rules[${i}]`));
  }
  if (r.kind === 'not') assertRule(r.rule, `${where}.rule`);
}

/** Validates parsed JSON (for example a rules file) and returns it typed. */
export function parseRuleSet(json: unknown): RuleSet {
  const set = json as RuleSet;
  if (!set || set.version !== 1 || typeof set.listeners !== 'object') {
    throw new Error('rule set must look like { "version": 1, "listeners": { ... } }');
  }
  for (const [listenerId, rules] of Object.entries(set.listeners)) {
    for (const stage of ['require', 'reject', 'accept'] as const) {
      rules[stage]?.forEach((rule, i) => assertRule(rule, `${listenerId}.${stage}[${i}]`));
    }
  }
  return set;
}
