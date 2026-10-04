// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, require-await -- Sol's proof, kept as written */
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { useStoredAppearance } from '../../apps/web/src/appearance.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, type Mounted } from './mount.tsx';

const views: Mounted[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  window.sessionStorage.clear();
  delete document.documentElement.dataset['themePreference'];
});
async function open(element: Parameters<typeof mount>[0]) {
  const view = await mount(element);
  views.push(view);
  return view;
}
const json = (value: unknown, status = 200) => Response.json(value, { status });

// Sol OW-078.2 criterion 5, retitled by what it proves; its body is Sol's.
it('a delayed initial appearance read cannot replace a later successfully saved choice', async () => {
  let reads = 0;
  let finish: ((response: Response) => void) | undefined;
  let saved = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/preference/save')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        preference: 'appearance',
        value: 'dark',
      });
      saved = true;
      return json({ recordId: null, revision: null });
    }
    reads += 1;
    if (reads === 1) return json({ preferences: { appearance: 'light' } });
    return new Promise<Response>((done) => {
      finish = done;
    });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  function AppearanceHarness() {
    useStoredAppearance(client, 'alpha:ada', window.sessionStorage);
    return <YouGroups client={client} grantKey="alpha:ada" storage={window.sessionStorage} />;
  }
  const view = await open(<AppearanceHarness />);
  expect(reads).toBe(2);
  const dark = view
    .all('[data-pref="appearance"] button')
    .find((button) => button.textContent === 'Dark');
  expect(dark).toBeDefined();
  await act(() => {
    (dark as HTMLButtonElement).click();
  });
  expect(saved).toBe(true);
  expect(document.documentElement.dataset['themePreference']).toBe('dark');
  await act(() => {
    finish?.(json({ preferences: { appearance: 'light' } }));
  });
  expect(document.documentElement.dataset['themePreference']).toBe('dark');
});
