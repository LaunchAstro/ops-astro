// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// "Set up an authenticator app" (C59) orders its enrols one after another and
// keeps nothing of their answers beyond the panel that shows one. Once the
// panel is cancelled and gone, the issued factor (its secret, its QR) can be
// collected. An enrol that fails outright says so and leaves Start working.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import type {
  CallResult,
  IssuedFactor,
  OperationsClient,
} from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { AuthenticatorSetup } from '../../apps/web/src/screens/settings/authenticator.tsx';
import { mount } from '../surfaces/mount.tsx';
import { settle } from './mp-2-1-support.tsx';

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

const START = '[data-factor="enrol"] button';

const stepUp = () => Promise.resolve({ ok: false as const, because: 'not used here' });

/** A client whose enrols answer from `enrols`, in turn; only `enrolFactor` is used. */
const clientOf = (enrols: (() => Promise<CallResult<IssuedFactor>>)[]): OperationsClient =>
  ({
    businessKey: 'alpha',
    enrolFactor: async () => await (enrols.shift() ?? (() => new Promise(() => {})))(),
  }) as unknown as OperationsClient;

const panel = async (client: OperationsClient) =>
  await mount(
    <StepUpContext.Provider value={stepUp}>
      <AuthenticatorSetup client={client} />
    </StepUpContext.Provider>,
  );

it('a cancelled set-up, once its panel is gone, keeps no issued factor in memory', async () => {
  let issued: WeakRef<IssuedFactor> | undefined;
  const enrol = () => {
    const factor = { factorId: 'f-1', qrCode: null, secret: 'KEPT-NOWHERE', uri: 'otpauth://x' };
    issued = new WeakRef(factor as unknown as IssuedFactor);
    return Promise.resolve({ ok: true as const, value: factor as unknown as IssuedFactor });
  };
  const view = await panel(clientOf([enrol]));
  await view.click(START);
  await settle();
  expect(view.find('[data-factor="secret"]')?.textContent).toBe('KEPT-NOWHERE');
  await view.click('[data-factor="cancel"] button');
  await view.unmount();
  await settle();
  collect();
  await settle();
  collect();
  expect(issued?.deref()).toBeUndefined();
});

it('an enrol that fails outright leaves later set-ups free to enrol, and says so', async () => {
  const shown = { factorId: 'f-2', qrCode: null, secret: 'SHOWN-AFTER', uri: 'otpauth://y' };
  const failed = await panel(clientOf([() => Promise.reject(new Error('transport'))]));
  await failed.click(START);
  await settle();
  const next = await panel(
    clientOf([
      () => Promise.resolve({ ok: true as const, value: shown as unknown as IssuedFactor }),
    ]),
  );
  try {
    await next.click(START);
    await vi.waitFor(() => {
      expect(next.find('[data-factor="secret"]')?.textContent).toBe('SHOWN-AFTER');
    });
    expect(failed.find('[data-factor="outcome"]')).not.toBeNull();
    expect(failed.find('[data-factor="enrol"] button')?.hasAttribute('disabled')).toBe(false);
  } finally {
    await failed.unmount();
    await next.unmount();
  }
});
