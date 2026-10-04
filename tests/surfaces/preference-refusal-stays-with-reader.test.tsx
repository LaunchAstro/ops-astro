// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ You after a change of reader (WEB.md: a change of owner shows
// nothing of the last one). A refusal line belongs to the reader it was said
// to: the next business or person never sees it, while their own read is
// pending or after it answers.

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

const refused = (): Promise<Response> =>
  Promise.resolve(
    Response.json(
      {
        refused: true,
        code: 'SCOPE_NOT_GRANTED',
        names: ['preference.read'],
        fixes: ['Ask an owner for the scope.'],
      },
      { status: 403 },
    ),
  );
const answered = (): Promise<Response> =>
  Promise.resolve(Response.json({ preferences: { appearance: 'light' } }));
const pending = (): Promise<Response> => new Promise<Response>(() => {});

function settings(preferenceRead: () => Promise<Response>): typeof globalThis.fetch {
  return ((input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/preference/read')) return preferenceRead();
    if (url.endsWith('/settings/read')) return Promise.resolve(Response.json({ settings: [] }));
    if (url.endsWith('/session/capabilities'))
      return Promise.resolve(Response.json({ grants: [] }));
    throw new Error(`Unexpected request ${url}`);
  }) as typeof globalThis.fetch;
}

const client = (businessKey: string, fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

it.each([
  ['business to business, read pending', 'bravo', 'bravo:ada', pending],
  ['business to business, read answered', 'bravo', 'bravo:ada', answered],
  ['person to person, read pending', 'alpha', 'alpha:ben', pending],
  ['person to person, read answered', 'alpha', 'alpha:ben', answered],
])(
  '%s: the last reader’s refusal line is not drawn',
  async (_boundary, business, grant, nextRead) => {
    view = await mount(
      <SettingsGeneralScreen
        client={client('alpha', settings(refused))}
        grantKey="alpha:ada"
        storage={null}
      />,
    );
    await settle();
    expect(view.find('[data-pref="refusal"]')?.textContent).toContain('SCOPE_NOT_GRANTED');

    await view.render(
      <SettingsGeneralScreen
        client={client(business, settings(nextRead))}
        grantKey={grant}
        storage={null}
      />,
    );
    await settle();
    expect(view.find('[data-pref="refusal"]'), 'the last reader’s refusal is drawn').toBeNull();
  },
);
