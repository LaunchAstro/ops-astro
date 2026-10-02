// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-3's application harness: the app signed in on the Projects board at a
// chosen window width, the person's rail kept in the tab's copy of the one
// preference store before its first render (as a reload finds it), and each
// `preference.save` of it heard as the rail it leaves, with the rail's grip
// and keys to hand.

import { act, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import type { RailPreference } from '../../apps/web/src/shell/use-rail.ts';
import { SessionStore, layoutKey, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const live: Mounted[] = [];

/** Unmounts every page `at` drew, one act() scope at a time. */
export async function unmountAll(): Promise<void> {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
}

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@example.test' };
const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

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

export function app(input: {
  readonly width?: number;
  readonly rail?: RailPreference;
  readonly saved?: RailPreference[];
}): ReactElement {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: input.width ?? 1480 });
  const storage = memory();
  if (input.rail !== undefined) {
    const layout = { 'rail.collapsed': input.rail.collapsed, 'rail.width': input.rail.width };
    storage.setItem(layoutKey('alpha'), JSON.stringify({ who: SESSION.email, layout }));
  }
  // The rail each save leaves, from where the last one left it.
  let rail = { collapsed: input.rail?.collapsed === true, width: input.rail?.width ?? 224 };
  const fetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/preference/save')) {
      const body = JSON.parse(String(init?.body)) as { preference: string; value: never };
      rail = { ...rail, [body.preference === 'rail.width' ? 'width' : 'collapsed']: body.value };
      input.saved?.push(rail);
    }
    return new Promise<Response>(() => {});
  };
  return (
    <App
      path="/projects/"
      navigate={() => {}}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={fetch as typeof globalThis.fetch}
      storage={storage as Storage}
      panels={REGISTRY}
    />
  );
}

/** Mounts an element and unmounts it after the test. */
export async function drawn(element: ReactElement): Promise<Mounted> {
  const page = await mount(element);
  live.push(page);
  return page;
}

export function at(input: Parameters<typeof app>[0]): Promise<Mounted> {
  return drawn(app(input));
}

export const shell = (page: Mounted): HTMLElement => page.find('.shell') as HTMLElement;
export const railWidth = (page: Mounted): string => shell(page).style.getPropertyValue('--rail-w');
export const grip = (page: Mounted): HTMLElement => {
  const found = page.find('.railgrip') as HTMLElement;
  found.setPointerCapture = () => {};
  return found;
};
export const pointer = (type: string, clientX: number): Event =>
  Object.assign(new MouseEvent(type, { bubbles: true, clientX }), { pointerId: 1 });
export const key = async (target: HTMLElement, name: string, shiftKey = false): Promise<void> => {
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }));
  });
};
