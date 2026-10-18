// SPDX-License-Identifier: AGPL-3.0-only
//
// The credential rule on the `chatgpt-plan` route (#1620 P4): the owner's
// plan carries only runs the owner started, on a task with no client, in its
// own installation. A run nobody attends is carried when the owner started
// it; any other is refused `SUBSCRIPTION_NOT_OWNER_STARTED`. A client's task
// and another installation keep their own refusals, first. Every other
// subscription route keeps today's rule, and the plan's refusal is in the
// refusal register with its status and meaning.

import { describe, expect, it } from 'vitest';
import { CHATGPT_PLAN_PROVIDER } from '../../packages/core-connectors/src/index.ts';
import {
  PLAN_PROVIDER,
  carriesOnPlan,
  mayCarry,
  type CarryContext,
} from '../../packages/core-custody/src/carry-rule.ts';
import { REFUSAL_REGISTER } from '../../packages/core-records/src/index.ts';

const OWNER = 'person-owner';

const run = (change: Partial<CarryContext> = {}): CarryContext => ({
  unattended: true,
  sessionPersonId: null,
  workForPersonId: OWNER,
  tenantInstallation: 'here',
  credentialInstallation: 'here',
  planRoute: true,
  ownerStarted: true,
  clientWork: false,
  ...change,
});

describe('on the plan route', () => {
  it('a run the owner started, attended by nobody, is carried', () => {
    expect(mayCarry('subscription', run())).toEqual({ ok: true });
  });

  it('the owner attending their own started run is carried', () => {
    expect(mayCarry('subscription', run({ unattended: false, sessionPersonId: OWNER }))).toEqual({
      ok: true,
    });
  });

  it.each<[string, Partial<CarryContext>]>([
    ['a run staff started', { ownerStarted: false }],
    [
      'a run staff started, attended by them',
      {
        ownerStarted: false,
        unattended: false,
        sessionPersonId: 'person-staff',
        workForPersonId: 'person-staff',
      },
    ],
    [
      'a run staff started under the laptop carve-out',
      { ownerStarted: false, localOwnerTesting: true },
    ],
  ])('%s is refused SUBSCRIPTION_NOT_OWNER_STARTED', (_how, change) => {
    expect(mayCarry('subscription', run(change))).toEqual({
      ok: false,
      code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
    });
  });
});

describe('on the plan route, refused', () => {
  it('a run whose starter is not said is refused SUBSCRIPTION_NOT_OWNER_STARTED', () => {
    const { ownerStarted: _unsaid, ...unsaid } = run();
    expect(mayCarry('subscription', unsaid)).toEqual({
      ok: false,
      code: 'SUBSCRIPTION_NOT_OWNER_STARTED',
    });
  });

  it("an owner's run attended by someone else keeps the not-own-work refusal", () => {
    const other = run({ unattended: false, sessionPersonId: 'person-staff' });
    expect(mayCarry('subscription', other)).toEqual({
      ok: false,
      code: 'SUBSCRIPTION_NOT_OWN_WORK',
    });
  });

  it("a client's task is refused for client work first, whoever started it", () => {
    for (const ownerStarted of [true, false]) {
      expect(mayCarry('subscription', run({ clientWork: true, ownerStarted }))).toEqual({
        ok: false,
        code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
      });
    }
  });

  it("another installation's tenant is refused as one, whoever started it", () => {
    for (const ownerStarted of [true, false]) {
      expect(
        mayCarry('subscription', run({ tenantInstallation: 'elsewhere', ownerStarted })),
      ).toEqual({ ok: false, code: 'SUBSCRIPTION_OTHER_TENANT' });
    }
  });
});

describe('off the plan route', () => {
  it('an unattended run on another subscription route stays refused as unattended, owner-started or not', () => {
    for (const ownerStarted of [true, false]) {
      expect(mayCarry('subscription', run({ planRoute: false, ownerStarted }))).toEqual({
        ok: false,
        code: 'SUBSCRIPTION_UNATTENDED',
      });
    }
  });

  it('a key carries what it carried before', () => {
    expect(mayCarry('api_key', run({ ownerStarted: false }))).toEqual({ ok: true });
  });
});

describe('the route and the register', () => {
  it("is the plan's route exactly when its provider is the plan's", () => {
    expect(PLAN_PROVIDER).toBe(CHATGPT_PLAN_PROVIDER);
    expect(carriesOnPlan({ provider: CHATGPT_PLAN_PROVIDER })).toBe(true);
    for (const provider of ['local_gpt', 'replay', 'openrouter', 'CHATGPT_PLAN', 'chatgpt_plan ']) {
      expect(carriesOnPlan({ provider })).toBe(false);
    }
  });

  it('names the refusal with a status and a meaning', () => {
    const entry = REFUSAL_REGISTER.find((each) => each.code === 'SUBSCRIPTION_NOT_OWNER_STARTED');
    expect(entry).toMatchObject({ status: 403 });
    expect(entry?.meaning).toMatch(/owner/u);
  });
});
