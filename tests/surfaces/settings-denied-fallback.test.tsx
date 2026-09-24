// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A denied `settings.read` ends the session's fallback, not just the render
// (Sol 6 recheck, SURFACE-2 at 0395827).
//
// The fallback is the last write this session saw confirmed, drawn only while
// `settings.read` is not answering. Reads use current authority
// (`docs/local/DATA.md`): once the server has refused this reader the value,
// the tab's copy is not theirs to see either. Hiding it for the one render the
// denial is on screen is not enough, because the next unavailable read would
// draw it again. So the denial removes the copy, and until an authorised read
// answers, a write from the same session does not put one back. Both hold in
// the mounted screen and across a remount of it.

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

type ReadAnswer = 'rows' | 'denied' | 'unavailable';

/** One session's API, with what `settings.read` answers changeable between calls. */
interface Server {
  answer: ReadAnswer;
  readonly fetch: typeof globalThis.fetch;
}

function api(): Server {
  const held: { answer: ReadAnswer } = { answer: 'unavailable' };
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
    if (at.endsWith('/settings/read')) {
      if (held.answer === 'denied') {
        return json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['settings:read'], fixes: [] },
          403,
        );
      }
      if (held.answer === 'unavailable') return json({ error: 'unavailable' }, 503);
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
  return Object.assign(held, { fetch });
}

const open = async (server: Server): Promise<Mounted> => {
  const page = await mount(
    <SettingsScreen
      client={
        new OperationsClient({
          base: '/api',
          businessKey: ADA.businessKey,
          token: ADA.token,
          fetch: server.fetch,
        })
      }
      grantKey={grantKeyOf(ADA)}
      storage={window.sessionStorage}
    />,
  );
  await tick();
  return page;
};

const known = (page: Mounted): string =>
  page.find('[data-settings="four-eyes-known"]')?.textContent ?? '';

const cached = (): string =>
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith('ops-astro.settings.'))
    .map((key) => window.sessionStorage.getItem(key) ?? '')
    .join('');

/** Ada writes 7777 while the read is unavailable, and sees her own fallback. */
async function adaWrites(server: Server): Promise<Mounted> {
  server.answer = 'unavailable';
  const page = await open(server);
  await page.type('#settings-four-eyes', '7777');
  await page.click('[data-settings="save-four-eyes"]');
  await tick();
  expect(known(page)).toContain('7777');
  return page;
}

// eslint-disable-next-line max-lines-per-function -- one session, its reads in order
describe('a denied settings.read ends the fallback for the session', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    new SessionStore(window.sessionStorage).set(ADA);
  });

  it('write, denied read, then unavailable read after a remount draws no cached value', async () => {
    const server = api();
    await (await adaWrites(server)).unmount();
    expect(cached()).toContain('7777');

    server.answer = 'denied';
    const denied = await open(server);
    expect(denied.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('denied');
    expect(denied.text()).not.toContain('7777');
    await denied.unmount();
    expect(cached()).not.toContain('7777');

    server.answer = 'unavailable';
    const after = await open(server);
    expect(after.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('unavailable');
    expect(after.text()).not.toContain('7777');
    expect(known(after)).toContain('not known');
    await after.unmount();
  });

  it('write, denied read, then unavailable read in the same mount draws no cached value', async () => {
    const server = api();
    const page = await adaWrites(server);

    // The write's reread is refused: the grant went between the two.
    server.answer = 'denied';
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('denied');
    expect(cached()).not.toContain('7777');

    // The next write's reread is unavailable. The write is confirmed, but a
    // denied session does not refill the fallback from it.
    server.answer = 'unavailable';
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('unavailable');
    expect(page.text()).not.toContain('7777');
    expect(known(page)).toContain('not known');
    expect(cached()).not.toContain('7777');
    await page.unmount();

    const again = await open(server);
    expect(again.text()).not.toContain('7777');
    await again.unmount();
  });

  it('an authorised read lifts the hold, so the next confirmed write is the fallback again', async () => {
    const server = api();
    await (await adaWrites(server)).unmount();
    server.answer = 'denied';
    await (await open(server)).unmount();

    server.answer = 'rows';
    const page = await open(server);
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('ready');

    server.answer = 'unavailable';
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(known(page)).toContain('7777');
    expect(cached()).toContain('7777');
    await page.unmount();
  });
});
