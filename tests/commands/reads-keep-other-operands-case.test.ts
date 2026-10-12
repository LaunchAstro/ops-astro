// SPDX-License-Identifier: AGPL-3.0-only
//
// Only a read's identifier fields are lowercased: a preset name that happens
// to look like a uuid keeps its case.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { grantTo } from '../commands/fixture.ts';

let world: AgentWorld;
let decider: Decider;

const serverUrl = databaseUrlFromEnvironment();

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('roc', `operand-case-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('preset-reader');
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

it.skipIf(serverUrl === undefined)(
  'preset names retain their case when they happen to look like UUIDs',
  async () => {
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, decider, 'manage');
    });
    const presetKey = 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF';
    const answer = await executeRead(world.db.app, world.business, decider.presented, {
      read: 'preset.plan',
      recordTypeKey: 'task',
      presetKey,
      fields: [],
    });
    expect(answer).toHaveProperty('plan.presetKey', presetKey);
  },
);
