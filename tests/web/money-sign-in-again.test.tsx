// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A client meeting the money step-up (C59, Q1): the server's `STEP_UP_REQUIRED`
// names `sign_in`, so the prompt asks for the password rather than a code. A
// good password is a fresh sign-in, a new provider session: its token is
// traded for a new cookie, the tab moves to it, the old sign-in is signed out
// at the API, the provider and its cookie, and the write goes once more. The
// password is sent to the provider and kept nowhere. The server's half is
// `tests/identity/c59-step-up-client-sign-in.test.ts`.

import { useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useMoneyCommand } from '../../apps/web/src/records/use-money-command.ts';
import { StepUpPrompt } from '../../apps/web/src/views/step-up-prompt.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';
import {
  EMAIL,
  FRESH,
  FRESH_REFRESH,
  GOTRUE,
  PASSWORD,
  drawSignedIn,
  held,
  refusal,
  typedPasswords,
  type Call,
  type Route,
} from './sign-in-again-support.tsx';

const WRITE = '/budget/set_planning_cap';
const PROMPT = '[data-step-up="prompt"]';
const SIGN_IN = [
  'Sign in again with your password, then retry.',
  'A money action needs a sign-in in the last 60 minutes.',
];
const CODE = [
  'Sign in again with the code from your authenticator app, then retry.',
  'A money action needs a sign-in with the second factor in the last 60 minutes.',
];

/** The money write: applied on the new sign-in, refused the step-up on the old. */
const money =
  (names: readonly string[], fixes: readonly string[]): Route =>
  (call: Call) => {
    if (!call.url.endsWith(WRITE)) return null;
    return Promise.resolve(
      call.session === 'sid-new'
        ? json({ recordId: null, revision: null, detail: { state: 'applied' } })
        : refusal('STEP_UP_REQUIRED', fixes, 403, names),
    );
  };

/** One money write, sent from a button, and the hook's prompt. */
function Probe(props: { readonly client: OperationsClient }): ReactElement {
  const command = useMoneyCommand(props.client);
  const [sent, setSent] = useState(0);
  return (
    <div>
      <button
        type="button"
        data-probe="send"
        onClick={() => {
          setSent(sent + 1);
          command.run((client) =>
            client.mutate('budget.set_planning_cap', {
              limitMinor: 7_500,
              currency: 'AUD',
              fromLimitMinor: 5_000,
            }),
          );
        }}
      >
        Send
      </button>
      {command.stepUp === null ? null : <StepUpPrompt ask={command.stepUp} />}
    </div>
  );
}

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await view.unmount();
  }
  vi.restoreAllMocks();
});

type Spy = { readonly mock: { readonly calls: readonly (readonly unknown[])[] } };
const spies: Spy[] = [];
const written = (): string[] =>
  spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')));
beforeEach(() => {
  spies.length = 0;
  spies.push(vi.spyOn(Storage.prototype, 'setItem'));
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(vi.spyOn(console, method));
  }
});

/** The write sent and refused the step-up, naming `sign_in` unless told otherwise. */
async function refused(extra: Route = () => null, names = ['sign_in'], fixes = SIGN_IN) {
  const route: Route = (call) => extra(call) ?? money(names, fixes)(call);
  const drawn = await drawSignedIn(route, (client) => <Probe client={client} />);
  live.push(drawn.view);
  await drawn.view.click('[data-probe="send"]');
  await settle();
  return drawn;
}

async function signInWith(view: Mounted, password: string): Promise<void> {
  await view.type(`${PROMPT} [data-step-up="password"]`, password);
  await view.click(`${PROMPT} [data-step-up="confirm"]`);
  await settle();
}

const isGoTrue = (call: Call): boolean => call.url.startsWith(GOTRUE);
const trades = (calls: readonly Call[]) => calls.filter((call) => call.url === '/api/session');

// eslint-disable-next-line max-lines-per-function -- one case per part of the sign-in again
describe('money step-up by signing in again', () => {
  it('money sign-in again: a refusal naming sign_in asks for the password, and a good sign-in resends the write once on the new session', async () => {
    const { view, server, sessions } = await refused();
    const field = view.find(`${PROMPT} [data-step-up="password"]`) as HTMLInputElement | null;
    expect(field?.type).toBe('password');
    expect(field?.getAttribute('autocomplete')).toBe('current-password');
    expect(view.find(`label[for="${field?.id ?? 'none'}"]`)?.textContent).toBe('Password');
    expect(view.find(`${PROMPT} [data-step-up="code"]`)).toBeNull();
    expect(view.find(`${PROMPT} [data-step-up="confirm"]`)?.textContent).toBe(
      'Sign in again and send',
    );
    expect(view.find(`${PROMPT}`)?.textContent).toContain('sign-in within the last hour');

    await signInWith(view, PASSWORD);
    expect(server.calls.filter((call) => isGoTrue(call))).toMatchObject([
      { url: `${GOTRUE}/token?grant_type=password`, body: { email: EMAIL, password: PASSWORD } },
    ]);
    expect(trades(server.calls)).toMatchObject([{ authorization: `Bearer ${FRESH}` }]);
    expect(server.to(WRITE).map((call) => call.session)).toStrictEqual(['sid-old', 'sid-new']);
    expect(sessions.session?.sessionId).toBe('sid-new');
    expect(view.find(`${PROMPT}`)).toBeNull();
  });

  it('money sign-in again: a team member’s refusal, naming nothing, still asks for the code', async () => {
    const { view } = await refused(() => null, [], CODE);
    expect(view.find(`${PROMPT} [data-step-up="code"]`)).not.toBeNull();
    expect(view.find(`${PROMPT} [data-step-up="password"]`)).toBeNull();
  });

  it('money sign-in again: a wrong password shows GoTrue’s words in the prompt and sends nothing', async () => {
    const { view, server, sessions } = await refused();
    await signInWith(view, 'not-the-password');
    expect(view.find(`${PROMPT} [role="alert"]`)?.textContent).toContain(
      'Invalid login credentials',
    );
    expect(trades(server.calls)).toEqual([]);
    expect(server.to('/account/sessions/sign-out')).toEqual([]);
    expect(server.to(WRITE)).toHaveLength(1);
    expect(sessions.session?.sessionId).toBe('sid-old');
  });

  it('money sign-in again: a session ended during the sign-in sends nothing and signs the new sign-in out at the provider and its cookie', async () => {
    const trade = held();
    const { view, server, end } = await refused((call) =>
      call.url === '/api/session' ? trade.wait() : null,
    );
    await signInWith(view, PASSWORD);
    await end();
    trade.answer(json({ ok: true, session: 'sid-new' }));
    await settle();
    const ended = server.calls.filter((call) => call.url === '/api/session/end');
    expect(ended.map((call) => call.session)).toStrictEqual(['sid-new']);
    expect(server.to('/account/sessions/sign-out').map((call) => call.session)).toStrictEqual([
      'sid-new',
    ]);
    expect(server.to(WRITE)).toHaveLength(1);
  });

  it('money sign-in again: a session ended during the password check signs the new token out at GoTrue and trades nothing', async () => {
    const password = held();
    const { view, server, end } = await refused((call) =>
      call.url === `${GOTRUE}/token?grant_type=password` ? password.wait() : null,
    );
    await signInWith(view, PASSWORD);
    await end();
    password.answer(json({ access_token: FRESH, refresh_token: 'r' }));
    await settle();
    expect(server.to('/logout?scope=local')).toMatchObject([
      { url: `${GOTRUE}/logout?scope=local`, authorization: `Bearer ${FRESH}` },
    ]);
    expect(trades(server.calls)).toEqual([]);
    expect(server.to(WRITE)).toHaveLength(1);
  });

  it('money sign-in again: a cookie trade the API refuses signs the new token out at GoTrue and sends nothing', async () => {
    const { view, server, sessions } = await refused((call) =>
      call.url === '/api/session' ? Promise.resolve(refusal('AUTH_UNKNOWN_LOGIN', [], 401)) : null,
    );
    await signInWith(view, PASSWORD);
    expect(server.to('/logout?scope=local')).toMatchObject([{ authorization: `Bearer ${FRESH}` }]);
    expect(server.to(WRITE)).toHaveLength(1);
    expect(sessions.session?.sessionId).toBe('sid-old');
  });

  it('money sign-in again: the old sign-in is signed out at the API, the provider and its cookie once the tab has moved', async () => {
    const { view, server } = await refused();
    await signInWith(view, PASSWORD);
    const signOut = server.to('/account/sessions/sign-out');
    expect(signOut).toMatchObject([
      { url: '/api/b/alpha/account/sessions/sign-out', session: 'sid-old', tabAt: 'sid-new' },
    ]);
    const cookies = server.calls.filter((call) => call.url === '/api/session/end');
    expect(cookies).toMatchObject([{ session: 'sid-old', tabAt: 'sid-new' }]);
    const order = server.calls.map((call) => call.url);
    expect(order.indexOf('/api/b/alpha/account/sessions/sign-out')).toBeGreaterThan(
      order.indexOf('/api/session'),
    );
  });

  it('money sign-in again never: keeps the password in storage, the console, the page or any call but the provider’s', async () => {
    const { view, server, held: kept } = await refused();
    await signInWith(view, 'not-the-password');
    expect(typedPasswords(view)).toStrictEqual(['']);
    await signInWith(view, PASSWORD);
    const anywhere = [
      ...written(),
      JSON.stringify([...kept.entries()]),
      JSON.stringify({ ...window.sessionStorage }),
      JSON.stringify({ ...window.localStorage }),
      document.body.innerHTML,
      ...typedPasswords(view),
    ].join('\n');
    for (const secret of [PASSWORD, FRESH, FRESH_REFRESH]) expect(anywhere).not.toContain(secret);
    const toApi = JSON.stringify(server.calls.filter((call) => !isGoTrue(call)));
    expect(toApi).not.toContain(PASSWORD);
    expect(server.to(WRITE)).toHaveLength(2);
  });
});
