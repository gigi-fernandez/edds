import type { EddsEvent } from './types.ts';

/** Flattens a value into `path: value` lines so rules and traces see one text. */
export function flatten(value: unknown, path = ''): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') {
    const text = String(value);
    return path ? `${path}: ${text}` : text;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  return entries
    .map(([key, v]) => flatten(v, path ? `${path}.${key}` : key))
    .filter(Boolean)
    .join('\n');
}

export function eventText(event: Pick<EddsEvent, 'name' | 'payload'>): string {
  const body = flatten(event.payload);
  return event.name ? `${event.name}\n${body}` : body;
}

/** Reads a dot path (`payload.subject`, `name`) from an event. */
export function readField(event: Pick<EddsEvent, 'name' | 'payload'>, path: string): unknown {
  let current: unknown = event;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Applies `fn` to every string leaf, keeping the shape. */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}
