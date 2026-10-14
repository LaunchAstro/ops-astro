// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72: work on a task with a client never reaches a subscription,
// whoever's session it is and under LA-1's laptop carve-out too. Other
// credential kinds are judged by the data classes and C60, not here.

import { expect, it } from 'vitest';
import { mayCarry, type CarryContext } from '../../packages/core-custody/src/index.ts';

const own: CarryContext = {
  unattended: false,
  sessionPersonId: 'p1',
  workForPersonId: 'p1',
  tenantInstallation: 'here',
  credentialInstallation: 'here',
  clientWork: false,
};

it("a subscription carries its own person's attended work with no client", () => {
  expect(mayCarry('subscription', own)).toEqual({ ok: true });
});

it.each([
  ["in its own person's session", own],
  ['under the laptop carve-out', { ...own, unattended: true, localOwnerTesting: true }],
  ['unattended', { ...own, unattended: true, sessionPersonId: null }],
  ["for another person's work", { ...own, workForPersonId: 'p2' }],
])('client work on a subscription %s is refused by name', (_how, context) => {
  expect(mayCarry('subscription', { ...context, clientWork: true })).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
  });
});

it.each(['api_key', 'cloud_credential', 'replay'] as const)(
  'client work names no refusal for %s here',
  (kind) => {
    expect(mayCarry(kind, { ...own, clientWork: true })).toEqual({ ok: true });
  },
);
