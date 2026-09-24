// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A settings write answered after sign-out leaves nothing in the tab (Sol 6
// recheck, AUTHORITY at 0395827).
//
// Sign-out removes the session's cached settings value (`SessionStore.clear`).
// A save pressed before it can still be answered after it: the request left
// with the old bearer and the server confirms it. The screen must not then
// write the confirmed value back into the tab, where it would outlive the
// session it belonged to. The write is gated on the session that pressed Save
// still being the one in hand, whether or not the screen is still mounted.

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ADA: Session = { token: 'tok-ada', businessKey: 'alpha', email: 'ada@alpha.local' };

/** An API whose write answers only when the test says so. The read is unavailable. */
function api(): { fetch: typeof globalThis.fetch; answer: () => void } {
  const gate: { release: (() => void) | null } = { release: null };
  const answered = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p',
        businessKey: 'alpha',
        grants: [{ collection: 'settings', action: 'manage' }],
      });
    }
    if (at.endsWith('/settings/read')) return json({ error: 'unavailable' }, 503);
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      await answered;
      return json({ recordId: 'row', revision: null, detail: { value: 7777 } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    answer: () => {
      gate.release?.();
    },
  };
}

const open = async (fetch: typeof globalThis.fetch): Promise<Mounted> => {
  const page = await mount(
    <SettingsScreen
      client={
        new OperationsClient({
          origin: '',
          businessKey: ADA.businessKey,
          token: ADA.token,
          fetch,
        })
      }
      grantKey={grantKeyOf(ADA)}
      storage={window.sessionStorage}
    />,
  );
  await tick();
  return page;
};

const cached = (): string =>
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith('ops-astro.settings.'))
    .map((key) => window.sessionStorage.getItem(key) ?? '')
    .join('');

// eslint-disable-next-line max-lines-per-function -- one save, the sign-outs that can overtake it
describe('a settings write answered after sign-out', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('leaves no settings cache when the screen has gone with the session', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    sessions.set(ADA);
    const server = api();
    const page = await open(server.fetch);
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    sessions.clear();
    await page.unmount();
    server.answer();
    await tick();

    expect(cached()).toBe('');
  });

  it('leaves no settings cache when the screen is still mounted', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    sessions.set(ADA);
    const server = api();
    const page = await open(server.fetch);
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    sessions.clear();
    server.answer();
    await tick();

    expect(cached()).toBe('');
    await page.unmount();
  });

  it('still keeps the confirmed value when the session is the one that pressed Save', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    sessions.set(ADA);
    const server = api();
    const page = await open(server.fetch);
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    server.answer();
    await tick();

    expect(cached()).toContain('7777');
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('7777');
    await page.unmount();
  });

  it('keeps the confirmed value when the same session left the screen before the answer', async () => {
    // Leaving the page is not leaving the session. The write is kept when it
    // answers, not on a render the unmounted screen will never have
    // (THERMO-RECHECK-3 R3C1).
    const sessions = new SessionStore(window.sessionStorage);
    sessions.set(ADA);
    const server = api();
    const page = await open(server.fetch);
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    await page.unmount();
    server.answer();
    await tick();

    expect(cached()).toContain('7777');
    const again = await open(server.fetch);
    expect(again.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('unavailable');
    expect(again.find('[data-settings="four-eyes-known"]')?.textContent).toContain('7777');
    await again.unmount();
  });
});
