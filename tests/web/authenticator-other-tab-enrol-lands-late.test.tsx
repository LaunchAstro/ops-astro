// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable max-lines-per-function -- Sol's proof, kept as written */
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

let releaseFirst: (() => void) | undefined;
let issued = 0;
const replies: Record<string, Reply> = {
  'POST /factors': (request, response) => {
    const ordinal = ++issued;
    const reply = () =>
      json(200, {
        id: ordinal === 1 ? 'factor-one' : 'factor-two',
        totp: {
          qr_code: 'data:image/svg+xml,<svg/>',
          secret: ordinal === 1 ? 'CANCELLED-OTHER-TAB' : 'DISPLAYED-HERE',
          uri: 'otpauth://totp/test',
        },
      })(request, response, '');
    if (ordinal === 1) releaseFirst = reply;
    else reply();
  },
  'POST /factors/factor-one/challenge': json(200, { id: 'challenge-one' }),
  'POST /factors/factor-one/verify': json(422, {
    msg: 'Code belongs to the displayed second factor.',
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
  await openRoutes('solf1twotabs', { replies: () => replies, saw: () => {} });
}, 60_000);
afterAll(async () => {
  await closeRoutes();
});

// Sol F1-FIX1 criterion 5, retitled by what it proves; its body is Sol's.
it('a cancelled enrolment from another tab cannot replace the displayed factor', async () => {
  const token = await fresh(clientD);
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return await api.request(String(input), { ...init, headers });
    },
  });
  // Tab A has its own module-local landing promise. Its already dispatched
  // request survives cancelling or closing that tab. Send that request through
  // the same real client; the panel below is tab B's independent enrol queue.
  const abandoned = client.enrolFactor();
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
  const stepUp = async (code: string) => {
    const result = await client.verifyFactor(code);
    return 'ok' in result
      ? { ok: true as const, sessionId: 'upgraded' }
      : { ok: false as const, because: describeFailure(result) ?? 'Verification failed.' };
  };
  const view = await mount(
    <StepUpContext.Provider value={stepUp}>
      <AuthenticatorSetup client={client} />
    </StepUpContext.Provider>,
  );
  try {
    await view.click('[data-factor="enrol"] button');
    await vi.waitFor(() =>
      expect(view.find('[data-factor="secret"]')?.textContent).toBe('DISPLAYED-HERE'),
    );
    expect((await factorOf(clientD.personId))?.providerFactorId).toBe('factor-two');
    const release = releaseFirst;
    releaseFirst = undefined;
    release?.();
    await abandoned;
    await settle();
    expect(view.find('[data-factor="secret"]')?.textContent).toBe('DISPLAYED-HERE');
    await view.type('[data-step-up="code"]', '222222');
    await view.click('[data-factor="confirm"] button');
    await vi.waitFor(() =>
      expect(view.find('[data-factor="done"]') ?? view.find('[role="alert"]')).not.toBeNull(),
    );
    expect(
      view.find('[data-factor="done"]'),
      `live target=${(await factorOf(clientD.personId))?.providerFactorId}; panel=${view.text()}`,
    ).not.toBeNull();
  } finally {
    const release = releaseFirst;
    releaseFirst = undefined;
    release?.();
    await abandoned;
    await view.unmount();
  }
}, 30_000);
