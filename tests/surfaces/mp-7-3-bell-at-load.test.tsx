// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3 bell count at load (ORCH47 ruling (b)5): the dock's Notifications tab
// carries INB-1's owed figure with the first frame, on any agency screen, read
// from `inbox.count` in the frame's own load beside the person menu's name.
// The figure is the count's, never a tally; zero draws no badge, and a refused
// or failed count draws none rather than a zero. It follows the `board` topic,
// as `/inbox/` does, so it moves without a reload.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

function storage(seed: Record<string, string> = {}): StorageLike {
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every call the load makes, and a count the test chooses. */
function served(count: () => Response): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    calls.push(at);
    if (at.endsWith('/session/person')) return json({ ok: true, person: { name: 'Mia Hart' } });
    if (at.endsWith('/inbox/count')) return count();
    if (at.includes('/live')) return new Response(null, { status: 503 });
    if (at.endsWith('/team/list')) return json({ ok: true, team: [] });
    return json({ ok: false, code: 'NOT_FOUND' }, 404);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

async function open(fetch: typeof globalThis.fetch): Promise<Mounted> {
  const mounted = await mount(
    <App
      path="/team"
      navigate={() => {}}
      sessions={new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  await settle();
  await settle();
  return mounted;
}

const bell = (m: Mounted): Element | undefined =>
  m.all('.dock__tab').find((tab) => /Notifications/u.test(tab.getAttribute('aria-label') ?? ''));

describe('MP-7-3 bell count at load', () => {
  it("the Notifications tab carries inbox.count's figure with the first frame on a screen that is not /inbox/", async () => {
    const { fetch, calls } = served(() => json({ ok: true, owed: 7 }));
    view = await open(fetch);
    expect(bell(view)?.querySelector('.cbadge')?.textContent).toBe('7');
    expect(bell(view)?.getAttribute('aria-label')).toBe('Open Notifications, 7 unread');
    // The bell reads the count and nothing else of the inbox: no list behind it.
    expect(calls.filter((url) => url.includes('/inbox/'))).toEqual(['/api/b/alpha/inbox/count']);
    // It follows the board topic on the tab's one stream, as /inbox/ does.
    expect(calls.some((url) => url.includes('/live') && url.includes('topic=board'))).toBe(true);
  });

  it('nothing owed draws no badge, not a zero', async () => {
    const { fetch } = served(() => json({ ok: true, owed: 0 }));
    view = await open(fetch);
    expect(bell(view)).toBeDefined();
    expect(bell(view)?.querySelector('.cbadge')).toBeNull();
    expect(bell(view)?.getAttribute('aria-label')).toBe('Open Notifications');
  });

  it('a refused or failed count draws no figure at all', async () => {
    for (const reply of [
      () => json({ ok: false, code: 'NO_GRANT_AT_ALL' }, 403),
      () => new Response('down', { status: 503 }),
    ]) {
      const { fetch } = served(reply);
      // oxlint-disable-next-line no-await-in-loop
      view = await open(fetch);
      expect(bell(view)?.querySelector('.cbadge')).toBeNull();
      // oxlint-disable-next-line no-await-in-loop
      await view.unmount();
      view = undefined;
    }
  });
});
