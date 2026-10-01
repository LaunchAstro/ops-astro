// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-12 (REVIEW-BATCH-2 #312, batch 3a). The Agent drawer must not
// survive a business switch. The held-address notice's switch
// (`apps/web/src/App.tsx`, `onSwitch`) swaps the session to the other business
// and keeps the page; `<AssistantView>` carries no key and the shell keeps the
// panel mounted, so the drawer keeps the old business's tabs: its questions,
// its conversation's address and its conversation id, and the next question is
// posted to the new business as a message on the old business's conversation.
// The application is the real one, mounted as `tests/surfaces/mp-7-11-dock.test.tsx`
// and `tests/web/mp-2-1-held-address.test.tsx` mount it; the network is a
// recorder.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { json, open, settle, silent } from '../web/mp-2-1-support.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const FRESH_SESSION = 'fresh-session';
const ALPHA_CONVERSATION = '11111111-1111-4111-8111-111111111111';
const BRAVO_CONVERSATION = '22222222-2222-4222-8222-222222222222';
const HELD = {
  'ops-astro.return-to': JSON.stringify({
    address: '/task/TSK-1',
    businessKey: 'bravo',
    code: 'AUTH_SESSION_EXPIRED',
  }),
};

interface Posted {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The identity provider and the API: Bravo grants the person, and each business answers a start with its own conversation. */
function world(posted: Posted[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.startsWith('http://identity.invalid/token')) return json({ access_token: 'fresh' });
    if (at === '/api/session') return json({ ok: true, session: FRESH_SESSION });
    if (at.startsWith('/api/b/bravo/session/capabilities')) {
      return json({ ok: true, personId: 'p', businessKey: 'bravo', grants: [] });
    }
    if (/\/conversation\/(?:start|message)$/u.test(at)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posted.push({ url: at, body });
      const conversationId = at.startsWith('/api/b/bravo/')
        ? BRAVO_CONVERSATION
        : ALPHA_CONVERSATION;
      return json({ recordId: '', revision: 0, detail: { conversationId } });
    }
    return await silent(url, init);
  }) as unknown as typeof fetch;
}

async function signInToAlphaWithBravoHeld(posted: Posted[]) {
  const opened = await open('/sign-in', { businessKey: null, seed: HELD, fetch: world(posted) });
  const { view } = opened;
  track(view);
  await view.choose('#signin-business', 'alpha');
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'whatever-it-is');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  return opened;
}

describe('REVIEW-3A-12 drawer across a business switch', () => {
  it('REVIEW-3A-12: switching business leaves none of the old business’s conversation in the drawer, and a later question does not post to the old conversation', async () => {
    const posted: Posted[] = [];
    const { view, sessions } = await signInToAlphaWithBravoHeld(posted);
    expect(sessions.session?.businessKey).toBe('alpha');
    expect(view.find('[data-switch="held-address"]')).not.toBeNull();

    // Alpha: open the drawer and ask; the conversation starts in Alpha.
    await view.click('[aria-label="Open Agent"]');
    await view.type('[data-assistant="input"]', 'What is on Alpha’s board?');
    await press(view, '[data-assistant="input"]', 'Enter');
    await settle();
    expect(posted.map((each) => each.url)).toStrictEqual(['/api/b/alpha/conversation/start']);
    expect(view.all('[data-message-role]').length).toBeGreaterThan(0);
    expect(view.find('[data-assistant="address"]')?.getAttribute('href')).toContain(
      ALPHA_CONVERSATION,
    );

    // Switch to Bravo from the notice.
    await view.click('[data-switch="held-address"]');
    await settle();
    expect(sessions.session?.businessKey).toBe('bravo');
    expect(
      view.all('[data-message-role]').map((each) => each.textContent),
      'the old business’s messages are still drawn after the switch',
    ).toStrictEqual([]);
    expect(
      view.find('[data-assistant="address"]')?.getAttribute('href') ?? null,
      'the old business’s conversation address is still drawn after the switch',
    ).toBeNull();

    // A question in Bravo never names Alpha's conversation. A fix may close
    // the drawer on the switch instead; then it is opened again to ask.
    if (view.find('[data-assistant="panel"]') === null)
      await view.click('[aria-label="Open Agent"]');
    await view.type('[data-assistant="input"]', 'What is on Bravo’s board?');
    await press(view, '[data-assistant="input"]', 'Enter');
    await settle();
    const after = posted.slice(1);
    expect(after.length).toBeGreaterThan(0);
    expect(
      after.filter((each) => each.body['conversationId'] === ALPHA_CONVERSATION),
      'a question asked after the switch was posted on the old business’s conversation id',
    ).toStrictEqual([]);
  });
});
