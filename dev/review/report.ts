import type { Rule } from '../../src/rules/rules.ts';
import type { DistillOptions } from './distill.ts';
import { checkStatus, type ReviewResult } from './review.ts';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function describe(rule: Rule): string {
  switch (rule.kind) {
    case 'keywords':
      return `keywords ${rule.any.map((k) => `"${k}"`).join(', ')}`;
    case 'regex':
      return `regex \`/${rule.pattern}/${rule.flags ?? 'iu'}\``;
    default:
      return rule.kind;
  }
}

export function renderReport(result: ReviewResult, opts: DistillOptions, extra: { trace: string; events: number; promoted?: string[] }): string {
  const lines: string[] = [
    '# EDDS review',
    '',
    `Trace: \`${extra.trace}\` (${extra.events} events). A rule passes when it matched at least ${opts.minSupport} events and agrees with the model with a 95% lower bound of ${pct(opts.minPrecision)} or more; reject rules may also block at most ${pct(opts.maxRecallLoss)} of the model's confident yeses.`,
    '',
    '## Listeners',
    '',
    '| Listener | Model calls | Confident yes | Ambiguous |',
    '|---|---:|---:|---:|',
    ...result.stats.map((s) => `| \`${s.listenerId}\` | ${s.modelCalls} | ${pct(s.confidentYes)} | ${pct(s.ambiguous)}${s.ambiguous > 0.25 ? ' ⚠' : ''} |`),
    '',
  ];
  const vague = result.stats.filter((s) => s.ambiguous > 0.25);
  if (vague.length) {
    lines.push(`⚠ More than 25% ambiguous answers usually means the description is vague. Rewrite: ${vague.map((s) => `\`${s.listenerId}\``).join(', ')}.`, '');
  }

  lines.push('## Proposed rules', '');
  if (result.proposals.length === 0) {
    lines.push('None. Collect more traffic, or lower `--min-support`.', '');
  } else {
    lines.push('Load these as `shadowRules` first. Promote them after they pass on new traffic.', '');
    lines.push('| Listener | Verdict | Rule | Matched | Agreed | Lower bound | Saves | Origin |', '|---|---|---|---:|---:|---:|---:|---|');
    for (const c of result.proposals) {
      lines.push(`| \`${c.listenerId}\` | ${c.verdict} | ${describe(c.rule)} | ${c.matched} | ${c.agreed} | ${pct(c.precisionLB)} | ${pct(c.coverage)} | ${c.origin} |`);
    }
    lines.push('');
  }

  if (result.dropped.length) {
    lines.push('### Dropped by the judge', '', 'These held up on the trace but look like coincidences rather than real signals.', '');
    for (const c of result.dropped) lines.push(`- \`${c.listenerId}\` ${c.verdict} ${describe(c.rule)} (${c.why ?? ''})`);
    lines.push('');
  }

  lines.push('## Shadow and audited rules', '');
  if (result.checks.length === 0) {
    lines.push('No shadow or audited rules in this trace.', '');
  } else {
    lines.push('| Listener | Rule | Mode | Verdict | Matched | Agreed | Contradicted | Lower bound | Status |', '|---|---|---|---|---:|---:|---:|---:|---|');
    for (const c of result.checks) {
      const s = checkStatus(c, opts);
      const status = s === 'drifting' ? '**drifting: review or remove**' : s;
      lines.push(`| \`${c.listenerId}\` | \`${c.ruleId}\` | ${c.mode} | ${c.verdict} | ${c.matched} | ${c.agreed} | ${c.contradicted} | ${pct(c.precisionLB)} | ${status} |`);
    }
    lines.push('');
  }

  if (extra.promoted?.length) {
    lines.push('## Promoted', '', ...extra.promoted.map((p) => `- \`${p}\``), '');
  }
  if (result.warnings.length) {
    lines.push('## Warnings', '', ...result.warnings.map((w) => `- ${w}`), '');
  }
  return lines.join('\n');
}
