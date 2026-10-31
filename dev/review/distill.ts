import { createHash } from 'node:crypto';
import { ABUSE_GUARD_ID } from '../../src/edds.ts';
import { FILLER_WORDS } from '../../src/preprocess/filler.ts';
import { matches, RuleContext, type Rule, type RuleVerdict } from '../../src/rules/rules.ts';
import type { TraceEntry } from '../../src/trace.ts';

export interface Example {
  eventId: string;
  text: string;
  /** The model's probability for this listener. */
  probability: number;
}

export interface ListenerExamples {
  listenerId: string;
  description: string;
  /** Events the model scored. */
  examples: Example[];
  /** Events an enforced rule decided without the model (probability 1 or 0). */
  ruleDecided: Example[];
}

export interface DistillOptions {
  /** Model probability at or above this counts as a confident yes. */
  high: number;
  /** Model probability at or below this counts as a confident no. */
  low: number;
  /** Matched events a rule needs before it can be proposed. */
  minSupport: number;
  /** Required 95% lower bound of agreement with the model. */
  minPrecision: number;
  /** Largest share of confident yeses a reject rule may swallow. */
  maxRecallLoss: number;
  maxRulesPerListener: number;
}

export const DEFAULTS: DistillOptions = {
  high: 0.9,
  low: 0.1,
  minSupport: 20,
  minPrecision: 0.9,
  maxRecallLoss: 0.02,
  maxRulesPerListener: 5,
};

export interface RuleScore {
  /** Traced events the rule matched. */
  matched: number;
  /** Matched events where the model confidently agreed with the rule. */
  agreed: number;
  /** Matched events where the model confidently said the opposite. */
  contradicted: number;
  precisionLB: number;
  /** Reject rules only: share of the model's confident yeses this rule would block. */
  recallLoss: number;
  /** Share of this listener's model calls the rule would replace. */
  coverage: number;
}

export interface Candidate extends RuleScore {
  listenerId: string;
  verdict: RuleVerdict;
  rule: Rule;
  origin: 'mined' | 'llm';
  why?: string;
}

/** Whether a traced event counts as evidence for a listener. */
export function isEvidence(entry: TraceEntry, listenerId: string): boolean {
  return listenerId === ABUSE_GUARD_ID || !(entry.blocked || entry.flagged);
}

/**
 * Model-scored examples per listener. Audited rule decisions count, since the
 * model answered them. Identical texts collapse into one example (with the mean
 * probability) so repeated events cannot inflate a rule's support.
 *
 * Events an enforced rule decided without the model land in `ruleDecided`
 * (probability 1 or 0). They are never mined, since that would learn rules from
 * rules, but candidates are checked against them: otherwise a new reject rule
 * could silently block events an existing accept rule handles.
 *
 * Events the abuse guard blocked or flagged only teach the guard itself.
 * Otherwise an attacker could flood the trace with crafted events until the
 * miner turns their wording into an accept rule for some other listener.
 */
export function collectExamples(entries: TraceEntry[]): Map<string, ListenerExamples> {
  const out = new Map<string, ListenerExamples>();
  const seen = new Map<string, { example: Example; sum: number; n: number }>();
  const add = (list: 'examples' | 'ruleDecided', listenerId: string, description: string, entry: TraceEntry, probability: number) => {
    let group = out.get(listenerId);
    if (!group) out.set(listenerId, (group = { listenerId, description, examples: [], ruleDecided: [] }));
    group.description = description;
    const key = `${list}\u0000${listenerId}\u0000${entry.text}`;
    const prior = seen.get(key);
    if (prior) {
      prior.sum += probability;
      prior.n++;
      prior.example.probability = prior.sum / prior.n;
      return;
    }
    const example = { eventId: entry.eventId, text: entry.text, probability };
    seen.set(key, { example, sum: probability, n: 1 });
    group[list].push(example);
  };

  for (const entry of entries) {
    for (const d of entry.decisions) {
      if (!isEvidence(entry, d.listenerId)) continue;
      const modelP = d.source === 'model' ? d.probability : d.audit;
      if (modelP !== null && modelP !== undefined) add('examples', d.listenerId, d.description, entry, modelP);
      else if (d.source === 'rule' && d.probability !== null) add('ruleDecided', d.listenerId, d.description, entry, d.probability);
    }
  }
  return out;
}

/** Everything a candidate must hold up against: model answers plus enforced rule decisions. */
export function validationSet(group: ListenerExamples): Example[] {
  return [...group.examples, ...group.ruleDecided];
}

/** Wilson score lower bound: a cautious estimate of a success rate from k of n. */
export function wilsonLowerBound(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export function scoreRule(rule: Rule, verdict: RuleVerdict, examples: Example[], opts: DistillOptions): RuleScore {
  let matched = 0;
  let agreed = 0;
  let contradicted = 0;
  let positives = 0;
  for (const ex of examples) {
    const yes = ex.probability >= opts.high;
    const no = ex.probability <= opts.low;
    if (yes) positives++;
    if (!matches(rule, new RuleContext({ payload: undefined }, ex.text))) continue;
    matched++;
    if (verdict === 'accept' ? yes : no) agreed++;
    if (verdict === 'accept' ? no : yes) contradicted++;
  }
  return {
    matched,
    agreed,
    contradicted,
    precisionLB: wilsonLowerBound(agreed, matched),
    recallLoss: verdict === 'reject' && positives > 0 ? contradicted / positives : 0,
    coverage: examples.length ? matched / examples.length : 0,
  };
}

/**
 * An abuse rule blocks every event it matches, and attackers can outvote
 * legitimate events with enough distinct texts, so precision alone cannot
 * clear it: it also gets a cap on the confident noes it would swallow.
 */
export function swallowsLegitimate(contradicted: number, negatives: number, opts: DistillOptions): boolean {
  return negatives > 0 && contradicted / negatives > opts.maxRecallLoss;
}

export function passes(score: RuleScore, verdict: RuleVerdict, examples: Example[], opts: DistillOptions, listenerId?: string): boolean {
  if (score.matched < opts.minSupport || score.precisionLB < opts.minPrecision) return false;
  if (listenerId === ABUSE_GUARD_ID) {
    const negatives = examples.filter((e) => e.probability <= opts.low).length;
    if (swallowsLegitimate(score.contradicted, negatives, opts)) return false;
  }
  if (verdict === 'reject') {
    // Without enough confident yeses, there is no evidence a reject rule is safe.
    const positives = examples.filter((e) => e.probability >= opts.high).length;
    if (positives < 5 || score.recallLoss > opts.maxRecallLoss) return false;
  }
  return true;
}

/**
 * Frequent words that are too generic to stand alone as a rule, even when they
 * happen to line up with the model in a trace. Wider than the filler lists,
 * which only drop words the model never needs.
 */
export const COMMON_WORDS: Record<string, readonly string[]> = {
  en: [
    'about', 'again', 'all', 'also', 'and', 'any', 'are', 'ask', 'asked', 'back', 'been', 'but', 'can', 'come', 'could', 'day', 'did', 'does', 'done',
    'each', 'every', 'for', 'from', 'get', 'give', 'going', 'good', 'had', 'has', 'have', 'her', 'here', 'him', 'his', 'how', 'into', 'its', 'just',
    'know', 'last', 'let', 'like', 'look', 'made', 'make', 'may', 'might', 'more', 'most', 'must', 'need', 'new', 'next', 'now', 'one', 'only', 'other',
    'our', 'out', 'over', 'own', 'please', 'said', 'same', 'say', 'see', 'send', 'she', 'should', 'some', 'still', 'such', 'take', 'tell', 'than',
    'thank', 'thanks', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this', 'those', 'time', 'too', 'two', 'use',
    'very', 'want', 'was', 'way', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  ],
  es: [
    'aquí', 'como', 'cómo', 'con', 'cuando', 'cuándo', 'del', 'desde', 'donde', 'dónde', 'era', 'esa', 'ese', 'eso', 'esta', 'está', 'están', 'este',
    'esto', 'fue', 'gracias', 'hace', 'hacer', 'hasta', 'hay', 'les', 'más', 'mis', 'muy', 'nos', 'para', 'pero', 'por', 'puede', 'pueden', 'puedo',
    'podéis', 'que', 'qué', 'quiere', 'quiero', 'ser', 'sin', 'sobre', 'son', 'sus', 'también', 'tengo', 'tiene', 'tienen', 'tus', 'voy',
  ],
};

const SKIP = new Set([...Object.values(FILLER_WORDS).flat(), ...Object.values(COMMON_WORDS).flat()]);
const TOKEN = /\p{L}[\p{L}\p{N}'’-]*/gu;

/** Unigrams and bigrams, skipping filler, common and very short words. */
export function terms(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(TOKEN) ?? []).filter((t) => t.length >= 3 && !SKIP.has(t));
  const out = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function ruleHash(verdict: RuleVerdict, rule: Rule): string {
  const { meta: _meta, ...body } = rule;
  return 'rv-' + createHash('sha256').update(verdict + JSON.stringify(body)).digest('hex').slice(0, 10);
}

/**
 * Finds words and word pairs that the model's confident answers already
 * follow, keeping the ones that hold up on every traced event.
 */
export function mineCandidates(group: ListenerExamples, opts: DistillOptions): Candidate[] {
  const out: Candidate[] = [];
  const termsByEvent = new Map(group.examples.map((ex) => [ex, terms(ex.text)]));
  const validation = validationSet(group);

  for (const verdict of verdictsFor(group.listenerId)) {
    const target = group.examples.filter((ex) => (verdict === 'accept' ? ex.probability >= opts.high : ex.probability <= opts.low));
    const df = new Map<string, number>();
    for (const ex of target) for (const t of termsByEvent.get(ex)!) df.set(t, (df.get(t) ?? 0) + 1);

    const scored: Candidate[] = [];
    for (const [term, count] of df) {
      if (count < opts.minSupport) continue;
      const rule: Rule = { kind: 'keywords', any: [term] };
      const score = scoreRule(rule, verdict, validation, opts);
      if (passes(score, verdict, validation, opts, group.listenerId)) {
        scored.push({ listenerId: group.listenerId, verdict, rule, origin: 'mined', ...score });
      }
    }

    // Greedy cover: each extra rule must explain events the earlier ones did not.
    scored.sort((a, b) => b.agreed - a.agreed || b.precisionLB - a.precisionLB);
    const covered = new Set<Example>();
    let kept = 0;
    for (const c of scored) {
      if (kept >= opts.maxRulesPerListener) break;
      const fresh = target.filter((ex) => !covered.has(ex) && matches(c.rule, new RuleContext({ payload: undefined }, ex.text)));
      if (fresh.length < Math.ceil(opts.minSupport / 2)) continue;
      fresh.forEach((ex) => covered.add(ex));
      out.push(c);
      kept++;
    }
  }
  return out;
}

/** The abuse check can be made stricter by rules, never skipped, so it gets no reject rules. */
export function verdictsFor(listenerId: string): readonly RuleVerdict[] {
  return listenerId === ABUSE_GUARD_ID ? ['accept'] : ['accept', 'reject'];
}

export function stamp(c: Candidate): Rule {
  return {
    ...c.rule,
    meta: {
      id: ruleHash(c.verdict, c.rule),
      source: 'review-agent',
      note: [`${c.origin}: agreed with the model on ${c.agreed}/${c.matched} traced events`, c.why].filter(Boolean).join('; '),
      precision: Number(c.precisionLB.toFixed(4)),
      support: c.matched,
      createdAt: new Date().toISOString(),
    },
  };
}
