// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The sign-in page opens one session, as the identity submitted for the
// attempt that made it. Mia (alpha) has an authenticator app; Ada (bravo) has
// none. A code check still out when its step is cancelled and Ada signs in
// instead opens nothing when it answers, and the sign-in it made goes. An
// answer lost at any step of a sign-in leaves the page asking again, and the
// retry opens as what was submitted for it, never as an earlier attempt or as
// whatever the form says now.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import { SESSION_HEADER, SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';

const GOTRUE = 'http://identity.invalid';
const SUBMIT = '[data-screen="sign-in"] button[type="submit"]';
const CANCEL = '[data-screen="sign-in"] button.btn--ghost';
const CODE = 'input[autocomplete="one-time-code"]';
const MIA = { businessKey: 'alpha', email: 'mia@alpha.local' };
const ADA = { businessKey: 'bravo', email: 'ada.bravo@example.test' };

/** The cookie id the API names for each token the page trades. */
const SESSIONS: Readonly<Record<string, string>> = {
  'Bearer aal1-mia@example.test': 'mia-half',
  'Bearer aal1-ada.bravo@example.test': 'ada-half',
  'Bearer aal2-mia@example.test': 'mia-full',
};

type Step = 'password grant' | 'cookie trade' | 'second-factor probe' | 'code check' | 'code trade';

/** A response the test answers, or fails as a lost one, when it chooses. */
function deferred() {
  let answer!: (response: Response) => void;
  let lose!: () => void;
  const promise = new Promise<Response>((resolve, reject) => {
    answer = resolve;
    lose = () => {
      reject(new TypeError('fetch failed'));
    };
  });
  return { promise, answer, lose };
}

/**
 * The provider and the API. `lost` loses that step's first answer; `held`
 * holds that step's first answer until the test lets it go.
 */
function world(options: { readonly lost?: Step; readonly held?: Step } = {}) {
  const lose = new Set<Step>(options.lost === undefined ? [] : [options.lost]);
  const hold = new Set<Step>(options.held === undefined ? [] : [options.held]);
  const holding = deferred();
  const ended: string[] = [];
  const answered = (step: Step, answer: () => Response): Promise<Response> => {
    if (lose.delete(step)) return Promise.reject(new TypeError('fetch failed'));
    if (hold.delete(step)) return holding.promise;
    return Promise.resolve(answer());
  };
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Readonly<Record<string, string>>;
    if (url.startsWith(`${GOTRUE}/token`)) {
      const { email } = JSON.parse(String(init?.body)) as { email: string };
      return answered('password grant', () => json({ access_token: `aal1-${email}` }));
    }
    if (url === SESSION_PATH) {
      const bearer = headers['authorization'] ?? '';
      const step = bearer.startsWith('Bearer aal2') ? 'code trade' : 'cookie trade';
      return answered(step, () => json({ ok: true, session: SESSIONS[bearer] }));
    }
    if (url.endsWith('/session/person')) {
      return answered('second-factor probe', () =>
        url.includes('/alpha/')
          ? json({ refused: true, code: 'AUTH_SECOND_FACTOR_REQUIRED', names: [], fixes: [] }, 401)
          : json({ person: { name: 'Ada Lin' } }),
      );
    }
    if (url.endsWith('/account/factor/verify')) {
      return answered('code check', () => json({ accessToken: 'aal2-mia@example.test' }));
    }
    if (url.endsWith('/sign-out') || url === `${SESSION_PATH}/end`) {
      ended.push(headers[SESSION_HEADER] ?? '');
    }
    return Promise.resolve(json({ ok: true }));
  };
  return { fetcher, holding, ended };
}

async function page(fetcher: typeof fetch) {
  const opened: Session[] = [];
  const view = await mount(
    <SignIn
      gotrueUrl={GOTRUE}
      apiOrigin=""
      fetch={fetcher}
      ended={null}
      build={null}
      onSignedIn={(session) => opened.push(session)}
    />,
  );
  const submit = async (who: { businessKey: string; email: string }) => {
    await view.type('#signin-email', who.email);
    await view.type('#signin-password', 'test-password');
    await view.choose('#signin-business', who.businessKey);
    await view.click(SUBMIT);
    await settle();
  };
  const code = async () => {
    await view.type(CODE, '123456');
    await view.click(SUBMIT);
    await settle();
  };
  return { view, opened, submit, code };
}

async function lateCodeCheckAfterCancel() {
  const { fetcher, holding } = world({ held: 'code check' });
  const { view, opened, submit, code } = await page(fetcher);
  await submit(MIA);
  expect(view.find(`${CODE}`), 'Mia is asked for her code').not.toBeNull();
  await code();
  await view.click(CANCEL);
  await settle();
  await submit(ADA);
  expect(opened).toEqual([{ ...ADA, sessionId: 'ada-half' }]);
  await act(async () => {
    holding.answer(json({ accessToken: 'aal2-mia@example.test' }));
    await settle();
  });
  expect(opened, 'the late check opens nothing').toEqual([{ ...ADA, sessionId: 'ada-half' }]);
  await view.unmount();
}

async function lateCodeTradeAfterCancel() {
  const { fetcher, holding, ended } = world({ held: 'code trade' });
  const { view, opened, submit, code } = await page(fetcher);
  await submit(MIA);
  await code();
  await view.click(CANCEL);
  await settle();
  await submit(ADA);
  await act(async () => {
    holding.answer(json({ ok: true, session: 'mia-full' }));
    await settle();
  });
  expect(opened).toEqual([{ ...ADA, sessionId: 'ada-half' }]);
  expect(ended, 'the sign-in the late trade made goes').toContain('mia-full');
  await view.unmount();
}

async function lostAnswerThenRetryAsAda(step: 'password grant' | 'cookie trade') {
  const { fetcher } = world({ lost: step });
  const { view, opened, submit } = await page(fetcher);
  await submit(MIA);
  expect(opened, 'the lost attempt opens nothing').toEqual([]);
  expect(view.find('[role="alert"]'), 'the page says the sign-in failed').not.toBeNull();
  await submit(ADA);
  expect(opened).toEqual([{ ...ADA, sessionId: 'ada-half' }]);
  await view.unmount();
}

async function lostProbeWhileFormChanged() {
  const probe = deferred();
  const { fetcher: base } = world();
  const fetcher: typeof fetch = async (input, init) =>
    String(input).endsWith('/session/person') ? await probe.promise : await base(input, init);
  const { view, opened, submit } = await page(fetcher);
  await submit(MIA);
  await view.type('#signin-email', ADA.email);
  await view.choose('#signin-business', ADA.businessKey);
  await act(async () => {
    probe.lose();
    await settle();
  });
  expect(opened).toEqual([{ ...MIA, sessionId: 'mia-half' }]);
  await view.unmount();
}

async function lostCodeAnswerThenCodeAgain(step: 'code check' | 'code trade') {
  const { fetcher } = world({ lost: step });
  const { view, opened, submit, code } = await page(fetcher);
  await submit(MIA);
  await code();
  expect(opened, 'the lost answer opens nothing').toEqual([]);
  expect(view.find(`${CODE}`), 'the code is asked again').not.toBeNull();
  await code();
  expect(opened).toEqual([{ ...MIA, sessionId: 'mia-full' }]);
  await view.unmount();
}

describe('sign-in opens one identity through crossed or lost answers', () => {
  it(
    'a code check answered after its step was cancelled and Ada signed in opens only Ada',
    lateCodeCheckAfterCancel,
  );

  it(
    'a code trade answered after its step was cancelled and Ada signed in opens only Ada and ends its cookie',
    lateCodeTradeAfterCancel,
  );

  it.each(['password grant', 'cookie trade'] as const)(
    'a lost %s answer, then a retry as Ada, opens Ada and never Mia',
    lostAnswerThenRetryAsAda,
  );

  it(
    'a lost second-factor probe answer opens Mia, as submitted, though the form was changed to Ada meanwhile',
    lostProbeWhileFormChanged,
  );

  it.each(['code check', 'code trade'] as const)(
    'a lost %s answer, then the code again, opens Mia once on her full sign-in',
    lostCodeAnswerThenCodeAgain,
  );
});
