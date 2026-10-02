// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// In the dock the task panel draws no Close of its own, so the dock's X, Close
// all and Escape are the closes a person has. Leaving a task with this person's
// timer running logs the time through time.stop once (MP-4-13, DP-07, D-33),
// as the panel's own close does.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const TASK = '.dpanel[data-panel-id="task"]';
const DOOR = '#perspective-panel-team [data-panel-door="log"]';

function storage(seed: Record<string, string>): StorageLike {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
}

const RUNNING = {
  entries: [],
  running: { entryId: 'e-run', startedAt: '2026-09-30T01:00:00.000Z' },
  totalMinutes: 0,
};

function world() {
  const sent: string[] = [];
  const fetch = ((url: string | URL) => {
    const where = String(url);
    if (where.endsWith('/time/stop')) sent.push('time.stop');
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (where.endsWith('/task/read')) {
      return Promise.resolve(json({ ok: true, task: task({ time: RUNNING }) }));
    }
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/time/stop')) {
      return Promise.resolve(json({ ok: true, recordId: null, revision: null, detail: {} }));
    }
    return Promise.resolve(json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

async function opened(sent: string[], fetch: typeof globalThis.fetch) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const view = await mount(
    <App
      path={`/task/${KEY}`}
      navigate={() => {}}
      sessions={new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  await tick();
  await view.click(DOOR);
  await tick();
  expect(view.host.querySelector(`${TASK} [data-task-panel]`)).not.toBeNull();
  expect(sent).toEqual([]);
  return view;
}

describe('the dock closes a task with my timer running and logs it', () => {
  it("the dock's X, the panel's one close, sends time.stop once", async () => {
    const { sent, fetch } = world();
    const view = await opened(sent, fetch);
    await view.click(`${TASK} [data-act="close"]`);
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(sent).toEqual(['time.stop']);
  });

  it('Close all sends time.stop once', async () => {
    const { sent, fetch } = world();
    const view = await opened(sent, fetch);
    await view.click('.dock__closeall');
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(sent).toEqual(['time.stop']);
  });

  it("the dock's Escape (focus outside the panel) sends time.stop once", async () => {
    const { sent, fetch } = world();
    const view = await opened(sent, fetch);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(sent).toEqual(['time.stop']);
  });

  it('control: Escape inside the panel (its own onClose, synchronous) sends time.stop once', async () => {
    const { sent, fetch } = world();
    const view = await opened(sent, fetch);
    const panel = view.host.querySelector(`${TASK} [data-task-panel]`) as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(sent).toEqual(['time.stop']);
  });
});
