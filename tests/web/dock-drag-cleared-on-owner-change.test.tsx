// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable no-await-in-loop -- Sol's proof, kept as written */

import { type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { useDockShell } from '../../apps/web/src/dock/dock-props.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { layoutKey, type Session, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const MIA: Session = {
  businessKey: 'alpha',
  email: 'mia@alpha.local',
  sessionId: 'mia-session',
};
const pending: typeof fetch = () => new Promise<Response>(() => {});
const pages: Mounted[] = [];
afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
});

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function LayoutProbe(props: {
  readonly session: Session;
  readonly storage: StorageLike;
  readonly client: OperationsClient;
}): ReactElement {
  const { layout } = useDockShell(props.client, props.session, props.storage, {});
  return (
    <>
      <button
        data-move
        onClick={() => {
          layout.setWidth(613);
        }}
      />
      <output>{layout.width}</output>
    </>
  );
}

// Sol OW-081.3 criterion 2, retitled by what it proves; its body is Sol's.
// prettier-ignore
it.each([
  { boundary: 'business to business', next: { ...MIA, businessKey: 'bravo' } },
  {
    boundary: 'person to person',
    next: { ...MIA, email: 'noah@alpha.local', sessionId: 'noah-session' },
  },
])(
  '$boundary clears an unfinished dock drag before drawing the next owner',
  async ({ next }) => {
    const storage = memory();
    storage.setItem(
      layoutKey(next.businessKey),
      JSON.stringify({
        who: next.email,
        layout: { 'dock.width': 402 },
      }),
    );
    const clientFor = (session: Session) =>
      new OperationsClient({
        origin: '',
        businessKey: session.businessKey,
        signedIn: true,
        ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
        fetch: pending,
      });
    const page = await mount(
      <LayoutProbe session={MIA} storage={storage} client={clientFor(MIA)} />,
    );
    pages.push(page);
    await page.click('[data-move]');
    expect(page.find('output')?.textContent).toBe('613');
    await page.render(<LayoutProbe session={next} storage={storage} client={clientFor(next)} />);
    expect(page.find('output')?.textContent).toBe('402');
  },
);
