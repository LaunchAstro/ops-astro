// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat: a send the API refuses or cannot answer keeps its words, still
// to send, after the person moves to another conversation and back. Direct
// and group conversations sit at different places in the panel, so a switch
// unmounts the composer; the words must not live only there. They never show
// in the other conversation's composer. Sol's design-check finding F1 on
// p17-chat-outbox-graduate-reconcile (#1448), as a failing test.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

async function sendAndFail(m: Mounted, said: string): Promise<void> {
  await m.type(FIELD, said);
  await act(() => {
    m.host
      .querySelector('.tmc__conv form.composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await until('the failure said', () => m.find('[role="alert"]') !== null);
}

const refused = (): Response =>
  json({ refused: true, code: 'NOT_FOUND', names: [], fixes: ['Bo cannot be messaged.'] }, 422);
const unanswered = (): Response => json({ error: 'busy' }, 503);

const CANARY = 'unsent message canary';

const talkingTo = (m: Mounted): string | null => m.find(FIELD)?.getAttribute('aria-label') ?? null;

/** The words are in this conversation's composer, or in an unsent entry under its thread. */
const kept = (m: Mounted): boolean =>
  typed(m) === CANARY ||
  m.all('.tmc__conv .tmc__unsent').some((entry) => entry.textContent?.includes(CANARY) === true);

describe('a failed send keeps its words across a switch of conversation', () => {
  it.each([
    { outcome: 'refuses', failure: refused },
    { outcome: 'cannot answer', failure: unanswered },
  ] as const)(
    'a direct send the API $outcome is still there after opening the group and coming back',
    async ({ failure }) => {
      mounted = await mount(<TeamScreen client={sendsFail(failure)} grantKey="alpha:ana" />);
      const m = mounted;
      await until('the conversation with Bo open', () => typed(m) !== undefined);
      await sendAndFail(m, CANARY);
      await m.click(`.tmc__g[data-group="${GROUP}"]`);
      await until('the group open', () => talkingTo(m) === 'Message Shoot crew');
      expect(typed(m)).toBe('');
      await m.click('[data-person="p-bo"] .tmc__face');
      await until('the conversation with Bo open again', () => talkingTo(m) === 'Message Bo');
      expect(kept(m)).toBe(true);
      expect(m.all('.tmc__conv .msg__text').map((t) => t.textContent)).toEqual(['Ready?']);
    },
  );
});
