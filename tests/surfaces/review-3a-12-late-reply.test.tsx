// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-12 (REVIEW-BATCH-2 #312, batch 3a), the in-flight half: a reply
// still out when the business switches never lands in the drawer. Alpha's
// start is held, the person switches to Bravo from the held-address notice,
// then Alpha's answer arrives; the drawer under Bravo draws none of it.
// Mounted as `review-3a-12-drawer-business-switch.test.tsx` mounts it.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { json, open, settle, silent } from '../web/mp-2-1-support.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const ALPHA_CONVERSATION = '11111111-1111-4111-8111-111111111111';
const ALPHA_ANSWER = 'Alpha’s board has three tasks.';
const HELD = {
  'ops-astro.return-to': JSON.stringify({
    address: '/task/TSK-1',
    businessKey: 'bravo',
    code: 'AUTH_SESSION_EXPIRED',
  }),
};

/** The identity provider and the API, Alpha's start answered only when the test lets it go. */
function world(held: Promise<void>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.startsWith('http://identity.invalid/token')) return json({ access_token: 'fresh' });
    if (at === '/api/session') return json({ ok: true, session: 'fresh-session' });
    if (at.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    if (at.startsWith('/api/b/bravo/session/capabilities')) {
      return json({ ok: true, personId: 'p', businessKey: 'bravo', grants: [] });
    }
    if (at === '/api/b/alpha/conversation/start') {
      await held;
      return json({
        recordId: '',
        revision: 0,
        detail: { conversationId: ALPHA_CONVERSATION },
        reply: { answered: true, messageId: 'm-1', body: ALPHA_ANSWER },
      });
    }
    return await silent(url, init);
  }) as unknown as typeof fetch;
}

describe('REVIEW-3A-12 a reply still out across a business switch', () => {
  it('REVIEW-3A-12: the old business’s answer arriving after the switch is not drawn', async () => {
    const released: (() => void)[] = [];
    const held = new Promise<void>((resolve) => {
      released.push(resolve);
    });
    const { view, sessions } = await open('/sign-in', {
      businessKey: null,
      seed: HELD,
      fetch: world(held),
    });
    track(view);
    await view.choose('#signin-business', 'alpha');
    await view.type('#signin-email', 'mia@alpha.local');
    await view.type('#signin-password', 'whatever-it-is');
    await view.click('form.signin__form button[type="submit"]');
    await settle();

    await view.click('[aria-label="Open Agent"]');
    await view.type('[data-assistant="input"]', 'What is on Alpha’s board?');
    await press(view, '[data-assistant="input"]', 'Enter');
    await view.click('[data-switch="held-address"]');
    await settle();
    expect(sessions.session?.businessKey).toBe('bravo');

    for (const resolve of released) resolve();
    await settle();
    await settle();
    expect(
      view.all('[data-message-role]').map((each) => each.textContent),
      'the old business’s answer was drawn under the new business',
    ).toStrictEqual([]);
    expect(view.find('[data-assistant="address"]')).toBeNull();
  });
});
