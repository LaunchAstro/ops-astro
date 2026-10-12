// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C71 team chat, the web half: Team drawn at an address that asks for a
// conversation (a mention's door) opens it, and a new request in a Team screen
// already open moves to the new conversation. The server is a stand-in.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const DIRECT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const BO_SAID = { authorId: 'p-bo', author: 'Bo Reyes', at: '2026-10-01T10:00:00.000Z' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The chat reads the Team screen opens on: Ana and Bo, direct and in "Shoot crew". */
function chatRead(at: string, body: Record<string, unknown>): Response | null {
  if (at.endsWith('/team/list')) {
    const people = [
      { personId: 'p-me', name: 'Ana Bell', availability: null },
      { personId: 'p-bo', name: 'Bo Reyes', availability: null },
    ];
    return json({ ok: true, you: 'p-me', people });
  }
  if (at.endsWith('/chat/conversations')) {
    const conversations = [DIRECT, GROUP].map((conversationId) => ({
      conversationId,
      kind: conversationId === GROUP ? 'group' : 'direct',
      name: conversationId === GROUP ? 'Shoot crew' : null,
      members: ['p-me', 'p-bo'],
      lastRead: null,
      lastMessageAt: BO_SAID.at,
      unread: 1,
    }));
    return json({ ok: true, conversations });
  }
  if (!at.endsWith('/chat/messages')) return null;
  const conversationId = String(body['conversationId']);
  const messages = [{ id: `m-${conversationId}`, ...BO_SAID, body: 'Ready?' }];
  return json({ ok: true, conversationId, lastRead: null, messages });
}

/** The API behind the Team screen, every chat command answered `failure`. */
function sendsFail(failure: () => Response): OperationsClient {
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.includes('/live')) {
      const stream = new ReadableStream<Uint8Array>();
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return chatRead(at, body) ?? failure();
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
}

async function until(say: string, done: () => boolean, deadline = Date.now() + 2000) {
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
    // oxlint-disable-next-line no-await-in-loop -- waiting on the stand-in's answers, one at a time
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    });
  }
}

const FIELD = '.tmc__conv .composer input';
const typed = (m: Mounted): string | undefined =>
  (m.host.querySelector(FIELD) as HTMLInputElement | null)?.value;

const refused = (): Response =>
  json({ refused: true, code: 'NOT_FOUND', names: [], fixes: ['Bo cannot be messaged.'] }, 422);

/* eslint-disable unicorn/no-array-callback-reference -- Sol's proof, kept as written */
// Sol's proof on #1378 (round 2), retitled by what it proves; its body is Sol's.
it('another mention changes the conversation in an already open Team screen', async () => {
  const client = sendsFail(refused);
  mounted = await mount(
    <TeamScreen client={client} grantKey="alpha:ana" address={`/team/?conversation=${DIRECT}`} />,
  );
  const m = mounted;
  await until('the requested direct conversation', () => typed(m) !== undefined);
  expect(m.find(FIELD)?.getAttribute('aria-label')).toBe('Message Bo');
  await m.render(
    <TeamScreen client={client} grantKey="alpha:ana" address={`/team/?conversation=${GROUP}`} />,
  );
  expect(m.find(FIELD)?.getAttribute('aria-label')).toBe('Message Shoot crew');
});
/* eslint-enable unicorn/no-array-callback-reference */
