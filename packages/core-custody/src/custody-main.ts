// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's own process: the only one that holds a provider credential, and
// the only one a model call leaves the machine from (AW-01).
//
// It reads its credential file and destination list from its own environment
// at start, and nothing else of the product: it imports no adapter, no
// connector and no database code (`tests/custody/aw-01-custody.test.ts` reads
// its import graph). Its one message is `dispatch`: a credential reference
// and a request with no origin. It answers with the bounded, redacted answer
// or a fault. No message returns a credential, and an unknown message is
// refused, so there is no borrow path.
//
// Every refusal and fault it writes names a kind, never a value.

import { readFileSync } from 'node:fs';
import { parseCredentials, type StoredCredential } from './credentials.ts';
import { parseDestinations, send, type Destination, type OutboundRequest } from './egress.ts';
import { METHODS } from './egress-routes.ts';

interface Loaded {
  readonly credentials: ReadonlyMap<string, StoredCredential>;
  readonly destinations: ReadonlyMap<string, Destination>;
}

function fail(kind: string): never {
  process.stderr.write(`custody: ${kind}\n`);
  process.exit(78);
}

function load(): Loaded {
  const file = process.env['CUSTODY_CREDENTIALS_FILE'];
  if (file === undefined || file === '') fail('no credential file named');
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('credential file unreadable');
  }
  const credentials = parseCredentials(entries);
  if (!credentials.ok) fail(`credential ${String(credentials.at)} refused ${credentials.code}`);
  let listed: unknown;
  try {
    listed = JSON.parse(process.env['CUSTODY_DESTINATIONS'] ?? '');
  } catch {
    fail('destination list unreadable');
  }
  const destinations = parseDestinations(listed);
  if (!destinations.ok) fail(`destination ${String(destinations.at)} refused ${destinations.code}`);
  // The file's path leaves the environment once read; a child of this process inherits neither.
  delete process.env['CUSTODY_CREDENTIALS_FILE'];
  return { credentials: credentials.credentials, destinations: destinations.destinations };
}

/** One way to spell one character of a secret; `fold` compares a percent escape's hex case-free. */
interface Spelling {
  readonly text: string;
  readonly fold: boolean;
}

/** A character as itself, as JSON text writes it, and as its UTF-8 bytes percent-escaped. */
function spellingsOf(character: string): readonly Spelling[] {
  const json = JSON.stringify(character).slice(1, -1);
  const escaped = [...Buffer.from(character, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  return [
    { text: character, fold: false },
    ...(json === character ? [] : [{ text: json, fold: false }]),
    { text: escaped, fold: true },
  ];
}

const spelledAt = (text: string, offset: number, spelling: Spelling): boolean => {
  const part = text.slice(offset, offset + spelling.text.length);
  return spelling.fold ? part.toLowerCase() === spelling.text : part === spelling.text;
};

/**
 * Where the text spells the secret, each character in any of its spellings,
 * in any mix: one pass that keeps, for each text offset ahead, how far into
 * the secret a spelling reaching it has got and the earliest start that got
 * there (steps that meet go on alike). Nothing is retried, so the cost is the
 * text's length times the secret's, and every spelling stays reachable.
 */
function spans(
  text: string,
  groups: readonly (readonly Spelling[])[],
): readonly (readonly [number, number])[] {
  if (groups.length === 0) return [];
  const ahead = new Map<number, Map<number, number>>();
  const found: [number, number][] = [];
  for (let offset = 0; offset <= text.length; offset += 1) {
    const here = ahead.get(offset) ?? new Map<number, number>();
    ahead.delete(offset);
    here.set(0, offset);
    for (const [step, start] of here) {
      if (step === groups.length) {
        found.push([start, offset]);
        continue;
      }
      for (const spelling of groups[step] ?? []) {
        if (!spelledAt(text, offset, spelling)) continue;
        const next = offset + spelling.text.length;
        const reached = ahead.get(next) ?? new Map<number, number>();
        if ((reached.get(step + 1) ?? next) > start) reached.set(step + 1, start);
        ahead.set(next, reached);
      }
    }
  }
  return found;
}

/** The text with every span, merged where they overlap, replaced by `[redacted]`. */
function cut(text: string, found: readonly (readonly [number, number])[]): string {
  const merged: [number, number][] = [];
  for (const [start, end] of found.toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = '';
  let from = 0;
  for (const [start, end] of merged) {
    out += `${text.slice(from, start)}[redacted]`;
    from = end;
  }
  return out + text.slice(from);
}

/**
 * The secret's base64, standard and base64url, at each of the three byte
 * offsets it can sit at inside longer encoded text: only the characters every
 * bit of which comes from the secret, so neighbouring bytes cannot change
 * them. A whole encoding alone, padded or not, contains the offset-0 one.
 */
function base64Spellings(secret: string): readonly string[] {
  const bytes = Buffer.from(secret);
  return [0, 1, 2].flatMap((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const stable = encoded.slice(
      Math.ceil((8 * offset) / 6),
      Math.floor((8 * (offset + bytes.length)) / 6),
    );
    return [stable, stable.replaceAll('+', '-').replaceAll('/', '_')];
  });
}

/**
 * Text with every spelling of each secret replaced by `[redacted]`. The
 * spellings are worked out once, so a JSON answer of many small values costs
 * its length, not a setup per value.
 */
function redacterOf(secrets: readonly string[]): (text: string) => string {
  const spelled = secrets.map((secret) => [...secret].map((character) => spellingsOf(character)));
  const encoded = secrets.flatMap((secret) => base64Spellings(secret));
  return (text) => {
    const unescaped = cut(
      text,
      spelled.flatMap((groups) => spans(text, groups)),
    );
    return encoded.reduce((out, spelling) => out.split(spelling).join('[redacted]'), unescaped);
  };
}

/**
 * Remove every spelling of the credential a provider might echo back: the
 * value, and a Basic pair's secret half alone, each as itself, as JSON text
 * spells it, percent-escaped in either case, or in base64 or base64url,
 * alone or inside longer encoded text. A JSON answer is redacted inside each
 * key and value as the broker's parse reads them, then written back, so an
 * escape the provider chose (`\/`, `\u0063`) hides nothing and no match
 * reaches the quotes and commas between values; a number or literal that
 * spells a secret becomes `[redacted]`. Other text is redacted as it came.
 */
function redact(text: string, credential: StoredCredential): string {
  const { value } = credential;
  const redactText = redacterOf(
    credential.scheme === 'basic' ? [value, value.split(':')[1] ?? value] : [value],
  );
  const inside = (decoded: unknown): unknown => {
    if (typeof decoded === 'string') return redactText(decoded);
    if (Array.isArray(decoded)) return decoded.map((item) => inside(item));
    if (typeof decoded === 'object' && decoded !== null) {
      return Object.fromEntries(
        Object.entries(decoded).map(([key, field]) => [redactText(key), inside(field)]),
      );
    }
    const written = JSON.stringify(decoded);
    return redactText(written) === written ? decoded : '[redacted]';
  };
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  try {
    return JSON.stringify(inside(decoded));
  } catch {
    // Too deep to walk or write back: no body, which the broker reads as no answer.
    return '';
  }
}

/** Exactly these keys: a request naming a header, an origin or anything else is refused whole. */
const REQUEST_KEYS = 'body,destination,maxResponseBytes,method,path,timeoutMs';

function isRequest(value: unknown): value is OutboundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  return (
    Object.keys(shape).toSorted().join() === REQUEST_KEYS &&
    typeof shape['destination'] === 'string' &&
    typeof shape['path'] === 'string' &&
    (METHODS as readonly unknown[]).includes(shape['method']) &&
    typeof shape['body'] === 'string' &&
    typeof shape['timeoutMs'] === 'number' &&
    typeof shape['maxResponseBytes'] === 'number'
  );
}

const loaded = load();

process.on('uncaughtException', () => fail('internal fault'));

process.on('message', (message: unknown) => {
  const shape = (typeof message === 'object' && message !== null ? message : {}) as Record<
    string,
    unknown
  >;
  const id = typeof shape['id'] === 'string' ? shape['id'] : '';
  const reply = (body: Record<string, unknown>): void => {
    process.send?.({ id, ...body });
  };
  if (shape['type'] !== 'dispatch' || id === '') {
    reply({ type: 'refused', code: 'CUSTODY_UNKNOWN_REQUEST' });
    return;
  }
  const request = shape['request'];
  const ref = shape['credentialRef'];
  if (!isRequest(request)) {
    reply({ type: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
    return;
  }
  const credential = typeof ref === 'string' ? loaded.credentials.get(ref) : undefined;
  if (credential === undefined || credential.destination !== request.destination) {
    reply({ type: 'refused', code: 'CUSTODY_CREDENTIAL_UNKNOWN' });
    return;
  }
  reply({ type: 'started' });
  void (async (): Promise<void> => {
    const outcome = await send(loaded.destinations, request, credential);
    const safe = outcome.ok ? { ...outcome, body: redact(outcome.body, credential) } : outcome;
    reply({
      type: 'answer',
      outcome: safe,
      kind: credential.kind,
      account: credential.account,
    });
  })();
});

process.send?.({ type: 'ready' });
