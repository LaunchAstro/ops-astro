// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the money step-up setting is a person's alone. An agent under a live
// delegation from an administrator cannot switch it. Switching it off asks the
// step-up; switching it back on asks nothing. The rest of C59 is in
// `c59-second-factor.test.ts` and `c59-second-factor-commands.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MONEY_STEP_UP_SETTING,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import {
  withSession,
  type VerifiedSubject,
} from '../../packages/core-records/src/identity/login-resolution.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { prepareCommand } from '../../packages/core-commands/src/commands/prepare.ts';
import { declarationOf, type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, codeOf, type AgentWorld } from '../commands/agent-fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let world: AgentWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('c59agent', 'c59agent');
  await world.db.app.withBusiness(world.business, async (tx) => await installBusinessSettings(tx));
}, 60_000);

afterAll(async () => await world?.drop());

const stepUpValue = async () =>
  await world.db.app.withBusiness(
    world.business,
    async (tx) => (await readBusinessSetting(tx, MONEY_STEP_UP_SETTING))?.value,
  );

const setStepUp = (value: boolean) => ({
  command: 'settings.set_money_step_up' as const,
  operationId: `c59-step-${randomUUID()}`,
  value,
});

/** The seeded money stand-in of `c59-second-factor-commands.test.ts`, prepared as `subject`. */
const MONEY: CommandDeclaration = {
  ...declarationOf('settings.set_client_sign_off'),
  collection: 'billing',
  action: 'decide',
};
const prepareMoney = async (subject: VerifiedSubject) =>
  await withSession(world.db.app, world.business, subject, async (tx, session) => {
    const body = {
      command: 'settings.set_client_sign_off' as const,
      operationId: randomUUID(),
      value: true,
    };
    const prepared = await prepareCommand(tx, session, 'api', body, MONEY);
    return 'refusal' in prepared ? prepared.refusal.code : 'prepared';
  });

describe.skipIf(serverUrl === undefined)(
  'C59 the money step-up setting is a person’s alone',
  () => {
    it('C59 toggle admin only: an agent under a live delegation from an administrator is refused', async () => {
      // The approver holds settings:manage, delegable, so nothing but the agent
      // being an agent stands between its credential and the switch.
      const owner = await world.decider('owner');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, owner, 'read', WHOLE_BUSINESS, true, 'settings');
        await grantTo(tx, owner, 'manage', WHOLE_BUSINESS, true, 'settings');
      });
      const picked = await world.pickUp(owner, 'c59 agent work');
      const value = async () =>
        await world.db.app.withBusiness(
          world.business,
          async (tx) => (await readBusinessSetting(tx, MONEY_STEP_UP_SETTING))?.value,
        );
      expect(await value()).toBe(true);

      const operationId = `c59-agent-${randomUUID()}`;
      const refused = await world.asAgent(
        { command: 'settings.set_money_step_up', operationId, value: false },
        picked.credential,
      );
      expect(codeOf(refused)).toBe('DELEGATION_EXCLUDES_OPERATION');
      expect(await value()).toBe(true);

      // The same switch in the approver's own hands applies, so the refusal
      // above is the agent's and not a body or a missing row.
      const own = await world.asPerson(owner, {
        command: 'settings.set_money_step_up',
        operationId: `c59-owner-${randomUUID()}`,
        value: false,
      });
      expect(codeOf(own)).toBe('not-a-refusal');
      expect(await value()).toBe(false);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 the money step-up switch is itself a money act',
  () => {
    it('C59 step-up toggle: switching the money step-up off asks the step-up itself, so a stale sign-in is refused and the setting stays on', async () => {
      // A person holding settings:manage and a money key, whose second factor
      // is past the window: a money command is refused them STEP_UP_REQUIRED.
      const admin = await world.decider('admin');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, admin, 'read', WHOLE_BUSINESS, false, 'settings');
        await grantTo(tx, admin, 'manage', WHOLE_BUSINESS, false, 'settings');
        await grantTo(tx, admin, 'decide', WHOLE_BUSINESS, false, 'billing');
      });
      // On, from a fresh sign-in, whatever an earlier case left it at.
      const on = await world.asPerson(admin, setStepUp(true));
      expect(codeOf(on)).toBe('not-a-refusal');
      expect(await stepUpValue()).toBe(true);

      const factorAt = Math.floor(Date.now() / 1000) - STEP_UP_WINDOW_SECONDS - 3600;
      const stale = {
        ...admin.presented,
        assurance: { level: 'aal2', signedInAt: factorAt, factorAt } as const,
      };
      expect(await prepareMoney(stale)).toBe('STEP_UP_REQUIRED');

      // The switch that would let that same stale sign-in through is asked too.
      const off = await executeCommand(
        world.db.app,
        world.business,
        stale,
        'api',
        setStepUp(false),
      );
      expect(codeOf(off)).toBe('STEP_UP_REQUIRED');
      expect(await stepUpValue()).toBe(true);
    });
  },
);

describe.skipIf(serverUrl === undefined)('C59 switching the money step-up on asks nothing', () => {
  it('C59 step-up toggle: switching the money step-up on is not refused STEP_UP_REQUIRED on a stale or factor-less sign-in, so protection can always be turned back on', async () => {
    const keeper = await world.decider('keeper');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, keeper, 'read', WHOLE_BUSINESS, false, 'settings');
      await grantTo(tx, keeper, 'manage', WHOLE_BUSINESS, false, 'settings');
    });
    const now = Math.floor(Date.now() / 1000);
    const factorAt = now - STEP_UP_WINDOW_SECONDS - 3600;
    const signIns = {
      stale: { level: 'aal2', signedInAt: factorAt, factorAt },
      'factor-less': { level: 'aal1', signedInAt: now, factorAt: null },
    } as const;
    for (const [how, assurance] of Object.entries(signIns)) {
      // Off, from a fresh sign-in, so switching on has something to change.
      // oxlint-disable-next-line no-await-in-loop
      expect(codeOf(await world.asPerson(keeper, setStepUp(false))), how).toBe('not-a-refusal');
      // oxlint-disable-next-line no-await-in-loop
      expect(await stepUpValue(), how).toBe(false);
      // oxlint-disable-next-line no-await-in-loop
      const on = await executeCommand(
        world.db.app,
        world.business,
        { ...keeper.presented, assurance },
        'api',
        setStepUp(true),
      );
      expect(codeOf(on), how).toBe('not-a-refusal');
      // oxlint-disable-next-line no-await-in-loop
      expect(await stepUpValue(), how).toBe(true);
    }
  });
});
