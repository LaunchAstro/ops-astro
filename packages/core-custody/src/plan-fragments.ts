// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a plan answer holds a held secret beyond what redaction removes
// (#1620 P3, `plan-answer.ts`). Two rules, each over every key, string and
// number's text of the answer, as sent, percent-decoded, and base64 or
// base64url decoded when it is wholly that:
//
// 1. A run: FRAGMENT_RUN characters of a secret in any one text, or in a join
//    in document order of all texts, all values, the values under one key
//    name, all percent-decoded texts or all base64-decoded ones. A secret
//    split into texts that follow one another is caught here, however short
//    its pieces.
// 2. Pieces: every whole run of a secret's own characters, PIECE_MIN or more
//    long, that is a piece of it marks where it sits in the secret. Pieces in
//    any order that cover COVER_SHARE of a secret withhold the answer. A word
//    that matches by chance covers little; a secret cut up and scattered
//    covers it all.
//
// A signed token is judged on its signature: its header and claims are not
// secret, and would match every answer that shows a token. A token counts as
// signed only when its header and claims decode to JSON and the header names
// its algorithm; an opaque three-part secret is judged whole. Not judged:
// pieces of one or two characters apart or out of order (chance covers as
// much), pieces shorter than FRAGMENT_RUN glued inside other text, and other
// deliberate encodings. No text rule catches
// those, and the token reaches only the request's header, never the model.

/** The shortest run of a secret that withholds an answer on its own. */
export const FRAGMENT_RUN = 6;
/** The shortest whole run that counts as a piece of a secret. */
const PIECE_MIN = 3;
/**
 * How much of a secret its pieces may cover, in any order, before the answer
 * is withheld. Measured on 1,800 answers made from this repository's own
 * documents and code against random 32- to 64-character tokens, chance pieces
 * of three or more covered at most 19%; pieces of two covered up to 66%, so
 * no share tells them from a leak.
 */
const COVER_SHARE = 0.5;

/**
 * What a reader can join from a parsed value, in document order: all its
 * keys, strings and numbers' texts, its values alone, and the values under
 * each key name (every `text`). The first group holds every text.
 */
function groupsOf(value: unknown): readonly (readonly string[])[] {
  const alone: string[] = [];
  const values: string[] = [];
  const byKey = new Map<string, string[]>();
  // A key's own text is filed under null: it is no value.
  const pending: [unknown, string | null][] = [[value, '']];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, key] = next;
    if (typeof item !== 'object' || item === null) {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      alone.push(text);
      if (key === null) continue;
      values.push(text);
      const same = byKey.get(key) ?? [];
      same.push(text);
      byKey.set(key, same);
      continue;
    }
    const items: [unknown, string | null][] = Array.isArray(item)
      ? item.map((child) => [child, key])
      : Object.entries(item).flatMap(([name, child]) => [
          [name, null],
          [child, name],
        ]);
    // Reversed onto the list, so they come off it in document order.
    for (let at = items.length - 1; at >= 0; at -= 1) pending.push(items[at] ?? [null, null]);
  }
  return [alone, values, ...byKey.values()];
}

/** Percent escapes decoded, each byte as one character. */
const unpercent = (text: string): string =>
  text.replaceAll(/%([0-9A-Fa-f]{2})/gu, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );

/** A text as sent, percent-decoded, and base64 or base64url decoded ('' when it is not wholly that). */
function readingsOf(text: string): readonly [string, string, string] {
  const packed = text.replaceAll(/\s/gu, '').replaceAll('-', '+').replaceAll('_', '/');
  const decoded = /^[A-Za-z0-9+/]+={0,2}$/u.test(packed)
    ? Buffer.from(packed, 'base64').toString('latin1')
    : '';
  return [text, unpercent(text), decoded];
}

/** A base64url part decoded to a JSON object, or undefined. */
function jsonPart(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The part of a secret a fragment is judged on: a signed token's signature,
 * or the whole. A token is signed only when its header and claims decode to
 * JSON objects and the header names its algorithm; any other three-part
 * secret is opaque.
 */
function secretPart(secret: string): string {
  const [header = '', claims = '', signature = ''] = secret.split('.');
  const signed =
    /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(secret) &&
    typeof jsonPart(header)?.['alg'] === 'string' &&
    jsonPart(claims) !== undefined;
  return signed ? signature : secret;
}

/** Rule 1: a run of FRAGMENT_RUN characters of the secret (a shorter secret whole) in a text. */
function holdsRun(texts: readonly string[], secret: string): boolean {
  const length = Math.min(FRAGMENT_RUN, secret.length);
  const runs = new Set<string>();
  for (let at = 0; at + length <= secret.length; at += 1) runs.add(secret.slice(at, at + length));
  return texts.some((text) => {
    for (let at = 0; at + length <= text.length; at += 1)
      if (runs.has(text.slice(at, at + length))) return true;
    return false;
  });
}

/** Rule 2: whole runs of the secret's own characters, each a piece of it, cover COVER_SHARE of it. */
function piecesCover(texts: readonly string[], secret: string): boolean {
  const own = new Set(secret);
  const covered = new Uint8Array(secret.length);
  const marked = new Set<string>();
  const mark = (run: string): void => {
    if (run.length < PIECE_MIN || marked.has(run)) return;
    marked.add(run);
    for (let at = secret.indexOf(run); at !== -1; at = secret.indexOf(run, at + 1))
      covered.fill(1, at, at + run.length);
  };
  for (const text of texts) {
    let start = 0;
    for (let at = 0; at <= text.length; at += 1) {
      if (at < text.length && own.has(text.charAt(at))) continue;
      mark(text.slice(start, at));
      start = at + 1;
    }
  }
  return covered.reduce((sum, bit) => sum + bit, 0) >= secret.length * COVER_SHARE;
}

/** Whether a redacted answer still holds any secret, by either rule. */
export function holdsSecret(value: unknown, secrets: readonly string[]): boolean {
  const groups = groupsOf(value);
  const each = (groups[0] ?? []).flatMap((text) => readingsOf(text));
  // Each group joined three ways: as sent, percent-decoded, base64-decoded.
  const joined = groups.flatMap((texts) => {
    const readings = texts.map((text) => readingsOf(text));
    return [0, 1, 2].map((way) => readings.map((reading) => reading[way]).join(''));
  });
  return secrets
    .map((secret) => secretPart(secret))
    .some((secret) => holdsRun([...each, ...joined], secret) || piecesCover(each, secret));
}
