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
// refused, so there is no borrow path. A dispatch marked `gated` waits after
// `started` for its admission's `go` (sent) or `stop` (refused, nothing sent).
// A request on a template route is answered with its declared fields only,
// or `withheld` whole: `malformed` when it is not JSON or does not fill them,
// `echoed` when the caller could rebuild the credential from them.
// A `deadlineAt` gates the write itself (`egress.ts`). A GitHub App entry is
// never sent: a call on it names its party, is refused before `started` unless
// its path names that party's bound repository, and is sent with a token
// minted for it alone (`github-app.ts`), refused when none is minted. The
// mint spends the call's own time, and the token goes only while still in
// date: one that expires while admission waits is refused, never sent.
//
// Every refusal and fault it writes names a kind, never a value.

import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  described,
  parseCredentials,
  type Presentable,
  type StoredCredential,
} from './credentials.ts';
import { carriedByApp, type PartyRequest } from './github-app.ts';
import {
  parseDestinations,
  send,
  type Destination,
  type Outbound,
  type OutboundRequest,
} from './egress.ts';
import { keptOf } from './egress-answer.ts';
import { METHODS, pathAllowed, templateFilled, type Extras } from './egress-routes.ts';
import { redact, withholds } from './redaction.ts';
import { openaiSse } from './stream-decode.ts';

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

/** Exactly these keys, a party optional: a request naming a header, an origin or anything else is refused whole. */
const REQUEST_KEYS = new Set([
  'body,destination,maxResponseBytes,method,path,timeoutMs',
  'body,destination,maxResponseBytes,method,party,path,timeoutMs',
]);

/** The longest delay a timer keeps: past it, or below one, a deadline is no request. */
const LONGEST_DEADLINE_MS = 2_147_483_647;

function isRequest(value: unknown): value is PartyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  const deadline = shape['timeoutMs'];
  return (
    REQUEST_KEYS.has(Object.keys(shape).toSorted().join()) &&
    (shape['party'] === undefined || typeof shape['party'] === 'string') &&
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

/** A dispatch's deadline as its send gate, noting `written`: none when absent, null when malformed. */
function sendGateOf(at: unknown, reply: (body: Message) => void) {
  if (at === undefined) return;
  if (typeof at !== 'number' || !Number.isSafeInteger(at)) return null;
  return { deadlineAt: at, onWritten: () => reply({ type: 'written' }) };
}

const loaded = load();

/** A credential custody sends as it is held, or one minted for the call, with its expiry. */
type Carried = StoredCredential & Presentable & { readonly expiresAt?: number };

/**
 * A PUT its destination lists no route for, or a POST to a destination that
 * takes none or not at that path: custody never sends one, so it is no request.
 */
const unrouted = (asked: OutboundRequest): boolean => {
  const destination: Extras = loaded.destinations.get(asked.destination) ?? {};
  if (asked.method === 'PUT') return !pathAllowed(destination, 'PUT', asked.path);
  if (asked.method !== 'POST') return false;
  const barred = destination.post === false || destination.posts !== undefined;
  return barred && !pathAllowed(destination, 'POST', asked.path);
};

/**
 * How an answer goes back. Passed on as it comes only for a credential
 * presented as nothing: no secret went out, so none can come back in a piece
 * before redaction. A presented key streams only to a destination that
 * declares a format custody decodes, as decoded, redacted text
 * (`stream-decode.ts`), and its answer is the folded body. Any other answer
 * from a presented key is redacted whole.
 */
function streamingOf(
  credential: Carried,
  destination: string,
  piece: (text: string) => void,
): {
  readonly onChunk: ((chunk: Buffer) => void) | undefined;
  readonly answer: (outcome: Outbound) => Outbound;
} {
  if (credential.scheme === 'none') {
    const decoder = new StringDecoder('utf8');
    return {
      onChunk: (chunk) => {
        const text = decoder.write(chunk);
        if (text !== '') piece(text);
      },
      answer: (outcome) => outcome,
    };
  }
  const redacted = (outcome: Outbound): Outbound =>
    outcome.ok ? { ...outcome, body: redact(outcome.body, credential) } : outcome;
  if (loaded.destinations.get(destination)?.stream !== 'openai_sse') {
    return { onChunk: undefined, answer: redacted };
  }
  const decoding = openaiSse(credential);
  return {
    onChunk: (chunk) => {
      for (const text of decoding.push(chunk)) piece(text);
    },
    answer: (outcome) => {
      if (!outcome.ok) return outcome;
      const { pieces, body } = decoding.end();
      for (const text of pieces) piece(text);
      return { ...outcome, body };
    },
  };
}

/** Dispatches held after `started` until their admission says `go` or `stop` (#1508). */
const gates = new Map<string, (go: boolean) => void>();

/** Whether a gated dispatch may send: its admission's word, or no within the request's own deadline. */
async function gateOf(id: string, deadlineMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => settle(false), deadlineMs);
    const settle = (go: boolean): void => {
      clearTimeout(timer);
      gates.delete(id);
      resolve(go);
    };
    gates.set(id, settle);
  });
}

/**
 * The answer to a started dispatch: for a gated one, only once its admission
 * says `go`, sent and passed back as `streamingOf` says.
 */
async function answer(
  id: string,
  request: OutboundRequest,
  credential: Carried,
  gated: boolean,
  reply: (body: Message) => void,
  sendGate?: ReturnType<typeof sendGateOf>,
): Promise<void> {
  if (gated && !(await gateOf(id, request.timeoutMs))) {
    reply({ type: 'refused', code: 'CUSTODY_NOT_ADMITTED' });
    return;
  }
  // A minted token is judged at the send, not at the mint: admission may outlast it.
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
    reply({ type: 'refused', code: 'CUSTODY_TOKEN_EXPIRED' });
    return;
  }
  const streaming = streamingOf(credential, request.destination, (text) =>
    reply({ type: 'piece', text }),
  );
  const destination: Extras = loaded.destinations.get(request.destination) ?? {};
  const route = templateFilled(destination, request.method, request.path);
  // A template route's answer is judged whole, so none of it goes out as it is read.
  const onChunk = route === undefined ? streaming.onChunk : undefined;
  let outcome = await send(
    loaded.destinations,
    request,
    credential,
    undefined,
    onChunk,
    sendGate ?? undefined,
  );
  if (route !== undefined && outcome.ok) {
    const kept = keptOf(outcome, route.fields);
    if (kept === undefined || withholds(kept.values, credential)) {
      reply({ type: 'withheld', reason: kept === undefined ? 'malformed' : 'echoed' });
      return;
    }
    outcome = { ...outcome, body: kept.body };
  }
  reply({
    type: 'answer',
    outcome: streaming.answer(outcome),
    kind: credential.kind,
    account: credential.account,
  });
}

process.on('uncaughtException', () => fail('internal fault'));

process.on('message', (message: unknown) => {
  const shape = (typeof message === 'object' && message !== null ? message : {}) as Message;
  const id = typeof shape['id'] === 'string' ? shape['id'] : '';
  const reply = (body: Message): void => void process.send?.({ id, ...body });
  if ((shape['type'] === 'go' || shape['type'] === 'stop') && id !== '') {
    // A gated dispatch's word: anything for no waiting dispatch is dropped, never answered.
    gates.get(id)?.(shape['type'] === 'go');
    return;
  }
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
  const sendGate = sendGateOf(shape['deadlineAt'], reply);
  if (!isRequest(request) || unrouted(request) || sendGate === null) {
    reply({ type: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
    return;
  }
  if (credential === undefined || credential.destination !== request.destination) {
    reply({ type: 'refused', code: 'CUSTODY_CREDENTIAL_UNKNOWN' });
    return;
  }
  const gated = shape['gated'] === true;
  if (credential.scheme === 'github_app') {
    void (async () => {
      const carried = await carriedByApp(credential, request, loaded.destinations);
      if (typeof carried === 'string') return reply({ type: 'refused', code: carried });
      reply({ type: 'started' });
      const minted = { ...credential, ...carried.presented, expiresAt: carried.expiresAt };
      await answer(id, carried.request, minted, gated, reply, sendGate);
    })();
    return;
  }
  reply({ type: 'started' });
  void answer(id, request, { ...credential, scheme: credential.scheme }, gated, reply, sendGate);
});

process.send?.({ type: 'ready' });
