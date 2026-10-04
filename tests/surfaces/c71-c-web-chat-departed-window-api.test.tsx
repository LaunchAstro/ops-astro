// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A departed group's archive through the real API: a reader who leaves, is
// re-added and leaves again sees nothing from their first membership window,
// though the departed view carries no joinedAt to bound it.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { createGroupWorld } from '../api/c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { asBrowser } from '../support/sign-in.ts';
import { mount, settle } from './mount.tsx';

async function world(part: string) {
  const g = await createGroupWorld(part);
  const { mia, ada, alpha, db } = g.chat.harness.world;
  const personId = mia.personId;
  const actorId = ada.actorId;
  if (personId === null || actorId === null) throw new Error('fixture needs a person and grantor');
  await db.app.withBusiness(alpha, async (tx) => {
    const granted = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      collection: 'person',
      action: 'read',
      scope: { kind: 'business', id: null },
      parentGrantId: null,
      grantedByActorId: actorId,
    });
    expect(granted.ok).toBe(true);
  });
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: Promise<Response>[] = [];
  const transport = { unavailable: false, messageReads: 0, markerWrites: 0, calls };
  const fetch: typeof globalThis.fetch = asBrowser(mia.token, async (input, init) => {
    const url = String(input);
    if (url.includes('/live?'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    if (url.endsWith('/chat/messages')) {
      transport.messageReads += 1;
      if (transport.unavailable)
        return Response.json({ error: 'temporarily down' }, { status: 503 });
    }
    if (url.endsWith('/chat/mark_read')) transport.markerWrites += 1;
    const response = Promise.resolve(g.chat.harness.world.api.fetch(new Request(url, init)));
    transport.calls.push(response);
    return await response;
  });
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
  });
  const page = await mount(<TeamScreen client={client} grantKey="alpha:mia" />);
  const signal = async (event: string, topic: string): Promise<void> => {
    await act(() => {
      if (stream === undefined) throw new Error('no stream');
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${topic}\n\n`));
    });
  };
  const change = async (side: 'add' | 'remove'): Promise<void> => {
    const result = await g.as(g.chat.tess, 'chat.change_members', {
      conversationId: g.conversationId,
      [side]: [mia.personId],
    });
    expect(result.status, result.text).toBe(200);
  };
  return { g, mia, page, transport, signal, change };
}

async function until(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await settle();
      check();
    },
    { timeout: 10_000, interval: 10 },
  );
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'person to person departure after a rejoin cannot resurrect an earlier membership window through the real API',
  async () => {
    const w = await world('sol368r3window');
    try {
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await w.change('remove');
      await w.change('add');
      w.transport.unavailable = true;
      await w.signal('conversation', 'board');
      await until(() => expect(w.page.text()).not.toContain(w.g.canary));
      await w.change('remove');
      const view = await w.g.viewOf(w.mia);
      expect(view?.joinedAt).toBeNull();
      expect(view?.lastMessageAt).toBeNull();
      expect(await w.g.bodiesOf(w.mia)).toEqual([]);
      const before = w.transport.messageReads;
      await w.signal('closed', `conversation:${w.g.conversationId}`);
      await until(() => expect(w.page.text()).toContain('You left this group.'));
      await until(() => expect(w.transport.messageReads).toBeGreaterThan(before));
      expect(w.page.text()).not.toContain(w.g.canary);
    } finally {
      await w.page.unmount();
      await w.g.chat.harness.close();
    }
  },
  180_000,
);
