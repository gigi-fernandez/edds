import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Edds, MemoryTraceSink, type Decision, type EddsEvent } from '../src/index.ts';
import { FakeModel, keywordModel } from './helpers.ts';

const refundEmail: EddsEvent = { name: 'email', payload: { subject: 'Where is my refund?', body: 'Hi, the refund never arrived.' } };

test('fires listeners the model scores above their threshold', async () => {
  const model = keywordModel();
  const edds = new Edds({ model });
  const seen: string[] = [];
  edds.on({ id: 'refunds', description: 'Customer asks about a [refund]', handler: () => void seen.push('refunds') });
  edds.on({ id: 'legal', description: 'Customer threatens [lawsuit]', handler: () => void seen.push('legal') });

  const result = await edds.emit(refundEmail);

  assert.deepEqual(seen, ['refunds']);
  assert.deepEqual(result.fired, ['refunds']);
  assert.equal(result.decisions[0]!.source, 'model');
  assert.equal(model.requests.length, 1, 'both listeners and the abuse guard asked in one request');
  assert.equal(Object.keys(model.requests[0]!.questions).length, 3);
  assert.equal(model.listenerQuestions().length, 2);
  assert.equal(result.blocked, false);
  assert.equal(result.abuse.probability, 0.01);
});

test('per-listener thresholds', async () => {
  const edds = new Edds({ model: new FakeModel(() => 0.7), threshold: 0.5 });
  edds.on({ id: 'loose', description: 'x', handler: () => {} });
  edds.on({ id: 'strict', description: 'y', threshold: 0.9, handler: () => {} });
  const result = await edds.emit(refundEmail);
  assert.deepEqual(result.fired, ['loose']);
});

test('hard rules decide listeners; only the abuse guard is still asked', async () => {
  const model = keywordModel();
  const edds = new Edds({
    model,
    rules: { version: 1, listeners: { refunds: { accept: [{ kind: 'keywords', any: ['refund'], meta: { id: 'kw-refund' } }] } } },
  });
  let decision: Decision | undefined;
  edds.on({ id: 'refunds', description: 'Customer asks about a [refund]', handler: (_e, d) => void (decision = d) });

  await edds.emit(refundEmail);

  assert.equal(model.requests.length, 1);
  assert.deepEqual(model.listenerQuestions(), []);
  assert.equal(decision?.source, 'rule');
  assert.equal(decision?.ruleId, 'kw-refund');
});

test('listener rules and rule-set rules merge; require rejects early', async () => {
  const model = keywordModel();
  const edds = new Edds({ model });
  edds.on({
    id: 'refunds',
    description: 'Customer asks about a [refund]',
    rules: { require: [{ kind: 'equals', field: 'name', value: 'ticket' }] },
    handler: () => assert.fail('should not fire'),
  });
  const result = await edds.emit(refundEmail);
  assert.equal(result.decisions[0]!.source, 'rule');
  assert.equal(result.decisions[0]!.fired, false);
  assert.deepEqual(model.listenerQuestions(), []);
});

test('shadow rules are logged next to the model answer but never decide', async () => {
  const trace = new MemoryTraceSink();
  const edds = new Edds({
    model: keywordModel(),
    trace,
    shadowRules: { version: 1, listeners: { refunds: { reject: [{ kind: 'keywords', any: ['refund'], meta: { id: 'bad' } }] } } },
  });
  edds.on({ id: 'refunds', description: 'Customer asks about a [refund]', handler: () => {} });

  const result = await edds.emit(refundEmail);

  assert.deepEqual(result.fired, ['refunds']);
  const d = trace.entries[0]!.decisions.find((x) => x.listenerId === 'refunds')!;
  assert.equal(d.source, 'model');
  assert.deepEqual(d.shadow, { ruleId: 'bad', verdict: 'reject' });
});

test('audit sampling sends rule-decided listeners to the model without changing the decision', async () => {
  const trace = new MemoryTraceSink();
  const model = new FakeModel(() => 0.02);
  const edds = new Edds({
    model,
    trace,
    auditRate: 1,
    rules: { version: 1, listeners: { refunds: { accept: [{ kind: 'keywords', any: ['refund'], meta: { id: 'r1' } }] } } },
  });
  edds.on({ id: 'refunds', description: 'refunds', handler: () => {} });

  const result = await edds.emit(refundEmail);

  assert.deepEqual(result.fired, ['refunds']);
  assert.equal(model.requests.length, 1);
  const d = trace.entries[0]!.decisions.find((x) => x.listenerId === 'refunds')!;
  assert.equal(d.audit, 0.02);
  assert.equal(d.source, 'rule');
});

test('splits large listener sets into parallel requests', async () => {
  const model = new FakeModel(() => 0.9);
  const edds = new Edds({ model, maxQuestionsPerRequest: 4 });
  for (let i = 0; i < 10; i++) edds.on({ id: `l${i}`, description: `listener ${i}`, handler: () => {} });
  const result = await edds.emit(refundEmail);
  // 10 listeners + the abuse guard, which always goes first.
  assert.deepEqual(model.requests.map((r) => Object.keys(r.questions).length), [4, 4, 3]);
  assert.equal(result.fired.length, 10);
  assert.equal(result.usage.inputTokens, 300);
});

test('filler pruning changes what the model sees, not what rules see', async () => {
  const model = keywordModel();
  const trace = new MemoryTraceSink();
  const edds = new Edds({ model, trace, filler: { languages: ['en', 'es'] } });
  edds.on({ id: 'refunds', description: 'Customer asks about a [refund]', handler: () => {} });

  await edds.emit(refundEmail);

  const payload = model.requests[0]!.state.payload as { body: string };
  assert.equal(payload.body, 'refund never arrived.');
  assert.equal(trace.entries[0]!.language, 'en');
  assert.match(trace.entries[0]!.text, /Hi, the refund/);
});

test('images: dropped for text-only models, kept for image models, or an error', async () => {
  const withImage: EddsEvent = { ...refundEmail, images: [{ format: 'png', data: 'iVBORw0KGgo=' }] };
  const textOnly = keywordModel();
  const trace = new MemoryTraceSink();
  const edds = new Edds({ model: textOnly, trace });
  edds.on({ id: 'refunds', description: '[refund]', handler: () => {} });
  await edds.emit(withImage);
  assert.equal(textOnly.requests[0]!.images!.length, 0);
  assert.equal(trace.entries[0]!.imagesDropped, 1);

  const strict = new Edds({ model: keywordModel(), onUnsupportedImages: 'error' });
  strict.on({ id: 'refunds', description: '[refund]', handler: () => {} });
  await assert.rejects(strict.emit(withImage), /does not accept images/);
});

test('a model selector can route image events to an image-capable model', async () => {
  const text = keywordModel({ id: 'text' });
  const vision = keywordModel({ id: 'vision', images: true });
  const edds = new Edds({ model: (e) => (e.images?.length ? vision : text) });
  edds.on({ id: 'refunds', description: '[refund]', handler: () => {} });

  await edds.emit(refundEmail);
  await edds.emit({ ...refundEmail, images: [{ format: 'jpg', data: 'AAAA' }] });

  assert.equal(text.requests.length, 1);
  assert.equal(vision.requests.length, 1);
  assert.equal(vision.requests[0]!.images!.length, 1);
});

test('model and handler failures are reported, not thrown', async () => {
  const failing = new FakeModel(() => {
    throw new Error('boom');
  });
  const edds = new Edds({ model: failing });
  edds.on({ id: 'a', description: 'a', handler: () => {} });
  const r1 = await edds.emit(refundEmail);
  assert.equal(r1.decisions[0]!.source, 'error');
  assert.equal(r1.errors[0]!.kind, 'model');
  assert.equal(r1.blocked, true, 'a failed abuse check fails closed');

  const edds2 = new Edds({ model: new FakeModel(() => 1) });
  edds2.on({ id: 'a', description: 'a', handler: () => {
    throw new Error('handler broke');
  } });
  edds2.on({ id: 'b', description: 'b', handler: () => {} });
  const r2 = await edds2.emit(refundEmail);
  assert.deepEqual(r2.fired, ['a', 'b']);
  assert.equal(r2.errors[0]!.kind, 'handler');
  assert.equal(r2.errors[0]!.listenerId, 'a');
});

test('on() returns an unsubscribe function and rejects duplicate ids', () => {
  const edds = new Edds({ model: keywordModel() });
  const off = edds.on({ id: 'a', description: 'a', handler: () => {} });
  assert.throws(() => edds.on({ id: 'a', description: 'a', handler: () => {} }), /already registered/);
  off();
  assert.equal(edds.listeners.length, 0);
});
