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

/** Remove every spelling of the credential a provider might echo back. */
function redact(text: string, value: string): string {
  const spellings = [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
  return spellings.reduce((out, spelling) => out.split(spelling).join('[redacted]'), text);
}

function isRequest(value: unknown): value is OutboundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  return (
    typeof shape['destination'] === 'string' &&
    typeof shape['path'] === 'string' &&
    shape['method'] === 'POST' &&
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
    const safe = outcome.ok
      ? { ...outcome, body: redact(outcome.body, credential.value) }
      : outcome;
    reply({
      type: 'answer',
      outcome: safe,
      kind: credential.kind,
      account: credential.account,
    });
  })();
});

process.send?.({ type: 'ready' });
