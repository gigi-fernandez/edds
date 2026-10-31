import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecisionModelError, OpenRouterDecisionModel } from '../src/index.ts';

function fakeFetch(handler: (url: string, body: any) => { status: number; json: unknown }) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const { status, json } = handler(url, body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { impl, calls };
}

test('builds a Decisions API request with noul questions and image assets', async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    json: { answers: { q0: { type: 'noul', noul: 0.83 } }, usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 } },
  }));
  const model = new OpenRouterDecisionModel({ model: 'typesafe/jev-1.14', apiKey: 'k', fetch: impl });

  const res = await model.decide({
    state: { payload: { text: 'hello' } },
    questions: { q0: { instructions: 'Is it a greeting?', criteria: { true: 'yes', false: 'no' } } },
    images: [{ format: 'png', data: 'iVBORw0KGgo=' }],
  });

  assert.equal(res.probabilities.q0, 0.83);
  assert.deepEqual(res.usage, { inputTokens: 120, costUsd: 0.000005 });
  const { url, body } = calls[0]!;
  assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(body.model, 'typesafe/jev-1.14');
  assert.equal(body.questions.q0.type, 'noul');
  assert.deepEqual(body.state.images, ['image_0']);
  assert.deepEqual(body.assets.image_0, { type: 'image', format: 'png', data_base64: 'iVBORw0KGgo=' });
});

test('omits assets for text-only events', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, json: { answers: { q0: { noul: 0.1 } }, usage: {} } }));
  const model = new OpenRouterDecisionModel({ model: 'm', apiKey: 'k', fetch: impl });
  await model.decide({ state: { payload: 'x' }, questions: { q0: { instructions: 'i', criteria: { true: 't', false: 'f' } } } });
  assert.equal(calls[0]!.body.assets, undefined);
  assert.equal(calls[0]!.body.state.images, undefined);
});

test('retries 429 then surfaces API errors', async () => {
  let n = 0;
  const { impl } = fakeFetch(() => (++n === 1 ? { status: 429, json: {} } : { status: 400, json: { error: { code: 400, message: 'bad question' } } }));
  const model = new OpenRouterDecisionModel({ model: 'm', apiKey: 'k', fetch: impl });
  await assert.rejects(
    model.decide({ state: {}, questions: { q0: { instructions: 'i', criteria: { true: 't', false: 'f' } } } }),
    (err: any) => err instanceof DecisionModelError && err.status === 400 && /bad question/.test(err.message),
  );
  assert.equal(n, 2);
});

test('looks up image support from the decision model list', async () => {
  const { impl } = fakeFetch((url) => {
    assert.match(url, /output_modalities=decisions/);
    return {
      status: 200,
      json: { data: [
        { id: 'openai/gpt-6-luna-decisions', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'microsoft/microsoft-decision-1', architecture: { input_modalities: ['text'] } },
      ] },
    };
  });
  const opts = { apiKey: 'k', fetch: impl, baseUrl: 'https://test.local' };
  assert.equal(await new OpenRouterDecisionModel({ model: 'openai/gpt-6-luna-decisions', ...opts }).supportsImages(), true);
  assert.equal(await new OpenRouterDecisionModel({ model: 'microsoft/microsoft-decision-1', ...opts }).supportsImages(), false);
  assert.equal(await new OpenRouterDecisionModel({ model: 'unknown/x', ...opts }).supportsImages(), false);
  assert.equal(await new OpenRouterDecisionModel({ model: 'unknown/x', images: true, ...opts }).supportsImages(), true);
});

test('missing API key is a clear error', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const model = new OpenRouterDecisionModel({ model: 'm' });
    await assert.rejects(model.decide({ state: {}, questions: {} }), /OPENROUTER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});
