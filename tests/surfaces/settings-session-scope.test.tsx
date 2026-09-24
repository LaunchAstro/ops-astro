// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings` never shows one session's cached value to another (Sol 6
// SURFACE-2).
//
// The screen remembers the last write the server confirmed so it has something
// to say while `settings.read` is not answering. That memory lives in the tab's
// `sessionStorage`, and a tab outlives a session: an admin writes a threshold,
// signs out, and a member signs in to the same tab. These cases hold three
// rules about that memory.
//
//  - **A denied read shows nothing.** `SCOPE_NOT_GRANTED` on `settings.read` is
//    the server declining to tell this reader the value; drawing the value from
//    the tab would be answering on its behalf.
//  - **The memory belongs to the session that wrote it.** Another session in
//    the same tab, even with the read merely unavailable, sees "not known".
//  - **Sign-out removes it**, so nothing of the first session is left in the
//    tab for the second.
//
// And the ordinary path is unchanged: an authorised read draws the server's
// value.

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
const MIA: Session = { token: 'tok-mia', businessKey: 'alpha', email: 'mia@alpha.local' };

/** What `settings.read` answers this session: the rows, a refusal, or no such read. */
type ReadAnswer = 'rows' | 'denied' | 'unavailable';

function api(read: ReadAnswer): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p',
        businessKey: 'alpha',
        grants: [{ collection: 'settings', action: 'manage' }],
      });
    }
    if (at.endsWith('/settings/read')) {
      if (read === 'denied') {
        return json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['settings:read'], fixes: [] },
          403,
        );
      }
      if (read === 'unavailable') return json({ error: 'not found' }, 404);
      return json({
        ok: true,
        settings: [
          {
            key: 'four_eyes_threshold',
            value: 500,
            valueType: 'number',
            updatedAt: '2026-09-23T02:15:00.000Z',
            updatedByActorId: 'actor-ada',
          },
        ],
      });
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      return json({ recordId: 'row', revision: null, detail: { value: 7777 } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
}

const open = async (session: Session, read: ReadAnswer): Promise<Mounted> => {
  const page = await mount(
    <SettingsScreen
      client={
        new OperationsClient({
          base: '/api',
          businessKey: session.businessKey,
          token: session.token,
          fetch: api(read),
        })
      }
      grantKey={grantKeyOf(session)}
      storage={window.sessionStorage}
    />,
  );
  await tick();
  return page;
};

/** Ada, an admin, writes 7777 through the screen while the read is unavailable. */
async function adaWrites(sessions: SessionStore): Promise<void> {
  sessions.set(ADA);
  const page = await open(ADA, 'unavailable');
  await page.type('#settings-four-eyes', '7777');
  await page.click('[data-settings="save-four-eyes"]');
  await tick();
  // Her own session still has its fallback: that is what it is for.
  expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('7777');
  await page.unmount();
}

const cached = (): string =>
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith('ops-astro.settings.'))
    .map((key) => window.sessionStorage.getItem(key) ?? '')
    .join('');

// eslint-disable-next-line max-lines-per-function -- one tab, the sessions that share it
describe("a settings session never shows another session's cached value", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('a second session refused settings.read sees neither the value nor its cached copy', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    await adaWrites(sessions);
    sessions.clear();
    sessions.set(MIA);

    const page = await open(MIA, 'denied');
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('denied');
    expect(page.find('[data-settings="read"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(page.text()).not.toContain('7777');
    expect(page.find('[data-settings="four-eyes-known"]')).toBeNull();
    expect(page.find('[data-settings="not-readable"]')).toBeNull();
    expect(cached()).not.toContain('7777');
    await page.unmount();
  });

  it('sign-out removes the cached value from the tab', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    await adaWrites(sessions);
    expect(cached()).toContain('7777');
    sessions.clear();
    expect(cached()).toBe('');
  });

  it('a session-ending refusal removes the cached value too', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    await adaWrites(sessions);
    sessions.end({ address: '/settings', businessKey: 'alpha', code: 'AUTH_UNKNOWN_LOGIN' });
    expect(cached()).toBe('');
  });

  it('a value left in the tab by another session is not drawn when the read is unavailable', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    await adaWrites(sessions);
    // No sign-out: the tab still holds Ada's copy when Mia's session opens.
    sessions.set(MIA);

    const page = await open(MIA, 'unavailable');
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('unavailable');
    expect(page.text()).not.toContain('7777');
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('not known');
    await page.unmount();
  });

  it('an authorised read in the second session still draws the server value', async () => {
    const sessions = new SessionStore(window.sessionStorage);
    await adaWrites(sessions);
    sessions.clear();
    sessions.set(MIA);

    const page = await open(MIA, 'rows');
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('ready');
    expect(page.find('[data-settings="four-eyes-value"]')?.textContent).toContain('500');
    expect(page.text()).not.toContain('7777');
    await page.unmount();
  });
});
