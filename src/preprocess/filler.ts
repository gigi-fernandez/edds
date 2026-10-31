/**
 * Conservative filler lists: articles, hesitation sounds, discourse fillers and
 * greetings. Negations, prepositions, pronouns and intensifiers are left alone
 * because they change what a sentence means.
 */
export const FILLER_WORDS: Record<string, readonly string[]> = {
  en: ['a', 'an', 'the', 'um', 'umm', 'uh', 'uhh', 'erm', 'hmm', 'basically', 'actually', 'literally', 'honestly', 'anyway', 'anyways', 'hi', 'hello', 'hey', 'regards', 'cheers'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'eh', 'em', 'ehm', 'mmm', 'pues', 'básicamente', 'literalmente', 'sinceramente', 'hola', 'saludos'],
  fr: ['le', 'la', 'les', 'un', 'une', 'euh', 'bah', 'ben', 'bref', 'bonjour', 'salut', 'cordialement'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'äh', 'ähm', 'eigentlich', 'sozusagen', 'hallo', 'grüße'],
  pt: ['o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'né', 'basicamente', 'literalmente', 'olá', 'oi'],
};

/** Frequent words used only to guess the language of a text. */
const MARKERS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'is', 'to', 'of', 'it', 'you', 'that', 'not', 'with', 'my', 'was'],
  es: ['el', 'la', 'que', 'y', 'es', 'por', 'para', 'con', 'mi', 'pero', 'los', 'está'],
  fr: ['le', 'les', 'et', 'est', 'pas', 'pour', 'avec', 'une', 'des', 'je', 'mon', 'dans'],
  de: ['der', 'die', 'und', 'ist', 'nicht', 'das', 'mit', 'ich', 'zu', 'ein', 'mein', 'auf'],
  pt: ['o', 'que', 'e', 'não', 'para', 'com', 'uma', 'é', 'os', 'meu', 'mas', 'está'],
};

/** Never pruned, even if a custom list includes them. */
const PROTECTED = new Set(['no', 'not', 'never', 'nor', 'nunca', 'ni', 'ne', 'pas', 'jamais', 'nicht', 'kein', 'keine', 'nie', 'não', 'nem']);

export interface FillerOptions {
  /** Languages that events may arrive in, e.g. ['en', 'es']. */
  languages: string[];
  /** Extra filler words per language, added to the built-in lists. */
  extra?: Record<string, string[]>;
  /** Words that are never pruned. */
  keep?: string[];
}

export interface PruneResult {
  text: string;
  /** Detected language, or undefined when several configured languages tied. */
  language?: string;
  removed: number;
}

const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;

export class FillerPruner {
  readonly #lists = new Map<string, Set<string>>();
  readonly #markers = new Map<string, Set<string>>();
  readonly #keep: Set<string>;

  constructor(options: FillerOptions) {
    for (const lang of options.languages) {
      const builtIn = FILLER_WORDS[lang];
      const extra = options.extra?.[lang] ?? [];
      if (!builtIn && extra.length === 0) {
        throw new Error(`no filler list for language "${lang}"; pass words in options.extra.${lang}`);
      }
      this.#lists.set(lang, new Set([...(builtIn ?? []), ...extra].map((w) => w.toLowerCase())));
      this.#markers.set(lang, new Set(MARKERS[lang] ?? builtIn ?? extra));
    }
    this.#keep = new Set([...PROTECTED, ...(options.keep ?? []).map((w) => w.toLowerCase())]);
  }

  /** Picks the configured language with the most marker hits; ties return undefined. */
  detect(text: string): string | undefined {
    const words = text.toLowerCase().match(WORD) ?? [];
    let best: string | undefined;
    let bestScore = 0;
    let tie = false;
    for (const [lang, markers] of this.#markers) {
      const score = words.reduce((n, w) => n + (markers.has(w) ? 1 : 0), 0);
      if (score > bestScore) [best, bestScore, tie] = [lang, score, false];
      else if (score === bestScore && score > 0) tie = true;
    }
    return tie || bestScore === 0 ? undefined : best;
  }

  /** Words to prune for a language, or the union of all configured lists. */
  fillerFor(language: string | undefined): Set<string> {
    if (language) return this.#lists.get(language)!;
    return new Set([...this.#lists.values()].flatMap((s) => [...s]));
  }

  isFiller(word: string, language?: string): boolean {
    const w = word.toLowerCase();
    return !this.#keep.has(w) && this.fillerFor(language).has(w);
  }

  prune(text: string, language: string | undefined = this.detect(text)): PruneResult {
    const filler = this.fillerFor(language);
    let removed = 0;
    const pruned = text
      .replace(WORD, (word) => {
        const w = word.toLowerCase();
        if (this.#keep.has(w) || !filler.has(w)) return word;
        removed++;
        return '';
      })
      // Tidy what removal leaves behind: "Hi, um, the x" → ", , x" → "x".
      .replace(/[ \t]*([,;:])(?:[ \t]*[,;:])+/g, '$1')
      .replace(/[ \t]+([,;:.!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t]*[,;:][ \t]*/gm, '')
      .replace(/^[ \t]+|[ \t]+$/gm, '');
    return { text: pruned, language, removed };
  }
}
