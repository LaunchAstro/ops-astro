// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the money step-up setting is a person's alone. An agent under a live
// delegation from an administrator cannot switch it. The rest of C59 is in
// `c59-second-factor.test.ts` and `c59-second-factor-commands.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MONEY_STEP_UP_SETTING } from '../../packages/core-records/src/authority/step-up.ts';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
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
