// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Any `[data-new-task]` control opens a new-task draft in the dock's Task
// panel. The client face draws no dock (R17), so a door there must open
// nothing: a draft opened there would wait unseen and appear on the next Hub
// page as if the person had asked for it.

import { act, useState, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { granted } from './mp-2-1-support.tsx';
import { tick } from './task-page-stub.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const pending = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;

function memory(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
}

it('a new-task door on the client face opens no draft, then or on the next Hub page', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
  let go: ((path: string) => void) | undefined;
  const storage = memory();
  function Harness(): ReactElement {
    const [path, setPath] = useState('/portal/acme-dental/');
    go = setPath;
    return (
      <App
        path={path}
        navigate={setPath}
        sessions={new SessionStore(storage)}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={pending}
        storage={storage as Storage}
        clientAccess={granted}
      />
    );
  }
  const view = await mount(<Harness />);
  expect((view.find('.appbar') as HTMLElement | null)?.dataset['face']).toBe('client');
  const door = document.createElement('button');
  door.dataset['newTask'] = 'Checkout down';
  view.host.querySelector('main')?.append(door);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    door.dispatchEvent(click);
    await Promise.resolve();
  });
  expect(click.defaultPrevented, 'no dock took the click').toBe(false);

  await act(async () => {
    go?.('/projects/');
    await Promise.resolve();
  });
  await tick();
  expect(view.all('.dock__tab').length).toBeGreaterThan(0);
  expect(view.find('[data-draft-panel]')).toBeNull();
});
