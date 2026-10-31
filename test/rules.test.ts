import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRules, matches, parseRuleSet, RuleContext, type Rule } from '../src/index.ts';

const ctx = new RuleContext({ name: 'email.received', payload: { subject: 'Refund for order #42', from: 'ana@example.com', vip: true } });

test('keywords match whole words, case-insensitively', () => {
  assert.equal(matches({ kind: 'keywords', any: ['REFUND'] }, ctx), true);
  assert.equal(matches({ kind: 'keywords', any: ['fund'] }, ctx), false);
  assert.equal(matches({ kind: 'keywords', any: ['for  order'] }, ctx), true);
});

test('field rules read dot paths on the event', () => {
  assert.equal(matches({ kind: 'keywords', any: ['refund'], field: 'payload.from' }, ctx), false);
  assert.equal(matches({ kind: 'equals', field: 'payload.vip', value: true }, ctx), true);
  assert.equal(matches({ kind: 'equals', field: 'name', value: 'email.received' }, ctx), true);
  assert.equal(matches({ kind: 'regex', pattern: '#\\d+', field: 'payload.subject' }, ctx), true);
});

test('all / any / not compose', () => {
  const refund: Rule = { kind: 'keywords', any: ['refund'] };
  const vip: Rule = { kind: 'equals', field: 'payload.vip', value: false };
  assert.equal(matches({ kind: 'all', rules: [refund, vip] }, ctx), false);
  assert.equal(matches({ kind: 'any', rules: [refund, vip] }, ctx), true);
  assert.equal(matches({ kind: 'not', rule: vip }, ctx), true);
});

test('require, then reject, then accept', () => {
  const refund: Rule = { kind: 'keywords', any: ['refund'], meta: { id: 'refund' } };
  const spam: Rule = { kind: 'keywords', any: ['unsubscribe'] };
  assert.deepEqual(evaluateRules({ accept: [refund] }, ctx), { verdict: 'accept', stage: 'accept', ruleId: 'refund' });
  assert.deepEqual(evaluateRules({ require: [spam], accept: [refund] }, ctx), { verdict: 'reject', stage: 'require', ruleId: 'require[0]' });
  assert.deepEqual(evaluateRules({ reject: [refund], accept: [refund] }, ctx), { verdict: 'reject', stage: 'reject', ruleId: 'refund' });
  assert.equal(evaluateRules({ accept: [spam] }, ctx), null);
});

test('parseRuleSet rejects malformed rules', () => {
  assert.throws(() => parseRuleSet({ version: 2, listeners: {} }));
  assert.throws(() => parseRuleSet({ version: 1, listeners: { a: { accept: [{ kind: 'nope' }] } } }), /unknown rule kind/);
  assert.throws(() => parseRuleSet({ version: 1, listeners: { a: { accept: [{ kind: 'regex', pattern: '(' }] } } }));
  assert.ok(parseRuleSet({ version: 1, listeners: { a: { accept: [{ kind: 'keywords', any: ['x'] }] } } }));
});
