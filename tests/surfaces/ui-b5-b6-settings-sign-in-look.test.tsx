// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UI-POLISH B5 and B6: the markup the look probes measure.
//
// Settings draws the mockup's settings rows (DS-COMP-26, AG-X20 and AG-X21):
// one capped card, a row per setting with its label and one sentence beside
// the row's controls, on and off as the segmented control (AG-X22), and the
// server's value as the row's derived line. Sign in is drawn signed out with
// no shell: the brand mark over one card of kit fields, and the version stamp
// in its fixed selector because there is no rail to carry it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { BUILD_SELECTOR } from '../browser/served-build.ts';
import { mount, settle } from './mount.tsx';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const answered = ((url: string | URL) =>
  Promise.resolve(
    String(url).endsWith('/settings/read')
      ? json({
          ok: true,
          settings: [
            { key: 'four_eyes_threshold', value: 500, revision: 2 },
            { key: 'client_sign_off_required', value: true, revision: 1 },
            { key: 'conversation_window_days', value: 30, revision: 1 },
            { key: 'retention_window_days', value: 365, revision: 1 },
          ],
        })
      : json({
          ok: true,
          personId: 'p-ada',
          businessKey: 'alpha',
          grants: [{ collection: 'settings', action: 'manage' }],
        }),
  )) as unknown as typeof globalThis.fetch;

const emptyStorage = (): StorageLike => ({
  getItem: () => null,
  setItem: () => {
    /* Nothing is kept. */
  },
  removeItem: () => {
    /* Nothing is kept. */
  },
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
});

describe('B5 settings, as the mockup draws settings rows', () => {
  it('draws one capped card with a row per setting and its controls beside it', async () => {
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: answered,
    });
    const page = await mount(
      <SettingsScreen client={client} grantKey="alpha:ada" storage={window.sessionStorage} />,
    );
    await settle();
    expect(page.all('.card.set__card')).toHaveLength(1);
    expect(page.all('.set__card .card__title')).toHaveLength(1);
    const rows = page.all('.set > .setrow');
    expect(rows.map((row) => (row as HTMLElement).dataset['set'])).toEqual([
      'four-eyes',
      'sign-off',
      'conversation',
      'retention',
    ]);
    for (const row of rows) {
      expect(row.querySelector('.setrow__t .setrow__k')).not.toBeNull();
      expect(row.querySelector('.setrow__t .setrow__note')).not.toBeNull();
      expect(
        row.querySelector('.setrow__ctl .segmented [aria-pressed], .setrow__ctl input.tf'),
      ).not.toBeNull();
      expect(row.querySelector('.setrow__ctl .btn.btn--sm')).not.toBeNull();
      expect(row.querySelector('.setrow__ctl .setrow__state')?.textContent).toMatch(/holds/u);
    }
    // A read that answered leaves no empty read-state box above the card.
    expect(page.find('[data-settings="read"]')?.childElementCount).toBe(0);
    await page.unmount();
  });
});

describe('B6 sign in, signed out and with no shell', () => {
  it('draws the brand mark, kit fields and the stamp, and no rail or top bar', async () => {
    vi.stubEnv('VITE_OPS_ASTRO_BUILD', '0123456789ab');
    const view = await mount(
      <App
        path="/sign-in"
        navigate={() => {
          /* The test drives the address directly. */
        }}
        sessions={new SessionStore(emptyStorage())}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={(() => Promise.resolve(json({}))) as unknown as typeof fetch}
        storage={tabStorage()}
      />,
    );
    await settle();
    expect(view.find('nav.rail')).toBeNull();
    expect(view.find('.topbar')).toBeNull();
    expect(view.find('.signin .signin__brand .brand--wordmark')).not.toBeNull();
    expect(view.find('form.signin__form.card h1.card__title')?.textContent).toBe('Sign in');
    expect(view.all('.signin__form .field > label.field__label')).toHaveLength(3);
    expect(view.all('.signin__form input.tf')).toHaveLength(2);
    expect(view.find('.signin__form button.btn.btn--primary[type="submit"]')).not.toBeNull();
    const stamp = view.all(BUILD_SELECTOR)[0] as HTMLElement | undefined;
    expect(stamp?.dataset['build']).toBe('0123456789ab');
    await view.unmount();
  });
});
