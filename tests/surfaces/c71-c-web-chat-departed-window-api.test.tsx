// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A departed group's archive through the real API: a reader who leaves, is
// re-added and leaves again sees nothing from their first membership window,
// though the departed view carries no joinedAt to bound it: not once settled,
// not in any one commit, and not when no list saw the rejoin.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { createGroupWorld, type GroupWorld } from '../api/c71-g-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { asBrowser } from '../support/sign-in.ts';
import { mount, settle } from './mount.tsx';

/** A reader's browser transport to the real API, with the stream and message reads held here. */
function browser(g: GroupWorld, token: string) {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: Promise<Response>[] = [];
  const transport = { unavailable: false, messageReads: 0, markerWrites: 0, lists: 0, calls };
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
    if (url.endsWith('/chat/messages')) {
      transport.messageReads += 1;
      if (transport.unavailable)
        return Response.json({ error: 'temporarily down' }, { status: 503 });
    }
    if (url.endsWith('/chat/mark_read')) transport.markerWrites += 1;
    if (url.endsWith('/chat/conversations')) transport.lists += 1;
    const response = Promise.resolve(g.chat.harness.world.api.fetch(new Request(url, init)));
    transport.calls.push(response);
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

/** Every text the page commits from now on, kept even once React removes or rewrites it. */
function commitsTo(host: HTMLElement): () => string {
  const seen: string[] = [];
  const keep = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        seen.push(node.textContent ?? '');
      }
      if (record.type === 'characterData') {
        seen.push(record.target.textContent ?? '', record.oldValue ?? '');
      }
    }
  };
  const observer = new MutationObserver(keep);
  observer.observe(host, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
  });
  return () => {
    keep(observer.takeRecords());
    return seen.join('\n');
  };
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

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a second departure never commits a message from the earlier window, even for one render, through the real API',
  async () => {
    const w = await world('departedcommit');
    try {
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await w.change('remove');
      await w.change('add');
      w.transport.unavailable = true;
      await w.signal('conversation', 'board');
      await until(() => expect(w.page.text()).not.toContain(w.g.canary));
      await w.change('remove');
      const before = w.transport.messageReads;
      const committed = commitsTo(w.page.host);
      await w.signal('closed', `conversation:${w.g.conversationId}`);
      await until(() => expect(w.page.text()).toContain('You left this group.'));
      await until(() => expect(w.transport.messageReads).toBeGreaterThan(before));
      expect(committed()).toContain('You left this group.');
      expect(committed()).not.toContain(w.g.canary);
    } finally {
      await w.page.unmount();
      await w.g.chat.harness.close();
    }
  },
  180_000,
);

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a rejoin and departure no list saw cannot keep the earlier window drawn when the next read is unavailable, through the real API',
  async () => {
    const w = await world('departedunseen');
    try {
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await w.change('remove');
      await w.signal('closed', `conversation:${w.g.conversationId}`);
      await until(() => expect(w.page.text()).toContain('You left this group.'));
      // The first window's archive, read since the departure, is the server's to serve.
      await until(() => expect(w.page.text()).toContain(w.g.canary));
      await Promise.allSettled(w.transport.calls);
      const lists = w.transport.lists;
      await w.change('add');
      const later = 'a second-window message';
      expect((await w.g.say(w.g.chat.tess, later)).status).toBe(200);
      await w.change('remove');
      expect(w.transport.lists).toBe(lists);
      const view = await w.g.viewOf(w.mia);
      expect(view?.joinedAt).toBeNull();
      expect(view?.lastMessageAt).not.toBeNull();
      expect(await w.g.bodiesOf(w.mia)).toEqual([later]);
      w.transport.unavailable = true;
      const before = w.transport.messageReads;
      await w.signal('conversation', 'board');
      await until(() => expect(w.transport.messageReads).toBeGreaterThan(before));
      await Promise.allSettled(w.transport.calls);
      await settle();
      expect(w.page.text()).toContain('You left this group.');
      expect(w.page.text()).not.toContain(w.g.canary);
    } finally {
      await w.page.unmount();
      await w.g.chat.harness.close();
    }
  },
  180_000,
);
