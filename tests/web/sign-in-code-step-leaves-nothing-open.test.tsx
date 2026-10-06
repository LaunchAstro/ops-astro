// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in code step (C59) leaves no sign-in open behind a person who did
// not finish it. A Cancel that lands while the good code's new sign-in is
// being finished signs that new one out too; leaving the page while the code
// step is open signs the half-made one out, as Cancel does. A good code that
// opened the session is never signed out by the page going.

import { describe, expect, it, vi } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';

const SUBMIT = '[data-screen="sign-in"] button[type="submit"]';
const CODE = 'input[autocomplete="one-time-code"]';
const CANCEL = '.signin__foot .btn--ghost';

/** A login holding a verified factor; `hold` keeps the half sign-in's cookie end unanswered. */
function world(hold: boolean) {
  const sent: string[] = [];
  let trades = 0;
  let release: (() => void) | undefined;
  const answer = (url: string, init?: RequestInit): Response | Promise<Response> => {
    const session = new Headers(init?.headers).get('x-ops-astro-session') ?? '-';
    sent.push(`${url} ${session}`);
    if (url.startsWith('http://identity.invalid/token')) return json({ access_token: 'aal1' });
    if (url === '/api/session') {
      trades += 1;
      return json({ ok: true, session: trades === 1 ? 'half' : 'full' });
    }
    if (url.endsWith('/session/person')) {
      return json(
        { refused: true, code: 'AUTH_SECOND_FACTOR_REQUIRED', names: [], fixes: [] },
        401,
      );
    }
    if (url.endsWith('/account/factor/verify')) return json({ accessToken: 'aal2' });
    if (hold && release === undefined && url === '/api/session/end' && session === 'half') {
      return new Promise((done) => {
        release = () => {
          done(json({ ok: true }));
        };
      });
    }
    return json({ ok: true });
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(String(url), init))) as unknown as typeof globalThis.fetch;
  return { fetch, sent, release: () => release?.() };
}

async function atCodeStep(hold = false) {
  const { fetch, sent, release } = world(hold);
  const opened: Session[] = [];
  const view = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      ended={null}
      build={null}
      onSignedIn={(session) => {
        opened.push(session);
      }}
    />,
  );
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'test-password');
  await view.click(SUBMIT);
  await settle();
  expect(view.find('input[autocomplete="one-time-code"]')).not.toBeNull();
  return { view, sent, opened, release };
}

const signOuts = (sent: readonly string[]) => sent.filter((line) => line.includes('sign-out'));

describe('the sign-in code step leaves nothing open', () => {
  it('a cancel landing while the new sign-in is finished signs that one out too', async () => {
    const { view, sent, opened, release } = await atCodeStep(true);
    try {
      await view.type(CODE, '123456');
      await view.click(SUBMIT);
      // The new cookie is set and the half one's end is in flight: Cancel now.
      await vi.waitFor(() => {
        expect(sent).toContain('/api/session/end half');
      });
      await view.click(CANCEL);
      release();
      await settle();
      expect(opened).toEqual([]);
      expect(sent).toContain('/api/b/alpha/account/sessions/sign-out full');
      expect(sent).toContain('/api/session/end full');
    } finally {
      await view.unmount();
    }
  });

  it('leaving the page in the code step signs the half-made sign-in out', async () => {
    const { view, sent, opened } = await atCodeStep();
    expect(signOuts(sent)).toEqual([]);
    await view.unmount();
    await settle();
    expect(opened).toEqual([]);
    expect(signOuts(sent)).toEqual(['/api/b/alpha/account/sessions/sign-out half']);
    expect(sent).toContain('/api/session/end half');
  });

  it('leaving the page once a good code opened the session signs nothing out', async () => {
    const { view, sent, opened } = await atCodeStep();
    await view.type(CODE, '123456');
    await view.click(SUBMIT);
    await settle();
    expect(opened).toEqual([{ businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'full' }]);
    await view.unmount();
    await settle();
    expect(signOuts(sent)).toEqual([]);
  });
});
