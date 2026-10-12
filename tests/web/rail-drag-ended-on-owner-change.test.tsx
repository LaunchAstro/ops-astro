// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A rail drag belongs to the business and person it started under. When the
// tab switches business or person with the pointer still held, the drag ends
// at the grip: the pointer moving on and its release save nothing into either
// owner's preferences, the new owner's rail is drawn at its own width, and
// switching back does not bring the dead drag's width back. A keyboard step
// under the new owner is still kept.
//
// Driven through the real shell and its grip, with the rail and the props the
// application hands the shell (`useDockShell`, `shellDock`).

import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { shellDock, useDockShell } from '../../apps/web/src/dock/dock-props.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { layoutKey, type Session, type StorageLike } from '../../apps/web/src/session/token.ts';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { press } from './frame-support.tsx';

const MIA: Session = { businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'mia-session' };
const BRAVO: Session = { ...MIA, businessKey: 'bravo' };
// Noah has no rail kept in Alpha, so his is drawn at the default, 224.
const NOAH: Session = { ...MIA, email: 'noah@alpha.local', sessionId: 'noah-session' };

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
  const docked = useDockShell(props.client, props.session, props.storage, {});
  return (
    <>
      <Shell
        face="agency"
        build={null}
        rail={[]}
        here="/projects/"
        title="Projects"
        {...shellDock(docked, null)}
      >
        {null}
      </Shell>
      <output>{docked.nav.width}</output>
    </>
  );
}

/** Mia's rail at 224 in Alpha and 260 in Bravo; every preference save recorded, none answered. */
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

/** A pointer event at `clientX` on the rail's grip, as it is drawn now. */
async function pointer(page: Mounted, type: string, clientX: number): Promise<void> {
  const grip = page.find('.railgrip') as HTMLElement | null;
  if (grip === null) throw new Error('no rail grip');
  grip.setPointerCapture = () => {};
  await act(() => {
    grip.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX }), { pointerId: 1 }),
    );
  });
}

const width = (page: Mounted): string | undefined => page.find('output')?.textContent ?? undefined;

it.each([
  { boundary: 'business to business', next: BRAVO, theirs: '260' },
  { boundary: 'person to person', next: NOAH, theirs: '224' },
])('$boundary ends a held rail drag with nothing saved', async ({ next, theirs }) => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  expect(width(page)).toBe('224');
  await pointer(page, 'pointerdown', 224);
  await pointer(page, 'pointermove', 377);
  expect(width(page)).toBe('377');
  await page.render(draw(next));
  expect(width(page)).toBe(theirs);
  await pointer(page, 'pointermove', 390);
  await pointer(page, 'pointerup', 390);
  expect(saves).toEqual([]);
  expect(width(page)).toBe(theirs);
});

it('a drag ended by a business switch stays ended when the tab switches back', async () => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  await pointer(page, 'pointerdown', 224);
  await pointer(page, 'pointermove', 377);
  await page.render(draw(BRAVO));
  await page.render(draw(MIA));
  expect(width(page)).toBe('224');
  await pointer(page, 'pointerup', 390);
  expect(saves).toEqual([]);
});

it('a keyboard step under the next owner, after a switch ended a drag, is kept', async () => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  await pointer(page, 'pointerdown', 224);
  await pointer(page, 'pointermove', 377);
  await page.render(draw(BRAVO));
  await press(page.find('.railgrip') ?? document.body, 'ArrowRight');
  expect(saves).toHaveLength(1);
  expect(saves[0]).toContain('276');
});

it('a drag released under the owner it started with keeps its width', async () => {
  const { saves, draw } = world();
  const page = await mount(draw(MIA));
  pages.push(page);
  await pointer(page, 'pointerdown', 224);
  await pointer(page, 'pointermove', 377);
  await pointer(page, 'pointerup', 377);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toContain('377');
  expect(width(page)).toBe('377');
});
