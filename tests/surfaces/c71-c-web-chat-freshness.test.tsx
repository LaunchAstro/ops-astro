// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { nudgeTeamUnread, useTeamUnread } from '../../apps/web/src/data/dock-counts.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount, settle } from './mount.tsx';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-01T10:00:00.000Z';
const conversation = {
  conversationId: ID,
  kind: 'direct',
  name: null,
  members: ['p-me', 'p-bo'],
  lastRead: null,
  lastMessageAt: AT,
  unread: 1,
};
const message = { id: 'm1', authorId: 'p-bo', author: 'Bo Reyes', at: AT, body: 'private canary' };
const json = (value: unknown, status = 200): Response => Response.json(value, { status });
const listed = (unread = 1): Response =>
  json({ ok: true, conversations: [{ ...conversation, unread }] });
const refusal = (): Response =>
  json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: ['chat:comment'], fixes: [] }, 403);

function notInitialised(): never {
  throw new Error('not initialised');
}

function deferred(): { promise: Promise<Response>; resolve: (answer: Response) => void } {
  let resolve: (answer: Response) => void = notInitialised;
  const promise = new Promise<Response>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
}

function server() {
  const pending: ReturnType<typeof deferred>[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/live?')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    }
    if (url.endsWith('/chat/conversations')) {
      const read = deferred();
      pending.push(read);
      return await read.promise;
    }
    if (url.endsWith('/team/list'))
      return json({
        ok: true,
        you: 'p-me',
        people: [
          { personId: 'p-me', name: 'Ana Bell', availability: null },
          { personId: 'p-bo', name: 'Bo Reyes', availability: null },
        ],
      });
    if (url.endsWith('/chat/messages'))
      return json({ ok: true, conversationId: ID, lastRead: null, messages: [message] });
    throw new Error(`unexpected ${url}`);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    pending,
    client,
    signal: (event = 'invalidate') => {
      if (stream === undefined) throw new Error('no stream');
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: board\n\n`));
    },
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each answer lands before the next effect
    await settle();
  }
}

it('a server conversation board event refreshes the Team unread chip', async () => {
  const api = server();
  const session: Session = { businessKey: 'alpha', email: 'ana@example.test' };
  function Chip(): ReactElement {
    const n = useTeamUnread(api.client, session, true);
    return <b data-chip>{n === null ? 'none' : n}</b>;
  }
  const page = await mount(<Chip />);
  api.pending[0]?.resolve(listed(1));
  await flush();
  expect(page.text()).toBe('1');
  await act(() => {
    api.signal('conversation');
  });
  await flush();
  api.pending[1]?.resolve(listed(2));
  await flush();
  expect(page.text()).toBe('2');
});

it('person to person chat access refusal cannot be undone by an older list response', async () => {
  const api = server();
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  api.pending[0]?.resolve(listed());
  await flush();
  expect(page.text()).toContain('private canary');
  await act(() => {
    api.signal();
  });
  await flush();
  expect(api.pending).toHaveLength(2);
  await act(() => {
    api.signal();
  });
  await flush();
  expect(api.pending).toHaveLength(3);
  api.pending[2]?.resolve(refusal());
  await flush();
  expect(page.text()).not.toContain('private canary');
  api.pending[1]?.resolve(listed());
  await flush();
  expect(page.text()).not.toContain('private canary');
});

it('an older Team unread response cannot overwrite the newer count', async () => {
  const api = server();
  const session: Session = { businessKey: 'alpha', email: 'ana@example.test' };
  function Chip(): ReactElement {
    const n = useTeamUnread(api.client, session, true);
    return <b data-chip>{n === null ? 'none' : n}</b>;
  }
  const page = await mount(<Chip />);
  api.pending[0]?.resolve(listed(1));
  await flush();
  expect(page.text()).toBe('1');
  await act(() => {
    nudgeTeamUnread(api.client);
    nudgeTeamUnread(api.client);
  });
  expect(api.pending).toHaveLength(3);
  api.pending[2]?.resolve(listed(0));
  await flush();
  expect(page.text()).toBe('0');
  api.pending[1]?.resolve(listed(1));
  await flush();
  expect(page.text()).toBe('0');
});

it('recovery from the first unavailable chat read opens the first unread conversation', async () => {
  const api = server();
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  api.pending[0]?.resolve(json({ error: 'temporarily down' }, 503));
  await flush();
  await act(() => {
    api.signal();
  });
  await flush();
  expect(api.pending).toHaveLength(2);
  api.pending[1]?.resolve(listed());
  await flush();
  expect(page.find('[data-person="p-bo"] .cbadge')?.textContent).toBe('1');
  expect(page.find('.tmc__conv [data-message="m1"]')).not.toBeNull();
});
