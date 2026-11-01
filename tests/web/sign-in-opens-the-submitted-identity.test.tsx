// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A sign-in opens as the email and business it was submitted with. The form
// stays editable while the second-factor probe is out, so whatever the person
// types there by the time the sign-in finishes names nobody: the session the
// API issued belongs to the submitted login, and the shell must say so.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';
import { held } from './sign-in-again-support.tsx';

const SUBMIT = '[data-screen="sign-in"] button[type="submit"]';
const CODE = 'input[autocomplete="one-time-code"]';

/** Mia signs in to alpha, then the form is changed to Ada in bravo while the probe is held. */
async function editedDuringProbe() {
  const probe = held();
  let trades = 0;
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith('http://identity.invalid/token'))
      return Promise.resolve(json({ access_token: 'aal1' }));
    if (url === '/api/session') {
      trades += 1;
      return Promise.resolve(json({ ok: true, session: trades === 1 ? 'half' : 'full' }));
    }
    if (url.endsWith('/session/person')) return probe.wait();
    if (url.endsWith('/account/factor/verify')) {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      return Promise.resolve(json(code === '123456' ? { accessToken: 'aal2' } : {}));
    }
    return Promise.resolve(json({ ok: true }));
  };
  const opened: Session[] = [];
  const view = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetcher}
      ended={null}
      build={null}
      onSignedIn={(session) => opened.push(session)}
    />,
  );
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'test-password');
  await view.choose('#signin-business', 'alpha');
  await view.click(SUBMIT);
  await settle();
  await view.type('#signin-email', 'ada.bravo@example.test');
  await view.choose('#signin-business', 'bravo');
  return { view, probe, opened };
}

describe('a sign-in opens as the identity it was submitted with', () => {
  it('a code step opens the submitted identity despite edits during its probe', async () => {
    const { view, probe, opened } = await editedDuringProbe();
    await act(async () => {
      probe.answer(
        json({ refused: true, code: 'AUTH_SECOND_FACTOR_REQUIRED', names: [], fixes: [] }, 401),
      );
      await settle();
    });
    await view.type(CODE, '123456');
    await view.click(SUBMIT);
    await settle();
    expect(opened).toEqual([{ businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'full' }]);
    await view.unmount();
  });

  it('a sign-in with no code step opens the submitted identity despite edits during its probe', async () => {
    const { view, probe, opened } = await editedDuringProbe();
    await act(async () => {
      probe.answer(json({ person: { name: 'Mia Hart' } }));
      await settle();
    });
    expect(opened).toEqual([{ businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'half' }]);
    await view.unmount();
  });
});
