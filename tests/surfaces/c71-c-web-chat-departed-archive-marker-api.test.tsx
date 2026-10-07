// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A departed group's archive through the real API: the reader may still read
// what they had, but the server refuses a departed member's read marker, so
// reading the archive sends no marker write and shows no refusal. A browser
// refresh that lands the list before the archive's read keeps the archive.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { createGroupWorld, type GroupWorld } from '../api/c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { asBrowser } from '../support/sign-in.ts';
import { mount, settle } from './mount.tsx';

/** A reader's browser transport to the real API: the stream, marker writes and held chat reads. */
function browser(g: GroupWorld, token: string) {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: Promise<Response>[] = [];
  const held = { lists: [] as (() => void)[], messages: [] as (() => void)[] };
  const transport = { markerWrites: 0, calls, holding: false, held };
  const fetch: typeof globalThis.fetch = asBrowser(token, async (input, init) => {
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
    if (url.endsWith('/chat/mark_read')) transport.markerWrites += 1;
    const response = Promise.resolve(g.chat.harness.world.api.fetch(new Request(url, init)));
    transport.calls.push(response);
    const queue = url.endsWith('/chat/conversations')
      ? held.lists
      : url.endsWith('/chat/messages')
        ? held.messages
        : undefined;
    // A held read answers as the server did when asked, once released.
    if (transport.holding && queue !== undefined) {
      await new Promise<void>((go) => {
        queue.push(go);
      });
    }
    return await response;
  });
  const signal = async (event: string, topic: string): Promise<void> => {
    await act(() => {
      if (stream === undefined) throw new Error('no stream');
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${topic}\n\n`));
    });
  };
  return { transport, fetch, signal };
}

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
  const { transport, fetch, signal } = browser(g, mia.token);
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
  });
  const page = await mount(<TeamScreen client={client} grantKey="alpha:mia" />);
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
  'reading a departed group archive does not submit a refused marker write through the real API',
  async () => {
    const w = await world('c71cmarker');
    try {
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await w.change('remove');
      await w.signal('closed', `conversation:${w.g.conversationId}`);
      await until(() => expect(w.page.text()).toContain('You left this group.'));
      expect(w.page.find('.tmc__conv .composer')).toBeNull();
      // Read the archive once it draws what the reader had, as a person would.
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await w.page.click('.tmc__conv .tmc__scroll');
      // Drain the real read-marker call so the visible API refusal is evidence too.
      await act(async () => {
        await Promise.all(w.transport.calls);
      });
      await settle();
      expect.soft(w.transport.markerWrites).toBe(0);
      expect.soft(w.page.find('[role="alert"]')).toBeNull();
    } finally {
      await w.page.unmount();
      await w.g.chat.harness.close();
    }
  },
  180_000,
);

/** Releases every held answer in `queue`, then lets the page take them in and commit. */
async function release(calls: readonly Promise<Response>[], queue: (() => void)[]): Promise<void> {
  expect(queue.length).toBeGreaterThan(0);
  await act(async () => {
    for (const go of queue.splice(0)) go();
    await Promise.allSettled(calls);
    await new Promise<void>((done) => {
      setTimeout(done, 0);
    });
  });
  await settle();
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a browser refresh that answers the list before the archive keeps a departed group archive drawn through the real API',
  async () => {
    const w = await world('c71carchiverefresh');
    try {
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await w.change('remove');
      await w.signal('closed', `conversation:${w.g.conversationId}`);
      await until(() => expect(w.page.text()).toContain('You left this group.'));
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await act(async () => {
        await Promise.allSettled(w.transport.calls);
      });
      const before = await w.g.viewOf(w.mia);
      expect(before?.members).toEqual([]);
      expect(before?.joinedAt).toBeNull();
      w.transport.holding = true;
      await act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await until(() => expect(w.transport.held.lists.length).toBeGreaterThan(0));
      await until(() => expect(w.transport.held.messages.length).toBeGreaterThan(0));
      w.transport.holding = false;
      // The list answers first, unchanged; the archive's read is still out.
      expect(await w.g.viewOf(w.mia)).toEqual(before);
      await release(w.transport.calls, w.transport.held.lists);
      expect(w.page.text()).toContain(w.g.canary);
      // Then the archive's read answers, as it did, and no list event follows.
      await release(w.transport.calls, w.transport.held.messages);
      await act(async () => {
        await Promise.allSettled(w.transport.calls);
      });
      await settle();
      expect(w.page.text()).toContain('You left this group.');
      expect(w.page.text()).toContain(w.g.canary);
      expect(w.transport.markerWrites).toBe(0);
    } finally {
      await w.page.unmount();
      await w.g.chat.harness.close();
    }
  },
  180_000,
);
