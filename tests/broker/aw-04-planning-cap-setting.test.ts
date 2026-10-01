// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning cap setting` (owner, NATHAN-STAGE1-TODAY 4): the AI planning
// chat's budget is AUD 50 per business until a person moves it, and the
// settings page shows it beside the business's other settings. `settings.read`
// carries the business's planning cap: the limit, its currency and whether a
// cap row holds it (`set: false` is the default). The page moves it through
// `budget.set_planning_cap` (`billing:decide`, `aw-04-set-planning-cap`).

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  asAgent,
  asPerson,
  codeOf,
  createTask,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/t2d-harness.ts';
import { noDatabase, s } from './broker-world.ts';
import { p, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04capset');
beforeAll(async () => {
  if (noDatabase) return;
  for (const on of [s, p.bravo]) {
    // eslint-disable-next-line no-await-in-loop
    await on.db.app.withBusiness(on.business, async (tx) => {
      await grantTo(tx, on.decider, 'decide', undefined, false, 'billing');
      await grantTo(tx, on.decider, 'read', undefined, false, 'settings');
    });
  }
});

const settingsOf = async (on: Schedules, who: Member = on.decider) =>
  (await executeRead(on.db.app, on.business, who.presented, {
    read: 'settings.read',
  } as never)) as unknown as Record<string, unknown>;

it('AW-04 planning cap setting: settings.read shows the default AUD 50 until a person moves it, then the limit they set', async () => {
  expect((await settingsOf(p.bravo))['planningCap']).toStrictEqual({
    limitMinor: 5_000,
    currency: 'AUD',
    set: false,
  });
  const moved = await asPerson(p.bravo, {
    command: 'budget.set_planning_cap',
    operationId: randomUUID(),
    limitMinor: 7_500,
    currency: 'AUD',
    fromLimitMinor: 5_000,
  });
  expect(codeOf(moved)).toBe('applied');
  expect((await settingsOf(p.bravo))['planningCap']).toStrictEqual({
    limitMinor: 7_500,
    currency: 'AUD',
    set: true,
  });
});

it('AW-04 planning cap setting isolation: another business, another client, another person under a live delegation', async () => {
  // Alpha's cap at a planted amount no crossing may read.
  await s.db.admin.execute(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, 'planning', 7319, 'AUD')
     on conflict (business_id, key) do update set limit_minor = 7319`,
    [s.business, randomUUID()],
  );
  // 1. Another business: bravo's owner reads bravo's own cap, never alpha's.
  const bravo = await settingsOf(p.bravo);
  expect(bravo['planningCap']).toMatchObject({ currency: 'AUD' });
  expect(JSON.stringify(bravo)).not.toContain('7319');
  const across = (await executeRead(s.db.app, s.business, p.bravo.decider.presented, {
    read: 'settings.read',
  } as never)) as unknown as Record<string, unknown>;
  expect(across).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
  // 2. Another client of the business, holding a share of one task.
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'share');
  });
  const task = await createTask(s, 'aw04capset client task');
  const client = await cq8World(s).client(s.business, s.decider, 'aw04cs', task);
  const clientSees = await settingsOf(s, client);
  expect(clientSees).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  // 3. Another person: a member with no settings grant, and the world's agent
  // under its pickup's live delegation.
  const plain = await enrol(s.db.app, s.business, 'aw04capset-plain');
  expect(await settingsOf(s, plain)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  const credential = String(p.work.picked['credential']);
  const agentSees = await asAgent(
    s,
    { command: 'settings.read', operationId: randomUUID() },
    credential,
  );
  expect(agentSees).toMatchObject({ code: 'DELEGATION_EXCLUDES_OPERATION' });
  for (const answer of [across, clientSees, agentSees]) {
    expect(JSON.stringify(answer)).not.toMatch(/7319|planningCap/u);
  }
  // The positive control: alpha's own settings reader sees the planted limit.
  expect((await settingsOf(s))['planningCap']).toStrictEqual({
    limitMinor: 7_319,
    currency: 'AUD',
    set: true,
  });
}, 120_000);
