// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// P11: someone in another session changes the business's priority stages.
// The server says `resync` on the board topic (the board's live digest moved),
// and this tab's open board and task panel re-read and show the new ranks
// without a reload or a wait for the 30-second floor.

import { act } from 'react';
import { expect, it } from 'vitest';
import { nestedAppHost } from './nested-task-app-support.tsx';
import { task, tick } from './task-page-stub.tsx';

const TRUST = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ordinary = 'impact 7 × confidence 9 × ease 8 = 504 · derived';
const prioritised = 'impact 7 × confidence 9 × ease 8 = 504 × priority 1.25 = 630 · derived';

function boardItem(id: string, key: string, rank: { number: number; score: number; calc: string }) {
  return Object.assign({}, task({ id, key, title: key, time: null, rank }), {
    actualMinutes: 0,
    estimateMinutes: null,
    statePosition: null,
    waitReason: null,
    awaitingDecision: false,
    agent: null,
    myAgents: [],
    comments: { client: 0, mentions: 0, latest: null },
  });
}

const SECOND = { number: 1, score: 560, calc: 'impact 7 × confidence 10 × ease 8 = 560' };

/** Ranks as the server derives them, before and after the other session's change. */
function ranksFor(trustIsPriority: boolean) {
  return trustIsPriority
    ? { trust: { number: 1, score: 630, calc: prioritised }, other: { ...SECOND, number: 2 } }
    : { trust: { number: 2, score: 504, calc: ordinary }, other: SECOND };
}

/** The server's side: the stages as the other session last left them, and the open streams. */
function server() {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const state = { trustIsPriority: false };
  const read = (path: string): unknown => {
    const ranks = ranksFor(state.trustIsPriority);
    if (path === '/task/board') {
      const tasks = [
        boardItem(TRUST, 'Trust-task', ranks.trust),
        boardItem(OTHER, 'Other-task', ranks.other),
      ];
      return { ok: true, tasks, viewer: null };
    }
    if (path !== '/task/read') return null;
    return { ok: true, task: task({ id: TRUST, key: 'Trust-task', rank: ranks.trust }) };
  };
  const stream = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => void streams.add(controller),
        cancel: () => {
          for (const one of streams) if (one.desiredSize === null) streams.delete(one);
        },
      }),
    );
  return {
    state,
    reply: (sent: { readonly path: string }): Promise<Response> | undefined => {
      if (sent.path.includes('/live?')) return Promise.resolve(stream());
      const body = read(sent.path);
      return body === null ? undefined : Promise.resolve(Response.json(body));
    },
    /** What the board's live digest says when it moved: one content-free frame. */
    resync: () => {
      for (const controller of streams) {
        try {
          controller.enqueue(new TextEncoder().encode('event: resync\ndata: board\n\n'));
        } catch {
          streams.delete(controller);
        }
      }
    },
  };
}

const rankOf = (host: HTMLElement, id: string): string | undefined =>
  host.querySelector(`main tr[data-row="${id}"] td[data-key="rank"]`)?.textContent ?? undefined;

it('a priority stages change in another session re-ranks the open board and task panel at once', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
  const world = server();
  const app = await nestedAppHost({ reply: world.reply });
  await tick();
  expect(rankOf(app.view.host, TRUST)).toBe('2');
  expect(rankOf(app.view.host, OTHER)).toBe('1');
  await act(() => {
    app.view
      .find(`main tr[data-row="${TRUST}"] td[data-key="rank"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await tick();
  const panel = app.view.find(`.dpanel[data-panel-id="task"]`);
  expect(panel?.textContent).toContain(ordinary);
  const boards = app.sent.filter((one) => one.path === '/task/board').length;
  const reads = app.sent.filter((one) => one.path === '/task/read').length;

  world.state.trustIsPriority = true;
  await act(() => {
    world.resync();
  });
  await tick();

  expect(app.sent.filter((one) => one.path === '/task/board').length).toBeGreaterThan(boards);
  expect(app.sent.filter((one) => one.path === '/task/read').length).toBeGreaterThan(reads);
  expect(rankOf(app.view.host, TRUST)).toBe('1');
  expect(rankOf(app.view.host, OTHER)).toBe('2');
  expect(app.view.find(`.dpanel[data-panel-id="task"]`)?.textContent).toContain(prioritised);
});
