// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-4: the gesture law for every open. The tab's own rule, and every other
// door into the dock (a row, a route, a badge, the ask seam, a task icon),
// which declares its target with `data-dock-open` (and `data-ask` for the
// assistant) and obeys the same law: plain solos, shift stacks, and a target
// already open is left open while its view moves.

import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const pending = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;

function memory(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
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

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function at(path = '/projects/'): Promise<Mounted> {
  const storage = memory();
  const page = await mount(
    <App
      path={path}
      navigate={() => {}}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={pending}
      storage={storage as Storage}
    />,
  );
  live.push(page);
  return page;
}

async function clickOn(target: Element | null, shiftKey = false): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  });
}

const tab = (page: Mounted, id: string): Element | null =>
  page.find(`.dock__tab[data-panel="${id}"]`);
const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);
/** A door into the dock drawn on the page, as a row or badge would be. */
function door(page: Mounted, attributes: Readonly<Record<string, string>>): HTMLElement {
  const button = document.createElement('button');
  for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
  (page.find('.content') as HTMLElement).append(button);
  return button;
}

// Sol OW-080.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('the shipped Agent panel opens from the ask seam', async () => {
  const page = await at();
  expect(tab(page, 'ai')).not.toBeNull();
  await clickOn(door(page, { 'data-ask': 'What changed this week?' }));
  expect(openIds(page)).toEqual(['ai']);
});
