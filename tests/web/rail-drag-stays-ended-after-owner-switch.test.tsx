// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A business or person switch with the rail's pointer still held ends that
// drag. Ended means ended: the grip moving on under the next owner, or the tab
// switching back, does not revive it, so its release saves nothing. A keyboard
// step is its own intent, and it is kept for the owner it was pressed under.

import { type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { useDockShell } from '../../apps/web/src/dock/dock-props.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { layoutKey, type Session, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const MIA: Session = { businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'mia-session' };
const BRAVO: Session = { ...MIA, businessKey: 'bravo' };
const pages: Mounted[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.unmount()));
});

function memory(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** The grip's three gestures: a pointer move, a pointer release, and a key step (move then keep). */
function RailProbe(props: {
  readonly session: Session;
  readonly storage: StorageLike;
  readonly client: OperationsClient;
}): ReactElement {
  const { nav } = useDockShell(props.client, props.session, props.storage, {});
  return (
    <>
      <button data-move onClick={() => nav.resize(377)} />
      <button data-move-on onClick={() => nav.resize(390)} />
      <button data-release onClick={() => nav.keep(390)} />
      <button
        data-key-step
        onClick={() => {
          nav.resize(300);
          nav.keep(300);
        }}
      />
      <output>{nav.width}</output>
    </>
  );
}

function world() {
  const storage = memory();
  for (const [session, width] of [
    [MIA, 224],
    [BRAVO, 260],
  ] as const) {
    storage.setItem(
      layoutKey(session.businessKey),
      JSON.stringify({ who: session.email, layout: { 'rail.width': width } }),
    );
  }
  const saves: string[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (String(url).includes('preference/save')) saves.push(String(init?.body));
    return new Promise<Response>(() => {
      /* never answers */
    });
  };
  const clients = new Map<Session, OperationsClient>();
  const clientFor = (session: Session): OperationsClient => {
    const made =
      clients.get(session) ??
      new OperationsClient({
        origin: '',
        businessKey: session.businessKey,
        signedIn: true,
        ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
        fetch,
      });
    clients.set(session, made);
    return made;
  };
  const draw = (session: Session): ReactElement => (
    <RailProbe session={session} storage={storage} client={clientFor(session)} />
  );
  return { saves, draw };
}

it('a drag ended by a business switch saves nothing when its pointer moves on and releases', async () => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  await page.click('[data-move]');
  await page.render(draw(BRAVO));
  await page.click('[data-move-on]');
  await page.click('[data-release]');
  expect(saves).toEqual([]);
  expect(page.find('output')?.textContent).toBe('260');
});

it('a drag ended by a business switch stays ended when the tab switches back', async () => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  await page.click('[data-move]');
  await page.render(draw(BRAVO));
  await page.render(draw(MIA));
  expect(page.find('output')?.textContent).toBe('224');
  await page.click('[data-release]');
  expect(saves).toEqual([]);
});

it('a keyboard step under the next owner, after a switch ended a drag, is kept', async () => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  await page.click('[data-move]');
  await page.render(draw(BRAVO));
  await page.click('[data-key-step]');
  expect(saves).toHaveLength(1);
  expect(page.find('output')?.textContent).toBe('300');
});
