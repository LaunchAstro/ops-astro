// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 (TR-A-4, carried from MP-4-3, MP-4-5 and MP-4-16): the task page's
// doors open the dock task panel on the matching perspective, the reply door
// on the same conversation tab, and a change made in the panel shows at once on
// the page. Driven through the real application: the address, the page, the
// shell's panel slot. The dock frame the panel will sit in is MP-3-1's (SL06
// U08, not on main); until then it is the shell's panel slot.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';

function storage(seed: Record<string, string>): StorageLike {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };

/** One task on a server that turns Ad hoc when told to, counting its reads. */
function server(): { readonly fetch: typeof globalThis.fetch; readonly reads: () => number } {
  let adHoc = false;
  let reads = 0;
  const fetch = ((url: string | URL) => {
    const where = String(url);
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (where.includes('/live/task/')) return Promise.resolve(new Response(null, { status: 404 }));
    if (where.endsWith('/task/read')) {
      reads += 1;
      return Promise.resolve(json({ ok: true, task: task({ adHoc }) }));
    }
    if (where.endsWith('/task/set_adhoc')) {
      adHoc = true;
      return Promise.resolve(json({ recordId: 'r', revision: 5 }));
    }
    throw new Error(`unrouted ${where}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, reads: () => reads };
}

const app = async (fetch: typeof globalThis.fetch) => {
  const view = await mount(
    <App
      path={`/task/${KEY}`}
      navigate={() => undefined}
      sessions={new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  await tick();
  return view;
};

const PAGE = 'main .content';

describe('MP-4-8 task page doors open the panel', () => {
  it('no panel until a door is pressed; then the panel opens on Team', async () => {
    const view = await app(server().fetch);
    expect(view.find('[data-task-panel]')).toBeNull();
    await view.click(`#perspective-panel-team [data-panel-door="log"]`);
    await tick();
    expect(view.find('[data-task-panel] [data-panel-title]')?.textContent).toBe(
      'Budget pacing fix',
    );
    expect(view.find('#panel-perspective-tab-team')?.getAttribute('aria-selected')).toBe('true');
    await view.unmount();
  });

  it('the reply door opens the panel on the conversation tab showing on the page', async () => {
    const view = await app(server().fetch);
    await view.click('#conversation-tab-client');
    await view.click('[data-panel-door="reply"]');
    await tick();
    expect(view.find('#panel-conversation-tab-client')?.getAttribute('aria-selected')).toBe('true');
    await view.unmount();
  });

  it('a change made in the panel shows at once on the page', async () => {
    const { fetch, reads } = server();
    const view = await app(fetch);
    await view.click('[data-panel-door="open"]');
    await tick();
    const before = reads();
    expect(view.find(`${PAGE} .tpr__facts [data-mark="adhoc"]`)?.getAttribute('data-on')).toBe(
      'no',
    );
    await view.click('[data-task-panel] [data-tick="adhoc"]');
    await tick();
    expect(reads()).toBeGreaterThan(before + 1);
    expect(view.find(`${PAGE} .tpr__facts [data-mark="adhoc"]`)?.getAttribute('data-on')).toBe(
      'yes',
    );
    await view.unmount();
  });

  it('closing the panel returns focus to the door that opened it', async () => {
    const view = await app(server().fetch);
    const door = '#perspective-panel-team [data-panel-door="timer"]';
    await view.click(door);
    await tick();
    await view.click('[data-panel-head="close"]');
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(document.activeElement).toBe(view.find(door));
    await view.unmount();
  });
});
