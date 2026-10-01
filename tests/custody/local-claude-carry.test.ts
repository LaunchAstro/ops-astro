// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the local carve-out in which credential may carry a call. On
// the owner's laptop, with the `local-claude` provider, a subscription may
// carry unattended work (a scheduled job, a task's agent run). Everywhere
// else the AW-01 rule stands unchanged, and under the carve-out a call for
// another installation's tenant, or an attended call for someone else's
// work, is still refused by name.

import { expect, it } from 'vitest';
import { mayCarry, type CarryContext } from '../../packages/core-custody/src/index.ts';

const unattended: CarryContext = {
  unattended: true,
  sessionPersonId: null,
  workForPersonId: 'p1',
  tenantInstallation: 'here',
  credentialInstallation: 'here',
};

const attended: CarryContext = {
  ...unattended,
  unattended: false,
  sessionPersonId: 'p1',
};

it('LA-1 local carve-out: an unattended subscription call is carried under local owner testing', () => {
  expect(mayCarry('subscription', { ...unattended, localOwnerTesting: true })).toEqual({
    ok: true,
  });
});

it.each([
  ['the flag absent', unattended],
  ['the flag false', { ...unattended, localOwnerTesting: false }],
])('LA-1 local carve-out: with %s, an unattended subscription stays refused', (_how, context) => {
  expect(mayCarry('subscription', context)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_UNATTENDED',
  });
});

it("LA-1 local carve-out: another installation's tenant is still refused under it", () => {
  for (const context of [unattended, attended]) {
    expect(
      mayCarry('subscription', {
        ...context,
        localOwnerTesting: true,
        tenantInstallation: 'there',
      }),
    ).toEqual({ ok: false, code: 'SUBSCRIPTION_OTHER_TENANT' });
  }
});

it("LA-1 local carve-out: an attended call for another person's work is still refused under it", () => {
  expect(
    mayCarry('subscription', { ...attended, localOwnerTesting: true, workForPersonId: 'p2' }),
  ).toEqual({ ok: false, code: 'SUBSCRIPTION_NOT_OWN_WORK' });
});

it('LA-1 local carve-out: an attended call for its own person is carried, as before', () => {
  expect(mayCarry('subscription', { ...attended, localOwnerTesting: true })).toEqual({ ok: true });
  expect(mayCarry('subscription', attended)).toEqual({ ok: true });
});
