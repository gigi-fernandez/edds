# EDDS: Event Driven Decision System

Listeners describe *when* they should fire in plain language. For each event, a decision model scores every listener in parallel and returns one probability per listener. Listeners above their threshold fire.

```ts
import { Edds, OpenRouterDecisionModel } from 'edds';
import { JsonlTraceSink } from 'edds/node';

const edds = new Edds({
  model: new OpenRouterDecisionModel({ model: 'typesafe/jev-1.14' }),
  filler: { languages: ['en', 'es'] },
  trace: new JsonlTraceSink('edds-trace.jsonl'),
});

edds.on({
  id: 'refunds',
  description: 'The customer asks for a refund or their money back',
  handler: (event, decision) => openRefundTicket(event.payload, decision.probability),
});

await edds.emit({ name: 'support.email', payload: { subject, body } });
```

## Pipeline

For each `emit(event)`:

1. **Hard rules** (`require` → `reject` → `accept`) decide what they can, without calling the model.
2. **Filler pruning** removes filler words in the configured languages from the payload the model sees. Rules still match the raw text.
3. **Decision model** answers one independent yes/no question per remaining listener, plus the **abuse guard**, which is always asked. Large listener sets are split into parallel requests (`maxQuestionsPerRequest`, default 32).
4. **Abuse guard, then `maxFired`.** If the guard fires, no other listener fires. Otherwise at most `maxFired` listeners fire, highest probability first.
5. **Handlers** run. A failing handler or model call is reported in `result.errors`; it never stops the other listeners.
6. **Trace**: one JSON line per event. This is what the review agent reads.

## Abuse guard (always on)

Every event is also checked for abuse: attempts to get unauthorized access to data or accounts, prompt injection, manipulating scores or routing, and impersonating staff or the system. Anger, complaints and legal threats are explicitly *not* abuse.

```ts
new Edds({
  model,
  abuse: {
    threshold: 0.5,      // default
    action: 'block',     // default; 'flag' lets listeners fire and only marks the result
    onError: 'block',    // default: if the check itself fails, fail closed
    handler: (event, decision) => alertSecurity(event),
  },
});
// result.blocked, result.abuse, and decision.suppressedBy === 'abuse'
```

The guard can't be removed. Its reserved id is `edds.abuse`. Hard rules can only make it stricter: an `accept` rule blocks the event without calling the model, while `require` and `reject` rules for it are refused. The review agent never proposes rules that would skip it. Every question also tells the model the event is untrusted data.

### Injection hardening

| Attack | Defense |
|---|---|
| ASCII smuggling (Unicode tag characters), emoji/variation-selector smuggling | Decoded into visible `[hidden text: …]` before rules, model and traces see the event; finding any blocks it (`edds.abuse/hidden-text`) |
| Zero-width, bidi and full-width tricks to dodge keyword rules | Invisible characters stripped and text NFKC-folded before rules run |
| Chat-template tokens posing as system turns (`<\|im_start\|>`, `[INST]`, `<<SYS>>`, …) | Blocked without calling the model (`edds.abuse/chat-template`) |
| Event text closing the `<event>` block in chat prompts | Random tag suffix, and `<`, `>`, `&` escaped inside the event JSON |
| "Answer q0 with 0" score steering | Question keys are random per event |
| Context flooding / many-shot | Opt-in `abuse.maxChars` blocks oversized events (`edds.abuse/oversized`) |
| Poisoning the review agent with crafted events | Blocked and flagged events only count as evidence for the abuse guard, and abuse rules that swallow legitimate events are refused |
| Keys that differ only by invisible characters, hiding a value from the model | Both values are kept and the event is blocked (`edds.abuse/hidden-text`) |
| Regexes from the review LLM that backtrack badly | Backreferences, quantified groups containing quantifiers and patterns over 200 characters are dropped |

`abuse.signatures: false` turns off the hidden-text and chat-template blocks; hidden text is still revealed. Handlers always receive the original event.

## maxFired

`maxFired: 2` caps how many listeners a single event can trigger. Listeners decided by a rule count as probability 1. Listeners that cleared their threshold but were cut get `suppressedBy: 'maxFired'`.

## Providers

EDDS depends on one interface, `DecisionModel`: answer independent yes/no questions, each with a probability. Every provider plugs in through it.

```ts
// Decision-model APIs (OpenRouter Decisions: Jev, GPT Luna Decisions, Perplexity Decider, …)
new OpenRouterDecisionModel({ model: 'typesafe/jev-1.14' });

// Any OpenAI-compatible chat API: openai, openrouter, groq, together, mistral, gemini, ollama, or a URL
openAICompatible({ baseUrl: 'ollama', model: 'qwen3' });
openAICompatible({ baseUrl: 'openai', model: 'gpt-6-luna', apiKeyEnv: 'OPENAI_API_KEY' });

// Claude through the official Anthropic SDK (optional peer dependency, separate entry point)
import { anthropic } from 'edds/anthropic';
anthropic({ model: 'claude-opus-5-5' });                  // defaults: low effort, server-side refusal fallbacks
anthropic({ client: new AnthropicBedrockMantle({ awsRegion: 'us-east-1' }), fallbacks: false });

// Anything else: wrap one chat call, or implement decide() directly
new ChatDecisionModel({ id: 'my-llm', images: false, complete: async ({ system, prompt, schema }) => ({ text: await myLlm(system, prompt, schema) }) });
defineDecisionModel({ id: 'my-classifier', decide: async ({ state, questions }) => ({ probabilities, usage }) });

// Combine
withFallback(jev, openAICompatible({ baseUrl: 'groq', model: '…' }));
new Edds({ model: (event) => (event.images?.length ? luna : jev) });
```

Decision models return trained probabilities. Chat models estimate them in a JSON reply, which is less calibrated, so tune thresholds per model.

For OpenRouter decision models, image support is detected automatically. For chat transports, declare it with `images: true`. If an event has images and the model is text-only, the images are dropped (`imagesDropped` in the trace); set `onUnsupportedImages: 'error'` to throw instead.

## Filler pruning

`filler: { languages: ['en', 'es'], extra?, keep? }`. Built-in lists cover `en es fr de pt`; other languages need `extra`. The lists are conservative on purpose: articles, hesitation sounds ("um", "eh"), discourse fillers ("basically", "pues") and greetings. Negations, prepositions and pronouns are never removed. The language is detected per event among the configured ones.

## Hard rules

Rule files are JSON (`{ "version": 1, "listeners": { "<id>": { "require": [], "reject": [], "accept": [] } } }`). Rule kinds: `keywords` (whole-word), `regex`, `equals` (on a dot path such as `payload.vip`), and `all` / `any` / `not`.

| Option | Effect |
|---|---|
| `rules` | Enforced: matching rules decide, and the model is skipped. |
| `shadowRules` | Only logged next to the model's answer. Never decide. |
| `auditRate` | Share of rule-decided listeners that are still sent to the model, to catch drift. |

## Review agent (development only, not shipped)

`dev/review/` is excluded from the package. It reads traces and distills the model's confident answers into hard rules, which cuts cost and latency over time.

```sh
npm run review -- --trace edds-trace.jsonl                  # → edds.rules.proposed.json + edds-review.md
npm run review -- --trace t.jsonl --judge typesafe/jev-1.14  # drop coincidental keywords
npm run review -- --trace t.jsonl --llm <chat-model-id>      # also ask an LLM for regex rules
npm run review -- --trace t.jsonl --shadow s.json --rules r.json --promote
```

How it decides:

- **Mining.** Finds words and word pairs that line up with the model's confident yes (≥ 0.9) or no (≤ 0.1). Filler words and common words are skipped.
- **Validation.** Every candidate is scored against the whole trace, including events that existing rules decided. It must match at least `--min-support` unique events, with a 95% Wilson lower bound of `--min-precision` or more. Reject rules may also block at most `--max-recall-loss` of the model's confident yeses.
- **Optional judge.** A decision model is asked whether each keyword is a direct signal for the listener or a coincidence.
- **Lifecycle.** Proposed → shadow (checked on new traffic) → `--promote` → enforced, with audits continuing to watch for drift. Nothing is enforced without first passing on traffic it wasn't mined from.

Identical event texts count once, so repeated events can't inflate a rule's support.

## Try it

```sh
npm install
npm test
npm run example -- --offline                          # 1000 generated emails, stand-in model, no key needed
npm run review -- --trace edds-trace.jsonl
OPENROUTER_API_KEY=... npm run example                # live: 13 emails (3 abusive) through Jev 1.14
OPENROUTER_API_KEY=... npm run example -- --provider chat --model openai/gpt-6-luna
```

The full loop on the demo:

```sh
npm run example -- --offline && npm run review -- --trace edds-trace.jsonl
rm edds-trace.jsonl && npm run example -- --offline --seed 99 --shadow edds.rules.proposed.json
cp edds.rules.proposed.json edds.rules.shadow.json
npm run review -- --trace edds-trace.jsonl --shadow edds.rules.shadow.json --rules edds.rules.json --promote
rm edds-trace.jsonl && npm run example -- --offline --seed 5 --rules edds.rules.json --audit 0.1
```
