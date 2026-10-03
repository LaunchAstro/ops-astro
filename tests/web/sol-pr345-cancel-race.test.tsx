// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AuthenticatorSetup } from '../../apps/web/src/screens/settings/authenticator.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { describeFailure } from '../../apps/web/src/records/submit.ts';
import { mount } from '../surfaces/mount.tsx';
import { settle } from './mp-2-1-support.tsx';
import {
  api,
  clientD,
  closeRoutes,
  factorOf,
  fresh,
  json,
  openRoutes,
  type Reply,
} from '../api/c59-factor-routes-world.ts';

let releaseCancelled: (() => void) | undefined;
let issued = 0;
const replies: Record<string, Reply> = {
  'POST /factors': (request, response) => {
    issued += 1;
    const ordinal = issued;
    const reply = () =>
      json(200, {
        id: ordinal === 1 ? 'factor-one' : 'factor-two',
        totp: {
          qr_code: 'data:image/svg+xml,<svg/>',
          secret: ordinal === 1 ? 'CANCELLED-SECRET' : 'DISPLAYED-SECRET',
          uri: 'otpauth://totp/test',
        },
      })(request, response, '');
    if (ordinal === 1) releaseCancelled = reply;
    else reply();
  },
  'POST /factors/factor-one/challenge': json(200, { id: 'challenge-one' }),
  'POST /factors/factor-one/verify': json(422, {
    msg: 'Invalid TOTP code for the cancelled factor.',
  }),
  'POST /factors/factor-two/challenge': json(200, { id: 'challenge-two' }),
  'POST /factors/factor-two/verify': json(200, {
    access_token: 'aal2',
    refresh_token: 'refresh',
    expires_in: 3600,
  }),
  'POST /logout?scope=others': (_request, response) => {
    response.writeHead(204);
    response.end();
  },
};

beforeAll(async () => {
  await openRoutes('sol345cancel', { replies: () => replies, saw: () => {} });
}, 60_000);
afterAll(async () => {
  await closeRoutes();
});

it('Sol proof, criterion 5: a cancelled enrolment cannot invalidate the displayed replacement when it finishes later', async () => {
  const token = await fresh(clientD);
  let completed = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    // Only the identity provider is substituted, via the existing loopback
    // fixture. The real API, factor commands and migrated Postgres run here.
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      const answer = await api.request(String(input), { ...init, headers });
      if (String(input).endsWith('/account/factor/enrol')) completed += 1;
      return answer;
    },
  });
  const stepUp = async (code: string) => {
    const result = await client.verifyFactor(code);
    return 'ok' in result
      ? { ok: true as const, sessionId: 'sid-new' }
      : { ok: false as const, because: describeFailure(result) ?? 'Verification failed.' };
  };
  const view = await mount(
    <StepUpContext.Provider value={stepUp}>
      <AuthenticatorSetup client={client} />
    </StepUpContext.Provider>,
  );
  try {
    await view.click('[data-factor="enrol"] button');
    await vi.waitFor(() => expect(releaseCancelled).toBeTypeOf('function'));
    await view.click('[data-factor="cancel"] button');
    // A fix may keep enrolment busy until the cancelled call settles. Let
    // that safe serial ordering finish before asking for the replacement.
    const restart = view.find('[data-factor="enrol"] button');
    if (restart === null || restart.hasAttribute('disabled')) {
      releaseCancelled?.();
      releaseCancelled = undefined;
      await vi.waitFor(() => expect(completed).toBe(1));
      await settle();
    }
    await view.click('[data-factor="enrol"] button');
    await vi.waitFor(() =>
      expect(view.find('[data-factor="secret"]')?.textContent).toBe('DISPLAYED-SECRET'),
    );
    expect((await factorOf(clientD.personId))?.providerFactorId).toBe('factor-two');
    releaseCancelled?.();
    await vi.waitFor(() => expect(completed).toBe(2));
    await settle();
    expect(view.find('[data-factor="secret"]')?.textContent).toBe('DISPLAYED-SECRET');
    await view.type('[data-step-up="code"]', '222222');
    await view.click('[data-factor="confirm"] button');
    await vi.waitFor(() =>
      expect(view.find('[data-factor="done"]') ?? view.find('[role="alert"]')).not.toBeNull(),
    );
    // The current displayed key has a good code at the provider. The
    // cancelled request must not replace its database target afterwards.
    expect(
      view.find('[data-factor="done"]'),
      `live target=${(await factorOf(clientD.personId))?.providerFactorId}; panel=${view.text()}`,
    ).not.toBeNull();
  } finally {
    await view.unmount();
  }
}, 30_000);
