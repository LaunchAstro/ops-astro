// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Changing the authenticator app on Settings ▸ General (C59, Q2): removing it
// with the current code, after which set-up is offered again; an enrol refused
// `FACTOR_ALREADY_ENROLLED` opens that removal; and an enrol refused
// `FRESH_SIGN_IN_REQUIRED` asks for the password, signs in again and starts the
// set-up again on the client the application builds for the new sign-in. The
// application's half is the stand-in of `sign-in-again-support.tsx`.

import { afterEach, describe, expect, it } from 'vitest';
import { AuthenticatorSetup } from '../../apps/web/src/screens/settings/authenticator.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';
import {
  FRESH,
  PASSWORD,
  drawSignedIn,
  refusal,
  typedPasswords,
  type Call,
  type Route,
} from './sign-in-again-support.tsx';

const PANEL = '[data-factor="panel"]';
const CANARY = 'CHANGE-CANARY-SECRET';
const issued = {
  factorId: 'factor-2',
  qrCode: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"/>',
  secret: CANARY,
  uri: `otpauth://totp/x?secret=${CANARY}`,
};
const ENROLLED = [
  'You already have an authenticator app. To replace it, remove it with a code from it first.',
];
const FRESH_FIXES = [
  'Sign in again with your password, then set up the authenticator app within 60 minutes.',
];

const removes = (call: Call): boolean => call.url.endsWith('/account/factor/remove');
const enrols = (call: Call): boolean => call.url.endsWith('/account/factor/enrol');

/** The remove route: the current code `123456` removes it, any other is refused. */
const goodRemove: Route = (call) => {
  if (!removes(call)) return null;
  return Promise.resolve(
    call.body['code'] === '123456'
      ? json({ removed: true, otherSessions: { ended: 2, signedOutAtProvider: true } })
      : refusal(
          'SECOND_FACTOR_INVALID',
          ['Check the code in your authenticator app and retry.'],
          422,
        ),
  );
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await view.unmount();
  }
});

async function panel(route: Route) {
  const drawn = await drawSignedIn(route, (client) => <AuthenticatorSetup client={client} />);
  live.push(drawn.view);
  await settle();
  return drawn;
}

async function removeWith(view: Mounted, code: string): Promise<void> {
  await view.type(`${PANEL} [data-factor="remove-code"]`, code);
  await view.click(`${PANEL} [data-factor="remove-confirm"] button`);
  await settle();
}

// eslint-disable-next-line max-lines-per-function -- one case per part of the change
describe('authenticator change', () => {
  it('authenticator remove: the current code removes it, says other sessions were signed out and offers set-up again', async () => {
    const { view, server } = await panel(goodRemove);
    await view.click(`${PANEL} [data-factor="remove"] button`);
    await settle();
    await removeWith(view, '123456');
    expect(server.calls.filter((call) => removes(call))).toMatchObject([
      { url: '/api/b/alpha/account/factor/remove', session: 'sid-old', body: { code: '123456' } },
    ]);
    const said = view.find(`${PANEL} [data-factor="removed"]`)?.textContent ?? '';
    expect(said).toContain('removed');
    expect(said).toContain('signed out');
    expect(view.find(`${PANEL} [data-factor="remove-code"]`)).toBeNull();
    expect(view.find(`${PANEL} [data-factor="enrol"] button`)?.textContent).toContain(
      'Set up authenticator app',
    );
  });

  it('authenticator remove: a refusal is drawn in the server’s words and the form stays for another try', async () => {
    const { view, server } = await panel(goodRemove);
    await view.click(`${PANEL} [data-factor="remove"] button`);
    await settle();
    await removeWith(view, '000000');
    const alert = view.find(`${PANEL} [role="alert"]`)?.textContent ?? '';
    expect(alert).toContain('SECOND_FACTOR_INVALID');
    expect(alert).toContain('Check the code in your authenticator app and retry.');
    expect(view.find(`${PANEL} [data-factor="removed"]`)).toBeNull();
    await removeWith(view, '123456');
    expect(server.calls.filter((call) => removes(call))).toHaveLength(2);
    expect(view.find(`${PANEL} [data-factor="removed"]`)).not.toBeNull();
  });

  it('authenticator set-up: FACTOR_ALREADY_ENROLLED opens the remove form', async () => {
    const route: Route = (call) =>
      enrols(call)
        ? Promise.resolve(refusal('FACTOR_ALREADY_ENROLLED', ENROLLED, 409))
        : goodRemove(call);
    const { view, server } = await panel(route);
    await view.click(`${PANEL} [data-factor="enrol"] button`);
    await settle();
    expect(view.find(`${PANEL} [data-factor="outcome"]`)?.textContent).toContain(ENROLLED[0]);
    expect(view.find(`${PANEL} [data-factor="remove-code"]`)).not.toBeNull();
    await removeWith(view, '123456');
    expect(server.calls.filter((call) => removes(call))).toHaveLength(1);
    expect(view.find(`${PANEL} [data-factor="removed"]`)).not.toBeNull();
  });

  it('authenticator set-up: FRESH_SIGN_IN_REQUIRED asks for the password, and once signed in again the set-up starts again on the new sign-in', async () => {
    const route: Route = (call) => {
      if (!enrols(call)) return null;
      return Promise.resolve(
        call.session === 'sid-new'
          ? json(issued)
          : refusal('FRESH_SIGN_IN_REQUIRED', FRESH_FIXES, 403),
      );
    };
    const { view, server, sessions } = await panel(route);
    await view.click(`${PANEL} [data-factor="enrol"] button`);
    await settle();
    expect(view.find(`${PANEL} [data-factor="outcome"]`)?.textContent).toContain(FRESH_FIXES[0]);
    const field = view.find(`${PANEL} [data-factor="password"]`) as HTMLInputElement | null;
    expect(field?.type).toBe('password');
    expect(field?.getAttribute('autocomplete')).toBe('current-password');

    await view.type(`${PANEL} [data-factor="password"]`, PASSWORD);
    await view.click(`${PANEL} [data-factor="sign-in"] button`);
    await settle();
    expect(server.calls.filter((call) => call.url === '/api/session')).toMatchObject([
      { authorization: `Bearer ${FRESH}` },
    ]);
    expect(sessions.session?.sessionId).toBe('sid-new');
    expect(server.to('/account/sessions/sign-out')).toMatchObject([{ session: 'sid-old' }]);
    expect(server.calls.filter((call) => enrols(call)).map((call) => call.session)).toStrictEqual([
      'sid-old',
      'sid-new',
    ]);
    expect(view.find(`${PANEL} [data-factor="secret"]`)?.textContent).toBe(CANARY);
    expect(view.find(`${PANEL} [data-factor="password"]`)).toBeNull();
    expect(typedPasswords(view)).toStrictEqual([]);
  });
});
