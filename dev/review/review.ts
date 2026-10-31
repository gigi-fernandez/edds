import { ABUSE_GUARD_ID } from '../../src/edds.ts';
import type { Rule, RuleSet, RuleVerdict } from '../../src/rules/rules.ts';
import type { TraceEntry } from '../../src/trace.ts';
import {
  collectExamples,
  isEvidence,
  mineCandidates,
  passes,
  ruleHash,
  scoreRule,
  stamp,
  swallowsLegitimate,
  wilsonLowerBound,
  validationSet,
  verdictsFor,
  type Candidate,
  type DistillOptions,
} from './distill.ts';
import { judgeCandidates } from './judge.ts';
import { proposeWithLlm, type LlmOptions } from './llm.ts';
import type { DecisionModel } from '../../src/models/decision-model.ts';

export interface RuleCheck {
  listenerId: string;
  ruleId: string;
  /** shadow: logged but not enforced. audit: enforced, sampled back to the model. */
  mode: 'shadow' | 'audit';
  verdict: RuleVerdict;
  matched: number;
  agreed: number;
  contradicted: number;
  precisionLB: number;
  recallLoss: number;
  passes: boolean;
}

export interface ListenerStats {
  listenerId: string;
  description: string;
  modelCalls: number;
  /** Share of model answers between the low and high cut-offs. */
  ambiguous: number;
  /** Share of model answers at or above the high cut-off. */
  confidentYes: number;
}

export interface ReviewResult {
  proposals: Candidate[];
  /** Candidates that passed the trace checks but the judge model rejected. */
  dropped: Candidate[];
  checks: RuleCheck[];
  stats: ListenerStats[];
  warnings: string[];
}

export interface ReviewOptions {
  distill: DistillOptions;
  llm?: LlmOptions;
  /** Decision model that vets each candidate for being a real signal, not a coincidence. */
  judge?: DecisionModel;
  /** Rule ids already enforced or in shadow; these are not proposed again. */
  knownRuleIds?: Set<string>;
}

/** Compares shadow and audited rules with the model answers logged next to them. */
export function checkTracedRules(entries: TraceEntry[], opts: DistillOptions): RuleCheck[] {
  const positives = new Map<string, number>();
  const negatives = new Map<string, number>();
  for (const [id, group] of collectExamples(entries)) {
    positives.set(id, group.examples.filter((e) => e.probability >= opts.high).length);
    negatives.set(id, group.examples.filter((e) => e.probability <= opts.low).length);
  }

  const checks = new Map<string, RuleCheck>();
  const seen = new Set<string>();
  const add = (listenerId: string, ruleId: string, mode: RuleCheck['mode'], verdict: RuleVerdict, p: number, text: string) => {
    const key = `${listenerId}\u0000${ruleId}\u0000${mode}`;
    // Like collectExamples: a repeated text is one piece of evidence.
    if (seen.has(`${key}\u0000${text}`)) return;
    seen.add(`${key}\u0000${text}`);
    let c = checks.get(key);
    if (!c) {
      c = { listenerId, ruleId, mode, verdict, matched: 0, agreed: 0, contradicted: 0, precisionLB: 0, recallLoss: 0, passes: false };
      checks.set(key, c);
    }
    c.matched++;
    if (verdict === 'accept' ? p >= opts.high : p <= opts.low) c.agreed++;
    if (verdict === 'accept' ? p <= opts.low : p >= opts.high) c.contradicted++;
  };

  for (const entry of entries) {
    for (const d of entry.decisions) {
      if (!isEvidence(entry, d.listenerId)) continue;
      if (d.shadow && d.source === 'model' && d.probability !== null) {
        add(d.listenerId, d.shadow.ruleId, 'shadow', d.shadow.verdict, d.probability, entry.text);
      }
      if (d.source === 'rule' && d.ruleId && d.audit !== undefined) {
        add(d.listenerId, d.ruleId, 'audit', d.probability === 1 ? 'accept' : 'reject', d.audit, entry.text);
      }
    }
  }

  return [...checks.values()].map((c) => {
    c.precisionLB = wilsonLowerBound(c.agreed, c.matched);
    const pos = positives.get(c.listenerId) ?? 0;
    c.recallLoss = c.verdict === 'reject' && pos > 0 ? c.contradicted / pos : 0;
    c.passes =
      c.matched >= opts.minSupport &&
      c.precisionLB >= opts.minPrecision &&
      (c.verdict === 'accept' || c.recallLoss <= opts.maxRecallLoss) &&
      !(c.listenerId === ABUSE_GUARD_ID && swallowsLegitimate(c.contradicted, negatives.get(c.listenerId) ?? 0, opts));
    return c;
  });
}

export type CheckStatus = 'ready to promote' | 'holding' | 'needs more data' | 'drifting' | 'failed';

/** Not enough evidence yet is different from evidence against the rule. */
export function checkStatus(c: RuleCheck, opts: DistillOptions): CheckStatus {
  if (c.passes) return c.mode === 'shadow' ? 'ready to promote' : 'holding';
  const noEvidenceAgainst = c.contradicted === 0;
  if (c.matched < opts.minSupport || noEvidenceAgainst) return 'needs more data';
  return c.mode === 'audit' ? 'drifting' : 'failed';
}

export async function runReview(entries: TraceEntry[], opts: ReviewOptions): Promise<ReviewResult> {
  const { distill } = opts;
  const known = opts.knownRuleIds ?? new Set<string>();
  const proposals: Candidate[] = [];
  const dropped: Candidate[] = [];
  const stats: ListenerStats[] = [];
  const warnings: string[] = [];

  for (const group of collectExamples(entries).values()) {
    const n = group.examples.length;
    stats.push({
      listenerId: group.listenerId,
      description: group.description,
      modelCalls: n,
      ambiguous: n ? group.examples.filter((e) => e.probability > distill.low && e.probability < distill.high).length / n : 0,
      confidentYes: n ? group.examples.filter((e) => e.probability >= distill.high).length / n : 0,
    });

    const candidates = mineCandidates(group, distill);

    if (opts.llm) {
      try {
        for (const p of await proposeWithLlm(group, distill, opts.llm)) {
          if (!verdictsFor(group.listenerId).includes(p.verdict)) continue;
          const rule: Rule = { kind: 'regex', pattern: p.pattern, flags: 'iu' };
          const validation = validationSet(group);
          const score = scoreRule(rule, p.verdict, validation, distill);
          if (passes(score, p.verdict, validation, distill, group.listenerId)) {
            candidates.push({ listenerId: group.listenerId, verdict: p.verdict, rule, origin: 'llm', why: p.why, ...score });
          }
        }
      } catch (err) {
        warnings.push(`${group.listenerId}: LLM proposals skipped (${(err as Error).message})`);
      }
    }

    const fresh = candidates.filter((c) => !known.has(ruleHash(c.verdict, c.rule)));
    if (opts.judge && fresh.length) {
      try {
        const judged = await judgeCandidates(fresh, new Map([[group.listenerId, group.description]]), opts.judge);
        proposals.push(...judged.kept);
        dropped.push(...judged.dropped);
      } catch (err) {
        warnings.push(`${group.listenerId}: judge failed, nothing proposed for this listener (${(err as Error).message})`);
      }
    } else {
      proposals.push(...fresh);
    }
  }

  return { proposals, dropped, checks: checkTracedRules(entries, distill), stats, warnings };
}

export function toRuleSet(candidates: Candidate[]): RuleSet {
  const set: RuleSet = { version: 1, listeners: {} };
  for (const c of candidates) {
    const rules = (set.listeners[c.listenerId] ??= {});
    (rules[c.verdict] ??= []).push(stamp(c));
  }
  return set;
}

export function ruleIds(set: RuleSet | undefined): Set<string> {
  const ids = new Set<string>();
  for (const rules of Object.values(set?.listeners ?? {})) {
    for (const list of [rules.require, rules.reject, rules.accept]) {
      for (const r of list ?? []) if (r.meta?.id) ids.add(r.meta.id);
    }
  }
  return ids;
}

/** Moves shadow rules that passed their checks into the enforced set. */
export function promote(shadow: RuleSet, enforced: RuleSet, checks: RuleCheck[]): { shadow: RuleSet; enforced: RuleSet; promoted: string[] } {
  const ok = new Set(checks.filter((c) => c.mode === 'shadow' && c.passes).map((c) => `${c.listenerId}\u0000${c.ruleId}`));
  const next: RuleSet = structuredClone(enforced);
  const rest: RuleSet = { version: 1, listeners: {} };
  const promoted: string[] = [];
  for (const [listenerId, rules] of Object.entries(shadow.listeners)) {
    for (const stage of ['require', 'reject', 'accept'] as const) {
      (rules[stage] ?? []).forEach((rule, i) => {
        const id = rule.meta?.id ?? `${stage}[${i}]`;
        const allowed = stage === 'accept' || verdictsFor(listenerId).includes('reject');
        const target = allowed && ok.has(`${listenerId}\u0000${id}`) ? next : rest;
        ((target.listeners[listenerId] ??= {})[stage] ??= []).push(rule);
        if (target === next) promoted.push(`${listenerId}/${id}`);
      });
    }
  }
  return { shadow: rest, enforced: next, promoted };
}
