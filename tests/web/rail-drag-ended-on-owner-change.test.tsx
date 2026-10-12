// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A rail drag belongs to the business and person it started under. When the
// tab switches business or person with the pointer still held, the drag ends
// with nothing saved: the release cannot write the old owner's width into the
// new owner's preferences, and the new owner's rail is drawn at its own width.

import { type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { useDockShell } from '../../apps/web/src/dock/dock-props.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { layoutKey, type Session, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const MIA: Session = { businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'mia-session' };
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

function RailProbe(props: {
  readonly session: Session;
  readonly storage: StorageLike;
  readonly client: OperationsClient;
}): ReactElement {
  const { nav } = useDockShell(props.client, props.session, props.storage, {});
  return (
    <>
      <button
        data-move
        onClick={() => {
          nav.resize(377);
        }}
      />
      <button
        data-release
        onClick={() => {
          nav.keep(377);
        }}
      />
      <output>{nav.width}</output>
    </>
  );
}

it.each([
  { boundary: 'business to business', next: { ...MIA, businessKey: 'bravo' } },
  {
    boundary: 'person to person',
    next: { ...MIA, email: 'noah@alpha.local', sessionId: 'noah-session' },
  },
])('$boundary ends a held rail drag with nothing saved', async ({ next }) => {
  const storage = memory();
  for (const [session, width] of [
    [MIA, 224],
    [next, 260],
  ] as const) {
    storage.setItem(
      layoutKey(session.businessKey),
      JSON.stringify({ who: session.email, layout: { 'rail.width': width } }),
    );
  }
  const saves: string[] = [];
  const fetch: typeof globalThis.fetch = (url) => {
    if (String(url).includes('preference/save')) saves.push(String(url));
    return new Promise<Response>(() => {
      /* never answers */
    });
  };
  const clientFor = (session: Session) =>
    new OperationsClient({
      origin: '',
      businessKey: session.businessKey,
      signedIn: true,
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      fetch,
    });
  const page = await mount(<RailProbe session={MIA} storage={storage} client={clientFor(MIA)} />);
  pages.push(page);
  expect(page.find('output')?.textContent).toBe('224');
  await page.click('[data-move]');
  expect(page.find('output')?.textContent).toBe('377');
  await page.render(<RailProbe session={next} storage={storage} client={clientFor(next)} />);
  expect(page.find('output')?.textContent).toBe('260');
  await page.click('[data-release]');
  expect(saves).toEqual([]);
  expect(page.find('output')?.textContent).toBe('260');
});

it('a drag released under the owner it started with keeps its width', async () => {
  const saves: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: MIA.businessKey,
    signedIn: true,
    sessionId: 'mia-session',
    fetch: (url) => {
      saves.push(String(url));
      return new Promise<Response>(() => {
        /* never answers */
      });
    },
  });
  const page = await mount(<RailProbe session={MIA} storage={memory()} client={client} />);
  pages.push(page);
  await page.click('[data-move]');
  await page.click('[data-release]');
  expect(saves.filter((url) => url.includes('preference/save'))).toHaveLength(1);
  expect(page.find('output')?.textContent).toBe('377');
});
