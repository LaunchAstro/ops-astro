// SPDX-License-Identifier: AGPL-3.0-only
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
export const person = '11111111-1111-4111-8111-111111111111';
export const clientId = '22222222-2222-4222-8222-222222222222';
export function row(key: string, title: string, whoseMove = 'Team') {
  return {
    id: key,
    key,
    title,
    assignee: { personId: person, name: 'Noah Lee' },
    state: null,
    revision: 1,
    due: null,
    priority: null,
    completedAt: null,
    tags: [],
    category: null,
    waitingComments: 0,
    whoseMove,
  };
}
export function transport() {
  const reads: unknown[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    let answer: unknown = { ok: true };
    if (String(input).endsWith('/person/list'))
      answer = { ok: true, persons: [{ personId: person, name: 'Noah Lee' }] };
    if (String(input).endsWith('/client/list'))
      answer = { ok: true, clients: [{ clientId, name: 'Acme Physio' }] };
    if (String(input).endsWith('/task/todos')) {
      reads.push(body);
      const scoped =
        typeof body === 'object' && body !== null && ('person' in body || 'client' in body);
      answer = {
        ok: true,
        todos: scoped
          ? [
              row('Team-1', 'Team work'),
              row('Team-2', 'Review title only'),
              row('Team-3', 'Real review', 'Review'),
            ]
          : [row('Own-1', 'My work')],
      };
    }
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return {
    reads,
    client: new OperationsClient({ origin: '', businessKey: 'synthetic', signedIn: true, fetch }),
  };
}
function noHeldRead(): never {
  throw new Error('No held read');
}
export function heldTransport() {
  let release: (response: Response) => void = noHeldRead;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let personReads = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const path = String(input);
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (path.endsWith('/person/list'))
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, persons: [{ personId: person, name: 'Noah Lee' }] }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    if (path.endsWith('/client/list'))
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, clients: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (typeof body === 'object' && body !== null && 'person' in body) {
      personReads++;
      return held;
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, todos: [row('Own', 'Own work')] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'synthetic',
    signedIn: true,
    fetch,
  });
  return { client, release, personReads: () => personReads };
}
export const deniedVocabulary: typeof globalThis.fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  );
