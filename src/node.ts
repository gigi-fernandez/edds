import { appendFile, readFile } from 'node:fs/promises';
import { parseRuleSet, type RuleSet } from './rules/rules.ts';
import type { TraceEntry, TraceSink } from './trace.ts';

/** Appends one JSON line per event. This is the review agent's input. */
export class JsonlTraceSink implements TraceSink {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async record(entry: TraceEntry): Promise<void> {
    await appendFile(this.path, JSON.stringify(entry) + '\n');
  }
}

export async function loadRuleSet(path: string): Promise<RuleSet> {
  return parseRuleSet(JSON.parse(await readFile(path, 'utf8')));
}
