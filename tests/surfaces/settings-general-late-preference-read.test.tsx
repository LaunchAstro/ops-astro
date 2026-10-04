// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- Sol's proof, kept as written */
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SettingsGeneralScreen } from '../../apps/web/src/screens/SettingsGeneral.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const client = (businessKey: string, fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

function settingsFetch(
  preferenceRead: () => Promise<Response>,
  saved: string[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/preference/read')) return preferenceRead();
    if (url.endsWith('/preference/save')) {
      saved.push(String(init?.body));
      return json({ recordId: null, revision: null });
    }
    if (url.endsWith('/settings/read')) return json({ settings: [] });
    if (url.endsWith('/session/capabilities')) return json({ grants: [] });
    throw new Error(`Unexpected request ${url}`);
  };
}

async function pressAppearance(label: string): Promise<void> {
  const button = view
    ?.all('[data-pref="appearance"] button')
    .find((one) => one.textContent === label);
  expect(button).toBeDefined();
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
  await settle();
}

// Sol OW-084.3 criterion 5, retitled by what it proves; its body is Sol's.
it('a delayed initial preference read cannot replace a successfully saved choice', async () => {
  let release: ((response: Response) => void) | undefined;
  const saved: string[] = [];
  const api = settingsFetch(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    saved,
  );
  view = await mount(
    <SettingsGeneralScreen client={client('alpha', api)} grantKey="alpha:ada" storage={null} />,
  );
  expect(release).toBeDefined();
  await pressAppearance('Dark');
  expect(saved).toHaveLength(1);
  expect(JSON.parse(saved[0] ?? '{}')).toMatchObject({ preference: 'appearance', value: 'dark' });
  await act(async () => {
    release?.(json({ preferences: { appearance: 'light' } }));
  });
  const dark = view
    .all('[data-pref="appearance"] button')
    .find((one) => one.textContent === 'Dark');
  expect(
    dark?.getAttribute('aria-pressed'),
    'the read started before Save overwrote the saved choice',
  ).toBe('true');
});
