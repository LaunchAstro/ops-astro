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
// or a fault. For a credential presented as nothing (`none`), it also passes
// each chunk of a successful answer on as a `piece` note while it reads:
// nothing secret went out, so nothing secret can come back unredacted. No message returns a credential, and an unknown message is
// refused, so there is no borrow path.
//
// Every refusal and fault it writes names a kind, never a value.

import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { described, parseCredentials, type StoredCredential } from './credentials.ts';
import { parseDestinations, send, type Destination, type OutboundRequest } from './egress.ts';
import { METHODS, pathAllowed, type Extras } from './egress-routes.ts';
import { cut, spans, spellingsOf } from './secret-spellings.ts';

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
  // Every spelling is at least as long as its secret, so shorter text holds none.
  const shortest = Math.min(...secrets.map((secret) => secret.length));
  return (text) => {
    if (text.length < shortest) return text;
    const unescaped = cut(
      text,
      spelled.flatMap((groups) => spans(text, groups)),
    );
    return encoded.reduce((out, spelling) => out.split(spelling).join('[redacted]'), unescaped);
  };
}

/** An own field, as the parse sets it: a `__proto__` key is a field like any other. */
const FIELD = { writable: true, enumerable: true, configurable: true } as const;
const put = (into: object, slot: string | number, value: unknown): void => {
  Object.defineProperty(into, slot, { ...FIELD, value });
};

/**
 * A parsed JSON value with each key and string redacted, and a number or literal spelling a
 * secret as `[redacted]`. It walks its own list, not the call stack, into plain objects, which
 * keep JSON.stringify on its fast writer: any depth the parse and write-back accepted still is.
 */
function redactedValue(decoded: unknown, redactText: (text: string) => string): unknown {
  const root: unknown[] = [undefined];
  const pending: [unknown, object, string | number][] = [[decoded, root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, into, slot] = next;
    let out: unknown;
    if (typeof value === 'string') {
      out = redactText(value);
    } else if (Array.isArray(value)) {
      const list: unknown[] = Array.from({ length: value.length });
      for (const [at, item] of value.entries()) pending.push([item, list, at]);
      out = list;
    } else if (typeof value === 'object' && value !== null) {
      const record = {};
      const fields: [unknown, object, string][] = [];
      for (const [key, field] of Object.entries(value)) {
        const name = redactText(key);
        put(record, name, null);
        fields.push([field, record, name]);
      }
      // Reversed, so a later field whose redacted name repeats wins, as in the parse.
      for (const field of fields.toReversed()) pending.push(field);
      out = record;
    } else {
      const written = JSON.stringify(value);
      out = redactText(written) === written ? value : '[redacted]';
    }
    put(into, slot, out);
  }
  return root[0];
}

/**
 * The text JSON.stringify writes for a parsed value, from custody's own list rather than the
 * call stack, for an answer nested deeper than the engine's JSON.stringify reaches (5,000
 * levels on Node 24). Pending text is written as it comes; a pending object or array is opened
 * into its text, each object or array inside it left pending in its place.
 */
function writtenDeep(decoded: unknown): string {
  let out = '';
  const pending: (string | object)[] = [
    typeof decoded === 'object' && decoded !== null ? decoded : JSON.stringify(decoded),
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === 'string') {
      out += next;
      continue;
    }
    const list = Array.isArray(next);
    const pieces: (string | object)[] = [];
    let text = list ? '[' : '{';
    for (const [at, [key, item]] of Object.entries(next).entries()) {
      if (at > 0) text += ',';
      if (!list) text += `${JSON.stringify(key)}:`;
      if (typeof item === 'object' && item !== null) {
        pieces.push(text, item);
        text = '';
      } else {
        text += JSON.stringify(item);
      }
    }
    pieces.push(`${text}${list ? ']' : '}'}`);
    for (const piece of pieces.toReversed()) pending.push(piece);
  }
  return out;
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
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  const redacted = redactedValue(decoded, redactText);
  try {
    return JSON.stringify(redacted);
  } catch {
    // Deeper than the engine's writer reaches: written from custody's own list instead.
    return writtenDeep(redacted);
  }
}

/** Exactly these keys: a request naming a header, an origin or anything else is refused whole. */
const REQUEST_KEYS = 'body,destination,maxResponseBytes,method,path,timeoutMs';

/** The longest delay a timer keeps: past it, or below one, a deadline is no request. */
const LONGEST_DEADLINE_MS = 2_147_483_647;

function isRequest(value: unknown): value is OutboundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  const deadline = shape['timeoutMs'];
  return (
    Object.keys(shape).toSorted().join() === REQUEST_KEYS &&
    typeof shape['destination'] === 'string' &&
    typeof shape['path'] === 'string' &&
    (METHODS as readonly unknown[]).includes(shape['method']) &&
    typeof shape['body'] === 'string' &&
    typeof deadline === 'number' &&
    Number.isInteger(deadline) &&
    deadline >= 1 &&
    deadline <= LONGEST_DEADLINE_MS &&
    typeof shape['maxResponseBytes'] === 'number'
  );
}

type Message = Record<string, unknown>;

const loaded = load();

/**
 * A PUT its destination lists no route for, or a POST to a destination that
 * takes none: custody never sends one, so it is no request.
 */
const unrouted = (asked: OutboundRequest): boolean => {
  const destination: Extras = loaded.destinations.get(asked.destination) ?? {};
  if (asked.method === 'PUT') return !pathAllowed(destination, 'PUT', asked.path);
  return asked.method === 'POST' && destination.post === false;
};

process.on('uncaughtException', () => fail('internal fault'));

process.on('message', (message: unknown) => {
  const shape = (typeof message === 'object' && message !== null ? message : {}) as Message;
  const id = typeof shape['id'] === 'string' ? shape['id'] : '';
  const reply = (body: Message): void => void process.send?.({ id, ...body });
  const ref = shape['credentialRef'];
  const credential = typeof ref === 'string' ? loaded.credentials.get(ref) : undefined;
  if (shape['type'] === 'describe' && id !== '') {
    reply(described(credential, shape['destination']));
    return;
  }
  if (shape['type'] !== 'dispatch' || id === '') {
    reply({ type: 'refused', code: 'CUSTODY_UNKNOWN_REQUEST' });
    return;
  }
  const request = shape['request'];
  if (!isRequest(request) || unrouted(request)) {
    reply({ type: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
    return;
  }
  if (credential === undefined || credential.destination !== request.destination) {
    reply({ type: 'refused', code: 'CUSTODY_CREDENTIAL_UNKNOWN' });
    return;
  }
  reply({ type: 'started' });
  // Passed on as it comes only for a credential presented as nothing: no
  // secret went out, so none can come back in a piece before redaction.
  const none = credential.scheme === 'none';
  const decoder = new StringDecoder('utf8');
  const onChunk = none
    ? (chunk: Buffer): void => {
        const text = decoder.write(chunk);
        if (text !== '') reply({ type: 'piece', text });
      }
    : undefined;
  void (async (): Promise<void> => {
    const outcome = await send(loaded.destinations, request, credential, undefined, onChunk);
    const safe =
      outcome.ok && !none ? { ...outcome, body: redact(outcome.body, credential) } : outcome;
    reply({
      type: 'answer',
      outcome: safe,
      kind: credential.kind,
      account: credential.account,
    });
  })();
});

process.send?.({ type: 'ready' });
