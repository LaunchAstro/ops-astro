// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The task panel's timer stop outlives the panel's body, so a close the
// person does not press still logs the time. It belongs to the business and
// person whose timer it was: after a switch, opening a task in the next
// business's panel sends no time.stop for the old one, and the next
// business's own stop goes once, to that business.

import { act, useState, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { pathTo } from '../../apps/web/src/routes.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { task } from './task-page-stub.tsx';
import { mount, unmountAll } from './perspective-support.tsx';
import { json, settle, storage } from './mp-2-1-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const TASK = '.dpanel[data-panel-id="task"]';
const DOOR = '#perspective-panel-team [data-panel-door="log"]';
const HELD = {
  'ops-astro.return-to': JSON.stringify({
    address: `/task/${KEY}`,
    businessKey: 'bravo',
    code: 'AUTH_SESSION_EXPIRED',
  }),
};

const RUNNING = {
  entries: [],
  running: { entryId: 'e-run', startedAt: '2026-09-30T01:00:00.000Z' },
  totalMinutes: 0,
};

/** The sign-in, and a running task in every business; each time.stop is kept with its address. */
function world() {
  const stops: string[] = [];
  const answer = (where: string): Response => {
    if (where.startsWith('http://identity.invalid/token')) {
      return json({ access_token: 'fresh-token' });
    }
    if (where === '/api/session') return json({ ok: true, session: 'fresh-session' });
    if (where.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    if (where.includes('/session/capabilities')) {
      return json({ ok: true, personId: 'p', businessKey: 'bravo', grants: [] });
    }
    if (where.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (where.endsWith('/task/queue')) {
      return json({ ok: true, queue: [], alerts: [], outages: [] });
    }
    if (/\/live(\/task\/|\?|$)/u.test(where)) return new Response(null, { status: 404 });
    if (where.endsWith('/task/read')) return json({ ok: true, task: task({ time: RUNNING }) });
    if (where.endsWith('/task/board')) return json({ ok: true, tasks: [] });
    if (where.endsWith('/time/stop')) {
      stops.push(where);
      return json({ ok: true, recordId: null, revision: null, detail: {} });
    }
    return json({ ok: false });
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch;
  return { stops, fetch };
}

/** The page's navigate, kept so the case can move the address as the person would. */
let go: (path: string) => void = () => {};

async function visit(path: string): Promise<void> {
  await act(async () => {
    go(path);
    await Promise.resolve();
  });
  await settle();
}

/** Signed in to Alpha with a held Bravo address, so the board offers the switch. */
async function signedInToAlpha(fetch: typeof globalThis.fetch) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const tab = storage(HELD);
  const sessions = new SessionStore(tab.like);
  function Harness(): ReactElement {
    const [path, setPath] = useState('/sign-in');
    go = setPath;
    return (
      <App
        path={path}
        navigate={setPath}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={fetch}
        storage={tab.like as Storage}
        clientAccess={() => true}
      />
    );
  }
  const view = await mount(<Harness />);
  await view.choose('#signin-business', 'alpha');
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'whatever-it-is');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  expect(sessions.session?.businessKey).toBe('alpha');
  return { view, sessions };
}

it("after a business switch the old business's held stop sends nothing, and the next one's goes once", async () => {
  const { stops, fetch } = world();
  const { view, sessions } = await signedInToAlpha(fetch);
  await visit(`/task/${KEY}`);
  await view.click(DOOR);
  await settle();
  expect(view.host.querySelector(`${TASK} [data-task-panel]`)).not.toBeNull();
  // The switch is offered on the board; the panel stays open in the dock.
  await visit(pathTo('agency:projects-board'));
  expect(view.host.querySelector(`${TASK} [data-task-panel]`)).not.toBeNull();

  await view.click('[data-switch="held-address"]');
  await settle();
  expect(sessions.session?.businessKey).toBe('bravo');
  expect(stops, 'the switch stops nothing').toEqual([]);
  await view.click(DOOR);
  await settle();
  expect(view.host.querySelector(`${TASK} [data-task-panel]`)).not.toBeNull();
  expect(stops, 'opening a task in the next business stops nothing').toEqual([]);

  await view.click('.dock__closeall');
  await settle();
  expect(stops).toHaveLength(1);
  expect(stops[0]).toContain('/bravo/');
});
