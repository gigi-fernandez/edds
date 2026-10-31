import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { OpenRouterDecisionModel } from '../../src/models/openrouter.ts';
import { loadRuleSet } from '../../src/node.ts';
import type { RuleSet } from '../../src/rules/rules.ts';
import type { TraceEntry } from '../../src/trace.ts';
import { DEFAULTS, type DistillOptions } from './distill.ts';
import { renderReport } from './report.ts';
import { checkStatus, promote, ruleIds, runReview, toRuleSet } from './review.ts';

const USAGE = `EDDS review agent (development only)

Reads a decision trace and distills the model's confident answers into hard rules.

  npm run review -- --trace edds-trace.jsonl [options]

  --trace <file>          JSONL written by JsonlTraceSink (required)
  --out <file>            proposed rules (default edds.rules.proposed.json)
  --report <file>         markdown report (default edds-review.md)
  --rules <file>          enforced rules file; its rules are not proposed again
  --shadow <file>         shadow rules file; its rules are checked and not proposed again
  --promote               move passing shadow rules into --rules (needs --rules and --shadow)
  --llm <model>           also ask an OpenRouter chat model for regex rules
  --judge <model>         drop candidates a decision model calls coincidences (e.g. typesafe/jev-1.14)
  --min-support <n>       default ${DEFAULTS.minSupport}
  --min-precision <x>     default ${DEFAULTS.minPrecision}
  --max-recall-loss <x>   default ${DEFAULTS.maxRecallLoss}
  --high <x> --low <x>    confident yes / no cut-offs (default ${DEFAULTS.high} / ${DEFAULTS.low})
`;

const { values } = parseArgs({
  options: {
    trace: { type: 'string' },
    out: { type: 'string', default: 'edds.rules.proposed.json' },
    report: { type: 'string', default: 'edds-review.md' },
    rules: { type: 'string' },
    shadow: { type: 'string' },
    promote: { type: 'boolean', default: false },
    llm: { type: 'string' },
    judge: { type: 'string' },
    'min-support': { type: 'string' },
    'min-precision': { type: 'string' },
    'max-recall-loss': { type: 'string' },
    high: { type: 'string' },
    low: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.trace) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));
const distill: DistillOptions = {
  ...DEFAULTS,
  minSupport: num(values['min-support'], DEFAULTS.minSupport),
  minPrecision: num(values['min-precision'], DEFAULTS.minPrecision),
  maxRecallLoss: num(values['max-recall-loss'], DEFAULTS.maxRecallLoss),
  high: num(values.high, DEFAULTS.high),
  low: num(values.low, DEFAULTS.low),
};

const entries: TraceEntry[] = (await readFile(values.trace, 'utf8'))
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const load = async (path: string | undefined): Promise<RuleSet | undefined> =>
  path && existsSync(path) ? loadRuleSet(path) : undefined;
const enforced = await load(values.rules);
const shadow = await load(values.shadow);

const result = await runReview(entries, {
  distill,
  llm: values.llm ? { model: values.llm } : undefined,
  judge: values.judge ? new OpenRouterDecisionModel({ model: values.judge }) : undefined,
  knownRuleIds: new Set([...ruleIds(enforced), ...ruleIds(shadow)]),
});

let promoted: string[] | undefined;
if (values.promote) {
  if (!values.rules || !values.shadow || !shadow) {
    console.error('--promote needs --rules <file> and an existing --shadow <file>');
    process.exit(1);
  }
  const next = promote(shadow, enforced ?? { version: 1, listeners: {} }, result.checks);
  await writeFile(values.rules, JSON.stringify(next.enforced, null, 2) + '\n');
  await writeFile(values.shadow, JSON.stringify(next.shadow, null, 2) + '\n');
  promoted = next.promoted;
}

await writeFile(values.out, JSON.stringify(toRuleSet(result.proposals), null, 2) + '\n');
await writeFile(values.report, renderReport(result, distill, { trace: values.trace, events: entries.length, promoted }));

const ready = result.checks.filter((c) => c.mode === 'shadow' && c.passes).length;
const drifting = result.checks.filter((c) => checkStatus(c, distill) === 'drifting').length;
console.log(`${entries.length} events reviewed`);
console.log(`${result.proposals.length} new rules proposed → ${values.out}`);
if (result.dropped.length) console.log(`${result.dropped.length} candidates dropped by the judge`);
if (ready) console.log(`${ready} shadow rules ready to promote${promoted ? ` (promoted ${promoted.length})` : ' (run with --promote)'}`);
if (drifting) console.log(`${drifting} enforced rules drifting from the model`);
for (const w of result.warnings) console.log(`warning: ${w}`);
console.log(`report → ${values.report}`);
