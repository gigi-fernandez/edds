import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FillerPruner } from '../src/index.ts';

const pruner = new FillerPruner({ languages: ['en', 'es'] });

test('detects the configured language', () => {
  assert.equal(pruner.detect('The package is not here and my order was late'), 'en');
  assert.equal(pruner.detect('El paquete no está y mi pedido llegó tarde para la fiesta'), 'es');
  assert.equal(pruner.detect('12345'), undefined);
});

test('prunes English filler but keeps negations and meaning words', () => {
  const r = pruner.prune('Hi, um, basically the refund did not arrive');
  assert.equal(r.text, 'refund did not arrive');
  assert.equal(r.language, 'en');
  assert.equal(r.removed, 4);
});

test('prunes Spanish filler with Spanish lists only', () => {
  const r = pruner.prune('Hola, pues el reembolso no ha llegado a la cuenta');
  assert.equal(r.language, 'es');
  // "a" is a Spanish preposition and stays; "la" and "el" go.
  assert.equal(r.text, 'reembolso no ha llegado a cuenta');
});

test('custom keep list and extra words', () => {
  const custom = new FillerPruner({ languages: ['en'], extra: { en: ['kindly', 'not'] }, keep: ['the'] });
  assert.equal(custom.prune('kindly check the box, not later', 'en').text, 'check the box, not later');
});

test('unknown language without a custom list is an error', () => {
  assert.throws(() => new FillerPruner({ languages: ['xx'] }), /no filler list/);
  assert.ok(new FillerPruner({ languages: ['xx'], extra: { xx: ['foo'] } }));
});
