import type { EddsEvent } from './types.ts';

/**
 * Characters that render as nothing: zero-width spaces and joiners, direction
 * marks and overrides, word joiner, invisible operators, BOM, soft hyphen and
 * the Mongolian vowel separator. Inserted between letters, they let a text
 * slip past keyword rules while the model still reads the words.
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** Tag-character runs. Subdivision flags (England, Scotland, Wales) are the one legitimate use, matched first and kept. */
const TAGS = /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,7}\u{E007F})|[\u{E0000}-\u{E007F}]+/gu;

/** A single selector picks an emoji or glyph style; a run of them is data. */
const SELECTOR_RUN = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]{2,}/gu;

export interface Revealed {
  text: string;
  /** Text that was hidden in invisible characters, decoded. */
  hidden: string[];
}

function decodeTags(run: string): string {
  return [...run]
    .map((c) => c.codePointAt(0)! - 0xe0000)
    .filter((cp) => cp >= 0x20 && cp < 0x7f)
    .map((cp) => String.fromCharCode(cp))
    .join('');
}

function decodeSelectors(run: string): string {
  const bytes = [...run].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16;
  });
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Makes a text read the same to rules as it does to a model: hidden payloads
 * (Unicode tag characters, variation-selector runs) are decoded into visible
 * `[hidden text: …]` markers, invisible characters are dropped, and
 * full-width or styled letters fold to plain ones (NFKC).
 */
export function reveal(text: string): Revealed {
  const hidden: string[] = [];
  const show = (decoded: string) => {
    if (!decoded.trim()) return '';
    hidden.push(decoded);
    return `[hidden text: ${decoded}]`;
  };
  const out = text
    .replace(TAGS, (run, flag?: string) => flag ?? show(decodeTags(run)))
    .replace(SELECTOR_RUN, (run) => show(decodeSelectors(run)))
    .replace(INVISIBLE, '')
    .normalize('NFKC');
  return { text: out, hidden };
}

function revealValue(value: unknown, hidden: string[]): unknown {
  const one = (s: string) => {
    const r = reveal(s);
    hidden.push(...r.hidden);
    return r.text;
  };
  if (typeof value === 'string') return one(value);
  if (Array.isArray(value)) return value.map((v) => revealValue(v, hidden));
  if (value !== null && typeof value === 'object') {
    const out = new Map<string, unknown>();
    for (const [k, v] of Object.entries(value)) {
      let key = one(k);
      // Keys that differ only by invisible characters would overwrite each other,
      // hiding a value from the model that handlers still receive.
      if (out.has(key)) hidden.push(key);
      while (out.has(key)) key += ' [duplicate]';
      out.set(key, revealValue(v, hidden));
    }
    return Object.fromEntries(out);
  }
  return value;
}

/** `reveal` applied to the event name, every string value and every key. */
export function revealEvent<P>(event: Pick<EddsEvent<P>, 'name' | 'payload'>): { event: { name?: string; payload: unknown }; hidden: string[] } {
  const hidden: string[] = [];
  const name = event.name === undefined ? undefined : (revealValue(event.name, hidden) as string);
  const payload = revealValue(event.payload, hidden);
  return { event: name === undefined ? { payload } : { name, payload }, hidden };
}
