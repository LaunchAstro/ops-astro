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

it.each([
  ['business to business', 'beta', 'beta:ada'],
  ['person to person', 'alpha', 'alpha:ben'],
])(
  'Sol proof, criterion 2: %s preference state stays with its original reader during a pending new read',
  async (_boundary, business, grant) => {
    const oldApi = settingsFetch(
      async () =>
        json({
          preferences: {
            appearance: 'dark',
            'tips.dismissed': { 'agency:inbox#private-tip': 1 },
          },
        }),
      [],
    );
    view = await mount(
      <SettingsGeneralScreen
        client={client('alpha', oldApi)}
        grantKey="alpha:ada"
        storage={null}
      />,
    );
    await settle();
    expect(view.text()).toContain('Bring back 1 dismissed tip');
    const saved: string[] = [];
    const newApi = settingsFetch(() => new Promise(() => {}), saved);
    await view.render(
      <SettingsGeneralScreen client={client(business, newApi)} grantKey={grant} storage={null} />,
    );
    expect(view.text()).not.toContain('Bring back 1 dismissed tip');
    await pressAppearance('Light');
    expect(saved).toHaveLength(1);
    expect(
      view.text(),
      'saving the new reader’s choice retagged the old reader’s dismissed tips',
    ).not.toContain('Bring back 1 dismissed tip');
  },
);
