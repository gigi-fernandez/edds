import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectExamples, DEFAULTS, mineCandidates, passes, ruleHash, scoreRule, wilsonLowerBound, type Candidate, type ListenerExamples } from '../dev/review/distill.ts';
import { judgeCandidates } from '../dev/review/judge.ts';
import { parseProposals } from '../dev/review/llm.ts';
import { checkTracedRules, promote, runReview, toRuleSet } from '../dev/review/review.ts';
import { ABUSE_GUARD_ID, Edds, MemoryTraceSink, parseRuleSet, type TraceEntry } from '../src/index.ts';
import { FakeModel } from './helpers.ts';

const opts = { ...DEFAULTS, minSupport: 10 };

const YES = ['I want a refund please', 'where is my refund', 'refund still missing after a week', 'can you refund my card', 'requesting a refund now'];
const NO = ['how do I change my password', 'the app crashes on login', 'what are your opening hours', 'my invoice shows the wrong address', 'love the new update'];

/** 40 refund emails the model says yes to, 60 other emails it says no to. */
function syntheticTrace(): ListenerExamples {
  const examples = [];
  for (let i = 0; i < 40; i++) examples.push({ eventId: `y${i}`, text: `subject: ticket ${i}\nbody: ${YES[i % YES.length]}`, probability: 0.97 });
  for (let i = 0; i < 60; i++) examples.push({ eventId: `n${i}`, text: `subject: ticket ${i}\nbody: ${NO[i % NO.length]}`, probability: 0.02 });
  return { listenerId: 'refunds', description: 'Customer wants a refund', examples, ruleDecided: [] };
}

test('wilson lower bound is cautious with small samples', () => {
  assert.ok(wilsonLowerBound(10, 10) < 0.75);
  assert.ok(wilsonLowerBound(100, 100) > 0.96);
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('mines an accept rule the model already follows', () => {
  const candidates = mineCandidates(syntheticTrace(), opts);
  const accept = candidates.filter((c) => c.verdict === 'accept');
  assert.ok(accept.length >= 1);
  assert.deepEqual(accept[0]!.rule, { kind: 'keywords', any: ['refund'] });
  assert.equal(accept[0]!.agreed, 40);
  assert.equal(accept[0]!.contradicted, 0);
});

test('does not propose rules the model contradicts', () => {
  const group = syntheticTrace();
  // Half of the password emails also mention a refund, and the model says no to them.
  group.examples.slice(40, 70).forEach((e) => (e.text += ' (not a refund question)'));
  const accept = mineCandidates(group, opts).filter((c) => c.verdict === 'accept');
  assert.ok(accept.every((c) => !(c.rule.kind === 'keywords' && c.rule.any[0] === 'refund')));
});

test('reject rules must not swallow confident yeses', () => {
  const group = syntheticTrace();
  // "order" appears in every no and in a third of the yeses: it must not become a reject rule.
  group.examples.slice(40).forEach((e) => (e.text += ' order status'));
  group.examples.slice(0, 13).forEach((e) => (e.text += ' order status'));
  const reject = mineCandidates(group, opts).filter((c) => c.verdict === 'reject');
  assert.ok(reject.every((c) => c.recallLoss <= opts.maxRecallLoss));
  assert.ok(!reject.some((c) => c.rule.kind === 'keywords' && c.rule.any[0] === 'order'));
});

test('proposals round-trip into a valid rule set with stable ids', () => {
  const candidates = mineCandidates(syntheticTrace(), opts);
  const set = parseRuleSet(JSON.parse(JSON.stringify(toRuleSet(candidates))));
  const rule = set.listeners.refunds!.accept![0]!;
  assert.equal(rule.meta?.id, ruleHash('accept', { kind: 'keywords', any: ['refund'] }));
  assert.equal(rule.meta?.source, 'review-agent');
});

test('end to end: trace → proposals → shadow → promote', async () => {
  const model = new FakeModel((state) => (state.includes('refund') ? 0.96 : 0.03));
  // 50 matches are needed: with 30, the 95% lower bound tops out near 0.89.
  const emails = Array.from({ length: 100 }, (_, i) =>
    i % 2 ? { subject: `Refund please #${i}`, body: 'The item broke, I want a refund.' } : { subject: `Login #${i}`, body: 'I cannot log in to my account.' },
  );

  // 1. Run with the model only and collect a trace.
  const first = new MemoryTraceSink();
  const edds = new Edds({ model, trace: first });
  edds.on({ id: 'refunds', description: 'Customer wants a refund', handler: () => {} });
  for (const payload of emails) await edds.emit({ name: 'email', payload });

  const review = await runReview(first.entries, { distill: opts });
  assert.ok(review.proposals.some((p) => p.verdict === 'accept'));
  const proposed = toRuleSet(review.proposals);

  // 2. Load proposals as shadow rules and collect a fresh trace.
  const second = new MemoryTraceSink();
  const shadowEdds = new Edds({ model, trace: second, shadowRules: proposed });
  shadowEdds.on({ id: 'refunds', description: 'Customer wants a refund', handler: () => {} });
  for (const payload of emails) await shadowEdds.emit({ name: 'email', payload });

  const checks = checkTracedRules(second.entries, opts);
  assert.ok(checks.length > 0);
  assert.ok(checks.every((c) => c.mode === 'shadow'));

  // 3. Promote what passed.
  const { enforced, shadow, promoted } = promote(proposed, { version: 1, listeners: {} }, checks);
  assert.ok(promoted.length > 0);
  assert.ok(enforced.listeners.refunds?.accept?.length);
  const leftover = Object.values(shadow.listeners).flatMap((r) => [...(r.accept ?? []), ...(r.reject ?? [])]);
  assert.equal(leftover.length + promoted.length, review.proposals.length);

  // 4. Promoted rules now skip the model.
  const enforcedEdds = new Edds({ model, rules: enforced });
  enforcedEdds.on({ id: 'refunds', description: 'Customer wants a refund', handler: () => {} });
  const r = await enforcedEdds.emit({ name: 'email', payload: emails[1] });
  assert.equal(r.decisions[0]!.source, 'rule');
  assert.deepEqual(model.listenerQuestions(model.requests.at(-1)), [], 'only the abuse guard was asked');
});

test('repeated identical events count once', () => {
  const entries: TraceEntry[] = Array.from({ length: 50 }, (_, i) => ({
    ts: '',
    eventId: `e${i}`,
    text: 'please refund me',
    decisions: [{ listenerId: 'refunds', description: 'd', probability: i % 2 ? 0.9 : 1, source: 'model' }],
    usage: { inputTokens: 0, costUsd: 0 },
  }));
  const group = collectExamples(entries).get('refunds')!;
  assert.equal(group.examples.length, 1);
  assert.ok(Math.abs(group.examples[0]!.probability - 0.95) < 1e-9);
  assert.equal(mineCandidates(group, opts).length, 0);
});

test('audited rules that drift from the model fail their check', () => {
  const entries: TraceEntry[] = Array.from({ length: 30 }, (_, i) => ({
    ts: '',
    eventId: `e${i}`,
    text: `refund ${i}`,
    decisions: [{ listenerId: 'refunds', description: 'd', probability: 1, source: 'rule', ruleId: 'r1', audit: 0.05 }],
    usage: { inputTokens: 0, costUsd: 0 },
  }));
  const [check] = checkTracedRules(entries, opts);
  assert.equal(check!.mode, 'audit');
  assert.equal(check!.passes, false);
  assert.equal(check!.contradicted, 30);
});

test('common words never become rules', () => {
  const group = syntheticTrace();
  // "want" now appears only in refund emails, so it lines up perfectly with the model.
  group.examples.slice(0, 40).forEach((e) => (e.text += ' I want this sorted'));
  const rules = mineCandidates(group, opts).map((c) => (c.rule.kind === 'keywords' ? c.rule.any[0] : ''));
  assert.ok(!rules.includes('want'));
  assert.ok(rules.includes('refund'));
});

test('the judge drops coincidental candidates', async () => {
  const judge = new FakeModel((_state, instructions) => (instructions.includes('"refund"') ? 0.9 : 0.1));
  const base = { listenerId: 'refunds', verdict: 'accept' as const, origin: 'mined' as const, matched: 40, agreed: 40, contradicted: 0, precisionLB: 0.91, recallLoss: 0, coverage: 0.4 };
  const { kept, dropped } = await judgeCandidates(
    [
      { ...base, rule: { kind: 'keywords', any: ['refund'] } },
      { ...base, rule: { kind: 'keywords', any: ['sorted'] } },
    ],
    new Map([['refunds', 'Customer wants a refund']]),
    judge,
  );
  assert.deepEqual(kept.map((c) => c.rule), [{ kind: 'keywords', any: ['refund'] }]);
  assert.deepEqual(dropped.map((c) => c.rule), [{ kind: 'keywords', any: ['sorted'] }]);
  assert.match(kept[0]!.why!, /judge 0\.90/);
  assert.equal(judge.requests.length, 1, 'all candidates judged in one request');
});

test('candidates are checked against events enforced rules decided', () => {
  const group: ListenerExamples = { listenerId: 'refunds', description: 'Customer wants a refund', examples: [], ruleDecided: [] };
  for (let i = 0; i < 40; i++) group.examples.push({ eventId: `y${i}`, text: `${YES[i % YES.length]} ${i}`, probability: 0.97 });
  for (let i = 0; i < 60; i++) group.examples.push({ eventId: `n${i}`, text: `password reset ${i}`, probability: 0.02 });
  const isPasswordReject = (c: Candidate) => c.verdict === 'reject' && c.rule.kind === 'keywords' && c.rule.any[0] === 'password';

  // From the model's answers alone, "password" looks like a perfect reject rule.
  assert.ok(mineCandidates(group, opts).some(isPasswordReject));

  // But an enforced accept rule already handles 30 "refund + password" emails the model never saw.
  for (let i = 0; i < 30; i++) group.ruleDecided.push({ eventId: `r${i}`, text: `refund, and password reset ${i}`, probability: 1 });
  assert.ok(!mineCandidates(group, opts).some(isPasswordReject));
});

test('the abuse guard never gets reject rules, and promote refuses them', () => {
  const group = syntheticTrace();
  group.listenerId = ABUSE_GUARD_ID;
  const candidates = mineCandidates(group, opts);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => c.verdict === 'accept'));

  const shadow = { version: 1 as const, listeners: { [ABUSE_GUARD_ID]: { reject: [{ kind: 'keywords' as const, any: ['hi'], meta: { id: 'x' } }] } } };
  const checks = [{ listenerId: ABUSE_GUARD_ID, ruleId: 'x', mode: 'shadow' as const, verdict: 'reject' as const, matched: 99, agreed: 99, contradicted: 0, precisionLB: 0.99, recallLoss: 0, passes: true }];
  const { promoted } = promote(shadow, { version: 1, listeners: {} }, checks);
  assert.deepEqual(promoted, []);
});

test('parses LLM proposals defensively', () => {
  const out = parseProposals('Sure! {"rules":[{"verdict":"accept","pattern":"\\\\brefund","why":"w"},{"verdict":"accept","pattern":"("},{"verdict":"maybe","pattern":"x"}]}');
  assert.deepEqual(out, [{ verdict: 'accept', pattern: '\\brefund', why: 'w' }]);
  assert.deepEqual(parseProposals('no json here'), []);
});

test('blocked and flagged events never teach rules to other listeners', () => {
  const entry = (i: number, extra: Partial<TraceEntry>): TraceEntry => ({
    ts: '',
    eventId: `e${i}`,
    text: `zebra refund ${i}`,
    decisions: [
      { listenerId: ABUSE_GUARD_ID, description: 'abuse', probability: 0.97, source: 'model' },
      { listenerId: 'refunds', description: 'd', probability: 0.99, source: 'model' },
    ],
    usage: { inputTokens: 0, costUsd: 0 },
    ...extra,
  });
  const entries = [...Array.from({ length: 30 }, (_, i) => entry(i, { blocked: true })), ...Array.from({ length: 30 }, (_, i) => entry(i + 30, { flagged: true }))];
  const groups = collectExamples(entries);
  assert.equal(groups.get('refunds'), undefined);
  assert.equal(groups.get(ABUSE_GUARD_ID)!.examples.length, 60);
});

test('blocked and flagged events never vouch for shadow or audited rules', () => {
  const decision = (i: number) =>
    i % 2
      ? { listenerId: 'refunds', description: 'd', probability: 0.99, source: 'model' as const, shadow: { ruleId: 's1', verdict: 'accept' as const } }
      : { listenerId: 'refunds', description: 'd', probability: 1, source: 'rule' as const, ruleId: 'r1', audit: 0.99 };
  const entries: TraceEntry[] = Array.from({ length: 60 }, (_, i) => ({
    ts: '',
    eventId: `e${i}`,
    text: `zebra refund ${i}`,
    blocked: i % 4 < 2 || undefined,
    flagged: i % 4 >= 2 || undefined,
    decisions: [decision(i)],
    usage: { inputTokens: 0, costUsd: 0 },
  }));
  assert.deepEqual(checkTracedRules(entries, opts), []);
});

test('an abuse rule that swallows legitimate events fails however many attacks it matches', () => {
  const example = (text: string, probability: number, i: number) => ({ eventId: `e${i}`, text, probability });
  const attacks = Array.from({ length: 2000 }, (_, i) => example(`refund attack ${i}`, 0.99, i));
  const legitimate = Array.from({ length: 100 }, (_, i) => example(`refund for order ${i}`, 0.01, i));
  const unrelated = Array.from({ length: 200 }, (_, i) => example(`shipping question ${i}`, 0.01, i));
  const examples = [...attacks, ...legitimate, ...unrelated];
  const score = scoreRule({ kind: 'keywords', any: ['refund'] }, 'accept', examples, opts);
  assert.ok(score.precisionLB >= opts.minPrecision);
  assert.equal(passes(score, 'accept', examples, opts, 'refunds'), true);
  assert.equal(passes(score, 'accept', examples, opts, ABUSE_GUARD_ID), false);
});

test('proposed regexes that can backtrack badly are dropped', () => {
  const reply = (pattern: string) => JSON.stringify({ rules: [{ verdict: 'accept', pattern, why: 'w' }] });
  for (const pattern of ['(a+)+$', '(a|b*)*x', '(\\w+\\s?){2,}$', '(a)\\1', '(?<x>a)\\k<x>', 'a'.repeat(201)]) {
    assert.deepEqual(parseProposals(reply(pattern)), [], pattern);
  }
  assert.equal(parseProposals(reply('\\brefunds?\\b')).length, 1);
  assert.equal(parseProposals(reply('(order|invoice) #\\d+')).length, 1);
});
