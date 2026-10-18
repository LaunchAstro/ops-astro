// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The server registers a refusal under its operation id and replays it, so a
// Retry after a known refusal must be a new request. A lost answer may hide a
// stored Start, so its Retry is the same request. A lost Start whose retry is
// refused can only be let go by the person, and letting go clears its copy.
import { expect, it } from 'vitest';
import { timerWorld } from './task-bound-timer-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';

const TIMER = 'ops-astro.task-timer';
const STRIP = '[data-task-timer-strip] [data-timer]';
const PAGE = 'main [data-time-log-section] [data-timer]';
const RETRY = '[data-task-timer-retry]';
const REFUSED = { refused: true, code: 'TRANSITION_NOT_PERMITTED', names: [], fixes: [] };

/** Starts answer as `mode` says; a refused id is registered and replayed as refused. */
function startServer() {
  const world = timerWorld();
  const registered = new Set<string>();
  const starts: string[] = [];
  const control = { mode: 'apply' as 'apply' | 'refuse' | 'unreached' };
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (!String(url).endsWith('/time/start')) return world.fetch(url, init);
    const id = String((JSON.parse(String(init?.body)) as { operationId: unknown }).operationId);
    starts.push(id);
    if (registered.has(id) || control.mode === 'refuse') {
      registered.add(id);
      return Promise.resolve(new Response(JSON.stringify(REFUSED), { status: 409 }));
    }
    if (control.mode === 'unreached') return Promise.reject(new TypeError('Failed to fetch'));
    return world.fetch(url, init);
  };
  return { world, starts, control, fetch };
}

function button(view: Awaited<ReturnType<typeof realm>>['view'], words: RegExp) {
  return view
    .all('button')
    .find((one): one is HTMLButtonElement => words.test(one.textContent ?? ''));
}

it('Retry after a refused timer Start sends a new request the server judges afresh', async () => {
  const server = startServer();
  server.control.mode = 'refuse';
  const app = await realm(server.fetch);
  await app.view.click(PAGE);
  await app.tick();
  expect(app.view.text()).toContain('Timer change refused');
  // The person stops the timer running elsewhere, then presses Retry.
  server.control.mode = 'apply';
  await app.view.click(RETRY);
  await app.tick();
  expect(server.starts).toHaveLength(2);
  expect(server.starts[1]).not.toBe(server.starts[0]);
  expect(app.view.find(STRIP)?.textContent).toContain('Stop');
});

it('Retry after a lost timer answer sends the same request again', async () => {
  const server = startServer();
  server.world.loseStart();
  const app = await realm(server.fetch);
  await app.view.click(PAGE);
  await app.tick();
  expect(app.view.text()).toContain('Timer outcome unknown');
  await app.view.click(RETRY);
  await app.tick();
  expect(server.starts).toHaveLength(2);
  expect(server.starts[1]).toBe(server.starts[0]);
  expect(app.view.find(STRIP)?.textContent).toContain('Stop');
});

it('A lost Start whose retry is refused can be let go, freeing Start and clearing its copy', async () => {
  const server = startServer();
  server.control.mode = 'unreached';
  const app = await realm(server.fetch);
  await app.view.click(PAGE);
  await app.tick();
  // Meanwhile a timer was started in another tab, so the retry is refused.
  server.control.mode = 'refuse';
  await app.view.click(RETRY);
  await app.tick();
  expect(server.starts).toEqual([server.starts[0], server.starts[0]]);
  expect(app.storage.getItem(TIMER)).toContain(server.starts[0]);
  const letGo = button(app.view, /stop waiting/iu);
  expect(letGo, 'a held Start whose retry was refused offers Stop waiting').toBeDefined();
  await app.act(() => letGo?.click());
  await app.tick();
  expect(app.storage.getItem(TIMER)).toBeNull();
  expect(app.view.find(RETRY)).toBeNull();
  expect(app.view.find(PAGE)).toHaveProperty('disabled', false);
  expect(app.view.find(STRIP)).toHaveProperty('disabled', false);
  expect(server.starts).toHaveLength(2);
});

it('A let-go Start whose saved copy cannot be removed keeps Start locked until Clear saved copy removes it', async () => {
  const server = startServer();
  server.control.mode = 'unreached';
  const app = await realm(server.fetch);
  await app.view.click(PAGE);
  await app.tick();
  server.control.mode = 'refuse';
  await app.view.click(RETRY);
  await app.tick();
  const saved = app.storage.getItem(TIMER);
  const remove = app.storage.removeItem.bind(app.storage);
  let blocked = true;
  app.storage.removeItem = (key) => {
    if (blocked && key === TIMER) throw new Error('storage blocked');
    remove(key);
  };
  await app.act(() => button(app.view, /stop waiting/iu)?.click());
  await app.tick();
  expect(app.view.text()).toContain(
    'This change was let go, but this browser could not clear its saved copy yet.',
  );
  expect(app.view.find(RETRY)).toBeNull();
  expect(app.view.find(PAGE)).toHaveProperty('disabled', true);
  expect(app.storage.getItem(TIMER)).toBe(saved);
  blocked = false;
  await app.act(() => button(app.view, /clear saved copy/iu)?.click());
  await app.tick();
  expect(app.storage.getItem(TIMER)).toBeNull();
  expect(app.view.find(PAGE)).toHaveProperty('disabled', false);
  expect(server.starts).toHaveLength(2);
});
