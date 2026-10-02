// SPDX-License-Identifier: AGPL-3.0-only
//
// The application with the person's layout in MP-2-11's one preference store
// (MP-2-3 the rail, MP-3-2 the dock width, MP-3-3 the sheet height), for the
// jsdom legs: signed in on the Projects board, its `preference.read` answered
// with the stored keys (or never), every request heard, and the tab's storage
// handed in, so a reload is a fresh mount on the same tab. The same legs
// against the real boundary and a fresh Postgres are in
// layout-preferences-api.test.tsx.

import { expect } from 'vitest';
import { act } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

/** One tab's storage, signed in as Mia in Alpha. */
export function tab(): StorageLike {
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

export interface Heard {
  readonly at: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The `preference.save` bodies heard, as `[key, value]`. */
export const savesIn = (heard: readonly Heard[]): readonly (readonly [unknown, unknown])[] =>
  heard
    .filter((each) => each.at.endsWith('/preference/save'))
    .map((each) => [each.body['preference'], each.body['value']] as const);

/** Every save heard, at least `count`, names only its key and value: never a person. */
export function expectNoPersonNamed(heard: readonly Heard[], count: number): void {
  const saves = heard.filter((each) => each.at.endsWith('/preference/save'));
  expect(saves).toHaveLength(count);
  for (const save of saves) {
    expect(Object.keys(save.body).toSorted()).toEqual(['operationId', 'preference', 'value']);
  }
}

/** Noa, another person in Alpha, signs in to the same tab. */
export function noaSignsIn(storage: StorageLike): void {
  storage.setItem('ops-astro.session', JSON.stringify({ ...SESSION, email: 'noah@alpha.local' }));
}

const live: Mounted[] = [];

/** Unmounts every page drawn here, one act() scope at a time. */
export async function unmountLayouts(): Promise<void> {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
}

/**
 * The application at `width` on `storage`'s tab. `stored` is what the store
 * answers `preference.read` with; left out, the read is never answered.
 */
export async function layoutAt(input: {
  readonly width: number;
  readonly height?: number;
  readonly storage: StorageLike;
  readonly heard: Heard[];
  readonly stored?: Readonly<Record<string, unknown>>;
}): Promise<Mounted> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: input.width });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: input.height ?? 1000,
  });
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    input.heard.push({
      at,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (at.endsWith('/preference/read') && input.stored !== undefined) {
      const body = JSON.stringify({ ok: true, preferences: input.stored });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }
    return new Promise<Response>(() => {});
  }) as typeof globalThis.fetch;
  const page = await mount(
    <App
      path="/projects/"
      navigate={() => {}}
      sessions={new SessionStore(input.storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={fetch}
      storage={input.storage as Storage}
      panels={REGISTRY}
    />,
  );
  live.push(page);
  // The read's answer, where there is one, is applied.
  await act(async () => {
    await Promise.resolve();
  });
  return page;
}

/** Opens a dock tab by a plain press, unless the tab's own copy already has it open. */
export async function openTab(page: Mounted, id: string): Promise<void> {
  const tabButton = page.find(`.dock__tab[data-panel="${id}"]`);
  if (tabButton?.getAttribute('aria-expanded') === 'true') return;
  await act(() => {
    tabButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The dock's grip, ready for a pointer drag. */
export function dockGrip(page: Mounted): HTMLElement {
  const found = page.find('.dpanel__grip') as HTMLElement;
  found.setPointerCapture = () => {};
  return found;
}

/** Drags `grip` along x (or y for a sheet) from `from` through `moves`, let go at the last. */
export async function drag(
  grip: HTMLElement,
  axis: 'x' | 'y',
  from: number,
  moves: readonly number[],
): Promise<void> {
  const at = (type: string, point: number): Event =>
    Object.assign(
      new MouseEvent(type, {
        bubbles: true,
        ...(axis === 'x' ? { clientX: point } : { clientY: point }),
      }),
      { pointerId: 1 },
    );
  await act(() => {
    grip.dispatchEvent(at('pointerdown', from));
  });
  for (const point of moves) {
    // eslint-disable-next-line no-await-in-loop -- each move is drawn before the next
    await act(() => {
      grip.dispatchEvent(at('pointermove', point));
    });
  }
  await act(() => {
    grip.dispatchEvent(at('pointerup', moves.at(-1) ?? from));
  });
}

/** The value a grip says it holds. */
export const gripValue = (grip: Element | null): number =>
  Number(grip?.getAttribute('aria-valuenow'));
