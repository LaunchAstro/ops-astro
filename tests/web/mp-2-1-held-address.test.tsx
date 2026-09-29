// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1 held address switch (absorbs product issue 74). A session ends on an
// address in Bravo; the person signs in to Alpha. The application asks Bravo,
// with the new bearer, whether this person holds a grant there, and only on a
// yes does it name Bravo and offer the one-click switch back. On a no, or on no
// answer at all, it names no business.

import { describe, expect, it } from 'vitest';
import { json, open, settle, silent } from './mp-2-1-support.tsx';

const FRESH = 'fresh-token';
const HELD = {
  'ops-astro.return-to': JSON.stringify({
    address: '/task/TSK-1',
    businessKey: 'bravo',
    code: 'AUTH_SESSION_EXPIRED',
  }),
};

type Bravo = 'granted' | 'no-membership' | 'no-grant' | 'down' | 'never';

/** The identity provider and the API, with Bravo's answer to the probe chosen per case. */
function world(bravo: Bravo, asked: string[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.startsWith('http://identity.invalid/token')) return json({ access_token: FRESH });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    asked.push(`${at} ${String(headers['authorization'])}`);
    if (!at.startsWith('/api/b/bravo/session/capabilities')) return await silent(url, init);
    if (bravo === 'never') return await silent(url, init);
    if (bravo === 'down') throw new TypeError('network down');
    if (bravo === 'no-membership') {
      return json({ refused: true, code: 'AUTH_NO_MEMBERSHIP', names: [], fixes: [] }, 403);
    }
    if (bravo === 'no-grant') {
      return json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
    }
    return json({ ok: true, personId: 'p', businessKey: 'bravo', grants: [] });
  }) as unknown as typeof fetch;
}

async function signInToAlpha(bravo: Bravo, asked: string[] = []) {
  const opened = await open('/sign-in', {
    businessKey: null,
    seed: HELD,
    fetch: world(bravo, asked),
  });
  const { view } = opened;
  expect((view.find('#signin-business') as HTMLSelectElement | null)?.value).toBe('bravo');
  await view.choose('#signin-business', 'alpha');
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'whatever-it-is');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  return opened;
}

describe('MP-2-1 held address switch', () => {
  asksThenSwitchesBack();
  namesNothingWithoutAGrant();
});

function asksThenSwitchesBack(): void {
  it('asks the held business, with the new bearer, whether the person holds a grant there', async () => {
    const asked: string[] = [];
    const { view } = await signInToAlpha('granted', asked);
    expect(asked).toContain(`/api/b/bravo/session/capabilities Bearer ${FRESH}`);
    await view.unmount();
  });

  it('names the business and switches back in one click where the person holds a grant', async () => {
    const { view, seen, sessions } = await signInToAlpha('granted');
    expect(sessions.session?.businessKey).toBe('alpha');
    expect(seen.at(-1)).toBe('/projects/');
    const notice = view.find('[data-notice="other-business"]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('bravo');

    await view.click('[data-switch="held-address"]');
    expect(sessions.session).toMatchObject({ businessKey: 'bravo', token: FRESH });
    expect(seen.at(-1)).toBe('/task/TSK-1');
    expect(view.find('[data-notice="other-business"]')).toBeNull();
    await view.unmount();
  });
}

function namesNothingWithoutAGrant(): void {
  it.each(['no-membership', 'no-grant', 'down'] as const)(
    'names no business and offers no switch when Bravo answers %s',
    async (bravo) => {
      const { view, seen, sessions } = await signInToAlpha(bravo);
      expect(sessions.session?.businessKey).toBe('alpha');
      expect(seen.at(-1)).toBe('/projects/');
      const notice = view.find('[data-notice="other-business"]');
      expect(notice).not.toBeNull();
      expect(notice?.textContent).not.toContain('bravo');
      expect(notice?.textContent).not.toContain('alpha');
      expect(view.find('[data-switch="held-address"]')).toBeNull();
      expect(view.text()).not.toContain('bravo');
      await view.unmount();
    },
  );

  it('names nothing while the answer is still out', async () => {
    const { view } = await signInToAlpha('never');
    expect(view.text()).not.toContain('bravo');
    expect(view.find('[data-switch="held-address"]')).toBeNull();
    await view.unmount();
  });

  it('goes straight back, with no probe and no notice, when the business is the same', async () => {
    const asked: string[] = [];
    const opened = await open('/sign-in', {
      businessKey: null,
      seed: HELD,
      fetch: world('granted', asked),
    });
    await opened.view.type('#signin-email', 'bea@bravo.local');
    await opened.view.type('#signin-password', 'whatever-it-is');
    await opened.view.click('form.signin__form button[type="submit"]');
    await settle();
    expect(opened.seen.at(-1)).toBe('/task/TSK-1');
    expect(asked.some((line) => line.includes('session/capabilities'))).toBe(false);
    expect(opened.view.find('[data-notice="other-business"]')).toBeNull();
    await opened.view.unmount();
  });
}
