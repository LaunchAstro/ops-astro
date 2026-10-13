// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan route (#1620) carries a run only when the owner
// started it: the run works for the plan's owner, as the broker's setting
// names them. Any other run is refused by name on that route, attended or
// not, whatever kind its credential is filed as; another installation's
// tenant stays refused; every other route keeps the rule it had.

import { expect, it } from 'vitest';
import { CHATGPT_PLAN_PROVIDER as CONNECTOR_PROVIDER } from '../../packages/core-connectors/src/index.ts';
import {
  CHATGPT_PLAN_PROVIDER,
  mayCarry,
  planCarry,
  type CarryContext,
} from '../../packages/core-custody/src/index.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

const unattended: CarryContext = {
  unattended: true,
  sessionPersonId: null,
  workForPersonId: OWNER,
  tenantInstallation: 'here',
  credentialInstallation: 'here',
};

const plan = { provider: CHATGPT_PLAN_PROVIDER };

it("custody's plan provider key is the connector's", () => {
  expect(CHATGPT_PLAN_PROVIDER).toBe(CONNECTOR_PROVIDER);
});

it('a run the owner started is carried on the plan route, though no one attends it', () => {
  const context = { ...unattended, plan: planCarry({ planOwnerPersonId: OWNER }, plan, OWNER) };
  expect(mayCarry('subscription', context)).toEqual({ ok: true });
});

it.each([
  ['a staff member started it', STAFF],
  ['no person started it', null],
])('a run is refused on the plan route when %s', (_who, workFor) => {
  const context = {
    ...unattended,
    workForPersonId: workFor,
    plan: planCarry({ planOwnerPersonId: OWNER }, plan, workFor),
  };
  expect(mayCarry('subscription', context)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
  });
});

it('an attended run for someone else is refused on the plan route too', () => {
  const context = {
    ...unattended,
    unattended: false,
    sessionPersonId: STAFF,
    workForPersonId: STAFF,
    plan: planCarry({ planOwnerPersonId: OWNER }, plan, STAFF),
  };
  expect(mayCarry('subscription', context)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
  });
});

it('with no plan owner set, no run is carried on the plan route', () => {
  const context = { ...unattended, plan: planCarry({}, plan, OWNER) };
  expect(mayCarry('subscription', context)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
  });
});

it('the plan route refuses a non-owner run even when its credential is filed as another kind', () => {
  const context = { ...unattended, plan: planCarry({ planOwnerPersonId: OWNER }, plan, STAFF) };
  expect(mayCarry('api_key', context)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
  });
});

it("another installation's tenant stays refused on the plan route", () => {
  const context = {
    ...unattended,
    tenantInstallation: 'there',
    plan: planCarry({ planOwnerPersonId: OWNER }, plan, OWNER),
  };
  expect(mayCarry('subscription', context)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_OTHER_TENANT',
  });
});

it('every other route keeps its rule: the owner plan admits nothing there', () => {
  expect(planCarry({ planOwnerPersonId: OWNER }, { provider: 'ollama' }, OWNER)).toBeUndefined();
  expect(mayCarry('subscription', unattended)).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_UNATTENDED',
  });
});
