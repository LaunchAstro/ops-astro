// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { APPEARANCE_KEY } from '../../apps/web/src/appearance.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  window.sessionStorage.clear();
  delete document.documentElement.dataset['themePreference'];
  delete document.documentElement.dataset['themeFade'];
});

function gate() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function button(group: string, label: string): HTMLButtonElement {
  const found = view
    ?.all(`[data-pref="${group}"] button`)
    .find((node) => node.textContent === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing ${group} ${label}`);
  return found;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await settle();
}

const stored = () => Response.json({ preferences: { appearance: 'light', 'tips.enabled': true } });

it('a newer tips reread does not drop the failed appearance restore', async () => {
  const r1 = gate();
  const r2 = gate();
  let reads = 0;
  const saves: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (String(input).endsWith('/preference/read')) {
      reads += 1;
      if (reads === 1) return Promise.resolve(stored());
      return reads === 2 ? r1.promise : r2.promise;
    }
    const body = JSON.parse(String(init?.body)) as { preference: string };
    saves.push(body.preference);
    return Promise.resolve(new Response(null, { status: 503 }));
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  view = await mount(
    <YouGroups client={client} grantKey="alpha:ada" storage={window.sessionStorage} />,
  );
  await flush();
  expect(button('appearance', 'Light').getAttribute('aria-pressed')).toBe('true');

  await act(() => button('appearance', 'Dark').click());
  await flush();
  expect(saves).toEqual(['appearance']);
  expect(reads).toBe(2);

  await act(() => button('tips', 'Off').click());
  await flush();
  expect(saves).toEqual(['appearance', 'tips.enabled']);
  expect(reads).toBe(3);

  await act(() => r2.release(stored()));
  await flush();
  await act(() => r1.release(stored()));
  await flush();

  expect(button('appearance', 'Light').getAttribute('aria-pressed')).toBe('true');
  expect(
    document.documentElement.dataset['themePreference'],
    'the failed Dark save must not stay applied',
  ).toBe('light');
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBe('light');
});
